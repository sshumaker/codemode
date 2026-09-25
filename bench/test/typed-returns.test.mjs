/**
 * Typed results, compiled from each tool's `outputSchema` (bench/output-types.mjs).
 *
 * MEASURED PROVENANCE. `call()` returned `body["text"]` — a raw JSON string — and
 * every wrapper was annotated `-> Any`. Nothing in the tree said what a creative
 * action gives back, so the only way to learn the id lives at
 * `result["assets"]["image"][0]` was to run the call, print it, and read the id
 * off the output. Across a 40-round arm that is exactly what happened: **59 of 59
 * creative-action cells passed hand-copied string literals and 0 passed a prior
 * return value programmatically**, and a median of 8 cells per round existed only
 * to carry a value across a turn boundary the kernel already held in a variable.
 *
 * The first fix (H56) promised `CreativeResult` from a corpus map and a name-prefix
 * rule — derived from runs, not from the tools, and never measured. W128 replaced
 * both: the product declares an output_model on every ToolDef and publishes it as
 * MCP `outputSchema`; this generator compiles THAT and nothing else.
 *
 * Grouped by the ways this could be wrong: the class could disagree with the schema,
 * the affordance could be undiscoverable (coercion works but the hint denies it),
 * an untyped catalogue could stop rendering the tree earlier benchmarks measured, or
 * a product catalogue missing a schema could slip through the build.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { generate, returnType } from "../generate.mjs";
import { collectOutputTypes, outputClassName, renderOutputTypes, untypedTools, UNTYPED_RESULT } from "../output-types.mjs";

// The kernel's interpreter when it is on this machine: Python 3.11 evaluates
// annotations at def time, 3.14 defers them, and a NameError in a hint is exactly
// the class of bug a system-python run hides.
const KERNEL_PY = join(homedir(), ".prime/agent/kernel-venv/bin/python");
const PYTHON = existsSync(KERNEL_PY) ? KERNEL_PY : "python3";

/** pydantic's rendering of a creative-action output model (the product port's catalogue shape). */
const CREATIVE = {
	$defs: {
		RetryReplaceResult: {
			additionalProperties: false,
			properties: {
				status: { type: "string" },
				target_id: { type: "string", format: "asset-ref" },
				new_artifact_id: { type: "string", format: "asset-ref" },
				error: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
			},
			required: ["status", "target_id", "new_artifact_id"],
			title: "RetryReplaceResult",
			type: "object",
		},
	},
	additionalProperties: false,
	description: "What execute_creative_tool returns when the action was scheduled.",
	properties: {
		tool_id: { type: "string" },
		assets: { type: "object", additionalProperties: { type: "array", items: { type: "string", format: "asset-ref" } } },
		note: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
		parent_group_id: { anyOf: [{ type: "string", format: "shape-ref" }, { type: "null" }], default: null },
		estimated_credits: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
		retry_replace: { anyOf: [{ $ref: "#/$defs/RetryReplaceResult" }, { type: "null" }], default: null },
	},
	required: ["tool_id"],
	title: "CreativeActionOutput",
	type: "object",
};

const WAIT = {
	title: "WaitForAssetsOutput",
	type: "object",
	additionalProperties: false,
	required: ["completed", "results"],
	properties: {
		completed: { type: "boolean" },
		results: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["asset_id", "state"],
				properties: { asset_id: { type: "string", format: "asset-ref" }, state: { type: "string" } },
			},
		},
	},
};

const JUDGE = {
	title: "JudgeOutput",
	type: "object",
	additionalProperties: false,
	required: ["verdict"],
	properties: { verdict: { type: "string", enum: ["pass", "fail"] }, notes: { type: "array", items: { type: "string" } } },
};

/** A union: one tool, several closed record shapes. */
const READ_UNION = {
	title: "ReadOutput",
	description: "One of: ArtifactReadOutput, WorkspaceReadOutput.",
	anyOf: [
		{ title: "ArtifactReadOutput", type: "object", additionalProperties: false, required: ["asset_id"], properties: { asset_id: { type: "string", format: "asset-ref" }, asset: { type: "object", additionalProperties: true } } },
		{ title: "WorkspaceReadOutput", type: "object", additionalProperties: false, required: ["ref", "text"], properties: { ref: { type: "string" }, text: { type: "string" } } },
	],
};

const tool = (name, props, required, outputSchema) => ({
	name,
	description: `${name}.`,
	inputSchema: { type: "object", properties: props, required },
	...(outputSchema ? { outputSchema } : {}),
});

