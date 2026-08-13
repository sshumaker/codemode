/**
 * The narrowing checker: does a proposed schema accept a strict subset of what the
 * source accepts?
 *
 * Separated from `enrich-catalogue.mjs` — which does the I/O and the model call —
 * because this is the part that has to be *tested*, and testing it must not need a
 * network. Everything here is a pure function of (source, proposal).
 *
 * The rule the whole pass rests on: **enrichment may only narrow.** A model reading
 * a tool's prose and proposing `enum: ["+price", "-price", "+rating"]` for a
 * parameter documented as "the attribute to sort by prefixed with +/-" is doing
 * something a tool-calling harness could equally do to its own JSON, so it is fair
 * to give it to every arm. A model that *widens* — drops a `required`, relaxes a
 * `maximum`, replaces an enum with a superset — has invented a capability the
 * server never offered, and every arm would then be measured against a schema that
 * lies. So widening is not a bug to be caught in review; it is rejected here, in
 * code, before it can reach a catalogue.
 *
 * Rejection is conservative by construction. Deciding schema subsumption in general
 * is undecidable-adjacent and this file does not attempt it: every accepted edit is
 * drawn from a small whitelist whose narrowing direction is provable by inspection,
 * and *anything else at all* is rejected. An enricher that returns something clever
 * and unverifiable gets nothing applied, which is the intended failure.
 */

/** JSON Schema keywords a proposal is allowed to touch. Everything else is rejected. */
export const NARROWABLE = new Set([
	"type",
	"enum",
	"format",
	"pattern",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
]);

/** Formats this project's validator actually enforces. Proposing another is a no-op. */
export const ENFORCED_FORMATS = new Set(["email"]);

/**
 * The keywords applied by default — everything narrowable except `pattern`.
 *
 * MEASURED, not assumed. On the first full pass over AppWorld's 469 tools the model
 * made 135 proposals, of which 62 of the 105 accepted were `pattern`, and reading
 * the server showed a whole class of them to be wrong:
 *
 *   `gmail.show_threads.min_created_at` is documented "in YYYY-MM-DD format", and
 *   the proposal `^\d{4}-\d{2}-\d{2}$` follows from that prose exactly. But
 *   `apps/lib/apis/datetime.py:parse_date` falls back to `%Y-%m-%dT%H:%M:%S`, so
 *   the server accepts an ISO datetime the pattern forbids — and even the server's
 *   own error message says "Use YYYY-MM-DD".
 *
 * This is the limit of the narrowing invariant, and it is worth stating plainly:
 * **the invariant is relative to the declared schema, and the declared schema is
 * not the server.** A parameter typed `{"type": "string"}` declares nothing, so any
 * pattern narrows it, while the implementation behind it may be far more lenient
 * than its own documentation. Documentation is not a specification.
 *
 * The other keywords do not have this exposure to the same degree — an `enum` or a
 * `minimum` proposed from prose is a claim about a value SET the docs enumerate,
 * where a `pattern` is a claim about a value FORMAT, and formats are where
 * implementations quietly accept more than they document. Patterns stay available
 * behind `--allow-pattern` so the A/B can price them rather than a rule of thumb
 * deciding it.
 */
export const DEFAULT_KEYWORDS = new Set([...NARROWABLE].filter((k) => k !== "pattern"));

const typeNames = (schema) => {
	const t = schema?.type;
	if (t === undefined) return null;
	return new Set(Array.isArray(t) ? t : [t]);
};

/**
 * Does `value` satisfy `schema`? A deliberately partial mirror of the Python
 * validator in `generate.mjs`, used to answer "would the proposal still admit this
 * value the source explicitly allows?".
 *
 * Partial in the safe direction: anything it cannot decide, it calls valid — so an
 * undecidable case makes the *checker* refuse the proposal (the value looks
 * allowed under source and must therefore be allowed under proposal), never accept
 * a narrowing it could not verify.
 */
