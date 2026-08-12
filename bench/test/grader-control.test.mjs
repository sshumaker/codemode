/**
 * Fairness invariant: every grader carries its own null-policy control.
 *
 * Same purpose as the rest of bench/test — pin a confound that has already produced a
 * plausible number somewhere, so it cannot come back quietly. This one was found in
 * tau-bench during the Phase-0 scout (docs/SCOUT-tau-bench.md) and it is a guard on
 * *our* graders, not a port of theirs: every state-diff grader we author inherits the
 * same hole, because a state diff only detects change.
 *
 * The existing "null control" in fairness.test.mjs guards the *statistic* (a cell
 * compared with itself must come out zero). This one guards the *grader* (a run that
 * did nothing must come out failed). Different mechanism, same discipline.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { assertNullPolicyControl, checkNullPolicyControl } from "../grader-control.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const P0_LOG = join(ROOT, ".run/appworld/p0-challenge.jsonl");
const CHALLENGE_P0 = join(ROOT, "bench/appworld/challenge-p0.py");

describe("the grader control is a pair, and both halves are load-bearing", () => {
	// A discriminating task: ground truth writes something, so doing nothing is
	// observably different from doing it right.
	const sound = { groundTruthPassed: true, nullPolicyPassed: false, groundTruthChangedState: true };

	it("accepts a grader that passes ground truth and fails a do-nothing run", () => {
		assert.equal(checkNullPolicyControl(sound).ok, true);
		assert.doesNotThrow(() => assertNullPolicyControl(sound, "sound grader"));
	});

	it("rejects a grader that also passes a do-nothing run", () => {
		// The tau-bench shape, measured: ground truth 140/140, do-nothing 19/50 on
		// airline. Both true at once.
		const res = checkNullPolicyControl({ ...sound, nullPolicyPassed: true });
		assert.equal(res.ok, false);
		assert.match(res.reasons.join(" "), /accepts a do-nothing policy/);
	});

	it("rejects a grader that fails ground truth", () => {
		// The other direction, and the one that eats result sets silently: TAC's
		// `evaluate_with_llm` catches its own failure and returns False, so a correct
		// answer scores zero and nothing says why.
		const res = checkNullPolicyControl({ ...sound, groundTruthPassed: false });
		assert.equal(res.ok, false);
		assert.match(res.reasons.join(" "), /rejects a known-correct solution/);
	});

	it("reports a non-discriminating control task as vacuous, not as a grader bug", () => {
		// tau-bench airline task 12: the user insists on a disallowed refund and the
		// correct behaviour is to refuse. Ground truth is zero actions, so refusing,
		// capitulating and saying nothing all leave the same end-state. The control
		// cannot say anything about the grader here — the task is the problem.
		const res = checkNullPolicyControl({
			groundTruthPassed: true,
			nullPolicyPassed: true,
			groundTruthChangedState: false,
		});
		assert.equal(res.ok, false);
		assert.equal(res.vacuous, true);
		assert.match(res.reasons.join(" "), /not discriminating/);
		// and it does not additionally blame the grader for the task's shape
		assert.doesNotMatch(res.reasons.join(" "), /vacuous on this task/);
	});
});

describe("the control would actually catch the failure it exists for", () => {
	// Non-vacuity, asserted rather than asserted-about. The failure mode is not "the
	// control is missing" but "the control is present and toothless": tau-bench's own
	// verification passes ground truth, which is the check everyone writes, and that
	// check is green on a grader that passes doing nothing.
	const tauBenchShape = {
		groundTruthPassed: true, // 140/140
		nullPolicyPassed: true, // 19/50 airline, 7/115 retail
		groundTruthChangedState: true, // read-only GT excluded; even so it passes
	};

	it("a ground-truth-only check is green on the tau-bench grader", () => {
		// This is the weaker control, spelled out so the contrast is in the test rather
		// than in a comment. If this assertion ever fails, the shape has changed and the
		// one below is no longer testing what it claims to.
		assert.equal(tauBenchShape.groundTruthPassed, true);
	});

	it("the paired control is red on the same input", () => {
		assert.equal(checkNullPolicyControl(tauBenchShape).ok, false);
		assert.throws(() => assertNullPolicyControl(tauBenchShape, "tau-bench"), /accepts a do-nothing policy/);
	});

	it("the assertion names the grader, so a failure is diagnosable", () => {
		assert.throws(() => assertNullPolicyControl(tauBenchShape, "appworld"), /null-policy control failed for appworld/);
	});
});

describe("the Phase-0 probe runs both halves against the real grader", () => {
	// "Run the real harness, not a reimplementation": the control above is a predicate
	// over verdicts, and a predicate never executed against a real grader guards
	// nothing. challenge-p0.py drives AppWorld.evaluate() itself.
	const haveProbe = existsSync(CHALLENGE_P0);
	const source = haveProbe ? readFileSync(CHALLENGE_P0, "utf8") : "";

	it("both controls exist", { skip: haveProbe ? false : "no challenge-p0.py" }, () => {
		assert.match(source, /def cmd_negative\(/);
		assert.match(source, /def cmd_positive\(/);
	});

	it("the negative control requires False and the positive requires True", { skip: haveProbe ? false : "no challenge-p0.py" }, () => {
		// Identity, not truthiness: `success` has arrived as None from a grader that
		// errored, and `not None` is True.
		assert.match(source, /ok = verdict\["success"\] is False/);
		assert.match(source, /ok = verdict\["success"\] is True/);
	});

	it("success comes from tracker.success, never a pass fraction", { skip: haveProbe ? false : "no challenge-p0.py" }, () => {
		// The same bug in its other form: a do-nothing run scores 1/2 on a read-only
		// AppWorld task because "no collateral damage" passes trivially.
		// docs/BENCHMARK-SELECTION.md §4.2.
		assert.match(source, /"success": bool\(tracker\.success\)/);
	});

	it("it records what the grader saw, not just the verdict", { skip: haveProbe ? false : "no challenge-p0.py" }, () => {
		assert.match(source, /def record\(/);
		assert.match(source, /"report": report/);
	});
});

describe("the recorded Phase-0 evidence satisfies the control", () => {
	// Applied to real verdicts, so this is a check on the grader rather than on the
	// predicate. Skipped rather than faked when the probe has not been run.
	const haveLog = existsSync(P0_LOG);
	const rows = haveLog
		? readFileSync(P0_LOG, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
	const negatives = rows.filter((r) => r.control === "negative" && !r.error);
	const positives = rows.filter((r) => r.control === "positive" && !r.error);

	it("both halves of the pair were actually run", { skip: haveLog ? false : "run bench/appworld/challenge-p0.py" }, () => {
		assert.ok(negatives.length > 0, "no negative (do-nothing) control recorded");
		assert.ok(positives.length > 0, "no positive (known-correct) control recorded");
	});

	it("every do-nothing run was failed by the grader", { skip: haveLog ? false : "run bench/appworld/challenge-p0.py" }, () => {
		// The tau-bench invariant, on our own grader. One do-nothing run scoring
		// success here means AppWorld tasks have the same read-only hole, and every
		// score from that split is suspect until it is explained.
		const passed = negatives.filter((r) => r.success !== false);
		assert.deepEqual(
			passed.map((r) => r.taskId),
			[],
			`the grader passed a do-nothing run on ${passed.length} task(s) — see ${P0_LOG}`,
		);
	});

	it("at least one known-correct solution was passed", { skip: haveLog ? false : "run bench/appworld/challenge-p0.py" }, () => {
		// Deliberately "at least one" rather than "all": a failing positive means the
		// hand-written solution for that task is wrong, which is a REFERENCE finding
		// for whoever is writing it, not evidence about the grader. What this half has
		// to establish is only that the grader is *able* to say yes — without it, the
		// negative control above is satisfied by a grader that fails everything.
		assert.ok(
			positives.some((r) => r.success === true),
			"no positive control passed — a grader that always fails satisfies the negative control trivially",
		);
	});

	it("the pair holds jointly, via the shared control", { skip: haveLog ? false : "run bench/appworld/challenge-p0.py" }, () => {
		assertNullPolicyControl(
			{
				groundTruthPassed: positives.some((r) => r.success === true),
				nullPolicyPassed: negatives.some((r) => r.success !== false),
				groundTruthChangedState: true,
			},
			"appworld test_challenge",
		);
	});
});
