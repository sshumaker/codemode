/**
 * Tasks that cannot be completed without the jobs primitives.
 *
 * Each one is graded on *behaviour*, not just on the final answer, because the
 * failure this eval exists to catch is an agent that produces the right answer the
 * wrong way — by blocking a cell for two minutes, or by spawning a thread that
 * happens to survive long enough. Both look like success in the transcript.
 *
 * Work is simulated with `sleep` and marker files so the eval is hermetic: no
 * network, no services, and a run costs seconds rather than minutes.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A check that a file exists and (optionally) contains text. */
const fileHas = (runDir, rel, needle) => {
	const p = join(runDir, rel);
	if (!existsSync(p)) return false;
	return needle ? readFileSync(p, "utf8").includes(needle) : true;
};

export const TASKS = {
	/**
	 * The base case. Work that outruns the cell timeout, so doing it inline is not
	 * merely inelegant — it cannot succeed.
	 */
	background: {
		prompt:
			"Run the command `sleep 75 && echo BUILD-OK > build.out` to completion, then " +
			"tell me the exact contents of build.out. The command takes longer than a " +
			"single cell is allowed to run.",
		check: ({ summary, runDir }) => [
			{ name: "used jobs.submit", ok: summary.used.submit },
			{ name: "waited outside the kernel", ok: summary.used.wait },
			{ name: "collected the result", ok: summary.used.get },
			{
				name: "did not block a cell with sleep",
				ok: !summary.used.sleep,
				detail: summary.used.shellSleep ? "blocked a cell with shell `sleep`" : summary.used.sleep ? "a cell called sleep()" : "",
			},
			{ name: "did not spawn a thread", ok: !summary.used.thread },
			{
				name: "build.out written",
				ok: fileHas(runDir, "build.out", "BUILD-OK"),
			},
			{
				name: "reported the contents",
				ok: /BUILD-OK/.test(summary.finalText ?? ""),
				detail: summary.finalText ? "" : "no final text",
			},
		],
	},

	/**
	 * A readiness condition. Tests `expect="once"` and, more importantly, whether the
	 * agent reaches for the exit-status shape rather than a `tail -f | grep` pipeline
	 * that can silently never fire.
	 */
	condition: {
		prompt:
			"Another process will create the file `ready.flag` in this directory about 40 " +
			"seconds from now — start it with `(sleep 40; touch ready.flag) &` in a job. " +
			"Wait until ready.flag exists, then create `done.txt` containing the word READY. " +
			"Do not poll by sleeping inside a cell.",
		check: ({ summary, runDir }) => [
			{ name: "used jobs.submit", ok: summary.used.submit },
			{ name: "waited outside the kernel", ok: summary.used.wait },
			{
				name: "did not block a cell with sleep",
				ok: !summary.used.sleep,
				detail: summary.used.shellSleep ? "blocked a cell with shell `sleep`" : summary.used.sleep ? "a cell called sleep()" : "",
			},
			{ name: "ready.flag appeared", ok: fileHas(runDir, "ready.flag") },
			{ name: "done.txt written", ok: fileHas(runDir, "done.txt", "READY") },
		],
	},

	/**
	 * Recovery. The agent is told the kernel may restart, which is the case the whole
	 * file-backed design exists for — and the one where the obvious wrong assumption
	 * (that variables come back) is most costly.
	 */
	recover: {
		prompt:
			"Start a job named `slowcount` that runs `for i in 1 2 3 4 5 6 7 8; do echo tick-$i; sleep 8; done`. " +
			"Then use %reset -f to clear all your variables, simulating a kernel restart. " +
			"Afterwards, recover the job, wait for it to finish, and tell me the LAST line it printed.",
		check: ({ summary }) => [
			{ name: "used jobs.submit", ok: summary.used.submit },
			{ name: "recovered with jobs.get after reset", ok: summary.used.get },
			{ name: "waited outside the kernel", ok: summary.used.wait },
			{
				name: "did not block a cell with sleep",
				ok: !summary.used.sleep,
			},
			{
				name: "reported the last line",
				ok: /tick-8/.test(summary.finalText ?? ""),
				detail: summary.finalText ? `said: ${(summary.finalText ?? "").slice(0, 80)}` : "no final text",
			},
		],
	},

	/**
	 * The real failure, reproduced. This is the shape that motivated the whole design.
	 *
	 * Taken from `pm-schedule-meeting-2`, where the agent wrote this 24 times:
	 *
	 *     def hist2(rid): ...fetch chat history...
	 *     time.sleep(10)
	 *     for rid,u in [...]: print(u, hist2(rid))
	 *
	 * 302 sleeps and 48 threads in one run. The situation is "a colleague will reply
	 * to my message, and I do not know when" — 78% of observed waits are message-reply.
	 * Reproduced here with a file-backed inbox so it is hermetic and fast; the shape
	 * the agent faces is identical, which is the part under test.
	 *
	 * The prompt deliberately does NOT say "do not sleep". An earlier version did, and
	 * that made the whole eval circular: the no-prompt arm passed because the *task*
	 * carried the guidance, so it measured instruction-following rather than whether
	 * the runtime teaches. The real TAC tasks said nothing of the kind — the agent
	 * reached for time.sleep on its own, which is the behaviour under test.
	 */
	reply: {
		prompt:
			"Ask a colleague a question and wait for their answer. To ask: run " +
			"`bash ask.sh <your question>` — it appends their reply to `inbox.txt` about " +
			"25 seconds later. Read the reply and tell me the exact answer they gave.",
		setup: (runDir) => {
			// The "colleague": replies after a delay, exactly like a chat partner.
			writeFileSync(
				join(runDir, "ask.sh"),
				"#!/bin/bash\n( sleep 25; echo \"colleague: the answer is PURPLE-7\" >> inbox.txt ) &\necho sent\n",
				{ mode: 0o755 },
			);
		},
		check: ({ summary, runDir }) => [
			{ name: "used jobs to wait", ok: summary.used.wait },
			{
				name: "did not poll by sleeping in a cell",
				ok: !summary.used.sleep,
				detail: summary.used.shellSleep ? "blocked a cell with shell `sleep`" : summary.used.sleep ? "a cell called sleep()" : "",
			},
			{ name: "did not spawn a thread", ok: !summary.used.thread },
			{ name: "got the reply", ok: fileHas(runDir, "inbox.txt", "PURPLE-7") },
			{
				name: "reported the answer",
				ok: /PURPLE-7/.test(summary.finalText ?? ""),
				detail: (summary.finalText ?? "").slice(0, 70),
			},
		],
	},

	/**
	 * The fan-out variant, and the one that produced the threads.
	 *
	 * `pm-schedule-meeting-2` spawned 48 `threading.Thread` pollers — one per
	 * colleague per retry — racing on a shared dict, none of them ever stopped. The
	 * situation is "ask three people, wait for all three", which is where a Python
	 * programmer reaches for threads by reflex. That reflex is the thing under test.
	 */
	broadcast: {
		prompt:
			"Ask three colleagues (alice, bob, carol) for their code word. To ask one, run " +
			"`bash ask.sh <name>` — that colleague appends their answer to `inbox.txt` after " +
			"a delay of between 10 and 30 seconds. Collect all three code words and report them.",
		setup: (runDir) => {
			writeFileSync(
				join(runDir, "ask.sh"),
				"#!/bin/bash\n" +
					"case $1 in\n" +
					"  alice) d=10; w=ALPHA-1;;\n" +
					"  bob)   d=20; w=BRAVO-2;;\n" +
					"  carol) d=30; w=CHARLIE-3;;\n" +
					"  *) echo 'unknown colleague' >&2; exit 1;;\n" +
					"esac\n" +
					"( sleep $d; echo \"$1: $w\" >> inbox.txt ) &\necho \"asked $1\"\n",
				{ mode: 0o755 },
			);
		},
		check: ({ summary, runDir }) => [
			{ name: "used jobs to wait", ok: summary.used.wait },
			{
				name: "did not poll by sleeping in a cell",
				ok: !summary.used.sleep,
				detail: summary.used.shellSleep ? "blocked a cell with shell `sleep`" : "",
			},
			{ name: "did not spawn a thread", ok: !summary.used.thread },
			{ name: "all three replied", ok: ["ALPHA-1", "BRAVO-2", "CHARLIE-3"].every((w) => fileHas(runDir, "inbox.txt", w)) },
			{
				name: "reported all three code words",
				ok: ["ALPHA-1", "BRAVO-2", "CHARLIE-3"].every((w) => (summary.finalText ?? "").includes(w)),
				detail: (summary.finalText ?? "").slice(0, 70),
			},
		],
	},

	/**
	 * The negative control. Short work that needs no job at all — the primitives must
	 * not be so loudly advertised that the agent reaches for them when a plain cell
	 * is correct. An API that gets used when it should not is its own failure.
	 */
	control: {
		prompt: "Write the numbers 1 to 5, one per line, into a file called count.txt. Then tell me you are done.",
		check: ({ summary, runDir }) => [
			{
				name: "did NOT use jobs for trivial work",
				ok: !summary.used.submit && !summary.used.wait,
				detail: summary.used.submit ? "reached for submit on a one-cell task" : "",
			},
			{ name: "count.txt written", ok: fileHas(runDir, "count.txt", "5") },
			{ name: "finished in few turns", ok: summary.turns <= 6, detail: `${summary.turns} turns` },
		],
	},
};