export function accepts(schema, value) {
	if (!schema || typeof schema !== "object") return true;
	const variants = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(variants) && variants.length > 0) return variants.some((v) => accepts(v, value));

	const types = typeNames(schema);
	if (types) {
		const actual =
			value === null ? "null"
			: Array.isArray(value) ? "array"
			: typeof value === "boolean" ? "boolean"
			: typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number")
			: typeof value === "string" ? "string"
			: typeof value === "object" ? "object"
			: "unknown";
		// An integer satisfies `number`; nothing else is widened.
		const ok = types.has(actual) || (actual === "integer" && types.has("number"));
		if (!ok) return false;
	}
	if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) return false;
	if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) return false;
		if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
		if (schema.pattern !== undefined) {
			try {
				if (!new RegExp(schema.pattern).test(value)) return false;
			} catch {
				// An un-compilable pattern is handled by the proposal checker, not here.
			}
		}
		if (schema.format === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return false;
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) return false;
		if (schema.maximum !== undefined && value > schema.maximum) return false;
		if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false;
		if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return false;
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) return false;
		if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
	}
	return true;
}

/**
 * Values the SOURCE schema says out loud are legal, which a proposal must still admit.
 *
 * Three sources, in descending order of how explicit they are:
 *   - `default` — the value the server itself uses when the parameter is omitted.
 *     A proposal that forbids it is wrong by inspection.
 *   - `examples` / `enum` — stated, machine-readable, and already in the schema.
 *   - quoted and back-ticked literals in the parameter's own prose. A description
 *     reading "e.g. '2023-01-15'" is the author telling us that string is legal;
 *     a proposed `enum` that omits it is narrowing past what was documented.
 *
 * The prose scan is why `describedValues` takes the description rather than the
 * schema alone. It is lossy — it will pick up words that are not values — but in
 * the safe direction: a spurious literal can only cause a proposal to be REJECTED.
 */
