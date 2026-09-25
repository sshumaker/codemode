#!/usr/bin/env node
/**
 * Score runs with MCP-Bench's rubric.
 *
 *   bench/judge.mjs <env-file> [--model ...] [--run <runId>] [--all] [--force]
 *
 * Ports the six dimensions and scoring guidance from
 * vendor/mcp-bench/benchmark/evaluator.py so numbers stay comparable to
 * published MCP-Bench results rather than being a scale of our own invention.
 *
 * The judge sees the concrete task description (not the fuzzy phrasing the agent
 * got), the agent's final answer, and its full tool trajectory. Both arms are
 * scored by the identical prompt — the trajectory is normalized so a judge
 * cannot tell which arm produced it from formatting alone, only from what was
 * actually done.
 *
 * Scores are written back into each run's result.json under `judge`.
 */
import { spawn } from "node:child_process";

/**
 * Run a command asynchronously, writing `input` to its stdin.
 *
 * Not `execFileSync` — the sync form blocks the event loop, so every pool worker
 * waited on one thread and `--concurrency` did nothing. Not `promisify(execFile)`
 * either: it has no `input` option, so curl sat waiting on stdin until the run
 * timed out. spawn is the form that actually works.
 */
function run(cmd, args, input) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(-200) || `exit ${code}`))));
		child.stdin.end(input);
	});
}
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.mjs";
import { generate } from "./generate.mjs";
import { loadTasks } from "./tasks.mjs";
import { loadCatalogue } from "./catalogue.mjs";
import { makeArgv } from "./argv.mjs";

// Look tasks up without the grounded/runnable filters: runs made before a task
// was excluded still exist on disk and should still be scoreable.
const ALL_TASKS = new Map(loadTasks({ runnable: false }).map((t) => [t.id, t]));
const findTask = (id) => {
	const task = ALL_TASKS.get(id);
	if (!task) throw new Error(`no task definition for ${id}`);
	return task;
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, ".run/runs");
const MCP_LOG = join(ROOT, ".run/mcp-calls.jsonl");
const SCHEMAS = join(ROOT, "bench/data/mcp-schemas.json");
const CATALOGUE = loadCatalogue(SCHEMAS);

/**
 * Wire names of every tool the agent could reach on this task.
 *
 * Tool appropriateness cannot be judged without knowing what was on offer —
 * MCP-Bench passes this list and we were not, so the judge was scoring tool
 * choice against an unknown menu.
 */
function availableToolNames(task) {
	const selected = CATALOGUE.filter((s) => task.exposedServers.includes(s.server));
	return generate(selected).toolDefs.map((d) => d.name);
}

const argv = process.argv.slice(2);
const { flag } = makeArgv(argv);
const envFile = argv.find((a) => !a.startsWith("--") && (a.includes("/") || a.includes(".env")));
const judgeModel = flag("model", "claude-opus-4-5");
const force = argv.includes("--force");
// Judge the same run N times to measure judge noise; results go to judgeSamples.
// Judge the same run N times and average. Measured judge-only noise on an
// unchanged run was sd ~0.39 on the 10-point scale — comparable to the arm
// difference being measured — so a single sample is not a measurement.
// Averaging N samples cuts that by sqrt(N). MCP-Bench does the same
// (`enable_judge_stability`).
const repeats = Number(flag("repeat", 3));
// Judging is API-latency bound, so it parallelizes as well as the runs do.
const concurrency = Number(flag("concurrency", 8));

if (!envFile) {
	console.error("usage: bench/judge.mjs <env-file> [--model ...] [--run <runId>] [--all]");
	process.exit(2);
}

const DIMENSIONS = {
	"Task Completion": {
		task_fulfillment: "Perfectly completes X% of requirements.",
		grounding: "X% of claims are perfectly grounded in tool outputs.",
	},
	"Tool Usage": {
		tool_appropriateness: "X% of tools were perfectly selected for their subtasks.",
		parameter_accuracy: "X% of tool calls have perfectly accurate and complete parameters.",
	},
	"Planning Effectiveness and Efficiency": {
		dependency_awareness: "X% of dependency chains are perfectly executed.",
		parallelism_and_efficiency: "Redundant calls avoided and parallelizable work executed in parallel.",
	},
};

const BANDS = [
	"1-3: 10-30% of the criterion met.",
	"4-6: 40-60% of the criterion met.",
	"7-8: 70-80% of the criterion met.",
	"9-10: 90-100% of the criterion met.",
];

