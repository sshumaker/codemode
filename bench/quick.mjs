#!/usr/bin/env node
/**
 * Fast iteration loop.
 *
 *   bench/quick.mjs <env-file> [--variants v1,v5] [--arms codemode] [--repeat 2]
 *   bench/quick.mjs <env-file> --cells 2x2 [--repeat 2]    the factorial, paired
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

// Opus is the model under study. Sonnet was useful early for cheap iteration,
// but the two disagree on configuration — Opus prefers delta namespace
// injection, Sonnet prefers full — so tuning on Sonnet optimizes the wrong thing.
const model = flag("model", "anthropic/claude-opus-5");
const variants = flag("variants", "q8").split(",").map((v) => v.trim());
const arms = flag("arms", "codemode").split(",").map((a) => a.trim());
const repeat = Number(flag("repeat", 1));
const concurrency = Number(flag("concurrency", 16));
const timeout = flag("timeout", "300");
// Show the live kernel namespace after every cell (harness-side fix for the
// redundancy gap, as opposed to the prompt-side fix in variant q7).
// "full" repeats the whole namespace each cell; "delta" shows only what is new,
// which is far cheaper in context because the repetition is where the cost is.
// Delta is the default: it is the best measured configuration on Opus (0.809 vs
// 0.799 full), because Opus retains a binding after being told once and the
// repeated full listing is then pure context cost. Sonnet needs the repetition.
const nsMode = argv.includes("--ns-full") ? "1" : argv.includes("--ns-off") ? "0" : "delta";
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
// --tasks narrows the fast set, for validating a new cell before paying for the
// whole factorial. It cannot widen it: FAST_TASKS is the speed-selected subset and
// CLAUDE.md records that efficiency findings on it do not generalise.
const taskFlag = flag("tasks", "");
const requested = taskFlag ? taskFlag.split(",").map((s) => s.trim()) : null;
if (requested) {
	const unknown = requested.filter((t) => !FAST_TASKS.includes(t));
	if (unknown.length) {
		console.error(`--tasks names tasks outside the fast set: ${unknown.join(",")}\nfast set: ${FAST_TASKS.join(",")}`);
		process.exit(2);
	}
}
const tasks = FAST_TASKS.filter((t) => available.has(t)).filter((t) => !requested || requested.includes(t));

if (tasks.length === 0) {
	console.error("no fast tasks are currently runnable — check bench/validate.mjs and the task filters");
	process.exit(1);
}

/**
 * The 2x2 from docs/DESIGN.md, as MCP-Bench cells.
 *
 * Deliberately the same four cells AppWorld's factorial.mjs runs — representation
 * (code | tools) x documentation residency (in | out) — because the open question
 * is whether the AppWorld result reproduces, and two benchmarks running two
 * different designs answer nothing. MCP-Bench is the mirror-image control: its
 * bias on pagination runs the other way.
 *
 * Prompts differ per benchmark because the variant names do (q8/w2/w3 here,
 * a1/b1/b2 there); the *structure* is identical. Within each row the two cells now
 * share their guidance verbatim, so residency is the only thing that varies.
 */
const CELLS_2X2 = [
	{ key: "code / docs out", row: "code", col: "out", arm: "codemode", residency: "L0", prompt: "q8" },
	{ key: "code / docs in", row: "code", col: "in", arm: "codemode", residency: "L4", prompt: "q8" },
	{ key: "tools / docs out", row: "tools", col: "out", arm: "vanilla", residency: "L1", vanillaPrompt: "w3" },
	{ key: "tools / docs in", row: "tools", col: "in", arm: "vanilla", residency: "L4", vanillaPrompt: "w2" },
];

// --cells runs the factorial instead of variants x arms. Named subsets allowed so
// a single cell can be re-run without re-running the other three.
const cellsFlag = flag("cells", "");
const selectedCells = cellsFlag
	? cellsFlag === "2x2"
		? CELLS_2X2
		: CELLS_2X2.filter((c) => cellsFlag.split(",").map((s) => s.trim()).includes(c.key))
	: null;
if (cellsFlag && selectedCells.length === 0) {
	console.error(`--cells matched nothing. Available: 2x2, or any of: ${CELLS_2X2.map((c) => `"${c.key}"`).join(", ")}`);
	process.exit(2);
}

