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
 *  - a union (`anyOf`/`oneOf` of records, arms `$ref`s into the root `$defs`,
 *    possibly nesting further unions) flattens into one list of variant classes,
 *    and a `discriminator` mapping or a `const` key narrows which arm a payload is;
 *  - a string whose `format` is the catalogue's asset-ref format, or whose kind
 *    annotation (`refKinds`) names an asset kind, IS an asset ref. A class whose fields
 *    carry asset refs gets `.ids`, `.id`, `__str__` (the id), `__iter__` and
 *    `__len__`, which is what lets a result be passed straight back;
 *  - a string with `contentEncoding: "base64"` (or `format: "byte"` / `"binary"`) is
 *    bytes on the wire: its class gets a `<field>_bytes` property that decodes it
 *    (`data_b64` -> `data_bytes`), plus `.bytes` when it is the class's only such
 *    field, and a `__str__` / `__repr__` that print its size rather than its text;
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
 *
 * A catalogue that names kinds in an annotation instead (`{format: "product-ref",
 * "x-ref-kinds": ["artifact"]}`) passes `refKinds: { key, kinds }`, mapping each
 * kind word to a category; a node carrying the key is read by its kinds, not its format.
 */
export const DEFAULT_REF_FORMATS = Object.freeze({ asset: "asset-ref", shape: "shape-ref", job: "job-ref" });

const formatTable = (formats) =>
	new Map(Object.entries({ ...DEFAULT_REF_FORMATS, ...formats }).filter(([, format]) => format).map(([kind, format]) => [format, kind]));

// Scoped to one collectOutputTypes() call; see there.
let refPolicy = { formats: formatTable({}), kindsKey: null, kinds: new Map() };

// A field whose kind words map to several categories is treated as the first here:
// a field that may hold an asset id is passable wherever one is expected.
const REF_CATEGORY_ORDER = ["asset", "shape", "job"];

/** The ref category ("asset" | "shape" | "job" | null) a string schema node carries. */
function refCategory(node) {
	const words = refPolicy.kindsKey ? node[refPolicy.kindsKey] : undefined;
	if (Array.isArray(words)) {
		const found = new Set(words.map((w) => refPolicy.kinds.get(w)).filter(Boolean));
		return REF_CATEGORY_ORDER.find((c) => found.has(c)) ?? null;
	}
	return refPolicy.formats.get(node.format) ?? null;
}

/**
 * How a string schema node encodes bytes, or null when it holds text.
 *
 * JSON Schema says it with `contentEncoding`; OpenAPI says it with `format: "byte"`
 * (base64) or `format: "binary"`, which a JSON payload can only carry as base64 too.
 */
