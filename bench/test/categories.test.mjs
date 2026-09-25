/**
 * The consolidated layout groups by category, when the catalogue carries one.
 *
 * Measured motivation: the port's consolidated tree produced
 * `api/creative_actions.py` at 152KB across 45 tools — a shape no API
 * reference has. `stripe.py` is one module per resource, and the affordance rule
 * says get as close to the in-distribution shape as the constraints allow. The
 * registry already knows each action's category, so the grouping is READ from the
 * catalogue rather than invented by the compiler.
 *
 * The property that matters most is the one that has nothing to do with ergonomics:
 * where a function is DOCUMENTED must be independent of where it is DISPATCHED.
 * `_call`'s first argument is the real server name in every module, or a
 * reorganisation of the tree would silently retarget the transport.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { generate } from "../generate.mjs";

const tool = (name, category) => ({
	name,
	...(category ? { category } : {}),
	description: `${name.replace(/_/g, " ")}.`,
	inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
});

const PRODUCT = [
	{
		server: "creative_actions",
		tools: [
			tool("create_image_nano_banana_pro", "image"),
			tool("blend_image", "image"),
			tool("create_video_ray3", "video"),
			tool("reframe_video", "video"),
			tool("read_app_state"),
		],
	},
];
const consolidated = (catalogue, options = {}) =>
	generate(catalogue, { apiLayout: "consolidated", validateArgs: true, ...options }).files;

describe("grouping by category", () => {
	const files = consolidated(PRODUCT);

	it("emits one flat module per category, importable as api.<category>", () => {
		// Flat, not `api/<server>/<category>.py`: the ask is `import api.image`, and a
		// nested path spends the ergonomic win on a directory nobody types.
		assert.ok(files["image.py"], "no api/image.py");
		assert.ok(files["video.py"], "no api/video.py");
		assert.match(files["image.py"], /async def create_image_nano_banana_pro/);
		assert.match(files["image.py"], /async def blend_image/);
		assert.equal(/async def create_video_ray3/.test(files["image.py"]), false, "a video tool landed in image");
	});

	it("leaves an uncategorised tool in the server module", () => {
		assert.match(files["creative_actions.py"], /async def read_app_state/);
	});

	it("keeps the server module importable as an alias for the moved tools", () => {
		// Mid-comparison insurance: a call shape written before the split must not
		// become an AttributeError. It re-exports rather than re-documents.
		const alias = files["creative_actions.py"];
		assert.match(alias, /from \.image import \(\n(\s+create_image_nano_banana_pro,\n)/);
		assert.match(alias, /from \.video import \(/);
		assert.match(alias, /"create_image_nano_banana_pro",/);
		// The docstring lives in ONE module, so `grep -ril` finds the real one.
		assert.equal((alias.match(/create image nano banana pro\./g) ?? []).length, 0);
	});

	it("qualifies a category two servers both claim, rather than overwriting", () => {
		const two = [
			{ server: "alpha", tools: [tool("a_one", "image")] },
			{ server: "beta", tools: [tool("b_one", "image")] },
		];
		const both = consolidated(two);
		assert.ok(both["alpha_image.py"] && both["beta_image.py"], Object.keys(both).join(", "));
		assert.equal("image.py" in both, false, "a collision silently claimed the flat name");
	});

	it("renders exactly the tree it always did when nothing carries a category", () => {
		const plain = PRODUCT.map((s) => ({ ...s, tools: s.tools.map((t) => ({ ...t, category: undefined })) }));
		const before = consolidated(plain);
		assert.ok(before["creative_actions.py"]);
		assert.equal("image.py" in before, false);
		assert.match(before["INDEX.md"], /\| package \| server \| tools \|/);
	});
});

describe("the transport is independent of the module a function lives in", () => {
	const dirs = [];
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	it("a category module still posts server='creative_actions'", () => {
		// Textual first — every `_call` in every module names the real server.
		const files = consolidated(PRODUCT);
		for (const module of ["image.py", "video.py"]) {
			for (const call of files[module].match(/_call\(\n?\s*"([^"]+)"/g) ?? []) {
				assert.match(call, /"creative_assets|creative_actions"/);
			}
		}
	});

	it("and does so when actually called, through the real generated tree", () => {
		// The assertion that cannot be satisfied by a plausible-looking string: what
		// the stub proxy RECEIVED after `import api.image`.
		const dir = mkdtempSync(join(tmpdir(), "harness-categories-"));
		dirs.push(dir);
		for (const [rel, content] of Object.entries(consolidated(PRODUCT))) {
			const path = join(dir, "api", rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		const script = [
			"import asyncio, json, os, sys, threading",
			"from http.server import BaseHTTPRequestHandler, HTTPServer",
			"SEEN = []",
			"class H(BaseHTTPRequestHandler):",
			"    def do_POST(self):",
			"        SEEN.append(json.loads(self.rfile.read(int(self.headers['content-length']))))",
			"        out = json.dumps({'ok': True, 'text': 'RESULT'}).encode()",
			"        self.send_response(200); self.send_header('content-length', str(len(out))); self.end_headers(); self.wfile.write(out)",
			"    def log_message(self, *a): pass",
			"s = HTTPServer(('127.0.0.1', 0), H)",
			"threading.Thread(target=s.serve_forever, daemon=True).start()",
			"os.environ['HARNESS_MCP_PROXY'] = f'http://127.0.0.1:{s.server_port}'",
			`sys.path.insert(0, ${JSON.stringify(dir)})`,
			"import api.image, api.creative_actions as alias",
			"async def main():",
			"    await api.image.create_image_nano_banana_pro(prompt='x')",
			"    await alias.blend_image(prompt='y')",
			"asyncio.run(main())",
			"print(json.dumps([(c['server'], c['tool']) for c in SEEN]))",
		].join("\n");
		const out = execFileSync("python3", ["-c", script], { encoding: "utf8", stdio: "pipe" });
		assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)), [
			["creative_actions", "create_image_nano_banana_pro"],
			["creative_actions", "blend_image"],
		]);
	});
});

describe("the root INDEX lists what can be imported", () => {
	const index = consolidated(PRODUCT)["INDEX.md"];

	it("is one row per module, with the app's own word for the group", () => {
		assert.match(index, /\| module \| what it holds \| server \| tools \|/);
		assert.match(index, /\| `api\.image` \| image \| creative_actions \| 2 \|/);
		assert.match(index, /\| `api\.video` \| video \| creative_actions \| 2 \|/);
		assert.match(index, /\| `api\.creative_actions` \| everything else in this app \| creative_actions \| 1 \|/);
	});

	it("counts modules, and tells the agent to import one", () => {
		assert.match(index, /5 tools in 3 modules/);
		assert.match(index, /import api\.<module>/);
		assert.match(index, /cat api\/<module>\.py/);
	});
});

describe("the module index, opt-in (W129)", () => {
	const index = consolidated(PRODUCT, { moduleIndex: true })["INDEX.md"];

	it("the column is the KINDS of operation, derived from the tool names, never the bare category word", () => {
		assert.match(index, /\| `api\.image` \| [^|]*\w[^|]* \| creative_actions \| 2 \|/);
		assert.doesNotMatch(index, /\| `api\.image` \| image \|/);
		assert.match(index, /\| `api\.video` \| [^|]+ \| creative_actions \| 2 \|/);
		assert.match(index, /\| `api\.creative_actions` \| [^|]+ \| creative_actions \| 1 \|/);
		assert.doesNotMatch(index, /everything else in this app/);
		assert.match(index, /head -60 api\/<module>\.py/);
	});

	it("each module's header lists its tools, one line each, before the full contracts", () => {
		const image = consolidated(PRODUCT, { moduleIndex: true })["image.py"];
		const header = image.slice(0, image.indexOf('"""', 3));
		assert.match(header, /Tools \(signature — what it does\):\n {2}api\.image\.create_image_nano_banana_pro\(prompt\) — create image nano banana pro\./);
		assert.match(header, /api\.image\.blend_image\(prompt\)/);
	});

	it("is off by default: the tree is the one rendered before the option existed", () => {
		const files = consolidated(PRODUCT);
		assert.doesNotMatch(files["image.py"], /Tools \(signature/);
		assert.doesNotMatch(files["INDEX.md"], /head -60/);
		assert.deepEqual(consolidated(PRODUCT, { moduleIndex: false }), files);
	});
});

describe("operationFamilies: kinds of operation, derived from names (W129)", async () => {
	const { operationFamilies } = await import("../generate.mjs");
	it("groups by the first two tokens, names the variants, and stands the rest alone", () => {
		const out = operationFamilies([
			"create_image_gpt_image_2", "create_image_nano_banana_pro", "create_image_seedream",
			"modify_image_gpt_image_2", "modify_image_nano_banana_2",
			"remove_background_sam3", "image_crop", "blend_image",
		]);
		assert.equal(out, "create_image ×3 (gpt, nano, seedream), modify_image ×2 (gpt, nano), blend_image, image_crop, remove_background_sam3");
	});
	it("caps the list and counts the remainder, so it stays a table of contents", () => {
		const out = operationFamilies(["read", "write", "edit", "link", "judge_tool", "label_asset", "search_web", "todo_write", "complete_job", "wait_for_assets"], { max: 4 });
		assert.match(out, /^complete_job, edit, judge_tool, label_asset, \+6 more$/);
	});
});
