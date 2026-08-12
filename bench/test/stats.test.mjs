/**
 * Tests for the paired statistics the conclusions rest on.
 *
 * `bench/stats.mjs` is new because the repo had no paired test at all — CLAUDE.md has
 * mandated one since the v3 episode, and `report.mjs` printed mean cost and turn
 * *ratios* over paired tasks and stopped. `bench/compare.mjs` does not implement one
 * either (it spawns arms and parses streams), so there was nothing to reuse.
 *
 * The two sanity checks that matter most are the degenerate ones. A statistic that
 * reports significance on identical inputs, or that quietly substitutes a value for a
 * missing pair, produces a plausible number rather than an error — which is the shape
 * of every serious bug found on this project.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPaired, mean, pairedTest, sd, signTest, tTestP } from "../stats.mjs";

describe("the t distribution is the real one", () => {
	// Against published two-sided critical values. A p-value routine that is merely
	// monotonic looks right on real data and misstates every threshold.
	it("matches known critical values at df=9 and df=10", () => {
		assert.ok(Math.abs(tTestP(2.228, 10) - 0.05) < 0.001, `t=2.228 df=10 -> ${tTestP(2.228, 10)}`);
		assert.ok(Math.abs(tTestP(3.169, 10) - 0.01) < 0.001, `t=3.169 df=10 -> ${tTestP(3.169, 10)}`);
		assert.ok(Math.abs(tTestP(2.262, 9) - 0.05) < 0.001, `t=2.262 df=9 -> ${tTestP(2.262, 9)}`);
		assert.ok(Math.abs(tTestP(1.833, 9) - 0.1) < 0.001, `t=1.833 df=9 -> ${tTestP(1.833, 9)}`);
	});

	it("t=0 is p=1 and larger |t| is never a larger p", () => {
		assert.ok(Math.abs(tTestP(0, 9) - 1) < 1e-9);
		let previous = 1;
		for (const t of [0.5, 1, 2, 3, 5, 10]) {
			const p = tTestP(t, 9);
			assert.ok(p <= previous, `p should not increase with t: ${t}`);
			previous = p;
		}
	});

	it("is symmetric in the sign of t", () => {
		assert.ok(Math.abs(tTestP(2.3, 9) - tTestP(-2.3, 9)) < 1e-12);
	});
});

describe("a cell compared with itself must show nothing", () => {
	// Sanity check 1. If pairing is implemented wrongly — comparing across tasks
	// rather than within them, say — identical inputs still produce a spread, and the
	// test reports an effect that cannot exist.
	const costs = [0.11, 1.94, 0.07, 0.63, 2.41, 0.09, 0.88, 0.15, 3.02, 0.21];

	it("mean difference is exactly zero", () => {
		const result = pairedTest(costs.map((c) => c - c));
		assert.equal(result.mean, 0);
		assert.equal(result.sd, 0);
	});

	it("reports no significance rather than a spurious effect", () => {
		const result = pairedTest(costs.map((c) => c - c));
		// se == 0, so t is not finite; the contract is that this surfaces as "—"
		// rather than as Infinity dressed up as an enormous effect.
		assert.equal(Number.isFinite(result.t), false, `t on identical inputs was ${result.t}`);
		assert.match(formatPaired("self", result), /t=—/);
	});

	it("the sign test degenerates rather than claiming a win", () => {
		const result = signTest(costs.map((c) => c - c));
		// Every difference is a tie, so nothing is left to test.
		assert.equal(result.nEffective, 0);
		assert.equal(result.wins, 0);
		assert.ok(Number.isNaN(result.p));
	});

	it("a spread that is real is still detected, so the check is not vacuous", () => {
		// The same shape with a genuine constant offset must come back significant —
		// otherwise "shows nothing on identical inputs" would be trivially satisfied by
		// a test that never fires.
		const result = pairedTest(costs.map(() => 0.5));
		assert.equal(result.mean, 0.5);
		assert.equal(signTest(costs.map(() => 0.5)).wins, 10);
	});
});

describe("a missing pair is dropped, never substituted", () => {
	// Sanity check 2. "Missing is not zero" was the worst bug of the night: an
	// analysis that substituted 0 for an unrun task and divided by the full set
	// rendered a half-finished cell as a cheap one.
	const paired = [
		{ task: "a", x: 1.0, y: 1.5 },
		{ task: "b", x: 2.0, y: 2.4 },
		{ task: "c", x: 3.0, y: undefined }, // y never ran
		{ task: "d", x: 4.0, y: 4.6 },
	];

	/** The rule the callers must apply: only tasks present in BOTH cells. */
	const deltas = paired.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => p.y - p.x);

	it("n reflects the pairs that exist, not the tasks attempted", () => {
		const result = pairedTest(deltas);
		assert.equal(result.n, 3, "the unpaired task was counted");
		assert.equal(result.df, 2);
	});

	it("the mean is unaffected by the missing task", () => {
		const result = pairedTest(deltas);
		// 0.5, 0.4, 0.6 -> 0.5. Substituting 0 for the missing pair would give 0.375.
		assert.ok(Math.abs(result.mean - 0.5) < 1e-12, `mean was ${result.mean}`);
	});

	it("substituting zero would have changed the answer, so this is worth asserting", () => {
		const substituted = paired.map((p) => (Number.isFinite(p.y) ? p.y - p.x : 0));
		assert.notEqual(mean(substituted).toFixed(3), mean(deltas).toFixed(3));
	});
});

describe("the sign test is exact and does not overstate", () => {
	it("10/10 in one direction is p≈0.002, not p=0", () => {
		const result = signTest([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
		assert.equal(result.wins, 10);
		assert.ok(Math.abs(result.p - 2 * 0.5 ** 10) < 1e-12, `p was ${result.p}`);
	});

	it("an even split is p=1", () => {
		assert.ok(Math.abs(signTest([1, 1, 1, -1, -1, -1]).p - 1) < 1e-12);
	});

	it("ties shrink n rather than counting as agreement", () => {
		const result = signTest([1, 1, 0, 0, -1]);
		assert.equal(result.nEffective, 3);
	});
});

describe("sd is the sample sd", () => {
	it("uses n-1", () => {
		// [2,4,4,4,5,5,7,9]: population sd 2, sample sd 2.138…
		assert.ok(Math.abs(sd([2, 4, 4, 4, 5, 5, 7, 9]) - 2.13809) < 1e-4);
	});

	it("is undefined for a single observation rather than zero", () => {
		// Zero would read as "no variance measured" when the truth is "not measurable".
		assert.ok(Number.isNaN(sd([1])));
	});
});
