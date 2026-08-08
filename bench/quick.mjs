#!/usr/bin/env node
/**
 * Fast iteration loop.
 *
 *   bench/quick.mjs <env-file> [--variants v1,v5] [--arms codemode] [--repeat 2]
 *
 * The full sweep takes ~2 hours because a handful of tasks run 10-12 minutes
 * each; the median task finishes in 137s. This runs only the fast tasks, at high
 * concurrency, with no judge — turns and cost are enough signal to reject a bad
 * prompt, and rejecting fast is the point.
 *
 *   full sweep   18 tasks x 3 arms, 1200s timeout, judge   ~2 hours
 *   quick        6 fast tasks, 300s timeout, no judge      ~3 minutes
 *
 * Use quick to kill bad ideas, then confirm survivors with the full sweep.
 *
 * `--repeat N` runs each cell N times. Measured run-to-run noise on an identical
 * configuration is ~27% in turns and cost, so a single run per cell cannot rank
 * two variants; repeats are usually a better use of budget than more tasks.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.mjs";
import { loadTasks } from "./tasks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, ".run/runs");

/**
 * Tasks whose median wall-clock is under ~150s, measured over prior runs.
 * They span single- and multi-server tiers so the subset is not trivially easy;
 * re-derive with the timing analysis in docs/FINDINGS.md if the set drifts.
 */
export const FAST_TASKS = [
	"huge_icons_000",
	"call_for_papers_000",
	"reddit_001",
	"openapi_explorer_000",
	"fruityvice_001",
	"game_trends_reddit_000",
];

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const envFile = argv.find((a) => !a.startsWith("--") && (a.includes("/") || a.includes(".env")));
if (!envFile) {
	console.error("usage: bench/quick.mjs <env-file> [--variants v1,v5] [--arms codemode] [--repeat 2]");
	process.exit(2);
}

const model = flag("model", "anthropic/claude-sonnet-5");
const variants = flag("variants", "v1").split(",").map((v) => v.trim());
const arms = flag("arms", "codemode").split(",").map((a) => a.trim());
const repeat = Number(flag("repeat", 1));
const concurrency = Number(flag("concurrency", 16));
const timeout = flag("timeout", "300");
// Score the runs. Turns and cost are cheap proxies, but the question MCP-Bench
// actually asks is whether the task was completed with the right tools — a
// variant can be cheaper because it gave up sooner.
const withJudge = argv.includes("--judge");
const judgeModel = flag("judge-model", "claude-opus-4-5");
const residency = flag("residency", "L0");
// Guardrails. Every one of these has cost real wall-clock in this project.
if (concurrency < 8) {
	console.error(
		`concurrency ${concurrency} is too low — runs are latency-bound and the key supports far more.\n` +
			"Use 24-48. Pass --i-know-what-im-doing to override.",
	);
	if (!argv.includes("--i-know-what-im-doing")) process.exit(2);
}
if (repeat < 2 && variants.length > 1) {
	console.error(
		"comparing variants with --repeat 1: run-to-run noise is ~27%, so this cannot rank them.\n" +
			"Use --repeat 4 (see CLAUDE.md).",
	);
}

const available = new Set(loadTasks().map((t) => t.id));
const tasks = FAST_TASKS.filter((t) => available.has(t));

if (tasks.length === 0) {
	console.error("no fast tasks are currently runnable — check bench/validate.mjs and the task filters");
	process.exit(1);
}

const jobs = [];
for (const variant of variants) {
	for (const arm of arms) {
		for (const task of tasks) {
			for (let rep = 0; rep < repeat; rep++) jobs.push({ variant, arm, task, rep });
		}
	}
}

// Repeats need distinct ids, and quick runs are throwaway — never let them
// collide with or overwrite a sweep's recorded results.
const runId = ({ variant, arm, task, rep }) =>
	`quick__${task}__${arm}__${variant}__r${rep}__${model.replace(/[^a-z0-9]/gi, "-")}`;

console.log(`quick: ${variants.join(",")} x ${arms.join(",")} x ${tasks.length} tasks x ${repeat} = ${jobs.length} runs`);
console.log(`concurrency ${concurrency}, timeout ${timeout}s, no judge\n`);

const started = Date.now();
let done = 0;

