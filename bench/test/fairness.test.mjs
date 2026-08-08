/**
 * Fairness invariants.
 *
 * Every assertion here exists because its violation was found in a live run and
 * silently corrupted results. They are cheap to check and expensive to miss.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { generate, pyIdent, pyPackage } from "../generate.mjs";
import { loadTasks } from "../tasks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUN_TASK = readFileSync(join(ROOT, "bench/run-task.mjs"), "utf8");
const SCHEMAS = join(ROOT, "bench/data/mcp-schemas.json");
const haveSchemas = existsSync(SCHEMAS);

describe("the vanilla arm has no shell", () => {
	// 78% of this arm's bash calls were `curl` straight to the APIs its MCP tools
	// wrap, so it was not exercising tool-calling at all — and the judge, which
	// only sees proxy-logged calls, scored those facts as ungrounded.
	it("bash is not in the vanilla built-in set", () => {
		const match = RUN_TASK.match(/const BUILTINS = \[([^\]]*)\]/);
		assert.ok(match, "BUILTINS not found in run-task.mjs");
		assert.ok(!/"bash"/.test(match[1]), `vanilla regained bash: ${match[1]}`);
	});

	it("codemode keeps its REPL, which is the treatment", () => {
		assert.match(RUN_TASK, /toolList = \["ipython"\]/);
	});
});

describe("direct network egress is blocked", () => {
	// Proxy env vars stop curl/requests/urllib. Raw sockets still evade them,
	// which is why removing the shell matters more than this does.
	it("the agent process gets a dead proxy", () => {
		assert.match(RUN_TASK, /https_proxy: "http:\/\/127\.0\.0\.1:9"/);
	});

	it("the MCP proxy and the model API stay reachable", () => {
		const match = RUN_TASK.match(/no_proxy: "([^"]+)"/);
		assert.ok(match, "no_proxy not set");
		assert.match(match[1], /127\.0\.0\.1/);
		assert.match(match[1], /api\.anthropic\.com/);
	});

	it("the escape hatch is opt-in and off by default", () => {
		assert.match(RUN_TASK, /HARNESS_ALLOW_DIRECT_NET === "1"/);
	});
});

describe("both arms share one base system prompt", () => {
	// prime's own base prompt was 6,284 chars for codemode and 615 for vanilla:
	// whole sections gate on `hasIpython`, so the code arm received 10x more
	// workflow guidance plus RLM instructions this experiment does not use.
	it("a single BASE_SYSTEM_PROMPT is defined", () => {
		assert.match(RUN_TASK, /const BASE_SYSTEM_PROMPT = \[/);
	});

	it("it is passed to every arm, not built per-arm", () => {
		assert.match(RUN_TASK, /"--system-prompt",\s*\n\s*BASE_SYSTEM_PROMPT,/);
		// Check the definition itself for arm branching, not a byte window after
		// it — the following statement legitimately mentions `arm`.
		const start = RUN_TASK.indexOf("const BASE_SYSTEM_PROMPT = [");
		const body = RUN_TASK.slice(start, RUN_TASK.indexOf('].join("\\n");', start));
		assert.ok(!/\barm\b/.test(body), "the base prompt definition branches on arm");
	});

	it("it says nothing about ipython, python, or bash", () => {
		// Naming one arm's mechanics in the shared prompt would tilt the comparison.
		const body = RUN_TASK.slice(
			RUN_TASK.indexOf("const BASE_SYSTEM_PROMPT = ["),
			RUN_TASK.indexOf('].join("\\n");', RUN_TASK.indexOf("const BASE_SYSTEM_PROMPT = [")),
		);
		for (const word of ["ipython", "python", "bash", "REPL", "api/"]) {
			assert.ok(!new RegExp(word, "i").test(body), `base prompt mentions "${word}"`);
		}
	});
});

describe("both arms receive the same tool catalogue", { skip: haveSchemas ? false : "no schemas dumped" }, () => {
	const catalogue = () => JSON.parse(readFileSync(SCHEMAS, "utf8")).catalogue;

	it("tool-definition count equals api/ module count, per task", () => {
		// A tool present to one arm and absent from the other is a capability
		// difference wearing a token-saving costume.
		const all = catalogue();
		for (const task of loadTasks().slice(0, 25)) {
			const selected = all.filter((s) => task.exposedServers.includes(s.server));
			const { toolDefs, files } = generate(selected);
			const modules = Object.keys(files).filter(
				(p) => p.endsWith(".py") && !p.endsWith("__init__.py") && !p.endsWith("_client.py"),
			);
			assert.equal(toolDefs.length, modules.length, `${task.id}: ${toolDefs.length} defs vs ${modules.length} modules`);
		}
	});

	it("both renderings carry the same authored descriptions", () => {
		// Look the module up by its deterministic path rather than by scanning for
		// a substring, which matched the wrong file when tool names share a prefix.
		const selected = catalogue().slice(0, 4);
		const { toolDefs, files } = generate(selected);
		for (const server of selected) {
			for (const tool of server.tools) {
				if (!tool.description) continue;
				const module = files[`${pyPackage(server.server)}/${pyIdent(tool.name)}.py`];
				const def = toolDefs.find((d) => d._mcp.server === server.server && d._mcp.tool === tool.name);
				const first = tool.description.trim().split("\n")[0];
				assert.ok(module, `no module for ${server.server}.${tool.name}`);
				assert.ok(module.includes(first), `${tool.name}: api/ module lost the description`);
				assert.equal(def.description, tool.description.trim(), `${tool.name}: tool def altered the description`);
			}
		}
	});
});

describe("recorded runs remain interpretable", () => {
	it("run-task records what it would need to detect its own contamination", () => {
		for (const field of ["firstTurnPromptTokens", "residencyViolation", "promptVariant", "toolCount"]) {
			assert.match(RUN_TASK, new RegExp(field), `run-task no longer records ${field}`);
		}
	});

	it("a completed run cannot be silently overwritten", () => {
		assert.match(RUN_TASK, /run already exists/);
	});
});
