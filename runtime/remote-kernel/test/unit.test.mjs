// Unit tests for the remote kernel's pure parts: the wire codec, the reliable
// channel, path translation, env filtering, error mapping, and skill hashing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { DIST } from "./fake-server.mjs";

const R = `${DIST}/core/kernel/remote`;
const protocol = await import(`${R}/protocol.js`);
const { ReliableChannel } = await import(`${R}/channel.js`);
const { RemotePathMap } = await import(`${R}/pathmap.js`);
const server = await import(`${R}/server.js`);
const { hashSkillPackage, placeSkills, remoteSkill } = await import(`${R}/skills.js`);
const { forwardedKernelEnv, remoteKernelConfigFromEnv, RemoteKernelPendingError, toWebSocketUrl } = await import(
	`${R}/config.js`
);
const { KernelBusyAfterInterruptError } = await import(`${DIST}/core/kernel/index.js`);

describe("protocol codec", () => {
	it("round-trips a data frame and a control frame", () => {
		const d = { t: "d", seq: 3, m: { op: "execute", id: 7, kernel: "k", code: "1+1" } };
		assert.deepEqual(protocol.decodeClientFrame(protocol.encodeFrame(d)), d);
		const ping = { t: "ping", n: 1, ack: 0 };
		assert.deepEqual(protocol.decodeServerFrame(Buffer.from(protocol.encodeFrame(ping))), ping);
	});

	it("rejects what the other side would never send", () => {
		const bad = [
			"not json",
			JSON.stringify({ nope: 1 }),
			JSON.stringify({ t: "d", seq: 0, m: { op: "noop", id: 1 } }),
			JSON.stringify({ t: "d", seq: 1, m: { op: "result", id: 1 } }), // a server op, sent to the server
			JSON.stringify({ t: "ping", n: 1 }), // heartbeat without ack
			JSON.stringify({ t: "hello", v: 2 }), // hello without session
			JSON.stringify({ t: "launch" }),
		];
		for (const raw of bad) assert.throws(() => protocol.decodeClientFrame(raw), protocol.ProtocolError, raw);
	});

	it("refuses a host or tool call frame over 1 MB, and no other kind", () => {
		const big = "x".repeat(protocol.MAX_CALL_FRAME_CHARS);
		const http = { op: "http_request", reqId: 1, kernel: "k", method: "POST", path: "/call", headers: {}, body: big };
		const host = { op: "host_request", reqId: 2, kernel: "k", payload: { type: "t", blob: big } };
		for (const m of [http, host]) {
			assert.equal(protocol.isOversizedCall(m), true);
			assert.throws(() => protocol.decodeServerFrame(protocol.encodeFrame({ t: "d", seq: 1, m })), /exceeds the 1048576 cap/);
		}
		const result = { op: "result", id: 1, ok: true, value: big, serverMs: 0 };
		assert.equal(protocol.decodeServerFrame(protocol.encodeFrame({ t: "d", seq: 1, m: result })).m.op, "result");
		assert.equal(protocol.isOversizedCall({ ...http, body: "small" }), false);
	});

	it("keeps the server/client op sets apart", () => {
		const result = JSON.stringify({ t: "d", seq: 1, m: { op: "result", id: 1, ok: true, value: 1, serverMs: 0 } });
		assert.equal(protocol.decodeServerFrame(result).m.op, "result");
		assert.throws(() => protocol.decodeServerFrame(JSON.stringify({ t: "d", seq: 1, m: { op: "execute" } })));
	});
});

/** Two channels wired back to back through switchable sinks. */
function pair() {
	const got = { a: [], b: [] };
	const acks = { a: [], b: [] };
	const a = new ReliableChannel({ onMessage: (m) => got.a.push(m), onAckDue: (s) => acks.a.push(s), ackDelayMs: 5 });
	const b = new ReliableChannel({ onMessage: (m) => got.b.push(m), onAckDue: (s) => acks.b.push(s), ackDelayMs: 5 });
	const wire = (to) => ({ send: (raw) => to.receive(JSON.parse(raw)) });
	return { a, b, got, acks, wire };
}