await pool(
	jobs,
	(job) =>
		new Promise((resolve) => {
			const id = runId(job);
			rmSync(join(RUNS, id), { recursive: true, force: true });
			const child = spawn(
				"node",
				[
					join(ROOT, "bench/run-task.mjs"),
					envFile,
					model,
					job.task,
					job.arm,
					"--prompt",
					job.variant,
					"--run-id",
					id,
					// Residency levels are arm-specific: codemode has L0/L1/L2, vanilla
					// has L4/L1. Passing codemode's default to vanilla made the
					// extension throw, and the run completed with zero tools and a
					// floor score that looked like a model result.
					"--residency",
					job.arm === "codemode" ? residency : job.arm === "notools" ? "none" : "L4",
					"--timeout",
					timeout,
					"--max-cost",
					"1.0",
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (out += d));
			child.on("close", () => {
				done++;
				process.stderr.write(`[${done}/${jobs.length}] `);
				resolve();
			});
		}),
	concurrency,
);

process.stderr.write("\n");

if (withJudge) {
	// One judge invocation for every run, parallel inside. Spawning judge.mjs
	// per run with --concurrency 1 serialized the whole stage and took longer
	// than the runs themselves.
	console.log("judging...");
	const { spawnSync } = await import("node:child_process");
	spawnSync(
		"node",
		[join(ROOT, "bench/judge.mjs"), envFile, "--model", judgeModel, "--concurrency", "24", "--only-prefix", "quick__"],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);
}

// --- report -------------------------------------------------------------------
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rows = [];
for (const variant of variants) {
	for (const arm of arms) {
		const results = jobs
			.filter((j) => j.variant === variant && j.arm === arm)
			.map((j) => join(RUNS, runId(j), "result.json"))
			.filter(existsSync)
			.map((p) => JSON.parse(readFileSync(p, "utf8")));
		if (!results.length) continue;
		// Average only completed runs. A truncated run has artificially low turns
		// and cost, so including it makes a variant look better for failing —
		// exactly backwards.
		const ok = results.filter((r) => r.summary.stopReason === "completed");
		const cut = results.length - ok.length;
		rows.push({
			variant,
			arm,
			runs: results.length,
			"cut short": cut > 0 ? `${cut} !!` : 0,
			avgTurns: ok.length ? +mean(ok.map((r) => r.summary.turns)).toFixed(1) : "—",
			avgCost: ok.length ? +mean(ok.map((r) => r.summary.cost)).toFixed(3) : "—",
			score: ok.filter((r) => r.judge).length
				? +mean(ok.filter((r) => r.judge).map((r) => r.judge.overall)).toFixed(2)
				: "—",
			fulfil: ok.filter((r) => r.judge).length
				? +mean(ok.filter((r) => r.judge).map((r) => r.judge.scores.task_fulfillment)).toFixed(2)
				: "—",
			p90Sec: ok.length
				? Math.round([...ok.map((r) => r.summary.wallMs / 1000)].sort((a, b) => a - b)[Math.floor(ok.length * 0.9)])
				: "—",
			avgSec: ok.length ? Math.round(mean(ok.map((r) => r.summary.wallMs / 1000))) : "—",
		});
	}
}

const base = rows[0];
for (const r of rows) {
	const ok = base && typeof r.avgTurns === "number" && typeof base.avgTurns === "number";
	r["turns vs first"] = ok ? `${((r.avgTurns / base.avgTurns - 1) * 100).toFixed(0)}%` : "";
	r["cost vs first"] = ok ? `${((r.avgCost / base.avgCost - 1) * 100).toFixed(0)}%` : "";
}

const truncated = rows.reduce((n, r) => n + (typeof r["cut short"] === "string" ? 1 : 0), 0);

console.log(`\nwall clock: ${((Date.now() - started) / 1000 / 60).toFixed(1)} min\n`);
console.table(rows);
console.log("Negative is better. Run-to-run noise is ~27%: treat anything smaller as nothing.");
if (truncated > 0) {
	console.log("!! Some runs were cut short by the timeout and are excluded from the averages.");
	console.log("   Raise --timeout or drop the offending task; a truncated cell is not a measurement.\n");
} else {
	console.log("");
}
