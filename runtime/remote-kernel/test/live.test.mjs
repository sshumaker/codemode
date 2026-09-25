// The behaviour suite against a real Daytona sandbox with all egress blocked, plus
// what only a real sandbox can show: stop -> start -> reattach keeping files and the
// namespace, certification (no route out, no secret in), and one real prime turn.
//
// Skipped without DAYTONA_API_KEY. Every sandbox carries
// {app: assistant-workspace, purpose: harness-remote-kernel-dev, env: test} and is
// deleted in the final `after`, which also asserts none remain.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { certifySandbox } from "../../daytona/certify.mjs";
import { DaytonaKernelProvider } from "../../daytona/provider.mjs";
import { DIST } from "./fake-server.mjs";
import { assertPrimeTurn, loadModelEnv, runPrimeTurn } from "./prime-turn.mjs";
import { defineKernelSuite, EGRESS_TOKEN, fixtureApiTree, startFixtureProxy } from "./suite.mjs";

const R = `${DIST}/core/kernel/remote`;
const { RemoteKernelLink } = await import(`${R}/link.js`);
const { RemoteKernelManager, dispatchHostRequest } = await import(`${R}/manager.js`);
const { RemotePathMap } = await import(`${R}/pathmap.js`);
const { forwardToolCall } = await import(`${R}/tools.js`);
const { connectionEnv } = await import("../../daytona/provider.mjs");

const LIVE = Boolean(process.env.DAYTONA_API_KEY);
const TEST_LABELS = { purpose: "harness-remote-kernel-dev", env: "test" };
const RUN = `t${Date.now().toString(36)}`;
const provider = LIVE
	? new DaytonaKernelProvider({ labels: TEST_LABELS, autoDeleteMinutes: 180, log: (l) => console.log(`[provider] ${l}`) })
	: undefined;
export const liveTimings = {};

function target(conversationId) {
	return async () => {
		const apiDirs = [];
		let info = await provider.ensure(conversationId);
		liveTimings[`${conversationId}.ensure`] = info.timings;
		return {
			boundary: "daytona-sandbox",
			requireBlockedEgress: true,
			remoteCwd: info.remoteCwd,
			timings: liveTimings,
			connection: () => ({ url: info.url, token: info.token, headers: info.headers }),
			putTree: async (dir, rel) => {
				apiDirs.push({ local: dir, remote: rel });
				info = await provider.ensure(conversationId, { mounts: apiDirs });
			},
			cleanup: async () => {},
		};
	};
}

// RK_LIVE_SKIP_SUITE=1 runs only the lifecycle/certification/prime block below.
if (LIVE && process.env.RK_LIVE_SKIP_SUITE !== "1") {
	defineKernelSuite("daytona", target(`${RUN}-suite`), { longBlockSeconds: Number(process.env.RK_LONG_BLOCK_SECONDS ?? 60) });
}

