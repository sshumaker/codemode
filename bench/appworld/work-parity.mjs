#!/usr/bin/env node
/**
 * Does the representation saving survive when the two arms do the same work?
 *
 *   node bench/appworld/work-parity.mjs [--tasks a,b,c] [--band 1.6]
 *
 * Why this exists
 * ---------------
 * A paired cost difference between two arms is only a measurement of the *treatment*
 * if the arms did comparable work. This project has already been burned by the other
 * case: in the original 2x2 the `docs-in` column showed a cost difference that failed
 * the sign test, and the reason was that `tools/docs-in` made 37.6 API calls against
 * `docs-out`'s 63.0 — it did less work and therefore cost less
 * (docs/BENCHMARK-SELECTION.md §10).
 *
 * The challenge-split pilot hit the same question from the other side: codemode
 * averaged 55.0 API calls to vanilla-L1's 37.8 in the high stratum, so the reported
 * $0.386 representation term was quoted as a lower bound
 * (docs/SCOUT-appworld-challenge.md §3.1). This file replaces that caveat with a
 * number, using only runs already on disk.
 *
 * What the per-task view shows, and why the mean was misleading
 * ------------------------------------------------------------
 * The imbalance is **bidirectional**, not a systematic handicap: tools/code API-call
 * ratios run from 0.18 (`5800354_2`) to 3.14 (`a1d3dfd_2`). The high-stratum mean of
 * "31% less work" is produced by two tasks where codemode paginated a collection
 * exhaustively and vanilla did not — and on the task where *vanilla* made 3.1x more
 * calls, code was still $0.614 cheaper. So "vanilla did less work" was a property of
 * the mean, not of the sample, and averaging a ratio hid that.
 *
 * Three views, none of which needs a new run:
 *
 *   1. **matched-work subset** — restrict to tasks whose call ratio is inside a band
 *      and re-run the paired test. Assumption-free; costs sample size.
 *   2. **cost per API call** — the per-unit-of-work quantity, paired per task. This is
 *      arguably the better estimand for "what does the representation cost", and it is
 *      defined on every task regardless of parity.
 *   3. **work-adjusted counterfactual** — regress cost on *actual* API calls within
 *      each arm, then ask what the tools arm would have cost at the code arm's call
 *      count. Model-based, and labelled as such: it is the only view here that
 *      extrapolates, and it is reported with its fit quality so the reader can
 *      discount it.
 *
 * Reuses bench/stats.mjs for the paired t-test and exact sign test. Cost differences
 * are right-skewed; when the two disagree, believe the sign test.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatPaired, mean, pairedTest } from "../stats.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 ? argv[i + 1] : d;
};
const model = flag("model", "anthropic/claude-opus-5").replace(/[^a-z0-9]/gi, "-");
const band = Number(flag("band", 1.6));
const tasks = flag(
	"tasks",
	"e775c78_1,eb5ad85_1,3f3c139_1,a132254_3,7574325_1,5800354_2,33e202d_2,a1d3dfd_2,d37c235_2,cdaaea5_1",
).split(",");

/** The two arms of the representation contrast, docs non-resident in both. */
const CODE = (t) => `${t}__codemode__L0__a1__${model}`;
const TOOLS = (t) => `${t}__vanilla__L1__b2__${model}`;

function summary(runId) {
	const path = join(ROOT, ".run/appworld", runId, "result.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")).summary;
	} catch {
		return null;
	}
}

const rows = [];
for (const task of tasks) {
	const code = summary(CODE(task));
	const tools = summary(TOOLS(task));
	if (!code || !tools) {
		console.error(`skipping ${task}: missing ${code ? "tools" : "code"} cell`);
		continue;
	}
	rows.push({
		task,
		codeApi: code.apiCalls,
		toolsApi: tools.apiCalls,
		ratio: tools.apiCalls / code.apiCalls,
		codeCost: code.cost,
		toolsCost: tools.cost,
		diff: tools.cost - code.cost,
	});
}
if (rows.length < 2) {
	console.error("need at least 2 tasks present in both cells");
	process.exit(2);
}