/**
 * The MCP calls a run made, as the judge should see them.
 *
 * Taken from the proxy log rather than the harness stream so both arms are
 * described identically: vanilla's calls arrive as native tool invocations and
 * codemode's as Python coroutines, but at the proxy they are the same records.
 * Anything else would let the judge infer the arm from formatting.
 */
function trajectory(runId) {
	if (!existsSync(MCP_LOG)) return [];
	return readFileSync(MCP_LOG, "utf8")
		.split("\n")
		.filter((l) => l.startsWith("{"))
		.map((l) => JSON.parse(l))
		.filter((r) => r.kind === "call" && r.meta?.runId === runId);
}

/**
 * Deterministic shuffle, seeded by run id.
 *
 * MCP-Bench randomizes dimension order so the judge does not anchor on whichever
 * dimension it reads first. Seeding by run id keeps that bias control while
 * making a re-judge of the same run reproducible.
 */
function seededShuffle(items, seed) {
	let h = 2166136261;
	for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		h = (Math.imul(h, 48271) + 11) >>> 0;
		const j = h % (i + 1);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function buildPrompt(run, task, calls, availableTools) {
	const steps = calls.map((c, i) => {
		const status = c.ok ? "ok" : `FAILED: ${c.error}`;
		return [
			`${i + 1}. ${c.server}.${c.tool}(${JSON.stringify(c.args ?? {})})`,
			`   status: ${status}`,
			`   result (${c.resultChars ?? 0} chars): ${(c.resultPreview ?? "").slice(0, 300).replace(/\n/g, " ")}`,
		].join("\n");
	});

	const groups = seededShuffle(Object.keys(DIMENSIONS), run.runId);
	const rubric = groups
		.map((group) => {
			const subs = seededShuffle(Object.keys(DIMENSIONS[group]), `${run.runId}:${group}`);
			return `${group}\n${subs.map((k) => `  - ${k}: ${DIMENSIONS[group][k]}`).join("\n")}`;
		})
		.join("\n\n");

	return [
		"You are an impartial evaluator judging an AI agent's multi-server tool-based task execution.",
		"Assign scores only on evidence from the task, the agent's answer, and its tool usage.",
		"Be objective: ignore narrative style, verbosity, and formatting polish.",
		"Be strict: most real executions should score 4-6. Scores of 8+ should be exceptional.",
		"Focus on completion ratios, not absolute numbers of calls.",
		"",
		"## TASK PRESENTED TO THE AGENT",
		task.fuzzy,
		"",
		// Without this caveat the judge marks the agent down for diverging from a
		// specification it never saw. MCP-Bench states it explicitly and we had
		// dropped it, which depressed task_fulfilment and dependency_awareness.
		"## CONCRETE TASK REFERENCE (evaluation context only)",
		"The agent did NOT see this version — it saw only the fuzzy task above.",
		"The agent's interpretation may differ from this and still be entirely valid.",
		"Judge whether the underlying need was met, not whether the wording matches.",
		task.description,
		"",
		task.dependencies
			? [
					"## DEPENDENCY ANALYSIS (evaluation context only)",
					"Generated during task creation. The agent did NOT see this.",
					"Score the PROPORTION of dependencies handled, not exact conformance.",
					JSON.stringify(task.dependencies).slice(0, 3000),
					"",
				].join("\n")
			: "",
		"## AGENT'S FINAL ANSWER",
		(run.summary.finalText || "(the agent produced no final answer)").slice(0, 12000),
		"",
		`## TOOL CALLS (${calls.length} total, over ${run.summary.turns} rounds)`,
		steps.length > 0 ? steps.join("\n") : "(the agent made no tool calls)",
		"",
		// Tool appropriateness cannot be judged without knowing what was on offer.
		// MCP-Bench passes this list; we were not, so the judge was scoring tool
		// choice against an unknown menu.
		`## TOOLS AVAILABLE TO THE AGENT (${availableTools.length})`,
		availableTools.join(", ") || "(unknown)",
		"",
		"## SCORING BANDS (apply to every dimension)",
		BANDS.join("\n"),
		"",
		"## DIMENSIONS",
		rubric,
		"",
		"Return only a JSON object with these keys, scores as integers 1-10:",
		"{",
		'  "task_fulfillment_reasoning": "...",',
		'  "grounding_reasoning": "...",',
		'  "tool_appropriateness_reasoning": "...",',
		'  "parameter_accuracy_reasoning": "...",',
		'  "dependency_awareness_reasoning": "...",',
		'  "parallelism_efficiency_reasoning": "...",',
		'  "task_fulfillment": X, "grounding": X,',
		'  "tool_appropriateness": X, "parameter_accuracy": X,',
		'  "dependency_awareness": X, "parallelism_and_efficiency": X',
		"}",
	]
		.filter(Boolean)
		.join("\n");
}

/** Call Anthropic directly; the key is sourced in a subshell, never read here. */
async function callJudge(prompt) {
	const payload = JSON.stringify({
		model: judgeModel,
		max_tokens: 2000,
		messages: [{ role: "user", content: prompt }],
	});
	const script = `
set -a; . "$1"; set +a
curl -sS https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  --data-binary @-`;
	const body = JSON.parse(await run("bash", ["-c", script, "_", envFile], payload));
	if (body.error) throw new Error(`judge API: ${body.error.message}`);
	const text = (body.content ?? []).map((c) => c.text ?? "").join("");
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) throw new Error(`judge returned no JSON: ${text.slice(0, 200)}`);
	return JSON.parse(match[0]);
}

