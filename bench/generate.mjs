/**
 * Render an MCP tool catalogue into every form the experiment needs.
 *
 * This is the fairness mechanism. Each tool's description is authored once — by
 * the MCP server — and rendered into four containers. If the containers were
 * written separately the experiment would measure whose prose is better rather
 * than which architecture is better, so every renderer here reads the same
 * `description` field and none of them paraphrase it.
 *
 *   toolDefs   vanilla L4  — JSON Schema definitions, resident every turn
 *   tocLines   L2          — one line per tool: signature + summary
 *   names      L1          — names only, schemas fetched on demand
 *   apiTree    codemode    — real Python modules on disk, greppable
 *
 * See docs/DESIGN.md.
 */

/** JSON Schema type -> Python type hint. */
const PY_TYPES = {
	string: "str",
	number: "float",
	integer: "int",
	boolean: "bool",
	array: "list",
	object: "dict",
	null: "None",
};

/**
 * Python reserved words. MCP parameter names are free-form, and real servers do
 * ship `from`, `class`, and `id`-adjacent names. Emitting one bare produces a
 * module that fails to import — which would silently remove the tool from the
 * codemode arm while leaving it present in vanilla, quietly biasing the result.
 */
const PY_KEYWORDS = new Set([
	"False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
	"def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import",
	"in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while",
	"with", "yield", "match", "case",
]);

/** A tool identifier that is safe as a Python module and function name. */
export function pyIdent(name) {
	const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
	const safe = cleaned || "tool";
	const prefixed = /^[0-9]/.test(safe) ? `t_${safe}` : safe;
	// PEP 8: a trailing underscore avoids the keyword collision.
	return PY_KEYWORDS.has(prefixed) ? `${prefixed}_` : prefixed;
}

/**
 * Package name for a server.
 *
 * Lowercased, per PEP 8 and because the agent has to type it from memory after
 * reading an index — "OpenAPI Explorer" becoming `openapi_explorer` is a rule
 * it can apply, whereas mixed case invites near-miss imports.
 */
export function pyPackage(server) {
	return pyIdent(server).toLowerCase();
}

function pyType(schema) {
	if (!schema || typeof schema !== "object") return "Any";
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		const literals = schema.enum.map((v) => JSON.stringify(v)).join(", ");
		return `Literal[${literals}]`;
	}
	if (Array.isArray(schema.type)) {
		const parts = schema.type.filter((t) => t !== "null").map((t) => PY_TYPES[t] ?? "Any");
		const union = [...new Set(parts)].join(" | ") || "Any";
		return schema.type.includes("null") ? `${union} | None` : union;
	}
	if (schema.type === "array") {
		return `list[${pyType(schema.items)}]`;
	}
	return PY_TYPES[schema.type] ?? "Any";
}

/** Normalize one MCP tool into the shape every renderer consumes. */
export function normalizeTool(tool) {
	const schema = tool.inputSchema ?? tool.input_schema ?? { type: "object", properties: {} };
	const properties = schema.properties ?? {};
	const required = new Set(schema.required ?? []);

	const params = Object.entries(properties).map(([name, spec]) => ({
		name,
		pyName: pyIdent(name),
		required: required.has(name),
		type: pyType(spec),
		description: (spec?.description ?? "").trim(),
	}));

	// Required parameters must precede optional ones in a Python signature.
	params.sort((a, b) => Number(b.required) - Number(a.required));

	return {
		name: tool.name,
		pyName: pyIdent(tool.name),
		description: (tool.description ?? "").trim(),
		schema,
		params,
	};
}

const firstLine = (text) => (text ?? "").trim().split("\n")[0]?.trim() ?? "";

/** Signature as shown in a TOC line: required args bare, optional suffixed `?`. */
export function signature(tool) {
	return `${tool.name}(${tool.params.map((p) => (p.required ? p.name : `${p.name}?`)).join(", ")})`;
}

// --- renderers ---------------------------------------------------------------

/**
 * Provider-safe tool name.
 *
 * Anthropic requires `^[a-zA-Z0-9_-]{1,64}$`, so real server names ("OpenAPI
 * Explorer") cannot be used raw, and server+tool can exceed 64 characters. The
 * qualified name is what the model sees; the proxy maps it back to the real
 * (server, tool) pair, so mangling here never reaches the wire.
 */
export function wireName(server, tool) {
	const clean = (s) => s.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
	const full = server ? `${clean(server)}__${clean(tool)}` : clean(tool);
	if (full.length <= 64) return full;
	// Truncate the server half first; the tool half carries more information.
	const toolPart = clean(tool).slice(0, 48);
	const budget = 64 - toolPart.length - 2;
	return `${clean(server).slice(0, Math.max(1, budget))}__${toolPart}`;
}

