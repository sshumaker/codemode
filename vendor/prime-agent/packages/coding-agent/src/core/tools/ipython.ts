// TODO: reconsider whether the persistent kernel is needed once RLM-1 weights land.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IMAGE_MIME_TYPES } from "../../utils/mime.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { withKernelBootPermit } from "../kernel/boot-gate.js";
import type { KernelBootstrapProgressHandler } from "../kernel/bootstrap.js";
import {
	type ExecuteResult,
	type HostRequestHandlers,
	type KernelAttachment,
	KernelBusyAfterInterruptError,
	type KernelDiffDisplay,
	KernelManager,
	type KernelSentAgentMessage,
} from "../kernel/index.js";
import { isRemoteKernelEnabled } from "../kernel/remote/config.js";
import { RemoteKernelManager } from "../kernel/remote/manager.js";
import { createRemoteKernelManager, remoteKernelCwd } from "../kernel/remote/tools.js";
import { manifestPathIn, type RestoreResult, snapshotPathIn } from "../kernel/state-snapshot.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";
import { parseIpythonBashCell } from "./ipython-cell-code.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

/**
 * Trim an IPython traceback to the exception and the lines that raised it.
 *
 * Measured on a real bridge error (the fixture in bench/test/fixtures/, captured
 * from the same IPython the kernel runs): **2,961 characters across 8 frames, with
 * the message last.** The bulk is not asyncio plumbing. IPython prints source
 * CONTEXT around each frame's failing line, and in the compiled API bridge the
 * lines above `return await _call(...)` are the function's entire docstring — so a
 * two-call chain re-printed two docstrings the model had already been given, then
 * `_client.py`'s docstring, then the payload literal, and only then said what was
 * wrong. On the product port GLM 5.2 hit this 12 times in 83 cells.
 *
 * ipykernel sends one array element per frame, so the trim is structural rather
 * than a regex over the whole blob:
 *
 *   - interpreter plumbing (asyncio, nest_asyncio, ipykernel, IPython) is dropped;
 *     the mistake is never there,
 *   - a frame that is only a call INTO the generated bridge is dropped. Detected
 *     from the marked line, not from a path: `await _call(...)`, `_validate(...)`
 *     and the bridge's own `raise` are the three, and the exception message names
 *     the API, the argument and the constraint already,
 *   - in every surviving frame the lines BEFORE the `--->` marker go and the
 *     marker line and everything after it stay. That keeps the location line, the
 *     offending line and the continuation lines carrying the arguments the model
 *     passed, and drops the echoed docstring,
 *   - the leading separator, the `ExcType Traceback (most recent call last)`
 *     header and the final `ExcType: message` are kept verbatim.
 *
 * On the fixture: 2,961 -> 931 characters, and what remains is the header, the
 * model's own two frames, and the message. Nothing that names code the model
 * wrote is dropped, so an ordinary Python bug in a cell is still diagnosable —
 * a plain `KeyError` matches none of these rules and only loses the source lines
 * above the one that raised.
 *
 * OFF unless HARNESS_TRACEBACK_TRIM=1, and off is byte-faithful to upstream — an
 * unflagged build renders exactly what every pre-trim run saw.
 *
 * The default is not timidity about the trim; it is about how a condition gets
 * selected. Before this gate the trim was chosen by REBUILDING dist, and a
 * rebuild in a checkout that a live eval was reading put the trim into two jobs
 * that had not asked for it (one kept — no error cells, so the trim could not
 * have mattered — one excluded). An env var lets ONE dist serve both arms of an
 * A/B, makes the condition explicit in the run recipe rather than implicit in a
 * build timestamp, and cannot leak into a run that did not name it.
 * See scripts/neutralize-prime.mjs.
 */
const TRACEBACK_PLUMBING =
	/(?:^|[/\\])(?:nest_asyncio\d*\.py|asyncio[/\\][^/\\]+\.py|ipykernel(?:_launcher)?[/\\]|IPython[/\\]core[/\\])/;

/** The marked line of a frame that is only a hop through the generated bridge. */
const BRIDGE_HOP = /^\s*-+>\s*\d*\s*(?:return )?(?:await _call\(|_validate\(server, tool|raise (?:ArgumentError|McpError|DocsFirst|ReadFirst)\()/;

export function trimCellTraceback(traceback: readonly string[]): string {
	const frames = traceback ?? [];
	// Read per call, not captured at module load: the kernel and the agent share a
	// process, and a value frozen at import would make the flag depend on when the
	// module was first required rather than on the run's own environment.
	if (process.env.HARNESS_TRACEBACK_TRIM !== "1" || frames.length < 3) return frames.join("\n");

	const kept: string[] = [];
	frames.forEach((frame, index) => {
		// The first two elements are the separator and the `ExcType Traceback ...`
		// header; the last is the message. All three are what the trim is FOR.
		if (index < 2 || index === frames.length - 1) {
			kept.push(frame);
			return;
		}
		if (TRACEBACK_PLUMBING.test(frame)) return;
		const lines = frame.split("\n");
		const marker = lines.findIndex((line) => /^\s*-+>\s/.test(line));
		if (marker < 0) {
			kept.push(frame);
			return;
		}
		if (BRIDGE_HOP.test(lines[marker])) return;
		// Line 0 is `File <path>:<n>, in <fn>(...)` or `Cell In[n], line n` — the
		// only context that says WHERE. Everything between it and the marker is
		// source the model either wrote itself one cell ago or cannot edit.
		kept.push(marker === 0 ? frame : [lines[0], ...lines.slice(marker)].join("\n"));
	});
	// A traceback trimmed to nothing but its own punctuation is worse than a long
	// one: if EVERY middle frame matched, the raise happened somewhere this
	// function does not model, so show what the kernel actually sent.
	return kept.length >= 4 ? kept.join("\n") : frames.join("\n");
}

/**
 * Refuse a cell that reaches outside the job's own working directory.
 *
 * Measured provenance (H1 probe, job `6p8nIAVw`): **62 of 75 cells hunted the
 * harness itself** for a tool named in the job brief — `grep -r start_media_job`
 * over `~/src/harness`, reading daemon sockets and session state, and recovering
 * its own system prompt out of a daemon state JSON — while the complete tool index
 * AND an explicit "do not search the filesystem" rule sat in its system prompt the
 * entire run. In-context guidance has hit its ceiling on this failure mode.
 *
 * So the correction moves to the channel this project has repeatedly measured to
 * work: the ERROR of the cell that made the mistake. Runs that hit a guard adopted
 * the primitive on the very next cell, where the same sentence in a prompt did not
 * (CLAUDE.md, "put the correction in the error, not in the prompt").
 *
 * OFF unless HARNESS_FS_GUARD=1, and off is byte-faithful — an unflagged build
 * executes exactly the cells it always did. Same contract as
 * HARNESS_TRACEBACK_TRIM, and for the same reason: a condition selected by
 * REBUILDING dist leaked the trim into two eval jobs that had not asked for it, so
 * conditions live in the run's environment where the recipe can record them.
 *
 * Deliberately blunt. This is an experiment arm: a false positive costs one
 * redirected cell (and the redirect is the intervention), while a false negative
 * is just the behaviour we already have. What it therefore does NOT do is parse
 * Python or shell — it scans the cell's source text for absolute paths, `~`, and
 * `$HOME`, and for a whole-machine search with no path at all (`find / -name …`).
 *
 * What is allowed, i.e. what the job legitimately touches:
 *   - anything at or under the cell's cwd (the round directory), which is where
 *     `api/` lives — so `open('api/INDEX.md')` and every relative path pass,
 *   - TMPDIR and /tmp, for scratch files,
 *   - anything that is not a filesystem path: URLs, division, regexes, and bare
 *     strings that merely start with a slash are left alone by construction,
 *     because a candidate must look like a rooted path AND fall outside the roots.
 *
 * The parent of cwd is NOT allowed, on purpose: the session directory one level up
 * holds `system-prompt.txt` and the live `stream.jsonl`, and reading its own
 * transcript back into context is P7 in the failure ledger.
 */

/**
 * Absolute-path-shaped tokens: `/x`, `~/x`, `~user/x`, `$HOME/x`.
 *
 * The home-relative alternatives are DELIMITED (`~` must be followed by `/`, by a
 * username, or by nothing) because tilde expansion bypasses the SYSTEM_ROOTS
 * bound below by construction: `~<anything>` resolves under `$HOME`, whose first
 * segment is always `Users`/`home`, so a bare `~[A-Za-z0-9...]*` can never be
 * dismissed as "probably a URL or a regex" the way a `/`-rooted token can.
 *
 * Measured cost of not delimiting it: a creative prompt containing the markdown
 * cell `| Product Staging | Athletic-build subjects, arms bent ~45° for outerwear |`
 * was read as the path `~45`, expanded to `/Users/<me>45`, and the WHOLE CELL was
 * refused with "outside this job's working directory" — a refusal that looks like
 * the agent overstepped and is actually the guard misreading prose. `~3`, `~1.5`,
 * `~50`, `~60` and `~9` all appeared the same way in one 40-round arm. A tilde is
 * only ever a path when it is `~` alone, `~/…`, or `~username…`; a `~` followed by
 * a digit or a dot is an approximation sign, which is how models write prose.
 */
const ROOTED_PATH = /(?:^|[\s'"`(=:,\[{|&;])((?:\$HOME(?=[\/\s'"`,;)\]}|]|$)|~(?=[\/\s'"`,;)\]}|]|$)|~[A-Za-z_][A-Za-z0-9_.-]*(?=[\/\s'"`,;)\]}|]|$)|\/)[A-Za-z0-9_.\-/~$]*)/g;

