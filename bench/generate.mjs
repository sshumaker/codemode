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
import { isNestedShape, isNullable, paramAdapter, paramExample } from "./pythonic-args.mjs";

/** JSON Schema type -> Python type hint. */
import { DEFAULT_REF_FORMATS, UNTYPED_RESULT, collectOutputTypes, renderOutputTypes, untypedTools } from "./output-types.mjs";
import { collectInputTypes, renderInputTypes } from "./input-types.mjs";

/**
 * The header `_client.call` stamps on every request, so a forwarder can tell a call
 * that came through the compiled bridge from raw JSON POSTed at the proxy. `null`
 * sends none. A forwarder that already checks a name of its own passes that name.
 */
export const DEFAULT_BRIDGE_HEADER = "x-harness-bridge";
// Why it exists (W40 §3a, experiment-lab): 10.7% of measured rounds skipped the
// bridge and POSTed raw JSON to HARNESS_MCP_PROXY, which a cell's os.environ dump
// hands them -- tool-calling-over-HTTP inside the codemode arm, the representation
// under test discarded. The header lets the forwarder tell the two apart, and
// refuse the raw one with a correction naming api/_client. The rationale lives
// here rather than in the rendered transport: every line of `_client.py` is text
// the agent can read, and this one would be about the harness, not the task.

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

/**
 * Description text made safe for interpolation into a `"""…"""` docstring.
 *
 * Backslashes double (so the DISPLAYED text is unchanged — Python renders \\ as
 * \), then `"""` is escaped, then a trailing `"` is escaped so it cannot fuse
 * with the closing quotes. Without this, one `"""` anywhere in an MCP tool
 * description is a SyntaxError that takes out the whole app module in the
 * consolidated layout — and only drops one tool in per-method, i.e. a
 * capability difference between arms masquerading as a token saving. AppWorld
 * ships zero of either character, which is luck, not a property; the first
 * real-world catalogue is where this fires. The sanitisation is display-
 * preserving, so on catalogues without these characters output is unchanged.
 */
export function pyDocstring(text) {
	let safe = String(text ?? "").replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
	if (safe.endsWith('"')) safe = `${safe.slice(0, -1)}\\"`;
	return safe;
}

/**
 * One enum/const member as a PYTHON literal.
 *
 * JSON.stringify emits `true`/`false`/`null` — which PARSE inside a Literal[…]
 * annotation and then raise NameError at import, past the ast.parse gate the
 * tests used to rely on. Objects and arrays have no Literal spelling; the
 * caller degrades the whole enum to the base type instead.
 */
export function pyLiteral(v) {
	if (v === true) return "True";
	if (v === false) return "False";
	if (v === null) return "None";
	if (typeof v === "object") return null; // no Literal spelling — degrade
	return JSON.stringify(v);
}

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
		const members = schema.enum.map(pyLiteral);
		// Any member with no Literal spelling (an object/array) degrades the whole
		// enum to the base type rather than emitting a token that NameErrors.
		if (members.every((m) => m !== null)) return `Literal[${members.join(", ")}]`;
		return PY_TYPES[schema.type] ?? "Any";
	}
	// A single permitted value is a Literal, same as a one-member enum. Rendering it
	// `str` would drop the only thing the schema actually says about the parameter.
	if ("const" in schema) {
		const member = pyLiteral(schema.const);
		if (member !== null) return `Literal[${member}]`;
		return PY_TYPES[schema.type] ?? "Any";
	}
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
	// The map case, and the same information loss as the two branches above and
	// below: `{"type": "object", "additionalProperties": {...}}` is a homogeneous
	// dict, and rendering it bare `dict` says nothing about what goes in it. JSON
	// object keys are always strings, so the key type is exact rather than a guess.
	// Measured on the product port: `complete_job.final_outputs` is
	// `additionalProperties: {type: array, items: {type: string}}` — i.e.
	// `dict[str, list[str]]` — and rendered `dict`, whereupon four consecutive real
	// jobs called it with a bare list and had to `cat` the wrapper to recover. The
	// docstring carried the shape the whole time; the signature is what the agent
	// writes from, so the signature is where the shape has to be.
	// `additionalProperties: true`/`false`/absent stays `dict`: those say the
	// values are unconstrained, which bare `dict` already expresses.
	if (schema.type === "object" && schema.additionalProperties && typeof schema.additionalProperties === "object") {
		return `dict[str, ${pyType(schema.additionalProperties)}]`;
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

/**
 * The signature type for a parameter the T1 adapter widens.
 *
 * The strict form stays first, because it is the one the schema declares and the
 * one the server sees; the two accepted alternatives follow. `list[dict[str, str]]`
 * rather than the bare `list[dict]` pyType would emit whenever every property is
 * a string — the item shape is the thing the model was getting wrong, so erasing
 * it from the signature is the last place to save characters.
 */
function adaptedType(schema, adapter) {
	if (adapter.kind === "singleton") {
		// `list[str] | str`, not `Any`: the strict form stays first and the ONE extra
		// shape is named, so the signature still says what the server wants.
		return `${pyType(schema)} | ${PY_TYPES[adapter.itemType] ?? "Any"}`;
	}
	const strict = adapter.allStrings ? "list[dict[str, str]]" : pyType(schema);
	return `${strict} | list[str] | dict[str, str]`;
}

/** The `_client` helper a parameter's adapter is coerced by, and its arguments. */
function coercion(param) {
	const { adapter, pyName } = param;
	if (adapter.kind === "singleton") {
		return { helper: "as_list", call: `_as_list(${pyName}, ${JSON.stringify(adapter.itemType)})` };
	}
	return {
		helper: "labeled_ids",
		call:
			`_labeled_ids(${pyName}, ${JSON.stringify(adapter.labelKey)},` +
			` ${JSON.stringify(adapter.idKey)}, ${JSON.stringify(adapter.stem)})`,
	};
}

/** The import alias each helper is called through, in a stable order. */
const HELPER_IMPORTS = {
	unset: "UNSET as _UNSET",
	labeled_ids: "labeled_ids as _labeled_ids",
	as_list: "as_list as _as_list",
	wait_bridge: "wait_bridge as _wait_bridge",
};

/** `call as _call` plus whatever coercion helpers these tools actually use. */
function clientImport(tools, from, waitBridge = false) {
	const helpers = new Set();
	for (const tool of tools) for (const p of tool.params) if (p.adapter) helpers.add(coercion(p).helper);
	if (tools.some((t) => t.params.some((p) => !p.required))) helpers.add("unset");
	if (waitBridge && tools.some((t) => waitToolParam(t))) helpers.add("wait_bridge");
	const extra = Object.keys(HELPER_IMPORTS)
		.filter((h) => helpers.has(h))
		.map((h) => HELPER_IMPORTS[h]);
	// W130: a module with a launch needs the launcher, the Handle its annotation names,
	// and `result(name)` so a wake can collect a run by name without the variable.
	const launch = tools.some((t) => t.launches) ? ["launch as _launch", "Handle", "result"] : [];
	return `from ${from} import ${["call as _call", ...extra, ...launch].join(", ")}`;
}

/** Normalize one MCP tool into the shape every renderer consumes. */
export function normalizeTool(tool) {
	const schema = tool.inputSchema ?? tool.input_schema ?? { type: "object", properties: {} };
	const properties = schema.properties ?? {};
	const required = new Set(schema.required ?? []);

	const params = Object.entries(properties).map(([name, spec]) => {
		// Schema-shape-driven, computed once, here — so the signature, the docstring,
		// the INDEX line, the resident L4 docs and the validator's example table are
		// all rendered from one decision about one parameter and cannot disagree
		// about what shape it accepts.
		const adapter = paramAdapter(spec, name);
		return {
			name,
			pyName: pyIdent(name),
			required: required.has(name),
			type: adapter ? adaptedType(spec, adapter) : pyType(spec),
			description: (spec?.description ?? "").trim(),
			// The coercion this parameter accepts, if any: `{labelKey, idKey, stem}`.
			adapter,
			nullable: isNullable(spec),
			// A literal of the right shape, for the error channel. Every container gets
			// one; only a container OF containers (`nested`) is worth the characters in
			// an INDEX line or a docstring.
			example: paramExample(spec, name),
			nested: isNestedShape(spec),
			// The server-side default, surfaced in the docstring. Vanilla's tool defs
			// carry it in the raw schema; dropping it here made 363 AppWorld defaults
			// visible to one arm and invisible to the other — an asymmetry against
			// the fairness invariant (2026-08-15 review, P1.5).
			serverDefault: spec !== null && typeof spec === "object" && "default" in spec ? spec.default : undefined,
			// The schema's bounds, surfaced in the docstring. The validator enforces
			// them (`_schemas.json` is the same spec), and the raw schema shows them
			// to vanilla; a docstring that omits them makes the first in-range guess
			// a coin flip. Measured (W126, h57): 136 constraints across 64 tools,
			// none rendered, 1.57 ArgumentError turns per job — 20 of them
			// `max_timeout` > 60 on a parameter documented as "Maximum seconds".
			constraints: paramConstraints(spec),
		};
	});

	// Two wire names can normalize to one identifier (`page-index` and
	// `page_index`): the second becomes `page_index_2` instead of a SyntaxError
	// (duplicate argument) that takes the whole module down. The wire `name` is
	// untouched — _call sends the original.
	const seenParams = new Map();
	for (const p of params) {
		const n = seenParams.get(p.pyName) ?? 0;
		seenParams.set(p.pyName, n + 1);
		if (n > 0) p.pyName = `${p.pyName}_${n + 1}`;
	}

	// Required parameters must precede optional ones in a Python signature.
	params.sort((a, b) => Number(b.required) - Number(a.required));

	// A catalogue may name the Python function apart from the wire tool: `pyName`
	// (or `call_name`, the product catalogue's spelling) wins over the derived name,
	// and `_call` still sends `name`.
	const override = tool.pyName ?? tool.py_name ?? tool.call_name;
	return {
		name: tool.name,
		pyName: override ? pyIdent(String(override)) : tool.launches ? `spawn_${pyIdent(tool.name).replace(/_tool$/, "")}` : pyIdent(tool.name),
		renamed: Boolean(override),
		description: (tool.description ?? "").trim(),
		// Optional, and optional per TOOL rather than per server: the registry knows
		// which of its actions are image work and which are video work, and a
		// catalogue that does not say simply groups as it always did.
		category: String(tool.category ?? "").trim(),
		// W130 (docs/W130-OBSERVE-IS-THE-WAIT.md): two facts about a tool's TIME.
		// awaitsInputs — needs its input assets finished; the codemode client raises
		// NotReady on an unfinished one and names wait_for. launches — starts work
		// that can take minutes; exposed as a launch returning a handle, named
		// spawn_<stem> (judge_tool → spawn_judge), collected after a wait_for.
		awaitsInputs: Boolean(tool.awaitsInputs ?? tool.awaits_inputs ?? false),
		launches: Boolean(tool.launches ?? false),
		schema,
		params,
		// The output half of the contract, as MCP publishes it. Compiled by
		// output-types.mjs into the class the wrapper returns; a tool without one
		// returns the untyped base (and generate() refuses the catalogue unless
		// told to allow it — the schema is a declaration the PRODUCT owes).
		outputSchema: tool.outputSchema ?? tool.output_schema ?? null,
	};
}

const firstLine = (text) => (text ?? "").trim().split("\n")[0]?.trim() ?? "";

/**
 * The required-default transform: an optional parameter that decides WHO a
 * mutation lands on is rendered with no default, so it cannot be left out.
 *
 * Measured motivation, in full in `docs/CC-EDGE-TRACES.md` §M1 and in the header
 * of `bench/required-defaults.mjs`: `gmail.reply_to_email.email_addresses`
 * defaults to "the sender", which on an outbox thread is the user themselves.
 * 35 of 36 codemode runs omitted it and every one failed. Making the schema
 * visible did not fix it (L4 fails identically), and *proving the model read the
 * sentence* did not fix it (the verified read-gate). Visible-and-optional loses;
 * the untested condition is required.
 *
 * What the transform is allowed to be, stated as a constraint on this file: it
 * changes the SIGNATURE and one docstring line, and nothing else. The call site,
 * the transport, the arguments actually sent and the tree's layout are all
 * untouched, so with the flag off the tree is byte-identical to the one every
 * earlier run used — asserted in `bench/test/required-defaults.test.mjs`.
 *
 * The list itself is never authored here. It comes from a codegen-time
 * classifier that sees schemas and docstrings only, and every entry carries the
 * verbatim sentence that justifies it.
 */
/**
 * The bounds a schema states for one parameter, or null when it states none.
 *
 * Only the keywords the validator checks (generate's `renderValidator`): numeric
 * minimum/maximum (and the exclusive forms), string minLength/maxLength, array
 * minItems/maxItems. Read from the top-level property spec only — that is where
 * all 136 of the product catalogue's constraints sit, and nested bounds already
 * reach the agent through the validator's per-path error message.
 */
export function paramConstraints(spec) {
	if (spec === null || typeof spec !== "object") return null;
	const out = {};
	for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"]) {
		if (typeof spec[k] === "number") out[k] = spec[k];
	}
	return Object.keys(out).length > 0 ? out : null;
}

/**
 * The schema's bounds as one docstring line — or null.
 *
 * Says the same thing the validator's error will say, in the place the agent
 * reads BEFORE calling: `wait_for_assets.max_timeout` renders as
 * `Range: 1 <= value <= 60.`, so "wait up to 300s" is a decision made against the
 * bound rather than a round trip that discovers it.
 */
