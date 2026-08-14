#!/usr/bin/env node
/**
 * The one way to run AppWorld tasks. Do not hand-roll a loop over run-task.mjs.
 *
 *   node bench/appworld/sweep.mjs <env-file> --tasks a,b,c [--arms codemode,vanilla]
 *   node bench/appworld/sweep.mjs <env-file> --sample 5 [--split train] [--seed 0]
 *   node bench/appworld/sweep.mjs <env-file> --tasks a,b --repeat 4
 *
 * Options
 *   --arms         default codemode,vanilla  (also: notools, claude-code)
 *   --claude-prompt  claude-code preamble variant, default c1
 *   --model        default anthropic/claude-opus-5
 *   --concurrency  default 6
 *   --repeat       runs per (task, arm) cell; ids get __rN
 *   --max-cost     per-run dollar cap, default from run-task.mjs
 *   --resume       skip cells that already have a result.json
 *   --report       re-print the table from existing runs and exit
 *
 * Opt-in codemode variants, both OFF by default and both A/B'd before adoption:
 *   --codemode-docs-gate[=redirect|inline]
 *                          first use of an API is answered with documentation
 *                          instead of a result: `redirect` (default) points at
 *                          api/<pkg>/DOCS.md, `inline` puts the docstring and the
 *                          nearest siblings in the error
 *   --codemode-nav-tools   give codemode read/grep/find/ls as well as ipython
 *   --codemode-api-layout[=consolidated]
 *                          one module per app (api/gmail.py) instead of one file
 *                          per method; call sites are identical in both
 *   --codemode-validate-args
 *   --codemode-read-gate   verified read-precondition on every API (implies
 *                          --codemode-nav-tools + --codemode-api-layout=consolidated)
 *   --codemode-bash        give codemode prime's bash, guarded: blocking commands
 *                          are refused and network egress is refused, so a shell
 *                          cannot become a second route to the world
 *   --codemode-required-defaults
 *                          the parameters bench/required-defaults.mjs listed — an
 *                          optional argument of a MUTATING API whose documented
 *                          default resolves against runtime state ("otherwise, to
 *                          the sender") — render with no default, so omitting one
 *                          is a TypeError at the call site rather than a silent
 *                          redirect of who the call affects
 *                          check every call's arguments against the source MCP
 *                          schema inside the agent's process, before the request
 *                          is sent; a violation raises ArgumentError naming the
 *                          argument and never reaches the server
 *
 * Arm-neutral, and applied to every arm at once:
 *   --base-prompt=v1|v2   which shared base prompt all arms receive (default v1).
 *                         v2 is the hierarchy/checklist rewrite; see prompts.mjs.
 *                         Lands in the runId as __bp-v2.
 *   --catalogue <path>    the shared tool catalogue every arm is rendered from,
 *                         e.g. an enriched one from bench/enrich-catalogue.mjs.
 *                         Lands in the runId as __cat-<name>.
 * Each lands in the runId (__gate-<mode>, __nav), so a variant run never
 * overwrites the baseline run it is being compared against.
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiLayout, docsGateMode } from "../generate.mjs";
import { pool } from "../pool.mjs";
import { BASE_PROMPTS } from "./prompts.mjs";
import { prewarm } from "./prewarm.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = join(ROOT, "bench/appworld/run-task.mjs");
// The claude-code arm is a different product, not a different flag: it runs the real
// `claude` CLI against AppWorld's own MCP server, with its own world plumbing. It
// gets its own runner and is dispatched here so the ramp still goes through one
// entry point — a hand-rolled loop over runners is the thing CLAUDE.md opens with.
const CLAUDE_RUNNER = join(ROOT, "bench/appworld/run-claude-code.mjs");
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
const residencyFor = (arm) => flag(`${arm}-residency`, undefined);
const claudePromptName = flag("claude-prompt", "c1");
// Per-arm and codemode-only, matching run-task.mjs, which rejects them on any
// other arm rather than accepting a flag it will not honour. The mode is parsed
// and validated here as well as there, so a typo fails before 50 tasks run.
function parseDocsGate() {
	const i = argv.findIndex((a) => a === "--codemode-docs-gate" || a.startsWith("--codemode-docs-gate="));
	if (i < 0) return "off";
	if (argv[i].includes("=")) return docsGateMode(argv[i].split("=").slice(1).join("="));
	const next = argv[i + 1];
	return docsGateMode(next && !next.startsWith("--") ? next : "redirect");
}
const codemodeDocsGate = parseDocsGate();
const codemodeNavTools = has("codemode-nav-tools");
const codemodeValidateArgs = has("codemode-validate-args");
// Refused here as well as in the runner, so an unsatisfiable combination fails
// before 46 tasks run rather than 46 times.
const codemodeReadGate = has("codemode-read-gate");
/**
 * --codemode-required-defaults — render the classifier's listed parameters with no
 * default, so an optional argument that decides WHO a mutation lands on cannot be
 * left out. See bench/required-defaults.mjs and docs/CC-EDGE-TRACES.md §M1.
 */
