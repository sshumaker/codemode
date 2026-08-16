#!/usr/bin/env node
/**
 * Ask a model for the constraints a tool's prose already states but its schema does not.
 *
 *   node bench/enrich-catalogue.mjs <env-file> [--in <catalogue>] [--out <catalogue>]
 *                                   [--model claude-opus-5] [--concurrency 8] [--limit N]
 *                                   [--allow-pattern]
 *   node bench/enrich-catalogue.mjs --replay <trace.jsonl> [--out <catalogue>]
 *
 * `--replay` re-runs the CHECKER over a saved trace and rebuilds the catalogue with
 * zero model calls. That is the trace paying for itself: a policy change (say,
 * disabling `pattern` after finding a class of it wrong against the server) is
 * re-derivable from what the model already said, rather than being another $10 and
 * a different random sample of proposals. It is also the executable form of
 * CLAUDE.md's test for sufficient logging — "could you re-derive the verdict
 * tomorrow?" — since replaying an old trace against today's checker must reproduce
 * the same verdicts for the same inputs.
 *
 * This is a CODEGEN-time pass, not a runtime one. It runs once, offline, over the
 * shared catalogue, and its output is a catalogue file of exactly the same shape —
 * so every downstream container (the api/ tree, the L2 TOC, the L1 name list, and
 * the vanilla arm's JSON tool definitions) picks the improvement up from the single
 * authored source, with no second authoring path. That is deliberate and it is the
 * fairness point: **nothing stops a tool-calling harness pre-processing its own
 * JSON schemas the same way**, so this must not be a codemode-only advantage. The
 * codemode-only part is enforcement at the call site (`--validate-args`), which is
 * a property of executing in the agent's process, not of having better schemas.
 *
 * What it looks for: constraints a careful reader would extract from the tool's own
 * description. AppWorld's `amazon.search_products.sort_by` is the canonical case —
 * "The attribute to sort the products by prefixed with +/- ... Valid attributes:
 * rating, price, ..." — an enum stated in prose and absent from `enum`.
 *
 * ## The guardrails, and why each is code rather than prompt text
 *
 * 1. **The enricher never sees task data.** Its entire input is (name, description,
 *    inputSchema) read from the catalogue file. `buildPrompt` is a pure function of
 *    those three fields and takes nothing else — there is no parameter through which
 *    an instruction, a ground truth, an evaluator or a run artefact could arrive.
 *    A prompt that merely *said* "do not look at the tasks" would be the kind of
 *    documented-but-unexecuted check this project keeps finding.
 * 2. **Enrichment may only narrow.** `bench/enrich-schemas.mjs` decides that, from a
 *    whitelist of keywords whose direction is provable, plus an independent check
 *    that every value the source's own default/examples/prose allows is still
 *    allowed afterwards. Anything else is rejected.
 * 3. **Every proposal is logged with its inputs and its verdict** to a JSONL, the
 *    judge-trace pattern: a rejection has to be re-derivable tomorrow, after the
 *    catalogue has moved on.
 * 4. **Anything unverifiable is dropped**, and dropping is silent in effect — the
 *    parameter keeps its source schema exactly.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNarrowing, DEFAULT_KEYWORDS, NARROWABLE } from "./enrich-schemas.mjs";
import {
	drivePass,
	makeJudge,
	openTrace,
	parsePassArgs,
	printRejections,
	provenance,
	readCatalogue,
	replayTrace,
	toolIndex,
	toolKey,
	traceBase,
} from "./enrich-driver.mjs";

/**
 * The instruction, and the model's entire view of the world.
 *
 * A pure function of one tool's three public fields. Exported so a test can assert
 * that property directly rather than trusting the sentence above: pass a catalogue
 * and a task corpus, and check the corpus appears nowhere in what the function
 * returns for any tool.
 */
