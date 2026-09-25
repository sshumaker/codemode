/**
 * The remote-kernel behaviour suite, run against any target: the local fake
 * (fake.test.mjs) and a real Daytona sandbox with egress blocked (live.test.mjs).
 *
 * A target is { name, connection(), remoteCwd, putTree(localDir, remoteRel),
 * sandboxRead(remotePath) }. Everything below talks to it only through the real
 * loop-side code: RemoteKernelLink, RemoteKernelManager, and prime's own file tools.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CA, DIST, ROOT } from "./fake-server.mjs";

const R = `${DIST}/core/kernel/remote`;
const { RemoteKernelLink } = await import(`${R}/link.js`);
const { RemoteKernelManager, dispatchHostRequest } = await import(`${R}/manager.js`);
const { RemotePathMap } = await import(`${R}/pathmap.js`);
const { forwardToolCall, setRemoteRuntimeForTest } = await import(`${R}/tools.js`);
const { buildRlmBootstrapCode } = await import(`${DIST}/core/tools/ipython.js`);
const { createAllToolDefinitions } = await import(`${DIST}/core/tools/index.js`);
const { generate } = await import(`${ROOT}/bench/generate.mjs`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const EGRESS_TOKEN = "egress-token-held-by-the-loop-only";

const ATTACH_IMAGE = {
	name: "attach-image",
	importName: "attach_image",
	packagePath: join(CA, "skills/attach-image"),
	pyprojectPath: join(CA, "skills/attach-image/pyproject.toml"),
};

/** A stand-in for the gateway's tool proxy: records what reaches it, can hold a call. */
export async function startFixtureProxy() {
	const calls = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
		calls.push({ path: req.url, headers: req.headers, body, at: Date.now() });
		if (body.tool === "slow") await sleep(Number(body.args?.seconds ?? 1) * 1000);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, text: `${body.tool}:${JSON.stringify(body.args)}:${hostname()}` }));
	});
	server.requestTimeout = 0;
	server.headersTimeout = 0;
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

/** An api/ tree for the fixture server, rendered by harness's own generator. */
export function fixtureApiTree() {
	const out = mkdtempSync(join(tmpdir(), "rk-api-"));
	const { files } = generate([
		{
			server: "fixture",
			tools: [
				{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
				{ name: "slow", description: "Hold", inputSchema: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] } },
			],
		},
	]);
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(dirname(join(out, rel)), { recursive: true });
		writeFileSync(join(out, rel), text);
	}
	return out;
}

