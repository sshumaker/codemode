#!/usr/bin/env node
/**
 * Neutralize prime-agent behaviours that make benchmark runs non-reproducible.
 *
 * prime-agent is a product, and carries state that is a feature there and a
 * confound here. Nothing in this script is a judgement about whether those
 * features work — only that a benchmark cannot measure a harness whose prompt
 * changes between runs.
 *
 * Disabled (restore any of them by setting the env var to "1"):
 *
 *   PRIME_HARNESS_STATE  The /refine continual-harness state. It persists to
 *                        harness_state.json and is folded into the system
 *                        prompt, so run N's prompt depends on run N-1. Fatal for
 *                        reproducibility and for run-order independence.
 *
 * Deliberately NOT disabled:
 *
 *   - The conversation-log path (`Conversation log: <file>` in the prompt). It
 *     is one line, it is identical across arms, and it is the mechanism by which
 *     an agent recovers context after a compaction or kernel reset. Removing it
 *     would handicap both arms for no experimental gain. See docs/DESIGN.md.
 *   - IPython kernel prewarm. Already gated upstream on `ipython` being an
 *     active tool, so the vanilla arm never starts a kernel.
 *
 * Idempotent: safe to re-run after bumping the vendored upstream.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// HARNESS_VENDOR_DIR retargets which vendored tree gets patched — the
// pristine-replay test (bench/test/provenance.test.mjs) points it at a scratch
// extraction of the base commit to prove scripts ≡ committed tree. Patch
// snippets always come from the real scripts/patches/.
const VENDOR = process.env.HARNESS_VENDOR_DIR ?? join(ROOT, "vendor");
const PRIME = join(VENDOR, "prime-agent/packages/coding-agent/src");

const log = (...a) => console.log(...a);

/**
 * Replace `find` with `replace`, asserting the match is unique.
 *
 * `marker` overrides the already-applied check. The vendored tree is committed
 * with patches in place, so a checkout restores a patched file; comparing
 * against the full replacement text then fails whenever the patch body is
 * edited, and the block gets inserted twice. A short stable marker survives
 * edits to the surrounding text.
 */
function sub(relPath, find, replace, label, marker) {
	const path = join(PRIME, relPath);
	const src = readFileSync(path, "utf8");
	if (src.includes(marker ?? replace)) return log(`  present ${relPath} :: ${label}`);
	const count = src.split(find).length - 1;
	if (count !== 1) throw new Error(`${relPath}: expected 1 match for ${label}, found ${count}`);
	// Function replacement: String.replace treats $&, $`, $' in a STRING
	// replacement as substitution patterns. A patch body containing `$` + backtick
	// (any template literal ending in `$`) spliced the entire preceding file into
	// itself — 847 duplicated lines, caught by the pristine-replay test.
	writeFileSync(path, src.replace(find, () => replace));
	log(`  patched ${relPath} :: ${label}`);
}

/**
 * A patch body, read from scripts/patches/ as real TypeScript.
 *
 * Embedding a multi-line snippet as an escaped string here mangled every
 * backslash — `\n` became a literal newline and `\w` became `w` — and produced
 * a file that did not compile (CLAUDE.md).
 */
const patch = (name) => readFileSync(join(ROOT, "scripts/patches", name), "utf8").trimEnd();

log("neutralizing prime-agent for reproducible runs\n");

// ---- kernel env: the sandbox boundary ------------------------------------
// The brain (loop) holds ANTHROPIC_API_KEY; the kernel and everything agent
// code spawns from it must not (docs/CLOUD-HARNESS-DESIGN.md). The helper is
// the whole boundary, so it lives in scripts/patches/kernel-env.ts as real
// TypeScript rather than as an escaped string; it supports an allow-list
// (HARNESS_KERNEL_ENV_ALLOW, fails closed) and the older deny-list
// (HARNESS_KERNEL_ENV_SCRUB, fails open).
sub(
	"core/kernel/index.ts",
	'} from "./state-snapshot.js";',
	`} from "./state-snapshot.js";\n\n${patch("kernel-env.ts")}`,
	"kernel env allow-list/scrub helper",
	"function kernelSpawnEnv",
);
// Both spawn sites pass the inherited environment and KernelOptions.env
// SEPARATELY, because the allow-list filters the first and must not touch the
// second. They keep upstream's own asymmetry — a copy on the fork path, the
// live object on the direct path — which is also what makes the two patched
// texts differ, so sub()'s presence check cannot mistake one site for the other
// (that collision is how the direct-spawn site went unpatched in a546017).
sub(
	"core/kernel/index.ts",
	"env: this.options.env ? { ...process.env, ...this.options.env } : { ...process.env },",
	"env: kernelSpawnEnv({ ...process.env }, this.options.env),",
	"fork-path kernel env is built by the boundary helper",
);
sub(
	"core/kernel/index.ts",
	"env: this.options.env ? { ...process.env, ...this.options.env } : process.env,",
	"env: kernelSpawnEnv(process.env, this.options.env),",
	"direct-spawn kernel env is built by the boundary helper",
);


// The continual-harness state injected into the system prompt. Opt back in with
// PRIME_HARNESS_STATE=1 if we ever want to measure it as its own variable.
sub(
	"core/agent-session.ts",
	`			harnessState: this._loadMergedHarnessState(),`,
	`			// Benchmark reproducibility: harness state persists across runs and
			// mutates the system prompt, making run N depend on run N-1.
			// See scripts/neutralize-prime.mjs.
			harnessState: process.env.PRIME_HARNESS_STATE === "1" ? this._loadMergedHarnessState() : undefined,`,
	"harness-state prompt injection",
);

// --- experiment-only CLI surface ---------------------------------------------
// `--tools` sets both the allowlist and the initially-active set, so there is no
// way from the CLI to allow a tool while leaving it dormant. The vanilla arm's
// L1 (deferred) condition needs exactly that: all 250 MCP tools permitted, only
// a handful active until `load_tool` activates one. The SDK already supports it
// (`initialActiveToolNames`); this only exposes it.
log("\nexperiment CLI surface:");

sub(
	"cli/args.ts",
	`\t\t} else if (arg === "--thinking" && i + 1 < args.length) {`,
	`\t\t} else if (arg === "--active-tools" && i + 1 < args.length) {
			// Initially-active subset of --tools. See scripts/neutralize-prime.mjs.
			result.activeTools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if (arg === "--thinking" && i + 1 < args.length) {`,
	"--active-tools flag",
);

sub(
	"cli/args.ts",
	`\ttools?: string[];`,
	`\ttools?: string[];\n\tactiveTools?: string[];`,
	"activeTools on Args",
);

sub(
	"core/agent-session-config.ts",
	`\ttools?: string[];`,
	`\ttools?: string[];\n\t/** Initially-active subset of \`tools\`. See scripts/neutralize-prime.mjs. */\n\tinitialActiveToolNames?: string[];`,
	"initialActiveToolNames on AgentSessionRuntimeConfig",
);

sub(
	"main.ts",
	`\t\ttools: parsed.tools,`,
	`\t\ttools: parsed.tools,\n\t\tinitialActiveToolNames: parsed.activeTools,`,
	"pass activeTools into session options",
);

// The missing link: prepareRuntimeServices maps config -> session options, and
// mapped `tools` but not the active subset, so the flag died here.
sub(
	"main.ts",
	`\tif (config.tools) {\n\t\toptions.tools = [...config.tools];\n\t}`,
	`\tif (config.tools) {\n\t\toptions.tools = [...config.tools];\n\t}\n` +
		`\tif (config.initialActiveToolNames) {\n\t\toptions.initialActiveToolNames = [...config.initialActiveToolNames];\n\t}`,
	"map initialActiveToolNames through prepareRuntimeServices",
);

