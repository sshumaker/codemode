#!/usr/bin/env node
/**
 * The 2x2: representation (code | tools) x documentation residency (in | out).
 *
 *   node bench/appworld/factorial.mjs [--tasks a,b,c] [--model anthropic/claude-opus-5]
 *
 * Why a factorial rather than a head-to-head
 * ------------------------------------------
 * Every measurement this project has taken confounds representation with
 * residency — and so does upstream's. AppWorld's function-calling agent narrows
 * 469 APIs to <=20 with an LLM pre-pass because the schemas do not fit
 * (`function_calling_agent.py:117`), and their **full-code** agent runs the same
 * pre-pass, because it interpolates `api_documentation_string` into the prompt
 * (`full_code_agent.py:119-123`). So "code beats tool-calling" and "non-resident
 * docs beat resident docs" have never been separated by anyone, including them.
 *
 *                    docs resident            docs non-resident
 *   code             codemode L4              codemode L0 (api/ on disk)
 *   tools            vanilla L4               vanilla L1 (search/describe/call)
 *
 * plus `vanilla predicted` — upstream's own baseline — which is a third point on
 * the tools row: docs resident, but only <=20 of them, at the cost of an extra LLM
 * call.
 *
 * Reports each cell, both main effects, and the interaction, on the tasks present
 * in **every** cell. Cells are means over the same tasks or they are not
 * comparable; the predictor arm cannot run on upstream's three demo tasks
 * (`82e2fac_1` among them) without ground-truth leakage, so that task drops out of
 * any comparison including it.
 *
 * TGC only for score. Cost and context are the informative axes at this sample
 * size, and neither is a score.
 */
import { existsSync, readFileSync } from "node:fs";
import { formatPaired, mean as smean, pairedTest, sd as ssd } from "../stats.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 ? argv[i + 1] : d;
};
const model = flag("model", "anthropic/claude-opus-5").replace(/[^a-z0-9]/gi, "-");
const tasks = (
	flag("tasks", "82e2fac_1,6c2c621_1,22cc237_2,4fab96f_2,57c3486_1,32616b5_3,425a494_2,b6d1104_1,c77c005_2")
).split(",");

const CELLS = [
	{ key: "code / docs out", arm: "codemode", residency: "L0", prompt: "a1", row: "code", col: "out" },
	{ key: "code / docs in", arm: "codemode", residency: "L4", prompt: "a1", row: "code", col: "in" },
	{ key: "tools / docs out", arm: "vanilla", residency: "L1", prompt: "b2", row: "tools", col: "out" },
	{ key: "tools / docs in", arm: "vanilla", residency: "L4", prompt: "b1", row: "tools", col: "in" },
	{ key: "tools / predicted", arm: "vanilla", residency: "predicted", prompt: "b3", row: "tools", col: "predicted" },
	// The mirror test. Same tree, same discovery, same kernel, same async calls as
	// `code / docs out` — but forbidden to summarise a response before printing it.
	// Measured: the tools arms already issue parallel calls (vanilla L4 averages 4.6
	// per turn, up to 11) while codemode is strictly 1.00, so round trips are not the
	// mechanism. What differs is what enters context per unit of work. This cell
	// removes only the ability to discard.
	{ key: "code / no-filter", arm: "codemode", residency: "L0", prompt: "a2", row: "code", col: "nofilter" },
];

/**
 * `--cells "code / docs out,code / docs in,tools / docs out"` — analyse a partial design.
 *
 * The full 2x2 requires four cells and every task to be present in all of them, and
 * that is the right default: a contrast read off a design that was only half run is
 * how a half-finished cell got reported as a cheap one. But a *deliberately* partial
 * design is a legitimate thing to run — the challenge-split pilot bought the two
 * contrasts CLAUDE.md calls defensible (residency on the code row, representation with
 * docs non-resident) and skipped `tools / docs in`, which neither contrast uses.
 *
 * Naming the cells makes the restriction explicit and auditable, rather than letting a
 * missing cell quietly shrink the sample. Contrasts that need an omitted cell are
 * skipped and listed as skipped, never computed from a smaller task set.
 */
