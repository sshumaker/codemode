import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LocalKernelBackend, walkOutputs } from "../local.mjs";
import { createKernelBackend } from "../select.mjs";
import { HostWorkspaceFiles } from "../workspace-files.mjs";

const PY = "/usr/bin/python3";
const select = (name, platform, env = {}) => createKernelBackend({ name, kernelPython: PY, platform, env });

function scratch() {
	const dir = mkdtempSync(join(tmpdir(), "hk-kernel-"));
	for (const d of ["work", "api", "tmp", "bin"]) mkdirSync(join(dir, d));
	const ctx = (id) => ({
		conversationId: id,
		userId: "u1",
		convDir: dir,
		workDir: join(dir, "work"),
		apiTreeDir: join(dir, "api"),
		skillRoots: [],
		tmpDir: join(dir, "tmp"),
		agentBinDir: join(dir, "bin"),
		egressToken: "tok",
		toolProxyPath: "/tool-proxy",
		localBaseUrl: "http://127.0.0.1:1",
	});
	return { dir, ctx, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("kernel backend selection", () => {
	test("local refuses to start off macOS; daytona is available anywhere; unknown names refuse", () => {
		assert.throws(() => select("local", "linux"), /only sets up on macOS[\s\S]*local-unsafe/);
		assert.equal(select("local", "darwin").name, "local");
		assert.equal(select("daytona", "linux", { DAYTONA_API_KEY: "k" }).name, "daytona");
		assert.throws(() => select("daytona", "linux", {}), /needs DAYTONA_API_KEY[\s\S]*local-unsafe/);
		assert.throws(() => select("nope", "linux"), /not built into the harness/);
		assert.throws(
			() => createKernelBackend({ name: "daytona", kernelPython: PY, env: { DAYTONA_API_KEY: "k" }, harnessRoot: "/nowhere" }),
			/needs a harness with runtime\/daytona/,
		);
	});

	test("local-unsafe says so on the log, turns the sandbox off explicitly and never sets srt settings", async () => {
		const warned = [];
		const backend = createKernelBackend({ name: "local-unsafe", kernelPython: PY, platform: "linux", log: { info() {}, warn: (m) => warned.push(m) } });
		assert.equal(backend.name, "local-unsafe");
		assert.deepEqual(warned, ["kernel sandbox disabled (KERNEL_BACKEND=local-unsafe)"]);
		const s = scratch();
		try {
			const session = await backend.open(s.ctx("c1"));
			assert.equal(session.primeEnv.HARNESS_KERNEL_SANDBOX, "off");
			assert.equal(session.primeEnv.HARNESS_KERNEL_SANDBOX_SETTINGS, undefined);
			assert.equal(session.primeEnv.HARNESS_KERNEL_SANDBOX_BIN, undefined);
			assert.ok(session.primeEnv.HARNESS_KERNEL_ENV_ALLOW, "the kernel env is still built from the allow-list");
			assert.equal(session.primeEnv.HARNESS_MCP_PROXY, "http://127.0.0.1:1/tool-proxy");
			const safe = await select("local", "darwin").open(s.ctx("c2"));
			assert.equal(safe.primeEnv.HARNESS_KERNEL_SANDBOX, undefined);
			assert.ok(safe.primeEnv.HARNESS_KERNEL_SANDBOX_SETTINGS);
		} finally {
			s.done();
		}
	});
});

describe("local kernel backend", () => {
	test("stages hooks, the env hook, the app's startup files and the prelude; srt reads only this conversation", async () => {
		const s = scratch();
		try {
			const backend = new LocalKernelBackend({ kernelPython: PY, extraStartupFiles: { "07-computer-fs.py": "X = 1\n" } });
			const ctx = { ...s.ctx("c1"), timeZone: "Europe/Paris" };
			const session = await backend.open(ctx);
			const env = session.primeEnv;
			const startup = join(env.IPYTHONDIR, "profile_default/startup");
			const names = readdirSync(startup).sort();
			for (const n of ["00-eperm-correction.py", "05-api-doc-expansion.py", "06-aw-env.py", "07-computer-fs.py", "10-harness-prelude.py"])
				assert.ok(names.includes(n), `${n} staged`);
			assert.equal(readFileSync(join(startup, "07-computer-fs.py"), "utf8"), "X = 1\n");
			const staged = readdirSync(env.HARNESS_RUNTIME_DIR);
			for (const m of ["jobs.py", "scheduler.py", "invocations.py"]) assert.ok(staged.includes(m), `the prelude's runtime is beside it (${m})`);
			assert.equal(env.HARNESS_JOB_DIR, join(ctx.workDir, ".jobs"));
			assert.equal(env.TZ, "Europe/Paris");
			assert.equal(env.HARNESS_EGRESS_TOKEN, "tok");
			assert.equal(env.PRIME_AGENT_KERNEL_PYTHON, PY);
			assert.equal(env.CLAUDE_CODE_TMPDIR, ctx.tmpDir);
			const settings = JSON.parse(readFileSync(env.HARNESS_KERNEL_SANDBOX_SETTINGS, "utf8"));
			assert.ok(JSON.stringify(settings).includes(ctx.apiTreeDir), "the api tree is readable");
			assert.equal(session.primeCwd, ctx.workDir);
			assert.deepEqual(session.workDirAliases, []);
			assert.equal(session.schedulerPollMs, 2000);
			assert.equal(typeof session.scheduler, "function");
			assert.equal(await session.restored, undefined, "files never leave the host, so nothing is restored");
		} finally {
			s.done();
		}
	});

	test("outputs are the host's own files; workspace files stay inside the work dir", async () => {
		const s = scratch();
		try {
			const session = await new LocalKernelBackend({ kernelPython: PY, sandbox: false }).open(s.ctx("c1"));
			const work = join(s.dir, "work");
			mkdirSync(join(work, "outputs/sub"), { recursive: true });
			writeFileSync(join(work, "outputs/b.txt"), "bb");
			writeFileSync(join(work, "outputs/sub/a.txt"), "a");
			writeFileSync(join(work, "outputs/.hidden"), "h");
			assert.deepEqual(
				(await session.listOutputs()).map((f) => [f.path, f.size]),
				[
					["outputs/b.txt", 2],
					["outputs/sub/a.txt", 1],
				],
			);
			assert.deepEqual(walkOutputs(work).length, 2);
			assert.equal((await session.readOutput("outputs/b.txt")).toString(), "bb");
			assert.ok(session.files instanceof HostWorkspaceFiles);
			writeFileSync(join(s.dir, "secret"), "s");
			symlinkSync(join(s.dir, "secret"), join(work, "outputs/link"));
			await assert.rejects(session.files.readFile("outputs/link", 100), /points outside the workspace/);
			await assert.rejects(session.files.readFile("outputs/b.txt", 1), /the cap is/);
			await assert.rejects(session.files.writeFile("outputs/link", Buffer.from("x")), /symbolic link/);
			await session.files.writeFile("outputs/new/c.txt", Buffer.from("c"));
			assert.equal(readFileSync(join(work, "outputs/new/c.txt"), "utf8"), "c");
		} finally {
			s.done();
		}
	});
});
