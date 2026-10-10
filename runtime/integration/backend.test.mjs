/**
 * The local kernel backend (runtime/kernel/local.mjs), end to end: it stages a
 * conversation's IPython dir and runtime and writes its srt posture; prime launches the
 * kernel from that, sandboxed, and a scripted agent uses what was staged.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LocalKernelBackend } from "../kernel/local.mjs";
import { SCRIPTS, kernelPython, missingPrereqs, runPrime, scenario, startToolProxy } from "./lib.mjs";

const missing = missingPrereqs();
if (process.platform !== "darwin") missing.push("the local (srt) backend runs on macOS only");
const skip = missing.length ? missing.join("; ") : false;

describe("integration: local kernel backend", { skip }, () => {
	it("opens a real sandboxed kernel with the staged runtime (jobs, invocations), loopback to the proxy, nothing else readable", { timeout: 180_000 }, async () => {
		const n = randomBytes(3).toString("hex");
		const proxy = await startToolProxy();
		const secretDir = `/tmp/hit-secret-${n}`;
		const secret = join(secretDir, "secret.txt");
		const opts = { script: join(SCRIPTS, "local-backend.json"), vars: { NONCE: n, SECRET_PY: JSON.stringify(secret) } };
		await scenario("local-backend", opts, async (w) => {
			w.cleanups.push(proxy.close);
			mkdirSync(secretDir, { recursive: true });
			writeFileSync(secret, "do not read");
			w.cleanups.push(async () => (await import("node:fs")).rmSync(secretDir, { recursive: true, force: true }));
			const conv = join(w.root, "conv");
			for (const d of ["work", "api", "bin"]) mkdirSync(join(conv, d), { recursive: true });
			mkdirSync(join(w.tmp, "c"));
			const ctx = {
				conversationId: "c1",
				userId: "u1",
				convDir: conv,
				workDir: join(conv, "work"),
				apiTreeDir: join(conv, "api"),
				skillRoots: [],
				tmpDir: join(w.tmp, "c"),
				agentBinDir: join(conv, "bin"),
				egressToken: `tok-${n}`,
				toolProxyPath: "/tool-proxy",
				localBaseUrl: proxy.url.replace(/\/$/, ""),
			};
			const session = await new LocalKernelBackend({ kernelPython: kernelPython(), sandbox: true }).open(ctx);
			await session.ready;
			const runtimeDir = session.primeEnv.HARNESS_RUNTIME_DIR;
			for (const m of ["jobs.py", "invocations.py", "scheduler.py"]) assert.ok(existsSync(join(runtimeDir, m)), `${m} staged`);

			// The host's env for prime: this world's model and daemon, the backend's kernel env.
			const { HARNESS_KERNEL_SANDBOX, IPYTHONDIR, HARNESS_RUNTIME_DIR, HARNESS_JOB_CWD, ...base } = w.env;
			const env = { ...base, ...session.primeEnv, TMPDIR: ctx.tmpDir };
			const run = await runPrime(w, { env, cwd: session.primeCwd, message: `GOLF-${n} use the staged runtime` });
			await session.release();

			assert.equal(run.code, 0, run.stderr.slice(-2000));
			assert.deepEqual(w.model.errors, []);
			assert.equal(w.model.requests.length, 3);
			const first = w.model.requests[1].last;
			assert.match(first, new RegExp(`RUNTIME ${runtimeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), first);
			assert.match(first, new RegExp(`JOBDIR ${join(ctx.workDir, ".jobs")}`));
			assert.match(first, /SECRET-DENIED PermissionError/, "srt denied a read outside the conversation");
			assert.match(first, /PROXY \{"ok":true,"text":"lookup-result"\}/, "loopback reaches the tool proxy");
			assert.equal(proxy.count("lookup"), 1);
			const second = w.model.requests[2].last;
			assert.match(second, /JOB done staged-job-ok/);
			assert.match(second, /\["job", "staged", "succeeded"\]/, "the job projects into the staged invocation store");
			assert.match(second, /\["call", "fake\.lookup", "succeeded"\]/, "and so does the proxy call, through the call journal");
			const store = readdirSync(join(ctx.workDir, ".jobs", "invocations"));
			assert.ok(store.map(decodeURIComponent).some((f) => f.startsWith("job:staged@")), store.join(","));
		});
	});
});
