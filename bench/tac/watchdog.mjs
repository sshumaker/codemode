#!/usr/bin/env node
/**
 * Watch the company's health while a sweep runs, and stop the sweep if it dies.
 *
 *   bench/tac/watchdog.mjs [--interval 120] [--halt]
 *
 * The first 40-task sweep filled the docker disk at task 8, took GitLab and
 * ownCloud down with it, and then spent nine more hours recording UNGRADED for
 * every remaining task. Nothing in the sweep's own output said the cause was
 * disk — each task just failed to seed. The expensive part was not the failure,
 * it was the eight hours of running after the failure.
 *
 * So this checks the two things that actually precede that collapse — free disk
 * and service health — and with `--halt` stops the sweep rather than letting it
 * grind out worthless rows. A halted sweep resumes for free: run-task.mjs skips
 * any task that already has a result.json.
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LOG = join(ROOT, ".run/tac/watchdog.log");

const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 ? argv[i + 1] : d;
};
const intervalSec = Number(flag("interval", 120));
const halt = argv.includes("--halt");

const SERVICES = { gitlab: 8929, owncloud: 8092, rocketchat: 3000, plane: 8091 };
/** Below this the services begin failing rather than the sweep. */
const DISK_CRITICAL = 90;
/** Reclaim at this point; only halt if reclaiming cannot get back under CRITICAL. */
const DISK_RECLAIM = 82;
const DISK_WARN = 75;
/** Consecutive failed checks before halting — see the note at the halt site. */
const BAD_CHECKS_BEFORE_HALT = 6;
let consecutiveBad = 0;

mkdirSync(dirname(LOG), { recursive: true });
const say = (msg) => {
	const line = `${new Date().toISOString()} ${msg}`;
	console.log(line);
	appendFileSync(LOG, `${line}\n`);
};

const sh = async (cmd) => {
	try {
		const { stdout } = await run("bash", ["-c", cmd], { timeout: 60_000 });
		return stdout.trim();
	} catch {
		return "";
	}
};

async function diskPercent() {
	const out = await sh("colima ssh -- df -h /var/lib/docker 2>/dev/null | awk 'NR==2{print $5}' | tr -d '%'");
	const n = Number(out);
	return Number.isFinite(n) ? n : null;
}

async function unhealthy() {
	const bad = [];
	for (const [name, port] of Object.entries(SERVICES)) {
		// Any HTTP response means the service is answering; 000 is curl's "no
		// connection at all", which is the failure mode that matters here.
		const code = await sh(`curl -s -o /dev/null -w '%{http_code}' -m 10 http://localhost:${port}`);
		if (code === "000" || code === "") bad.push(`${name}(${code || "no response"})`);
	}
	return bad;
}

async function sweepRunning() {
	return (await sh("pgrep -f 'tac/sweep.mjs' | head -1")) !== "";
}

async function stopSweep(why) {
	say(`HALTING SWEEP: ${why}`);
	await sh("pkill -f 'tac/sweep.mjs'; pkill -f 'tac/run-task.mjs'");
	await sh("docker rm -fv $(docker ps -aq --filter name=tac-) 2>/dev/null");
	say("sweep stopped; completed tasks keep their result.json, so a relaunch resumes where it left off");
}

say(`watchdog up (every ${intervalSec}s, halt=${halt})`);

for (;;) {
	if (!(await sweepRunning())) {
		say("no sweep running — exiting");
		break;
	}

	const pct = await diskPercent();
	const bad = await unhealthy();

	if (pct !== null && pct >= DISK_RECLAIM) {
		// Reclaim before considering a halt. Killing the sweep was the wrong first
		// move: the sde-* tasks build and run real services, so the disk grows from
		// agent activity mid-task and no amount of pre-task pruning helps. The
		// watchdog can see the problem and can fix it, so it should.
		say(`disk ${pct}% — reclaiming unused images and volumes`);
		await sh(
			"docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'theagentcompany/.*-image:' " +
				"| xargs -r -n1 docker rmi -f 2>/dev/null; docker volume prune -f 2>/dev/null; docker container prune -f 2>/dev/null",
		);
		const after = await diskPercent();
		say(`disk after reclaim: ${after ?? "?"}%`);
		if (after !== null && after >= DISK_CRITICAL) {
			say(`CRITICAL: docker disk still ${after}% after reclaiming`);
			if (halt) {
				await stopSweep(`disk ${after}% full even after reclaim — further tasks would record UNGRADED`);
				break;
			}
		}
	} else if (bad.length > 0) {
		// Require sustained failure across several checks, not one.
		//
		// A single 30s re-check was not enough and it cost a run: every task's
		// init.sh calls reset.sh, and resetting GitLab takes minutes during which
		// it answers nothing. The watchdog read a normal reset as a dead service
		// and halted a healthy sweep at task 8. Genuine death — the disk-full
		// cascade this exists to catch — persists for far longer than a reset, so
		// waiting costs nothing and false positives cost a night.
		consecutiveBad += 1;
		if (consecutiveBad < BAD_CHECKS_BEFORE_HALT) {
			say(`degraded (${consecutiveBad}/${BAD_CHECKS_BEFORE_HALT}): ${bad.join(", ")} — likely a service reset, waiting`);
		} else {
			say(`SERVICES DOWN for ${consecutiveBad} consecutive checks: ${bad.join(", ")}`);
			if (halt) {
				await stopSweep(`services down across ${consecutiveBad} checks: ${bad.join(", ")}`);
				break;
			}
		}
	} else {
		consecutiveBad = 0;
		const note = pct !== null && pct >= DISK_WARN ? ` [disk ${pct}% — prune soon]` : "";
		say(`ok — disk ${pct ?? "?"}%, all services answering${note}`);
	}

	await new Promise((r) => setTimeout(r, intervalSec * 1000));
}
