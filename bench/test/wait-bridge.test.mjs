/**
 * H9: the compiled wait tool spends wall-clock without holding the kernel.
 *
 * Measured friction: `wait_for_assets.max_timeout` carries `le=60`, GLM asks for
 * 120 or 300, and every one of those calls in the traces died as an ArgumentError —
 * 7+ occurrences, the most recurring in the port. Meanwhile the shim flattens the
 * product's server-side suspension into an immediate "still in flight", so the
 * session polls by re-calling: one model turn per poll, covering no wall clock.
 *
 * The design call is forced by the primitive rather than chosen. `jobs.wait`
 * (runtime/jobs.py) prints a sentinel, records the wake on disk and raises
 * `WaitSignal` — it ENDS THE CELL; the host sleeps with the kernel released and
 * calls the model again. Nothing after it in a cell ever runs, so a wrapper cannot
 * loop across a wait. Hence hop-and-yield: one server call at the cap the server
 * allows, then yield the rest of the caller's time to the host.
 *
 * Two conditions, on purpose: the WRAPPER is bundle-carried (a property of the
 * schemas), the BEHAVIOUR is env-gated by HARNESS_WAIT_BRIDGE so one bundle A/Bs.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { generate, normalizeTool, waitToolCap, waitToolParam } from "../generate.mjs";
import { realistic, wide } from "./fixtures/catalogue.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PROBE = join(ROOT, "bench/test/fixtures/wait_bridge_probe.py");

const WAIT_TOOL = {
	name: "wait_for_assets",
	description: "Wait until assets become ready.",
	inputSchema: {
		type: "object",
		properties: {
			ids: { type: "array", items: { type: "string" }, minItems: 1 },
			max_timeout: { type: "number", minimum: 1, maximum: 60, description: "Maximum seconds to wait (default 30)" },
			reason: { type: "string" },
		},
		required: ["ids"],
	},
};
const CATALOGUE = [{ server: "agent_tools", tools: [WAIT_TOOL] }];

describe("which tools the override applies to", () => {
	it("finds the capped timeout of a wait tool, from the schema", () => {
		const tool = normalizeTool(WAIT_TOOL);
		const param = waitToolParam(tool);
		assert.equal(param?.name, "max_timeout");
		assert.equal(waitToolCap(tool, param), 60);
	});

	it("declines everything else, so no other tool's call site changes", () => {
		// Shape-driven and narrow: `wait_*`, plus a numeric timeout carrying a
		// maximum. A tool that merely takes a timeout is not a wait tool.
		const not = [
			{ name: "read", inputSchema: { type: "object", properties: { ref: { type: "string" } } } },
			{ name: "wait_for_assets", inputSchema: { type: "object", properties: { ids: { type: "array" } } } },
			{ name: "fetch", inputSchema: { type: "object", properties: { max_timeout: { type: "number", maximum: 60 } } } },
			{ name: "wait_for_assets", inputSchema: { type: "object", properties: { max_timeout: { type: "number" } } } },
		];
		for (const tool of not) assert.equal(waitToolParam(normalizeTool(tool)), null, tool.name);
	});
});

describe("the compiled call site", () => {
	const on = generate(CATALOGUE, { validateArgs: true, waitBridge: true }).files;
	const off = generate(CATALOGUE, { validateArgs: true }).files;

	it("routes the wait tool through the bridge, carrying the schema's own cap", () => {
		const module = on["agent_tools/wait_for_assets.py"];
		assert.match(module, /from \.\._client import call as _call.*wait_bridge as _wait_bridge/);
		assert.match(module, /return await _wait_bridge\(/);
		assert.match(module, /^\s+max_timeout,$/m);
		assert.match(module, /^\s+60,$/m, "the server's cap is not passed from the schema");
	});

	it("changes exactly two files, and no schema", () => {
		// The cap is REAL — the server enforces it — so the fix must not widen
		// `_schemas.json`. With the gate off, a 300 still raises the same
		// ArgumentError it always did; that is asserted for real in the probe.
		const changed = Object.keys(on).filter((k) => on[k] !== off[k]);
		assert.deepEqual(changed.sort(), ["_client.py", "agent_tools/INDEX.md", "agent_tools/wait_for_assets.py"]);
		assert.deepEqual(JSON.parse(on["_schemas.json"]), JSON.parse(off["_schemas.json"]));
	});

	it("renders nothing at all for a catalogue with no wait tool", () => {
		for (const catalogue of [realistic, wide]) {
			const withOption = generate(catalogue, { validateArgs: true, waitBridge: true });
			const without = generate(catalogue, { validateArgs: true });
			assert.deepEqual(withOption.files, without.files);
		}
	});

	it("teaches the yield where the model reads: the docstring and the INDEX line", () => {
		// Scott-ordered. The docstring sentence sits under the parameter it changes,
		// and the INDEX line — where a tool is CHOSEN — carries the short marker.
		const module = on["agent_tools/wait_for_assets.py"];
		assert.match(module, /Long waits YIELD THE REPL: this cell ends while the host waits/);
		assert.match(module, /Each server call waits at most 60s; request the max_timeout you actually need\./);
		assert.match(on["agent_tools/INDEX.md"], /wait_for_assets\(ids, max_timeout\?, reason\?\)` \*\(yields the REPL on long waits\)\*/);
		// Neither appears without the option: an unbridged tree must not advertise a
		// yield that will not happen.
		assert.equal(/YIELD THE REPL/.test(off["agent_tools/wait_for_assets.py"]), false);
		assert.equal(/yields the REPL/.test(off["agent_tools/INDEX.md"]), false);
	});

	it("stops hopping the moment the wait resolves", () => {
		// The shapes came from real streams: `completed: true` is done,
		// `suspended: true` / `completed: false` is in flight, anything else is
		// unknown and goes to the model verbatim. All three are executed in the probe.
		assert.match(on["_client.py"], /def _wait_resolved\(text: str\)/);
		assert.match(on["_client.py"], /payload\.get\("suspended"\) is True/);
		assert.match(on["_client.py"], /return completed if isinstance\(completed, bool\) else None/);
	});

	it("states the mechanism in the transport, gated and off by default", () => {
		assert.match(on["_client.py"], /os\.environ\.get\("HARNESS_WAIT_BRIDGE"\) != "1"/);
		assert.equal(/HARNESS_WAIT_BRIDGE/.test(off["_client.py"]), false);
	});
});

