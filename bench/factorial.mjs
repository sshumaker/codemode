#!/usr/bin/env node
/**
 * The MCP-Bench 2x2 — the reproduction test for the AppWorld result.
 *
 *   node bench/factorial.mjs [--tag x2x2] [--model anthropic-claude-opus-5]
 *
 * Same four cells and the same contrasts as bench/appworld/factorial.mjs, on the
 * same bench/stats.mjs. That is the point: AppWorld measured residency as a flat
 * ~$0.51 per-task tax and representation as a term that scales with work ($0.067
 * low stratum, $0.766 high). Neither claim is reproduced anywhere else, which is
 * the top open question in docs/. MCP-Bench is the mirror-image control — its
 * pagination bias runs the other way, so if the ordering survives here it is not
 * an artefact of one benchmark's response shapes.
 *
 * Two guards that AppWorld does not need:
 *
 * 1. **Refusals.** MCP-Bench prompts are scraped from real server descriptions and
 *    some trip the provider's refusal classifier — osint_intelligence_000 asks for
 *    typo-squat and exposed-service enumeration, refuses three times, makes zero
 *    tool calls, and used to be recorded as `completed` at $0.02. A refusal in
 *    some cells and not others biases whichever cells refused toward zero, so any
 *    task not completed in *every* cell is dropped whole.
 *
 * 2. **Live servers.** These are real APIs, so a run from three days ago is not
 *    exchangeable with one from today: payload sizes move and cost follows. Cells
 *    are therefore read from one --tag, and the span of start times is printed so
 *    a reader can see how contemporaneous the comparison actually is.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pairedTest, formatPaired, mean, sd } from "./stats.mjs";
import { selectTags } from "./select-tags.mjs";
import { loadTasks } from "./tasks.mjs";
import { makeArgv } from "./argv.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, ".run/runs");
const argv = process.argv.slice(2);
const { flag } = makeArgv(argv);
// Comma-separated: each tag is one full pass over the factorial, i.e. one
// replicate. Replicates are averaged within (task, cell) BEFORE pairing —
// treating them as independent observations is pseudo-replication and inflates n.
const TAGS = flag("tag", "x2x2").split(",").map((s) => s.trim()).filter(Boolean);
/**
 * Tags whose runs REPLACE same-cell runs from --tag rather than averaging with them.
 *
 * The two are not interchangeable and conflating them silently corrupts the result.
 * `--tag a,b` means "b is another replicate of the same configuration", so the two
 * are averaged. The budget repair is not that: it re-runs a task at a higher cost
 * cap because the original was *truncated*. Averaging a censored $1.06 with its
 * uncensored $2.30 replacement produces a number that is neither, and it would look
 * perfectly reasonable — the same shape as every other bug tonight.
 *
 * So: per (task, cell), if any override tag has a run, the base tags are ignored
 * for that cell entirely.
 */
const OVERRIDE_TAGS = flag("override-tag", "").split(",").map((s) => s.trim()).filter(Boolean);
const MODEL = flag("model", "anthropic-claude-opus-5");

/** Must match bench/quick.mjs's CELLS_2X2 and sweep's runId construction. */
const CELLS = [
	{ key: "code / docs out", row: "code", col: "out", arm: "codemode", residency: "L0", prompt: "q8" },
	{ key: "code / docs in", row: "code", col: "in", arm: "codemode", residency: "L4", prompt: "q8" },
	{ key: "tools / docs out", row: "tools", col: "out", arm: "vanilla", residency: "L1", prompt: "w3" },
	{ key: "tools / docs in", row: "tools", col: "in", arm: "vanilla", residency: "L4", prompt: "w2" },
];

const dirFor = (task, cell, tag) =>
	join(RUNS, `${task}__${cell.arm}__${cell.residency}__${cell.prompt}__${MODEL}__${tag}`);

const TASKS = loadTasks();
const TIER = new Map(TASKS.map((t) => [t.id, t.tier]));

