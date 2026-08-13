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

/**
 * `api.<pkg>.<tool>(required, optional?)` — the call an agent would type.
 *
 * One function because three renderers show this string (the server index, the
 * gate's neighbour table, the TOC), and three spellings of one API's signature
 * is exactly the drift the single-authored-description rule exists to prevent.
 */
export function pyCallSignature(tool, pkg) {
	return `api.${pkg}.${tool.pyName}(${tool.params.map((p) => (p.required ? p.pyName : `${p.pyName}?`)).join(", ")})`;
}

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
		const path =
			style === "wire"
				? `${wireName(server, t.name)}(${t.params.map((p) => (p.required ? p.pyName : `${p.pyName}?`)).join(", ")})`
				: pyCallSignature(t, pyPackage(server));
		return `${path} — ${firstLine(t.description)}`;
	});
}

/**
 * L4 for the *codemode* arm: the whole `api/` tree's documentation, inline.
 *
 * This is the fourth cell of the 2x2 that separates representation from residency.
 * Every measurement this project has taken confounds the two — and so does
 * upstream's: AppWorld's own full-code agent interpolates `api_documentation_string`
 * into its prompt and therefore has to run the same <=20-API predictor as their
 * function-calling agent (`full_code_agent.py:119-123`). If documentation residency
 * is the mechanism and code is merely what makes non-resident documentation usable,
 * a codemode arm with its docs resident should lose most of its advantage. This
 * renderer is what makes that falsifiable.
 *
 * Deliberately built from the same fields `renderToolModule` puts in the module
 * docstring — signature, description, per-parameter notes — so the resident text
 * and the on-disk text cannot drift. It is the same container, relocated into the
 * prompt, which is exactly the contrast wanted.
 */
