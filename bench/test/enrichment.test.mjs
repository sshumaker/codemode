/**
 * LLM schema enrichment: the guardrails, executed.
 *
 * The pass asks a model for constraints a tool's own prose already states but its
 * schema does not, once, offline, over the shared catalogue. Two things make that
 * safe rather than a way to leak the benchmark into the arm, and both are code:
 *
 *   1. **The enricher's input is the catalogue and nothing else.** `buildPrompt` is
 *      a pure function of (name, description, inputSchema), so there is no parameter
 *      through which a task instruction, a ground truth, an evaluator or a run
 *      artefact could arrive. Asserted here against a real corpus of task data.
 *   2. **A proposal may only NARROW.** Widening is rejected in `enrich-schemas.mjs`
 *      before it can reach a catalogue, on a whitelist of keywords whose direction
 *      is provable, plus an independent check that every value the source's own
 *      default/examples/prose allows is still allowed afterwards.
 *
 * The direction of every test below is the same: a widening proposal must be
 * REJECTED, and a proposal the checker cannot verify must be rejected too. An
 * enrichment pass that accepts something clever and wrong is worse than one that
 * accepts nothing, because it would be measured as a property of the arm.
 *
 * Fairness note pinned at the bottom: enrichment produces a CATALOGUE, which every
 * container is rendered from, so vanilla and claude-code get the improved schemas
 * as well. Nothing stops a tool-calling harness pre-processing its own JSON the
 * same way; the codemode-only part is enforcement at the call site.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { buildPrompt } from "../enrich-catalogue.mjs";
import { accepts, checkNarrowing, DEFAULT_KEYWORDS, describedValues, NARROWABLE } from "../enrich-schemas.mjs";
import { constrained, realistic } from "./fixtures/catalogue.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ENRICHER = readFileSync(join(ROOT, "bench/enrich-catalogue.mjs"), "utf8");

/** The canonical target: an enum stated in prose, absent from the schema. */
const SORT_BY = {
	type: "string",
	description: "The attribute to sort the products by prefixed with +/- to reflect ascending/descending. Valid attributes: rating, price.",
};