describe("remote kernel [daytona] lifecycle, certification, prime", { skip: !LIVE && "no DAYTONA_API_KEY" }, () => {
	const conv = `${RUN}-life`;
	let info;
	let proxy;
	before(async () => {
		proxy = await startFixtureProxy();
		const t0 = Date.now();
		info = await provider.ensure(conv, { mounts: [{ local: fixtureApiTree(), remote: "api" }] });
		liveTimings.lifeEnsureMs = Date.now() - t0;
		liveTimings.lifeEnsure = info.timings;
	});
	after(async () => {
		await proxy?.close();
		console.log("live timings", JSON.stringify(liveTimings));
	});

	const connect = (i) => {
		const link = new RemoteKernelLink({ connection: () => ({ url: i.url, token: i.token, headers: i.headers }) });
		link.handlers.hostRequest = dispatchHostRequest;
		link.handlers.httpRequest = (m, signal) =>
			forwardToolCall({ toolProxy: proxy.url, egressToken: EGRESS_TOKEN, toolTimeoutMs: 60_000 }, m, signal);
		return link;
	};
	const manager = (link, i, key) =>
		new RemoteKernelManager({ link, pathMap: new RemotePathMap([]), remoteCwd: i.remoteCwd, sessionId: key, snapshotKey: key });

	it("moves conversation files in and out", async () => {
		await provider.uploadFile(conv, "inputs/data.csv", "a,b\n1,2\n3,4\n");
		const link = connect(info);
		const km = manager(link, info, `${conv}-files`);
		await km.start();
		const r = await km.execute("import pandas as pd\ndf = pd.read_csv('inputs/data.csv')\ndf.to_csv('outputs/sum.csv', index=False)\nprint(int(df.b.sum()))");
		assert.equal(r.stdout.trim(), "6");
		const files = await provider.listFiles(conv, "outputs");
		assert.ok(files.some((f) => f.name === "sum.csv"), JSON.stringify(files));
		assert.match((await provider.readFile(conv, "outputs/sum.csv")).toString(), /^a,b\n1,2\n3,4/);
		await assert.rejects(provider.readFile(conv, "../../etc/passwd"), /outside the conversation's work dir/);
		await km.dispose();
		await link.close({ bye: true });
	});

	it("stop -> start -> reattach keeps files and revives the namespace", { timeout: 300_000 }, async () => {
		const key = `${conv}-persist`;
		let link = connect(info);
		let km = manager(link, info, key);
		await km.start();
		await km.execute("kept = {'rows': [1, 2, 3]}\nopen('outputs/keep.txt', 'w').write('survives a stop')");
		await km.snapshotState();
		await km.dispose();
		await link.close({ bye: true });
		const t0 = Date.now();
		assert.equal((await provider.stop(conv)).stopped, true);
		liveTimings.stopMs = Date.now() - t0;
		const t1 = Date.now();
		info = await provider.ensure(conv, { mounts: [{ local: fixtureApiTree(), remote: "api" }] });
		liveTimings.restartEnsureMs = Date.now() - t1;
		liveTimings.restartEnsure = info.timings;
		link = connect(info);
		km = manager(link, info, key);
		const t2 = Date.now();
		await km.start();
		liveTimings.kernelStartAfterRestartMs = Date.now() - t2;
		assert.equal(await km.snapshotExists(), true);
		const restored = await km.restoreState();
		assert.ok(restored?.restored.includes("kept"), JSON.stringify(restored));
		const r = await km.execute("print(kept['rows'], open('outputs/keep.txt').read())");
		assert.equal(r.stdout.trim(), "[1, 2, 3] survives a stop");
		assert.equal(km.posture.egress, "blocked", "a restarted sandbox is still locked");
		await km.dispose();
		await link.close({ bye: true });
	});

	it("certifies: no route out, the one door open, no loop secret anywhere inside", { timeout: 600_000 }, async () => {
		const env = loadModelEnv();
		const link = connect(info);
		const km = manager(link, info, `${conv}-cert`);
		await km.start();
		const secrets = {
			ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
			DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
			HARNESS_EGRESS_TOKEN: EGRESS_TOKEN,
			CONNECTOR_TOKEN_STANDIN: "ya29_connector_token_standin_held_by_the_gateway",
		};
		const toolDoorWorks = async () => {
			const r = await km.execute("from api.fixture import echo\nprint(await echo(text='door'))");
			return /echo:\{"text":"door"\}/.test(r.stdout);
		};
		const report = await certifySandbox({ km, secrets, toolDoorWorks });
		console.log("certification", JSON.stringify(report, null, 1));
		assert.ok(report.secretsChecked.includes("ANTHROPIC_API_KEY"), "the model key must be among those checked");
		for (const c of report.checks) assert.ok(c.ok, `${c.name}: ${JSON.stringify(c.detail)}`);
		await km.dispose();
		await link.close({ bye: true });
	});

	it("runs one real prime turn whose tool call crosses the tunnel and whose file it reads back", { timeout: 600_000 }, async () => {
		const callsBefore = proxy.calls.length;
		const r = await runPrimeTurn({ connectionEnv: connectionEnv(info), proxyUrl: proxy.url, egressToken: EGRESS_TOKEN, label: "daytona" });
		liveTimings.primeTurnMs = r.wallMs;
		liveTimings.primeTurnCostUsd = r.cost;
		console.log(`prime turn: exit ${r.status}, ${r.wallMs}ms, $${r.cost.toFixed(4)}, transcript ${r.transcript}\n${JSON.stringify(r.tools)}\n${r.stderr.slice(-1000)}`);
		assertPrimeTurn(r, { proxy, callsBefore, egressToken: EGRESS_TOKEN });
		assert.match((await provider.readFile(conv, "outputs/tool.txt")).toString(), /echo:\{"text":"sandbox-turn"\}/);
	});
});

after(async () => {
	if (!LIVE) return;
	const deleted = await provider.reap({ knownConversationIds: [] });
	console.log(`reaped ${deleted.length} test sandboxes: ${deleted.map((d) => d.sandboxId).join(", ")}`);
	const left = await provider.listOrphans();
	assert.equal(left.length, 0, `test sandboxes left behind: ${JSON.stringify(left)}`);
});
