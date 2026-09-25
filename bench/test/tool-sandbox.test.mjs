/**
 * W121: the file tools (read/grep/find/ls) execute inside the kernel's sandbox.
 *
 * These tests run REAL seatbelt via the repo's own srt binary against the
 * COMPILED tree the arms exec (dist/core/tools/path-utils.js) — a source
 * assertion passes against a stale dist, which is how a condition leaked into
 * two eval jobs once before (see fs-guard.test.mjs's provenance note).
 *
 * What is pinned, because prose in a rules file is not a control:
 *   - inactive (env pair unset) is an identity passthrough, byte-for-byte
 *     upstream behavior;
 *   - active, a read INSIDE the policy succeeds and returns the exact bytes;
 *   - active, a read of a HOME path fails EACCES with the teaching text —
 *     the correction lives in the error, not the prompt;
 *   - the spawn wrap has the same argv shape as the kernel launch and the
 *     arm's preflight probe: `srt --settings <settings> <bin> <args...>`;
 *   - the child env is built from HARNESS_KERNEL_ENV_ALLOW, so a provider key
 *     in node's env never reaches the sandboxed child.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/core/tools/path-utils.js");
const SRT = join(ROOT, "node_modules/.bin/srt");
// Outside HOME, so the sandbox's deny-read [HOME] cannot block the interpreter
// itself — the arm solves the same problem by allow-listing the venv prefix.
const PYTHON = "/usr/bin/python3";

const canRun = process.platform === "darwin" && existsSync(SRT) && existsSync(PYTHON);

let mod;
let scratch;
let settingsPath;
const saved = {};
const ENV_KEYS = ["HARNESS_KERNEL_SANDBOX_BIN", "HARNESS_KERNEL_SANDBOX_SETTINGS", "HARNESS_KERNEL_ENV_ALLOW", "PRIME_AGENT_KERNEL_PYTHON", "FAKE_PROVIDER_KEY", "HARNESS_TOOL_SANDBOX_SCRIPT_DIR"];

function deactivate() {
	delete process.env.HARNESS_KERNEL_SANDBOX_BIN;
	delete process.env.HARNESS_KERNEL_SANDBOX_SETTINGS;
}

function activate() {
	process.env.HARNESS_KERNEL_SANDBOX_BIN = SRT;
	process.env.HARNESS_KERNEL_SANDBOX_SETTINGS = settingsPath;
	process.env.PRIME_AGENT_KERNEL_PYTHON = PYTHON;
	// The ops script must be readable inside the sandbox; scratch is allowed.
	process.env.HARNESS_TOOL_SANDBOX_SCRIPT_DIR = scratch;
}

before(async () => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	mod = await import(DIST);
	scratch = mkdtempSync(join(tmpdir(), "tool-sandbox-test-"));
	writeFileSync(join(scratch, "inside.txt"), "readable inside the sandbox\n");
	mkdirSync(join(scratch, "skills/test-skill"), { recursive: true });
	writeFileSync(join(scratch, "skills/test-skill/SKILL.md"), "# test skill\n");
	// The arm's settings shape (codemode_arm._write_sandbox_settings): deny the
	// HOME region, re-permit only the job's world. Here the world is `scratch`.
	settingsPath = join(scratch, "srt-settings.json");
	writeFileSync(
		settingsPath,
		JSON.stringify({
			filesystem: {
				allowWrite: [scratch, "/tmp"],
				denyWrite: [],
				denyRead: [process.env.HOME ?? "/nonexistent"],
				allowRead: [scratch, "/tmp"],
			},
			network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: true, allowAllUnixSockets: true },
		}),
	);
});

after(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("inactive: identity passthrough", () => {
	it("toolSandboxWrap returns the argv untouched", () => {
		deactivate();
		const { bin, args } = mod.toolSandboxWrap("/usr/bin/rg", ["-n", "x", "/some/dir"]);
		assert.equal(bin, "/usr/bin/rg");
		assert.deepEqual(args, ["-n", "x", "/some/dir"]);
	});

	it("toolSandboxOptions is empty, so tool creation is byte-identical to stock", () => {
		deactivate();
		assert.deepEqual(mod.toolSandboxOptions(), {});
	});
});

describe("active: the wrap has the kernel launch's argv shape", () => {
	it("srt --settings <settings> <bin> <args...>", () => {
		activate();
		const { bin, args } = mod.toolSandboxWrap("/usr/bin/rg", ["-n", "x"]);
		assert.equal(bin, SRT);
		assert.deepEqual(args, ["--settings", settingsPath, "/usr/bin/rg", "-n", "x"]);
	});
});

describe("active: real seatbelt enforcement", { skip: !canRun }, () => {
	it("a read inside the policy returns the exact bytes", async () => {
		activate();
		const ops = mod.toolSandboxOptions().read.operations;
		const buf = await ops.readFile(join(scratch, "inside.txt"));
		assert.equal(buf.toString(), "readable inside the sandbox\n");
	});

	it("a read under HOME fails EACCES with the teaching text", async () => {
		activate();
		const ops = mod.toolSandboxOptions().read.operations;
		// The repo itself lives under HOME, so its package.json both exists and
		// is denied — exactly the credential-file shape without touching one.
		await assert.rejects(ops.readFile(join(ROOT, "package.json")), (e) => {
			assert.match(e.message, /EACCES/);
			assert.match(e.message, /outside the job's world/);
			assert.match(e.message, /sandbox that runs your cells/);
			return true;
		});
	});

	it("ls's readdir works inside and is refused under HOME", async () => {
		activate();
		const ops = mod.toolSandboxOptions().ls.operations;
		const entries = await ops.readdir(scratch);
		assert.ok(entries.includes("inside.txt"));
		await assert.rejects(ops.readdir(join(ROOT, "bench")), /EACCES/);
	});

	it("grep's readFile is governed the same way", async () => {
		activate();
		const ops = mod.toolSandboxOptions().grep.operations;
		assert.equal(await ops.readFile(join(scratch, "inside.txt")), "readable inside the sandbox\n");
		await assert.rejects(ops.readFile(join(ROOT, "package.json")), /EACCES/);
	});

	it("a missing file is ENOENT, not EACCES — the errors stay diagnosable", async () => {
		activate();
		const ops = mod.toolSandboxOptions().read.operations;
		await assert.rejects(ops.readFile(join(scratch, "no-such-file.txt")), /ENOENT/);
	});
});

describe("W126: reading a skill directory returns its SKILL.md and references", { skip: !canRun }, () => {
	// Fixtures live under scratch/skills, which the test settings allow-read.
	// The model points the FILE `read` tool at `skills/<slug>` (a dir), where
	// the useful answer is SKILL.md + a references listing, and any other
	// directory reads as its listing.
	before(() => {
		mkdirSync(join(scratch, "skills/model-guide/references"), { recursive: true });
		writeFileSync(join(scratch, "skills/model-guide/SKILL.md"), "# model guide\n");
		writeFileSync(join(scratch, "skills/model-guide/references/image-models.md"), "img\n");
		writeFileSync(join(scratch, "skills/model-guide/references/audio-models.md"), "aud\n");
		// A skill without a references/ dir → content only, no listing block.
		mkdirSync(join(scratch, "skills/lonely"), { recursive: true });
		writeFileSync(join(scratch, "skills/lonely/SKILL.md"), "# lonely\n");
		// A plain directory that is not a skill (no SKILL.md).
		mkdirSync(join(scratch, "plain-dir"), { recursive: true });
	});

	it("a dir with SKILL.md + references returns content then the listing block", async () => {
		activate();
		const ops = mod.toolSandboxOptions().read.operations;
		await ops.access(join(scratch, "skills/model-guide")); // access must succeed for a skill dir
		const text = (await ops.readFile(join(scratch, "skills/model-guide"))).toString();
		assert.equal(
			text,
			"# model guide\n" +
				"\n\nThis skill's references, addressable by full path:\n" +
				"- skills/model-guide/references/audio-models.md\n" +
				"- skills/model-guide/references/image-models.md",
		);
	});

	it("a dir with SKILL.md but no references returns content only, no block", async () => {
		activate();
		const ops = mod.toolSandboxOptions().read.operations;
		const text = (await ops.readFile(join(scratch, "skills/lonely"))).toString();
		assert.equal(text, "# lonely\n");
	});

	// W128: a directory WITHOUT SKILL.md reads as its listing. Before this it was
	// EISDIR plus a hint to use ls — a correct hint that still cost the turn (W126
	// measured 0.81 EISDIR turns per job; the model's PATH was right, only the verb
	// was wrong).
	it("a directory WITHOUT SKILL.md reads as its listing, and access succeeds", async () => {
		activate();
		const ops = mod.toolSandboxOptions().read.operations;
		await ops.access(join(scratch, "plain-dir"));
		const text = (await ops.readFile(join(scratch, "plain-dir"))).toString();
		assert.match(text, /is a directory with 0 entries; read a file by its path/);
	});

	it("the skills root reads as its listing (skill dirs marked with a slash)", async () => {
		activate();
		const ops = mod.toolSandboxOptions().read.operations;
		await ops.access(join(scratch, "skills"));
		const text = (await ops.readFile(join(scratch, "skills"))).toString();
		assert.match(text, /is a directory with \d+ entries/);
		assert.match(text, /^lonely\/$/m);
		assert.match(text, /^model-guide\/$/m);
	});

	it("an ordinary missing file keeps the plain ENOENT (no nudge)", async () => {
		activate();
		const ops = mod.toolSandboxOptions().read.operations;
		await assert.rejects(ops.access(join(scratch, "no-such.txt")), (e) => {
			assert.match(e.message, /ENOENT: no such file or directory/);
			return true;
		});
	});

	it("an ordinary file read is byte-identical passthrough", async () => {
		activate();
		const ops = mod.toolSandboxOptions().read.operations;
		const buf = await ops.readFile(join(scratch, "inside.txt"));
		assert.equal(buf.toString(), "readable inside the sandbox\n");
	});
});

describe("the child env is the kernel's allow-list", () => {
	it("a provider key in node's env never reaches the sandboxed child", () => {
		activate();
		process.env.FAKE_PROVIDER_KEY = "sk-should-not-cross";
		process.env.HARNESS_KERNEL_ENV_ALLOW = "PATH,HOME,HARNESS_*,PRIME_AGENT_*";
		const env = mod.toolSandboxChildEnv();
		assert.equal(env.FAKE_PROVIDER_KEY, undefined);
		assert.equal(env.PATH, process.env.PATH);
		assert.equal(env.PRIME_AGENT_KERNEL_PYTHON, PYTHON);
	});

	it("inactive, the env passes through untouched — stock behavior preserved", () => {
		deactivate();
		process.env.FAKE_PROVIDER_KEY = "sk-should-not-cross";
		assert.equal(mod.toolSandboxChildEnv().FAKE_PROVIDER_KEY, "sk-should-not-cross");
	});
});
describe("W126: through the compiled read TOOL, not just the ops", { skip: !canRun && "darwin + srt + python3 required" }, () => {
	// read.ts runs an image sniff (`detectImageMimeType`) between `access` and
	// `readFile`. `operations` replaces stock's defaults WHOLESALE, so before W126
	// the sandboxed read tool had no sniff at all — every image read came back as
	// utf-8 text — and stock's default, had it been kept, open()s the path
	// host-side and throws EISDIR on the very directory `access` just admitted.
	// The sniff is now a sandboxed op; only the tool's own execute() sees the whole
	// sequence, so that is what is pinned here.
	let createReadTool;
	before(async () => {
		({ createReadTool } = await import(join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/core/tools/read.js")));
		mkdirSync(join(scratch, "skills/e2e-skill/references"), { recursive: true });
		writeFileSync(join(scratch, "skills/e2e-skill/SKILL.md"), "# e2e skill\nbody\n");
		writeFileSync(join(scratch, "skills/e2e-skill/references/notes.md"), "ref\n");
		// A real PNG header, so the sniff path is exercised on a file too.
		writeFileSync(join(scratch, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
	});

	it("read(path='skills/<slug>') returns SKILL.md plus the references block", async () => {
		activate();
		const tool = createReadTool(scratch, mod.toolSandboxOptions().read);
		const { content } = await tool.execute("t1", { path: "skills/e2e-skill" });
		const text = content.map((c) => c.text ?? "").join("");
		assert.match(text, /^# e2e skill\nbody\n/);
		assert.match(text, /This skill's references, addressable by full path:\n- skills\/e2e-skill\/references\/notes\.md/);
	});

	it("an image file is still detected as an image, via the sandboxed sniff", async () => {
		activate();
		const tool = createReadTool(scratch, mod.toolSandboxOptions().read);
		const { content } = await tool.execute("t3", { path: "pixel.png" });
		assert.ok(content.some((c) => c.type === "image" && c.mimeType === "image/png"), JSON.stringify(content).slice(0, 200));
	});

	it("a plain text file reads byte-identically through the tool", async () => {
		activate();
		const tool = createReadTool(scratch, mod.toolSandboxOptions().read);
		const { content } = await tool.execute("t4", { path: "inside.txt" });
		assert.equal(content[0].text, "readable inside the sandbox\n");
	});
});
