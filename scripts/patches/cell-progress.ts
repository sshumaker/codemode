/**
 * How far a cell got before its kernel died. "started" once the kernel picked it up
 * (execute_input or busy for its request); "called" once it also reached outside the
 * kernel — a host request, or a tool call through the remote tunnel.
 *
 * Carried on the error that fails the execution, so the auto-restart path in
 * ipython.ts can tell a cell that never ran (safe to send again) from one that may
 * already have acted (sending it again would act twice). See scripts/neutralize-prime.mjs.
 */
export type CellProgress = "started" | "called";

export function markCellProgress<E extends Error>(error: E, progress: CellProgress | undefined): E {
	if (!progress) return error;
	const prior = (error as { cellProgress?: CellProgress }).cellProgress;
	(error as { cellProgress?: CellProgress }).cellProgress = prior === "called" ? prior : progress;
	return error;
}

export function cellProgress(error: unknown): CellProgress | undefined {
	const progress = (error as { cellProgress?: unknown } | undefined)?.cellProgress;
	return progress === "started" || progress === "called" ? progress : undefined;
}
