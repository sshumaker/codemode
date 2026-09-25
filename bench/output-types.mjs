/**
 * Output types for the compiled bridge, derived from each tool's `outputSchema`.
 *
 * WHY THIS FILE EXISTS. Until W128 the generated wrappers were annotated `-> Any`
 * and returned the server's JSON as a *string*; a corpus-derived map then promised
 * `CreativeResult` for 33 tools and a name-prefix rule guessed the rest. Neither
 * was derived from the tools. Measured cost of the string: 59/59 creative-action
 * cells on one control arm re-typed an asset id by hand off a printed result, and
 * every `result["assets"]` on a str raised `string indices must be integers`.
 *
 * Now the product declares an output model on every tool and publishes it as
 * MCP `outputSchema`. This module
 * compiles that schema — and nothing else — into a frozen dataclass per distinct
 * shape, so:
 *
 *   result = await api.image.create_image_nano_banana_pro(prompt=...)
 *   result.assets            # {"image": ["image:CZaUC3KT"]}, typed
 *   result.id                # the first asset ref
 *   references=[result]      # coerced to the id on the wire
 *   result["assets"]         # still works — the idiom the model already writes
 *
 * Rules, all schema-driven:
 *  - one class per DISTINCT schema (the 45 creative actions share one envelope
 *    and get one class, named by the schema's own `title`);
 *  - `$defs` become nested classes; `anyOf [X, null]` becomes `X | None`;
 *  - a string whose `format` is the catalogue's asset-ref format IS an asset ref. A class whose fields
 *    carry asset refs gets `.ids`, `.id`, `__str__` (the id), `__iter__` and
 *    `__len__`, which is what lets a result be passed straight back;
 *  - a tool with NO outputSchema gets the untyped base `ToolResult` (parsed JSON
 *    behind `.raw`, dict access still works). `generate()` refuses such a
 *    catalogue unless told to allow it, because a missing schema is a missing
 *    declaration in the product, not a property of the tool.
 *
 * Pure: no disk, no clock. `renderOutputTypes` returns Python source text.
 */

/**
 * The JSON Schema `format` strings that mark a reference, by kind. A catalogue
 * names its own formats (`collectOutputTypes(tools, { refFormats })`); these are
 * the neutral defaults. A field's `ref` is recorded as the KIND ("asset" |
 * "shape" | "job"), never as the format string, so nothing downstream depends on
 * which product's spelling the catalogue used.
 */
export const DEFAULT_REF_FORMATS = Object.freeze({ asset: "asset-ref", shape: "shape-ref", job: "job-ref" });

// Scoped to one collectOutputTypes() call; see there.
let refFormatKinds = new Map(Object.entries(DEFAULT_REF_FORMATS).map(([kind, format]) => [format, kind]));

/** The fallback class every untyped tool returns. Also the base of every typed one. */
export const UNTYPED_RESULT = "ToolResult";

const PY_SCALARS = { string: "str", number: "float", integer: "int", boolean: "bool", null: "None" };