export function describedValues(source, description = "") {
	const values = [];
	if ("default" in source && source.default !== null) values.push(source.default);
	for (const v of source.examples ?? []) values.push(v);
	for (const v of source.enum ?? []) values.push(v);
	// The single-quote form requires a word boundary on both sides. Without it an
	// apostrophe opens a quote: "the user's home directory, starting with '/'" was
	// read as the literal "s home directory, starting with ", which then vetoed 28
	// otherwise-legal proposals in one pass. Backticks and double quotes need no
	// such guard.
	for (const m of String(description).matchAll(/`([^`\n]{1,40})`|(?:^|[\s([])'([^'\n]{1,40})'(?=$|[\s).,;:])|"([^"\n]{1,40})"/g)) {
		const literal = m[1] ?? m[2] ?? m[3];
		// Only literals the source would itself accept are evidence about the source.
		// A quoted phrase from an unrelated sentence fails this and is ignored.
		if (accepts(source, literal)) values.push(literal);
	}
	return values;
}

/**
 * Is `proposed` a legal narrowing of `source`?
 *
 * @returns {{ok: boolean, reason: string, applied?: object}} — `applied` is the
 *          source schema with the accepted keywords merged in, so the caller never
 *          writes the model's object into the catalogue directly.
 */
export function checkNarrowing(source, proposed, { description = "", keywords = DEFAULT_KEYWORDS } = {}) {
	if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) {
		return { ok: false, reason: "proposal is not an object" };
	}
	const touched = Object.keys(proposed);
	if (touched.length === 0) return { ok: false, reason: "proposal is empty" };

	// Two gates, and the order matters for the trace: a keyword outside NARROWABLE is
	// a rule violation, where one inside it but outside the enabled set is a policy
	// choice this run made. They read differently in a rejection tally.
	const disabled = touched.filter((k) => NARROWABLE.has(k) && !keywords.has(k));
	if (disabled.length > 0) {
		return { ok: false, reason: `keyword(s) not enabled for this pass: ${disabled.join(", ")}` };
	}
	const illegal = touched.filter((k) => !NARROWABLE.has(k));
	if (illegal.length > 0) {
		// Includes every structural keyword — properties, required, additionalProperties,
		// anyOf, items, $ref. Rewriting the shape of a schema is not a narrowing this
		// file can verify, so it is not a narrowing this file permits.
		return { ok: false, reason: `touches non-narrowable keyword(s): ${illegal.join(", ")}` };
	}

	for (const key of touched) {
		const from = source[key];
		const to = proposed[key];
		switch (key) {
			case "type": {
				const src = typeNames(source);
				const dst = typeNames(proposed);
				if (!dst || dst.size === 0) return { ok: false, reason: "type narrowed to nothing" };
				// A source with no declared type accepts everything, so any concrete type
				// is a narrowing. Otherwise the proposed set must be a subset.
				if (src && [...dst].some((t) => !src.has(t))) {
					return { ok: false, reason: `type ${[...dst].join("|")} is not a subset of ${[...src].join("|")}` };
				}
				break;
			}
			case "enum": {
				if (!Array.isArray(to) || to.length === 0) return { ok: false, reason: "enum is empty" };
				// Every proposed member must already be legal under the source, or the
				// enum is admitting values the server never offered.
				const outside = to.filter((v) => !accepts(source, v));
				if (outside.length > 0) {
					return { ok: false, reason: `enum admits value(s) the source forbids: ${JSON.stringify(outside)}` };
				}
				if (Array.isArray(from)) {
					const kept = new Set(to.map((v) => JSON.stringify(v)));
					const dropped = from.filter((v) => !kept.has(JSON.stringify(v)));
					if (dropped.length > 0) {
						return { ok: false, reason: `enum drops source value(s): ${JSON.stringify(dropped)}` };
					}
				}
				break;
			}
			case "format": {
				if (from !== undefined && from !== to) return { ok: false, reason: `format ${from} -> ${to} is a change, not a narrowing` };
				if (!ENFORCED_FORMATS.has(to)) return { ok: false, reason: `format ${to} is not enforced, so applying it would be decoration` };
				break;
			}
			case "pattern": {
				// Regex containment is not decidable here, so a pattern may only be ADDED.
				// Replacing one is a change whose direction cannot be verified.
				if (from !== undefined) return { ok: false, reason: "pattern already present; replacing it is unverifiable" };
				try {
					new RegExp(to);
				} catch (error) {
					return { ok: false, reason: `pattern does not compile: ${error.message}` };
				}
				break;
			}
			case "minimum":
			case "exclusiveMinimum":
			case "minLength":
			case "minItems": {
				if (typeof to !== "number") return { ok: false, reason: `${key} is not a number` };
				if (from !== undefined && to < from) return { ok: false, reason: `${key} ${from} -> ${to} raises the ceiling on what is accepted` };
				break;
			}
			case "maximum":
			case "exclusiveMaximum":
			case "maxLength":
			case "maxItems": {
				if (typeof to !== "number") return { ok: false, reason: `${key} is not a number` };
				if (from !== undefined && to > from) return { ok: false, reason: `${key} ${from} -> ${to} raises the ceiling on what is accepted` };
				break;
			}
			default:
				return { ok: false, reason: `unhandled keyword ${key}` };
		}
	}

	const applied = { ...source, ...proposed };

	// The independent check, and the one that catches a plausible-looking proposal
	// the keyword rules above wave through: whatever the source itself says is legal
	// — its default, its examples, the literals in its own prose — must still be
	// legal afterwards.
	for (const value of describedValues(source, description)) {
		if (!accepts(applied, value)) {
			return { ok: false, reason: `would forbid ${JSON.stringify(value)}, which the source schema or its description allows` };
		}
	}
	// And the proposal must actually do something. A restatement of the source is
	// churn in the catalogue digest for no change in what is accepted.
	if (JSON.stringify(applied) === JSON.stringify(source)) {
		return { ok: false, reason: "proposal is identical to the source" };
	}
	return { ok: true, reason: "narrows", applied };
}