/** vanilla L4: the JSON tool definitions that occupy context every turn. */
export function renderToolDefs(tools, { server } = {}) {
	return tools.map((t) => ({
		name: wireName(server, t.name),
		description: t.description,
		input_schema: t.schema,
		// Not sent to the model — the proxy needs the real identifiers back.
		_mcp: { server, tool: t.name },
	}));
}

/**
 * L2: one line per tool.
 *
 * `style` decides what the line is addressed by, because the two arms call
 * tools differently and a TOC the agent cannot act on is worse than none:
 *   "python"  api.math_mcp.add(a, b) — ...      (codemode: an importable path)
 *   "wire"    Math_MCP__add(a, b) — ...         (vanilla: the tool name)
 */
export function renderTocLines(tools, { server, style = "python" } = {}) {
	return tools.map((t) => {
		const params = t.params.map((p) => (p.required ? p.pyName : `${p.pyName}?`)).join(", ");
		const path =
			style === "wire"
				? `${wireName(server, t.name)}(${params})`
				: `api.${pyPackage(server)}.${t.pyName}(${params})`;
		return `${path} — ${firstLine(t.description)}`;
	});
}

/** L1: names only. */
export function renderNames(tools, { server, style = "python" } = {}) {
	return tools.map((t) =>
		style === "wire" ? wireName(server, t.name) : `api.${pyPackage(server)}.${t.pyName}`,
	);
}

/**
 * codemode: one Python module per tool.
 *
 * The docstring carries the server's description verbatim, so `grep`, `import`,
 * and `help()` all read the same text and cannot drift.
 */
export function renderToolModule(tool, { server }) {
	const args = tool.params.map((p) => (p.required ? `${p.pyName}: ${p.type}` : `${p.pyName}: ${p.type} | None = None`));
	const signatureLine = `async def ${tool.pyName}(${args.join(", ")}) -> Any:`;

	const doc = [`    """${firstLine(tool.description) || tool.name}`];
	const rest = (tool.description ?? "").trim().split("\n").slice(1).join("\n").trim();
	if (rest) doc.push("", ...rest.split("\n").map((l) => `    ${l}`));

	if (tool.params.length > 0) {
		doc.push("", "    Args:");
		for (const p of tool.params) {
			const note = p.description ? ` ${p.description}` : "";
			const opt = p.required ? "" : " Optional.";
			doc.push(`        ${p.pyName}:${note}${opt}`.trimEnd());
		}
	}
	doc.push("", "    Returns:", "        The tool result as returned by the MCP server.", '    """');

	const callArgs = tool.params.map((p) => `"${p.name}": ${p.pyName}`).join(", ");
	return [
		`"""${server}.${tool.name} — generated from the MCP schema. Do not edit."""`,
		"",
		"from typing import Any, Literal",
		"",
		// `_client` lives at the api/ root, one level above the server package.
		`from .._client import call as _call`,
		"",
		"",
		signatureLine,
		...doc,
		`    return await _call("${server}", "${tool.name}", {${callArgs}})`,
		"",
	].join("\n");
}

/** codemode: the per-server package index, one line per tool. */
export function renderServerIndex(tools, { server }) {
	const pkg = pyPackage(server);
	return [
		`# ${server}`,
		"",
		`${tools.length} tool${tools.length === 1 ? "" : "s"}. \`import api.${pkg}\`, then call any of the below.`,
		`Each is \`async\`. Read \`api/${pkg}/<tool>.py\` for full parameter documentation.`,
		"",
		...tools.map((t) => `- \`api.${pkg}.${t.pyName}(${t.params.map((p) => (p.required ? p.pyName : `${p.pyName}?`)).join(", ")})\` — ${firstLine(t.description)}`),
		"",
	].join("\n");
}

/** codemode: the package __init__, re-exporting every tool. */
export function renderServerInit(tools, { server }) {
	return [
		`"""${server} — generated from the MCP schema. Do not edit."""`,
		"",
		...tools.map((t) => `from .${t.pyName} import ${t.pyName}`),
		"",
		"__all__ = [",
		...tools.map((t) => `    "${t.pyName}",`),
		"]",
		"",
	].join("\n");
}

/**
 * codemode: the transport every generated module calls through.
 *
 * Deliberately the same proxy the vanilla arm's tools POST to, so the arms
 * differ only in how the model is shown the catalogue — not in how calls are
 * made, what they cost, or how they fail.
 *
 * Written with stdlib only: the kernel is a bare uv-managed environment and a
 * missing `requests` would silently disable the entire arm.
 */
