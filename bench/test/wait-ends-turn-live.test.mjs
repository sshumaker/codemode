/**
 * `jobs.wait` ends the turn — against a real model, in the real harness.
 *
 * Opt-in (it spends a few cents of Haiku): HARNESS_LIVE_WAIT=1 with ANTHROPIC_API_KEY
 * in the environment. PRIME_AGENT_KERNEL_PYTHON names the kernel venv (default: the
 * shared one, read-only).
 *
 * The unit tests (wait-ends-turn.test.mjs) prove the mechanism with a faux model;
 * this proves the model-facing behaviour it exists for. Each scenario is one real
 * prime process, and each asserts the same three things from the recorded stream
 * AND the session JSONL prime persisted:
 *
 *   1. the run ends at the wait: `agent_end` carries stopReason "waiting" and the
 *      wait's parameters, and ZERO assistant messages are produced between that
 *      agent_end and the wake — nothing polls, nothing sleeps in-process;
 *   2. the host decides the wake from the request alone (`scheduler.reason_for`),
 *      and the reason is the right one for the source;
 *   3. the new turn opens with the wake message and the model uses what it woke for.
 *
 * Hosts covered: an RPC host (this file, standing in for the gateway), prime's own
 * print mode waking itself, and print mode under runtime/scheduler.py.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { seedPrimeSettings } from "../prime-settings.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/cli.js");
const RUNTIME = join(ROOT, "runtime");
const MODEL = process.env.HARNESS_LIVE_WAIT_MODEL ?? "anthropic/claude-haiku-4-5";
const KERNEL_PYTHON = process.env.PRIME_AGENT_KERNEL_PYTHON ?? join(homedir(), ".prime/agent/kernel-venv/bin/python");
const live = process.env.HARNESS_LIVE_WAIT === "1" && Boolean(process.env.ANTHROPIC_API_KEY) && existsSync(KERNEL_PYTHON);

const BASE = "You are working in a Python (IPython) kernel via the `ipython` tool. Be concise.";
const JOBS_PROMPT = live ? execFileSync("python3", [join(RUNTIME, "jobs.py"), "--prompt"], { encoding: "utf8" }) : "";
const costs = [];
const sockets = [];
after(() => {
	// Stop only the daemons this file started: the process listening on each private
	// socket. SIGTERM, which the supervisor passes to its workers. Never the global
	// `prime-agent shutdown`, which stops every agent on the machine.
	let table = "";
	try {
		table = execFileSync("lsof", ["-U", "-F", "pn"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	} catch (e) {
		table = e.stdout?.toString() ?? "";
	}
	let pid;
	const mine = new Set();
	for (const line of table.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && sockets.some((s) => line.includes(s.split("/").slice(-2).join("/")))) mine.add(pid);
	}
	for (const p of mine) {
		try {
			process.kill(p, "SIGTERM");
		} catch {}
	}
	if (costs.length) console.log(`[live] model cost: ${costs.map((c) => `${c.label} $${c.cost.toFixed(4)}`).join(", ")}`);
});

/** A per-scenario world: agent home, job dir, kernel prelude, and the env that names them. */
function world(label) {
	const dir = mkdtempSync(join(tmpdir(), `wait-live-${label}-`));
	const startup = join(dir, "ipython/profile_default/startup");
	mkdirSync(startup, { recursive: true });
	writeFileSync(
		join(startup, "00-jobs.py"),
		`import runpy\nrunpy.run_path(${JSON.stringify(join(RUNTIME, "kernel-prelude.py"))}, run_name="__prelude__")\n`,
	);
	const work = join(dir, "work");
	mkdirSync(work);
	const env = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		TMPDIR: process.env.TMPDIR ?? tmpdir(),
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		DO_NOT_TRACK: "1",
		PRIME_AGENT_TELEMETRY: "0",
		PRIME_AGENT_CODING_AGENT_DIR: seedPrimeSettings(join(dir, "agent-home")),
		PRIME_AGENT_KERNEL_PYTHON: KERNEL_PYTHON,
		IPYTHONDIR: join(dir, "ipython"),
		HARNESS_JOB_DIR: join(dir, "jobs"),
		HARNESS_JOB_CWD: work,
		HARNESS_RUNTIME_DIR: RUNTIME,
		HARNESS_PRELUDE_MARKER: join(dir, "prelude.txt"),
		HARNESS_KERNEL_SANDBOX: "off",
		HARNESS_MIN_WAIT_SECONDS: "5",
		HARNESS_WAIT_TOKEN: randomBytes(8).toString("hex"),
	};
	// A private daemon. prime's default socket is machine-global, and a daemon some
	// other checkout started would run THIS test's session on ITS code — the first
	// live run here did exactly that and measured the old sleep path.
	const socket = join(dir, "d.sock");
	sockets.push(socket);
	const args = [
		"--daemon-socket", socket,
		"--model", MODEL, "--tools", "ipython", "--cwd", work,
		"--no-context-files", "--no-prompt-templates", "--no-extensions",
		"--system-prompt", `${BASE}\n\n${JOBS_PROMPT}`,
	];
	return { dir, work, env, args, label };
}

