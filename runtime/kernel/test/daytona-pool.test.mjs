import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WarmPool } from "../daytona-pool.mjs";

function fakePool(leftovers = []) {
	const sandboxes = new Map();
	for (const l of leftovers) sandboxes.set(l.conversationId, { pool: "warm", conversation: l.conversationId });
	const log = [];
	let alive = 0;
	let gate;
	let hold = false;
	let healthy = true;
	const provider = {
		ensure: async (id) => {
			log.push(`ensure ${id}`);
			if (hold) await new Promise((r) => (gate = r));
			if (!sandboxes.has(id)) sandboxes.set(id, { pool: "warm", conversation: id });
			return { sandboxId: `sb-${id}`, url: `wss://8765-sb-${id}` };
		},
		verify: async (info) => {
			log.push(`verify ${info.sandboxId}`);
			return healthy ? { ok: true } : undefined;
		},
		keepAlive: (id) => {
			alive++;
			log.push(`keepAlive ${id}`);
			return () => {
				alive--;
			};
		},
		destroy: async (id) => {
			log.push(`destroy ${id}`);
			sandboxes.delete(id);
		},
		find: async (id) =>
			sandboxes.has(id)
				? {
						id: `sb-${id}`,
						setLabels: async (labels) => {
							log.push(`relabel ${id} -> ${labels.conversation}`);
							sandboxes.set(id, labels);
						},
					}
				: undefined,
		listOrphans: async () => leftovers.map((l) => ({ sandboxId: `sb-${l.conversationId}`, ...l })),
	};
	return {
		provider,
		sandboxes,
		log,
		alive: () => alive,
		holdEnsures: () => (hold = true),
		setHealthy: (v) => (healthy = v),
		releaseEnsure: () => gate?.(),
	};
}
const labelsFor = (c) => ({ app: "assistant-workspace", conversation: c });
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("daytona warm pool", () => {
	test("fills to size, holds each awake, and a claim relabels one to the conversation and refills", async () => {
		const f = fakePool();
		const pool = new WarmPool({ provider: f.provider, size: 2, labelsFor });
		await pool.start();
		await settle();
		assert.equal(pool.readyCount, 2);
		assert.equal(f.alive(), 2);
		const setupCalls = f.log.length;
		const claimed = await pool.claim("conv_a");
		assert.match(String(claimed?.sandboxId), /^sb-pool-/, "the claim returns the sandbox id, for the caller to bind");
		assert.equal(claimed?.info?.sandboxId, claimed?.sandboxId, "and the connection from warm time, verified");
		assert.deepEqual(
			f.log
				.slice(setupCalls, setupCalls + 2)
				.map((l) => l.split(" ")[0])
				.sort(),
			["relabel", "verify"],
			"a claim is a relabel and a health check: no ensure(), no uploads",
		);
		const bound = [...f.sandboxes.values()].filter((l) => l.conversation === "conv_a");
		assert.deepEqual(bound, [{ app: "assistant-workspace", conversation: "conv_a" }], "pool labels replaced, not merged");
		await settle();
		assert.equal(pool.readyCount, 2, "refilled");
		assert.equal(f.alive(), 2, "the claimed one's keep-alive is released; the new one holds its own");
		await pool.close();
		assert.equal(pool.readyCount, 0);
		assert.equal(f.alive(), 0);
		assert.deepEqual(
			[...f.sandboxes.values()].map((l) => l.conversation),
			["conv_a"],
			"only the claimed sandbox survives close",
		);
	});

	test("a claim while the pool is still warming waits for that sandbox rather than creating cold", async () => {
		const f = fakePool();
		f.holdEnsures();
		const pool = new WarmPool({ provider: f.provider, size: 1, labelsFor });
		void pool.start();
		await settle();
		const claim = pool.claim("conv_w");
		await settle();
		f.releaseEnsure();
		assert.match(String((await claim)?.sandboxId), /^sb-pool-/);
		await pool.close();
	});

	test("a claim waiting on a warm that fails is sent to create cold at once, not after its wait", async () => {
		const f = fakePool();
		const failing = {
			...f.provider,
			ensure: async () => {
				await settle();
				throw new Error("quota");
			},
		};
		const pool = new WarmPool({ provider: failing, size: 1, labelsFor, warmWaitMs: 60_000 });
		void pool.start();
		await settle();
		const t0 = Date.now();
		assert.equal(await pool.claim("conv_f"), undefined);
		assert.ok(Date.now() - t0 < 1000, "released when the warm failed");
		await pool.close();
	});

	test("a warm that hangs past the wait sends the claim cold", async () => {
		const f = fakePool();
		f.holdEnsures();
		const pool = new WarmPool({ provider: f.provider, size: 1, labelsFor, warmWaitMs: 30 });
		void pool.start();
		await settle();
		assert.equal(await pool.claim("conv_h"), undefined);
		await pool.close();
		f.releaseEnsure();
	});

	test("with nothing ready or warming the claim says so, and a sandbox landing after close is deleted", async () => {
		const f = fakePool();
		const pool = new WarmPool({ provider: f.provider, size: 1, labelsFor });
		assert.equal(await pool.claim("conv_b"), undefined, "never started: nothing warming");
		f.holdEnsures();
		void pool.start();
		await settle();
		await pool.close();
		f.releaseEnsure();
		await settle();
		assert.deepEqual(
			[...f.sandboxes.keys()].filter((k) => k.startsWith("pool-")),
			[],
			"deleted when it lands",
		);
	});

	test("a claimed sandbox whose server does not answer is still the conversation's, but without connection info", async () => {
		const f = fakePool();
		const pool = new WarmPool({ provider: f.provider, size: 1, labelsFor });
		await pool.start();
		await settle();
		f.setHealthy(false);
		const claimed = await pool.claim("conv_s");
		assert.match(String(claimed?.sandboxId), /^sb-pool-/, "relabelled all the same: ensure() repairs it in place");
		assert.equal(claimed?.info, undefined, "no info, so the caller runs ensure()");
		assert.ok([...f.sandboxes.values()].some((l) => l.conversation === "conv_s"));
		await pool.close();
	});

	test("a relabel that fails deletes the sandbox and sends the claim cold", async () => {
		const f = fakePool();
		const pool = new WarmPool({ provider: f.provider, size: 1, labelsFor });
		await pool.start();
		await settle();
		const find = f.provider.find;
		const broken = {
			...f.provider,
			find: async (id) => {
				const sb = await find(id);
				return (
					sb && {
						...sb,
						setLabels: async () => {
							throw new Error("502");
						},
					}
				);
			},
		};
		const pool2 = new WarmPool({ provider: broken, size: 1, labelsFor });
		await pool2.start();
		await settle();
		assert.equal(await pool2.claim("conv_r"), undefined);
		await settle();
		assert.ok(f.log.some((l) => /^destroy pool-/.test(l)));
		await pool.close();
		await pool2.close();
	});

	test("leftovers from a previous process are adopted up to size; extras are deleted; a conversation's is never adopted", async () => {
		const f = fakePool([
			{ conversationId: "pool-old1" },
			{ conversationId: "conv_real" },
			{ conversationId: "pool-old2" },
			{ conversationId: "pool-old3" },
		]);
		const pool = new WarmPool({ provider: f.provider, size: 2, labelsFor });
		await pool.start();
		await settle();
		assert.equal(pool.readyCount, 2);
		assert.ok(f.log.includes("ensure pool-old1") && f.log.includes("ensure pool-old2"));
		assert.ok(f.log.includes("destroy pool-old3"));
		assert.ok(!f.log.some((l) => l.endsWith("conv_real")), "a claimed sandbox that still matches the labels is left alone");
		assert.ok(!f.log.some((l) => /^ensure pool-(?!old)/.test(l)), "no new sandbox needed");
		await pool.close();
	});

	test("the pool reports to the injected log", async () => {
		const f = fakePool();
		const lines = [];
		const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
		const pool = new WarmPool({ provider: f.provider, size: 1, labelsFor, log });
		await pool.start();
		await settle();
		await pool.claim("conv_l");
		await pool.close();
		assert.ok(lines.includes("warm pool: sandbox ready"));
		assert.ok(lines.includes("warm pool: claimed"));
	});
});
