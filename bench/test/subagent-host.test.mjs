/**
 * The loop-side half of spawn()'s host transport (scripts/patches/subagent-host.ts),
 * as compiled into prime. The kernel half is runtime/test_subagents_host.py.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { harnessSubagentHostHandlers, SUBAGENT_HOST_REQUEST } = await import(
	join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/core/harness-subagents.js")
);

const ON = {
	HARNESS_SUBAGENTS: "1",
	HARNESS_SUBAGENT_BROKER_URL: "http://127.0.0.1:9/subagents/",
	HARNESS_EGRESS_TOKEN: "egr_test",
};

function fakeFetch(status, body) {
	const calls = [];
	const fn = async (url, init) => {
		calls.push({ url, init, body: JSON.parse(init.body) });
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	};
	fn.calls = calls;
	return fn;
}

describe("the spawn() host-request handler", () => {
	it("is absent unless HARNESS_SUBAGENTS=1 and a broker is named", () => {
		assert.deepEqual(harnessSubagentHostHandlers(() => ({}), {}), {});
		assert.deepEqual(harnessSubagentHostHandlers(() => ({}), { HARNESS_SUBAGENTS: "1" }), {});
		assert.deepEqual(harnessSubagentHostHandlers(() => ({}), { ...ON, HARNESS_SUBAGENTS: "0" }), {});
		assert.deepEqual(Object.keys(harnessSubagentHostHandlers(() => ({}), ON)), [SUBAGENT_HOST_REQUEST]);
	});

	it("a child gets its end of the conversation only, and its siblings only when allowed", async () => {
		const CHILD = {
			HARNESS_SUBAGENTS: "0",
			HARNESS_SUBAGENT_CHILD: "1",
			HARNESS_SUBAGENT_DEPTH: "1",
			HARNESS_SUBAGENT_BROKER_URL: "http://127.0.0.1:9/subagents",
		};
		assert.deepEqual(harnessSubagentHostHandlers(() => ({}), { ...CHILD, HARNESS_SUBAGENT_CHILD: "0" }), {});
		assert.deepEqual(harnessSubagentHostHandlers(() => ({}), { ...CHILD, HARNESS_SUBAGENT_DEPTH: "0" }), {});
		const fetch = fakeFetch(200, { ok: true, id: "q1" });
		const h = harnessSubagentHostHandlers(() => ({}), CHILD, fetch);
		assert.equal((await h[SUBAGENT_HOST_REQUEST]({ op: "ask", question: "which year?" })).id, "q1");
		assert.equal(fetch.calls[0].url, "http://127.0.0.1:9/subagents/ask");
		assert.equal(fetch.calls[0].body.parent.depth, 1);
		for (const op of ["spawn", "wait", "send", "kill"])
			await assert.rejects(h[SUBAGENT_HOST_REQUEST]({ op }), /not available to this agent/);
		assert.equal(fetch.calls.length, 1);
		const sib = harnessSubagentHostHandlers(() => ({}), { ...CHILD, HARNESS_SUBAGENT_SIBLINGS: "1" }, fetch);
		await sib[SUBAGENT_HOST_REQUEST]({ op: "send", name: "b", text: "hi", mode: "follow_up" });
		await assert.rejects(sib[SUBAGENT_HOST_REQUEST]({ op: "spawn" }), /not available to this agent/);
	});

	it("forwards the request with the loop's token, stamped with the parent's model", async () => {
		const fetch = fakeFetch(200, { ok: true, child: { name: "a", state: "running" } });
		const h = harnessSubagentHostHandlers(
			() => ({ model: "anthropic/claude-sonnet-5", thinking: "medium" }),
			{ ...ON, HARNESS_SUBAGENT_DEPTH: "0" },
			fetch,
		);
		const reply = await h[SUBAGENT_HOST_REQUEST]({
			type: SUBAGENT_HOST_REQUEST,
			cellSourceCode: "spawn(...)",
			op: "spawn",
			name: "a",
			prompt: "p",
			model: null,
			max_turns: 5,
		});
		assert.equal(reply.child.name, "a");
		const call = fetch.calls[0];
		assert.equal(call.url, "http://127.0.0.1:9/subagents/spawn");
		assert.equal(call.init.headers["x-egress-token"], "egr_test");
		assert.deepEqual(call.body, {
			op: "spawn",
			name: "a",
			prompt: "p",
			model: null,
			max_turns: 5,
			parent: { model: "anthropic/claude-sonnet-5", thinking: "medium", depth: 0 },
		});
	});

	it("turns a broker refusal into the error the kernel raises", async () => {
		const fetch = fakeFetch(403, { ok: false, error: "model x is not allowed; allowed: a, b" });
		const h = harnessSubagentHostHandlers(() => ({}), ON, fetch);
		await assert.rejects(h[SUBAGENT_HOST_REQUEST]({ op: "spawn" }), /not allowed; allowed: a, b/);
	});

	it("names a broker that did not answer JSON", async () => {
		const h = harnessSubagentHostHandlers(() => ({}), ON, fakeFetch(502, "<html>bad gateway"));
		await assert.rejects(h[SUBAGENT_HOST_REQUEST]({ op: "status" }), /answered 502: <html>bad gateway/);
	});

	it("refuses an operation it does not know without calling the broker", async () => {
		const fetch = fakeFetch(200, { ok: true });
		const h = harnessSubagentHostHandlers(() => ({}), ON, fetch);
		await assert.rejects(h[SUBAGENT_HOST_REQUEST]({ op: "rm -rf" }), /unknown subagent operation/);
		assert.equal(fetch.calls.length, 0);
	});
});