/** Ask the scheduler whether a wait request is due — what any host does with `agent_end.wait.request`. */
function reasonFor(request) {
	return JSON.parse(
		execFileSync("python3", [join(RUNTIME, "scheduler.py"), "--reason-for-request", "--consume"], {
			input: JSON.stringify(request),
			encoding: "utf8",
		}),
	);
}

async function until(fn, { timeoutMs = 120_000, everyMs = 500, what = "condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, everyMs));
	}
}

const isAssistantEnd = (e) => e.type === "message_end" && e.message?.role === "assistant";
const textOf = (m) => (Array.isArray(m?.content) ? m.content.map((c) => c.text ?? "").join("") : String(m?.content ?? ""));

/** Every message prime persisted for this world, in order (the session JSONL is the truth). */
function sessionMessages(w) {
	const out = [];
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl")) {
				for (const line of readFileSync(p, "utf8").split("\n")) {
					if (!line.trim()) continue;
					try {
						const entry = JSON.parse(line);
						if (entry.type === "message" && entry.message) out.push(entry.message);
					} catch {}
				}
			}
		}
	};
	const sessions = join(w.env.PRIME_AGENT_CODING_AGENT_DIR, "sessions");
	if (existsSync(sessions)) walk(sessions);
	return out;
}

/**
 * The transcript invariant: the wait's tool result is followed by the wake message,
 * never by an assistant message — no model call happened between them.
 */
function assertNothingBetweenWaitAndWake(w, waitToolCallId, wakeText) {
	const msgs = sessionMessages(w);
	const i = msgs.findIndex((m) => m.role === "toolResult" && m.toolCallId === waitToolCallId);
	assert.ok(i >= 0, "the wait's tool result is persisted");
	const next = msgs.slice(i + 1).find((m) => m.role !== "toolResult");
	assert.equal(next?.role, "user", `after the wait's result came a ${next?.role} message, not the wake`);
	assert.ok(textOf(next).startsWith(wakeText.slice(0, 40)), `the next message is the wake: ${textOf(next).slice(0, 120)}`);
	return msgs;
}

/** An RPC host over one prime process: this file plays the gateway. */
function rpcHost(w) {
	const child = spawn(process.execPath, [CLI, "--mode", "rpc", ...w.args], {
		cwd: w.work,
		env: w.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const events = [];
	let buf = "";
	let stderr = "";
	child.stdout.on("data", (d) => {
		buf += d;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line.startsWith("{")) continue;
			try {
				events.push({ ...JSON.parse(line), _at: Date.now() });
			} catch {}
		}
	});
	child.stderr.on("data", (d) => {
		stderr += d;
	});
	const send = (message) => child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
	const agentEnd = (after) =>
		until(() => events.slice(after).find((e) => e.type === "agent_end"), { what: "agent_end", timeoutMs: 240_000 });
	const stop = async () => {
		child.stdin.end();
		await Promise.race([new Promise((r) => child.once("close", r)), new Promise((r) => setTimeout(r, 10_000))]);
		if (child.exitCode === null) child.kill("SIGTERM");
	};
	return { child, events, send, agentEnd, stop, stderr: () => stderr };
}

function cost(events) {
	return events.filter(isAssistantEnd).reduce((s, e) => s + (e.message.usage?.cost?.total ?? 0), 0);
}

/**
 * One RPC scenario: prompt, the turn ends waiting, the host waits for the right
 * reason (optionally making the world move first), wakes, and the model finishes.
 */
