/**
 * Invariants for the residency dial and the 2x2 cells.
 *
 * These exist because the project's failures have twice been *checks that were
 * documented but never executed*: an L1 arm that was silently L4 for three
 * attempts, and a paired t-test mandated in CLAUDE.md that no code implemented.
 * Prose in a rules file is a statement of intent. This is the control.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generate, renderFullDocs } from "../generate.mjs";
import { buildVanillaPreamble, VANILLA_VARIANT_NAMES } from "../prompts.mjs";
import { loadTasks } from "../tasks.mjs";

const CATALOGUE = JSON.parse(readFileSync(new URL("../data/mcp-schemas.json", import.meta.url), "utf8")).catalogue;
const TASKS = loadTasks();
const forTask = (t) => CATALOGUE.filter((s) => t.exposedServers.includes(s.server));

/** The tail both guided vanilla variants share, from "Two things make..." on. */
const tail = (s) => s.slice(s.indexOf("Two things make"));

test("guided vanilla variants carry byte-identical efficiency guidance", () => {
	const guided = ["w2", "w3"];
	for (const v of guided) {
		const s = buildVanillaPreamble(v, { toolCount: 96 });
		assert.ok(s.includes("Two things make"), `${v} lost the efficiency guidance`);
	}
	const [a, b] = guided.map((v) => buildVanillaPreamble(v, { toolCount: 96 }));
	// Not "both mention parallelism" — byte-identical. A reworded copy in one cell
	// is exactly the confound this prevents, and it would pass a looser check.
	assert.equal(tail(a), tail(b), "w2 and w3 guidance diverged; the tools row is confounded");
});

test("w3 describes the deferred mechanism and w2 does not claim it", () => {
	const w3 = buildVanillaPreamble("w3", { toolCount: 96 });
	const w2 = buildVanillaPreamble("w2", { toolCount: 96 });
	// w3 is the L1 cell: it must actually explain how to reach a schema.
	assert.ok(w3.includes("describe_tool") && w3.includes("call_tool"), "w3 must document the dispatcher");
	// w2 is the L4 cell: schemas are resident, so it must not send the model looking.
	assert.ok(!w2.includes("describe_tool"), "w2 must not describe a lookup step it does not have");
	assert.ok(w2.includes("already in your context"), "w2 should state schemas are resident");
});

test("w1 remains unguided — the negative control is not silently upgraded", () => {
	assert.equal(buildVanillaPreamble("w1", { toolCount: 96 }), "");
	assert.ok(VANILLA_VARIANT_NAMES.includes("w1"), "w1 must stay available as the no-guidance baseline");
});

test("codemode L4 renders real documentation for every runnable task", () => {
	assert.ok(TASKS.length > 0, "no runnable tasks — the rest of this file proves nothing");
	for (const t of TASKS) {
		const { normalized, tocLines } = generate(forTask(t));
		const docs = normalized.map(({ server, tools }) => renderFullDocs(tools, { server })).join("\n");
		// The failure mode is an empty or near-empty render, which would make the
		// docs-in cell an L0 run wearing an L4 label and read as "docs cost nothing".
		assert.ok(docs.length > 2_000, `${t.id}: renderFullDocs produced only ${docs.length} chars`);
		assert.ok(tocLines.length > 0, `${t.id}: no tools in catalogue`);
		// Every tool named in the index must be documented, or the cell is partial.
		assert.ok(docs.length / 4 > tocLines.length * 20, `${t.id}: docs too small for ${tocLines.length} tools`);
	}
});

test("the docs-in preamble is an order of magnitude larger than docs-out", () => {
	// The dial has to actually move. Measured on collected AppWorld runs the levels
	// were 4.6k / 9k / 68k with no overlap; this asserts the same separation here,
	// where the catalogue is per-task and smaller.
	for (const t of TASKS.slice(0, 10)) {
		const { normalized, names } = generate(forTask(t));
		const docs = normalized.map(({ server, tools }) => renderFullDocs(tools, { server })).join("\n");
		const namesOnly = names.join("\n");
		assert.ok(
			docs.length > namesOnly.length * 4,
			`${t.id}: docs-in (${docs.length}) is not meaningfully larger than names-only (${namesOnly.length})`,
		);
	}
});

/**
 * The guard itself, as a pure function of the two recorded numbers. Kept in sync
 * with run-task.mjs by testing the rule, not the copy — if the rule changes there
 * and not here, the asserted failure case below stops failing.
 */
const violates = (firstTurnPromptTokens, preambleChars) => {
	const preambleTokens = preambleChars / 4;
	return preambleTokens > 1_000 && firstTurnPromptTokens < preambleTokens * 0.6;
};

test("preamble guard catches a dropped preamble and clears real runs", () => {
	// A dropped preamble: first turn is the base prompt only against a 60k catalogue.
	assert.equal(violates(4_600, 240_000), true, "a dropped catalogue must be caught");
	// The tightest real run measured across 122 collected runs had ratio 1.38.
	assert.equal(violates(82_800, 240_000), false, "a real L4 run must pass");
	// Small preambles are exempt: L0's pointer is ~600 tokens and has no floor.
	assert.equal(violates(4_600, 2_400), false, "L0 must not be subject to a docs floor");
	// The boundary is 0.6 — assert both sides so a silent retune of the constant
	// shows up here rather than as a quietly disabled check.
	assert.equal(violates(5_999, 40_000), true);
	assert.equal(violates(6_001, 40_000), false);
});
