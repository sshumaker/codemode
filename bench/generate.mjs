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

/** vanilla L4: the JSON tool definitions that occupy context every turn. */
export function renderToolDefs(tools, { server } = {}) {
	return tools.map((t) => ({
		name: server ? `${server}__${t.name}` : t.name,
		description: t.description,
		input_schema: t.schema,
	}));
}

/** L2: one line per tool. */
export function renderTocLines(tools, { server } = {}) {
	const prefix = server ? `${server}.` : "";
	return tools.map((t) => `${prefix}${signature(t)} — ${firstLine(t.description)}`);
}

/** L1: names only. */
export function renderNames(tools, { server } = {}) {
	return tools.map((t) => (server ? `${server}.${t.name}` : t.name));
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
		`from ._client import call as _call`,
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
	return [
		`# ${server}`,
		"",
		`${tools.length} tool${tools.length === 1 ? "" : "s"}. Read a tool's module for full documentation.`,
		"",
		...tools.map((t) => `- \`${signature(t)}\` — ${firstLine(t.description)}`),
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

/** codemode: the top-level index across servers. */
export function renderRootIndex(catalogue) {
	const total = catalogue.reduce((n, s) => n + s.tools.length, 0);
	return [
		"# api",
		"",
		`${catalogue.length} servers, ${total} tools. \`cat api/<server>/INDEX.md\` for a server's tools.`,
		"",
		...catalogue.map((s) => `- \`${s.server}\` — ${s.tools.length} tools`),
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
	const normalized = catalogue.map((s) => ({ server: s.server, tools: s.tools.map(normalizeTool) }));

	const toolDefs = [];
	const tocLines = [];
	const names = [];
	const files = { "INDEX.md": renderRootIndex(normalized) };

	for (const { server, tools } of normalized) {
		toolDefs.push(...renderToolDefs(tools, { server }));
		tocLines.push(...renderTocLines(tools, { server }));
		names.push(...renderNames(tools, { server }));

		files[`${server}/INDEX.md`] = renderServerIndex(tools, { server });
		files[`${server}/__init__.py`] = renderServerInit(tools, { server });
		for (const tool of tools) {
			files[`${server}/${tool.pyName}.py`] = renderToolModule(tool, { server });
		}
	}

	return { toolDefs, tocLines, names, files, normalized };
}
