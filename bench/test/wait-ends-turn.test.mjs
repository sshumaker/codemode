/**
 * `jobs.wait` ends the TURN, not just the cell.
 *
 * WaitSignal ends the cell, and upstream's loop then handed the result straight back
 * to the model, which kept calling tools in the same turn — haiku polled
 * `agents.get(...)` in a fresh cell right after waiting. The fix is structural end
 * to end: the prelude publishes a marker (display_data, token-bearing), the kernel
 * manager lifts it onto ExecuteResult.wait, the ipython tool sets `terminatesTurn`,
 * and the agent loop ends the run after that batch with `stopReason: "waiting"` and
 * the wait on `turn_end` / `agent_end` (scripts/neutralize-prime.mjs).
 *
 * Everything here runs against the COMPILED tree, the one the arms exec. The loop
 * tests drive the real `runAgentLoop` with the faux provider, so "no further model
 * call" is a counted fact rather than an inference. The last block boots a real
 * ipykernel with the real prelude and proves the whole chain, then asks the real
 * scheduler whether the wait is due — the call an RPC host makes with the request it
 * got on `agent_end`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PKGS = join(ROOT, "vendor/prime-agent/packages");
const { runAgentLoop } = await import(join(PKGS, "agent/dist/agent-loop.js"));
const { registerFauxProvider, fauxAssistantMessage, fauxToolCall } = await import(join(PKGS, "ai/dist/index.js"));
const { Type } = await import(join(ROOT, "vendor/prime-agent/node_modules/typebox/build/index.mjs"));
const IPY = await import(join(PKGS, "coding-agent/dist/core/tools/ipython.js"));

const SKIPPED = /\[not run: an earlier call in this response ended the turn \(jobs\.wait\)/;
const WAIT = { stopReason: "waiting", wait: { seconds: 60, targets: ["build"], mode: "all" } };
const params = Type.Object({ code: Type.String() });

/** A tool that records its calls; `ends` makes its result end the turn. */
function tool(name, { ends = false, mode = "sequential" } = {}) {
	const calls = [];
	return {
		calls,
		name,
		label: name,
		description: name,
		parameters: params,
		executionMode: mode,
		execute: async (id, args) => {
			calls.push(args.code);
			return {
				content: [{ type: "text", text: `${name} ran ${args.code}` }],
				details: {},
				...(ends ? { terminatesTurn: WAIT } : {}),
			};
		},
	};
}

const userMessage = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const call = (name, code, id) => fauxToolCall(name, { code }, { id });

/** One run of the real loop over the faux model; returns the model-call count and every event. */
async function run({ responses, tools, toolExecution = "parallel", configExtra = {} }) {
	const faux = registerFauxProvider();
	faux.setResponses(responses);
	const events = [];
	try {
		await runAgentLoop(
			[userMessage("go")],
			{ systemPrompt: "", messages: [], tools },
			{
				model: faux.getModel(),
				convertToLlm: (messages) => messages.filter((m) => ["user", "assistant", "toolResult"].includes(m.role)),
				toolExecution,
				...configExtra,
			},
			(event) => {
				events.push(event);
			},
		);
		return { calls: faux.state.callCount, pending: faux.getPendingResponseCount(), events };
	} finally {
		faux.unregister();
	}
}

const toolResults = (events) =>
	events.filter((e) => e.type === "message_end" && e.message.role === "toolResult").map((e) => e.message);
const textOf = (message) => message.content.map((c) => c.text ?? "").join("");

