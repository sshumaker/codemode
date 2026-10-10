/**
 * Waking, end to end: the real scheduler serving a real `prime -c -p` per turn, a real
 * kernel and real jobs, against the scripted model. Each scenario asserts on the
 * durable state the scheduler and runtime leave on disk AND on what the model was
 * shown in the request that opened its next turn.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SCRIPTS, missingPrereqs, scenario, sleep, until } from "./lib.mjs";

const missing = missingPrereqs();
const skip = missing.length ? missing.join("; ") : false;
const T = { timeout: 180_000 };

/** Let the scheduler scan a few more times, so "exactly once" is not "not yet twice". */
const settle = (w, scans = 6) => sleep(scans * 500 + 500);

describe("integration: wakes and owed outcomes", { skip }, () => {
	it("a job started and never waited on wakes the session once, with its outcome", T, async () => {
		const nonce = randomBytes(3).toString("hex");
		await scenario("unwaited", { script: join(SCRIPTS, "unwaited-job.json"), vars: { NONCE: nonce } }, async (w) => {
			w.post("start the background job");
			w.startScheduler();
			await until(() => w.model.served() === 3 && !w.turn(), { what: "the woken turn to finish", timeoutMs: 90_000 });
			await settle(w);

			assert.deepEqual(w.model.errors, [], "the model saw what the script expected at every turn");
			assert.equal(w.model.requests.length, 3, "no further model call after the outcome was delivered");
			const wakes = w.wakes();
			assert.equal(wakes.length, 2, `two wakes: the user message, then the job\n${wakes.join("\n")}`);
			assert.match(wakes[1], /waking s: job 'bg': succeeded \(exit 0\)/);

			// Durable state: the job's invocation is terminal and delivered, exactly once.
			const inv = w.invocations().find((r) => r.kind === "job" && r.name === "bg");
			assert.equal(inv?.state, "succeeded");
			assert.ok(inv.delivered_at, "the outcome is marked delivered");
			assert.equal(inv.delivering, null, "no delivery left in flight");
			assert.equal(w.lastTurn()?.state, "done");
			assert.deepEqual(w.lastTurn()?.invocations, [inv.id], "the woken turn carried exactly this invocation");

			// What the model was shown: the opening of turn 3 is the wake with the outcome,
			// and it appears in exactly one request's newest message.
			const shown = w.model.requests.filter((r) => r.last.includes("job 'bg': succeeded"));
			assert.equal(shown.length, 1, "the outcome opened exactly one turn");
			assert.equal(shown[0].lastRole, "user");
			assert.equal(shown[0].n, 2);
		});
	});

	it("a barrier on three jobs, one failing, wakes once carrying all three outcomes", T, async () => {
		await scenario("barrier", { script: join(SCRIPTS, "barrier.json") }, async (w) => {
			w.post("start three jobs");
			w.startScheduler();
			await until(() => w.model.served() === 2 && !w.turn(), { what: "the woken turn to finish", timeoutMs: 90_000 });
			await settle(w);

			assert.deepEqual(w.model.errors, []);
			assert.equal(w.model.requests.length, 2);
			const wakes = w.wakes();
			assert.equal(wakes.length, 2, `the user message, then ONE barrier wake\n${wakes.join("\n")}`);

			const opening = w.model.requests[1].last;
			for (const piece of [/^\[woken: all finished: /, /\ba \(succeeded \(exit 0\)\)/, /\bb \(failed \(exit 3\)\)/, /\bc \(succeeded \(exit 0\)\)/]) {
				assert.match(opening, piece, `the wake names every outcome: ${opening}`);
			}
			// The wake fired only once all three were terminal: c (the slowest) finished
			// before the woken turn started.
			const byName = Object.fromEntries(w.invocations().filter((r) => r.kind === "job").map((r) => [r.name, r]));
			assert.deepEqual(Object.keys(byName).sort(), ["a", "b", "c"]);
			assert.equal(byName.b.state, "failed");
			for (const r of Object.values(byName)) {
				assert.ok(r.delivered_at, `${r.name} delivered`);
				assert.ok(r.finished_at * 1000 <= w.model.requests[1].at, `${r.name} finished before the wake`);
			}
			assert.deepEqual([...w.lastTurn().invocations].sort(), Object.values(byName).map((r) => r.id).sort());
			assert.ok(existsSync(join(w.session, "wake.json.fired")), "the wait was consumed (wake.json.fired)");
			assert.ok(!existsSync(join(w.session, "wake.json")), "and nothing is waiting any more");
		});
	});
});

