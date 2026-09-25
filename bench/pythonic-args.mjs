/**
 * Pythonic argument shapes for the compiled API bridge.
 *
 * Two jobs, both aimed at one measured failure class: the model can write a flat
 * argument correctly and cannot reliably hand-build a nested literal.
 *
 * Measured, GLM 5.2 on the product port (Decomposed bank, n=5): **12 of 83 cells
 * ended in a client-side `ArgumentError`, and every one of them was a nested
 * construction** — `judge_tool(assets=[...])`, whose schema wants
 * `[{label, asset_id}]`, and `complete_job(final_outputs=[...])`, whose schema
 * wants `dict[str, list[str]]`. Zero flat arguments failed. The nesting is the
 * variable, not the model's care.
 *
 * So:
 *
 *   1. ADAPT what can be adapted deterministically. An array of `{label, id}`
 *      objects carries no information a bare id list does not, except the labels
 *      — and labels the caller did not choose can be generated. `list[str]` and
 *      `dict[label -> id]` are therefore accepted at the call site and coerced to
 *      the strict form before validation. The strict form still works unchanged.
 *
 *   2. SHOW an example for what cannot. `complete_job.final_outputs` buckets ids
 *      by asset type, and only the server knows an asset's type, so no
 *      client-side coercion is sound — inventing one would guess. What is
 *      available is a literal example of the right shape, and this file
 *      synthesizes one from the schema (preferring the schema author's own, mined
 *      out of the parameter description when there is one there). That example is
 *      then shown in three places: the INDEX one-liner the model demonstrably
 *      writes calls from, the parameter's docstring, and — the channel this
 *      project has measured to be the one that changes behaviour — the
 *      `ArgumentError` itself.
 *
 * Detection is schema-shape-driven throughout. Nothing here keys on a tool or
 * parameter name from any particular catalogue: a rule that fires on
 * `judge_tool` would be a fix for one server rather than a property of the
 * bridge, and the next catalogue would arrive with the same problem unfixed.
 */

/** `assets` -> `asset`. Used for generated labels and for naming example leaves. */
export function singular(name) {
	const text = String(name ?? "");
	if (/(us|is|ss)$/i.test(text)) return text; // status, analysis, address
	if (/ies$/i.test(text)) return `${text.slice(0, -3)}y`; // categories -> category
	// A naive trailing-`s` strip turns `email_addresses` into `email_addresse`,
	// which then reads as a typo in every example built on top of it.
	if (/(s|x|z|ch|sh)es$/i.test(text)) return text.slice(0, -2); // addresses -> address
	return /s$/i.test(text) && text.length > 2 ? text.slice(0, -1) : text;
}

/** A property name that holds an opaque identifier. */
export const isIdKey = (name) => /(^|_)(id|ids|uuid|uuids|guid|guids)$/i.test(String(name ?? ""));

/** A property name that holds a human-chosen handle for the thing beside it. */
export const isLabelKey = (name) => /(^|_)(label|labels|name|title|caption|tag|key)$/i.test(String(name ?? ""));

/** The schema's declared type, with a union's `null` branch dropped. */
function declaredType(schema) {
	if (!schema || typeof schema !== "object") return undefined;
	const type = schema.type;
	if (Array.isArray(type)) return type.find((t) => t !== "null");
	return type;
}

/** True when this parameter is a container — an array or an object. */
export function isNonScalar(schema) {
	const type = declaredType(schema);
	if (type === "array" || type === "object") return true;
	// A union or anyOf whose branches include a container: the value the model has
	// to write is still a nested literal in at least one legal shape.
	const variants = schema?.anyOf ?? schema?.oneOf;
	if (Array.isArray(variants)) return variants.some((v) => isNonScalar(v));
	return false;
}

/**
 * True when the value the model has to write is a container OF containers.
 *
 * The distinction from `isNonScalar` decides where an example is shown, and it is
 * the whole measured signal: `wait_for_assets(ids=['LmuewMxf'])` is an array and
 * never failed, while `[{label, asset_id}]` and `dict[str, list[str]]` failed 12
 * times in 83 cells. A `list[str]` needs no example and an INDEX line taxed with
 * one for every string list would stop being readable.
 */