describe("reliable channel", () => {
	it("a message that will not encode throws without using up a sequence number", () => {
		const { a, b, got, wire } = pair();
		a.attach(wire(b), 0);
		assert.throws(() => a.send({ op: "host_response", value: 1n }), /BigInt/);
		a.send({ op: "noop", n: 1 });
		assert.deepEqual(got.b, [{ op: "noop", n: 1 }], "the next message read as a sequence gap");
	});

	it("delivers in order and drops replayed duplicates", () => {
		const { a, b, got, wire } = pair();
		a.attach(wire(b), 0);
		a.send({ n: 1 });
		a.send({ n: 2 });
		assert.deepEqual(got.b, [{ n: 1 }, { n: 2 }]);
		// Reattach claiming the peer has nothing: everything is replayed, and dropped as duplicate.
		a.detach();
		a.attach(wire(b), 0);
		assert.deepEqual(got.b, [{ n: 1 }, { n: 2 }]);
	});

	it("buffers while detached and replays only what the peer lacks", () => {
		const { a, b, got, wire } = pair();
		a.attach(wire(b), 0);
		a.send({ n: 1 });
		a.detach();
		a.send({ n: 2 });
		a.send({ n: 3 });
		assert.equal(a.unacked, 3);
		a.attach(wire(b), b.received);
		assert.deepEqual(got.b, [{ n: 1 }, { n: 2 }, { n: 3 }]);
		assert.equal(a.unacked, 2, "attach acknowledges what the peer said it has");
		a.acknowledge(3);
		assert.equal(a.unacked, 0);
	});

	it("refuses a sequence gap rather than resuming into a hole", () => {
		const { b } = pair();
		b.receive({ t: "d", seq: 1, m: {} });
		assert.throws(() => b.receive({ t: "d", seq: 3, m: {} }), /sequence gap/);
	});

	it("acks after ackEvery messages or ackDelayMs", async () => {
		const got = [];
		const acks = [];
		const c = new ReliableChannel({ onMessage: (m) => got.push(m), onAckDue: (s) => acks.push(s), ackEvery: 3, ackDelayMs: 20 });
		c.attach({ send() {} }, 0);
		for (let i = 1; i <= 3; i++) c.receive({ t: "d", seq: i, m: i });
		assert.deepEqual(acks, [3]);
		c.receive({ t: "d", seq: 4, m: 4 });
		await new Promise((r) => setTimeout(r, 40));
		assert.deepEqual(acks, [3, 4]);
	});

	it("breaks (does not silently drop) when a detached outbox overflows", () => {
		const c = new ReliableChannel({ onMessage() {}, maxBufferedBytes: 100 });
		c.send({ big: "x".repeat(200) });
		assert.equal(c.isBroken, true);
		assert.equal(c.unacked, 0);
	});
});

describe("path map", () => {
	const map = new RemotePathMap([
		{ local: "/Users/me/data/conv/work", remote: "/home/daytona/work" },
		{ local: "/Users/me/tools/skills/", remote: "/home/daytona/work/.skills" },
	]);

	it("maps by longest prefix, both ways, and passes the rest through", () => {
		assert.equal(map.toRemote("/Users/me/data/conv/work/outputs/a.png"), "/home/daytona/work/outputs/a.png");
		assert.equal(map.toRemote("/Users/me/data/conv/work"), "/home/daytona/work");
		assert.equal(map.toRemote("/Users/me/data/conv/workshop"), "/Users/me/data/conv/workshop", "prefix must end at a separator");
		assert.equal(map.toRemote("/tmp/x"), "/tmp/x");
		assert.equal(map.toLocal("/home/daytona/work/.skills/pdf/SKILL.md"), "/Users/me/tools/skills/pdf/SKILL.md");
		assert.equal(map.toLocal("/home/daytona/work/a"), "/Users/me/data/conv/work/a");
	});

	it("rewrites argv paths but not flags or patterns", () => {
		assert.deepEqual(map.argsToRemote(["--json", "--", "def x", "/Users/me/data/conv/work/src"]), [
			"--json",
			"--",
			"def x",
			"/home/daytona/work/src",
		]);
	});

	it("rewrites rg --json and fd output lines back to loop paths", () => {
		const line = JSON.stringify({ type: "match", data: { path: { text: "/home/daytona/work/.skills/pdf/SKILL.md" } } });
		assert.match(map.lineToLocal(line), /"\/Users\/me\/tools\/skills\/pdf\/SKILL.md"/);
		assert.equal(map.lineToLocal("/home/daytona/work/outputs/b.csv"), "/Users/me/data/conv/work/outputs/b.csv");
	});
});

