/**
 * The kernel's read scope, enforced by real seatbelt on a real ipykernel.
 *
 * A Sonnet 5 trace ran `find / -name _types.py` from a cell and got hits under
 * /private/tmp/cmp/... — other workspaces — because srtSettings denied only $HOME
 * and every runner allowed all of /tmp. runtime/posture.mjs now denies reads from
 * the root and allows back the system paths plus what the run names. This pins,
 * through the compiled ipython tool the arms exec and the settings posture.mjs
 * builds:
 *
 *   - a cell reading another directory under /tmp, or a file under $HOME, fails;
 *   - `find /` lists nothing from another run's directory;
 *   - what a real session needs still works: matplotlib's display_data image,
 *     attach_image, an api/ tree reached through a symlink, stdlib imports;
 *   - the file tools (read, grep, find, ls) obey the same scope;
 *   - `rlm` is not in the user namespace unless HARNESS_RLM=1.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { generate } from "../generate.mjs";
import { KERNEL_ENV_ALLOW, pythonPrefixes, srtSettings } from "../../runtime/posture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = join(ROOT, "vendor/prime-agent/packages/coding-agent/dist");
const SRT = join(ROOT, "node_modules/.bin/srt");
const KERNEL_PYTHON = process.env.PRIME_AGENT_KERNEL_PYTHON ?? join(homedir(), ".prime/agent/kernel-venv/bin/python");
const SKILLS = join(ROOT, "vendor/prime-agent/packages/coding-agent/skills");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const canRun = process.platform === "darwin" && existsSync(SRT) && existsSync(KERNEL_PYTHON) && existsSync(join(DIST, "core/tools/ipython.js"));
const SKIP = !canRun && "darwin + srt + a kernel python + a built dist required";

const ENV_KEYS = [
	"HARNESS_KERNEL_SANDBOX_SETTINGS", "HARNESS_KERNEL_SANDBOX_BIN", "HARNESS_KERNEL_SANDBOX", "HARNESS_KERNEL_ENV_ALLOW",
	"PRIME_AGENT_KERNEL_PYTHON", "TMPDIR", "HARNESS_RLM", "HARNESS_TOOL_SANDBOX_SCRIPT_DIR", "HARNESS_DISPLAY_IMAGES",
];

const textOf = (r) => r.content.map((c) => c.text ?? "").join("");

describe("the kernel reads only its own world", { skip: SKIP }, () => {
	const saved = {};
	let IPY;
	let TOOLS;
	let world;
	let other;
	let provisioner;
	let tool;
	const cell = async (code, id = "c") => tool.execute(id, { code });

	before(async () => {
		for (const k of ENV_KEYS) saved[k] = process.env[k];
		IPY = await import(join(DIST, "core/tools/ipython.js"));
		TOOLS = await import(join(DIST, "core/tools/path-utils.js"));

		// Another run's directory, beside ours under the shared temp dir: the thing
		// the trace could list.
		other = mkdtempSync(join("/tmp", "scope-other-"));
		writeFileSync(join(other, "secret-marker.txt"), "another workspace\n");

		world = mkdtempSync(join("/tmp", "scope-world-"));
		const work = join(world, "work");
		const scratch = join(world, "tmp");
		const ipython = join(world, "ipython");
		const apiTree = join(world, "api-tree");
		for (const d of [work, scratch, ipython]) mkdirSync(d, { recursive: true });
		writeFileSync(join(work, "secret-marker.txt"), "ours\n");
		writeFileSync(join(work, "notes.txt"), "alpha\nneedle here\nomega\n");

		// A real generated api/ tree, outside the work dir and linked in, the way the
		// gateway and the arms place it.
		const { catalogue } = JSON.parse(readFileSync(join(ROOT, "bench/data/mcp-schemas.json"), "utf8"));
		const { files } = generate(catalogue.filter((s) => s.server === "Math MCP"));
		for (const [rel, content] of Object.entries(files)) {
			mkdirSync(dirname(join(apiTree, "api", rel)), { recursive: true });
			writeFileSync(join(apiTree, "api", rel), content);
		}
		symlinkSync(join(apiTree, "api"), join(work, "api"));

		const settingsPath = join(world, "srt-settings.json");
		const settings = srtSettings({
			runDir: work,
			home: homedir(),
			readable: [apiTree, scratch, ipython, join(SKILLS, "attach-image/src"), ...pythonPrefixes(KERNEL_PYTHON)],
			writable: [scratch, ipython],
		});
		writeFileSync(settingsPath, JSON.stringify(settings));

		process.env.HARNESS_KERNEL_SANDBOX_SETTINGS = settingsPath;
		process.env.HARNESS_KERNEL_SANDBOX_BIN = SRT;
		process.env.HARNESS_KERNEL_ENV_ALLOW = KERNEL_ENV_ALLOW;
		process.env.PRIME_AGENT_KERNEL_PYTHON = KERNEL_PYTHON;
		process.env.HARNESS_TOOL_SANDBOX_SCRIPT_DIR = scratch;
		process.env.HARNESS_DISPLAY_IMAGES = "1";
		// The connection file and the kernel's own TMPDIR: this run's scratch.
		process.env.TMPDIR = scratch;
		delete process.env.HARNESS_KERNEL_SANDBOX;
		delete process.env.HARNESS_RLM;

		const env = {
			IPYTHONDIR: ipython,
			MPLBACKEND: "module://matplotlib_inline.backend_inline",
			MPLCONFIGDIR: join(scratch, "matplotlib"),
		};
		const hostHandlers = { "model.info": async () => ({ id: "fake", provider: "anthropic", input: ["text", "image"] }) };
		provisioner = new IPY.IpythonKernelProvisioner(work, { env, hostHandlers });
		tool = IPY.createIpythonTool(work, { env, provisioner });
	});

	after(async () => {
		await provisioner?.dispose();
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		for (const d of [world, other]) if (d) rmSync(d, { recursive: true, force: true });
	});

	it("rlm is not a name a cell can see", { timeout: 120_000 }, async () => {
		const r = await cell(
			"import builtins\n" +
				"_w = get_ipython().run_line_magic('who_ls', '')\n" +
				"print('WHO', 'rlm' in _w)\n" +
				"print('DIR', 'rlm' in dir())\n" +
				"print('GLOBALS', 'rlm' in globals())\n" +
				"print('BUILTINS', hasattr(builtins, 'rlm'))\n" +
				"try:\n    rlm\nexcept NameError:\n    print('NAMEERROR')\n",
		);
		const text = textOf(r);
		assert.equal(r.isError, false, text);
		for (const line of ["WHO False", "DIR False", "GLOBALS False", "BUILTINS False", "NAMEERROR"]) assert.match(text, new RegExp(line));
		const whos = textOf(await cell("%whos"));
		assert.doesNotMatch(whos, /\brlm\b/);
		assert.doesNotMatch(whos, /_RLMCallable/);
	});

	it("reads under another /tmp directory and under $HOME are refused", { timeout: 60_000 }, async () => {
		const probe = (p) =>
			`try:\n    open(${JSON.stringify(p)}).read()\n    print('READ', ${JSON.stringify(p)})\nexcept PermissionError as e:\n    print('DENIED', e.errno)\n`;
		const text = textOf(
			await cell(
				probe(join(other, "secret-marker.txt")) +
					probe(join("/private", other, "secret-marker.txt")) +
					probe(join(ROOT, "package.json")) +
					"import os\n" +
					"try:\n    os.listdir('/private/tmp'); print('LISTED /private/tmp')\nexcept PermissionError:\n    print('DENIED listdir')\n",
			),
		);
		assert.doesNotMatch(text, /READ|LISTED/, text);
		// seatbelt refuses with EPERM ("Operation not permitted"), not EACCES.
		assert.equal((text.match(/DENIED 1\b/g) ?? []).length, 3, text);
		assert.match(text, /DENIED listdir/);
	});

	it("find / lists nothing of another run's, and find . still finds ours", { timeout: 180_000 }, async () => {
		const text = textOf(
			await cell(
				"import subprocess\n" +
					"walk = lambda root: sorted(subprocess.run(f'find {root} -name secret-marker.txt 2>/dev/null', shell=True, capture_output=True, text=True).stdout.split())\n" +
					"print('ROOT', walk('/'))\n" +
					"print('HERE', walk('.'))\n" +
					`print('OTHER', walk(${JSON.stringify(other)}))\n`,
			),
		);
		// The walk from / cannot descend into /private/tmp at all (listing it is denied),
		// so it reaches neither directory under it; the one hit is the cwd's own fd.
		assert.doesNotMatch(text, /scope-other-/, text);
		assert.match(text, /HERE \['\.\/secret-marker\.txt'\]/, text);
		assert.match(text, /OTHER \[\]/, text);
	});

	it("matplotlib draws, and the figure arrives as a display_data image", { timeout: 120_000 }, async () => {
		const r = await cell(
			"import matplotlib.pyplot as plt\n" + "plt.plot([1, 2, 3], [1, 4, 9]); plt.title('fonts render')\n" + "plt.show()\n",
		);
		assert.equal(r.isError, false, textOf(r));
		assert.ok(
			r.content.some((c) => c.type === "image" && c.mimeType === "image/png"),
			JSON.stringify(r.content).slice(0, 400),
		);
	});

	it("attach_image reaches the host without an rlm name in the namespace", { timeout: 60_000 }, async () => {
		const r = await cell(
			"import sys, base64\n" +
				`sys.path.insert(0, ${JSON.stringify(join(SKILLS, "attach-image/src"))})\n` +
				"import attach_image\n" +
				`png = ${JSON.stringify(join(world, "work/dot.png"))}\n` +
				`open(png, 'wb').write(base64.b64decode(${JSON.stringify(PNG)}))\n` +
				"print('RESULT', await attach_image.run(png))\n" +
				"print('STILL HIDDEN', 'rlm' not in globals())\n",
		);
		const text = textOf(r);
		assert.equal(r.isError, false, text);
		assert.match(text, /RESULT Loaded 1 image\(s\) into context/);
		assert.match(text, /STILL HIDDEN True/);
	});

	it("the api/ tree imports through its symlink, and the stdlib imports", { timeout: 60_000 }, async () => {
		const r = await cell(
			"import api.math_mcp, sqlite3, ssl, zoneinfo, json, csv, decimal, ctypes, email, xml.etree.ElementTree, datetime\n" +
				"print('API', api.math_mcp.__name__)\n" +
				"print('TZ', zoneinfo.ZoneInfo('America/Los_Angeles').key)\n" +
				"print('SQL', sqlite3.connect(':memory:').execute('select 1').fetchone())\n" +
				"print('SSL', bool(ssl.OPENSSL_VERSION))\n",
		);
		const text = textOf(r);
		assert.equal(r.isError, false, text);
		for (const want of ["API api.math_mcp", "TZ America/Los_Angeles", "SQL (1,)", "SSL True"]) assert.ok(text.includes(want), text);
	});

	describe("the file tools obey the same scope", () => {
		const ops = (name) => TOOLS.toolSandboxOptions(join(world, "work"))[name].operations;

		it("read: ours reads, another run's and $HOME's are EACCES", async () => {
			assert.equal((await ops("read").readFile(join(world, "work/notes.txt"))).toString(), "alpha\nneedle here\nomega\n");
			await assert.rejects(ops("read").readFile(join(other, "secret-marker.txt")), /EACCES/);
			await assert.rejects(ops("read").readFile(join(ROOT, "package.json")), /EACCES/);
		});

		it("ls: ours lists, another run's is EACCES", async () => {
			assert.ok((await ops("ls").readdir(join(world, "work"))).includes("notes.txt"));
			await assert.rejects(ops("ls").readdir(other), /EACCES/);
		});

		it("grep: the ops read ours and refuse another run's", async () => {
			assert.match(await ops("grep").readFile(join(world, "work/notes.txt")), /needle/);
			await assert.rejects(ops("grep").readFile(join(other, "secret-marker.txt")), /EACCES/);
		});

		it("find and grep binaries run inside the sandbox and see only the allowed tree", async () => {
			const run = (bin, args) =>
				new Promise((resolve) => {
					const child = TOOLS.toolSandboxSpawn(bin, args);
					let out = "";
					child.stdout.on("data", (d) => (out += d));
					child.on("close", () => resolve(out));
				});
			const ours = await run("/usr/bin/find", [join(world, "work"), "-name", "secret-marker.txt"]);
			assert.match(ours, /scope-world-.*work\/secret-marker\.txt/);
			assert.equal(await run("/usr/bin/find", [other, "-name", "secret-marker.txt"]), "");
			assert.equal(await run("/usr/bin/find", ["/private/tmp", "-name", "secret-marker.txt"]), "");
			const grepped = await run("/usr/bin/grep", ["-r", "workspace", other]);
			assert.equal(grepped, "", "grep read another run's file");
		});
	});
});

describe("HARNESS_RLM=1 binds rlm again", { skip: SKIP }, () => {
	const saved = {};
	let provisioner;
	let tool;
	let world;

	before(async () => {
		for (const k of ENV_KEYS) saved[k] = process.env[k];
		const IPY = await import(join(DIST, "core/tools/ipython.js"));
		world = mkdtempSync(join(tmpdir(), "scope-rlm-"));
		process.env.PRIME_AGENT_KERNEL_PYTHON = KERNEL_PYTHON;
		process.env.HARNESS_KERNEL_SANDBOX = "off";
		delete process.env.HARNESS_KERNEL_SANDBOX_SETTINGS;
		const env = { IPYTHONDIR: join(world, "ipython"), HARNESS_RLM: "1" };
		provisioner = new IPY.IpythonKernelProvisioner(world, { env });
		tool = IPY.createIpythonTool(world, { env, provisioner });
	});

	after(async () => {
		await provisioner?.dispose();
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		if (world) rmSync(world, { recursive: true, force: true });
	});

	it("the name is back, as the callable", { timeout: 120_000 }, async () => {
		const r = await tool.execute("r", { code: "print('BOUND', type(rlm).__name__, callable(rlm))" });
		assert.match(textOf(r), /BOUND _RLMCallable True/, textOf(r));
	});
});
