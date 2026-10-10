/**
 * Crashes, end to end: SIGKILL the harness or the scheduler at a known point in a real
 * turn (the scripted model holds its response, so "mid-turn" is exact, not a sleep),
 * then check recovery from what is on disk and what the model is shown next.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SCRIPTS, World, identityAlive, missingPrereqs, scenario, sleep, until } from "./lib.mjs";

const missing = missingPrereqs();
const skip = missing.length ? missing.join("; ") : false;
const T = { timeout: 180_000 };

/** Sample how many prime clients run on the session, until stop() — the max must stay 1. */
function watchClients(w) {
	let max = 0;
	let on = true;
	const loop = (async () => {
		while (on) {
			max = Math.max(max, w.primeClients().length);
			await sleep(150);
		}
	})();
	return async () => {
		on = false;
		await loop;
		return max;
	};
}

describe("integration: crashes", { skip }, () => {
	it("SIGKILL of prime mid-turn: one interrupted re-wake; no message lost or repeated", T, async () => {
		const n = randomBytes(3).toString("hex");
		await scenario("prime-kill", { script: join(SCRIPTS, "prime-killed.json"), vars: { NONCE: n } }, async (w) => {
			w.post(`ALPHA-${n} first message`);
			w.startScheduler();
			await until(() => w.model.isHeld("first"), { what: "the first model call to be in flight" });
			// Sent while the turn runs, before the crash: it is pending, not in flight.
			w.post(`BRAVO-${n} second message`);
			const killed = w.turn().child;
			assert.ok(identityAlive({ pid: killed.pid }), "the harness is running");
			const stopWatch = watchClients(w);
			process.kill(killed.pid, "SIGKILL");

			await until(() => w.model.served() === 2 && !w.turn(), { what: "the recovered turn to finish", timeoutMs: 90_000 });
			await sleep(3500);
			const maxClients = await stopWatch();

			assert.deepEqual(w.model.errors, [], "the model saw what the script expected");
			assert.equal(w.model.requests.length, 2, "exactly one turn after the crash");
			assert.equal(maxClients, 1, "never two harnesses on the session");
			assert.ok(!w.model.isHeld("first"), "the killed turn's agent is gone (its model call was dropped)");

			const wakes = w.wakes();
			assert.equal(wakes.length, 2, wakes.join("\n"));
			assert.match(wakes[1], /interrupted \(crash\)/);
			const next = w.model.requests[1];
			assert.match(next.last, /previous turn was interrupted \(crash\)/, "the model is told");
			assert.equal(World.occurrences(next, `ALPHA-${n}`), 1, "the message the crashed turn received is not re-injected");
			assert.equal(World.occurrences(next, `BRAVO-${n}`), 1, "the message sent before the crash is delivered once");

			// Durable state.
			assert.deepEqual(w.inbox().map((f) => f.replace(/^.*\.json/, ".json")), [".json.delivered", ".json.delivered"]);
			const last = w.lastTurn();
			assert.equal(last.state, "done");
			assert.equal(last.recovering?.state, "interrupted", "the run that answered the crash keeps it as evidence");
			assert.equal(last.recovering.crashed.child.pid, killed.pid);
			const alphaId = last.recovering.crashed.messages[0].id;
			const received = [...(last.recovering.received ?? []), ...(last.recovering.late_received ?? [])];
			assert.deepEqual(received, [alphaId], "the crashed turn's transcript received ALPHA (at the crash, or by the re-wake)");
			assert.equal(last.recoveries, 1);
		});
	});

	it("SIGKILL of the scheduler mid-turn: no second prime; the orphan finishes; recovery settles it once", T, async () => {
		const n = randomBytes(3).toString("hex");
		await scenario("sched-kill", { script: join(SCRIPTS, "scheduler-killed.json"), vars: { NONCE: n } }, async (w) => {
			w.post(`CHARLIE-${n} go`);
			const first = w.startScheduler();
			await until(() => w.model.isHeld("first"), { what: "the first model call to be in flight" });
			const turn = w.turn();
			const stopWatch = watchClients(w);
			process.kill(first.proc.pid, "SIGKILL");
			await until(() => first.exited, { what: "the scheduler to die" });
			assert.ok(identityAlive({ pid: turn.child.pid }), "the harness outlived its scheduler");

			const second = w.startScheduler();
			await until(() => /still running/.test(second.out), { what: "the new scheduler to see the orphan", timeoutMs: 20_000 });
			await sleep(1500);
			assert.equal(w.model.requests.length, 1, "no second harness called the model");

			w.model.release("first");
			await until(() => w.model.served() === 2 && !w.turn(), { what: "the orphan's turn to be settled", timeoutMs: 60_000 });
			await sleep(3000);
			const maxClients = await stopWatch();

			assert.deepEqual(w.model.errors, []);
			assert.equal(maxClients, 1, "never two harnesses on the session");
			assert.equal(w.model.requests.length, 2, "the orphan's turn ran to the end, once");
			assert.equal(w.wakes().length, 1, "the new scheduler never woke the session");
			assert.match(second.out, /had exited 0; finished its bookkeeping/);
			const last = w.lastTurn();
			assert.equal(last.run_id, turn.run_id);
			assert.equal(last.state, "done");
			assert.equal(last.settled_by, "recovery");
			assert.deepEqual(w.inbox().map((f) => f.replace(/^.*\.json/, ".json")), [".json.delivered"]);
		});
	});
});
