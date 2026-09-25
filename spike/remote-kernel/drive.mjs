// SPIKE driver: exercises RemoteKernelManager against a kernel-server inside a Daytona sandbox.
// Env: RK_URL, RK_PREVIEW_TOKEN, RK_APP_TOKEN, RK_REMOTE_CWD. Writes drive_results.json.
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const CA = new URL("../../vendor/prime-agent/packages/coding-agent/", import.meta.url).pathname;
const { RemoteKernelManager } = await import(join(CA, "dist/core/kernel/remote.js"));
const { buildRlmBootstrapCode } = await import(join(CA, "dist/core/tools/ipython.js"));

const skills = [{
	name: "attach-image", importName: "attach_image",
	packagePath: join(CA, "skills/attach-image"), pyprojectPath: join(CA, "skills/attach-image/pyproject.toml"),
}];
const hostCalls = [];
const hostHandlers = {
	"model.info": async (p) => { hostCalls.push({ type: p.type, pid: process.pid }); return { id: "spike-model", input: ["text", "image"] }; },
	"spike.echo": async (p) => {
		hostCalls.push({ type: p.type, pid: process.pid, cellSourceCode: typeof p.cellSourceCode });
		return { echoed: p.n * 2, handledOn: hostname(), handledPid: process.pid };
	},
};
const R = { checks: {} };
const ok = (k, cond, detail) => { R.checks[k] = { pass: Boolean(cond), detail }; console.log(cond ? "PASS" : "FAIL", k, JSON.stringify(detail).slice(0, 300)); };
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { p50: +s[Math.floor(s.length / 2)].toFixed(1), p90: +s[Math.floor(s.length * 0.9) - 1].toFixed(1), min: +s[0].toFixed(1), n: s.length }; };

