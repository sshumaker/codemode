/**
 * The end of a session, end to end: a real deadline passes while the agent waits on
 * long-running jobs. The scheduler wakes it once to wrap up, ends the session when that
 * turn returns, and reaps every process the session started — checked by pid AND start
 * time, so a recycled pid can never pass for a survivor or a corpse.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SCRIPTS, identityAlive, kernelsUnder, missingPrereqs, processesUnder, readJson, scenario, sleep, startTimes, until } from "./lib.mjs";

const missing = missingPrereqs();
const skip = missing.length ? missing.join("; ") : false;

/** Live child processes of `pid`, as identities. */
function childrenOf(pid) {
	const r = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
	const kids = (r.stdout ?? "")
		.split("\n")
		.map((l) => l.trim().split(/\s+/).map(Number))
		.filter(([, ppid]) => ppid === pid)
		.map(([p]) => p);
	const times = startTimes(kids);
	return kids.filter((p) => times[p]).map((p) => ({ pid: p, start: times[p] }));
}

/** Every live process in these process groups, as {pid, start} identities. */
function groupMembers(pgids) {
	const r = spawnSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" });
	const pids = (r.stdout ?? "")
		.split("\n")
		.map((l) => l.trim().split(/\s+/).map(Number))
		.filter(([pid, pgid]) => pid && pgids.includes(pgid))
		.map(([pid]) => pid);
	const times = startTimes(pids);
	return pids.filter((p) => times[p]).map((pid) => ({ pid, start: times[pid] }));
}

describe("integration: session lifecycle", { skip }, () => {
	it("deadline: one wrap-up wake, then the session ends and its process tree is reaped", { timeout: 180_000 }, async () => {
		const n = randomBytes(3).toString("hex");
		const deadline = Date.now() / 1000 + 15;
		await scenario("deadline", { script: join(SCRIPTS, "deadline.json"), vars: { NONCE: n }, session: { deadline, deadline_grace_s: 30 } }, async (w) => {
			w.post(`FOXTROT-${n} go`);
			w.startScheduler();
			await until(() => w.model.served() === 1 && !w.turn() && existsSync(join(w.session, "wake.json")), {
				what: "the first turn to end in its wait",
				timeoutMs: 60_000,
			});
			assert.ok(Date.now() / 1000 < deadline, "the first turn finished before the deadline (raise it if this machine is slow)");
			const jobs = ["long", "tree"].map((name) => readJson(join(w.jobs, `${name}.json`)));
			const pgids = jobs.map((j) => j.pgid ?? j.pid);
			const tree = groupMembers(pgids);
			assert.ok(tree.length >= 4, `both jobs and their children are running: ${JSON.stringify(tree)}`);
			// Between turns the daemon keeps exactly one helper (its session catalog): the
			// first turn's worker went with its client. Anything else at the end is a leak.
			const [daemon] = w.daemons();
			const helpers = childrenOf(daemon.pid);
			assert.equal(helpers.length, 1, `between turns the daemon has only its catalog helper: ${JSON.stringify(helpers)}`);

			await until(() => readJson(join(w.session, "end.json"))?.state === "ended", {
				what: "the session to end",
				timeoutMs: 60_000,
			});
			assert.ok(Date.now() / 1000 >= deadline);
			// Ended sessions are never woken: a message now changes nothing.
			w.post("anyone there?");
			await sleep(3000);

			assert.deepEqual(w.model.errors, []);
			assert.equal(w.model.requests.length, 2, "exactly one wrap-up turn");
			const wakes = w.wakes();
			assert.equal(wakes.length, 2, wakes.join("\n"));
			assert.match(wakes[1], /session deadline reached/);
			assert.match(w.model.requests[1].last, /Wrap up now/);

			const end = readJson(join(w.session, "end.json"));
			assert.equal(end.kind, "deadline");
			const reap = readJson(join(w.session, "reap.json"));
			assert.ok(reap, "reap.json is the evidence");
			for (const p of tree) assert.ok(!identityAlive(p), `pid ${p.pid} (${p.start}) survived the end`);
			assert.deepEqual(groupMembers(pgids), [], "nothing is left in the jobs' process groups");
			assert.deepEqual(kernelsUnder(w.roots), [], "the kernel is gone");
			assert.deepEqual(w.primeClients(), [], "no harness is running");
			const infra = [daemon, ...helpers, ...w.schedulers.map((s) => s.ident)];
			const isInfra = (p) => infra.some((i) => i.pid === p.pid && i.start === p.start);
			const left = processesUnder(w.roots).filter((p) => !isInfra(p));
			assert.deepEqual(left.map((p) => `${p.pid} ${p.command}`), [], "only the scheduler and prime's daemon (host infrastructure) remain");
			for (const j of jobs) assert.notEqual(readJson(join(w.jobs, `${j.name}.json`)).state, "running");
		});
	});
});
