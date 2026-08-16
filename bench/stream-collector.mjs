/**
 * The one accumulator for prime's `--mode json` event stream.
 *
 * Three runners — `bench/run-task.mjs`, `bench/appworld/run-task.mjs` and
 * `bench/tac/run-task.mjs` — each hand-rolled the same loop: split stdout into
 * lines, parse the JSON ones, count `tool_execution_start`, tally errors off
 * `tool_execution_end`, and accumulate turns, tokens and cost from
 * `message_end`. Three copies of an accumulator that decides what every number
 * in this project's results tables means.
 *
 * They had already drifted, and the drift was invisible in the output:
 *
 *   - **TAC captured no first-turn context.** `firstTurnPromptTokens` is what the
 *     residency guard checks, so the one benchmark with no guard was the one
 *     whose arm labels nothing verified. An L0 run wearing an L4 label reads as
 *     "docs-in costs nothing", which is the direction that flatters the headline.
 *   - **TAC had no budget enforcement**, so `--max-cost` meant one thing on two
 *     benchmarks and nothing on the third.
 *   - **TAC recorded error COUNTS but not error TEXT**, against CLAUDE.md's rule
 *     to persist what a check saw rather than only its verdict.
 *   - **Only MCP-Bench noticed refusals.** A provider-side refusal is not a
 *     result; averaged in, it pulls a cell's mean cost toward zero in whichever
 *     cells happen to refuse.
 *
 * All four are fixed by having one implementation. What stays per-runner is
 * genuinely per-runner: where the raw stream is persisted, what else a tool
 * result is scanned for, and what a budget breach should do.
 *
 * ## Why the responseId dedup is not optional
 *
 * `message_end` can arrive more than once for the same assistant response —
 * retries, and the stream replay a resumed session emits. Counting completed
 * messages rather than streamed deltas already fixed one bug where summing
 * content blocks across `message_update` counted a single tool call nine times;
 * the responseId set is the same fix one level up, and it is the same semantics
 * `runtime/subagent_run.py` uses. Without it turns, tokens and cost are all
 * inflated by an amount that varies with how flaky the connection was, which is
 * the worst kind of measurement error: silent, and correlated with nothing you
 * are studying.
 */

/** The summary fields every runner accumulates, plus whatever else it wants. */
export function newSummary(extra = {}) {
	return {
		turns: 0,
		toolCalls: 0,
		toolNames: [],
		toolErrors: 0,
		errorMessages: [],
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		finalText: "",
		...extra,
	};
}

/**
 * Feed it stdout chunks; it fills `summary`.
 *
 * @param summary   the object to accumulate into — see `newSummary`
 * @param onEvent   every parsed event, in receipt order (trajectory logging)
 * @param onToolEnd `(event, text)` for `tool_execution_end`, with the result's
 *                  text already joined — a runner scans it for its own signals
 *                  (ArgumentError, ReadFirst, a wedged kernel) without re-parsing
 * @param onCounted called after each NEWLY counted turn, i.e. after `cost` and
 *                  `turns` have moved — where budget and turn caps belong
 */
export function createStreamCollector({ summary, onEvent, onToolEnd, onCounted } = {}) {
	const counted = new Set();
	let buffer = "";

	function handle(event) {
		onEvent?.(event);
		if (event.type === "tool_execution_start") {
			summary.toolCalls++;
			summary.toolNames.push(event.toolName);
			return;
		}
		if (event.type === "tool_execution_end") {
			const text = (event.result?.content ?? []).map((c) => c.text ?? "").join(" ");
			if (event.isError) {
				summary.toolErrors++;
				summary.errorMessages.push(text.slice(0, 300));
			}
			// Outside the isError branch on purpose: an exception the agent caught
			// inside its own cell is still a correction that was delivered.
			onToolEnd?.(event, text);
			return;
		}
		if (event.type !== "message_end" || event.message?.role !== "assistant") return;

		const message = event.message;
		// A provider-side refusal is not a result. osint_intelligence_000 asks for
		// typo-squat and exposed-service enumeration against a domain, which trips
		// the refusal classifier: three retries, all refused, zero tool calls, and
		// the run was recorded as `completed` at $0.02. Averaged in, a refusal pulls
		// its cell's mean cost toward zero in whichever cells happen to refuse — the
		// same shape as the rate-limited server whose 429s were counted as
		// successful MCP responses.
		if (message.stopReasonRaw === "refusal" || /\brefus/i.test(message.errorMessage ?? "")) {
			summary.refusals = (summary.refusals ?? 0) + 1;
		}
		const texts = (message.content ?? []).filter((c) => c.type === "text" && c.text);
		if (texts.length > 0) summary.finalText = texts.map((c) => c.text).join("");

		const id = message.responseId;
		if (!id || counted.has(id) || !message.usage?.totalTokens) return;
		counted.add(id);
		// Total context billed on the first turn: system prompt + tools + task.
		// This is what residency actually controls, so it is what the guards check.
		if (summary.turns === 0) {
			const u = message.usage;
			summary.firstTurnPromptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		}
		summary.turns++;
		for (const k of ["input", "output", "cacheRead", "cacheWrite"]) summary[k] += message.usage[k] ?? 0;
		summary.cost += message.usage.cost?.total ?? 0;
		onCounted?.(message);
	}

	return {
		/** The responseIds already counted. Exposed so a test can assert the dedup. */
		counted,
		/** Feed one raw stdout chunk. Partial lines are held until they complete. */
		write(chunk) {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("{")) continue;
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				handle(event);
			}
		},
		/** Feed one already-parsed event. */
		handle,
	};
}