describe("kernel environment", () => {
	it("drops secret-shaped names, remaps loop dirs, and pins the tool proxy to loopback", () => {
		const { env, dropped } = server.kernelEnvFor(
			{
				RLM_DEPTH: "0",
				RLM_SESSION_DIR: "/Users/me/.prime/sessions/abc",
				SERPER_API_KEY: "sk-live",
				HARNESS_EGRESS_TOKEN: "egress-secret",
				HARNESS_MCP_PROXY: "https://gateway.example/r/mcp",
				HARNESS_WAIT_TOKEN: "nonce",
				GITHUB_TOKEN: "ghp",
			},
			"/state/kernels/k1",
			"http://127.0.0.1:40000/k/k1",
		);
		assert.equal(env.RLM_DEPTH, "0");
		assert.equal(env.RLM_SESSION_DIR, "/state/kernels/k1/rlm_session_dir");
		assert.equal(env.HARNESS_MCP_PROXY, "http://127.0.0.1:40000/k/k1");
		assert.equal(env.HARNESS_WAIT_TOKEN, "nonce");
		for (const name of ["SERPER_API_KEY", "HARNESS_EGRESS_TOKEN", "GITHUB_TOKEN"]) assert.equal(env[name], undefined, name);
		assert.deepEqual(dropped.sort(), ["GITHUB_TOKEN", "HARNESS_EGRESS_TOKEN", "SERPER_API_KEY"]);
	});

	it("builds child env from an allow-list, not the server's whole environment", () => {
		const env = server.childBaseEnv({ PATH: "/bin", HOME: "/h", KERNEL_SERVER_TOKEN: "t", ANTHROPIC_API_KEY: "k", UV_OFFLINE: "1" });
		assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", "UV_OFFLINE"]);
	});
});

describe("error mapping", () => {
	it("classifies kernel failures by the wording prime's recovery paths match on", () => {
		assert.equal(server.toWireError(new Error("Kernel exited: code 1")).code, "kernel_died");
		assert.equal(server.toWireError(new Error("Kernel has been shut down")).code, "kernel_shutdown");
		assert.equal(server.toWireError(new KernelBusyAfterInterruptError()).code, "busy_after_interrupt");
		assert.equal(server.toWireError(new server.RemoteRequestError("egress_open", "x")).code, "egress_open");
		assert.equal(server.toWireError("weird").code, "internal");
	});
});

