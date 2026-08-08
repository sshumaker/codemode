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
import { generate, normalizeTool, pyIdent, signature } from "../generate.mjs";
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
				const def = toolDefs.find((d) => d.name === `${raw.server}__${raw.name}`);
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
				const line = tocLines.find((l) => l.startsWith(`${raw.server}.${raw.name}(`));
				assert.ok(line, `no TOC line for ${raw.name}`);
				assert.ok(line.includes(firstLine), `TOC line for ${raw.name} lost its summary`);
			}
		});

		it("the JSON schema is passed through untouched", () => {
			const { toolDefs } = generate(catalogue);
			for (const raw of allTools(catalogue)) {
				if (!raw.inputSchema) continue;
				const def = toolDefs.find((d) => d.name === `${raw.server}__${raw.name}`);
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
