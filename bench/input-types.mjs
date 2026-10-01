/**
 * Typed parameters: a dataclass for every structured argument, compiled from the
 * tool's inputSchema — the input half of bench/output-types.mjs.
 *
 * Without it a parameter whose schema is an object with properties rendered as
 * `manifest: dict`, and the only description of what that dict must hold was the
 * docstring example. The agent built it by hand, key by key, and learned about a
 * missing or misspelled key from the validator's error after the call — the same
 * "run it and read the error" loop typed returns removed on the output side. With
 * typed inputs the signature says `manifest: PluginManifest`, `help(PluginManifest)`
 * lists every field, a misspelled field is a TypeError at construction, and the
 * wrapper refuses a plain dict where a class is declared.
 *
 * What becomes a class: an object with properties, at any depth (directly, as array
 * items, as map values). Scalars, enums (`Literal[...]`), arrays of scalars and maps
 * of scalars keep their existing hints. The wire names are kept in each class's
 * `_WIRE` table, so a key that is not a Python identifier (`$file`, `from`) still
 * round-trips.
 *
 * Opt-in (`generate(..., { typedInputs: true })`) and requires typed returns (the
 * classes live in `_types.py`). Off, every tree is byte-identical to before.
 */

const PY_SCALARS = { string: "str", integer: "int", number: "float", boolean: "bool", null: "None" };

const PY_RESERVED = new Set([
	"False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
	"else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or",
	"pass", "raise", "return", "try", "while", "with", "yield",
]);

const isIdent = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
const pascal = (s) =>
	String(s)
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join("") || "Input";

export const fieldIdent = (name) => (isIdent(name) && !PY_RESERVED.has(name) ? name : `${name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1")}_`);

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

const pyLiteral = (v) => (typeof v === "string" ? JSON.stringify(v) : typeof v === "number" ? String(v) : v === true ? "True" : v === false ? "False" : null);

/** True when a schema node (or something inside it) will become an input class. */
export function needsInputClass(node) {
	if (!node || typeof node !== "object") return false;
	if (node.$ref) return true;
	const variants = node.anyOf ?? node.oneOf;
	if (Array.isArray(variants)) return variants.some(needsInputClass);
	const type = Array.isArray(node.type) ? node.type.find((t) => t !== "null") : node.type;
	if (type === "object") {
		if (node.properties && Object.keys(node.properties).length > 0) return true;
		return needsInputClass(node.additionalProperties);
	}
	if (type === "array") return needsInputClass(node.items);
	return false;
}

/**
 * Collect the input classes for every tool's parameters. Returns
 * `{ classes: Map<name, entry>, params: Map<"tool\0param", {py, check}> }`, where
 * `check` is how the wrapper verifies the argument: `{cls, how: "one"|"list"|"map"}`
 * or null when nothing needs checking.
 *
 * `taken` is the set of class names already used (the output classes), so an input
 * class that happens to share a name with an output class of a different shape is
 * renamed `<Name>Input` rather than shadowing it in the shared `_types.py`.
 */
export function collectInputTypes(tools, { taken = new Set() } = {}) {
	const classes = new Map();
	const params = new Map();
	for (const tool of tools) {
		const schema = tool.inputSchema ?? tool.schema ?? { type: "object", properties: {} };
		const defs = schema.$defs ?? schema.definitions ?? {};
		const toolName = pascal(tool.pyName ?? tool.name);
		for (const [pname, spec] of Object.entries(schema.properties ?? {})) {
			if (!needsInputClass(spec)) continue;
			const t = fieldType(spec, { name: typeof spec.title === "string" && isIdent(spec.title) ? spec.title : `${toolName}${pascal(pname)}`, defs, classes, taken });
			params.set(`${tool.name}\0${pname}`, { py: t.py, check: t.check });
		}
	}
	return { classes, params };
}