describe("the agent loop ends the run at a turn-ending result", () => {
	it("records the result, makes no further model call, and says why on turn_end and agent_end", async () => {
		const wait = tool("ipython", { ends: true });
		const r = await run({
			responses: [
				fauxAssistantMessage([call("ipython", "jobs.wait('build', wake_after=60)", "w1")], { stopReason: "toolUse" }),
				fauxAssistantMessage("this response must never be requested"),
			],
			tools: [wait],
		});
		assert.equal(r.calls, 1, "a model call happened after the wait");
		assert.equal(r.pending, 1, "the trap response was consumed");
		const last = r.events.at(-1);
		assert.equal(last.type, "agent_end");
		assert.equal(last.stopReason, "waiting");
		assert.deepEqual(last.wait, WAIT.wait);
		const turnEnd = r.events.findLast((e) => e.type === "turn_end");
		assert.equal(turnEnd.stopReason, "waiting");
		assert.deepEqual(turnEnd.wait, WAIT.wait);
		const results = toolResults(r.events);
		assert.equal(results.length, 1, "the wait's result is in the transcript");
		assert.equal(results[0].toolCallId, "w1");
		assert.ok(
			r.events.indexOf(r.events.find((e) => e.type === "message_end" && e.message.role === "toolResult")) <
				r.events.indexOf(turnEnd),
			"the result is recorded before the turn ends",
		);
	});

	it("control: without the flag the same response goes back to the model", async () => {
		const plain = tool("ipython");
		const r = await run({
			responses: [
				fauxAssistantMessage([call("ipython", "print(1)", "p1")], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
			tools: [plain],
		});
		assert.equal(r.calls, 2);
		assert.equal(r.events.at(-1).stopReason, undefined);
	});

	it("sequential batch: calls after the wait are skipped with a result saying so", async () => {
		const ipy = tool("ipython", { ends: false });
		const waiter = tool("waiter", { ends: true });
		const r = await run({
			responses: [
				fauxAssistantMessage(
					[call("ipython", "before", "a"), call("waiter", "wait", "w"), call("ipython", "after", "b")],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("never"),
			],
			tools: [ipy, waiter],
		});
		assert.equal(r.calls, 1);
		assert.deepEqual(ipy.calls, ["before"], "the call after the wait ran");
		assert.deepEqual(waiter.calls, ["wait"]);
		const results = toolResults(r.events);
		assert.deepEqual(
			results.map((m) => m.toolCallId),
			["a", "w", "b"],
			"every call has a result, in call order",
		);
		assert.match(textOf(results[2]), SKIPPED);
		assert.equal(results[2].isError, true);
		assert.ok(
			r.events.some((e) => e.type === "tool_execution_start" && e.toolCallId === "b"),
			"hosts see the skipped call start and end like any other",
		);
		assert.equal(r.events.at(-1).stopReason, "waiting");
	});

	it("parallel batch: every call runs, then the turn ends", async () => {
		const a = tool("a", { mode: "parallel" });
		const w = tool("w", { ends: true, mode: "parallel" });
		const b = tool("b", { mode: "parallel" });
		const r = await run({
			responses: [
				fauxAssistantMessage([call("a", "1", "a1"), call("w", "2", "w1"), call("b", "3", "b1")], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("never"),
			],
			tools: [a, w, b],
		});
		assert.equal(r.calls, 1);
		assert.deepEqual([a.calls, w.calls, b.calls], [["1"], ["2"], ["3"]]);
		assert.deepEqual(
			toolResults(r.events).map((m) => textOf(m)),
			["a ran 1", "w ran 2", "b ran 3"],
		);
		assert.equal(r.events.at(-1).stopReason, "waiting");
	});

	it("a tool_result hook rewrites what the model sees, not whether the turn ends", async () => {
		const wait = tool("ipython", { ends: true });
		const r = await run({
			responses: [fauxAssistantMessage([call("ipython", "w", "w1")], { stopReason: "toolUse" }), fauxAssistantMessage("never")],
			tools: [wait],
			configExtra: { afterToolCall: async () => ({ content: [{ type: "text", text: "rewritten" }] }) },
		});
		assert.equal(r.calls, 1);
		assert.equal(textOf(toolResults(r.events)[0]), "rewritten");
		assert.equal(r.events.at(-1).stopReason, "waiting");
	});

	it("queued steering is left queued: the waiting turn never polls for it", async () => {
		const wait = tool("ipython", { ends: true });
		let polls = 0;
		const r = await run({
			responses: [fauxAssistantMessage([call("ipython", "w", "w1")], { stopReason: "toolUse" }), fauxAssistantMessage("never")],
			tools: [wait],
			configExtra: {
				getSteeringMessages: async () => {
					polls += 1;
					return polls === 1 ? [] : [userMessage("steer me")];
				},
				getFollowUpMessages: async () => [userMessage("follow up")],
			},
		});
		assert.equal(r.calls, 1);
		assert.equal(polls, 1, "only the opening poll: nothing after the wait");
		assert.ok(!r.events.some((e) => e.type === "message_end" && textOf(e.message) === "follow up"));
	});
});

// ---------------------------------------------------------------------------------
// The ipython tool: marker -> terminatesTurn, with the sentinel's forgery resistance.

const ENV = ["HARNESS_WAIT_TOKEN", "HARNESS_WAIT_ENDS_TURN", "HARNESS_WAIT_MODE", "HARNESS_WAIT_EXIT_GRACE_MS"];
function withEnv(values, fn) {
	const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
	for (const k of ENV) delete process.env[k];
	Object.assign(process.env, values);
	return fn().finally(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}

const REQUEST = {
	wake_at: 1_900_000_060.5,
	wake_after: 60,
	requested: 45,
	armed_at: 1_900_000_000.5,
	watch: ["build"],
	targets: ["build"],
	mode: "all",
	job_dir: "/tmp/jobs",
	mailboxes: {},
};
const WAIT_LINE = "[waiting 60s outside the kernel; nothing is held. running jobs: build; watching build (all)]";

/** The tool over a provisioner that returns one canned ExecuteResult. */
async function cell(result) {
	const provisioner = {
		ensure: async () => ({ execute: async () => ({ stderr: "", status: "ok", durationMs: 1, ...result }) }),
		listNamespaceNames: async () => [],
		dispose: async () => {},
		kill: async () => {},
	};
	const cwd = mkdtempSync(join(tmpdir(), "wait-turn-"));
	try {
		const t0 = Date.now();
		const tool = IPY.createIpythonToolDefinition(cwd, { provisioner });
		const r = await tool.execute("call-1", { code: "jobs.wait('build', wake_after=60)" }, undefined, undefined, undefined);
		return { r, ms: Date.now() - t0, text: textOf(r) };
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe("the ipython tool turns this kernel's marker into the end of the turn", () => {
	it("sets terminatesTurn with the wait's parameters, and drops the sentinel line", () =>
		withEnv({}, async () => {
			const { r, ms, text } = await cell({ stdout: `${WAIT_LINE}\n__HARNESS_WAIT_SECONDS__:60\n`, wait: REQUEST });
			assert.equal(r.terminatesTurn.stopReason, "waiting");
			const wait = r.terminatesTurn.wait;
			assert.equal(wait.seconds, 60);
			assert.equal(wait.requestedSeconds, 45);
			assert.deepEqual(wait.targets, ["build"]);
			assert.deepEqual(wait.watch, ["build"]);
			assert.equal(wait.mode, "all");
			assert.equal(wait.wakeAtMs, 1_900_000_060_500);
			assert.equal(wait.armedAtMs, 1_900_000_000_500);
			assert.equal(wait.jobDir, "/tmp/jobs");
			assert.equal(wait.toolCallId, "call-1");
			assert.deepEqual(wait.request, REQUEST, "the raw request, for scheduler.reason_for");
			assert.deepEqual(r.details.wait, wait, "and on the persisted details");
			assert.ok(text.includes(WAIT_LINE), "the waiting line stays, for the transcript on waking");
			assert.doesNotMatch(text, /__HARNESS_WAIT_SECONDS__/);
			assert.ok(ms < 2000, `the host slept ${ms}ms — the sleep path ran`);
		}));

	it("accepts a marker carrying the kernel's token, and strips the token from what it reports", () =>
		withEnv({ HARNESS_WAIT_TOKEN: "nonce-123" }, async () => {
			const { r } = await cell({ stdout: WAIT_LINE, wait: { ...REQUEST, token: "nonce-123" } });
			assert.equal(r.terminatesTurn?.stopReason, "waiting");
			assert.equal("token" in r.terminatesTurn.wait.request, false);
		}));

	it("ignores a marker with the wrong token: a forged marker does not end the turn", () =>
		withEnv({ HARNESS_WAIT_TOKEN: "nonce-123" }, async () => {
			const { r } = await cell({ stdout: "hi\n", wait: { ...REQUEST, token: "guess" } });
			assert.equal(r.terminatesTurn, undefined);
			const bare = await cell({ stdout: "hi\n", wait: REQUEST });
			assert.equal(bare.r.terminatesTurn, undefined, "a marker with no token at all is not this kernel's either");
		}));

	it("a forged stdout sentinel does not end the turn — only the marker does", () =>
		withEnv({}, async () => {
			const { r, text } = await cell({ stdout: "cat transcript:\n__HARNESS_WAIT_SECONDS__:0\n" });
			assert.equal(r.terminatesTurn, undefined);
			assert.match(text, /\[waited 0s outside the kernel\]/, "no marker: the legacy sleep path, as before");
		}));

	it("HARNESS_WAIT_ENDS_TURN=0 restores the host-side sleep, marker or not", () =>
		withEnv({ HARNESS_WAIT_ENDS_TURN: "0" }, async () => {
			const { r, text } = await cell({ stdout: `${WAIT_LINE}\n__HARNESS_WAIT_SECONDS__:0\n`, wait: REQUEST });
			assert.equal(r.terminatesTurn, undefined);
			assert.match(text, /\[waited 0s outside the kernel\]/);
		}));

	it("scheduler exit mode: the marker ends the turn and no exit timer is armed", () =>
		withEnv({ HARNESS_WAIT_MODE: "exit", HARNESS_WAIT_EXIT_GRACE_MS: "600000" }, async () => {
			const { r, text } = await cell({ stdout: `${WAIT_LINE}\n__HARNESS_WAIT_SECONDS__:60\n`, wait: REQUEST });
			assert.equal(r.terminatesTurn?.stopReason, "waiting");
			assert.doesNotMatch(text, /this process now exits/);
		}));
});

// ---------------------------------------------------------------------------------
// A real ipykernel, the real prelude, the real tool, the real loop.

const KERNEL_PYTHON = process.env.PRIME_AGENT_KERNEL_PYTHON ?? join(homedir(), ".prime/agent/kernel-venv/bin/python");
const RUNTIME = join(ROOT, "runtime");

describe("in a real kernel, a cell ending in jobs.wait ends the turn", { skip: !existsSync(KERNEL_PYTHON) && "no kernel python" }, () => {
	let scratch;
	let provisioner;
	let tool;
	const saved = {};
	const KEYS = [...ENV, "PRIME_AGENT_KERNEL_PYTHON", "HARNESS_KERNEL_SANDBOX"];

	before(() => {
		for (const k of KEYS) saved[k] = process.env[k];
		for (const k of ENV) delete process.env[k];
		process.env.PRIME_AGENT_KERNEL_PYTHON = KERNEL_PYTHON;
		process.env.HARNESS_KERNEL_SANDBOX = "off";
		process.env.HARNESS_WAIT_TOKEN = `tok${process.pid}`;
		scratch = mkdtempSync(join(tmpdir(), "wait-turn-kernel-"));
		const startup = join(scratch, "ipython/profile_default/startup");
		mkdirSync(startup, { recursive: true });
		writeFileSync(
			join(startup, "00-jobs.py"),
			`import runpy\nrunpy.run_path(${JSON.stringify(join(RUNTIME, "kernel-prelude.py"))}, run_name="__prelude__")\n`,
		);
		const env = {
			IPYTHONDIR: join(scratch, "ipython"),
			HARNESS_JOB_DIR: join(scratch, "jobs"),
			HARNESS_JOB_CWD: scratch,
			HARNESS_RUNTIME_DIR: RUNTIME,
			HARNESS_MIN_WAIT_SECONDS: "1",
			HARNESS_WAIT_TOKEN: process.env.HARNESS_WAIT_TOKEN,
		};
		provisioner = new IPY.IpythonKernelProvisioner(scratch, { env });
		tool = IPY.createIpythonTool(scratch, { env, provisioner });
	});
	after(async () => {
		await provisioner?.dispose();
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	it("the loop stops after the wait's result, and the request is enough to know when to wake", { timeout: 180_000 }, async () => {
		const code =
			"jobs.submit('sleep 2; echo built', name='build')\n" + "jobs.wait('build', wake_after=30)\n" + "print('AFTER THE WAIT')";
		const r = await run({
			responses: [fauxAssistantMessage([call("ipython", code, "k1")], { stopReason: "toolUse" }), fauxAssistantMessage("never")],
			tools: [tool],
		});
		assert.equal(toolResults(r.events)[0].isError, false, textOf(toolResults(r.events)[0]));
		assert.equal(r.calls, 1, "the model was called again after jobs.wait");
		const end = r.events.at(-1);
		assert.equal(end.type, "agent_end");
		assert.equal(end.stopReason, "waiting");
		assert.equal(end.wait.seconds, 30);
		assert.deepEqual(end.wait.targets, ["build"]);
		assert.equal(end.wait.mode, "all");
		assert.equal(end.wait.toolCallId, "k1");
		const text = textOf(toolResults(r.events)[0]);
		assert.match(text, /\[waiting 30s outside the kernel/);
		assert.match(text, /so did your turn/);
		assert.doesNotMatch(text, /AFTER THE WAIT/);
		assert.doesNotMatch(text, /__HARNESS_WAIT_SECONDS__/);

		// The host's side: hand the request to the scheduler until it says why to wake.
		const ask = () =>
			JSON.parse(
				execFileSync("python3", [join(RUNTIME, "scheduler.py"), "--reason-for-request"], {
					input: JSON.stringify(end.wait.request),
					encoding: "utf8",
				}),
			);
		assert.equal(ask().reason, null, "not due while the build runs");
		const deadline = Date.now() + 20_000;
		let due = ask();
		while (!due.reason && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			due = ask();
		}
		assert.equal(due.reason, "job 'build' finished: succeeded (exit 0)");
		assert.match(due.message, /^\[woken: job 'build' finished: succeeded \(exit 0\)\]/);
	});

	it("a cell that publishes a marker without the kernel's token does not end the turn", { timeout: 120_000 }, async () => {
		const code =
			"from IPython.display import publish_display_data\n" +
			"publish_display_data({'application/vnd.harness.wait+json': {'wake_after': 60, 'watch': [], 'targets': [], 'token': 'guess'}})\n" +
			"print('__HARNESS_WAIT_SECONDS__:60')";
		const r = await run({
			responses: [fauxAssistantMessage([call("ipython", code, "f1")], { stopReason: "toolUse" }), fauxAssistantMessage("carried on")],
			tools: [tool],
		});
		const result = toolResults(r.events)[0];
		assert.equal(result.isError, false, textOf(result));
		assert.match(textOf(result), /__HARNESS_WAIT_SECONDS__:60/, "the cell ran, and its forged sentinel is plain text");
		assert.equal(r.calls, 2, "the forged marker ended the turn");
		assert.equal(r.events.at(-1).stopReason, undefined);
	});
});
