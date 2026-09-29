/**
 * Harness end-of-turn marker: runtime/kernel-prelude.py publishes a `jobs.wait` request
 * as display_data under this MIME when the cell ends on WaitSignal. Lifted onto
 * ExecuteResult.wait here; validated and acted on by the ipython tool
 * (scripts/patches/wait-ends-turn.ts). See scripts/neutralize-prime.mjs.
 */
export const HARNESS_WAIT_MARKER_MIME = "application/vnd.harness.wait+json";

function parseHarnessWaitMarker(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	const raw = data?.[HARNESS_WAIT_MARKER_MIME];
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}
