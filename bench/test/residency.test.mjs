/**
 * Residency levels.
 *
 * Residency is a dial, not a switch: L0 (discover everything) through L4 (every
 * schema resident, which is what `vanilla` does today). These tests pin the
 * properties the calibration pass depends on — chiefly that no level silently
 * drops a tool, since a TOC missing an entry would look like a token win while
 * actually being a capability loss.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ARMS, buildArm, countTokens, RESIDENCY_LEVELS, renderResidency } from "../arms.mjs";

describe("residency rendering", () => {
	it("rejects an unknown level", async () => {
		const built = await buildArm("vanilla");
		assert.throws(() => renderResidency(built, "L9"), /unknown residency level/);
	});

	it("L0 is empty — the agent discovers from the api/ tree", async () => {
		const built = await buildArm("vanilla");
		assert.equal(renderResidency(built, "L0"), "");
	});

	for (const arm of Object.keys(ARMS)) {
		it(`${arm}: L1 names every tool exactly once`, async () => {
			const built = await buildArm(arm);
			const lines = renderResidency(built, "L1").split("\n").filter(Boolean);
			assert.deepEqual(lines.sort(), [...built.names].sort());
		});

		it(`${arm}: L2 mentions every tool — a TOC must not drop entries`, async () => {
			const built = await buildArm(arm);
			const toc = renderResidency(built, "L2");
			for (const name of built.names) {
				assert.ok(toc.includes(name), `L2 TOC omits ${name}`);
			}
		});

		it(`${arm}: L2 gives one line per tool`, async () => {
			const built = await buildArm(arm);
			const lines = renderResidency(built, "L2").split("\n").filter(Boolean);
			assert.equal(lines.length, built.names.length);
		});

		it(`${arm}: L4 round-trips to the wire definitions`, async () => {
			const built = await buildArm(arm);
			assert.deepEqual(JSON.parse(renderResidency(built, "L4")), built.wire);
		});
	}
});

describe("residency cost is monotone", () => {
	// Each level should cost strictly more than the one below it. If it does not,
	// the level is mislabelled and the calibration pass would compare the wrong
	// things.
	for (const arm of Object.keys(ARMS)) {
		it(`${arm}: L0 < L1 < L2 < L4`, async () => {
			const built = await buildArm(arm);
			const costs = RESIDENCY_LEVELS.map((L) => countTokens(renderResidency(built, L)));
			for (let i = 1; i < costs.length; i++) {
				assert.ok(
					costs[i] > costs[i - 1],
					`${RESIDENCY_LEVELS[i]} (${costs[i]}) is not more than ${RESIDENCY_LEVELS[i - 1]} (${costs[i - 1]})`,
				);
			}
		});
	}
});

describe("the arms sit on one axis", () => {
	it("codemode's full schema cost is below vanilla's", async () => {
		const [v, c] = await Promise.all([buildArm("vanilla"), buildArm("codemode")]);
		assert.ok(
			c.residentTokens < v.residentTokens,
			`codemode ${c.residentTokens} should be below vanilla ${v.residentTokens}`,
		);
	});

	it("L2 compresses meaningfully against L4", async () => {
		// The deflationary hypothesis in docs/DESIGN.md: if most of the token win
		// comes from schema -> TOC compression rather than lazy loading, it is
		// obtainable without a REPL. This pins the compression ratio so a
		// regression in TOC rendering is visible.
		const built = await buildArm("vanilla");
		const l2 = countTokens(renderResidency(built, "L2"));
		const l4 = countTokens(renderResidency(built, "L4"));
		assert.ok(l4 / l2 > 1.5, `expected >1.5x compression, got ${(l4 / l2).toFixed(2)}x`);
	});

	it("reports the measured costs for the record", async () => {
		// Not an assertion so much as a fixture: these numbers are the built-in
		// tool baseline, before any MCP catalogue is added.
		const rows = [];
		for (const arm of Object.keys(ARMS)) {
			const built = await buildArm(arm);
			const costs = Object.fromEntries(
				RESIDENCY_LEVELS.map((L) => [L, countTokens(renderResidency(built, L))]),
			);
			rows.push({ arm, ...costs });
		}
		console.table(rows);
		assert.ok(rows.length === 2);
	});
});