export function constraintNote(param) {
	const c = param?.constraints;
	if (!c) return null;
	const parts = [];
	const lo = c.exclusiveMinimum !== undefined ? `${c.exclusiveMinimum} <` : c.minimum !== undefined ? `${c.minimum} <=` : null;
	const hi = c.exclusiveMaximum !== undefined ? `< ${c.exclusiveMaximum}` : c.maximum !== undefined ? `<= ${c.maximum}` : null;
	if (lo || hi) parts.push(`Range: ${[lo, "value", hi].filter(Boolean).join(" ")}.`);
	if (c.minLength !== undefined || c.maxLength !== undefined) {
		parts.push(
			c.minLength !== undefined && c.maxLength !== undefined
				? `Length: ${c.minLength} to ${c.maxLength} characters.`
				: c.minLength !== undefined
					? `Length: at least ${c.minLength} character${c.minLength === 1 ? "" : "s"}.`
					: `Length: at most ${c.maxLength} characters.`,
		);
	}
	if (c.minItems !== undefined || c.maxItems !== undefined) {
		parts.push(
			c.minItems !== undefined && c.maxItems !== undefined
				? `Items: ${c.minItems} to ${c.maxItems}.`
				: c.minItems !== undefined
					? `Items: at least ${c.minItems}.`
					: `Items: at most ${c.maxItems}.`,
		);
	}
	return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * The schema's own `default`, as one docstring line — or null.
 *
 * Skipped for promoted (requiredDefault) parameters: those get the "Required
 * here" sentence instead, and showing a default under a required slot would
 * reintroduce exactly the contradiction the promotion removed.
 */
export function serverDefaultNote(param) {
	if (param.serverDefault === undefined || param.requiredDefault || param.required) return null;
	const literal = JSON.stringify(param.serverDefault);
	if (literal === undefined || literal.length > 80) return null;
	// Sanitize backslashes and triple-quotes only. pyDocstring's trailing-quote
	// escape is for text that ENDS a docstring; here a period follows, and the
	// escape DISPLAYED — seen in a live trace as `Server-side default: "success\".`
	const safe = literal.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
	return `Server-side default: ${safe}.`;
}

/**
 * The T1 adapter's accepted alternatives, as one docstring line — or null.
 *
 * Stated in the docstring rather than only in the widened type hint because the
 * generated labels are the part a type cannot express: a caller handing over bare
 * ids is agreeing to labels it did not choose, and it should be able to see what
 * they will be before the judge's output comes back naming `asset_2`.
 */
export function adapterNote(param) {
	if (!param?.adapter) return null;
	const adapter = param.adapter;
	if (adapter.kind === "singleton") {
		// Short on purpose: this note lands on 23 AppWorld parameters and 23 product
		// ones, so a sentence is a per-parameter tax across the whole tree.
		return `Also accepts a single ${PY_TYPES[adapter.itemType] ?? "value"}, wrapped as a one-item list.`;
	}
	const { labelKey, idKey, stem } = adapter;
	return (
		`Also accepts a plain list of ${idKey} strings — labels are generated` +
		` ('${stem}_1', '${stem}_2', ...) — or a {${labelKey}: ${idKey}} dict.`
	);
}

/**
 * One literal example of a nested parameter, as a docstring line — or null.
 *
 * Only for a container OF containers, and only where an example could be derived
 * from the schema. The flat parameters in the measured traces never failed, and a
 * docstring that exemplifies `page_index=1` spends characters teaching nothing.
 */
/**
 * The one sentence a wait-bridged tool's docstring gains — or null.
 *
 * Scott-ordered, and it teaches the affordance where the model reads rather than
 * in a prompt it has already stopped attending to. The verb matters: "yields the
 * REPL" is what actually happens (runtime/jobs.py raises WaitSignal, the cell
 * ends, the host waits with the kernel released), and the last clause is the
 * behaviour change we want — the cap is no longer a reason to ask for less time
 * than the job needs.
 */
export function waitNote(tool, param) {
	if (!param) return null;
	return (
		`Long waits YIELD THE REPL: this cell ends while the host waits, and the kernel` +
		` resumes with the result when the wait resolves or the next hop is due. Each` +
		` server call waits at most ${waitToolCap(tool, param)}s; request the ${param.pyName} you actually need.`
	);
}

export function exampleNote(param) {
	if (!param?.example || !param.nested) return null;
	// When the example was mined out of this parameter's own description, the
	// docstring already shows it and a second copy two lines below reads as two
	// different examples. The INDEX line still needs it: that line carries only the
	// TOOL's first description line, never a parameter's.
	const squash = (text) => String(text).replace(/\s+/g, "");
	if (squash(param.description).includes(squash(param.example))) return null;
	return `Example: ${param.pyName}=${param.example}`;
}

export function requiredDefaultNote(param) {
	if (!param?.requiredDefault) return null;
	// Whitespace-collapsed, and `"""` removed so a quote can never terminate the
	// docstring it is quoted inside. Backslashes go for the same reason: this text
	// is emitted into a Python source file, and CLAUDE.md already records a run
	// where an injected snippet's backslashes were mangled into a file that would
	// not compile.
	const quote = String(param.requiredDefault).replace(/\s+/g, " ").replace(/["\\]/g, "").trim().slice(0, 200);
	return (
		`Required here: the server-side default ('${quote}') resolves against` +
		" runtime state, so you must choose explicitly."
	);
}

/**
 * Promote the listed parameters of one tool from optional to required.
 *
 * Copies rather than mutates: `normalizeTool` hands back the catalogue's own
 * `inputSchema` object, so writing `required` through would edit the shared
 * catalogue in memory and make a second `generate()` in the same process return
 * something different from the first — a silent cross-run contamination in
 * exactly the family this project keeps finding.
 */
function applyRequiredDefaults(tool, server, index) {
	if (!index || index.size === 0) return tool;
	const promoted = [];
	const params = tool.params.map((p) => {
		const quote = index.get(`${server}\u0000${tool.name}\u0000${p.name}`);
		if (quote === undefined || p.required) return p;
		promoted.push(p.name);
		return { ...p, required: true, requiredDefault: quote };
	});
	if (promoted.length === 0) return tool;
	// Required parameters must precede optional ones in a Python signature. The
	// sort is stable, so the originally-required ones keep their order and the
	// promoted ones follow in theirs.
	params.sort((a, b) => Number(b.required) - Number(a.required));
	return {
		...tool,
		params,
		// The schema moves with the signature, so `--validate-args` enforces the same
		// presence the signature does and `_schemas.json` cannot disagree with the
		// module it sits next to.
		schema: { ...tool.schema, required: [...new Set([...(tool.schema.required ?? []), ...promoted])] },
	};
}

/**
 * One parameter as it appears in an INDEX one-liner: `name`, `name?`, or
 * `name?=<example>` when the value is a nested literal.
 *
 * The example is here, in the one-liner, because that is where the measured
 * behaviour is: GLM 5.2 writes calls straight off this line without opening the
 * tool module, and 12 of 83 cells in the product port died on a nested literal it
 * had to invent. A parameter whose shape is flat gets nothing — an INDEX line
 * carrying `page_index?=1` is longer and teaches nothing.
 */
const indexSlot = (p) => `${p.pyName}${p.required ? "" : "?"}${p.nested && p.example ? `=${p.example}` : ""}`;

/**
 * `api.<pkg>.<tool>(required, optional?)` — the call an agent would type.
 *
 * One function because three renderers show this string (the server index, the
 * gate's neighbour table, the TOC), and three spellings of one API's signature
 * is exactly the drift the single-authored-description rule exists to prevent.
 */
export function pyCallSignature(tool, pkg) {
	// W130: a launch takes an optional name first — `spawn_judge("kite-check", ...)`.
	const slots = tool.params.map(indexSlot);
	return `api.${pkg}.${tool.pyName}(${(tool.launches ? ["name?", ...slots] : slots).join(", ")})`;
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
export function renderTocLines(tools, { server, pkg = pyPackage(server), style = "python" } = {}) {
	return tools.map((t) => {
		const path =
			style === "wire"
				? `${wireName(server, t.name)}(${t.params.map((p) => (p.required ? p.pyName : `${p.pyName}?`)).join(", ")})`
				: pyCallSignature(t, pkg);
		const mark = t.launches
			? " [launch → Handle; collect after wait_for]"
			: t.awaitsInputs
				? " [needs finished inputs: NotReady → wait_for]"
				: "";
		return `${path} — ${firstLine(t.description)}${mark}`;
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
export function renderFullDocs(tools, { server, pkg = pyPackage(server), heading = true, constraintNotes = false }) {
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
			const required = requiredDefaultNote(p);
			const dflt = serverDefaultNote(p);
			const adapted = adapterNote(p);
			const example = exampleNote(p);
			const bounds = constraintNotes ? constraintNote(p) : null;
			if (!p.description && !required && !dflt && !adapted && !example && !bounds) continue;
			if (p.description) lines.push(`      ${p.pyName}: ${p.description}${p.required ? "" : " (optional)"}`);
			// The same sentences the module docstring carries, from the same helpers:
			// the resident L4 text and the on-disk text must not be able to drift.
			if (required) lines.push(`        ${required}`);
			if (dflt) lines.push(`        ${dflt}`);
			if (adapted) lines.push(`        ${adapted}`);
			if (example) lines.push(`        ${example}`);
			if (bounds) lines.push(`        ${bounds}`);
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
export function renderSchemas(normalized, { waitSurface = false, modules = null } = {}) {
	const packages = {};
	const tools = {};
	const examples = {};
	const time = {};
	const functions = {};
	for (const { server, pyServer, tools: list } of normalized) {
		packages[server] = pyServer ?? pyPackage(server);
		for (const t of list) if (t.renamed) (functions[server] ??= {})[t.name] = t.pyName;
		tools[server] = Object.fromEntries(list.map((t) => [t.name, stripProse(t.schema)]));
		// W130: the time facts, per tool, for the forwarder (which tools need finished
		// inputs; which are launches). Same source as the wrappers' docstrings.
		for (const t of list) {
			if (t.awaitsInputs || t.launches) {
				(time[server] ??= {})[t.name] = { awaitsInputs: Boolean(t.awaitsInputs), launches: Boolean(t.launches) };
			}
		}
		// One literal per non-scalar parameter, for the ArgumentError to quote. A
		// SIBLING table rather than a key inside each schema, so the `schema for
		// <name>: {...}` line the error already prints stays the schema and nothing
		// else — and so `_check` can never be handed our own annotation as a
		// constraint to enforce.
		const perTool = {};
		for (const tool of list) {
			const perParam = {};
			for (const p of tool.params) if (p.example) perParam[p.name] = p.example;
			if (Object.keys(perParam).length > 0) perTool[tool.name] = perParam;
		}
		if (Object.keys(perTool).length > 0) examples[server] = perTool;
	}
	const table = waitSurface ? { packages, tools, examples, time } : { packages, tools, examples };
	// Only a tree with category modules carries it: there the server's package is not
	// where the function lives, so an error naming it names a call that was never made.
	if (modules && Object.keys(modules).length > 0) table.modules = modules;
	// Only a catalogue that names functions apart from their tools carries it.
	if (Object.keys(functions).length > 0) table.functions = functions;
	return `${JSON.stringify(table, null, 1)}\n`;
}

/** `{<server>: {<tool>: <module>}}` for every tool rendered in a category module. */
export function categoryModuleMap(normalized, claimed) {
	const out = {};
	for (const { server, pyServer, tools } of normalized) {
		for (const group of categoryModules(tools, pyServer, claimed).groups) {
			for (const tool of group.tools) (out[server] ??= {})[tool.name] = group.module;
		}
	}
	return out;
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
function renderValidator({ renamed = false } = {}) {
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
        # The map case: additionalProperties, as a schema, constrains every value
        # not covered by properties. Without this a homogeneous dict was checked
        # only for being a dict, so {"image": "id"} passed here and failed at the
        # server — one round trip later, and for a graded run, one error row in the
        # trace the graders read.
        extra = schema.get("additionalProperties")
        if isinstance(extra, dict):
            for key, item in value.items():
                if key in properties:
                    continue
                problem = _check(item, extra, f"{path}[{key!r}]")
                if problem:
                    return problem
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


def _example(server: str, tool: str, name: str) -> str:
    """One literal of the right shape for a non-scalar argument, as a suffix line.

    Measured reason this is in the error rather than only in the documentation:
    GLM 5.2 passed a bare list for \`complete_job.final_outputs\` — declared
    \`dict[str, list[str]]\` — in 3 of 5 jobs, and each recovery cost a turn spent
    re-reading the tool module. The shape it needed fits on one line, and this
    project has repeatedly measured the error channel to be the one a model
    actually adopts from, where the same sentence in a prompt is not.
    """
    literal = ((((_table().get("examples") or {}).get(server) or {}).get(tool)) or {}).get(name)
    return f"\\n  example: {name}={literal}" if literal else ""


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
    # In a category layout the function lives in its category's module, not the server's.
    module = ((_table().get("modules") or {}).get(server) or {}).get(tool)
    call = f"api.{module or (_table().get('packages') or {}).get(server, server)}.{${renamed ? `((_table().get('functions') or {}).get(server) or {}).get(tool, tool)` : "tool"}}"

    for name in schema.get("required", []):
        if name not in args:
            known = ", ".join(sorted(properties)) or "none"
            raise ArgumentError(
                f"{call}: missing required argument {name!r}. Parameters: {known}"
                f"{_example(server, tool, name)}"
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
            # The example first, then the schema: the actionable line should not be
            # below a JSON blob a model has to scroll past to reach it.
            raise ArgumentError(
                f"{call}: {problem}{_example(server, tool, name)}"
                f"\\n  schema for {name}: {json.dumps(spec)}"
            )

`;
}

/**
 * The unset sentinel and the one filter every send path applies, in `_client.py`.
 *
 * A wrapper's optional parameters default to `UNSET`, not None, so an omitted
 * argument and an explicit `None` stay distinguishable down to the send. Its repr
 * is "None", so `help()` and `inspect.signature` still read `= None`. Falsy, so a
 * helper that tests an optional value for truth (`wait_bridge`) reads it as absent.
 */
function renderSendable(nullable) {
	const entries = nullable.map(([server, tool, names]) => `    (${JSON.stringify(server)}, ${JSON.stringify(tool)}): frozenset({${names.map((n) => JSON.stringify(n)).join(", ")}}),`);
	const table = entries.length ? `{\n${entries.join("\n")}\n}` : "{}";
	return `

class _Unset:
    """The default of every optional wrapper parameter: not passed, distinct from None."""

    def __repr__(self) -> str:
        return "None"

    def __bool__(self) -> bool:
        return False


UNSET = _Unset()

# Per (server, tool), the parameters whose schema accepts null. Generated.
_NULLABLE: dict[tuple[str, str], frozenset[str]] = ${table}


def _sendable(args: dict | None, nullable: frozenset[str] | None = None) -> dict:
    """The arguments to send: UNSET dropped, None kept only where the schema accepts null."""
    return {
        k: v
        for k, v in (args or {}).items()
        if v is not UNSET and (v is not None or (nullable is not None and k in nullable))
    }

`;
}

/**
 * The T1 coercion, rendered into `_client.py` only when some tool takes an
 * adaptable argument.
 *
 * In `_client` rather than inlined into 469 modules for the reason the validator
 * is data-driven: one implementation is one place to be wrong, and the generated
 * wrappers stay a signature and a call. It is public (no leading underscore) and
 * documented, because a model that reads the module can then see exactly what
 * happened to its argument — a silent rewrite of a call's payload is the kind of
 * helpfulness that becomes unattributable in a trace.
 *
 * Deterministic and total: a strict-form value is returned unchanged, an
 * unrecognised value is returned unchanged for the validator to reject, and
 * nothing here can turn a valid call into an invalid one.
 */
function renderAdapters(helpers, typedReturns = false) {
	// A typed result is reduced to its id by the same `asset_id` `_call` applies to
	// every argument, only first: the adapters decide by shape (is this an id? a lone
	// scalar?), and a result is neither until it has been coerced. Idempotent, so the
	// second pass in `_call` changes nothing.
	const coerce = typedReturns ? "\n    value = _asset_ids(value)" : "";
	const labeledIds = `

def labeled_ids(value: object, label_key: str, id_key: str, stem: str) -> object:
    """Accept a bare id list, or a {label: id} dict, where [{label, id}] is declared.

    The declared shape carries nothing a list of ids does not, except labels — and
    a label the caller did not choose can be generated, which is what this does:

        ['a1', 'a2']            -> [{label_key: f'{stem}_1', id_key: 'a1'}, ...]
        {'hero': 'a1'}          -> [{label_key: 'hero', id_key: 'a1'}]
        [{'label': 'hero', ...}] -> unchanged

    Anything else is returned unchanged, so a value this function does not
    understand reaches the schema check rather than a rewrite of it.
    """${coerce}
    if isinstance(value, dict):
        return [{label_key: str(key), id_key: item} for key, item in value.items()]
    if isinstance(value, (list, tuple)):
        # Per element, so a partly-labeled list works too: the strict entries are
        # kept verbatim and only the bare ids get a generated label.
        return [
            {label_key: f"{stem}_{i + 1}", id_key: item} if isinstance(item, str) else item
            for i, item in enumerate(value)
        ]
    return value

`;

	const asList = `

def as_list(value: object, item_type: str) -> object:
    """Wrap a lone scalar in a one-item list, where an array of scalars is declared.

        'abc123'   with item_type 'string'   -> ['abc123']
        ['abc123']                           -> unchanged
        5          with item_type 'string'   -> unchanged (the validator says why)

    Only when the scalar's type matches the declared item type, so a genuine type
    error still reaches the schema check as itself rather than buried in a list.
    Which parameters get this at all is decided at compile time — an array of
    objects, or one demanding two items, is never wrapped.
    """${coerce}
    # Python's bool is an int subclass, so it has to be excluded explicitly, or
    # flags=True would arrive at an array-of-integer parameter as [True].
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return [value] if item_type == "string" else value
    if isinstance(value, int):
        return [value] if item_type in ("number", "integer") else value
    if isinstance(value, float):
        return [value] if item_type == "number" else value
    return value

`;

	// Only the helpers some generated module imports. An unused function in the
	// tree is one more hit in the agent's `grep -ril` and one more thing to read.
	return [helpers.has("labeled_ids") ? labeledIds : "", helpers.has("as_list") ? asList : ""].join("");
}

/**
 * The wait-tool override: a tool that BLOCKS server-side, with a cap the model
 * keeps exceeding.
 *
 * Measured: `wait_for_assets` declares `max_timeout` with `le=60`, and GLM asks for
 * 120 or 300 — 7+ ArgumentErrors across arms, the single most recurring friction in
 * the port. The cap is real (the server enforces it), so the fix cannot be to widen
 * the schema; it has to be to spend more wall-clock than one call is allowed to.
 *
 * Deliberately narrow and shape-driven rather than a name list: a tool called
 * `wait_*` with a numeric `max_timeout`-ish parameter carrying a `maximum`. Anything
 * else compiles exactly as before.
 */
export function waitToolParam(tool) {
	if (!/^wait(_|$)/.test(tool.name ?? "")) return null;
	return (
		tool.params.find(
			(p) =>
				/timeout|seconds|duration/.test(p.name) &&
				typeof (tool.schema?.properties?.[p.name] ?? {}).maximum === "number",
		) ?? null
	);
}

/** The per-call cap the SERVER enforces, from the schema itself. */
export function waitToolCap(tool, param) {
	return tool.schema.properties[param.name].maximum;
}

/**
 * `wait_bridge`, rendered into `_client.py` when the catalogue has a wait tool.
 *
 * The design call, made from the harness primitive rather than from preference.
 * `jobs.wait(wake_after=N)` (runtime/jobs.py) prints a sentinel, writes the wake
 * request to disk and raises `WaitSignal` — it ENDS THE CELL. The host then sleeps
 * outside the kernel and calls the model again. It is not cell-resumable: nothing
 * after `jobs.wait` in a cell ever runs, by construction. So a compiled wrapper
 * cannot loop across a wait, and the honest shape is hop-and-yield:
 *
 *   hop:   one server call at the cap it allows — the only wait the SERVER can do
 *   yield: end the cell, release the kernel, let the host spend the remaining time
 *
 * What that buys, precisely: today a poll returns immediately (the shim flattens
 * the product's suspension), so twenty polls burn twenty turns and ~no wall clock.
 * After this, each turn covers a real host-side sleep with the kernel released, and
 * `HARNESS_MIN_WAIT_SECONDS` (60 by default) is the floor on a hop.
 *
 * What it does NOT do, and why: it does not parse the result to decide whether the
 * assets resolved. Every `wait_for_assets` call in the traces I have died on the
 * cap, so the resolved-vs-in-flight response shape is unobserved, and a poller that
 * guessed it would return a fake success and let the job proceed on an unready
 * asset — a plausible number instead of an error, which is this project's
 * signature failure. The model reads the product's own verbatim result each hop and
 * decides. Collapsing this to two turns needs that shape; see the report.
 */
function renderWaitBridge() {
	return `

async def wait_bridge(server: str, tool: str, args: dict, requested: float | None, cap: float) -> str:
    """Spend more wall-clock than one call is allowed to, without holding the kernel.

    OFF unless HARNESS_WAIT_BRIDGE=1, and off is the behaviour this tree always had:
    the request goes through untouched, so a value above the server's cap raises the
    same ArgumentError it always raised.
    """
    if os.environ.get("HARNESS_WAIT_BRIDGE") != "1" or not requested or requested <= cap:
        return await call(server, tool, args)

    # The hop the server will actually accept. Never more than the cap, so the
    # validator sees a legal value and the wire is unchanged.
    hop = dict(args)
    hop[_wait_param(args, cap)] = cap
    text = await call(server, tool, hop)
    remaining = float(requested) - cap
    if remaining <= 0 or _wait_resolved(text) is not False:
        # Resolved, or a shape this function does not model. Either way the answer
        # is the server's own text, returned now — see _wait_resolved.
        return text

    print(text)
    print(
        f"[waited {cap:.0f}s of {float(requested):.0f}s server-side. Ending the cell to spend the"
        f" remaining {remaining:.0f}s with the kernel released — re-issue this call to continue"
        " waiting, or read the asset if the result above says it is ready.]"
    )
    try:
        import jobs  # injected by the kernel prelude
    except ImportError:
        # No hosted runtime in this kernel: the hop is all the waiting available, and
        # returning it is exactly what the tree did before this wrapper existed.
        return text
    jobs.wait(wake_after=remaining)  # raises WaitSignal: the cell ends here
    return text  # unreachable; kept so the function's type is honest


def _wait_resolved(text: str) -> "bool | None":
    """True if the wait finished, False if it is still in flight, None if unknown.

    The two shapes, from real streams:

        resolved   {"results": [{"asset_id": ..., "state": "completed", ...}],
                    "completed": true}
        in flight  {"suspended": true}  /  {"completed": false}

    Anything else returns None and the caller hands the server's text straight to
    the model. That third branch is the point: the in-flight shape was never
    captured live, so a function that assumed one would eventually report a fake
    completion and let a job proceed on an unready asset. Unknown is a verdict.
    """
    try:
        payload = json.loads(text)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("suspended") is True:
        return False
    completed = payload.get("completed")
    return completed if isinstance(completed, bool) else None


def _wait_param(args: dict, cap: float) -> str:
    """The timeout argument's own name, so the hop rewrites the right key."""
    for name in args:
        if "timeout" in name or "seconds" in name or "duration" in name:
            return name
    return "max_timeout"

`;
}

/**
 * Split one server's tools into the modules they will be emitted as.
 *
 * Measured motivation: the port's consolidated tree produced
 * `api/creative_actions.py` at 152KB across 45 tools. That is a single file no
 * API reference on earth is shaped like — `stripe.py` is one module per RESOURCE,
 * and the affordance rule says get as close to the in-distribution shape as the
 * constraints allow. The registry already knows each action's category, so the
 * grouping is read from the catalogue rather than invented here.
 *
 * Module naming is FLAT (`api/image.py`) rather than nested
 * (`api/creative_actions/image.py`), because the ergonomic ask is
 * `import api.image` and a nested path would spend the win on a directory nobody
 * types. Flat names can collide across servers, so a category claimed by more than
 * one server is qualified — `api/<server>_<category>.py` — which keeps every module
 * one import deep and the collision deterministic rather than last-writer-wins.
 *
 * @param claimed Map of category -> number of servers using it, catalogue-wide.
 */
/**
 * The KINDS of operation a module holds, derived from its tool names — for the
 * root index's "what it holds" column and the arm's per-file table of contents.
 *
 * W129, measured on h65: a per-method name list in the prompt let the model skip
 * the package file; a per-file line that said only "api/image.py 19 tools" left it
 * unable to find image generation at all (pos 24 guessed `agent_tools.generate`
 * three times; pos 2 never found it and hand-drew SVGs into text documents). The
 * line has to say what kind of work the file does, without becoming the name list
 * again — so: families, not functions. Names sharing their first two tokens with at
 * least one other tool form a family (`create_image ×6 (gpt, nano, seedream)`);
 * the rest stand alone; `max` families are shown and the remainder counted, so it
 * stays a table of contents and the file stays the place to choose.
 *
 * Derived from the tools list only, never hand-written (CLAUDE.md: the generator
 * must always be able to produce this from a tools list).
 */
export function operationFamilies(names, { max = 8 } = {}) {
	const groups = new Map();
	for (const name of names) {
		const toks = name.split("_");
		const key = toks.length >= 3 ? toks.slice(0, 2).join("_") : name;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(toks);
	}
	const fams = [...groups.entries()].map(([key, members]) => {
		if (members.length === 1) return { label: members[0].join("_"), size: 1 };
		const thirds = [...new Set(members.map((m) => m[2]).filter(Boolean))];
		const detail = thirds.length > 0 && thirds.length <= 4 ? ` (${thirds.join(", ")})` : "";
		return { label: `${key} ×${members.length}${detail}`, size: members.length };
	});
	fams.sort((a, b) => b.size - a.size || a.label.localeCompare(b.label));
	const shown = fams.slice(0, max).map((f) => f.label);
	const rest = fams.length - shown.length;
	return rest > 0 ? `${shown.join(", ")}, +${rest} more` : shown.join(", ");
}

export function categoryModules(tools, pyServer, claimed) {
	const groups = new Map();
	const ungrouped = [];
	for (const tool of tools) {
		if (!tool.category) {
			ungrouped.push(tool);
			continue;
		}
		const slug = pyIdent(tool.category).toLowerCase();
		const module = (claimed.get(slug) ?? 0) > 1 ? `${pyServer}_${slug}` : slug;
		if (!groups.has(module)) groups.set(module, { module, category: tool.category, tools: [] });
		groups.get(module).tools.push(tool);
	}
	return { groups: [...groups.values()], ungrouped };
}

/** category slug -> how many servers use it, so a collision can be qualified. */
export function claimedCategories(normalized) {
	const claimed = new Map();
	for (const { tools } of normalized) {
		const slugs = new Set(tools.filter((t) => t.category).map((t) => pyIdent(t.category).toLowerCase()));
		for (const slug of slugs) claimed.set(slug, (claimed.get(slug) ?? 0) + 1);
	}
	return claimed;
}

/**
 * The server module, when its tools have moved into category modules: an alias.
 *
 * Cheap, and worth it mid-comparison — `api.creative_actions.create_image_x`
 * keeps working while the model learns `api.image.create_image_x`, so a call shape
 * from an earlier turn (or an earlier run) does not become an AttributeError. It
 * re-exports rather than re-documents: the docstrings live in one module each, so
 * `grep -ril` finds the real one and this file stays a few lines per tool.
 */
export function renderServerAlias(server, pyServer, groups, ungroupedText) {
	const lines = ungroupedText
		? [ungroupedText.replace(/\n__all__ = \[[\s\S]*$/, "").trimEnd(), "", ""]
		: [
				`"""${pyDocstring(server)} — generated from the MCP schema. Do not edit.`,
				"",
				"Every API of this app, re-exported from the modules it is documented in.",
				`Prefer the specific module (\`import api.${groups[0]?.module ?? pyServer}\`) — this alias exists so a`,
				" call written before the split keeps working.",
				'"""',
				"",
			];
	const names = [];
	for (const group of groups) {
		lines.push(`from .${group.module} import (`);
		for (const tool of group.tools) {
			lines.push(`    ${tool.pyName},`);
			names.push(tool.pyName);
		}
		lines.push(")");
	}
	lines.push("", "__all__ = [", ...names.map((n) => `    "${n}",`), "]", "");
	return lines.join("\n");
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

export function renderAppDocs(tools, { server, pkg = pyPackage(server), constraintNotes = false }) {
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
		renderFullDocs(tools, { server, heading: false, constraintNotes }),
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
export function renderNames(tools, { server, pkg = pyPackage(server), style = "python" } = {}) {
	return tools.map((t) =>
		style === "wire" ? wireName(server, t.name) : `api.${pkg}.${t.pyName}`,
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
 * `pathLiteral` is the only thing that differs, and only when a gate is on:
 * in per-method `__name__` already IS `api.<pkg>.<tool>`, while a consolidated
 * module's `__name__` is just `api.<pkg>`, which would lose the tool half and make
 * the gate fire once per APP instead of once per API.
 */
function renderFunction(tool, { server, docsGate = "off", readGate = false, waitBridge = false, pathLiteral = "__name__", typedReturns = false, returnShapes = null, constraintNotes = false }) {
	const mode = docsGateMode(docsGate);
	// An asset parameter's hint says what `_client` already accepts there. The
	// coercion admits `Asset` and any asset-carrying result at every asset slot; a hint
	// reading `list[str]` denies an affordance that exists, which is the `-> Any`
	// failure one level down — the agent's only way to find it would be to guess.
	// EXTENDS the declared type, never replaces it. The first version replaced it
	// and silently dropped `list[dict[str, str]]` from judge_tool's `assets`, which
	// is the shape that tool actually wants (`[{"label": ..., "asset_id": ...}]`) —
	// a hint that narrows what a tool accepts is worse than one that omits an extra.
	const hint = (p) => {
		if (!typedReturns || !isAssetParam(p.name)) return p.type;
		const widened = p.type.replace(/\blist\[str\]/g, "list[str | AssetLike]");
		return `${widened} | AssetLike`;
	};
	const args = tool.params.map((p) => (p.required ? `${p.pyName}: ${hint(p)}` : `${p.pyName}: ${hint(p)} | None = _UNSET`));
	// A launch takes an optional NAME first (positional — `spawn_judge("kite-check", ...)`),
	// then the tool's own parameters keyword-only, and returns a Handle, never the result.
	// Plain `def`, not a coroutine: a launch returns in ~1 s and two of three h68 jobs
	// called it without await (Scott's own sketch shape) and paid a TypeError.
	const signatureLine = tool.launches
		? `def ${tool.pyName}(name: str | None = None, *, ${args.join(", ")}) -> Handle:`
		: `async def ${tool.pyName}(${args.join(", ")}) -> ${typedReturns ? returnType(tool.name, returnShapes) : "Any"}:`;
	// A wait tool spends wall-clock the caller may ask for more of than one server
	// call allows. `waitBridge` is bundle-carried; the BEHAVIOUR is env-gated inside
	// the helper, so an unflagged run of this same tree is unchanged. Resolved here
	// because both the docstring and the call site below need it.
	const waitParam = waitBridge ? waitToolParam(tool) : null;

	// Every description is untrusted catalogue text on its way into a `"""…"""`
	// block — pyDocstring keeps the displayed text identical and the parse safe.
	const safeDescription = pyDocstring((tool.description ?? "").trim());
	const doc = [`    """${firstLine(safeDescription) || tool.pyName}`];
	const rest = safeDescription.split("\n").slice(1).join("\n").trim();
	if (rest) doc.push("", ...rest.split("\n").map((l) => `    ${l}`));
	// W130: the one thing about TIME a reader has to know before calling.
	if (tool.launches) {
		doc.push(
			"",
			"    LAUNCH: a plain call (no await) that returns a Handle at once; the work runs for",
			"    minutes, and inputs still processing are waited for. `await handle` or",
			"    `wait_for(handle)` waits for it (up to the bound); then `handle.result()` — before",
			"    it is done, `.result()` raises NotReady. `name` labels the run for `result(name)`.",
		);
	} else if (tool.awaitsInputs) {
		doc.push(
			"",
			"    NEEDS FINISHED INPUTS: an asset still processing raises NotReady — `wait_for(<it>)`,",
			"    which ends your turn until it is ready, then call again.",
		);
	}

	if (tool.params.length > 0) {
		doc.push("", "    Args:");
		for (const p of tool.params) {
			const note = p.description ? ` ${pyDocstring(p.description)}` : "";
			const opt = p.required ? "" : " Optional.";
			doc.push(`        ${p.pyName}:${note}${opt}`.trimEnd());
			// What this parameter accepts beyond its declared shape, and one literal
			// of that shape. Both from the same helpers the resident L4 docs use, so
			// the on-disk text and the in-prompt text cannot drift.
			const adapted = adapterNote(p);
			if (adapted) doc.push(`            ${pyDocstring(adapted)}`);
			// The wait affordance sits under the parameter it is about, so the
			// sentence and the argument it changes are read together.
			if (waitParam && p.name === waitParam.name) {
				doc.push(`            ${pyDocstring(waitNote(tool, waitParam))}`);
			}
			const example = p.inputTyped ? null : exampleNote(p);
			if (example) doc.push(`            ${pyDocstring(example)}`);
			if (p.inputCheck) doc.push(`            A ${p.inputCheck.how === "one" ? "" : p.inputCheck.how === "list" ? "list of " : "dict of str to "}${p.inputCheck.cls}; help(${p.inputCheck.cls}) lists its fields.`);
			// One line, and only for a promoted parameter. Without it the signature
			// says "required" while the description it sits beside still says the
			// server has a default for it, and the agent is left to reconcile two
			// contradictory statements about the same slot.
			const required = requiredDefaultNote(p);
			if (required) doc.push(`            ${required}`);
			// The schema's own default, which the raw JSON schema shows vanilla and
			// the signature's `= None` erases: the None-drop in _call is what lets
			// the server apply it, so the DOCSTRING carries it (P1.5).
			const dflt = serverDefaultNote(p);
			if (dflt) doc.push(`            ${dflt}`);
			// The bounds the validator will enforce, stated where the agent reads
			// before it calls. Same source as `_schemas.json`, so the two agree.
			const bounds = constraintNotes ? constraintNote(p) : null;
			if (bounds) doc.push(`            ${bounds}`);
		}
	}
	// The Returns section said "The tool result as returned by the MCP server." on
	// all 64 tools — a heading in the place a reader looks, answering nothing. With
	// typed returns it says the shape AND the one thing worth knowing about it:
	// that the value can go straight back where an id is expected. The annotation
	// alone is not documentation; `-> CreativeActionOutput` names a type whose only
	// definition is in another file, and the measured behaviour this whole change
	// exists to fix was the agent printing a result because it could not tell what
	// the result was.
	const returned = typedReturns ? returnType(tool.name, returnShapes) : "str";
	const entry = typedReturns ? returnShapes?.classes?.get(returned) : null;
	doc.push("", "    Returns:");
	if (!typedReturns) {
		doc.push("        The tool result as returned by the MCP server.");
	} else if (!entry) {
		doc.push(
			`        ${returned} — this API publishes no output schema; the parsed payload is`,
			"        in `.raw` and readable dict-style (`result[\"key\"]`).",
		);
	} else if (entry.union) {
		// A multi-arm tool: name the variants, so the reader knows to look at the
		// value's own class rather than expecting one field set.
		doc.push(`        ${returned} — one of ${entry.union.join(", ")}, by which record the`, "        server returned; each variant lists its own fields. `.raw` is the whole payload.");
	} else {
		// From the schema: the class, its fields, and — when it carries asset refs —
		// the one thing worth knowing, that the value goes straight back as an id.
		const fields = entry.fields.map((f) => f.pyName).join(", ");
		const carries = entry.fields.some((f) => f.ref === "asset");
		doc.push(`        ${returned}${fields ? ` with ${fields}` : ""}.`);
		if (carries) {
			doc.push(
				"        Carries asset refs: pass it straight back wherever an asset id is expected,",
				"        e.g. `references=[result]` or `ids=[result]`; `.ids` lists them all.",
			);
		}
		doc.push("        `.raw` is the server's whole payload; `help(" + returned + ")` shows every field.");
	}
	doc.push('    """');

	// Deterministic coercion of the pythonic argument shapes, at the top of the
	// body so the value the docstring documents is the value `_call` validates and
	// sends. A strict-form argument passes through untouched.
	const coercions = tool.params.filter((p) => p.adapter).map((p) => `    ${p.pyName} = ${coercion(p).call}`);
	// Typed inputs: refuse anything but the declared class, then send its payload.
	const inputChecks = tool.params
		.filter((p) => p.inputCheck)
		.map((p) => `    ${p.pyName} = _require_input(${p.pyName}, ${p.inputCheck.cls}, "${p.pyName}", "${p.inputCheck.how}")`);
	coercions.push(...inputChecks);
	const callArgs = tool.params.map((p) => `"${p.name}": ${p.inputCheck || p.inputTyped ? `_to_payload(${p.pyName})` : p.pyName}`).join(", ");
	// `_path` is what arms the gate — `__name__` is already the import path
	// (`api.<pkg>.<tool>`), so the citation and the package name need no plumbing.
	// `_doc` is passed only by the mode that shows a docstring, and it is read off
	// `__doc__` at call time so the delivered text is the same object `help()`
	// prints and the file contains. A second copy would drift.
	// Both gates are armed by `_path`; only `inline` also needs the docstring. The
	// read gate resolves `_path` into an app module and a line span, so it needs the
	// same literal for the same reason.
	const expectArg = typedReturns ? `\n        _expect="${returnType(tool.name, returnShapes)}",` : "";
	const gateArgs =
		mode === "inline"
			? `\n        _doc=${tool.pyName}.__doc__,\n        _path=${pathLiteral},`
			: mode === "redirect" || readGate
				? `\n        _path=${pathLiteral},`
				: "";
	const call = waitParam
		? `    return await _wait_bridge(\n        "${server}",\n        "${tool.name}",\n        {${callArgs}},\n        ${waitParam.pyName},\n        ${waitToolCap(tool, waitParam)},\n    )`
		: gateArgs
			? `    return await _call(\n        "${server}",\n        "${tool.name}",\n        {${callArgs}},${gateArgs}${expectArg}\n    )`
			: expectArg
				? `    return await _call("${server}", "${tool.name}", {${callArgs}},${expectArg}\n    )`
				: `    return await _call("${server}", "${tool.name}", {${callArgs}})`;
	// W130: a launch dispatches and returns a Handle; the work is collected later.
	if (tool.launches) {
		const expect = typedReturns ? `, expect="${returnType(tool.name, returnShapes)}"` : "";
		return [signatureLine, ...doc, ...coercions, `    return _launch("${server}", "${tool.name}", {${callArgs}}, name=name${expect})`];
	}
	return [signatureLine, ...doc, ...coercions, call];
}

/**
 * per-method: one Python module per tool.
 *
 * The docstring carries the server's description verbatim, so `grep`, `import`,
 * and `help()` all read the same text and cannot drift.
 */
export function renderToolModule(tool, { server, docsGate = "off", waitBridge = false, typedReturns = false, returnShapes = null, constraintNotes = false }) {
	return [
		`"""${pyDocstring(`${server}.${tool.name}`)} — generated from the MCP schema. Do not edit."""`,
		"",
		"from typing import Any, Literal",
		"",
		// The annotation has to resolve at import time, so a module that promises a
		// typed return must import the name it promises. Only that module: a tree
		// with no typed returns stays byte-identical to the untyped one.
		// AssetLike too: the widened parameter hints name it, and annotations are
		// evaluated at def time on the kernel's Python 3.11 (3.14 defers them, which
		// is how a NameError here passed a system-python smoke test once).
		...(typedReturns ? [`from .._types import AssetLike, ${returnType(tool.name, returnShapes)}`] : []),
		...(tool.params.some((p) => p.inputTyped)
			? [`from .._types import ${[...new Set(tool.params.flatMap((p) => p.inputClasses ?? []))].sort().concat(["require_input as _require_input", "to_payload as _to_payload"]).join(", ")}`]
			: []),
		// `_client` lives at the api/ root, one level above the server package.
		// Coercion helpers are imported only by modules that call them, so a tree
		// with no adaptable parameter is byte-identical to the pre-adapter one.
		clientImport([tool], ".._client", waitBridge),
		"",
		"",
		// `__name__` is already the import path (`api.<pkg>.<tool>`), so arming the
		// gate needs no plumbing in this layout.
		...renderFunction(tool, { server, docsGate, waitBridge, pathLiteral: "__name__", typedReturns, returnShapes, constraintNotes }),
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
export function renderAppModule(tools, options) {
	return renderAppModuleParts(tools, options).text;
}

/**
 * The consolidated module AND the exact line span of every function in it.
 *
 * One renderer, two outputs, because the read gate's whole claim is that the span
 * it cites is where the contract actually is. A second function that re-derived
 * spans by parsing the emitted text — or worse, by counting docstring lines a
 * second time — would be a second authority on one fact, and the first edit to
 * either would make the citation point at the wrong place while still looking
 * plausible. We emit the file, so the spans are exact by construction, and
 * `bench/test/read-gate.test.mjs` re-checks them against the emitted text.
 *
 * A span runs from the `async def` line through the last line of its `return await
 * _call(...)`, 1-based and inclusive — i.e. the signature, the whole docstring and
 * the call. That is what "read this API's contract" means.
 */
export function renderAppModuleParts(tools, { server, pkg = pyPackage(server), docsGate = "off", readGate = false, waitBridge = false, typedReturns = false, returnShapes = null, constraintNotes = false, moduleIndex = false }) {
	// The annotations must resolve at import time, so import exactly the typed
	// names this app actually promises — deduped, and nothing when it promises none.
	// AssetLike always: the widened parameter hints name it (see renderToolModule).
	const typedNames = typedReturns ? [...new Set(["AssetLike", ...tools.map((t) => returnType(t.name, returnShapes))])].sort() : [];
	// Typed inputs: every class a signature in this module names, and the two helpers.
	const inputNames = [...new Set(tools.flatMap((t) => t.params.flatMap((p) => p.inputClasses ?? [])))].sort();
	const usesInputs = tools.some((t) => t.params.some((p) => p.inputTyped));
	if (usesInputs) typedNames.push(...inputNames, "require_input as _require_input", "to_payload as _to_payload");
	const conventions = appConventions(tools, pkg);
	const lines = [
		`"""${pyDocstring(server)} — generated from the MCP schema. Do not edit.`,
		"",
		`${tools.length} API${tools.length === 1 ? "" : "s"}, all async, documented in full below.`,
		`Call them as \`api.${pkg}.<name>(...)\`.`,
		// W129: the header IS the index of this family — one line per tool, signature
		// and summary — so a read of the first screen answers "which one", and the
		// full contracts follow for the one chosen. Measured need: with no such
		// header, h65 pos 24 spent 22 cells on help() one function at a time, and
		// pos 22 read this whole 78KB file twice.
		...(moduleIndex
			? [
					"",
					"Tools (signature — what it does):",
					// pyDocstring: a description carrying `"""` or a backslash must not end the
					// docstring early (bench/test/hostile.test.mjs, "every module IMPORTS").
					...renderTocLines(tools, { server, pkg }).map((l) => `  ${pyDocstring(l)}`),
				]
			: []),
		...(conventions.length > 0 ? ["", "Conventions:", ...conventions] : []),
		'"""',
		"",
		"from typing import Any, Literal",
		"",
		...(typedNames.length > 0 ? [`from ._types import ${typedNames.join(", ")}`] : []),
		// `_client` is a sibling module here, not a parent package. Coercion helpers
		// are imported only when some API in this app takes an adaptable argument, so
		// an app without one renders exactly as it did before.
		clientImport(tools, "._client", waitBridge),
	];
	// NOT `lines.length`: several elements of this array are themselves multi-line
	// (the gated `_call` is one element carrying four newlines), so the array index
	// and the file's line number diverge. Counting newlines is the only accounting
	// that survives a renderer emitting a block as one string — which is exactly how
	// the first version of this got `reply_to_email` wrong by two lines while
	// producing an entirely plausible-looking span.
	const lineCount = (parts) => parts.reduce((n, part) => n + part.split("\n").length, 0);
	const lineMap = {};
	for (const tool of tools) {
		lines.push("", "");
		const body = renderFunction(tool, {
			server,
			docsGate,
			readGate,
			waitBridge,
			typedReturns,
			returnShapes,
			constraintNotes,
			// A literal, not `__name__`: this module's `__name__` is only `api.<pkg>`,
			// so `__name__` would lose the tool half and the gate would fire once per
			// app instead of once per API.
			pathLiteral: JSON.stringify(`api.${pkg}.${tool.pyName}`),
		});
		const start = lineCount(lines) + 1;
		lines.push(...body);
		lineMap[tool.pyName] = [start, lineCount(lines)];
	}
	lines.push("", "", "__all__ = [", ...tools.map((t) => `    "${t.pyName}",`), "]", "");
	return { text: lines.join("\n"), lineMap };
}

/** codemode: the per-server package index, one line per tool. */
export function renderServerIndex(tools, { server, pkg = pyPackage(server), docsGate = "off", waitBridge = false }) {
	return [
		`# ${server}`,
		"",
		`${tools.length} tool${tools.length === 1 ? "" : "s"}. \`import api.${pkg}\`, then call any of the below.`,
		`Each is \`async\`. Read \`api/${pkg}/<tool>.py\` for full parameter documentation.`,
		// Only when the file exists. A pointer to a file that is not there is worse
		// than no pointer: it costs a turn and teaches the tree cannot be trusted.
		...(docsGateMode(docsGate) === "off" ? [] : [`\`api/${pkg}/DOCS.md\` has all of them at once, with this app's conventions.`]),
		"",
		// The marker is on the INDEX line because that is where the model picks a
		// tool; the sentence explaining it is in the module, one read away.
		...tools.map(
			(t) =>
				`- \`${pyCallSignature(t, pkg)}\`${waitBridge && waitToolParam(t) ? " *(yields the REPL on long waits)*" : ""} — ${firstLine(t.description)}`,
		),
		"",
	].join("\n");
}

/** codemode: the package __init__, re-exporting every tool. */
export function renderServerInit(tools, { server }) {
	return [
		`"""${pyDocstring(server)} — generated from the MCP schema. Do not edit."""`,
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
/**
 * The typed result surface (output-types.mjs): `Asset`, the schema-compiled classes, and the coercion that
 * lets either stand in for a bare asset id.
 *
 * MEASURED PROBLEM. `call()` returned `body["text"]`, a raw JSON string, and the
 * generated wrappers were annotated `-> Any`. Nothing in the tree said what a
 * creative action gives back. So the only way to learn that the id lives at
 * `result["assets"]["image"][0]` was to run the call, print it, and read the id
 * off the output — which is exactly what the agent did: across a 40-round arm,
 * **59 of 59 creative-action cells passed hand-copied string literals and zero
 * passed a prior return value programmatically**, and a median of 8 cells per
 * round existed only to carry a value across a turn boundary the kernel already
 * held in a variable. At ~30 cells per round that is ~29% of them, and cost goes
 * as the square of turns.
 *
 * DESIGN. What you would type without us is `references=[can]` — pass back the
 * thing you were just given. So that is made to work, rather than taught:
 *
 *     can = await api.image.create_image_gpt_image_1_5(prompt=...)
 *     b1  = await api.image.create_image_nano_banana_pro(prompt=..., references=[can])
 *     await api.agent_tools.wait_for_assets(asset_ids=[can, b1])
 *
 * `Asset` is a frozen dataclass whose `__str__` is its id, so it also works in
 * f-strings and json.dumps-free paths. Every result holds the whole payload
 * — nothing is hidden — and additionally behaves like its first asset, because
 * one-asset calls are the overwhelming majority and `result.assets[0].id` for
 * the common case is the kind of ceremony that sends people back to printing.
 *
 * The shapes are corpus-derived, not invented: over 401 rounds of real traffic
 * `{tool_id, assets: {image: [str]}, note, parent_group_id, estimated_credits}`
 * covers 74-100% of creative-action responses and `{results: [...], completed}`
 * covers 100% of wait_for_assets. Anything unrecognised is returned as the raw
 * string it always was, so this can only add affordance, never remove one.
 */

export function returnType(toolName, types = null) {
	// The class output-types.mjs compiled from this tool's outputSchema, or the
	// untyped base when the tool published none. Nothing here is guessed from the
	// name: until W128 a name-prefix rule and a corpus map stood in for the schema
	// the product never published, and both were wrong for whole tool families.
	return types?.byTool?.get(toolName) ?? UNTYPED_RESULT;
}

/**
 * True when a parameter carries asset ids.
 *
 * Hand-authored and name-based for the same reason `returnType` is: no tool in
 * the catalogue publishes an output schema, and the INPUT schema says only
 * `array of string` — nothing distinguishes an asset id from any other string.
 *
 * It matters because the coercion in `_client` already ACCEPTS an `Asset` or a
 * an asset-carrying result at these parameters, and a hint reading `list[str]` does not
 * say so. An affordance the type hint denies is the `-> Any` mistake one level
 * down: the agent's only route to discovering it would be to try it and see.
 */
function isAssetParam(name) {
	// Widened from the same audit. The first list omitted `ref` (4,121 observed
	// calls across read/write), `output_artifacts` (978, on update_job_progress),
	// and the media-specific slots `video`/`videos`/`images` that the video and
	// composite tools take -- i.e. it covered the parameters I thought of rather
	// than the ones the corpus uses.
	return /^(ids|asset_id|asset_ids|ref|refs|reference|references|source|sources|assets|artifacts|output_artifacts|image|images|video|videos|audio)$/.test(
		name,
	);
}

export function renderClient({
	docsGate = "off",
	nullable = [],
	readGate = false,
	validateArgs = false,
	adapters = [],
	waitBridge = false,
	apiLayout: layout = "per-method",
	typedReturns = false,
	returnShapes = null,
	waitSurface = false,
	bridgeHeader = DEFAULT_BRIDGE_HEADER,
	bridgeHeaderNote = null,
	waitCalls = null,
	// Some tool's Python name was set apart from its wire name: errors look it up.
	renamed = false,
} = {}) {
	const mode = docsGateMode(docsGate);
	if (readGate && mode !== "off") {
		// They are two answers to one question and they compose badly: the docs gate
		// clears itself on the retry the read gate is about to refuse, so a run with
		// both on would raise two different exceptions for one call and neither result
		// would be attributable. The read gate REPLACES it — see READ_GATE.
		throw new Error("--read-gate and --docs-gate are alternatives, not a stack; run one or the other");
	}
	if (readGate && apiLayout(layout) !== "consolidated") {
		// The gate cites a line span in `api/<app>.py`. In per-method there is no such
		// file and no span to cite, so the citation would be a lie and the gate would
		// be unsatisfiable. Refuse rather than degrade to something weaker wearing the
		// same label.
		throw new Error("--read-gate requires --api-layout=consolidated (the line map is a property of that layout)");
	}
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

	/**
	 * The read gate: a VERIFIED read-precondition, shaped like Claude Code's Edit tool.
	 *
	 * The docs gate above is *skippable by construction* — it marks the (server, tool)
	 * pair delivered BEFORE it raises, so a retry proceeds whether or not anything was
	 * read. That was a deliberate anti-deadlock choice and it was taken literally.
	 * Measured on the `ce73d68` family (docs/CC-EDGE-TRACES.md): **zero of 12 codemode
	 * configurations ever read `reply_to_email`'s contract before calling it**, the two
	 * docs-gate configurations included. The contract they never read says
	 * `email_addresses` defaults to "the sender", which on an outbox thread is the
	 * supervisor themselves; 35 of 36 runs omitted it and every one of those failed.
	 *
	 * Edit refuses to write a file that has not been Read, the retry re-checks, and
	 * models comply at essentially 100% because that loop is trained in. This is the
	 * same precondition against the same vocabulary:
	 *
	 *   - armed per API, satisfied by a read WINDOW covering that API's lines in its
	 *     app module — hence `consolidated`, where `api/<app>.py` has exact spans,
	 *   - one read of an app module bulk-satisfies every API in it, so the tax is
	 *     about one read per app per task rather than one per API,
	 *   - NOTHING is recorded before the raise. The only state is the ledger, which
	 *     only prime's `read` tool can append to, so there is no path through.
	 *
	 * `cat`, `help()` and in-cell `open()` deliberately do not satisfy it. The
	 * affordance rule says match the idiom rather than invent one, and the model's
	 * strongest habit here is the read tool — so the error names that tool.
	 */
	const readFirst = `
class ReadFirst(McpError):
    """An API was called before its contract was read."""


_LINEMAP_PATH = os.path.join(os.path.dirname(__file__), "_linemap.json")
# Written by bench/arms/read-ledger-extension.ts, in the agent's process, from
# prime's own read-tool results. Overridable so the run directory owns it.
_LEDGER_PATH = os.environ.get(
    "HARNESS_READ_LEDGER"
) or os.path.join(os.path.dirname(__file__), ".read-ledger.jsonl")
_LINEMAP: dict | None = None


def _linemap() -> dict:
    """The generated span table. Read once — the file cannot change mid-run."""
    global _LINEMAP
    if _LINEMAP is None:
        with open(_LINEMAP_PATH) as handle:
            _LINEMAP = json.load(handle)
    return _LINEMAP


def _read_windows(pkg: str) -> list:
    """Every line window prime's read tool has returned for api/<pkg>.py.

    Re-read on every call and never cached: the ledger is appended to by the
    agent process between cells, so a cached copy would make the first retry
    after a read fail anyway and teach the agent that reading does not work.
    """
    windows = []
    try:
        with open(_LEDGER_PATH) as handle:
            lines = handle.readlines()
    except OSError:
        return windows
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:  # a half-written final line; the next call will see it
            continue
        if entry.get("tool") != "read" or entry.get("pkg") != pkg or entry.get("isError"):
            continue
        start, end = entry.get("start"), entry.get("end")
        if isinstance(start, int) and isinstance(end, int) and end >= start:
            windows.append((start, end))
    return windows


def _covers(windows: list, span: list) -> bool:
    """True when the UNION of read windows contains every line of span.

    A union rather than "one window covers it": two reads that between them
    delivered the whole section did deliver the whole section, and refusing that
    would punish the paging the read tool's own truncation notice asks for.
    """
    line = span[0]
    for start, end in sorted(windows):
        if start > line:
            break  # a gap the reads never closed
        if end >= line:
            line = end + 1
        if line > span[1]:
            return True
    return line > span[1]


def _read_first(server: str, tool: str, path: str) -> None:
    """Refuse an API whose contract has not been read. No path through."""
    parts = path.split(".")
    pkg, name = (parts[-2], parts[-1]) if len(parts) >= 2 else (server, tool)
    span = _linemap().get(pkg, {}).get(name)
    if span is None:
        return
    if _covers(_read_windows(pkg), span):
        return
    raise ReadFirst(
        f"{path} has not been read. Read api/{pkg}.py (this API is lines"
        f" {span[0]}-{span[1]}) with the read tool, then re-issue the call.\\n"
        f"One read of that file covers all {len(_linemap().get(pkg, {}))} APIs in"
        f" api.{pkg}; cat, help() and open() inside a cell do not count."
    )

`;

	const gate = readGate ? readFirst : mode === "redirect" ? redirect : mode === "inline" ? inline : "";
	const validator = validateArgs ? renderValidator({ renamed }) : "";
	// Rendered only for the helpers the catalogue actually needs — an unused helper
	// in the tree is one more thing in the agent's `grep -ril` and one more line of
	// difference between two trees that are supposed to be identical.
	const adapter = renderAdapters(new Set(adapters), typedReturns);
	const sendable = renderSendable(nullable);
	// Only when the catalogue actually has a wait tool: an unused coroutine in the
	// transport is one more thing in the agent's `grep -ril`.
	const waiter = waitBridge ? renderWaitBridge() : "";
	return `"""Transport for the generated api/ modules. Do not edit.

Every tool module calls \`_client.call\`, which forwards to the shared MCP proxy.
"""

${mode === "inline" ? "import inspect\n" : ""}import asyncio
import json
import os
${validateArgs ? "import re\n" : ""}${waitSurface ? "import urllib.parse\n" : ""}import urllib.request${typedReturns ? "\n\nfrom ._types import Asset, AssetLike, ToolResult, asset_id as _asset_ids, wrap as _wrap" : ""}

_PROXY = os.environ.get("HARNESS_MCP_PROXY", "http://127.0.0.1:8765")

# NOTE: transparent memoization of identical calls was tried here and removed.
# 29% of MCP calls in a run are byte-identical repeats, so caching them looks
# like free efficiency — but it is not safe. "Read-only" is not "idempotent":
# Reddit hot threads, Steam trending and market prices all change between calls,
# so a cache silently serves stale data, and for any server with side effects it
# is simply wrong. Deduplication has to be the agent's judgement call per tool,
# which is what the q6 ledger prompt asks for.
_RUN_ID = os.environ.get("HARNESS_RUN_ID", "")
# Set only under the boundary posture, where _PROXY points at the egress proxy's
# /r/mcp route rather than straight at the MCP proxy. Empty otherwise, and the
# request is then byte-identical to the pre-posture one.
_EGRESS_TOKEN = os.environ.get("HARNESS_EGRESS_TOKEN", "")
# Seconds a call may take end to end. 180 unless the host says otherwise: a host that
# holds calls open on a human (an approval prompt, a question) needs minutes.
try:
    _TIMEOUT = float(os.environ.get("HARNESS_MCP_TIMEOUT_S") or 180)
except ValueError:
    _TIMEOUT = 180


class McpError(RuntimeError):
    """An MCP tool returned an error, or the server was unreachable."""


def _request(route: str, payload: dict | None = None, *, tagged: bool = False) -> urllib.request.Request:
    """Every request this client makes, so each route carries the same egress token."""
    headers = {} if payload is None else {"content-type": "application/json"}
${bridgeHeader ? `${(bridgeHeaderNote ?? []).map((l) => `    # ${l}
`).join("")}    if tagged:
        headers["${bridgeHeader}"] = "api/_client"
` : ""}    if _EGRESS_TOKEN:
        headers["x-egress-token"] = _EGRESS_TOKEN
    if payload is None:
        return urllib.request.Request(_PROXY + route, headers=headers)
    return urllib.request.Request(_PROXY + route, data=json.dumps(payload).encode(), headers=headers, method="POST")


def _fetch(request) -> dict:
    """Blocking. From a coroutine, go through asyncio.to_thread or gather runs serially."""
    with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
        return json.loads(response.read())

${sendable}${validator}${adapter}${waiter}${gate}
async def call(server: str, tool: str, args: dict${typedReturns ? ', _expect: str | None = None' : ""}${mode === "inline" ? ", _doc: str | None = None, _path: str | None = None" : mode === "redirect" || readGate ? ", _path: str | None = None" : ""}) -> ${typedReturns ? "ToolResult" : "str"}:
    """Invoke an MCP tool and return its ${typedReturns ? "typed result (see _types.py)" : "text result"}.

    Arguments go through \`_sendable\`: an optional parameter left at its default
    is not sent, and an explicit None is sent as null only where the parameter's
    schema accepts null — several servers reject a null anywhere else.

    Raises:${validateArgs ? "\n        ArgumentError: An argument does not satisfy this API's schema. Nothing was sent." : ""}${mode === "off" ? "" : "\n        DocsFirst: This is the first call to this API; read the message, then call again."}${readGate ? "\n        ReadFirst: This API's contract has not been read. Read it, then call again." : ""}
        McpError: The server returned an error or could not be reached.
    """${mode === "inline" ? "\n    if _path is not None:\n        _docs_first(server, tool, _doc, _path)" : mode === "redirect" ? "\n    if _path is not None:\n        _docs_first(server, tool, _path)" : readGate ? "\n    if _path is not None:\n        _read_first(server, tool, _path)" : ""}${
			validateArgs
				? // Validate what is actually SENT, i.e. after the None-drop below, or every
					// optional parameter left at its default would read as a null type violation
					// — the generated wrappers pass all of them on every call.
					(typedReturns
						? // Coercion BEFORE validation: an `Asset` at a string parameter is exactly
							// what this feature invites, and the validator would reject the object it
							// was handed. Coerce, then check what will actually be sent.
							'\n    sent = _asset_ids(_sendable(args, _NULLABLE.get((server, tool))))\n    _validate(server, tool, sent)'
						: '\n    sent = _sendable(args, _NULLABLE.get((server, tool)))\n    _validate(server, tool, sent)')
				: ""
		}
    payload = {
        "server": server,
        "tool": tool,
        "args": ${validateArgs ? "sent" : typedReturns ? "_asset_ids(_sendable(args, _NULLABLE.get((server, tool))))" : "_sendable(args, _NULLABLE.get((server, tool)))"},
        "meta": {"arm": "codemode", "runId": _RUN_ID},
    }
    request = _request("/call", payload, tagged=True)
    try:
        body = await asyncio.to_thread(_fetch, request)
    except Exception as exc:  # noqa: BLE001 - surfaced to the agent as-is
        raise McpError(f"{server}.{tool}: proxy unreachable: {exc}") from exc

${waitSurface ? `    if body.get("not_ready"):
        raise NotReady(f"{server}.{tool}: {body.get('error', 'input still processing')}")
` : ""}    if not body.get("ok"):
        raise McpError(f"{server}.{tool}: {body.get('error', 'unknown error')}")
    return ${typedReturns ? "_wrap(body.get(\"text\", \"\"), _expect)" : 'body.get("text", "")'}${waitSurface ? renderWaitSurface({ typedReturns, validateArgs, bridgeHeader, waitCalls }) : ""}
`;
}

/**
 * The wait surface (W130, docs/W130-OBSERVE-IS-THE-WAIT.md, on experiment-lab):
 * `NotReady`, `WaitSignal`, `Handle`, `wait_for`, `result` and `launch`, appended
 * to `_client.py`. Rendered only when the catalogue declares a tool that
 * `launches` or `awaitsInputs`, or when the caller forces `waitSurface: true`; a
 * tree with neither stays byte-identical to the one without it.
 *
 * The forwarder protocol is fixed (`/wait`, `/spawn`, `/job/<name>`). What names a
 * product's own read and collect calls in the teaching text is `waitCalls`.
 */
function renderWaitSurface({ typedReturns = false, validateArgs = false, bridgeHeader = DEFAULT_BRIDGE_HEADER, waitCalls = null } = {}) {
	const readCall = waitCalls?.read ?? "api.<module>.read";
	const resultCall = waitCalls?.result ?? "result";
	return `


class NotReady(RuntimeError):
    """Raised when something is asked for before it exists: a read of an asset that
    is still processing, or 'handle.result()' before the launch finished. The
    message names what is not ready and the one call that waits for it, 'wait_for',
    which takes several ids or handles at once. Nothing here can wait inside a cell
    — that is the whole reason this is an error and not a "processing" value
    (docs/W130-OBSERVE-IS-THE-WAIT.md)."""


class WaitSignal(BaseException):
    """Ends the cell at 'wait_for(...)' — control flow, not an error.

    'wait_for' cannot block: the host parks the run once the cell has finished and
    wakes it when the things waited for are ready. Anything after it in the same
    cell would run NOW, before any waiting, so raising makes that code unreachable
    by construction. BaseException so a stray 'except Exception:' cannot swallow it.
    """


class Handle:
    """A launched run ('spawn_*'): a view over the host's record of it, never the work
    itself. 'await handle' or 'wait_for(handle)' waits for it up to the bound; then
    '.result()' returns the typed record — before it is done, '.result()' raises NotReady."""

    def __init__(self, name: str, tool: str, kind: str, expect: str | None = None):
        self.name = name
        self.tool = tool
        self.kind = kind
        self._expect = expect

    def __repr__(self) -> str:
        return f"Handle({self.name!r}, {self.kind})"

    def __str__(self) -> str:
        return self.name

    def __await__(self):
        # 'await handle' IS wait_for(handle): hold up to the bound, then this handle
        # (ready) — or the cell ends with WaitSignal, exactly as wait_for would. Measured
        # h68: the model wrote 'await spawn_judge(...)' and 'await handle' by reflex.
        wait_for(self)
        if False:
            yield
        return self

    def _status(self) -> dict:
        request = _request("/job/" + urllib.parse.quote(self.name, safe=""))
        try:
            return _fetch(request)
        except Exception as exc:  # noqa: BLE001
            raise McpError(f"{self.kind} {self.name!r}: proxy unreachable: {exc}") from exc

    @property
    def state(self) -> str:
        return str(self._status().get("state", "unknown"))

    @property
    def done(self) -> bool:
        return self._status().get("state") in ("done", "failed")

    def result(self):
        body = self._status()
        state = body.get("state")
        if state == "done":
            return ${typedReturns ? '_wrap(body.get("text", ""), self._expect)' : 'body.get("text", "")'}
        if state == "failed":
            raise McpError(f"{self.kind} {self.name!r} failed: {body.get('error', 'unknown error')}")
        raise NotReady(
            f"{self.kind} {self.name!r} is still {state or 'running'}"
            + (f" — waiting on {body['waiting_on']}" if body.get("waiting_on") else "")
            + f". Nothing here can wait for it inside a cell. wait_for({self.name!r}) ends your turn "
            f"and wakes you when it is done; then {self.name!r}.result() — or ${resultCall}({self.name!r}) "
            f"in a fresh cell."
        )


class _Ready:
    """What wait_for returns when there was nothing to wait for: falsy-ish, awaitable, inert."""

    def __await__(self):
        if False:
            yield
        return None

    def __repr__(self) -> str:
        return "ready"


_WAIT_ACCEPTS = (
    "wait_for takes asset ids, job ids, results that carry either, records with a 'job_id', "
    "Handles from spawn_* calls, or lists of these"
)


def _ready_ids(things) -> tuple[list[str], list[str]]:
    """Split wait_for's arguments into asset ids and job ids / launch names."""
    assets: list = []
    jobs: list = []
    for t in things:
        if isinstance(t, Handle):
            jobs.append(t.name)
        elif isinstance(t, (list, tuple)):
            a, j = _ready_ids(t)
            assets.extend(a)
            jobs.extend(j)
        elif isinstance(t, str):
            assets.append(t)${typedReturns ? `
        elif isinstance(t, Asset) or (isinstance(t, ToolResult) and t._asset_refs()):
            assets.append(_asset_ids(t))
        elif isinstance(t, ToolResult) and t._job_refs():
            jobs.extend(t._job_refs())` : ""}
        elif isinstance(t, ${typedReturns ? "(dict, ToolResult)" : "dict"}) and isinstance(t.get("job_id"), str):
            jobs.append(t["job_id"])
        else:
            raise ${validateArgs ? "ArgumentError" : "TypeError"}(f"{_WAIT_ACCEPTS}; got {type(t).__name__}: {t!r:.200}")
    return assets, jobs


def _fact_line(fact: dict) -> str:
    """'image:ab12cd34 — image/png 1024×1024': an asset's id, then whichever facts the host sent."""
    parts = [str(fact.get("content_type") or fact.get("kind") or "")]
    if fact.get("width") and fact.get("height"):
        parts.append(f"{fact['width']}×{fact['height']}")
    if fact.get("duration_s"):
        parts.append(f"{float(fact['duration_s']):g} s")
    described = " ".join(p for p in parts if p)
    return f"{fact['id']} — {described}" if described else str(fact["id"])


def wait_for(*things) -> None:
    """Wait until every asset id / result / Handle given is finished.

    The host holds the call for up to a bound (about 100 s) — most images and judges
    finish inside it and this simply returns; 'await wait_for(x)' is fine. Past the
    bound the cell ENDS here (nothing after it runs): call wait_for again to keep
    waiting, or end your turn and you are woken in a fresh cell with the ready ids
    listed. Then read assets with '${readCall}(id)' and collect a launch with
    '${resultCall}(name)' or the handle's '.result()'. Raises McpError, naming each
    failed id and why, as soon as any has failed.
    """
    assets, jobs = _ready_ids(things)
    if not assets and not jobs:
        raise ${validateArgs ? "ArgumentError" : "TypeError"}(f"{_WAIT_ACCEPTS}; got nothing to wait for")
    payload = {"assets": assets, "jobs": jobs, "meta": {"arm": "codemode", "runId": _RUN_ID}}
    request = _request("/wait", payload)
    try:
        body = _fetch(request)
    except Exception as exc:  # noqa: BLE001
        raise McpError(f"wait_for: proxy unreachable: {exc}") from exc
    if body.get("unknown"):
        names = ", ".join(repr(u) for u in body["unknown"])
        raise McpError(
            f"wait_for: no launched run named {names}. A spawn_* call returns its Handle when it runs — "
            f"check that the call executed (it is a plain call, no await needed) and use the Handle or its .name."
        )
    if body.get("failed"):
        # Failure wins over anything still pending: a failed id never becomes ready.
        # Measured: a failed image reported "already ready" was reported as done.
        failures = "; ".join(f"{f.get('id')}: {f.get('reason') or 'failed'}" for f in body["failed"])
        raise McpError(f"wait_for: failed — {failures}. It produced nothing: do not read it or report it as done.")
    if body.get("ready"):
        # Everything is already finished: no turn to end. Say so and return an awaitable
        # no-op — measured (h68 pos 24): the model writes 'await wait_for(h)', and a bare
        # None there is a TypeError that costs the turn wait_for just saved.
        facts = [f for f in body.get("facts") or [] if isinstance(f, dict) and f.get("id")]
        if not facts:
            print(f"[harness] already ready: {', '.join(assets + jobs)} — read them now.")
            return _Ready()
        for f in facts:
            print(f"[harness] ready: {_fact_line(f)}")
        # The host may spell an id differently ('image:x' for 'artifact:x'): match on the bare id.
        described = {str(f["id"]).rsplit(":", 1)[-1] for f in facts}
        rest = [str(i) for i in assets + jobs if str(i).rsplit(":", 1)[-1] not in described]
        if rest:
            print(f"[harness] ready: {', '.join(rest)}")
        return _Ready()
    waiting = body.get("waiting_on") or (assets + jobs)
    held = body.get("held_s")
    raise WaitSignal(
        f"still not ready after {held or 'the'} s of waiting: {', '.join(str(w) for w in waiting)}. "
        f"This cell ends here. Either call wait_for(...) again (each call waits up to about "
        f"{int(float(body.get('hold_s') or 100))} s more) or end your turn — you will be woken when "
        f"they are ready, with the ids listed. Then read(id) / ${resultCall}(name)."
    )


def result(name: str):
    """The typed result of a launched run, by name — after a wake, when the variable is gone.
    Raises NotReady before the run is done."""
    body = Handle(name, "", "run")._status()
    return Handle(name, str(body.get("tool") or ""), str(body.get("kind") or "run"), expect=body.get("expect")).result()


def launch(server: str, tool: str, args: dict, name: str | None = None, expect: str | None = None) -> Handle:
    """Start a launch (a spawn_* API) and return its Handle at once."""
    sent = ${typedReturns ? "_asset_ids(_sendable(args, _NULLABLE.get((server, tool))))" : "_sendable(args, _NULLABLE.get((server, tool)))"}${validateArgs ? "\n    _validate(server, tool, sent)" : ""}
    payload = {"server": server, "tool": tool, "args": sent, "name": name, "expect": expect, "meta": {"arm": "codemode", "runId": _RUN_ID}}
    request = _request("/spawn", payload, tagged=True)
    try:
        body = _fetch(request)
    except Exception as exc:  # noqa: BLE001
        raise McpError(f"{server}.{tool}: proxy unreachable: {exc}") from exc
    if not body.get("ok"):
        raise McpError(f"{server}.{tool}: {body.get('error', 'unknown error')}")
    return Handle(body["name"], tool, body.get("kind", tool.replace("_tool", "")), expect=body.get("expect") or expect)

`;
}

/** codemode: the top-level index across servers. */
export function renderRootIndex(catalogue, { docsGate = "off", readGate = false, validateArgs = false, apiLayout: layout = "per-method", modules = null, moduleIndex = false } = {}) {
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
	// Announced, not sprung, for the same reason — and stated as the precondition it
	// is rather than as a first-use hint, because unlike the docs gate this one
	// cannot be cleared by retrying.
	const readGateAnnouncement = readGate
		? [
				"Calling an API before you have read its contract raises `ReadFirst` and",
				"nothing is sent. Use the `read` tool on `api/<app>.py` — one read covers",
				"every API in that app — then issue the call. Retrying without reading",
				"raises again.",
				"",
			]
		: [];
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
	// Grouped only when the emit actually produced more modules than servers: a
	// catalogue with no categories must render the index it always rendered.
	const grouped = Array.isArray(modules) && modules.length > catalogue.length;
	return [
		"# api",
		"",
		grouped
			? `${catalogue.length} servers, ${total} tools in ${modules.length} modules, all async.`
			: `${catalogue.length} servers, ${total} tools, all async.`,
		"",
		...announcement,
		...readGateAnnouncement,
		...validation,
		"Find a tool:",
		"  grep -ril '<keyword>' api/          # search every tool's documentation",
		// Per layout, and only the files that exist in it. The consolidated tree has
		// no per-app INDEX.md because the module is the index.
		// H54. This line WAS `cat api/<module>.py`, i.e. our own index instructing
		// the agent to dump the whole module -- and measured over 120 rounds, 72%
		// of them did exactly that. api/image.py is 65,578 chars at the truncation
		// cap, ~16k tokens, re-charged every later turn by residency (62% of the
		// bill, W46). The agent was complying, not erring, which is why the
		// error-channel rung (H52) fired in 1 round of 27 and measured null.
		//
		// So name the cheap route where the agent already looks: 91% of rounds read
		// this file, and 93% of the rounds that dump a module had read it first.
		// Off unless HARNESS_INDEX_DOCSTRING_HINT=1, so it is an A/B-able rung.
		...(apiLayout(layout) === "consolidated"
			? grouped
				? (process.env.HARNESS_INDEX_DOCSTRING_HINT === "1"
					? ["  python -c 'import api.<module> as m; print(m.<tool>.__doc__)'   # ONE contract, cheap",
					   "  cat api/<module>.py                 # the whole group -- large, prefer the line above"]
					: moduleIndex
						? ["  head -60 api/<module>.py            # the header: every API in the group, one line each with its signature",
						   "  cat api/<module>.py                 # the whole group, with full parameter docs"]
						: ["  cat api/<module>.py                 # one group: every API in it, with full parameter docs"])
				: (process.env.HARNESS_INDEX_DOCSTRING_HINT === "1"
					? ["  python -c 'import api.<package> as m; print(m.<tool>.__doc__)'  # ONE contract, cheap",
					   "  cat api/<package>.py                # the whole app -- large, prefer the line above"]
					: ["  cat api/<package>.py                # one app: every API, with full parameter docs"])
			: ["  cat api/<package>/INDEX.md          # list one server's tools", "  cat api/<package>/<tool>.py         # full parameter documentation"]),
		"",
		"Call one:",
		...(grouped
			? ["  import api.<module>", "  result = await api.<module>.<tool>(...)"]
			: ["  import api.<package>", "  result = await api.<package>.<tool>(...)"]),
		"",
		...(grouped
			? [
					"| module | what it holds | server | tools |",
					"| --- | --- | --- | --- |",
					// One row per module the agent can import. "What it holds" is the KINDS of
					// operation in it, derived from the tool names (operationFamilies) — the
					// app's own category word was "image" for api.image and "everything else
					// in this app" for the agent tools, which told the reader nothing (W129).
					...modules.map(
						(m) =>
							`| \`api.${m.module}\` | ${moduleIndex && m.names ? operationFamilies(m.names) : (m.category ?? "everything else in this app")} | ${m.server} | ${m.count} |`,
					),
				]
			: [
					"| package | server | tools |",
					"| --- | --- | --- |",
					// The package column is what gets imported; the server column is the
					// name the task description will use. The agent needs both to bridge.
					...catalogue.map((s) => `| \`${s.pyServer}\` | ${s.server} | ${s.tools.length} |`),
				]),
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
 * @param options.readGate render the verified read-precondition and `_linemap.json`
 * @param options.requiredDefaults Map of `"<server>\0<tool>\0<param>"` -> evidence
 *        quote, from bench/required-defaults.mjs. Those parameters render with no
 *        default, so omitting one is a TypeError at the call site. See
 *        `requiredDefaultNote`.
 * @returns { toolDefs, tocLines, names, files } — `files` is a path -> content
 *          map rooted at `api/`, written to disk by the caller.
 */
export function generate(
	catalogue,
	{
		docsGate = "off",
		readGate = false,
		validateArgs = false,
		waitBridge = false,
		apiLayout: layout = "per-method",
		requiredDefaults = null,
		// "auto" (the default): typed results when EVERY tool publishes an
		// outputSchema — every wrapper then returns the class compiled from its
		// schema. Any catalogue short of that (a foreign server; every pre-W128
		// dump) renders the string-returning tree it always did, byte-identical, so
		// no earlier benchmark's measured condition moves. `true`/`false` force it.
		typedReturns = "auto",
		// Typed parameters (bench/input-types.mjs): every structured argument becomes a
		// dataclass in `_types.py`, the wrapper refuses a dict where one is declared.
		// Opt-in, so no earlier benchmark's tree changes; needs typed returns.
		typedInputs = false,
		// Nested output records take their schema `title` as their class name. Off by
		// default so typed trees already measured keep their class names.
		schemaTitles = false,
		// In typed mode, a tool WITHOUT an outputSchema returns the untyped base
		// `ToolResult`. The product owes a schema on every tool (the product
		// agents/tool_output.py), so bench/port/build-bundle.mjs refuses a mixed
		// catalogue by default; this library default admits it because the
		// generator also compiles catalogues this project does not own.
		allowUntyped = true,
		serverAlias = true,
		// JSON Schema `format` strings that mark an asset / shape / job reference in
		// an outputSchema. Only an asset ref makes a result coercible back to an id.
		refFormats = DEFAULT_REF_FORMATS,
		// A kind annotation on ref strings, read in preference to `format`:
		// { key: "x-...-kinds", kinds: { <kind word>: "asset" | "shape" | "job" | null } }.
		// null reads formats only.
		refKinds = null,
		// Types module docstring example: lines of Python, or null for the neutral one.
		typesExample = null,
		// Extra members for generated result classes: { <ClassName>: <class-body Python> },
		// written unindented and appended last, so a member here overrides a generated
		// one. A name this catalogue does not generate is skipped: one option set serves
		// many catalogues.
		classExtensions = null,
		// The wait surface (see renderWaitSurface): "auto" renders it when some tool
		// declares `launches` or `awaitsInputs`; true/false force it.
		waitSurface = "auto",
		// Names the product's read and collect calls in the wait surface's text:
		// { read: "api.assets.read", result: "api.review.result" }.
		waitCalls = null,
		bridgeHeader = DEFAULT_BRIDGE_HEADER,
		// Comment lines rendered above the header in `_client.py`, or null for none.
		bridgeHeaderNote = null,
		// W126: the schema's bounds as a docstring line under each parameter.
		constraintNotes = false,
		// W129: a module-header index of its tools in the consolidated layout, the
		// operation families in the root index's "what it holds" column, and the
		// `head -60` pointer at that header.
		moduleIndex = false,
		// Consolidated: a server module whose name a category module already has is
		// renamed `<server>_<suffix>`. null refuses the catalogue instead.
		serverModuleSuffix = "server",
	} = {},
) {
	const gateMode = docsGateMode(docsGate);
	const layoutMode = apiLayout(layout);
	// Real MCP server names contain spaces ("OpenAPI Explorer", "Math MCP"), so
	// the package directory needs its own identifier. The raw name is still what
	// goes on the wire and what the TOC and tool defs display.
	// Applied ONCE, here, immediately after normalization — so every container
	// (the module, the L4 resident docs, the TOC, the vanilla tool defs, the
	// validator's `_schemas.json`) is rendered from one promoted tool object and
	// they cannot disagree about which parameters are required.
	const normalized = catalogue.map((s) => ({
		server: s.server,
		pyServer: pyPackage(s.server),
		tools: s.tools.map((t) => applyRequiredDefaults(normalizeTool(t), s.server, requiredDefaults)),
	}));

	const seen = new Map();
	for (const s of normalized) {
		// Two servers could normalize to the same identifier; disambiguate rather
		// than silently overwriting one package with the other. The deduped
		// pyServer is then THE package name: every renderer takes it as `pkg`
		// rather than recomputing pyPackage(server) — recomputation is how the TOC
		// and INDEX ended up citing `api.math_mcp.sub` while the module lived in
		// `math_mcp_2/` (2026-08-15 review, P1.5 #4).
		const count = seen.get(s.pyServer) ?? 0;
		seen.set(s.pyServer, count + 1);
		if (count > 0) s.pyServer = `${s.pyServer}_${count + 1}`;

		// Same collision class one level down: `dup-name` and `dup_name` both
		// normalize to `dup_name`. Consolidated, the second def silently SHADOWED
		// the first — api.x.dup_name called the wrong wire tool, no error;
		// per-method, one module file overwrote the other. The wire `name` is
		// untouched — _call still sends the original.
		const seenTools = new Map();
		for (const t of s.tools) {
			const n = seenTools.get(t.pyName) ?? 0;
			seenTools.set(t.pyName, n + 1);
			if (n > 0) t.pyName = `${t.pyName}_${n + 1}`;
		}
	}
	if (layoutMode === "consolidated") separateServerModules(normalized, { serverAlias, suffix: serverModuleSuffix });

	// Which coercion helpers this catalogue needs. Computed from the normalized
	// tools rather than passed in as a flag: an adapter is a property of the
	// SCHEMAS, not a condition of the run, so a catalogue with no adaptable
	// parameter must render the tree it always rendered.
	// Whether any tool in this catalogue is a wait tool. Like the adapters, this is a
	// property of the SCHEMAS: a catalogue without one renders the tree it always did
	// even with the option on.
	const hasWaitTool = normalized.some((s) => s.tools.some((t) => waitToolParam(t)));
	// Per tool, the wire names whose schema accepts null: where an explicit None is sent.
	const nullable = normalized.flatMap((s) =>
		s.tools
			.map((t) => [s.server, t.name, t.params.filter((p) => p.nullable).map((p) => p.name)])
			.filter(([, , names]) => names.length > 0),
	);
	const adapters = new Set(
		normalized.flatMap((s) =>
			s.tools.flatMap((t) => t.params.filter((p) => p.adapter).map((p) => coercion(p).helper)),
		),
	);

	// The output classes, compiled once from every tool's outputSchema and threaded
	// to each renderer as `returnShapes` (the name every renderer already takes).
	const allTools = normalized.flatMap((s) => s.tools);
	const untyped = untypedTools(allTools);
	// auto: typed only when EVERY tool publishes a schema — the product's catalogue.
	// A foreign catalogue where some servers happen to publish outputSchema keeps
	// rendering the untyped tree every earlier benchmark measured; forcing `true`
	// is the deliberate act that changes that condition.
	if (typedReturns === "auto") typedReturns = allTools.length > 0 && untyped.length === 0;
	// A caller that requires schemas is refused a catalogue missing any, whatever
	// mode the tree would have rendered in: the refusal is about the declaration.
	if (!allowUntyped && untyped.length > 0) {
		throw new Error(
			`${untyped.length} tool(s) publish no outputSchema: ${untyped.slice(0, 8).join(", ")}${untyped.length > 8 ? ", …" : ""}. ` +
				"Declare an output schema on every tool and re-dump the catalogue, " +
				"or pass allowUntyped: true for a catalogue whose schemas you do not control.",
		);
	}
	const returnShapes = typedReturns ? collectOutputTypes(allTools, { refFormats, refKinds, schemaTitles }) : null;
	if (typedInputs && !typedReturns) {
		throw new Error("typedInputs needs typed returns: the argument classes live in _types.py, which only a typed tree has");
	}
	const inputShapes = typedInputs ? collectInputTypes(allTools, { taken: new Set(returnShapes.classes.keys()) }) : null;
	if (inputShapes) {
		for (const t of allTools) {
			for (const p of t.params) {
				const typed = inputShapes.params.get(`${t.name}\0${p.name}`);
				if (!typed) continue;
				// The class replaces both the plain hint and any shape adapter: a dataclass
				// argument is the one spelling, so there is nothing left to coerce.
				p.type = typed.py;
				p.adapter = null;
				p.inputTyped = true;
				p.inputCheck = typed.check;
				p.inputClasses = [...typed.py.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)].map((m) => m[0]).filter((n) => inputShapes.classes.has(n));
			}
		}
	}
	const launching = allTools.filter((t) => t.launches).map((t) => t.name);
	if (waitSurface === "auto") waitSurface = launching.length > 0 || allTools.some((t) => t.awaitsInputs);
	// A launch wrapper returns `_launch(...)`, which only the wait surface defines.
	if (!waitSurface && launching.length > 0) {
		throw new Error(`waitSurface: false, but ${launching.join(", ")} declare launches; their wrappers need the wait surface`);
	}

	const toolDefs = [];
	const tocLines = [];
	const names = [];
	// Catalogue-wide, so a category two servers both use can be qualified rather
	// than silently overwritten by whichever server renders second.
	const claimed = claimedCategories(normalized);
	// What the root INDEX lists: one row per emitted module, which is what the agent
	// imports — the package table stopped being that the moment a server became
	// several modules.
	const modules = [];
	// `__init__.py` at the root so `import api.<pkg>` resolves as a regular
	// package rather than relying on namespace-package resolution.
	const files = {
		// Placeholder: rewritten below, once the modules are known. In the grouped
		// layout the row set is a property of the emit, not of the catalogue.
		"INDEX.md": "",
		"__init__.py": waitSurface
			? '"""Generated MCP tool catalogue. See INDEX.md."""\n\n'
				+ "from ._client import Handle, NotReady, wait_for  # noqa: F401 — the wait surface (W130)\n"
			: '"""Generated MCP tool catalogue. See INDEX.md."""\n',
		// Throws on read-gate + docs-gate and on read-gate + per-method, before a
		// single file is written. A tree that half-satisfies a label is the failure
		// mode this project keeps rediscovering.
		"_client.py": renderClient({ docsGate: gateMode, readGate, validateArgs, adapters, nullable, waitBridge: waitBridge && hasWaitTool, apiLayout: layoutMode, typedReturns, returnShapes, waitSurface, bridgeHeader, bridgeHeaderNote, waitCalls, renamed: allTools.some((t) => t.renamed) }),
	};
	// Only when the gate is on: the map is the gate's evidence, and an unused span
	// table in the tree is one more hit in the agent's `grep -ril`.
	const lineMap = readGate ? {} : null;
	// Only when validation is on: an unused 469-schema file in the tree is one more
	// hit in the agent's `grep -ril` and one more thing to read.
	// The typed result surface. Its own module so `_client` imports it and any
	// cell can too: `from api._types import Asset` is a thing a person would try.
	if (typedReturns) files["_types.py"] = renderOutputTypes(returnShapes, { example: typesExample, resultCall: waitCalls?.result, extensions: classExtensions }) + (inputShapes ? renderInputTypes(inputShapes) : "");
	if (validateArgs) {
		const modules = layoutMode === "consolidated" ? categoryModuleMap(normalized, claimed) : null;
		files["_schemas.json"] = renderSchemas(normalized, { waitSurface, modules });
	}
	// Only the mode that cites siblings pays for the table. Every extra file in
	// the tree is one more line in the agent's `grep -ril`.
	if (gateMode === "inline") files["_neighbours.json"] = renderNeighbours(normalized);

	for (const { server, pyServer, tools } of normalized) {
		toolDefs.push(...renderToolDefs(tools, { server }));
		tocLines.push(...renderTocLines(tools, { server, pkg: pyServer }));
		names.push(...renderNames(tools, { server, pkg: pyServer }));

		if (layoutMode === "consolidated") {
			// One module per CATEGORY when the catalogue carries them, and nothing else:
			// no per-app INDEX.md (the module is the index), no DOCS.md (the module is
			// the documentation), no per-method files. `_call`'s first argument is the
			// real server name in every module, so where a function is DOCUMENTED and
			// where it is DISPATCHED are independent — pinned by test.
			const { groups, ungrouped } = categoryModules(tools, pyServer, claimed);
			for (const group of groups) {
				const part = renderAppModuleParts(group.tools, {
					typedReturns,
					returnShapes,
					constraintNotes,
					moduleIndex,
					server,
					pkg: group.module,
					docsGate: gateMode,
					readGate,
					waitBridge,
				});
				emitModule(files, group.module, part.text);
				if (lineMap) lineMap[group.module] = part.lineMap;
				modules.push(moduleEntry(group.module, server, group.category, group.tools));
			}
			// The server module: the ungrouped tools in full, plus an alias for the
			// grouped ones so a call written before the split keeps working.
			const rest = groups.length === 0 ? tools : ungrouped;
			const part =
				rest.length > 0
					? renderAppModuleParts(rest, { server, pkg: pyServer, docsGate: gateMode, readGate, waitBridge, typedReturns, returnShapes, constraintNotes, moduleIndex })
					: null;
			if (groups.length === 0) {
				emitModule(files, pyServer, part.text);
				if (lineMap) lineMap[pyServer] = part.lineMap;
				modules.push(moduleEntry(pyServer, server, null, tools));
			} else if (serverAlias || rest.length > 0) {
				// W130: with `serverAlias: false` (the codemode bundle's default) the server
				// module is emitted only if it still DEFINES something (ungrouped tools). The
				// pure re-export alias showed every tool again under the server's name —
				// `dir(api.agent_tools)` in 7 of 12 h65 traces — undoing the split.
				emitModule(files, pyServer, renderServerAlias(server, pyServer, groups, part?.text ?? ""));
				if (lineMap && part) lineMap[pyServer] = part.lineMap;
				if (rest.length > 0) modules.push(moduleEntry(pyServer, server, null, rest));
			}
			continue;
		}
		modules.push(moduleEntry(pyServer, server, null, tools));
		files[`${pyServer}/INDEX.md`] = renderServerIndex(tools, { server, pkg: pyServer, docsGate: gateMode, waitBridge });
		files[`${pyServer}/__init__.py`] = renderServerInit(tools, { server });
		// The redirect target. Both live modes render it: `redirect` sends the agent
		// here instead of showing a docstring, `inline` sends it here when a sibling
		// looks like the better call.
		if (gateMode !== "off") files[`${pyServer}/DOCS.md`] = renderAppDocs(tools, { server, pkg: pyServer, constraintNotes });
		for (const tool of tools) {
			files[`${pyServer}/${tool.pyName}.py`] = renderToolModule(tool, { server, docsGate: gateMode, waitBridge, typedReturns, returnShapes, constraintNotes });
		}
	}

	// Written last, so both can only ever describe modules that were actually
	// rendered — the same reason the line map is written here.
	files["INDEX.md"] = renderRootIndex(normalized, {
		docsGate: gateMode,
		readGate,
		validateArgs,
		apiLayout: layoutMode,
		modules,
		moduleIndex,
	});
	if (lineMap) files["_linemap.json"] = `${JSON.stringify(lineMap, null, 1)}\n`;

	return { toolDefs, tocLines, names, files, normalized, modules, callPaths: callPathMap(modules), moduleToc: renderModuleToc(modules) };
}

/** One importable module: what `generate()` returns in `modules` and the root INDEX lists. */
function moduleEntry(module, server, category, tools) {
	return { module, server, category, count: tools.length, names: tools.map((t) => t.pyName), tools: tools.map((t) => t.name) };
}

/** `{"api.<module>.<function>": {server, tool}}`: the call a cell types, and what goes on the wire. */
export function callPathMap(modules) {
	const out = {};
	for (const m of modules) m.names.forEach((fn, i) => (out[`api.${m.module}.${fn}`] = { server: m.server, tool: m.tools[i] }));
	return out;
}

/** One line per module: its import path, tool count and the families of tools in it. */
export function renderModuleToc(modules) {
	const sorted = [...modules].sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
	const width = Math.max(0, ...sorted.map((m) => `api.${m.module}`.length));
	return sorted.map((m) => {
		const count = `${m.count} tool${m.count === 1 ? "" : "s"}`;
		return `  ${`api.${m.module}`.padEnd(width)}  ${count.padStart(8)} — ${operationFamilies(m.names)}`;
	});
}

/** Write `api/<module>.py`, refusing to overwrite one already emitted. */
function emitModule(files, module, text) {
	const path = `${module}.py`;
	if (path in files) throw new Error(`two modules render to api/${path}; rename a server or a category`);
	files[path] = text;
}

/**
 * Consolidated layout: rename a server whose own module would land on a category
 * module's file. A server and a category are named independently (a connector
 * called `notion` beside a category `notion`), and without this the second write
 * replaced the first. The rename is `<server>_<suffix>`, numbered if that is taken;
 * only the Python package moves, `_call` still sends the server's own name.
 */
export function separateServerModules(normalized, { serverAlias = true, suffix = "server" } = {}) {
	const claimed = claimedCategories(normalized);
	const layouts = normalized.map((s) => ({ s, ...categoryModules(s.tools, s.pyServer, claimed) }));
	const categories = new Set(layouts.flatMap((l) => l.groups.map((g) => g.module)));
	const taken = new Set([...categories, ...normalized.map((s) => s.pyServer)]);
	for (const { s, groups, ungrouped } of layouts) {
		const emitsServer = groups.length === 0 || serverAlias || ungrouped.length > 0;
		if (!emitsServer || !categories.has(s.pyServer)) continue;
		if (suffix === null) {
			throw new Error(`server ${JSON.stringify(s.server)} and a category both render api/${s.pyServer}.py; set serverModuleSuffix to rename the server`);
		}
		let name = `${s.pyServer}_${pyPackage(suffix)}`;
		for (let n = 2; taken.has(name); n++) name = `${s.pyServer}_${pyPackage(suffix)}_${n}`;
		taken.add(name);
		s.pyServer = name;
	}
}