export function buildPrompt({ name, description, inputSchema }) {
	return [
		"You are tightening a JSON Schema for a single API, offline, before any agent runs.",
		"",
		"You are given ONLY that API's name, its documentation, and its current input schema.",
		"There is no task, no user and no context beyond this. Do not imagine one.",
		"",
		"Your job: find constraints the DOCUMENTATION ALREADY STATES that the schema does not",
		"encode. Typical finds:",
		"  - a set of valid values listed in the prose but absent from `enum`",
		"  - a stated numeric floor or ceiling absent from `minimum`/`maximum`",
		"  - a stated string shape (a date format, an id prefix) expressible as `pattern`",
		"  - `format: \"email\"` where the prose says the value is an email address",
		"",
		"Hard rules:",
		"  - Propose ONLY what the documentation states or unambiguously implies. If you are",
		"    inferring from what an API of this name usually accepts, do not propose it.",
		"  - You may only NARROW. Never admit a value the current schema forbids, and never",
		"    forbid a value the documentation gives as an example or as the default.",
		"  - You may only touch these keywords: type, enum, format, pattern, minimum, maximum,",
		"    exclusiveMinimum, exclusiveMaximum, minLength, maxLength, minItems, maxItems.",
		"    Never propose properties, required, additionalProperties, anyOf, items or $ref.",
		"  - Proposing nothing is the correct answer for most parameters. Say so.",
		"",
		`API name: ${name}`,
		"",
		"Documentation:",
		description || "(none)",
		"",
		"Current input schema:",
		JSON.stringify(inputSchema, null, 1),
		"",
		"Reply with JSON and nothing else:",
		"{",
		'  "proposals": [',
		'    {"parameter": "<name>", "keywords": {"enum": ["a","b"]}, "evidence": "<the exact',
		'     phrase in the documentation that states this>"}',
		"  ]",
		"}",
		'An empty "proposals" list is a valid and common answer.',
	].join("\n");
}

// --- everything below is I/O; the model's view is fixed above ------------------

// The apparatus around the question — argv, the catalogue read, the trace, the
// pool, the provenance block — is `bench/enrich-driver.mjs`, shared with
// `bench/required-defaults.mjs`. What stays here is the question, the checker
// call, and the trace ROW, whose field order is what makes an old trace
// replayable.

/**
 * Is this proposal a narrowing? Called from one place, by the driver's judge, so
 * the live pass and `--replay` are scored by exactly the same code path. Two
 * implementations of "is this a narrowing?" would make the replay a different
 * question from the pass.
 */
const narrowingVerdict = (record, keywords) =>
	!record.sourceSchema
		? { ok: false, reason: `no such parameter: ${record.parameter}` }
		: checkNarrowing(record.sourceSchema, record.proposed ?? {}, { description: record.sourceSchema.description ?? "", keywords });

/**
 * The trace row: content, predicate, verdict, model — the judge-trace pattern.
 *
 * The SOURCE schema goes in the record rather than a pointer to it, because the
 * catalogue it points at is the thing that moves. Written here rather than in
 * the driver because these field names and their order are the format an old
 * trace is replayed from.
 */
const narrowingRow = (record, verdict) => ({
	...traceBase(record),
	source: record.sourceSchema ?? null,
	proposed: record.proposed ?? null,
	evidence: record.evidence ?? null,
	accepted: verdict.ok,
	reason: verdict.reason,
	applied: verdict.applied ?? null,
});

/**
 * The SOURCE schema with verified keywords merged in — never the model's object
 * written through. A keyword the checker did not vouch for does not exist as far
 * as the catalogue is concerned, so this is the ONLY write into the catalogue.
 */
function applyTo(properties, parameter, verdict) {
	if (verdict && properties) properties[parameter] = verdict.applied;
}

