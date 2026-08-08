#!/usr/bin/env node
/**
 * Run one MCP-Bench task through one arm, capturing everything.
 *
 *   bench/run-task.mjs <env-file> <model> <task-id> <arm> [--residency L0|L1|L2] [--timeout 600]
 *
 * Writes a self-contained run directory under .run/runs/<runId>/:
 *
 *   meta.json     task, arm, model, residency, exposed servers, preamble
 *   stream.jsonl  the harness's raw JSON event stream, unmodified
 *   result.json   parsed summary: turns, tool calls, tokens, cost, final text
 *   api/          (codemode) the tool tree the agent actually had
 *   prompt.txt    the exact appended system prompt
 *
 * Keeping the raw stream means any later analysis can be redone without
 * re-spending tokens — the parse is derived, the stream is the record.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./generate.mjs";
import { findTask } from "./tasks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/cli.js");
const SCHEMAS = join(ROOT, "bench/data/mcp-schemas.json");
const EXTENSION = join(ROOT, "bench/arms/mcp-tools-extension.ts");
const PROXY = process.env.HARNESS_MCP_PROXY ?? "http://127.0.0.1:8765";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const [envFile, model, taskId, arm] = positional;

if (!envFile || !model || !taskId || !arm) {
	console.error("usage: bench/run-task.mjs <env-file> <model> <task-id> <arm> [--residency L0|L1|L2]");
	process.exit(2);
}
if (!["vanilla", "codemode"].includes(arm)) {
	console.error(`unknown arm: ${arm}`);
	process.exit(2);
}

const residency = flag("residency", arm === "codemode" ? "L0" : "L4");
const timeoutSec = Number(flag("timeout", 900));
// Budget cap in dollars — the arm-neutral control. 0 disables.
const maxCost = Number(flag("max-cost", 1.0));
// Optional hard turn cap, off by default (see enforceBudget).
const maxTurns = Number(flag("max-turns", 0));
const task = findTask(taskId);

const runId = flag("run-id", `${taskId}__${arm}__${residency}__${model.replace(/[^a-z0-9]/gi, "-")}`);
const runDir = join(ROOT, ".run/runs", runId);
mkdirSync(runDir, { recursive: true });

/**
 * The codemode arm's system-prompt preamble.
 *
 * Even L0 must say the tree exists — an agent that does not know to look would
 * fail for a reason unrelated to the hypothesis. That pointer is the fixed cost
 * counted against codemode's savings in docs/DESIGN.md.
 */
function buildPreamble() {
	if (arm === "vanilla") return "";

	const catalogue = JSON.parse(readFileSync(SCHEMAS, "utf8")).catalogue.filter((s) =>
		task.exposedServers.includes(s.server),
	);
	const { tocLines, names } = generate(catalogue);

	const pointer = [
		"## Tools",
		"",
		`The \`api/\` directory in your working directory contains ${tocLines.length} async tool functions`,
		`across ${catalogue.length} services, generated from their live API schemas.`,
		"",
		"Discover them:",
		"  cat api/INDEX.md              # services and their package names",
		"  cat api/<package>/INDEX.md    # one service's tools",
		"  grep -ril '<keyword>' api/    # search all tool documentation",
		"  cat api/<package>/<tool>.py   # full parameter docs for one tool",
		"",
		"Call them from the ipython tool:",
		"  import api.<package>",
		"  result = await api.<package>.<tool>(...)",
		"",
		"They are coroutines — always await them. Results are strings.",
		"Hold intermediate results in variables; only print what you need to reason about.",
	].join("\n");

	if (residency === "L0") return pointer;
	if (residency === "L1") return `${pointer}\n\nAvailable tools:\n${names.join("\n")}`;
	if (residency === "L2") return `${pointer}\n\nAvailable tools:\n${tocLines.join("\n")}`;
	throw new Error(`unsupported residency for codemode: ${residency}`);
}

const preamble = buildPreamble();
writeFileSync(join(runDir, "prompt.txt"), preamble);