const codemodeRequiredDefaults = has("codemode-required-defaults");
/**
 * --codemode-bash — give codemode prime's `bash`, guarded so it cannot reach the
 * network. See --bash in run-task.mjs: the reason bash was withheld here is EGRESS
 * (78% of vanilla's bash calls on MCP-Bench were `curl` past its own tools), not
 * shells, so the honest form is a shell that cannot leave the transport.
 */
const codemodeBash = has("codemode-bash");
/**
 * --codemode-api-layout[=consolidated] — one module per app instead of one file per
 * method. Validated here as well as in the runner so a typo fails before 46 tasks run.
 */
const codemodeApiLayout = (() => {
	const i = argv.findIndex((a) => a === "--codemode-api-layout" || a.startsWith("--codemode-api-layout="));
	if (i < 0) return "per-method";
	if (argv[i].includes("=")) return apiLayout(argv[i].split("=").slice(1).join("="));
	const next = argv[i + 1];
	return apiLayout(next && !next.startsWith("--") ? next : "consolidated");
})();
if (codemodeReadGate && (codemodeApiLayout !== "consolidated" || !codemodeNavTools)) {
	console.error("--codemode-read-gate requires --codemode-api-layout=consolidated and --codemode-nav-tools");
	process.exit(2);
}
/**
 * The shared catalogue, applied to EVERY arm — never per-arm, for the reason
 * --base-prompt is never per-arm: one authored description rendered into four
 * containers is the fairness mechanism, and a flag that could hand one arm better
 * schemas than another would be aimed straight at it.
 */
const DEFAULT_CATALOGUE = "bench/data/appworld-schemas.json";
const cataloguePath = flag("catalogue", DEFAULT_CATALOGUE);
if (!existsSync(resolve(ROOT, cataloguePath))) {
	console.error(`no such catalogue: ${cataloguePath}`);
	process.exit(2);
}
const catalogueSuffix =
	cataloguePath === DEFAULT_CATALOGUE
		? ""
		: `__cat-${cataloguePath.split("/").pop().replace(/\.json$/, "").replace(/[^a-z0-9]+/gi, "-")}`;
/**
 * --base-prompt=v1|v2 — the shared base prompt, applied to EVERY arm in the sweep.
 *
 * Unlike the codemode variants above this is not per-arm and must never become so:
 * the base prompt being byte-identical across arms is the fairness invariant the
 * whole three-arm comparison rests on, and a flag that could set it for one arm only
 * would be a loaded gun pointed at that invariant. It is validated here as well as in
 * the runners so a typo fails before 46 tasks run.
 */
const basePromptVersion = (() => {
	const i = argv.findIndex((a) => a === "--base-prompt" || a.startsWith("--base-prompt="));
	if (i < 0) return "v1";
	const value = argv[i].includes("=") ? argv[i].split("=").slice(1).join("=") : argv[i + 1];
	if (!BASE_PROMPTS[value]) {
		console.error(`unknown --base-prompt: ${value} (have ${Object.keys(BASE_PROMPTS).join("|")})`);
		process.exit(2);
	}
	return value;
})();
const basePromptSuffix = basePromptVersion === "v1" ? "" : `__bp-${basePromptVersion}`;
/**
 * The vanilla preamble must match the residency it is describing.
 *
 * `b1` says "their full parameter schemas are already in front of you; you do not
 * need to look anything up" — true at L4, false at L1, where the arm holds only
 * `search_tools`/`describe_tool`/`call_tool`. `run-task.mjs` has always picked the
 * matching default (b2 for L1, b3 for `predicted`); this file used to hardcode `b1`
 * and pass it explicitly, silently overriding that and mis-briefing the L1 arm.
 *
 * An L1 run so briefed never calls `describe_tool` at all — it guesses arguments
 * straight into `call_tool`, which mostly works, so nothing raises. Measured on ten
 * challenge tasks, b1-vs-b2 paired: b2 (correct) cost **+$0.020/task more**, with 262
 * actions and 0 tool errors against b1's 253 and 2. So the misbrief made the tools arm
 * look slightly *cheaper* than it is — it understated the representation gap rather
 * than flattering codemode, which is the opposite of the guess that motivated the fix.
 *
 * Small either way; the reason to fix it is that the arm was not in the condition its
 * label claimed, and nothing in the numbers would ever have said so.
 */
