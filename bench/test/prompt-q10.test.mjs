/**
 * q10: the preamble described from generate()'s promptContext. And q8, which a
 * port adapts by pattern match, keeps the text those patterns match.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generate } from "../generate.mjs";
import { SDK_PORT_OPTIONS } from "../generator-presets.mjs";
import { VARIANT_NAMES, buildPreamble } from "../prompts.mjs";
import { realistic } from "./fixtures/catalogue.mjs";

const BENCH = /ipython|Results are strings|scored|MCP-Bench/;

describe("q10", () => {
	it("is registered beside the other variants", () => {
		assert.ok(VARIANT_NAMES.includes("q10"));
		assert.ok(VARIANT_NAMES.includes("q8"));
	});

	it("describes the consolidated, typed tree a port ships, with its tool name", () => {
		const text = buildPreamble("q10", { toolCount: 40, serverCount: 2, moduleCount: 6, apiLayout: "consolidated", moduleIndex: true, typedReturns: true, validateArgs: true, toolName: "python" });
		assert.doesNotMatch(text, BENCH);
		assert.match(text, /40 async API functions\nin 6 modules/);
		assert.match(text, /!grep -n -A30 'def <api>\(' api\/<module>\.py +# one API's full docs/);
		assert.match(text, /!head -60 api\/<module>\.py/);
		assert.doesNotMatch(text, /!cat api\/<module>\.py/);
		assert.match(text, /Call them from the python tool\. `await` works at the top level/);
		assert.match(text, /Results are typed objects/);
		assert.match(text, /An `ArgumentError` already contains the fix/);
		assert.match(text, /## A cell is a program/);
		assert.doesNotMatch(text, /## Asset ids and waiting/);
	});

	it("describes the per-method, untyped tree with what that tree has", () => {
		const text = buildPreamble("q10", { toolCount: 5, serverCount: 2 });
		assert.match(text, /in 2 packages/);
		assert.match(buildPreamble("q10", { toolCount: 1, serverCount: 1 }), /holds 1 async API function\nin 1 package,/);
		assert.match(text, /!cat api\/<package>\/INDEX\.md/);
		assert.doesNotMatch(text, /def <api>\(|head -60|ArgumentError/);
		assert.match(text, /Results are the server's text, usually JSON/);
		assert.match(text, /json\.loads\(a\)/);
	});

	it("teaches asset ids and wait_for only for a tree with the wait surface, naming the read call it was given", () => {
		const base = { toolCount: 3, serverCount: 1, apiLayout: "consolidated", typedReturns: true };
		assert.doesNotMatch(buildPreamble("q10", base), /wait_for/);
		const waiting = buildPreamble("q10", { ...base, waitSurface: true, waitCalls: { read: "api.session.read" } });
		assert.match(waiting, /## Asset ids and waiting/);
		assert.match(waiting, /await api\.wait_for\(made\)/);
		assert.match(waiting, /call `api\.session\.read` with its id/);
		assert.doesNotMatch(buildPreamble("q10", { ...base, waitSurface: true }), /To look at an asset/);
	});

	it("reads its context straight from generate()", () => {
		const out = { title: "MadeOutput", type: "object", properties: { id: { type: "string", format: "product-asset-ref" } } };
		const cat = [{ server: "maker", tools: [{ name: "make_image", category: "image", inputSchema: { type: "object", properties: {} }, outputSchema: out }, { name: "ping", inputSchema: { type: "object", properties: {} }, outputSchema: out }] }];
		const { promptContext, modules } = generate(cat, SDK_PORT_OPTIONS);
		assert.deepEqual({ ...promptContext, waitCalls: undefined }, { toolCount: 2, serverCount: 1, moduleCount: modules.length, apiLayout: "consolidated", moduleIndex: true, typedReturns: true, validateArgs: true, waitSurface: true, waitCalls: undefined });
		const sdk = buildPreamble("q10", { ...promptContext, toolName: "python" });
		assert.match(sdk, /in 2 modules/);
		assert.match(sdk, /## Asset ids and waiting/);
		const bench = buildPreamble("q10", generate(realistic).promptContext);
		assert.match(bench, /packages/);
		assert.doesNotMatch(bench, /wait_for|ArgumentError/);
	});
});

describe("q8", () => {
	// the product shared/codemode/compile.mjs `adaptPreamble` rewrites q8 with these;
	// a q8 edit that stops matching one breaks that port's compile.
	const ADAPTED = [
		/you are scored on making the FEWEST calls that answer the\s+question, not the most\./,
		/enumerating an entire collection is scored as redundancy\./,
		/(\d+) services, generated/,
		/Discover them:\n[\s\S]*?\n\n/,
		"Call them from the ipython tool:",
		"ids = [r['id'] for r in json.loads(a)['items']][:15]",
		/Results are strings\./,
	];

	it("keeps every line a port adapts", () => {
		const text = buildPreamble("q8", { toolCount: 10, serverCount: 2 });
		for (const pattern of ADAPTED) {
			assert.ok(typeof pattern === "string" ? text.includes(pattern) : pattern.test(text), String(pattern));
		}
	});
});