// codemode reads its catalogue off disk; vanilla gets it as tool definitions.
if (arm === "codemode") {
	const catalogue = JSON.parse(readFileSync(SCHEMAS, "utf8")).catalogue.filter((s) =>
		task.exposedServers.includes(s.server),
	);
	const { files } = generate(catalogue);
	for (const [rel, content] of Object.entries(files)) {
		const path = join(runDir, "api", rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
}

const meta = {
	runId,
	arm,
	residency,
	model,
	task: {
		id: task.id,
		tier: task.tier,
		servers: task.servers,
		exposedServers: task.exposedServers,
		droppedDistractors: task.droppedDistractors ?? [],
	},
	preambleChars: preamble.length,
	startedAt: new Date().toISOString(),
};

// The agent sees the fuzzy phrasing, which names no tools — retrieval is part
// of what is being measured.
const prompt = task.fuzzy;

// `--tools` is an *allowlist* (agent-session.ts:8473), not just an initial
// selection — anything absent is filtered out even if an extension registered
// it. The vanilla arm therefore has to name every MCP tool explicitly, or its
// 250 tool definitions silently never reach the model and it falls back to bash.
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
let toolList;
if (arm === "vanilla") {
	const catalogue = JSON.parse(readFileSync(SCHEMAS, "utf8")).catalogue.filter((s) =>
		task.exposedServers.includes(s.server),
	);
	const { toolDefs } = generate(catalogue);
	toolList = [...BUILTINS, ...toolDefs.map((d) => d.name)];
	meta.mcpToolCount = toolDefs.length;
} else {
	toolList = ["ipython"];
}
const tools = toolList.join(",");
meta.toolCount = toolList.length;
writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
const cliArgs = [
	CLI,
	"-p",
	"--mode",
	"json",
	"--model",
	model,
	"--tools",
	tools,
	"--cwd",
	runDir,
	"--no-skills",
	"--no-context-files",
	"--no-prompt-templates",
];
if (arm === "vanilla") {
	cliArgs.push("--extension", EXTENSION);
} else {
	cliArgs.push("--no-extensions");
}
if (preamble) cliArgs.push("--append-system-prompt", preamble);
cliArgs.push(prompt);

// Source the env file in a subshell so the key never lands in a JS variable.
// `shift` drops the env-file argument before "$@" is handed to node.
const child = spawn(
	"bash",
	["-c", `set -a; . "$1"; set +a; shift; exec node "$@"`, "_", envFile, ...cliArgs],
	{
		cwd: runDir,
		env: {
			...process.env,
			PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`,
			DO_NOT_TRACK: "1",
			PRIME_AGENT_TELEMETRY: "0",
			PRIME_AGENT_CODING_AGENT_DIR: join(runDir, "agent-home"),
			HARNESS_MCP_PROXY: PROXY,
			HARNESS_MCP_CATALOGUE: SCHEMAS,
			HARNESS_MCP_SERVERS: task.exposedServers.join(","),
			HARNESS_RUN_ID: runId,
		},
		stdio: ["ignore", "pipe", "pipe"],
	},
);

const streamFile = createWriteStream(join(runDir, "stream.jsonl"));
const started = Date.now();
const summary = {
	turns: 0,
	toolCalls: 0,
	toolNames: [],
	toolErrors: 0,
	errorMessages: [],
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	finalText: "",
};
const counted = new Set();
let buffer = "";
let stderr = "";

const killTimer = setTimeout(() => {
	summary.timedOut = true;
	child.kill("SIGKILL");
}, timeoutSec * 1000);

/**
 * Budget cap, checked as usage streams in.
 *
 * Cost rather than turns or wall-clock. Turns are not comparable units across
 * arms — vanilla batches parallel tool calls into a single turn while codemode
 * issues one cell per turn — so a turn cap silently penalizes codemode's style.
 * Wall-clock penalizes it too. A dollar budget asks the question the experiment
 * actually cares about: given the same spend, which arm gets further?
 */
function enforceBudget() {
	if (maxCost > 0 && summary.cost >= maxCost) {
		summary.budgetExceeded = true;
		child.kill("SIGKILL");
	}
	if (maxTurns > 0 && summary.turns >= maxTurns) {
		summary.turnCapReached = true;
		child.kill("SIGKILL");
	}
}

child.stderr.on("data", (d) => {
	stderr = (stderr + d).slice(-8000);
});

child.stdout.on("data", (chunk) => {
	streamFile.write(chunk);
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.startsWith("{")) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "tool_execution_start") {
			summary.toolCalls++;
			summary.toolNames.push(event.toolName);
		} else if (event.type === "tool_execution_end" && event.isError) {
			summary.toolErrors++;
			const text = (event.result?.content ?? []).map((c) => c.text ?? "").join(" ");
			summary.errorMessages.push(text.slice(0, 300));
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			const message = event.message;
			const texts = (message.content ?? []).filter((c) => c.type === "text" && c.text);
			if (texts.length > 0) summary.finalText = texts.map((c) => c.text).join("");
			const id = message.responseId;
			if (id && !counted.has(id) && message.usage?.totalTokens) {
				counted.add(id);
				summary.turns++;
				for (const k of ["input", "output", "cacheRead", "cacheWrite"]) summary[k] += message.usage[k] ?? 0;
				summary.cost += message.usage.cost?.total ?? 0;
				enforceBudget();
			}
		}
	}
});

child.on("close", (code) => {
	clearTimeout(killTimer);
	streamFile.end();
	summary.exitCode = code;
	summary.wallMs = Date.now() - started;
	summary.stderrTail = stderr.split("\n").slice(-8).join("\n");
	summary.maxCost = maxCost;
	// A run stopped by the budget is not a failed run — it is a run that spent
	// its allowance. Reported separately from timeouts so the two never merge.
	summary.stopReason = summary.budgetExceeded
		? "budget"
		: summary.turnCapReached
			? "turn-cap"
			: summary.timedOut
				? "timeout"
				: "completed";
	writeFileSync(join(runDir, "result.json"), `${JSON.stringify({ ...meta, summary }, null, 2)}\n`);

	const tally = [...new Set(summary.toolNames)].join(",") || "none";
	console.log(
		`${arm}/${residency} ${taskId}: ${summary.turns} turns, ${summary.toolCalls} calls (${tally}), ` +
			`${summary.toolErrors} errors, $${summary.cost.toFixed(4)}, ${(summary.wallMs / 1000).toFixed(0)}s` +
			`${summary.stopReason === "completed" ? "" : ` [${summary.stopReason.toUpperCase()}]`}`,
	);
	console.log(`  -> ${runDir}`);
	process.exit(0);
});