const cellFilter = flag("cells", null);
if (cellFilter) {
	const wanted = new Set(cellFilter.split(",").map((s) => s.trim()));
	const unknown = [...wanted].filter((k) => !CELLS.some((c) => c.key === k));
	if (unknown.length) {
		console.error(`unknown cell key(s): ${unknown.join(", ")}\nhave: ${CELLS.map((c) => c.key).join(" | ")}`);
		process.exit(2);
	}
	for (let i = CELLS.length - 1; i >= 0; i--) if (!wanted.has(CELLS[i].key)) CELLS.splice(i, 1);
}

/**
 * Every replicate of one (task, cell), averaged.
 *
 * `sweep.mjs --repeat N` writes `<base>__r1 … __rN`; a single run writes `<base>`.
 * Both are collected, so a cell run once and a cell run three times are read the
 * same way and `replicates` records which is which. Variance across replicates is
 * the point — see `varianceReport` — so the raw list is kept, not just the mean.
 */
function read(task, cell) {
	const base = `${task}__${cell.arm}__${cell.residency}__${cell.prompt}__${model}`;
	const paths = [join(ROOT, ".run/appworld", base, "result.json")];
	for (let r = 1; r <= 8; r++) paths.push(join(ROOT, ".run/appworld", `${base}__r${r}`, "result.json"));
	const runs = [];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			runs.push(JSON.parse(readFileSync(path, "utf8")).summary);
		} catch {
			// A truncated result.json is a missing run, not a zero.
		}
	}
	if (runs.length === 0) return null;
	const avg = (field) => runs.reduce((n, s) => n + (Number(s[field]) || 0), 0) / runs.length;
	return {
		...runs[0],
		replicates: runs.length,
		runs,
		cost: avg("cost"),
		turns: avg("turns"),
		toolCalls: avg("toolCalls"),
		apiCalls: avg("apiCalls"),
		output: avg("output"),
		firstTurnPromptTokens: avg("firstTurnPromptTokens"),
		wallMs: avg("wallMs"),
		input: avg("input"),
		cacheRead: avg("cacheRead"),
		cacheWrite: avg("cacheWrite"),
		// TGC over replicates is a rate, not a boolean; `success` stays the first run's
		// verdict for the pass/fail column and `successRate` carries the rest.
		successRate: runs.filter((s) => s.success === true).length / runs.length,
		// A run stopped at --max-cost has its cost TRUNCATED at the cap, so this cell's
		// cost for this task is a lower bound and any contrast using it is biased toward
		// zero. Not dropped: the same task is uncensored in the other cells, and dropping
		// it whole would remove it from clean contrasts too. Flagged instead, per
		// contrast, so no reader can average a censored value in without being told.
		capped: runs.filter((s) => s.stopReason === "budget").length,
	};
}

/**
 * Run-to-run variance, reported as its own finding.
 *
 * Everything else in this file is a point estimate from one run per cell, and this
 * project has already been burned once by an effect the size of its own measurement
 * noise (single-sample LLM judging on MCP-Bench). The low-stratum representation
 * difference is $0.070; whether that is "essentially zero" or "a small real effect"
 * is a question about this number.
 */
/**
 * Paired per-task differences — the statistic the claims are actually about.
 *
 * Per-cell variation on this benchmark is dominated by task size (a 7-call task and
 * a 191-call task differ by more than any treatment effect), and that spread cancels
 * exactly in a within-task difference. A per-cell CV therefore cannot say whether a
 * $0.070 saving is real; the SD of the per-task difference can.
 *
 * Both tests are printed. Cost differences are right-skewed and heavy-tailed, which
 * the t-test's normality assumption does not love at n=10, so the near-assumption-free
 * sign test is reported alongside. If they disagree, believe the sign test.
 */
