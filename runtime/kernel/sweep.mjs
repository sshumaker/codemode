/**
 * Running a backend's idle-sandbox sweep on a schedule: once shortly after startup, then
 * every few hours. The deciding is the backend's (sweepIdle); this only calls it.
 */

export const SWEEP_FIRST_DELAY_MS = 60_000;
export const SWEEP_INTERVAL_MS = 6 * 3_600_000;

/**
 * Sweep `backend`'s sandboxes idle longer than `olderThanMs`, after `firstDelayMs` and
 * then every `intervalMs`. A no-op (and a no-op stop) when the backend cannot sweep or
 * `olderThanMs` is not positive. Timers are unref'd, so they never hold a process open.
 * Returns a function that stops the schedule.
 */
export function startIdleSweep(backend, opts) {
	const { olderThanMs, lastActive, isOpen } = opts;
	if (!backend.sweepIdle || !(olderThanMs > 0)) return () => {};
	const onError = opts.onError ?? (() => {});
	const sweep = () => {
		backend.sweepIdle({ olderThanMs, lastActive, isOpen }).then(opts.onSwept, onError).catch(onError);
	};
	const first = setTimeout(sweep, opts.firstDelayMs ?? SWEEP_FIRST_DELAY_MS);
	first.unref?.();
	const every = setInterval(sweep, opts.intervalMs ?? SWEEP_INTERVAL_MS);
	every.unref?.();
	return () => {
		clearTimeout(first);
		clearInterval(every);
	};
}
