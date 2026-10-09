/**
 * What a port reads off `generate()` instead of rebuilding it: Python names set
 * apart from wire names, the module list, call paths and per-module TOC, server /
 * category module collisions, the startup-hook manifest and the SDK preset.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { generate } from "../generate.mjs";
import { PRODUCT_PORT_OPTIONS, SDK_PORT_OPTIONS } from "../generator-presets.mjs";
import { HOOK_ENV, STARTUP_HOOKS, startupFiles } from "../startup-hooks.mjs";

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), "../../runtime");

const tool = (name, extra = {}) => ({
	name,
	description: `${name}.`,
	inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
	...extra,
});

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function writeTree(files) {
	const dir = mkdtempSync(join(tmpdir(), "harness-port-surface-"));
	dirs.push(dir);
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, "api", rel)), { recursive: true });
		writeFileSync(join(dir, "api", rel), text);
	}
	return dir;
}

describe("a Python name set apart from the wire name", () => {
	const CAT = [
		{ server: "maker", tools: [tool("kernel_read", { category: "session", call_name: "read" }), tool("make_image", { category: "image" })] },
		{ server: "notion", tools: [tool("notion__search", { pyName: "search" })] },
	];

	it("names the function, and _call still sends the wire name, for category and server tools", () => {
		const { files, callPaths } = generate(CAT, { apiLayout: "consolidated" });
		assert.match(files["session.py"], /^async def read\(prompt: str\)/m);
		assert.match(files["session.py"], /_call\("maker", "kernel_read"/);
		assert.match(files["notion.py"], /^async def search\(prompt: str\)/m);
		assert.match(files["notion.py"], /_call\("notion", "notion__search"/);
		assert.deepEqual(callPaths["api.session.read"], { server: "maker", tool: "kernel_read" });
		assert.deepEqual(callPaths["api.notion.search"], { server: "notion", tool: "notion__search" });
	});

	it("is the name an ArgumentError quotes", () => {
		const dir = writeTree(generate(CAT, { apiLayout: "consolidated", validateArgs: true }).files);
		const py = `
import asyncio, sys
sys.path.insert(0, ${JSON.stringify(dir)})
import api.session
try:
    asyncio.run(api.session.read(prompt=3))
except TypeError as e:
    print(e)
`;
		assert.match(execFileSync("python3", ["-c", py], { encoding: "utf8" }), /^api\.session\.read: /);
	});

	it("leaves the client's lookup out when no tool is renamed", () => {
		const { files } = generate([{ server: "s", tools: [tool("a")] }], { validateArgs: true });
		assert.doesNotMatch(files["_client.py"], /functions/);
		assert.equal("functions" in JSON.parse(files["_schemas.json"]), false);
	});
});

describe("modules, call paths and the per-module TOC", () => {
	const CAT = [{ server: "acts", tools: [tool("create_image_a", { category: "image" }), tool("create_image_b", { category: "image" }), tool("edit_video", { category: "video" }), tool("ping")] }];

	it("lists every importable module with its functions and wire tools", () => {
		const { modules } = generate(CAT, { apiLayout: "consolidated" });
		assert.deepEqual(
			modules.map((m) => [m.module, m.server, m.names, m.tools]),
			[
				["image", "acts", ["create_image_a", "create_image_b"], ["create_image_a", "create_image_b"]],
				["video", "acts", ["edit_video"], ["edit_video"]],
				["acts", "acts", ["ping"], ["ping"]],
			],
		);
	});

	it("maps each call path to its wire tool, in either layout", () => {
		assert.deepEqual(Object.keys(generate(CAT, { apiLayout: "consolidated" }).callPaths).sort(), ["api.acts.ping", "api.image.create_image_a", "api.image.create_image_b", "api.video.edit_video"]);
		const perMethod = generate(CAT);
		assert.deepEqual(perMethod.modules.map((m) => m.module), ["acts"]);
		assert.deepEqual(perMethod.callPaths["api.acts.edit_video"], { server: "acts", tool: "edit_video" });
	});

	it("renders one TOC line per module: path, count and operation families", () => {
		assert.deepEqual(generate(CAT, { apiLayout: "consolidated" }).moduleToc, [
			"  api.acts     1 tool — ping",
			"  api.image   2 tools — create_image ×2 (a, b)",
			"  api.video    1 tool — edit_video",
		]);
	});
});

describe("a server module and a category module with one name", () => {
	const CAT = [
		{ server: "maker", tools: [tool("notion_import", { category: "notion" }), tool("make_image", { category: "image" })] },
		{ server: "notion", tools: [tool("search")] },
	];

	it("renames the server's module, keeping both files and the server's wire name", () => {
		const { files, modules } = generate(CAT, { apiLayout: "consolidated" });
		assert.match(files["notion.py"], /async def notion_import/);
		assert.match(files["notion_server.py"], /_call\("notion", "search"/);
		assert.deepEqual(modules.map((m) => m.module).sort(), ["image", "notion", "notion_server"]);
	});

	it("takes the suffix from serverModuleSuffix, and null refuses the catalogue", () => {
		assert.ok("notion_connector.py" in generate(CAT, { apiLayout: "consolidated", serverModuleSuffix: "connector" }).files);
		assert.throws(() => generate(CAT, { apiLayout: "consolidated", serverModuleSuffix: null }), /server "notion" and a category both render api\/notion\.py/);
	});

	it("covers a server whose own category carries its name", () => {
		const own = [{ server: "image", tools: [tool("make", { category: "image" }), tool("ping")] }];
		const { files } = generate(own, { apiLayout: "consolidated" });
		assert.match(files["image.py"], /async def make/);
		assert.match(files["image_server.py"], /async def ping/);
	});

	it("leaves a catalogue without the collision as it was", () => {
		const fine = [CAT[0], { server: "slack", tools: [tool("post")] }];
		assert.deepEqual(Object.keys(generate(fine, { apiLayout: "consolidated" }).files).filter((f) => f.endsWith(".py")).sort(), ["__init__.py", "_client.py", "image.py", "maker.py", "notion.py", "slack.py"]);
	});
});

describe("the startup-hook manifest", () => {
	it("names hooks that exist, in the chain's order, with the env that turns them on", () => {
		assert.deepEqual(STARTUP_HOOKS, ["eperm_correction.py", "api_layout_correction.py", "api_prebind.py", "api_signature_correction.py", "api_doc_expansion.py"]);
		for (const name of STARTUP_HOOKS) assert.ok(existsSync(join(RUNTIME, name)), name);
		assert.equal(HOOK_ENV.HARNESS_API_LAYOUT_CORRECTION, "1");
	});

	it("renders startup files whose names sort in load order", () => {
		const files = startupFiles();
		assert.deepEqual(Object.keys(files).sort(), Object.keys(files));
		assert.deepEqual(Object.keys(files), STARTUP_HOOKS.map((n, i) => `${String(i * 10).padStart(2, "0")}-${n}`));
		assert.equal(files["00-eperm_correction.py"], readFileSync(join(RUNTIME, "eperm_correction.py"), "utf8"));
	});
});

describe("SDK_PORT_OPTIONS", () => {
	const out = { title: "MadeOutput", type: "object", additionalProperties: false, properties: { id: { type: "string", format: "product-asset-ref" } } };
	const CAT = [{ server: "maker", tools: [tool("make_image", { category: "image", outputSchema: out }), tool("judge_tool", { launches: true, outputSchema: out })] }];

	it("holds values only, and keeps PRODUCT_PORT_OPTIONS' ref vocabulary", () => {
		assert.deepEqual(JSON.parse(JSON.stringify(SDK_PORT_OPTIONS)), { ...SDK_PORT_OPTIONS });
		assert.deepEqual(SDK_PORT_OPTIONS.refKinds, PRODUCT_PORT_OPTIONS.refKinds);
	});

	it("renders a tree that names no experiment-lab tool", () => {
		const text = Object.values(generate(CAT, SDK_PORT_OPTIONS).files).join("\n");
		assert.doesNotMatch(text, /api\.assets\.read|api\.review\.result|agent_tools|create_image_gpt_image|nano_banana/);
		assert.match(Object.values(generate(CAT, { ...PRODUCT_PORT_OPTIONS, apiLayout: "consolidated", typedReturns: true }).files).join("\n"), /api\.assets\.read/);
	});
});