describe("config", () => {
	it("reads the connection from env or a connect file, the file winning and re-read each time", () => {
		const dir = mkdtempSync(join(tmpdir(), "rk-cfg-"));
		const file = join(dir, "connect.json");
		writeFileSync(file, JSON.stringify({ url: "https://8765-x.proxy", token: "t1", headers: { h: "1" } }));
		const cfg = remoteKernelConfigFromEnv({
			HARNESS_REMOTE_KERNEL_URL: "ws://ignored",
			HARNESS_REMOTE_KERNEL_CONNECT_FILE: file,
			HARNESS_MCP_PROXY: "http://gw/r/mcp",
		});
		assert.deepEqual(cfg.connection(), { url: "wss://8765-x.proxy", token: "t1", headers: { h: "1" } });
		writeFileSync(file, JSON.stringify({ url: "wss://new", token: "t2" }));
		assert.equal(cfg.connection().token, "t2");
		assert.equal(cfg.toolProxy, "http://gw/r/mcp");
		assert.equal(cfg.toolTimeoutMs, 16 * 60_000, "a tool call may wait 15 minutes on a human");
		const env = remoteKernelConfigFromEnv({ HARNESS_REMOTE_KERNEL_URL: "http://h:1", HARNESS_REMOTE_KERNEL_PREVIEW_TOKEN: "p" });
		assert.deepEqual(env.connection().headers, { "x-daytona-preview-token": "p" });
		assert.equal(toWebSocketUrl("https://a"), "wss://a");
	});

	it("the server's skills live under its state dir unless KERNEL_SERVER_SKILLS_DIR moves them", () => {
		const own = server.kernelServerConfigFromEnv({ KERNEL_SERVER_STATE_DIR: "/r/conv-1/state" });
		assert.equal(own.skillsDir, "/r/conv-1/state/skills");
		// Several servers, one per conversation: own state, one shared prebaked skill set.
		const shared = server.kernelServerConfigFromEnv({ KERNEL_SERVER_STATE_DIR: "/r/conv-1/state", KERNEL_SERVER_SKILLS_DIR: "/r/skills" });
		assert.equal(shared.stateDir, "/r/conv-1/state");
		assert.equal(shared.skillsDir, "/r/skills");
	});

	it("a pending connect file asks the caller to wait; an error file fails with its text", () => {
		const dir = mkdtempSync(join(tmpdir(), "rk-cfg-"));
		const file = join(dir, "connect.json");
		writeFileSync(file, JSON.stringify({ pending: true }));
		const cfg = remoteKernelConfigFromEnv({ HARNESS_REMOTE_KERNEL_CONNECT_FILE: file });
		assert.equal(cfg.pendingWaitMs, 180_000);
		assert.throws(() => cfg.connection(), (e) => e instanceof RemoteKernelPendingError);
		writeFileSync(file, JSON.stringify({ error: "no capacity" }));
		assert.throws(
			() => cfg.connection(),
			(e) => !(e instanceof RemoteKernelPendingError) && /could not start \(no capacity\)/.test(e.message),
		);
		writeFileSync(file, JSON.stringify({ url: "https://h", token: "t" }));
		assert.equal(cfg.connection().url, "wss://h");
	});
});

describe("daytona provider verify", () => {
	it("asks the server's /healthz through the preview proxy with the preview header, and checks version and egress", async () => {
		const { createServer } = await import("node:http");
		const { DaytonaKernelProvider } = await import("../../daytona/provider.mjs");
		const { tokenFingerprint } = await import("../../daytona/provider.mjs");
		let health = { ok: true, version: "v1", tokenId: tokenFingerprint("tok"), posture: { egress: "blocked" } };
		let seen;
		const srv = createServer((req, res) => {
			seen = { url: req.url, preview: req.headers["x-daytona-preview-token"] };
			if (req.headers["x-daytona-preview-token"] !== "pt") {
				res.writeHead(401).end();
				return;
			}
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(health));
		});
		await new Promise((r) => srv.listen(0, "127.0.0.1", r));
		const url = `ws://127.0.0.1:${srv.address().port}`;
		const p = new DaytonaKernelProvider({ daytona: {} });
		const info = { url, headers: { "x-daytona-preview-token": "pt" }, version: "v1", token: "tok" };
		try {
			assert.equal((await p.verify(info))?.version, "v1");
			assert.deepEqual(seen, { url: "/healthz", preview: "pt" });
			assert.equal(await p.verify({ ...info, headers: { "x-daytona-preview-token": "stale" } }), undefined, "a stale preview token");
			assert.equal(await p.verify({ ...info, version: "v2" }), undefined, "another bundle");
			assert.equal(await p.verify({ ...info, token: "relaunched" }), undefined, "a server relaunched with another token");
			health = { ...health, posture: { egress: "open" } };
			assert.equal(await p.verify(info), undefined, "egress not locked");
		} finally {
			srv.close();
		}
		assert.equal(await p.verify(info, { timeoutMs: 500 }), undefined, "down");
	});
});

