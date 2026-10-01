/**
 * Omitted vs explicit-None optional arguments, driven in real Python against a stub.
 *
 * The client dropped every None, so a cell could not clear a nullable field: an
 * explicit `note=None` never reached the server. Now an optional parameter the cell
 * did not pass is omitted, an explicit None is sent as null where the parameter's
 * schema accepts null, and dropped where it does not — on the wrappers and the
 * generic `_client.call` alike.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { generate } from "../generate.mjs";
import { PRODUCT_PORT_OPTIONS } from "../generator-presets.mjs";
import { isNullable } from "../pythonic-args.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PROBE = join(ROOT, "bench/test/fixtures/nullable_args_probe.py");
const KERNEL_PY = join(homedir(), ".prime/agent/kernel-venv/bin/python");
const PYTHON = existsSync(KERNEL_PY) ? KERNEL_PY : "python3";

const CATALOGUE = [
	{
		server: "maker",
		tools: [
			{
				name: "gen",
				category: "session",
				description: "Generate.",
				inputSchema: {
					type: "object",
					properties: { prompt: { type: "string" }, note: { type: ["string", "null"] }, count: { type: "integer" } },
					required: ["prompt"],
				},
				outputSchema: { title: "GenOutput", type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			},
		],
	},
];

const ARMS = [
	["typed, validated, consolidated", { ...PRODUCT_PORT_OPTIONS, apiLayout: "consolidated", typedReturns: true, validateArgs: true, allowUntyped: true }, "api.session"],
	["untyped, unvalidated, per-method", { apiLayout: "per-method" }, "api.maker.gen"],
];

describe("isNullable", () => {
	it("reads a null type, a type list with null, and a null anyOf/oneOf arm", () => {
		assert.equal(isNullable({ type: ["string", "null"] }), true);
		assert.equal(isNullable({ type: "null" }), true);
		assert.equal(isNullable({ anyOf: [{ type: "string" }, { type: "null" }] }), true);
		assert.equal(isNullable({ oneOf: [{ type: "integer" }, { type: ["string", "null"] }] }), true);
		assert.equal(isNullable({ type: "string" }), false);
		assert.equal(isNullable({ anyOf: [{ type: "string" }, { type: "integer" }] }), false);
	});
});

for (const [label, options, module] of ARMS) {
	describe(`generated client (${label}): explicit None reaches a nullable parameter`, () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-nullable-"));
		after(() => rmSync(dir, { recursive: true, force: true }));
		for (const [rel, content] of Object.entries(generate(CATALOGUE, options).files)) {
			const path = join(dir, "api", rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		const probe = JSON.parse(execFileSync(PYTHON, [PROBE, dir, module], { encoding: "utf8" }).trim().split("\n").at(-1));

		it("every call succeeds", () => {
			for (const [name, outcome] of Object.entries(probe.outcomes)) assert.equal(outcome, "ok", name);
		});

		it("sends an explicit None for a nullable parameter and drops it for a non-nullable one", () => {
			assert.deepEqual(probe.sent[0], { prompt: "a", note: null });
		});

		it("omits an optional parameter the cell did not pass", () => {
			assert.deepEqual(probe.sent[1], { prompt: "b" });
		});

		it("applies the same rule to a generic call's dict", () => {
			assert.deepEqual(probe.sent[2], { prompt: "c", note: null });
			assert.deepEqual(probe.sent[3], { prompt: "d" });
		});

		it("still reads `= None` in the signature", () => {
			assert.match(probe.signature, /^\(prompt: str, note: str \| None = None, count: int \| None = None\)/);
		});
	});
}
