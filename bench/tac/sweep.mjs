#!/usr/bin/env node
/**
 * Run a set of TheAgentCompany tasks through both arms.
 *
 *   bench/tac/sweep.mjs <env-file> [--tasks a,b,c] [--limit 20] [--arms codemode,vanilla]
 *
 * Sequential by design, and that is not a missing feature.
 *
 * Every task's `init.sh` calls `reset.sh`, which wipes and re-seeds the shared
 * GitLab / ownCloud / Plane / RocketChat instances. Two tasks touching the same
 * service cannot run at the same time without corrupting each other's world —
 * and since the grader inspects that world afterwards, the corruption would show
 * up as a score, not as an error. Parallelism here would need one service stack
 * per worker (~30GB and 17 containers each), which is a deliberate decision to
 * make, not something to default into.
 *
 * Arms alternate per task rather than running all of one then all of the other,
 * so any drift in service state over a long sweep hits both arms evenly.
 */
import { spawn } from "node:child_process";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TASKS_DIR = join(ROOT, "vendor/TheAgentCompany/workspaces/tasks");

const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 ? argv[i + 1] : d;
};
const envFile = argv.find((a) => !a.startsWith("--") && (a.includes("/") || a.includes(".env")));
if (!envFile) {
	console.error("usage: bench/tac/sweep.mjs <env-file> [--tasks a,b] [--limit 20] [--arms codemode,vanilla]");
	process.exit(2);
}

const arms = flag("arms", "codemode,vanilla").split(",");
const limit = Number(flag("limit", 0));
const explicit = flag("tasks", "");
const model = flag("model", "anthropic/claude-opus-5");

let tasks = explicit
	? explicit.split(",")
	: readdirSync(TASKS_DIR).filter((d) => existsSync(join(TASKS_DIR, d, "task.md"))).sort();
if (limit > 0) tasks = tasks.slice(0, limit);

console.log(`${tasks.length} tasks × ${arms.length} arms, sequential (shared services)\n`);

const started = Date.now();
const results = [];

for (const [i, task] of tasks.entries()) {
	// Headroom first. Reclaiming only after a task is too late: the disk went
	// 78% -> 97% in four minutes while pulling one GitLab task image, and the
	// watchdog rightly halted the sweep mid-run. Pruning everything unused before
	// a task costs a re-pull at worst; not pruning costs the run.
	await ensureHeadroom();

	for (const arm of arms) {
		const t0 = Date.now();
		const code = await new Promise((resolve) => {
			const child = spawn(
				"node",
				[join(ROOT, "bench/tac/run-task.mjs"), envFile, task, "--arm", arm, "--model", model,
				 ...(flag("overwrite", "") ? ["--overwrite", flag("overwrite")] : [])],
				{ stdio: ["ignore", "inherit", "inherit"] },
			);
			child.on("close", resolve);
		});
		const runId = `tac__${task}__${arm}__${arm === "codemode" ? "t1" : "w1"}__${model.replace(/\//g, "-")}`;
		const path = join(ROOT, ".run/tac", runId, "result.json");
		let row = { task, arm, ok: code === 0, secs: (Date.now() - t0) / 1000 };
		if (existsSync(path)) {
			const r = JSON.parse(readFileSync(path, "utf8"));
			row = { ...row, graded: r.graded, result: r.score?.result ?? null, total: r.score?.total ?? null, cost: r.summary?.cost ?? 0, turns: r.summary?.turns ?? 0 };
		}
		results.push(row);
		console.log(`  [${i + 1}/${tasks.length}] ${task} ${arm}: ${row.graded ? `${row.result}/${row.total}` : "UNGRADED"} (${row.secs.toFixed(0)}s)\n`);
	}

	// Reclaim after both arms are done with this task's image.
	//
	// Not housekeeping — the first attempt at this sweep filled the VM's 98GB
	// docker disk by task 8 and took the whole company down with it: GitLab and
	// ownCloud stopped answering, MongoDB and Plane went into restart loops, and
	// every subsequent task recorded UNGRADED. Task images are ~1.5GB each and
	// every task container spawns an anonymous volume from the image's VOLUME
	// directive; 33 tasks in, those volumes alone held 54GB.
	//
	// upstream's run_eval.sh prunes after every task for exactly this reason.
	await reclaim(task);
}