export function renderClient() {
	return `"""Transport for the generated api/ modules. Do not edit.

Every tool module calls \`_client.call\`, which forwards to the shared MCP proxy.
"""

import json
import os
import urllib.request

_PROXY = os.environ.get("HARNESS_MCP_PROXY", "http://127.0.0.1:8765")
_RUN_ID = os.environ.get("HARNESS_RUN_ID", "")
_TIMEOUT = 180


class McpError(RuntimeError):
    """An MCP tool returned an error, or the server was unreachable."""


async def call(server: str, tool: str, args: dict) -> str:
    """Invoke an MCP tool and return its text result.

    Arguments whose value is None are dropped, so optional parameters left at
    their default are not sent as explicit nulls — several servers reject that.

    Raises:
        McpError: The server returned an error or could not be reached.
    """
    payload = {
        "server": server,
        "tool": tool,
        "args": {k: v for k, v in (args or {}).items() if v is not None},
        "meta": {"arm": "codemode", "runId": _RUN_ID},
    }
    request = urllib.request.Request(
        _PROXY + "/call",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            body = json.loads(response.read())
    except Exception as exc:  # noqa: BLE001 - surfaced to the agent as-is
        raise McpError(f"{server}.{tool}: proxy unreachable: {exc}") from exc

    if not body.get("ok"):
        raise McpError(f"{server}.{tool}: {body.get('error', 'unknown error')}")
    return body.get("text", "")
`;
}

/** codemode: the top-level index across servers. */
export function renderRootIndex(catalogue) {
	const total = catalogue.reduce((n, s) => n + s.tools.length, 0);
	return [
		"# api",
		"",
		`${catalogue.length} servers, ${total} tools, all async.`,
		"",
		"Find a tool:",
		"  grep -ril '<keyword>' api/          # search every tool's documentation",
		"  cat api/<package>/INDEX.md          # list one server's tools",
		"  cat api/<package>/<tool>.py         # full parameter documentation",
		"",
		"Call one:",
		"  import api.<package>",
		"  result = await api.<package>.<tool>(...)",
		"",
		"| package | server | tools |",
		"| --- | --- | --- |",
		// The package column is what gets imported; the server column is the name
		// the task description will use. The agent needs both to bridge them.
		...catalogue.map((s) => `| \`${s.pyServer}\` | ${s.server} | ${s.tools.length} |`),
		"",
	].join("\n");
}

/**
 * Render a whole catalogue into every container.
 *
 * @param catalogue [{ server, tools: [rawMcpTool] }]
 * @returns { toolDefs, tocLines, names, files } — `files` is a path -> content
 *          map rooted at `api/`, written to disk by the caller.
 */
export function generate(catalogue) {
	// Real MCP server names contain spaces ("OpenAPI Explorer", "Math MCP"), so
	// the package directory needs its own identifier. The raw name is still what
	// goes on the wire and what the TOC and tool defs display.
	const normalized = catalogue.map((s) => ({
		server: s.server,
		pyServer: pyPackage(s.server),
		tools: s.tools.map(normalizeTool),
	}));

	const seen = new Map();
	for (const s of normalized) {
		// Two servers could normalize to the same identifier; disambiguate rather
		// than silently overwriting one package with the other.
		const count = seen.get(s.pyServer) ?? 0;
		seen.set(s.pyServer, count + 1);
		if (count > 0) s.pyServer = `${s.pyServer}_${count + 1}`;
	}

	const toolDefs = [];
	const tocLines = [];
	const names = [];
	// `__init__.py` at the root so `import api.<pkg>` resolves as a regular
	// package rather than relying on namespace-package resolution.
	const files = {
		"INDEX.md": renderRootIndex(normalized),
		"__init__.py": '"""Generated MCP tool catalogue. See INDEX.md."""\n',
		"_client.py": renderClient(),
	};

	for (const { server, pyServer, tools } of normalized) {
		toolDefs.push(...renderToolDefs(tools, { server }));
		tocLines.push(...renderTocLines(tools, { server }));
		names.push(...renderNames(tools, { server }));

		files[`${pyServer}/INDEX.md`] = renderServerIndex(tools, { server });
		files[`${pyServer}/__init__.py`] = renderServerInit(tools, { server });
		for (const tool of tools) {
			files[`${pyServer}/${tool.pyName}.py`] = renderToolModule(tool, { server });
		}
	}

	return { toolDefs, tocLines, names, files, normalized };
}
