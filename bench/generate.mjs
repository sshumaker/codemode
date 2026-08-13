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
	// A single permitted value is a Literal, same as a one-member enum. Rendering it
	// `str` would drop the only thing the schema actually says about the parameter.
	if ("const" in schema) return `Literal[${JSON.stringify(schema.const)}]`;
	if (Array.isArray(schema.type)) {
		// `items` still applies when "array" arrives inside a type union, so recurse
		// rather than flattening to a bare `list` — the same information loss the
		// anyOf fallthrough below was fixed for.
		const parts = schema.type
			.filter((t) => t !== "null")
			.map((t) => (t === "array" ? `list[${pyType(schema.items)}]` : (PY_TYPES[t] ?? "Any")));
		const union = [...new Set(parts)].join(" | ") || "Any";
		return schema.type.includes("null") ? `${union} | None` : union;
	}
	if (schema.type === "array") {
		return `list[${pyType(schema.items)}]`;
	}
	// anyOf / oneOf. Without this the union collapses to `Any` and the signature
	// stops carrying what the schema knows -- measured on AppWorld's
	// `supervisor.complete_task`, whose `answer` is anyOf[number,integer,string]
	// and rendered as `Any`, the only untyped parameter in 3,125. The whole point
	// of compiling MCP into Python is that the signature keeps the schema's
	// information; a fallthrough that silently drops it defeats the exercise.
	const variants = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(variants) && variants.length > 0) {
		const parts = variants.filter((v) => v && v.type !== "null").map((v) => pyType(v));
		const union = [...new Set(parts)].join(" | ") || "Any";
		const nullable = variants.some((v) => v && v.type === "null");
		return nullable ? `${union} | None` : union;
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

// --- runtime argument validation ---------------------------------------------

/**
 * The per-tool schemas shipped alongside the tree, for `_client` to validate against.
 *
 * Data-driven rather than codegen'd per function on purpose: a `if not isinstance(...)`
 * ladder inlined into 469 modules is 469 places for the generator to be subtly wrong,
 * and it would put a *translation* of the schema between the benchmark and the arm.
 * This file is the schema itself, so a validation verdict is re-derivable from it.
 *
 * `description` is stripped from every level. Validation needs constraints, not prose,
 * and leaving the prose in would make `_schemas.json` a shadow documentation surface —
 * one `cat` away from the whole catalogue, which is exactly the residency the L0 label
 * claims is absent. The docstrings in the .py files remain the only documentation.
 */
const PROSE_KEYWORDS = new Set(["description", "title", "$comment"]);
/**
 * Keywords whose value is a map of NAME -> schema. Their keys are parameter names,
 * not schema keywords.
 *
 * Load-bearing, and found the hard way: without this, a parameter literally named
 * `description` was deleted from the table — `splitwise.record_expense`,
 * `todoist.create_task` and 31 others — so the validator reported the agent's
 * perfectly legal `description="..."` as an *unknown argument*. Measured in a live
 * run: the agent obeyed the correction, dropped the argument, and the call went
 * through without it. A validation bug that produces a plausible-looking error and
 * a plausible-looking recovery, which is this project's recurring failure shape.
 */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
/** Keywords whose value is DATA, not a schema. Rewriting these would change meaning. */
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples"]);

function stripProse(node) {
	if (Array.isArray(node)) return node.map(stripProse);
	if (!node || typeof node !== "object") return node;
	const out = {};
	for (const [k, v] of Object.entries(node)) {
		if (PROSE_KEYWORDS.has(k)) continue;
		if (DATA_KEYWORDS.has(k)) {
			// An enum member that happens to be an object is a VALUE the argument is
			// compared against; stripping a key out of it would silently change which
			// arguments compare equal.
			out[k] = v;
		} else if (SCHEMA_MAPS.has(k) && v && typeof v === "object" && !Array.isArray(v)) {
			out[k] = Object.fromEntries(Object.entries(v).map(([name, schema]) => [name, stripProse(schema)]));
		} else {
			out[k] = stripProse(v);
		}
	}
	return out;
}

/**
 * `{ packages: {<server>: <pyPackage>}, tools: {<server>: {<tool>: <inputSchema>}} }`
 *
 * Keyed by the RAW identifiers, because those are what `_client.call` is handed; a
 * table keyed by the python names would silently miss every tool whose name needed
 * mangling, i.e. validation would quietly do nothing for exactly the tools most
 * likely to be called wrong.
 *
 * `packages` exists so the error can name the *import path* the agent types rather
 * than the wire name. On AppWorld the two coincide, but a real MCP server called
 * "Math MCP" would otherwise be reported as `api.Math MCP.add` — a correction that
 * cannot be pasted back into a cell.
 */
export function renderSchemas(normalized) {
	const packages = {};
	const tools = {};
	for (const { server, pyServer, tools: list } of normalized) {
		packages[server] = pyServer ?? pyPackage(server);
		tools[server] = Object.fromEntries(list.map((t) => [t.name, stripProse(t.schema)]));
	}
	return `${JSON.stringify({ packages, tools }, null, 1)}\n`;
}

/**
 * The validator, rendered into `_client.py` only when the arm asked for it.
 *
 * Why this is worth building at all, and why it is not a mirror of what the
 * tool-calling arm already gets for free:
 *
 *   A JSON tool-calling harness has argument validation, but the PROVIDER does it,
 *   after the model has emitted the call, and the correction arrives as a tool error
 *   one round trip later. Generated code validates AT THE CALL SITE, inside the
 *   agent's own process, before anything leaves it — so the correction lands in the
 *   error channel of the cell that made the mistake. That channel is the one this
 *   project has measured to work: runs that hit a guard adopted the primitive on the
 *   very next cell, where a prompt advertising the same rule did not (CLAUDE.md,
 *   "put the correction in the error, not in the prompt").
 *
 *   It also recovers the one real cost of the search_tools/describe_tool/call_tool
 *   pattern several MCP harnesses ship: the provider validates `call_tool`'s schema,
 *   not the inner tool's, so argument validation is lost entirely. Here it is not.
 *
 * Stdlib only, like the rest of the transport: the kernel is a bare uv-managed
 * environment and an ImportError would silently disable the whole arm.
 */
function renderValidator() {
	return `
_SCHEMAS_PATH = os.path.join(os.path.dirname(__file__), "_schemas.json")
_SCHEMAS: dict | None = None


class ArgumentError(McpError, TypeError):
    """An argument does not satisfy its API's declared input schema.

    Subclasses TypeError as well as McpError so that the idiom already in the
    model's head — \`except TypeError\` around a call with a guessed argument —
    catches it, rather than requiring a bespoke exception to be learned first.
    """


# JSON Schema type -> the Python types that satisfy it. \`bool\` is deliberately
# NOT accepted for integer/number and \`int\` not for boolean: Python's bool is an
# int subclass, so a naive isinstance check would let \`limit=True\` through and
# let \`verified=1\` through, and both are rejected by the servers downstream.
_JSON_TYPES = {
    "string": (str,),
    "integer": (int,),
    "number": (int, float),
    "boolean": (bool,),
    "array": (list, tuple),
    "object": (dict,),
    "null": (type(None),),
}

_EMAIL = re.compile(r"^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")


def _brief(value: object, limit: int = 80) -> str:
    text = repr(value)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _type_matches(value: object, name: str) -> bool:
    allowed = _JSON_TYPES.get(name)
    if allowed is None:  # a type this validator does not model: do not invent a verdict
        return True
    if isinstance(value, bool) and name in ("integer", "number"):
        return False
    if not isinstance(value, bool) and name == "boolean":
        return False
    return isinstance(value, allowed)


def _check(value: object, schema: dict, path: str) -> str | None:
    """Return a description of the first violation, or None if the value is valid."""
    if not isinstance(schema, dict) or not schema:
        return None

    variants = schema.get("anyOf") or schema.get("oneOf")
    if variants:
        if any(_check(value, v, path) is None for v in variants):
            return None
        shapes = ", ".join(str(v.get("type", "?")) for v in variants)
        return f"{path}={_brief(value)} matches none of the allowed shapes ({shapes})"

    declared = schema.get("type")
    if declared is not None:
        names = declared if isinstance(declared, list) else [declared]
        if not any(_type_matches(value, n) for n in names):
            return (
                f"{path} must be {' or '.join(names)}, got {type(value).__name__} "
                f"({_brief(value)})"
            )

    if "const" in schema and value != schema["const"]:
        return f"{path} must be exactly {schema['const']!r}, got {_brief(value)}"
    if "enum" in schema and value not in schema["enum"]:
        allowed = ", ".join(repr(v) for v in schema["enum"])
        return f"{path}={_brief(value)} is not one of the allowed values: {allowed}"

    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            return f"{path} must be at least {schema['minLength']} characters, got {len(value)}"
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            return f"{path} must be at most {schema['maxLength']} characters, got {len(value)}"
        pattern = schema.get("pattern")
        if pattern is not None and re.search(pattern, value) is None:
            return f"{path}={_brief(value)} does not match the required pattern {pattern!r}"
        # Only formats this validator actually implements are enforced. An
        # unimplemented format must not produce a verdict either way.
        if schema.get("format") == "email" and _EMAIL.match(value) is None:
            return f"{path}={_brief(value)} is not an email address"

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        for key, ok, word in (
            ("minimum", lambda v, b: v >= b, ">="),
            ("maximum", lambda v, b: v <= b, "<="),
            ("exclusiveMinimum", lambda v, b: v > b, ">"),
            ("exclusiveMaximum", lambda v, b: v < b, "<"),
        ):
            if key in schema and not ok(value, schema[key]):
                return f"{path} must be {word} {schema[key]}, got {value!r}"

    if isinstance(value, (list, tuple)):
        if "minItems" in schema and len(value) < schema["minItems"]:
            return f"{path} must have at least {schema['minItems']} items, got {len(value)}"
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            return f"{path} must have at most {schema['maxItems']} items, got {len(value)}"
        items = schema.get("items")
        if isinstance(items, dict):
            for i, item in enumerate(value):
                problem = _check(item, items, f"{path}[{i}]")
                if problem:
                    return problem

    if isinstance(value, dict):
        properties = schema.get("properties") or {}
        for key, spec in properties.items():
            if key in value:
                problem = _check(value[key], spec, f"{path}.{key}")
                if problem:
                    return problem
        for key in schema.get("required", []):
            if key not in value:
                return f"{path} is missing the required key {key!r}"
    return None


def _table() -> dict:
    global _SCHEMAS
    if _SCHEMAS is None:
        try:
            with open(_SCHEMAS_PATH) as handle:
                _SCHEMAS = json.load(handle)
        except Exception:  # noqa: BLE001 - a missing table must not break every call
            _SCHEMAS = {"packages": {}, "tools": {}}
    return _SCHEMAS


def _schema_for(server: str, tool: str) -> dict | None:
    return ((_table().get("tools") or {}).get(server) or {}).get(tool)


def _validate(server: str, tool: str, args: dict) -> None:
    """Check args against the API's own schema before anything leaves this process.

    Raised here rather than surfaced by the server (or, for a tool-calling arm, by
    the provider one round trip later) so the correction reaches the agent in the
    error channel of the cell that made the mistake.
    """
    schema = _schema_for(server, tool)
    if not schema:
        return
    properties = schema.get("properties") or {}
    # The import path the agent types, not the wire name: a server called "Math MCP"
    # is imported as api.math_mcp, and a correction naming "api.Math MCP.add" cannot
    # be pasted back into a cell.
    call = f"api.{(_table().get('packages') or {}).get(server, server)}.{tool}"

    for name in schema.get("required", []):
        if name not in args:
            known = ", ".join(sorted(properties)) or "none"
            raise ArgumentError(
                f"{call}: missing required argument {name!r}. Parameters: {known}"
            )

    if properties and schema.get("additionalProperties") is not True:
        for name in args:
            if name not in properties:
                known = ", ".join(sorted(properties)) or "none"
                raise ArgumentError(
                    f"{call}: unknown argument {name!r}. Parameters: {known}"
                )

    for name, value in args.items():
        spec = properties.get(name)
        if not spec:
            continue
        problem = _check(value, spec, name)
        if problem:
            raise ArgumentError(f"{call}: {problem}\\n  schema for {name}: {json.dumps(spec)}")

`;
}

// --- api tree layout ---------------------------------------------------------

/**
 * How the generated tree is arranged on disk.
 *
 * per-method    api/<app>/<api>.py — one file per API, plus a per-app INDEX.md.
 * consolidated  api/<app>.py — one module per app, every API in it, full docstrings.
 *
 * The flag exists because the per-method tree is a shape the model has never seen.
 * No API reference and no SDK is one file per method: `stripe.py`, a boto3 service
 * module, a REST reference page — all are one page per service or resource. Reading
 * the documentation for an app is a 48-file operation in the per-method tree and a
 * single `cat` in the consolidated one, and the measured behaviour at L0 is that the
 * agent reads the INDEX one-liners and stops. Both dissected AppWorld failures came
 * from a contract that only exists in a docstring nobody opened — `show_drafts`'s
 * YYYY-MM-DD `min_created_at`, and `complete_task`'s answer-only-if-asked rule.
 *
 * This is CLAUDE.md's affordance rule applied to the tree itself: write down what
 * you would reach for without the new thing, and get as close to it as possible.
 * `cat api/gmail.py` is that; `cat api/gmail/show_drafts.py` × 48 is not.
 *
 * What it deliberately does NOT change is the call site. `import api.gmail` and
 * `await api.gmail.show_drafts(...)` are identical in both layouts, so the contrast
 * is the shape of the documentation and nothing else.
 */
export const API_LAYOUTS = ["per-method", "consolidated"];

/** Normalize and validate a layout. A typo must not silently mean the default. */
export function apiLayout(value) {
	if (value === undefined || value === null) return "per-method";
	if (!API_LAYOUTS.includes(value)) {
		throw new Error(`unknown api layout: ${value} (have ${API_LAYOUTS.join("|")})`);
	}
	return value;
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
export function appConventions(tools, pkg) {
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
	return conventions;
}

export function renderAppDocs(tools, { server, pkg = pyPackage(server) }) {
	// Shared with the consolidated module's header rather than written twice: two
	// statements of one app's conventions is the drift the single-authored-text rule
	// exists to prevent, and this pair would drift across a layout flag where nobody
	// is comparing them side by side.
	const conventions = appConventions(tools, pkg);

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
 * One `async def`, with its docstring and its `_call` — the unit both layouts share.
 *
 * Extracted so the two layouts cannot render a function two different ways. The
 * whole claim of `--api-layout` is that it moves text between files and changes
 * nothing an agent could call differently; a second copy of this renderer would
 * make that claim false the first time one of them was edited.
 *
 * `pathLiteral` is the only thing that differs, and only when the docs gate is on:
 * in per-method `__name__` already IS `api.<pkg>.<tool>`, while a consolidated
 * module's `__name__` is just `api.<pkg>`, which would lose the tool half and make
 * the gate fire once per APP instead of once per API.
 */
function renderFunction(tool, { server, docsGate = "off", pathLiteral = "__name__" }) {
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
	const gateArgs =
		mode === "inline"
			? `\n        _doc=${tool.pyName}.__doc__,\n        _path=${pathLiteral},`
			: mode === "redirect"
				? `\n        _path=${pathLiteral},`
				: "";
	const call = gateArgs
		? `    return await _call(\n        "${server}",\n        "${tool.name}",\n        {${callArgs}},${gateArgs}\n    )`
		: `    return await _call("${server}", "${tool.name}", {${callArgs}})`;
	return [signatureLine, ...doc, call];
}

/**
 * per-method: one Python module per tool.
 *
 * The docstring carries the server's description verbatim, so `grep`, `import`,
 * and `help()` all read the same text and cannot drift.
 */
export function renderToolModule(tool, { server, docsGate = "off" }) {
	return [
		`"""${server}.${tool.name} — generated from the MCP schema. Do not edit."""`,
		"",
		"from typing import Any, Literal",
		"",
		// `_client` lives at the api/ root, one level above the server package.
		`from .._client import call as _call`,
		"",
		"",
		// `__name__` is already the import path (`api.<pkg>.<tool>`), so arming the
		// gate needs no plumbing in this layout.
		...renderFunction(tool, { server, docsGate, pathLiteral: "__name__" }),
		"",
	].join("\n");
}

/**
 * consolidated: one Python module per APP, carrying every one of its APIs.
 *
 * The in-distribution shape — `stripe.py`, a boto3 service module, one reference
 * page per service. `cat api/gmail.py` is a single natural read that delivers the
 * whole app surface with full parameter documentation, where the per-method tree
 * makes the same information a 48-file operation that the measured agent does not
 * perform.
 *
 * The module docstring leads with the app's conventions for the same reason
 * DOCS.md does: auth and pagination are the part no single function's docstring
 * states, and both are derived from the schemas rather than asserted, so an app
 * that does not work that way is not told that it does.
 */
export function renderAppModule(tools, { server, pkg = pyPackage(server), docsGate = "off" }) {
	const conventions = appConventions(tools, pkg);
	const header = [
		`"""${server} — generated from the MCP schema. Do not edit.`,
		"",
		`${tools.length} API${tools.length === 1 ? "" : "s"}, all async, documented in full below.`,
		`Call them as \`api.${pkg}.<name>(...)\`.`,
		...(conventions.length > 0 ? ["", "Conventions:", ...conventions] : []),
		'"""',
	];
	const body = [];
	for (const tool of tools) {
		body.push(
			"",
			"",
			// A literal, not `__name__`: this module's `__name__` is only `api.<pkg>`,
			// so `__name__` would lose the tool half and the gate would fire once per
			// app instead of once per API.
			...renderFunction(tool, { server, docsGate, pathLiteral: JSON.stringify(`api.${pkg}.${tool.pyName}`) }),
		);
	}
	return [
		...header,
		"",
		"from typing import Any, Literal",
		"",
		// `_client` is a sibling module here, not a parent package.
		"from ._client import call as _call",
		...body,
		"",
		"",
		"__all__ = [",
		...tools.map((t) => `    "${t.pyName}",`),
		"]",
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
export function renderClient({ docsGate = "off", validateArgs = false, apiLayout: layout = "per-method" } = {}) {
	const mode = docsGateMode(docsGate);
	// Where the gate sends the agent, per layout. A pointer to a file that is not
	// there is worse than no pointer: it costs a turn and teaches that the tree
	// cannot be trusted. In consolidated the app module IS the documentation, so
	// there is no DOCS.md to cite.
	const docsTarget = apiLayout(layout) === "consolidated" ? "api/{pkg}.py" : "api/{pkg}/DOCS.md";
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
        f"First use of {name}. Before calling it, read ${docsTarget} — it"
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
        lines.append(f"and {rest} more — see ${docsTarget}")
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
        f"If a neighbor fits better, read ${docsTarget} before proceeding."
    )
    raise DocsFirst("\\n\\n".join(parts))

`;

	const gate = mode === "redirect" ? redirect : mode === "inline" ? inline : "";
	const validator = validateArgs ? renderValidator() : "";
	return `"""Transport for the generated api/ modules. Do not edit.

Every tool module calls \`_client.call\`, which forwards to the shared MCP proxy.
"""

${mode === "inline" ? "import inspect\n" : ""}import json
import os
${validateArgs ? "import re\n" : ""}import urllib.request

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

${validator}${gate}
async def call(server: str, tool: str, args: dict${mode === "inline" ? ", _doc: str | None = None, _path: str | None = None" : mode === "redirect" ? ", _path: str | None = None" : ""}) -> str:
    """Invoke an MCP tool and return its text result.

    Arguments whose value is None are dropped, so optional parameters left at
    their default are not sent as explicit nulls — several servers reject that.

    Raises:${validateArgs ? "\n        ArgumentError: An argument does not satisfy this API's schema. Nothing was sent." : ""}${mode === "off" ? "" : "\n        DocsFirst: This is the first call to this API; read the message, then call again."}
        McpError: The server returned an error or could not be reached.
    """${mode === "inline" ? "\n    if _path is not None:\n        _docs_first(server, tool, _doc, _path)" : mode === "redirect" ? "\n    if _path is not None:\n        _docs_first(server, tool, _path)" : ""}${
			validateArgs
				? // Validate what is actually SENT, i.e. after the None-drop below, or every
					// optional parameter left at its default would read as a null type violation
					// — the generated wrappers pass all of them on every call.
					'\n    sent = {k: v for k, v in (args or {}).items() if v is not None}\n    _validate(server, tool, sent)'
				: ""
		}
    payload = {
        "server": server,
        "tool": tool,
        "args": ${validateArgs ? "sent" : "{k: v for k, v in (args or {}).items() if v is not None}"},
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
export function renderRootIndex(catalogue, { docsGate = "off", validateArgs = false, apiLayout: layout = "per-method" } = {}) {
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
	// Announced for the same reason, and only when it is on: an unexplained
	// exception on a call the agent believes is correct is a bug to work around,
	// where a documented contract is a rule to satisfy.
	const validation = validateArgs
		? [
				"Arguments are checked against each API's schema before the call is sent. A",
				"violation raises `ArgumentError` naming the argument and what it allows, and",
				"nothing reaches the server — fix the argument and call again.",
				"",
			]
		: [];
	return [
		"# api",
		"",
		`${catalogue.length} servers, ${total} tools, all async.`,
		"",
		...announcement,
		...validation,
		"Find a tool:",
		"  grep -ril '<keyword>' api/          # search every tool's documentation",
		// Per layout, and only the files that exist in it. The consolidated tree has
		// no per-app INDEX.md because the module is the index.
		...(apiLayout(layout) === "consolidated"
			? ["  cat api/<package>.py                # one app: every API, with full parameter docs"]
			: ["  cat api/<package>/INDEX.md          # list one server's tools", "  cat api/<package>/<tool>.py         # full parameter documentation"]),
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
 * @param options.validateArgs render `_schemas.json` and check every call's
 *        arguments against it before the request leaves the process
 * @param options.apiLayout "per-method" | "consolidated" — see API_LAYOUTS
 * @returns { toolDefs, tocLines, names, files } — `files` is a path -> content
 *          map rooted at `api/`, written to disk by the caller.
 */
export function generate(catalogue, { docsGate = "off", validateArgs = false, apiLayout: layout = "per-method" } = {}) {
	const gateMode = docsGateMode(docsGate);
	const layoutMode = apiLayout(layout);
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
		"INDEX.md": renderRootIndex(normalized, { docsGate: gateMode, validateArgs, apiLayout: layoutMode }),
		"__init__.py": '"""Generated MCP tool catalogue. See INDEX.md."""\n',
		"_client.py": renderClient({ docsGate: gateMode, validateArgs, apiLayout: layoutMode }),
	};
	// Only when validation is on: an unused 469-schema file in the tree is one more
	// hit in the agent's `grep -ril` and one more thing to read.
	if (validateArgs) files["_schemas.json"] = renderSchemas(normalized);
	// Only the mode that cites siblings pays for the table. Every extra file in
	// the tree is one more line in the agent's `grep -ril`.
	if (gateMode === "inline") files["_neighbours.json"] = renderNeighbours(normalized);

	for (const { server, pyServer, tools } of normalized) {
		toolDefs.push(...renderToolDefs(tools, { server }));
		tocLines.push(...renderTocLines(tools, { server }));
		names.push(...renderNames(tools, { server }));

		if (layoutMode === "consolidated") {
			// One module, and nothing else: no per-app INDEX.md (the module is the
			// index), no DOCS.md (the module is the documentation), no per-method files.
			files[`${pyServer}.py`] = renderAppModule(tools, { server, pkg: pyServer, docsGate: gateMode });
			continue;
		}
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