const SCORE_KEYS = [
	"task_fulfillment",
	"grounding",
	"tool_appropriateness",
	"parameter_accuracy",
	"dependency_awareness",
	"parallelism_and_efficiency",
];

/**
 * A run that did not finish has no answer to judge.
 *
 * Measured 2026-08-31: 30 timed-out runs were scored as if they had answered, and
 * they land at a mean 3.61 against 6.26 for completed runs — a −2.35 within-task
 * penalty, lower in 10 of 10 tasks. The judge is not wrong about them: fulfilment
 * and grounding SHOULD floor when the deliverable is absent. The harness is wrong to
 * hand it a decapitated run. `finalText` proves the absence — a fragment or empty in
 * 29 of 31 timed-out runs against 26 of 946 completed, a 34x rate difference, with
 * survivors reading "Now the conferences." and "so I'll pivot to recent clinical
 * trial literature."
 *
 * The penalty is NOT arm-neutral: it concentrates in the arm that takes more turns,
 * so it biases arm comparison against codemode.
 *
 * There was no gating here to make symmetric. `budget` (23) and `refused` (4) runs
 * happen to carry no judge, but so do 138 COMPLETED runs — because those sweeps ran
 * without `--judge`, not because anything excluded them. The exclusion had to be
 * added, not repaired.
 *
 * Deliberately not fixed by raising the deadline: the deadline is legitimate cost
 * control, and scoring a killed run is the defect. Raising it converts a scoring
 * error into a spend increase and leaves the defect in place.
 */
const SCORABLE_STOP_REASON = "completed";

function sessionDiedAtCompaction(dir) {
	const sessions = join(dir, "agent-home", "sessions");
	if (!existsSync(sessions)) return false;
	for (const f of readdirSync(sessions)) {
		if (!f.endsWith(".jsonl")) continue;
		let last;
		try {
			const lines = readFileSync(join(sessions, f), "utf8").split("\n");
			for (let i = lines.length - 1; i >= 0; i--) {
				const l = lines[i].trim();
				if (!l.startsWith("{")) continue;
				last = JSON.parse(l);
				break;
			}
		} catch {
			continue;
		}
		if (last?.type === "compaction") return true;
		if (last?.type === "custom_message" && String(last.content ?? "").includes("too short to compact")) return true;
	}
	return false;
}

