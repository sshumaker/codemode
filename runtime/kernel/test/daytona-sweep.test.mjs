import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DaytonaKernelBackend } from "../daytona.mjs";
import { startIdleSweep } from "../sweep.mjs";
import { fakeModule, kernelContext } from "./fakes.mjs";

const DAY = 24 * 3_600_000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const ctx = () => kernelContext({ skillRoots: [] });

describe("sweepIdle", () => {
	const olderThanMs = 30 * DAY;
	const known = {
		"conv-old": new Date(Date.now() - 40 * DAY),
		"conv-old-but-daytona-busy": new Date(Date.now() - 40 * DAY),
		"conv-recent": new Date(Date.now() - 1 * DAY),
		"conv-open": new Date(Date.now() - 40 * DAY),
	};
	const orphans = [
		{ sandboxId: "s0", conversationId: "pool-abc", state: "started", lastActivityAt: iso(90 * DAY) },
		{ sandboxId: "s1", conversationId: "conv-old", state: "stopped", lastActivityAt: iso(40 * DAY) },
		{ sandboxId: "s2", conversationId: "conv-old-but-daytona-busy", state: "started", lastActivityAt: iso(3_600_000) },
		{ sandboxId: "s3", conversationId: "conv-recent", state: "stopped", lastActivityAt: iso(40 * DAY) },
		{ sandboxId: "s4", conversationId: "conv-open", state: "started", lastActivityAt: iso(40 * DAY) },
		{ sandboxId: "s5", conversationId: "conv-deleted", state: "stopped", lastActivityAt: iso(2 * 3_600_000) },
		{ sandboxId: "s6", conversationId: "child-just-made", state: "started", lastActivityAt: iso(5 * 60_000) },
	];
	const destroyed = (f) => f.calls.filter((c) => c.op === "destroy").map((c) => c.args[0]);

	test("deletes only what is idle by both clocks, gone conversations after a grace, never the pool or an open one", async () => {
		const f = fakeModule({ orphans });
		const backend = new DaytonaKernelBackend({ providerModule: f.mod, poolOwner: "gw-1" });
		const r = await backend.sweepIdle({
			olderThanMs,
			lastActive: (id) => known[id],
			isOpen: (id) => id === "conv-open",
		});
		assert.deepEqual(r.deleted.sort(), ["conv-deleted", "conv-old"]);
		assert.deepEqual(destroyed(f).sort(), ["conv-deleted", "conv-old"]);
		assert.equal(r.kept, 5);
	});

	test("the sweep only ever sees this host's sandboxes: the provider is scoped by the owner label", async () => {
		const f = fakeModule({ orphans: [] });
		const backend = new DaytonaKernelBackend({ providerModule: f.mod, poolOwner: "gw-1", autoDeleteMinutes: 45 * 24 * 60 });
		await backend.sweepIdle({ olderThanMs, lastActive: () => undefined, isOpen: () => false });
		assert.equal(f.constructed[0]?.labels?.pool_owner, "gw-1");
		assert.equal(f.constructed[0]?.autoDeleteMinutes, 45 * 24 * 60, "Daytona's own delete is the backstop");
	});

	test("a sandbox with no activity time and a gone conversation is deleted", async () => {
		const f = fakeModule({ orphans: [{ sandboxId: "s", conversationId: "conv-x", state: "stopped" }] });
		const backend = new DaytonaKernelBackend({ providerModule: f.mod });
		const r = await backend.sweepIdle({ olderThanMs, lastActive: () => undefined, isOpen: () => false });
		assert.deepEqual(r.deleted, ["conv-x"]);
	});

	test("a sandbox that will not delete is kept and counted; the sweep goes on", async () => {
		const f = fakeModule({
			orphans: [
				{ sandboxId: "a", conversationId: "conv-a", state: "stopped" },
				{ sandboxId: "b", conversationId: "conv-b", state: "stopped" },
			],
		});
		f.provider.destroy = async (id) => {
			if (id === "conv-a") throw new Error("500");
		};
		const warned = [];
		const backend = new DaytonaKernelBackend({ providerModule: f.mod, log: { info() {}, warn: (m) => warned.push(m) } });
		const r = await backend.sweepIdle({ olderThanMs, lastActive: () => undefined, isOpen: () => false });
		assert.deepEqual(r, { deleted: ["conv-b"], kept: 1 });
		assert.deepEqual(warned, ["sweep: could not delete an idle sandbox"]);
	});

	test("a provider that cannot list sandboxes sweeps nothing", async () => {
		const f = fakeModule();
		const backend = new DaytonaKernelBackend({ providerModule: f.mod });
		assert.deepEqual(await backend.sweepIdle({ olderThanMs, lastActive: () => undefined, isOpen: () => false }), {
			deleted: [],
			kept: 0,
		});
	});
});