sub(
	"main.ts",
	`\t\tinitialActiveToolNames: runtimeSessionOptions?.initialActiveToolNames,`,
	`\t\tinitialActiveToolNames:\n\t\t\truntimeSessionOptions?.initialActiveToolNames ?? sessionOptions.initialActiveToolNames,`,
	"fall back to CLI activeTools",
);

// `initialActiveToolNames` is dead whenever an allowlist is present: _buildRuntime
// unconditionally activates every allowed tool, overriding the explicit active
// set. That makes "allow a tool but leave it dormant" unexpressible, which is
// exactly what the vanilla L1 (deferred) condition needs. Restrict the blanket
// activation to the case where no explicit active set was supplied — existing
// behaviour is unchanged when the caller does not pass one.
sub(
	"core/agent-session.ts",
	`\t\tif (allowedToolNames) {\n\t\t\tfor (const toolName of this._toolRegistry.keys()) {\n\t\t\t\tif (allowedToolNames.has(toolName)) {\n\t\t\t\t\tnextActiveToolNames.push(toolName);\n\t\t\t\t}\n\t\t\t}\n\t\t} else if (options?.includeAllExtensionTools) {`,
	`\t\tif (allowedToolNames && !options?.activeToolNames) {\n\t\t\tfor (const toolName of this._toolRegistry.keys()) {\n\t\t\t\tif (allowedToolNames.has(toolName)) {\n\t\t\t\t\tnextActiveToolNames.push(toolName);\n\t\t\t\t}\n\t\t\t}\n\t\t} else if (options?.includeAllExtensionTools && !options?.activeToolNames) {`,
	"honour an explicit active set over the allowlist",
);

// mergeAgentSessionRuntimeConfig and its clone helper copy known fields one by
// one, so a new config field is silently dropped between the CLI and the
// session. This is the last link in the --active-tools chain.
sub(
	"core/agent-session-config.ts",
	`\t\ttools: cloneArray(override.tools ?? base.tools),`,
	`\t\ttools: cloneArray(override.tools ?? base.tools),\n\t\tinitialActiveToolNames: cloneArray(override.initialActiveToolNames ?? base.initialActiveToolNames),`,
	"merge initialActiveToolNames",
);

sub(
	"core/agent-session-config.ts",
	`\t\ttools: cloneArray(config.tools),`,
	`\t\ttools: cloneArray(config.tools),\n\t\tinitialActiveToolNames: cloneArray(config.initialActiveToolNames),`,
	"clone initialActiveToolNames",
);

// --- cell errors: the exception, not a re-print of the docstring ------------
// Measured on the product port: a client-side ArgumentError rendered 1,500+ chars
// into the cell result with the message LAST, because IPython prints source
// context around each frame and the lines above a generated wrapper's
// `return await _call(...)` are its whole docstring. OFF unless
// HARNESS_TRACEBACK_TRIM=1: the condition belongs in the run's environment, not
// in a build timestamp — a rebuild is how the trim leaked into two eval jobs
// that had not asked for it.
log("\ntraceback hygiene:");

sub(
	"core/tools/ipython.ts",
	"const RLM_BOOTSTRAP_BASE_CODE = `",
	`${patch("traceback-trim.ts")}\n\nconst RLM_BOOTSTRAP_BASE_CODE = \``,
	"trim cell tracebacks to the exception and the raising lines",
	"function trimCellTraceback(",
);

sub(
	"core/tools/ipython.ts",
	'\t\t\t\t\ttext += (text ? "\\n" : "") + r.error.traceback.join("\\n");',
	'\t\t\t\t\ttext += (text ? "\\n" : "") + trimCellTraceback(r.error.traceback);',
	"render the trimmed traceback",
);

// --- cells that hunt the machine instead of using api/ ----------------------
// H1 probe, job 6p8nIAVw: 62 of 75 cells grepped ~/src/harness for a tool named
// in the brief, with the full tool index and a "do not search the filesystem"
// rule in the system prompt throughout. The correction moves to the error
// channel, which this project has measured to work where prompts do not.
// OFF unless HARNESS_FS_GUARD=1.
log("\nfilesystem guard:");

sub(
	"core/tools/ipython.ts",
	"const RLM_BOOTSTRAP_BASE_CODE = `",
	`${patch("fs-guard.ts")}\n\nconst RLM_BOOTSTRAP_BASE_CODE = \``,
	"refuse cells that reach outside the job's working directory",
	"export function fsGuardCheck(",
);

sub(
	"core/tools/ipython.ts",
	"\t\t\t\tconst code = applyShellSettingsToBashMagicCell(params.code, options);",
	"\t\t\t\tconst code = applyShellSettingsToBashMagicCell(params.code, options);\n" +
		"\t\t\t\t// Before the kernel sees it: the refusal has to arrive as this cell's own\n" +
		"\t\t\t\t// error, since that is the channel the correction is delivered on.\n" +
		"\t\t\t\tconst fsRefusal = fsGuardCheck(code, cwd);\n" +
		"\t\t\t\tif (fsRefusal) {\n" +
		"\t\t\t\t\tclearTimeout(cellTimer);\n" +
		"\t\t\t\t\treturn {\n" +
		"\t\t\t\t\t\tcontent: [{ type: \"text\", text: fsRefusal }],\n" +
		"\t\t\t\t\t\tdetails: { durationMs: 0, status: \"error\", errorEname: \"FilesystemGuard\", stdout: \"\", stderr: fsRefusal },\n" +
		"\t\t\t\t\t\tisError: true,\n" +
		"\t\t\t\t\t};\n" +
		"\t\t\t\t}",
	"refuse the cell before it executes",
	// NOT the `const fsRefusal = ...` line this sub inserts: the exec-guard sub
	// below REWRITES that line into a chained one, so the naive marker stops
	// matching after a full run and a second run re-inserts the whole block --
	// two `const fsRefusal` declarations and a build that will not compile. The
	// patcher was non-idempotent by construction; `errorEname` is written here
	// and rewritten by nothing.
	'errorEname: "FilesystemGuard"',
);

// --- Symlink-blind find/grep --------------------------------------------------
// The arm links the compiled api package into the working directory as a
// SYMLINK (work/api -> bundle/api). fd and rg do not follow symlinks by default,
// so `find **/__init__.py` and `grep "def wait_for"` returned "No files found" /
// "No matches found" for the api tree in every run since the file tools were
// added (h83 pos 8: a nudged session concluded there was no api module and spent
// ten cells introspecting). `read` and `ls` open the path directly and were never
// affected. --follow makes the two walkers see what the other tools see; the
// sandbox already resolves the symlink target for reads (tool-sandbox.ts).
sub(
	"core/tools/find.ts",
	'const args: string[] = ["--glob", "--color=never", "--hidden"];',
	'const args: string[] = ["--glob", "--color=never", "--hidden", "--follow"];',
	"find follows symlinks (api/ is a symlink)",
	'"--hidden", "--follow"];',
);
sub(
	"core/tools/grep.ts",
	'const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];',
	'const args: string[] = ["--json", "--line-number", "--color=never", "--hidden", "--follow"];',
	"grep follows symlinks (api/ is a symlink)",
	'"--color=never", "--hidden", "--follow"];',
);

