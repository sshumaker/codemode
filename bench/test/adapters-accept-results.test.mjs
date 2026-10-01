/**
 * Typed results at adapted parameters, driven in real Python against a stub proxy.
 *
 * The pythonic adapters (`labeled_ids`, `as_list`) ran before `_call` coerced results
 * to ids, so `assets=[result]` at a `[{label, asset_id}]` parameter and `ids=result`
 * at a `list[str]` parameter were refused client-side — while `ids=[result]` at a
 * plain list worked. A result is now accepted wherever an id or list of ids is,
 * and the wire shape is the one bare ids would have produced.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { generate } from "../generate.mjs";
import { PRODUCT_PORT_OPTIONS } from "../generator-presets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PROBE = join(ROOT, "bench/test/fixtures/adapters_accept_results_probe.py");
const KERNEL_PY = join(homedir(), ".prime/agent/kernel-venv/bin/python");
const PYTHON = existsSync(KERNEL_PY) ? KERNEL_PY : "python3";

const output = (title, properties) => ({ title, type: "object", properties, required: Object.keys(properties) });
const tool = (name, inputSchema, outputSchema) => ({ name, category: "session", description: `${name.replace(/_/g, " ")}.`, inputSchema, outputSchema });

const CATALOGUE = [
	{
		server: "maker",
		tools: [
			tool(
				"make_image",
				{ type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
				output("MakeImageOutput", { asset_id: { type: "string", format: "product-ref", "x-ref-kinds": ["image"] } }),
			),
			tool(
				"judge",
				{
					type: "object",
					properties: {
						assets: {
							type: "array",
							items: {
								type: "object",
								properties: { label: { type: "string" }, asset_id: { type: "string" } },
								required: ["label", "asset_id"],
							},
						},
					},
					required: ["assets"],
				},
				output("JudgeOutput", { verdict: { type: "string" } }),
			),
			tool(
				"wait_ids",
				{ type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
				output("WaitIdsOutput", { done: { type: "boolean" } }),
			),
		],
	},
];

const OPTIONS = { ...PRODUCT_PORT_OPTIONS, apiLayout: "consolidated", typedReturns: true, validateArgs: true, allowUntyped: true };

describe("generated client: adapted parameters accept typed results", () => {
	const dirs = [];
	let probe;
	before(() => {
		const dir = mkdtempSync(join(tmpdir(), "harness-adapters-results-"));
		dirs.push(dir);
		for (const [rel, content] of Object.entries(generate(CATALOGUE, OPTIONS).files)) {
			const path = join(dir, "api", rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		probe = JSON.parse(execFileSync(PYTHON, [PROBE, dir], { encoding: "utf8" }).trim().split("\n").at(-1));
	});
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	const sent = (tool) => probe.requests.filter((r) => r.tool === tool).map((r) => r.args);

	it("labels a list of results where [{label, asset_id}] is declared", () => {
		assert.equal(probe.outcomes.labeled_results, "ok");
		assert.deepEqual(sent("judge")[0], {
			assets: [
				{ label: "asset_1", asset_id: "img_1" },
				{ label: "asset_2", asset_id: "img_2" },
			],
		});
	});

	it("labels a mixed list of a result, a bare id and a strict entry holding a result", () => {
		assert.equal(probe.outcomes.labeled_mixed, "ok");
		assert.deepEqual(sent("judge")[1], {
			assets: [
				{ label: "asset_1", asset_id: "img_1" },
				{ label: "asset_2", asset_id: "img_bare" },
				{ label: "hero", asset_id: "img_2" },
			],
		});
	});

	it("accepts a {label: result} dict", () => {
		assert.equal(probe.outcomes.labeled_dict_results, "ok");
		assert.deepEqual(sent("judge")[2], { assets: [{ label: "hero", asset_id: "img_1" }] });
	});

	it("wraps a single result where a list of ids is declared", () => {
		assert.equal(probe.outcomes.singleton_result, "ok");
		assert.deepEqual(sent("wait_ids")[0], { ids: ["img_1"] });
	});

	it("passes a mixed list of a result and a bare id through as ids", () => {
		assert.equal(probe.outcomes.singleton_mixed, "ok");
		assert.deepEqual(sent("wait_ids")[1], { ids: ["img_1", "img_bare"] });
	});

	it("still refuses a value no adapter understands, before the network", () => {
		assert.match(probe.outcomes.singleton_unrecognised, /^ArgumentError: /);
		assert.equal(sent("wait_ids").length, 2);
	});
});
