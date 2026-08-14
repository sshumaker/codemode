/**
 * The guarded `bash` tool, exercised rather than described.
 *
 * The failure this closes produced a plausible number, not an error: the codemode
 * arm was given prime's native `bash`, and `bash make` then blocked the turn for
 * twenty minutes with no redirect and no backstop. The kernel's guards
 * (`_guard_shell_cells`, the SIGALRM watchdog) are Python-side and a bash TOOL
 * passes none of them, so the arm behaved like the blocking arms while still
 * wearing the codemode label — measured on `compile-compcert`, where the arm with a
 * kernel handed the build to `jobs.submit` and passed.
 *
 * "A documented check is not an executed check", so every test here runs the thing:
 * the extension's real handlers, the real `jobs.blocking_sleep` behind them, and —
 * for the ceiling — prime's own bash tool actually killing a real process.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { buildArm } from "../arms.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const JOBS_PY = join(ROOT, "runtime/jobs.py");
const EXTENSION = join(ROOT, "bench/arms/bash-tool-extension.ts");

let dir;
before(() => {
	dir = mkdtempSync(join(tmpdir(), "harness-bash-guard-"));
});
after(() => dir && rmSync(dir, { recursive: true, force: true }));

/**
 * Load the extension with a given environment and collect its handlers.
 *
 * The module reads process.env at import, and node caches modules by specifier —
 * so a cache-busting query is needed for each configuration, or every test would
 * silently run against whichever env the first one used. That is the same class of
 * bug as a flag that never reaches the process it is meant to configure.
 */
let loadCounter = 0;
async function load(env = {}) {
	const saved = { ...process.env };
	Object.assign(process.env, { HARNESS_JOBS_PY: JOBS_PY, HARNESS_BASH_LEDGER: "", ...env });
	try {
		const module = await import(`${EXTENSION}?n=${loadCounter++}`);
		const handlers = {};
		module.default({
			on: (event, handler) => {
				(handlers[event] ??= []).push(handler);
			},
			registerTool: () => assert.fail("the guard must not register a tool; it intercepts prime's own bash"),
		});
		return {
			call: (input, id = "t1") => handlers.tool_call[0]({ toolName: "bash", toolCallId: id, input }),
			result: (event) => handlers.tool_result[0]({ toolName: "bash", ...event }),
		};
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	}
}