// --- W121: file tools execute inside the kernel's sandbox --------------------
// srt wraps the ipykernel child; the node orchestrator stays outside on the
// rationale that it runs only harness code. Activating read/grep/find/ls in
// the codemode arm breaks that premise: their paths are model-chosen.
// So their filesystem work runs as sandboxed children under the SAME settings
// file the kernel uses -- one policy, one enforcement engine, no node-side
// path-check reimplementation to drift. Identity passthrough when the
// HARNESS_KERNEL_SANDBOX_* pair is unset.
log("\ntool sandbox:");

sub(
	"core/tools/path-utils.ts",
	'import { accessSync, constants } from "node:fs";',
	`${patch("tool-sandbox.ts")}\n\nimport { accessSync, constants } from "node:fs";`,
	"sandboxed fs operations for the file tools",
	"export function toolSandboxWrap",
);

// After the ported-tool import block, not before it: scripts/port-vanilla-tools.mjs
// recognises its own block by adjacency to the ipython.js import, and re-inserts
// the whole block (duplicate imports, a build that will not compile) when anything
// lands between the two.
sub(
	"core/tools/index.ts",
	'import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.js";',
	'import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.js";\nimport { toolSandboxOptions } from "./path-utils.js";',
	"index.ts imports the sandbox options factory",
);

// Both definition factories: agent-session builds via createAllToolDefinitions;
// createToolDefinition is the single-tool path other callers use. The sandbox
// ops spread LAST so they win for read/grep/ls; ipython options pass through.
sub(
	"core/tools/index.ts",
	"export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {\n\tswitch (toolName) {",
	"export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {\n\toptions = { ...options, ...(toolSandboxOptions(cwd, options as Record<string, unknown>) as Partial<ToolsOptions>) };\n\tswitch (toolName) {",
	"createToolDefinition applies sandbox ops",
);

sub(
	"core/tools/index.ts",
	"export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {\n\treturn {",
	"export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {\n\toptions = { ...options, ...(toolSandboxOptions(cwd, options as Record<string, unknown>) as Partial<ToolsOptions>) };\n\treturn {",
	"createAllToolDefinitions applies sandbox ops",
);

// The two helper-binary spawns. Wrapping the ARGV keeps real rg/fd semantics
// and puts the search itself under seatbelt; the scrubbed env keeps provider
// keys out of the sandboxed child (kernelSpawnEnv's law, applied to tools).
sub(
	"core/tools/grep.ts",
	'import { spawn } from "child_process";',
	'import { toolSandboxSpawn } from "./path-utils.js";',
	"grep.ts spawns through the sandbox chokepoint",
);

// mapOutput: rg prints absolute paths, which in the remote shape are the
// sandbox's; the chokepoint rewrites them back so formatPath's relativising works.
sub(
	"core/tools/grep.ts",
	'const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });',
	"const child = toolSandboxSpawn(rgPath, args, { mapOutput: true });",
	"rg runs inside the sandbox",
);

sub(
	"core/tools/find.ts",
	'import { spawn } from "child_process";',
	'import { toolSandboxSpawn } from "./path-utils.js";',
	"find.ts spawns through the sandbox chokepoint",
);

sub(
	"core/tools/find.ts",
	'const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });',
	"const child = toolSandboxSpawn(fdPath, args, { mapOutput: true });",
	"fd runs inside the sandbox",
);

// --- cells that run commands this environment does not have -----------------
// The hole the FS guard leaves: it blocks rooted paths, so `which opsctl`
// and `pip list` walk past it (job dl3D-iS5). Separate flag from the FS guard —
// two interventions on the same cells are two conditions.
log("\nexec guard:");

sub(
	"core/tools/ipython.ts",
	"const RLM_BOOTSTRAP_BASE_CODE = `",
	`${patch("exec-guard.ts")}\n\nconst RLM_BOOTSTRAP_BASE_CODE = \``,
	"refuse commands that are not in this environment",
	"export function execGuardCheck(",
);

sub(
	"core/tools/ipython.ts",
	"const fsRefusal = fsGuardCheck(code, cwd);",
	"const fsRefusal = fsGuardCheck(code, cwd) ?? execGuardCheck(code) ?? readBatchGateCheck(code);",
	"check the guards and the one-time gate on the one pre-execution path",
	"?? readBatchGateCheck(code)",
);

// --- optional: show the kernel namespace after every cell -------------------
// Gated on HARNESS_SHOW_NAMESPACE=1 so it can be A/B'd against the prompt-only
// fix (variant q7) rather than silently becoming part of the arm.
//
// The snippets live in scripts/patches/*.ts as real TypeScript (see `patch`).
log("\nnamespace injection:");

sub(
	"core/tools/ipython.ts",
	'import { existsSync } from "node:fs";',
	'import { existsSync, mkdirSync, writeFileSync } from "node:fs";\nimport { join as pathJoin } from "node:path";',
	"fs/path imports for provenance",
);

sub(
	"core/tools/ipython.ts",
	"export function createIpythonToolDefinition(",
	`${patch("namespace-provenance.ts")}\n\nexport function createIpythonToolDefinition(`,
	"track assignment provenance",
	"const assignedAt = new Map<string, Provenance>()",
);

// The container-kernel backend (HARNESS_EXEC_CONTAINER, a hand-rolled kernel
// driven over `docker exec`) was REMOVED 2026-08-15. It was the abandoned first
// fix for TheAgentCompany — CLAUDE.md records why real-harness-in-container
// (PRIME_AGENT_KERNEL_PYTHON) replaced it — and nothing set the env var any
// more. Its patch also dead-lettered the namespace patch below via a marker
// collision, which is the second reason it must not come back as a patch file.
// A cell that blocks ends the run. prime's `ipython` tool has no per-cell
// timeout — grep it for `timeoutMs` and there is nothing — while `bash` exposes
// one that kills the process tree. That asymmetry decided three runs on
// TheAgentCompany: every codemode timeout was one wedged cell eating the whole
// 40-minute budget with ~5% of it spent executing. The causes were an
// `asyncio.run_until_complete` deadlock inside IPython's own event loop, a binary
// run under nested emulation, and a slow pip install.
//
// The kernel already knows how to interrupt (interrupt_request on the control
// channel, wired to abort with a force-kill grace period) and an interrupt keeps
// the namespace. Nothing was triggering it. HARNESS_CELL_TIMEOUT_MS does.
log("\nper-cell timeout:");

sub(
	"core/tools/ipython.ts",
	"\t\t\ttry {\n\t\t\t\tconst code = applyShellSettingsToBashMagicCell(params.code, options);",
	"\t\t\t// Bound each cell so one hang cannot consume the run. Abort drives the\n" +
		"\t\t\t// kernel's own interrupt, so variables and imports survive.\n" +
		"\t\t\tconst cellTimeoutMs = Number(process.env.HARNESS_CELL_TIMEOUT_MS ?? 0);\n" +
		"\t\t\tconst cellAbort = new AbortController();\n" +
		"\t\t\tlet cellTimedOut = false;\n" +
		"\t\t\tconst forwardAbort = () => cellAbort.abort();\n" +
		"\t\t\tsignal?.addEventListener(\"abort\", forwardAbort, { once: true });\n" +
		"\t\t\tconst cellTimer =\n" +
		"\t\t\t\tcellTimeoutMs > 0\n" +
		"\t\t\t\t\t? setTimeout(() => {\n" +
		"\t\t\t\t\t\t\tcellTimedOut = true;\n" +
		"\t\t\t\t\t\t\tcellAbort.abort();\n" +
		"\t\t\t\t\t\t}, cellTimeoutMs)\n" +
		"\t\t\t\t\t: undefined;\n" +
		"\t\t\ttry {\n\t\t\t\tconst code = applyShellSettingsToBashMagicCell(params.code, options);",
	"bound each cell with a timeout",
	"HARNESS_CELL_TIMEOUT_MS",
);