// --- load ---------------------------------------------------------------------
const table = new Map(); // `${task}|${cell.key}` -> { cost, turns, calls, ctx0, runs[] }
const excluded = new Map(); // task -> reason
const overridden = new Set(); // tasks whose cells came from an override tag
const starts = [];
for (const cell of CELLS) {
	for (const t of TASKS.map((x) => x.id)) {
		const reps = [];
		// An override for this (task, cell) suppresses the base tags for it. Checked
		// first so a repaired cell never mixes with the censored run it replaces.
		const picked = selectTags(TAGS, OVERRIDE_TAGS, (tag) => existsSync(join(dirFor(t, cell, tag), "result.json")));
		if (picked.overridden) overridden.add(t);
		for (const tag of picked.tags) {
			const f = join(dirFor(t, cell, tag), "result.json");
			if (!existsSync(f)) continue;
			let r;
			try {
				r = JSON.parse(readFileSync(f, "utf8"));
			} catch {
				continue;
			}
			if (r.startedAt) starts.push(r.startedAt);
			if (r.summary?.residencyViolation) {
				excluded.set(t, `${cell.key}/${tag}: ${r.summary.residencyViolation}`);
				continue;
			}
			if (r.summary?.stopReason !== "completed") {
				// Recorded, not silently skipped — a cell that refuses or times out on a
				// task is information about the task, and the exclusion has to be visible.
				excluded.set(t, `${cell.key}/${tag}: ${r.summary?.stopReason ?? "no summary"}`);
				continue;
			}
			reps.push(r.summary);
		}
		if (reps.length === 0) continue;
		table.set(`${t}|${cell.key}`, {
			cost: mean(reps.map((s) => s.cost)),
			// Billed-token components, for the priced decomposition below. Cost is an
			// exact linear function of these, so residency and representation can be
			// split into a prompt term and an output term rather than modelled.
			wprompt: mean(reps.map((s) => (s.input ?? 0) + 0.1 * (s.cacheRead ?? 0) + 1.25 * (s.cacheWrite ?? 0))),
			output: mean(reps.map((s) => s.output ?? 0)),
			turns: mean(reps.map((s) => s.turns)),
			calls: mean(reps.map((s) => s.toolCalls)),
			ctx0: mean(reps.map((s) => s.firstTurnPromptTokens ?? Number.NaN)),
			replicates: reps.length,
			runs: reps,
		});
	}
}

const capped = [...excluded].filter(([, why]) => /budget/.test(why));

// Machine-readable list for the repair script, so the tasks it re-runs are derived
// from what the analysis actually excluded rather than transcribed by hand. Emitted
// before any informational output so stdout carries only the list.
if (argv.includes("--list-capped")) {
	console.log(capped.map(([t]) => t).join(","));
	process.exit(0);
}

const costOf = (row, col, t) => table.get(`${t}|${CELLS.find((c) => c.row === row && c.col === col).key}`)?.cost;
const isComplete = (t) =>
	!excluded.has(t) && CELLS.every((c) => Number.isFinite(table.get(`${t}|${c.key}`)?.cost));
const allTasks = TASKS.map((t) => t.id);
const complete = allTasks.filter(isComplete);

console.log(`tags=${TAGS.join(",")} (${TAGS.length} replicate pass${TAGS.length === 1 ? "" : "es"})  model=${MODEL}`);
if (starts.length) {
	const s = starts.slice().sort();
	console.log(`runs span ${s[0].slice(0, 16)} .. ${s[s.length - 1].slice(0, 16)} (${starts.length} runs read)`);
}
console.log(`${complete.length} tasks present and completed in all ${CELLS.length} cells`);
if (OVERRIDE_TAGS.length > 0) {
	console.log(
		`override tags ${OVERRIDE_TAGS.join(",")} REPLACED the base runs for ${overridden.size} task(s) — ` +
			`not averaged with them`,
	);
	for (const t of overridden) console.log(`   overridden: ${t}`);
}
if (excluded.size) {
	console.log(`\n${excluded.size} task(s) excluded whole (not completed in every cell):`);
	for (const [t, why] of excluded) console.log(`   ${t.padEnd(46)} ${why}`);
}

// Budget censoring is the one exclusion reason that is NOT neutral.
//
// A run stopped at --max-cost has its cost truncated at the cap, and the expensive
// cells hit the cap first. Averaging a censored run in would understate whichever
// cell was capped — so tasks capped anywhere are dropped whole, which removes that
// bias. But the tasks that hit a cap are the most expensive ones, i.e. the
// high-work tasks where the representation term is largest, so dropping them
// truncates the sample on exactly the axis under measurement. Unbiased estimate,
// narrowed range: the same trap as hillclimbing on the fast subset.
//
// AppWorld runs at --max-cost $3 for this reason; MCP-Bench has been running at $1.
const budgetCapped = capped;
if (budgetCapped.length > 0) {
	console.log(
		`\n!! ${budgetCapped.length} task(s) lost to the cost cap, not to a defect. These are the most` +
			`\n   expensive tasks, which is where the representation term is largest, so this` +
			`\n   sample is truncated on the axis being measured and the representation effect` +
			`\n   below is a LOWER BOUND. Repair by re-running these tasks in ALL FOUR cells at a` +
			`\n   higher --max-cost under a new tag, then pass it as --override-tag (NOT --tag,` +
			`\n   which would average the censored run with its replacement).` +
			`\n   Measured: repairing 11 such tasks turned an apparent collapse of the` +
			`\n   representation term into a clean monotonic trend — censoring inverted it.`,
	);
	for (const [t, why] of budgetCapped) console.log(`     ${t.padEnd(46)} ${why}`);
}