/** A whole-machine search that names no path: `find / -name x`, `grep -r x ~`. */
const BARE_ROOT_SEARCH = /\b(?:find|grep|rg|fd|ls|cat|du|tree)\b[^\n]*?\s(\/|~)(?:\s|$)/m;

/** First path segments that mean "the machine", not "this job". */
const SYSTEM_ROOTS = new Set([
	"Users",
	"home",
	"root",
	"etc",
	"usr",
	"opt",
	"var",
	"private",
	"proc",
	"sys",
	"dev",
	"Library",
	"Applications",
	"System",
	"Volumes",
	"srv",
	"mnt",
	"media",
	"snap",
	"bin",
	"sbin",
	"lib",
	"lib64",
	"boot",
]);

function fsGuardRoots(cwd: string): string[] {
	// TMPDIR itself, not its parent. An earlier version allowed all of
	// `/var/folders` — macOS's TMPDIR lives there — and that swallowed the SESSION
	// directory whenever the round directory sat under a temp root, i.e. the guard
	// silently permitted the one read (its own system prompt) it most needs to
	// refuse. The allowance is now exactly the temp roots and nothing above them.
	const roots = [cwd, process.env.TMPDIR ?? "", "/tmp", "/private/tmp", "/var/tmp"];
	return roots.filter(Boolean).map((root) => (root.endsWith("/") ? root.slice(0, -1) : root));
}