sub(
	"core/tools/ipython.ts",
	"\t\t\t\t\tsignal,\n\t\t\t\t\t(chunk) => {",
	"\t\t\t\t\tcellAbort.signal,\n\t\t\t\t\t(chunk) => {",
	"pass the bounded signal to the kernel",
	"cellAbort.signal,",
);

// Telling the model is the whole point. Interrupting a cell silently is worse
// than letting it hang: in testing the agent reported a `time.sleep(600)` cut off
// at 45s as having "completed with no output and no errors" and moved on. An
// agent that believes a truncated computation finished will build on a result it
// never got.
sub(
	"core/tools/ipython.ts",
	"\t\t\t\tlet text = r.stdout;",
	// The cell timer must stop when the cell RETURNS, not in the `finally`.
	//
	// Found by reading a trajectory: an agent used jobs.wait(wake_after=90)
	// correctly and was told "[this cell was INTERRUPTED after 60s]". It had not
	// been. The cell finished in milliseconds; the 90s host-side wait happens
	// after it, and the 60s timer ran through that and set cellTimedOut. Every
	// wait longer than the cell timeout accused a correct cell of being cut off,
	// teaching the agent to distrust the primitive it had just used properly.
	"\t\t\t\t// The cell has returned, so stop the cell clock HERE rather than in the\n" +
		"\t\t\t\t// finally below. Everything after this point is host-side time — the\n" +
		"\t\t\t\t// jobs.wait sleep — and letting the timer run through it marked a cell\n" +
		"\t\t\t\t// that finished in milliseconds as \"INTERRUPTED after 60s\" whenever the\n" +
		"\t\t\t\t// requested wait exceeded the cell timeout. The agent was told its work\n" +
		"\t\t\t\t// had been cut off when it had completed, which is precisely the wrong\n" +
		"\t\t\t\t// lesson about the primitive it had just used correctly.\n" +
		"\t\t\t\tclearTimeout(cellTimer);\n" +
		"\t\t\t\tconst cellTimedOutWhileExecuting = cellTimedOut;\n" +
		"\n" +
		"\t\t\t\tlet text = r.stdout;\n" +
		"\t\t\t\tif (cellTimedOutWhileExecuting) {\n" +
		"\t\t\t\t\ttext =\n" +
		"\t\t\t\t\t\t`[this cell was INTERRUPTED after ${Math.round(cellTimeoutMs / 1000)}s and did not finish. ` +\n" +
		"\t\t\t\t\t\t`Any output below is partial, and whatever it was computing did NOT complete. ` +\n" +
		"\t\t\t\t\t\t`Variables bound before this cell are still available. Do not assume this ` +\n" +
		"\t\t\t\t\t\t`worked. For work that legitimately takes this long, hand it to a job so it ` +\n" +
		"\t\t\t\t\t\t`outlives the cell:\\n` +\n" +
		"\t\t\t\t\t\t`    jobs.submit('your command', name='pick-a-name')\\n` +\n" +
		"\t\t\t\t\t\t`    jobs.wait(wake_after=120)   # last line of the cell\\n` +\n" +
		"\t\t\t\t\t\t`then jobs.get('pick-a-name') to collect it.]\\n\\n${text}`;\n" +
		"\t\t\t\t}",
	"tell the model when a cell was interrupted",
	"this cell was INTERRUPTED after",
);

sub(
	"core/tools/ipython.ts",
	"\t\t\t} finally {\n\t\t\t\tif (hasWorkingMessage) {",
	"\t\t\t} finally {\n" +
		"\t\t\t\tclearTimeout(cellTimer);\n" +
		"\t\t\t\tsignal?.removeEventListener(\"abort\", forwardAbort);\n" +
		"\t\t\t\tif (hasWorkingMessage) {",
	"clear the cell timer",
	// Unique to THIS patch's body. The previous marker, `clearTimeout(cellTimer);`,
	// is also emitted by the interrupt patch above, so the already-applied check
	// fired early and this patch was silently skipped on a fresh upstream — the
	// same collision class as the namespace patch. Caught by the pristine-replay
	// test the first time it ran.
	'removeEventListener("abort", forwardAbort)',
);

// The hosted-runtime v1 surface (docs/HOSTED-RUNTIME-DESIGN.md §4).
//
// Two patches. First: when a cell prints the wait sentinel, the *tool* sleeps —
// after the cell has finished and the kernel is free. That is the whole point.
// `time.sleep(235)` inside a cell holds a single-threaded kernel for the interval
// and collides with the cell timeout; this holds nothing. Same wall-clock, no
// kernel, no frame, no thread.
//
// Second: `threading.Thread` and long `time.sleep` fail loudly, pointing at
// jobs.*. The agent wrote the in-process form four times unprompted on one task
// — the in-distribution pull is strong enough that documentation loses to it.
log("\nhosted runtime (jobs):");