export function isNestedShape(schema) {
	const type = declaredType(schema);
	if (type === "array") {
		const items = schema.items;
		if (!items || typeof items !== "object" || Array.isArray(items)) return false;
		const inner = declaredType(items);
		return inner === "object" || inner === "array";
	}
	if (type === "object") {
		const properties = schema.properties;
		if (properties && typeof properties === "object" && Object.keys(properties).length > 0) return true;
		const extra = schema.additionalProperties;
		return Boolean(extra && typeof extra === "object");
	}
	const variants = schema?.anyOf ?? schema?.oneOf;
	if (Array.isArray(variants)) return variants.some((v) => isNestedShape(v));
	return false;
}

/**
 * The T1 adapter: an array of two-field `{label, id}` objects, or null.
 *
 * The shape has to be recognised from the schema alone, and recognised
 * conservatively — a coercion that fires on a parameter it does not understand
 * would corrupt a call that was already correct, which is strictly worse than
 * the error it was meant to prevent. So all of the following are required:
 *
 *   - an array of objects with exactly two required properties,
 *   - both of them strings, one label-ish and one id-ish by name,
 *   - the label unconstrained beyond being a string, since a GENERATED label has
 *     to be legal. An `enum`, `const`, `pattern` or `format` on it means the
 *     caller's label carries information this file cannot invent, so it declines.
 *
 * Optional extra properties are fine: coercion omits them, which is exactly what
 * "optional" means. Extra REQUIRED properties are not, because the coerced object
 * would then be incomplete and the validator would reject a call the adapter
 * itself produced.
 */
export function labeledIdAdapter(schema, paramName) {
	if (declaredType(schema) !== "array") return null;
	const items = schema.items;
	if (!items || typeof items !== "object" || Array.isArray(items)) return null;
	if (declaredType(items) !== "object") return null;
	const properties = items.properties;
	if (!properties || typeof properties !== "object") return null;
	const required = Array.isArray(items.required) ? items.required : [];
	if (required.length !== 2) return null;

	const specs = required.map((key) => [key, properties[key]]);
	if (specs.some(([, spec]) => !spec || typeof spec !== "object" || declaredType(spec) !== "string")) return null;

	const labels = specs.filter(([key]) => isLabelKey(key));
	const ids = specs.filter(([key]) => isIdKey(key));
	if (labels.length !== 1 || ids.length !== 1) return null;
	const [labelKey, labelSpec] = labels[0];
	const [idKey] = ids[0];
	if (labelKey === idKey) return null;
	// A label this file would have to invent must be free to invent.
	for (const keyword of ["enum", "const", "pattern", "format", "minLength", "maxLength"]) {
		if (keyword in labelSpec) return null;
	}

	// `asset_id` -> `asset`, so generated labels read `asset_1`, `asset_2`. The
	// parameter name is the fallback (`assets` -> `asset`) and `item` the floor,
	// because a label of `_1` names nothing.
	const fromId = idKey.replace(/(^|_)(id|ids|uuid|uuids|guid|guids)$/i, "").replace(/_+$/, "");
	const stem = fromId || singular(paramName) || "item";
	// Every property being a string is what licenses `dict[str, str]` in the
	// rendered signature; anything else and the strict form stays `list[dict]`.
	const allStrings = Object.values(properties).every(
		(spec) => spec && typeof spec === "object" && declaredType(spec) === "string",
	);
	return { kind: "labeled-ids", labelKey, idKey, stem, allStrings };
}

/** JSON Schema types a lone value may be wrapped into a one-item list for. */
const WRAPPABLE = new Set(["string", "number", "integer"]);

