/**
 * Generator tests.
 *
 * The generator is the experiment's fairness mechanism: one authored
 * description per tool, rendered into four containers. Two properties matter
 * above all others, and both are checked here against adversarial input:
 *
 *   1. No tool is dropped from any rendering. A tool missing from the api/ tree
 *      but present in the vanilla tool defs is a capability difference masquerading
 *      as a token saving.
 *   2. The description text is identical everywhere. If the containers diverge,
 *      the experiment measures prose quality rather than architecture.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { countTokens } from "../arms.mjs";
import { constraintNote, generate, normalizeTool, pyIdent, renderFullDocs, signature, wireName } from "../generate.mjs";
import { adversarial, realistic, synthetic } from "./fixtures/catalogue.mjs";

const allTools = (catalogue) => catalogue.flatMap((s) => s.tools.map((t) => ({ server: s.server, ...t })));

describe("identifier safety", () => {
	it("converts illegal characters to underscores", () => {
		assert.equal(pyIdent("get-user.profile"), "get_user_profile");
	});

	it("prefixes a leading digit", () => {
		assert.equal(pyIdent("2fa_verify"), "t_2fa_verify");
	});

	it("escapes Python reserved words", () => {
		// A bare `from` or `class` is a syntax error, which would silently remove
		// the tool from codemode while leaving it present in vanilla.
		assert.equal(pyIdent("from"), "from_");
		assert.equal(pyIdent("class"), "class_");
		assert.equal(pyIdent("lambda"), "lambda_");
	});

	it("never returns an empty identifier", () => {
		assert.ok(pyIdent("---").length > 0);
		assert.ok(pyIdent("").length > 0);
	});
});

describe("signatures", () => {
	it("marks optional parameters and orders required ones first", () => {
		const tool = normalizeTool(realistic[0].tools[0]);
		assert.equal(signature(tool), "list_issues(team, status?, limit?)");
	});

	it("handles a tool with no parameters", () => {
		const tool = normalizeTool({ name: "ping", description: "Health check." });
		assert.equal(signature(tool), "ping()");
	});
});

for (const [label, catalogue] of [["realistic", realistic], ["adversarial", adversarial]]) {
	describe(`coverage — ${label}`, () => {
		it("every tool appears in the JSON tool definitions", () => {
			const { toolDefs } = generate(catalogue);
			assert.equal(toolDefs.length, allTools(catalogue).length);
		});

		it("every tool appears in the TOC", () => {
			const { tocLines } = generate(catalogue);
			assert.equal(tocLines.length, allTools(catalogue).length);
		});

		it("every tool appears in the name list", () => {
			const { names } = generate(catalogue);
			assert.equal(names.length, allTools(catalogue).length);
		});

		it("every tool gets its own module in the api/ tree", () => {
			const { files } = generate(catalogue);
			for (const { server, name } of allTools(catalogue)) {
				const path = `${server}/${pyIdent(name)}.py`;
				assert.ok(files[path], `missing module for ${server}.${name} (expected ${path})`);
			}
		});

		it("every server gets an index and an __init__", () => {
			const { files } = generate(catalogue);
			for (const { server } of catalogue) {
				assert.ok(files[`${server}/INDEX.md`], `missing ${server}/INDEX.md`);
				assert.ok(files[`${server}/__init__.py`], `missing ${server}/__init__.py`);
			}
		});

		it("the root index names every server", () => {
			const { files } = generate(catalogue);
			for (const { server } of catalogue) {
				assert.ok(files["INDEX.md"].includes(server), `root index omits ${server}`);
			}
		});
	});

	describe(`fairness — ${label}`, () => {
		it("the tool-def description is the authored description, unmodified", () => {
			const { toolDefs } = generate(catalogue);
			for (const raw of allTools(catalogue)) {
				const def = toolDefs.find((d) => d.name === wireName(raw.server, raw.name));
				assert.equal(def.description, (raw.description ?? "").trim());
			}
		});

		it("the api/ module docstring carries the authored description", () => {
			const { files } = generate(catalogue);
			for (const raw of allTools(catalogue)) {
				if (!raw.description) continue;
				const module = files[`${raw.server}/${pyIdent(raw.name)}.py`];
				const firstLine = raw.description.trim().split("\n")[0];
				assert.ok(module.includes(firstLine), `${raw.name} module lost its description`);
			}
		});

		it("the TOC line carries the authored summary", () => {
			const { tocLines } = generate(catalogue);
			for (const raw of allTools(catalogue)) {
				if (!raw.description) continue;
				const firstLine = raw.description.trim().split("\n")[0];
				const line = tocLines.find((l) => l.includes(`.${pyIdent(raw.name)}(`));
				assert.ok(line, `no TOC line for ${raw.name}`);
				assert.ok(line.includes(firstLine), `TOC line for ${raw.name} lost its summary`);
			}
		});

		it("the JSON schema is passed through untouched", () => {
			const { toolDefs } = generate(catalogue);
			for (const raw of allTools(catalogue)) {
				if (!raw.inputSchema) continue;
				const def = toolDefs.find((d) => d.name === wireName(raw.server, raw.name));
				assert.deepEqual(def.input_schema, raw.inputSchema);
			}
		});
	});

	describe(`wire fidelity — ${label}`, () => {
		it("calls use the original MCP tool name, not the Python identifier", () => {
			const { files } = generate(catalogue);
			for (const { server, name } of allTools(catalogue)) {
				const module = files[`${server}/${pyIdent(name)}.py`];
				assert.ok(module.includes(`"${name}"`), `${name} module does not send its real MCP name`);
			}
		});

		it("calls use the original parameter names as keys", () => {
			const { files } = generate(catalogue);
			for (const raw of allTools(catalogue)) {
				const props = Object.keys(raw.inputSchema?.properties ?? {});
				const module = files[`${raw.server}/${pyIdent(raw.name)}.py`];
				for (const prop of props) {
					assert.ok(module.includes(`"${prop}":`), `${raw.name} does not send parameter ${prop}`);
				}
			}
		});
	});

	describe(`generated Python is valid — ${label}`, () => {
		it("every module compiles", () => {
			// The decisive test. A module that does not parse removes its tool from
			// the codemode arm at import time, with no error the harness would catch.
			const { files } = generate(catalogue);
			const dir = mkdtempSync(join(tmpdir(), "harness-api-"));
			try {
				const pyFiles = [];
				for (const [rel, content] of Object.entries(files)) {
					if (!rel.endsWith(".py")) continue;
					const path = join(dir, rel);
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, content);
					pyFiles.push(path);
				}
				assert.ok(pyFiles.length > 0, "no Python modules were generated");
				for (const path of pyFiles) {
					assert.doesNotThrow(
						() => execFileSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", path], { stdio: "pipe" }),
						`generated module does not parse: ${path}`,
					);
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
}

describe("determinism", () => {
	it("two generations are byte-identical", () => {
		const a = generate(realistic);
		const b = generate(realistic);
		assert.deepEqual(a.files, b.files);
		assert.deepEqual(a.toolDefs, b.toolDefs);
		assert.deepEqual(a.tocLines, b.tocLines);
	});
});

describe("residency scaling", () => {
	// The headline measurement: how the containers diverge as the catalogue grows.
	// MCP-Bench is ~250 tools, so that is the row that matters.
	it("reports L1/L2/L4 cost across catalogue sizes", () => {
		const rows = [];
		for (const count of [10, 50, 250]) {
			const { toolDefs, tocLines, names } = generate(synthetic(count));
			const l1 = countTokens(names.join("\n"));
			const l2 = countTokens(tocLines.join("\n"));
			const l4 = countTokens(JSON.stringify(toolDefs));
			rows.push({ tools: count, L1: l1, L2: l2, L4: l4, "L4/L2": +(l4 / l2).toFixed(2) });
		}
		console.table(rows);

		const biggest = rows.at(-1);
		assert.ok(biggest.L1 < biggest.L2, "L1 should cost less than L2");
		assert.ok(biggest.L2 < biggest.L4, "L2 should cost less than L4");
	});

	it("cost grows roughly linearly in tool count", () => {
		// Sub-linear growth would mean the renderer is truncating, which would make
		// a large catalogue look cheap while quietly hiding tools.
		const small = generate(synthetic(10));
		const large = generate(synthetic(100));
		const ratio = countTokens(large.tocLines.join("\n")) / countTokens(small.tocLines.join("\n"));
		assert.ok(ratio > 8 && ratio < 12, `expected ~10x growth, got ${ratio.toFixed(2)}x`);
	});
});

describe("wire names satisfy provider constraints", () => {
	// Anthropic requires ^[a-zA-Z0-9_-]{1,64}$. Real server names contain spaces
	// and server+tool can exceed 64 chars, so a regression here rejects the whole
	// request rather than degrading gracefully.
	const VALID = /^[a-zA-Z0-9_-]{1,64}$/;

	it("sanitizes spaces and punctuation", () => {
		assert.match(wireName("OpenAPI Explorer", "getApiOverview"), VALID);
		assert.equal(wireName("OpenAPI Explorer", "getApiOverview"), "OpenAPI_Explorer__getApiOverview");
	});

	it("caps length at 64 characters", () => {
		const name = wireName("A Very Long Server Name That Goes On", "an_extremely_long_tool_name_that_also_goes_on_and_on");
		assert.ok(name.length <= 64, `got ${name.length} chars`);
		assert.match(name, VALID);
	});

	it("keeps the tool half when truncating, since it carries more information", () => {
		const name = wireName("Some Extremely Long Server Name Here Indeed", "distinctive_tool");
		assert.ok(name.includes("distinctive_tool"), `tool name was truncated away: ${name}`);
	});

	it("produces valid, unique names across the whole realistic catalogue", () => {
		const { toolDefs } = generate(realistic);
		const names = toolDefs.map((d) => d.name);
		for (const n of names) assert.match(n, VALID);
		assert.equal(new Set(names).size, names.length, "wire names collided");
	});

	it("carries the real server and tool back for the proxy", () => {
		// The mangled name is what the model sees; the proxy needs the originals.
		const { toolDefs } = generate(realistic);
		for (const def of toolDefs) {
			assert.ok(def._mcp?.server, `${def.name} lost its server`);
			assert.ok(def._mcp?.tool, `${def.name} lost its tool name`);
		}
	});
});

describe("schema bounds reach the docstring (W126)", () => {
	// The validator enforced 136 constraints the docstrings never stated, so the
	// agent's first in-range value was a guess: 1.57 ArgumentError turns per job,
	// 20 of them `max_timeout` > 60. The docstring and `_schemas.json` are rendered
	// from the same spec, so the sentence and the error can no longer disagree.
	const tool = normalizeTool({
		name: "bounded",
		description: "Bounded.",
		inputSchema: {
			type: "object",
			properties: {
				max_timeout: { type: "number", description: "Maximum seconds to wait", minimum: 1, maximum: 60 },
				prompt: { type: "string", minLength: 1, maxLength: 7000 },
				references: { type: "array", items: { type: "string" }, maxItems: 4 },
				rate: { type: "number", exclusiveMinimum: 0 },
				free: { type: "string", description: "No bounds" },
			},
			required: ["prompt"],
		},
	});
	const byName = Object.fromEntries(tool.params.map((p) => [p.name, p]));

	it("renders one sentence per bounded parameter, in the validator's terms", () => {
		assert.equal(constraintNote(byName.max_timeout), "Range: 1 <= value <= 60.");
		assert.equal(constraintNote(byName.prompt), "Length: 1 to 7000 characters.");
		assert.equal(constraintNote(byName.references), "Items: at most 4.");
		assert.equal(constraintNote(byName.rate), "Range: 0 < value.");
		assert.equal(constraintNote(byName.free), null);
	});

	it("puts the sentence under the parameter in both layouts and in the resident docs", () => {
		const cat = [{ server: "svc", tools: [{ name: "bounded", description: "Bounded.", inputSchema: tool.schema }] }];
		for (const apiLayout of ["per-method", "consolidated"]) {
			const { files } = generate(cat, { apiLayout, validateArgs: true, constraintNotes: true });
			const text = Object.values(files).join("\n");
			assert.match(text, /max_timeout: Maximum seconds to wait Optional\.\n\s+Range: 1 <= value <= 60\./, apiLayout);
			assert.match(text, /prompt:\n\s+Length: 1 to 7000 characters\./, apiLayout);
		}
		assert.match(renderFullDocs(cat[0].tools.map(normalizeTool), { server: "svc", constraintNotes: true }), /Range: 1 <= value <= 60\./);
	});

	it("is opt-in: without constraintNotes no tree or resident doc changes", () => {
		// The MCP-Bench and AppWorld numbers were measured on trees without these
		// lines (AppWorld alone has 324 bounded parameters, ~10.7k chars of L4 text).
		const cat = [{ server: "svc", tools: [{ name: "bounded", description: "Bounded.", inputSchema: tool.schema }] }];
		for (const apiLayout of ["per-method", "consolidated"]) {
			const text = Object.values(generate(cat, { apiLayout, validateArgs: true }).files).join("\n");
			assert.doesNotMatch(text, /Range: |Length: |Items: /, apiLayout);
		}
		assert.doesNotMatch(renderFullDocs(cat[0].tools.map(normalizeTool), { server: "svc" }), /Range: /);
	});
});
