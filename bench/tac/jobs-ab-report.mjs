#!/usr/bin/env node
/**
 * Aggregate a paired ON/OFF jobs-runtime sweep into a table plus paired statistics.
 *
 *   node bench/tac/jobs-ab-report.mjs [--prefix a1] [--md]
 *
 * Pairs are (task, rep): the driver runs ON and OFF back to back, so the pair shares
 * a service state that drifts over hours. Task-to-task spread on TAC is far larger
 * than any treatment effect, and in a paired difference that spread cancels — the
 * reason CLAUDE.md insists on the paired test rather than a comparison of means.
 *
 * Sign test is the headline. Cost and turn differences here are right-skewed (a
 * single run that polls itself into 200 turns moves a mean and barely moves a
 * median), and the sign test assumes only symmetry under the null. When the two
 * disagree, believe the sign test.
 *
 * A run whose `integrity.valid` is false is EXCLUDED from every comparison and
 * listed separately with its reasons. That is the A0 gate: a wedged kernel and a
 * weak agent produce the same-looking number, so the only safe thing to do with an
 * INVALID run is to refuse to average it.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatPaired, pairedTest } from "../stats.mjs";
import { makeArgv } from "../argv.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNS = join(ROOT, ".run/tac");

const argv = process.argv.slice(2);
const { flag } = makeArgv(argv);
const prefix = flag("prefix", "a1");
const asMarkdown = argv.includes("--md");

/**
 * What the agent ran, and what came back.
 *
 * Results matter as well as sources because the negative control's question is
 * "did a guard fire on ordinary code?", and a guard fires in the *result* — the
 * cell source looks perfectly innocent. Counting only sources would answer a
 * different question and look like it had answered this one.
 */
function cells(runId) {
	const f = join(RUNS, runId, "stream.jsonl");
	if (!existsSync(f)) return { sources: [], results: [] };
	const sources = [];
	const results = [];
	for (const line of readFileSync(f, "utf8").split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const e = JSON.parse(line);
			if (e.type === "tool_execution_start") {
				const src = e.args?.code ?? e.args?.source ?? "";
				if (src) sources.push(src);
			} else if (e.type === "tool_execution_end") {
				results.push(JSON.stringify(e.result ?? e.output ?? ""));
			}
		} catch {
			// A truncated trailing line is not worth failing the analysis over.
		}
	}
	return { sources, results };
}

/**
 * Cells whose result carries a guard's refusal.
 *
 * Keyed on the shared tail of `_redirect()` in runtime/kernel-prelude.py, which
 * every guard emits — so this counts refusals rather than any one blocked API.
 */
const guardFires = (results) => results.filter((r) => r.includes("Hand it to a job instead")).length;

/**
 * Which checkpoints are graded by an LLM, per task, as 0-based indices into the
 * grader's `checkpoints` array.
 *
 * Read off each task's `evaluator.py` — the order of `checkpoints.append(...)` in
 * `grade_checkpoints` is the order in the result:
 *
 *   pm-schedule-meeting-2   cp3 (3 of 5 pts) — `evaluate_with_llm(conclusion.txt,
 *                           "the meeting is scheduled on Friday")`
 *   hr-collect-feedbacks    cp4 (2 of 5 pts) — `evaluate_chat_history_with_llm(…,
 *                           "…had an average job performance")`
 *
 * The other tasks used here contain no LLM grading at all (verified: zero
 * references to `evaluate_with_llm` / `evaluate_chat_history_with_llm`).
 *
 * These are DROPPED from the score, uniformly and for both conditions, because a
 * replay of one recorded judge input returned 2 "yes" and 3 "no" on byte-identical
 * content — a coin flip carrying no signal. Dropping structurally rather than
 * majority-voting per run keeps the denominator identical across conditions; the two
 * conditions write different messages, so per-run exclusion would diverge them.
 */
const LLM_CHECKPOINTS = {
	"pm-schedule-meeting-2": [2],
	"hr-collect-feedbacks": [3],
};

