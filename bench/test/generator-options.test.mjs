/**
 * The generator's opt-in surfaces: what each option adds, and that leaving it at
 * its default renders the tree the MCP-Bench / AppWorld numbers were measured on.
 *
 * The experiment-lab port adopts this generator by passing PRODUCT_PORT_OPTIONS
 * (bench/generator-presets.mjs) instead of carrying its own copy, so the preset's
 * job is pinned here too: values only, every key a real option.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_BRIDGE_HEADER, generate } from "../generate.mjs";
import { PRODUCT_PORT_OPTIONS } from "../generator-presets.mjs";
import { realistic } from "./fixtures/catalogue.mjs";

const tool = (name, extra = {}) => ({
	name,
	description: `${name}.`,
	inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
	...extra,
});
const TIMED = [{ server: "svc", tools: [tool("make_thing"), tool("review_tool", { launches: true }), tool("edit_thing", { awaitsInputs: true })] }];
const PLAIN = [{ server: "svc", tools: [tool("make_thing"), tool("edit_thing")] }];
const SURFACE = /class NotReady\(RuntimeError\)|def wait_for\(|class Handle:/;

describe("the wait surface renders only when the catalogue has a use for it", () => {
	it("absent by default for a catalogue with no launches / awaitsInputs", () => {
		const { files } = generate(realistic, { validateArgs: true });
		assert.doesNotMatch(files["_client.py"], SURFACE);
		assert.doesNotMatch(files["_client.py"], /not_ready|urllib\.parse/);
		assert.equal(files["__init__.py"], '"""Generated MCP tool catalogue. See INDEX.md."""\n');
		assert.equal("time" in JSON.parse(files["_schemas.json"]), false);
	});

	it("present, with the time table, when a tool declares either", () => {
		const { files } = generate(TIMED, { validateArgs: true });
		assert.match(files["_client.py"], SURFACE);
		assert.match(files["__init__.py"], /from \._client import Handle, NotReady, wait_for/);
		assert.deepEqual(JSON.parse(files["_schemas.json"]).time, {
			svc: { review_tool: { awaitsInputs: false, launches: true }, edit_thing: { awaitsInputs: true, launches: false } },
		});
		assert.match(files["svc/spawn_review.py"], /^def spawn_review\(name: str \| None = None, \*, prompt: str\) -> Handle:/m);
	});

	it("forced on by waitSurface: true, and refused off when a launch needs it", () => {
		assert.match(generate(PLAIN, { waitSurface: true }).files["_client.py"], SURFACE);
		assert.throws(() => generate(TIMED, { waitSurface: false }), /review_tool declare launches/);
	});

	it("names the caller's read and collect calls, and neutral ones otherwise", () => {
		const neutral = generate(TIMED).files["_client.py"];
		assert.doesNotMatch(neutral, /api\.review|api\.assets/);
		const named = generate(TIMED, { waitCalls: { read: "api.things.read", result: "api.jobs.result" } }).files["_client.py"];
		assert.match(named, /read assets with 'api\.things\.read\(id\)'/);
		assert.match(named, /api\.jobs\.result\(\{self\.name!r\}\)/);
	});
});

describe("the bridge header", () => {
	it(`defaults to ${DEFAULT_BRIDGE_HEADER}, is renamable, and null sends none`, () => {
		const header = (opts) => generate(PLAIN, opts).files["_client.py"].match(/^ {4}headers = .*$/m)[0];
		assert.equal(header({}), `    headers = {"content-type": "application/json", "${DEFAULT_BRIDGE_HEADER}": "api/_client"}`);
		assert.equal(header({ bridgeHeader: "x-acme-bridge" }), '    headers = {"content-type": "application/json", "x-acme-bridge": "api/_client"}');
		assert.equal(header({ bridgeHeader: null }), '    headers = {"content-type": "application/json"}');
	});

	it("the launch request carries the same header", () => {
		const client = generate(TIMED, { bridgeHeader: "x-acme-bridge" }).files["_client.py"];
		assert.match(client, /_PROXY \+ "\/spawn".*\n\s+headers=\{"content-type": "application\/json", "x-acme-bridge": "api\/_client"\}/);
	});
});

describe("PRODUCT_PORT_OPTIONS", () => {
	it("holds values only", () => {
		const walk = (v) => {
			assert.notEqual(typeof v, "function");
			if (v && typeof v === "object") Object.values(v).forEach(walk);
		};
		walk(PRODUCT_PORT_OPTIONS);
		assert.deepEqual(JSON.parse(JSON.stringify(PRODUCT_PORT_OPTIONS)), { ...PRODUCT_PORT_OPTIONS });
	});

	it("every key changes something, so none of them is a typo the generator ignores", () => {
		const ASSET = { type: "string" };
		const out = { title: "MadeOutput", type: "object", additionalProperties: false, required: ["assets"], properties: { assets: { type: "array", items: { ...ASSET, format: "product-asset-ref" } } } };
		const cat = [
			{ server: "acts", tools: [tool("make_image", { category: "image", outputSchema: out }), tool("make_video", { category: "video", outputSchema: out })] },
			{ server: "agent", tools: [{ ...tool("wait_x"), inputSchema: { type: "object", properties: { t: { type: "number", maximum: 60 } } }, outputSchema: out }] },
		];
		const render = (opts) => JSON.stringify(generate(cat, { apiLayout: "consolidated", validateArgs: true, ...opts }).files);
		const withAll = render(PRODUCT_PORT_OPTIONS);
		for (const key of Object.keys(PRODUCT_PORT_OPTIONS)) {
			const { [key]: _drop, ...rest } = PRODUCT_PORT_OPTIONS;
			assert.notEqual(render(rest), withAll, `${key} had no effect`);
		}
	});
});

describe("a tree with the wait surface imports in Python", () => {
	const dirs = [];
	after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

	it("per-method and consolidated, typed, with the port's options", () => {
		const out = { title: "MadeOutput", type: "object", additionalProperties: false, properties: { id: { type: "string", format: "product-asset-ref" } } };
		const typed = TIMED.map((s) => ({ ...s, tools: s.tools.map((t) => ({ ...t, outputSchema: out })) }));
		for (const apiLayout of ["per-method", "consolidated"]) {
			const dir = mkdtempSync(join(tmpdir(), "harness-waitsurface-"));
			dirs.push(dir);
			for (const [rel, text] of Object.entries(generate(typed, { ...PRODUCT_PORT_OPTIONS, apiLayout, validateArgs: true }).files)) {
				mkdirSync(dirname(join(dir, "api", rel)), { recursive: true });
				writeFileSync(join(dir, "api", rel), text);
			}
			const mod = apiLayout === "consolidated" ? "api.svc" : "api.svc.spawn_review";
			const py = `import sys; sys.path.insert(0, ${JSON.stringify(dir)}); import api, ${mod}; print(api.wait_for.__name__, api.Handle.__name__)`;
			assert.equal(execFileSync("python3", ["-c", py], { encoding: "utf8" }).trim(), "wait_for Handle", apiLayout);
		}
	});
});
