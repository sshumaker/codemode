#!/usr/bin/env node
/**
 * Where do tasks actually fail, and do the arms fail the SAME ones?
 *
 *   node bench/appworld/failures.mjs [--model anthropic-claude-opus-5]
 *
 * Every cell of the 2x2 scored 6-7 of 8 on AppWorld and that was reported as "no
 * score signal". But a mean is not a comparison: two arms can post identical scores
 * while failing disjoint sets of tasks, which is a real quality difference in both
 * directions that the aggregate hides. It can also be the opposite — both arms
 * missing the same checkpoints, which is task difficulty and genuinely no signal.
 * Those two look the same in the mean and could not be more different.
 *
 * So this reports the 2x2 of agreement per pair of cells:
 *
 *     both pass | code only | tools only | both fail
 *
 * plus how the failures fail — ran out of budget, ran out of turns, committed a
 * wrong answer, or died on API errors.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signTest } from "../stats.mjs";
import { makeArgv } from "../argv.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNS = join(ROOT, ".run/appworld");
const argv = process.argv.slice(2);
const { flag } = makeArgv(argv);
const MODEL = flag("model", "anthropic-claude-opus-5");

const CELLS = [
	{ key: "code/docs-out", arm: "codemode", residency: "L0", prompt: "a1" },
	{ key: "code/docs-in", arm: "codemode", residency: "L4", prompt: "a1" },
	{ key: "tools/docs-out", arm: "vanilla", residency: "L1", prompt: "b2" },
	{ key: "tools/docs-in", arm: "vanilla", residency: "L4", prompt: "b1" },
];

// task -> cell -> [runs across replicates]
const table = new Map();
for (const d of readdirSync(RUNS)) {
	const f = join(RUNS, d, "result.json");
	if (!existsSync(f)) continue;
	let r;
	try {
		r = JSON.parse(readFileSync(f, "utf8"));
	} catch {
		continue;
	}
	const cell = CELLS.find(
		(c) => r.arm === c.arm && r.residency === c.residency && r.promptVariant === c.prompt,
	);
	if (!cell || !r.model?.includes(MODEL.replace(/-/g, "")) === false) {
		// model match is loose on purpose; the runId carries the sanitised name
	}
	if (!cell) continue;
	if (!d.includes(MODEL)) continue;
	const task = r.task?.id ?? d.split("__")[0];
	if (!table.has(task)) table.set(task, new Map());
	if (!table.get(task).has(cell.key)) table.get(task).set(cell.key, []);
	table.get(task).get(cell.key).push(r.summary);
}

/**
 * A task counts as passed in a cell if a MAJORITY of its replicates passed.
 *
 * Not "any replicate passed", which would launder a flaky arm into a reliable one,
 * and not "all passed", which punishes an arm for one bad sample. With n=3 the
 * majority rule is also the one that treats the two arms symmetrically.
 */
const passed = (runs) => {
	if (!runs?.length) return null;
	const ok = runs.filter((s) => s.success).length;
	return ok * 2 > runs.length;
};
const meanOf = (runs, f) => (runs?.length ? runs.reduce((a, s) => a + (f(s) ?? 0), 0) / runs.length : Number.NaN);

const tasks = [...table.keys()].sort();
const complete = tasks.filter((t) => CELLS.every((c) => table.get(t).get(c.key)?.length));
console.log(`${tasks.length} tasks seen, ${complete.length} present in all four cells (model ${MODEL})\n`);
if (complete.length === 0) process.exit(0);

// --- per-cell pass rates -------------------------------------------------------
console.log("=== pass rate per cell ===\n");
for (const c of CELLS) {
	const p = complete.filter((t) => passed(table.get(t).get(c.key))).length;
	const partial = complete.map((t) => {
		const runs = table.get(t).get(c.key);
		return meanOf(runs, (s) => (s.totalCount ? s.passCount / s.totalCount : 0));
	});
	const mean = partial.reduce((a, b) => a + b, 0) / partial.length;
	console.log(`  ${c.key.padEnd(16)} ${p}/${complete.length} tasks fully passed   mean checkpoint rate ${(mean * 100).toFixed(1)}%`);
}

