/**
 * The two opt-in codemode variants: the first-use documentation gate, and the
 * read-only navigation tools.
 *
 * Both exist because of a measured loss. On AppWorld 4242c97_1 the codemode arm
 * read `api/INDEX.md` and nothing else. INDEX summarises
 * `supervisor.complete_task` as "Mark the currently active task as complete with
 * the given answer", which reads as an instruction to supply one; the file it
 * never opened, `api/supervisor/complete_task.py`, says to pass an answer only if
 * the task asks a question. It volunteered `answer="navy blue"` and lost the task
 * on an unread docstring.
 *
 * The gate has three modes and the A/B prices them against each other:
 *   off       byte-identical to the tree every earlier run used
 *   redirect  a pointer to api/<pkg>/DOCS.md, nothing inlined  (the primary form)
 *   inline    the docstring plus the nearest siblings, in the message
 *
 * What is pinned here, per the rule that a documented check is not an executed
 * check:
 *
 *   - off renders nothing at all, in any file,
 *   - redirect cites the file and does NOT inline the docstring,
 *   - inline delivers the FUNCTION's docstring — the one with Args and the
 *     constraints, not the INDEX one-liner that caused the loss — plus siblings,
 *     bounded so the message stays a hint rather than a context bomb,
 *   - a gated call never reaches the transport,
 *   - the (server, tool) pair is marked delivered BEFORE the raise, so a cell
 *     that first-uses several APIs clears them all in one retry instead of
 *     wedging on the first one,
 *   - the nav tools are read-only: no bash, no edit, no write.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
	DOCS_GATE_MODES,
	docsGateMode,
	generate,
	normalizeTool,
	renderAppDocs,
	renderClient,
	renderRootIndex,
	renderToolModule,
} from "../generate.mjs";
import { realistic, wide } from "./fixtures/catalogue.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = readFileSync(join(ROOT, "bench/appworld/run-task.mjs"), "utf8");
const SWEEP = readFileSync(join(ROOT, "bench/appworld/sweep.mjs"), "utf8");
const PROBE = join(ROOT, "bench/test/fixtures/docs_gate_probe.py");
const CATALOGUE = [...realistic, ...wide];

describe("the gate's modes are a closed set", () => {
	it("has exactly off, redirect and inline", () => {
		assert.deepEqual(DOCS_GATE_MODES, ["off", "redirect", "inline"]);
	});

	it("rejects an unknown mode instead of degrading to off", () => {
		// A run labelled with a mode it is not in is the failure this project keeps
		// finding — a silent fallback would reproduce it on the flag.
		assert.throws(() => docsGateMode("redirct"), /unknown docs-gate mode/);
		assert.throws(() => generate(realistic, { docsGate: "on" }), /unknown docs-gate mode/);
	});
});

describe("the docs gate is off by default", () => {
	it("generate() without the option renders the tree it always rendered", () => {
		// The A/B compares two trees. "The same file with a dormant branch in it"
		// is not the same file, so the gate is rendered in rather than switched on.
		assert.deepEqual(generate(CATALOGUE), generate(CATALOGUE, { docsGate: "off" }));
	});

	it("renders no gate machinery, no DOCS.md and no neighbour table", () => {
		const { files } = generate(CATALOGUE);
		assert.equal(/DocsFirst|_DOCS_DELIVERED|inspect/.test(files["_client.py"]), false, "gate-off client carries gate code");
		assert.equal(Object.keys(files).some((f) => f.endsWith("DOCS.md")), false, "gate-off tree carries DOCS.md");
		assert.equal(Object.keys(files).some((f) => f.includes("_neighbours")), false, "gate-off tree carries a neighbour table");
		for (const [rel, content] of Object.entries(files)) {
			if (!rel.endsWith(".py")) continue;
			assert.equal(/_doc=|_path=/.test(content), false, `${rel} carries gate plumbing with the gate off`);
		}
	});

	it("no INDEX announces a gate that will not fire", () => {
		assert.equal(/DOCS\.md|first call to any API/i.test(renderRootIndex([])), false);
		assert.equal(/DOCS\.md/.test(generate(CATALOGUE).files["linear/INDEX.md"]), false);
	});

	it("the runner's flag defaults to off and is codemode-only", () => {
		assert.match(RUNNER, /const docsGate = parseDocsGate\(\)/);
		assert.match(RUNNER, /if \(i < 0\) return "off"/);
		assert.match(RUNNER, /const navTools = argv\.includes\("--nav-tools"\)/);
		// The list of codemode-only variants grows; the property being pinned is that
		// each is refused on another arm rather than silently ignored.
		assert.match(RUNNER, /\(docsGate !== "off" \|\| navTools[^)]*\) && arm !== "codemode"/);
	});

	it("a bare --docs-gate means the primary form, not the alternate", () => {
		assert.match(RUNNER, /docsGateMode\(next && !next\.startsWith\("--"\) \? next : "redirect"\)/);
		assert.match(SWEEP, /docsGateMode\(next && !next\.startsWith\("--"\) \? next : "redirect"\)/);
	});
});

describe("redirect: a pointer, not a payload", () => {
	const { files } = generate(CATALOGUE, { docsGate: "redirect" });

	it("arms the gate with __name__ alone — no docstring is plumbed anywhere", () => {
		const module = files["linear/list_issues.py"];
		assert.match(module, /_path=__name__/);
		assert.equal(/_doc=/.test(module), false, "redirect plumbs a docstring it will never show");
		assert.equal(/inspect/.test(files["_client.py"]), false, "redirect imports a docstring cleaner it never uses");
	});

	it("names DOCS.md in the message, and nothing else", () => {
		const client = renderClient({ docsGate: "redirect" });
		assert.match(client, /read api\/\{pkg\}\/DOCS\.md/);
		assert.match(client, /Then re-issue your call/);
		assert.equal(/cleandoc/.test(client), false, "redirect renders the inline mode's docstring handling");
	});

	it("renders no neighbour table, since it cites none", () => {
		assert.equal(Object.keys(files).some((f) => f.includes("_neighbours")), false);
	});
});

describe("DOCS.md is the redirect target", () => {
	it("is rendered per app, in both live modes and neither in off", () => {
		for (const mode of ["redirect", "inline"]) {
			const { files } = generate(CATALOGUE, { docsGate: mode });
			for (const pkg of ["linear", "notion", "wide"]) {
				assert.ok(files[`${pkg}/DOCS.md`], `${mode}: api/${pkg}/DOCS.md was not generated`);
			}
		}
	});

	it("carries every one of its app's APIs with full parameter documentation", () => {
		const docs = generate(CATALOGUE, { docsGate: "redirect" }).files["linear/DOCS.md"];
		for (const tool of realistic[0].tools) {
			assert.ok(docs.includes(`api.linear.${tool.name}(`), `${tool.name} is missing from DOCS.md`);
		}
		assert.match(docs, /Team key, e\.g\. ENG\./);
		assert.match(docs, /capped at 50/);
	});

	it("leads with the conventions it can derive, and asserts none it cannot", () => {
		// Derived from the schemas rather than stated: an app that does not work
		// this way must not be told that it does.
		const tools = wide[0].tools.map(normalizeTool);
		const withConventions = renderAppDocs(tools, { server: "wide", pkg: "wide" });
		assert.match(withConventions, /## Conventions/);
		assert.match(withConventions, /Pagination: \d+ APIs take `page_index`/);

		const bare = renderAppDocs(realistic[0].tools.map(normalizeTool), { server: "linear", pkg: "linear" });
		assert.equal(/## Conventions/.test(bare), false, "invented a convention for an app that has none");
	});

	it("is pointed at from the app's INDEX, which is where the agent starts", () => {
		const index = generate(CATALOGUE, { docsGate: "redirect" }).files["linear/INDEX.md"];
		assert.match(index, /`api\/linear\/DOCS\.md`/);
	});
});

describe("inline: the docstring, plus the neighbourhood", () => {
	const { files } = generate(CATALOGUE, { docsGate: "inline" });

	it("passes __doc__ and __name__ rather than a second copy of the text", () => {
		// Two copies drift. `__doc__` is the same object `help()` prints and the
		// file contains, and `__name__` is already the import path the agent types.
		const module = files["linear/list_issues.py"];
		assert.match(module, /_doc=list_issues\.__doc__/);
		assert.match(module, /_path=__name__/);
	});

	it("the docstring it delivers is the one with the Args, not the INDEX line", () => {
		const module = renderToolModule(normalizeTool(realistic[0].tools[0]), { server: "linear", docsGate: "inline" });
		assert.match(module, /Args:/);
		assert.match(module, /Team key, e\.g\. ENG\./);
	});

	it("the neighbour table reuses the INDEX line, so one API has one summary", () => {
		// INDEX wraps the signature in backticks; strip those and the two lines must
		// be the same sentence about the same API, from the same renderer.
		const table = JSON.parse(files["_neighbours.json"]);
		const index = files["linear/INDEX.md"].replace(/`/g, "");
		for (const line of Object.values(table.linear)) assert.ok(index.includes(line), `neighbour line drifted from INDEX: ${line}`);
	});

	it("covers every app and every tool", () => {
		const table = JSON.parse(files["_neighbours.json"]);
		assert.deepEqual(Object.keys(table).sort(), ["linear", "notion", "wide"]);
		assert.equal(Object.keys(table.wide).length, 25);
	});
});

describe("both live modes", () => {
	for (const mode of ["redirect", "inline"]) {
		describe(mode, () => {
			it("DocsFirst subclasses McpError, so existing handling still catches it", () => {
				assert.match(renderClient({ docsGate: mode }), /class DocsFirst\(McpError\):/);
			});

			it("marks the pair delivered before raising", () => {
				// Load-bearing, not stylistic: marked after the raise, a cell that
				// first-uses three APIs never gets past the first one.
				const client = renderClient({ docsGate: mode });
				const add = client.indexOf("_DOCS_DELIVERED.add(key)");
				const raise = client.indexOf("raise DocsFirst(");
				assert.ok(add > 0 && raise > 0, "gate body not found");
				assert.ok(add < raise, "the pair is marked AFTER the raise — a multi-API cell would wedge");
			});

			it("announces itself in INDEX.md in the form it will actually take", () => {
				const index = generate(CATALOGUE, { docsGate: mode }).files["INDEX.md"];
				assert.match(index, /re-issue the call/i);
				assert.match(index, mode === "redirect" ? /pointer to that app's DOCS\.md/ : /that API's documentation/);
			});

			it("every generated module still compiles", () => {
				const dir = mkdtempSync(join(tmpdir(), "harness-gate-"));
				try {
					for (const [rel, content] of Object.entries(generate(CATALOGUE, { docsGate: mode }).files)) {
						if (!rel.endsWith(".py")) continue;
						const path = join(dir, rel);
						mkdirSync(dirname(path), { recursive: true });
						writeFileSync(path, content);
						assert.doesNotThrow(
							() => execFileSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", path], { stdio: "pipe" }),
							`generated module does not parse: ${rel}`,
						);
					}
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			});
		});
	}
});

describe("the generated client, executed against a stub proxy", () => {
	// String assertions certify that the text is there. `find_spec` once certified
	// a module that contained a syntax error, because locating a module does not
	// execute it — so the gate is also run, in every mode.
	const dirs = [];
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	const probe = (mode) => {
		const dir = mkdtempSync(join(tmpdir(), "harness-probe-"));
		dirs.push(dir);
		for (const [rel, content] of Object.entries(generate(CATALOGUE, { docsGate: mode }).files)) {
			const path = join(dir, "api", rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		return execFileSync("python3", [PROBE, dir, mode], { encoding: "utf8", stdio: "pipe" });
	};

	it("off: the first call goes straight to the transport", () => {
		assert.match(probe("off"), /OK/);
	});

	it("redirect: first use raises a DOCS.md pointer with no docstring; the re-issue proceeds", () => {
		assert.match(probe("redirect"), /OK/);
	});

	it("inline: first use raises docstring + bounded neighbours; the re-issue proceeds", () => {
		// Also covers mark-before-raise under `asyncio.gather` — the shape the a1
		// preamble teaches — and the >20-tool truncation, in Python where the
		// ranking actually runs.
		assert.match(probe("inline"), /OK/);
	});
});

describe("the nav tools are read-only navigation, not a shell", () => {
	it("codemode's default tool list is still ipython alone", () => {
		assert.match(RUNNER, /toolList = \["ipython"\]/);
	});

	it("--nav-tools adds only read/grep/find/ls", () => {
		const match = /if \(navTools\) toolList = \[\.\.\.toolList, ([^\]]*)\]/.exec(RUNNER);
		assert.ok(match, "--nav-tools handling not found in run-task.mjs");
		assert.deepEqual(match[1].split(",").map((s) => s.trim().replace(/"/g, "")).sort(), ["find", "grep", "ls", "read"]);
	});

	it("no variant can give codemode a shell or a writer", () => {
		// A shell is an escape hatch out of the surface under test: 78% of vanilla's
		// bash calls on MCP-Bench were `curl` to the APIs its own tools wrapped.
		const match = /if \(navTools\) toolList = \[([^\]]*)\]/.exec(RUNNER);
		assert.equal(/"bash"|"edit"|"write"/.test(match[1]), false, `nav tools include a shell or writer: ${match[1]}`);
	});

	it("the tool names are ones prime actually builds", async () => {
		const registry = await import(join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/core/tools/index.js"));
		const built = Object.keys(registry.createAllToolDefinitions(ROOT, {}));
		for (const name of ["ipython", "read", "grep", "find", "ls"]) {
			assert.ok(built.includes(name), `prime does not build a tool called ${name}; --tools would silently drop it`);
		}
	});
});

describe("a variant run never overwrites the baseline it is compared against", () => {
	// The runId-collision failure this repo already has a guard for: a scheme
	// change once silently replaced two already-reported runs.
	it("the runner puts the mode, not just the fact, in the default runId", () => {
		assert.match(RUNNER, /__gate-\$\{docsGate\}/);
		assert.match(RUNNER, /const runId = flag\("run-id", `[^`]*\$\{variantSuffix\}/);
	});

	it("the sweep builds the same suffix, or --resume would look for the wrong id", () => {
		assert.match(SWEEP, /__gate-\$\{codemodeDocsGate\}/);
		assert.match(SWEEP, /codemodeNavTools \? "__nav" : ""/);
		assert.match(SWEEP, /\$\{suffix\}\$\{variantSuffix\}/);
	});

	it("the sweep passes the mode through to the runner", () => {
		assert.match(SWEEP, /args\.push\(`--docs-gate=\$\{codemodeDocsGate\}`\)/);
		assert.match(SWEEP, /if \(codemodeNavTools\) args\.push\("--nav-tools"\)/);
	});

	it("the condition is recorded in meta.json, not inferred from the id", () => {
		// Field-wise, not the whole literal: `variants` accumulates conditions (the base
		// prompt version joined it), and pinning the exact object made an unrelated
		// addition look like a docs-gate regression.
		assert.match(RUNNER, /variants: \{[^}]*\bdocsGate\b[^}]*\bnavTools\b[^}]*\}/);
	});
});

describe("pyType: schema information must survive into the signature", () => {
	it("anyOf collapses to a union, not Any", () => {
		const t = normalizeTool({
			name: "complete_task",
			description: "Mark done.",
			input_schema: {
				type: "object",
				properties: { answer: { anyOf: [{ type: "number" }, { type: "integer" }, { type: "string" }] } },
			},
		});
		// Measured regression: this rendered `Any` — the only untyped parameter of
		// 3,125 on AppWorld — because pyType had no anyOf/oneOf case.
		assert.equal(t.params.find((p) => p.name === "answer").type, "float | int | str");
	});

	it("oneOf is handled the same way, and null makes it optional", () => {
		const t = normalizeTool({
			name: "x",
			description: "d",
			input_schema: {
				type: "object",
				properties: { v: { oneOf: [{ type: "string" }, { type: "null" }] } },
			},
		});
		assert.equal(t.params.find((p) => p.name === "v").type, "str | None");
	});

	it("an array inside a type union keeps its item type", () => {
		// `{"type": ["array", "null"]}` flattened to a bare `list`, dropping `items`
		// — the same information loss the anyOf case above was fixed for, arriving
		// through the other branch.
		const t = normalizeTool({
			name: "z",
			description: "d",
			input_schema: {
				type: "object",
				properties: { ids: { type: ["array", "null"], items: { type: "integer" } } },
			},
		});
		assert.equal(t.params.find((p) => p.name === "ids").type, "list[int] | None");
	});

	it("a const is a one-member Literal, not its base type", () => {
		const t = normalizeTool({
			name: "w",
			description: "d",
			input_schema: { type: "object", properties: { kind: { type: "string", const: "issue" } } },
		});
		assert.equal(t.params.find((p) => p.name === "kind").type, 'Literal["issue"]');
	});

	it("enum still wins over anyOf, and arrays still nest", () => {
		const t = normalizeTool({
			name: "y",
			description: "d",
			input_schema: {
				type: "object",
				properties: {
					status: { type: "string", enum: ["success", "fail"] },
					ids: { type: "array", items: { type: "integer" } },
				},
			},
		});
		const by = Object.fromEntries(t.params.map((p) => [p.name, p.type]));
		assert.equal(by.status, 'Literal["success", "fail"]');
		assert.equal(by.ids, "list[int]");
	});

	it("a non-string enum keeps its JSON values, not their reprs", () => {
		// `Literal[1, 2]` and `Literal[True]` are what Python wants; a naive
		// stringify would emit `Literal["1"]` and silently change the type.
		const t = normalizeTool({
			name: "v",
			description: "d",
			input_schema: {
				type: "object",
				properties: {
					stars: { type: "integer", enum: [1, 2, 3] },
					nested: { type: "array", items: { type: "array", items: { type: "string" } } },
				},
			},
		});
		const by = Object.fromEntries(t.params.map((p) => [p.name, p.type]));
		assert.equal(by.stars, "Literal[1, 2, 3]");
		assert.equal(by.nested, "list[list[str]]");
	});
});
