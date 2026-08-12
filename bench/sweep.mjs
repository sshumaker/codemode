#!/usr/bin/env node
/**
 * Run a task sample across both arms and report.
 *
 *   bench/sweep.mjs <env-file> <model> [--tasks 6] [--arms vanilla,codemode]
 *                   [--residency L0] [--timeout 420] [--tier single]
 *
 * Sequential by design: the MCP servers are shared local processes and several
 * bind fixed ports, so concurrent runs would contend and produce failures that
 * look like agent errors.
 *
 * Resumable — a task/arm whose result.json already exists is skipped, so an
 * interrupted sweep continues rather than re-spending tokens.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.mjs";
import { sampleTasks, loadTasks } from "./tasks.mjs";

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
	console.error("usage: bench/sweep.mjs <env-file> <model> [--tasks N] [--arms a,b] [--residency L0]");
	process.exit(2);
}

const perTier = Number(flag("tasks", 2));
const arms = flag("arms", "vanilla,codemode").split(",");
const residency = flag("residency", "L0");
// Vanilla can also run deferred (L1); default stays the naive L4 baseline.
const vanillaResidency = flag("vanilla-residency", "L4");
const timeout = flag("timeout", "420");
const tier = flag("tier", null);
// Runs are latency-bound, so wall-clock scales close to linearly with this.
const concurrency = Number(flag("concurrency", 1));
// Best measured configuration on Opus — see CLAUDE.md.
const codemodePrompt = flag("prompt", "q8");
const vanillaPrompt = flag("vanilla-prompt", "w2");
const nsMode = flag("ns", "delta");
// 0 disables the cap. It was never forwarded to run-task, so every run silently
// used run-task's $1 default and truncated — a cap that is not passed through is
// worse than no cap, because the runs look complete.
const maxCost = flag("max-cost", "0");

/**
 * Restrict the sweep to a named subset of the sampled tasks.
 *
 * Used to repair budget censoring: a capped run's cost is truncated, so the fix is
 * to re-run the affected tasks at a higher cap — but only those tasks, and in every
 * cell, since a cap that is never reached has no effect on the run while a cap that
 * differs *between* cells of one contrast changes the treatment.
 *
 * Declared here, above the task selection that uses it. It was first written next
 * to `tag` further down, which put it in a temporal dead zone: `node --check`
 * passes, the file only throws at run time, and because the edit landed while a
 * sweep was in flight the two cells that had not yet started spawned into it and
 * died on load. Nothing in the log said "cells 3 and 4 never ran" — the wrapper
 * printed ALL CELLS COMPLETE over two exit-1 cells.
 */
const onlyTasks = flag("only-tasks", "").split(",").map((s) => s.trim()).filter(Boolean);

const sampled = tier
	? loadTasks({ tier }).sort((a, b) => a.id.localeCompare(b.id)).slice(0, perTier)
	: sampleTasks(perTier);
// Filter, never substitute: --only-tasks names a subset of the same deterministic
// sample, so the tasks it selects are the identical ones the full sweep would run.
const tasks = onlyTasks.length > 0 ? sampled.filter((t) => onlyTasks.includes(t.id)) : sampled;
if (onlyTasks.length > 0) {
	const missing = onlyTasks.filter((n) => !sampled.some((t) => t.id === n));
	if (missing.length > 0) {
		console.error(`--only-tasks names tasks outside this sample: ${missing.join(",")}`);
		process.exit(2);
	}
	console.log(`--only-tasks: ${tasks.length} of ${sampled.length} sampled tasks`);
}

console.log(`sweep: ${tasks.length} tasks x ${arms.length} arms = ${tasks.length * arms.length} runs`);
console.log(`model: ${model}  residency(codemode): ${residency}\n`);

/** Residency label per arm; notools has none, vanilla is always L4. */
const levelFor = (arm) => (arm === "codemode" ? residency : arm === "notools" ? "none" : vanillaResidency);

/**
 * Must match run-task.mjs exactly, prompt suffix included. When it did not, the
 * skip check never matched, sweep spawned anyway, and run-task's overwrite guard
 * refused — 51 of 76 runs bounced with "run already exists" and the sweep
 * reported success.
 */
const promptSuffix = (arm) =>
	arm === "codemode" ? (codemodePrompt === "v1" ? "" : `__${codemodePrompt}`)
	: arm === "vanilla" ? (vanillaPrompt === "w1" ? "" : `__${vanillaPrompt}`)
	: "";

/**
 * Optional namespace suffix for one experiment's runs.
 *
 * MCP-Bench talks to live servers, so a result.json from three days ago is not
 * interchangeable with one from today: payload sizes move as the upstream data
 * moves, and cost follows payload size. The resume-on-existing behaviour is
 * therefore a hazard for a *factorial* — the cells that happened to have been run
 * before get old API state and the new cells get today's, which puts a confound on
 * exactly the axis being varied. Tagging gives one experiment its own namespace so
 * every cell is fresh and contemporaneous, without deleting any history.
 */