describe("daytona provider find", () => {
	it("a bound sandbox is fetched by id, so a lagging label search can't hide a relabelled one", async () => {
		const { DaytonaKernelProvider } = await import("../../daytona/provider.mjs");
		const sandboxes = new Map([["sb-1", { id: "sb-1", state: "started", labels: { app: "assistant-workspace", conversation: "pool-x" } }]]);
		let searchable = false;
		const daytona = {
			async *list({ labels }) {
				for (const sb of sandboxes.values()) {
					if (!searchable && labels.conversation === "conv-1") continue;
					if (Object.entries(labels).every(([k, v]) => sb.labels[k] === v)) yield sb;
				}
			},
			async get(id) {
				const sb = sandboxes.get(id);
				if (!sb) throw new Error("not found");
				return sb;
			},
		};
		const p = new DaytonaKernelProvider({ daytona });
		sandboxes.get("sb-1").labels = { app: "assistant-workspace", conversation: "conv-1" };
		assert.equal(await p.find("conv-1"), undefined, "the search lags the relabel");
		p.bind("conv-1", "sb-1");
		assert.equal((await p.find("conv-1"))?.id, "sb-1");
		sandboxes.get("sb-1").labels = { app: "assistant-workspace", conversation: "someone-else" };
		searchable = true;
		assert.equal(await p.find("conv-1"), undefined, "a binding is dropped once the sandbox is no longer the conversation's");
	});
});

describe("provider: sandboxes deleted under it", () => {
	let DaytonaKernelProvider;
	before(async () => {
		({ DaytonaKernelProvider } = await import("../../daytona/provider.mjs"));
	});
	const deletedLister = (entries, getBehaviour) => ({
		async *list() {
			for (const sb of entries) yield sb;
		},
		async get(id) {
			return getBehaviour(id);
		},
	});

	it("find() skips a sandbox the search still lists after it was deleted, and one listed as destroyed", async () => {
		const gone = Object.assign(new Error("Sandbox with ID or name sb-old not found"), { name: "DaytonaNotFoundError" });
		const daytona = deletedLister(
			[
				{ id: "sb-dead", state: "destroyed", labels: { app: "assistant-workspace", conversation: "conv-1" } },
				{ id: "sb-old", state: "stopped", labels: { app: "assistant-workspace", conversation: "conv-1" } },
			],
			(id) => {
				if (id === "sb-old") throw gone;
				return { id, state: "destroyed" };
			},
		);
		const p = new DaytonaKernelProvider({ daytona });
		assert.equal(await p.find("conv-1"), undefined, "no live sandbox: ensure() will create one");
	});

	it("find() returns a listed sandbox once get() confirms it is alive", async () => {
		const daytona = deletedLister([{ id: "sb-1", state: "stopped", labels: { conversation: "conv-1" } }], (id) => ({
			id,
			state: "stopped",
			labels: { conversation: "conv-1" },
		}));
		const p = new DaytonaKernelProvider({ daytona });
		assert.equal((await p.find("conv-1"))?.id, "sb-1");
	});

	it("find() does not swallow errors other than not-found", async () => {
		const daytona = deletedLister([{ id: "sb-1", state: "stopped", labels: {} }], () => {
			throw new Error("503 upstream");
		});
		const p = new DaytonaKernelProvider({ daytona });
		await assert.rejects(p.find("conv-1"), /503 upstream/);
	});

	it("ensure() recovers once from a sandbox that vanished mid-ensure, and forgets it", async () => {
		const p = new DaytonaKernelProvider({ daytona: {} });
		p.bind("conv-1", "sb-old");
		let calls = 0;
		p.ensureUnlocked = async () => {
			calls++;
			if (calls === 1) throw Object.assign(new Error("Sandbox with ID or name sb-old not found"), { name: "DaytonaNotFoundError" });
			return { sandboxId: "sb-new", created: true };
		};
		const info = await p.ensure("conv-1");
		assert.equal(info.sandboxId, "sb-new");
		assert.equal(calls, 2);
		assert.equal(p.bound.get("conv-1"), undefined, "the dead binding was dropped before the retry");
	});

	it("ensure() retries only once, and never for other errors", async () => {
		const p = new DaytonaKernelProvider({ daytona: {} });
		let calls = 0;
		p.ensureUnlocked = async () => {
			calls++;
			throw Object.assign(new Error("not found"), { name: "DaytonaNotFoundError" });
		};
		await assert.rejects(p.ensure("conv-1"), /not found/);
		assert.equal(calls, 2);
		calls = 0;
		p.ensureUnlocked = async () => {
			calls++;
			throw new Error("quota exceeded");
		};
		await assert.rejects(p.ensure("conv-2"), /quota exceeded/);
		assert.equal(calls, 1);
	});
});

