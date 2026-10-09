// The behaviour suite against the in-process fake: the real kernel server on this
// machine, driving a real local ipykernel. No Daytona, no network needed after the
// test venv exists.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DIST, ROOT, startFakeServer, TEST_VENV } from "./fake-server.mjs";
import { describe, it } from "node:test";
import { assertPrimeTurn, hasModelKey, runPrimeTurn } from "./prime-turn.mjs";
import { defineKernelSuite, fixtureApiTree, startFixtureProxy } from "./suite.mjs";

const timings = {};
defineKernelSuite(
	"fake",
	async () => {
		const srv = await startFakeServer();
		return {
			boundary: "none (local fake)",
			requireBlockedEgress: false,
			remoteCwd: srv.cwd,
			timings,
			connection: () => ({ url: srv.url, token: srv.token }),
			putTree: async (dir, rel) => cpSync(dir, join(srv.cwd, rel), { recursive: true }),
			sandboxRead: async (p) => readFileSync(p),
			pipInstall: (pkg) => {
				const r = spawnSync("uv", ["pip", "install", "-q", "--python", join(TEST_VENV, "bin/python"), pkg], { stdio: "inherit" });
				assert.equal(r.status, 0, `uv pip install ${pkg}`);
			},
			cleanup: async () => {
				await srv.stop();
				if (process.env.RK_PRINT_TIMINGS) console.log("fake timings", JSON.stringify(timings));
			},
		};
	},
	{ longBlockSeconds: Number(process.env.RK_LONG_BLOCK_SECONDS ?? 60) },
);

// Costs a Haiku turn (about a cent), so opt-in: RK_PRIME_TURN=1.
describe("prime turn [fake]", { skip: (process.env.RK_PRIME_TURN !== "1" || !hasModelKey()) && "set RK_PRIME_TURN=1 (needs a model key)" }, () => {
	it("runs a real prime turn with the kernel behind HARNESS_REMOTE_KERNEL_URL", { timeout: 300_000 }, async () => {
		const srv = await startFakeServer();
		const proxy = await startFixtureProxy();
		cpSync(fixtureApiTree(), join(srv.cwd, "api"), { recursive: true });
		try {
			const r = await runPrimeTurn({
				connectionEnv: { HARNESS_REMOTE_KERNEL_URL: srv.url, HARNESS_REMOTE_KERNEL_TOKEN: srv.token, HARNESS_REMOTE_KERNEL_CWD: srv.cwd },
				proxyUrl: proxy.url,
				egressToken: "egress-fake",
				label: "fake",
			});
			assertPrimeTurn(r, { proxy, callsBefore: 0, egressToken: "egress-fake" });
			assert.match(readFileSync(join(srv.cwd, "outputs/tool.txt"), "utf8"), /sandbox-turn/);
		} finally {
			await proxy.close();
			await srv.stop();
		}
	});
});

