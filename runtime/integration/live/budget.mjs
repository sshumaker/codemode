/**
 * The live tier's per-run cost cap. Every scenario that calls a paid model records
 * what it spent (summed from prime's own usage accounting on each assistant message)
 * in HARNESS_LIVE_LEDGER; `overBudget()` is checked before each scenario starts.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const LEDGER = process.env.HARNESS_LIVE_LEDGER;
export const MAX_COST = Number(process.env.HARNESS_LIVE_MAX_COST ?? "1.00");

export function spent() {
	if (!LEDGER || !existsSync(LEDGER)) return 0;
	return readFileSync(LEDGER, "utf8")
		.split("\n")
		.filter(Boolean)
		.reduce((s, l) => s + (JSON.parse(l).cost ?? 0), 0);
}

export function record(label, cost) {
	if (LEDGER) appendFileSync(LEDGER, `${JSON.stringify({ label, cost, at: Date.now() })}\n`);
}

/** A skip reason once the run has spent its cap, else false. */
export function overBudget() {
	const s = spent();
	return s >= MAX_COST ? `the run has spent $${s.toFixed(4)} of its $${MAX_COST.toFixed(2)} cap` : false;
}

/** USD prime reported for these events' assistant messages. */
export function costOf(events) {
	return events
		.filter((e) => e.type === "message_end" && e.message?.role === "assistant")
		.reduce((s, e) => s + (e.message.usage?.cost?.total ?? 0), 0);
}
