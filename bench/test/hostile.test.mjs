/**
 * The compiler against inputs AppWorld never sends.
 *
 * Every case here was safe on AppWorld's dialect by LUCK — zero `"""` in
 * descriptions, no identifier collisions, string-only enums — and each one
 * broke silently or loudly on the first adversarial catalogue the 2026-08-15
 * review generated. The gate is IMPORT, not ast.parse: `Literal[true]` and a
 * shadowed duplicate def both parse cleanly and only fail (or lie) at import.
 *
 * The failure mode being pinned is the project's recurring one: per-method, a
 * broken tool silently DROPS from codemode while staying in vanilla's toolDefs
 * — a capability difference masquerading as a token saving; consolidated, the
 * whole app module is lost at once, which is at least loud.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { generate } from "../generate.mjs";
import { hostile } from "./fixtures/catalogue.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PROBE = join(ROOT, "bench/test/fixtures/layout_probe.py");

const dirs = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function materialize(options) {
	const generated = generate(hostile, options);
	const dir = mkdtempSync(join(tmpdir(), "harness-hostile-"));
	dirs.push(dir);
	for (const [rel, content] of Object.entries(generated.files)) {
		const path = join(dir, "api", rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return { generated, dir };
}

/** Import the whole tree for real; throws with Python's traceback on failure. */
function importSurface(dir) {
	return JSON.parse(execFileSync("python3", [PROBE, dir], { encoding: "utf8", stdio: "pipe" }));
}

for (const layout of ["per-method", "consolidated"]) {
	describe(`hostile catalogue, ${layout}: every module IMPORTS`, () => {
		const { generated, dir } = materialize({ apiLayout: layout });
		const surface = importSurface(dir); // throws = the finding regressed

		it("no tool was dropped: python sees every tool the catalogue ships", () => {
			const total = Object.values(surface).reduce((n, fns) => n + Object.keys(fns).length, 0);
			assert.equal(total, hostile.reduce((n, s) => n + s.tools.length, 0));
		});

		it("colliding servers get distinct packages, and the docs cite the real ones", () => {
			// "Math MCP" and "math-mcp" both normalize to math_mcp; the second must
			// be math_mcp_2 EVERYWHERE — a TOC line citing a module that does not
			// exist teaches the agent the tree cannot be trusted.
			assert.ok(surface.math_mcp, "math_mcp missing");
			assert.ok(surface.math_mcp_2, "math_mcp_2 missing — server dedupe regressed");
			const cited = generated.tocLines.filter((l) => l.startsWith("api.math_mcp"));
			assert.ok(cited.some((l) => l.startsWith("api.math_mcp.add(")), `TOC lost add: ${cited}`);
			assert.ok(cited.some((l) => l.startsWith("api.math_mcp_2.sub(")), `TOC cites a phantom package: ${cited}`);
			for (const name of generated.names.filter((n) => n.includes("math_mcp"))) {
				const pkg = name.split(".")[1];
				assert.ok(surface[pkg], `names list cites api.${pkg}, which does not import`);
			}
		});

		it("colliding tools both exist and route to their OWN wire names", () => {
			assert.ok(surface.traps.dup_name, "first of the colliding pair missing");
			assert.ok(surface.traps.dup_name_2, "second of the colliding pair missing — it used to shadow the first");
			// The wire identity must be preserved per tool: dup_name -> "dup-name",
			// dup_name_2 -> "dup_name". A shadow here calls the WRONG TOOL, no error.
			const source =
				layout === "consolidated"
					? generated.files["traps.py"]
					: `${generated.files["traps/dup_name.py"]}\n${generated.files["traps/dup_name_2.py"]}`;
			const routes = [...source.matchAll(/async def (dup_name(?:_2)?)\(|"traps",\s*\n?\s*"(dup[-_]name)"/g)];
			const order = routes.map((m) => m[1] ?? m[2]);
			assert.deepEqual(
				order,
				["dup_name", "dup-name", "dup_name_2", "dup_name"],
				`wire routing scrambled: ${order}`,
			);
		});

		it("colliding parameters are both callable", () => {
			assert.match(surface.traps.kwcollide.signature, /page_index/);
			assert.match(surface.traps.kwcollide.signature, /page_index_2/);
		});

		it("non-string enums become python literals, and object members degrade", () => {
			const sig = surface.traps.boolenum.signature;
			assert.match(sig, /Literal\[True, False, None\]/);
			assert.match(sig, /Literal\['fixed'\]/); // inspect.signature repr uses single quotes
			assert.match(sig, /Literal\[1, 2, 3\]/);
			assert.equal(/w:.*Literal/.test(sig), false, "an object enum member has no Literal spelling");
		});

		it('a `"""` in a description reaches the docstring, displayed intact', () => {
			const doc = surface.traps.inject_doc.doc;
			assert.match(doc, /Bad """ docstring/);
			assert.match(doc, /trailing backslash \\/);
		});

		it("a schema default surfaces in the docstring both arms can see", () => {
			assert.match(surface.traps.defaulted.doc, /Server-side default: 5\./);
		});

		it("vanilla's tool defs still carry the RAW identity — the wire is untouched", () => {
			const defs = generated.toolDefs.map((d) => d._mcp.tool);
			for (const name of ["dup-name", "dup_name", "get-user.profile".replace("get-user.profile", "inject_doc")])
				assert.ok(defs.includes(name), `${name} missing from toolDefs`);
		});
	});
}
