#!/usr/bin/env node
/**
 * Did the jobs runtime actually fix the behaviour it was built for?
 *
 *   node bench/tac/compare-waits.mjs <new-run-id> [baseline-run-id]
 *
 * The runtime exists because of specific, counted failures in recorded TAC runs:
 * `pm-schedule-meeting-2` wrote 302 in-cell sleeps and spawned 48 `threading.Thread`
 * pollers; `admin-ask-for-meeting-feedback` 335 sleeps; `hr-collect-feedbacks` 215.
 * Those numbers are the baseline, and they are on disk, so the check is a diff rather
 * than an impression.
 *
 * Counts cells, not characters: an agent that writes one `sleep` in a submitted job's
 * command has done the right thing, and a per-line grep would score that as a
 * regression. What matters is how many CELLS blocked the kernel.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNS = join(ROOT, ".run/tac");

const [newId, baselineId] = process.argv.slice(2);
if (!newId) {
	console.error("usage: bench/tac/compare-waits.mjs <new-run-id> [baseline-run-id]");
	console.error(`have: ${readdirSync(RUNS).slice(0, 8).join(", ")} ...`);
	process.exit(2);
}

/** Cells the agent executed, with the source it actually ran. */
function cells(runId) {
	const f = join(RUNS, runId, "stream.jsonl");
	if (!existsSync(f)) return null;
	const out = [];
	for (const line of readFileSync(f, "utf8").split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const e = JSON.parse(line);
			if (e.type === "tool_execution_start") {
				const src = e.args?.code ?? e.args?.source ?? "";
				if (src) out.push(src);
			}
		} catch {
			// A truncated trailing line is not worth failing the analysis over.
		}
	}
	return out;
}

/**
 * A sleep that holds the KERNEL, as opposed to one inside submitted work.
 *
 * `jobs.submit("until [ -f x ]; do sleep 2; done", ...)` contains the word sleep and
 * is exactly correct — the sleeping happens in a detached process. Counting it would
 * report the fix as the disease. So: strip submitted command strings first.
 */
function blockingSleepCells(sources) {
	return sources.filter((src) => {
		const withoutSubmits = src.replace(/jobs\.submit\((?:[^()]|\([^()]*\))*\)/gs, "");
		const pySleep = /(?:time\.|asyncio\.)?sleep\s*\(\s*\d+(?:\.\d+)?\s*\)/.test(withoutSubmits);
		const shSleep = /^\s*%%bash/.test(src) && /(^|[;&|]|\s)sleep\s+\d/m.test(withoutSubmits);
		return pySleep || shSleep;
	});
}

const threadCells = (sources) => sources.filter((s) => /threading\.Thread|ThreadPoolExecutor|multiprocessing\./.test(s));
const jobsCells = (sources) => sources.filter((s) => /jobs\.(submit|wait|get)\(/.test(s));

function summarise(runId) {
	const src = cells(runId);
	if (!src) return null;
	const result = existsSync(join(RUNS, runId, "result.json"))
		? JSON.parse(readFileSync(join(RUNS, runId, "result.json"), "utf8"))
		: {};
	// A0: a run whose machinery was broken is not a data point. Surface it as such
	// rather than letting a wedged-kernel 0/5 sit in the table looking like a weak
	// agent — the exact confusion that cost seven runs.
	if (result.integrity && result.integrity.valid === false) {
		return { run: runId.length > 44 ? `…${runId.slice(-42)}` : runId, INVALID: result.integrity.reasons.join("; ") };
	}
	return {
		run: runId.length > 44 ? `…${runId.slice(-42)}` : runId,
		cells: src.length,
		blockingSleepCells: blockingSleepCells(src).length,
		threadCells: threadCells(src).length,
		jobsCells: jobsCells(src).length,
		score: result.score ?? result.summary?.score ?? "—",
		graded: result.graded ?? false,
	};
}

// Recorded baselines, so the comparison works even if the old run directory is gone.
const KNOWN = {
	"pm-schedule-meeting-2": { sleeps: 302, threads: 48 },
	"admin-ask-for-meeting-feedback": { sleeps: 335, threads: 5 },
	"hr-collect-feedbacks": { sleeps: 215, threads: 5 },
	"pm-ask-for-issue-and-create-in-gitlab": { sleeps: 94, threads: 43 },
};

const rows = [summarise(newId)].filter(Boolean);
if (baselineId) {
	const b = summarise(baselineId);
	if (b) rows.push(b);
}
console.table(rows);

const task = Object.keys(KNOWN).find((t) => newId.includes(t));
if (task) {
	const k = KNOWN[task];
	console.log(
		`\nrecorded baseline for ${task}: ${k.sleeps} raw sleep mentions, ${k.threads} thread mentions\n` +
			"(raw grep counts from the original trace — not directly comparable to the CELL\n" +
			" counts above, which is the point: the old runs were counted by mention because\n" +
			" nothing distinguished a blocking sleep from one inside submitted work.)",
	);
}
console.log(
	"\nWhat would count as a fix: blockingSleepCells and threadCells at or near zero,\n" +
		"with jobsCells > 0. A run with all three at zero did no waiting at all and\n" +
		"proves nothing — check the task actually required waiting before believing it.",
);