const TYPED = [
	{
		server: "acts",
		tools: [
			tool("create_image_x", { prompt: { type: "string" }, references: { type: "array", items: { type: "string" } } }, ["prompt"], CREATIVE),
			tool("modify_image_y", { prompt: { type: "string" } }, ["prompt"], CREATIVE),
			tool("wait_for_assets", { ids: { type: "array", items: { type: "string" } } }, ["ids"], WAIT),
			tool(
				"judge_tool",
				{ query: { type: "string" }, assets: { type: "array", items: { type: "object", properties: { asset_id: { type: "string" } } } } },
				["query", "assets"],
				JUDGE,
			),
			tool("read", { ref: { type: "string" } }, ["ref"], READ_UNION),
		],
	},
];
/** The same catalogue with every outputSchema stripped: what every pre-W128 dump looked like. */
const UNTYPED = TYPED.map((s) => ({ ...s, tools: s.tools.map(({ outputSchema, ...t }) => t) }));

const tree = (cat, opts) => generate(cat, { apiLayout: "consolidated", ...opts }).files;
const source = (files) => Object.entries(files).filter(([p]) => p.endsWith(".py")).map(([, c]) => c).join("\n");

describe("output types are compiled from the schema", () => {
	it("one class per distinct schema, named by the schema's title", () => {
		const tools = TYPED[0].tools.map((t) => ({ ...t, pyName: t.name }));
		const { classes, byTool } = collectOutputTypes(tools);
		assert.equal(byTool.get("create_image_x"), "CreativeActionOutput");
		assert.equal(byTool.get("modify_image_y"), "CreativeActionOutput", "two tools with one schema must share one class");
		assert.equal(byTool.get("wait_for_assets"), "WaitForAssetsOutput");
		assert.equal(byTool.get("judge_tool"), "JudgeOutput");
		// $defs and inline object items become classes too.
		assert.deepEqual([...classes.keys()].sort(), ["ArtifactReadOutput", "CreativeActionOutput", "JudgeOutput", "ReadOutput", "RetryReplaceResult", "WaitForAssetsOutput", "WaitForAssetsOutputResultsItem", "WorkspaceReadOutput"]);
		assert.equal(byTool.get("read"), "ReadOutput");
		assert.equal(outputClassName({ name: "x", pyName: "x" }), UNTYPED_RESULT);
	});

	it("the wrapper's annotation, docstring and _expect all come from the same class", () => {
		const src = source(tree(TYPED));
		assert.match(src, /async def create_image_x\([^)]*\) -> CreativeActionOutput:/);
		assert.match(src, /async def wait_for_assets\([^)]*\) -> WaitForAssetsOutput:/);
		assert.match(src, /async def judge_tool\([^)]*\) -> JudgeOutput:/);
		assert.match(src, /async def read\([^)]*\) -> ReadOutput:/);
		assert.match(src, /ReadOutput — one of ArtifactReadOutput, WorkspaceReadOutput/);
		assert.match(src, /_expect="CreativeActionOutput"/);
		assert.match(src, /Returns:\n\s+CreativeActionOutput with tool_id, assets, note, parent_group_id, estimated_credits, retry_replace\./);
		assert.match(src, /Carries asset refs: pass it straight back/);
		assert.doesNotMatch(src, /^async def .*-> Any:/m, "no wrapper may keep the untyped Any");
		assert.doesNotMatch(src, /^async def .*-> str:/m, "no wrapper may return a bare string");
	});

	it("returnType never guesses from a name", () => {
		assert.equal(returnType("create_image_anything"), UNTYPED_RESULT);
		assert.equal(returnType("wait_for_anything"), UNTYPED_RESULT);
		const types = collectOutputTypes(TYPED[0].tools.map((t) => ({ ...t, pyName: t.name })));
		assert.equal(returnType("create_image_x", types), "CreativeActionOutput");
	});

	it("asset parameters ADVERTISE what the client accepts, extending the declared type", () => {
		const src = source(tree(TYPED));
		assert.match(src, /references: list\[str \| AssetLike\][^,)]*\| AssetLike/);
		assert.match(src, /ids: list\[str \| AssetLike\][^,)]*\| AssetLike/);
		// Regression guard: judge_tool's `list[dict...]` must SURVIVE the widening.
		const line = src.split("\n").find((l) => l.startsWith("async def judge_tool("));
		assert.ok(line.includes("list[dict"), `the dict form was dropped: ${line}`);
		assert.ok(line.includes("AssetLike"), `the asset form was not added: ${line}`);
	});

	it("coerces BEFORE validating, so a result object at a string parameter is legal", () => {
		const client = tree(TYPED, { validateArgs: true })["_client.py"];
		const coerce = client.indexOf("sent = _asset_ids(");
		const validate = client.indexOf("_validate(server, tool, sent)");
		assert.ok(coerce > 0 && coerce < validate, "validation must run on the coerced arguments");
	});
});