describe("sweepIdle over harness's own provider", () => {
	test("label scoping and Daytona's last-activity time come from provider.mjs's listOrphans", async () => {
		const mod = await import("../../daytona/provider.mjs");
		const sandboxes = [
			{ id: "s1", state: "stopped", lastActivityAt: iso(40 * DAY), labels: { app: "assistant-workspace", pool_owner: "gw-1", conversation: "conv-old" } },
			{ id: "s2", state: "stopped", lastActivityAt: iso(40 * DAY), labels: { app: "assistant-workspace", pool_owner: "gw-2", conversation: "conv-other-gw" } },
			{ id: "s3", state: "started", lastActivityAt: iso(60_000), labels: { app: "assistant-workspace", pool_owner: "gw-1", conversation: "conv-busy" } },
			{ id: "s4", state: "destroyed", labels: { app: "assistant-workspace", pool_owner: "gw-1", conversation: "conv-dead" } },
		];
		const deleted = [];
		const daytona = {
			async *list({ labels }) {
				for (const sb of sandboxes) if (Object.entries(labels).every(([k, v]) => sb.labels[k] === v)) yield sb;
			},
			async get(id) {
				const sb = sandboxes.find((s) => s.id === id);
				if (!sb || deleted.includes(id)) throw Object.assign(new Error("not found"), { name: "DaytonaNotFoundError", statusCode: 404 });
				return { ...sb, delete: async () => void deleted.push(id) };
			},
		};
		const backend = new DaytonaKernelBackend({ providerModule: mod, providerOptions: { daytona }, poolOwner: "gw-1" });
		const r = await backend.sweepIdle({
			olderThanMs: 30 * DAY,
			lastActive: () => new Date(Date.now() - 40 * DAY),
			isOpen: () => false,
		});
		assert.deepEqual(r.deleted, ["conv-old"], "another host's sandbox is invisible; a busy one is kept; a destroyed one is not listed");
		assert.deepEqual(deleted, ["s1"]);
		assert.equal(r.kept, 1);
	});
});

describe("startIdleSweep", () => {
	test("sweeps after the first delay and then on the interval, and stops", async () => {
		const seen = [];
		const backend = {
			name: "b",
			open: async () => ({}),
			sweepIdle: async (o) => {
				seen.push(o.olderThanMs);
				return { deleted: [], kept: 0 };
			},
		};
		const swept = [];
		const stop = startIdleSweep(backend, {
			olderThanMs: 5,
			lastActive: () => undefined,
			isOpen: () => false,
			firstDelayMs: 5,
			intervalMs: 20,
			onSwept: (r) => swept.push(r),
		});
		await new Promise((r) => setTimeout(r, 60));
		stop();
		const n = seen.length;
		assert.ok(n >= 2, `swept on start and on the interval (${n})`);
		assert.equal(swept.length, n);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(seen.length, n, "nothing after stop");
	});

	test("a failing sweep goes to onError; a backend that cannot sweep, or a zero age, schedules nothing", async () => {
		const errors = [];
		const failing = { name: "b", open: async () => ({}), sweepIdle: async () => Promise.reject(new Error("boom")) };
		const stop = startIdleSweep(failing, {
			olderThanMs: 1,
			lastActive: () => undefined,
			isOpen: () => false,
			firstDelayMs: 1,
			onError: (e) => errors.push(String(e)),
		});
		await new Promise((r) => setTimeout(r, 20));
		stop();
		assert.deepEqual(errors, ["Error: boom"]);
		let called = false;
		const counting = { name: "b", open: async () => ({}), sweepIdle: async () => ((called = true), { deleted: [], kept: 0 }) };
		startIdleSweep(counting, { olderThanMs: 0, lastActive: () => undefined, isOpen: () => false, firstDelayMs: 1 })();
		startIdleSweep({ name: "n", open: async () => ({}) }, { olderThanMs: 1, lastActive: () => undefined, isOpen: () => false })();
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(called, false);
	});
});