/** Score over rule-based checkpoints only, plus how many points were dropped. */
function ruleBasedScore(task, checkpoints) {
	if (!checkpoints) return { result: null, total: null, droppedPoints: 0 };
	const llm = new Set(LLM_CHECKPOINTS[task] ?? []);
	let result = 0;
	let total = 0;
	let droppedPoints = 0;
	checkpoints.forEach((c, i) => {
		if (llm.has(i)) droppedPoints += c.total;
		else {
			result += c.result;
			total += c.total;
		}
	});
	return { result, total, droppedPoints };
}

// Same classifiers as compare-waits.mjs: cells, not mentions. A `sleep` inside a
// submitted command is the fix, not the disease, so submitted command strings are
// stripped before looking for a blocking sleep.
const blockingSleepCells = (s) =>
	s.filter((src) => {
		const w = src.replace(/jobs\.submit\((?:[^()]|\([^()]*\))*\)/gs, "");
		return (
			/(?:time\.|asyncio\.)?sleep\s*\(\s*\d+(?:\.\d+)?\s*\)/.test(w) ||
			(/^\s*%%bash/.test(src) && /(^|[;&|]|\s)sleep\s+\d/m.test(w))
		);
	}).length;
const threadCells = (s) => s.filter((x) => /threading\.Thread|ThreadPoolExecutor|multiprocessing\./.test(x)).length;
const jobsCells = (s) => s.filter((x) => /jobs\.(submit|wait|get|manifest|help)\(/.test(x)).length;

function load(runId) {
	const p = join(RUNS, runId, "result.json");
	if (!existsSync(p)) return null;
	let r;
	try {
		r = JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return null;
	}
	const m = runId.match(new RegExp(`^${prefix}__(.+)__(on|off)__r(\\d+)$`));
	if (!m) return null;
	const { sources: src, results } = cells(runId);
	return {
		runId,
		task: m[1],
		condition: m[2],
		rep: Number(m[3]),
		valid: r.integrity?.valid ?? null,
		reasons: r.integrity?.reasons ?? [],
		graded: !!r.graded,
		cells: src.length,
		blockingSleepCells: blockingSleepCells(src),
		threadCells: threadCells(src),
		jobsCells: jobsCells(src),
		guardFires: guardFires(results),
		turns: r.summary?.turns ?? null,
		cost: r.summary?.cost ?? null,
		// Wall-clock the agent actually spent. Turns and cost cannot see a blocking
		// sleep at all — the kernel is held, no tokens are spent, and the run simply
		// takes longer. It is the one metric on which an in-cell `sleep(5)` is
		// visibly worse than not sleeping.
		agentSeconds:
			r.phases?.agentStart && r.phases?.agentEnd
				? (new Date(r.phases.agentEnd) - new Date(r.phases.agentStart)) / 1000
				: null,
		timedOut: !!r.summary?.timedOut,
		result: r.score?.result ?? null,
		total: r.score?.total ?? null,
		scoreFrac: r.score && r.score.total ? r.score.result / r.score.total : null,
		...(() => {
			const rb = ruleBasedScore(m[1], r.result?.checkpoints);
			return {
				ruleResult: rb.result,
				ruleTotal: rb.total,
				droppedPoints: rb.droppedPoints,
				ruleScoreFrac: rb.total ? rb.result / rb.total : null,
			};
		})(),
	};
}

const rows = readdirSync(RUNS)
	.filter((d) => d.startsWith(`${prefix}__`))
	.map(load)
	.filter(Boolean)
	.sort((a, b) => a.task.localeCompare(b.task) || a.rep - b.rep || a.condition.localeCompare(b.condition));

const invalid = rows.filter((r) => r.valid === false);
const usable = rows.filter((r) => r.valid !== false);

console.log(`\n${rows.length} runs under prefix "${prefix}" — ${usable.length} valid, ${invalid.length} INVALID\n`);
console.table(
	rows.map((r) => ({
		task: r.task.length > 34 ? `…${r.task.slice(-32)}` : r.task,
		cond: r.condition,
		rep: r.rep,
		ok: r.valid === false ? "INVALID" : r.graded ? "" : "ungraded",
		cells: r.cells,
		sleepC: r.blockingSleepCells,
		threadC: r.threadCells,
		jobsC: r.jobsCells,
		guard: r.guardFires,
		turns: r.turns,
		cost: r.cost === null ? null : +r.cost.toFixed(3),
		secs: r.agentSeconds,
		score: r.total ? `${r.result}/${r.total}` : "—",
		rule: r.ruleTotal ? `${r.ruleResult}/${r.ruleTotal}` : "—",
		llmPts: r.droppedPoints || "",
	})),
);

// Pair by (task, rep). A pair with either side INVALID or ungraded-for-score is
// dropped for that metric rather than half-counted.
const key = (r) => `${r.task}#${r.rep}`;
const pairs = [];
for (const on of usable.filter((r) => r.condition === "on")) {
	const off = usable.find((r) => r.condition === "off" && key(r) === key(on));
	if (off) pairs.push({ task: on.task, rep: on.rep, on, off });
}

const METRICS = [
	["blockingSleepCells", "", 2, "lower is better"],
	["threadCells", "", 2, "lower is better"],
	["jobsCells", "", 2, "ON-only by construction"],
	["guardFires", "", 2, "must be 0 on work that needs no waiting"],
	["turns", "", 2, "lower is better"],
	["cost", "$", 3, "lower is better"],
	// Unit stays empty: formatPaired prefixes it, which reads right for "$" and wrong
	// for "s". Seconds are named in the label instead.
	["agentSeconds", "", 1, "seconds of wall-clock — the only metric a blocking sleep shows up in"],
	["ruleScoreFrac", "", 3, "rule-based checkpoints only — the score to read"],
	["scoreFrac", "", 3, "includes LLM-judged checkpoints — DO NOT READ, kept to show the difference"],
];

console.log(`\npaired ON − OFF over ${pairs.length} (task, rep) pairs:\n`);
const stats = {};
for (const [metric, unit, digits, note] of METRICS) {
	const deltas = pairs
		.filter((p) => p.on[metric] !== null && p.off[metric] !== null)
		.map((p) => p.on[metric] - p.off[metric]);
	if (deltas.length < 2) {
		console.log(`${metric.padEnd(30)} n=${deltas.length} — not enough pairs`);
		continue;
	}
	const t = pairedTest(deltas);
	stats[metric] = { ...t, n: deltas.length, note };
	console.log(`${formatPaired(metric, t, { unit, digits })}   [${note}]`);
}

if (invalid.length) {
	console.log(`\nINVALID runs (excluded from every comparison above):`);
	for (const r of invalid) console.log(`  ${r.runId}: ${r.reasons.join("; ")}`);
}

if (asMarkdown) {
	const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "—");
	console.log(`\n\n| metric | ON mean | OFF mean | Δ (ON−OFF) | sign test | t-test |`);
	console.log(`|---|---|---|---|---|---|`);
	for (const [metric, unit, digits] of METRICS) {
		const ps = pairs.filter((p) => p.on[metric] !== null && p.off[metric] !== null);
		if (ps.length < 2) continue;
		const t = stats[metric];
		if (!t) continue;
		const mOn = ps.reduce((s, p) => s + p.on[metric], 0) / ps.length;
		const mOff = ps.reduce((s, p) => s + p.off[metric], 0) / ps.length;
		console.log(
			`| ${metric} | ${unit}${f(mOn, digits)} | ${unit}${f(mOff, digits)} | ${unit}${f(t.mean, digits)} ± ${f(t.sd, digits)} | ` +
				`${t.sign.wins}/${t.sign.nEffective}, p=${f(t.sign.p, 3)} | t=${f(t.t, 2)}, p=${f(t.p, 3)} |`,
		);
	}
}