sub(
	"core/tools/ipython.ts",
	"\t\t\t\tlet text = r.stdout;",
	"\t\t\t\tlet text = r.stdout;\n" +
		"\t\t\t\t// jobs.wait(wake_after=N) — the cell has already returned, so this\n" +
		"\t\t\t\t// sleep holds nothing. See runtime/jobs.py.\n" +
		"\t\t\t\t// Line-anchored, and token-gated when HARNESS_WAIT_TOKEN is set: the\n" +
		"\t\t\t\t// sentinel is model-reachable stdout, so a bare substring match let a\n" +
		"\t\t\t\t// cat of a transcript arm an hour-long sleep (2026-08-15 review). The\n" +
		"\t\t\t\t// kernel inherits the token via env, so only runtime/jobs.py can emit it.\n" +
		"\t\t\t\tconst waitToken = process.env.HARNESS_WAIT_TOKEN;\n" +
		"\t\t\t\tconst waitRe = waitToken\n" +
		"\t\t\t\t\t? new RegExp(`^__HARNESS_WAIT_SECONDS__:(\\\\d+):${waitToken}$`, \"m\")\n" +
		"\t\t\t\t\t: /^__HARNESS_WAIT_SECONDS__:(\\d+)(?::[A-Za-z0-9_-]+)?$/m;\n" +
		"\t\t\t\tconst waitMatch = waitRe.exec(text);\n" +
		"\t\t\t\tif (waitMatch && process.env.HARNESS_WAIT_MODE === \"exit\") {\n" +
		"\t\t\t\t\t// Scheduler mode (runtime/scheduler.py): the run ENDS at a wait, by\n" +
		"\t\t\t\t\t// mechanism rather than by request. Asking the model to end its turn\n" +
		"\t\t\t\t\t// was measured twice (demo2/demo3: 36 and 28 zero-second waits) and\n" +
		"\t\t\t\t\t// lost to the sampling prior both times — the same lesson as the\n" +
		"\t\t\t\t\t// guards: a deviation the prose requests, the mechanism must enforce.\n" +
		"\t\t\t\t\t// The grace period lets the toolResult land in the session JSONL and\n" +
		"\t\t\t\t\t// the protocol stream; the wake is `--resume` plus a user message, so\n" +
		"\t\t\t\t\t// a transcript ending at this toolResult is exactly resumable. Any\n" +
		"\t\t\t\t\t// partial next turn the model starts in the window is never recorded\n" +
		"\t\t\t\t\t// (messages persist on message_end) and costs nothing but tokens.\n" +
		"\t\t\t\t\ttext = text.replace(\n" +
		"\t\t\t\t\t\twaitMatch[0],\n" +
		"\t\t\t\t\t\t`[wait armed: this process now exits; you will be re-invoked the moment the job finishes or the deadline passes]`,\n" +
		"\t\t\t\t\t);\n" +
		"\t\t\t\t\tsetTimeout(() => {\n" +
		"\t\t\t\t\t\t// Take the kernel down with us: a bare process.exit orphans the\n" +
		"\t\t\t\t\t\t// ipykernel child — harmless per bench run, a per-wake process\n" +
		"\t\t\t\t\t\t// leak on a long-lived host. dispose() also drops an in-flight\n" +
		"\t\t\t\t\t\t// boot; the race caps a hung shutdown so the exit is never held.\n" +
		"\t\t\t\t\t\tvoid Promise.race([\n" +
		"\t\t\t\t\t\t\tprovisioner.dispose(),\n" +
		"\t\t\t\t\t\t\tnew Promise((resolve) => setTimeout(resolve, 3000)),\n" +
		"\t\t\t\t\t\t]).finally(() => process.exit(0));\n" +
		"\t\t\t\t\t}, Number(process.env.HARNESS_WAIT_EXIT_GRACE_MS ?? 1500));\n" +
		"\t\t\t\t} else if (waitMatch) {\n" +
		"\t\t\t\t\tconst secs = Math.min(Number(waitMatch[1]), Number(process.env.HARNESS_MAX_WAIT_SECONDS ?? 3600));\n" +
		"\t\t\t\t\tsetToolWorkingMessage(`waiting ${secs}s (kernel released)`);\n" +
		"\t\t\t\t\t// Abortable: a run timeout or Ctrl-C must interrupt the wait, not\n" +
		"\t\t\t\t\t// sit behind it — one wedged wait ate 20 minutes past its own budget.\n" +
		"\t\t\t\t\tawait new Promise((resolve) => {\n" +
		"\t\t\t\t\t\tconst waitTimer = setTimeout(resolve, secs * 1000);\n" +
		"\t\t\t\t\t\tcellAbort.signal.addEventListener(\n" +
		"\t\t\t\t\t\t\t\"abort\",\n" +
		"\t\t\t\t\t\t\t() => {\n" +
		"\t\t\t\t\t\t\t\tclearTimeout(waitTimer);\n" +
		"\t\t\t\t\t\t\t\tresolve(undefined);\n" +
		"\t\t\t\t\t\t\t},\n" +
		"\t\t\t\t\t\t\t{ once: true },\n" +
		"\t\t\t\t\t\t);\n" +
		"\t\t\t\t\t});\n" +
		"\t\t\t\t\ttext = text.replace(waitMatch[0], `[waited ${secs}s outside the kernel]`);\n" +
		"\t\t\t\t}",
	"host-side wait for jobs.wait",
	"__HARNESS_WAIT_SECONDS__",
);

// --- surviving the death of the kernel ---------------------------------------
//
// The hosted runtime's central claim is that work outlives the kernel. Testing it
// needs a kernel that comes back, and upstream has no such path: a kernel killed out
// from under the agent (SIGKILL, OOM, container restart) sets state="shutdown", and
// `IpythonKernelProvisioner.ensure()` keeps returning that same memoised corpse, so
// every later cell throws "Kernel has been shut down" for the rest of the run.
// Upstream only ever rebuilds a kernel when a *human* picks "Kill kernel and restart"
// at the busy-kernel prompt, and print mode has no human.
//
// Measured with HARNESS_KERNEL_AUTORESTART unset: after an external SIGKILL the agent
// spent its remaining 11 cells on "Kernel has been shut down", never ran another line
// of Python, and reported failure on a job that had in fact completed on disk. That is
// a harness limit, not an agent failure, and it makes the durability property
// unobservable — see docs/DURABILITY-RESULTS.md.
//
// Gated on HARNESS_KERNEL_AUTORESTART=1 so the wedge is preserved by default and the
// two conditions are the same code path with a flag.
//
// The notice deliberately says NOTHING about jobs. Whether the agent knows its
// background work survived is the thing under test; putting the answer in the harness
// notice would measure instruction-following instead.
log("\nkernel auto-restart after death:");

sub(
	"core/tools/ipython.ts",
	`const KERNEL_RESTART_NOTICE = [`,
	`const KERNEL_DEATH_NOTICE = [
	"<ipython_kernel_restarted>",
	"The IPython kernel process died and a fresh one was started. Every variable, import and in-memory object defined before this point is gone; recreate anything you still need. Nothing outside the process was lost: your files and this working directory are intact on disk, and background jobs kept running — \`jobs.manifest()\` lists them, \`jobs.get('<name>')\` reaches one.",
	"</ipython_kernel_restarted>",
].join("\\n");
const KERNEL_RESTART_NOTICE = [`,
	"a notice for a kernel that died rather than one restarted on purpose",
	"KERNEL_DEATH_NOTICE",
);

sub(
	"core/tools/ipython.ts",
	`): Promise<{ result: ExecuteResult; kernelRestarted: boolean }> {\n\tlet kernelRestarted = false;`,
	`): Promise<{ result: ExecuteResult; kernelRestarted: boolean; kernelDied: boolean }> {\n` +
		`\tlet kernelRestarted = false;\n` +
		`\t// Bounded: a kernel that dies on every boot must fail the call, not spin.\n` +
		`\tlet deadKernelRestarts = 0;\n` +
		`\tlet kernelDied = false;`,
	"track a dead kernel separately from a deliberately restarted one",
	"let deadKernelRestarts = 0;",
);

sub(
	"core/tools/ipython.ts",
	`\t\t\treturn {\n\t\t\t\tresult: await m.execute(code, {`,
	`\t\t\treturn {\n\t\t\t\tkernelDied,\n\t\t\t\tresult: await m.execute(code, {`,
	"return the death flag",
	"kernelDied,\n\t\t\t\tresult:",
);

sub(
	"core/tools/ipython.ts",
	`\t\t} catch (error) {\n\t\t\tif (!(error instanceof KernelBusyAfterInterruptError) || signal?.aborted) {\n\t\t\t\tthrow error;\n\t\t\t}`,
	`\t\t} catch (error) {\n` +
		`\t\t\t// The kernel died under us. Drop the corpse the provisioner is memoising and\n` +
		`\t\t\t// boot a fresh one, then tell the model — the same recovery the busy path\n` +
		`\t\t\t// already performs, minus the human. See scripts/neutralize-prime.mjs.\n` +
		`\t\t\tif (\n` +
		`\t\t\t\tprocess.env.HARNESS_KERNEL_AUTORESTART === "1" &&\n` +
		`\t\t\t\tdeadKernelRestarts < 3 &&\n` +
		`\t\t\t\t!signal?.aborted &&\n` +
		`\t\t\t\t/Kernel has been shut down|Kernel exited/.test(String((error as { message?: string })?.message ?? ""))\n` +
		`\t\t\t) {\n` +
		`\t\t\t\tdeadKernelRestarts += 1;\n` +
		`\t\t\t\tonWorkingMessage("Restarting IPython kernel...");\n` +
		`\t\t\t\tawait provisioner.kill();\n` +
		`\t\t\t\tkernelRestarted = true;\n` +
		`\t\t\t\tkernelDied = true;\n` +
		`\t\t\t\tcontinue;\n` +
		`\t\t\t}\n` +
		`\t\t\tif (!(error instanceof KernelBusyAfterInterruptError) || signal?.aborted) {\n\t\t\t\tthrow error;\n\t\t\t}`,
	"rebuild a dead kernel instead of throwing forever",
	"HARNESS_KERNEL_AUTORESTART",
);

