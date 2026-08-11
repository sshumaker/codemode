#!/usr/bin/env node
/**
 * Report TheAgentCompany results, per checkpoint rather than per total.
 *
 *   bench/tac/report.mjs [--dir .run/tac]
 *
 * Totals hide the thing worth knowing. On admin-make-spreadsheet both arms
 * scored 4/5 and the tie was an accident: codemode missed a drink and counted
 * correctly, vanilla found every drink and miscounted. Two different failures,
 * one identical number.
 *
 * TAC's scoring strategies compound this. `bonus_for_completing_final` awards
 * every checkpoint when the last one passes, and `bonus_for_completing_any`
 * awards the first whenever anything passes — so hr-check-attendance reports 3/3
 * for both arms while both actually fail checkpoint 1. A comparison built on
 * those totals is measuring the scoring strategy as much as the arms.
 *
 * So this prints, per task: each checkpoint side by side, where the arms
 * diverge, and full-solve counts — with the paired t-test on totals kept only as
 * a summary line rather than the headline.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 ? argv[i + 1] : d;
};
const RUNS = join(ROOT, flag("dir", ".run/tac"));

const byTask = new Map();
for (const d of readdirSync(RUNS)) {
	const f = join(RUNS, d, "result.json");
	if (!existsSync(f)) continue;
	let r;
	try {
		r = JSON.parse(readFileSync(f, "utf8"));
	} catch {
		continue;
	}
	if (!byTask.has(r.task)) byTask.set(r.task, {});
	byTask.get(r.task)[r.arm] = {
		graded: r.graded,
		score: r.score,
		checkpoints: r.result?.checkpoints ?? [],
		summary: r.summary ?? {},
		dir: join(RUNS, d),
	};
}

const ARMS = ["codemode", "vanilla", "claude-code"];
const present = ARMS.filter((a) => [...byTask.values()].some((v) => v[a]));

const frac = (s) => (s?.score?.total ? s.score.result / s.score.total : null);
/** A checkpoint's raw pass/fail, before any bonus strategy rewrites the total. */
const raw = (s) => s.checkpoints.map((c) => `${Number(c.result)}/${c.total}`).join(" ");
const rawPassed = (s) => s.checkpoints.reduce((n, c) => n + (Number(c.result) === c.total ? 1 : 0), 0);
const rawTotal = (s) => s.checkpoints.length;

console.log("=".repeat(78));
console.log("PER-CHECKPOINT DETAIL");
console.log("=".repeat(78));

const divergent = [];
for (const [task, arms] of [...byTask].sort()) {
	const graded = present.filter((a) => arms[a]?.graded);
	if (graded.length === 0) continue;
	console.log(`\n${task}`);
	for (const a of graded) {
		const s = arms[a];
		console.log(
			`  ${a.padEnd(11)} ${String(s.score.result).padStart(2)}/${s.score.total}  raw[${raw(s)}]  ` +
				`${s.summary.turns ?? "?"}t ${s.summary.toolCalls ?? "?"}c ${s.summary.toolErrors ?? 0}e $${(s.summary.cost ?? 0).toFixed(2)}` +
				`${s.summary.timedOut ? "  [TRUNCATED — hit the time cap]" : ""}`,
		);
	}
	// Divergence at the checkpoint level, which a matching total can conceal.
	if (arms.codemode?.graded && arms.vanilla?.graded) {
		const a = arms.codemode.checkpoints;
		const b = arms.vanilla.checkpoints;
		const diffs = [];
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			const x = Number(a[i]?.result ?? -1);
			const y = Number(b[i]?.result ?? -1);
			if (x !== y) diffs.push(`cp${i + 1}: cm=${x} van=${y}`);
		}
		if (diffs.length > 0) {
			divergent.push({ task, diffs, cmTotal: arms.codemode.score.result, vanTotal: arms.vanilla.score.result });
			console.log(`  DIVERGE    ${diffs.join(", ")}${arms.codemode.score.result === arms.vanilla.score.result ? "  (totals tie — different failures)" : ""}`);
		}
	}
}

console.log(`\n${"=".repeat(78)}`);
console.log("SUMMARY");
console.log("=".repeat(78));

