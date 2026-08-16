/**
 * The mechanics the two codegen-time catalogue passes share.
 *
 * `bench/enrich-catalogue.mjs` and `bench/required-defaults.mjs` ask a model two
 * different questions about the same three public fields of one tool, and both
 * wrap that question in the same apparatus: sniff an env-file or a `--replay`
 * trace, read the catalogue once, truncate and append a judge-trace, index the
 * catalogue by `app\0tool`, count every proposal and tally every rejection
 * reason, either pool the model calls or re-decide a saved trace, then write a
 * provenance block and print the same summary. That apparatus was written twice.
 *
 * It is deduplicated here rather than left alone because the trace is the thing
 * this project relies on to re-derive a verdict tomorrow, and two spellings of
 * "log the proposal BEFORE the accept/reject branch" is two chances for one of
 * them to start logging only the accepts — the same class as the twenty copies
 * of the argv parser that `bench/argv.mjs` replaced.
 *
 * What deliberately did NOT move here: the prompt, the checker, and the trace
 * ROW. The prompt and the checker are each pass's whole content, and the row's
 * field order is what makes an old trace replayable, so both files keep their
 * rows literal and auditable in one place. This module owns the control flow
 * around them, never the judgement.
 *
 * ## The isolation guarantee lives here now
 *
 * Guardrail 1 of both passes — "the model never sees task data" — is a property
 * of the I/O, and the I/O is in this file: `readCatalogue` and `readTraceRows`
 * are the only readers either pass has. `bench/test/enrichment.test.mjs` and
 * `bench/test/required-defaults.test.mjs` pin that inventory against this file
 * as well as against their own, so a second input cannot be added to either pass
 * by adding it here.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeArgv } from "./argv.mjs";
import { pool } from "./pool.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Run a command asynchronously, writing `input` to its stdin. Same form as judge.mjs. */
function run(cmd, args, input) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolvePromise(out) : reject(new Error(err.slice(-200) || `exit ${code}`))));
		child.stdin.end(input);
	});
}

/**
 * One model call, returning `{ parsed, usage }`.
 *
 * Both passes are a codegen-time question asked of one tool's three public
 * fields, and two spellings of "how this project calls the API" is the drift the
 * single-authored-text rule exists to prevent. The key is sourced in a subshell
 * and never exists as a JavaScript value.
 */