function fieldType(node, ctx) {
	const { name, defs } = ctx;
	if (!node || typeof node !== "object") return { py: "Any", check: null };
	const ref = typeof node.$ref === "string" && /^#\/(\$defs|definitions)\//.test(node.$ref) ? node.$ref.split("/").pop() : null;
	if (ref) {
		const target = defs[ref];
		if (!target) return { py: "Any", check: null };
		return fieldType({ ...target, title: target.title ?? ref }, { ...ctx, name: target.title ?? ref });
	}
	const variants = node.anyOf ?? node.oneOf;
	if (Array.isArray(variants) && variants.length > 0) {
		const nonNull = variants.filter((v) => !(v && v.type === "null"));
		const parts = nonNull.map((v, i) => fieldType(v, { ...ctx, name: nonNull.length > 1 ? `${name}${i + 1}` : name }));
		const py = [...new Set(parts.map((p) => p.py))].join(" | ") || "Any";
		const nullable = variants.length !== nonNull.length;
		return { py: nullable ? `${py} | None` : py, check: parts.length === 1 ? parts[0].check : null, nullable };
	}
	if (Array.isArray(node.type)) {
		const nonNull = node.type.filter((t) => t !== "null");
		if (nonNull.length === 1) {
			const inner = fieldType({ ...node, type: nonNull[0] }, ctx);
			return node.type.includes("null") ? { ...inner, py: `${inner.py} | None`, nullable: true } : inner;
		}
		return { py: nonNull.map((t) => PY_SCALARS[t] ?? "Any").join(" | ") || "Any", check: null };
	}
	if (Array.isArray(node.enum) && node.enum.length > 0) {
		const members = node.enum.map(pyLiteral);
		if (members.every((m) => m !== null)) return { py: `Literal[${members.join(", ")}]`, check: null };
	}
	if (node.type === "array") {
		const item = fieldType(node.items, { ...ctx, name: `${name}Item` });
		return { py: `list[${item.py}]`, check: item.check?.how === "one" ? { cls: item.check.cls, how: "list" } : null };
	}
	if (node.type === "object") {
		if (node.properties && Object.keys(node.properties).length > 0) {
			const cls = ensureClass(typeof node.title === "string" && isIdent(node.title) ? node.title : name, node, ctx);
			return { py: cls, check: { cls, how: "one" } };
		}
		if (node.additionalProperties && typeof node.additionalProperties === "object") {
			const val = fieldType(node.additionalProperties, { ...ctx, name: `${name}Value` });
			return { py: `dict[str, ${val.py}]`, check: val.check?.how === "one" ? { cls: val.check.cls, how: "map" } : null };
		}
		return { py: "dict[str, Any]", check: null };
	}
	return { py: PY_SCALARS[node.type] ?? "Any", check: null };
}

function ensureClass(wanted, node, ctx) {
	const { classes, taken } = ctx;
	const key = canonical({ ...node, title: undefined, description: undefined });
	let cls = isIdent(wanted) ? wanted : pascal(wanted);
	// An output class by the same name lives in the same module; never shadow it.
	if (taken.has(cls)) cls = `${cls}Input`;
	// Same name, different shape: number the later one rather than merging two records.
	for (let n = 2; classes.has(cls) && classes.get(cls).key !== key; n++) cls = `${cls.replace(/\d+$/, "")}${n}`;
	if (classes.has(cls)) return cls;
	const entry = { name: cls, key, description: (node.description ?? "").trim(), fields: [] };
	classes.set(cls, entry);
	const required = new Set(node.required ?? []);
	const seen = new Map();
	for (const [fname, fnode] of Object.entries(node.properties ?? {})) {
		const t = fieldType(fnode, { ...ctx, name: `${cls}${pascal(fname)}` });
		let pyName = fieldIdent(fname);
		const n = seen.get(pyName) ?? 0;
		seen.set(pyName, n + 1);
		if (n > 0) pyName = `${pyName}_${n + 1}`;
		entry.fields.push({
			name: fname,
			pyName,
			required: required.has(fname),
			py: t.py,
			description: ((fnode && fnode.description) || "").trim(),
			default: fnode && typeof fnode === "object" && "default" in fnode ? fnode.default : undefined,
		});
	}
	return cls;
}

const doc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');

