// The loop-side connection state machine against a real kernel server process:
// drops mid-request, a stalled server (heartbeat), a restarted server (session
// lost), an unreachable one (grace expiry), bad credentials, and bye.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DIST, startFakeServer } from "./fake-server.mjs";

const { RemoteKernelLink } = await import(`${DIST}/core/kernel/remote/link.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function linkTo(srv, opts = {}) {
	return new RemoteKernelLink({
		connection: () => ({ url: srv.url, token: opts.token ?? srv.token }),
		graceMs: opts.graceMs ?? 20_000,
		pingIntervalMs: opts.pingIntervalMs ?? 200,
		deadAfterMs: opts.deadAfterMs ?? 1500,
		connectTimeoutMs: 3000,
	});
}

/** Run a shell command in the "sandbox" through the link, collecting stdout. */
async function run(link, command) {
	let out = "";
	const call = await link.start((id) => ({ op: "spawn", id, bin: "bash", args: ["-c", command] }), {
		onSpawnData: (fd, data) => {
			if (fd === 1) out += data.toString();
		},
	});
	return { id: call.id, done: call.done.then((exit) => ({ ...exit, out })) };
}

describe("remote kernel link", () => {
	let srv;
	before(async () => {
		srv = await startFakeServer({ graceMs: 5000 });
	});
	after(async () => {
		await srv?.stop();
	});

	it("connects, reports the server's posture, and round-trips", async () => {
		const link = linkTo(srv);
		assert.ok((await link.ping()) < 1000);
		assert.equal(link.state, "open");
		assert.equal(link.posture.boundary, "none (local fake)");
		assert.equal(link.posture.egressOverride, "local fake: no sandbox to lock");
		await link.close({ bye: true });
	});

	it("survives a dropped socket mid-request: the result arrives, once", async () => {
		const link = linkTo(srv);
		const release = link.hold();
		const call = await run(link, "echo start; sleep 1; echo done");
		await sleep(300);
		link.dropSocketForTest();
		const r = await call.done;
		assert.equal(r.code, 0);
		assert.equal(r.out, "start\ndone\n");
		assert.equal(link.reconnects, 1);
		assert.ok(link.lastReattachMs < 2000, `reattach took ${link.lastReattachMs}ms`);
		release();
		await link.close({ bye: true });
	});

	it("delivers a stream exactly once and in order across repeated drops", async () => {
		const link = linkTo(srv);
		const release = link.hold();
		const call = await run(link, "for i in $(seq 1 12); do echo line$i; sleep 0.15; done");
		const chaos = setInterval(() => link.dropSocketForTest(), 350);
		const r = await call.done;
		clearInterval(chaos);
		const expected = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n");
		assert.equal(r.out.trim(), expected);
		assert.ok(link.reconnects >= 3, `only ${link.reconnects} reconnects`);
		release();
		await link.close({ bye: true });
	});

	it("notices a silent server by heartbeat and reattaches when it wakes", async () => {
		const link = linkTo(srv, { deadAfterMs: 800, pingIntervalMs: 150 });
		const release = link.hold();
		await link.ping();
		const call = await run(link, "sleep 0.5; echo after-stall");
		srv.child.kill("SIGSTOP");
		await sleep(1500);
		assert.equal(link.state, "reconnecting", "the link must have given up on the stalled socket");
		srv.child.kill("SIGCONT");
		const r = await call.done;
		assert.equal(r.out, "after-stall\n");
		assert.ok(link.reconnects >= 1);
		release();
		await link.close({ bye: true });
	});

	it("rejects bad credentials as a refused connection", async () => {
		const link = linkTo(srv, { token: "wrong" });
		await assert.rejects(link.ping(), /refused the connection \(unauthorized/);
		await link.close();
	});

	it("goes idle on a drop when nothing is held, and reconnects lazily", async () => {
		const link = linkTo(srv);
		await link.ping();
		await sleep(700); // let the server acknowledge, so nothing is left in flight
		link.dropSocketForTest();
		await sleep(100);
		assert.equal(link.state, "idle");
		await link.ping();
		assert.equal(link.state, "open");
		await link.close({ bye: true });
	});

	it("bye disposes the session on the server at once", async () => {
		const link = linkTo(srv);
		await link.ping();
		const session = link.session.slice(0, 8);
		await link.close({ bye: true });
		await sleep(200);
		assert.match(srv.log(), new RegExp(`session ${session} disposed: loop said bye`));
	});
});

describe("remote kernel link: losing the session", () => {
	it("a restarted server means the session is lost: pending fails as a dead kernel, new work succeeds", async () => {
		const srv = await startFakeServer();
		const link = linkTo(srv, { graceMs: 15_000 });
		const release = link.hold();
		const lost = [];
		link.onSessionLost((why) => lost.push(why));
		const call = await run(link, "sleep 5; echo never");
		await sleep(300);
		await srv.kill9();
		const srv2 = await startFakeServer({ port: srv.port, token: srv.token, stateDir: srv.stateDir });
		try {
			await assert.rejects(call.done, /Kernel exited: remote the sandbox side no longer has this session/);
			assert.equal(lost.length, 1);
			const again = await run(link, "echo fresh");
			assert.equal((await again.done).out, "fresh\n");
		} finally {
			release();
			await link.close({ bye: true });
			await srv2.stop();
		}
	});

	it("an unreachable server fails pending work after the grace window, not before", async () => {
		const srv = await startFakeServer();
		const link = linkTo(srv, { graceMs: 1500 });
		const release = link.hold();
		const call = await run(link, "sleep 10");
		await sleep(200);
		const t0 = Date.now();
		await srv.kill9();
		await assert.rejects(call.done, /Kernel exited: remote connection lost and not re-established within 2s/);
		const waited = Date.now() - t0;
		assert.ok(waited >= 1400 && waited < 8000, `failed after ${waited}ms`);
		assert.equal(link.state, "lost");
		await assert.rejects(link.ping(), /Kernel exited: remote sandbox unreachable/);
		release();
		await link.close();
	});
});
