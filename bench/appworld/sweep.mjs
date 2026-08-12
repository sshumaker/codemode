#!/usr/bin/env node
/**
 * The one way to run AppWorld tasks. Do not hand-roll a loop over run-task.mjs.
 *
 *   node bench/appworld/sweep.mjs <env-file> --tasks a,b,c [--arms codemode,vanilla]
 *   node bench/appworld/sweep.mjs <env-file> --sample 5 [--split train] [--seed 0]
 *   node bench/appworld/sweep.mjs <env-file> --tasks a,b --repeat 4
 *
 * Options
 *   --arms         default codemode,vanilla  (also: notools)
 *   --model        default anthropic/claude-opus-5
 *   --concurrency  default 6
 *   --repeat       runs per (task, arm) cell; ids get __rN
 *   --max-cost     per-run dollar cap, default from run-task.mjs
 *   --resume       skip cells that already have a result.json
 *   --report       re-print the table from existing runs and exit
 *
 * Why this file exists rather than a bash loop, verbatim from CLAUDE.md: a
 * sequential loop, a per-run judge spawn, and a hand-picked concurrency have each
 * already cost this project 45 minutes of wall-clock. AppWorld worlds are
 * independent in-memory SQLite databases — upstream's own verifier runs them at
 * `--num-processes 6` — so there is no shared service to serialise around and no
 * reason to run them one at a time.
 *
 * `--sample` draws from a split with a fixed seed and prints the draw, because a
 * subset chosen by *speed* is the mistake CLAUDE.md names: AppWorld tasks are
 * fast partly because they need fewer API calls, which is the axis under study.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../pool.mjs";
import { prewarm } from "./prewarm.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = join(ROOT, "bench/appworld/run-task.mjs");
const APPWORLD = join(ROOT, "vendor/appworld");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const envFile = argv.find((a) => !a.startsWith("--") && (a.includes("/") || a.includes(".env")));

if (!envFile && !has("report")) {
	console.error("usage: bench/appworld/sweep.mjs <env-file> --tasks a,b,c | --sample N");
	process.exit(2);
}

const model = flag("model", "anthropic/claude-opus-5");
const arms = flag("arms", "codemode,vanilla").split(",").map((s) => s.trim()).filter(Boolean);
const concurrency = Number(flag("concurrency", 6));
const repeat = Number(flag("repeat", 1));
const split = flag("split", "train");
const seed = Number(flag("seed", 0));
const promptName = flag("prompt", "a1");
const vanillaPromptName = flag("vanilla-prompt", "b1");
const residencyFor = (arm) => flag(`${arm}-residency`, undefined);

/** Task ids for a split, read out of AppWorld rather than hardcoded. */
function splitTaskIds(name) {
	const py = join(APPWORLD, ".venv/bin/python3");
	const out = execFileSync(py, ["-c", `import warnings;warnings.filterwarnings('ignore')\nfrom appworld import load_task_ids\nprint(','.join(load_task_ids('${name}')))`], {
		cwd: APPWORLD,
		encoding: "utf8",
	});
	return out.trim().split(",").filter(Boolean);
}
/** Deterministic PRNG so a sample is reproducible from (split, seed, n). */
function mulberry32(a) {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

let tasks;
if (flag("tasks")) {
	tasks = flag("tasks").split(",").map((s) => s.trim()).filter(Boolean);
} else if (flag("sample")) {
	const n = Number(flag("sample"));
	const all = splitTaskIds(split);
	const rng = mulberry32(seed);
	const shuffled = [...all];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	tasks = shuffled.slice(0, n);
	console.log(`sample: split=${split} seed=${seed} n=${n}\n  ${tasks.join(",")}`);
} else if (!has("report")) {
	console.error("pass --tasks a,b,c or --sample N");
	process.exit(2);
}

const cells = [];
for (const task of tasks ?? []) {
	for (const arm of arms) {
		for (let r = 1; r <= repeat; r++) {
			const residency = residencyFor(arm) ?? (arm === "codemode" ? "L0" : arm === "notools" ? "none" : "L4");
			const suffix = arm === "codemode" ? `__${promptName}` : arm === "vanilla" ? `__${vanillaPromptName}` : "";
			const base = `${task}__${arm}__${residency}${suffix}__${model.replace(/[^a-z0-9]/gi, "-")}`;
			cells.push({ task, arm, residency, repeat: r, runId: repeat > 1 ? `${base}__r${r}` : base });
		}
	}
}

function runDirFor(runId) {
	return join(ROOT, ".run/appworld", runId);
}

function readResult(runId) {
	const path = join(runDirFor(runId), "result.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

async function runCell(cell) {
	if (has("resume") && readResult(cell.runId)?.summary?.success !== undefined) {
		return { ...cell, skipped: true };
	}
	const args = [
		RUNNER,
		envFile,
		model,
		cell.task,
		cell.arm,
		"--residency",
		cell.residency,
		"--run-id",
		cell.runId,
		"--force",
	];
	if (cell.arm === "codemode") args.push("--prompt", promptName);
	if (cell.arm === "vanilla") args.push("--vanilla-prompt", vanillaPromptName);
	if (flag("max-cost")) args.push("--max-cost", flag("max-cost"));
	if (flag("timeout")) args.push("--timeout", flag("timeout"));

	await new Promise((resolve) => {
		const child = spawn("node", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
		let tail = "";
		child.stdout.on("data", (d) => {
			tail = (tail + d).slice(-4000);
		});
		child.stderr.on("data", (d) => {
			tail = (tail + d).slice(-4000);
		});
		child.on("close", () => {
			if (!readResult(cell.runId)) console.error(`[sweep] ${cell.runId} produced no result:\n${tail.slice(-1200)}`);
			resolve();
		});
	});
	return { ...cell, ...(readResult(cell.runId) ?? {}) };
}

function report() {
	const rows = [];
	for (const cell of cells) {
		const result = readResult(cell.runId);
		if (!result) {
			rows.push({ ...cell, missing: true });
			continue;
		}
		rows.push({ ...cell, ...result.summary });
	}

	const pad = (s, n) => String(s).padEnd(n);
	const num = (v, n, d = 0) => (v === null || v === undefined ? "-".padStart(n) : Number(v).toFixed(d).padStart(n));
	console.log(
		`\n${pad("task", 14)}${pad("arm", 10)}${pad("res", 5)}${"pass".padStart(5)}${"tests".padStart(7)}` +
			`${"turns".padStart(6)}${"tools".padStart(6)}${"api".padStart(5)}${"dupes".padStart(6)}${"fail".padStart(5)}` +
			`${"ctx0".padStart(8)}${"cost".padStart(8)}${"secs".padStart(6)}  stop`,
	);
	for (const r of rows) {
		if (r.missing) {
			console.log(`${pad(r.task, 14)}${pad(r.arm, 10)}${pad(r.residency, 5)}  MISSING`);
			continue;
		}
		console.log(
			`${pad(r.task, 14)}${pad(r.arm, 10)}${pad(r.residency, 5)}` +
				`${(r.success === true ? "PASS" : "fail").padStart(5)}` +
				`${`${r.passCount}/${r.totalCount}`.padStart(7)}` +
				`${num(r.turns, 6)}${num(r.toolCalls, 6)}${num(r.apiCalls, 5)}${num(r.duplicateCalls, 6)}` +
				`${num(r.apiCallsFailed, 5)}${num(r.firstTurnPromptTokens, 8)}${num(r.cost, 8, 4)}` +
				`${num((r.wallMs ?? 0) / 1000, 6)}  ${r.stopReason ?? ""}${r.residencyViolation ? " !!RESIDENCY" : ""}`,
		);
	}

	// Per-arm aggregates. TGC only — the pass/total fraction is not a score, a
	// do-nothing run gets 1/2 on a read-only task.
	console.log("");
	for (const arm of arms) {
		const mine = rows.filter((r) => r.arm === arm && !r.missing);
		if (mine.length === 0) continue;
		const mean = (f) => mine.reduce((n, r) => n + (Number(f(r)) || 0), 0) / mine.length;
		const solved = mine.filter((r) => r.success === true).length;
		console.log(
			`${pad(arm, 10)} TGC ${solved}/${mine.length}  ` +
				`turns ${mean((r) => r.turns).toFixed(1)}  ` +
				`toolCalls ${mean((r) => r.toolCalls).toFixed(1)}  ` +
				`apiCalls ${mean((r) => r.apiCalls).toFixed(1)}  ` +
				`ctx0 ${mean((r) => r.firstTurnPromptTokens).toFixed(0)}  ` +
				`$${mean((r) => r.cost).toFixed(4)}  ` +
				`${mean((r) => (r.wallMs ?? 0) / 1000).toFixed(0)}s`,
		);
	}

	// Paired differences, per task, on TGC. With this many cells it is a sanity
	// check and not a test — CLAUDE.md: under ~20 paired cells nothing can be
	// ranked, and the paired t-test is mandatory before believing a difference.
	if (prewarmResult && !prewarmResult.ok) {
		console.log("\n!! pre-warm failed — do NOT report latency from this sweep");
	}
	if (arms.length === 2) {
		const [a, b] = arms;
		const paired = (tasks ?? []).flatMap((task) => {
			const ra = rows.filter((r) => r.task === task && r.arm === a && !r.missing);
			const rb = rows.filter((r) => r.task === task && r.arm === b && !r.missing);
			if (ra.length === 0 || rb.length === 0) return [];
			const s = (rs) => rs.filter((r) => r.success === true).length / rs.length;
			return [{ task, d: s(ra) - s(rb) }];
		});
		const wins = paired.filter((p) => p.d > 0).length;
		const losses = paired.filter((p) => p.d < 0).length;
		console.log(
			`\npaired on TGC (${a} - ${b}): ${wins} win / ${losses} loss / ${paired.length - wins - losses} tie ` +
				`over ${paired.length} tasks — NOT a ranking; run bench/compare.mjs on >=20 paired cells.`,
		);
	}
}

if (has("report")) {
	report();
	process.exit(0);
}

console.log(`${cells.length} cells: ${(tasks ?? []).length} tasks x ${arms.length} arms x ${repeat} repeat, concurrency ${concurrency}`);

// Warm the IPython kernel once before the pool starts.
//
// Cold, the first boot faults a 285 MB venv in from disk and takes ~70s; warm it
// is ~5s. Six workers doing it simultaneously turned that into a 190s mean and a
// 310s max on codemode's first action — 87% of its agent time — which would read
// as "codemode is slower" and be an artefact of the machine. Skip with
// --no-prewarm only if you are not going to quote a latency.
let prewarmResult = null;
if (!has("no-prewarm") && arms.some((a) => a === "codemode")) {
	prewarmResult = await prewarm({ envFile });
	if (!prewarmResult.ok) console.error("[sweep] WARNING: pre-warm did not run a cell; latency numbers are not comparable");
}

const started = Date.now();
let done = 0;
await pool(
	cells,
	runCell,
	concurrency,
	(result, cell) => {
		done++;
		const r = readResult(cell.runId)?.summary;
		console.log(
			`[${done}/${cells.length} ${((Date.now() - started) / 1000).toFixed(0)}s] ${cell.runId}: ` +
				(result?.skipped
					? "skipped (resume)"
					: r
						? `${r.success === true ? "PASS" : "fail"} ${r.passCount}/${r.totalCount}, ${r.turns}t, ${r.apiCalls}api, $${r.cost?.toFixed(4)}`
						: "NO RESULT"),
		);
	},
);
report();
