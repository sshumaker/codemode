// The behaviour suite against the in-process fake: the real kernel server on this
// machine, driving a real local ipykernel. No Daytona, no network needed after the
// test venv exists.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIST, startFakeServer } from "./fake-server.mjs";
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
});