/**
 * The T2 adapter: an array of scalars, which also accepts one bare scalar.
 *
 * Measured twice as natural intent — `extract_color_palette(image=...)` and
 * `8wLm-Itk`'s `image`, both passing the single thing where a one-item list was
 * declared. The mistake a wrap could mask is "one item where several were wanted",
 * and that is not validator-catchable in the first place: two of three items
 * passes every check too. So the wrap costs nothing that was being caught.
 *
 * Declines, each for a reason that would otherwise let it corrupt a correct call:
 *
 *   - items of type object or array. `todo_write.todos` is the case: its objects
 *     need three fields, so a wrapped scalar would be an object this file cannot
 *     complete, and the adapter would emit a call the validator rejects.
 *   - `minItems > 1`. A schema demanding two items means one is a real mistake,
 *     and wrapping would replace a client-side error with a server-side one.
 *   - `maxItems: 0`, for the same reason in the other direction.
 *   - a scalar whose type does not match the declared item type. `limit="10"`
 *     where `array<integer>` is declared is a type error, and wrapping it would
 *     bury that inside a list.
 *   - boolean items. Not ordered, and Python's `bool` is an `int` subclass, which
 *     is exactly the confusion the validator already refuses to paper over.
 *   - a parameter whose declared type ALREADY permits the bare scalar (a
 *     `["array", "string"]` union, or an anyOf with a string branch). There the
 *     caller's value is legal as passed, and wrapping would change what the
 *     server receives for an input that needed no help.
 */
export function singletonAdapter(schema, paramName) {
	if (!schema || typeof schema !== "object") return null;
	// Strictly an array, and nothing but: a union or anyOf that also admits the
	// scalar needs no adapter, and must not get one.
	if (schema.type !== "array") return null;
	if (schema.anyOf || schema.oneOf) return null;
	const items = schema.items;
	if (!items || typeof items !== "object" || Array.isArray(items)) return null;
	const itemType = declaredType(items);
	if (!WRAPPABLE.has(itemType)) return null;
	if (typeof schema.minItems === "number" && schema.minItems > 1) return null;
	if (typeof schema.maxItems === "number" && schema.maxItems < 1) return null;
	void paramName;
	return { kind: "singleton", itemType };
}

/**
 * The one adapter a parameter gets, or null.
 *
 * T1 first, though the two cannot both match — an array of objects is not an
 * array of scalars — so the order documents precedence rather than resolving a
 * conflict.
 */
export function paramAdapter(schema, name) {
	return labeledIdAdapter(schema, name) ?? singletonAdapter(schema, name);
}

/** A JSON value as a Python literal — single-quoted strings, `True`/`None`. */
export function pyRepr(value) {
	if (value === null) return "None";
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "number") return String(value);
	if (typeof value === "string") {
		// Single quotes to match what a model types, so the literal can be pasted
		// into a cell as-is. Escaped only where it would break the quoting.
		return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
	}
	if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
	if (typeof value === "object") {
		return `{${Object.entries(value)
			.map(([k, v]) => `${pyRepr(String(k))}: ${pyRepr(v)}`)
			.join(", ")}}`;
	}
	return "None";
}

/** How deep an example may nest, and how many leaves it may show. */
const MAX_EXAMPLE_DEPTH = 4;
const MAX_EXAMPLE_PROPS = 3;

/**
 * A literal of the right shape, synthesized from the schema — or null.
 *
 * Null rather than a guess whenever the schema constrains a leaf in a way this
 * file cannot satisfy (a `pattern`, an unimplemented `format`, a `maxLength`
 * shorter than any placeholder). An example that the validator would itself
 * reject teaches a shape that does not work, which is worse than showing none:
 * `bench/test/pythonic-args.test.mjs` checks every example this function returns
 * against the real `_check` in the generated client, on every catalogue in the
 * repo, for exactly that reason.
 */