sub(
	"core/tools/ipython.ts",
	`\t\t\t\tconst { result: r, kernelRestarted } = await executeWithBusyKernelChoice(`,
	`\t\t\t\tconst { result: r, kernelRestarted, kernelDied } = await executeWithBusyKernelChoice(`,
	"destructure the death flag at the call site",
	"kernelRestarted, kernelDied }",
);

sub(
	"core/tools/ipython.ts",
	`\t\t\t\tif (kernelRestarted) {\n\t\t\t\t\ttext = text ? \`\${KERNEL_RESTART_NOTICE}\\n\\n\${text}\` : KERNEL_RESTART_NOTICE;\n\t\t\t\t}`,
	`\t\t\t\tif (kernelRestarted) {\n` +
		`\t\t\t\t\tconst notice = kernelDied ? KERNEL_DEATH_NOTICE : KERNEL_RESTART_NOTICE;\n` +
		`\t\t\t\t\ttext = text ? \`\${notice}\\n\\n\${text}\` : notice;\n` +
		`\t\t\t\t}`,
	"pick the notice that matches what actually happened",
	"const notice = kernelDied ?",
);

log("\ncontainer kernel:");

// Appended *after* the provenance import pair, never between its two lines:
// that pair is the guard for the patch above, and splitting it makes the guard
// miss and the whole script fail on the second run.
sub(
	"core/tools/ipython.ts",
	"\t\t\t\tconst imageBlocks = imageBlocksFromAttachments(r.attachments);",
	`${patch("namespace-inject.ts")
		.split("\n")
		.map((l) => (l ? `\t\t\t\t${l}` : l))
		.join("\n")}\n\n\t\t\t\tconst imageBlocks = imageBlocksFromAttachments(r.attachments);`,
	"append live namespace to each cell result",
	// Deliberately a phrase unique to the injected BODY, not the env var name.
	// The env var appears in doc comments of other patches: guarding on it made
	// the already-applied check fire early and silently skip this patch on a
	// fresh upstream — the exact plausible-number trap this script exists to
	// avoid, caught by the 2026-08-15 review. bench/test/provenance.test.mjs's
	// pristine-replay test now pins scripts ≡ tree.
	"already available, do not re-fetch",
);

// --- sandbox the REPL, not the agent -----------------------------------------
//
// Hands, not brain. The agent process runs no model-authored code — it talks to the
// model API and owns a daemon socket. The kernel is where code the model wrote
// actually executes, so it is the only thing that needs an OS-level boundary.
//
// Wrapping the agent instead was tried first and is wrong twice: it buys nothing
// (nothing untrusted runs there) and it breaks the daemon, whose Unix socket srt
// blocks by default.
//
// It is also where benchmark integrity lives. `curl` to an API that the MCP tools
// wrap happens in a *cell*. A network allowlist on the kernel is the enforcement the
// dead-proxy trick was approximating — and on Linux it is airtight, because srt
// removes the network namespace entirely and routes over Unix sockets, so unsetting
// http_proxy leaves no route rather than an unfiltered one.
//
// FAIL CLOSED on HARNESS_KERNEL_SANDBOX_SETTINGS: with it unset the kernel REFUSES to
// start unless HARNESS_KERNEL_SANDBOX=off says the launcher chose bare on purpose.
// The old gate ran bare on silence, and silence is how the product arm shipped
// model-authored code execution with no boundary -- the variable is the transport
// for the posture, never the policy. Off remains available (it is a measured
// benchmark condition) but must be said, so it lands in provenance.
log("\nkernel boot budget:");

// W42/W43: the boot handshake gives up after a HARDCODED 5s. The kernel venv is
// 341 MB across 17,192 files and faults in on first boot -- measured 15x cold vs
// warm on AppWorld, and 70s -> 310s with six concurrent workers. A boot slower
// than 5s never completes, the rebuild path faults just as cold, and the round
// spends its whole budget on the same error: one measured round burned 99 cells
// that way, scored as a weak agent.
//
// W43's venv warm is the primary fix and should make this moot. This is the
// fallback, and the lever to reach for if `stopped_by: dead-kernel` survives it.
// Default-preserving: unset means literally 5000, so an unflagged build stays
// byte-faithful to upstream.
sub(
	"core/kernel/index.ts",
	"const PORTS_RESOLVE_TIMEOUT_MS = 5000;",
	'const PORTS_RESOLVE_TIMEOUT_MS = Number(process.env.HARNESS_KERNEL_PORTS_TIMEOUT_MS) || 5000;',
	"kernel port resolution honours HARNESS_KERNEL_PORTS_TIMEOUT_MS",
	"HARNESS_KERNEL_PORTS_TIMEOUT_MS",
);

sub(
	"core/kernel/index.ts",
	"const READY_TIMEOUT_MS = 5000;",
	'const READY_TIMEOUT_MS = Number(process.env.HARNESS_KERNEL_READY_TIMEOUT_MS) || 5000;',
	"kernel readiness handshake honours HARNESS_KERNEL_READY_TIMEOUT_MS",
	"HARNESS_KERNEL_READY_TIMEOUT_MS",
);

// Kernel stderr is where IPython's startup warnings go; upstream never writes
// it anywhere unless the kernel dies. See scripts/patches/kernel-stderr-log.ts.
sub(
	"core/kernel/index.ts",
	'import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
	'import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
	"kernel/index.ts imports appendFileSync for the stderr log",
	"appendFileSync",
);
sub(
	"core/kernel/index.ts",
	`\t\t\tkernel.stderr?.on("data", (buf: Buffer) => {\n\t\t\t\tconst s = buf.toString();\n\t\t\t\tthis.kernelStderr += s;\n\t\t\t});`,
	patch("kernel-stderr-log.ts"),
	"kernel stderr is persisted to HARNESS_KERNEL_STDERR_LOG",
	"HARNESS_KERNEL_STDERR_LOG",
);

log("\nsandboxed kernel:");