async function main() {
	const { envFile, replayPath, sourceFlag, inPath, outPath, tracePath, model, concurrency, limit, has } = parsePassArgs({
		usage: [
			"usage: bench/enrich-catalogue.mjs <env-file> [--in <catalogue>] [--out <catalogue>]",
			"       bench/enrich-catalogue.mjs --replay <trace.jsonl> [--out <catalogue>]",
		],
		defaultOut: "bench/data/appworld-schemas.enriched.json",
		defaultTrace: "bench/data/enrichment-trace.jsonl",
		defaultConcurrency: 8,
	});
	// `pattern` is off by default; see DEFAULT_KEYWORDS for the measurement that put
	// it there. The flag exists so the A/B can price it rather than a rule of thumb.
	const keywords = has("allow-pattern") ? NARROWABLE : DEFAULT_KEYWORDS;

	// The single input, read by the driver. Nothing else is read: no task file, no
	// run directory, no evaluator. That read IS guardrail 1.
	const { source, digest } = readCatalogue(inPath);
	// Re-enriching compounds unverifiable edits and destroys the provenance chain
	// back to the benchmark's own schemas. `bench/required-defaults.mjs` needs no
	// such guard: its output is not a catalogue, so it cannot be fed back in, and
	// its pass never mutates what it read.
	if (source.enrichment) throw new Error(`${inPath} is already enriched — enrich the source catalogue, not its output`);

	const stats = { tools: 0, proposals: 0, accepted: 0, rejected: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
	const rejections = {};
	const onTrace = openTrace(tracePath);
	const judge = makeJudge({
		stats,
		rejections,
		onTrace,
		verdict: (record) => narrowingVerdict(record, keywords),
		row: narrowingRow,
	});

	if (replayPath) {
		// Zero model calls: every proposal, and the exact schema it was made against,
		// is already in the trace. The catalogue is rebuilt from the SOURCE file, so a
		// replay under a different keyword policy is a clean re-derivation and not an
		// edit layered on a previous output.
		const index = toolIndex(source);
		const seen = new Set();
		replayTrace(replayPath, {
			stats,
			onRow: (row) => {
				const key = toolKey(row.app, row.tool);
				seen.add(key);
				const properties = index.has(key) ? (index.get(key).inputSchema?.properties ?? {}) : null;
				applyTo(
					properties,
					row.parameter,
					judge({ ...row, model: row.model, sourceSchema: properties?.[row.parameter] ?? row.source, proposed: row.proposed }),
				);
			},
		});
		// Tools that PROPOSED something, not tools processed: a trace records proposals,
		// and the tools the model had nothing to say about leave no record. Named so
		// the number is not read as coverage.
		stats.toolsWithProposals = seen.size;
	} else {
		await drivePass({
			source,
			envFile,
			model,
			limit,
			concurrency,
			stats,
			onTrace,
			buildPrompt,
			onReply: (reply, { app, tool }) => {
				const properties = tool.inputSchema?.properties ?? {};
				for (const proposal of reply.parsed.proposals ?? []) {
					applyTo(
						properties,
						proposal.parameter,
						judge({
							model,
							app: app.server,
							tool: tool.name,
							parameter: proposal.parameter,
							sourceSchema: properties[proposal.parameter],
							proposed: proposal.keywords,
							evidence: proposal.evidence,
						}),
					);
				}
			},
		});
	}

	const enrichment = provenance({
		model,
		head: { keywords: [...keywords].sort() },
		sourceFlag,
		digest,
		replayPath,
		tracePath,
		at: "enrichedAt",
		stats,
		rejections,
	});
	writeFileSync(outPath, `${JSON.stringify({ ...source, enrichment }, null, 1)}\n`);

	console.log(
		`tools ${replayPath ? `${stats.toolsWithProposals} with proposals` : stats.tools} (${stats.failed} failed)  proposals ${stats.proposals}  ` +
			`accepted ${stats.accepted}  rejected ${stats.rejected}`,
	);
	printRejections(rejections);
	console.log(`-> ${outPath}\n-> ${tracePath}`);
}

// Importable for tests (buildPrompt) without running the pass — the isolation
// guarantee is only testable if the prompt builder can be called without a network.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
