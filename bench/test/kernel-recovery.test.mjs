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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const IPY = await import(join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/core/tools/ipython.js"));
const KERNEL_PYTHON = process.env.PRIME_AGENT_KERNEL_PYTHON ?? join(homedir(), ".prime/agent/kernel-venv/bin/python");
const KEYS = [
	"PRIME_AGENT_KERNEL_PYTHON",
	"HARNESS_KERNEL_SANDBOX",
	"HARNESS_KERNEL_AUTORESTART",
	"HARNESS_CELL_TIMEOUT_MS",
	"HARNESS_SNAPSHOT_RESTORE_TIMEOUT_MS",
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
