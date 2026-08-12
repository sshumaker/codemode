/**
 * Paired statistics. The test CLAUDE.md mandates and the repo did not have.
 *
 * "Always run the paired t-test, never eyeball the means" has been the rule since
 * the v3 episode, and nothing in `bench/` implemented one — `report.mjs` prints mean
 * cost and turn *ratios* over paired tasks and stops there. This module is that
 * missing piece, kept separate so `compare.mjs`, `report.mjs` and
 * `appworld/factorial.mjs` share one implementation.
 *
 * Why paired, and why it matters more here than usual
 * ---------------------------------------------------
 * The claims are about **differences between conditions on the same task**. Task-to-
 * task spread on this benchmark is enormous — a 7-call task and a 191-call task
 * differ by more than any treatment effect — and in a paired difference that spread
 * cancels exactly. An unpaired comparison of cell means is dominated by which tasks
 * landed in the sample; the paired difference is not.
 *
 * Concretely: the low-stratum representation saving is $0.070 against cell means
 * near $0.12 and $0.19. A per-cell coefficient of variation cannot say whether
 * $0.070 is real, because the cell's variation is mostly task size. `sd` of the
 * per-task difference can.
 *
 * Both a t-test and a sign test are reported. The t-test assumes roughly normal
 * differences, which cost data — right-skewed and heavy-tailed — does not reliably
 * satisfy at n=10. The sign test assumes only symmetry about zero under the null and
 * is nearly assumption-free. When they disagree, believe the sign test and say so.
 */

export const mean = (xs) => (xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Sample standard deviation (n-1). */
export function sd(xs) {
	if (xs.length < 2) return Number.NaN;
	const m = mean(xs);
	return Math.sqrt(xs.reduce((n, x) => n + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Continued-fraction expansion for the incomplete beta function (Lentz's method). */
function betacf(a, b, x) {
	const FPMIN = 1e-300;
	const qab = a + b;
	const qap = a + 1;
	const qam = a - 1;
	let c = 1;
	let d = 1 - (qab * x) / qap;
	if (Math.abs(d) < FPMIN) d = FPMIN;
	d = 1 / d;
	let h = d;
	for (let m = 1; m <= 200; m++) {
		const m2 = 2 * m;
		let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < FPMIN) d = FPMIN;
		c = 1 + aa / c;
		if (Math.abs(c) < FPMIN) c = FPMIN;
		d = 1 / d;
		h *= d * c;
		aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < FPMIN) d = FPMIN;
		c = 1 + aa / c;
		if (Math.abs(c) < FPMIN) c = FPMIN;
		d = 1 / d;
		const del = d * c;
		h *= del;
		if (Math.abs(del - 1) < 3e-14) break;
	}
	return h;
}

function logGamma(x) {
	// Lanczos approximation; plenty for p-values.
	const g = [
		676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
		-0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
	];
	if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
	const z = x - 1;
	let a = 0.99999999999980993;
	const t = z + 7.5;
	for (let i = 0; i < g.length; i++) a += g[i] / (z + i + 1);
	return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised incomplete beta I_x(a, b). */
function incompleteBeta(a, b, x) {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
	return x < (a + 1) / (a + b + 2) ? (front * betacf(a, b, x)) / a : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** Two-sided p-value for Student's t with `df` degrees of freedom. */
export function tTestP(t, df) {
	if (!Number.isFinite(t) || df <= 0) return Number.NaN;
	return incompleteBeta(df / 2, 0.5, df / (df + t * t));
}

function logChoose(n, k) {
	return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/**
 * Exact two-sided sign test.
 *
 * Ties (a difference of exactly zero) are dropped, which is the standard treatment
 * and shrinks n — reported as `nEffective` so a result resting on three non-tied
 * pairs is visibly doing so.
 */
export function signTest(deltas) {
	const nonZero = deltas.filter((d) => d !== 0);
	const n = nonZero.length;
	const wins = nonZero.filter((d) => d > 0).length;
	if (n === 0) return { nEffective: 0, wins: 0, p: Number.NaN };
	const extreme = Math.max(wins, n - wins);
	let tail = 0;
	for (let k = extreme; k <= n; k++) tail += Math.exp(logChoose(n, k) + n * Math.log(0.5));
	return { nEffective: n, wins, p: Math.min(1, 2 * tail) };
}

/**
 * Paired test over per-task differences.
 *
 * @param deltas one difference per task, already paired
 * @returns n, mean, sd, se, t, df, p (t-test), and the sign test
 */
export function pairedTest(deltas) {
	const n = deltas.length;
	const m = mean(deltas);
	const s = sd(deltas);
	const se = s / Math.sqrt(n);
	const t = se > 0 ? m / se : Number.NaN;
	return {
		n,
		mean: m,
		sd: s,
		se,
		t,
		df: n - 1,
		p: tTestP(t, n - 1),
		sign: signTest(deltas),
	};
}

/** One-line rendering, with the sign test alongside because cost is skewed. */
export function formatPaired(label, result, { unit = "$", digits = 3 } = {}) {
	const f = (x) => (Number.isFinite(x) ? x.toFixed(digits) : "—");
	const stars = result.p < 0.001 ? "***" : result.p < 0.01 ? "**" : result.p < 0.05 ? "*" : "";
	return (
		`${label.padEnd(30)} ${unit}${f(result.mean)} ± ${f(result.sd)}  ` +
		`t=${Number.isFinite(result.t) ? result.t.toFixed(2) : "—"} (df=${result.df}) ` +
		`p=${Number.isFinite(result.p) ? result.p.toExponential(1) : "—"}${stars}  ` +
		`sign ${result.sign.wins}/${result.sign.nEffective} p=${Number.isFinite(result.sign.p) ? result.sign.p.toFixed(3) : "—"}`
	);
}