describe("provider: the kernel server's lifecycle", () => {
	let provider;
	before(async () => {
		provider = await import("../../daytona/provider.mjs");
	});
	const layout = () => {
		const root = mkdtempSync(join(tmpdir(), "rk-layout-"));
		return { home: root, root, workDir: join(root, "work") };
	};
	const healthy = (token, extra = {}) => ({
		ok: true,
		version: "v1",
		tokenId: provider.tokenFingerprint(token),
		posture: { egress: "blocked" },
		...extra,
	});

	it("a restart waits for the old server to exit, SIGKILLing one that ignores SIGTERM", { timeout: 60_000 }, async () => {
		const { spawn, spawnSync } = await import("node:child_process");
		const tag = `krtest-${process.pid}-${Date.now()}`;
		// Ignores SIGTERM, like a server stuck in a kernel shutdown.
		const old = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1e3)", "kernel-server.mjs", tag], {
			stdio: "ignore",
		});
		const exited = new Promise((resolve) => old.once("exit", (code, signal) => resolve(signal)));
		await new Promise((r) => setTimeout(r, 300));
		let oldAliveAtLaunch;
		const sb = {
			process: {
				executeCommand: async (command) => {
					const r = spawnSync("sh", ["-c", command], { encoding: "utf8" });
					return { exitCode: r.status, result: `${r.stdout}${r.stderr}` };
				},
				createSession: async () => {},
				executeSessionCommand: async () => {
					// spawnSync held the event loop; let it reap a child that already exited.
					await new Promise((r) => setTimeout(r, 200));
					oldAliveAtLaunch = old.exitCode === null && old.signalCode === null;
				},
			},
		};
		const p = new provider.DaytonaKernelProvider({ daytona: {} });
		p.serverMatch = `[k]ernel-server.mjs ${tag}`;
		p.kernelMatch = `[k]ernel-of-${tag}`;
		try {
			await p.launchServer(sb, layout(), "v1", "tok");
			assert.equal(oldAliveAtLaunch, false, "the new server was launched while the old one still held the port");
			assert.equal(await exited, "SIGKILL");
		} finally {
			old.kill("SIGKILL");
		}
	});

	it("waitHealthy accepts only the server launched with the new token", async () => {
		const p = new provider.DaytonaKernelProvider({ daytona: {} });
		const answers = [healthy("old"), healthy("old"), healthy("new")];
		p.health = async () => answers.shift() ?? healthy("new");
		const h = await p.waitHealthy({}, "v1", "new", 5000);
		assert.equal(h.tokenId, provider.tokenFingerprint("new"));
		assert.equal(answers.length, 0, "it settled for the old server");
	});

	it("a server that never comes up is stopped, not left running", async () => {
		const p = new provider.DaytonaKernelProvider({ daytona: {} });
		let stopped = 0;
		p.readServerState = async () => undefined;
		p.health = async () => undefined;
		p.launchServer = async () => {};
		p.waitHealthy = async () => {
			throw new Error("kernel server did not come up");
		};
		p.stopServer = async () => {
			stopped++;
		};
		await assert.rejects(p.ensureServer({}, layout(), "v1", false), /did not come up/);
		assert.equal(stopped, 1);
	});

	it("a transient read of server.json does not relaunch a healthy server", async () => {
		const p = new provider.DaytonaKernelProvider({ daytona: {} });
		let reads = 0;
		const sb = {
			fs: {
				downloadFile: async () => {
					if (++reads === 1) throw new Error("socket hang up");
					return Buffer.from(JSON.stringify({ token: "tok", version: "v1" }));
				},
			},
		};
		let launched = 0;
		p.health = async () => healthy("tok");
		p.launchServer = async () => {
			launched++;
		};
		p.waitHealthy = async (_sb, _v, token) => healthy(token);
		const server = await p.ensureServer(sb, layout(), "v1", false);
		assert.equal(launched, 0, "a healthy server was relaunched over a failed read");
		assert.equal(server.token, "tok");
	});

	it("server.json that keeps failing to read is an error, and a missing one relaunches", async () => {
		const p = new provider.DaytonaKernelProvider({ daytona: {} });
		let launched = 0;
		p.health = async () => healthy("tok");
		p.launchServer = async () => {
			launched++;
		};
		p.waitHealthy = async (_sb, _v, token) => healthy(token);
		const failing = { fs: { downloadFile: async () => Promise.reject(new Error("socket hang up")) } };
		await assert.rejects(p.ensureServer(failing, layout(), "v1", false), /socket hang up/);
		assert.equal(launched, 0);
		const missing = { fs: { downloadFile: async () => Promise.reject(Object.assign(new Error("not found"), { statusCode: 404 })) } };
		await p.ensureServer(missing, layout(), "v1", false);
		assert.equal(launched, 1);
	});

	it("a server answering with another launch's token is relaunched", async () => {
		const p = new provider.DaytonaKernelProvider({ daytona: {} });
		let launched = 0;
		const sb = { fs: { downloadFile: async () => Buffer.from(JSON.stringify({ token: "tok" })) } };
		p.health = async () => healthy("someone-else");
		p.launchServer = async () => {
			launched++;
		};
		p.waitHealthy = async (_sb, _v, token) => healthy(token);
		const server = await p.ensureServer(sb, layout(), "v1", false);
		assert.equal(launched, 1);
		assert.notEqual(server.token, "tok");
	});
});

