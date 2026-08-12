import { test } from "node:test";
import assert from "node:assert/strict";
import { selectTags } from "../select-tags.mjs";

const has = (...present) => (tag) => present.includes(tag);

test("replicates average: no override tags means all base tags are used", () => {
	const r = selectTags(["a", "b"], [], has("a", "b"));
	assert.deepEqual(r.tags, ["a", "b"]);
	assert.equal(r.overridden, false);
});

test("an override REPLACES the base tags rather than joining them", () => {
	const r = selectTags(["a", "b"], ["c"], has("a", "b", "c"));
	// The whole point: "c" must not appear alongside a and b, because averaging a
	// censored run with its uncensored replacement yields a value that is neither.
	assert.deepEqual(r.tags, ["c"]);
	assert.equal(r.overridden, true);
	assert.ok(!r.tags.includes("a"), "base run must be dropped, not averaged");
});

test("an override with no run here falls through to the base tags", () => {
	// A repair covering 11 of 24 tasks must leave the other 13 on their base runs.
	// Excluding them instead would silently shrink the sample to the repaired set.
	const r = selectTags(["a"], ["c"], has("a"));
	assert.deepEqual(r.tags, ["a"]);
	assert.equal(r.overridden, false);
});

test("multiple override tags average with each other", () => {
	// Two repair passes at the same corrected setting ARE replicates of each other.
	const r = selectTags(["a"], ["c", "d"], has("a", "c", "d"));
	assert.deepEqual(r.tags, ["c", "d"]);
	assert.equal(r.overridden, true);
});

test("only override tags that actually have runs are used", () => {
	const r = selectTags(["a"], ["c", "d"], has("a", "d"));
	assert.deepEqual(r.tags, ["d"], "an override tag with no run must not be selected");
	assert.equal(r.overridden, true);
});

test("the distinction is not vacuous: averaging would change the answer", () => {
	// Guards the test suite itself. If selectTags ever returned base+override, the
	// mean below would move — so this asserts the scenario has teeth.
	const censored = 1.06;
	const repaired = 2.3;
	const picked = selectTags(["x2x2"], ["c3"], has("x2x2", "c3"));
	const value = picked.tags.includes("c3") && picked.tags.length === 1 ? repaired : (censored + repaired) / 2;
	assert.equal(value, repaired);
	assert.notEqual(repaired, (censored + repaired) / 2, "scenario must distinguish the two rules");
});