describe("the generated tree, executed", () => {
	const dirs = [];
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	it("hops at the cap, yields the rest, and never blocks the cell", () => {
		// The probe asserts the wall-clock property directly: with the gate on and a
		// 300s request, the call returns control in milliseconds having sent ONE hop
		// of 60 and handed 240 to the host. It also covers the gate-off path (the
		// original ArgumentError), a request within the cap (untouched), and a kernel
		// with no `jobs` module (degrades to the hop).
		const dir = mkdtempSync(join(tmpdir(), "harness-waitbridge-"));
		dirs.push(dir);
		for (const [rel, content] of Object.entries(generate(CATALOGUE, { validateArgs: true, waitBridge: true }).files)) {
			const path = join(dir, "api", rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		assert.match(execFileSync("python3", [PROBE, dir], { encoding: "utf8", stdio: "pipe" }), /^OK$/m);
	});

	it("every module still compiles with the bridge on", () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-waitbridge-ast-"));
		dirs.push(dir);
		const catalogue = JSON.parse(readFileSync(join(ROOT, "bench/data/appworld-schemas.json"), "utf8")).catalogue;
		for (const [rel, content] of Object.entries(generate([...catalogue, ...CATALOGUE], { validateArgs: true, waitBridge: true }).files)) {
			if (!rel.endsWith(".py")) continue;
			const path = join(dir, rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
			execFileSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", path], { stdio: "pipe" });
		}
	});
});