describe("a proposal may only narrow", () => {
	it("accepts an enum the source schema would already admit", () => {
		const verdict = checkNarrowing(SORT_BY, { enum: ["+rating", "-rating", "+price", "-price"] }, { description: SORT_BY.description });
		assert.equal(verdict.ok, true, verdict.reason);
		// The SOURCE schema with the verified keyword merged in — never the model's
		// object written through. A keyword the checker did not vouch for does not
		// exist as far as the catalogue is concerned.
		assert.equal(verdict.applied.type, "string");
		assert.equal(verdict.applied.description, SORT_BY.description);
	});

	it("rejects an enum containing a value the source forbids", () => {
		// The load-bearing case. `{type: integer}` cannot be narrowed to an enum of
		// strings — that is a *different* accepted space, not a smaller one.
		const verdict = checkNarrowing({ type: "integer" }, { enum: [1, 2, "three"] });
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason, /admits value\(s\) the source forbids/);
		assert.match(verdict.reason, /"three"/);
	});

	it("rejects an enum that drops a value the source already allowed", () => {
		const source = { type: "string", enum: ["all", "files", "directories"] };
		const verdict = checkNarrowing(source, { enum: ["files", "directories"] });
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason, /drops source value\(s\).*all/);
	});

	it("rejects a bound that raises the ceiling", () => {
		assert.equal(checkNarrowing({ type: "integer", maximum: 20 }, { maximum: 100 }).ok, false);
		assert.equal(checkNarrowing({ type: "integer", minimum: 1 }, { minimum: 0 }).ok, false);
		assert.equal(checkNarrowing({ type: "string", minLength: 8 }, { minLength: 1 }).ok, false);
		assert.equal(checkNarrowing({ type: "array", maxItems: 3 }, { maxItems: 10 }).ok, false);
		// ...and accepts the same edits in the tightening direction.
		assert.equal(checkNarrowing({ type: "integer", maximum: 100 }, { maximum: 20 }).ok, true);
		assert.equal(checkNarrowing({ type: "integer" }, { minimum: 0 }).ok, true);
	});

	it("rejects a type that is not a subset of the source's", () => {
		assert.equal(checkNarrowing({ type: ["string", "null"] }, { type: ["string", "integer"] }).ok, false);
		assert.equal(checkNarrowing({ type: ["string", "null"] }, { type: "string" }).ok, true);
		// A source with no declared type accepts everything, so any concrete type narrows.
		assert.equal(checkNarrowing({ description: "d" }, { type: "string" }).ok, true);
	});

	it("refuses every structural keyword outright", () => {
		// Rewriting the shape of a schema is not a narrowing this checker can verify,
		// so it is not a narrowing it permits — including the ones that LOOK like
		// narrowings. `required` and `additionalProperties: false` do narrow an object's
		// accepted space, and are still refused: at parameter level they would remove
		// an argument the server accepts, and the checker cannot tell which.
		for (const keywords of [
			{ required: ["a"] },
			{ additionalProperties: false },
			{ properties: { a: { type: "string" } } },
			{ anyOf: [{ type: "string" }] },
			{ items: { type: "string" } },
			{ $ref: "#/definitions/x" },
			{ const: "fixed" },
		]) {
			const verdict = checkNarrowing({ type: "object" }, keywords);
			assert.equal(verdict.ok, false, `${JSON.stringify(keywords)} was accepted`);
			assert.match(verdict.reason, /non-narrowable keyword/);
		}
		assert.equal(NARROWABLE.has("required"), false);
		assert.equal(NARROWABLE.has("properties"), false);
	});

	it("will add a pattern but never replace one", () => {
		// Regex containment is not decidable here, so the direction of a replacement
		// cannot be verified — and an unverifiable edit is dropped, not guessed at.
		assert.equal(checkNarrowing({ type: "string" }, { pattern: "^[A-Z]{3}$" }, { keywords: NARROWABLE }).ok, true);
		const verdict = checkNarrowing({ type: "string", pattern: "^[A-Z]+$" }, { pattern: "^[A-Z]{3}$" }, { keywords: NARROWABLE });
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason, /unverifiable/);
	});

	it("rejects a pattern that does not compile", () => {
		const verdict = checkNarrowing({ type: "string" }, { pattern: "^[A-Z" }, { keywords: NARROWABLE });
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason, /does not compile/);
	});

	it("rejects a format the runtime validator does not actually enforce", () => {
		// Applying `format: date-time` would be decoration: it would appear in the
		// signature and the docs and check nothing. Claiming a check that does not
		// run is the exact failure this project keeps finding.
		assert.equal(checkNarrowing({ type: "string" }, { format: "email" }).ok, true);
		assert.match(checkNarrowing({ type: "string" }, { format: "date-time" }).reason, /not enforced/);
	});

	it("rejects a proposal that changes nothing", () => {
		const source = { type: "string", enum: ["a", "b"] };
		assert.match(checkNarrowing(source, { enum: ["a", "b"] }).reason, /identical to the source/);
		assert.match(checkNarrowing(source, {}).reason, /empty/);
	});
});

