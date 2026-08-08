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
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.mjs";
import { loadTasks } from "./tasks.mjs";

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

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
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

function buildPrompt(run, task, calls) {
	const steps = calls.map((c, i) => {
		const status = c.ok ? "ok" : `FAILED: ${c.error}`;
		return [
			`${i + 1}. ${c.server}.${c.tool}(${JSON.stringify(c.args ?? {})})`,
			`   status: ${status}`,
			`   result (${c.resultChars ?? 0} chars): ${(c.resultPreview ?? "").slice(0, 300).replace(/\n/g, " ")}`,
		].join("\n");
	});

	const rubric = Object.entries(DIMENSIONS)
		.map(([group, subs]) => {
			const lines = Object.entries(subs).map(([key, desc]) => `  - ${key}: ${desc}`);
			return `${group}\n${lines.join("\n")}`;
		})
		.join("\n\n");

	return [
		"You are evaluating an AI agent's execution of a tool-using task.",
		"Assign scores only on evidence from the task, the agent's answer, and its tool usage.",
		"Be strict: most real executions should score 4-6. Scores of 8+ should be exceptional.",
		"Focus on completion ratios, not absolute numbers of calls.",
		"",
		"## CONCRETE TASK DESCRIPTION",
		task.description,
		"",
		task.dependencies ? `## DEPENDENCY ANALYSIS\n${JSON.stringify(task.dependencies).slice(0, 3000)}\n` : "",
		"## AGENT'S FINAL ANSWER",
		(run.summary.finalText || "(the agent produced no final answer)").slice(0, 12000),
		"",
		`## TOOL CALLS (${calls.length} total)`,
		steps.length > 0 ? steps.join("\n") : "(the agent made no tool calls)",
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
function callJudge(prompt) {
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
	const raw = execFileSync("bash", ["-c", script, "_", envFile], {
		input: payload,
		encoding: "utf8",
		maxBuffer: 20e6,
	});
	const body = JSON.parse(raw);
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

function judgeRun(dir) {
	const resultPath = join(dir, "result.json");
	const run = JSON.parse(readFileSync(resultPath, "utf8"));
	if (run.judge && !force) return { ...run, skipped: true };

	const task = findTask(run.task.id);
	const calls = trajectory(run.runId);
	const prompt = buildPrompt(run, task, calls);

	const samples = [];
	const perDim = {};
	for (let i = 0; i < repeats; i++) {
		const s = callJudge(prompt);
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
await pool(
	dirs,
	(dir) => {
		try {
			const run = judgeRun(dir);
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
			process.stderr.write("x");
			rows.push({ task: dir.split("/").pop().slice(0, 26), arm: "?", overall: `ERR: ${err.message.slice(0, 50)}` });
		}
	},
	concurrency,
);
process.stderr.write("\n");
console.table(rows);
