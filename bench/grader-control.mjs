/**
 * The null-policy control for a state-diff grader.
 *
 * Every grader in this project decides whether a task passed by comparing the world
 * *after* the agent ran against what it should have been. That shape has a hole, and
 * the hole is invisible in aggregate: **a state diff only ever detects change**. On a
 * task whose correct behaviour changes nothing observable, an agent that does nothing
 * produces the same end-state as a correct one, so the grader says PASS.
 *
 * Measured on tau-bench (docs/SCOUT-tau-bench.md), which grades exactly this way:
 *
 *   ground truth passes                              140/140   <- looks healthy
 *   an agent that does nothing also passes            19/50    <- 38% of airline
 *
 * Reachable in one step there, because `transfer_to_human_agents` is a terminating
 * tool: call it first and the episode is graded immediately. Both numbers are true at
 * once, and quoting only the first one certifies a broken grader.
 *
 * So the control is a **pair**, and neither half means anything alone:
 *
 *   1. a known-correct solution must PASS   (else the grader is broken — the
 *      `evaluate_with_llm`-returns-False-on-its-own-error trap, CLAUDE.md)
 *   2. a do-nothing policy must FAIL        (else the grader is vacuous)
 *
 * And a third condition, which is the part that is easy to miss: the control is only
 * informative on a **discriminating task** — one whose ground truth makes an
 * observable change. Run it on a read-only task and the do-nothing policy passes *by
 * construction*, so a "failing" control is telling you about your task choice, not
 * your grader. tau-bench's 19 airline tasks are all of this kind (read-only or
 * zero-action ground truth), which is why upstream never noticed.
 *
 * Used by the Phase-0 grader-trust probes: bench/appworld/challenge-p0.py and the
 * terminal-bench oracle/nop pair. See docs/VALIDATION-AND-BENCHMARK-PLAN.md Phase 0.
 */

/**
 * @typedef {object} ControlPair
 * @property {boolean} groundTruthPassed  verdict for a known-correct solution
 * @property {boolean} nullPolicyPassed   verdict for an agent that took no action
 * @property {boolean} [groundTruthChangedState]  did the correct solution change
 *   anything observable? Omit only when unknown; pass `false` and the pair is
 *   reported as vacuous rather than as a grader failure.
 */

/**
 * @param {ControlPair} pair
 * @returns {{ok: boolean, vacuous: boolean, reasons: string[]}}
 */
export function checkNullPolicyControl(pair) {
	const { groundTruthPassed, nullPolicyPassed, groundTruthChangedState } = pair;
	const reasons = [];
	// Checked first: on a non-discriminating task the other two verdicts are
	// determined by the task, not by the grader, so reporting them as a grader
	// failure would send the reader to debug the wrong thing.
	const vacuous = groundTruthChangedState === false;
	if (vacuous) {
		reasons.push(
			"the control task is not discriminating: its ground truth changes nothing observable, " +
				"so a do-nothing policy matches the correct end-state by construction. Pick a task " +
				"whose ground truth writes something.",
		);
	}
	if (groundTruthPassed !== true) {
		reasons.push("the grader rejects a known-correct solution — it is broken, not strict");
	}
	if (nullPolicyPassed !== false && !vacuous) {
		reasons.push("the grader accepts a do-nothing policy — it is vacuous on this task");
	}
	return { ok: reasons.length === 0, vacuous, reasons };
}

/**
 * Throwing form, for use in probes and tests.
 * @param {ControlPair} pair
 * @param {string} [label]
 */
export function assertNullPolicyControl(pair, label = "grader") {
	const { ok, reasons } = checkNullPolicyControl(pair);
	if (!ok) {
		const error = new Error(`null-policy control failed for ${label}:\n  - ${reasons.join("\n  - ")}`);
		error.reasons = reasons;
		throw error;
	}
}