if (complete.length < 2) {
	console.log("\nToo few complete tasks to pair. No statistics reported — a mean over one task is not a measurement.");
	process.exit(0);
}

// --- per-cell table -----------------------------------------------------------
const agg = (cell, taskSet, field) =>
	mean(taskSet.map((t) => table.get(`${t}|${cell.key}`)?.[field]).filter(Number.isFinite));

console.log("");
console.table(
	CELLS.map((c) => ({
		cell: c.key,
		arm: `${c.arm}/${c.residency}`,
		prompt: c.prompt,
		tasks: complete.length,
		avgCost: +agg(c, complete, "cost").toFixed(3),
		avgTurns: +agg(c, complete, "turns").toFixed(1),
		avgCalls: +agg(c, complete, "calls").toFixed(1),
		ctx0: Math.round(agg(c, complete, "ctx0")),
	})),
);

// --- paired contrasts ---------------------------------------------------------
function pairedReport(taskSet, label) {
	if (taskSet.length < 2) {
		console.log(`\n=== ${label}: only ${taskSet.length} task(s), not reported ===`);
		return;
	}
	const contrasts = [
		["residency, code row (in - out)", (t) => costOf("code", "in", t) - costOf("code", "out", t)],
		["residency, tools row (in - out)", (t) => costOf("tools", "in", t) - costOf("tools", "out", t)],
		["representation, docs-in (tools - code)", (t) => costOf("tools", "in", t) - costOf("code", "in", t)],
		["representation, docs-out (tools - code)", (t) => costOf("tools", "out", t) - costOf("code", "out", t)],
	];
	console.log(`\n=== paired per-task cost differences — ${label} (n=${taskSet.length} tasks) ===\n`);
	for (const [name, fn] of contrasts) console.log(`  ${formatPaired(name, pairedTest(taskSet.map(fn)))}`);
	// The null control, printed every time rather than checked once. If pairing were
	// done across tasks instead of within them, identical inputs would show a spread
	// and this line would report an effect that cannot exist.
	const self = pairedTest(taskSet.map((t) => costOf("code", "out", t) - costOf("code", "out", t)));
	console.log(`  ${formatPaired("NULL CONTROL (a cell vs itself)", self)}`);
	if (self.mean !== 0 || Number.isFinite(self.t)) {
		console.log("  !! NULL CONTROL FAILED — the pairing is wrong; do not read the numbers above");
	}
	replicateNullControl(taskSet);
	console.log("\n  Believe the sign test when the two disagree: cost is right-skewed, and a");
	console.log("  t-test carried by a few heavy tasks has already been overturned this way.");
	console.log("  * p<0.05  ** p<0.01  *** p<0.001");
}

/**
 * Non-degenerate null control: r2 - r1 within one cell. Mean should be ~0, and the
 * SD is the measured noise floor.
 *
 * The reported floor is deliberately NOT the raw SD of (r2 - r1). That quantity is
 * a difference of two *single* runs, so it carries a factor of sqrt(2), and the
 * contrast it would be compared against is built from means of R replicates, which
 * carry a factor of 1/sqrt(R). Comparing the raw SD against an effect mean
 * therefore overstates the floor by sqrt(2R) — sqrt(6) at R=3 — and understates a
 * real effect by the same factor. So convert to the quantity that actually enters
 * the contrast: noise on one paired difference between two R-replicate cell means.
 */