function renderClass(entry) {
	const lines = ["", "", "@dataclass(frozen=True, kw_only=True)", `class ${entry.name}(ToolInput):`];
	const head = entry.description || `Argument record ${entry.name}.`;
	lines.push(`    """${doc(head.split("\n")[0])}`);
	const rest = head.split("\n").slice(1).join("\n").trim();
	if (rest) lines.push("", ...rest.split("\n").map((l) => `    ${doc(l)}`));
	if (entry.fields.length > 0) {
		lines.push("", "    Fields:");
		for (const f of entry.fields) {
			const note = f.description ? ` ${doc(f.description.replace(/\s+/g, " "))}` : "";
			const opt = f.required ? "" : " Optional.";
			const dflt = f.default !== undefined ? ` Server default: ${doc(JSON.stringify(f.default))}.` : "";
			lines.push(`        ${f.pyName}:${note}${opt}${dflt}`.trimEnd());
		}
	}
	lines.push('    """', "");
	// kw_only: required and optional fields may interleave in schema order.
	for (const f of entry.fields) {
		lines.push(f.required ? `    ${f.pyName}: ${f.py}` : `    ${f.pyName}: ${f.py.endsWith("| None") ? f.py : `${f.py} | None`} = None`);
	}
	if (entry.fields.length === 0) lines.push("    pass");
	lines.push("", `    _WIRE = (${entry.fields.map((f) => `(${JSON.stringify(f.name)}, ${JSON.stringify(f.pyName)})`).join(", ")}${entry.fields.length === 1 ? "," : ""})`);
	return lines;
}

/** The input half of `_types.py`: the base, the helpers `_client` and the wrappers use, every class. */
export function renderInputTypes({ classes }) {
	const lines = [
		"",
		"",
		"# ---- Typed arguments. Generated from each tool's inputSchema — do not edit. ----",
		"#",
		"# A structured parameter takes one of these classes, never a dict: construct it",
		"# with keywords (`PluginManifest(id=..., app=AppRef(bundle_id=...))`) and a",
		"# misspelled or missing field is an error before anything is sent.",
		"",
		"",
		"@dataclass(frozen=True, kw_only=True)",
		"class ToolInput:",
		'    """Base of every typed argument. `to_payload()` is the JSON the tool receives."""',
		"",
		"    _WIRE: tuple = ()",
		"",
		"    def to_payload(self) -> dict:",
		"        out = {}",
		"        for wire, name in type(self)._WIRE:",
		"            value = getattr(self, name)",
		"            if value is not None:",
		"                out[wire] = to_payload(value)",
		"        return out",
		"",
		"",
		"def to_payload(value: Any) -> Any:",
		'    """A typed argument (or a list / dict holding them) as the JSON a tool receives."""',
		"    if isinstance(value, ToolInput):",
		"        return value.to_payload()",
		"    if isinstance(value, (list, tuple)):",
		"        return [to_payload(v) for v in value]",
		"    if isinstance(value, dict):",
		"        return {k: to_payload(v) for k, v in value.items()}",
		"    return value",
		"",
		"",
		"def require_input(value: Any, cls: type, param: str, how: str = \"one\") -> Any:",
		'    """The wrapper\'s check that a structured argument is the declared class."""',
		"    # Not passed: None, or _client's UNSET (by class: _client imports this module).",
		"    if value is None or type(value).__name__ == \"_Unset\":",
		"        return value",
		"    def bad(got: Any) -> TypeError:",
		"        return TypeError(",
		'            f"{param} takes {cls.__name__}, not {type(got).__name__}: "',
		'            f"build it with {cls.__name__}(...); help({cls.__name__}) lists its fields"',
		"        )",
		"    if how == \"one\":",
		"        if not isinstance(value, cls):",
		"            raise bad(value)",
		"    elif how == \"list\":",
		"        if not isinstance(value, (list, tuple)):",
		'            raise TypeError(f"{param} takes a list of {cls.__name__}, not {type(value).__name__}")',
		"        for v in value:",
		"            if not isinstance(v, cls):",
		"                raise bad(v)",
		"    elif how == \"map\":",
		"        if not isinstance(value, dict):",
		'            raise TypeError(f"{param} takes a dict of str to {cls.__name__}, not {type(value).__name__}")',
		"        for v in value.values():",
		"            if not isinstance(v, cls):",
		"                raise bad(v)",
		"    return value",
	];
	for (const entry of classes.values()) lines.push(...renderClass(entry));
	lines.push("");
	return lines.join("\n");
}
