/**
 * Task selection.
 *
 * Which tasks enter the sample decides what the experiment can detect, and two
 * of the filters exist because of things observed in live runs rather than
 * reasoning: computational servers let both arms bypass MCP entirely, and
 * credentialed servers return error payloads through a successful MCP call.
 *
 * Sampling must also be deterministic — every arm and model has to see the
 * identical task set, or the comparison is between samples rather than arms.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
	CREDENTIALED_SERVERS,
	RATE_LIMITED_SERVERS,
	SUBSTITUTABLE_SERVERS,
	availableServers,
	loadTasks,
	sampleTasks,
} from "../tasks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const available = existsSync(join(ROOT, "vendor/mcp-bench/tasks"));
const opts = { skip: available ? false : "vendor/mcp-bench not set up" };

describe("task loading", opts, () => {
	it("loads MCP-Bench's three tiers", () => {
		const tasks = loadTasks({ runnable: false });
		assert.ok(tasks.length > 100, `expected ~104 tasks, got ${tasks.length}`);
		assert.deepEqual([...new Set(tasks.map((t) => t.tier))].sort(), ["multi2", "multi3", "single"]);
	});

	it("gives every task a fuzzy phrasing and a concrete description", () => {
		// The agent sees the fuzzy one (retrieval is part of the measurement); the
		// judge sees the concrete one.
		for (const task of loadTasks({ runnable: false })) {
			assert.ok(task.fuzzy.length > 0, `${task.id} has no fuzzy description`);
			assert.ok(task.description.length > 0, `${task.id} has no concrete description`);
		}
	});

	it("exposes distractor servers alongside the real ones", () => {
		// This is the context-bloat condition: a "single-server" task really
		// mounts ~11 servers' worth of tool definitions.
		const tasks = loadTasks({ runnable: false });
		const withDistractors = tasks.filter((t) => t.distractors.length > 0);
		assert.ok(withDistractors.length > 0, "no task declared distraction servers");
		for (const task of withDistractors) {
			assert.ok(
				task.exposedServers.length > task.servers.length,
				`${task.id} exposes no more servers than it requires`,
			);
		}
	});
});

describe("runnability filtering", opts, () => {
	it("drops tasks needing a server we could not start", () => {
		const have = availableServers();
		if (have.size === 0) return;
		for (const task of loadTasks()) {
			for (const server of task.servers) {
				assert.ok(have.has(server), `${task.id} requires unavailable server ${server}`);
			}
		}
	});

	it("drops tasks requiring a server we have no credentials for", () => {
		for (const task of loadTasks()) {
			for (const server of task.servers) {
				assert.ok(!CREDENTIALED_SERVERS.has(server), `${task.id} requires credentialed ${server}`);
			}
		}
	});

	it("drops tasks requiring a rate-limited server", () => {
		// Their 429s arrive as successful MCP responses and are indistinguishable
		// from real tool errors to both the agent and the judge.
		for (const task of loadTasks()) {
			for (const server of task.servers) {
				assert.ok(!RATE_LIMITED_SERVERS.has(server), `${task.id} requires rate-limited ${server}`);
			}
		}
	});

	it("drops tasks a model could answer without tools", () => {
		for (const task of loadTasks()) {
			for (const server of task.servers) {
				assert.ok(!SUBSTITUTABLE_SERVERS.has(server), `${task.id} requires substitutable ${server}`);
			}
		}
	});

	it("keeps excluded servers as distractors", () => {
		// Their definitions are exactly the bloat being measured, so filtering them
		// out of the exposed set would weaken the condition under test.
		const have = availableServers();
		if (have.size === 0) return;
		const tasks = loadTasks();
		const anyExcludedDistractor = tasks.some((t) =>
			t.exposedServers.some((s) => CREDENTIALED_SERVERS.has(s) || SUBSTITUTABLE_SERVERS.has(s)),
		);
		assert.ok(anyExcludedDistractor, "excluded servers were removed from exposure as well as from requirements");
	});

	it("records distractors dropped for being unavailable", () => {
		// Silent removal would understate the bloat condition.
		for (const task of loadTasks()) {
			assert.ok(Array.isArray(task.droppedDistractors), `${task.id} has no droppedDistractors record`);
		}
	});

	it("grounded filtering is a strict subset of runnable", () => {
		const runnable = loadTasks({ grounded: false }).map((t) => t.id);
		const grounded = loadTasks().map((t) => t.id);
		assert.ok(grounded.length <= runnable.length);
		for (const id of grounded) assert.ok(runnable.includes(id), `${id} is grounded but not runnable`);
	});
});

describe("sampling is deterministic", opts, () => {
	it("returns the identical set on repeated calls", () => {
		const a = sampleTasks(3).map((t) => t.id);
		const b = sampleTasks(3).map((t) => t.id);
		assert.deepEqual(a, b, "sampling is not reproducible across calls");
	});

	it("stratifies across tiers", () => {
		const sample = sampleTasks(2);
		const tiers = new Set(sample.map((t) => t.tier));
		assert.ok(tiers.size > 1, `sample covered only ${[...tiers]}`);
	});

	it("does not repeat a task within a sample", () => {
		const ids = sampleTasks(4).map((t) => t.id);
		assert.equal(new Set(ids).size, ids.length);
	});

	it("samples only grounded tasks", () => {
		const grounded = new Set(loadTasks().map((t) => t.id));
		for (const task of sampleTasks(3)) {
			assert.ok(grounded.has(task.id), `sampled ungrounded task ${task.id}`);
		}
	});
});