describe("a proposal may not forbid what the source says is legal", () => {
	it("rejects one that would forbid the source's own default", () => {
		const source = { type: "string", default: "descending", description: "Order." };
		const verdict = checkNarrowing(source, { enum: ["ascending"] }, { description: source.description });
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason, /would forbid "descending"/);
	});

	it("rejects one that would forbid a literal quoted in the parameter's own prose", () => {
		// The independent check, and the one that catches a proposal the keyword rules
		// wave through: a description reading "e.g. `INBOX`" is the author saying that
		// value is legal, so an enum omitting it is narrowing past what was documented.
		const source = { type: "string", description: "Mailbox to read, e.g. `INBOX` or `SENT`." };
		const verdict = checkNarrowing(source, { enum: ["INBOX"] }, { description: source.description });
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason, /would forbid "SENT"/);
		// The same proposal covering both documented values is fine.
		assert.equal(checkNarrowing(source, { enum: ["INBOX", "SENT"] }, { description: source.description }).ok, true);
	});

	it("ignores quoted prose the source itself would not accept", () => {
		// A lossy scan, lossy in the SAFE direction: a spurious literal can only cause
		// a rejection. One that the source's own type forbids is not evidence about
		// the source and must not veto an otherwise legal narrowing.
		const source = { type: "integer", description: "Page size. Pass `unlimited` to the web UI instead." };
		assert.deepEqual(describedValues(source, source.description), []);
		assert.equal(checkNarrowing(source, { minimum: 1, maximum: 20 }, { description: source.description }).ok, true);
	});

	it("treats an existing enum as evidence in both directions", () => {
		const source = { type: "string", enum: ["a", "b"] };
		assert.deepEqual(describedValues(source).sort(), ["a", "b"]);
	});
});

describe("the value-acceptance mirror", () => {
	it("agrees with the runtime validator on the cases that matter", () => {
		// Same rules as the Python `_check` rendered into api/_client.py: if these two
		// disagreed, the checker could vouch for a narrowing the runtime then rejects,
		// which would break calls the server would have answered.
		assert.equal(accepts({ type: "integer" }, 3), true);
		assert.equal(accepts({ type: "integer" }, 3.5), false);
		assert.equal(accepts({ type: "number" }, 3), true, "an integer must satisfy number");
		assert.equal(accepts({ type: "integer" }, true), false, "a boolean is not an integer");
		assert.equal(accepts({ type: "string", format: "email" }, "a@b.co"), true);
		assert.equal(accepts({ type: "string", format: "email" }, "nope"), false);
		assert.equal(accepts({ anyOf: [{ type: "number" }, { type: "string" }] }, "x"), true);
		assert.equal(accepts({ anyOf: [{ type: "number" }, { type: "string" }] }, [1]), false);
	});
});

describe("the enricher cannot see task data", () => {
	// The things it must never be shown: an instruction, a ground-truth answer, the
	// evaluator's code, and a path into a previous run's artefacts.
	const forbidden = [
		"Order a large pepperoni pizza from my favourite restaurant",
		"ground_truth_answer",
		"def test_complete_task(self)",
		"evaluation.json",
		".run/appworld",
	];

	it("buildPrompt is a pure function of (name, description, inputSchema)", () => {
		// Asserted by construction rather than by reading the prompt: the function is
		// called with an object carrying every forbidden string as EXTRA fields, and
		// none of them can reach the output because none of them are destructured.
		const tool = {
			...constrained[0].tools[0],
			instruction: forbidden[0],
			groundTruth: forbidden[1],
			evaluator: forbidden[2],
			runDir: forbidden[4],
		};
		const prompt = buildPrompt(tool);
		for (const secret of forbidden) {
			assert.equal(prompt.includes(secret), false, `task data reached the enricher's prompt: ${secret}`);
		}
		// And it does carry the three fields it is entitled to.
		assert.ok(prompt.includes("search"), "the tool name is missing");
		assert.ok(prompt.includes("Search the catalogue."), "the description is missing");
		assert.ok(prompt.includes('"exclusiveMinimum"'), "the input schema is missing");
	});

	it("reads exactly one file, the catalogue", () => {
		// The isolation guarantee is a property of the I/O, so it is asserted on the
		// I/O: every readFileSync in the pass, listed. A future reader adding a second
		// input has to change this test, which is the point.
		// The catalogue, and — in replay mode — a trace this pass itself wrote. Nothing
		// else. A future reader adding a second input has to change this test, which is
		// the point of listing them rather than describing them.
		const reads = [...ENRICHER.matchAll(/readFileSync\(([^)]*)\)/g)].map((m) => m[1].trim());
		assert.deepEqual(
			reads,
			["inPath, \"utf8\"", "resolve(ROOT, replayPath", "inPath"],
			`the enricher reads something other than the catalogue and its own trace: ${reads}`,
		);
		// No directory walk and no second source. `readdirSync` is how a pass would
		// grow a second input without anyone noticing.
		for (const forbiddenApi of ["readdirSync", "loadTasks", "globSync", "Task.load"]) {
			assert.equal(ENRICHER.includes(forbiddenApi), false, `the enricher can enumerate files with ${forbiddenApi}`);
		}
		// It imports the checker and the pool, and nothing that knows about tasks.
		const imports = [...ENRICHER.matchAll(/^import .* from "(\.[^"]+)";$/gm)].map((m) => m[1]);
		assert.deepEqual(imports.sort(), ["./enrich-schemas.mjs", "./pool.mjs"]);
	});

	it("refuses to enrich an already-enriched catalogue", () => {
		// Re-enriching compounds unverifiable edits and destroys the provenance chain
		// back to the benchmark's own schemas.
		assert.match(ENRICHER, /if \(source\.enrichment\) throw new Error/);
	});
});