function pairedReport(taskSet, label) {
	const cell = (row, col) => CELLS.find((c) => c.row === row && c.col === col);
	const costOf = (row, col, t) => table.get(`${t}|${cell(row, col)?.key}`)?.cost;
	// Which of the four factorial corners this run actually has. Under `--cells` some
	// are absent by design; without it, an absent corner still means a half-run design.
	const have = (row, col) => Boolean(cell(row, col));
	const corners = [
		["code", "out"],
		["code", "in"],
		["tools", "out"],
		["tools", "in"],
	].filter(([r, c]) => have(r, c));
	if (!have("code", "out")) return; // every contrast and the null control reference it
	const usable = taskSet.filter((t) => corners.every(([r, c]) => Number.isFinite(costOf(r, c, t))));
	if (usable.length < 2) return;

	const censored = (row, col) => usable.some((t) => table.get(`${t}|${cell(row, col).key}`)?.capped);
	const mark = (...pairs) => (pairs.some(([r, c]) => censored(r, c)) ? "  [CENSORED: lower bound]" : "");
	const allContrasts = [
		[["code", "in"], ["code", "out"], "residency, code row (in - out)"],
		[["tools", "in"], ["tools", "out"], "residency, tools row (in - out)"],
		[["tools", "in"], ["code", "in"], "representation, docs-in (tools - code)"],
		[["tools", "out"], ["code", "out"], "representation, docs-out (tools - code)"],
	];
	const contrasts = allContrasts
		.filter(([a, b]) => have(...a) && have(...b))
		.map(([a, b, name]) => [`${name}${mark(a, b)}`, (t) => costOf(...a, t) - costOf(...b, t)]);
	const skipped = allContrasts.filter(([a, b]) => !have(...a) || !have(...b)).map(([, , name]) => name);

	console.log(`\n=== paired per-task cost differences — ${label} (n=${usable.length} tasks) ===\n`);
	for (const [name, fn] of contrasts) {
		console.log(`  ${formatPaired(name, pairedTest(usable.map(fn)))}`);
	}
	for (const name of skipped) console.log(`  ${name}: SKIPPED — a cell it needs was not run`);
	// A null control on every report, not a one-off check.
	//
	// One cell compared with itself must produce exactly zero with no significance.
	// If pairing were implemented across tasks rather than within them, identical
	// inputs would still show a spread and the line below would report an effect that
	// cannot exist. Printing it every time means the reader can see the analysis is
	// sound on the same page as the numbers it produced.
	const selfControl = pairedTest(usable.map((t) => costOf("code", "out", t) - costOf("code", "out", t)));
	console.log(`  ${formatPaired("NULL CONTROL (a cell vs itself)", selfControl)}`);
	if (selfControl.mean !== 0 || Number.isFinite(selfControl.t)) {
		console.log("  !! NULL CONTROL FAILED — the pairing is wrong; do not read the numbers above");
	}
	replicateNullControl(usable, CELLS.filter((c) => c.col === "in" || c.col === "out"));
	console.log("\n  Read the SD, not just the mean: a difference smaller than its own SD is not");
	console.log("  distinguishable from noise at this n. * p<0.05  ** p<0.01  *** p<0.001");
}

/**
 * The non-degenerate null control: replicate r1 against r2 of the SAME cell.
 *
 * The self-comparison control above is degenerate by construction — identical inputs,
 * $0.000 ± 0.000. It catches pairing that crosses tasks, which is worth having, and it
 * cannot say anything about magnitude.
 *
 * This one can. Same configuration, same tasks, different runs: the mean should be
 * ~0, and **the SD is the noise floor, measured rather than assumed**, in dollars, on
 * the same axis as the effects it has to be compared against.
 *
 * It is the test the small-effect claim rests on. The low-stratum representation
 * saving is $0.067. If replicate-vs-replicate on the same cell has an SD near $0.03,
 * that claim is comfortable. If the SD is near $0.07, it is not — whatever the
 * t-statistic says — because then the paired test would be resolving a difference the
 * size of the run-to-run spread, and what looks like an effect could be replicate
 * noise that happens to correlate within a task.
 */