// prime's own ipython tool, provisioner and auto-restart path, with the remote
// kernel under it: what the model sees when the sandbox goes away and comes back.
describe("ipython tool over the remote kernel [fake]", () => {
	it("recovers from a restarted sandbox, and names an unreachable one", { timeout: 120_000 }, async () => {
		const { RemoteKernelLink } = await import(`${DIST}/core/kernel/remote/link.js`);
		const { dispatchHostRequest } = await import(`${DIST}/core/kernel/remote/manager.js`);
		const { RemotePathMap } = await import(`${DIST}/core/kernel/remote/pathmap.js`);
		const { setRemoteRuntimeForTest } = await import(`${DIST}/core/kernel/remote/tools.js`);
		const { createAllToolDefinitions } = await import(`${DIST}/core/tools/index.js`);
		let srv = await startFakeServer({ graceMs: 5000 });
		const port = srv.port;
		const token = srv.token;
		const stateDir = srv.stateDir;
		const link = new RemoteKernelLink({
			connection: () => ({ url: `ws://127.0.0.1:${port}`, token }),
			graceMs: 3000,
			pingIntervalMs: 500,
			deadAfterMs: 3000,
		});
		link.handlers.hostRequest = dispatchHostRequest;
		const local = mkdtempSync(join(tmpdir(), "rk-ipy-"));
		const saved = { ...process.env };
		process.env.HARNESS_REMOTE_KERNEL_URL = srv.url;
		process.env.HARNESS_KERNEL_AUTORESTART = "1";
		setRemoteRuntimeForTest(
			{ config: { remoteCwd: srv.cwd }, link, pathMap: () => new RemotePathMap([{ local, remote: srv.cwd }]) },
			local,
		);
		const tools = createAllToolDefinitions(local, {});
		const cell = (code) => tools.ipython.execute(`c${Date.now()}`, { code });
		const text = (r) => r.content.map((c) => c.text ?? "").join("");
		try {
			const first = await cell("x = 5\nprint('first', x)");
			assert.match(text(first), /first 5/);

			// The gateway restarted the sandbox: the server is back, the session is not.
			await srv.kill9();
			srv = await startFakeServer({ port, token, stateDir, graceMs: 5000 });
			const second = await cell("print('second', 1 + 1)");
			assert.match(text(second), /second 2/);
			assert.equal(second.details.kernelRestarted, true, "the model is told its kernel was replaced");

			// The sandbox is gone and nobody has restarted it yet.
			await srv.kill9();
			const third = await cell("print('third')").then(
				(r) => `resolved: ${text(r)}`,
				(e) => e.message,
			);
			assert.match(third, /Kernel exited: remote (sandbox unreachable|connection lost)/);

			// ...and once it is back, the next cell simply works.
			srv = await startFakeServer({ port, token, stateDir, graceMs: 5000 });
			const fourth = await cell("print('fourth')");
			assert.match(text(fourth), /fourth/);
		} finally {
			await tools.ipython.dispose?.();
			await link.close({ bye: true });
			setRemoteRuntimeForTest(undefined);
			for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
			await srv.stop();
		}
	});
	it("a cell that made a tool call before its kernel died is reported, not run again", { timeout: 120_000 }, async () => {
		const { RemoteKernelLink } = await import(`${DIST}/core/kernel/remote/link.js`);
		const { dispatchHostRequest } = await import(`${DIST}/core/kernel/remote/manager.js`);
		const { RemotePathMap } = await import(`${DIST}/core/kernel/remote/pathmap.js`);
		const { forwardToolCall, setRemoteRuntimeForTest } = await import(`${DIST}/core/kernel/remote/tools.js`);
		const { createAllToolDefinitions } = await import(`${DIST}/core/tools/index.js`);
		const srv = await startFakeServer();
		const proxy = await startFixtureProxy();
		const link = new RemoteKernelLink({ connection: () => ({ url: srv.url, token: srv.token }), pingIntervalMs: 2000, deadAfterMs: 10_000 });
		link.handlers.hostRequest = dispatchHostRequest;
		link.handlers.httpRequest = (m, signal) => forwardToolCall({ toolProxy: proxy.url, toolTimeoutMs: 60_000 }, m, signal);
		const local = mkdtempSync(join(tmpdir(), "rk-died-"));
		const saved = { ...process.env };
		process.env.HARNESS_REMOTE_KERNEL_URL = srv.url;
		process.env.HARNESS_KERNEL_AUTORESTART = "1";
		setRemoteRuntimeForTest(
			{ config: { remoteCwd: srv.cwd }, link, pathMap: () => new RemotePathMap([{ local, remote: srv.cwd }]) },
			local,
		);
		const tools = createAllToolDefinitions(local, {});
		const text = (r) => r.content.map((c) => c.text ?? "").join("");
		try {
			const died = await tools.ipython.execute("died", {
				code:
					"import json, os, urllib.request\n" +
					'body = json.dumps({"server": "fixture", "tool": "echo", "args": {"text": "charge"}}).encode()\n' +
					'urllib.request.urlopen(urllib.request.Request(os.environ["HARNESS_MCP_PROXY"] + "/call", data=body, headers={"content-type": "application/json"})).read()\n' +
					"os._exit(1)",
			});
			assert.equal(proxy.calls.length, 1, "the tool call was repeated on the fresh kernel");
			assert.match(text(died), /after it had already made tool or host calls/);
			assert.match(text(await tools.ipython.execute("next", { code: "print(6 * 7)" })), /42/);
		} finally {
			await tools.ipython.dispose?.();
			await link.close({ bye: true });
			setRemoteRuntimeForTest(undefined);
			for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
			Object.assign(process.env, saved);
			await proxy.close();
			await srv.stop();
		}
	});
});