async function judgeRun(dir) {
	const resultPath = join(dir, "result.json");
	const run = JSON.parse(readFileSync(resultPath, "utf8"));
	if (run.judge && !force) return { ...run, skipped: true };

	const stopReason = run.summary?.stopReason;
	if (stopReason && stopReason !== SCORABLE_STOP_REASON) {
		// Recorded rather than silently dropped, so the count is visible in the run
		// record and a later reader can tell "not scored" from "scored zero".
		return { ...run, unscorable: { reason: stopReason, finalTextChars: (run.summary?.finalText ?? "").length } };
	}

	// Same defect class as the timeout fix above, one layer deeper: a run whose
	// next request could not be built (one oversized tool result overflowed the
	// window; compaction either skipped -- turn-boundary cuts cannot discard a
	// result inside the FINAL turn -- or ran and the continuation still died)
	// exits 0 with stopReason "completed", and the judge then scores a stump.
	// 22+1 such runs found 2026-09-01, every one vanilla, all openapi_explorer /
	// hugging_face family. The session-side signature: the LAST session event is
	// a compaction entry or the "too short to compact" skip message — a session
	// that survived either is always followed by more messages.
	if (sessionDiedAtCompaction(dir)) {
		return { ...run, unscorable: { reason: "died-mid-turn (oversized result; compaction could not rescue; exit recorded completed)", finalTextChars: (run.summary?.finalText ?? "").length } };
	}

	const task = findTask(run.task.id);
	const calls = trajectory(run.runId);
	const prompt = buildPrompt(run, task, calls, availableToolNames(task));

	// The repeat samples are independent, so issue them together. Running them in
	// series multiplied every worker's latency by `repeats` and quietly divided
	// the effective concurrency by the same factor.
	const raw = await Promise.all(Array.from({ length: repeats }, () => callJudge(prompt)));
	const samples = [];
	const perDim = {};
	for (const [i, s] of raw.entries()) {
		const values = SCORE_KEYS.map((k) => Number(s[k]) || 0);
		samples.push(+(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
		for (const k of SCORE_KEYS) (perDim[k] ??= []).push(Number(s[k]) || 0);
		if (i === 0) run.judgeReasoning = s;
	}


	const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
	const scores = Object.fromEntries(SCORE_KEYS.map((k) => [k, +avg(perDim[k]).toFixed(2)]));
	const overall = avg(samples);
	const sd =
		samples.length > 1
			? Math.sqrt(samples.reduce((a, b) => a + (b - overall) ** 2, 0) / (samples.length - 1))
			: 0;

	// Log the inputs, not just the verdicts (CLAUDE.md): a deterministic-looking
	// judge disagreed 3.67 vs 6.56 across arms on near-identical evidence
	// (huge_icons_000, triage 2026-09-01) and nothing on disk could say why,
	// because neither the assembled prompt nor any rationale was kept. With this
	// file the verdict is re-derivable tomorrow, after the corpus moves on.
	writeFileSync(
		join(dir, "judge-trace.json"),
		`${JSON.stringify({ model: judgeModel, at: new Date().toISOString(), prompt, samples: raw }, null, 2)}\n`,
	);

	run.judge = {
		model: judgeModel,
		samples,
		// Standard error of the averaged score — carry it so downstream analysis
		// can tell measurement noise from a real difference.
		sd: +sd.toFixed(3),
		se: +(sd / Math.sqrt(samples.length)).toFixed(3),
		scores,
		overall: +overall.toFixed(2),
		mcpCalls: calls.length,
	};

	writeFileSync(resultPath, `${JSON.stringify(run, null, 2)}\n`);
	return run;
}

const only = flag("run", null);
const onlyPrefix = flag("only-prefix", null);
const dirs = only
	? [join(RUNS, only)]
	: readdirSync(RUNS)
			.map((n) => join(RUNS, n))
			.filter((d) => existsSync(join(d, "result.json")))
			.filter((d) => !onlyPrefix || d.split("/").pop().startsWith(onlyPrefix));

const rows = [];
const failures = [];
await pool(
	dirs,
	async (dir) => {
		try {
			const run = await judgeRun(dir);
			rows.push({
				task: run.task.id.slice(0, 26),
				arm: `${run.arm}/${run.residency}`,
				fulfil: run.judge.scores.task_fulfillment,
				ground: run.judge.scores.grounding,
				overall: run.judge.overall,
				sd: run.judge.sd ?? "—",
				cached: run.skipped ? "cached" : "",
			});
			process.stderr.write(".");
		} catch (err) {
			failures.push(`${dir.split("/").pop().slice(0, 50)}: ${err.message.slice(0, 90)}`);
			process.stderr.write("x");
			rows.push({ task: dir.split("/").pop().slice(0, 26), arm: "?", overall: `ERR: ${err.message.slice(0, 50)}` });
		}
	},
	concurrency,
);
process.stderr.write("\n");

// Loudly, and with a non-zero exit. A quiet failure here looks identical to a
// cache hit, and once hid every run failing on the same undefined reference.
if (failures.length > 0) {
	console.error(`\n!! ${failures.length}/${dirs.length} runs failed to judge:`);
	for (const f of failures.slice(0, 5)) console.error(`   ${f}`);
	if (failures.length > 5) console.error(`   … and ${failures.length - 5} more`);
	if (failures.length === dirs.length) {
		console.error("\n   EVERY run failed — this is a bug in judge.mjs, not the data.");
		process.exitCode = 1;
	}
}
console.table(rows);