const pascal = (s) =>
	String(s)
		.replace(/[^A-Za-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join("") || "Output";

const isIdent = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

/** A class name for a tool's output: the schema's title (pydantic emits the model's
 *  class name) when it is an identifier, else derived from the tool name. */
export function outputClassName(tool) {
	const schema = tool.outputSchema;
	if (!schema || typeof schema !== "object") return UNTYPED_RESULT;
	if (typeof schema.title === "string" && isIdent(schema.title) && schema.title !== UNTYPED_RESULT) return schema.title;
	return `${pascal(tool.pyName ?? tool.name)}Output`;
}

/** Canonical JSON: key-sorted, so two identical schemas compare equal by string. */
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

const refName = (ref) => (typeof ref === "string" && ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : null);

/**
 * Resolve the type of ONE schema node to (python type, kind), collecting nested
 * object classes into `classes` as it goes. `name` is the class name to use if
 * this node is itself an inline object with properties.
 */
function fieldType(node, { name, defs, classes, prefix }) {
	if (!node || typeof node !== "object") return { py: "Any", ref: null, cls: null };
	const dn = refName(node.$ref);
	if (dn) {
		const target = defs[dn];
		if (!target) return { py: "Any", ref: null, cls: null };
		const cls = ensureClass(dn, target, { defs, classes, prefix });
		return { py: cls, ref: null, cls };
	}
	const variants = node.anyOf ?? node.oneOf;
	if (Array.isArray(variants) && variants.length > 0) {
		const nonNull = variants.filter((v) => !(v && v.type === "null"));
		const parts = nonNull.map((v, i) => fieldType(v, { name: nonNull.length > 1 ? `${name}${i + 1}` : name, defs, classes, prefix }));
		const py = [...new Set(parts.map((p) => p.py))].join(" | ") || "Any";
		const nullable = variants.length !== nonNull.length;
		// A ref that is one of several variants is still a ref for coercion purposes.
		const ref = parts.find((p) => p.ref)?.ref ?? null;
		const cls = parts.length === 1 ? parts[0].cls : null;
		return { py: nullable ? `${py} | None` : py, ref, cls, listOf: parts.length === 1 ? parts[0].listOf : undefined, mapOf: parts.length === 1 ? parts[0].mapOf : undefined };
	}
	if (Array.isArray(node.type)) {
		const nonNull = node.type.filter((t) => t !== "null");
		const parts = nonNull.map((t) => fieldType({ ...node, type: t }, { name, defs, classes, prefix }));
		const py = [...new Set(parts.map((p) => p.py))].join(" | ") || "Any";
		return { py: node.type.includes("null") ? `${py} | None` : py, ref: parts.find((p) => p.ref)?.ref ?? null, cls: null };
	}
	if (node.type === "string") {
		const ref = refFormatKinds.get(node.format) ?? null;
		if (Array.isArray(node.enum) && node.enum.every((e) => typeof e === "string")) {
			return { py: `Literal[${node.enum.map((e) => JSON.stringify(e)).join(", ")}]`, ref, cls: null };
		}
		return { py: "str", ref, cls: null };
	}
	if (node.type === "array") {
		const item = fieldType(node.items, { name: `${name}Item`, defs, classes, prefix });
		return { py: `list[${item.py}]`, ref: item.ref, cls: null, listOf: item };
	}
	if (node.type === "object") {
		if (node.properties && Object.keys(node.properties).length > 0) {
			const cls = ensureClass(name, node, { defs, classes, prefix });
			return { py: cls, ref: null, cls };
		}
		if (node.additionalProperties && typeof node.additionalProperties === "object") {
			const val = fieldType(node.additionalProperties, { name: `${name}Value`, defs, classes, prefix });
			return { py: `dict[str, ${val.py}]`, ref: val.ref, cls: null, mapOf: val };
		}
		return { py: "dict[str, Any]", ref: null, cls: null };
	}
	return { py: PY_SCALARS[node.type] ?? "Any", ref: null, cls: null };
}

/** Register (once) the class for an object schema and return its final name. */
function ensureClass(name, node, { defs, classes, prefix }) {
	let cls = isIdent(name) ? name : pascal(name);
	// Same name, different shape (two schemas each with a nested `Item`): suffix
	// the later one with its owner rather than silently merging two records.
	const key = canonical({ ...node, title: undefined, description: undefined });
	const existing = classes.get(cls);
	if (existing && existing.key !== key) cls = `${prefix}${cls}`;
	if (classes.has(cls)) return cls;
	// Reserve before recursing so a self-referential schema terminates.
	const entry = { name: cls, key, node, fields: [], description: node.description ?? "" };
	classes.set(cls, entry);
	const required = new Set(node.required ?? []);
	for (const [fname, fnode] of Object.entries(node.properties ?? {})) {
		const t = fieldType(fnode, { name: `${cls}${pascal(fname)}`, defs, classes, prefix: cls });
		entry.fields.push({
			name: fname,
			pyName: isIdent(fname) && !PY_RESERVED.has(fname) ? fname : `${fname.replace(/[^A-Za-z0-9_]/g, "_")}_`,
			required: required.has(fname),
			py: t.py,
			ref: t.ref,
			cls: t.cls,
			listOf: t.listOf,
			mapOf: t.mapOf,
			description: (fnode && fnode.description) || "",
		});
	}
	return cls;
}

const PY_RESERVED = new Set([
	"False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
	"else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or",
	"pass", "raise", "return", "try", "while", "with", "yield", "raw",
]);

// Base-class attributes a payload field may legitimately be named after (`id`,
// `text`, ...). A required dataclass field with no default leaves the base
// PROPERTY in place, and a frozen __init__ then fails on it ("property has no
// setter") — so a colliding field always gets a default, which as a class
// attribute shadows the property. from_payload still treats it as required.
const BASE_ATTRS = new Set(["id", "ids", "text", "keys", "items", "values", "get"]);

/**
 * Every distinct output type across `tools`, in a stable order, as
 * `{ classes: Map<name, entry>, byTool: Map<toolName, className> }`.
 *
 * `tools` are normalized tools (`name`, `pyName`, `outputSchema`).
 */
export function collectOutputTypes(tools, { refFormats = DEFAULT_REF_FORMATS } = {}) {
	const previous = refFormatKinds;
	refFormatKinds = new Map(Object.entries({ ...DEFAULT_REF_FORMATS, ...refFormats }).filter(([, format]) => format).map(([kind, format]) => [format, kind]));
	try {
		return collectOutputTypesWith(tools);
	} finally {
		refFormatKinds = previous;
	}
}

function collectOutputTypesWith(tools) {
	const classes = new Map();
	const byTool = new Map();
	const byShape = new Map();
	for (const tool of tools) {
		const schema = tool.outputSchema;
		if (!schema || typeof schema !== "object" || !isTypedSchema(schema)) {
			byTool.set(tool.name, UNTYPED_RESULT);
			continue;
		}
		const key = canonical({ ...schema, description: undefined });
		if (byShape.has(key)) {
			byTool.set(tool.name, byShape.get(key));
			continue;
		}
		const want = outputClassName(tool);
		if (Array.isArray(schema.anyOf)) {
			// A union (an `anyOf` of closed records): each variant is its own closed class;
			// the union class dispatches on which variant accepts the payload's keys.
			const variantNames = schema.anyOf.map((v, i) => {
				const vdefs = v.$defs ?? v.definitions ?? schema.$defs ?? {};
				const vname = typeof v.title === "string" && isIdent(v.title) ? v.title : `${want}Variant${i + 1}`;
				return ensureClass(vname, v, { defs: vdefs, classes, prefix: vname });
			});
			let uname = want;
			if (classes.has(uname)) uname = `${want}Union`;
			classes.set(uname, { name: uname, key, node: schema, fields: [], description: schema.description ?? "", union: variantNames });
			byShape.set(key, uname);
			byTool.set(tool.name, uname);
			continue;
		}
		const defs = schema.$defs ?? schema.definitions ?? {};
		const cls = ensureClass(want, schema, { defs, classes, prefix: want });
		// The owner's description is the class docstring even when the shape was
		// registered under another name; keep the first non-empty one.
		if (!classes.get(cls).description && schema.description) classes.get(cls).description = schema.description;
		byShape.set(key, cls);
		byTool.set(tool.name, cls);
	}
	return { classes, byTool };
}

/** The asset-carrying fields of a class: `{ scalar: [...], many: [...] }`. */
function assetFields(entry) {
	const scalar = entry.fields.filter((f) => f.ref === "asset" && !f.listOf && !f.mapOf && f.py.startsWith("str"));
	const many = entry.fields.filter((f) => f.ref === "asset" && (f.listOf || f.mapOf));
	return { scalar, many };
}

const pyStr = (s) => JSON.stringify(String(s));

function docLines(text, indent) {
	return String(text)
		.replace(/"""/g, '\\"\\"\\"')
		.split("\n")
		.map((l) => (l.trim() ? `${indent}${l}` : ""));
}

/**
 * One frozen dataclass. Kept SHORT on purpose: the model reads `_types.py` whole
 * during discovery (h64, pos 31: 1,800 lines, ~40k tokens), so every class is
 * its docstring, its fields, and three spec tuples the base class interprets.
 */
function renderClass(entry) {
	if (entry.union) return renderUnionClass(entry);
	const { scalar, many } = assetFields(entry);
	const req = entry.fields.filter((f) => f.required);
	const opt = entry.fields.filter((f) => !f.required);
	const lines = ["@dataclass(frozen=True, kw_only=True, repr=False)", `class ${entry.name}(ToolResult):`];
	const doc = [entry.description || `The result of a tool returning \`${entry.name}\`.`];
	// Field docs, compact: the annotations below already carry name and type, so a
	// field is documented here only when the schema SAYS something about it (a
	// description or a ref kind). The model reads this file whole during discovery
	// (h64: 300k tokens on one job); every repeated line is paid on every turn.
	const documented = entry.fields.filter((f) => f.description || f.ref);
	if (documented.length) {
		doc.push("");
		for (const f of documented) {
			const kind = f.ref ? `[${f.ref} ref] ` : "";
			doc.push(`${f.pyName}: ${kind}${f.description || ""}`.trimEnd());
		}
	}
	if (many.length) {
		doc.push("", "Produces assets: `str(result)` / `result.id` is the first asset ref and `result.ids` all", "of them, so `references=[result]` and `ids=[result]` work.");
	} else if (scalar.length) {
		doc.push("", `Carries an asset ref in ${scalar.map((f) => `\`${f.pyName}\``).join(", ")}: pass the result straight back where an asset id is expected.`);
	}
	lines.push('    """' + doc[0]);
	lines.push(...docLines(doc.slice(1).join("\n"), "    "));
	lines.push('    """', "");
	for (const f of [...req, ...opt]) {
		const ann = f.required || f.py.endsWith("| None") ? f.py : `${f.py} | None`;
		const needsDefault = !f.required || BASE_ATTRS.has(f.pyName);
		lines.push(`    ${f.pyName}: ${ann}${needsDefault ? " = None" : ""}`);
	}
	if (!entry.fields.length) lines.push("    pass", "");
	// The spec the base class interprets: (payload key, field, nested class, how).
	const spec = entry.fields.map((f) => {
		const nested = f.cls ?? f.listOf?.cls ?? f.mapOf?.cls ?? null;
		const how = f.listOf ? "list" : f.mapOf ? "map" : "one";
		return `(${pyStr(f.name)}, ${pyStr(f.pyName)}, ${nested ?? "None"}, ${pyStr(how)})`;
	});
	if (spec.length) {
		lines.push("", `    _SPEC = (${spec.join(", ")},)`);
		lines.push(`    _REQUIRED = frozenset(${JSON.stringify(req.map((f) => f.name)).replace(/"/g, "'")})`);
	}
	const assetSpec = [...many, ...scalar].map((f) => `(${pyStr(f.pyName)}, ${pyStr(f.mapOf ? "map" : f.listOf ? "list" : "one")})`);
	if (assetSpec.length) lines.push(`    _ASSET_FIELDS = (${assetSpec.join(", ")},)`);
	// Only a class whose PURPOSE is producing assets stringifies to the id. A read
	// result carries an asset_id too, and `print(read_result)` printing eight
	// characters instead of the record cost three cells per trace (h64, pos 3, 12).
	if (many.length) {
		lines.push("", "    def __str__(self) -> str:", "        refs = self._asset_refs()", "        return refs[0] if refs else super().__str__()", "", "    def __iter__(self):", "        return iter(Asset(id=i) for i in self._asset_refs())", "", "    def __len__(self) -> int:", "        return len(self._asset_refs())");
	}
	const flag = entry.fields.find((f) => f.py === "bool" && ["completed", "success", "ok", "done"].includes(f.name));
	if (flag) lines.push("", "    def __bool__(self) -> bool:", `        return bool(self.${flag.pyName})`);
	return lines.join("\n");
}

/**
 * A union: the class a multi-arm tool is annotated with. `from_payload` returns
 * the variant whose key set matches (required keys present, no unknown keys);
 * an instance of the union class itself is never constructed.
 */
function renderUnionClass(entry) {
	const lines = ["@dataclass(frozen=True, kw_only=True, repr=False)", `class ${entry.name}(ToolResult):`];
	const doc = [entry.description || `One of: ${entry.union.join(", ")}.`, "", `Variants: ${entry.union.join(", ")}. The value you get IS one of those classes —`, "check with isinstance or look at its fields; each variant lists its own."];
	lines.push('    """' + doc[0]);
	lines.push(...docLines(doc.slice(1).join("\n"), "    "));
	lines.push('    """', "");
	lines.push(`    _VARIANTS = (${entry.union.join(", ")},)`);
	lines.push("", "    @classmethod", "    def from_payload(cls, obj):", "        if not isinstance(obj, dict):", "            return ToolResult(raw=obj)", "        keys = set(obj)", "        best, best_score = None, None", "        for v in cls._VARIANTS:", "            declared = {k for k, _f, _c, _h in v._SPEC}", "            if not v._REQUIRED <= keys:", "                continue", "            unknown = len(keys - declared)", "            score = (unknown, -len(keys & declared))", "            if best_score is None or score < best_score:", "                best, best_score = v, score", "        return best.from_payload(obj) if best is not None else ToolResult(raw=obj)");
	return lines.join("\n");
}

/**
 * `_types.py`: the base classes, every generated class, the registry `wrap`
 * dispatches on, and the argument coercion `_client` applies before a call.
 */
/** The docstring's worked example when the caller names none: shape, not product. */
export const DEFAULT_TYPES_EXAMPLE = Object.freeze([
	"first = await api.<module>.<tool_that_makes_something>(...)",
	"await api.<module>.<tool_that_takes_it>(..., references=[first])",
]);

export function renderOutputTypes({ classes }, { example = null, resultCall = "result" } = {}) {
	const exampleLines = (example ?? DEFAULT_TYPES_EXAMPLE).map((l) => `    ${l}`).join("\n");
	// Dependency order: a class's _SPEC names its nested classes at class-body
	// time, so those must already exist. Post-order over the `cls` references.
	const all = [...classes.values()];
	const byName = new Map(all.map((c) => [c.name, c]));
	const generated = [];
	const seen = new Set();
	const visit = (c) => {
		if (seen.has(c.name)) return;
		seen.add(c.name);
		for (const f of c.fields) {
			const dep = f.cls ?? f.listOf?.cls ?? f.mapOf?.cls;
			if (dep && byName.has(dep) && dep !== c.name) visit(byName.get(dep));
		}
		for (const dep of c.union ?? []) if (byName.has(dep)) visit(byName.get(dep));
		generated.push(c);
	};
	all.forEach(visit);
	const head = `"""Typed results for this API. Generated from each tool's outputSchema — do not edit.

Every API function returns an instance of one of these classes instead of the
server's JSON text. Dict-style access still works (\`result["assets"]\`), the
typed fields are attributes (\`result.assets\`), and a result that carries asset
refs can be passed straight back wherever an asset id is expected:

${exampleLines}

\`.raw\` is the whole payload as the server sent it, so nothing is lost.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass(frozen=True)
class Asset:
    """One asset ref. Usable anywhere an asset id is expected — pass the object."""

    id: str
    kind: str | None = None

    def __str__(self) -> str:
        return self.id


@dataclass(frozen=True, kw_only=True)
class ToolResult:
    """A tool result. The base of every typed result, and what an API with no
    output schema returns: the parsed payload behind \`.raw\`, readable dict-style.
    """

    raw: Any = None

    # Which payload keys map to which fields, and how: (key, field, nested class or
    # None, "one" | "list" | "map"). Filled in by each generated subclass; the base
    # from_payload below is the only constructor logic, so 56 classes do not carry
    # 56 copies of it.
    _SPEC: tuple = ()
    _REQUIRED: frozenset = frozenset()
    # Fields carrying asset refs, as (field, "one" | "list" | "map").
    _ASSET_FIELDS: tuple = ()

    def __getitem__(self, key):
        if isinstance(self.raw, (dict, list)):
            return self.raw[key]
        raise TypeError(f"{type(self).__name__} payload is {type(self.raw).__name__}, not indexable; see .raw")

    def get(self, key, default=None):
        return self.raw.get(key, default) if isinstance(self.raw, dict) else default

    def __contains__(self, key) -> bool:
        return isinstance(self.raw, dict) and key in self.raw

    def keys(self):
        return self.raw.keys() if isinstance(self.raw, dict) else []

    def items(self):
        return self.raw.items() if isinstance(self.raw, dict) else []

    def values(self):
        return self.raw.values() if isinstance(self.raw, dict) else []

    def __repr__(self) -> str:
        # Only the fields this payload actually carries: a 30-field class printing
        # 27 =None fields hides the three that matter (measured, h64).
        shown = []
        for _k, f, _c, _how in type(self)._SPEC:
            v = getattr(self, f, None)
            if v is not None:
                shown.append(f"{f}={v!r}")
        if not type(self)._SPEC:
            return f"{type(self).__name__}(raw={self.raw!r})"
        return f"{type(self).__name__}({', '.join(shown)})"

    def _asset_refs(self) -> list[str]:
        # The refs this result carries. A method with a private name so a payload
        # field called "id" or "ids" (shape records have one) cannot shadow it —
        # coercion and __str__ go through here, never through the properties.
        out: list = []
        for f, how in type(self)._ASSET_FIELDS:
            v = getattr(self, f, None)
            if v is None:
                continue
            if how == "map":
                for vs in v.values():
                    out.extend(vs if isinstance(vs, list) else [vs])
            elif how == "list":
                out.extend(v)
            else:
                out.append(v)
        return [str(x) for x in out]

    @property
    def ids(self) -> list[str]:
        """Every asset ref this result carries, in field order ([] when none)."""
        return self._asset_refs()

    @property
    def id(self) -> str:
        """The first asset ref this result carries. Raises if it carries none."""
        refs = self._asset_refs()
        if not refs:
            raise ValueError(f"{type(self).__name__} carries no asset ref; see .raw for what the server said")
        return refs[0]

    def __str__(self) -> str:
        # print(result) shows the payload, as it did when results were strings.
        # Asset-PRODUCING classes override this to return their id.
        return self.raw if isinstance(self.raw, str) else json.dumps(self.raw, default=str)

    def __await__(self):
        # A record is already here; awaiting it is a no-op that yields itself. Measured
        # (h68 pos 22): the model writes 'await handle.result()' and 'await
        # ${resultCall}(name)' because every other call on this surface is awaited,
        # and a TypeError there costs the turn the wait just saved.
        if False:
            yield
        return self

    @classmethod
    def from_payload(cls, obj):
        if not cls._SPEC or not isinstance(obj, dict):
            return cls(raw=obj)
        kw = {}
        for key, f, nested, how in cls._SPEC:
            if key not in obj:
                if key in cls._REQUIRED:
                    kw[f] = None
                continue
            v = obj[key]
            if nested is None or v is None:
                kw[f] = v
            elif how == "list":
                kw[f] = [nested.from_payload(x) if isinstance(x, dict) else x for x in v] if isinstance(v, list) else v
            elif how == "map":
                kw[f] = {k: (nested.from_payload(x) if isinstance(x, dict) else x) for k, x in v.items()} if isinstance(v, dict) else v
            else:
                kw[f] = nested.from_payload(v) if isinstance(v, dict) else v
        return cls(raw=obj, **kw)


AssetLike = Asset | ToolResult
`;
	const body = generated.map(renderClass).join("\n\n\n");
	const registry = `

# Class by name — what \`_client.call\` resolves the wrapper's promised type against.
_TYPES: dict[str, type[ToolResult]] = {${generated.map((c) => `${pyStr(c.name)}: ${c.name}`).join(", ")}}


def _is_asset_like(value: Any) -> bool:
    return isinstance(value, Asset) or (isinstance(value, ToolResult) and bool(type(value)._ASSET_FIELDS))


def asset_id(value: Any) -> Any:
    """Any asset-shaped value as the id the wire expects.

    Applied to every argument before a call, so an \`Asset\`, a typed result that
    carries asset refs, a bare id, and lists/dicts of any of them are all accepted
    at every asset parameter. Values it does not recognise pass through untouched.
    """
    if isinstance(value, Asset):
        return value.id
    if _is_asset_like(value):
        refs = value._asset_refs()
        return refs[0] if refs else value
    if isinstance(value, list):
        return [asset_id(v) for v in value]
    if isinstance(value, tuple):
        return tuple(asset_id(v) for v in value)
    if isinstance(value, dict):
        return {k: asset_id(v) for k, v in value.items()}
    return value


def wrap(text: str, expect: str | None = None) -> ToolResult:
    """Parse a tool's text result into the class its wrapper promised.

    \`expect\` names a generated class. A payload that is not a JSON object still
    comes back as a \`ToolResult\` carrying the text (never a bare string): an
    annotation that silently degrades to \`str\` is the \`-> Any\` problem again.
    """
    obj: Any = text
    if isinstance(text, str) and text[:1] in ("{", "["):
        try:
            obj = json.loads(text)
        except ValueError:
            obj = text
    cls = _TYPES.get(expect or "")
    if cls is not None and isinstance(obj, dict):
        try:
            return cls.from_payload(obj)
        except (TypeError, ValueError):
            return ToolResult(raw=obj)
    return ToolResult(raw=obj)
`;
	return head + "\n\n" + body + registry;
}

/** A schema this compiler can type: a closed object, or an anyOf of them. */
function isTypedSchema(schema) {
	if (!schema || typeof schema !== "object") return false;
	if (schema.type === "object") return true;
	return Array.isArray(schema.anyOf) && schema.anyOf.length > 0 && schema.anyOf.every((v) => v && v.type === "object");
}

/** The tools in `tools` that publish no usable outputSchema. */
export function untypedTools(tools) {
	return tools.filter((t) => !isTypedSchema(t.outputSchema)).map((t) => t.name);
}
