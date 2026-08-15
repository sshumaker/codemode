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
import { readFileSync, writeFileSync } from "node:fs";
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

log("neutralizing prime-agent for reproducible runs\n");

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

// --- optional: show the kernel namespace after every cell -------------------
// Gated on HARNESS_SHOW_NAMESPACE=1 so it can be A/B'd against the prompt-only
// fix (variant q7) rather than silently becoming part of the arm.
//
// The snippets live in scripts/patches/*.ts as real TypeScript. Embedding them
// as escaped strings here mangled every backslash — `\n` became a literal
// newline and `\w` became `w` — and produced a file that did not compile.
log("\nnamespace injection:");

const patch = (name) => readFileSync(join(ROOT, "scripts/patches", name), "utf8").trimEnd();

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
		"\t\t\t\tif (waitMatch) {\n" +
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
	"The IPython kernel process died and a fresh one was started. Every variable, import and in-memory object defined before this point is gone; recreate anything you still need.",
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
// Gated on HARNESS_KERNEL_SANDBOX_SETTINGS: with it unset the spawn is byte-identical
// to upstream, so an unsandboxed run is unchanged and the two are comparable.
log("\nsandboxed kernel:");

sub(
	"core/kernel/index.ts",
	`\t\t\tconst kernel = spawn(python, ["-m", "ipykernel_launcher", "-f", connection.path], {`,
	`\t\t\t// Sandbox the REPL (hands), never the agent (brain). See\n` +
		`\t\t\t// scripts/neutralize-prime.mjs and runtime/eval/run.mjs.\n` +
		`\t\t\tconst sandboxSettings = process.env.HARNESS_KERNEL_SANDBOX_SETTINGS;\n` +
		`\t\t\tconst sandboxBin = process.env.HARNESS_KERNEL_SANDBOX_BIN ?? "srt";\n` +
		`\t\t\tconst kernelArgv: [string, string[]] = sandboxSettings\n` +
		`\t\t\t\t// srt takes SPLIT argv, not one command string: the README's\n` +
		`\t\t\t\t// \`srt "cmd"\` form fails with "command not found".\n` +
		`\t\t\t\t? [sandboxBin, ["--settings", sandboxSettings, python, "-m", "ipykernel_launcher", "-f", connection.path]]\n` +
		`\t\t\t\t: [python, ["-m", "ipykernel_launcher", "-f", connection.path]];\n` +
		`\t\t\tconst kernel = spawn(kernelArgv[0], kernelArgv[1], {`,
	"sandbox the ipython kernel",
	"HARNESS_KERNEL_SANDBOX_SETTINGS",
);

log("\ndone.");