/**
 * Prune every unused task image when the disk is tight, before the next pull.
 *
 * Deliberately more aggressive than the per-task reclaim: task images are ~1.5GB
 * and the GitLab-backed ones far larger, so "remove just the one we finished"
 * cannot keep up with a large pull that has not happened yet.
 */
async function ensureHeadroom() {
	const shq = (cmd) =>
		new Promise((resolve) => {
			const c = spawn("bash", ["-c", cmd], { stdio: ["ignore", "pipe", "ignore"] });
			let out = "";
			c.stdout.on("data", (d) => (out += d));
			c.on("close", () => resolve(out.trim()));
		});
	const pct = Number(await shq("colima ssh -- df -h /var/lib/docker 2>/dev/null | awk 'NR==2{print $5}' | tr -d '%'"));
	// 50%, not 65%. A GitLab-backed task image took the disk from 61% to 97% in
	// one pull, so the threshold has to leave room for the largest image in the
	// set rather than the average one.
	if (!Number.isFinite(pct) || pct < 50) return;
	console.log(`  (disk ${pct}% before task — pruning unused task images)`);
	await shq("docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'theagentcompany/.*-image:' | xargs -r -n1 docker rmi -f 2>/dev/null; docker volume prune -f 2>/dev/null; docker container prune -f 2>/dev/null");
	const after = await shq("colima ssh -- df -h /var/lib/docker 2>/dev/null | awk 'NR==2{print $5}'");
	console.log(`  (disk after prune: ${after})`);
}

/** Drop this task's image and any stranded volumes, then report headroom. */
async function reclaim(task) {
	const sh = (cmd) =>
		new Promise((resolve) => {
			const c = spawn("bash", ["-c", cmd], { stdio: ["ignore", "pipe", "ignore"] });
			let out = "";
			c.stdout.on("data", (d) => (out += d));
			c.on("close", () => resolve(out.trim()));
		});

	await sh(`docker rmi -f ghcr.io/theagentcompany/${task}-image:1.0.0 2>/dev/null`);
	await sh("docker volume prune -f 2>/dev/null");
	const used = await sh("colima ssh -- df -h /var/lib/docker 2>/dev/null | awk 'NR==2{print $5}' | tr -d '%'");
	const pct = Number(used);
	if (Number.isFinite(pct)) {
		if (pct >= 90) {
			// Past this the services start failing rather than the sweep, and the
			// failure is attributed to the arm. Say so loudly.
			console.log(`  !! docker disk ${pct}% full — services will start failing; prune images before continuing`);
		} else if (pct >= 75) {
			console.log(`  (docker disk ${pct}% full)`);
		}
	}
}

console.log(`\n=== ${((Date.now() - started) / 60000).toFixed(1)} min ===\n`);
for (const arm of arms) {
	// Only graded runs count. A grader crash is a missing measurement, and
	// averaging it in as a zero would punish whichever arm happened to hit it.
	const rows = results.filter((r) => r.arm === arm && r.graded);
	const got = rows.reduce((s, r) => s + r.result, 0);
	const max = rows.reduce((s, r) => s + r.total, 0);
	const solved = rows.filter((r) => r.result === r.total).length;
	const cost = rows.reduce((s, r) => s + r.cost, 0);
	console.log(
		`${arm.padEnd(9)} ${max ? ((got / max) * 100).toFixed(1) : "0.0"}% checkpoints (${got}/${max}), ` +
			`${solved}/${rows.length} fully solved, $${cost.toFixed(2)}, ${results.filter((r) => r.arm === arm && !r.graded).length} ungraded`,
	);
}
