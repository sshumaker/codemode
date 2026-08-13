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
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNarrowing, DEFAULT_KEYWORDS, NARROWABLE } from "./enrich-schemas.mjs";
import { pool } from "./pool.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};

/** Run a command asynchronously, writing `input` to its stdin. Same form as judge.mjs. */
function run(cmd, args, input) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(-200) || `exit ${code}`))));
		child.stdin.end(input);
	});
}

async function callModel(envFile, model, prompt) {
	const payload = JSON.stringify({
		model,
		max_tokens: 2000,
		messages: [{ role: "user", content: prompt }],
	});
	const script = `
set -a; . "$1"; set +a
curl -sS https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  --data-binary @-`;
	const body = JSON.parse(await run("bash", ["-c", script, "_", envFile], payload));
	if (body.error) throw new Error(`enricher API: ${body.error.message}`);
	const text = (body.content ?? []).map((c) => c.text ?? "").join("");
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) throw new Error(`enricher returned no JSON: ${text.slice(0, 200)}`);
	return { parsed: JSON.parse(match[0]), usage: body.usage ?? {} };
}

/**
 * Judge one proposal against its source schema and record it, whatever the verdict.
 *
 * Shared by the live pass and `--replay`, so a replayed trace is scored by exactly
 * the code path that scored it the first time. Two implementations of "is this a
 * narrowing?" would make the replay a different question from the pass.
 */
function judge(record, { keywords, stats, rejections, onTrace }) {
	stats.proposals++;
	const { sourceSchema, proposed } = record;
	const verdict = !sourceSchema
		? { ok: false, reason: `no such parameter: ${record.parameter}` }
		: checkNarrowing(sourceSchema, proposed ?? {}, { description: sourceSchema.description ?? "", keywords });

	// content, predicate, verdict, model — the judge-trace pattern. The SOURCE schema
	// goes in the record rather than a pointer to it, because the catalogue it points
	// at is the thing that moves.
	onTrace({
		ts: new Date().toISOString(),
		model: record.model,
		app: record.app,
		tool: record.tool,
		parameter: record.parameter,
		source: sourceSchema ?? null,
		proposed: proposed ?? null,
		evidence: record.evidence ?? null,
		accepted: verdict.ok,
		reason: verdict.reason,
		applied: verdict.applied ?? null,
	});

	if (!verdict.ok) {
		stats.rejected++;
		const key = verdict.reason.split(":")[0].slice(0, 60);
		rejections[key] = (rejections[key] ?? 0) + 1;
		return null;
	}
	stats.accepted++;
	// The SOURCE schema with verified keywords merged in — never the model's object
	// written through. A keyword the checker did not vouch for does not exist as far
	// as the catalogue is concerned.
	return verdict.applied;
}

