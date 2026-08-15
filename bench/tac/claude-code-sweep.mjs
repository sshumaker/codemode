#!/usr/bin/env node
/**
 * Run Claude Code on the tasks where our two arms disagreed.
 *
 *   bench/tac/claude-code-sweep.mjs <env-file> [--wait] [--n 10] [--controls 3]
 *
 * A third arm is only worth its cost where it can settle something. On a task
 * both our arms fully solve, Claude Code tells us the task was easy; on one both
 * fail, that the task is hard or broken. Neither is worth $4. The tasks where
 * codemode and vanilla diverge are the ones where "which representation is
 * better" has an actual answer, and an independent harness is the tiebreaker.
 *
 * A few agreement cases are still included as controls. Without them a
 * disagreement-only subset is unfalsifiable: if Claude Code scores badly across
 * the board we could not tell a weak harness from a subset selected for
 * difficulty. The controls calibrate that.
 *
 * `--wait` blocks until the main sweep exits. The two cannot overlap — every
 * task's init.sh resets the shared services, so a concurrent run corrupts the
 * other's world and shows up as a score rather than an error.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeArgv } from "../argv.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNS = join(ROOT, ".run/tac");

const argv = process.argv.slice(2);
const { flag } = makeArgv(argv);
const envFile = argv.find((a) => !a.startsWith("--") && (a.includes("/") || a.includes(".env")));
if (!envFile) {
	console.error("usage: bench/tac/claude-code-sweep.mjs <env-file> [--wait] [--n 10] [--controls 3]");
	process.exit(2);
}
const nDisagree = Number(flag("n", 10));
const nControls = Number(flag("controls", 3));

const sh = (cmd) =>
	new Promise((resolve) => {
		const c = spawn("bash", ["-c", cmd], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		c.stdout.on("data", (d) => (out += d));
		c.on("close", () => resolve(out.trim()));
	});

if (argv.includes("--wait")) {
	console.log("waiting for the main sweep to finish (services cannot be shared)…");
	for (;;) {
		if ((await sh("pgrep -f 'tac/sweep.mjs' | head -1")) === "") break;
		await new Promise((r) => setTimeout(r, 60_000));
	}
	console.log("main sweep done.\n");
}

/** Collect per-task, per-arm score fractions from the completed runs. */
function collect() {
	const byTask = new Map();
	for (const dir of readdirSync(RUNS)) {
		const f = join(RUNS, dir, "result.json");
		if (!existsSync(f)) continue;
		let r;
		try {
			r = JSON.parse(readFileSync(f, "utf8"));
		} catch {
			continue;
		}
		if (!r.graded || !r.score?.total) continue;
		if (r.arm !== "codemode" && r.arm !== "vanilla") continue;
		if (!byTask.has(r.task)) byTask.set(r.task, {});
		byTask.get(r.task)[r.arm] = { frac: r.score.result / r.score.total, ...r.score, cost: r.summary?.cost ?? 0 };
	}
	return byTask;
}

const byTask = collect();
const paired = [...byTask.entries()].filter(([, v]) => v.codemode && v.vanilla);
if (paired.length === 0) {
	console.error("no paired results yet — run the main sweep first");
	process.exit(1);
}

const scored = paired.map(([task, v]) => ({
	task,
	cm: v.codemode.frac,
	van: v.vanilla.frac,
	gap: Math.abs(v.codemode.frac - v.vanilla.frac),
}));

const disagree = scored.filter((s) => s.gap > 0).sort((a, b) => b.gap - a.gap).slice(0, nDisagree);
const chosen = new Set(disagree.map((s) => s.task));

// Controls, split between "both solved" and "both failed" so the subset cannot
// be read as selected purely for difficulty.
const agree = scored.filter((s) => s.gap === 0 && !chosen.has(s.task));
const bothSolved = agree.filter((s) => s.cm === 1).slice(0, Math.ceil(nControls / 2));
const bothFailed = agree.filter((s) => s.cm === 0).slice(0, Math.floor(nControls / 2));
for (const s of [...bothSolved, ...bothFailed]) chosen.add(s.task);

console.log(`${paired.length} paired tasks available`);
console.log(`\ndisagreement (${disagree.length}):`);
for (const s of disagree) console.log(`  ${s.task.padEnd(48)} cm ${s.cm.toFixed(2)}  van ${s.van.toFixed(2)}  gap ${s.gap.toFixed(2)}`);
console.log(`\ncontrols (${bothSolved.length + bothFailed.length}):`);
for (const s of [...bothSolved, ...bothFailed]) console.log(`  ${s.task.padEnd(48)} both ${s.cm.toFixed(2)}`);

const tasks = [...chosen];
console.log(`\nrunning claude-code on ${tasks.length} tasks, sequential\n`);

const results = [];
for (const [i, task] of tasks.entries()) {
	const t0 = Date.now();
	await new Promise((resolve) => {
		const c = spawn("node", [join(ROOT, "bench/tac/run-claude-code.mjs"), envFile, task], {
			stdio: ["ignore", "inherit", "inherit"],
		});
		c.on("close", resolve);
	});
	const f = join(RUNS, `tac__${task}__claude-code__native__claude-code`, "result.json");
	let row = { task, secs: (Date.now() - t0) / 1000 };
	if (existsSync(f)) {
		const r = JSON.parse(readFileSync(f, "utf8"));
		row = { ...row, graded: r.graded, result: r.score?.result ?? null, total: r.score?.total ?? null, cost: r.summary?.cost ?? 0 };
	}
	results.push(row);
	console.log(`  [${i + 1}/${tasks.length}] ${task}: ${row.graded ? `${row.result}/${row.total}` : "UNGRADED"} ($${(row.cost ?? 0).toFixed(2)})\n`);

	// Same reclaim discipline as the main sweep; the disk filling is what killed
	// the first attempt.
	await sh(`docker rmi -f ghcr.io/theagentcompany/${task}-image:1.0.0 2>/dev/null; docker volume prune -f 2>/dev/null`);
}

console.log("\n=== three-way, on the disagreement subset ===\n");
console.log(`${"task".padEnd(48)} ${"cm".padEnd(7)} ${"van".padEnd(7)} claude-code`);
let ccCost = 0;
for (const row of results) {
	const v = byTask.get(row.task);
	const cc = row.graded ? (row.result / row.total).toFixed(2) : "UNGRADED";
	ccCost += row.cost ?? 0;
	console.log(
		`${row.task.slice(0, 48).padEnd(48)} ${v.codemode.frac.toFixed(2).padEnd(7)} ${v.vanilla.frac.toFixed(2).padEnd(7)} ${cc}`,
	);
}
const graded = results.filter((r) => r.graded);
const ccMean = graded.reduce((s, r) => s + r.result / r.total, 0) / (graded.length || 1);
const cmMean = graded.reduce((s, r) => s + byTask.get(r.task).codemode.frac, 0) / (graded.length || 1);
const vanMean = graded.reduce((s, r) => s + byTask.get(r.task).vanilla.frac, 0) / (graded.length || 1);
console.log(
	`\nmeans over ${graded.length} graded: codemode ${cmMean.toFixed(3)}, vanilla ${vanMean.toFixed(3)}, claude-code ${ccMean.toFixed(3)}`,
);
console.log(`claude-code cost $${ccCost.toFixed(2)}`);
console.log("\nNote: this subset is selected for disagreement, so these means are NOT");
console.log("comparable to the full-set means — they are a tiebreaker, not a ranking.");