function binaryEncoding(node) {
	const encoding = typeof node?.contentEncoding === "string" ? node.contentEncoding.toLowerCase() : null;
	if (encoding === "base64" || encoding === "base64url") return encoding;
	if (node?.format === "byte" || node?.format === "binary") return "base64";
	return null;
}

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
		const cls = isUnionNode(target) ? ensureUnion(dn, target, { defs, classes, prefix }) : ensureClass(dn, target, { defs, classes, prefix });
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
		// pydantic puts a field's extra keywords beside the `anyOf`, not inside the arm.
		const binary = parts.length === 1 && parts[0].py === "str" ? (binaryEncoding(node) ?? parts[0].binary) : null;
		return { py: nullable ? `${py} | None` : py, ref, cls, binary, listOf: parts.length === 1 ? parts[0].listOf : undefined, mapOf: parts.length === 1 ? parts[0].mapOf : undefined };
	}
	if (Array.isArray(node.type)) {
		const nonNull = node.type.filter((t) => t !== "null");
		const parts = nonNull.map((t) => fieldType({ ...node, type: t }, { name, defs, classes, prefix }));
		const py = [...new Set(parts.map((p) => p.py))].join(" | ") || "Any";
		return { py: node.type.includes("null") ? `${py} | None` : py, ref: parts.find((p) => p.ref)?.ref ?? null, cls: null, binary: parts.length === 1 ? parts[0].binary : null };
	}
	if (node.type === "string") {
		const ref = refCategory(node);
		if (Array.isArray(node.enum) && node.enum.every((e) => typeof e === "string")) {
			return { py: `Literal[${node.enum.map((e) => JSON.stringify(e)).join(", ")}]`, ref, cls: null };
		}
		return { py: "str", ref, cls: null, binary: binaryEncoding(node) };
	}
	if (node.type === "array") {
		const item = fieldType(node.items, { name: `${name}Item`, defs, classes, prefix });
		return { py: `list[${item.py}]`, ref: item.ref, cls: null, listOf: item };
	}
	if (node.type === "object") {
		if (node.properties && Object.keys(node.properties).length > 0) {
			// schemaTitles: a nested record the schema titled (`Mac`) is that class, not
			// a path-derived one (`MacsMacsItem`). Off by default: typed trees already
			// measured keep their class names.
			const titled = useSchemaTitles && typeof node.title === "string" && isIdent(node.title) && node.title !== UNTYPED_RESULT;
			const cls = ensureClass(titled ? node.title : name, node, { defs, classes, prefix });
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
	cls = claimName(cls, key, classes, `${prefix}${cls}`);
	if (classes.has(cls)) return cls;
	// Reserve before recursing so a self-referential schema terminates.
	const entry = { name: cls, key, node, fields: [], description: node.description ?? "" };
	classes.set(cls, entry);
	const required = new Set(node.required ?? []);
	const taken = new Set();
	for (const [fname, fnode] of Object.entries(node.properties ?? {})) {
		const t = fieldType(fnode, { name: `${cls}${pascal(fname)}`, defs, classes, prefix: cls });
		entry.fields.push({
			name: fname,
			pyName: fieldPyName(fname, taken),
			required: required.has(fname),
			py: t.py,
			ref: t.ref,
			cls: t.cls,
			listOf: t.listOf,
			mapOf: t.mapOf,
			binary: t.binary ?? null,
			description: (fnode && fnode.description) || "",
		});
	}
	return cls;
}

/** `cls` if free or already this shape, else `alt`, numbered until one is. */
function claimName(cls, key, classes, alt) {
	const existing = classes.get(cls);
	if (!existing || existing.key === key) return cls;
	let name = alt;
	for (let n = 2; classes.has(name) && classes.get(name).key !== key; n++) name = `${alt}${n}`;
	return name;
}

/**
 * The attribute a payload key becomes. Leading underscores are stripped: inside a
 * class body `__x` is name-mangled and `_x` reads as private, and the product
 * publishes `_external_content_notice` on every external result. A name that is
 * not an identifier as-is, or is reserved, gets a trailing `_`; so does one another
 * field of the same class already took.
 */
function fieldPyName(fname, taken) {
	const stripped = String(fname).replace(/^_+/, "");
	let py = stripped.replace(/[^A-Za-z0-9_]/g, "_");
	if (!py || /^[0-9]/.test(py)) py = `f_${py}`;
	if (py !== stripped || PY_RESERVED.has(py)) py = `${py}_`;
	while (taken.has(py) || PY_RESERVED.has(py)) py = `${py}_`;
	taken.add(py);
	return py;
}

const hasProperties = (node) => !!node.properties && Object.keys(node.properties).length > 0;

/** A union node: an `anyOf`/`oneOf` that is not itself a record with fields. */
const isUnionNode = (node) => !!node && typeof node === "object" && !hasProperties(node) && Array.isArray(node.anyOf ?? node.oneOf) && (node.anyOf ?? node.oneOf).length > 0;

/** A discriminator's mapping as `{ prop, byDef: Map<defName, values[]> }`, or null. */
function discriminatorOf(node) {
	const d = node.discriminator;
	if (!d || typeof d.propertyName !== "string" || !d.mapping || typeof d.mapping !== "object") return null;
	const byDef = new Map();
	for (const [value, ref] of Object.entries(d.mapping)) {
		const dn = refName(ref);
		if (dn) byDef.set(dn, [...(byDef.get(dn) ?? []), value]);
	}
	return { prop: d.propertyName, byDef };
}

/**
 * Every record arm under a union node, nested unions flattened, in declaration
 * order: `{ cls, node, tags }`, where `tags` holds the values an enclosing
 * discriminator mapping assigns to the arm (`Map<prop, values[]>`).
 */
function unionArms(node, ctx, out = [], tags = new Map()) {
	if (!node || typeof node !== "object" || node.type === "null") return out;
	const dn = refName(node.$ref);
	if (dn) {
		const target = ctx.defs[dn];
		if (!target) return out;
		if (isUnionNode(target)) return unionArms(target, ctx, out, tags);
		const title = isIdent(target.title) && target.title !== UNTYPED_RESULT ? target.title : dn;
		out.push({ cls: ensureClass(title, target, ctx), node: target, tags });
		return out;
	}
	if (isUnionNode(node)) {
		const disc = discriminatorOf(node);
		for (const branch of node.anyOf ?? node.oneOf) {
			const bn = refName(branch?.$ref);
			const sub = disc && bn && disc.byDef.has(bn) ? new Map([...tags, [disc.prop, disc.byDef.get(bn)]]) : tags;
			unionArms(branch, ctx, out, sub);
		}
		return out;
	}
	// An inline record arm (older catalogues): its own $defs, named by its title.
	const vdefs = node.$defs ?? node.definitions ?? ctx.defs;
	const vname = isIdent(node.title) ? node.title : `${ctx.prefix}Variant${out.length + 1}`;
	out.push({ cls: ensureClass(vname, node, { defs: vdefs, classes: ctx.classes, prefix: vname }), node, tags });
	return out;
}

/** Per arm, the values each constrained key may take: discriminator tags, then `const`s. */
function armConstraints(arm) {
	const allowed = new Map(arm.tags);
	for (const [k, p] of Object.entries(arm.node.properties ?? {})) {
		if (allowed.has(k) || !p || typeof p !== "object") continue;
		if ("const" in p) allowed.set(k, [p.const]);
		else if (Array.isArray(p.enum) && p.enum.length === 1) allowed.set(k, [p.enum[0]]);
	}
	return allowed;
}

/**
 * The `(class, constraints)` pairs a union dispatches on. An arm reached twice keeps
 * only the keys both paths constrain, values merged. A key every arm constrains to
 * the same values (the external-content notice) tells no arm apart and is dropped.
 */
function unionMatch(arms) {
	const byCls = new Map();
	for (const arm of arms) {
		const allowed = armConstraints(arm);
		const seen = byCls.get(arm.cls);
		if (!seen) {
			byCls.set(arm.cls, allowed);
			continue;
		}
		for (const k of [...seen.keys()]) {
			if (allowed.has(k)) seen.set(k, [...new Set([...seen.get(k), ...allowed.get(k)])]);
			else seen.delete(k);
		}
	}
	const all = [...byCls.values()];
	const keys = new Set(all.flatMap((m) => [...m.keys()]));
	for (const k of keys) {
		const sig = (m) => (m.has(k) ? canonical([...m.get(k)].sort()) : null);
		if (all.every((m) => sig(m) !== null && sig(m) === sig(all[0]))) all.forEach((m) => m.delete(k));
	}
	return [...byCls].filter(([, m]) => m.size > 0).map(([cls, m]) => [cls, [...m]]);
}

/**
 * Register (once) the class for a union node and return its name. `reserve` claims
 * the name before the arms are built, so a union reached again through one of its
 * own arms' fields terminates; a tool's root union does not, so an arm titled like
 * the tool keeps its name and the union takes `...Union`.
 */
function ensureUnion(name, node, { defs, classes, prefix }, { reserve = true } = {}) {
	const want = isIdent(name) ? name : pascal(name);
	const key = canonical({ ...node, title: undefined, description: undefined });
	if (classes.get(want)?.key === key) return want;
	const entry = { name: want, key, node, fields: [], description: node.description ?? "", union: [], match: [] };
	const reserved = reserve && !classes.has(want);
	if (reserved) classes.set(want, entry);
	const arms = unionArms(node, { defs, classes, prefix: want });
	if (!reserved) {
		entry.name = claimName(want, key, classes, reserve ? `${prefix}${want}` : `${want}Union`);
		if (classes.get(entry.name)?.key === key) return entry.name;
		classes.set(entry.name, entry);
	}
	entry.union = [...new Set(arms.map((a) => a.cls))];
	entry.match = unionMatch(arms);
	return entry.name;
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
let useSchemaTitles = false;

export function collectOutputTypes(tools, { refFormats = DEFAULT_REF_FORMATS, refKinds = null, schemaTitles = false } = {}) {
	const previous = refPolicy;
	const previousTitles = useSchemaTitles;
	refPolicy = {
		formats: formatTable(refFormats),
		kindsKey: refKinds?.key ?? null,
		kinds: new Map(Object.entries(refKinds?.kinds ?? {}).filter(([, category]) => category)),
	};
	useSchemaTitles = schemaTitles;
	try {
		return collectOutputTypesWith(tools);
	} finally {
		refPolicy = previous;
		useSchemaTitles = previousTitles;
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
		if (isUnionNode(schema)) {
			// A union of closed records — checked before the plain-object branch, since a
			// published union root also says `type: object`. Each arm is its own class;
			// the union class dispatches on which arm accepts the payload.
			const defs = schema.$defs ?? schema.definitions ?? {};
			const uname = ensureUnion(want, schema, { defs, classes, prefix: want }, { reserve: false });
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

/**
 * The base64 fields of a class, each with the accessor that decodes it:
 * `<field>_bytes`, with a trailing `_b64` / `_base64` dropped from the field name
 * (`data_b64` -> `data_bytes`). A class with exactly one such field also gets
 * `.bytes`, its payload. An accessor whose name a payload field already holds is
 * not rendered.
 */
function binaryFields(entry) {
	const fields = entry.fields.filter((f) => f.binary && !f.listOf && !f.mapOf);
	const taken = new Set([...entry.fields.map((f) => f.pyName), ...BASE_ATTRS]);
	const out = fields.map((f) => {
		const stem = f.pyName.replace(/_(b64|base64)$/, "");
		const accessor = `${stem || f.pyName}_bytes`;
		return { field: f, accessor: taken.has(accessor) ? null : accessor };
	});
	const payload = out.length === 1 && !taken.has("bytes") ? out[0] : null;
	return { fields: out, payload };
}

/** The job-ref fields of a class: what `wait_for(result)` waits on when it carries no asset. */
function jobFields(entry) {
	return entry.fields.filter((f) => f.ref === "job" && (f.listOf || f.mapOf || f.py.startsWith("str")));
}

const pyStr = (s) => JSON.stringify(String(s));

const pyLiteral = (v) => (v === null ? "None" : v === true ? "True" : v === false ? "False" : JSON.stringify(v));

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
function renderClass(entry, later, extension = null) {
	if (entry.union) return renderUnionClass(entry, later);
	const { scalar, many } = assetFields(entry);
	const binary = binaryFields(entry);
	const req = entry.fields.filter((f) => f.required);
	const opt = entry.fields.filter((f) => !f.required);
	const lines = ["@dataclass(frozen=True, kw_only=True, repr=False)", `class ${entry.name}(ToolResult):`];
	const doc = [entry.description || `The result of a tool returning \`${entry.name}\`.`];
	// Field docs, compact: the annotations below already carry name and type, so a
	// field is documented here only when the schema SAYS something about it (a
	// description or a ref kind). The model reads this file whole during discovery
	// (h64: 300k tokens on one job); every repeated line is paid on every turn.
	const decodedAs = new Map(binary.fields.map(({ field, accessor }) => [field, accessor ?? (binary.payload?.field === field ? "bytes" : null)]));
	const documented = entry.fields.filter((f) => f.description || f.ref || decodedAs.has(f));
	if (documented.length) {
		doc.push("");
		for (const f of documented) {
			const decoded = decodedAs.get(f);
			const kind = f.ref ? `[${f.ref} ref] ` : decodedAs.has(f) ? `[${f.binary}${decoded ? `; decoded as .${decoded}` : ""}] ` : "";
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
	const nestedOf = (f) => f.cls ?? f.listOf?.cls ?? f.mapOf?.cls ?? null;
	const spec = entry.fields.map((f) => {
		const nested = nestedOf(f);
		const how = f.listOf ? "list" : f.mapOf ? "map" : "one";
		return `(${pyStr(f.name)}, ${pyStr(f.pyName)}, ${nested ?? "None"}, ${pyStr(how)})`;
	});
	if (spec.length) {
		lines.push("", later.place(entry.name, "_SPEC", `(${spec.join(", ")},)`, entry.fields.map(nestedOf)));
		lines.push(`    _REQUIRED = frozenset(${JSON.stringify(req.map((f) => f.name)).replace(/"/g, "'")})`);
	}
	const assetSpec = [...many, ...scalar].map((f) => `(${pyStr(f.pyName)}, ${pyStr(f.mapOf ? "map" : f.listOf ? "list" : "one")})`);
	if (assetSpec.length) lines.push(`    _ASSET_FIELDS = (${assetSpec.join(", ")},)`);
	const jobSpec = jobFields(entry).map((f) => `(${pyStr(f.pyName)}, ${pyStr(f.mapOf ? "map" : f.listOf ? "list" : "one")})`);
	if (jobSpec.length) lines.push(`    _JOB_FIELDS = (${jobSpec.join(", ")},)`);
	// Only a class whose PURPOSE is producing assets stringifies to the id. A read
	// result carries an asset_id too, and `print(read_result)` printing eight
	// characters instead of the record cost three cells per trace (h64, pos 3, 12).
	const plainStr = binary.fields.length ? "_str_without_binary(self)" : "super().__str__()";
	if (many.length) {
		lines.push("", "    def __str__(self) -> str:", "        refs = self._asset_refs()", `        return refs[0] if refs else ${plainStr}`, "", "    def __iter__(self):", "        return iter(Asset(id=i) for i in self._asset_refs())", "", "    def __len__(self) -> int:", "        return len(self._asset_refs())");
	}
	const flag = entry.fields.find((f) => f.py === "bool" && ["completed", "success", "ok", "done"].includes(f.name));
	if (flag) lines.push("", "    def __bool__(self) -> bool:", `        return bool(self.${flag.pyName})`);
	if (binary.fields.length) lines.push(...renderBinaryMembers(binary, { hasStr: many.length > 0 }));
	if (extension) lines.push("", ...extensionLines(extension));
	return lines.join("\n");
}

/**
 * The decoded accessors of a class with base64 fields, and a `__str__` / `__repr__`
 * that show each such field's size instead of its text: the inherited ones would
 * print the whole payload, and everything printed is re-read on every later turn.
 */
function renderBinaryMembers({ fields, payload }, { hasStr }) {
	const lines = ["", `    _BINARY_FIELDS = (${fields.map(({ field }) => `(${pyStr(field.name)}, ${pyStr(field.pyName)}, ${pyStr(field.binary)})`).join(", ")},)`];
	for (const { field, accessor } of fields) {
		if (!accessor) continue;
		lines.push("", "    @property", `    def ${accessor}(self) -> bytes | None:`, `        """\`${field.pyName}\`, decoded from ${field.binary}. None when the payload has none."""`, `        return _decode_binary(self.${field.pyName}, ${pyStr(field.binary)})`);
	}
	if (payload) {
		const read = payload.accessor ? `self.${payload.accessor}` : `_decode_binary(self.${payload.field.pyName}, ${pyStr(payload.field.binary)})`;
		lines.push("", "    @property", "    def bytes(self) -> bytes | None:", `        """The payload's bytes: \`${payload.field.pyName}\`, decoded."""`, `        return ${read}`);
	}
	if (!hasStr) lines.push("", "    def __str__(self) -> str:", "        return _str_without_binary(self)");
	lines.push("", "    def __repr__(self) -> str:", "        return _repr_without_binary(self)");
	return lines;
}

/** A class extension's members, as class-body lines. Written unindented by the caller. */
function extensionLines(extension) {
	const text = Array.isArray(extension) ? extension.join("\n") : String(extension);
	return text
		.replace(/^\n+|\s+$/g, "")
		.split("\n")
		.map((l) => (l.trim() ? `    ${l}` : ""));
}

/**
 * Class attributes naming other classes, placed in the class body when those are
 * already defined and after every class otherwise: a recursive record (a comment
 * whose `replies` are comments) names itself, and a class body cannot.
 */
function deferredAttrs() {
	const defined = new Set();
	const trailer = [];
	let current = null;
	const api = {
		defining(name) {
			if (current) defined.add(current);
			current = name;
			return api;
		},
		place(owner, attr, value, names) {
			if (names.every((n) => !n || defined.has(n))) return `    ${attr} = ${value}`;
			trailer.push(`${owner}.${attr} = ${value}`);
			return `    # ${attr}: set below, once every class it names exists.`;
		},
		render: () => (trailer.length ? `\n\n\n${trailer.join("\n")}` : ""),
	};
	return api;
}

/**
 * A union: the class a multi-arm tool is annotated with. `from_payload` returns
 * the variant whose key set matches (required keys present, no unknown keys);
 * an instance of the union class itself is never constructed.
 */
function renderUnionClass(entry, later) {
	const lines = ["@dataclass(frozen=True, kw_only=True, repr=False)", `class ${entry.name}(ToolResult):`];
	const doc = [entry.description || `One of: ${entry.union.join(", ")}.`, "", `Variants: ${entry.union.join(", ")}. The value you get IS one of those classes —`, "check with isinstance or look at its fields; each variant lists its own."];
	lines.push('    """' + doc[0]);
	lines.push(...docLines(doc.slice(1).join("\n"), "    "));
	lines.push('    """', "");
	lines.push(later.place(entry.name, "_VARIANTS", `(${entry.union.join(", ")},)`, entry.union));
	// Per arm, the values its discriminator / const keys may take: an arm whose key
	// the payload carries with another value is not that payload's arm.
	if (entry.match?.length) {
		const armMatch = ([cls, pairs]) => `${cls}: {${pairs.map(([k, vals]) => `${pyStr(k)}: (${vals.map(pyLiteral).join(", ")},)`).join(", ")}}`;
		lines.push(later.place(entry.name, "_MATCH", `{${entry.match.map(armMatch).join(", ")}}`, entry.match.map(([cls]) => cls)));
	}
	lines.push("", "    @classmethod", "    def from_payload(cls, obj):", "        if not isinstance(obj, dict):", "            return ToolResult(raw=obj)", "        keys = set(obj)", "        match = getattr(cls, \"_MATCH\", {})", "        best, best_score = None, None", "        for v in cls._VARIANTS:", "            declared = {k for k, _f, _c, _h in v._SPEC}", "            if not v._REQUIRED <= keys:", "                continue", "            if any(k in obj and obj[k] not in vals for k, vals in match.get(v, {}).items()):", "                continue", "            unknown = len(keys - declared)", "            score = (unknown, -len(keys & declared))", "            if best_score is None or score < best_score:", "                best, best_score = v, score", "        return best.from_payload(obj) if best is not None else ToolResult(raw=obj)");
	return lines.join("\n");
}

/**
 * `_types.py`: the base classes, every generated class, the registry `wrap`
 * dispatches on, and the argument coercion `_client` applies before a call.
 */
/** Module helpers for classes with base64 fields; rendered only when one exists. */
const BINARY_HELPERS = `

def _decode_binary(value: str | None, encoding: str) -> bytes | None:
    if value is None:
        return None
    if encoding == "base64url":
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    return base64.b64decode(value)


def _binary_size(value: str) -> str:
    return f"<{len(value.rstrip('=')) * 3 // 4} bytes>"


def _repr_without_binary(result: ToolResult) -> str:
    binary = {f for _k, f, _e in type(result)._BINARY_FIELDS}
    shown = []
    for _k, f, _c, _how in type(result)._SPEC:
        v = getattr(result, f, None)
        if v is not None:
            shown.append(f"{f}={_binary_size(v)}" if f in binary and isinstance(v, str) else f"{f}={v!r}")
    return f"{type(result).__name__}({', '.join(shown)})"


def _str_without_binary(result: ToolResult) -> str:
    raw = result.raw
    if isinstance(raw, dict):
        keys = {k for k, _f, _e in type(result)._BINARY_FIELDS}
        raw = {k: _binary_size(v) if k in keys and isinstance(v, str) else v for k, v in raw.items()}
    return raw if isinstance(raw, str) else json.dumps(raw, default=str)
`;

/** The docstring's worked example when the caller names none: shape, not product. */
export const DEFAULT_TYPES_EXAMPLE = Object.freeze([
	"first = await api.<module>.<tool_that_makes_something>(...)",
	"await api.<module>.<tool_that_takes_it>(..., references=[first])",
]);

export function renderOutputTypes({ classes }, { example = null, resultCall = "result", extensions = null } = {}) {
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
	const hasBinary = generated.some((c) => binaryFields(c).fields.length > 0);
	const head = `"""Typed results for this API. Generated from each tool's outputSchema — do not edit.

Every API function returns an instance of one of these classes instead of the
server's JSON text. Dict-style access still works (\`result["assets"]\`), the
typed fields are attributes (\`result.assets\`), and a result that carries asset
refs can be passed straight back wherever an asset id is expected:

${exampleLines}

\`.raw\` is the whole payload as the server sent it, so nothing is lost.
"""

from __future__ import annotations

${hasBinary ? "import base64\n" : ""}import json
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
    # Fields carrying job refs, same shape: what wait_for waits on when no asset is here.
    _JOB_FIELDS: tuple = ()

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
        return self._refs(type(self)._ASSET_FIELDS)

    def _job_refs(self) -> list[str]:
        return self._refs(type(self)._JOB_FIELDS)

    def _refs(self, fields: tuple) -> list[str]:
        out: list = []
        for f, how in fields:
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
${hasBinary ? BINARY_HELPERS : ""}`;
	const later = deferredAttrs();
	const body = generated.map((c) => renderClass(c, later.defining(c.name), extensions?.[c.name] ?? null)).join("\n\n\n") + later.render();
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

/** A schema this compiler can type: a closed object, or a union of them. */
function isTypedSchema(schema) {
	if (!schema || typeof schema !== "object") return false;
	if (schema.type === "object") return true;
	return isUnionNode(schema) && (schema.anyOf ?? schema.oneOf).every((v) => v && (v.type === "object" || typeof v.$ref === "string" || isUnionNode(v)));
}

/** The tools in `tools` that publish no usable outputSchema. */
export function untypedTools(tools) {
	return tools.filter((t) => !isTypedSchema(t.outputSchema)).map((t) => t.name);
}