describe("an untyped catalogue renders the tree every earlier benchmark measured", () => {
	it("auto mode is off when no tool publishes a schema, and off is byte-identical to typedReturns:false", () => {
		const auto = tree(UNTYPED);
		const off = tree(UNTYPED, { typedReturns: false });
		assert.equal(JSON.stringify(auto), JSON.stringify(off));
		assert.ok(!("_types.py" in auto));
		assert.match(source(auto), /^async def .*-> Any:/m);
	});

	it("forcing typed on an untyped catalogue returns the untyped base, never a string", () => {
		const src = source(tree(UNTYPED, { typedReturns: true }));
		assert.match(src, /^async def .*-> ToolResult:/m);
		assert.doesNotMatch(src, /^async def .*-> Any:/m);
		assert.deepEqual(untypedTools(UNTYPED[0].tools.map((t) => ({ ...t, pyName: t.name }))), UNTYPED[0].tools.map((t) => t.name));
	});

	it("a MIXED catalogue is refused when the caller requires schemas", () => {
		const mixed = [{ server: "acts", tools: [TYPED[0].tools[0], UNTYPED[0].tools[1]] }];
		assert.throws(() => generate(mixed, { allowUntyped: false }), /1 tool\(s\) publish no outputSchema: modify_image_y/);
		// and admitted, as ToolResult, when it does not and typed mode is forced
		// (auto stays untyped for a catalogue that is not fully typed)
		assert.match(source(tree(mixed)), /^async def .*-> Any:/m);
		const src = source(tree(mixed, { typedReturns: true }));
		assert.match(src, /async def modify_image_y\([^)]*\) -> ToolResult:/);
	});
});

