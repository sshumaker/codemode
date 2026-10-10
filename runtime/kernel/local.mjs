/**
 * The local kernel backend: prime's own KernelManager launching ipykernel under srt on
 * this machine, sharing the host filesystem (so moving files across the boundary is a
 * no-op).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { HARNESS_ROOT, stagePrelude, stageRuntime, stageStartupHooks } from "./prelude.mjs";
import { HostWorkspaceFiles } from "./workspace-files.mjs";

/**
 * HOME is read-denied inside the sandbox, so libraries that cache under it (matplotlib,
 * fontconfig) warn on every first import. Point them at the writable scratch dir.
 */
export const KERNEL_ENV_HOOK = `import os as _os
_tmp = _os.environ.get("TMPDIR") or "/tmp"
_os.environ.setdefault("MPLCONFIGDIR", _os.path.join(_tmp, "matplotlib"))
_os.environ.setdefault("XDG_CACHE_HOME", _os.path.join(_tmp, "cache"))
del _os, _tmp
`;

export const KERNEL_ENV_HOOK_NAME = "06-aw-env.py";

/** Every regular file under `workDir/outputs` (dotfiles skipped, 6 levels deep), sorted by path. */
export function walkOutputs(workDir) {
	const root = join(workDir, "outputs");
	const out = [];
	const walk = (dir, depth) => {
		if (depth > 6) return;
		let names;
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (name.startsWith(".")) continue;
			const full = join(dir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(full, depth + 1);
			else if (st.isFile()) out.push({ path: relative(workDir, full), size: st.size, mtimeMs: st.mtimeMs });
		}
	};
	walk(root, 0);
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** runtime/scheduler.py on this host, under `python` (the kernel's interpreter: a container has no python3). */
export function hostScheduler(harnessRoot, python) {
	const script = join(harnessRoot, "runtime", "scheduler.py");
	const bin = existsSync(python) ? python : "python3";
	return (args, stdin) =>
		new Promise((resolve, reject) => {
			const child = spawn(bin, [script, ...args], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
			});
			let out = "";
			let err = "";
			const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (err += d));
			child.on("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve(out);
				else reject(new Error(`scheduler.py exited ${code}: ${err.trim().slice(-400)}`));
			});
			child.stdin.end(stdin);
		});
}

/**
 * The kernel is prime's own ipykernel, launched by prime under srt with harness's
 * posture (runtime/posture.mjs): reads denied everywhere except the system paths and
 * this conversation's own directories (never another conversation's, never the shared
 * /tmp), writes only to its work dir and scratch, no network except loopback (where the
 * tool proxy's authority is the per-conversation token), and an environment built from
 * an allow-list.
 *
 * Owns: staging the conversation's IPython dir (harness hooks, the env hook, the app's
 * extra startup files, the prelude and its runtime), writing its srt settings, and the
 * env prime needs to launch the kernel.
 * Not responsible for: launching anything (prime does), or the tool proxy (the host's).
 */
export class LocalKernelBackend {
	constructor(opts = {}) {
		this.harnessRoot = opts.harnessRoot ?? HARNESS_ROOT;
		this.kernelPython = opts.kernelPython;
		/** false = `local-unsafe`: no srt sandbox at all. Container smoke tests only. */
		this.sandbox = opts.sandbox ?? true;
		this.extraStartupFiles = opts.extraStartupFiles ?? {};
		this.name = this.sandbox ? "local" : "local-unsafe";
		this.posture = undefined;
	}

	async loadPosture() {
		this.posture ??= await import(pathToFileURL(join(this.harnessRoot, "runtime/posture.mjs")).href);
		return this.posture;
	}

	async open(ctx) {
		const posture = await this.loadPosture();
		const tmp = ctx.tmpDir;
		const ipython = join(ctx.convDir, ".ipython");
		mkdirSync(tmp, { recursive: true });
		const startup = join(ipython, "profile_default/startup");
		stageStartupHooks(this.harnessRoot, startup, { [KERNEL_ENV_HOOK_NAME]: KERNEL_ENV_HOOK, ...this.extraStartupFiles });
		// The prelude binds `jobs` (and `spawn` when the host enables subagents); its
		// modules live beside the startup dir, inside the readable ipython dir.
		const runtimeDir = join(ipython, "harness-runtime");
		const prelude = stagePrelude(this.harnessRoot, startup);
		if (prelude) stageRuntime(this.harnessRoot, runtimeDir);
		const cli = join(this.harnessRoot, "vendor/prime-agent/packages/coding-agent/dist");
		// Reads are an allow-list from the root (posture.mjs): this conversation's own
		// directories and what they link to, and nothing of the shared /tmp. TMPDIR is the
		// conversation's own scratch (`tmp`), so ipykernel's connection file is there.
		const readable = [
			ctx.apiTreeDir,
			...ctx.skillRoots,
			ctx.agentBinDir,
			ipython,
			tmp,
			cli,
			...posture.pythonPrefixes(this.kernelPython),
		];
		const settings = posture.srtSettings({
			runDir: ctx.workDir,
			home: homedir(),
			readable: [...new Set(readable)],
			writable: [tmp, ipython],
		});
		const settingsPath = join(ctx.convDir, "srt-settings.json");
		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
		const workDir = ctx.workDir;
		// Unsandboxed is something prime makes a launcher say explicitly (fails closed otherwise).
		const sandboxEnv = this.sandbox
			? {
					HARNESS_KERNEL_SANDBOX_SETTINGS: settingsPath,
					HARNESS_KERNEL_SANDBOX_BIN: join(this.harnessRoot, "node_modules/.bin/srt"),
				}
			: { HARNESS_KERNEL_SANDBOX: "off" };
		return {
			primeCwd: workDir,
			primeEnv: {
				...sandboxEnv,
				HARNESS_KERNEL_ENV_ALLOW: posture.KERNEL_ENV_ALLOW,
				HARNESS_KERNEL_STDERR_LOG: join(ctx.convDir, "kernel-stderr.log"),
				HARNESS_MCP_PROXY: `${ctx.localBaseUrl}${ctx.toolProxyPath}`,
				HARNESS_EGRESS_TOKEN: ctx.egressToken,
				IPYTHONDIR: ipython,
				// srt replaces the kernel's TMPDIR with CLAUDE_CODE_TMPDIR, else /tmp/claude, which
				// its default policy lets the kernel write and the read allow-list does not let it
				// read back: every tempfile round trip in a cell failed. Point srt at this
				// conversation's scratch dir, which is both readable and writable.
				CLAUDE_CODE_TMPDIR: tmp,
				CLAUDE_TMPDIR: tmp,
				PRIME_AGENT_KERNEL_PYTHON: this.kernelPython,
				...(ctx.timeZone ? { TZ: ctx.timeZone } : {}),
				...(prelude
					? {
							HARNESS_RUNTIME_DIR: runtimeDir,
							HARNESS_JOB_DIR: join(workDir, ".jobs"),
							HARNESS_PRELUDE_MARKER: join(ipython, "prelude-status.txt"),
						}
					: {}),
			},
			ready: Promise.resolve(),
			putInput: async () => {},
			listOutputs: async () => walkOutputs(workDir),
			readOutput: (rel) => readFile(join(workDir, rel)),
			files: new HostWorkspaceFiles(workDir),
			workDirAliases: [],
			release: async () => {},
			// The kernel shares this host's filesystem and pid space, so the scheduler here
			// sees its jobs exactly as the kernel does.
			scheduler: hostScheduler(this.harnessRoot, this.kernelPython),
			schedulerPollMs: 2000,
		};
	}
}