function replicateNullControl(taskSet) {
	const rows = [];
	for (const cell of CELLS) {
		const deltas = [];
		for (const t of taskSet) {
			const e = table.get(`${t}|${cell.key}`);
			if (!e || e.replicates < 2) continue;
			// First two replicates only: fixed and symmetric. Averaging the rest in
			// would shrink the spread and understate the floor.
			deltas.push(e.runs[1].cost - e.runs[0].cost);
		}
		if (deltas.length >= 2) rows.push({ cell, result: pairedTest(deltas) });
	}
	if (rows.length === 0) {
		console.log("\n  REPLICATE NULL CONTROL: unavailable — no cell has 2+ replicates.");
		console.log("  The noise floor is therefore UNMEASURED and every effect above is provisional.");
		console.log("  Run a second pass with a new --tag and pass both, e.g. --tag x2x2,x2x2r2.");
		return;
	}
	console.log("\n  replicate null control (r2 - r1, same cell, same tasks):");
	const sigma = new Map();
	for (const { cell, result } of rows) {
		console.log(`    ${formatPaired(cell.key, result)}`);
		// SD(r2-r1) = sqrt(2)*sigma  =>  sigma = SD/sqrt(2)
		sigma.set(cell.key, result.sd / Math.SQRT2);
		const both = Number.isFinite(result.p) && result.p < 0.05 && result.sign.p < 0.05;
		if (both) {
			console.log(`    !! ${cell.key}: replicates differ on BOTH tests — not exchangeable`);
		} else if (Number.isFinite(result.p) && result.p < 0.05) {
			console.log(
				`    note: ${cell.key} t-test flags p=${result.p.toExponential(1)} but the sign test does not ` +
					`(${result.sign.wins}/${result.sign.nEffective}, p=${result.sign.p.toFixed(3)}) — heavy tail, not a shift`,
			);
		}
	}
	const R = Math.max(...[...table.values()].map((e) => e.replicates ?? 1));
	const noiseOn = (rowA, colA, rowB, colB) => {
		const a = sigma.get(CELLS.find((c) => c.row === rowA && c.col === colA)?.key);
		const b = sigma.get(CELLS.find((c) => c.row === rowB && c.col === colB)?.key);
		return Number.isFinite(a) && Number.isFinite(b) ? Math.hypot(a / Math.sqrt(R), b / Math.sqrt(R)) : Number.NaN;
	};
	const repNoise = noiseOn("tools", "out", "code", "out");
	if (Number.isFinite(repNoise)) {
		const eff = mean(taskSet.map((t) => costOf("tools", "out", t) - costOf("code", "out", t)));
		const effSd = sd(taskSet.map((t) => costOf("tools", "out", t) - costOf("code", "out", t)));
		const hetero = Math.sqrt(Math.max(0, effSd ** 2 - repNoise ** 2));
		console.log(`\n    noise on ONE paired docs-out difference (R=${R}): $${repNoise.toFixed(4)}`);
		console.log(`    representation effect $${eff.toFixed(3)} = ${(eff / repNoise).toFixed(1)}x that noise, ` +
			`${(eff / (effSd / Math.sqrt(taskSet.length))).toFixed(1)}x its own SE`);
		// Heterogeneity beyond noise says whether the effect is uniform across tasks
		// or carried by a few. Uniform + a clean sign test is the strong case.
		console.log(`    task-to-task heterogeneity beyond noise: $${hetero.toFixed(4)} ` +
			`(${hetero < repNoise ? "effect is near-uniform across tasks" : "effect genuinely varies by task"})`);
	}
}

pairedReport(complete, "all tasks");

// --- stratified by tier -------------------------------------------------------
//
// The decisive test. AppWorld's finding was that residency is flat in task size
// while representation grows with it. MCP-Bench's tiers are a work axis by
// construction — single = one server, multi3 = three — so if the same ordering
// appears here, on different servers with the opposite pagination bias, the
// decomposition is a property of the architectures rather than of AppWorld.
const strata = { single: [], multi2: [], multi3: [] };
for (const t of complete) {
	const tier = TIER.get(t);
	if (strata[tier]) strata[tier].push(t);
}
for (const [tier, set] of Object.entries(strata)) {
	if (set.length >= 2) {
		const calls = mean(set.map((t) => table.get(`${t}|${CELLS[0].key}`)?.calls).filter(Number.isFinite));
		pairedReport(set, `${tier} tier — mean ${calls.toFixed(1)} tool calls (code/docs-out)`);
	} else {
		console.log(`\n=== ${tier} tier: ${set.length} complete task(s), not reported ===`);
	}
}

// --- priced decomposition -----------------------------------------------------
//
// Cost is an identity, not a regularity: at published Opus 5 prices, weighting prompt
// tokens by kind (cache read 0.1x, cache write 1.25x),
//
//     cost = $5.00/M weighted-prompt + $25.00/M output
//
// verified to 0.000% relative residual on every completed run here and on 297
// AppWorld runs. So a contrast splits exactly into a prompt term and an output term,
// and there is no need to model it as `ctx0 x turns` — that cannot distinguish a cache
// read from a cache write, and the arms have different cache mixes.
//
// Lives here rather than in a scratch script because the doc quotes these numbers,
// and a number that cannot be re-derived from a committed tool tomorrow is a number
// nobody can check.
const PRICE_PROMPT_PER_TOKEN = 5.0 / 1e6;
const PRICE_OUTPUT_PER_TOKEN = 25.0 / 1e6;

