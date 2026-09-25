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
