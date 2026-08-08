/**
 * Bounded-concurrency runner for benchmark jobs.
 *
 * Runs are almost entirely latency-bound — a task spends its time waiting on
 * model turns and MCP responses, not on CPU — so wall-clock scales close to
 * linearly with concurrency until an upstream rate limit bites.
 *
 * Safety notes, since parallelism here can produce failures that look like
 * agent errors:
 *
 *  - MCP servers are shared. Each is one child process with id-correlated
 *    JSON-RPC, so concurrent calls are safe at the protocol level, and the
 *    proxy serializes the handful MCP-Bench flags as sequential-only.
 *  - Each run gets its own run directory and agent home, so no run can observe
 *    or clobber another's state.
 *  - A first call to a cold server pays a 10-30s start; the pool does not
 *    special-case it, it just costs that job its own latency.
 */

/**
 * Run `jobs` with at most `concurrency` in flight.
 *
 * @param jobs        array of items
 * @param worker      (item, index) => Promise
 * @param concurrency max simultaneous workers
 * @param onSettled   optional (result, item, index) called as each finishes
 * @returns results in input order; a thrown job yields {error}
 */
export async function pool(jobs, worker, concurrency = 4, onSettled) {
	const results = new Array(jobs.length);
	let next = 0;

	async function runner() {
		for (;;) {
			const index = next++;
			if (index >= jobs.length) return;
			try {
				results[index] = await worker(jobs[index], index);
			} catch (error) {
				// One bad job must not abort the sweep — the point of a long run is
				// that it survives individual failures.
				results[index] = { error: error?.message ?? String(error) };
			}
			onSettled?.(results[index], jobs[index], index);
		}
	}

	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, runner));
	return results;
}