function replicateNullControl(taskSet, cells) {
	const rows = [];
	for (const cell of cells) {
		const deltas = [];
		for (const t of taskSet) {
			const entry = table.get(`${t}|${cell.key}`);
			if (!entry || entry.replicates < 2) continue;
			// First two replicates only: a fixed, symmetric comparison. Averaging the
			// rest in would shrink the spread and understate the floor.
			deltas.push((Number(entry.runs[1].cost) || 0) - (Number(entry.runs[0].cost) || 0));
		}
		if (deltas.length >= 2) rows.push({ cell: cell.key, result: pairedTest(deltas) });
	}
	if (rows.length === 0) {
		console.log("\n  REPLICATE NULL CONTROL: not available — no cell has 2+ replicates yet.");
		console.log("  Until it is, the noise floor is unmeasured and every effect below is provisional.");
		return;
	}
	console.log("\n=== replicate null control (r2 - r1, same cell, same tasks) ===\n");
	for (const { cell, result } of rows) {
		console.log(`  ${formatPaired(cell, result)}`);
	}
	// Pooled within-task sigma, computed from the replicates directly.
	//
	// The r2-r1 spread is NOT the noise that enters a contrast, and comparing an
	// effect against it double-counts twice over:
	//
	//   1. Var(r2 - r1) = 2*sigma^2, so that spread is sqrt(2) larger than single-run
	//      noise.
	//   2. Replicates are averaged before pairing, so the noise on a cell *mean* is
	//      sigma/sqrt(k), not sigma.
	//
	// Together the r2-r1 figure overstates the relevant noise by sqrt(2k) — sqrt(6) at
	// k=3 — which turned a 4.5x margin into a reported "about 2x". Backing sigma out of
	// the difference would work; computing it directly from all k replicates is better,
	// uses every observation (df = k-1 per task, pooled), and needs no correction
	// factor to get wrong.
	//
	// Caveat in the honest direction: pooling assumes sigma is comparable across tasks.
	// It is not — a 191-call task has more absolute spread than a 7-call one — so the
	// pooled figure overstates sigma for small tasks and the resulting margin is
	// conservative.
	const sigmaOf = (key) => {
		let ss = 0;
		let df = 0;
		for (const t of taskSet) {
			const entry = table.get(`${t}|${key}`);
			if (!entry || entry.replicates < 2) continue;
			const costs = entry.runs.map((r) => Number(r.cost) || 0);
			const m = mean(costs);
			ss += costs.reduce((n, c) => n + (c - m) ** 2, 0);
			df += costs.length - 1;
		}
		return df > 0 ? { sigma: Math.sqrt(ss / df), df } : null;
	};
	const replicatesOf = (key) => {
		const counts = taskSet.map((t) => table.get(`${t}|${key}`)?.replicates ?? 0).filter((n) => n > 0);
		return counts.length ? Math.min(...counts) : 0;
	};
	// Both quantities, each labelled, because they differ by sqrt(2R) and confusing them
	// has now cost three rounds of arithmetic:
	//
	//   SD(r2-r1)  spread of a difference of two SINGLE runs = sqrt(2)*sigma
	//   sigma      per-run noise
	//   sigma/sqrt(R)  noise on the R-replicate MEAN that actually enters a contrast
	//
	// A reader who compares an effect against the first column is comparing a mean
	// against a single-observation spread and will understate the margin by sqrt(2R).
	console.log("\n  per-cell noise, three ways (they differ by sqrt(2R); use the last for contrasts):");
	console.log(
		`    ${"cell".padEnd(20)}${"SD(r2-r1)".padStart(11)}${"sigma".padStart(10)}${"sigma/sqrt(R)".padStart(15)}`,
	);
	for (const cell of cells) {
		const est = sigmaOf(cell.key);
		if (!est) continue;
		const k = Math.max(1, replicatesOf(cell.key));
		const entry = rows.find((r) => r.cell === cell.key);
		const diffSd = entry ? entry.result.sd : Number.NaN;
		console.log(
			`    ${cell.key.padEnd(20)}${(Number.isFinite(diffSd) ? `$${diffSd.toFixed(4)}` : "—").padStart(11)}` +
				`${`$${est.sigma.toFixed(4)}`.padStart(10)}${`$${(est.sigma / Math.sqrt(k)).toFixed(4)}`.padStart(15)}` +
				`   (df=${est.df}, R=${k})`,
		);
	}
	console.log("    NB sigma is pooled from all R replicates directly, not backed out of r2-r1.");

	// Per-contrast floors, not a global maximum.
	//
	// The first version printed `max(sd)` across all cells as "the noise floor", and
	// that max came from `tools/docs-in` — the cell excluded from every conclusion as
	// confounded, and unsurprisingly also the least stable ($0.29-0.32 replicate SD
	// against $0.01-0.03 for the others). Comparing a clean contrast against the noise
	// of a cell it does not involve is not a comparison; it understates confidence
	// here, and in another configuration would overstate it.
	const sdOf = (key) => rows.find((r) => r.cell === key)?.result.sd;
	const floorFor = (a, b) => {
		const values = [sdOf(a), sdOf(b)].filter(Number.isFinite);
		return values.length ? Math.max(...values) : Number.NaN;
	};
	/** Noise on ONE paired difference of k-replicate means: sqrt(s1^2/k + s2^2/k). */
	const noiseOnDifference = (a, b) => {
		const ea = sigmaOf(a);
		const eb = sigmaOf(b);
		if (!ea || !eb) return Number.NaN;
		const k = Math.max(1, Math.min(replicatesOf(a), replicatesOf(b)));
		return Math.sqrt(ea.sigma ** 2 / k + eb.sigma ** 2 / k);
	};
	const contrasts = [
		["residency, code row", "code / docs in", "code / docs out"],
		["residency, tools row", "tools / docs in", "tools / docs out"],
		["representation, docs-in", "tools / docs in", "code / docs in"],
		["representation, docs-out", "tools / docs out", "code / docs out"],
	];
	console.log("\n  noise on one paired difference = sqrt(sigmaA^2/R + sigmaB^2/R) — BOTH cells;");
	console.log("  dividing one cell's SD(r2-r1) by sqrt(2R) gives only that cell's term and");
	console.log("  understates the noise, hence overstates the ratio:");
	for (const [name, a, b] of contrasts) {
		const noise = noiseOnDifference(a, b);
		const effect = mean(
			taskSet
				.map((t) => {
					const x = table.get(`${t}|${a}`)?.cost;
					const y = table.get(`${t}|${b}`)?.cost;
					return Number.isFinite(x) && Number.isFinite(y) ? x - y : Number.NaN;
				})
				.filter(Number.isFinite),
		);
		if (!Number.isFinite(noise)) {
			console.log(`    ${name.padEnd(26)} —`);
			continue;
		}
		// Residual task-to-task heterogeneity: how much of the paired SD is real
		// variation in the effect rather than measurement noise. Large residual means
		// the effect is present in most tasks at differing size; residual near zero
		// would mean the spread was all noise.
		const deltas = taskSet
			.map((t) => {
				const x = table.get(`${t}|${a}`)?.cost;
				const y = table.get(`${t}|${b}`)?.cost;
				return Number.isFinite(x) && Number.isFinite(y) ? x - y : Number.NaN;
			})
			.filter(Number.isFinite);
		const spread = ssd(deltas);
		const residual = Math.sqrt(Math.max(0, spread ** 2 - noise ** 2));
		console.log(
			`    ${name.padEnd(26)} noise $${noise.toFixed(4)}  effect/noise ${(Math.abs(effect) / noise).toFixed(1)}x` +
				`  residual heterogeneity $${residual.toFixed(4)}`,
		);
	}
	console.log("  NB: 'effect / its own standard error' is the t-statistic already printed above —");
	console.log("  quoting both as separate evidence would be double-counting. This column is the");
	console.log("  independent one: the effect against measured run-to-run noise.");
	console.log("  Mean of r2-r1 should be ~0; a significant mean on BOTH tests would mean the");
	console.log("  replicates are not exchangeable.");
	for (const { cell, result } of rows) {
		// BOTH tests, deliberately. Firing on the t-test alone would contradict the rule
		// stated in bench/stats.mjs — believe the sign test when they disagree — and it
		// did exactly that on first run: `code / docs in` came back t=2.30 p=0.033 with a
		// sign test of 10/20, p=1.000, i.e. a perfectly even split whose mean was carried
		// by a few heavy-tailed tasks. A warning that contradicts its own module's rule
		// is worse than no warning, because it gets believed.
		const bothAgree = Number.isFinite(result.p) && result.p < 0.05 && result.sign.p < 0.05;
		if (bothAgree) {
			console.log(`  !! ${cell}: replicates differ on BOTH tests (t p=${result.p.toExponential(1)}, sign p=${result.sign.p.toFixed(3)}) — not exchangeable`);
		} else if (Number.isFinite(result.p) && result.p < 0.05) {
			console.log(
				`  note: ${cell} t-test flags p=${result.p.toExponential(1)} but the sign test does not ` +
					`(${result.sign.wins}/${result.sign.nEffective}, p=${result.sign.p.toFixed(3)}) — heavy tail, not a shift`,
			);
		}
	}
}