async function rpcScenario(w, { prompt, beforeWake, expectReason, wakeMessage }) {
	const host = rpcHost(w);
	try {
		host.send(prompt);
		const end = await host.agentEnd(0);
		assert.equal(end.stopReason, "waiting", `the run ended without waiting: ${host.stderr().slice(-1500)}`);
		assert.ok(end.wait?.request, "agent_end carries the wait request");
		const endIdx = host.events.indexOf(end);
		const callsAtWait = host.events.filter(isAssistantEnd).length;

		await beforeWake?.(end.wait);
		let wake;
		if (wakeMessage) {
			wake = { reason: "user", message: wakeMessage };
		} else {
			wake = await until(() => {
				const r = reasonFor(end.wait.request);
				return r.reason ? r : null;
			}, { what: "the wake reason", timeoutMs: 150_000 });
			assert.match(wake.reason, expectReason);
		}
		// The heart of it: between the waiting agent_end and the wake, nothing.
		const between = host.events.slice(endIdx + 1);
		assert.equal(host.events.filter(isAssistantEnd).length, callsAtWait, "a model call happened while waiting");
		assert.ok(!between.some((e) => e.type === "agent_start" || e.type === "turn_start"), "a turn started while waiting");

		const sentAt = host.events.length;
		host.send(wake.message);
		const final = await host.agentEnd(sentAt);
		const newRun = host.events.slice(sentAt);
		const opening = newRun.find((e) => e.type === "message_end" && e.message?.role === "user");
		assert.equal(textOf(opening?.message), wake.message, "the new turn opens with the wake message");
		const toolCallId = end.wait.toolCallId;
		assertNothingBetweenWaitAndWake(w, toolCallId, wake.message);
		const answer = textOf(host.events.slice(sentAt).filter(isAssistantEnd).at(-1)?.message);
		costs.push({ label: w.label, cost: cost(host.events) });
		return { end, final, answer, wake, events: host.events };
	} finally {
		await host.stop();
		writeFileSync(join(w.dir, "events.jsonl"), host.events.map((e) => JSON.stringify(e)).join("\n"));
		writeFileSync(join(w.dir, "stderr.txt"), host.stderr());
		console.log(`[live] ${w.label}: ${w.dir}`);
	}
}