sub(
	"core/kernel/index.ts",
	`\t\t\tconst kernel = spawn(python, ["-m", "ipykernel_launcher", "-f", connection.path], {`,
	`\t\t\t// Sandbox the REPL (hands), never the agent (brain). See\n` +
		`\t\t\t// scripts/neutralize-prime.mjs and runtime/eval/run.mjs.\n` +
		`\t\t\tconst sandboxSettings = process.env.HARNESS_KERNEL_SANDBOX_SETTINGS;\n` +
		`\t\t\tconst sandboxBin = process.env.HARNESS_KERNEL_SANDBOX_BIN ?? "srt";\n` +
		`\t\t\tif (!sandboxSettings && process.env.HARNESS_KERNEL_SANDBOX !== "off") {\n` +
		`\t\t\t\t// FAIL CLOSED. An unset variable used to mean "run bare", and that\n` +
		`\t\t\t\t// silence is how an arm shipped model-authored code execution with\n` +
		`\t\t\t\t// no boundary for weeks -- nothing forced launchers to set it.\n` +
		`\t\t\t\t// Unsandboxed is a condition a launcher must SAY, and record.\n` +
		`\t\t\t\tthrow new Error(\n` +
		`\t\t\t\t\t"refusing to start an unsandboxed kernel: set HARNESS_KERNEL_SANDBOX_SETTINGS " +\n` +
		`\t\t\t\t\t\t"(runtime/posture.mjs srtSettings + pythonPrefixes build it) or set " +\n` +
		`\t\t\t\t\t\t"HARNESS_KERNEL_SANDBOX=off explicitly and record it in the run's provenance",\n` +
		`\t\t\t\t);\n` +
		`\t\t\t}\n` +
		`\t\t\tconst kernelArgv: [string, string[]] = sandboxSettings\n` +
		`\t\t\t\t// srt takes SPLIT argv, not one command string: the README's\n` +
		`\t\t\t\t// \`srt "cmd"\` form fails with "command not found".\n` +
		`\t\t\t\t? [sandboxBin, ["--settings", sandboxSettings, python, "-m", "ipykernel_launcher", "-f", connection.path]]\n` +
		`\t\t\t\t: [python, ["-m", "ipykernel_launcher", "-f", connection.path]];\n` +
		`\t\t\tconst kernel = spawn(kernelArgv[0], kernelArgv[1], {`,
	"sandbox the ipython kernel",
	"HARNESS_KERNEL_SANDBOX_SETTINGS",
);

// The fail-closed check, for a tree the sub above patched BEFORE it carried one.
// That sub's marker (HARNESS_KERNEL_SANDBOX_SETTINGS) is already present there, so
// it reports `present` and never inserts the check: exactly the silent staleness
// assertPatchesInSync below exists to name. A pristine tree gets the check from
// the sub above and this one reports `present`.
sub(
	"core/kernel/index.ts",
	`\t\t\tconst sandboxBin = process.env.HARNESS_KERNEL_SANDBOX_BIN ?? "srt";\n\t\t\tconst kernelArgv`,
	`\t\t\tconst sandboxBin = process.env.HARNESS_KERNEL_SANDBOX_BIN ?? "srt";\n` +
		`\t\t\tif (!sandboxSettings && process.env.HARNESS_KERNEL_SANDBOX !== "off") {\n` +
		`\t\t\t\t// FAIL CLOSED. An unset variable used to mean "run bare", and that\n` +
		`\t\t\t\t// silence is how an arm shipped model-authored code execution with\n` +
		`\t\t\t\t// no boundary for weeks -- nothing forced launchers to set it.\n` +
		`\t\t\t\t// Unsandboxed is a condition a launcher must SAY, and record.\n` +
		`\t\t\t\tthrow new Error(\n` +
		`\t\t\t\t\t"refusing to start an unsandboxed kernel: set HARNESS_KERNEL_SANDBOX_SETTINGS " +\n` +
		`\t\t\t\t\t\t"(runtime/posture.mjs srtSettings + pythonPrefixes build it) or set " +\n` +
		`\t\t\t\t\t\t"HARNESS_KERNEL_SANDBOX=off explicitly and record it in the run's provenance",\n` +
		`\t\t\t\t);\n` +
		`\t\t\t}\n` +
		`\t\t\tconst kernelArgv`,
	"the kernel fails closed without sandbox settings",
	"refusing to start an unsandboxed kernel",
);

// The full-transcript upload is installed unconditionally upstream and no env
// var gates it (PI_OFFLINE does not reach agent-traces.ts) — the one
// call-home a host cannot switch off. Gate it behind an explicit opt-in.
sub(
	"core/agent-session-services.ts",
	`	installAgentTraceUpload(options.sessionManager, {
		authStorage: options.services.authStorage,
		settingsManager: options.services.settingsManager,
	});`,
	`	// Installed unconditionally upstream, and no env var gates it — the only
	// call-home a host cannot switch off (2026-08-15 audit). When enabled and
	// credentialed it PUTs the entire session JSONL with cwd/git headers. A
	// hosted harness must opt IN, never be unable to opt out.
	if (process.env.PRIME_AGENT_TRACES === "1") {
		installAgentTraceUpload(options.sessionManager, {
			authStorage: options.services.authStorage,
			settingsManager: options.services.settingsManager,
		});
	}`,
	"trace upload is opt-in",
	'process.env.PRIME_AGENT_TRACES === "1"',
);

// --- remote kernel: the kernel in a sandbox on another machine ---------------
//
// Hands, not brain, taken one step further: the loop stays where the credentials
// are, and the kernel (plus every file tool) runs inside a remote sandbox — a
// Daytona sandbox, in the assistant — reached over one WebSocket. The modules are
// whole files under scripts/patches/remote-kernel/, placed verbatim into
// core/kernel/remote/; what follows are the three seams that choose them.
//
// The remote backend declares the sandbox as the boundary: the loop never starts a
// local kernel, and the in-sandbox server refuses to start one while its own probe
// can reach the internet (server.ts startKernel). See runtime/daytona/README.md.
log("\nremote kernel:");

const REMOTE_KERNEL_FILES = [
	"protocol.ts",
	"channel.ts",
	"config.ts",
	"pathmap.ts",
	"skills.ts",
	"link.ts",
	"manager.ts",
	"tools.ts",
	"server.ts",
	"server-main.ts",
];

/** Place a whole-file patch; the file under scripts/patches is the source of truth. */
function place(relPath, patchPath, label) {
	const path = join(PRIME, relPath);
	const body = readFileSync(join(ROOT, "scripts/patches", patchPath), "utf8");
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path) && readFileSync(path, "utf8") === body) return log(`  present ${relPath} :: ${label}`);
	writeFileSync(path, body);
	log(`  placed  ${relPath} :: ${label}`);
}

for (const name of REMOTE_KERNEL_FILES) {
	place(`core/kernel/remote/${name}`, `remote-kernel/${name}`, "remote kernel module");
}

sub(
	"core/tools/ipython.ts",
	'import { manifestPathIn, type RestoreResult, snapshotPathIn } from "../kernel/state-snapshot.js";',
	'import { isRemoteKernelEnabled } from "../kernel/remote/config.js";\n' +
		'import { RemoteKernelManager } from "../kernel/remote/manager.js";\n' +
		'import { createRemoteKernelManager } from "../kernel/remote/tools.js";\n' +
		'import { manifestPathIn, type RestoreResult, snapshotPathIn } from "../kernel/state-snapshot.js";',
	"ipython.ts imports the remote kernel",
	"../kernel/remote/manager.js",
);

sub(
	"core/tools/ipython.ts",
	"\t\t\tconst snapshotDir = this.options?.snapshotDir;\n\t\t\tconst m = new KernelManager({",
	"\t\t\tconst snapshotDir = this.options?.snapshotDir;\n" +
		"\t\t\t// HARNESS_REMOTE_KERNEL_URL: the kernel runs in a sandbox elsewhere, behind\n" +
		"\t\t\t// the same KernelManager surface. Its snapshot lives on the sandbox's disk,\n" +
		"\t\t\t// keyed by session id, so a restarted loop or sandbox revives the namespace.\n" +
		"\t\t\tconst m = isRemoteKernelEnabled()\n" +
		"\t\t\t\t? createRemoteKernelManager({\n" +
		"\t\t\t\t\t\tlocalCwd: this.cwd,\n" +
		"\t\t\t\t\t\tenv: this.options?.env,\n" +
		"\t\t\t\t\t\tsessionId: this.options?.sessionId,\n" +
		"\t\t\t\t\t\thostHandlers: this.options?.hostHandlers,\n" +
		"\t\t\t\t\t\tpythonSkills: this.options?.pythonSkills,\n" +
		"\t\t\t\t\t\tsnapshotKey: snapshotDir ? (this.options?.sessionId ?? snapshotDir) : undefined,\n" +
		"\t\t\t\t\t})\n" +
		"\t\t\t\t: new KernelManager({",
	"remote kernel swaps in behind the provisioner",
	"createRemoteKernelManager({",
);

