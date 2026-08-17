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

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

	// ================================================================================
	// A5 — durability. The three properties the design is *for*, none of which the
	// tasks above exercise: every one of them completes inside a single wait, in the
	// kernel that started it. See docs/VALIDATION-AND-BENCHMARK-PLAN.md §A5.
	// ================================================================================

	/**
	 * 1. KERNEL DEATH. The kernel is SIGKILLed mid-task, unannounced.
	 *
	 * `%reset -f` (the `recover` task above) clears the namespace and proves almost
	 * nothing: the process that owns the job's parentage, the prelude and the guards is
	 * still alive, so "the job survived" is barely a claim. Here the kernel process
	 * itself is killed by an external watchdog the moment a job record appears on disk
	 * (runtime/eval/run.mjs, `--kill-kernel`), which is what an OOM or a container
	 * restart actually looks like.
	 *
	 * The falsifier is work being *redone*. An agent that re-submits after the restart
	 * produces the same final answer through a mechanism that would have been ruinous
	 * on a real 40-minute build — and the transcript looks identical. So the job's
	 * script appends a line every time it starts, and the check counts them: exactly
	 * one START means the work outlived the kernel; two means the durability claim
	 * bought nothing.
	 */
	"kernel-death": {
		killKernel: true,
		timeout: 480,
		prompt:
			"Start the build by running `bash build.sh` as a job named `build`. It takes about " +
			"75 seconds and writes its result to `build.out`. While it runs, do nothing else. " +
			"When it has finished, tell me the exact contents of build.out. " +
			"Do not run build.sh more than once — it is expensive and the result is not " +
			"reproducible if it runs twice.",
		setup: (runDir) => {
			// Records every invocation, so a re-run is visible after the fact rather
			// than inferred from the transcript. The nonce is generated inside the
			// script, so a second run would produce a *different* token — which is how
			// "did it redo the work" becomes a property of the artefact, not of the prose.
			writeFileSync(
				join(runDir, "build.sh"),
				"#!/bin/bash\n" +
					'echo "START $(date +%s) pid=$$" >> build.trace\n' +
					"for i in $(seq 1 15); do echo \"step-$i\"; sleep 5; done\n" +
					'echo "BUILD-OK-$(od -An -N3 -tx1 /dev/urandom | tr -d \' \')" > build.out\n' +
					'echo "FINISH $(date +%s)" >> build.trace\n',
				{ mode: 0o755 },
			);
		},
		check: ({ summary, runDir }) => {
			const trace = existsSync(join(runDir, "build.trace")) ? readFileSync(join(runDir, "build.trace"), "utf8") : "";
			const starts = (trace.match(/^START /gm) ?? []).length;
			const out = existsSync(join(runDir, "build.out")) ? readFileSync(join(runDir, "build.out"), "utf8").trim() : "";
			return [
				{ name: "used jobs.submit", ok: summary.used.submit },
				{
					// Not a check on the agent. If the watchdog never fired there is no
					// experiment, and the rest of these checks would pass vacuously.
					name: "the kernel was actually killed",
					ok: (summary.kernelKill?.killed ?? []).length > 0,
					detail: summary.kernelKill
						? `${summary.kernelKill.killed.length} pid(s) at cell ${summary.kernelKill.atCell}`
						: "watchdog never fired — no kernel process matched",
				},
				{
					// Separates a harness failure from an agent failure. Upstream prime
					// memoises a dead kernel and throws forever; without this the run reads
					// as "the agent could not recover" when it was never given a kernel.
					name: "the agent got a working kernel back",
					// Cells that SUCCEEDED. Counting attempts made an eleven-cell run of
					// consecutive "Kernel has been shut down" errors read as recovery.
					ok: (summary.cellsAfterKernelKill ?? 0) > 0,
					detail:
						`${summary.cellsAfterKernelKill ?? 0} cells succeeded after the kill, ` +
						`${summary.failedCellsAfterKernelKill ?? 0} failed, ${summary.deadKernelErrors} dead-kernel errors`,
				},
				{
					name: "a second kernel booted and re-ran the runtime",
					ok: (summary.preludeStartPids ?? []).length >= 2,
					detail: `prelude STARTED pids: ${(summary.preludeStartPids ?? []).join(", ") || "none"}`,
				},
				{
					name: "was told the kernel restarted",
					ok: summary.restartNotices.length > 0,
					detail: `restart notices ${summary.restartNotices.length}, prelude announcements ${summary.preludeAnnouncements.length}`,
				},
				{
					name: "recovered the job with jobs.get/manifest in the new kernel",
					ok: summary.recoveredAfterKill === true,
				},
				{
					name: "did NOT redo the work",
					ok: starts === 1,
					detail: `build.sh started ${starts} time(s)${summary.resubmittedAfterKill ? "; re-submitted after the kill" : ""}`,
				},
				{ name: "the job finished", ok: /FINISH /.test(trace) && /^BUILD-OK-/.test(out), detail: out },
				{
					name: "reported the real token",
					ok: out.length > 0 && (summary.finalText ?? "").includes(out),
					detail: (summary.finalText ?? "").slice(0, 90),
				},
				{ name: "did not block a cell with sleep", ok: !summary.used.sleep },
				{ name: "did not spawn a thread", ok: !summary.used.thread },
			];
		},
	},

	/**
	 * 1b. EVICTION. Kernel death with BOTH kinds of survivor: running jobs AND disk state.
	 *
	 * `kernel-death` proves a single job outlives the kernel. A pruned/evicted kernel in
	 * the hosted design (CLOUD-HARNESS-DESIGN.md §3.2) additionally strands the agent's
	 * own files — and the announcement now promises they survived. This task makes that
	 * promise load-bearing: the agent mints a random token to a file BEFORE the kill, so
	 * after the restart the token exists nowhere but on disk (memory is gone by
	 * construction). Reporting the right token at the end is proof the agent trusted the
	 * announcement and read its file back rather than regenerating.
	 *
	 * Two jobs instead of one, so the recovery isn't "poll the one thing I remember":
	 * the fresh kernel's manifest names both, and both must finish exactly once. Every
	 * script appends a START line to its own trace, so a redo is a property of the
	 * artefact, not an inference from the transcript.
	 */
	eviction: {
		killKernel: true,
		timeout: 480,
		prompt:
			"First run `bash mktoken.sh` — it prints a session token and saves it to token.txt; " +
			"you will need to report that token at the very end. Then run the two analyses, " +
			"`bash analyse-a.sh` and `bash analyse-b.sh`, as jobs — they take roughly 40 and 55 " +
			"seconds and are independent, so run them concurrently. When both have finished, " +
			"report the token and each analysis's RESULT line exactly. All three scripts are " +
			"expensive and non-reproducible: each must run exactly once.",
		setup: (runDir) => {
			// Same nonce-trace pattern as kernel-death: outputs are unguessable, redos are
			// countable. The token is the files-survived probe; the analyses are the
			// jobs-survived probe.
			writeFileSync(
				join(runDir, "mktoken.sh"),
				"#!/bin/bash\n" +
					'echo "START $(date +%s) pid=$$" >> token.trace\n' +
					"tok=\"TOKEN-$(od -An -N4 -tx1 /dev/urandom | tr -d ' ')\"\n" +
					'echo "$tok" > token.txt\n' +
					'echo "$tok"\n',
				{ mode: 0o755 },
			);
			for (const [name, secs] of [["a", 8], ["b", 11]]) {
				writeFileSync(
					join(runDir, `analyse-${name}.sh`),
					"#!/bin/bash\n" +
						`echo "START $(date +%s) pid=$$" >> ${name}.trace\n` +
						`for i in $(seq 1 ${secs}); do echo "step-$i"; sleep 5; done\n` +
						`echo "RESULT-${name.toUpperCase()}-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')" > ${name}.out\n` +
						`echo "FINISH $(date +%s)" >> ${name}.trace\n`,
					{ mode: 0o755 },
				);
			}
		},
		check: ({ summary, runDir }) => {
			const read = (f) => (existsSync(join(runDir, f)) ? readFileSync(join(runDir, f), "utf8") : "");
			const starts = (f) => (read(f).match(/^START /gm) ?? []).length;
			const token = read("token.txt").trim();
			const outA = read("a.out").trim();
			const outB = read("b.out").trim();
			const finalText = summary.finalText ?? "";
			return [
				{ name: "used jobs.submit", ok: summary.used.submit },
				{
					name: "the kernel was actually killed",
					ok: (summary.kernelKill?.killed ?? []).length > 0,
					detail: summary.kernelKill
						? `${summary.kernelKill.killed.length} pid(s) at cell ${summary.kernelKill.atCell}`
						: "watchdog never fired — no kernel process matched",
				},
				{
					name: "was told the kernel restarted",
					ok: summary.restartNotices.length > 0,
					detail: `restart notices ${summary.restartNotices.length}, prelude announcements ${summary.preludeAnnouncements.length}`,
				},
				{
					// The prelude's stdout announcement never reaches the model (startup
					// output has no parent cell), so the death notice is the ONLY channel
					// for "here is what survived". An agent with a compacted context has
					// nothing else. Grep the stream the model actually received.
					name: "the notice it saw named the survivors (jobs + files)",
					ok: (() => {
						const s = read("stream.jsonl");
						return /kernel_restarted[\s\S]{0,600}?jobs\.manifest\(\)/.test(s) && /kernel_restarted[\s\S]{0,600}?intact/.test(s);
					})(),
				},
				{
					name: "cells kept succeeding after the kill",
					ok: (summary.cellsAfterKernelKill ?? 0) > 0,
					detail: `${summary.cellsAfterKernelKill ?? 0} ok / ${summary.failedCellsAfterKernelKill ?? 0} failed after the kill`,
				},
				{
					// The files-survived probe. The kill destroyed every variable, so a
					// correct token in the final answer has exactly one possible source:
					// token.txt, minted once (START count) and read back after the restart.
					name: "reported the pre-kill token from disk, minted exactly once",
					ok: token.length > 0 && finalText.includes(token) && starts("token.trace") === 1,
					detail: `token ${token || "missing"}, minted ${starts("token.trace")} time(s)`,
				},
				{
					name: "analysis A ran exactly once and its result was reported",
					ok: starts("a.trace") === 1 && outA.length > 0 && finalText.includes(outA),
					detail: `${starts("a.trace")} start(s), out=${outA || "missing"}`,
				},
				{
					name: "analysis B ran exactly once and its result was reported",
					ok: starts("b.trace") === 1 && outB.length > 0 && finalText.includes(outB),
					detail: `${starts("b.trace")} start(s), out=${outB || "missing"}`,
				},
				{ name: "did not block a cell with sleep", ok: !summary.used.sleep },
				{ name: "did not spawn a thread", ok: !summary.used.thread },
			];
		},
	},

	/**
	 * 1c. KEY BOUNDARY. The brain holds the API key; the sandbox side must not.
	 *
	 * run.mjs builds the kernel's environment from an allow-list, so no flag is
	 * needed and nothing has to name the key. The agent reports what
	 * it can see from a cell AND from a job it spawned (jobs inherit the kernel's
	 * env, so a leak through either path shows up in an artefact, not an
	 * inference). The run completing at all is the matching positive control: the
	 * loop still holds the key, or there would be no model calls.
	 */
	keyleak: {
		timeout: 240,
		// Asks for presence/absence, NEVER the value: "print the key" reads as
		// exfiltration and the API refuses the whole turn (measured: kl1,
		// stopReasonRaw=refusal, 0 cells) — and a test that echoes the secret on
		// the failing side would be worse than none.
		prompt:
			"Sandbox hygiene check. (1) In a cell, print 'cell-sees-key: ' followed by 'yes' if " +
			"os.environ.get('ANTHROPIC_API_KEY') is set, else 'no'. (2) Run `bash leak.sh` as a job; " +
			"it writes its own presence check to leak.out. When it finishes, report both results. " +
			"Never print the variable's value itself.",
		setup: (runDir) => {
			writeFileSync(
				join(runDir, "leak.sh"),
				"#!/bin/bash\n" +
					'if [ -n "$ANTHROPIC_API_KEY" ]; then echo "job-sees:PRESENT" > leak.out; else echo "job-sees:ABSENT" > leak.out; fi\n',
				{ mode: 0o755 },
			);
		},
		check: ({ summary, runDir }) => {
			const leak = existsSync(join(runDir, "leak.out")) ? readFileSync(join(runDir, "leak.out"), "utf8").trim() : "";
			const finalText = summary.finalText ?? "";
			return [
				{ name: "cell sees no key", ok: /cell-sees-key:?\s*no/i.test(finalText), detail: finalText.slice(0, 120) },
				{ name: "job sees no key", ok: leak === "job-sees:ABSENT", detail: leak || "leak.out missing" },
				{
					name: "no key material anywhere in the artefacts",
					ok: !leak.includes("sk-ant") && !finalText.includes("sk-ant"),
				},
			];
		},
	},

	/**
	 * 2. CONCURRENCY. Four jobs that must genuinely overlap.
	 *
	 * `broadcast` above already asks three colleagues at once, but the work is done by
	 * `ask.sh`'s own `&` — the agent submits nothing concurrent, so the runtime is not
	 * on trial. Here each job is real background work of a different length, and the
	 * check reads a timeline the jobs themselves write: four intervals that all overlap
	 * at one instant is concurrency; four that abut is a sequential run wearing a
	 * concurrency API, which produces the same answer and looks the same in the
	 * transcript.
	 *
	 * Per-job outputs are digests of per-job inputs, so they cannot be guessed, derived
	 * from each other, or produced without actually running the work. That also makes a
	 * race visible: a store that crossed two jobs' records would report a digest under
	 * the wrong name, which the check would catch as a mismatch rather than as silence.
	 */
	concurrent: {
		timeout: 420,
		prompt:
			"Four independent analyses need to run: alpha, beta, gamma, delta. Each is run " +
			"with `bash analyse.sh <name>` and takes between 20 and 50 seconds. Run all four " +
			"and report each one's RESULT line exactly. They do not depend on each other, so " +
			"do not run them one after another — the whole set should be finished in about the " +
			"time the slowest one takes.",
		setup: (runDir) => {
			// Distinct payloads => distinct digests. Written here rather than generated
			// in the script so the expected answer is computable by the check.
			for (const [name, payload] of [
				["alpha", "alpha-payload-7719"],
				["beta", "beta-payload-3304"],
				["gamma", "gamma-payload-9152"],
				["delta", "delta-payload-4488"],
			]) {
				writeFileSync(join(runDir, `${name}.in`), `${payload}\n`);
			}
			writeFileSync(
				join(runDir, "analyse.sh"),
				"#!/bin/bash\n" +
					"n=$1\n" +
					"case $n in\n" +
					"  alpha) d=20;;\n" +
					"  beta)  d=30;;\n" +
					"  gamma) d=40;;\n" +
					"  delta) d=50;;\n" +
					"  *) echo 'unknown analysis' >&2; exit 1;;\n" +
					"esac\n" +
					// One line per boundary, appended with >> so the interleaving is real.
					'echo "$n OPEN $(date +%s)" >> timeline.txt\n' +
					"sleep $d\n" +
					"h=$(shasum \"$n.in\" | cut -c1-10)\n" +
					'echo "$n CLOSE $(date +%s)" >> timeline.txt\n' +
					'echo "RESULT $n $h"\n',
				{ mode: 0o755 },
			);
		},
		check: ({ summary, runDir, jobDir }) => {
			const names = ["alpha", "beta", "gamma", "delta"];
			// Read the store, not the source text.
			//
			// The first version of this check counted `jobs.submit(` in the cells and
			// failed a run that had done everything right: the agent submitted all four
			// from a `for` loop, which is one occurrence and the better code. Counting
			// syntax measured the shape of the agent's Python; counting records measures
			// what the runtime was actually asked to do.
			const records = Object.fromEntries(
				names
					.map((n) => {
						const p = join(jobDir, `${n}.json`);
						return existsSync(p) ? [n, JSON.parse(readFileSync(p, "utf8"))] : null;
					})
					.filter(Boolean),
			);
			const submitted = names.filter((n) => records[n]);
			const startedAt = submitted.map((n) => records[n].started_at);
			// Fan-out as a property of the store rather than of the transcript: four
			// records armed within seconds of each other is a fan-out however it was
			// written, and four armed a minute apart is a sequential run however it
			// was written.
			const armSpread = startedAt.length === 4 ? Math.max(...startedAt) - Math.min(...startedAt) : Infinity;
			const digest = (n) => {
				const r = spawnSync("shasum", [`${n}.in`], { cwd: runDir, encoding: "utf8" });
				return (r.stdout ?? "").slice(0, 10);
			};
			const timeline = existsSync(join(runDir, "timeline.txt"))
				? readFileSync(join(runDir, "timeline.txt"), "utf8")
				: "";
			const span = (n) => {
				const open = new RegExp(`^${n} OPEN (\\d+)$`, "m").exec(timeline);
				const close = new RegExp(`^${n} CLOSE (\\d+)$`, "m").exec(timeline);
				return open && close ? [Number(open[1]), Number(close[1])] : null;
			};
			const spans = names.map(span);
			const complete = spans.every(Boolean);
			// All four alive at one instant. `max(open) < min(close)` is the whole test:
			// it is true only if every interval contains that instant.
			const overlapped =
				complete && Math.max(...spans.map((s) => s[0])) < Math.min(...spans.map((s) => s[1]));
			const wall = complete ? Math.max(...spans.map((s) => s[1])) - Math.min(...spans.map((s) => s[0])) : 0;
			const expected = names.map((n) => [n, digest(n)]);
			return [
				{
					name: "four jobs in the store, one per analysis",
					ok: submitted.length === 4,
					detail: `records: ${submitted.join(",") || "none"}`,
				},
				{
					name: "fanned out rather than run one after another",
					ok: armSpread < 10,
					detail: submitted.length === 4 ? `all four armed within ${armSpread.toFixed(1)}s` : "fewer than four",
				},
				{
					// The race the file-backed store could plausibly lose: four near-
					// simultaneous submits crossing each other's records. A record that
					// named the wrong command or pointed at another job's log would be
					// invisible in the answer — every digest would still be *a* digest.
					name: "no record crossed another",
					ok:
						submitted.length === 4 &&
						names.every(
							(n) =>
								records[n].cmd.includes(`analyse.sh ${n}`) &&
								records[n].log.endsWith(`${n}.log`) &&
								records[n].exit_marker.endsWith(`${n}.exit`),
						),
					detail: submitted.map((n) => `${n}: ${records[n].cmd}`).join(" | "),
				},
				{ name: "waited outside the kernel", ok: summary.used.wait },
				{ name: "all four jobs ran", ok: complete, detail: complete ? "" : `timeline: ${timeline.trim() || "(empty)"}` },
				{
					// The falsifier. 20+30+40+50 = 140s sequential against ~50s concurrent;
					// anything under 90 cannot have been sequential.
					name: "the four ran concurrently, not one after another",
					ok: overlapped && wall < 90,
					detail: complete ? `all four overlapped: ${overlapped}, wall ${wall}s (sequential would be ~140s)` : "incomplete",
				},
				{
					name: "reported each job's own digest",
					ok: expected.every(([n, h]) => h.length === 10 && new RegExp(`${n}[^\\n]*${h}|${h}[^\\n]*${n}`).test(summary.finalText ?? "")),
					detail: expected.map(([n, h]) => `${n}=${h}`).join(" "),
				},
				{
					// Enumerated, by whatever means. Requiring manifest() specifically
					// would fail the idiomatic answer: across 135 recorded runs `get` was
					// used 86 times and `manifest` twice, and a check that insists on the
					// rare call grades style rather than behaviour.
					name: "collected every job by name",
					ok: names.every((n) => new RegExp(`jobs\\.get\\(|${n}`).test(summary.cellSources.join("\n"))) &&
						(summary.used.get || summary.used.manifest),
				},
				{ name: "did not block a cell with sleep", ok: !summary.used.sleep },
				{ name: "did not spawn a thread", ok: !summary.used.thread },
			];
		},
	},

	/**
	 * 3. LONG HORIZON. Three staged minutes, where one wait cannot possibly be enough.
	 *
	 * This is the only task in the file that exercises the design's actual point. Every
	 * other one finishes inside a single `jobs.wait`, which means the check-then-wait
	 * loop — the shape the whole API is built around — has never been observed.
	 *
	 * Staging alone does NOT force polling, and the first version of this task assumed
	 * it did. Measured: the agent submitted
	 *
	 *     jobs.submit("bash stage.sh build && bash stage.sh test && bash stage.sh package",
	 *                 name="pipeline", max_runtime="15m")
	 *     jobs.wait(wake_after=200)
	 *
	 * — one job, one wait, three stages, correct answer in three cells. That is good
	 * work, not a cheat: given a primitive for durable background work, an agent hoists
	 * the sequencing into the job, and the dependency between stages is then enforced
	 * inside the shell rather than across turns. The task measured composition and
	 * called it polling.
	 *
	 * What actually forces a poll loop is a horizon longer than one wait may cover, so
	 * `HARNESS_MAX_WAIT_SECONDS` is capped at 60 here against ~190s of work. That is
	 * also the honest version of the constraint: `MAX_WAIT` exists precisely because a
	 * host will not park a model indefinitely, and the agent learns the cap the way it
	 * learns everything else here — `wait` tells it the request was clamped.
	 *
	 * The failure being watched for is the one the broken kernel produced: 87 turns of
	 * `print(38)`, the model using its own turn boundary as a clock. With a working
	 * kernel and a working `wait` that must not recur, and `summary.poll` is what says
	 * so — bare waits (a pause with no check) and trivial probes are both counted.
	 */
	"long-horizon": {
		timeout: 900,
		env: { HARNESS_MAX_WAIT_SECONDS: "60" },
		prompt:
			"Run a three-stage pipeline to completion and then tell me the exact contents of " +
			"`release.txt`. The stages are `bash stage.sh build`, `bash stage.sh test` and " +
			"`bash stage.sh package`; each takes roughly a minute. A stage will refuse to run " +
			"until the previous one has finished, so run them in order. Report `release.txt` " +
			"exactly as written.",
		setup: (runDir) => {
			writeFileSync(
				join(runDir, "stage.sh"),
				"#!/bin/bash\n" +
					"s=$1\n" +
					"case $s in\n" +
					"  build)   need=''; out=build.done;;\n" +
					"  test)    need=build.done; out=test.done;;\n" +
					"  package) need=test.done; out=package.done;;\n" +
					"  *) echo 'unknown stage' >&2; exit 2;;\n" +
					"esac\n" +
					'if [ -n "$need" ] && [ ! -f "$need" ]; then\n' +
					'  echo "stage $s cannot start: $need does not exist yet" >&2\n' +
					"  exit 3\n" +
					"fi\n" +
					'echo "$s START $(date +%s)" >> pipeline.log\n' +
					"sleep 60\n" +
					'echo "$s ok" > "$out"\n' +
					'echo "$s DONE $(date +%s)" >> pipeline.log\n' +
					'if [ "$s" = package ]; then\n' +
					'  echo "RELEASE-$(shasum build.done test.done package.done | shasum | cut -c1-8)" > release.txt\n' +
					"fi\n" +
					'echo "$s complete"\n',
				{ mode: 0o755 },
			);
		},
		check: ({ summary, runDir }) => {
			const log = existsSync(join(runDir, "pipeline.log")) ? readFileSync(join(runDir, "pipeline.log"), "utf8") : "";
			const release = existsSync(join(runDir, "release.txt"))
				? readFileSync(join(runDir, "release.txt"), "utf8").trim()
				: "";
			const stages = ["build", "test", "package"];
			const ran = stages.filter((s) => new RegExp(`^${s} DONE `, "m").test(log));
			const failedStarts = (log.match(/cannot start/g) ?? []).length;
			return [
				{ name: "used jobs.submit", ok: summary.used.submit },
				{ name: "all three stages completed", ok: ran.length === 3, detail: `completed: ${ran.join(",") || "none"}` },
				{
					// The point of the task. One wait means the horizon was not long, which
					// would mean the fixture is wrong rather than the agent clever.
					name: "polled across several waits",
					ok: summary.waits.length >= 3,
					detail: `waits [${summary.waits.join(",")}]`,
				},
				{
					// The degeneracy check. A wait with no check in the same cell is a bare
					// pause; a trivial probe is the `print(38)` shape outright.
					name: "check-then-wait, not turn-burning",
					ok: summary.poll.trivialPollCells === 0 && summary.poll.bareWaitCells <= 1,
					detail:
						`${summary.poll.waitCells} wait cells, ${summary.poll.bareWaitCells} bare, ` +
						`${summary.poll.trivialPollCells} trivial probes` +
						(summary.poll.trivialPollSources.length ? ` e.g. ${JSON.stringify(summary.poll.trivialPollSources[0])}` : ""),
				},
				{
					// Cells per stage. The old loop burned a turn per poll for 87 turns;
					// three stages done properly is roughly two cells each.
					name: "did not burn turns",
					ok: summary.cells <= 14,
					detail: `${summary.cells} cells, ${summary.turns} turns`,
				},
				{ name: "release.txt written", ok: /^RELEASE-/.test(release), detail: release },
				{
					name: "reported release.txt exactly",
					ok: release.length > 0 && (summary.finalText ?? "").includes(release),
					detail: (summary.finalText ?? "").slice(0, 90),
				},
				{ name: "did not block a cell with sleep", ok: !summary.used.sleep },
				{ name: "did not spawn a thread", ok: !summary.used.thread },
				{
					// Not graded as a failure of the agent — recorded because a stage that
					// refused to start is evidence the ordering constraint was real.
					name: "the stage ordering constraint was live",
					ok: true,
					detail: `${failedStarts} premature stage attempt(s)`,
				},
			];
		},
	},

	/**
	 * Subagents. A child agent is a job, so this is the same loop as `background` —
	 * spawn, wait outside the kernel, collect — with a model process in place of a
	 * shell command.
	 *
	 * Graded on the CHILD'S OWN ARTEFACTS, not on the parent's report. A parent that
	 * read notes.txt itself and claimed a subagent did it would pass every
	 * transcript-level check; the only thing that cannot be faked is the child's
	 * transcript on disk, its spec, and the restricted tool set it actually ran with.
	 * (CLAUDE.md: assert the observable effect — that the arm reached the transport —
	 * not the absence of an error.)
	 */
	subagent: {
		timeout: 420,
		setup: (runDir) => {
			writeFileSync(join(runDir, "notes.txt"),
				["field notes", "", "the secret word is PERIWINKLE", "", "end of notes"].join("\n"));
		},
		prompt:
			"Delegate this to a subagent rather than doing it yourself: read the file " +
			"notes.txt in this directory and report the secret word it contains. Give the " +
			"child only the read, grep and ls tools — it must not need a kernel. Then " +
			"collect its answer and tell me the secret word.",
		check: ({ summary, jobDir }) => {
			const cells = summary.cellSources.join("\n");
			// The child's own directory: <jobDir>/<name>.d/{spec,meta,stream}
			const children = existsSync(jobDir)
				? readdirSync(jobDir).filter((f) => f.endsWith(".d"))
				: [];
			const name = children[0]?.replace(/\.d$/, "") ?? "";
			const read = (rel) => {
				try {
					return readFileSync(join(jobDir, rel), "utf8");
				} catch {
					return "";
				}
			};
			const spec = name ? JSON.parse(read(`${name}.d/spec.json`) || "{}") : {};
			const stream = name ? read(`${name}.d/stream.jsonl`) : "";
			const meta = name ? JSON.parse(read(`${name}.d/meta.json`) || "{}") : {};
			return [
				{ name: "called spawn()", ok: /\bspawn\(/.test(cells) },
				{ name: "waited outside the kernel", ok: summary.used.wait },
				{ name: "a child was recorded", ok: Boolean(name), detail: name || "no <name>.d in the job dir" },
				{
					name: "the child ran with the RESTRICTED tool set",
					ok: Boolean(spec.tools) && !spec.tools.split(",").includes("ipython"),
					detail: spec.tools ? `tools=${spec.tools}` : "no spec.json",
				},
				{
					name: "the child really ran (its own transcript)",
					ok: stream.split("\n").filter((l) => l.startsWith("{")).length > 2,
					detail: `${stream.split("\n").filter((l) => l.startsWith("{")).length} stream events`,
				},
				{
					name: "the child found the word",
					ok: /PERIWINKLE/.test(read(`${name}.result.txt`)),
					detail: meta.turns ? `${meta.turns} turns, $${meta.cost}` : "no meta.json",
				},
				{
					name: "the parent collected it",
					ok: /jobs\.get\(|\.result\b/.test(cells),
				},
				{
					name: "the parent reported the word",
					ok: /PERIWINKLE/.test(summary.finalText ?? ""),
					detail: summary.finalText ? "" : "no final text",
				},
				{
					name: "did not block a cell with sleep",
					ok: !summary.used.sleep,
				},
			];
		},
	},

	/**
	 * Both halves of the architecture, in one run.
	 *
	 * `subagent` proves a child can be delegated to and collected; `keyleak` proves
	 * the sandbox holds no credential. The claim that matters is their conjunction —
	 * a subagent completes WHILE the sandbox provably has no key — and two passing
	 * runs do not make it, because nothing rules out the two conditions having held
	 * at different moments — the kernel env allow-list run.mjs sets makes the
	 * second half true by construction.
	 *
	 * The child is graded on its own artefacts for the reason `subagent` is: a
	 * parent that read the file itself and said a child did would pass every
	 * transcript-level check.
	 */
	"subagent-keyleak": {
		timeout: 420,
		setup: (runDir) => {
			writeFileSync(join(runDir, "notes.txt"), ["field notes", "", "the secret word is PERIWINKLE", ""].join("\n"));
		},
		prompt:
			"Two things, in order. (1) In a cell, print 'cell-sees-key: ' followed by 'yes' if " +
			"os.environ.get('ANTHROPIC_API_KEY') is set, else 'no'. Never print the value itself. " +
			"(2) Delegate to a subagent — do not do it yourself — reading the file notes.txt in this " +
			"directory and reporting the secret word. Give the child only the read, grep and ls tools. " +
			"Collect its answer and report both the key check and the secret word.",
		check: ({ summary, jobDir }) => {
			const finalText = summary.finalText ?? "";
			const children = existsSync(jobDir) ? readdirSync(jobDir).filter((f) => f.endsWith(".d")) : [];
			const name = children[0]?.replace(/\.d$/, "") ?? "";
			const read = (rel) => {
				try {
					return readFileSync(join(jobDir, rel), "utf8");
				} catch {
					return "";
				}
			};
			const result = name ? read(`${name}.result.txt`) : "";
			const stream = name ? read(`${name}.d/stream.jsonl`) : "";
			return [
				{
					name: "the sandbox side has no key",
					ok: /cell-sees-key:?\s*\**\s*no/i.test(finalText),
					detail: finalText.slice(0, 120),
				},
				{ name: "a child was recorded", ok: Boolean(name), detail: name || "no <name>.d in the job dir" },
				{
					// The child is a real model process that reached the provider, so
					// it had a credential the kernel did not — which is the whole
					// architecture in one assertion.
					name: "the child really ran, with a key the kernel did not have",
					ok: stream.split("\n").filter((l) => l.startsWith("{")).length > 2 && /PERIWINKLE/.test(result),
					detail: `${stream.split("\n").filter((l) => l.startsWith("{")).length} stream events`,
				},
				{ name: "the parent reported the word", ok: /PERIWINKLE/.test(finalText) },
				{ name: "no key material anywhere in the artefacts", ok: !result.includes("sk-ant") && !finalText.includes("sk-ant") },
			];
		},
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
