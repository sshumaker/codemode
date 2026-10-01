/**
 * Pythonic argument shapes: the adapter, the examples, and the trimmed traceback.
 *
 * The measurement these pin, in full in the header of `bench/pythonic-args.mjs`:
 * on GLM 5.2 (product port, Decomposed bank, n=5) **12 of 83 cells ended in a
 * client-side ArgumentError and every one was a nested literal the model had to
 * hand-build**. Flat arguments never failed. So the bridge accepts the flat
 * shapes it can accept deterministically, and shows a literal example of the ones
 * it cannot.
 *
 * Per "a documented check is not an executed check", the properties asserted here
 * are observable ones:
 *
 *   - the OLD FAILING SHAPES from the traces are replayed against a real
 *     generated tree in a real Python process: a bare id list to `judge_tool`
 *     must now SUCCEED via coercion, and a list to `complete_job.final_outputs`
 *     must still FAIL — with the example in the message,
 *   - every example this compiler emits is checked against its own schema by the
 *     generated validator's `_check`, over every catalogue in the repo. An
 *     example the validator would reject teaches a shape that does not work,
 *   - a catalogue with nothing to adapt renders the tree it always rendered,
 *     byte for byte,
 *   - the traceback trimmer runs on tracebacks captured verbatim from the same
 *     IPython the kernel runs.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { generate, normalizeTool, pyCallSignature, renderFullDocs, adapterNote, exampleNote } from "../generate.mjs";
import { loadTasks, requireTaskSet } from "../tasks.mjs";
import {
	isNestedShape,
	labeledIdAdapter,
	singletonAdapter,
	mineExample,
	paramExample,
	pyRepr,
	singular,
	synthesizeExample,
} from "../pythonic-args.mjs";
import { adversarial, constrained, realistic, wide } from "./fixtures/catalogue.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PROBE = join(ROOT, "bench/test/fixtures/pythonic_args_probe.py");

/** The two shapes from the traces, as an MCP catalogue. */
const PRODUCT = [
	{
		server: "agent_tools",
		tools: [
			{
				name: "judge_tool",
				description: "Judge/evaluate VISUAL and AUDIO assets on the canvas.",
				inputSchema: {
					type: "object",
					properties: {
						query: { type: "string", description: "Detailed question or evaluation criteria." },
						assets: {
							type: "array",
							minItems: 1,
							description: "Array of labeled artifacts for evaluation.",
							items: {
								type: "object",
								properties: { label: { type: "string" }, asset_id: { type: "string" } },
								required: ["label", "asset_id"],
							},
						},
					},
					required: ["query", "assets"],
				},
			},
			{
				name: "complete_job",
				description: "Mark the current job as completed or failed.",
				inputSchema: {
					type: "object",
					properties: {
						state: { type: "string", enum: ["completed", "failed"] },
						summary: { type: "string" },
						final_outputs: {
							type: "object",
							description:
								"Final artifacts created, organized by type. Example: {'image': ['uuid1', 'uuid2'], 'video': ['uuid3']}",
							additionalProperties: { type: "array", items: { type: "string" } },
						},
					},
					required: ["state", "summary"],
				},
			},
			{
				name: "todo_write",
				description: "Create and manage a structured task list.",
				inputSchema: {
					type: "object",
					properties: {
						merge: { type: "boolean", default: false },
						todos: {
							type: "array",
							minItems: 2,
							items: {
								type: "object",
								properties: {
									id: { type: "string" },
									content: { type: "string" },
									status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
								},
								required: ["id", "content", "status"],
							},
						},
					},
					required: ["merge", "todos"],
				},
			},
			{
				name: "wait_for_assets",
				description: "Wait until assets become ready.",
				inputSchema: {
					type: "object",
					properties: { ids: { type: "array", minItems: 1, items: { type: "string" } } },
					required: ["ids"],
				},
			},
		],
	},
];

const param = (tool, name) => normalizeTool(tool).params.find((p) => p.name === name);
const judgeAssets = () => param(PRODUCT[0].tools[0], "assets");