describe("live: jobs.wait ends the turn, and the host starts the next one", { skip: !live && "set HARNESS_LIVE_WAIT=1 with ANTHROPIC_API_KEY" }, () => {
	it("RPC: a 5 s job, a named wait; the host wakes it when the job finishes", { timeout: 400_000 }, async () => {
		const w = world("rpc-job");
		const nonce = randomBytes(4).toString("hex");
		const t0 = Date.now();
		const r = await rpcScenario(w, {
			prompt:
				`Use the ipython tool. In ONE cell: submit the shell job \`sleep 5; echo BUILD-OK-${nonce}\` with ` +
				`jobs.submit(..., name='build'), then call jobs.wait('build', wake_after='2m') as the cell's last statement. ` +
				"After you are woken, read the job's output and reply with the exact line it printed.",
			expectReason: /^job 'build' finished: succeeded \(exit 0\)$/,
		});
		assert.deepEqual(r.end.wait.targets, ["build"]);
		assert.equal(r.end.wait.seconds, 120);
		assert.ok(Date.now() - t0 < 110_000, "woke at the job, not the deadline");
		assert.match(r.answer, new RegExp(`BUILD-OK-${nonce}`), `the model did not use the result: ${r.answer}`);
	});

	it("RPC: a condition job fires when the test creates the file", { timeout: 400_000 }, async () => {
		const w = world("rpc-cond");
		const flag = join(w.dir, "flag", "ready");
		mkdirSync(dirname(flag));
		const r = await rpcScenario(w, {
			prompt:
				`Use the ipython tool. In ONE cell: jobs.submit("until test -f ${flag}; do sleep 1; done", name='ready', ` +
				"expect='once'), then jobs.wait('ready', wake_after='2m') as the cell's last statement. " +
				"When you are woken, reply with one line: why you were woken.",
			beforeWake: async (wait) => {
				assert.deepEqual(wait.targets, ["ready"]);
				await new Promise((res) => setTimeout(res, 3000));
				assert.equal(reasonFor(wait.request).reason, null, "woke before the condition held");
				writeFileSync(flag, "");
			},
			expectReason: /^job 'ready' finished: succeeded \(exit 0\)$/,
		});
		assert.match(r.answer, /ready/i, `the model did not say why it woke: ${r.answer}`);
	});

	it("RPC: a user message wakes a turn waiting on a long job", { timeout: 400_000 }, async () => {
		const w = world("rpc-user");
		const msg =
			"[woken: 1 new message from user]\n[your pending jobs.wait was cancelled by this; wait again if you still need to]\n\n" +
			"Reply with the single word PONG and nothing else. Do not call any tool.";
		const r = await rpcScenario(w, {
			prompt:
				"Use the ipython tool. In ONE cell: jobs.submit('sleep 600', name='long'), then " +
				"jobs.wait('long', wake_after='2m') as the cell's last statement.",
			beforeWake: async (wait) => {
				assert.deepEqual(wait.targets, ["long"]);
				assert.equal(reasonFor(wait.request).reason, null);
			},
			wakeMessage: msg,
		});
		assert.match(r.answer, /PONG/);
		execFileSync("python3", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(RUNTIME)}); import jobs; jobs.JobStore(${JSON.stringify(w.env.HARNESS_JOB_DIR)}, emit=lambda m: None).kill('long')`]);
	});

	it("print mode, no scheduler: the run wakes itself when the job finishes", { timeout: 400_000 }, async () => {
		const w = world("print-self");
		const nonce = randomBytes(4).toString("hex");
		const t0 = Date.now();
		const out = await new Promise((resolve) => {
			const child = spawn(process.execPath, [CLI, "-p", "--mode", "json", ...w.args,
				`Use the ipython tool. In ONE cell: jobs.submit('sleep 5; echo PRINT-OK-${nonce}', name='build'), then ` +
				"jobs.wait('build', wake_after='2m') as the cell's last statement. After you are woken, reply with the exact line the job printed."],
				{ cwd: w.work, env: w.env, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => { stdout += d; });
			child.stderr.on("data", (d) => { stderr += d; });
			const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
			child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
		});
		assert.equal(out.status, 0, out.stderr.slice(-1500));
		const events = out.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
		const ends = events.filter((e) => e.type === "agent_end");
		assert.equal(ends[0]?.stopReason, "waiting");
		assert.equal(ends.at(-1)?.stopReason, undefined, "the woken run finished normally");
		const wakeMsg = events.find((e) => e.type === "message_end" && e.message?.role === "user" && textOf(e.message).startsWith("[woken:"));
		assert.equal(textOf(wakeMsg?.message), "[woken: job 'build' finished: succeeded (exit 0)] Check your jobs and continue the task.");
		assertNothingBetweenWaitAndWake(w, ends[0].wait.toolCallId, textOf(wakeMsg.message));
		assert.ok(Date.now() - t0 < 110_000, "woke at the job, not the 2m deadline");
		assert.match(textOf(events.filter(isAssistantEnd).at(-1)?.message), new RegExp(`PRINT-OK-${nonce}`));
		costs.push({ label: w.label, cost: cost(events) });
	});

	it("print mode under the scheduler: the process exits at the wait and the scheduler wakes it", { timeout: 400_000 }, async () => {
		const w = world("print-sched");
		const nonce = randomBytes(4).toString("hex");
		const sessions = join(w.dir, "sessions");
		const session = join(sessions, "s");
		mkdirSync(session, { recursive: true });
		const env = { ...w.env, HARNESS_WAIT_MODE: "exit", HARNESS_WAKE_FILE: join(session, "wake.json") };
		writeFileSync(join(session, "session.json"), JSON.stringify({
			argv: [process.execPath, CLI, "-c", "-p", "--mode", "json", ...w.args],
			cwd: w.work,
			env: { HARNESS_JOB_DIR: w.env.HARNESS_JOB_DIR, HARNESS_WAIT_MODE: "exit", HARNESS_WAKE_FILE: join(session, "wake.json") },
		}));
		const first = await new Promise((resolve) => {
			const child = spawn(process.execPath, [CLI, "-p", "--mode", "json", ...w.args,
				`Use the ipython tool. In ONE cell: jobs.submit('sleep 5; echo SCHED-OK-${nonce}', name='build'), then ` +
				"jobs.wait('build', wake_after='2m') as the cell's last statement. After you are woken, reply with the exact line the job printed."],
				{ cwd: w.work, env, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => { stdout += d; });
			child.stderr.on("data", (d) => { stderr += d; });
			const t0 = Date.now();
			const timer = setTimeout(() => child.kill("SIGTERM"), 200_000);
			child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, ms: Date.now() - t0 }); });
		});
		assert.equal(first.status, 0, first.stderr.slice(-1500));
		const firstEvents = first.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
		const firstEnd = firstEvents.findLast((e) => e.type === "agent_end");
		assert.equal(firstEnd?.stopReason, "waiting", "the first process ended at the wait");
		assert.ok(existsSync(join(session, "wake.json")), "the wait is on disk for the scheduler");
		const drain = execFileSync("python3", ["-u", join(RUNTIME, "scheduler.py"), sessions, "--drain", "--interval", "1", "--deadline", "180"], {
			cwd: RUNTIME, env, encoding: "utf8", timeout: 300_000,
		});
		assert.match(drain, /\[scheduler\] waking s: job 'build' finished: succeeded \(exit 0\)/);
		const events = drain.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
		assert.match(textOf(events.filter(isAssistantEnd).at(-1)?.message), new RegExp(`SCHED-OK-${nonce}`));
		assertNothingBetweenWaitAndWake(w, firstEnd.wait.toolCallId, "[woken: job 'build' finished: succeeded (exit 0)]");
		costs.push({ label: w.label, cost: cost(firstEvents) + cost(events) });
	});
});
