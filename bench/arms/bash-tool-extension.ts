/**
 * codemode arm: a GUARDED `bash`, so a shell tool does not undo the kernel.
 *
 * The codemode arm's advantage on long work is that waiting happens outside the
 * kernel: `jobs.submit` detaches, `jobs.wait` ends the cell, and the agent is called
 * again later. Measured on terminal-bench's `compile-compcert`, the arm with that
 * runtime handed a 30-minute build to a job and passed; the arms that blocked on it
 * in the foreground failed.
 *
 * Adding prime's native `bash` to that arm removes the advantage silently. The
 * kernel's guards are Python-side — `_guard_shell_cells` wraps `%%bash` and `!cmd`,
 * the SIGALRM watchdog bounds a cell — and a bash TOOL passes none of them. `bash
 * make` then blocks the turn for twenty minutes with no redirect and no backstop,
 * and codemode behaves like the blocking arms while still wearing the codemode
 * label. That is the plausible-number failure this project keeps paying for.
 *
 * This restores the same two guards on the same surface:
 *
 *   pre-flight   `jobs.blocking_sleep` — a foreground `sleep` or a poll loop is
 *                refused before anything runs, with the redirect the kernel uses.
 *   ceiling      a wall-clock timeout injected into the call, because
 *                `blocking_sleep` finds no sleep in `make` and never will. Prime's
 *                own bash kills the process tree on timeout; the kill is rewritten
 *                into the same redirect, so the backstop teaches instead of
 *                truncating.
 *
 * Not a replacement tool
 * ----------------------
 * This registers NO tool. It intercepts prime's own `bash` through `tool_call` /
 * `tool_result`, for the reason CLAUDE.md gives: run the real harness, not a
 * reimplementation of it. A hand-written bash tool would have to re-do output
 * accumulation, the 30k/2000-line truncation, the temp-file spill and the process
 * tree kill, and every one of those divergences would be invisible until it cost a
 * task — which is precisely how the hand-rolled TAC kernel dropped image
 * attachments. `tool_call` can block and can mutate `event.input` in place
 * (agent-loop.ts:814), which is all a guard needs.
 *
 * One guard, not two copies
 * -------------------------
 * The verdict comes from `runtime/jobs.py --check-blocking`, i.e. from the same
 * `blocking_sleep` the kernel calls. A TypeScript port would be a second
 * implementation under one name. It costs one short subprocess per bash call.
 *
 * Fails LOUD, never open
 * ----------------------
 * At load the checker is exercised against a known-blocking and a known-safe
 * command, and the extension throws if either verdict is wrong. A guard that
 * degrades to "allow" when its checker is missing is indistinguishable from no
 * guard, and would be reported as an arm that chose to block — the deferred-tool
 * episode again ("narrowing worked and execution broke", and nothing caught it).
 *
 * Configuration, all via the environment:
 *
 *   HARNESS_JOBS_PY          path to runtime/jobs.py            (required)
 *   HARNESS_JOBS_PYTHON      interpreter for it                 (default python3)
 *   HARNESS_BASH_CEILING_SECONDS   wall-clock ceiling, 0 = off  (default 0)
 *   HARNESS_SLEEP_CEILING    foreground-sleep ceiling           (default 30)
 *   HARNESS_BASH_NO_EGRESS   1 = refuse network commands        (default off)
 *   HARNESS_BASH_LEDGER      JSONL evidence path                (optional)
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const JOBS_PY = process.env.HARNESS_JOBS_PY ?? "";
const PYTHON = process.env.HARNESS_JOBS_PYTHON ?? "python3";
const SLEEP_CEILING = process.env.HARNESS_SLEEP_CEILING ?? "30";
const CEILING = Number(process.env.HARNESS_BASH_CEILING_SECONDS ?? "0");
const NO_EGRESS = process.env.HARNESS_BASH_NO_EGRESS === "1";
const LEDGER = process.env.HARNESS_BASH_LEDGER ?? "";

interface Verdict {
	blocking: boolean;
	reason: string | null;
	message: string | null;
}

/**
 * Ask the runtime whether this command blocks.
 *
 * Throws when the CHECK fails, which the caller turns into a refusal rather than an
 * allow. "Could not tell" and "allowed" must never be the same outcome here.
 */