function pricedDecomposition(taskSet, label) {
	const get = (row, col, t, field) => table.get(`${t}|${CELLS.find((c) => c.row === row && c.col === col).key}`)?.[field];
	const rows = [
		["residency, code row", ["code", "in"], ["code", "out"]],
		["residency, tools row", ["tools", "in"], ["tools", "out"]],
		["representation, docs-out", ["tools", "out"], ["code", "out"]],
		["representation, docs-in", ["tools", "in"], ["code", "in"]],
	];
	console.log(`\n=== priced decomposition — ${label} (n=${taskSet.length}) ===\n`);
	console.log("  contrast                    prompt term  output term      total   refund   turns      output");
	for (const [name, [ra, ca], [rb, cb]] of rows) {
		const usable = taskSet.filter((t) => Number.isFinite(get(ra, ca, t, "cost")) && Number.isFinite(get(rb, cb, t, "cost")));
		if (usable.length < 2) continue;
		const dW = mean(usable.map((t) => get(ra, ca, t, "wprompt") - get(rb, cb, t, "wprompt")));
		const dO = mean(usable.map((t) => get(ra, ca, t, "output") - get(rb, cb, t, "output")));
		const dC = mean(usable.map((t) => get(ra, ca, t, "cost") - get(rb, cb, t, "cost")));
		const pt = dW * PRICE_PROMPT_PER_TOKEN;
		const ot = dO * PRICE_OUTPUT_PER_TOKEN;
		// The output term is a CREDIT when resident docs remove search turns. It does
		// not track turn savings: resident docs consolidate work into fewer, longer
		// cells, and the credit is whatever survives that consolidation.
		const refund = pt > 0 ? (-ot / pt) * 100 : Number.NaN;
		// Turn and output percentage changes, so the narrative about *why* the output
		// term moves rests on the same paired task set as the term itself.
		const pct = (field) => {
			const a = mean(usable.map((t) => get(ra, ca, t, field)));
			const b = mean(usable.map((t) => get(rb, cb, t, field)));
			return b !== 0 ? `${((a / b - 1) * 100).toFixed(0)}%` : "—";
		};
		console.log(
			`  ${name.padEnd(26)} $${pt.toFixed(3).padStart(7)}   $${ot.toFixed(3).padStart(7)}   $${(pt + ot).toFixed(3).padStart(7)}` +
				`   ${(Number.isFinite(refund) ? `${refund.toFixed(0)}%` : "—").padStart(6)}` +
				`   ${pct("turns").padStart(6)}   ${pct("output").padStart(6)}`,
		);
		// Asserts the identity rather than assuming it: if the two terms do not
		// reconstruct the measured cost difference, the prices or the weights are wrong.
		if (Math.abs(pt + ot - dC) > 0.005) {
			console.log(`    !! decomposition misses measured $${dC.toFixed(3)} by $${(pt + ot - dC).toFixed(4)} — prices/weights wrong`);
		}
	}
	console.log("\n  Prompt term = $5.00/M weighted prompt tokens; output term = $25.00/M output.");
	console.log("  A negative output term is a refund: resident docs remove search turns.");
}

pricedDecomposition(complete, "all tasks");
for (const [tier, set] of Object.entries(strata)) {
	if (set.length >= 2) pricedDecomposition(set, `${tier} tier`);
}

// --- comparison with AppWorld -------------------------------------------------
console.log("\n=== does the AppWorld result reproduce? ===\n");
const res = mean([
	...complete.map((t) => costOf("code", "in", t) - costOf("code", "out", t)),
	...complete.map((t) => costOf("tools", "in", t) - costOf("tools", "out", t)),
]);
const repOut = mean(complete.map((t) => costOf("tools", "out", t) - costOf("code", "out", t)));
console.log(`  residency (both rows pooled)  MCP-Bench $${res.toFixed(3)}   AppWorld $0.51 (flat in task size)`);
console.log(`  representation (docs-out)      MCP-Bench $${repOut.toFixed(3)}   AppWorld $0.067 low / $0.766 high`);
console.log("\n  What reproduction means here is the SIGN and the ORDERING, not the magnitude:");
console.log("  different catalogues, different response sizes, different task lengths. A");
console.log("  matching sign with a different magnitude is a reproduction; a flipped sign is");
console.log("  not, and would mean the AppWorld decomposition is benchmark-specific.");
const spread = sd(complete.map((t) => costOf("code", "out", t)));
console.log(`\n  code/docs-out cost SD across tasks: $${spread.toFixed(3)} — read every effect against this.`);