function varianceReport(taskSet, cells) {
	const rows = [];
	for (const cell of cells) {
		const cvs = [];
		let flips = 0;
		let repeated = 0;
		for (const t of taskSet) {
			const entry = table.get(`${t}|${cell.key}`);
			if (!entry || entry.replicates < 2) continue;
			repeated++;
			const costs = entry.runs.map((r) => Number(r.cost) || 0);
			const m = mean(costs);
			const sd = Math.sqrt(mean(costs.map((c) => (c - m) ** 2)) * (costs.length / (costs.length - 1)));
			if (m > 0) cvs.push(sd / m);
			const verdicts = new Set(entry.runs.map((r) => r.success === true));
			if (verdicts.size > 1) flips++;
		}
		if (repeated > 0) rows.push({ cell: cell.key, repeated, cv: mean(cvs), flips });
	}
	if (rows.length === 0) {
		console.log("\n=== run-to-run variance ===\n\n  no cell has been run more than once; every number above is a point estimate");
		return;
	}
	console.log("\n=== run-to-run variance (cost CV across replicates, per task, then averaged) ===\n");
	console.log(`${"cell".padEnd(20)}${"tasks".padStart(7)}${"cost CV".padStart(10)}${"TGC flips".padStart(11)}`);
	for (const r of rows) {
		console.log(`${r.cell.padEnd(20)}${String(r.repeated).padStart(7)}${`${(r.cv * 100).toFixed(1)}%`.padStart(10)}${String(r.flips).padStart(11)}`);
	}
	const overall = mean(rows.map((r) => r.cv));
	console.log(`\n  overall cost CV: ${(overall * 100).toFixed(1)}%`);
	console.log("  TGC flips = tasks where replicates of the SAME configuration disagreed on pass/fail.");
	console.log("  Any difference smaller than roughly this CV is not distinguishable from noise.");
}

