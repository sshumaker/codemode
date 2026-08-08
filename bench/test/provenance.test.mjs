/**
 * Setup verification.
 *
 * The vendored upstreams are patched by scripts, and the arms are read from a
 * compiled `dist/`. Both are silent failure modes: a fresh clone that skipped
 * the scripts, or a `dist/` older than the sources it came from, still runs —
 * it just runs a different experiment than the one documented. These tests make
 * that loud.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PRIME = join(ROOT, "vendor/prime-agent/packages/coding-agent");
const SRC = join(PRIME, "src");
const DIST = join(PRIME, "dist");

const read = (rel) => readFileSync(join(SRC, rel), "utf8");

/** Newest mtime under `dir`, ignoring node_modules. */
function newestMtime(dir) {
	let newest = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		const mtime = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
		if (mtime > newest) newest = mtime;
	}
	return newest;
}

describe("vendored upstreams are present", () => {
	it("prime-agent is vendored", () => {
		assert.ok(existsSync(SRC), "vendor/prime-agent missing — see README setup");
	});

	it("pi-mono is vendored (source for the ported tools)", () => {
		assert.ok(
			existsSync(join(ROOT, "vendor/pi-mono/packages/coding-agent/src/core/tools/read.ts")),
			"vendor/pi-mono missing — see README setup",
		);
	});
});

describe("port-vanilla-tools.mjs has been applied", () => {
	it("the five dropped tools exist in prime's tree", () => {
		for (const tool of ["read", "write", "grep", "find", "ls"]) {
			assert.ok(
				existsSync(join(SRC, `core/tools/${tool}.ts`)),
				`core/tools/${tool}.ts missing — run: node scripts/port-vanilla-tools.mjs`,
			);
		}
	});

	it("the registry knows all eight built-ins", () => {
		const index = read("core/tools/index.ts");
		for (const tool of ["read", "bash", "edit", "write", "grep", "find", "ls", "ipython"]) {
			assert.match(index, new RegExp(`"${tool}"`), `registry does not mention ${tool}`);
		}
	});

	it("the CLI no longer rejects the restored tools", () => {
		// prime hardcoded a rejection list for exactly the five it deleted.
		const args = read("cli/args.ts");
		assert.match(
			args,
			/REMOVED_BUILTIN_TOOL_NAMES = new Set<string>\(\[\]\)/,
			"cli/args.ts still rejects the restored tools — run: node scripts/port-vanilla-tools.mjs",
		);
	});

	it("read.ts image support resolves against prime's diverged utils", () => {
		const imageProcess = read("utils/image-process.ts");
		assert.match(imageProcess, /convertToPng/, "image-process was not adapted to prime's API");
		assert.ok(
			!imageProcess.includes(`import { convertImageBytesToPng } from "./image-convert.js"`),
			"image-process still imports pi's removed export",
		);
	});
});

describe("neutralize-prime.mjs has been applied", () => {
	it("harness state no longer reaches the system prompt by default", () => {
		// It persists to harness_state.json and mutates the prompt, so run N would
		// otherwise depend on run N-1.
		const session = read("core/agent-session.ts");
		assert.match(
			session,
			/PRIME_HARNESS_STATE === "1" \? this\._loadMergedHarnessState\(\) : undefined/,
			"harness-state injection is still live — run: node scripts/neutralize-prime.mjs",
		);
	});

	it("the conversation-log path is deliberately retained", () => {
		// Identical across arms, one line, and the mechanism for recovering context
		// after a compaction or kernel reset. Removing it would handicap both arms.
		const prompt = read("core/prompts/rlm.ts");
		assert.match(prompt, /Conversation log:/, "the conversation-log path was removed — see docs/DESIGN.md");
	});

	it("kernel prewarm stays gated on ipython being active", () => {
		// Upstream already gates this; if a bump removes the guard, the vanilla arm
		// would start a Python kernel it never uses and mask codemode's boot cost.
		const session = read("core/agent-session.ts");
		assert.match(
			session,
			/getActiveToolNames\(\)\.includes\("ipython"\)[\s\S]{0,80}prewarm\(\)/,
			"kernel prewarm is no longer gated on ipython being active",
		);
	});
});

describe("the compiled harness is current", () => {
	it("dist exists", () => {
		assert.ok(
			existsSync(join(DIST, "core/tools/index.js")),
			"dist missing — run: cd vendor/prime-agent && npm run build",
		);
	});

	it("dist is newer than src", () => {
		// Arms are read from dist. A stale dist silently measures the pre-patch
		// harness while every source assertion above still passes.
		const srcTime = newestMtime(SRC);
		const distTime = newestMtime(DIST);
		assert.ok(
			distTime >= srcTime,
			`dist is stale (src ${new Date(srcTime).toISOString()} > dist ${new Date(distTime).toISOString()}) — ` +
				"run: cd vendor/prime-agent && npm run build",
		);
	});

	it("the compiled registry builds all eight tools", async () => {
		const registry = await import(join(DIST, "core/tools/index.js"));
		const built = registry.createAllToolDefinitions(ROOT, {});
		assert.deepEqual(
			Object.keys(built).sort(),
			["bash", "edit", "find", "grep", "ipython", "ls", "read", "write"],
		);
	});
});