describe("the T1 adapter fires on a schema shape, not on a name", () => {
	const array = (items, extra = {}) => ({ type: "array", items, ...extra });
	const twoField = (a, b) => ({
		type: "object",
		properties: { [a]: { type: "string" }, [b]: { type: "string" } },
		required: [a, b],
	});

	it("recognises label+id, however the two are spelled", () => {
		for (const [labelKey, idKey] of [
			["label", "asset_id"],
			["name", "id"],
			["title", "uuid"],
			["caption", "image_id"],
			["key", "video_uuid"],
		]) {
			const found = labeledIdAdapter(array(twoField(labelKey, idKey)), "things");
			assert.ok(found, `${labelKey}/${idKey} was not recognised`);
			assert.equal(found.labelKey, labelKey);
			assert.equal(found.idKey, idKey);
		}
	});

	it("names generated labels after the id, not after the tool", () => {
		// `asset_id` -> `asset_1`: the stem comes from the schema, so a server whose
		// parameter is called `items` of `{name, video_id}` gets `video_1`.
		assert.equal(labeledIdAdapter(array(twoField("label", "asset_id")), "assets").stem, "asset");
		assert.equal(labeledIdAdapter(array(twoField("name", "video_id")), "items").stem, "video");
		// A bare `id` carries no stem of its own, so the parameter name is used —
		// and `_1` alone would name nothing.
		assert.equal(labeledIdAdapter(array(twoField("name", "id")), "clips").stem, "clip");
		assert.equal(labeledIdAdapter(array(twoField("name", "id")), "").stem, "item");
	});

	it("declines a third required property, so a coerced object is never incomplete", () => {
		// todo_write's `todos` requires id+content+status. Coercing `['a', 'b']`
		// there would produce objects missing `content`, i.e. the adapter itself
		// would generate a call the validator rejects.
		assert.equal(param(PRODUCT[0].tools[2], "todos").adapter, null);
	});

	it("declines when the label is constrained, since the label is generated", () => {
		for (const constraint of [
			{ enum: ["a", "b"] },
			{ const: "a" },
			{ pattern: "^x" },
			{ format: "email" },
			{ maxLength: 4 },
			{ minLength: 40 },
		]) {
			const items = twoField("label", "asset_id");
			items.properties.label = { type: "string", ...constraint };
			assert.equal(
				labeledIdAdapter(array(items), "assets"),
				null,
				`adapted despite ${JSON.stringify(constraint)} on the generated label`,
			);
		}
	});

	it("declines everything that is not this shape", () => {
		assert.equal(labeledIdAdapter({ type: "array", items: { type: "string" } }, "ids"), null);
		assert.equal(labeledIdAdapter({ type: "object" }, "x"), null);
		// Two labels and no id, two ids and no label, and non-string fields.
		assert.equal(labeledIdAdapter(array(twoField("label", "name")), "x"), null);
		assert.equal(labeledIdAdapter(array(twoField("id", "asset_id")), "x"), null);
		const numeric = twoField("label", "asset_id");
		numeric.properties.asset_id = { type: "integer" };
		assert.equal(labeledIdAdapter(array(numeric), "x"), null);
		// An object with the right properties but nothing required: there is no
		// declared shape to coerce TO.
		assert.equal(labeledIdAdapter(array({ ...twoField("label", "id"), required: [] }), "x"), null);
	});

	it("allows optional extra properties, because coercion omitting them is legal", () => {
		const items = twoField("label", "asset_id");
		items.properties.weight = { type: "number" };
		assert.ok(labeledIdAdapter(array(items), "assets"));
	});
});

