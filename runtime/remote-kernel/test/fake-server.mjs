/**
 * The in-process fake: the real kernel server (dist/core/kernel/remote/server-main.js)
 * run as a local child process against a real local ipykernel, no Daytona.
 *
 * The kernel venv is a dedicated one under ~/.cache (PRIME_AGENT_KERNEL_VENV), built by
 * prime's own bootstrap on first use, so tests never touch ~/.prime/agent/kernel-venv.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const CA = join(ROOT, "vendor/prime-agent/packages/coding-agent");
export const DIST = join(CA, "dist");
export const TEST_VENV = process.env.RK_TEST_VENV ?? join(homedir(), ".cache/harness-remote-kernel-test/kernel-venv");

/** Start a kernel server; resolves once it is listening. */
export async function startFakeServer(opts = {}) {
	const token = opts.token ?? randomBytes(16).toString("hex");
	const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "rk-state-"));
	const cwd = opts.cwd ?? join(stateDir, "work");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(dirname(TEST_VENV), { recursive: true });
	const env = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		TMPDIR: process.env.TMPDIR,
		LANG: process.env.LANG ?? "en_US.UTF-8",
		PRIME_AGENT_KERNEL_VENV: TEST_VENV,
		PRIME_AGENT_INSTALL_UV: "1",
		KERNEL_SERVER_PORT: String(opts.port ?? 0),
		KERNEL_SERVER_HOST: "127.0.0.1",
		KERNEL_SERVER_TOKEN: token,
		KERNEL_SERVER_CWD: cwd,
		KERNEL_SERVER_STATE_DIR: stateDir,
		KERNEL_SERVER_BOUNDARY: "none (local fake)",
		KERNEL_SERVER_VERSION: "fake",
		KERNEL_SERVER_GRACE_MS: String(opts.graceMs ?? 60_000),
		KERNEL_SERVER_IDLE_SOCKET_MS: String(opts.idleSocketMs ?? 45_000),
		KERNEL_SERVER_PROBE_TIMEOUT_MS: "500",
		...(opts.allowOpenEgress === false ? {} : { KERNEL_SERVER_ALLOW_OPEN_EGRESS: "local fake: no sandbox to lock" }),
		...(opts.probeTargets ? { KERNEL_SERVER_PROBE_TARGETS: opts.probeTargets } : {}),
		...opts.env,
	};
	// Its own process group, so kill9() takes the kernels down with it: a SIGKILLed
	// server cannot dispose them, and they would outlive the test.
	const child = spawn(process.execPath, [join(DIST, "core/kernel/remote/server-main.js")], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let log = "";
	child.stdout.on("data", (d) => {
		log += d;
	});
	child.stderr.on("data", (d) => {
		log += d;
	});
	const port = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 15_000);
		const check = () => {
			const m = /kernel-server listening on (\d+)/.exec(log);
			if (m) {
				clearTimeout(timer);
				resolve(Number(m[1]));
			}
		};
		child.stdout.on("data", check);
		child.once("exit", (code) => reject(new Error(`server exited ${code}:\n${log}`)));
	});
	return {
		url: `ws://127.0.0.1:${port}`,
		port,
		token,
		stateDir,
		cwd,
		child,
		log: () => log,
		stop: () =>
			new Promise((resolve) => {
				if (child.exitCode !== null) return resolve();
				child.once("exit", () => resolve());
				child.kill("SIGTERM");
			}),
		kill9: () =>
			new Promise((resolve) => {
				if (child.exitCode !== null) return resolve();
				child.once("exit", () => resolve());
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}),
	};
}