async function main() {
	const replayPath = flag("replay", null);
	const envFile = argv.find((a) => !a.startsWith("--") && (a.includes("/") || a.includes(".env")));
	if (!envFile && !replayPath) {
		console.error("usage: bench/enrich-catalogue.mjs <env-file> [--in <catalogue>] [--out <catalogue>]");
		console.error("       bench/enrich-catalogue.mjs --replay <trace.jsonl> [--out <catalogue>]");
		process.exit(2);
	}
	const inPath = resolve(ROOT, flag("in", "bench/data/appworld-schemas.json"));
	const outPath = resolve(ROOT, flag("out", "bench/data/appworld-schemas.enriched.json"));
	const tracePath = resolve(ROOT, flag("trace", "bench/data/enrichment-trace.jsonl"));
	const model = flag("model", "claude-opus-5");
	const concurrency = Number(flag("concurrency", 8));
	const limit = Number(flag("limit", 0));
	// `pattern` is off by default; see DEFAULT_KEYWORDS for the measurement that put
	// it there. The flag exists so the A/B can price it rather than a rule of thumb.
	const keywords = argv.includes("--allow-pattern") ? NARROWABLE : DEFAULT_KEYWORDS;

	// The single input. Nothing else is read: no task file, no run directory, no
	// evaluator. This line IS guardrail 1.
	const source = JSON.parse(readFileSync(inPath, "utf8"));
	if (source.enrichment) throw new Error(`${inPath} is already enriched — enrich the source catalogue, not its output`);

	const stats = { tools: 0, proposals: 0, accepted: 0, rejected: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
	const rejections = {};
	// Replaying must not overwrite the trace it is replaying.
	const outTrace = replayPath ? resolve(ROOT, flag("trace", `${replayPath}.replay`)) : tracePath;
	mkdirSync(dirname(outTrace), { recursive: true });
	writeFileSync(outTrace, "");
	const onTrace = (row) => appendFileSync(outTrace, `${JSON.stringify(row)}\n`);

	const propertiesFor = (() => {
		const index = new Map();
		for (const app of source.catalogue) {
			for (const tool of app.tools) index.set(`${app.server}\u0000${tool.name}`, tool.inputSchema?.properties ?? {});
		}
		return (app, tool) => index.get(`${app}\u0000${tool}`) ?? null;
	})();

	if (replayPath) {
		// Zero model calls: every proposal, and the exact schema it was made against,
		// is already in the trace. The catalogue is rebuilt from the SOURCE file, so a
		// replay under a different keyword policy is a clean re-derivation and not an
		// edit layered on a previous output.
		const rows = readFileSync(resolve(ROOT, replayPath), "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
		const seen = new Set();
		for (const row of rows) {
			if (row.error) {
				stats.failed++;
				continue;
			}
			seen.add(`${row.app}\u0000${row.tool}`);
			const properties = propertiesFor(row.app, row.tool);
			const applied = judge(
				{ ...row, model: row.model, sourceSchema: properties?.[row.parameter] ?? row.source, proposed: row.proposed },
				{ keywords, stats, rejections, onTrace },
			);
			if (applied && properties) properties[row.parameter] = applied;
		}
		// Tools that PROPOSED something, not tools processed: a trace records proposals,
		// and the tools the model had nothing to say about leave no record. Named so
		// the number is not read as coverage.
		stats.toolsWithProposals = seen.size;
		console.log(`replayed ${rows.length} trace records from ${replayPath}`);
	} else {
		const jobs = [];
		for (const app of source.catalogue) {
			for (const tool of app.tools) jobs.push({ app, tool });
		}
		const selected = limit > 0 ? jobs.slice(0, limit) : jobs;
		console.log(`${selected.length} tools -> ${model}, concurrency ${concurrency}`);

		await pool(
			selected,
			async ({ app, tool }) => {
				const prompt = buildPrompt(tool);
				let reply;
				try {
					reply = await callModel(envFile, model, prompt);
				} catch (error) {
					stats.failed++;
					onTrace({ ts: new Date().toISOString(), model, app: app.server, tool: tool.name, error: String(error) });
					return;
				}
				stats.tools++;
				stats.inputTokens += reply.usage.input_tokens ?? 0;
				stats.outputTokens += reply.usage.output_tokens ?? 0;
				const properties = tool.inputSchema?.properties ?? {};
				for (const proposal of reply.parsed.proposals ?? []) {
					const applied = judge(
						{
							model,
							app: app.server,
							tool: tool.name,
							parameter: proposal.parameter,
							sourceSchema: properties[proposal.parameter],
							proposed: proposal.keywords,
							evidence: proposal.evidence,
						},
						{ keywords, stats, rejections, onTrace },
					);
					if (applied) properties[proposal.parameter] = applied;
				}
			},
			concurrency,
		);
	}

	const enrichment = {
		model,
		keywords: [...keywords].sort(),
		source: flag("in", "bench/data/appworld-schemas.json"),
		sourceDigest: createHash("sha256").update(readFileSync(inPath)).digest("hex").slice(0, 16),
		replayedFrom: replayPath ?? undefined,
		trace: outTrace.slice(ROOT.length + 1),
		enrichedAt: new Date().toISOString(),
		stats,
		rejections,
	};
	writeFileSync(outPath, `${JSON.stringify({ ...source, enrichment }, null, 1)}\n`);

	console.log(
		`tools ${replayPath ? `${stats.toolsWithProposals} with proposals` : stats.tools} (${stats.failed} failed)  proposals ${stats.proposals}  ` +
			`accepted ${stats.accepted}  rejected ${stats.rejected}`,
	);
	for (const [reason, n] of Object.entries(rejections).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${reason}`);
	console.log(`-> ${outPath}\n-> ${outTrace}`);
}

// Importable for tests (buildPrompt) without running the pass — the isolation
// guarantee is only testable if the prompt builder can be called without a network.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