export async function callModel(envFile, model, prompt) {
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
 * The flags every pass takes, including the one that is easy to get wrong.
 *
 * A replay must not overwrite the trace it is replaying — it would destroy the
 * evidence mid-re-derivation — so the default output trace in replay mode is the
 * input's name plus `.replay`, never the pass's own default path.
 */
export function parsePassArgs({ usage, defaultIn = "bench/data/appworld-schemas.json", defaultOut, defaultTrace, defaultConcurrency, argv = process.argv.slice(2) }) {
	const { flag, has } = makeArgv(argv);
	const replayPath = flag("replay", null);
	const envFile = argv.find((a) => !a.startsWith("--") && (a.includes("/") || a.includes(".env")));
	if (!envFile && !replayPath) {
		for (const line of usage) console.error(line);
		process.exit(2);
	}
	const sourceFlag = flag("in", defaultIn);
	return {
		argv,
		flag,
		has,
		envFile,
		replayPath,
		sourceFlag,
		inPath: resolve(ROOT, sourceFlag),
		outPath: resolve(ROOT, flag("out", defaultOut)),
		tracePath: replayPath ? resolve(ROOT, flag("trace", `${replayPath}.replay`)) : resolve(ROOT, flag("trace", defaultTrace)),
		model: flag("model", "claude-opus-5"),
		concurrency: Number(flag("concurrency", defaultConcurrency)),
		limit: Number(flag("limit", 0)),
	};
}

/**
 * The single input, read once. Nothing else is read: no task file, no run
 * directory, no evaluator. This function IS guardrail 1.
 *
 * The digest comes off the same buffer the catalogue was parsed from, so the
 * provenance block cannot record a hash of a file that changed between the read
 * and the hash.
 */
export function readCatalogue(inPath) {
	const raw = readFileSync(inPath);
	const source = JSON.parse(raw.toString("utf8"));
	// A pass fed its OWN output — the required-defaults list, say — would iterate
	// `undefined` and die twenty lines later with a TypeError about `app.tools`.
	if (!Array.isArray(source.catalogue)) throw new Error(`${inPath} is not a catalogue (no top-level "catalogue" array)`);
	return { source, digest: createHash("sha256").update(raw).digest("hex").slice(0, 16) };
}

/** Truncate the trace and return the appender. A pass writes its trace or it has none. */
export function openTrace(tracePath) {
	mkdirSync(dirname(tracePath), { recursive: true });
	writeFileSync(tracePath, "");
	return (row) => appendFileSync(tracePath, `${JSON.stringify(row)}\n`);
}

/**
 * `"<app>\0<tool>"`. NUL rather than a dot because tool names contain dots, and a
 * key that can collide silently resolves a trace row against the wrong tool.
 */
export const toolKey = (app, tool) => `${app}\u0000${tool}`;

/** `"<app>\0<tool>" -> tool`, the index both passes need to resolve a trace row. */
export function toolIndex(source) {
	const index = new Map();
	for (const app of source.catalogue) {
		for (const tool of app.tools) index.set(toolKey(app.server, tool.name), tool);
	}
	return index;
}

/** The fields every trace row starts with, in the order both passes wrote them. */
export function traceBase(record) {
	return {
		ts: new Date().toISOString(),
		model: record.model,
		app: record.app,
		tool: record.tool,
		parameter: record.parameter,
	};
}

/**
 * Judge one proposal and record it, whatever the verdict.
 *
 * The order here is the invariant, and it is why this is shared: `onTrace` runs
 * BEFORE the accept/reject branch, so a rejection is in the trace and can be
 * re-derived tomorrow after the catalogue has moved on. `verdict` does the
 * judging and `row` builds the record — this function does neither, it only
 * guarantees that every proposal is counted once, logged once, and tallied by
 * reason when it loses.
 *
 * Returns the verdict on accept and `null` on reject, so a caller can apply it.
 */
export function makeJudge({ stats, rejections, onTrace, verdict: verdictFor, row: rowFor }) {
	return (record) => {
		stats.proposals++;
		const verdict = verdictFor(record);
		onTrace(rowFor(record, verdict));
		if (!verdict.ok) {
			stats.rejected++;
			const key = verdict.reason.split(":")[0].slice(0, 60);
			rejections[key] = (rejections[key] ?? 0) + 1;
			return null;
		}
		stats.accepted++;
		return verdict;
	};
}

/**
 * Re-decide a saved trace: zero model calls.
 *
 * That is the trace paying for itself. A policy change is re-derived from what
 * the model already said, at zero cost and on the same sample, instead of
 * another pass that would draw a different random set of proposals. It is also
 * CLAUDE.md's test for sufficient logging in executable form — replaying an old
 * trace against today's checker must reproduce the same verdicts for the same
 * inputs.
 */
export function replayTrace(replayPath, { stats, onRow }) {
	const rows = readFileSync(resolve(ROOT, replayPath), "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
	for (const row of rows) {
		if (row.error) {
			stats.failed++;
			continue;
		}
		onRow(row);
	}
	console.log(`replayed ${rows.length} trace records from ${replayPath}`);
	return rows;
}

/**
 * The live pass: one model call per tool, pooled, with the failure recorded in
 * the trace rather than thrown away.
 *
 * `onReply` receives the parsed answer and the tool it was about; everything a
 * pass does with an answer is in there, and everything it shares — the job list,
 * the limit, the concurrency, the token accounting, the failure row — is here.
 */
export async function drivePass({ source, envFile, model, limit, concurrency, stats, onTrace, buildPrompt, onReply }) {
	const jobs = [];
	for (const app of source.catalogue) {
		for (const tool of app.tools) jobs.push({ app, tool });
	}
	const selected = limit > 0 ? jobs.slice(0, limit) : jobs;
	console.log(`${selected.length} tools -> ${model}, concurrency ${concurrency}`);

	await pool(
		selected,
		async ({ app, tool }) => {
			let reply;
			try {
				reply = await callModel(envFile, model, buildPrompt(tool));
			} catch (error) {
				stats.failed++;
				onTrace({ ts: new Date().toISOString(), model, app: app.server, tool: tool.name, error: String(error) });
				return;
			}
			stats.tools++;
			stats.inputTokens += reply.usage.input_tokens ?? 0;
			stats.outputTokens += reply.usage.output_tokens ?? 0;
			onReply(reply, { app, tool, model });
		},
		concurrency,
	);
}

/**
 * The provenance block, in the key order each pass already wrote.
 *
 * `head` and `tail` exist so a pass can slot its own fields in without this
 * function knowing what they are, and without reordering the ones a committed
 * artefact already carries. `at` names the timestamp — `enrichedAt` for one pass
 * and `builtAt` for the other, which is cosmetic drift not worth a migration.
 */
export function provenance({ model, head = {}, sourceFlag, digest, replayPath, tracePath, at, stats, rejections, tail = {} }) {
	return {
		model,
		...head,
		source: sourceFlag,
		sourceDigest: digest,
		replayedFrom: replayPath ?? undefined,
		trace: tracePath.slice(ROOT.length + 1),
		[at]: new Date().toISOString(),
		stats,
		rejections,
		...tail,
	};
}

/** Rejection reasons, commonest first — the shape of what the checker threw out. */
export function printRejections(rejections) {
	for (const [reason, n] of Object.entries(rejections).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${reason}`);
}