const vanillaPromptFor = (residency) => flag("vanilla-prompt", residency === "L1" ? "b2" : residency === "predicted" ? "b3" : "b1");

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
			// claude-code's residency is not a dial: Claude Code registers every MCP tool
			// at connect time, so it is L4 by construction. Naming it anything else would
			// put a label on the run that the run cannot honour.
			const residency =
				arm === "claude-code" ? "L4" : (residencyFor(arm) ?? (arm === "codemode" ? "L0" : arm === "notools" ? "none" : "L4"));
			const vanillaPromptName = vanillaPromptFor(residency);
			const suffix =
				arm === "codemode"
					? `__${promptName}`
					: arm === "vanilla"
						? `__${vanillaPromptName}`
						: arm === "claude-code"
							? `__${claudePromptName}`
							: "";
			// Must match run-task.mjs's own default runId, or --resume and --report
			// look for a run that was written under a different name.
			const variantSuffix =
				arm === "codemode"
					? `${codemodeDocsGate === "off" ? "" : `__gate-${codemodeDocsGate}`}${codemodeNavTools ? "__nav" : ""}${codemodeValidateArgs ? "__val" : ""}${codemodeReadGate ? "__rg" : ""}${codemodeRequiredDefaults ? "__reqd" : ""}${codemodeBash ? "__bash" : ""}${codemodeApiLayout === "per-method" ? "" : `__layout-${codemodeApiLayout}`}`
					: "";
			const base = `${task}__${arm}__${residency}${suffix}${variantSuffix}${basePromptSuffix}${catalogueSuffix}__${model.replace(/[^a-z0-9]/gi, "-")}`;
			cells.push({ task, arm, residency, vanillaPromptName, repeat: r, runId: repeat > 1 ? `${base}__r${r}` : base });
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
	const args =
		cell.arm === "claude-code"
			? [CLAUDE_RUNNER, envFile, model, cell.task, "--prompt", claudePromptName, "--run-id", cell.runId, "--force"]
			: [RUNNER, envFile, model, cell.task, cell.arm, "--residency", cell.residency, "--run-id", cell.runId, "--force"];
	if (cell.arm === "codemode") {
		args.push("--prompt", promptName);
		if (codemodeDocsGate !== "off") args.push(`--docs-gate=${codemodeDocsGate}`);
		if (codemodeNavTools) args.push("--nav-tools");
		if (codemodeValidateArgs) args.push("--validate-args");
		if (codemodeReadGate) args.push("--read-gate");
		if (codemodeRequiredDefaults) args.push("--required-defaults");
		if (codemodeBash) args.push("--bash");
		if (codemodeApiLayout !== "per-method") args.push(`--api-layout=${codemodeApiLayout}`);
	}
	// Every arm, unconditionally — see the comment on cataloguePath.
	if (cataloguePath !== DEFAULT_CATALOGUE) args.push("--catalogue", cataloguePath);
	if (cell.arm === "vanilla") args.push("--vanilla-prompt", cell.vanillaPromptName);
	// Every arm, unconditionally — see the comment on basePromptVersion.
	if (basePromptVersion !== "v1") args.push(`--base-prompt=${basePromptVersion}`);
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
			// Only meaningful under --codemode-validate-args, and zero elsewhere. The
			// count is the whole claim of that variant: a correction delivered at the
			// call site rather than a round trip later.
			(codemodeValidateArgs && arm === "codemode"
				? `argErrs ${mean((r) => (r.argumentErrors ?? []).length).toFixed(2)}  `
				: "") +
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

// Declared before report() can run: `--report` calls it above the `let` below, and
// the temporal dead zone made every `--report` invocation throw *after* printing the
// table. A crash that follows correct output is the easiest kind to keep.
let prewarmResult = null;

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