for (const a of present) {
	const rows = [...byTask.values()].filter((v) => v[a]?.graded).map((v) => v[a]);
	if (rows.length === 0) continue;
	const got = rows.reduce((s, r) => s + r.score.result, 0);
	const max = rows.reduce((s, r) => s + r.score.total, 0);
	const full = rows.filter((r) => r.score.result === r.score.total).length;
	// Raw pass rate ignores the bonus strategies entirely.
	const rp = rows.reduce((s, r) => s + rawPassed(r), 0);
	const rt = rows.reduce((s, r) => s + rawTotal(r), 0);
	const cost = rows.reduce((s, r) => s + (r.summary.cost ?? 0), 0);
	const err = rows.reduce((s, r) => s + (r.summary.toolErrors ?? 0), 0);
	const ungraded = [...byTask.values()].filter((v) => v[a] && !v[a].graded).length;
	console.log(
		`${a.padEnd(11)} ${((got / max) * 100).toFixed(1)}% scored (${got}/${max})  ` +
			`${((rp / rt) * 100).toFixed(1)}% raw checkpoints (${rp}/${rt})  ` +
			`${full}/${rows.length} fully solved  $${cost.toFixed(2)}  ${err} tool errors  ${ungraded} ungraded`,
	);
}

// Paired test on the tasks where both arms produced a grade.
// A run cut off by the time cap did not finish losing — it stopped. Counting it
// against the other arm measures the cap. research-reproduce-figures showed the
// shape: codemode truncated at 1/8 after 2421s, vanilla finished 5/8 in 724s.
// Truncation only matters where it could have cost points. A run that hit the cap
// *and* scored full marks finished its work first — sde-copilot-arena-server-easy
// -add-suffix scored 4/4 at the cap — so excluding it would discard a legitimate
// result. Exclude only when a capped arm fell short of full.
const costlyTruncation = (s) => Boolean(s?.summary?.timedOut) && s.score.result < s.score.total;
const truncated = [...byTask].filter(([, v]) => costlyTruncation(v.codemode) || costlyTruncation(v.vanilla));
const paired = [...byTask.values()].filter(
	(v) => v.codemode?.graded && v.vanilla?.graded && !costlyTruncation(v.codemode) && !costlyTruncation(v.vanilla),
);
if (truncated.length > 0) {
	console.log(`\nexcluded from the paired test — one arm hit the time cap (${truncated.length}):`);
	for (const [task, v] of truncated) {
		const who = [costlyTruncation(v.codemode) ? "codemode" : null, costlyTruncation(v.vanilla) ? "vanilla" : null].filter(Boolean).join("+");
		console.log(`  ${task} (${who} truncated) — re-run with a longer --timeout to compare fairly`);
	}
}
if (paired.length >= 2) {
	const d = paired.map((v) => frac(v.codemode) - frac(v.vanilla));
	const n = d.length;
	const mean = d.reduce((a, b) => a + b, 0) / n;
	const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
	const t = sd === 0 ? 0 : mean / (sd / Math.sqrt(n));
	const wins = d.filter((x) => x > 0).length;
	const losses = d.filter((x) => x < 0).length;
	console.log(
		`\npaired n=${n}: codemode − vanilla = ${mean >= 0 ? "+" : ""}${mean.toFixed(3)} ` +
			`(t=${t.toFixed(2)}, sd=${sd.toFixed(3)}), codemode wins ${wins}, loses ${losses}, ties ${n - wins - losses}`,
	);
	if (sd === 0) console.log("sd is zero — every paired task scored identically; the test says nothing.");
	console.log(`tasks where the arms diverged on at least one checkpoint: ${divergent.length}/${n}`);
	const hiddenTies = divergent.filter((x) => x.cmTotal === x.vanTotal).length;
	if (hiddenTies > 0) console.log(`  of which ${hiddenTies} tie on the total while failing different checkpoints`);
}

const ungradedAll = [...byTask].filter(([, v]) => present.some((a) => v[a] && !v[a].graded));
if (ungradedAll.length > 0) {
	console.log(`\nexcluded (ungraded — grader failed, not a zero):`);
	for (const [task, v] of ungradedAll) {
		for (const a of present) if (v[a] && !v[a].graded) console.log(`  ${task} (${a}) — see ${v[a].dir}/grader.log`);
	}
}