describe("provider: cleanup", () => {
	let DaytonaKernelProvider;
	before(async () => {
		({ DaytonaKernelProvider } = await import("../../daytona/provider.mjs"));
	});
	const notFound = () => Object.assign(new Error("Sandbox not found"), { name: "DaytonaNotFoundError", statusCode: 404 });

	it("a created sandbox is deleted a day after it stops unless told otherwise", async () => {
		const daytona = { snapshot: { list: async () => ({ items: [], totalPages: 1 }) }, create: async (params) => params };
		assert.equal((await new DaytonaKernelProvider({ daytona }).create("c", "v1")).autoDeleteInterval, 1440);
		assert.equal((await new DaytonaKernelProvider({ daytona, autoDeleteMinutes: -1 }).create("c", "v1")).autoDeleteInterval, -1);
	});

	it("reap() keeps going past a sandbox that will not delete, and counts one already gone as done", async () => {
		const labels = { app: "assistant-workspace" };
		const listed = ["sb-500", "sb-404", "sb-ok"].map((id) => ({ id, state: "stopped", labels: { ...labels, conversation: id } }));
		const deleted = [];
		const daytona = {
			async *list() {
				for (const sb of listed) yield sb;
			},
			async get(id) {
				if (id === "sb-404") throw notFound();
				return {
					id,
					state: "stopped",
					delete: async () => {
						if (id === "sb-500") throw Object.assign(new Error("internal error"), { statusCode: 500 });
						deleted.push(id);
					},
				};
			},
		};
		const reaped = await new DaytonaKernelProvider({ daytona }).reap({ knownConversationIds: [], waitMs: 0 });
		assert.deepEqual(deleted, ["sb-ok"]);
		assert.deepEqual(
			reaped.map((o) => [o.sandboxId, o.error]),
			[["sb-500", "internal error"], ["sb-404", undefined], ["sb-ok", undefined]],
		);
	});

	it("destroy() deletes every sandbox for the conversation, and a repeat is a no-op", async () => {
		const sandboxes = new Map(
			["sb-a", "sb-b"].map((id) => [id, { id, state: "stopped", labels: { app: "assistant-workspace", conversation: "conv-1" } }]),
		);
		const daytona = {
			async *list({ labels }) {
				for (const sb of sandboxes.values()) if (sb.labels.conversation === labels.conversation) yield sb;
			},
			async get(id) {
				const sb = sandboxes.get(id);
				if (!sb) throw notFound();
				return { ...sb, delete: async () => sandboxes.delete(id) };
			},
		};
		const p = new DaytonaKernelProvider({ daytona });
		const first = await p.destroy("conv-1");
		assert.equal(first.destroyed, true);
		assert.deepEqual(first.sandboxIds, ["sb-a", "sb-b"]);
		assert.equal(sandboxes.size, 0);
		assert.deepEqual(await p.destroy("conv-1"), { destroyed: false });
		p.bind("conv-1", "sb-gone");
		assert.deepEqual(await p.destroy("conv-1"), { destroyed: false }, "a bound sandbox already deleted is not an error");
	});
});