const jobs = [];
if (selectedCells) {
	for (const cell of selectedCells) {
		for (const task of tasks) {
			for (let rep = 0; rep < repeat; rep++) jobs.push({ cell, arm: cell.arm, task, rep, variant: cell.prompt ?? cell.vanillaPrompt });
		}
	}
} else {
	for (const variant of variants) {
		for (const arm of arms) {
			for (const task of tasks) {
				for (let rep = 0; rep < repeat; rep++) jobs.push({ variant, arm, task, rep });
			}
		}
	}
}

// Repeats need distinct ids, and quick runs are throwaway — never let them
// collide with or overwrite a sweep's recorded results.
const runId = ({ variant, arm, task, rep, cell }) =>
	`quick__${task}__${arm}__${cell ? `${cell.residency}__` : ""}${variant}${nsMode === "1" ? "-ns" : nsMode === "delta" ? "-nsd" : ""}__r${rep}__${model.replace(/[^a-z0-9]/gi, "-")}`;

if (selectedCells) {
	console.log(`quick 2x2: ${selectedCells.length} cells x ${tasks.length} tasks x ${repeat} = ${jobs.length} runs`);
	for (const c of selectedCells) console.log(`   ${c.key.padEnd(18)} ${c.arm}/${c.residency} prompt=${c.prompt ?? c.vanillaPrompt}`);
} else {
	console.log(`quick: ${variants.join(",")} x ${arms.join(",")} x ${tasks.length} tasks x ${repeat} = ${jobs.length} runs`);
}
console.log(`concurrency ${concurrency}, timeout ${timeout}s, no judge\n`);

const started = Date.now();
let done = 0;

// --dry-run prints the exact argv per job and spends nothing. Worth having: three
// separate result sets in this project were invalidated by a flag that did not
// reach the runner, and each was only visible in the argv.
const dryRun = argv.includes("--dry-run");

const argsFor = (job, id) => [
	join(ROOT, "bench/run-task.mjs"),
	envFile,
	model,
	job.task,
	job.arm,
	...(job.cell
		? job.cell.prompt
			? ["--prompt", job.cell.prompt]
			: ["--vanilla-prompt", job.cell.vanillaPrompt]
		: ["--prompt", job.variant]),
	"--run-id",
	id,
	"--residency",
	job.cell ? job.cell.residency : job.arm === "codemode" ? residency : job.arm === "notools" ? "none" : "L4",
	"--timeout",
	timeout,
	"--max-cost",
	"1.0",
];

if (dryRun) {
	const seen = new Set();
	for (const job of jobs) {
		const a = argsFor(job, runId(job));
		// One line per distinct (cell, arm) shape — 200 identical-shaped lines hide
		// the one that differs.
		const shape = a.slice(4).filter((x) => !String(x).startsWith("quick__")).join(" ");
		if (seen.has(shape)) continue;
		seen.add(shape);
		console.log(`  node bench/run-task.mjs <env> ${model} ${job.task} ${shape}`);
	}
	console.log(`\n${jobs.length} runs, ${seen.size} distinct argv shapes. Nothing spent.`);
	process.exit(0);
}

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
					// In cells mode the prompt belongs to the arm: codemode reads
					// --prompt, vanilla reads --vanilla-prompt, and passing a w-name to
					// --prompt would throw on an unknown codemode variant.
					...(job.cell
						? job.cell.prompt
							? ["--prompt", job.cell.prompt]
							: ["--vanilla-prompt", job.cell.vanillaPrompt]
						: ["--prompt", job.variant]),
					"--run-id",
					id,
					// Residency levels are arm-specific: codemode has L0/L1/L2/L4,
					// vanilla has L4/L1. Passing codemode's default to vanilla made the
					// extension throw, and the run completed with zero tools and a
					// floor score that looked like a model result.
					"--residency",
					job.cell ? job.cell.residency : job.arm === "codemode" ? residency : job.arm === "notools" ? "none" : "L4",
					"--timeout",
					timeout,
					"--max-cost",
					"1.0",
				],
				{
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, HARNESS_SHOW_NAMESPACE: nsMode },
				},
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