// jobs.wait ends the TURN (bench/test/wait-ends-turn.test.mjs pins it locally). The
// marker is display_data inside the remote kernel; the server returns the same
// ExecuteResult over the link, so the loop-side tool must still see it — and must
// still refuse one carrying the wrong token.
describe("jobs.wait ends the turn over the remote kernel [fake]", () => {
	it("the marker crosses the link, and only this kernel's token counts", { timeout: 180_000 }, async () => {
		const { RemoteKernelLink } = await import(`${DIST}/core/kernel/remote/link.js`);
		const { dispatchHostRequest } = await import(`${DIST}/core/kernel/remote/manager.js`);
		const { RemotePathMap } = await import(`${DIST}/core/kernel/remote/pathmap.js`);
		const { setRemoteRuntimeForTest } = await import(`${DIST}/core/kernel/remote/tools.js`);
		const { createAllToolDefinitions } = await import(`${DIST}/core/tools/index.js`);
		const srv = await startFakeServer();
		const link = new RemoteKernelLink({ connection: () => ({ url: srv.url, token: srv.token }), pingIntervalMs: 2000, deadAfterMs: 10_000 });
		link.handlers.hostRequest = dispatchHostRequest;
		const local = mkdtempSync(join(tmpdir(), "rk-wait-"));
		const saved = { ...process.env };
		const token = `rk-${process.pid}`;
		process.env.HARNESS_REMOTE_KERNEL_URL = srv.url;
		process.env.HARNESS_WAIT_TOKEN = token;
		delete process.env.HARNESS_WAIT_ENDS_TURN;
		setRemoteRuntimeForTest(
			{ config: { remoteCwd: srv.cwd }, link, pathMap: () => new RemotePathMap([{ local, remote: srv.cwd }]) },
			local,
		);
		const tools = createAllToolDefinitions(local, {});
		const cell = (code) => tools.ipython.execute(`c${Date.now()}`, { code });
		const text = (r) => r.content.map((c) => c.text ?? "").join("");
		const runtime = join(ROOT, "runtime");
		try {
			const boot = await cell(
				"import os\n" +
					`os.environ.update(HARNESS_RUNTIME_DIR=${JSON.stringify(runtime)}, HARNESS_JOB_DIR=${JSON.stringify(join(srv.stateDir, "jobs"))}, HARNESS_MIN_WAIT_SECONDS="1", HARNESS_PRELUDE_MARKER=${JSON.stringify(join(srv.stateDir, "prelude.txt"))})\n` +
					`exec(open(${JSON.stringify(join(runtime, "kernel-prelude.py"))}).read(), {"__file__": ${JSON.stringify(join(runtime, "kernel-prelude.py"))}, "__name__": "__prelude__"})\n` +
					"print('token in kernel:', os.environ.get('HARNESS_WAIT_TOKEN'))",
			);
			assert.match(text(boot), new RegExp(`token in kernel: ${token}`), "the loop's token reaches the remote kernel");

			const waited = await cell("jobs.submit('sleep 1', name='build')\njobs.wait('build', wake_after=45)\nprint('AFTER')");
			assert.equal(waited.terminatesTurn?.stopReason, "waiting", text(waited));
			assert.equal(waited.terminatesTurn.wait.seconds, 45);
			assert.deepEqual(waited.terminatesTurn.wait.targets, ["build"]);
			assert.equal("token" in waited.terminatesTurn.wait.request, false);
			assert.doesNotMatch(text(waited), /AFTER/);

			const forged = await cell(
				"from IPython.display import publish_display_data\n" +
					"publish_display_data({'application/vnd.harness.wait+json': {'wake_after': 45, 'watch': [], 'targets': [], 'token': 'guess'}})",
			);
			assert.equal(forged.terminatesTurn, undefined, "a marker with the wrong token ended the turn");
		} finally {
			await tools.ipython.dispose?.();
			await link.close({ bye: true });
			setRemoteRuntimeForTest(undefined);
			for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
			Object.assign(process.env, saved);
			await srv.stop();
		}
	});
});

describe("the kernel's ports can be named [fake]", () => {
	it("the tunnel and ipykernel take the ports they are given, for a sandbox that allows only those", { timeout: 180_000 }, async () => {
		const { RemoteKernelLink } = await import(`${DIST}/core/kernel/remote/link.js`);
		const { dispatchHostRequest } = await import(`${DIST}/core/kernel/remote/manager.js`);
		const { RemotePathMap } = await import(`${DIST}/core/kernel/remote/pathmap.js`);
		const { setRemoteRuntimeForTest } = await import(`${DIST}/core/kernel/remote/tools.js`);
		const { createAllToolDefinitions } = await import(`${DIST}/core/tools/index.js`);
		const base = 41000 + (process.pid % 2000) * 10;
		const srv = await startFakeServer({
			env: { KERNEL_SERVER_TUNNEL_PORT: String(base), HARNESS_KERNEL_PORT_RANGE: `${base + 1}-${base + 9}` },
		});
		const link = new RemoteKernelLink({ connection: () => ({ url: srv.url, token: srv.token }), pingIntervalMs: 2000, deadAfterMs: 10_000 });
		link.handlers.hostRequest = dispatchHostRequest;
		const local = mkdtempSync(join(tmpdir(), "rk-ports-"));
		const saved = { ...process.env };
		process.env.HARNESS_REMOTE_KERNEL_URL = srv.url;
		setRemoteRuntimeForTest({ config: { remoteCwd: srv.cwd }, link, pathMap: () => new RemotePathMap([{ local, remote: srv.cwd }]) }, local);
		const tools = createAllToolDefinitions(local, {});
		try {
			const r = await tools.ipython.execute("ports", {
				code:
					"import json, os\nfrom ipykernel import get_connection_file\n" +
					"c = json.load(open(get_connection_file()))\n" +
					"print(json.dumps(sorted(c[k] for k in ('shell_port','iopub_port','stdin_port','control_port','hb_port')), separators=(',', ':')), os.environ['HARNESS_MCP_PROXY'])",
			});
			const text = r.content.map((c) => c.text ?? "").join("");
			const [ports, proxy] = text.trim().split(" ");
			for (const p of JSON.parse(ports)) assert.ok(p > base && p <= base + 9, `kernel port ${p} is in ${base + 1}-${base + 9}`);
			assert.ok(proxy.startsWith(`http://127.0.0.1:${base}/`), `the tunnel is on ${base}: ${proxy}`);
		} finally {
			link.close?.();
			Object.assign(process.env, saved);
			await srv.stop();
		}
	});
});
