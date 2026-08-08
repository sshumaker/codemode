#!/usr/bin/env node
/**
 * Hill-climb the codemode preamble.
 *
 *   bench/hillclimb.mjs <env-file> <model> [--variants v1,v3,v4] [--tasks 4]
 *
 * Runs each variant over the SAME fixed task set and reports turns, cost, and
 * judge score against the v1 baseline. Fixed tasks matter more than sample size
 * here: a variant that looks better because it drew easier tasks is worse than
 * no measurement at all.
 *
 * Resumable — an existing run for a (task, variant) pair is skipped, so adding
 * a variant costs only that variant's runs.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VARIANT_NAMES } from "./prompts.mjs";
import { sampleTasks } from "./tasks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, ".run/runs");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const [envFile, model] = positional;

if (!envFile || !model) {
	console.error("usage: bench/hillclimb.mjs <env-file> <model> [--variants v1,v3] [--tasks 4]");
	process.exit(2);
}

const variants = flag("variants", VARIANT_NAMES.join(",")).split(",").map((v) => v.trim());
const perTier = Number(flag("tasks", 2));
const timeout = flag("timeout", "900");
const maxCost = flag("max-cost", "2.0");

const tasks = sampleTasks(perTier);
const runId = (taskId, variant) =>
	`${taskId}__codemode__L0${variant === "v1" ? "" : `__${variant}`}__${model.replace(/[^a-z0-9]/gi, "-")}`;

console.log(`hillclimb: ${variants.length} variants x ${tasks.length} tasks = ${variants.length * tasks.length} runs\n`);

function runOne(task, variant) {
	return new Promise((resolve) => {
		const id = runId(task.id, variant);
		if (existsSync(join(RUNS, id, "result.json"))) {
			console.log(`  skip  ${variant.padEnd(4)} ${task.id}`);
			return resolve();
		}
		const child = spawn(
			"node",
			[
				join(ROOT, "bench/run-task.mjs"),
				envFile,
				model,
				task.id,
				"codemode",
				"--residency",
				"L0",
				"--prompt",
				variant,
				"--timeout",
				timeout,
				"--max-cost",
				maxCost,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("close", () => {
			console.log(`  ${out.split("\n").find((l) => l.includes("turns,")) ?? "(no output)"}`);
			resolve();
		});
	});
}

for (const variant of variants) {
	console.log(`\n--- ${variant} ---`);
	for (const task of tasks) await runOne(task, variant);
}

// --- report -------------------------------------------------------------------
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const rows = [];
for (const variant of variants) {
	const results = tasks
		.map((t) => join(RUNS, runId(t.id, variant), "result.json"))
		.filter((p) => existsSync(p))
		.map((p) => JSON.parse(readFileSync(p, "utf8")))
		.filter((r) => r.summary.stopReason === "completed" || !r.summary.timedOut);
	if (results.length === 0) continue;
	rows.push({
		variant,
		runs: results.length,
		avgTurns: +mean(results.map((r) => r.summary.turns)).toFixed(1),
		avgCost: +mean(results.map((r) => r.summary.cost)).toFixed(3),
		avgSec: Math.round(mean(results.map((r) => r.summary.wallMs / 1000))),
		avgScore: results.some((r) => r.judge)
			? +mean(results.filter((r) => r.judge).map((r) => r.judge.overall)).toFixed(2)
			: "—",
	});
}

const base = rows.find((r) => r.variant === "v1");
for (const r of rows) {
	if (!base) break;
	r["turns vs v1"] = `${((r.avgTurns / base.avgTurns - 1) * 100).toFixed(0)}%`;
	r["cost vs v1"] = `${((r.avgCost / base.avgCost - 1) * 100).toFixed(0)}%`;
}

console.log("\n");
console.table(rows);
console.log("Negative percentages are improvements. Run bench/judge.mjs for scores.\n");
