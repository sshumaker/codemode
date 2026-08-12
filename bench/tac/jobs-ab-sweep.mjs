#!/usr/bin/env node
/**
 * Paired ON/OFF sweep of the jobs runtime over TheAgentCompany tasks.
 *
 *   node bench/tac/jobs-ab-sweep.mjs <env-file> --tasks a,b --reps 3 [--conditions on,off]
 *
 * The independent variable here is `HARNESS_JOBS_RUNTIME`, not the arm: both
 * conditions are codemode, and the only difference is whether `jobs` is staged and
 * the in-process anti-patterns are guarded. `sweep.mjs` varies the arm instead, so
 * it cannot express this design.
 *
 * Strictly sequential, for the reason documented in sweep.mjs: every `init.sh`
 * calls `reset.sh`, which wipes the shared company services. Two concurrent tasks
 * corrupt each other's world, and because the grader reads that world it surfaces
 * as a *score* rather than an error.
 *
 * Ordering is task-major and ON/OFF adjacent — `t1 r1 ON, t1 r1 OFF, t1 r2 ON, …` —
 * so each pair is contemporaneous (services drift over a ten-hour sweep) and only
 * one ~2.5GB task image is resident at a time.
 *
 * Housekeeping is deliberately narrow: `run-task.mjs` already removes its own
 * container with `-v`, so the anonymous volume goes with it, and this driver only
 * ever names the task image it just finished with. It does NOT run
 * `docker volume prune` / `container prune` — that pair once deleted the stopped
 * GitLab and ownCloud containers and Plane's pgdata volume, and there is no local
 * backup.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LOGS = join(ROOT, ".run/tac-logs");

const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 ? argv[i + 1] : d;
};
const envFile = argv.find((a) => !a.startsWith("--") && (a.includes("/") || a.includes(".env")));
if (!envFile) {
	console.error("usage: jobs-ab-sweep.mjs <env-file> --tasks a,b --reps 3 [--conditions on,off] [--prefix a1]");
	process.exit(2);
}

const tasks = flag("tasks", "").split(",").filter(Boolean);
const reps = Number(flag("reps", 3));
// The first rep of the first task is normally run by hand and read end to end
// before anything is scaled, so the driver has to be able to start at rep 2.
const repStart = Number(flag("rep-start", 1));
const conditions = flag("conditions", "on,off").split(",");
const prefix = flag("prefix", "a1");
const timeout = flag("timeout", "3000");
const model = flag("model", "anthropic/claude-opus-5");
if (!tasks.length) {
	console.error("--tasks is required");
	process.exit(2);
}

mkdirSync(LOGS, { recursive: true });

const sh = (cmd) =>
	new Promise((resolve) => {
		const c = spawn("bash", ["-c", cmd], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		c.stdout.on("data", (d) => (out += d));
		c.on("close", () => resolve(out.trim()));
	});

const diskPct = async () =>
	Number(await sh("colima ssh -- df -h /var/lib/docker 2>/dev/null | awk 'NR==2{print $5}' | tr -d '%'"));

/**
 * One run, with its stdout tee'd to a per-run log.
 *
 * The log is the only place the condition banner ("jobs runtime: ON|OFF") and the
 * pre-flight line live, and both are needed to diagnose an INVALID run after the
 * container is gone.
 */
function runOne({ task, condition, rep }) {
	const runId = `${prefix}__${task}__${condition}__r${rep}`;
	const logPath = join(LOGS, `${runId}.log`);
	const fd = openSync(logPath, "a");
	const env = { ...process.env };
	if (condition === "on") env.HARNESS_JOBS_RUNTIME = "1";
	else delete env.HARNESS_JOBS_RUNTIME;
	return new Promise((resolve) => {
		const child = spawn(
			"node",
			[join(ROOT, "bench/tac/run-task.mjs"), envFile, task,
			 "--arm", "codemode", "--model", model, "--timeout", timeout,
			 "--run-id", runId, "--overwrite", "1"],
			{ stdio: ["ignore", fd, fd], env },
		);
		child.on("close", (code) => resolve({ runId, code, logPath }));
	});
}

/** Read back what the run certified about itself. */
function verdict(runId) {
	const p = join(ROOT, ".run/tac", runId, "result.json");
	if (!existsSync(p)) return { runId, missing: true };
	const r = JSON.parse(readFileSync(p, "utf8"));
	return {
		runId,
		valid: r.integrity?.valid ?? null,
		reasons: r.integrity?.reasons ?? [],
		graded: r.graded,
		score: r.score ? `${r.score.result}/${r.score.total}` : "—",
		turns: r.summary?.turns ?? null,
		cost: r.summary?.cost ?? null,
		timedOut: r.summary?.timedOut ?? null,
	};
}

const started = Date.now();
const done = [];

for (const task of tasks) {
	for (let rep = repStart; rep <= reps; rep++) {
		for (const condition of conditions) {
			const pct = await diskPct();
			// 82% is where the watchdog reclaims; past 90% the *services* start
			// failing and every later task records UNGRADED with nothing saying why.
			if (Number.isFinite(pct) && pct >= 88) {
				console.log(`!! docker disk ${pct}% — refusing to start ${task}/${condition}/r${rep}`);
				console.log("   free space, then re-run: this driver skips nothing, it stops.");
				process.exit(1);
			}
			const t0 = Date.now();
			process.stdout.write(`[${new Date().toISOString()}] ${task} ${condition} r${rep} (disk ${pct}%) … `);
			const { runId, code } = await runOne({ task, condition, rep });
			const v = verdict(runId);
			done.push({ ...v, task, condition, rep, secs: (Date.now() - t0) / 1000, exit: code });
			console.log(
				`${v.valid === false ? "INVALID" : v.graded ? v.score : "UNGRADED"} ` +
					`turns=${v.turns} $${(v.cost ?? 0).toFixed(2)} ${((Date.now() - t0) / 60000).toFixed(1)}min` +
					(v.valid === false ? `\n    reasons: ${v.reasons.join("; ")}` : ""),
			);
		}
	}
	// Both conditions and every rep are finished with this image now.
	await sh(`docker rmi -f ghcr.io/theagentcompany/${task}-image:1.0.0 2>/dev/null`);
	console.log(`  (dropped ${task} image; disk ${await diskPct()}%)`);
}

console.log(`\n=== ${((Date.now() - started) / 60000).toFixed(1)} min, ${done.length} runs ===`);
console.table(done.map(({ reasons, ...r }) => r));
const invalid = done.filter((r) => r.valid === false);
if (invalid.length) {
	console.log(`\n${invalid.length} INVALID run(s) — their numbers must not enter any comparison:`);
	for (const r of invalid) console.log(`  ${r.runId}: ${r.reasons.join("; ")}`);
}
