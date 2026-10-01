/**
 * Typed parameters, compiled from each tool's inputSchema (bench/input-types.mjs).
 *
 * PROVENANCE. A structured parameter rendered `manifest: dict`, and the desktop
 * bridge's first agent-written plugin was built against exactly that surface: the
 * agent assembled the dict key by key from a docstring example and learned what was
 * wrong from the error after the call. Typed returns already made results classes;
 * this is the input half, so every parameter and every return value of an API the
 * agent calls is a declared type.
 *
 * Grouped by the ways this could be wrong: the default tree could move (an earlier
 * benchmark's condition changing under it), the class could disagree with the
 * schema, the wrapper could accept what the signature denies, or two classes could
 * collide in the one `_types.py`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { generate } from "../generate.mjs";

const KERNEL_PY = join(homedir(), ".prime/agent/kernel-venv/bin/python");
const PYTHON = existsSync(KERNEL_PY) ? KERNEL_PY : "python3";

const MANIFEST = {
	title: "PluginManifest",
	type: "object",
	description: "What a plugin touches.",
	properties: {
		id: { type: "string", description: "Lowercase id." },
		app: { title: "AppRef", type: "object", properties: { bundle_id: { type: "string" }, name: { type: "string" } }, required: ["bundle_id"] },
		capabilities: { type: "array", items: { type: "string", enum: ["script", "ax"] } },
		files: { type: "array", items: { title: "FileScope", type: "object", properties: { path: { type: "string" }, access: { type: "string", enum: ["read", "read-write"] } }, required: ["path", "access"] } },
		from: { type: "string", description: "A wire name that is a Python keyword." },
	},
	required: ["id", "app", "capabilities"],
};

const CATALOGUE = [
	{
		server: "desk",
		tools: [
			{
				name: "install_plugin",
				description: "Install a plugin.",
				inputSchema: {
					type: "object",
					properties: {
						manifest: MANIFEST,
						skills: { type: "object", additionalProperties: { type: "string" } },
						layers: { type: "array", items: { type: "object", properties: { name: { type: "string" }, opacity: { type: "number" } }, required: ["name"] } },
						targets: { type: "object", additionalProperties: { type: "object", properties: { $file: { type: "string" } }, required: ["$file"] } },
						label: { type: "string" },
					},
					required: ["manifest"],
				},
				outputSchema: { title: "Installed", type: "object", properties: { installed: { type: "string" } }, required: ["installed"] },
			},
			{
				// A tool whose OUTPUT class is also called AppRef, with a different shape:
				// the input class must not shadow it in the shared _types.py.
				name: "which_app",
				description: "Which app.",
				inputSchema: { type: "object", properties: {} },
				outputSchema: { title: "AppRef", type: "object", properties: { display: { type: "string" } }, required: ["display"] },
			},
			{
				name: "status",
				description: "Status.",
				inputSchema: { type: "object", properties: {} },
				outputSchema: { title: "Status", type: "object", properties: { running: { type: "boolean" } }, required: ["running"] },
			},
		],
	},
];

const OPTS = { apiLayout: "consolidated", typedReturns: true, validateArgs: true, waitSurface: false, serverAlias: false };

function writeTree(files) {
	const root = mkdtempSync(join(tmpdir(), "typed-inputs-"));
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, "api", rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

function runPython(root, code) {
	return execFileSync(PYTHON, ["-c", code], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
}

const HARNESS = `
import asyncio, json
import api.desk as d
sent = []
async def fake(server, tool, args, _expect=None):
    # _client drops arguments left unset (UNSET) before sending; do the same here.
    from api._client import UNSET
    sent.append({k: v for k, v in args.items() if v is not UNSET})
    return None
d._call = fake
def run(coro):
    asyncio.run(coro)
    return sent[-1]
`;

describe("the default tree does not move", () => {
	it("is byte-identical with typedInputs off and absent", () => {
		assert.deepEqual(generate(CATALOGUE, OPTS).files, generate(CATALOGUE, { ...OPTS, typedInputs: false }).files);
	});

	it("keeps structured parameters as dict when off", () => {
		const { files } = generate(CATALOGUE, OPTS);
		assert.match(files["desk.py"], /manifest: dict/);
		assert.doesNotMatch(files["_types.py"], /class ToolInput/);
	});

	it("refuses typed inputs on an untyped tree", () => {
		assert.throws(() => generate(CATALOGUE, { ...OPTS, typedReturns: false, typedInputs: true }), /typedInputs needs typed returns/);
	});
});

describe("typed inputs", () => {
	const { files } = generate(CATALOGUE, { ...OPTS, typedInputs: true });

	it("names the class in the signature, for one, a list, and a map", () => {
		const sig = files["desk.py"].split("\n").find((l) => l.startsWith("async def install_plugin"));
		assert.match(sig, /manifest: PluginManifest/);
		assert.match(sig, /layers: list\[InstallPluginLayersItem\] \| None/);
		assert.match(sig, /targets: dict\[str, InstallPluginTargetsValue\] \| None/);
		assert.match(sig, /skills: dict\[str, str\] \| None/);
		assert.match(sig, /label: str \| None/);
	});

	it("does not shadow an output class of the same name", () => {
		assert.match(files["_types.py"], /class AppRef\(ToolResult\)/);
		assert.match(files["_types.py"], /class AppRefInput\(ToolInput\)/);
	});

	it("round-trips wire names that are not identifiers, and drops unset optionals", () => {
		const root = writeTree(files);
		try {
			const out = runPython(root, `${HARNESS}
from api._types import PluginManifest, AppRefInput, FileScope, InstallPluginLayersItem, InstallPluginTargetsValue
m = PluginManifest(id="numbers", app=AppRefInput(bundle_id="com.apple.iWork.Numbers"), capabilities=["script"],
                   files=[FileScope(path="~/Documents/Work", access="read-write")], from_="cloud")
p = run(d.install_plugin(manifest=m, layers=[InstallPluginLayersItem(name="bg")],
                         targets={"deck": InstallPluginTargetsValue(_file_="/tmp/x.pdf")}))
print(json.dumps(p, sort_keys=True))
`);
			assert.deepEqual(JSON.parse(out), {
				layers: [{ name: "bg" }],
				manifest: { app: { bundle_id: "com.apple.iWork.Numbers" }, capabilities: ["script"], files: [{ access: "read-write", path: "~/Documents/Work" }], from: "cloud", id: "numbers" },
				targets: { deck: { $file: "/tmp/x.pdf" } },
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a dict where a class is declared, at every shape", () => {
		const root = writeTree(files);
		try {
			const out = runPython(root, `${HARNESS}
from api._types import PluginManifest, AppRefInput
m = PluginManifest(id="x", app=AppRefInput(bundle_id="y"), capabilities=[])
for kwargs in ({"manifest": {"id": "x"}}, {"manifest": m, "layers": [{"name": "bg"}]}, {"manifest": m, "targets": {"a": {"$file": "x"}}}, {"manifest": m, "layers": "bg"}):
    try:
        run(d.install_plugin(**kwargs))
        print("accepted")
    except TypeError as e:
        print("refused:", str(e).split(":")[0])
print("sent", len(sent))
`);
			assert.deepEqual(out.trim().split("\n"), ["refused: manifest takes PluginManifest, not dict", "refused: layers takes InstallPluginLayersItem, not dict", "refused: targets takes InstallPluginTargetsValue, not dict", "refused: layers takes a list of InstallPluginLayersItem, not str", "sent 0"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails at construction on a misspelled or missing field, before any call", () => {
		const root = writeTree(files);
		try {
			const out = runPython(root, `
from api._types import PluginManifest, AppRefInput
for build in (lambda: PluginManifest(id="x", app=AppRefInput(bundle_id="y"), capabilites=[]), lambda: PluginManifest(id="x", capabilities=[])):
    try:
        build()
        print("built")
    except TypeError as e:
        print("TypeError")
`);
			assert.deepEqual(out.trim().split("\n"), ["TypeError", "TypeError"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("names nested output records by their schema title only when asked (schemaTitles)", () => {
		const cat = [{ server: "s", tools: [{ name: "apps", description: "d", inputSchema: { type: "object", properties: {} },
			outputSchema: { title: "Macs", type: "object", properties: { macs: { type: "array", items: { title: "Mac", type: "object", properties: { name: { type: "string" } }, required: ["name"] } } }, required: ["macs"] } }] }];
		assert.match(generate(cat, OPTS).files["_types.py"], /class MacsMacsItem\(ToolResult\)/);
		const titled = generate(cat, { ...OPTS, schemaTitles: true }).files["_types.py"];
		assert.match(titled, /class Mac\(ToolResult\)/);
		assert.match(titled, /macs: list\[Mac\]/);
	});

	it("documents each class and points the parameter at it", () => {
		assert.match(files["desk.py"], /A PluginManifest; help\(PluginManifest\) lists its fields\./);
		assert.match(files["_types.py"], /class PluginManifest\(ToolInput\):\n    """What a plugin touches\.[\s\S]*?id: Lowercase id\./);
		assert.doesNotMatch(files["desk.py"], /Example: manifest=/, "a dict example next to a class-typed parameter contradicts it");
	});
});