const table = new Map();
for (const cell of CELLS) for (const task of tasks) table.set(`${task}|${cell.key}`, read(task, cell));

// The 2x2 proper is the four factorial cells only.
//
// Filtered by inclusion, not exclusion: an earlier version said `col !== "predicted"`,
// so adding the no-filter cell silently pulled it into `core` and the 2x2 collapsed to
// n=1 while that cell was still running. Extra conditions must not be able to shrink
// the design they are compared against.
const core = CELLS.filter((c) => c.col === "in" || c.col === "out");
const complete = tasks.filter((t) => core.every((c) => table.get(`${t}|${c.key}`)));
const completeAll = tasks.filter((t) => CELLS.every((c) => table.get(`${t}|${c.key}`)));

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
/** Tasks in `taskSet` for which this cell actually has a result. */
const present = (cell, taskSet) => taskSet.filter((t) => table.get(`${t}|${cell.key}`));
/**
 * Mean over the tasks this cell actually ran.
 *
 * An earlier version substituted 0 for a missing task and divided by the full set,
 * which silently reported a half-finished cell as a cheap one — the running
 * no-filter cell showed "1/10, 0.7 turns, $0.0192" as though it had solved the
 * stratum for two cents. Missing is not zero; it is missing, and the per-cell n is
 * printed so a partial cell is visibly partial.
 */
const agg = (cell, taskSet, field) => mean(present(cell, taskSet).map((t) => table.get(`${t}|${cell.key}`)[field] ?? 0));
/**
 * Prompt tokens the *conversation* accumulated, on top of the fixed resident
 * catalogue.
 *
 * `total prompt tokens - ctx0 x turns`. Approximate — modelling the fixed cost as
 * ctx0 per turn is rough once caching is involved — so it is reported alongside
 * `out`, which is exact, rather than instead of it. It is here because this is the
 * quantity the no-filter cell is designed to move.
 */
function accum(cell, taskSet) {
	return mean(
		taskSet.map((t) => {
			const s = table.get(`${t}|${cell.key}`);
			if (!s) return 0;
			const total = (s.input ?? 0) + (s.cacheRead ?? 0) + (s.cacheWrite ?? 0);
			return total - (s.firstTurnPromptTokens ?? 0) * (s.turns ?? 0);
		}),
	);
}
const tgc = (cell, taskSet) => present(cell, taskSet).filter((t) => table.get(`${t}|${cell.key}`).success === true).length;

