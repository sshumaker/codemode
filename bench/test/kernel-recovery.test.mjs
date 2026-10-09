/**
 * The kernel's own recovery paths, against a real ipykernel and the COMPILED tool.
 *
 * Each of these used to make a run worse than the failure it recovered from: a dead
 * kernel re-ran the cell that killed it, a cell that ignored its interrupt failed
 * every later cell when there was no person to ask, and a snapshot that crashed or
 * hung the kernel did it again on every boot (scripts/neutralize-prime.mjs, "kernel
 * recovery").
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const IPY = await import(join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/core/tools/ipython.js"));
const KERNEL = await import(join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/core/kernel/index.js"));
const { generate } = await import(join(ROOT, "bench/generate.mjs"));
const KERNEL_PYTHON = process.env.PRIME_AGENT_KERNEL_PYTHON ?? join(homedir(), ".prime/agent/kernel-venv/bin/python");
const KEYS = [
	"PRIME_AGENT_KERNEL_PYTHON",
	"HARNESS_KERNEL_SANDBOX",
	"HARNESS_KERNEL_AUTORESTART",
	"HARNESS_CELL_TIMEOUT_MS",
	"HARNESS_SNAPSHOT_RESTORE_TIMEOUT_MS",
	"HARNESS_MCP_PROXY",
];

const text = (r) => r.content.map((c) => c.text ?? "").join("");

describe("kernel recovery", { skip: !existsSync(KERNEL_PYTHON) && "no kernel python" }, () => {
	let scratch;
	let provisioners;
	const saved = {};

	beforeEach(() => {
		for (const k of KEYS) saved[k] = process.env[k];
		process.env.PRIME_AGENT_KERNEL_PYTHON = KERNEL_PYTHON;
		process.env.HARNESS_KERNEL_SANDBOX = "off";
		process.env.HARNESS_KERNEL_AUTORESTART = "1";
		delete process.env.HARNESS_CELL_TIMEOUT_MS;
		scratch = mkdtempSync(join(tmpdir(), "kernel-recovery-"));
		provisioners = [];
	});
	afterEach(async () => {
		for (const p of provisioners) await p.dispose();
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
	});

	const tool = (options = {}) => {
		const provisioner = new IPY.IpythonKernelProvisioner(scratch, options);
		provisioners.push(provisioner);
		const t = IPY.createIpythonTool(scratch, { ...options, provisioner });
		let n = 0;
		return (code) => t.execute(`k${++n}`, { code });
	};

	it("a cell that dies after it started is reported, not run again", { timeout: 120_000 }, async () => {
		const cell = tool();
		const marker = join(scratch, "ran.txt");
		const died = await cell(`open(${JSON.stringify(marker)}, "a").write("ran\\n")\nimport os\nos._exit(1)`);
		assert.equal(readFileSync(marker, "utf8"), "ran\n", "the cell ran more than once");
		assert.match(text(died), /did not finish: the kernel process died after it had started running/);
		assert.match(text(died), /not run again/);
		// No call left the kernel, so the report is exactly what it was before the journal.
		assert.match(
			text(died),
			/This cell did not finish: the kernel process died after it had started running\. It was not run again, because what it already did may have taken effect\. Check what landed before repeating any of it\./,
		);
		assert.doesNotMatch(text(died), /Calls it made/);
		assert.match(text(died), /<ipython_kernel_restarted>/);
		assert.match(text(await cell("print(6 * 7)")), /42/, "the fresh kernel takes the next cell");
	});

	it("a cell that made a host call before dying says so", { timeout: 120_000 }, async () => {
		const calls = [];
		const cell = tool({ hostHandlers: { "test.charge": async (p) => (calls.push(p), { ok: 1 }) } });
		const died = await cell('from rlm import host_request\nawait host_request("test.charge", {"cents": 5})\nimport os\nos._exit(1)');
		assert.equal(calls.length, 1, "the host call was repeated");
		assert.match(text(died), /after it had already made tool or host calls/);
	});

	it("a host reply that will not encode is an error in the cell, not a hang", { timeout: 120_000 }, async () => {
		process.env.HARNESS_CELL_TIMEOUT_MS = "20000";
		const cell = tool({ hostHandlers: { "test.big": async () => ({ n: 10n }) } });
		const r = await cell('from rlm import host_request\ntry:\n    await host_request("test.big", {})\nexcept Exception as e:\n    print("raised", e)');
		assert.match(text(r), /raised .*host reply could not be sent/);
	});

	/** A stand-in tool proxy: `echo` answers with a job id, `fail` is refused, `slow` is held open. */
	const startProxy = async () => {
		const calls = [];
		const held = [];
		const server = createServer(async (req, res) => {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
			calls.push(body);
			if (body.tool === "slow") return held.push(res);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify(
					body.tool === "fail"
						? { ok: false, error: "card declined" }
						: { ok: true, text: JSON.stringify({ job_id: `j${calls.length}` }) },
				),
			);
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		provisioners.push({
			dispose: () => {
				for (const res of held) res.destroy();
				server.closeAllConnections();
				return new Promise((r) => server.close(r));
			},
		});
		process.env.HARNESS_MCP_PROXY = `http://127.0.0.1:${server.address().port}`;
		return { calls };
	};

	/** The real generated api/ client for the stand-in proxy, where the cell's cwd imports it. */
	const writeApiTree = () => {
		const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
		const { files } = generate([
			{
				server: "fixture",
				tools: ["echo", "fail", "slow"].map((name) => ({ name, description: name, inputSchema: schema })),
			},
		]);
		for (const [rel, body] of Object.entries(files)) {
			mkdirSync(dirname(join(scratch, "api", rel)), { recursive: true });
			writeFileSync(join(scratch, "api", rel), body);
		}
	};

	it("a cell that died after its calls lists them, in order, with what came of each", { timeout: 120_000 }, async () => {
		const proxy = await startProxy();
		writeApiTree();
		const cell = tool({ hostHandlers: { "test.charge": async () => ({ id: "ch_1" }) } });
		const died = text(
			await cell(
				"from rlm import host_request\n" +
					"from api.fixture import echo, fail\n" +
					'await host_request("test.charge", {"cents": 5})\n' +
					'print(await echo(text="a"))\n' +
					"try:\n" +
					'    await fail(text="b")\n' +
					"except Exception as e:\n" +
					'    print("refused", e)\n' +
					"import os\nos._exit(1)",
			),
		);
		assert.equal(proxy.calls.length, 2, `the proxy calls did not each run once:\n${died}`);
		assert.match(died, /after it had already made tool or host calls/);
		assert.match(died, /Calls it made, in the order they left the kernel \(2 completed, 1 failed; execution [\w-]+\):/);
		assert.match(died, /\n {2}1\. host test\.charge — completed: id=ch_1\n {2}2\. proxy fixture\.echo — completed: job_id=j1\n {2}3\. proxy fixture\.fail — failed: card declined\n/);
		assert.match(died, /every host request and every call to the tool proxy \(HARNESS_MCP_PROXY\) the cell made; nothing else left/);
		assert.match(died, /Check what landed before repeating any of it\.$/m);
	});

	it("a call still in flight when the kernel died is reported as UNKNOWN", { timeout: 120_000 }, async () => {
		const proxy = await startProxy();
		writeApiTree();
		let release;
		const hold = new Promise((r) => {
			release = r;
		});
		const cell = tool({ hostHandlers: { "test.hold": () => hold } });
		try {
			const died = text(
				await cell(
					"import asyncio, os\n" +
						"from rlm import host_request\n" +
						"from api.fixture import slow\n" +
						'asyncio.ensure_future(slow(text="charge"))\n' +
						'asyncio.ensure_future(host_request("test.hold", {}))\n' +
						"await asyncio.sleep(1.5)\n" +
						"os._exit(1)",
				),
			);
			assert.equal(proxy.calls.length, 1, `the held call did not run exactly once:\n${died}`);
			assert.match(died, /\(2 unknown;/);
			assert.match(died, /proxy fixture\.slow — UNKNOWN — no answer came back, so it may or may not have taken effect/);
			assert.match(died, /host test\.hold — UNKNOWN/);
		} finally {
			release({ ok: 1 });
		}
	});

	it("a kernel already dead before the cell is replaced, and the cell runs once", { timeout: 120_000 }, async () => {
		const cell = tool();
		const pid = Number(text(await cell("import os\nprint(os.getpid())")).match(/\d+/)[0]);
		process.kill(pid, "SIGKILL");
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const marker = join(scratch, "once.txt");
		const r = await cell(`open(${JSON.stringify(marker)}, "a").write("ran\\n")\nprint("after")`);
		assert.match(text(r), /after/);
		assert.equal(readFileSync(marker, "utf8"), "ran\n");
	});

	it("with nobody to ask, a kernel stuck on an ignored interrupt is restarted", { timeout: 120_000 }, async () => {
		process.env.HARNESS_CELL_TIMEOUT_MS = "2000";
		const cell = tool();
		const stuck = await cell("import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\ntime.sleep(600)");
		assert.match(text(stuck), /INTERRUPTED/);
		// Longer than the busy wait, so the next cell reaches the busy kernel rather than its own timeout.
		delete process.env.HARNESS_CELL_TIMEOUT_MS;
		const next = await cell("print('fresh')");
		assert.match(text(next), /fresh/);
		assert.match(text(next), /<ipython_kernel_reset>/, "the model is told its state is gone");
	});

	describe("a snapshot that breaks the kernel", () => {
		const writeSnapshot = (dir, reduce) => {
			mkdirSync(dir, { recursive: true });
			execFileSync(KERNEL_PYTHON, [
				"-c",
				"import dill, pickle, sys\n" +
					`class Bad:\n    def __reduce__(self):\n        ${reduce}\n` +
					'dill.dump({"bad": pickle.dumps(Bad())}, open(sys.argv[1], "wb"))',
				join(dir, "kernel-state.dill"),
			]);
		};

		it("one that kills the kernel on restore does not do it on the next boot", { timeout: 120_000 }, async () => {
			const dir = join(scratch, "session");
			writeSnapshot(dir, "import os; return (os._exit, (1,))");
			const cell = tool({ snapshotDir: dir });
			const first = await cell("print('one')").then(text, (e) => e.message);
			const second = first.includes("one") ? first : await cell("print('one')").then(text, (e) => e.message);
			assert.match(second, /one/, `the kernel never came back: ${second}`);
			assert.equal(existsSync(join(dir, "kernel-state.dill.restoring")), true, "the bad snapshot was not kept aside");
		});

		it("one that hangs on restore is abandoned after the deadline", { timeout: 120_000 }, async () => {
			process.env.HARNESS_SNAPSHOT_RESTORE_TIMEOUT_MS = "2000";
			const dir = join(scratch, "session");
			writeSnapshot(dir, "import time; return (time.sleep, (600,))");
			const cell = tool({ snapshotDir: dir });
			const t0 = Date.now();
			assert.match(text(await cell("print('booted')")), /booted/);
			assert.ok(Date.now() - t0 < 60_000, "the restore was not bounded");
		});

		it("one that restores is put back where it was", { timeout: 120_000 }, async () => {
			const dir = join(scratch, "session");
			writeSnapshot(dir, "return (int, (7,))");
			const cell = tool({ snapshotDir: dir });
			assert.match(text(await cell("print(bad * 6)")), /42/);
			assert.equal(existsSync(join(dir, "kernel-state.dill")), true);
			assert.equal(existsSync(join(dir, "kernel-state.dill.restoring")), false);
		});
	});
});