export function synthesizeExample(schema, name, depth = 0) {
	if (!schema || typeof schema !== "object" || depth > MAX_EXAMPLE_DEPTH) return null;

	// The schema author's own example beats anything synthesized, and `examples`
	// is data the schema table already carries verbatim.
	if (Array.isArray(schema.examples) && schema.examples.length > 0) return pyRepr(schema.examples[0]);
	if ("example" in schema && schema.example !== undefined) return pyRepr(schema.example);
	if ("const" in schema) return pyRepr(schema.const);
	if (Array.isArray(schema.enum) && schema.enum.length > 0) return pyRepr(schema.enum[0]);

	const variants = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(variants) && variants.length > 0 && declaredType(schema) === undefined) {
		for (const variant of variants) {
			if (variant?.type === "null") continue;
			const example = synthesizeExample(variant, name, depth);
			if (example !== null) return example;
		}
		return null;
	}

	switch (declaredType(schema)) {
		case "string": {
			if (schema.pattern !== undefined) return null; // cannot satisfy it; do not fabricate
			if (schema.format !== undefined && schema.format !== "email") return null;
			const text = schema.format === "email" ? "user@example.com" : isIdKey(name) ? "id1" : `<${String(name ?? "value")}>`;
			if (typeof schema.maxLength === "number" && text.length > schema.maxLength) return null;
			if (typeof schema.minLength === "number" && text.length < schema.minLength) return null;
			return pyRepr(text);
		}
		case "integer":
		case "number": {
			let value = 1;
			if (typeof schema.minimum === "number") value = Math.max(value, schema.minimum);
			if (typeof schema.exclusiveMinimum === "number") value = Math.max(value, schema.exclusiveMinimum + 1);
			if (typeof schema.maximum === "number" && value > schema.maximum) value = schema.maximum;
			if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) value = schema.exclusiveMaximum - 1;
			return String(value);
		}
		case "boolean":
			return "True";
		case "null":
			return "None";
		case "array": {
			const items = schema.items;
			if (!items || typeof items !== "object" || Array.isArray(items)) return null;
			const leaf = singular(name);
			const first = synthesizeExample(items, leaf, depth + 1);
			if (first === null) return null;
			// Two elements only where multiplicity is the point and cheap to show —
			// a list of ids. `minItems` overrides both, so the example satisfies the
			// same constraint the validator will check it against.
			let count = declaredType(items) === "string" && isIdKey(leaf) ? 2 : 1;
			if (typeof schema.minItems === "number") count = Math.max(count, schema.minItems);
			if (typeof schema.maxItems === "number") count = Math.min(count, schema.maxItems);
			if (count > 3) return null; // a wall of placeholders is not an example
			const parts = [];
			for (let i = 0; i < count; i++) {
				// `id1`, `id2`: distinct ids read as a list of things rather than one
				// thing repeated, and a repeated id is a shape a model might copy.
				parts.push(i === 0 ? first : synthesizeExample(items, leaf, depth + 1)?.replace(/id1/g, `id${i + 1}`) ?? first);
			}
			return `[${parts.join(", ")}]`;
		}
		case "object": {
			const properties = schema.properties;
			if (properties && typeof properties === "object" && Object.keys(properties).length > 0) {
				const required = Array.isArray(schema.required) ? schema.required.filter((k) => k in properties) : [];
				const keys = (required.length > 0 ? required : Object.keys(properties)).slice(0, MAX_EXAMPLE_PROPS);
				const parts = [];
				for (const key of keys) {
					const value = synthesizeExample(properties[key], key, depth + 1);
					// A required property with no expressible example makes the whole
					// object inexpressible: an incomplete literal is one the validator
					// would reject.
					if (value === null) return null;
					parts.push(`${pyRepr(key)}: ${value}`);
				}
				return `{${parts.join(", ")}}`;
			}
			const extra = schema.additionalProperties;
			if (extra && typeof extra === "object") {
				const value = synthesizeExample(extra, singular(name), depth + 1);
				if (value === null) return null;
				// `'<key>'` and not a plausible-looking key: the keys of a map are the
				// caller's to choose, and a concrete one would read as the required
				// spelling. `complete_job.final_outputs` buckets by asset type, which
				// only the server knows.
				return `{'<key>': ${value}}`;
			}
			return null; // a bare `dict` — nothing about its contents to show
		}
		default:
			return null;
	}
}

/** How much of a description an example may be mined from, and how long it may be. */
const MAX_MINED_CHARS = 160;

