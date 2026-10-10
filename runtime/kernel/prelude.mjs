/**
 * harness's kernel prelude, its startup hooks, and the runtime the prelude imports,
 * staged for a kernel.
 *
 * The prelude (runtime/kernel-prelude.py) binds `jobs` in every kernel and, under
 * HARNESS_SUBAGENTS=1, `agents` (with `spawn` as its alias) and `gather_children`; a
 * subagent's kernel gets its own `agents` (report, ask_parent). It is an IPython startup
 * file, so it goes in the startup dir after the error-correction hooks; the modules it
 * imports go in a directory the kernel finds through HARNESS_RUNTIME_DIR.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This checkout: runtime/kernel/ is two levels below it. */
export const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const PRELUDE_STARTUP_NAME = "10-harness-prelude.py";

/** The prelude's imports: jobs, subagents (spawn), agents and its mailbox, and what those import lazily. */
const RUNTIME_MODULES = [
	"jobs.py",
	"subagents.py",
	"agents.py",
	"agent_mailbox.py",
	"subagent_run.py",
	"shell_jobs.py",
	// jobs.py and scheduler.py record and deliver owed tool invocations through it (optional import).
	"invocations.py",
	// Not imported by the prelude: the host runs it where the jobs are to judge a wait.
	"scheduler.py",
];

/** Harness's IPython startup hooks, in load order: corrections that fire on real errors. */
export const STARTUP_HOOKS = [
	["eperm_correction.py", "00-eperm-correction.py"],
	["api_prebind.py", "02-api-prebind.py"],
	["api_signature_correction.py", "03-api-signature-correction.py"],
	["api_doc_expansion.py", "05-api-doc-expansion.py"],
];

/** Copy the prelude into `startupDir`. False when this harness has none. */
export function stagePrelude(harnessRoot, startupDir) {
	const from = join(harnessRoot, "runtime", "kernel-prelude.py");
	if (!existsSync(from)) return false;
	mkdirSync(startupDir, { recursive: true });
	copyFileSync(from, join(startupDir, PRELUDE_STARTUP_NAME));
	return true;
}

/** Copy the runtime modules into `dir` (HARNESS_RUNTIME_DIR). */
export function stageRuntime(harnessRoot, dir) {
	mkdirSync(dir, { recursive: true });
	for (const name of RUNTIME_MODULES) {
		const from = join(harnessRoot, "runtime", name);
		if (existsSync(from)) copyFileSync(from, join(dir, name));
	}
}

/** Copy harness's startup hooks into `startupDir`, and write the app's extra startup files beside them. */
export function stageStartupHooks(harnessRoot, startupDir, extraStartupFiles = {}) {
	mkdirSync(startupDir, { recursive: true });
	for (const [src, dest] of STARTUP_HOOKS) {
		const from = join(harnessRoot, "runtime", src);
		if (existsSync(from)) copyFileSync(from, join(startupDir, dest));
	}
	for (const [name, source] of Object.entries(extraStartupFiles)) writeFileSync(join(startupDir, name), source);
}

/**
 * A remote kernel's startup directory (a Daytona sandbox, a user's computer), staged
 * under `parentDir` for upload: harness's hooks, the app's extra startup files, and the
 * prelude with the runtime it imports (`runtimeDir`, when this harness has a prelude).
 */
export function stageRemoteStartup(harnessRoot, parentDir, extraStartupFiles = {}) {
	const hooksDir = join(parentDir, "remote-ipython-startup");
	stageStartupHooks(harnessRoot, hooksDir, extraStartupFiles);
	if (!stagePrelude(harnessRoot, hooksDir)) return { hooksDir };
	const runtimeDir = join(parentDir, "remote-harness-runtime");
	stageRuntime(harnessRoot, runtimeDir);
	return { hooksDir, runtimeDir };
}