describe("the T2 adapter wraps a lone scalar, and declines what it must", () => {
	const array = (items, extra = {}) => ({ type: "array", items, ...extra });

	it("fires on an array of scalars, naming the item type", () => {
		assert.deepEqual(singletonAdapter(array({ type: "string" }), "images"), { kind: "singleton", itemType: "string" });
		assert.deepEqual(singletonAdapter(array({ type: "number" }), "numbers"), { kind: "singleton", itemType: "number" });
		assert.deepEqual(singletonAdapter(array({ type: "integer" }), "ids"), { kind: "singleton", itemType: "integer" });
		// minItems 1 is the common spelling of "at least one" and must still adapt.
		assert.ok(singletonAdapter(array({ type: "string" }, { minItems: 1 }), "ids"));
	});

	it("declines an array of objects — the todos case, argued and now pinned", () => {
		// Wrapping there would emit an object missing `content` and `status`, i.e. the
		// adapter itself would produce a call the validator rejects.
		assert.equal(singletonAdapter(array({ type: "object", properties: { a: {} } }), "todos"), null);
		assert.equal(param(PRODUCT[0].tools[2], "todos").adapter, null);
	});

	it("declines minItems > 1, where one item is a real mistake", () => {
		assert.equal(singletonAdapter(array({ type: "string" }, { minItems: 2 }), "ids"), null);
		assert.equal(singletonAdapter(array({ type: "string" }, { maxItems: 0 }), "ids"), null);
	});

	it("declines a parameter that already accepts the bare scalar", () => {
		// A `["array", "string"]` union or an anyOf with a scalar branch is legal as
		// passed, and wrapping would change what the server receives for an input
		// that needed no help.
		assert.equal(singletonAdapter({ type: ["array", "string"], items: { type: "string" } }, "q"), null);
		assert.equal(singletonAdapter({ type: "array", items: { type: "string" }, anyOf: [{ type: "string" }] }, "q"), null);
	});

	it("declines booleans, which Python's int subclassing makes ambiguous", () => {
		assert.equal(singletonAdapter(array({ type: "boolean" }), "flags"), null);
	});

	it("widens the signature by exactly the one shape it accepts", () => {
		const p = param(PRODUCT[0].tools[3], "ids");
		assert.equal(p.type, "list[str] | str");
		assert.equal(adapterNote(p), "Also accepts a single str, wrapped as a one-item list.");
		const module = generate(PRODUCT, { validateArgs: true }).files["agent_tools/wait_for_assets.py"];
		assert.match(module, /from \.\._client import call as _call, as_list as _as_list/);
		assert.match(module, /^    ids = _as_list\(ids, "string"\)$/m);
	});

	it("does not claim a nested example, since a scalar array is not nested", () => {
		// The INDEX one-liner stays `wait_for_assets(ids)`: a flat list needs no
		// example, and the note lives in the docstring where it costs one line once.
		assert.equal(exampleNote(param(PRODUCT[0].tools[3], "ids")), null);
		assert.match(generate(PRODUCT).files["agent_tools/INDEX.md"], /wait_for_assets\(ids\)`/);
	});
});

describe("the widened signature", () => {
	const { files } = generate(PRODUCT, { validateArgs: true });
	const module = files["agent_tools/judge_tool.py"];

	it("keeps the declared shape first and adds the two accepted alternatives", () => {
		assert.equal(judgeAssets().type, "list[dict[str, str]] | list[str] | dict[str, str]");
		assert.match(module, /assets: list\[dict\[str, str\]\] \| list\[str\] \| dict\[str, str\]/);
	});

	it("recovers the item shape the old `list[dict]` erased", () => {
		// pyType renders an object-with-properties as bare `dict`, so the parameter
		// the model was getting wrong was also the one the signature said least
		// about. Every property here is a string, which is what licenses `[str, str]`.
		assert.equal(param(PRODUCT[0].tools[0], "assets").type.startsWith("list[dict[str, str]]"), true);
	});

	it("documents the generated labels, which a type cannot express", () => {
		const note = adapterNote(judgeAssets());
		assert.match(note, /plain list of asset_id strings/);
		assert.match(note, /'asset_1', 'asset_2'/);
		assert.match(note, /\{label: asset_id\} dict/);
		assert.match(module, /Also accepts a plain list of asset_id strings/);
	});

	it("coerces at the top of the wrapper, before the value is validated or sent", () => {
		const coerce = module.indexOf('assets = _labeled_ids(assets, "label", "asset_id", "asset")');
		const call = module.indexOf("return await _call(");
		assert.ok(coerce > 0, "the coercion line was not rendered");
		assert.ok(coerce < call, "the argument is sent before it is coerced");
		// Imported only by modules that use it.
		assert.match(module, /from \.\._client import call as _call, labeled_ids as _labeled_ids/);
		assert.match(files["agent_tools/complete_job.py"], /from \.\._client import call as _call, UNSET as _UNSET\n/);
	});

	it("renders the helper into _client only for a catalogue that has something to adapt", () => {
		assert.match(files["_client.py"], /^def labeled_ids\(/m);
		assert.equal(/labeled_ids/.test(generate(realistic, { validateArgs: true }).files["_client.py"]), false);
	});

	it("carries the coercion into the consolidated layout too", () => {
		const app = generate(PRODUCT, { apiLayout: "consolidated" }).files["agent_tools.py"];
		assert.match(app, /from \._client import call as _call, UNSET as _UNSET, labeled_ids as _labeled_ids/);
		assert.match(app, /assets = _labeled_ids\(assets, "label", "asset_id", "asset"\)/);
	});
});

describe("example literals", () => {
	it("prefers the schema author's own example over a synthesized one", () => {
		// `complete_job.final_outputs` buckets ids by asset type, and only the server
		// knows an asset's type — so no synthesizer can produce `'image'`. Its own
		// description can.
		assert.equal(
			param(PRODUCT[0].tools[1], "final_outputs").example,
			"{'image': ['uuid1', 'uuid2'], 'video': ['uuid3']}",
		);
	});

	it("mines only a literal that is balanced, parseable and shaped like the schema", () => {
		const map = { type: "object", additionalProperties: { type: "array", items: { type: "string" } } };
		assert.equal(mineExample("e.g. {'image': ['a']}", map), "{'image': ['a']}");
		// A description whose example illustrates something else — the containing
		// object, a sibling parameter — must not be adopted as this parameter's.
		assert.equal(mineExample("Example: ['a', 'b']", map), null);
		assert.equal(mineExample("Example: {'image': 'a'}", map), null);
		// Unbalanced, unparseable, and unmarked all decline.
		assert.equal(mineExample("Example: {'image': ['a'", map), null);
		assert.equal(mineExample("Example: {image: [a]}", map), null);
		assert.equal(mineExample("Pass {'image': ['a']} here", map), null);
	});

	it("synthesizes a literal that satisfies the schema's own constraints", () => {
		// minItems is why todo_write's example shows two todos and judge_tool's one:
		// the example has to be a value the validator would accept.
		assert.match(param(PRODUCT[0].tools[2], "todos").example, /^\[\{'id': 'id1'.*\}, \{'id': 'id2'.*\}\]$/);
		assert.equal(param(PRODUCT[0].tools[0], "assets").example, "[{'label': '<label>', 'asset_id': 'id1'}]");
		// An enum leaf uses a real member rather than a placeholder.
		assert.match(param(PRODUCT[0].tools[2], "todos").example, /'status': 'pending'/);
	});

	it("leaves the map key a placeholder, because the keys are the caller's", () => {
		const map = { type: "object", additionalProperties: { type: "array", items: { type: "string" } } };
		assert.equal(synthesizeExample(map, "final_outputs"), "{'<key>': ['<final_output>']}");
	});

	it("declines to fabricate a leaf it cannot satisfy", () => {
		// A `pattern` this file cannot solve, and a `format` the validator itself
		// declines to enforce: an example that would be rejected is worse than none.
		assert.equal(synthesizeExample({ type: "array", items: { type: "string", pattern: "^[A-Z]{3}-\\d+$" } }, "codes"), null);
		assert.equal(synthesizeExample({ type: "array", items: { type: "string", format: "date-time" } }, "times"), null);
		// A bare object says nothing about its contents, so there is nothing to show.
		assert.equal(synthesizeExample({ type: "object" }, "filters"), null);
		assert.equal(synthesizeExample({ type: "object", additionalProperties: true }, "filters"), null);
	});

	it("is emitted for containers and never for scalars", () => {
		const p = normalizeTool(PRODUCT[0].tools[0]).params;
		assert.equal(p.find((x) => x.name === "query").example, null);
		assert.ok(p.find((x) => x.name === "assets").example);
	});

	it("distinguishes a nested shape from a flat list, which is where it is shown", () => {
		// The measured signal: `wait_for_assets(ids=[...])` never failed and gets no
		// INDEX example; `[{label, asset_id}]` and `dict[str, list[str]]` did.
		assert.equal(isNestedShape({ type: "array", items: { type: "string" } }), false);
		assert.equal(isNestedShape({ type: "array", items: { type: "object", properties: { a: {} } } }), true);
		assert.equal(isNestedShape({ type: "object", additionalProperties: { type: "array" } }), true);
		assert.equal(isNestedShape({ type: "string" }), false);
		// A flat list still gets an example for the ERROR channel, just not for the
		// INDEX line — passing a bare string where a list is wanted is a real mistake.
		assert.equal(param(PRODUCT[0].tools[3], "ids").example, "['id1', 'id2']");
		assert.equal(exampleNote(param(PRODUCT[0].tools[3], "ids")), null);
	});

	it("renders Python, not JSON", () => {
		assert.equal(pyRepr({ a: [true, false, null, 1.5] }), "{'a': [True, False, None, 1.5]}");
		assert.equal(pyRepr("it's"), "'it\\'s'");
	});

	it("singularizes without inventing words", () => {
		assert.equal(singular("email_addresses"), "email_address");
		assert.equal(singular("categories"), "category");
		assert.equal(singular("assets"), "asset");
		assert.equal(singular("status"), "status");
	});
});

describe("the INDEX one-liner the model writes calls from", () => {
	const lines = generate(PRODUCT, { validateArgs: true }).files["agent_tools/INDEX.md"];

	it("shows an inline example for every nested parameter", () => {
		assert.match(lines, /judge_tool\(query, assets=\[\{'label': '<label>', 'asset_id': 'id1'\}\]\)/);
		assert.match(
			lines,
			/complete_job\(state, summary, final_outputs\?=\{'image': \['uuid1', 'uuid2'\], 'video': \['uuid3'\]\}\)/,
		);
	});

	it("leaves flat parameters exactly as they were", () => {
		assert.match(lines, /- `api\.agent_tools\.wait_for_assets\(ids\)`/);
	});

	it("keeps the optional marker, so an example is not read as a default", () => {
		const tool = normalizeTool(PRODUCT[0].tools[1]);
		assert.match(pyCallSignature(tool, "agent_tools"), /summary, final_outputs\?=\{/);
	});

	it("is the same string the docstring and the error table carry", () => {
		// Single-authored: three spellings of one parameter's shape is the drift that
		// makes a correction untrustworthy the first time one of them is edited.
		const example = param(PRODUCT[0].tools[1], "final_outputs").example;
		const table = JSON.parse(generate(PRODUCT, { validateArgs: true }).files["_schemas.json"]).examples;
		assert.equal(table.agent_tools.complete_job.final_outputs, example);
		assert.ok(lines.includes(example));
		assert.ok(generate(PRODUCT, { validateArgs: true }).files["agent_tools/complete_job.py"].includes(example));
	});
});

describe("what the adapters do NOT touch", () => {
	/** A catalogue whose every parameter is a scalar or an unconstrained object. */
	const PLAIN = [
		{
			server: "plain",
			tools: [
				{
					name: "search",
					description: "Search.",
					inputSchema: {
						type: "object",
						properties: {
							query: { type: "string" },
							limit: { type: "integer" },
							verified: { type: "boolean" },
							filters: { type: "object" },
						},
						required: ["query"],
					},
				},
			],
		},
	];

	it("a catalogue with no adaptable shape renders no adapter code anywhere", () => {
		// The invariant that survives T2: an adapter is a property of the SCHEMA, so a
		// catalogue offering nothing to adapt must get the tree it always got — no
		// helper in `_client`, no coercion line, no widened signature, no note.
		for (const opts of [{}, { validateArgs: true }, { apiLayout: "consolidated" }]) {
			const { files } = generate(PLAIN, opts);
			for (const [path, content] of Object.entries(files)) {
				if (!path.endsWith(".py") && !path.endsWith(".md")) continue;
				assert.equal(/labeled_ids|as_list/.test(content), false, `${path} carries adapter code`);
				assert.equal(/Also accepts /.test(content), false, `${path} carries an adapter note`);
			}
		}
	});

	it("only the helpers a catalogue needs are rendered into _client", () => {
		// Three catalogues, three answers: neither helper, one, or both. An unused
		// function in the tree is one more hit in the agent's `grep -ril`.
		const has = (catalogue) => {
			const client = generate(catalogue, { validateArgs: true }).files["_client.py"];
			return ["labeled_ids", "as_list"].filter((h) => new RegExp(`^def ${h}\\(`, "m").test(client));
		};
		assert.deepEqual(has(PLAIN), []);
		assert.deepEqual(has([{ server: "s", tools: [PRODUCT[0].tools[3]] }]), ["as_list"]); // wait_for_assets.ids
		assert.deepEqual(has(PRODUCT), ["labeled_ids", "as_list"]);
	});

	it("AppWorld's blast radius is 23 parameters, all of them scalar-array widenings", () => {
		// A NUMBER, deliberately. AppWorld is the catalogue the residency 2x2 was
		// measured on, and T2 does change its tree — 23 of 1,544 parameters gain a
		// widened type, a one-line note and a coercion line. Pinning the count is how
		// a future rule change that suddenly adapts 200 parameters gets noticed
		// instead of quietly moving every baseline's tree.
		const catalogue = JSON.parse(readFileSync(join(ROOT, "bench/data/appworld-schemas.json"), "utf8")).catalogue;
		const { normalized, files } = generate(catalogue);
		const adapted = normalized.flatMap(({ tools }) => tools.flatMap((t) => t.params.filter((p) => p.adapter)));
		assert.equal(adapted.length, 23, `AppWorld adapts ${adapted.length} parameters`);
		assert.deepEqual([...new Set(adapted.map((p) => p.adapter.kind))], ["singleton"], "a labeled-id adapter appeared");
		// And nothing nested, so no example reaches any AppWorld container: the
		// INDEX one-liners and the L4 docs carry no `Example:` line at all.
		for (const [path, content] of Object.entries(files)) {
			assert.equal(/^\s*Example: \w+=/m.test(content), false, `${path} grew an example`);
		}
		const coercions = Object.values(files).join("\n").match(/= _as_list\(/g) ?? [];
		assert.equal(coercions.length, 23, `${coercions.length} coercion lines for 23 adapted parameters`);
	});

	it("the L4 render of AppWorld's catalogue gains only the adapter notes", () => {
		// Asserted on the RENDER, not the tree: `renderFullDocs` goes into the prompt.
		const catalogue = JSON.parse(readFileSync(join(ROOT, "bench/data/appworld-schemas.json"), "utf8")).catalogue;
		const { normalized } = generate(catalogue);
		const docs = normalized.map(({ server, tools }) => renderFullDocs(tools, { server })).join("\n");
		assert.ok(docs.length > 100_000, `AppWorld L4 docs are only ${docs.length} chars`);
		assert.equal(/^\s*Example: \w+=/m.test(docs), false, "an example leaked into AppWorld's L4 docs");
		assert.equal((docs.match(/^\s*Also accepts /gm) ?? []).length, 23, "the note count moved");
		// The figure docs/BENCHMARK-SELECTION.md §10 quotes as the provenance delta
		// for the published 2x2 numbers: 1,453 added characters against 210,043, i.e.
		// 0.69%. Pinned here so the doc cannot rot into a number nobody rechecked —
		// the same reason the parameter count above is a literal and not "few".
		const notes = normalized.flatMap(({ tools }) => tools.flatMap((t) => t.params.filter((p) => p.adapter)));
		const added = notes.reduce((n, p) => n + adapterNote(p).length + 9, 0);
		assert.equal(added, 1_453, `the L4 delta is now ${added} chars, not the 1,453 the doc quotes`);
		assert.equal(docs.length, 210_043, `the L4 render is now ${docs.length} chars, not the 210,043 the doc quotes`);
	});
});

describe("the old failing shapes, replayed through a real generated tree", () => {
	const dirs = [];
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	it("a bare id list now succeeds, a list for a map still fails with the example", () => {
		// The mutation test the adapter exists to pass, run in Python against a stub
		// proxy: the exact arguments from the GLM traces, one of which must now reach
		// the transport in the strict shape and one of which must not reach it at all.
		const dir = mkdtempSync(join(tmpdir(), "harness-pythonic-"));
		dirs.push(dir);
		for (const [rel, content] of Object.entries(generate(PRODUCT, { validateArgs: true }).files)) {
			const path = join(dir, "api", rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		assert.match(execFileSync("python3", [PROBE, dir], { encoding: "utf8", stdio: "pipe" }), /^OK$/m);
	});

	it("every example this compiler emits is accepted by the validator it ships with", () => {
		// An example the validator would reject teaches a shape that does not work.
		// Run over every catalogue in the repo, through the generated `_check` rather
		// than a JS re-implementation of it — the client is the authority.
		const dir = mkdtempSync(join(tmpdir(), "harness-examples-"));
		dirs.push(dir);
		const catalogues = [
			...PRODUCT,
			...realistic,
			...wide,
			...adversarial,
			...constrained,
			...JSON.parse(readFileSync(join(ROOT, "bench/data/appworld-schemas.json"), "utf8")).catalogue,
			...(JSON.parse(readFileSync(join(ROOT, "bench/data/mcp-schemas.json"), "utf8")).catalogue ?? []),
		];
		for (const [rel, content] of Object.entries(generate(catalogues, { validateArgs: true }).files)) {
			if (rel.endsWith(".md")) continue;
			const path = join(dir, "api", rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		const script = [
			"import ast, json, sys",
			`sys.path.insert(0, ${JSON.stringify(dir)})`,
			"import api._client as c",
			"table = json.load(open(sys.argv[1]))",
			"bad, checked = [], 0",
			"for server, tools in (table.get('examples') or {}).items():",
			"    for tool, params in tools.items():",
			"        schema = table['tools'][server][tool]",
			"        for name, literal in params.items():",
			"            checked += 1",
			// ast.literal_eval, so the example is checked as the PYTHON value a model
			// pasting it into a cell would produce, not as a JSON re-encoding of it.
			"            value = ast.literal_eval(literal)",
			"            problem = c._check(value, schema['properties'][name], name)",
			"            if problem:",
			"                bad.append(f'{server}.{tool}.{name}: {literal} -> {problem}')",
			"print(json.dumps({'checked': checked, 'bad': bad[:5], 'total': len(bad)}))",
		].join("\n");
		const out = execFileSync("python3", ["-c", script, join(dir, "api", "_schemas.json")], {
			encoding: "utf8",
			stdio: "pipe",
		});
		const { checked, bad, total } = JSON.parse(out.trim().split("\n").at(-1));
		assert.ok(checked > 40, `expected examples across every catalogue, checked ${checked}`);
		assert.equal(total, 0, `the validator rejects examples this compiler emits:\n${bad.join("\n")}`);
	});
});

describe("cell errors are the exception, not a re-print of the docstring", () => {
	// The trimmer is a patch on the vendored harness (scripts/patches/traceback-trim.ts),
	// so it is imported from the COMPILED tree the arms actually run — a source
	// assertion would pass against a stale dist.
	//
	// OFF unless HARNESS_TRACEBACK_TRIM=1. The default is pinned first and hardest
	// below: an unflagged build must render byte-for-byte what every pre-trim run
	// saw, because the condition used to be selected by rebuilding dist and a
	// rebuild under a live eval put the trim into two jobs that never asked for it.
	const DIST = join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/core/tools/ipython.js");
	const fixture = (name) => JSON.parse(readFileSync(join(ROOT, "bench/test/fixtures", name), "utf8")).frames;

	/** Run `body` with the trim enabled, restoring whatever the environment had. */
	const trimming = (body) => {
		const before = process.env.HARNESS_TRACEBACK_TRIM;
		process.env.HARNESS_TRACEBACK_TRIM = "1";
		try {
			return body();
		} finally {
			if (before === undefined) delete process.env.HARNESS_TRACEBACK_TRIM;
			else process.env.HARNESS_TRACEBACK_TRIM = before;
		}
	};

	it("is OFF by default: an unflagged build is byte-faithful to upstream", async () => {
		const { trimCellTraceback } = await import(DIST);
		// Both fixtures, whole strings, no substring matching: "byte-faithful" is the
		// claim, so anything less than equality would not check it.
		assert.equal(process.env.HARNESS_TRACEBACK_TRIM, undefined, "the suite leaked the flag");
		for (const name of ["traceback-bridge.json", "traceback-user.json"]) {
			const frames = fixture(name);
			assert.equal(trimCellTraceback(frames), frames.join("\n"), `${name} was altered without the flag`);
		}
	});

	it("only the documented value enables it — a typo must not half-enable a condition", async () => {
		const { trimCellTraceback } = await import(DIST);
		const frames = fixture("traceback-bridge.json");
		const before = process.env.HARNESS_TRACEBACK_TRIM;
		try {
			for (const value of ["", "0", "true", "yes", "TRIM", "2"]) {
				process.env.HARNESS_TRACEBACK_TRIM = value;
				assert.equal(trimCellTraceback(frames), frames.join("\n"), `HARNESS_TRACEBACK_TRIM=${JSON.stringify(value)} enabled the trim`);
			}
		} finally {
			if (before === undefined) delete process.env.HARNESS_TRACEBACK_TRIM;
			else process.env.HARNESS_TRACEBACK_TRIM = before;
		}
	});

	it("is read per call, so one dist can serve both arms of an A/B", async () => {
		const { trimCellTraceback } = await import(DIST);
		const frames = fixture("traceback-bridge.json");
		// The same loaded module, alternating conditions: a value captured at import
		// would make the flag depend on load order instead of on the run.
		assert.equal(trimCellTraceback(frames), frames.join("\n"));
		const thin = trimming(() => trimCellTraceback(frames));
		assert.ok(thin.length < frames.join("\n").length / 3, "the flag did not enable the trim");
		assert.equal(trimCellTraceback(frames), frames.join("\n"), "the trim stayed on after the flag was cleared");
	});

	it("cuts a real bridge traceback to the call and the message", async () => {
		const { trimCellTraceback } = await import(DIST);
		const frames = fixture("traceback-bridge.json");
		const fat = frames.join("\n");
		const thin = trimming(() => trimCellTraceback(frames));
		// Captured verbatim from the kernel's own IPython: 8 frames, 2.6k characters,
		// message last.
		assert.ok(fat.length > 2000, `fixture is not the fat case (${fat.length} chars)`);
		assert.ok(thin.length < fat.length / 3, `trim kept ${thin.length} of ${fat.length} chars`);
		// What must survive: the exception line, the argument that was wrong, the
		// example, and the model's own offending call.
		assert.match(thin, /ArgumentError: api\.agent_tools\.complete_job: final_outputs must be object/);
		assert.match(thin, /example: final_outputs=\{'image'/);
		assert.match(thin, /---> 10 result = await run\(\)/);
		assert.match(thin, /final_outputs=\["abc123", "def456"\]/);
		// What must not: the bridge's frames and the docstrings they echo.
		assert.equal(/_client\.py/.test(thin), false, "the transport's frame survived");
		assert.equal(/Invoke an MCP tool and return its text result/.test(thin), false, "a docstring survived");
		assert.equal(/Mark the current job as completed/.test(thin), false, "a docstring survived");
	});

	it("keeps every frame of a plain user-code error", async () => {
		const { trimCellTraceback } = await import(DIST);
		const frames = fixture("traceback-user.json");
		const thin = trimming(() => trimCellTraceback(frames));
		// A KeyError in the model's own function matches none of the drop rules: both
		// frames and both marked lines stay, and only the source lines above them go.
		assert.match(thin, /KeyError: 'video'/);
		assert.match(thin, /---> 15 total\(\["image", "video"\]\)/);
		assert.match(thin, /---> 12     n \+= counts\[row\]/);
		assert.match(thin, /Cell In\[1\], line 12, in total\(rows\)/);
	});

	it("hands back what the kernel sent when there is nothing to trim", async () => {
		const { trimCellTraceback } = await import(DIST);
		trimming(() => {
			assert.equal(trimCellTraceback([]), "");
			assert.equal(trimCellTraceback(["a", "b"]), "a\nb");
			// Every middle frame dropped means the raise is somewhere this function
			// does not model, so it must not answer with three lines of punctuation.
			const allPlumbing = ["---", "E  Traceback", "File /x/asyncio/base_events.py:1, in run()\n---> 1 x", "E: m"];
			assert.equal(trimCellTraceback(allPlumbing), allPlumbing.join("\n"));
		});
	});

	it("the patch source and the built dist agree about the flag", () => {
		// The gate is only real in the COMPILED harness, and the patch snippet is the
		// authority on what gets compiled. A dist built before the gate landed would
		// pass every behavioural test above under the flag and still trim without it.
		const patch = readFileSync(join(ROOT, "scripts/patches/traceback-trim.ts"), "utf8");
		const dist = readFileSync(DIST, "utf8");
		assert.match(patch, /process\.env\.HARNESS_TRACEBACK_TRIM !== "1"/);
		assert.match(dist, /process\.env\.HARNESS_TRACEBACK_TRIM !== "1"/);
		// The retired escape hatch must not linger in either: two knobs for one
		// condition is how a run ends up unable to say which one it had.
		assert.equal(/HARNESS_FAT_TRACEBACK/.test(patch), false, "the old flag is still in the patch");
		assert.equal(/HARNESS_FAT_TRACEBACK/.test(dist), false, "the old flag is still in dist");
	});
});

describe("the example reaches the error channel", () => {
	const client = generate(PRODUCT, { validateArgs: true }).files["_client.py"];

	it("is quoted from a sibling table, so the schema line stays the schema", () => {
		assert.match(client, /def _example\(server: str, tool: str, name: str\) -> str:/);
		assert.match(client, /_table\(\)\.get\("examples"\)/);
		const table = JSON.parse(generate(PRODUCT, { validateArgs: true }).files["_schemas.json"]);
		assert.equal("pyExample" in (table.tools.agent_tools.complete_job.properties.final_outputs ?? {}), false);
	});

	it("is placed above the schema dump, not below it", () => {
		const example = client.indexOf("{_example(server, tool, name)}");
		const schema = client.indexOf("schema for {name}: {json.dumps(spec)}");
		assert.ok(example > 0 && schema > 0);
		assert.ok(example < schema, "the actionable line is below the JSON blob");
	});

	it("also fires when a nested argument is missing entirely", () => {
		assert.match(client, /missing required argument \{name!r\}\. Parameters: \{known\}"\n\s+f"\{_example\(server, tool, name\)\}/);
	});
});