const km = new RemoteKernelManager({
	url: process.env.RK_URL, headers: { "x-daytona-preview-token": process.env.RK_PREVIEW_TOKEN },
	token: process.env.RK_APP_TOKEN, remoteCwd: process.env.RK_REMOTE_CWD, sessionId: "spike-session",
	hostHandlers, pythonSkills: skills,
});
try {
	let t = performance.now();
	const progress = [];
	await km.start({ onBootstrapProgress: (m) => progress.push(m) });
	R.startMs = performance.now() - t; R.progress = progress;
	t = performance.now();
	const boot = await km.execute(buildRlmBootstrapCode(skills));
	R.bootstrapCellMs = performance.now() - t;
	ok("bootstrap", boot.status === "ok", { status: boot.status, stderr: boot.stderr.slice(0, 400), err: boot.error });

	// (a) state persists across cells
	const a1 = await km.execute("x = 41\nprint('set', x)");
	const a2 = await km.execute("x + 1");
	ok("a_state", a1.stdout.includes("set 41") && a2.result === "42", { a1: a1.stdout, a2: a2.result });

	// streaming: chunks must arrive before the cell ends
	const chunks = []; t = performance.now();
	const s = await km.execute("import time,sys\nfor i in range(3):\n    print('tick', i, flush=True); time.sleep(0.5)", {
		onStream: (c, n) => chunks.push({ at: +(performance.now() - t).toFixed(0), n, c }),
	});
	const end = performance.now() - t;
	ok("streaming", chunks.length >= 3 && chunks[0].at < end - 500, { chunks: chunks.map((c) => c.at), endMs: +end.toFixed(0), stdout: s.stdout });

	// (b)+(c): the real attach-image skill; it does host_request("model.info") first
	await km.execute(`from PIL import Image\nImage.new("RGB", (300, 200), (200, 40, 90)).save("/tmp/spike.png")`);
	const b = await km.execute(`import base64, hashlib\nmsg = await attach_image("/tmp/spike.png")\nprint(msg)`);
	const att = b.attachments?.[0];
	ok("b_attach_image_skill", b.status === "ok" && att?.mimeType?.startsWith("image/") && att.data.length > 100, {
		status: b.status, err: b.error, stdout: b.stdout, n: b.attachments?.length, mime: att?.mimeType, chars: att?.data?.length, path: att?.path,
	});
	if (att) {
		const png = Buffer.from(att.data, "base64");
		ok("b_attachment_decodes", png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" || png[0] === 0xff, { head: png.subarray(0, 8).toString("hex"), bytes: png.length });
	}
	// integrity at size: direct ATTACHMENT_DISPLAY_MIME emit, ~5 MB base64, hash both sides
	const big = await km.execute(`import os, base64, hashlib
from IPython.display import display
payload = base64.b64encode(os.urandom(3_700_000)).decode()
display({"application/vnd.prime-agent.attachment+json": {"mime_type": "image/png", "data": payload, "path": "/tmp/big"}, "text/plain": "big"}, raw=True)
print(hashlib.sha256(payload.encode()).hexdigest())`);
	const bigAtt = big.attachments?.[0];
	const localHash = bigAtt ? createHash("sha256").update(bigAtt.data).digest("hex") : null;
	ok("b_big_attachment_intact", big.status === "ok" && localHash === big.stdout.trim(), { chars: bigAtt?.data?.length, remote: big.stdout.trim().slice(0, 16), local: localHash?.slice(0, 16), clientMs: km.lastTiming?.clientMs, serverMs: km.lastTiming?.serverMs });

	// (c) explicit host request, handler runs locally
	const c = await km.execute(`from rlm import host_request\nr = await host_request("spike.echo", {"n": 21})\nprint(r)`);
	ok("c_host_request", c.status === "ok" && c.stdout.includes("'echoed': 42") && c.stdout.includes(hostname()), { stdout: c.stdout, err: c.error });
	const cErr = await km.execute(`from rlm import host_request\ntry:\n    await host_request("no.such.handler", {})\nexcept Exception as e:\n    print("raised", type(e).__name__, e)`);
	ok("c_host_request_unknown_type", cErr.stdout.includes("raised"), { stdout: cErr.stdout });
	R.hostCalls = hostCalls;

	// (d) interrupt a long-running cell
	const ac = new AbortController();
	t = performance.now();
	setTimeout(() => ac.abort(), 1500);
	const d = await km.execute("import time\nprint('sleeping', flush=True)\ntime.sleep(60)\nprint('never')", { signal: ac.signal });
	const dMs = performance.now() - t;
	const dAfter = await km.execute("x * 10");
	ok("d_interrupt", d.status !== "ok" && dMs < 6000 && dAfter.result === "410", { status: d.status, ename: d.error?.ename, dMs: +dMs.toFixed(0), after: dAfter.result, stdout: d.stdout });

	// per-cell overhead
	const rtt = [], srv = [], ping = [];
	for (let i = 0; i < 25; i++) { await km.execute("1+1"); rtt.push(km.lastTiming.clientMs); srv.push(km.lastTiming.serverMs); }
	for (let i = 0; i < 25; i++) ping.push(await km.ping());
	R.overhead = { cellClientMs: stats(rtt), cellServerMs: stats(srv), wsPingMs: stats(ping) };
	console.log("overhead", JSON.stringify(R.overhead));

	// (e) restart wipes state, kernel usable after
	t = performance.now();
	await km.restart();
	R.restartMs = performance.now() - t;
	const e = await km.execute("try:\n    x\nexcept NameError:\n    print('x gone')");
	const e2 = await km.execute("import os; os.getpid()");
	ok("e_restart", e.stdout.includes("x gone") && e2.status === "ok" && km.isRunning, { stdout: e.stdout, restartMs: +R.restartMs.toFixed(0) });

	// kernel death -> error text the autorestart path recognises
	const death = await km.execute("import os; os._exit(1)").then((r) => ({ resolved: r.status, err: r.error }), (err) => ({ rejected: String(err.message) }));
	R.kernelDeath = death; console.log("kernel death:", JSON.stringify(death));
} catch (err) {
	R.fatal = String(err?.stack ?? err); console.error("FATAL", err);
} finally {
	await km.dispose();
	writeFileSync(new URL("drive_results.json", import.meta.url), JSON.stringify(R, null, 1));
	const fails = Object.entries(R.checks).filter(([, v]) => !v.pass).map(([k]) => k);
	console.log("fails:", fails, R.fatal ? "FATAL" : "");
	process.exit(0);
}