// The snapshot is on the sandbox's disk; asking the loop's disk would always say no.
sub(
	"core/tools/ipython.ts",
	"\t\t\t\t\tconst snapshotExisted = existsSync(snapshotPathIn(snapshotDir));",
	"\t\t\t\t\tconst snapshotExisted =\n" +
		"\t\t\t\t\t\tm instanceof RemoteKernelManager ? await m.snapshotExists() : existsSync(snapshotPathIn(snapshotDir));",
	"remote snapshot existence is asked of the sandbox",
	"await m.snapshotExists()",
);

// ws is what both ends speak; it was only a transitive dependency before.
subPackageJson(
	'\t\t"uuid": "^14.0.0",\n',
	'\t\t"uuid": "^14.0.0",\n\t\t"ws": "^8.21.0",\n',
	"ws is a declared dependency",
	'"ws": "^8.21.0"',
);
subPackageJson(
	'\t\t"@types/proper-lockfile": "^4.1.4",\n',
	'\t\t"@types/proper-lockfile": "^4.1.4",\n\t\t"@types/ws": "^8.18.1",\n',
	"@types/ws for the remote kernel",
	'"@types/ws"',
);

/** sub() for the coding-agent package.json, which sits beside src/. */
function subPackageJson(find, replace, label, marker) {
	const path = join(PRIME, "..", "package.json");
	const src = readFileSync(path, "utf8");
	if (src.includes(marker)) return log(`  present package.json :: ${label}`);
	if (src.split(find).length - 1 !== 1) throw new Error(`package.json: expected 1 match for ${label}`);
	writeFileSync(path, src.replace(find, () => replace));
	log(`  patched package.json :: ${label}`);
}

log("\nkernel display images:");

// A product host shows cells to a person, and a chart drawn with plt.show() is the
// cell's point. See scripts/patches/display-images.ts; off unless HARNESS_DISPLAY_IMAGES=1.
sub(
	"core/kernel/index.ts",
	"function parseSentAgentMessage(payload: unknown): KernelSentAgentMessage | undefined {",
	`${patch("display-images.ts")}\n\nfunction parseSentAgentMessage(payload: unknown): KernelSentAgentMessage | undefined {`,
	"plain image displays become attachments under HARNESS_DISPLAY_IMAGES=1",
	"HARNESS_DISPLAY_IMAGE_MIMES",
);
sub(
	"core/kernel/index.ts",
	"\t\t\tconst attachment = parseAttachmentDisplay(c.data?.[ATTACHMENT_DISPLAY_MIME]);\n",
	"\t\t\tconst attachment = parseAttachmentDisplay(c.data?.[ATTACHMENT_DISPLAY_MIME]) ?? harnessDisplayImage(c.data);\n",
	"display handler consults the plain-image fallback",
	"?? harnessDisplayImage(c.data)",
);

// --- thinking display: summarized holds thinking back until it ends -----------
//
// Anthropic's "summarized" display sends the thinking summary only once the
// thinking block is over, so the first streamed byte of a turn that thinks lands
// seconds after the model started (Sonnet 5, effort medium: 5.45 s vs 1.7 s
// omitted). A caller that shows "thinking" rather than the thoughts opts into
// "omitted" with HARNESS_THINKING_DISPLAY; unset keeps upstream's default.
log("\nthinking display:");
const AI_ANTHROPIC = "../../ai/src/providers/anthropic.ts";
sub(
	AI_ANTHROPIC,
	'export type AnthropicThinkingDisplay = "summarized" | "omitted";',
	`export type AnthropicThinkingDisplay = "summarized" | "omitted";\n\n${patch("thinking-display.ts")}`,
	"HARNESS_THINKING_DISPLAY helper",
	"function harnessThinkingDisplay",
);
sub(
	AI_ANTHROPIC,
	'const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";',
	'const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? harnessThinkingDisplay() ?? "summarized";',
	"thinking display defaults to HARNESS_THINKING_DISPLAY",
	"?? harnessThinkingDisplay() ??",
);

/**
 * Every `scripts/patches/*.ts` body must be present VERBATIM in the vendored tree.
 *
 * `sub`'s already-applied check is a short stable marker, deliberately, so that
 * editing a patch body does not cause a double insertion. The cost of that choice
 * is silent staleness: once the marker exists, an edited patch file is never
 * re-applied and the vendored tree keeps running the OLD body while the patch file
 * -- the thing a reader treats as the source of truth -- shows the new one.
 *
 * Measured: the filesystem guard's path matcher read `~45` (from `arms bent ~45°`
 * in a creative prompt) as a home-relative path and refused the whole cell. The
 * fix was written to `scripts/patches/fs-guard.ts`, this script reported
 * `present ... :: refuse cells that reach outside...`, the build succeeded, the
 * tests still failed, and the vendored tree still held the unfixed regex. Nothing
 * in the pipeline said so.
 *
 * So the sync is asserted rather than assumed, per "a documented check is not an
 * executed check". This is a WARNING, not a throw: patch bodies are also rewritten
 * in place by later `sub` calls in this file (the exec-guard chains onto the fs
 * guard's line), so exact absence is strong evidence of drift but not proof of it.
 * It names the file, which is all a reader needs to go look.
 */
function assertPatchesInSync() {
	log("\npatch-file sync:");
	const dir = join(ROOT, "scripts/patches");
	let drifted = 0;
	for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
		const body = readFileSync(join(dir, name), "utf8").trimEnd();
		// The patch's own first declaration is enough to locate it; comparing whole
		// bodies would flag every legitimate downstream rewrite as drift.
		const probe = body.split("\n").filter((l) => l.trim() && !l.trim().startsWith("*") && !l.trim().startsWith("/*") && !l.trim().startsWith("//"));
		const hit = walkPrime().some((file) => {
			const src = readFileSync(file, "utf8");
			return probe.every((line) => src.includes(line.trim()));
		});
		if (hit) log(`  in sync  ${name}`);
		else {
			drifted++;
			log(`  DRIFT    ${name} :: the vendored tree does not contain this patch body verbatim.`);
			log("           The marker-based already-applied check will NOT re-apply an edited");
			log("           patch. Sync the vendored copy, rebuild, and re-run the tests.");
		}
	}
	if (!drifted) log("  all patch bodies present verbatim");
}

/** Every .ts under the vendored source tree. */
function walkPrime() {
	const out = [];
	// The ai package too: the thinking-display patch lives in its anthropic provider.
	const stack = [join(PRIME), join(PRIME, "../../ai/src")];
	while (stack.length) {
		for (const e of readdirSync(stack.pop(), { withFileTypes: true })) {
			const full = join(e.parentPath ?? e.path, e.name);
			if (e.isDirectory()) {
				if (e.name !== "node_modules" && e.name !== "dist") stack.push(full);
			} else if (e.name.endsWith(".ts")) out.push(full);
		}
	}
	return out;
}

assertPatchesInSync();

log("\ndone.");
