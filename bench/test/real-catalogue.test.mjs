/**
 * The generator against the real MCP-Bench catalogue.
 *
 * Synthetic fixtures caught reserved-word parameters; only the real catalogue
 * caught server names with spaces ("OpenAPI Explorer"), which produced package
 * directories that are not importable Python. Real schemas are also far heavier
 * than anything hand-written — a median description of 250 characters and a
 * maximum over 5,000 — so this file is the one that keeps the residency numbers
 * honest.
 *
 * Skips cleanly when the catalogue has not been dumped; run
 * `node bench/mcp-schemas.mjs` after `scripts/setup-mcp-bench.sh`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { generate, pyIdent, pyPackage } from "../generate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = join(ROOT, "bench/data/mcp-schemas.json");
const available = existsSync(DATA);

const load = () => JSON.parse(readFileSync(DATA, "utf8")).catalogue;

describe("real MCP-Bench catalogue", { skip: available ? false : "run bench/mcp-schemas.mjs first" }, () => {
	it("covers the servers and tools the paper describes", () => {
		const catalogue = load();
		const tools = catalogue.flatMap((s) => s.tools);
		assert.ok(catalogue.length >= 25, `expected ~27 servers, got ${catalogue.length}`);
		assert.ok(tools.length >= 200, `expected ~250 tools, got ${tools.length}`);
	});

	it("generates an importable package per server despite spaces in names", () => {
		// "OpenAPI Explorer" must not become a directory named "OpenAPI Explorer".
		const { files } = generate(load());
		for (const path of Object.keys(files)) {
			assert.ok(!/\s/.test(path), `generated path contains whitespace: ${path}`);
		}
	});

	it("gives every server a distinct package directory", () => {
		const catalogue = load();
		const { files } = generate(catalogue);
		const packages = new Set(Object.keys(files).filter((p) => p.includes("/")).map((p) => p.split("/")[0]));
		assert.equal(
			packages.size,
			catalogue.length,
			`${catalogue.length} servers collapsed into ${packages.size} packages`,
		);
	});

	it("keeps the real server name on the wire", () => {
		// The package is `openapi_explorer`; the call must still say "OpenAPI Explorer".
		const catalogue = load();
		const { files } = generate(catalogue);
		for (const { server, tools } of catalogue) {
			const pkg = pyPackage(server);
			const module = files[`${pkg}/${pyIdent(tools[0].name)}.py`];
			assert.ok(module, `no module for ${server}`);
			assert.ok(module.includes(`"${server}"`), `${server} module does not send its real server name`);
		}
	});

	it("every generated module compiles", () => {
		const { files } = generate(load());
		const dir = mkdtempSync(join(tmpdir(), "harness-real-api-"));
		try {
			const paths = [];
			for (const [rel, content] of Object.entries(files)) {
				if (!rel.endsWith(".py")) continue;
				const path = join(dir, rel);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, content);
				paths.push(path);
			}
			assert.ok(paths.length > 250, `expected >250 modules, got ${paths.length}`);
			// One interpreter invocation for all of them; 300 spawns is slow.
			const script = "import ast,sys\nfor p in sys.argv[1:]:\n ast.parse(open(p).read(), filename=p)\n";
			assert.doesNotThrow(
				() => execFileSync("python3", ["-c", script, ...paths], { stdio: "pipe" }),
				"a generated module does not parse",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("no tool is lost between the four renderings", () => {
		const catalogue = load();
		const total = catalogue.reduce((n, s) => n + s.tools.length, 0);
		const { toolDefs, tocLines, names, files } = generate(catalogue);
		assert.equal(toolDefs.length, total, "tool defs dropped a tool");
		assert.equal(tocLines.length, total, "TOC dropped a tool");
		assert.equal(names.length, total, "name list dropped a tool");
		// Exclude the package scaffolding: per-server __init__.py and the shared
		// root-level _client.py transport.
		const modules = Object.keys(files).filter(
			(p) => p.endsWith(".py") && !p.endsWith("__init__.py") && !p.endsWith("_client.py"),
		);
		assert.equal(modules.length, total, "api/ tree dropped a tool");
	});

	it("tools with no description still render", () => {
		// Seven real tools ship an empty description.
		const catalogue = load();
		const undocumented = catalogue.flatMap((s) =>
			s.tools.filter((t) => !t.description).map((t) => ({ server: s.server, name: t.name })),
		);
		if (undocumented.length === 0) return;
		const { files } = generate(catalogue);
		for (const { server, name } of undocumented) {
			const module = files[`${pyPackage(server)}/${pyIdent(name)}.py`];
			assert.ok(module, `undocumented tool ${server}.${name} produced no module`);
			assert.ok(module.includes('"""'), `undocumented tool ${name} has no docstring at all`);
		}
	});
});