// --- the question: do the arms fail the same tasks? ---------------------------
console.log("\n=== agreement between cells — do they fail the SAME tasks? ===\n");
const pairs = [
	["code/docs-out", "tools/docs-out", "representation, docs out"],
	["code/docs-in", "tools/docs-in", "representation, docs in"],
	["code/docs-out", "code/docs-in", "residency, code row"],
	["tools/docs-out", "tools/docs-in", "residency, tools row"],
];
for (const [a, b, label] of pairs) {
	let bothPass = 0, onlyA = 0, onlyB = 0, bothFail = 0;
	const disagreements = [];
	for (const t of complete) {
		const pa = passed(table.get(t).get(a));
		const pb = passed(table.get(t).get(b));
		if (pa && pb) bothPass++;
		else if (pa && !pb) { onlyA++; disagreements.push(`${t} — ${a} only`); }
		else if (!pa && pb) { onlyB++; disagreements.push(`${t} — ${b} only`); }
		else bothFail++;
	}
	// Only the disagreements carry information about which arm is better. The sign
	// test over them is McNemar's test — the correct one for paired binary outcomes,
	// and it ignores the ties, which is exactly the point.
	const deltas = [...Array(onlyA).fill(1), ...Array(onlyB).fill(-1)];
	const st = signTest(deltas);
	console.log(`  ${label}`);
	console.log(`    both pass ${bothPass}   ${a} only ${onlyA}   ${b} only ${onlyB}   both fail ${bothFail}`);
	console.log(
		`    discordant ${onlyA + onlyB}/${complete.length}` +
			(onlyA + onlyB > 0 ? `   McNemar sign ${st.wins}/${st.nEffective} p=${st.p.toFixed(3)}` : "   — nothing to test"),
	);
	if (bothFail > 0) console.log(`    ${bothFail} task(s) failed by BOTH — task difficulty, not an arm difference`);
	for (const d of disagreements.slice(0, 6)) console.log(`      ${d}`);
	console.log("");
}

// --- how do the failures fail? -------------------------------------------------
console.log("=== failure modes (runs that did not pass) ===\n");
console.log("  cell             runs  fail  stopReason                          apiFail  wrongAnswer  meanCheckpts");
for (const c of CELLS) {
	const runs = complete.flatMap((t) => table.get(t).get(c.key) ?? []);
	const bad = runs.filter((s) => !s.success);
	if (!bad.length) {
		console.log(`  ${c.key.padEnd(16)} ${String(runs.length).padStart(4)}     0  —`);
		continue;
	}
	const stops = {};
	for (const s of bad) stops[s.stopReason ?? "?"] = (stops[s.stopReason ?? "?"] ?? 0) + 1;
	const apiFail = bad.filter((s) => (s.apiCallsFailed ?? 0) > 0).length;
	// Committed an answer that was simply wrong, as opposed to never committing one.
	const wrong = bad.filter((s) => s.committedAnswer != null && s.committedAnswer !== s.groundTruthAnswer).length;
	const cp = bad.reduce((a, s) => a + (s.totalCount ? s.passCount / s.totalCount : 0), 0) / bad.length;
	console.log(
		`  ${c.key.padEnd(16)} ${String(runs.length).padStart(4)}  ${String(bad.length).padStart(4)}  ` +
			`${Object.entries(stops).map(([k, v]) => `${k}:${v}`).join(" ").padEnd(34)} ` +
			`${String(apiFail).padStart(7)}  ${String(wrong).padStart(11)}  ${(cp * 100).toFixed(0)}%`,
	);
}
console.log("\n  meanCheckpts = how much of the task a failing run still got right.");
console.log("  A failure at 80% is a different problem from a failure at 0%.");