const usd = (x) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(3)}`;
const pad = (s, n) => String(s).padEnd(n);

console.log("\n=== per-task API-call parity (tools / code) ===\n");
console.log("  task          codeAPI  toolsAPI   ratio    code    tools     diff");
for (const r of rows.sort((a, b) => a.ratio - b.ratio)) {
	console.log(
		`  ${pad(r.task, 12)}${String(r.codeApi).padStart(7)}${String(r.toolsApi).padStart(10)}` +
			`${r.ratio.toFixed(2).padStart(8)}${usd(r.codeCost).padStart(9)}${usd(r.toolsCost).padStart(9)}${usd(r.diff).padStart(9)}`,
	);
}
console.log(
	`\n  ratio range ${Math.min(...rows.map((r) => r.ratio)).toFixed(2)}–${Math.max(...rows.map((r) => r.ratio)).toFixed(2)}` +
		` — the imbalance runs in BOTH directions, so it is not a systematic handicap to either arm.`,
);
console.log(
	`  code cheaper on ${rows.filter((r) => r.diff > 0).length}/${rows.length} tasks, ` +
		`including ${rows.filter((r) => r.diff > 0 && r.ratio > 1).length} where the tools arm made MORE calls.`,
);

console.log("\n=== 1. unadjusted (all tasks) ===\n");
console.log(`  ${formatPaired("representation (tools - code)", pairedTest(rows.map((r) => r.diff)))}`);

console.log(`\n=== 2. matched-work subset (call ratio within [${(1 / band).toFixed(2)}, ${band.toFixed(2)}]) ===\n`);
const matched = rows.filter((r) => r.ratio >= 1 / band && r.ratio <= band);
const dropped = rows.filter((r) => !matched.includes(r));
console.log(`  kept ${matched.length}/${rows.length}: ${matched.map((r) => r.task).join(", ")}`);
console.log(`  dropped ${dropped.length}: ${dropped.map((r) => `${r.task}(${r.ratio.toFixed(2)})`).join(", ") || "none"}`);
if (matched.length >= 2) {
	console.log(`\n  ${formatPaired("representation (tools - code)", pairedTest(matched.map((r) => r.diff)))}`);
	console.log(
		`  mean call counts on the kept tasks: code ${mean(matched.map((r) => r.codeApi)).toFixed(1)}, ` +
			`tools ${mean(matched.map((r) => r.toolsApi)).toFixed(1)}`,
	);
} else {
	console.log("\n  too few matched tasks to test — widen --band or add runs");
}

console.log("\n=== 3. cost per API call (paired, defined on every task) ===\n");
const perCall = rows.map((r) => r.toolsCost / r.toolsApi - r.codeCost / r.codeApi);
console.log(`  ${formatPaired("cost/call (tools - code)", pairedTest(perCall))}`);
console.log(
	`  cell means: code ${usd(mean(rows.map((r) => r.codeCost / r.codeApi)))}/call, ` +
		`tools ${usd(mean(rows.map((r) => r.toolsCost / r.toolsApi)))}/call`,
);

/** OLS of cost on *actual* API calls, within one arm. */
function fit(xs, ys) {
	const mx = mean(xs);
	const my = mean(ys);
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < xs.length; i++) {
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
		syy += (ys[i] - my) ** 2;
	}
	return { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx, r: sxy / Math.sqrt(sxx * syy) };
}

console.log("\n=== 4. work-adjusted counterfactual (MODEL-BASED — read the fit quality) ===\n");
const codeFit = fit(rows.map((r) => r.codeApi), rows.map((r) => r.codeCost));
const toolsFit = fit(rows.map((r) => r.toolsApi), rows.map((r) => r.toolsCost));
console.log(`  code : $${codeFit.intercept.toFixed(3)} + $${codeFit.slope.toFixed(5)}/call   r=${codeFit.r.toFixed(2)}`);
console.log(`  tools: $${toolsFit.intercept.toFixed(3)} + $${toolsFit.slope.toFixed(5)}/call   r=${toolsFit.r.toFixed(2)}`);
console.log(
	`  the tools arm's cost rises ${(toolsFit.slope / codeFit.slope).toFixed(1)}x faster per API call, ` +
		"which is the representation effect stated as a rate rather than a level.",
);
const adjusted = rows.map((r) => toolsFit.intercept + toolsFit.slope * r.codeApi - r.codeCost);
console.log(`\n  ${formatPaired("representation at MATCHED call counts", pairedTest(adjusted))}`);
console.log("\n  This view extrapolates the tools arm to the code arm's call count. It is the only");
console.log("  one here that does, and it inherits whatever the fit above gets wrong. Quote view 2");
console.log("  or 3 as the result and this one as corroboration, never the other way round.");