/** True when `path` is at or under one of the allowed roots. */
function fsGuardAllows(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * The first out-of-bounds path a cell names, or null.
 *
 * Exported for the tests, which drive it directly rather than booting a kernel:
 * the refusal text IS the intervention, so it is pinned verbatim.
 */
export function fsGuardOffence(code: string, cwd: string): string | null {
	// A guard that throws turns one refusable cell into a dead tool call. Found by
	// driving the compiled tool directly with a malformed argument, which is a
	// thing no unit test of this function would have produced: never trust the
	// caller's shape in the one code path that runs before everything else.
	if (typeof code !== "string" || !code) return null;
	const roots = fsGuardRoots(typeof cwd === "string" ? cwd : "");
	const home = process.env.HOME ?? "";
	for (const match of code.matchAll(ROOTED_PATH)) {
		const raw = match[1];
		if (!raw || raw === "/" || raw === "~") continue;
		// `~` and `$HOME` are the spelling the measured failure actually used
		// (`grep -r … ~/src/harness`), so they are resolved rather than skipped.
		const path = raw.startsWith("~") ? home + raw.slice(1) : raw.startsWith("$HOME") ? home + raw.slice(5) : raw;
		if (!path.startsWith("/")) continue;
		if (fsGuardAllows(path, roots)) continue;
		// A rooted token whose first segment is not a real system root is far more
		// likely to be a URL path, a regex, or an MCP route than a file — this is
		// where the bluntness is bounded rather than in the caller.
		const first = path.split("/")[1] ?? "";
		if (!SYSTEM_ROOTS.has(first)) continue;
		return raw;
	}
	const bare = BARE_ROOT_SEARCH.exec(code);
	return bare ? bare[1] : null;
}

/**
 * The refusal, as the cell's own error result — three lines, no traceback.
 *
 * Short on purpose. The failing run had the whole tool index in context and still
 * hunted; a long explanation is more of the thing that did not work. Line one is
 * the fact (this path, refused), lines two and three are where to go instead.
 */
export function fsGuardRefusal(path: string): string {
	// The refusal is the one channel the model reliably learns from (measured:
	// next-cell adoption, every time), so it must name the WHOLE local surface.
	// The previous text named only api/ — and a live H20 trace (n7Lw6uhp cell 3→4)
	// showed a job absorb that as "skills/ is not part of the job" and walk past
	// the playbooks directory it had just listed.
	const skillsLine = process.env.HARNESS_SKILLS_ROOT ? " Playbooks are files under ./skills." : "";
	return (
		`Refused: ${path} is outside this job's working directory, and nothing was executed.\n` +
		`This machine is not part of the job. Your tools are Python packages under ./api — the index is in your system prompt.${skillsLine}\n` +
		"A tool named in the brief that is not under api/ belongs to a different agent; deliver the outcome with the tools you have."
	);
}

/**
 * H55: the one-time read-batching gate.
 *
 * Measured, on the 40-round control arm, from the per-message `usage` records:
 * cost is 66.6% cacheRead and `observed cacheRead / (n_messages x ctx_final / 2)`
 * = 1.09, i.e. essentially exactly QUADRATIC in message count -- a prefix is
 * re-read once per message. So a removed message is worth more than a removed
 * token, and the biggest removable block is sequential reading: 29% of cells are
 * read-only (median 10 of 33), in 66 runs of two or more consecutive read-only
 * cells, the longest 15 long. Collapsing each run to one cell removes 232 of 1242
 * cells, median 33 messages -> 24, which is a 0.63x cost multiplier: 37% cheaper.
 * That is an upper bound on perfect batching, and it is still the largest single
 * lever found for the 2.62x gap.
 *
 * The prompt already says it, twice -- "read the skills and query the tool schemas
 * you need once, up front and in parallel" and "a cell is a program, not a single
 * call: independent steps belong in ONE cell". Both were in context for every one
 * of those 66 streaks, which is L2 at its ceiling for the third time, so the
 * correction goes in the error channel where it has been adopted on the very next
 * cell every time it has fired.
 *
 * WHY THE THIRD CELL AND NOT THE SECOND. Two reads in a row are frequently
 * DEPENDENT and correct: the agent cannot know the path in `skills/<name>/SKILL.md`
 * until it has read the index that names it, and refusing that would be refusing
 * the only order the job permits. A third consecutive read-only cell is where the
 * pattern stops being "follow the reference I just learned" and starts being "one
 * file per turn". 46 of the 66 streaks reach three, so firing here still catches
 * most of them.
 *
 * The refusal names the plain-Python way to do it and invents no API, because a
 * bespoke accessor appears in zero pretraining tokens and the filesystem is
 * already the interface. Bounded like its siblings: fires ONCE, then disarms for
 * the session, so the worst case is one spent cell and the best case is six.
 * OFF unless HARNESS_READ_BATCH_GUARD=1; off is byte-faithful.
 */
const READ_ONLY_CELL =
	/open\s*\(|\.read\s*\(\s*\)|__doc__|\bhelp\s*\(|os\.listdir|glob\.glob|read_text\s*\(/;
/** Anything that acts. A cell that reads AND acts is never a pure read. */
const CELL_ACTS = /\bawait\s|\bapi\.\w+\.\w+\s*\(/;
let readBatchGateFired = false;
let consecutiveReadOnly = 0;

/** Exported for the tests, which drive the streak directly rather than a kernel. */
export function readBatchGateReset(): void {
	readBatchGateFired = false;
	consecutiveReadOnly = 0;
}

export function readBatchGateCheck(code: string): string | null {
	if (process.env.HARNESS_READ_BATCH_GUARD !== "1") return null;
	// The streak is tracked even after the gate has fired: cheap, and it keeps the
	// counter honest if a later change wants to fire more than once.
	if (READ_ONLY_CELL.test(code) && !CELL_ACTS.test(code)) consecutiveReadOnly += 1;
	else {
		consecutiveReadOnly = 0;
		return null;
	}
	if (readBatchGateFired || consecutiveReadOnly < 3) return null;
	readBatchGateFired = true;
	return (
		"Refused, this once only, and nothing was executed: this is the third cell in a row that only reads.\n" +
		"A cell costs a full turn and a turn re-reads every turn above it, so N reads in N cells cost about N^2. " +
		"Independent reads belong in ONE cell — e.g. `for p in [a, b, c]: print(p, open(p).read())` — " +
		"and a docstring is cheaper than a whole module: `print(api.<module>.<tool>.__doc__)`.\n" +
		"Re-run this cell with the other reads you already know you need folded into it. " +
		"This gate will not fire again this session."
	);
}

/** The guard's verdict for one cell, or null when it is off or the cell is fine. */
export function fsGuardCheck(code: string, cwd: string): string | null {
	// Read per call, not captured at module load: one dist has to serve both arms
	// of an A/B, and a value frozen at import would make the condition depend on
	// when this module was first required rather than on the run's environment.
	if (process.env.HARNESS_FS_GUARD !== "1") return null;
	const offence = fsGuardOffence(code, cwd);
	return offence === null ? null : fsGuardRefusal(offence);
}

/**
 * Refuse a cell that runs a command this environment does not have.
 *
 * The hole the filesystem guard leaves, found in a live trace (job `dl3D-iS5`):
 * that guard blocks ROOTED paths, so `grep -r x /Users/…` is refused while
 * `which opsctl` walks straight past it. A bare name on PATH reaches the
 * whole host — `pip`, `env`, `ps`, `curl`, and the operator's own binaries — and
 * the job hunted exactly there once the paths stopped working.
 *
 * Same contract as the other gates: OFF unless HARNESS_EXEC_GUARD=1, byte-faithful
 * when unset, read per call, the literal "1" only. Separate flag from
 * HARNESS_FS_GUARD on purpose — two interventions that fire on the same cells are
 * two conditions, and an A/B that cannot separate them measures neither.
 *
 * Blunt by construction, like the FS guard: the first word of each pipeline
 * segment, plus the first argument of a `subprocess`/`os.system` call. It does not
 * parse shell grammar, and a false positive costs one redirected cell.
 *
 * The allowlist is measured — the commands legitimate cells across all traces
 * actually used — not imagined. Everything else is refused BY NAME, which is the
 * whole point: the model learns the environment is closed, rather than learning
 * that one more binary was missing.
 *
 * Interim, and worth saying so: the real fix is a containerized kernel with only
 * the job directory mounted, which subsumes both guards. This is what can be
 * bought this window.
 */

/** Commands legitimate cells actually ran, across every trace read so far. */
const EXEC_ALLOWED = new Set([
	"cat",
	"ls",
	"head",
	"tail",
	"wc",
	"grep",
	"sed",
	"awk",
	"echo",
	"mkdir",
	"cp",
	"mv",
	"rm",
	"python3",
	"ffmpeg",
	"ffprobe",
]);

/**
 * Shell syntax that is not a binary on PATH, and therefore not what this guard is
 * about.
 *
 * NOT in the ordered allowlist, and added deliberately: `cd out && cat x` is one
 * legitimate cell, and refusing it on `cd` would teach that the shell itself is
 * unavailable — a false positive with no security value, since none of these
 * reaches the host beyond what the words after them already do. They are checked
 * for keyword-hood, not permitted as commands: whatever follows `&&` is still
 * judged on its own.
 */
const SHELL_SYNTAX = new Set([
	"cd",
	"export",
	"set",
	"unset",
	"local",
	"source",
	".",
	":",
	"true",
	"false",
	"test",
	"[",
	"[[",
	"printf",
	"read",
	"exit",
	"return",
	"shift",
	"break",
	"continue",
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"in",
	"function",
	"time",
	"exec",
	"eval",
	"wait",
]);

/** `FOO=1 BAR=2 cmd` — environment assignments precede the command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A `subprocess.*` / `os.system` / `os.popen` call's first string argument. */
const PYTHON_EXEC = /(?:subprocess\.(?:run|call|check_call|check_output|Popen)|os\.(?:system|popen|execvp?))\s*\(\s*(?:\[\s*)?(['"])([^'"]+)\1/g;

/** The command word of a shell fragment, or null when there is nothing to judge. */
function execCommandOf(fragment: string): string | null {
	for (const raw of fragment.trim().split(/\s+/)) {
		const word = raw.replace(/^[('"`]+/, "");
		if (!word || ENV_ASSIGNMENT.test(word)) continue; // FOO=1 cmd
		if (word.startsWith("-") || word.startsWith("<") || word.startsWith(">")) continue;
		// A rooted path is the filesystem guard's business, not this one — and
		// judging it here would refuse `/usr/bin/env` twice with two messages.
		if (word.startsWith("/") || word.startsWith("~") || word.startsWith(".")) return null;
		const command = word.split("/")[0];
		return SHELL_SYNTAX.has(command) ? null : command;
	}
	return null;
}

/** The first command a cell runs that this environment does not have, or null. */
export function execGuardOffence(code: string): string | null {
	if (typeof code !== "string" || !code) return null;
	const lines = code.split("\n");
	const isBash = /^\s*%%bash\b/.test(lines[0] ?? "");
	if (isBash) {
		for (const line of lines.slice(1)) {
			const stripped = line.replace(/#.*$/, "");
			// Pipelines and lists: every segment runs a command of its own, so each is
			// judged. `cat x | pip install -` is not made safe by starting with `cat`.
			for (const segment of stripped.split(/\||&&|\|\||;|\n/)) {
				const command = execCommandOf(segment);
				if (command && !EXEC_ALLOWED.has(command)) return command;
			}
		}
	}
	// `!cmd` line magic, and Python-side execution, in any cell.
	for (const line of lines) {
		const bang = /^\s*!(\S+)/.exec(line);
		if (bang && !EXEC_ALLOWED.has(bang[1]) && !SHELL_SYNTAX.has(bang[1])) return bang[1];
	}
	for (const match of code.matchAll(PYTHON_EXEC)) {
		const command = execCommandOf(match[2]);
		if (command && !EXEC_ALLOWED.has(command)) return command;
	}
	return null;
}

/**
 * The refusal — three lines, and the third is the FS guard's verbatim.
 *
 * Sharing that line is deliberate: a model that has seen it once should recognise
 * the same boundary being drawn, rather than reading two unrelated complaints.
 */
export function execGuardRefusal(command: string): string {
	return (
		`Refused: ${command} is not available here, and nothing was executed.\n` +
		"This environment is minimal and fully known: Python stdlib, preinstalled packages, and ./api — there are no other commands or services.\n" +
		"A tool named in the brief that is not under api/ belongs to a different agent; deliver the outcome with the tools you have."
	);
}

/** The guard's verdict for one cell, or null when it is off or the cell is fine. */
export function execGuardCheck(code: string): string | null {
	// Read per call, for the reason the other gates are: one dist serves both arms
	// of an A/B, and the condition belongs in the run's environment.
	if (process.env.HARNESS_EXEC_GUARD !== "1") return null;
	const offence = execGuardOffence(code);
	return offence === null ? null : execGuardRefusal(offence);
}

const RLM_BOOTSTRAP_BASE_CODE = `
import asyncio
import os as _prime_agent_os

_prime_agent_os.environ["NO_COLOR"] = "1"
get_ipython().colors = "nocolor"

try:
    import nest_asyncio as _prime_agent_nest_asyncio
    _prime_agent_nest_asyncio.apply()
except Exception:
    pass

try:
    import rlm as _prime_agent_rlm_module
    rlm = _prime_agent_rlm_module.rlm
except Exception as _prime_agent_rlm_error:
    _PRIME_AGENT_RLM_IMPORT_ERROR = str(_prime_agent_rlm_error)

    class _PrimeAgentMissingRlm:
        def _raise_missing(self):
            raise RuntimeError(
                "prime-agent-runtime is not installed in this IPython kernel. "
                "Remove ~/.prime/agent/kernel-venv so prime-agent can rebuild it, or set "
                "PRIME_AGENT_KERNEL_PYTHON to a kernel environment with prime-agent-runtime installed. "
                f"Import error: {_PRIME_AGENT_RLM_IMPORT_ERROR}"
            )

        async def run(self, prompt, **kwargs):
            self._raise_missing()

        async def find_models(self, query="", limit=8):
            self._raise_missing()

        async def list_subagents(self):
            self._raise_missing()

        async def delete_subagent(self, target):
            self._raise_missing()

        async def __call__(self, prompt, **kwargs):
            return await self.run(prompt, **kwargs)

    rlm = _PrimeAgentMissingRlm()
`.trim();

export function buildRlmBootstrapCode(pythonSkills: readonly PythonSkillRuntimeInfo[] = []): string {
	const importNames = [...new Set(pythonSkills.map((skill) => skill.importName))];
	if (importNames.length === 0) {
		return RLM_BOOTSTRAP_BASE_CODE;
	}

	return `
${RLM_BOOTSTRAP_BASE_CODE}

import importlib as _prime_agent_importlib
import inspect as _prime_agent_inspect
import sys as _prime_agent_sys
import types as _prime_agent_types

class _PrimeAgentCallableSkillModule(_prime_agent_types.ModuleType):
    async def __call__(self, *args, **kwargs):
        result = self.run(*args, **kwargs)
        if _prime_agent_inspect.isawaitable(result):
            return await result
        return result

class _PrimeAgentUnavailableSkill:
    def __init__(self, name, error):
        self.__name__ = name
        self._prime_agent_import_error = error
        self.__doc__ = f"Python skill {name} is unavailable: {error}"

    async def run(self, *args, **kwargs):
        raise RuntimeError(
            f"Python skill {self.__name__} is unavailable in this IPython kernel. "
            f"Import error: {self._prime_agent_import_error}"
        )

    async def __call__(self, *args, **kwargs):
        return await self.run(*args, **kwargs)

    def __repr__(self):
        return f"<unavailable Python skill {self.__name__!r}: {self._prime_agent_import_error}>"

def _prime_agent_wrap_skill_module(module):
    run = getattr(module, "run", None)
    if not callable(run):
        return module
    if isinstance(module, _PrimeAgentCallableSkillModule):
        return module
    wrapped = _PrimeAgentCallableSkillModule(module.__name__)
    wrapped.__dict__.update(module.__dict__)
    try:
        wrapped.__signature__ = _prime_agent_inspect.signature(run)
    except Exception:
        pass
    doc = getattr(run, "__doc__", None)
    if doc:
        wrapped.__doc__ = doc
    _prime_agent_sys.modules[module.__name__] = wrapped
    return wrapped

_PRIME_AGENT_SKILL_IMPORT_ERRORS = {}

for _prime_agent_skill_name in ${JSON.stringify(importNames)}:
    try:
        globals()[_prime_agent_skill_name] = _prime_agent_wrap_skill_module(
            _prime_agent_importlib.import_module(_prime_agent_skill_name)
        )
    except Exception as _prime_agent_skill_error:
        _PRIME_AGENT_SKILL_IMPORT_ERRORS[_prime_agent_skill_name] = str(_prime_agent_skill_error)
        globals()[_prime_agent_skill_name] = _PrimeAgentUnavailableSkill(
            _prime_agent_skill_name,
            str(_prime_agent_skill_error),
        )
`.trim();
}

const ipythonSchema = Type.Object({
	code: Type.String({
		description:
			"Python scratchpad code or `%%bash` shell cells to execute in the agent kernel. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
	}),
});

const BUSY_KERNEL_WAIT_CHOICE = "Wait and preserve state";
const BUSY_KERNEL_KILL_CHOICE = "Kill kernel and restart";
const BUSY_KERNEL_PROMPT = [
	"Interrupted IPython cell is still running",
	"Ctrl+C sent an interrupt, but the previous cell has not stopped yet. A new IPython command cannot start until it finishes.",
	"Waiting preserves the current kernel state. Killing restarts IPython and loses in-memory variables, imports, and running tasks.",
].join("\n");
const KERNEL_DEATH_NOTICE = [
	"<ipython_kernel_restarted>",
	"The IPython kernel process died and a fresh one was started. Every variable, import and in-memory object defined before this point is gone; recreate anything you still need. Nothing outside the process was lost: your files and this working directory are intact on disk, and background jobs kept running — `jobs.manifest()` lists them, `jobs.get('<name>')` reaches one.",
	"</ipython_kernel_restarted>",
].join("\n");
const KERNEL_RESTART_NOTICE = [
	"<ipython_kernel_reset>",
	"The IPython kernel was restarted after a previous interrupted cell kept running. Variables, imports, async tasks, and open resources from before the restart are no longer available; recreate them before using them.",
	"</ipython_kernel_reset>",
].join("\n");

function createAbortError(): Error {
	return new Error("IPython execution aborted");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		onAbort?.();
		return Promise.reject(createAbortError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", abort);
		const abort = () => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			onAbort?.();
			reject(createAbortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

function createLinkedAbortSignal(sources: readonly (AbortSignal | undefined)[]): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const cleanups: Array<() => void> = [];
	const abort = () => controller.abort();
	for (const source of sources) {
		if (!source) {
			continue;
		}
		if (source.aborted) {
			controller.abort();
			continue;
		}
		const listener = () => abort();
		source.addEventListener("abort", listener, { once: true });
		cleanups.push(() => source.removeEventListener("abort", listener));
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const cleanup of cleanups) {
				cleanup();
			}
		},
	};
}

function setWorkingMessage(ctx: ExtensionContext | undefined, message?: string): void {
	try {
		ctx?.ui.setWorkingMessage(message);
	} catch {
		// Stale UI context; cosmetic only.
	}
}

export type IpythonToolInput = Static<typeof ipythonSchema>;

export interface IpythonToolDetails {
	durationMs?: number;
	status?: "ok" | "error" | "aborted" | "starting";
	errorEname?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	/** Diffs streamed from file edits, rendered by the IPython cell. */
	diffs?: KernelDiffDisplay[];
	/** Media attachments loaded into context (e.g. by the attach-image skill). */
	attachments?: KernelAttachment[];
	/** Agent messages sent from this cell. */
	sentAgentMessages?: KernelSentAgentMessage[];
	/** True when this result came after killing and restarting a busy kernel. */
	kernelRestarted?: boolean;
	error?: {
		ename: string;
		evalue: string;
		traceback: string[];
	};
}

export interface IpythonToolOptions {
	/** Python override. Must have `ipykernel` installed. */
	python?: string;
	env?: Record<string, string>;
	/** Command prefix prepended to every %%bash cell. */
	commandPrefix?: string;
	/** Optional explicit shell path for bare %%bash cells. */
	shellPath?: string;
	sessionId?: string;
	/** Typed host request handlers for the kernel↔host bridge (rlm.run, goal.*, …). */
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly PythonSkillRuntimeInfo[];
	/** Per-session artifact dir where the kernel namespace snapshot is stored. Omit to disable snapshots. */
	snapshotDir?: string;
	/** Resolves before this kernel starts — e.g. the previous provisioner's dispose, so a
	 * /reload's old-kernel snapshot flush can't race the new kernel's restore. */
	readyGate?: Promise<unknown>;
	/** Filled with the live KernelManager after the first kernel start; cleared on construction. */
	kernelManagerRef?: { current?: KernelManager };
	/**
	 * Fires once per kernel start when a previous session's namespace was revived
	 * (some names restored or some failed), so the session can tell the model.
	 */
	onRestore?: (result: RestoreResult) => void;
	onLateSentAgentMessage?: (toolCallId: string, message: KernelSentAgentMessage) => void;
	/** Shared provisioner owning the kernel lifecycle. When provided, the remaining options are ignored. */
	provisioner?: IpythonKernelProvisioner;
}

function quoteScriptMagicArgument(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function applyShellSettingsToBashMagicCell(
	code: string,
	options: Pick<IpythonToolOptions, "commandPrefix" | "shellPath"> | undefined,
): string {
	const commandPrefix = options?.commandPrefix;
	const shellPath = options?.shellPath?.trim();
	if (!commandPrefix && !shellPath) return code;

	const bashCell = parseIpythonBashCell(code);
	if (!bashCell) return code;

	const firstLine =
		shellPath && bashCell.magicArguments.trim().length === 0
			? `${bashCell.indent}%%script ${quoteScriptMagicArgument(shellPath)}`
			: `${bashCell.indent}%%bash${bashCell.magicArguments}`;
	const nextBody = commandPrefix ? `${commandPrefix}${bashCell.body ? `\n${bashCell.body}` : ""}` : bashCell.body;
	return `${bashCell.leadingWhitespace}${firstLine}${bashCell.lineBreak || "\n"}${nextBody}`;
}

/**
 * Owns the lazy create+start+runtime-bootstrap of one session's IPython kernel.
 *
 * Concurrent ensure() calls await the same in-flight startup, a failed startup
 * clears the memo so the next call retries fresh, and progress listeners can
 * attach mid-flight (a tool call racing a background prewarm()).
 */
export class IpythonKernelProvisioner {
	private managerPromise?: Promise<KernelManager>;
	private startedManager?: KernelManager;
	private readonly startupListeners = new Set<KernelBootstrapProgressHandler>();
	private lastStartupMessage?: string;
	private _lastRestore?: RestoreResult;
	private readonly disposeController = new AbortController();

	constructor(
		private readonly cwd: string,
		private readonly options?: Omit<IpythonToolOptions, "provisioner">,
	) {
		if (options?.kernelManagerRef) {
			options.kernelManagerRef.current = undefined;
		}
	}

	/** The kernel manager, once a startup has completed successfully. */
	get manager(): KernelManager | undefined {
		return this.startedManager;
	}

	/** Result of reviving a prior session's namespace on the last kernel start, if any. */
	get lastRestore(): RestoreResult | undefined {
		return this._lastRestore;
	}

	/** Start the kernel in the background. Failures are swallowed here and surface on the next ensure(). */
	prewarm(): void {
		void this.ensure().catch(() => {});
	}

	/** Whether a kernel has finished starting and is currently running. */
	get hasRunningKernel(): boolean {
		return this.startedManager?.isRunning ?? false;
	}

	/** Live user-defined names in the kernel namespace, or null if listing failed / no kernel. */
	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		return (await m?.listNamespaceNames(signal)) ?? null;
	}

	/** Dispose the kernel owned by this provisioner, including one still starting up. */
	async dispose(): Promise<void> {
		// Drops a still-queued boot out of the semaphore and short-circuits an
		// in-flight startKernel before it spawns, so a disposed session's boot
		// doesn't waste a slot during a fan-out.
		this.disposeController.abort();
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (this.options?.kernelManagerRef) {
			this.options.kernelManagerRef.current = undefined;
		}
		if (!pending) return;
		try {
			const m = await pending;
			await m.dispose();
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	async kill(): Promise<void> {
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (this.options?.kernelManagerRef) {
			this.options.kernelManagerRef.current = undefined;
		}
		if (!pending) return;
		try {
			const m = await pending;
			await m.kill();
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	ensure(onProgress?: KernelBootstrapProgressHandler, signal?: AbortSignal): Promise<KernelManager> {
		if (signal?.aborted) {
			return Promise.reject(createAbortError());
		}
		let cleanupProgressListener: (() => void) | undefined;
		if (onProgress && !this.startedManager) {
			this.startupListeners.add(onProgress);
			cleanupProgressListener = () => {
				this.startupListeners.delete(onProgress);
				signal?.removeEventListener("abort", cleanupProgressListener!);
			};
			signal?.addEventListener("abort", cleanupProgressListener, { once: true });
			// Joining an in-flight startup: replay the current stage.
			if (this.managerPromise && this.lastStartupMessage) {
				onProgress(this.lastStartupMessage);
			}
		}
		if (!this.managerPromise) {
			const startup = this.startKernel(signal);
			this.managerPromise = startup;
			startup.then(
				(m) => {
					if (this.managerPromise === startup) {
						this.startedManager = m;
					}
					this.settleStartup();
				},
				() => {
					// Clear the memo so the next ensure() retries instead of
					// rethrowing a cached rejection forever.
					if (this.managerPromise === startup) {
						this.managerPromise = undefined;
					}
					this.settleStartup();
				},
			);
		}
		return raceWithAbort(this.managerPromise, signal).finally(() => {
			cleanupProgressListener?.();
		});
	}

	private settleStartup(): void {
		this.startupListeners.clear();
		this.lastStartupMessage = undefined;
	}

	private emitStartupProgress(message: string): void {
		this.lastStartupMessage = message;
		for (const listener of [...this.startupListeners]) {
			listener(message);
		}
	}

	private async startKernel(signal?: AbortSignal): Promise<KernelManager> {
		const startupAbort = createLinkedAbortSignal([this.disposeController.signal, signal]);
		const startupSignal = startupAbort.signal;
		// Wait for a previous provisioner (e.g. on /reload) to finish disposing — and
		// flushing its final snapshot — before we read that snapshot back, so the two
		// kernels can't race over the same on-disk file. Guarded so the common
		// no-gate path stays synchronous (callers rely on prompt startup progress).
		try {
			if (this.options?.readyGate) {
				await raceWithAbort(
					this.options.readyGate.catch(() => {}),
					startupSignal,
				);
			}
			const snapshotDir = this.options?.snapshotDir;
			// HARNESS_REMOTE_KERNEL_URL: the kernel runs in a sandbox elsewhere, behind
			// the same KernelManager surface. Its snapshot lives on the sandbox's disk,
			// keyed by session id, so a restarted loop or sandbox revives the namespace.
			const m = isRemoteKernelEnabled()
				? createRemoteKernelManager({
						localCwd: this.cwd,
						env: this.options?.env,
						sessionId: this.options?.sessionId,
						hostHandlers: this.options?.hostHandlers,
						pythonSkills: this.options?.pythonSkills,
						snapshotKey: snapshotDir ? (this.options?.sessionId ?? snapshotDir) : undefined,
					})
				: new KernelManager({
				python: this.options?.python,
				cwd: this.cwd,
				env: this.options?.env,
				sessionId: this.options?.sessionId,
				hostHandlers: this.options?.hostHandlers,
				pythonSkills: this.options?.pythonSkills,
				// Only persistent sessions (which have an artifact dir) get a revivable snapshot.
				snapshot: snapshotDir
					? { path: snapshotPathIn(snapshotDir), manifestPath: manifestPathIn(snapshotDir) }
					: undefined,
			});
			let pendingRestore: RestoreResult | undefined;
			try {
				// Emitted synchronously (before the permit await) so a listener attaching
				// mid-flight can replay the current stage.
				this.emitStartupProgress("Starting IPython kernel...");
				// Only the process spawn + port resolve contends for OS resources under a
				// fan-out, and it is bounded by start()'s own timeouts — so the permit
				// covers only start(). Restore/bootstrap run per-kernel afterwards and are
				// unbounded execute()s; holding the global permit across them could pin it
				// forever on a wedged bootstrap and starve every other session's boot.
				await withKernelBootPermit(() => {
					// Disposed while queued for the permit — don't spawn a kernel nobody wants.
					if (startupSignal.aborted) throw new Error("Kernel provisioner disposed before start");
					return m.start({
						onBootstrapProgress: (message) => this.emitStartupProgress(message),
						signal: startupSignal,
					});
				}, startupSignal);
				// Revive a prior session's namespace before the bootstrap, so the bootstrap
				// then overwrites live handles (rlm, skills) on top of anything restored.
				if (snapshotDir) {
					const snapshotExisted =
						m instanceof RemoteKernelManager ? await m.snapshotExists() : existsSync(snapshotPathIn(snapshotDir));
					this.emitStartupProgress("Restoring IPython state...");
					const restore = await raceWithAbort(m.restoreState(), startupSignal);
					if (snapshotExisted) {
						pendingRestore = restore ?? { restored: [], failed: [], path: snapshotPathIn(snapshotDir) };
					}
				}
				this.emitStartupProgress("Preparing IPython runtime...");
				const bootstrap = await m.execute(buildRlmBootstrapCode(this.options?.pythonSkills), {
					signal: startupSignal,
				});
				if (bootstrap.status !== "ok") {
					const details = [bootstrap.stderr, bootstrap.error?.traceback.join("\n")].filter(Boolean).join("\n");
					throw new Error(`Failed to initialize rlm runtime in the IPython kernel:\n${details}`);
				}
			} catch (error) {
				// Never leak the kernel's ZMQ sockets / temp dir if startup fails after spawn.
				void m.dispose();
				throw error;
			}
			// Only tell the model what was revived once the kernel is actually usable —
			// a notice claiming restored state must never outlive a failed bootstrap.
			if (pendingRestore) {
				this._lastRestore = pendingRestore;
				this.options?.onRestore?.(pendingRestore);
			}
			if (this.options?.kernelManagerRef) {
				this.options.kernelManagerRef.current = m;
			}
			return m;
		} finally {
			startupAbort.cleanup();
		}
	}
}

async function chooseBusyKernelAction(
	ctx: ExtensionContext | undefined,
	signal: AbortSignal | undefined,
): Promise<"wait" | "kill" | "cancel"> {
	if (!ctx?.hasUI) {
		return "cancel";
	}
	const choice = await ctx.ui.select(BUSY_KERNEL_PROMPT, [BUSY_KERNEL_WAIT_CHOICE, BUSY_KERNEL_KILL_CHOICE], {
		signal,
	});
	if (choice === BUSY_KERNEL_WAIT_CHOICE) {
		return "wait";
	}
	if (choice === BUSY_KERNEL_KILL_CHOICE) {
		return "kill";
	}
	return "cancel";
}

async function executeWithBusyKernelChoice(
	provisioner: IpythonKernelProvisioner,
	reportStartupProgress: KernelBootstrapProgressHandler,
	toolCallId: string,
	code: string,
	signal: AbortSignal | undefined,
	onStream: (chunk: string, name: "stdout" | "stderr") => void,
	onWorkingMessage: (message?: string) => void,
	onLateSentAgentMessage: ((toolCallId: string, message: KernelSentAgentMessage) => void) | undefined,
	ctx: ExtensionContext | undefined,
): Promise<{ result: ExecuteResult; kernelRestarted: boolean; kernelDied: boolean }> {
	let kernelRestarted = false;
	// Bounded: a kernel that dies on every boot must fail the call, not spin.
	let deadKernelRestarts = 0;
	let kernelDied = false;
	while (true) {
		const m = await provisioner.ensure(reportStartupProgress, signal);
		try {
			return {
				kernelDied,
				result: await m.execute(code, {
					signal,
					onStream,
					onLateSentAgentMessage: onLateSentAgentMessage
						? (message) => onLateSentAgentMessage(toolCallId, message)
						: undefined,
				}),
				kernelRestarted,
			};
		} catch (error) {
			// The kernel died under us. Drop the corpse the provisioner is memoising and
			// boot a fresh one, then tell the model — the same recovery the busy path
			// already performs, minus the human. See scripts/neutralize-prime.mjs.
			if (
				process.env.HARNESS_KERNEL_AUTORESTART === "1" &&
				deadKernelRestarts < 3 &&
				!signal?.aborted &&
				/Kernel has been shut down|Kernel exited/.test(String((error as { message?: string })?.message ?? ""))
			) {
				deadKernelRestarts += 1;
				onWorkingMessage("Restarting IPython kernel...");
				await provisioner.kill();
				kernelRestarted = true;
				kernelDied = true;
				continue;
			}
			if (!(error instanceof KernelBusyAfterInterruptError) || signal?.aborted) {
				throw error;
			}
			const action = await chooseBusyKernelAction(ctx, signal);
			if (action === "wait") {
				onWorkingMessage("Waiting for IPython kernel...");
				continue;
			}
			if (action === "kill") {
				onWorkingMessage("Restarting IPython kernel...");
				await provisioner.kill();
				kernelRestarted = true;
				continue;
			}
			throw error;
		}
	}
}

/** Turn kernel image attachments into `ImageContent` blocks; non-image types are dropped. */
export function imageBlocksFromAttachments(attachments: readonly KernelAttachment[] | undefined): ImageContent[] {
	if (!attachments) return [];
	return attachments
		.filter((a) => IMAGE_MIME_TYPES.has(a.mimeType))
		.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType }));
}

/**
 * Provenance for top-level bindings, and the cell transcript they refer to.
 *
 * Injected into ipython.ts by scripts/neutralize-prime.mjs. Kept as real
 * TypeScript because embedding it as an escaped string mangled every backslash.
 *
 * Each executed cell is written to `.cells/turn-N.py` under the working
 * directory, and every binding records the right-hand side that produced it plus
 * a `turn-N.py:LINE` reference. The model can therefore see not just which names
 * exist but what they hold and where they came from — and can `cat` the cell if
 * it needs the surrounding code.
 *
 * The right-hand side is more useful than a type name: `await api.reddit.hot(...)`
 * says both what the value is and that it came from a call already made, which is
 * the thing that stops it being fetched twice.
 *
 * Imports and loop/with targets are tracked so they can be excluded: `json`, `f`
 * and `target` are noise, and the listing exists to remind the model what *data*
 * it is already holding.
 */
interface Provenance {
	rhs: string;
	turn: number;
	line: number;
}

const assignedAt = new Map<string, Provenance>();
/** Names bound by import, `for` or `with` — excluded from the listing. */
const nonData = new Set<string>();
/** What has already been shown to the model, for delta mode. */
const shownNames = new Map<string, string>();
let cellTurn = 0;

function recordAssignments(code: string, cwd: string): void {
	cellTurn += 1;

	// Persist the cell so the `turn-N.py:LINE` references resolve to a real file.
	try {
		const dir = pathJoin(cwd, ".cells");
		mkdirSync(dir, { recursive: true });
		writeFileSync(pathJoin(dir, `turn-${cellTurn}.py`), code);
	} catch {
		// Transcript is a convenience; never fail a cell over it.
	}

	const lines = code.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// `import x`, `import x as y`, `from m import a, b as c`
		const imp = /^\s*(?:from\s+[\w.]+\s+)?import\s+(.+)$/.exec(line);
		if (imp) {
			for (const part of imp[1].split(",")) {
				const alias = /\s+as\s+([A-Za-z_]\w*)\s*$/.exec(part);
				const name = alias ? alias[1] : part.trim().split(".")[0].trim();
				if (name) nonData.add(name);
			}
			continue;
		}

		// Loop targets and context managers: `for x in …`, `with … as f:`
		const loop = /^\s*(?:async\s+)?for\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\s/.exec(line);
		if (loop) {
			for (const n of loop[1].split(",")) nonData.add(n.trim());
			continue;
		}
		for (const m of line.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) nonData.add(m[1]);

		// Comprehension and lambda locals leak into the listing as bare names with
		// no provenance, and they are never data the model needs reminding of.
		for (const m of line.matchAll(/\bfor\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\b/g)) {
			for (const n of m[1].split(",")) nonData.add(n.trim());
		}
		for (const m of line.matchAll(/\blambda\s+([^:]+):/g)) {
			for (const n of m[1].split(",")) {
				const bare = n.trim().split("=")[0].trim();
				if (/^[A-Za-z_]\w*$/.test(bare)) nonData.add(bare);
			}
		}
		// Walrus targets are intermediates, not results: `if (m := re.search(…))`.
		for (const m of line.matchAll(/([A-Za-z_]\w*)\s*:=/g)) nonData.add(m[1]);
		// Function and class definitions.
		const def = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(line);
		if (def) nonData.add(def[1]);

		// Top-level bindings only: no leading indentation, single or tuple target.
		const m = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=(?!=)/.exec(line);
		if (!m) continue;
		const rhs = line.slice(line.indexOf("=") + 1).trim().slice(0, 72) || "…";
		for (const name of m[1].split(",").map((n) => n.trim())) {
			assignedAt.set(name, { rhs, turn: cellTurn, line: i + 1 });
			nonData.delete(name);
		}
	}
}

/**
 * Render the listing, collapsing tuple unpacking.
 *
 * `a, b, c = await gather(...)` binds three names from one expression; repeating
 * that expression once per name was accurate and unreadable. Names sharing a
 * provenance are grouped onto a single line.
 */
function describeNamespace(names: string[]): string[] {
	const groups = new Map<string, { names: string[]; p: Provenance | undefined }>();
	for (const n of names) {
		if (nonData.has(n)) continue;
		const p = assignedAt.get(n);
		const key = p ? `${p.turn}:${p.line}:${p.rhs}` : `bare:${n}`;
		if (!groups.has(key)) groups.set(key, { names: [], p });
		groups.get(key)!.names.push(n);
	}
	return [...groups.values()].map(({ names: ns, p }) =>
		p ? `${ns.join(", ")}  # = ${p.rhs}, turn-${p.turn}.py:${p.line}` : ns.join(", "),
	);
}

export function createIpythonToolDefinition(
	cwd: string,
	options?: IpythonToolOptions,
): ToolDefinition<typeof ipythonSchema, IpythonToolDetails> {
	const provisioner = options?.provisioner ?? new IpythonKernelProvisioner(cwd, options);

	return {
		name: "ipython",
		label: "ipython",
		description:
			"Execute Python scratchpad code and `%%bash` shell cells in a persistent IPython kernel. Variables, imports, and loaded data persist across calls, and are revived on a best-effort basis when a session is resumed (objects that cannot be serialized are dropped and reported). Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
		promptSnippet: "ipython - persistent agent notebook for Python scratchpad code and %%bash orchestration",
		// The kernel is single-threaded — pi must not run two ipython calls in parallel within a batch.
		executionMode: "sequential",
		parameters: ipythonSchema,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			let hasWorkingMessage = false;
			const setToolWorkingMessage = (message?: string) => {
				setWorkingMessage(ctx, message);
				hasWorkingMessage = message !== undefined;
			};
			const reportStartupProgress: KernelBootstrapProgressHandler = (message) => {
				setToolWorkingMessage(message);
				onUpdate?.({
					content: [{ type: "text", text: message }],
					details: { status: "starting" },
				});
			};

			// Bound each cell so one hang cannot consume the run. Abort drives the
			// kernel's own interrupt, so variables and imports survive.
			const cellTimeoutMs = Number(process.env.HARNESS_CELL_TIMEOUT_MS ?? 0);
			const cellAbort = new AbortController();
			let cellTimedOut = false;
			const forwardAbort = () => cellAbort.abort();
			signal?.addEventListener("abort", forwardAbort, { once: true });
			const cellTimer =
				cellTimeoutMs > 0
					? setTimeout(() => {
							cellTimedOut = true;
							cellAbort.abort();
						}, cellTimeoutMs)
					: undefined;
			try {
				const code = applyShellSettingsToBashMagicCell(params.code, options);
				// Before the kernel sees it: the refusal has to arrive as this cell's own
				// error, since that is the channel the correction is delivered on.
				const fsRefusal = fsGuardCheck(code, remoteKernelCwd() ?? cwd) ?? execGuardCheck(code) ?? readBatchGateCheck(code);
				if (fsRefusal) {
					clearTimeout(cellTimer);
					return {
						content: [{ type: "text", text: fsRefusal }],
						details: { durationMs: 0, status: "error", errorEname: "FilesystemGuard", stdout: "", stderr: fsRefusal },
						isError: true,
					};
				}
				const { result: r, kernelRestarted, kernelDied } = await executeWithBusyKernelChoice(
					provisioner,
					reportStartupProgress,
					toolCallId,
					code,
					cellAbort.signal,
					(chunk) => {
						onUpdate?.({
							content: [{ type: "text", text: chunk }],
							details: { status: "ok" },
						});
					},
					setToolWorkingMessage,
					options?.onLateSentAgentMessage,
					ctx,
				);

				// The cell has returned, so stop the cell clock HERE rather than in the
				// finally below. Everything after this point is host-side time — the
				// jobs.wait sleep — and letting the timer run through it marked a cell
				// that finished in milliseconds as "INTERRUPTED after 60s" whenever the
				// requested wait exceeded the cell timeout. The agent was told its work
				// had been cut off when it had completed, which is precisely the wrong
				// lesson about the primitive it had just used correctly.
				clearTimeout(cellTimer);
				const cellTimedOutWhileExecuting = cellTimedOut;

				let text = r.stdout;
				// jobs.wait(wake_after=N) — the cell has already returned, so this
				// sleep holds nothing. See runtime/jobs.py.
				// Line-anchored, and token-gated when HARNESS_WAIT_TOKEN is set: the
				// sentinel is model-reachable stdout, so a bare substring match let a
				// cat of a transcript arm an hour-long sleep (2026-08-15 review). The
				// kernel inherits the token via env, so only runtime/jobs.py can emit it.
				const waitToken = process.env.HARNESS_WAIT_TOKEN;
				const waitRe = waitToken
					? new RegExp(`^__HARNESS_WAIT_SECONDS__:(\\d+):${waitToken}$`, "m")
					: /^__HARNESS_WAIT_SECONDS__:(\d+)(?::[A-Za-z0-9_-]+)?$/m;
				const waitMatch = waitRe.exec(text);
				if (waitMatch && process.env.HARNESS_WAIT_MODE === "exit") {
					// Scheduler mode (runtime/scheduler.py): the run ENDS at a wait, by
					// mechanism rather than by request. Asking the model to end its turn
					// was measured twice (demo2/demo3: 36 and 28 zero-second waits) and
					// lost to the sampling prior both times — the same lesson as the
					// guards: a deviation the prose requests, the mechanism must enforce.
					// The grace period lets the toolResult land in the session JSONL and
					// the protocol stream; the wake is `--resume` plus a user message, so
					// a transcript ending at this toolResult is exactly resumable. Any
					// partial next turn the model starts in the window is never recorded
					// (messages persist on message_end) and costs nothing but tokens.
					text = text.replace(
						waitMatch[0],
						`[wait armed: this process now exits; you will be re-invoked the moment the job finishes or the deadline passes]`,
					);
					setTimeout(() => {
						// Take the kernel down with us: a bare process.exit orphans the
						// ipykernel child — harmless per bench run, a per-wake process
						// leak on a long-lived host. dispose() also drops an in-flight
						// boot; the race caps a hung shutdown so the exit is never held.
						void Promise.race([
							provisioner.dispose(),
							new Promise((resolve) => setTimeout(resolve, 3000)),
						]).finally(() => process.exit(0));
					}, Number(process.env.HARNESS_WAIT_EXIT_GRACE_MS ?? 1500));
				} else if (waitMatch) {
					const secs = Math.min(Number(waitMatch[1]), Number(process.env.HARNESS_MAX_WAIT_SECONDS ?? 3600));
					setToolWorkingMessage(`waiting ${secs}s (kernel released)`);
					// Abortable: a run timeout or Ctrl-C must interrupt the wait, not
					// sit behind it — one wedged wait ate 20 minutes past its own budget.
					await new Promise((resolve) => {
						const waitTimer = setTimeout(resolve, secs * 1000);
						cellAbort.signal.addEventListener(
							"abort",
							() => {
								clearTimeout(waitTimer);
								resolve(undefined);
							},
							{ once: true },
						);
					});
					text = text.replace(waitMatch[0], `[waited ${secs}s outside the kernel]`);
				}
				if (cellTimedOutWhileExecuting) {
					text =
						`[this cell was INTERRUPTED after ${Math.round(cellTimeoutMs / 1000)}s and did not finish. ` +
						`Any output below is partial, and whatever it was computing did NOT complete. ` +
						`Variables bound before this cell are still available. Do not assume this ` +
						`worked. For work that legitimately takes this long, hand it to a job so it ` +
						`outlives the cell:\n` +
						`    jobs.submit('your command', name='pick-a-name')\n` +
						`    jobs.wait(wake_after=120)   # last line of the cell\n` +
						`then jobs.get('pick-a-name') to collect it.]\n\n${text}`;
				}
				if (r.stderr) text += (text ? "\n" : "") + r.stderr;
				if (r.result) text += (text ? "\n" : "") + r.result;
				if (r.status === "error" && r.error) {
					text += (text ? "\n" : "") + trimCellTraceback(r.error.traceback);
				}
				if (kernelRestarted) {
					const notice = kernelDied ? KERNEL_DEATH_NOTICE : KERNEL_RESTART_NOTICE;
					text = text ? `${notice}\n\n${text}` : notice;
				}

				// See scripts/neutralize-prime.mjs — opt-in kernel state visibility.
				//
				// The largest score gap is redundancy: 29% of MCP calls are byte-identical
				// repeats, because the model cannot see what it already fetched. Telling it to
				// run `%whos` costs a turn and relies on it remembering to look; appending the
				// namespace to every cell result costs a few tokens and no turn.
				//
				//   HARNESS_SHOW_NAMESPACE=1      full namespace after every cell
				//   HARNESS_SHOW_NAMESPACE=delta  only bindings that are new or changed
				//
				// Measured: full beats delta (0.702 vs 0.679) *and* uses fewer total tokens,
				// because the repetition is what keeps the model from re-fetching, and each
				// avoided call saves more context than the listing costs. Delta remains useful
				// if a namespace ever grows large enough for the listing itself to dominate.
				const nsMode = process.env.HARNESS_SHOW_NAMESPACE;
				if (nsMode === "1" || nsMode === "delta") {
					try {
						recordAssignments(code, cwd);
						const names = await provisioner.listNamespaceNames(signal);
						if (names && names.length > 0) {
							const lines = describeNamespace(names);
							if (nsMode === "delta") {
								const fresh = lines.filter((l) => !shownNames.has(l));
								for (const l of lines) shownNames.set(l, l);
								if (fresh.length > 0) {
									text += `${text ? "\n\n" : ""}[now available in the kernel:\n  ${fresh.join("\n  ")}\n]`;
								}
							} else if (lines.length > 0) {
								text += `${text ? "\n\n" : ""}[kernel — already available, do not re-fetch (cells in .cells/):\n  ${lines.join("\n  ")}\n]`;
							}
						}
					} catch {
						// Namespace listing is a convenience; never fail a cell over it.
					}
				}

				const imageBlocks = imageBlocksFromAttachments(r.attachments);
				const content: (TextContent | ImageContent)[] = [{ type: "text", text: text || "" }, ...imageBlocks];

				return {
					content,
					details: {
						durationMs: r.durationMs,
						status: r.status,
						errorEname: r.error?.ename,
						stdout: r.stdout,
						stderr: r.stderr,
						result: r.result,
						diffs: r.diffs,
						attachments: r.attachments,
						sentAgentMessages: r.sentAgentMessages,
						kernelRestarted,
						error: r.error,
					},
					isError: r.status === "error" || r.status === "aborted",
				};
			} finally {
				clearTimeout(cellTimer);
				signal?.removeEventListener("abort", forwardAbort);
				if (hasWorkingMessage) {
					setToolWorkingMessage();
				}
			}
		},
	};
}

export function createIpythonTool(cwd: string, options?: IpythonToolOptions): AgentTool<typeof ipythonSchema> {
	return wrapToolDefinition(createIpythonToolDefinition(cwd, options));
}