describe("the trace", () => {
	it("records every proposal with its inputs and its verdict, accepted or not", () => {
		// The judge-trace pattern from CLAUDE.md: a rejection has to be re-derivable
		// tomorrow, after the catalogue has moved on — so the SOURCE schema goes in the
		// record, not a pointer to it. This project has one check whose cause is now
		// permanently unknowable for exactly this reason.
		const write = ENRICHER.slice(ENRICHER.indexOf("\tonTrace({"), ENRICHER.indexOf("if (!verdict.ok)"));
		for (const field of ["source: sourceSchema", "proposed: proposed", "evidence:", "accepted: verdict.ok", "reason: verdict.reason", "model: record.model"]) {
			assert.ok(write.includes(field), `the trace omits ${field}`);
		}
		// Written before the accept/reject branch, so a rejection is logged too.
		assert.ok(ENRICHER.indexOf("\tonTrace({") < ENRICHER.indexOf("if (!verdict.ok)"));
	});

	it("writes the model's object nowhere — only the checker's applied result", () => {
		assert.match(ENRICHER, /return verdict\.applied;/);
		assert.equal(/properties\[[^\]]+\] = (proposal|row)\b/.test(ENRICHER), false, "the model's object is written through unchecked");
		assert.match(ENRICHER, /properties\[proposal\.parameter\] = applied/);
	});

	it("replay scores a saved trace through the same judge as the live pass", () => {
		// The trace paying for itself. A policy change — disabling `pattern` after
		// finding a class of it wrong against the server — is re-derived from what the
		// model already said, at zero cost and on the same sample, instead of another
		// pass that would draw different proposals. Two implementations of "is this a
		// narrowing?" would make the replay a different question, so there is one.
		assert.equal((ENRICHER.match(/checkNarrowing\(/g) ?? []).length, 1, "the checker is called from more than one place");
		assert.match(ENRICHER, /const applied = judge\(/);
		// And a replay must not overwrite the trace it is replaying.
		assert.match(ENRICHER, /replayPath \? resolve\(ROOT, flag\("trace", `\$\{replayPath\}\.replay`\)\) : tracePath/);
	});
});

describe("the keyword policy", () => {
	it("excludes pattern by default, on a measured finding rather than taste", () => {
		// AppWorld's `min_created_at` is documented "in YYYY-MM-DD format" and its
		// server's parse_date ALSO accepts `%Y-%m-%dT%H:%M:%S`, so the pattern the prose
		// implies forbids a value the API answers. The narrowing invariant is relative
		// to the DECLARED schema, and `{"type": "string"}` declares nothing — so a
		// formally valid narrowing can still be wrong about the server.
		assert.equal(DEFAULT_KEYWORDS.has("pattern"), false);
		assert.equal(NARROWABLE.has("pattern"), true, "pattern is still available behind the flag");
		for (const keyword of ["enum", "format", "minimum", "maxItems"]) {
			assert.equal(DEFAULT_KEYWORDS.has(keyword), true, `${keyword} should be on by default`);
		}
	});

	it("reports a disabled keyword as a policy choice, not a rule violation", () => {
		// They read differently in a rejection tally, and conflating them would hide
		// the difference between "the model proposed something illegal" and "this pass
		// chose not to apply it".
		const disabled = checkNarrowing({ type: "string" }, { pattern: "^x$" });
		assert.equal(disabled.ok, false);
		assert.match(disabled.reason, /not enabled for this pass/);
		const illegal = checkNarrowing({ type: "string" }, { required: ["a"] });
		assert.match(illegal.reason, /non-narrowable keyword/);
		// And with the flag on, the same proposal is judged on its merits.
		assert.equal(checkNarrowing({ type: "string" }, { pattern: "^x$" }, { keywords: NARROWABLE }).ok, true);
	});

	it("does not read an apostrophe as an opening quote", () => {
		// Measured: "the user's home directory, starting with '/'" was read as the
		// literal "s home directory, starting with ", which vetoed 28 otherwise-legal
		// proposals in one pass — a lossy scan failing loudly in the safe direction,
		// but still failing.
		const description = "Absolute path, or a path in the user's home directory, starting with '/' or '~/'.";
		const found = describedValues({ type: "string" }, description);
		assert.equal(found.some((v) => String(v).includes("home directory")), false, `the apostrophe opened a quote: ${found}`);
		assert.deepEqual(found.sort(), ["/", "~/"]);
	});
});

describe("enrichment is arm-neutral", () => {
	it("produces a catalogue, which every container is rendered from", () => {
		// Not codemode-only. A tool-calling harness could pre-process its own JSON the
		// same way, so making this a codemode advantage would be measuring a choice we
		// made rather than a property of the representation. The runner's --catalogue
		// flag therefore applies to every arm at once, like --base-prompt.
		const RUNNER = readFileSync(join(ROOT, "bench/appworld/run-task.mjs"), "utf8");
		const SWEEP = readFileSync(join(ROOT, "bench/appworld/sweep.mjs"), "utf8");
		assert.match(RUNNER, /const cataloguePath = flag\("catalogue", DEFAULT_CATALOGUE\)/);
		// Not gated on `arm`, unlike --validate-args, which is rejected on any other arm.
		assert.equal(/catalogue.*arm !== "codemode"/.test(RUNNER), false, "the catalogue flag is per-arm");
		assert.match(SWEEP, /if \(cataloguePath !== DEFAULT_CATALOGUE\) args\.push\("--catalogue", cataloguePath\)/);
		// And a different catalogue is a different experiment: it lands in the runId,
		// or an enriched run would overwrite the baseline it is compared against.
		assert.match(RUNNER, /__cat-/);
		assert.match(SWEEP, /__cat-/);
	});

	it("the enriched catalogue keeps the shape every renderer already consumes", () => {
		// No new code downstream, no second authoring path: the output is the input's
		// shape with tighter property schemas, so the api/ tree, the TOC, the name list
		// and the vanilla tool definitions all pick it up unchanged.
		const enrichedProperty = checkNarrowing(SORT_BY, { enum: ["+rating", "-rating"] }, { description: SORT_BY.description }).applied;
		assert.deepEqual(Object.keys(enrichedProperty).sort(), ["description", "enum", "type"]);
		assert.equal(enrichedProperty.description, SORT_BY.description, "enrichment rewrote the authored description");
	});

	it("never touches the description, which is the fairness mechanism", () => {
		// One authored description, N containers, no paraphrase (docs/DESIGN.md). A
		// pass that reworded descriptions would turn the experiment into a measurement
		// of whose prose is better.
		assert.equal(NARROWABLE.has("description"), false);
		const verdict = checkNarrowing(realistic[0].tools[0].inputSchema.properties.team, { description: "A better description." });
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason, /non-narrowable/);
	});
});