function checkBlocking(command: string): Verdict {
	const out = execFileSync(PYTHON, [JOBS_PY, "--check-blocking", command, "--ceiling", SLEEP_CEILING], {
		encoding: "utf8",
		// The check is a pure string function over one command; anything near this
		// bound means the interpreter itself is wedged, and hanging here would hold
		// the very turn the guard exists to protect.
		timeout: 20_000,
		// jobs.py warns on stderr about the job directory when no session is set.
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(out.trim().split("\n").pop() ?? "");
}

/**
 * Network egress, for the AppWorld arm only.
 *
 * AppWorld's world is reachable only through the env-server, and one transport is
 * what makes the two arms comparable: 78% of the vanilla arm's bash calls on
 * MCP-Bench were `curl` straight to the APIs its tools wrapped. Terminal-bench has
 * no such invariant — there the machine IS the surface — so this is off by default.
 *
 * A deny-list, and honestly so: it cannot be complete (a command can be computed at
 * run time, and `python3 -c` can open a socket in ways no pattern catches). What
 * makes it checkable rather than hopeful is the ledger — every command and its
 * verdict is recorded, so "did anything reach around the transport" is a question
 * answered from evidence after the run, not from the absence of an error.
 */
const EGRESS = [
	// Network clients, as COMMAND words. `http`/`https` are deliberately not in this
	// list even though httpie ships an `http` binary: `grep -rn http api/` is
	// ordinary work here, and a refusal that lands on it costs a turn and teaches
	// something false. The URL pattern below covers the case that matters.
	/\b(curl|wget|aria2c|httpie|nc|ncat|netcat|telnet|socat|ssh|scp|sftp|rsync|ftp|lynx|links|w3m|lwp-request)\b/,
	// An interpreter one-liner is the obvious way around a binary deny-list.
	/\b(python3?|node|ruby|perl|php)\b[^\n]*\b(requests|urllib|urlopen|http\.client|httpx|aiohttp|socket|fetch\(|net\.|Net::HTTP|LWP|file_get_contents)\b/,
	// Any literal URL, which covers a client this list has not heard of.
	/https?:\/\//,
];

function egressHit(command: string): string | null {
	for (const pattern of EGRESS) {
		const m = pattern.exec(command);
		if (m) return m[0];
	}
	return null;
}

const EGRESS_REFUSAL = (hit: string) =>
	`this command looks like network access (\`${hit}\`), and the bash tool here cannot reach the network.\n` +
	"Everything in this environment is reachable through the `api` package in the ipython tool, and that is the " +
	"only path to it — a shell cannot see it and there is nothing at any URL.\n" +
	"Use bash for the filesystem and for local commands; use ipython for the API.";

export default function (pi: ExtensionAPI) {
	if (!JOBS_PY) {
		throw new Error("HARNESS_JOBS_PY is required (path to runtime/jobs.py) — the bash guard has no checker without it");
	}

	// Prove the guard works before the model is called, on the observable effect
	// rather than on the absence of an error. `find_spec` once certified a module
	// containing a syntax error; locating jobs.py would say nothing about whether it
	// can answer.
	const selfCheck = (command: string, want: boolean) => {
		let verdict: Verdict;
		try {
			verdict = checkBlocking(command);
		} catch (error) {
			throw new Error(
				`bash guard self-check could not run \`${PYTHON} ${JOBS_PY} --check-blocking\`: ${String(error)}\n` +
					"Refusing to load: an unguarded bash tool on the codemode arm is not the arm it is labelled as.",
			);
		}
		if (verdict.blocking !== want) {
			throw new Error(
				`bash guard self-check failed: \`${command}\` returned blocking=${verdict.blocking}, expected ${want}. ` +
					"The checker is present but not answering correctly, so this run would be unguarded.",
			);
		}
	};
	selfCheck("sleep 300", true);
	selfCheck("ls -la", false);

	const record = (entry: Record<string, unknown>) => {
		if (!LEDGER) return;
		try {
			appendFileSync(LEDGER, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
		} catch {
			// Evidence is best-effort; refusing a command because a log is unwritable
			// would be the guard breaking the thing it guards.
		}
	};

	// Proof of load, written before the model is called.
	//
	// Everything else here is evidence of a REFUSAL, so an extension that never
	// loaded and one that was never given a blocking command produce the same empty
	// ledger — and the run would be reported as an arm that chose not to block. Same
	// ambiguity that cost four TAC runs to the missing prelude.
	record({ phase: "loaded", jobsPy: JOBS_PY, python: PYTHON, ceiling: CEILING, noEgress: NO_EGRESS, sleepCeiling: SLEEP_CEILING });

	// Which calls this guard capped, so the timeout rewrite fires only on ours and
	// never on a timeout the model asked for itself.
	const capped = new Map<string, { command: string; seconds: number }>();

	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: string; timeout?: number };
		const command = typeof input.command === "string" ? input.command : "";

		if (NO_EGRESS) {
			const hit = egressHit(command);
			if (hit) {
				record({ phase: "call", id: event.toolCallId, command, verdict: "blocked-egress", hit });
				return { block: true, reason: EGRESS_REFUSAL(hit) };
			}
		}

		let verdict: Verdict;
		try {
			verdict = checkBlocking(command);
		} catch (error) {
			// Refuse, never allow. The self-check passed at load, so a failure here is
			// a live problem, and letting the command through would produce an
			// unguarded call inside a guarded run — invisible in every artefact.
			record({ phase: "call", id: event.toolCallId, command, verdict: "checker-failed", error: String(error) });
			return {
				block: true,
				reason:
					"the bash guard could not check this command, so it was not run. Try it again, or do the work in " +
					"the ipython tool.",
			};
		}
		if (verdict.blocking) {
			record({ phase: "call", id: event.toolCallId, command, verdict: "blocked-blocking", reason: verdict.reason });
			return { block: true, reason: verdict.message ?? String(verdict.reason) };
		}

		// The ceiling. Mutated in place, which is prime's documented way to patch
		// arguments (`event.input` is the same object the tool receives). A timeout
		// the model set for itself is kept when it is tighter — that is the model
		// bounding its own command, which is the behaviour we want more of.
		let seconds = 0;
		if (CEILING > 0) {
			const asked = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : Number.POSITIVE_INFINITY;
			seconds = Math.min(asked, CEILING);
			input.timeout = seconds;
			// Recorded only when the guard is what lowered it. A model that set a
			// tighter timeout itself already knows what it asked for, and rewriting
			// its own kill into "the guard stopped you" would attribute a choice to a
			// mechanism that did not make it.
			if (asked > CEILING) capped.set(event.toolCallId, { command, seconds });
		}
		record({ phase: "call", id: event.toolCallId, command, verdict: "allowed", timeout: seconds || null });
		return undefined;
	});

	pi.on("tool_result", (event: ToolResultEvent) => {
		if (event.toolName !== "bash") return;
		const cap = capped.get(event.toolCallId);
		capped.delete(event.toolCallId);
		const text = (event.content ?? []).map((c) => ("text" in c ? (c.text ?? "") : "")).join("");
		record({ phase: "result", id: event.toolCallId, isError: event.isError, bytes: text.length });
		if (!event.isError || !cap) return;
		// prime's bash throws `Command timed out after N seconds` (tools/bash.ts:398),
		// with whatever output arrived first prepended. Keep that output — it is the
		// only evidence of how far the command got — and replace the bare notice with
		// the redirect, for the reason the prelude's watchdog exists: a silent kill
		// teaches nothing and the agent writes the same line again.
		if (!/Command timed out after \d+ seconds?/.test(text)) return;
		let message: string;
		try {
			message = execFileSync(PYTHON, [JOBS_PY, "--timeout-message", String(cap.seconds), cap.command], {
				encoding: "utf8",
				timeout: 20_000,
				stdio: ["ignore", "pipe", "pipe"],
			}).trimEnd();
		} catch {
			return; // leave prime's own message rather than swallow the failure
		}
		record({ phase: "timeout", id: event.toolCallId, command: cap.command, seconds: cap.seconds });
		return {
			content: [{ type: "text", text: text.replace(/Command timed out after \d+ seconds?\.?/, message) }],
			isError: true,
		};
	});
}