function report(taskSet, cells, label) {
	console.log(`\n=== ${label} (n=${taskSet.length}: ${taskSet.join(",")}) ===\n`);
	const pad = (s, n) => String(s).padEnd(n);
	const partial = [];
	console.log(`${pad("cell", 20)}${"n".padStart(4)}${"TGC".padStart(6)}${"turns".padStart(8)}${"actions".padStart(9)}${"api".padStart(7)}${"ctx0".padStart(9)}${"out".padStart(8)}${"ctxAccum".padStart(10)}${"cost".padStart(9)}${"secs".padStart(7)}`);
	for (const cell of cells) {
		const have = present(cell, taskSet);
		if (have.length === 0) {
			console.log(`${pad(cell.key, 20)}  NOT RUN`);
			continue;
		}
		if (have.length < taskSet.length) partial.push(`${cell.key} (${have.length}/${taskSet.length})`);
		console.log(
			`${pad(cell.key, 20)}${String(present(cell, taskSet).length).padStart(4)}` +
				`${`${tgc(cell, taskSet)}/${present(cell, taskSet).length}`.padStart(6)}` +
				`${agg(cell, taskSet, "turns").toFixed(1).padStart(8)}` +
				`${agg(cell, taskSet, "toolCalls").toFixed(1).padStart(9)}` +
				`${agg(cell, taskSet, "apiCalls").toFixed(1).padStart(7)}` +
				`${agg(cell, taskSet, "firstTurnPromptTokens").toFixed(0).padStart(9)}` +
				`${agg(cell, taskSet, "output").toFixed(0).padStart(8)}` +
				`${accum(cell, taskSet).toFixed(0).padStart(10)}` +
				`${agg(cell, taskSet, "cost").toFixed(4).padStart(9)}` +
				`${(agg(cell, taskSet, "wallMs") / 1000).toFixed(0).padStart(7)}`,
		);
	}
	if (partial.length > 0) {
		console.log(`\n  !! incomplete cells, means are over fewer tasks and NOT comparable: ${partial.join(", ")}`);
	}
}

// --- cost censoring ----------------------------------------------------------
const cappedCells = [];
for (const cell of CELLS) {
	for (const t of tasks) {
		const entry = table.get(`${t}|${cell.key}`);
		if (entry?.capped) cappedCells.push({ task: t, cell: cell.key, of: entry.replicates, n: entry.capped, cost: entry.cost });
	}
}
if (cappedCells.length > 0) {
	console.log("\n!! COST-CENSORED CELLS — these costs are LOWER BOUNDS, not measurements:\n");
	for (const c of cappedCells) {
		console.log(`   ${c.task.padEnd(12)} ${c.cell.padEnd(18)} ${c.n}/${c.of} replicates hit --max-cost  (mean $${c.cost.toFixed(3)})`);
	}
	const affected = new Set(cappedCells.map((c) => c.cell));
	console.log(`\n   Any contrast involving ${[...affected].join(", ")} is biased TOWARD ZERO by this.`);
	console.log("   Contrasts not involving those cells are unaffected. Raising the cap and re-running");
	console.log("   ALL cells under a new tag is the fix — raising it only for the expensive cell would");
	console.log("   make the treatment asymmetric.");
}

report(complete, core, "the 2x2");

if (complete.length > 0) {
	const cell = (row, col) => CELLS.find((c) => c.row === row && c.col === col);
	// Under `--cells` a corner can be absent by design; every line below is printed
	// only when both of its corners ran. Substituting a mean over a different task set
	// for a missing cell is the failure this file already carries two comments about.
	const has = (row, col) => Boolean(cell(row, col));
	const cost = (row, col) => agg(cell(row, col), complete, "cost");
	const ctx = (row, col) => agg(cell(row, col), complete, "firstTurnPromptTokens");
	console.log("\n--- cost, and what each factor buys on its own ---");
	if (has("code", "in") && has("tools", "in"))
		console.log(`  within docs-resident : code $${cost("code", "in").toFixed(3)} vs tools $${cost("tools", "in").toFixed(3)}  -> representation ${(cost("tools", "in") / cost("code", "in")).toFixed(1)}x`);
	if (has("code", "out") && has("tools", "out"))
		console.log(`  within docs-out      : code $${cost("code", "out").toFixed(3)} vs tools $${cost("tools", "out").toFixed(3)}  -> representation ${(cost("tools", "out") / cost("code", "out")).toFixed(1)}x`);
	if (has("code", "in") && has("code", "out"))
		console.log(`  within code          : in $${cost("code", "in").toFixed(3)} vs out $${cost("code", "out").toFixed(3)}  -> residency ${(cost("code", "in") / cost("code", "out")).toFixed(1)}x`);
	if (has("tools", "in") && has("tools", "out"))
		console.log(`  within tools         : in $${cost("tools", "in").toFixed(3)} vs out $${cost("tools", "out").toFixed(3)}  -> residency ${(cost("tools", "in") / cost("tools", "out")).toFixed(1)}x`);
	// A positive interaction here means the two factors are not additive: neither
	// alone gets you the win, which is a different claim from either headline.
	if (["code", "tools"].every((r) => ["in", "out"].every((c) => has(r, c)))) {
		const interaction =
			cost("tools", "in") - cost("tools", "out") - (cost("code", "in") - cost("code", "out"));
		console.log(`  interaction (log-scale ratio of ratios): ${((cost("tools", "in") / cost("tools", "out")) / (cost("code", "in") / cost("code", "out"))).toFixed(2)}`);
		console.log(`  interaction (linear $): ${interaction >= 0 ? "+" : ""}${interaction.toFixed(3)}`);
	} else {
		console.log("  interaction: SKIPPED — needs all four corners");
	}
	console.log("\n--- first-turn prompt tokens ---");
	for (const row of ["code", "tools"]) {
		const cells = ["in", "out"].filter((c) => has(row, c));
		if (!cells.length) continue;
		console.log(`  ${row.padEnd(6)}${cells.map((c) => ` docs-${c} ${ctx(row, c).toFixed(0).padStart(7)}`).join("  ")}`);
	}
	console.log(
		"\nTGC is identical across cells at this sample size — read cost and context, " +
			"not score, and do not rank the arms from this.",
	);
}