export function renderFullDocs(tools, { server, heading = true }) {
	const pkg = pyPackage(server);
	// The per-app DOCS.md file has its own title, so it asks for the body alone.
	// An option rather than the caller slicing lines off the front: a slice would
	// silently eat documentation the day this renderer's shape changes.
	const lines = heading ? [`### api.${pkg}  (${server})`, ""] : [];
	for (const tool of tools) {
		const args = tool.params.map((p) => (p.required ? `${p.pyName}: ${p.type}` : `${p.pyName}: ${p.type} = None`));
		lines.push(`async def api.${pkg}.${tool.pyName}(${args.join(", ")})`);
		const description = (tool.description ?? "").trim();
		if (description) for (const line of description.split("\n")) lines.push(`    ${line}`);
		for (const p of tool.params) {
			if (!p.description) continue;
			lines.push(`      ${p.pyName}: ${p.description}${p.required ? "" : " (optional)"}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

/**
 * The docs gate's three modes.
 *
 * off       nothing is rendered; the tree is byte-identical to the pre-gate one.
 * redirect  first use of an API raises with a pointer to its app's DOCS.md, and
 *           no documentation inline. The file carries what a docstring cannot —
 *           the app's conventions, its siblings, how it is organised — and going
 *           to read a file is in-distribution behaviour, where obeying a novel
 *           exception protocol is not. It costs one extra turn, which is exactly
 *           what the A/B prices.
 * inline    first use raises with the API's own docstring plus its nearest
 *           siblings' one-liners and a pointer to DOCS.md. Cheaper per fire, but
 *           it can only ever teach the API that was already called.
 *
 * Both live modes render DOCS.md; only `inline` renders the neighbour table.
 */
export const DOCS_GATE_MODES = ["off", "redirect", "inline"];

/** Normalize and validate a gate mode. A typo must not silently mean "off". */
export function docsGateMode(value) {
	if (value === undefined || value === null || value === false) return "off";
	if (value === true) return "inline";
	if (!DOCS_GATE_MODES.includes(value)) {
		throw new Error(`unknown docs-gate mode: ${value} (have ${DOCS_GATE_MODES.join("|")})`);
	}
	return value;
}

/**
 * The redirect target: one file per app, carrying every docstring in it.
 *
 * Leads with the conventions, because those are the part no single docstring
 * states and the part a wrong call most often violates — which token the API
 * wants, that a collection is paginated. Both are derived from the schemas
 * rather than asserted, so an app that does not work that way does not get told
 * that it does.
 *
 * The per-API body is `renderFullDocs`, i.e. the same text the L4 cell puts in
 * the prompt and the same fields the module docstrings carry. A second renderer
 * would be a second wording, and the drift would land inside the contrast.
 */
export function renderAppDocs(tools, { server, pkg = pyPackage(server) }) {
	const withToken = tools.filter((t) => t.params.some((p) => p.name === "access_token")).length;
	const paged = tools.filter((t) => t.params.some((p) => p.name === "page_index" || p.name === "page_limit")).length;
	const hasLogin = tools.some((t) => t.pyName === "login");

	const conventions = [];
	if (withToken > 0) {
		conventions.push(
			`- Authentication: ${withToken} of ${tools.length} APIs take \`access_token\`` +
				(hasLogin ? `, which \`api.${pkg}.login(...)\` returns.` : "."),
		);
	}
	if (paged > 0) {
		conventions.push(
			`- Pagination: ${paged} APIs take \`page_index\` (from 0) and \`page_limit\`. Loop until a` +
				" page comes back short or empty — the first page is not the answer.",
		);
	}

	return [
		`# api.${pkg} — ${server}`,
		"",
		`Full documentation for all ${tools.length} of this app's APIs.`,
		...(conventions.length > 0 ? ["", "## Conventions", "", ...conventions] : []),
		"",
		"## APIs",
		"",
		renderFullDocs(tools, { server, heading: false }),
	].join("\n");
}

/**
 * The neighbour table the `inline` gate cites: package -> tool -> INDEX line.
 *
 * Precomputed here rather than assembled in `_client`, and precomputed as the
 * *same* line `renderServerIndex` emits, so the summary the gate shows and the
 * summary the index shows cannot be two different sentences about one API.
 */
export function renderNeighbours(normalized) {
	const table = {};
	for (const { server, pyServer, tools } of normalized) {
		table[pyServer] = Object.fromEntries(
			tools.map((t) => [t.pyName, `${pyCallSignature(t, pyServer)} — ${firstLine(t.description)}`]),
		);
		void server;
	}
	return `${JSON.stringify(table, null, 1)}\n`;
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
export function renderToolModule(tool, { server, docsGate = "off" }) {
	const mode = docsGateMode(docsGate);
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
	// `_path` is what arms the gate — `__name__` is already the import path
	// (`api.<pkg>.<tool>`), so the citation and the package name need no plumbing.
	// `_doc` is passed only by the mode that shows a docstring, and it is read off
	// `__doc__` at call time so the delivered text is the same object `help()`
	// prints and the file contains. A second copy would drift.
	const gateArgs = mode === "inline" ? `\n        _doc=${tool.pyName}.__doc__,\n        _path=__name__,` : mode === "redirect" ? "\n        _path=__name__," : "";
	const call = gateArgs
		? `    return await _call(\n        "${server}",\n        "${tool.name}",\n        {${callArgs}},${gateArgs}\n    )`
		: `    return await _call("${server}", "${tool.name}", {${callArgs}})`;
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
		call,
		"",
	].join("\n");
}

/** codemode: the per-server package index, one line per tool. */
export function renderServerIndex(tools, { server, docsGate = "off" }) {
	const pkg = pyPackage(server);
	return [
		`# ${server}`,
		"",
		`${tools.length} tool${tools.length === 1 ? "" : "s"}. \`import api.${pkg}\`, then call any of the below.`,
		`Each is \`async\`. Read \`api/${pkg}/<tool>.py\` for full parameter documentation.`,
		// Only when the file exists. A pointer to a file that is not there is worse
		// than no pointer: it costs a turn and teaches the tree cannot be trusted.
		...(docsGateMode(docsGate) === "off" ? [] : [`\`api/${pkg}/DOCS.md\` has all of them at once, with this app's conventions.`]),
		"",
		...tools.map((t) => `- \`${pyCallSignature(t, pkg)}\` — ${firstLine(t.description)}`),
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
export function renderClient({ docsGate = "off" } = {}) {
	const mode = docsGateMode(docsGate);
	/**
	 * The docs gate, rendered only when the arm asked for it, and only in the shape
	 * that arm asked for.
	 *
	 * Rendered rather than switched on at runtime so that a gate-off tree is
	 * byte-identical to the one every earlier run used — the A/B compares two
	 * trees, and "the same file with a dormant branch in it" is not the same file.
	 * It also means the mode cannot disagree with the tree: there is no way to run
	 * an `inline` client against a tree that never passes `_doc`.
	 */
	const shared = `
class DocsFirst(McpError):
    """First use of an API is answered with documentation instead of a result."""


# Why this exists: an INDEX one-liner is a summary, and a summary is where a task
# is lost. \`supervisor.complete_task\` is summarised as "Mark the currently active
# task as complete with the given answer", which reads as an instruction to supply
# one; its own docstring says to pass an answer only if the task asked a question.
# A run that read only INDEX.md volunteered an answer and lost the task on it.
#
# The (server, tool) pair is marked delivered BEFORE the raise, on purpose: a cell
# that first-uses several APIs must make progress on every retry rather than wedge
# on the first one forever. Nothing tracks whether the docs were actually read —
# the second call proceeds either way. Compliance with an instruction delivered on
# the error channel is measured behaviour, and a gate that could not be cleared
# would be a deadlock rather than a hint.
_DOCS_DELIVERED: set = set()

# Optional narrowing: gate only the APIs named here (comma-separated
# "<server>.<tool>"), instead of every API in the tree.
#
# Measured reason for existing: the blanket gate taxes all 469 APIs to fix a
# contract problem on one, and it lost to a plain re-run on hard tasks
# (43.5% vs a 37.0% noise floor, z=0.74, at 2.1x the cost). The failures it
# was built for concentrate on APIs whose CONTRACT is subtle rather than whose
# NAME is unfamiliar -- supervisor.complete_task, whose "pass answer only if
# the task asks a question" rule is in the docstring the L0 arm never opens.
# Narrowing costs at most one extra turn per task instead of one per API.
_GATE_ONLY = {
    item.strip()
    for item in os.environ.get("HARNESS_DOCS_GATE_ONLY", "").split(",")
    if item.strip()
}


def _gated(server: str, tool: str) -> bool:
    return not _GATE_ONLY or f"{server}.{tool}" in _GATE_ONLY
`;

	const redirect = `${shared}

def _docs_first(server: str, tool: str, path: str) -> None:
    """Point at the app's documentation once, before an API's first real call."""
    key = (server, tool)
    if key in _DOCS_DELIVERED or not _gated(server, tool):
        return
    _DOCS_DELIVERED.add(key)
    name = path or f"{server}.{tool}"
    pkg = name.split(".")[-2] if "." in name else server
    raise DocsFirst(
        f"First use of {name}. Before calling it, read api/{pkg}/DOCS.md — it"
        " documents this API, its siblings, and this app's conventions (auth,"
        " pagination, organization). Then re-issue your call."
    )

`;

	const inline = `${shared}
_NEIGHBOURS_PATH = os.path.join(os.path.dirname(__file__), "_neighbours.json")
_NEIGHBOURS: dict | None = None

# Bounded on purpose. The message is a teaching aid, and a 75-line sibling dump
# would cost more context than the mistake it prevents; past ~20 siblings only the
# nearest by shared name-tokens are shown and the rest are a pointer.
_MAX_NEIGHBOURS = 12
_NEIGHBOUR_LIMIT = 20


def _neighbours(pkg: str, tool: str) -> list[str]:
    """The sibling APIs worth naming, nearest first."""
    global _NEIGHBOURS
    if _NEIGHBOURS is None:
        try:
            with open(_NEIGHBOURS_PATH) as handle:
                _NEIGHBOURS = json.load(handle)
        except Exception:  # noqa: BLE001 - a missing table must not break a call
            _NEIGHBOURS = {}
    siblings = {k: v for k, v in _NEIGHBOURS.get(pkg, {}).items() if k != tool}
    if len(siblings) + 1 <= _NEIGHBOUR_LIMIT:
        return [siblings[k] for k in sorted(siblings)]
    wanted = set(tool.split("_"))
    ranked = sorted(siblings, key=lambda k: (-len(wanted & set(k.split("_"))), k))
    lines = [siblings[k] for k in ranked[:_MAX_NEIGHBOURS]]
    rest = len(siblings) - len(lines)
    if rest > 0:
        lines.append(f"and {rest} more — see api/{pkg}/DOCS.md")
    return lines


def _docs_first(server: str, tool: str, doc: str, path: str) -> None:
    """Deliver an API's own documentation once, before its first real call."""
    key = (server, tool)
    if key in _DOCS_DELIVERED or not _gated(server, tool):
        return
    _DOCS_DELIVERED.add(key)
    name = path or f"{server}.{tool}"
    pkg = name.split(".")[-2] if "." in name else server
    parts = [inspect.cleandoc(doc or "")]
    siblings = _neighbours(pkg, name.split(".")[-1])
    if siblings:
        parts.append("Neighbors in api." + pkg + ":\\n" + "\\n".join("  " + s for s in siblings))
    parts.append(
        f"Docs for {name} shown above (first use). Re-issue the call if it is still"
        " what you want.\\n"
        f"If a neighbor fits better, read api/{pkg}/DOCS.md before proceeding."
    )
    raise DocsFirst("\\n\\n".join(parts))

`;

	const gate = mode === "redirect" ? redirect : mode === "inline" ? inline : "";
	return `"""Transport for the generated api/ modules. Do not edit.

Every tool module calls \`_client.call\`, which forwards to the shared MCP proxy.
"""

${mode === "inline" ? "import inspect\n" : ""}import json
import os
import urllib.request

_PROXY = os.environ.get("HARNESS_MCP_PROXY", "http://127.0.0.1:8765")

# NOTE: transparent memoization of identical calls was tried here and removed.
# 29% of MCP calls in a run are byte-identical repeats, so caching them looks
# like free efficiency — but it is not safe. "Read-only" is not "idempotent":
# Reddit hot threads, Steam trending and market prices all change between calls,
# so a cache silently serves stale data, and for any server with side effects it
# is simply wrong. Deduplication has to be the agent's judgement call per tool,
# which is what the q6 ledger prompt asks for.
_RUN_ID = os.environ.get("HARNESS_RUN_ID", "")
_TIMEOUT = 180


class McpError(RuntimeError):
    """An MCP tool returned an error, or the server was unreachable."""

${gate}
async def call(server: str, tool: str, args: dict${mode === "inline" ? ", _doc: str | None = None, _path: str | None = None" : mode === "redirect" ? ", _path: str | None = None" : ""}) -> str:
    """Invoke an MCP tool and return its text result.

    Arguments whose value is None are dropped, so optional parameters left at
    their default are not sent as explicit nulls — several servers reject that.

    Raises:${mode === "off" ? "" : "\n        DocsFirst: This is the first call to this API; read the message, then call again."}
        McpError: The server returned an error or could not be reached.
    """${mode === "inline" ? "\n    if _path is not None:\n        _docs_first(server, tool, _doc, _path)" : mode === "redirect" ? "\n    if _path is not None:\n        _docs_first(server, tool, _path)" : ""}
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
export function renderRootIndex(catalogue, { docsGate = "off" } = {}) {
	const total = catalogue.reduce((n, s) => n + s.tools.length, 0);
	const mode = docsGateMode(docsGate);
	// Announced, not sprung. An unexplained exception on a call the agent believes
	// is correct is a bug to work around; a documented protocol is a step to take.
	// Two lines, only when the gate is on, and worded per mode — telling the agent
	// it will receive documentation when it will receive a pointer is a small lie
	// that costs a turn.
	const announcement = {
		off: [],
		redirect: ["The first call to any API returns a pointer to that app's DOCS.md instead", "of a result. Read that file, then re-issue the call.", ""],
		inline: ["The first call to any API returns that API's documentation instead of a", "result. Read it, then re-issue the call.", ""],
	}[mode];
	return [
		"# api",
		"",
		`${catalogue.length} servers, ${total} tools, all async.`,
		"",
		...announcement,
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
 * @param options.docsGate "off" | "redirect" | "inline" — see DOCS_GATE_MODES
 * @returns { toolDefs, tocLines, names, files } — `files` is a path -> content
 *          map rooted at `api/`, written to disk by the caller.
 */
export function generate(catalogue, { docsGate = "off" } = {}) {
	const gateMode = docsGateMode(docsGate);
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
		"INDEX.md": renderRootIndex(normalized, { docsGate: gateMode }),
		"__init__.py": '"""Generated MCP tool catalogue. See INDEX.md."""\n',
		"_client.py": renderClient({ docsGate: gateMode }),
	};
	// Only the mode that cites siblings pays for the table. Every extra file in
	// the tree is one more line in the agent's `grep -ril`.
	if (gateMode === "inline") files["_neighbours.json"] = renderNeighbours(normalized);

	for (const { server, pyServer, tools } of normalized) {
		toolDefs.push(...renderToolDefs(tools, { server }));
		tocLines.push(...renderTocLines(tools, { server }));
		names.push(...renderNames(tools, { server }));

		files[`${pyServer}/INDEX.md`] = renderServerIndex(tools, { server, docsGate: gateMode });
		files[`${pyServer}/__init__.py`] = renderServerInit(tools, { server });
		// The redirect target. Both live modes render it: `redirect` sends the agent
		// here instead of showing a docstring, `inline` sends it here when a sibling
		// looks like the better call.
		if (gateMode !== "off") files[`${pyServer}/DOCS.md`] = renderAppDocs(tools, { server, pkg: pyServer });
		for (const tool of tools) {
			files[`${pyServer}/${tool.pyName}.py`] = renderToolModule(tool, { server, docsGate: gateMode });
		}
	}

	return { toolDefs, tocLines, names, files, normalized };
}
