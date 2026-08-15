#!/usr/bin/env node
/**
 * Boot one IPython kernel and throw it away, so the sweep does not pay for it.
 *
 *   node bench/appworld/prewarm.mjs [--env <file>] [--quiet]
 *
 * Why
 * ---
 * Codemode's *first action* was taking a mean of 190s and a max of 310s — 87% of
 * its whole agent time — while vanilla's first action was instant. Reported
 * naively that reads as "codemode is slower", which would have been wrong.
 *
 * It is not the dead egress proxy, and it is not the kernel-venv bootstrap.
 * Measured, one trivial `print(6*7)` cell per configuration:
 *
 *   dead proxy, cold                          70.9s
 *   no proxy                                   8.9s
 *   PRIME_AGENT_KERNEL_PYTHON pinned            5.9s
 *   dead proxy again, warm                     4.8s   <- same config as line 1
 *
 * The first and last lines are the same configuration and differ by 15x, so the
 * cost is **one-time and global**, not per-run and not proxy-related: the kernel
 * venv is 285 MB and the first boot faults it in from disk. Pinning
 * `PRIME_AGENT_KERNEL_PYTHON` buys ~1s and is not the fix. Six concurrent workers
 * all faulting cold pages is what turned 70s into 310s.
 *
 * So the fix is the same shape as TAC's `provision-agent-volume.sh`: pay it once
 * up front, and let every worker read a warm cache. `sweep.mjs` calls this before
 * its pool starts.
 *
 * Until this has run, **do not report latency for either arm** — the number is an
 * artefact of the machine, not of the representation.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeArgv } from "../argv.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/cli.js");

const argv = process.argv.slice(2);
const { flag } = makeArgv(argv);
const quiet = argv.includes("--quiet");
const envFile = flag("env");

/**
 * Runs the real CLI with the real tool, because the thing being warmed is
 * whatever prime's kernel boot touches. A hand-rolled `python -c "import pandas"`
 * would warm a guess.
 */
export async function prewarm({ envFile: file, quiet: silent } = {}) {
	if (!existsSync(CLI)) throw new Error(`missing prime-agent CLI: ${CLI}`);
	const started = Date.now();
	const cliArgs = [
		CLI,
		"-p",
		"--mode",
		"json",
		"--model",
		"anthropic/claude-haiku-4-5-20251001",
		"--tools",
		"ipython",
		"--cwd",
		ROOT,
		"--no-context-files",
		"--no-prompt-templates",
		"--no-extensions",
		"Run one ipython cell containing exactly: print(6*7). Then reply with only the number.",
	];
	const env = {
		...process.env,
		PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`,
		DO_NOT_TRACK: "1",
		PRIME_AGENT_TELEMETRY: "0",
		PRIME_AGENT_CODING_AGENT_DIR: join(ROOT, ".run/appworld/.prewarm-home"),
	};
	const child = file
		? // Source the env file in a subshell so the key never lands in a JS variable.
			spawn("bash", ["-c", `set -a; . "$1"; set +a; shift; exec node "$@"`, "_", file, ...cliArgs], {
				cwd: ROOT,
				env,
				// stdin must be closed: in print mode the CLI waits on an open stdin and
				// produces nothing at all. Cost me two ten-minute probes that looked like
				// kernel hangs.
				stdio: ["ignore", "pipe", "pipe"],
			})
		: spawn("node", cliArgs, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });

	let ranACell = false;
	child.stdout.on("data", (chunk) => {
		for (const line of String(chunk).split("\n")) {
			if (line.startsWith("{") && line.includes('"tool_execution_end"')) ranACell = true;
		}
	});
	const code = await new Promise((resolve) => child.on("close", resolve));
	const seconds = (Date.now() - started) / 1000;
	if (!silent) {
		console.log(`[prewarm] kernel boot ${ranACell ? "warmed" : "DID NOT RUN A CELL"} in ${seconds.toFixed(1)}s (exit ${code})`);
	}
	// Never fatal. A failed pre-warm makes the sweep slower, not wrong — and the
	// per-run phase timings will show it.
	return { ok: ranACell, seconds, exitCode: code };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const result = await prewarm({ envFile, quiet });
	process.exit(result.ok ? 0 : 1);
}
