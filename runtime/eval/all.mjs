#!/usr/bin/env node
/**
 * Run the whole jobs eval and print one table.
 *
 *   node runtime/eval/all.mjs <env-file> [--repeat 1] [--model ...]
 *
 * Costs about $0.20 and four minutes. Cheap enough to run after any change to the
 * primitives, the prompt or the guards — which is the point, because every defect
 * found here so far was invisible to the unit tests and visible in the first
 * trajectory: a false "cell INTERRUPTED" notice on a correct wait, `jobs` vanishing
 * after `%reset -f`, and a thread guard that broke IPython's own `%%bash`.
 *
 * `background --no-prompt` is included deliberately. It removes the resident
 * guidance so the run has to succeed on the guards and api/jobs.md alone, which is
 * what turns the channel design into a measurement instead of an assertion.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { TASKS } from "./tasks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 ? argv[i + 1] : d;
};
const envFile = argv.find((a) => !a.startsWith("--"));
if (!envFile) {
	console.error("usage: runtime/eval/all.mjs <env-file> [--repeat N] [--model M]");
	process.exit(2);
}
const repeat = Number(flag("repeat", "1"));
const model = flag("model", "anthropic/claude-opus-5");
const stamp = Date.now();

const CASES = [
	...Object.keys(TASKS).map((t) => ({ task: t, args: [] })),
	// Not a regression test — a measurement of what the resident prompt buys. It is
	// EXPECTED to fall short: the guards teach `wait` (a blocked sleep raises and
	// names it) but nothing teaches `submit`, because there is no wrong action to
	// correct — an agent that has never heard of it just improvises with
	// subprocess.Popen. Excluded from the exit code so a red suite always means a
	// real regression.
	{ task: "background", args: ["--no-prompt"], label: "background/no-prompt", contrast: true },
];

const jobs = [];
for (let r = 0; r < repeat; r++) for (const c of CASES) jobs.push({ ...c, rep: r });

const run = (c) =>
	new Promise((resolve) => {
		const id = `${(c.label ?? c.task).replace(/\//g, "-")}__${stamp}__r${c.rep}`;
		const p = spawn(
			"node",
			[join(HERE, "run.mjs"), envFile, c.task, "--model", model, "--timeout", "330", "--run-id", id, ...c.args],
			{ cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] },
		);
		p.on("close", () => {
			const f = join(ROOT, ".run/jobs", id, "result.json");
			resolve({ ...c, id, result: existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null });
		});
	});

console.log(`jobs eval: ${jobs.length} runs (${CASES.length} cases x ${repeat})\n`);
const done = await Promise.all(jobs.map(run));

const rows = done.map((d) => {
	const s = d.result?.summary;
	if (!s) return { case: d.label ?? d.task, rep: d.rep, result: "NO RESULT" };
	const failed = (s.checks ?? []).filter((c) => !c.ok).map((c) => c.name);
	return {
		case: d.label ?? d.task,
		rep: d.rep,
		result: s.passed ? "PASS" : "FAIL",
		turns: s.turns,
		cells: s.cells,
		waits: (s.waits ?? []).join(",") || "—",
		cost: +Number(s.cost).toFixed(3),
		sec: Math.round(s.wallMs / 1000),
		// The anti-patterns matter as much as the passes: an agent can reach the right
		// answer by blocking a cell, and that must not read as success.
		antipattern: s.used?.sleep || s.used?.thread ? "!! sleep/thread" : "",
		// A guard that fired is the teaching channel working, not a defect.
		// The adoption metric: cells burned before it reached for jobs, and how many of
		// those were guard refusals rather than free choices.
		adopt: s.attemptsBeforeAdoption === null ? "never" : `after ${s.attemptsBeforeAdoption}`,
		guardHits: s.guardFiresBeforeAdoption ?? 0,
		failed: failed.join("; "),
	};
});
console.table(rows);

const contrast = rows.filter((_, i) => done[i].contrast);
const graded = rows.filter((_, i) => !done[i].contrast);
const failures = graded.filter((r) => r.result !== "PASS");

for (const c of contrast) {
	const s = done.find((d) => (d.label ?? d.task) === c.case)?.result?.summary;
	console.log(
		`\ncontrast — ${c.case}: ${c.result}` +
			(s ? `  used submit=${s.used.submit} wait=${s.used.wait} get=${s.used.get}` : "") +
			(c.failed ? `\n  fell short on: ${c.failed}` : ""),
	);
	console.log("  This measures what the resident prompt buys; it is not graded.");
}

console.log(failures.length ? `\n${failures.length} FAILING` : "\nall graded cases passing");
process.exit(failures.length ? 1 : 0);
