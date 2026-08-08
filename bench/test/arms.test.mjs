/**
 * Arm composition and isolation.
 *
 * The experiment's validity rests on the two arms differing in exactly one
 * respect — the tool registry — so these assertions are load-bearing, not
 * hygiene. A vanilla arm that leaks `ipython`, or a codemode arm that keeps a
 * `read` tool, silently invalidates every run made against it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ARMS, buildArm, toWireFormat } from "../arms.mjs";

describe("arm composition", () => {
	it("vanilla exposes exactly the seven conventional tools", async () => {
		const built = await buildArm("vanilla");
		assert.deepEqual(
			built.wire.map((w) => w.name).sort(),
			["bash", "edit", "find", "grep", "ls", "read", "write"],
		);
	});

	it("codemode exposes exactly one tool", async () => {
		const built = await buildArm("codemode");
		assert.deepEqual(built.wire.map((w) => w.name), ["ipython"]);
	});

	it("rejects an unknown arm rather than silently building an empty one", async () => {
		await assert.rejects(() => buildArm("nonesuch"), /unknown arm/);
	});
});

describe("arm isolation", () => {
	it("vanilla does not leak the REPL", async () => {
		const built = await buildArm("vanilla");
		assert.ok(!built.names.includes("ipython"), "vanilla must not expose ipython");
	});

	it("codemode does not retain any conventional tool", async () => {
		const built = await buildArm("codemode");
		const conventional = ARMS.vanilla;
		const leaked = built.names.filter((n) => conventional.includes(n));
		assert.deepEqual(leaked, [], `codemode leaked: ${leaked.join(", ")}`);
	});

	it("the arms share no tool", async () => {
		const [v, c] = await Promise.all([buildArm("vanilla"), buildArm("codemode")]);
		const overlap = v.names.filter((n) => c.names.includes(n));
		assert.deepEqual(overlap, []);
	});
});

describe("tool definitions are well formed", () => {
	for (const arm of Object.keys(ARMS)) {
		it(`${arm}: every tool has a name, a description, and an object schema`, async () => {
			const built = await buildArm(arm);
			for (const w of built.wire) {
				assert.ok(w.name, "tool is missing a name");
				assert.ok(w.description.length > 0, `${w.name} has an empty description`);
				assert.equal(typeof w.input_schema, "object", `${w.name} has a non-object schema`);
				assert.equal(w.input_schema.type, "object", `${w.name} schema is not type:object`);
			}
		});

		it(`${arm}: every tool schema serializes to JSON`, async () => {
			const built = await buildArm(arm);
			for (const w of built.wire) {
				assert.doesNotThrow(() => JSON.stringify(w), `${w.name} schema is not serializable`);
			}
		});

		it(`${arm}: no duplicate tool names`, async () => {
			const built = await buildArm(arm);
			const names = built.wire.map((w) => w.name);
			assert.equal(new Set(names).size, names.length);
		});
	}
});

describe("determinism", () => {
	// Benchmark runs are only comparable if the resident prompt is byte-identical
	// across invocations. A schema that embeds a timestamp, a temp path, or a
	// randomized ordering would break that silently.
	for (const arm of Object.keys(ARMS)) {
		it(`${arm}: two builds produce identical wire definitions`, async () => {
			const [a, b] = await Promise.all([buildArm(arm), buildArm(arm)]);
			assert.equal(JSON.stringify(a.wire), JSON.stringify(b.wire));
		});

		it(`${arm}: resident token count is stable across builds`, async () => {
			const [a, b] = await Promise.all([buildArm(arm), buildArm(arm)]);
			assert.equal(a.residentTokens, b.residentTokens);
		});
	}

	it("tool definitions do not embed the working directory", async () => {
		// cwd leaking into a description would make runs non-reproducible across
		// machines and would differ between the benchmark harness and a local run.
		const built = await buildArm("vanilla", "/tmp/sentinel-cwd-xyz");
		const serialized = JSON.stringify(built.wire);
		assert.ok(!serialized.includes("sentinel-cwd-xyz"), "cwd leaked into a tool definition");
	});
});

describe("wire format", () => {
	it("carries only the three fields the API sends", async () => {
		const built = await buildArm("vanilla");
		for (const w of built.wire) {
			assert.deepEqual(Object.keys(w).sort(), ["description", "input_schema", "name"]);
		}
	});

	it("drops harness-internal fields such as renderers and execute", async () => {
		const built = await buildArm("vanilla");
		const raw = built.tools[0];
		assert.ok(typeof raw.execute === "function", "precondition: raw def has execute");
		const wire = toWireFormat(raw);
		assert.equal(wire.execute, undefined);
		assert.equal(wire.renderResult, undefined);
	});
});