if (selectedCells) {
	// Cells mode reports paired per-task differences, using the same bench/stats.mjs
	// as AppWorld's factorial — same contrasts, same null control, same sign test.
	// Reimplementing the statistics per benchmark is how two "identical" 2x2s stop
	// being comparable, and cost is right-skewed enough that the sign test has
	// already overturned a t-test in this project.
	const { pairedTest, formatPaired } = await import("./stats.mjs");
	const costs = new Map(); // `${task}|${cell.key}` -> mean cost over replicates
	const cellRows = [];
	for (const cell of selectedCells) {
		const perTask = new Map();
		for (const job of jobs.filter((j) => j.cell === cell)) {
			const p = join(RUNS, runId(job), "result.json");
			if (!existsSync(p)) continue;
			const r = JSON.parse(readFileSync(p, "utf8"));
			if (r.summary.stopReason !== "completed") continue;
			if (r.summary.residencyViolation) {
				console.log(`!! ${cell.key} ${job.task}: ${r.summary.residencyViolation}`);
				continue;
			}
			if (!perTask.has(job.task)) perTask.set(job.task, []);
			perTask.get(job.task).push(r);
		}
		// Average replicates within (task, cell) BEFORE pairing. Treating replicates
		// as independent observations is pseudo-replication and inflates n.
		for (const [task, rs] of perTask) costs.set(`${task}|${cell.key}`, mean(rs.map((r) => r.summary.cost)));
		const flat = [...perTask.values()].flat();
		cellRows.push({
			cell: cell.key,
			arm: `${cell.arm}/${cell.residency}`,
			tasks: perTask.size,
			runs: flat.length,
			avgTurns: flat.length ? +mean(flat.map((r) => r.summary.turns)).toFixed(1) : "—",
			avgCost: flat.length ? +mean(flat.map((r) => r.summary.cost)).toFixed(3) : "—",
			ctx0: flat.length ? Math.round(mean(flat.map((r) => r.summary.firstTurnPromptTokens ?? 0))) : "—",
		});
	}
	console.log(`\nwall clock: ${((Date.now() - started) / 1000 / 60).toFixed(1)} min\n`);
	console.table(cellRows);

	const cellFor = (row, col) => selectedCells.find((c) => c.row === row && c.col === col);
	const costOf = (row, col, t) => costs.get(`${t}|${cellFor(row, col)?.key}`);
	const complete = tasks.filter((t) =>
		["in", "out"].every((col) => ["code", "tools"].every((row) => Number.isFinite(costOf(row, col, t)))),
	);
	if (selectedCells.length === 4 && complete.length >= 2) {
		console.log(`\n=== paired per-task cost differences (n=${complete.length} tasks present in all 4 cells) ===\n`);
		const contrasts = [
			["residency, code row (in - out)", (t) => costOf("code", "in", t) - costOf("code", "out", t)],
			["residency, tools row (in - out)", (t) => costOf("tools", "in", t) - costOf("tools", "out", t)],
			["representation, docs-in (tools - code)", (t) => costOf("tools", "in", t) - costOf("code", "in", t)],
			["representation, docs-out (tools - code)", (t) => costOf("tools", "out", t) - costOf("code", "out", t)],
		];
		for (const [name, fn] of contrasts) console.log(`  ${formatPaired(name, pairedTest(complete.map(fn)))}`);
		const self = pairedTest(complete.map((t) => costOf("code", "out", t) - costOf("code", "out", t)));
		console.log(`  ${formatPaired("NULL CONTROL (a cell vs itself)", self)}`);
		if (self.mean !== 0 || Number.isFinite(self.t)) {
			console.log("  !! NULL CONTROL FAILED — the pairing is wrong; do not read the numbers above");
		}
		const dropped = tasks.length - complete.length;
		if (dropped > 0) {
			console.log(`\n  ${dropped} task(s) missing from at least one cell and excluded — NOT substituted with zero.`);
		}
		console.log("\n  Compare against AppWorld: residency ~$0.51 flat, representation $0.067 (low) to $0.766 (high).");
		console.log("  MCP-Bench is the mirror control — its pagination bias runs the other way.");
	} else if (selectedCells.length === 4) {
		console.log(`\n  Only ${complete.length} task(s) complete across all 4 cells — too few to pair. No statistics reported.`);
	}
	console.log("");
	process.exit(0);
}

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
