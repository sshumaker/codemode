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
