import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isPlacement, PlacedKernelBackend } from "../placed.mjs";

class Recording {
	constructor(name) {
		this.name = name;
		this.opened = [];
		this.destroyed = [];
		this.calls = [];
	}
	async open(ctx) {
		this.opened.push(ctx.conversationId);
		return { where: this.name };
	}
	async destroy(id) {
		this.destroyed.push(id);
	}
	async start() {
		this.calls.push("start");
	}
	async sweepIdle() {
		this.calls.push("sweep");
		return { deleted: ["x"], kept: 1 };
	}
	async drain() {
		this.calls.push("drain");
	}
	async shutdown() {
		this.calls.push("shutdown");
	}
}

class Device {
	constructor() {
		this.opened = [];
		this.destroyed = [];
		this.down = false;
	}
	async open(ctx) {
		this.opened.push(ctx.conversationId);
		return { where: "device" };
	}
	async destroyFor(userId, id) {
		this.destroyed.push([userId, id]);
	}
	async shutdown() {
		this.down = true;
	}
}

const ctx = (conversationId, over = {}) => ({ conversationId, userId: "user_k", ...over });

describe("placement routing", () => {
	test("each conversation's kernel runs where it was placed, and is removed from there", async () => {
		const rows = new Map([
			["conv-cloud", { placement: "cloud", userId: "user_k" }],
			["conv-mac", { placement: "device", userId: "user_k" }],
		]);
		const cloud = new Recording("cloud");
		const device = new Device();
		const router = new PlacedKernelBackend({ cloud, device, lookup: (id) => rows.get(id) });
		assert.equal(router.name, "cloud", "named after the cloud backend");
		assert.deepEqual(await router.open(ctx("conv-cloud")), { where: "cloud" });
		assert.deepEqual(await router.open(ctx("conv-mac")), { where: "device" });
		assert.deepEqual(cloud.opened, ["conv-cloud"], "the device conversation never touched the cloud backend");
		assert.deepEqual(device.opened, ["conv-mac"]);
		assert.equal(await router.placementOf("conv-mac"), "device");
		// The record is gone by the time the conversation is destroyed: the router remembers.
		rows.clear();
		await router.destroy("conv-mac");
		await router.destroy("conv-cloud");
		assert.deepEqual(device.destroyed, [["user_k", "conv-mac"]]);
		assert.deepEqual(cloud.destroyed, ["conv-cloud"]);
	});

	test("the caller's placement wins (a subagent), else the stored one, else cloud", async () => {
		const cloud = new Recording("cloud");
		const device = new Device();
		const router = new PlacedKernelBackend({ cloud, device, lookup: () => ({ placement: "cloud", userId: "u" }) });
		await router.open(ctx("child", { placement: "device" }));
		assert.deepEqual(device.opened, ["child"]);
		const unknown = new PlacedKernelBackend({ cloud, device, lookup: () => undefined });
		await unknown.open(ctx("new"));
		assert.deepEqual(cloud.opened, ["new"]);
		assert.equal(unknown.placementOf("never-opened"), "cloud");
	});

	test("whole-backend work goes to the cloud backend alone; shutdown reaches both", async () => {
		const cloud = new Recording("cloud");
		const device = new Device();
		const router = new PlacedKernelBackend({ cloud, device, lookup: () => undefined });
		await router.start({ apiTreeDir: "/a", skillRoots: [], dataDir: "/d" });
		assert.deepEqual(await router.sweepIdle({ olderThanMs: 1, lastActive: () => undefined, isOpen: () => false }), {
			deleted: ["x"],
			kept: 1,
		});
		await router.drain();
		await router.shutdown();
		assert.deepEqual(cloud.calls, ["start", "sweep", "drain", "shutdown"]);
		assert.equal(device.down, true);
	});

	test("a cloud backend without the optional verbs is fine; a device placement with no device backend fails to open", async () => {
		const bare = { name: "bare", open: async () => ({ where: "bare" }) };
		const router = new PlacedKernelBackend({ cloud: bare, lookup: (id) => (id === "m" ? { placement: "device", userId: "u" } : undefined) });
		await router.start({ apiTreeDir: "/a", skillRoots: [], dataDir: "/d" });
		assert.deepEqual(await router.sweepIdle({ olderThanMs: 1, lastActive: () => undefined, isOpen: () => false }), {
			deleted: [],
			kept: 0,
		});
		await router.drain();
		await router.destroy("c");
		await router.shutdown();
		await assert.rejects(router.open(ctx("m")), /no device backend/);
	});

	test("isPlacement", () => {
		assert.ok(isPlacement("cloud") && isPlacement("device"));
		assert.ok(!isPlacement("mac") && !isPlacement(undefined));
	});
});
