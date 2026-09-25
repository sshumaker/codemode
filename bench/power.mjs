/**
 * Can this comparison resolve the effect it is about to claim?
 *
 * WHY THIS EXISTS, measured 2026-08-31 on the product Decomposed bank (GLM 5.2)
 * Six prompt variants were run at N=40, one run per arm, and judged on
 * `references_required`. All six came back between -0.083 and -0.216, two of them
 * at sign-test p<0.05, and the obvious reading was "every prompt change hurts".
 *
 * It was an artifact. Seven near-identical configs on the same 40 positions span
 * 0.359-0.564 on that dimension — a range of 0.205, WIDER than any effect being
 * claimed — because 27 of 39 positions are bistable (position 27 scored
 * [1,0,0,0,0,0,0] across the seven). Scored leave-one-out against the pooled mean,
 * the only significant result in the whole set was that the BASELINE run was a high
 * outlier: +0.154, 20-6, p=0.0047. Every rung had been measured against one lucky
 * draw.
 *
 * `references_required` needs ~9 runs per arm to resolve +0.10 and ~35 to resolve
 * +0.05. The campaign used one. It was underpowered by an order of magnitude, and
 * nothing in the tooling said so — the numbers looked like results.
 *
 * So this is the check, in code rather than in a rules file, because "a documented
 * check is not an executed check" (CLAUDE.md) and that lesson has now been paid for
 * twice: once by a t-test mandated for months that the repo did not contain, and
 * once by this.
 *
 * A Python counterpart for the p-value side lives in `bench/tdist.py`: exact
 * two-sided Student-t via the regularised incomplete beta. It exists because the
 * first analysis script used `erfc(|t|/sqrt2)` for p, which at df=4 reports 0.0055
 * where the truth is 0.0500 — 9x overstated, in the direction that manufactures a
 * result. Do not reach for the normal approximation at these n.
 *
 * The estimator here is the standard two-sample normal approximation on RUN-level means.
 * The run is the unit of analysis because the run is the unit the noise was measured
 * at — pooling per-item scores across runs understates it badly, since the
 * bistability is per-item and correlated within a run.
 */

/**
 * Two-sided normal quantiles, tabulated for the power levels this module supports.
 *
 * A TABLE and not a `>= 0.9 ? a : b` ternary, because the ternary was the first
 * version and it was wrong in the dangerous direction: `power: 0.85` silently
 * returned the 80% answer and `power: 0.95` the 90% one, i.e. it UNDERSTATED the
 * required n and would have let an underpowered design through the gate built to
 * stop them. A plausible number and no error — the failure shape this whole file
 * exists to prevent, reproduced inside it within hours of being written.
 */
const Z_ALPHA_05 = 1.959964;
const Z_POWER = new Map([
	[0.8, 0.8416212],
	[0.9, 1.2815516],
	[0.95, 1.6448536],
	[0.99, 2.3263479],
]);

/**
 * Runs per arm needed to resolve `effect` given run-level `sd`.
 *
 * Two-sample, two-sided, equal n. Returns a real number — round UP when planning,
 * because 4.7 runs/arm means five.
 */
export function runsPerArm({ sd, effect, power = 0.8 }) {
	if (!(sd > 0)) throw new Error(`sd must be positive, got ${sd}`);
	if (!(Math.abs(effect) > 0)) throw new Error(`effect must be non-zero, got ${effect}`);
	const zb = Z_POWER.get(power);
	// Refuse an unsupported level rather than substituting a neighbour. Rounding
	// power DOWN silently reduces the n this returns, which is the one direction
	// that lets a bad design pass.
	if (zb === undefined) {
		throw new Error(
			`power=${power} is not tabulated; supported: ${[...Z_POWER.keys()].join(", ")}. ` +
				`Add the z-quantile rather than rounding to a neighbour — rounding down understates n.`,
		);
	}
	return ((Z_ALPHA_05 + zb) ** 2 * 2 * sd ** 2) / effect ** 2;
}

/**
 * Throw when a planned comparison cannot resolve the effect it intends to claim.
 *
 * Deliberately a throw and not a warning. The failure mode being prevented is
 * reporting an underpowered comparison as a finding, and a warning printed beside a
 * plausible-looking table gets read as decoration — the same reason the filesystem
 * guard refuses a cell instead of annotating it.
 */
export function assertResolvable({ label, sd, effect, runs, power = 0.8 }) {
	const need = runsPerArm({ sd, effect, power });
	if (runs < need) {
		throw new Error(
			`${label}: ${runs} run(s)/arm cannot resolve ${effect >= 0 ? "+" : ""}${effect} at sd=${sd} ` +
				`(needs ${Math.ceil(need)}). Either run ${Math.ceil(need)} per arm, pick a dimension with ` +
				`lower run-level noise, or state the expected effect as unmeasurable and do not run.`,
		);
	}
	return need;
}

/** A planning table: runs/arm for each dimension at a set of candidate effects. */
export function planningTable(sds, effects = [0.05, 0.1, 0.15]) {
	// No default: a borrowed noise estimate is the mistake this module exists to stop.
	if (!sds || typeof sds !== "object") throw new Error("planningTable needs run-level sds measured on YOUR bank");
	return Object.entries(sds).flatMap(([dim, sd]) =>
		effects.map((effect) => ({ dim, sd, effect, runsPerArm: runsPerArm({ sd, effect }) })),
	);
}