/**
 * The schema author's own example, mined out of the parameter description.
 *
 * Worth the prose-scraping because the author's keys are the DOMAIN's keys:
 * `complete_job.final_outputs` is documented as
 * `Example: {'image': ['uuid1', 'uuid2'], 'video': ['uuid3']}`, and no
 * synthesizer can produce `'image'` from `additionalProperties`. The measured
 * failure — three of five jobs passing a bare list — is a shape mistake, and the
 * best available correction is the shape its own author wrote down.
 *
 * Everything about this is bounded and refusable: the literal must follow an
 * `Example:`/`e.g.` marker, be brace-balanced, parse as JSON once quotes are
 * normalized, fit in `MAX_MINED_CHARS`, and match the schema's own top-level
 * shape. Any failure returns null and the synthesizer runs instead.
 */
export function mineExample(description, schema) {
	const text = String(description ?? "");
	if (!text) return null;
	const marker = /(?:examples?|e\.g\.)\s*:?\s*(?=[[{])/i.exec(text);
	if (!marker) return null;

	const start = marker.index + marker[0].length;
	const open = text[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let quote = null;
	let end = -1;
	for (let i = start; i < text.length && i - start <= MAX_MINED_CHARS; i++) {
		const char = text[i];
		if (quote) {
			if (char === "\\") i++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") {
			depth--;
			if (depth === 0) {
				if (char !== close) return null;
				end = i + 1;
				break;
			}
		}
	}
	if (end < 0) return null;

	const literal = text.slice(start, end);
	// Python-style single quotes are the common spelling in these descriptions.
	// Converted only when there is no double quote to confuse the substitution —
	// a mixed-quote literal is left alone rather than mangled.
	const json = literal.includes('"') ? literal : literal.replace(/'/g, '"');
	let value;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	if (!shapeMatches(value, schema)) return null;
	const rendered = pyRepr(value);
	return rendered.length <= MAX_MINED_CHARS ? rendered : null;
}

/**
 * A shallow structural check of a mined value against its schema.
 *
 * Deliberately NOT a second validator: it is a filter on OUR OWN examples, not
 * on the agent's arguments, and the authority on whether an example is legal is
 * the generated client's `_check`, which the test suite runs over every example
 * this module produces. What this catches is the realistic mining accident — a
 * description whose "example" illustrates the containing object rather than the
 * parameter, i.e. the wrong container type one level down.
 */
export function shapeMatches(value, schema) {
	const type = declaredType(schema);
	if (type === "array") {
		if (!Array.isArray(value)) return false;
		const items = schema.items;
		if (items && typeof items === "object" && !Array.isArray(items) && value.length > 0) {
			return shapeMatches(value[0], items);
		}
		return true;
	}
	if (type === "object") {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
		const extra = schema.additionalProperties;
		const properties = schema.properties ?? {};
		for (const [key, item] of Object.entries(value)) {
			const spec = properties[key] ?? (extra && typeof extra === "object" ? extra : null);
			if (spec && !shapeMatches(item, spec)) return false;
		}
		for (const key of Array.isArray(schema.required) ? schema.required : []) {
			if (!(key in value)) return false;
		}
		return true;
	}
	if (type === "string") return typeof value === "string";
	if (type === "integer") return Number.isInteger(value);
	if (type === "number") return typeof value === "number";
	if (type === "boolean") return typeof value === "boolean";
	return true; // a type this check does not model: do not invent a verdict
}

/**
 * The one example literal for a parameter, or null — author's, mined, or synthesized.
 *
 * Single-authored on purpose: the INDEX one-liner, the docstring line and the
 * `ArgumentError` all show this string, and three spellings of one parameter's
 * shape is the drift that makes a correction untrustworthy the first time one of
 * them is edited.
 */
export function paramExample(schema, name) {
	if (!schema || typeof schema !== "object") return null;
	if (!isNonScalar(schema)) return null;
	return mineExample(schema.description, schema) ?? synthesizeExample(schema, name);
}
