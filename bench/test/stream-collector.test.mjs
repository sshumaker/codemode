/**
 * The one accumulator for prime's `--mode json` stream, and the one wait sentinel.
 *
 * Two pins, both of the same shape: a string or a semantic that FIVE files have to
 * agree on, where disagreement produces a plausible number rather than an error.
 *
 *   1. **The stream collector.** Three runners each hand-rolled the same loop, and
 *      they had drifted: TAC captured no first-turn context (so the one benchmark
 *      with no residency guard was the one whose labels nothing verified), had no
 *      budget enforcement (so `--max-cost` was a silent no-op there), and recorded
 *      error counts without error text. All three now share one implementation,
 *      and this file asserts the semantics that implementation must have — most
 *      importantly the responseId dedup, without which turns, tokens and cost are
 *      all inflated by an amount that varies with how flaky the connection was.
 *
 *   2. **`__HARNESS_WAIT_SECONDS__`.** The sentinel a cell prints to ask the host
 *      to end the turn and wake later. `runtime/jobs.py` writes it; four other
 *      files DETECT it, two of them by regex inside string literals that a rename
 *      would not touch. A rename that updated jobs.py and missed one detector
 *      would not fail to compile — the wait would simply stop being noticed, and
 *      the arm would be blamed for the silence. So the value is read from jobs.py
 *      and required to appear in every file that claims to know it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createStreamCollector, newSummary } from "../stream-collector.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** One assistant `message_end`, the event every cost number in this project comes from. */
const turn = (responseId, usage, text = "") => ({
	type: "message_end",
	message: {
		role: "assistant",
		responseId,
		content: text ? [{ type: "text", text }] : [],
		usage: { totalTokens: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, ...usage },
	},
});