describe("the rendered types behave", () => {
	it("in real Python: attributes, ids, dict-style access, coercion, nested classes, fallbacks", () => {
		const dir = mkdtempSync(join(tmpdir(), "typed-"));
		try {
			for (const [rel, content] of Object.entries(tree(TYPED))) {
				const p = join(dir, "api", rel);
				mkdirSync(dirname(p), { recursive: true });
				writeFileSync(p, content);
			}
			const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(dir)})
import api._types as T
import api.acts  # annotations resolve at def time on 3.11

r = T.wrap(json.dumps({"tool_id": "create_image_x", "assets": {"image": ["image:AAA", "image:BBB"]}, "note": "n",
                       "retry_replace": {"status": "completed", "target_id": "image:old", "new_artifact_id": "image:new"}}), "CreativeActionOutput")
assert type(r).__name__ == "CreativeActionOutput", type(r)
assert r.id == "image:AAA" and r.ids == ["image:AAA", "image:BBB"] and str(r) == "image:AAA" and len(r) == 2
assert r.assets["image"][1] == "image:BBB"          # typed attribute
assert r["assets"]["image"][1] == "image:BBB"        # the dict idiom still works
assert type(r.retry_replace).__name__ == "RetryReplaceResult" and r.retry_replace.new_artifact_id == "image:new"
assert r.estimated_credits is None and r.raw["note"] == "n"
assert [a.id for a in r] == ["image:AAA", "image:BBB"]  # iterating yields Assets
assert T.asset_id({"references": [r], "ids": [T.Asset("image:z"), "plain", r], "n": 3}) == {"references": ["image:AAA"], "ids": ["image:z", "plain", "image:AAA"], "n": 3}

w = T.wrap(json.dumps({"completed": True, "results": [{"asset_id": "image:AAA", "state": "completed"}]}), "WaitForAssetsOutput")
assert bool(w) is True and w.results[0].asset_id == "image:AAA" and type(w.results[0]).__name__ == "WaitForAssetsOutputResultsItem"
assert not T.wrap(json.dumps({"completed": False, "results": []}), "WaitForAssetsOutput")
assert w.ids == [] and str(w).startswith("{")  # refs live inside nested items; the envelope itself carries none

j = T.wrap(json.dumps({"verdict": "pass", "notes": ["ok"]}), "JudgeOutput")
assert j.verdict == "pass" and j.ids == [] and json.loads(str(j)) == {"verdict": "pass", "notes": ["ok"]}, "a class without asset refs must not stringify to an id"
assert list(j.items()) == [("verdict", "pass"), ("notes", ["ok"])] and list(j.values()) == ["pass", ["ok"]]  # dict idioms
assert repr(j) == "JudgeOutput(verdict='pass', notes=['ok'])", repr(j)  # compact: only carried fields

# A result that CARRIES an asset ref but does not produce assets (a read): passable
# back as an id, but print() shows the record, not eight characters (h64, pos 3/12).
rr = T.wrap(json.dumps({"status": "completed", "target_id": "image:old", "new_artifact_id": "image:new"}), "RetryReplaceResult")
assert rr.ids == ["image:old", "image:new"] and rr.id == "image:old"
assert str(rr).startswith("{"), str(rr)
assert T.asset_id([rr]) == ["image:old"]

# a union dispatches to the variant whose key set matches; print() shows the record
a = T.wrap(json.dumps({"asset_id": "image:AAA", "asset": {"id": "AAA", "caption": "c"}}), "ReadOutput")
assert type(a).__name__ == "ArtifactReadOutput" and a.asset_id == "image:AAA" and a.ids == ["image:AAA"] and str(a).startswith("{"), (type(a), str(a))
wk = T.wrap(json.dumps({"ref": "workspace", "text": "{}"}), "ReadOutput")
assert type(wk).__name__ == "WorkspaceReadOutput" and wk.text == "{}"
odd = T.wrap(json.dumps({"nothing": 1}), "ReadOutput")
assert type(odd).__name__ == "ToolResult" and odd["nothing"] == 1
assert T.asset_id({"references": [a]}) == {"references": ["image:AAA"]}

u = T.wrap("plain text, not json", "CreativeActionOutput")
assert type(u).__name__ == "ToolResult" and str(u) == "plain text, not json"
unknown = T.wrap(json.dumps({"k": 1}), None)
assert type(unknown).__name__ == "ToolResult" and unknown["k"] == 1 and json.loads(str(unknown)) == {"k": 1}
print("ok")
`;
			const out = execFileSync(PYTHON, ["-c", script], { encoding: "utf8" });
			assert.equal(out.trim(), "ok");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("_types.py is valid Python for a schema with no fields and for reserved-word fields", () => {
		const odd = [{ server: "s", tools: [tool("empty", {}, [], { title: "EmptyOutput", type: "object", additionalProperties: false, properties: {} }), tool("kw", {}, [], { title: "KwOutput", type: "object", additionalProperties: false, required: ["class", "raw"], properties: { class: { type: "string" }, raw: { type: "string" } } })] }];
		const src = renderOutputTypes(collectOutputTypes(odd[0].tools.map((t) => ({ ...t, pyName: t.name }))));
		const dir = mkdtempSync(join(tmpdir(), "typed-odd-"));
		try {
			writeFileSync(join(dir, "_t.py"), src);
			execFileSync(PYTHON, ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(dir)}); import _t, json; k = _t.wrap(json.dumps({"class": "a", "raw": "b"}), "KwOutput"); assert k.class_ == "a" and k.raw_ == "b" and k.raw == {"class": "a", "raw": "b"}; _t.wrap("{}", "EmptyOutput")`], { encoding: "utf8" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("a catalogue this project does not own never throws", () => {
	it("allowUntyped defaults true: a mixed catalogue renders, the untyped tool returns the base", () => {
		const mixed = [{ server: "acts", tools: [TYPED[0].tools[0], { ...TYPED[0].tools[1], outputSchema: undefined }] }];
		const files = generate(mixed, { typedReturns: true }).files;
		assert.match(Object.values(files).join("\n"), /-> ToolResult:/);
		assert.doesNotThrow(() => generate(mixed));
	});
});

describe("ref formats are the catalogue's, not the generator's", () => {
	// A product spells its asset refs its own way. Relabel the fixture's formats and
	// pass the mapping: the compiled classes must be the same, byte for byte.
	const relabel = (node) =>
		JSON.parse(JSON.stringify(node).replace(/"(asset|shape|job)-ref"/g, '"acme-$1-ref"'));
	const acme = relabel(TYPED);
	const formats = { asset: "acme-asset-ref", shape: "acme-shape-ref", job: "acme-job-ref" };

	it("renders the same types with the mapping as the defaults do on neutral formats", () => {
		const neutral = generate(TYPED, { typedReturns: true }).files["_types.py"];
		assert.equal(generate(acme, { typedReturns: true, refFormats: formats }).files["_types.py"], neutral);
	});

	it("without the mapping, an unknown format is just a string", () => {
		const types = collectOutputTypes(acme[0].tools.map((t) => ({ ...t, pyName: t.name })));
		for (const entry of types.classes.values()) for (const f of entry.fields) assert.equal(f.ref, null, `${entry.name}.${f.pyName}`);
	});
});