report(completeAll, CELLS, "including upstream's predictor baseline");
pairedReport(complete, "all tasks");
varianceReport(complete, core);

// Stratified view: the decisive test of which term is which.
//
// If the representation term is composition, the tools/code ratio should stay small
// where tasks need few calls and grow where they need many. If residency is doing
// more work than the decomposition suggests, the ratio persists in the low stratum
// too — which would be the finding to escalate.
const STRATA_CACHE = join(ROOT, "bench/data/appworld-gt-calls.json");
if (existsSync(STRATA_CACHE)) {
	const gt = new Map(JSON.parse(readFileSync(STRATA_CACHE, "utf8")).filter((r) => !r.error).map((r) => [r.task, r.nCalls]));
	const strata = {
		low: tasks.filter((t) => (gt.get(t) ?? Infinity) <= 20),
		high: tasks.filter((t) => (gt.get(t) ?? -1) >= 60),
	};
	for (const [label, set] of Object.entries(strata)) {
		const usable = set.filter((t) => core.every((c) => table.get(`${t}|${c.key}`)));
		if (usable.length === 0) continue;
		const gtMean = usable.reduce((n, t) => n + gt.get(t), 0) / usable.length;
		report(usable, CELLS, `${label} stratum — mean ${gtMean.toFixed(1)} ground-truth calls`);
		const c = (row, col) => agg(CELLS.find((x) => x.row === row && x.col === col), usable, "cost");
		console.log(`\n  tools/code cost ratio, docs-out: ${(c("tools", "out") / c("code", "out")).toFixed(1)}x`);
		console.log(`  tools/code cost ratio, docs-in : ${(c("tools", "in") / c("code", "in")).toFixed(1)}x`);
		console.log(`  residency saving, tools row: $${(c("tools", "in") - c("tools", "out")).toFixed(3)}   code row: $${(c("code", "in") - c("code", "out")).toFixed(3)}`);
		console.log(`  representation saving, docs-in: $${(c("tools", "in") - c("code", "in")).toFixed(3)}   docs-out: $${(c("tools", "out") - c("code", "out")).toFixed(3)}`);
		pairedReport(usable, `${label} stratum`);
		varianceReport(usable, core);
	}
}
if (completeAll.length < tasks.length) {
	// Two different reasons a task is absent, and conflating them would misread as
	// "19 tasks were excluded for leakage" when almost all of them were simply not
	// run in that cell yet.
	const PREDICTOR_DEMOS = new Set(["82e2fac_1", "29caf6f_1", "d0b1f43_1"]);
	const dropped = tasks.filter((t) => !completeAll.includes(t));
	const leaked = dropped.filter((t) => PREDICTOR_DEMOS.has(t));
	const notRun = dropped.filter((t) => !PREDICTOR_DEMOS.has(t));
	if (leaked.length > 0) {
		console.log(`\nexcluded for leakage: ${leaked.join(",")}`);
		console.log("  (upstream's APIPredictor few-shots on these, with their ground-truth");
		console.log("   required_apis in the prompt, so predicting for them leaks)");
	}
	if (notRun.length > 0) {
		console.log(`\nnot yet run in every cell (${notRun.length}): ${notRun.join(",")}`);
	}
}