/** Feed events as the stream would deliver them: newline-delimited, one chunk. */
const feed = (collector, ...events) => collector.write(`${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

describe("the JSON stream collector", () => {
	it("counts a duplicated responseId once — turns, tokens and cost alike", () => {
		// The bug this exists to prevent is silent: a retried or replayed message_end
		// inflates every headline number, by an amount correlated with nothing under
		// study. bench/tac/run-task.mjs is the runner that most needed this shared.
		const summary = newSummary();
		const collector = createStreamCollector({ summary });
		const first = turn("r1", { input: 10, output: 5, cacheRead: 1_000, cacheWrite: 2_000, cost: { total: 0.25 } }, "hello");
		feed(collector, first, first, turn("r2", { input: 7, output: 3, cost: { total: 0.1 } }, "bye"));

		assert.equal(summary.turns, 2, "a duplicated responseId was counted twice");
		assert.equal(summary.input, 17);
		assert.equal(summary.output, 8);
		assert.equal(summary.cacheRead, 1_000);
		assert.equal(summary.cacheWrite, 2_000);
		assert.equal(Number(summary.cost.toFixed(4)), 0.35);
		assert.deepEqual([...collector.counted], ["r1", "r2"]);
		assert.equal(summary.finalText, "bye", "the final text is the last assistant message's");
	});

	it("captures ctx0 from the FIRST turn only, as input + cacheRead + cacheWrite", () => {
		// This is the number every residency guard checks. Taken from a later turn it
		// would measure conversation growth rather than what residency controls, and
		// an L0 run wearing an L4 label would read as "docs-in costs nothing".
		const summary = newSummary();
		const collector = createStreamCollector({ summary });
		feed(
			collector,
			turn("r1", { input: 10, cacheRead: 1_000, cacheWrite: 2_000 }),
			turn("r2", { input: 90_000, cacheRead: 5_000, cacheWrite: 0 }),
		);
		assert.equal(summary.firstTurnPromptTokens, 3_010);
	});

	it("a duplicate of the first turn does not re-capture ctx0 or advance the count", () => {
		const summary = newSummary();
		const collector = createStreamCollector({ summary });
		const first = turn("r1", { input: 10, cacheRead: 1_000, cacheWrite: 2_000 });
		feed(collector, first, first);
		assert.equal(summary.turns, 1);
		assert.equal(summary.firstTurnPromptTokens, 3_010);
	});

	it("does not count a message with no responseId or no usage", () => {
		// Both are how a partial or errored message arrives. Counting one as a turn
		// would credit spend to a response that never completed.
		const summary = newSummary();
		const collector = createStreamCollector({ summary });
		feed(
			collector,
			turn(undefined, { cost: { total: 9 } }),
			{ type: "message_end", message: { role: "assistant", responseId: "r9", content: [] } },
			{ type: "message_end", message: { role: "user", responseId: "r8", usage: { totalTokens: 5, cost: { total: 9 } } } },
		);
		assert.equal(summary.turns, 0);
		assert.equal(summary.cost, 0);
	});

	it("calls onCounted once per newly counted turn — the budget hook, deduped too", () => {
		// Budget enforcement rides on this hook in all three runners. Firing it on a
		// duplicate would kill a run at a cost it had not actually spent.
		const summary = newSummary();
		let fired = 0;
		const collector = createStreamCollector({ summary, onCounted: () => fired++ });
		const first = turn("r1", { cost: { total: 0.5 } });
		feed(collector, first, first, turn("r2", { cost: { total: 0.5 } }));
		assert.equal(fired, 2);
	});

	it("counts tool calls and keeps the text of every error", () => {
		const summary = newSummary();
		const collector = createStreamCollector({ summary });
		feed(
			collector,
			{ type: "tool_execution_start", toolName: "ipython" },
			{ type: "tool_execution_end", isError: true, result: { content: [{ text: "boom" }, { text: "detail" }] } },
			{ type: "tool_execution_start", toolName: "bash" },
			{ type: "tool_execution_end", isError: false, result: { content: [{ text: "fine" }] } },
		);
		assert.equal(summary.toolCalls, 2);
		assert.deepEqual(summary.toolNames, ["ipython", "bash"]);
		assert.equal(summary.toolErrors, 1);
		// The text, not only the count: CLAUDE.md's rule is to persist what a check
		// saw. TAC recorded the count alone until this module was shared.
		assert.deepEqual(summary.errorMessages, ["boom detail"]);
	});

	it("hands onToolEnd every tool result, error or not", () => {
		// AppWorld scans for ArgumentError and ReadFirst, TAC for a wedged kernel, and
		// all three signals can arrive inside a cell the agent caught — i.e. with
		// isError false. A hook that only fired on errors would miss exactly the
		// corrections those variants exist to measure.
		const summary = newSummary();
		const seen = [];
		const collector = createStreamCollector({ summary, onToolEnd: (_e, text) => seen.push(text) });
		feed(
			collector,
			{ type: "tool_execution_end", isError: false, result: { content: [{ text: "ArgumentError: api.gmail.x: nope" }] } },
			{ type: "tool_execution_end", isError: true, result: { content: [{ text: "Kernel did not respond" }] } },
		);
		assert.deepEqual(seen, ["ArgumentError: api.gmail.x: nope", "Kernel did not respond"]);
	});

	it("records a provider-side refusal, which is not a result", () => {
		const summary = newSummary();
		const collector = createStreamCollector({ summary });
		const refused = turn("r1", {});
		refused.message.stopReasonRaw = "refusal";
		feed(collector, refused);
		assert.equal(summary.refusals, 1);
	});

	it("holds a line split across chunks, and ignores anything that is not JSON", () => {
		const summary = newSummary();
		const collector = createStreamCollector({ summary });
		const line = JSON.stringify(turn("r1", { cost: { total: 1 } }));
		collector.write("prime-agent v1.2.3 starting\n");
		collector.write(line.slice(0, 40));
		assert.equal(summary.turns, 0, "an incomplete line was parsed");
		collector.write(`${line.slice(40)}\n{ this is not json\n`);
		assert.equal(summary.turns, 1);
		assert.equal(summary.cost, 1);
	});

	it("every runner accumulates through it — no fourth hand-rolled copy", () => {
		// The rule this project keeps rediscovering: a documented check is not an
		// executed check. Asserting the runners IMPORT the collector is what stops a
		// fourth copy of the loop growing back beside it.
		for (const runner of ["bench/run-task.mjs", "bench/appworld/run-task.mjs", "bench/tac/run-task.mjs"]) {
			const src = readFileSync(join(ROOT, runner), "utf8");
			assert.match(src, /createStreamCollector/, `${runner} does not use the shared collector`);
			assert.equal(/message_end/.test(src), false, `${runner} still parses message_end itself`);
			assert.equal(/counted\.has\(/.test(src), false, `${runner} still keeps its own responseId set`);
		}
	});
});

describe("the wait sentinel is one string, known by five files", () => {
	// jobs.py is the writer; everything else is a detector. A rename that updated
	// the writer and missed a detector compiles fine and silently stops noticing
	// waits — the failure mode this project keeps meeting, where a broken harness
	// and a weak agent produce the same-looking number.
	const JOBS = readFileSync(join(ROOT, "runtime/jobs.py"), "utf8");
	const declared = JOBS.match(/^WAIT_SENTINEL = "([^"]+)"$/m);

	it("runtime/jobs.py declares it", () => {
		assert.ok(declared, "runtime/jobs.py has no `WAIT_SENTINEL = \"...\"` line");
		assert.match(declared[1], /^__HARNESS_[A-Z_]+__$/);
	});

	it("every detector matches the declared value, verbatim", () => {
		const sentinel = declared[1];
		const detectors = [
			"scripts/neutralize-prime.mjs",
			"vendor/prime-agent/packages/coding-agent/src/core/tools/ipython.ts",
			"bench/tac/run-task.mjs",
			"bench/terminal/prime_agent.py",
		];
		for (const path of detectors) {
			const src = readFileSync(join(ROOT, path), "utf8");
			assert.ok(src.includes(sentinel), `${path} does not mention ${sentinel} — a rename left this detector behind`);
			// And nothing NEAR it: any other __HARNESS_*SECONDS*__ token in these files
			// is a half-finished rename, which is the state that produces a plausible
			// number rather than an error.
			for (const other of src.match(/__HARNESS_[A-Z0-9_]*SECONDS[A-Z0-9_]*__/g) ?? []) {
				assert.equal(other, sentinel, `${path} carries a second wait sentinel: ${other}`);
			}
		}
	});
});