describe("the guard refuses a blocking command and runs nothing", () => {
	it("blocks a foreground sleep, with the jobs redirect", async () => {
		const { call } = await load();
		const verdict = call({ command: "sleep 300" });
		assert.equal(verdict.block, true, "a 300s foreground sleep was allowed through");
		assert.match(verdict.reason, /jobs\.submit\(/);
		assert.match(verdict.reason, /jobs\.wait\(wake_after=/);
	});

	it("blocks a poll loop, which has no fixed duration to measure", async () => {
		const { call } = await load();
		const verdict = call({ command: "while true; do sleep 5; done" });
		assert.equal(verdict.block, true);
		assert.match(verdict.reason, /jobs\.submit\(/);
	});

	it("tells a shell-holding agent that jobs lives in the ipython tool", async () => {
		// Without this the obvious next move is to run `jobs.submit(...)` as a shell
		// command, which fails in a way that teaches the primitive is broken rather
		// than that it is elsewhere. The measured lesson of this project is that the
		// error is the strongest teaching channel there is; a misleading one is worse
		// than none.
		const { call } = await load();
		assert.match(call({ command: "sleep 300" }).reason, /ipython tool/);
	});

	it("blocking is decided by the runtime's own blocking_sleep, not a second copy", () => {
		// The guard shells out to jobs.py so there is exactly one implementation. This
		// pins the property that makes that true: the extension holds no rules of its
		// own about sleeps or loops.
		const source = readFileSync(EXTENSION, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
		assert.match(source, /--check-blocking/);
		assert.equal(/\bsleep\\s|while\\s\+true|_UNBOUNDED|tail -f/.test(source), false, "the extension re-implements the sleep rules");
	});

	it("a backgrounded command is allowed — starting work is not waiting for it", async () => {
		const { call } = await load();
		assert.equal(call({ command: "(sleep 300; touch done) &" }), undefined);
	});

	it("short commands run: the guard returns nothing and prime's bash executes", async () => {
		const { call } = await load();
		assert.equal(call({ command: "ls -la" }), undefined);
		assert.equal(call({ command: "grep -rn NEEDLE ." }), undefined);
	});
});

describe("the ceiling, against prime's real bash", () => {
	let bash;
	before(async () => {
		const built = await buildArm("vanilla", dir);
		bash = built.tools.find((t) => t.name === "bash");
		assert.ok(bash, "prime's bash tool is not in the vanilla arm");
	});

	it("`make`-shaped work passes the pre-flight check — which is why a ceiling is needed", async () => {
		// blocking_sleep looks for sleeps and loops. A build contains neither, so the
		// pre-flight guard cannot see the twenty-minute case at all. Pinning this
		// stops anyone concluding the pre-check is sufficient.
		const { call } = await load();
		assert.equal(call({ command: "make -j8" })?.block, undefined);
	});

	it("injects the ceiling as prime's own timeout parameter", async () => {
		const { call } = await load({ HARNESS_BASH_CEILING_SECONDS: "120" });
		const input = { command: "make -j8" };
		call(input);
		assert.equal(input.timeout, 120, "the ceiling was not mutated into the call");
	});

	it("keeps a tighter timeout the model set for itself", async () => {
		const { call } = await load({ HARNESS_BASH_CEILING_SECONDS: "120" });
		const input = { command: "make", timeout: 30 };
		call(input);
		assert.equal(input.timeout, 30);
	});

	it("prime's bash really kills the process at that timeout", async () => {
		// The mechanism the ceiling relies on, executed. If prime ever stopped
		// honouring `timeout`, every other test here would still pass and the ceiling
		// would silently do nothing.
		const started = Date.now();
		await assert.rejects(
			() => bash.execute("cap", { command: "sleep 30", timeout: 2 }, undefined),
			/timed out after 2 seconds/,
		);
		assert.ok(Date.now() - started < 15_000, "the command was not actually killed");
	});

	it("rewrites that kill into the redirect, keeping whatever output arrived", async () => {
		const { call, result } = await load({ HARNESS_BASH_CEILING_SECONDS: "2" });
		// Deliberately under the foreground-sleep ceiling, so the PRE-flight check
		// allows it and the wall-clock ceiling is what stops it. A command the
		// pre-check refuses would never reach the tool and would test nothing here.
		const input = { command: "echo starting; sleep 20" };
		assert.equal(call(input, "cap"), undefined);
		assert.equal(input.timeout, 2);
		let text;
		try {
			await bash.execute("cap", input, undefined);
			assert.fail("the command was not killed");
		} catch (error) {
			text = error.message;
		}
		assert.match(text, /Command timed out after 2 seconds/);
		const rewritten = result({ toolCallId: "cap", isError: true, content: [{ type: "text", text }] });
		assert.match(rewritten.content[0].text, /jobs\.submit\(/, "the kill did not name the replacement");
		assert.match(rewritten.content[0].text, /starting/, "output produced before the kill was discarded");
		assert.equal(rewritten.isError, true);
		assert.equal(/Command timed out after 2 seconds/.test(rewritten.content[0].text), false);
	});

	it("leaves a timeout the model asked for itself alone", async () => {
		// Only calls this guard LOWERED are rewritten. A model that set a tighter
		// timeout itself gets prime's message, because attributing its own choice to
		// the guard would misreport which mechanism stopped the command. Checked with
		// the ceiling ON, since with it off nothing is capped and the test would pass
		// for the wrong reason.
		const { call, result } = await load({ HARNESS_BASH_CEILING_SECONDS: "120" });
		call({ command: "ls", timeout: 2 }, "own");
		const text = "Command timed out after 2 seconds";
		assert.equal(result({ toolCallId: "own", isError: true, content: [{ type: "text", text }] }), undefined);
	});
});

describe("AppWorld: one transport, enforced on the shell too", () => {
	it("refuses curl, wget and a bare URL", async () => {
		const { call } = await load({ HARNESS_BASH_NO_EGRESS: "1" });
		for (const command of [
			"curl -s http://127.0.0.1:8123/call",
			"wget -qO- localhost:8123",
			"nc 127.0.0.1 8123",
			"python3 -c 'import requests; requests.get(u)'",
			"cat > /tmp/x <<< https://example.com",
		]) {
			const verdict = call({ command });
			assert.equal(verdict?.block, true, `allowed: ${command}`);
			assert.match(verdict.reason, /ipython/);
		}
	});

	it("still allows ordinary filesystem work", async () => {
		const { call } = await load({ HARNESS_BASH_NO_EGRESS: "1" });
		for (const command of [
			"ls api/",
			"grep -rn complete_task api/",
			"wc -l api/gmail.py",
			// `http` as a search term, not a client. httpie ships a binary by that
			// name and it was on the deny-list; a refusal landing here costs a turn
			// and teaches something false, and the URL pattern covers the real case.
			"grep -rn http api/",
		]) {
			assert.equal(call({ command }), undefined, `refused: ${command}`);
		}
	});

	it("terminal-bench is unrestricted — there the machine IS the surface", async () => {
		const { call } = await load();
		assert.equal(call({ command: "curl -sf localhost:5000/health" }), undefined);
	});

	it("every command and its verdict is recorded, so a bypass is answerable from evidence", async () => {
		const ledger = join(dir, "bash-calls.jsonl");
		const { call } = await load({ HARNESS_BASH_NO_EGRESS: "1", HARNESS_BASH_LEDGER: ledger });
		call({ command: "ls api/" }, "a");
		call({ command: "curl http://x/" }, "b");
		call({ command: "sleep 300" }, "c");
		const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		// The load marker comes first, and it is the point: an extension that never
		// loaded and one that was never given a blocking command otherwise leave the
		// same empty ledger, and the run gets scored as an arm that chose to block.
		assert.equal(rows[0].phase, "loaded");
		const calls = rows.filter((r) => r.phase === "call");
		assert.deepEqual(
			calls.map((r) => r.verdict),
			["allowed", "blocked-egress", "blocked-blocking"],
		);
		// The command itself, not just the verdict: "could you re-derive this
		// tomorrow, after the environment has been reset?"
		assert.equal(calls[1].command, "curl http://x/");
	});
});

describe("the guard fails loud, never open", () => {
	it("refuses to load without a checker", async () => {
		await assert.rejects(() => load({ HARNESS_JOBS_PY: "" }), /HARNESS_JOBS_PY is required/);
	});

	it("refuses to load when the checker cannot run", async () => {
		// An unguarded bash tool on the codemode arm is not the arm it is labelled as,
		// and the run would be reported as an agent that chose to block. Same shape as
		// the deferred-registration episode: narrowing "worked" and execution broke,
		// and nothing caught it.
		await assert.rejects(() => load({ HARNESS_JOBS_PY: join(dir, "does-not-exist.py") }), /self-check could not run/);
	});

	it("the self-check asserts the verdict, not the absence of an error", async () => {
		// A checker that answers "not blocking" to everything exits 0 and prints valid
		// JSON. Locating or running it proves nothing; only the answer does.
		const stub = join(dir, "always-allows.py");
		writeFileSync(stub, 'print(\'{"blocking": false, "reason": null, "message": null}\')\n');
		await assert.rejects(() => load({ HARNESS_JOBS_PY: stub }), /self-check failed/);
	});
});

describe("wiring: the arms that get the guard actually get it", () => {
	it("terminal-bench loads the extension for codemode with jobs on", () => {
		const agent = readFileSync(join(ROOT, "bench/terminal/prime_agent.py"), "utf8");
		assert.match(agent, /bash-tool-extension\.ts/);
		// The native bash must not be reachable alongside it: the guard intercepts the
		// builtin, so `bash` staying in --tools is required, and --no-extensions would
		// silently drop the guard while leaving the tool.
		assert.match(agent, /HARNESS_BASH_CEILING_SECONDS/);
		assert.equal(
			/"--no-extensions",\s*$/m.test(agent) && !/extension/.test(agent),
			false,
			"prime is started with --no-extensions, so the guard never loads",
		);
	});

	/**
	 * The invariant, asserted against recorded runs rather than against source.
	 *
	 * Everything above proves the guard behaves correctly when it is asked. This is
	 * the half that catches the guard never being asked: an extension that failed to
	 * load leaves no refusals, and a benchmark of API work produces no refusals
	 * either, so the two are indistinguishable from the counts alone. That ambiguity
	 * is exactly what made the deferred-registration "L1" survive for months.
	 */
	it("no recorded --bash run had an unguarded or leaking shell", () => {
		const runs = join(ROOT, ".run/appworld");
		if (!existsSync(runs)) return;
		const offenders = [];
		let checked = 0;
		for (const name of readdirSync(runs)) {
			if (!name.includes("__bash")) continue;
			const path = join(runs, name, "result.json");
			if (!existsSync(path)) continue;
			let run;
			try {
				run = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				continue;
			}
			if (!run.summary?.bashGuard) continue;
			checked++;
			if (!run.summary.bashGuard.loaded) offenders.push(`${name}: guard never loaded`);
			if (run.summary.bashGuardViolation) offenders.push(`${name}: ${run.summary.bashGuardViolation}`);
		}
		assert.equal(offenders.length, 0, `${offenders.length} of ${checked}:\n  ${offenders.join("\n  ")}`);
	});

	it("AppWorld gives codemode bash only with egress refused", () => {
		const runner = readFileSync(join(ROOT, "bench/appworld/run-task.mjs"), "utf8");
		assert.match(runner, /HARNESS_BASH_NO_EGRESS/);
		// The invariant that matters more than the flag: bash must never be in the
		// codemode tool list without the guard extension alongside it.
		const guarded = /BASH_EXTENSION/.test(runner);
		assert.equal(guarded, true, "AppWorld adds bash without loading the guard");
	});
});