describe("restoring a recreated workspace", () => {
	function hostFiles(dir) {
		mkdirSync(join(dir, "inputs"), { recursive: true });
		mkdirSync(join(dir, "art"), { recursive: true });
		writeFileSync(join(dir, "inputs", "sales.csv"), "a,b\n1,2\n");
		writeFileSync(join(dir, "art", "art_1"), "# brief v3\n");
		return [
			{ relPath: "inputs/sales.csv", hostPath: join(dir, "inputs", "sales.csv") },
			{ relPath: "outputs/brief.md", hostPath: join(dir, "art", "art_1") },
			{ relPath: "outputs/gone.md", hostPath: join(dir, "art", "missing") },
		];
	}

	test("a conversation that had a sandbox and gets a new one gets its inputs and latest outputs back", async () => {
		const f = fakeModule({ created: true });
		const backend = new DaytonaKernelBackend({ providerModule: f.mod });
		const c = ctx();
		writeFileSync(join(c.convDir, "daytona-sandbox"), "earlier\n");
		const files = hostFiles(c.convDir);
		c.restoreFiles = () => files;
		const session = await backend.open(c);
		await session.ready;
		assert.equal(await session.restored, 2, "the missing artifact file is skipped, not an error");
		assert.deepEqual(
			f.uploads.map((u) => [u.path, u.bytes]),
			[
				["inputs/sales.csv", "a,b\n1,2\n"],
				["outputs/brief.md", "# brief v3\n"],
			],
		);
	});

	test("without a warm pool, the first open still records that the conversation now has a sandbox", async () => {
		const f = fakeModule({ created: true });
		const backend = new DaytonaKernelBackend({ providerModule: f.mod });
		const c = ctx();
		const first = await backend.open(c);
		await first.ready;
		const files = hostFiles(c.convDir);
		c.restoreFiles = () => files;
		const again = await new DaytonaKernelBackend({ providerModule: f.mod }).open(c);
		await again.ready;
		assert.equal(await again.restored, 2, "a later fresh sandbox is recognised as a recreated one");
	});

	test("a brand-new conversation restores nothing, and says so at once", async () => {
		const f = fakeModule({ created: true });
		const backend = new DaytonaKernelBackend({ providerModule: f.mod });
		const c = ctx();
		c.restoreFiles = () => hostFiles(c.convDir);
		const session = await backend.open(c);
		assert.equal(await session.restored, 0);
		await session.ready;
		assert.equal(f.uploads.length, 0);
	});

	test("a stopped sandbox that is simply restarted keeps its files: nothing is re-uploaded", async () => {
		const f = fakeModule({ created: false });
		const backend = new DaytonaKernelBackend({ providerModule: f.mod });
		const c = ctx();
		writeFileSync(join(c.convDir, "daytona-sandbox"), "earlier\n");
		c.restoreFiles = () => hostFiles(c.convDir);
		const session = await backend.open(c);
		await session.ready;
		assert.equal(await session.restored, 0);
		assert.equal(f.uploads.length, 0);
	});
});