// The report itself, without a kernel: what a dead cell's journal says, and how much.
describe("the dead cell's call report", () => {
	const { CallJournal, describeCellDeath } = KERNEL;
	const HEAD = "This cell did not finish.";

	it("is unchanged when no call was recorded", () => {
		const journal = new CallJournal("e1");
		journal.died();
		assert.equal(describeCellDeath(HEAD, journal), `${HEAD} Check what landed before repeating any of it.`);
	});

	it("caps a long list but never hides an UNKNOWN", () => {
		const journal = new CallJournal("e1", { tunnelled: true });
		for (let i = 1; i <= 20; i++) {
			const settle = journal.begin("tool", `svc.call${i}`);
			if (i !== 10) settle("completed", `id=${i}`);
		}
		journal.died();
		const report = describeCellDeath(HEAD, journal);
		for (const n of [1, 8, 17, 20]) assert.match(report, new RegExp(`\\n  ${n}\\. tool svc\\.call${n} — completed: id=${n}\\n`));
		assert.doesNotMatch(report, /\n {2}9\. /, "a hidden completed call was listed");
		assert.match(report, /… calls 9–16 not listed \(7 completed, 1 unknown\); the unknown ones:\n {2}10\. tool svc\.call10 — UNKNOWN/);
		assert.ok(report.split("\n").length < 25, `the report is not bounded:\n${report}`);
	});

	it("marks a call that settled after the death, and says when the proxy was not observable", () => {
		const journal = new CallJournal("e1");
		const settle = journal.begin("host", "spawn");
		journal.died();
		settle("completed", "name=job-7");
		const report = describeCellDeath(HEAD, journal);
		assert.match(report, /1\. host spawn — completed after the kernel died \(the cell never saw it\): name=job-7/);
		assert.match(report, /Calls to the tool proxy \(HARNESS_MCP_PROXY\) were not observable for this kernel, so it may have made others/);
	});

	it("reads a local kernel's journal from where this execution began, and flags another cell's calls", () => {
		const dir = mkdtempSync(join(tmpdir(), "call-journal-"));
		try {
			const file = join(dir, "calls.jsonl");
			const line = (r) => `${JSON.stringify(r)}\n`;
			writeFileSync(file, line({ k: "open", pid: 1 }) + line({ k: "call", n: 1, msg: "old", at: 1, name: "a.before" }));
			const journal = new CallJournal("cell-2", { kernelFile: file });
			writeFileSync(
				file,
				readFileSync(file, "utf8") +
					line({ k: "end", n: 1, outcome: "completed", summary: "x" }) +
					line({ k: "call", n: 2, msg: "cell-2", at: 2, name: "a.mine" }) +
					line({ k: "end", n: 2, outcome: "completed", summary: '{"job_id": "j2"}' }) +
					line({ k: "call", n: 3, msg: "cell-1", at: 3, name: "a.background" }) +
					"{torn",
			);
			journal.died();
			const calls = journal.calls();
			assert.deepEqual(
				calls.map((c) => [c.id, c.name, c.outcome, c.summary, Boolean(c.background)]),
				[
					["cell-2:1", "a.mine", "completed", "job_id=j2", false],
					["cell-2:2", "a.background", "unknown", undefined, true],
				],
			);
			assert.equal(journal.coversProxy, true);
			assert.match(describeCellDeath(HEAD, journal), /2\. proxy a\.background \(from a background task an earlier cell started\) — UNKNOWN/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