describe("kernel-server bundle", () => {
	it("concurrent builds into one dir share a single build, and every caller settles", async () => {
		const { buildKernelServerBundle } = await import("../../daytona/bundle.mjs");
		const out = mkdtempSync(join(tmpdir(), "rk-bundle-"));
		const results = await Promise.all([buildKernelServerBundle(out), buildKernelServerBundle(out), buildKernelServerBundle(out)]);
		assert.equal(new Set(results.map((r) => r.version)).size, 1);
		assert.ok(results.every((r) => r === results[0]), "one build, shared");
	});
});

describe("skill packages", () => {
	it("hash by content, ignore build junk, and land at a content-addressed path", () => {
		const root = mkdtempSync(join(tmpdir(), "rk-skill-"));
		const make = (name) => {
			const dir = join(root, name, "my-skill");
			mkdirSync(join(dir, "my_skill"), { recursive: true });
			writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "my-skill"\n');
			writeFileSync(join(dir, "my_skill/__init__.py"), "X = 1\n");
			return dir;
		};
		const a = make("a");
		const b = make("b");
		mkdirSync(join(b, "my_skill/__pycache__"));
		writeFileSync(join(b, "my_skill/__pycache__/x.pyc"), "junk");
		assert.equal(hashSkillPackage(a), hashSkillPackage(b), "location and __pycache__ do not change identity");
		writeFileSync(join(b, "my_skill/__init__.py"), "X = 2\n");
		assert.notEqual(hashSkillPackage(a), hashSkillPackage(b));
		const [p] = placeSkills([{ name: "my-skill", importName: "my_skill", packagePath: a, pyprojectPath: join(a, "pyproject.toml") }]);
		const remote = remoteSkill(p, "/state/skills");
		assert.equal(remote.packagePath, `/state/skills/${p.hash}/my-skill`);
		assert.equal(remote.pyprojectPath, `/state/skills/${p.hash}/my-skill/pyproject.toml`);
	});
});

describe("flag forwarding", () => {
	it("forwards harness behaviour flags, never plumbing, secrets' carriers, or loop paths", () => {
		const env = forwardedKernelEnv({
			HARNESS_MCP_TIMEOUT_S: "960",
			HARNESS_DISPLAY_IMAGES: "1",
			HARNESS_RUN_ID: "r1",
			HARNESS_WAIT_TOKEN: "nonce",
			HARNESS_MCP_PROXY: "http://gw/r/mcp",
			HARNESS_EGRESS_TOKEN: "egress",
			HARNESS_REMOTE_KERNEL_TOKEN: "t",
			HARNESS_KERNEL_SANDBOX_SETTINGS: "/x.json",
			HARNESS_KERNEL_STDERR_LOG: "/Users/me/log",
			ANTHROPIC_API_KEY: "sk",
			HARNESS_REMOTE_KERNEL_ENV: JSON.stringify({ IPYTHONDIR: "/home/daytona/.ipython-aw" }),
		});
		assert.deepEqual(env, {
			HARNESS_MCP_TIMEOUT_S: "960",
			HARNESS_DISPLAY_IMAGES: "1",
			HARNESS_RUN_ID: "r1",
			HARNESS_WAIT_TOKEN: "nonce",
			IPYTHONDIR: "/home/daytona/.ipython-aw",
		});
	});

	it("adopts flags server-wide except the ones the server owns", () => {
		const target = {};
		const adopted = server.adoptHarnessFlags(
			{ HARNESS_DISPLAY_IMAGES: "1", HARNESS_KERNEL_SANDBOX: "on", HARNESS_MCP_PROXY: "x", PATH: "/evil" },
			target,
		);
		assert.deepEqual(adopted, ["HARNESS_DISPLAY_IMAGES"]);
		assert.deepEqual(target, { HARNESS_DISPLAY_IMAGES: "1" });
	});
});
