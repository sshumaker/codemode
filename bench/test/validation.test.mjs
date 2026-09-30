/**
 * Runtime argument validation: the generated `api/` tree checks every call's
 * arguments against the source MCP schema before the request leaves the process.
 *
 * The claim being pinned is narrow and worth stating precisely, because a looser
 * version of it is false. A JSON tool-calling harness is NOT unvalidated — the
 * provider validates the emitted tool call. What it cannot do is validate at the
 * *call site*: the correction is produced after the model has emitted, and arrives
 * as a tool result on the next turn. Generated code raises inside the cell that
 * made the mistake, in the error channel this project has measured to be the one
 * the model actually adopts from (CLAUDE.md: a guard's error changed behaviour on
 * the very next cell where prompt text did not).
 *
 * What is pinned here, per "a documented check is not an executed check":
 *
 *   - off renders nothing at all, and the tree is byte-identical to today's,
 *   - each error class fires and NAMES the offending argument,
 *   - a rejected call never reaches the transport,
 *   - a valid call is untouched, including the falsy-but-present and the
 *     unset-optional cases that a naive filter destroys,
 *   - an API with no schema entry still works, so a gap in the table cannot
 *     silently remove a tool from one arm.
 *
 * String assertions certify that the text is there; `find_spec` once certified a
 * module that contained a syntax error, because locating a module does not execute
 * it. So the validator is also RUN, against a real stub proxy, in both conditions.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { generate, renderClient, renderRootIndex, renderSchemas, normalizeTool } from "../generate.mjs";
import { adversarial, constrained, realistic, wide } from "./fixtures/catalogue.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = readFileSync(join(ROOT, "bench/appworld/run-task.mjs"), "utf8");
const SWEEP = readFileSync(join(ROOT, "bench/appworld/sweep.mjs"), "utf8");
const PROBE = join(ROOT, "bench/test/fixtures/validation_probe.py");
const CATALOGUE = [...realistic, ...wide];

describe("validation is off by default", () => {
	it("generate() without the option renders the tree it always rendered", () => {
		// The A/B compares two trees, and "the same file with a dormant branch in it"
		// is not the same file — the same rule the docs gate is rendered under.
		assert.deepEqual(generate(CATALOGUE), generate(CATALOGUE, { validateArgs: false }));
	});

	it("renders no validator, no schema table and no announcement", () => {
		const { files } = generate(CATALOGUE);
		assert.equal(/ArgumentError|_validate|_JSON_TYPES/.test(files["_client.py"]), false, "off client carries validator code");
		assert.equal("_schemas.json" in files, false, "off tree ships a schema table nothing reads");
		assert.equal(/import re/.test(files["_client.py"]), false, "off client imports re for a validator it does not have");
		assert.equal(/ArgumentError/.test(files["INDEX.md"]), false, "off INDEX announces a check that will not fire");
	});

	it("no INDEX announces validation that will not fire", () => {
		assert.equal(/ArgumentError|checked against/.test(renderRootIndex([])), false);
	});

	it("the runner's flag defaults to off and is codemode-only", () => {
		assert.match(RUNNER, /const validateArgs = argv\.includes\("--validate-args"\)/);
		// The list of codemode-only variants grows; the property pinned is that each is
		// REFUSED on another arm rather than accepted and silently ignored.
		assert.match(RUNNER, /\(docsGate !== "off" \|\| navTools \|\| validateArgs[^)]*\) && arm !== "codemode"/);
		assert.match(SWEEP, /const codemodeValidateArgs = has\("codemode-validate-args"\)/);
		assert.match(SWEEP, /if \(codemodeValidateArgs\) args\.push\("--validate-args"\)/);
	});

	it("the condition lands in the runId, so a variant run cannot overwrite its baseline", () => {
		assert.match(RUNNER, /validateArgs \? "__val" : ""/);
		assert.match(SWEEP, /codemodeValidateArgs \? "__val" : ""/);
	});

	it("the condition is recorded in meta.json, not inferred from the id", () => {
		assert.match(RUNNER, /variants: \{[^}]*\bvalidateArgs\b[^}]*\}/);
	});

	it("is decided at generate time, not read from the environment by the client", () => {
		// The kernel is a grandchild process. An env var that failed to propagate
		// would produce an unvalidated run wearing a validated label — the same
		// failure mode the docs gate is rendered rather than switched on to avoid.
		assert.equal(/HARNESS_VALIDATE_ARGS/.test(generate(CATALOGUE, { validateArgs: true }).files["_client.py"]), false);
		// Field-wise, not the whole literal: the options object accumulates conditions
		// (apiLayout joined it), and pinning the exact call made an unrelated addition
		// look like a validation regression.
		assert.match(RUNNER, /generate\(catalogue, \{[^}]*\bvalidateArgs\b[^}]*\}\)/);
	});
});

describe("the schema table shipped alongside the tree", () => {
	const { files } = generate(CATALOGUE, { validateArgs: true });
	const table = JSON.parse(files["_schemas.json"]).tools;

	it("is keyed by the identifiers _client.call actually receives", () => {
		// The RAW MCP names, not the python ones: `call(server, tool, args)` is given
		// the wire identifiers, so a table keyed by `pyName` would silently miss every
		// tool whose name needed mangling — i.e. validation would quietly do nothing.
		assert.ok(table.linear.list_issues, "the table is not keyed by (server, tool)");
		const messy = JSON.parse(generate(adversarial, { validateArgs: true }).files["_schemas.json"]);
		assert.ok(messy.tools.messy["get-user.profile"], "a mangled tool name lost its schema entry");
		// And the python path is carried alongside, so the error can name what the
		// agent would type rather than the wire name.
		assert.equal(messy.packages.messy, "messy");
		const spaced = JSON.parse(generate([{ server: "Math MCP", tools: [{ name: "add" }] }], { validateArgs: true }).files["_schemas.json"]);
		assert.equal(spaced.packages["Math MCP"], "math_mcp");
	});

	it("covers every tool in the catalogue", () => {
		const counted = Object.values(table).reduce((n, tools) => n + Object.keys(tools).length, 0);
		assert.equal(counted, CATALOGUE.reduce((n, s) => n + s.tools.length, 0));
	});

	it("keeps the constraints and drops the prose", () => {
		// Validation needs constraints, not descriptions. Leaving the prose in would
		// make _schemas.json a shadow documentation surface — one `cat` from the whole
		// catalogue, which is exactly the residency an L0 label claims is absent.
		const status = table.linear.list_issues.properties.status;
		assert.deepEqual(status.enum, ["todo", "in_progress", "done"]);
		assert.equal("description" in status, false, "the schema table carries prose");
		assert.equal(/Team key/.test(files["_schemas.json"]), false, "a description survived into the schema table");
		// And the docstrings remain the only place that prose lives.
		assert.match(files["linear/list_issues.py"], /Team key, e\.g\. ENG\./);
	});

	it("keeps a parameter that is literally NAMED description or title", () => {
		// The bug this test exists for, found in a live run: the prose stripper deleted
		// any key called `description`, including the 33 real AppWorld parameters with
		// that name, so `_validate` reported the agent's legal `description="..."` as an
		// UNKNOWN ARGUMENT. The agent obeyed, dropped the argument, and the call
		// succeeded without it — a validation bug that produces a plausible error AND a
		// plausible recovery, and would never have surfaced as a harness failure.
		const naming = [
			{
				server: "notes",
				tools: [
					{
						name: "create",
						description: "Create a note.",
						inputSchema: {
							type: "object",
							properties: {
								title: { type: "string", description: "The note's title." },
								description: { type: "string", description: "The note's body." },
							},
							required: ["title"],
						},
					},
				],
			},
		];
		const table = JSON.parse(generate(naming, { validateArgs: true }).files["_schemas.json"]).tools;
		assert.deepEqual(Object.keys(table.notes.create.properties).sort(), ["description", "title"]);
		// The parameter survives; its own prose does not.
		assert.deepEqual(table.notes.create.properties.description, { type: "string" });
	});

	it("keeps enum members intact, since they are values and not schemas", () => {
		// An enum member that happens to be an object is compared against the argument
		// by equality; rewriting it would change which arguments are accepted.
		const withData = [
			{
				server: "d",
				tools: [
					{
						name: "t",
						description: "d",
						inputSchema: {
							type: "object",
							properties: { mode: { enum: [{ description: "verbatim" }, "plain"], default: "plain", description: "Mode." } },
						},
					},
				],
			},
		];
		const table = JSON.parse(generate(withData, { validateArgs: true }).files["_schemas.json"]).tools;
		assert.deepEqual(table.d.t.properties.mode.enum, [{ description: "verbatim" }, "plain"]);
		assert.equal(table.d.t.properties.mode.default, "plain");
	});

	it("is the source schema, not a translation of it", () => {
		// A per-function isinstance ladder would put a generated *rendering* of the
		// schema between the benchmark and the arm; this is the schema.
		const source = normalizeTool(realistic[0].tools[0]).schema;
		assert.deepEqual(table.linear.list_issues.required, source.required);
		assert.deepEqual(Object.keys(table.linear.list_issues.properties), Object.keys(source.properties));
	});

	it("renders deterministically from the normalized catalogue", () => {
		assert.equal(renderSchemas(generate(CATALOGUE).normalized), files["_schemas.json"]);
	});
});

describe("the validator's shape", () => {
	const client = renderClient({ validateArgs: true });

	it("is catchable both as McpError and as TypeError", () => {
		// `except TypeError` around a call with a guessed argument is the idiom the
		// model already has. CLAUDE.md's affordance rule: adopt the idiom rather than
		// requiring a bespoke exception to be learned first.
		assert.match(client, /class ArgumentError\(McpError, TypeError\):/);
	});

	it("validates what is actually sent, after the None-drop", () => {
		// The generated wrappers pass every parameter on every call, so validating
		// before the drop would read each unset optional as a null type violation.
		const sent = client.indexOf("sent = {k: v for k, v in (args or {}).items() if v is not None}");
		const validate = client.indexOf("_validate(server, tool, sent)");
		assert.ok(sent > 0 && validate > 0, "the validation call was not rendered");
		assert.ok(sent < validate, "arguments are validated before the None-drop");
	});

	it("raises before the request is built, not after", () => {
		const validate = client.indexOf("_validate(server, tool, sent)");
		assert.ok(validate < client.indexOf("urllib.request.Request"), "the request is built before validation");
	});

	it("does not accept bool for a number, or int for a bool", () => {
		// Python's bool is an int subclass, so a naive isinstance lets `limit=True`
		// and `verified=1` through, and both are rejected downstream.
		assert.match(client, /if isinstance\(value, bool\) and name in \("integer", "number"\):\n\s+return False/);
		assert.match(client, /if not isinstance\(value, bool\) and name == "boolean":\n\s+return False/);
	});

	it("stays stdlib-only", () => {
		// The kernel is a bare uv-managed environment; an ImportError here would
		// silently disable the entire arm rather than fail one call.
		const imports = [...client.matchAll(/^import (\w+)|^from (\w+)/gm)].map((m) => m[1] ?? m[2]);
		assert.deepEqual([...new Set(imports)].sort(), ["asyncio", "json", "os", "re", "urllib"]);
	});

	it("declines to enforce a format it has not implemented", () => {
		// A verdict this validator cannot actually compute must not be invented —
		// rejecting a legal `date-time` would remove a capability vanilla still has.
		assert.match(client, /if schema\.get\("format"\) == "email"/);
		assert.equal(/date-time|uri|uuid|ipv4/.test(client), false, "claims formats it does not implement");
	});

	it("announces itself in INDEX.md, since an unexplained exception is a bug to work around", () => {
		const index = generate(CATALOGUE, { validateArgs: true }).files["INDEX.md"];
		assert.match(index, /ArgumentError/);
		assert.match(index, /nothing reaches the server/);
	});

	it("composes with the docs gate rather than replacing it", () => {
		const both = generate(CATALOGUE, { validateArgs: true, docsGate: "inline" }).files["_client.py"];
		assert.match(both, /class ArgumentError/);
		assert.match(both, /class DocsFirst/);
		assert.match(both, /^import inspect$/m);
		assert.match(both, /^import re$/m);
	});
});

describe("the generated tree, executed against a stub proxy", () => {
	const dirs = [];
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	const probe = (mode) => {
		const dir = mkdtempSync(join(tmpdir(), "harness-validate-"));
		dirs.push(dir);
		const files = generate(constrained, { validateArgs: mode === "on" }).files;
		for (const [rel, content] of Object.entries(files)) {
			const path = join(dir, "api", rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		return execFileSync("python3", [PROBE, dir, mode], { encoding: "utf8", stdio: "pipe" });
	};

	it("off: the schema-violating call goes out on the wire exactly as before", () => {
		assert.match(probe("off"), /^OK$/m);
	});

	it("on: every error class fires, names its argument, and stops at the call site", () => {
		// The probe covers type, enum, minimum/maximum, exclusiveMinimum,
		// minLength/maxLength, pattern, format, maxItems, per-item, nested object,
		// nested required, anyOf, missing-required and unknown-argument — and asserts
		// after every one that the transport saw nothing.
		assert.match(probe("on"), /^OK$/m);
	});

	it("on: a typed map's VALUES are checked, not just its dict-ness", () => {
		// `additionalProperties` as a schema constrains every value. Without it a
		// homogeneous dict was checked only for being a dict, so the wrong value type
		// passed here and failed at the server — one round trip later, and for a
		// graded run one `state=error` row in the trace the graders read. Measured on
		// the product port's `complete_job.final_outputs` (dict[str, list[str]]).
		const dir = mkdtempSync(join(tmpdir(), "harness-validate-map-"));
		dirs.push(dir);
		for (const [rel, content] of Object.entries(generate(CATALOGUE, { validateArgs: true }).files)) {
			const path = join(dir, "api", rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		const schema = { type: "object", additionalProperties: { type: "array", items: { type: "string" } } };
		const script = [
			"import json,sys",
			`sys.path.insert(0, ${JSON.stringify(dir)})`,
			"import api._client as c",
			`schema = json.loads(${JSON.stringify(JSON.stringify(schema))})`,
			"out = {",
			"  'good': c._check({'image': ['a', 'b']}, schema, 'final_outputs'),",
			"  'value_not_list': c._check({'image': 'a'}, schema, 'final_outputs'),",
			"  'item_not_str': c._check({'image': [1]}, schema, 'final_outputs'),",
			"  'not_a_dict': c._check(['a'], schema, 'final_outputs'),",
			"}",
			"print(json.dumps(out))",
		].join("\n");
		const out = JSON.parse(execFileSync("python3", ["-c", script], { encoding: "utf8", stdio: "pipe" }).trim().split("\n").at(-1));
		assert.equal(out.good, null, "a correctly shaped map was rejected");
		// Each rejection has to NAME the offending key, or the correction is a riddle.
		assert.match(out.value_not_list, /final_outputs\['image'\] must be array/);
		assert.match(out.item_not_str, /final_outputs\['image'\]\[0\] must be string/);
		// The list-for-dict mistake all four measured jobs actually made.
		assert.match(out.not_a_dict, /final_outputs must be object, got list/);
	});

	it("every generated module still compiles with validation on", () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-validate-ast-"));
		dirs.push(dir);
		for (const [rel, content] of Object.entries(generate([...CATALOGUE, ...adversarial, ...constrained], { validateArgs: true }).files)) {
			if (!rel.endsWith(".py")) continue;
			const path = join(dir, rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
			assert.doesNotThrow(
				() => execFileSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", path], { stdio: "pipe" }),
				`generated module does not parse: ${rel}`,
			);
		}
	});
});

describe("the real catalogue", () => {
	const path = join(ROOT, "bench/data/appworld-schemas.json");
	const catalogue = JSON.parse(readFileSync(path, "utf8")).catalogue;

	it("validates every tool AppWorld ships, and drops none of them", () => {
		const { files } = generate(catalogue, { validateArgs: true });
		const table = JSON.parse(files["_schemas.json"]).tools;
		const counted = Object.values(table).reduce((n, tools) => n + Object.keys(tools).length, 0);
		assert.equal(counted, catalogue.reduce((n, s) => n + s.tools.length, 0));
	});

	it("keeps every parameter name, so no legal argument can read as unknown", () => {
		// The general form of the `description` bug, and the check that would have
		// caught it without knowing which key was at fault: the validator refuses
		// arguments outside `properties`, so a name missing from the table becomes an
		// ArgumentError on a call the server would have answered. Names, not counts —
		// a count can net out.
		const { files } = generate(catalogue, { validateArgs: true });
		const table = JSON.parse(files["_schemas.json"]).tools;
		const missing = [];
		for (const app of catalogue) {
			for (const tool of app.tools) {
				const source = Object.keys(tool.inputSchema?.properties ?? {});
				const shipped = new Set(Object.keys(table[app.server][tool.name].properties ?? {}));
				for (const name of source) if (!shipped.has(name)) missing.push(`${app.server}.${tool.name}.${name}`);
			}
		}
		assert.deepEqual(missing, [], `${missing.length} parameters would be rejected as unknown`);
	});

	it("accepts every default value AppWorld's own schemas declare", () => {
		// A validator that rejects a schema's own `default` fails calls the server
		// would have answered, which is worse than not validating at all — and it is
		// the failure mode that would be invisible in an aggregate, since it removes
		// a capability from one arm only. Run against the real 469-tool catalogue
		// rather than a fixture, because that is where the odd combinations live:
		// AppWorld ships 363 defaults across enum, minimum, format and boolean
		// parameters.
		const dir = mkdtempSync(join(tmpdir(), "harness-defaults-"));
		try {
			for (const [rel, content] of Object.entries(generate(catalogue, { validateArgs: true }).files)) {
				const p = join(dir, "api", rel);
				mkdirSync(dirname(p), { recursive: true });
				writeFileSync(p, content);
			}
			const script = [
				"import json,sys",
				`sys.path.insert(0, ${JSON.stringify(dir)})`,
				"import api._client as c",
				"# The defaults live in the SOURCE catalogue: _schemas.json keeps constraints",
				"# and drops prose, but `default` is a value, not prose, so it is still there.",
				"table = json.load(open(sys.argv[1]))['tools']",
				"bad, checked = [], 0",
				"for server, tools in table.items():",
				"    for tool, schema in tools.items():",
				"        for name, spec in (schema.get('properties') or {}).items():",
				"            if 'default' not in spec or spec['default'] is None:",
				"                continue",
				"            checked += 1",
				"            problem = c._check(spec['default'], spec, name)",
				"            if problem:",
				"                bad.append(f'{server}.{tool}: ' + problem.replace(chr(10), ' '))",
				"print(json.dumps({'checked': checked, 'bad': bad[:5], 'total': len(bad)}))",
			].join("\n");
			const out = execFileSync("python3", ["-c", script, join(dir, "api", "_schemas.json")], { encoding: "utf8", stdio: "pipe" });
			const { checked, bad, total } = JSON.parse(out.trim().split("\n").at(-1));
			assert.ok(checked > 300, `expected AppWorld's ~363 defaults, checked ${checked}`);
			assert.equal(total, 0, `the validator rejects AppWorld's own default values:\n${bad.join("\n")}`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
