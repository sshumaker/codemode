/**
 * Harness: `jobs.wait` ends the TURN, not just the cell.
 *
 * The kernel prelude's WaitSignal handler publishes the wait request as display_data
 * under HARNESS_WAIT_MARKER_MIME; the kernel manager lifts it onto ExecuteResult.wait
 * (local and remote kernels alike — the remote server returns the same ExecuteResult);
 * this turns it into the result's `terminatesTurn`, and the patched agent loop ends
 * the run after the batch with `stopReason: "waiting"` and these parameters on
 * `turn_end` / `agent_end`. Hosts arm their wake from that event, never from text.
 *
 * Forgery resistance is the stdout sentinel's: when HARNESS_WAIT_TOKEN is set, a
 * marker without this kernel's token is ignored. HARNESS_WAIT_ENDS_TURN=0 restores
 * the host-side sleep. See scripts/neutralize-prime.mjs.
 */
export interface HarnessWait {
	/** The clamped wake_after, in seconds. */
	seconds: number;
	/** What the agent asked for, before clamping. */
	requestedSeconds?: number;
	wakeAtMs?: number;
	armedAtMs?: number;
	/** The jobs and agents the agent named; empty for a bare deadline wait. */
	targets: string[];
	/** For named waits: wake when "all" of the targets finish, or "any" one. */
	mode?: "all" | "any";
	/** What actually wakes it: the targets, or every job live when it waited. */
	watch: string[];
	jobDir?: string;
	toolCallId: string;
	/** The wake request exactly as jobs.py writes wake.json — `scheduler.reason_for` takes it as is. */
	request: Record<string, unknown>;
}

export function harnessWaitEndsTurn(): boolean {
	return process.env.HARNESS_WAIT_ENDS_TURN !== "0";
}

function waitNames(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

function epochMs(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) : undefined;
}

/** The wait this cell ended on, if the marker is this kernel's own; otherwise undefined. */
export function harnessWaitFromMarker(
	marker: Record<string, unknown> | undefined,
	toolCallId: string,
): HarnessWait | undefined {
	if (!marker || !harnessWaitEndsTurn()) return undefined;
	const token = process.env.HARNESS_WAIT_TOKEN;
	if (token && marker.token !== token) return undefined;
	const { token: _token, ...request } = marker;
	const seconds = Number(request.wake_after);
	if (!Number.isFinite(seconds)) return undefined;
	return {
		seconds,
		requestedSeconds: typeof request.requested === "number" ? request.requested : undefined,
		wakeAtMs: epochMs(request.wake_at),
		armedAtMs: epochMs(request.armed_at),
		targets: waitNames(request.targets),
		mode: request.mode === "all" || request.mode === "any" ? request.mode : undefined,
		watch: waitNames(request.watch),
		jobDir: typeof request.job_dir === "string" ? request.job_dir : undefined,
		toolCallId,
		request,
	};
}

/** The stdout sentinel drives the sleep path; when the turn ends instead, its line is noise. */
export function stripWaitSentinel(text: string): string {
	return text.replace(/^__HARNESS_WAIT_SECONDS__:\d+(?::[A-Za-z0-9_-]+)?\n?/gm, "");
}