export function defineKernelSuite(label, makeTarget, { longBlockSeconds = 60 } = {}) {
	describe(`remote kernel [${label}]`, () => {
		let target;
		let proxy;
		let link;
		let km;
		const hostCalls = [];
		const hostHandlers = {
			"model.info": async () => ({ id: "suite-model", input: ["text", "image"] }),
			"suite.echo": async (p) => {
				hostCalls.push(p);
				return { echoed: p.n * 2, handledOn: hostname(), handledPid: process.pid };
			},
		};
		const newLink = () =>
			new RemoteKernelLink({ connection: () => target.connection(), pingIntervalMs: 2000, deadAfterMs: 10_000 });
		const newManager = (l, extra = {}) =>
			new RemoteKernelManager({
				link: l,
				pathMap: new RemotePathMap([]),
				remoteCwd: target.remoteCwd,
				sessionId: extra.sessionId ?? "suite",
				snapshotKey: extra.snapshotKey,
				hostHandlers,
				pythonSkills: [ATTACH_IMAGE],
				env: { RLM_DEPTH: "0", SERPER_API_KEY: "must-not-cross", HARNESS_EGRESS_TOKEN: EGRESS_TOKEN },
			});
		const wire = (l) => {
			l.handlers.hostRequest = dispatchHostRequest;
			l.handlers.httpRequest = (m, signal) =>
				forwardToolCall({ toolProxy: proxy.url, egressToken: EGRESS_TOKEN, toolTimeoutMs: 20 * 60_000 }, m, signal);
			return l;
		};

		const savedFlags = { HARNESS_MCP_TIMEOUT_S: process.env.HARNESS_MCP_TIMEOUT_S, HARNESS_DISPLAY_IMAGES: process.env.HARNESS_DISPLAY_IMAGES };
		before(async () => {
			// Loop-side flags a local kernel would inherit; the remote one must see them too.
			process.env.HARNESS_MCP_TIMEOUT_S = "960";
			process.env.HARNESS_DISPLAY_IMAGES = "1";
			target = await makeTarget();
			proxy = await startFixtureProxy();
			await target.putTree(fixtureApiTree(), "api");
			link = wire(newLink());
			km = newManager(link);
			const t0 = performance.now();
			await km.start();
			target.timings.kernelStartMs = Math.round(performance.now() - t0);
			const t1 = performance.now();
			const boot = await km.execute(buildRlmBootstrapCode([ATTACH_IMAGE]));
			target.timings.bootstrapCellMs = Math.round(performance.now() - t1);
			assert.equal(boot.status, "ok", boot.stderr);
			const t2 = performance.now();
			await km.execute("1+1");
			target.timings.firstCellMs = Math.round(performance.now() - t2);
		});
		after(async () => {
			for (const [k, v] of Object.entries(savedFlags)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			await km?.dispose();
			await link?.close({ bye: true });
			await proxy?.close();
			await target?.cleanup?.();
		});

		it("keeps state across cells", async () => {
			const a = await km.execute("x = 41\nprint('set', x)");
			const b = await km.execute("x + 1");
			assert.match(a.stdout, /set 41/);
			assert.equal(b.result, "42");
		});

		it("reports the sandbox as the boundary", () => {
			assert.ok(km.posture, "start returns the server's posture");
			assert.equal(km.posture.boundary, target.boundary);
			if (target.requireBlockedEgress) assert.equal(km.posture.egress, "blocked");
		});

		it("streams output before the cell ends", async () => {
			const chunks = [];
			const t0 = performance.now();
			await km.execute("import time\nfor i in range(3):\n    print('tick', i, flush=True); time.sleep(0.4)", {
				onStream: () => chunks.push(performance.now() - t0),
			});
			const end = performance.now() - t0;
			assert.ok(chunks.length >= 3, `${chunks.length} chunks`);
			assert.ok(chunks[0] < end - 500, `first chunk at ${chunks[0]}ms, end ${end}ms`);
		});

		it("brings images back through the attach_image skill, byte-exact at 5 MB", async () => {
			await km.execute(`from PIL import Image\nImage.new("RGB", (300, 200), (200, 40, 90)).save("/tmp/suite.png")`);
			const r = await km.execute(`msg = await attach_image("/tmp/suite.png")\nprint(msg)`);
			assert.equal(r.status, "ok", r.error?.evalue);
			const att = r.attachments?.[0];
			assert.ok(att?.mimeType.startsWith("image/"), JSON.stringify(att?.mimeType));
			assert.equal(Buffer.from(att.data, "base64").subarray(0, 4).toString("hex"), "89504e47");
			const big = await km.execute(`import os, base64, hashlib
from IPython.display import display
payload = base64.b64encode(os.urandom(3_700_000)).decode()
display({"application/vnd.prime-agent.attachment+json": {"mime_type": "image/png", "data": payload, "path": "/tmp/big"}, "text/plain": "big"}, raw=True)
print(hashlib.sha256(payload.encode()).hexdigest())`);
			const bigAtt = big.attachments?.[0];
			assert.equal(createHash("sha256").update(bigAtt.data).digest("hex"), big.stdout.trim());
		});

		it("carries the loop's harness flags: the tool timeout, and plt.show() as an image", async () => {
			const env = await km.execute("import os\nprint(os.environ.get('HARNESS_MCP_TIMEOUT_S'))");
			assert.equal(env.stdout.trim(), "960");
			const has = await km.execute("import importlib.util\nprint(importlib.util.find_spec('matplotlib') is not None)");
			if (has.stdout.trim() !== "True") {
				assert.ok(target.pipInstall, "matplotlib must be in the sandbox's kernel venv");
				target.pipInstall("matplotlib");
			}
			const r = await km.execute(
				"import matplotlib\nmatplotlib.use('module://matplotlib_inline.backend_inline')\nimport matplotlib.pyplot as plt\nplt.plot([0, 1, 2], [0, 1, 4])\nplt.show()",
			);
			assert.equal(r.status, "ok", r.error?.evalue ?? r.stderr);
			const png = r.attachments?.find((a) => a.mimeType === "image/png");
			assert.ok(png, `no image attachment: ${JSON.stringify(r.attachments?.map((a) => a.mimeType))}`);
			assert.equal(Buffer.from(png.data, "base64").subarray(0, 4).toString("hex"), "89504e47");
		});

		it("answers host requests on the loop, and raises for unknown types", async () => {
			const r = await km.execute(`from rlm import host_request\nr = await host_request("suite.echo", {"n": 21})\nprint(r)`);
			assert.match(r.stdout, /'echoed': 42/);
			assert.match(r.stdout, new RegExp(hostname()));
			assert.equal(hostCalls.at(-1).n, 21);
			const bad = await km.execute(
				`from rlm import host_request\ntry:\n    await host_request("no.such", {})\nexcept Exception as e:\n    print("raised", e)`,
			);
			assert.match(bad.stdout, /raised/);
		});

		it("interrupts a running cell and keeps the namespace", async () => {
			const ac = new AbortController();
			const t0 = performance.now();
			setTimeout(() => ac.abort(), 1000);
			const r = await km.execute("import time\nprint('sleeping', flush=True)\ntime.sleep(60)", { signal: ac.signal });
			assert.notEqual(r.status, "ok");
			assert.ok(performance.now() - t0 < 8000);
			assert.equal((await km.execute("x * 10")).result, "410");
		});

		it("keeps a cell's result through a dropped socket mid-cell", async () => {
			const chunks = [];
			const pending = km.execute("import time\nfor i in range(4):\n    print('beat', i, flush=True); time.sleep(0.5)\n'finished'", {
				onStream: (c) => chunks.push(c),
			});
			await sleep(700);
			link.dropSocketForTest();
			const r = await pending;
			assert.equal(r.result, "'finished'");
			assert.equal(chunks.join("").match(/beat/g)?.length, 4, chunks.join(""));
			target.timings.reattachMs = link.lastReattachMs;
		});

		it("tunnels tool calls to the loop's proxy; the egress token is added loop-side only", async () => {
			const r = await km.execute(
				`import os\nfrom api.fixture import echo\nprint(await echo(text="hello"))\nprint("TOKEN_IN_KERNEL=" + str("HARNESS_EGRESS_TOKEN" in os.environ), "SERPER=" + str("SERPER_API_KEY" in os.environ))\nprint(os.environ["HARNESS_MCP_PROXY"])`,
			);
			assert.equal(r.status, "ok", r.error?.evalue ?? r.stderr);
			assert.match(r.stdout, /echo:\{"text":"hello"\}/);
			assert.match(r.stdout, /TOKEN_IN_KERNEL=False SERPER=False/);
			assert.match(r.stdout, /^http:\/\/127\.0\.0\.1:\d+\/k\//m);
			const call = proxy.calls.at(-1);
			assert.equal(call.path, "/call");
			assert.equal(call.headers["x-egress-token"], EGRESS_TOKEN);
			assert.deepEqual(call.body.args, { text: "hello" });
		});

		it(`holds a tool call blocked for ${longBlockSeconds}s (a human approving) and returns its answer`, { timeout: (longBlockSeconds + 60) * 1000 }, async () => {
			const t0 = Date.now();
			const r = await km.execute(`from api.fixture import slow\nprint(await slow(seconds=${longBlockSeconds}))`);
			assert.equal(r.status, "ok", r.error?.evalue ?? r.stderr);
			assert.match(r.stdout, /slow:/);
			assert.ok(Date.now() - t0 >= longBlockSeconds * 1000);
		});

		it("restarts to a clean namespace", async () => {
			await km.restart();
			const r = await km.execute("try:\n    x\nexcept NameError:\n    print('x gone')");
			assert.match(r.stdout, /x gone/);
			assert.equal(km.isRunning, true);
			await km.execute(buildRlmBootstrapCode([ATTACH_IMAGE]));
		});

		it("revives a namespace from the sandbox-side snapshot in a new kernel", async () => {
			const key = `suite-snap-${Date.now()}`;
			const l = wire(newLink());
			const a = newManager(l, { snapshotKey: key, sessionId: key });
			await a.start();
			assert.equal(await a.snapshotExists(), false);
			await a.execute("kept = {'answer': 42}");
			const snap = await a.snapshotState();
			assert.ok(snap?.saved.includes("kept"), JSON.stringify(snap));
			await a.dispose();
			const b = newManager(l, { snapshotKey: key, sessionId: key });
			await b.start();
			assert.equal(await b.snapshotExists(), true);
			const restored = await b.restoreState();
			assert.ok(restored?.restored.includes("kept"), JSON.stringify(restored));
			assert.equal((await b.execute("kept['answer']")).result, "42");
			await b.dispose();
			await l.close({ bye: true });
		});

		it("routes read/grep/find/ls/write/edit/bash to the sandbox's filesystem", async () => {
			const local = mkdtempSync(join(tmpdir(), "rk-loopcwd-"));
			// Decoys on the loop's disk: a tool that reads locally would return these.
			writeFileSync(join(local, "notes.txt"), "LOOP-SIDE DECOY\n");
			await km.execute(
				"import os\nos.makedirs('outputs', exist_ok=True)\nopen('notes.txt','w').write('alpha\\nneedle in the sandbox\\nomega\\n')\nopen('outputs/report.md','w').write('# Report\\nneedle two\\n')",
			);
			const saved = { ...process.env };
			process.env.HARNESS_REMOTE_KERNEL_URL = "ws://suite";
			setRemoteRuntimeForTest(
				{ config: { remoteCwd: target.remoteCwd }, link, pathMap: () => new RemotePathMap([{ local, remote: target.remoteCwd }]) },
				local,
			);
			try {
				const tools = createAllToolDefinitions(local, {});
				const text = (r) => r.content.map((c) => c.text ?? "").join("");
				const read = await tools.read.execute("t1", { path: "notes.txt" });
				assert.match(text(read), /needle in the sandbox/);
				assert.doesNotMatch(text(read), /DECOY/);
				const grep = await tools.grep.execute("t2", { pattern: "needle" });
				assert.match(text(grep), /notes\.txt:2: needle in the sandbox/);
				assert.match(text(grep), /outputs\/report\.md:2: needle two/);
				const find = await tools.find.execute("t3", { pattern: "*.md" });
				assert.match(text(find), /outputs\/report\.md/);
				const ls = await tools.ls.execute("t4", { path: "outputs" });
				assert.match(text(ls), /report\.md/);
				await tools.write.execute("t5", { path: "outputs/from-tool.txt", content: "written by the write tool\n" });
				await tools.edit.execute("t6", { path: "notes.txt", edits: [{ oldText: "omega", newText: "OMEGA-EDITED" }] });
				const bash = await tools.bash.execute("t7", { command: "cat outputs/from-tool.txt notes.txt; hostname" });
				assert.match(text(bash), /written by the write tool/);
				assert.match(text(bash), /OMEGA-EDITED/);
				const k = await km.execute("print(open('outputs/from-tool.txt').read(), open('notes.txt').read())");
				assert.match(k.stdout, /written by the write tool/);
				assert.match(k.stdout, /OMEGA-EDITED/);
				const missing = await tools.read.execute("t8", { path: "nope.txt" }).then(
					() => "resolved",
					(e) => e.message,
				);
				assert.match(missing, /ENOENT/);
			} finally {
				setRemoteRuntimeForTest(undefined);
				for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
			}
		});

		it("reports a kernel that died as a dead kernel", async () => {
			const death = await km.execute("import os; os._exit(1)").then(
				(r) => `resolved ${r.status}`,
				(e) => e.message,
			);
			assert.match(death, /Kernel exited|Kernel has been shut down/);
		});
	});
}