const tag = flag("tag", "");


const runId = (task, arm) =>
	`${task.id}__${arm}__${levelFor(arm)}${promptSuffix(arm)}__${model.replace(/[^a-z0-9]/gi, "-")}${tag ? `__${tag}` : ""}`;

function runOne(task, arm) {
	return new Promise((resolve) => {
		const id = runId(task, arm);
		if (existsSync(join(RUNS, id, "result.json"))) {
			console.log(`  skip (done)  ${arm.padEnd(8)} ${task.id}`);
			return resolve();
		}
		const args = [
			join(ROOT, "bench/run-task.mjs"),
			envFile,
			model,
			task.id,
			arm,
			"--residency",
			levelFor(arm),
			// Pass the id rather than letting run-task.mjs re-derive it. Two copies of
			// one naming scheme is the bug that silently overwrote already-reported v1
			// runs; here it meant --tag changed sweep's existence check but not the
			// directory actually written, so every tagged run was refused by run-task's
			// own overwrite guard as "already exists" and the sweep did nothing.
			"--run-id",
			id,
			"--timeout",
			timeout,
			"--max-cost",
			maxCost,
			...(arm === "codemode" ? ["--prompt", codemodePrompt] : []),
			...(arm === "vanilla" ? ["--vanilla-prompt", vanillaPrompt] : []),
		];
		const child = spawn("node", args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, HARNESS_SHOW_NAMESPACE: nsMode },
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("close", () => {
			const line = out.split("\n").find((l) => l.includes("turns,")) ?? out.trim().split("\n")[0] ?? "(no output)";
			console.log(`  ${line}`);
			resolve();
		});
	});
}

const jobs = tasks.flatMap((task) => arms.map((arm) => ({ task, arm })));
console.log(`concurrency: ${concurrency}\n`);
let done = 0;
await pool(
	jobs,
	({ task, arm }) => runOne(task, arm),
	concurrency,
	() => {
		done++;
		if (concurrency > 1) process.stderr.write(`  [${done}/${jobs.length}]\n`);
	},
);

// --- report -------------------------------------------------------------------

const mcpLog = join(ROOT, ".run/mcp-calls.jsonl");
const calls = existsSync(mcpLog)
	? readFileSync(mcpLog, "utf8")
			.split("\n")
			.filter((l) => l.startsWith("{"))
			.map((l) => JSON.parse(l))
			.filter((r) => r.kind === "call")
	: [];

/** MCP transport success is not task success — many servers return an error payload. */
const looksLikeError = (preview) =>
	/"error"|status code [45]\d\d|\bexception\b|not found|unauthorized|forbidden/i.test(preview ?? "");

const rows = [];
for (const task of tasks) {
	for (const arm of arms) {
		const dir = join(RUNS, runId(task, arm));
		if (!existsSync(join(dir, "result.json"))) continue;
		const r = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
		const s = r.summary;
		const mine = calls.filter((c) => c.meta?.runId === r.runId);
		const contentErrors = mine.filter((c) => c.ok && looksLikeError(c.resultPreview)).length;
		rows.push({
			task: task.id.slice(0, 30),
			arm: `${r.arm}/${r.residency}`,
			turns: s.turns,
			calls: s.toolCalls,
			mcp: mine.length,
			mcpBad: mine.filter((c) => !c.ok).length + contentErrors,
			toolErr: s.toolErrors,
			tokens: s.input + s.output + s.cacheRead + s.cacheWrite,
			cost: +s.cost.toFixed(4),
			sec: Math.round(s.wallMs / 1000),
			status: s.timedOut ? "TIMEOUT" : "ok",
		});
	}
}

console.log("\n");
console.table(rows);

const agg = {};
for (const row of rows) {
	const a = (agg[row.arm] ??= { runs: 0, turns: 0, mcp: 0, tokens: 0, cost: 0, sec: 0, timeouts: 0, noMcp: 0 });
	a.runs++;
	a.turns += row.turns;
	a.mcp += row.mcp;
	a.tokens += row.tokens;
	a.cost += row.cost;
	a.sec += row.sec;
	if (row.status === "TIMEOUT") a.timeouts++;
	if (row.mcp === 0) a.noMcp++;
}
console.log("per-arm totals:");
console.table(
	Object.entries(agg).map(([arm, a]) => ({
		arm,
		runs: a.runs,
		avgTurns: +(a.turns / a.runs).toFixed(1),
		avgMcpCalls: +(a.mcp / a.runs).toFixed(1),
		"runs w/o MCP": a.noMcp,
		avgTokens: Math.round(a.tokens / a.runs),
		totalCost: `$${a.cost.toFixed(2)}`,
		avgSec: Math.round(a.sec / a.runs),
		timeouts: a.timeouts,
	})),
);
