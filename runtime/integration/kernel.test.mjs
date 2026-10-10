/**
 * The kernel dies under a cell, end to end: a real ipykernel SIGKILLed (by the test,
 * or by the cell itself) while the cell is talking to a tool proxy. prime rebuilds the
 * kernel (HARNESS_KERNEL_AUTORESTART=1), never re-runs the cell, and reports the
 * cell's calls from the call journal; the invocation store folds the same journal.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SCRIPTS, kernelsUnder, missingPrereqs, scenario, sleep, startToolProxy, until } from "./lib.mjs";

const missing = missingPrereqs();
const skip = missing.length ? missing.join("; ") : false;
const T = { timeout: 180_000 };
const DELIVERY = { "fake.lookup": "read_only", "fake.*": "at_most_once" };

async function withProxy(label, script, nonce, hold, body) {
	const proxy = await startToolProxy({ hold });
	const opts = { script: join(SCRIPTS, script), vars: { NONCE: nonce }, env: { HARNESS_MCP_PROXY: proxy.url }, delivery: DELIVERY };
	await scenario(label, opts, async (w) => {
		w.cleanups.push(proxy.close);
		await body(w, proxy);
	});
}

describe("integration: a kernel that dies mid-cell", { skip }, () => {
	it("after making proxy calls: not re-run; the model sees each call completed or UNKNOWN", T, async () => {
		const n = randomBytes(3).toString("hex");
		await withProxy("kernel-death", "kernel-death.json", n, ["hang"], async (w, proxy) => {
			w.post(`DELTA-${n} go`);
			w.startScheduler();
			await until(() => proxy.count("hang") === 1, { what: "the cell's third call to reach the proxy" });
			const [kernel, ...others] = kernelsUnder(w.roots);
			assert.ok(kernel && others.length === 0, "one kernel");
			process.kill(kernel.pid, "SIGKILL");

			await until(() => w.model.served() === 2 && !w.turn(), { what: "the turn to finish", timeoutMs: 90_000 });
			await sleep(3000);

			assert.deepEqual(w.model.errors, []);
			assert.deepEqual(proxy.calls.map((c) => c.tool), ["lookup", "create", "hang"], "the cell was not re-run");
			const report = w.model.requests[1];
			assert.equal(report.lastRole, "tool", "the report is the cell's own tool result");
			assert.match(report.last, /It was not run again/);
			assert.match(report.last, /\(2 completed, 1 unknown;/);
			assert.match(report.last, /1\. proxy fake\.lookup — completed: lookup-result/);
			assert.match(report.last, /2\. proxy fake\.create — completed: create-result/);
			assert.match(report.last, /3\. proxy fake\.hang — UNKNOWN — /);
			assert.ok(!report.last.includes("never-printed"));

			// The same journal, folded into the store: terminal, and delivered by what showed it.
			const calls = Object.fromEntries(w.invocations().filter((r) => r.kind === "call").map((r) => [r.name, r]));
			assert.deepEqual(Object.keys(calls).sort(), ["fake.create", "fake.hang", "fake.lookup"]);
			assert.equal(calls["fake.lookup"].delivery, "read_only");
			assert.equal(calls["fake.create"].delivery, "at_most_once");
			assert.equal(calls["fake.lookup"].state, "succeeded");
			assert.equal(calls["fake.create"].state, "succeeded");
			assert.equal(calls["fake.hang"].state, "unknown");
			assert.equal(calls["fake.hang"].delivered_by, "dead-cell report");
			assert.equal(w.wakes().length, 1, "nothing owed is left to wake the session again");
		});
	});

	it("an at_most_once call claimed, then the kernel dies before sending: UNKNOWN, never sent", T, async () => {
		const n = randomBytes(3).toString("hex");
		await withProxy("at-most-once", "at-most-once.json", n, [], async (w, proxy) => {
			w.post(`ECHO-${n} go`);
			w.startScheduler();
			await until(() => w.model.served() === 2 && !w.turn(), { what: "the turn to finish", timeoutMs: 90_000 });
			// A few more scans: an owed or retried call would show up here.
			await sleep(4000);

			assert.deepEqual(w.model.errors, []);
			assert.equal(proxy.count("charge"), 0, "the request never left, and nothing resent it");
			const report = w.model.requests[1];
			assert.match(report.last, /proxy fake\.charge — UNKNOWN — /, report.last);
			assert.match(report.last, /in the order they left the kernel \(1 unknown;/);

			const [charge] = w.invocations().filter((r) => r.name === "fake.charge");
			assert.equal(charge.delivery, "at_most_once");
			assert.equal(charge.state, "unknown");
			assert.match(charge.outcome.summary, /may or may not have taken effect/);
			assert.ok(charge.delivered_at, "delivered by the report the model saw");
			assert.equal(w.wakes().length, 1, "no wake re-delivers or retries it");
			assert.equal(w.model.requests.length, 2);
		});
	});
});
