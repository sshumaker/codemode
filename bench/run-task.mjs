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
import { mkdirSync, writeFileSync, createWriteStream, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./generate.mjs";
import { buildPreamble as buildCodemodePreamble } from "./prompts.mjs";
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
// `notools` is a validity control, not a competitor: it gives the model nothing
// and asks the same question. Any task it answers well cannot discriminate the
// arms, because success there does not depend on tool use at all.
if (!["vanilla", "codemode", "notools"].includes(arm)) {
	console.error(`unknown arm: ${arm}`);
	process.exit(2);
}

const residency = flag("residency", arm === "codemode" ? "L0" : arm === "notools" ? "none" : "L4");
const timeoutSec = Number(flag("timeout", 900));
// Budget cap in dollars — the arm-neutral control. 0 disables.
const maxCost = Number(flag("max-cost", 1.0));
// Optional hard turn cap, off by default (see enforceBudget).
const maxTurns = Number(flag("max-turns", 0));
const task = findTask(taskId);

// Codemode preamble variant — see bench/prompts.mjs and bench/hillclimb.mjs.
const promptName = flag("prompt", "v1");
const promptSuffix = arm === "codemode" && promptName !== "v1" ? `__${promptName}` : "";
const runId = flag("run-id", `${taskId}__${arm}__${residency}${promptSuffix}__${model.replace(/[^a-z0-9]/gi, "-")}`);
const runDir = join(ROOT, ".run/runs", runId);

// Never silently overwrite a completed run. A runId scheme change once caused
// two v1 runs to be replaced mid-experiment by re-runs that happened to reuse
// their ids, which quietly removed them (and their judge scores) from a result
// that had already been reported.
if (existsSync(join(runDir, "result.json")) && !argv.includes("--force")) {
	console.error(`run already exists: ${runId}\n  pass --force to overwrite, or delete the directory`);
	process.exit(3);
}
mkdirSync(runDir, { recursive: true });

/**
 * The codemode arm's system-prompt preamble.
 *
 * Even L0 must say the tree exists — an agent that does not know to look would
 * fail for a reason unrelated to the hypothesis. That pointer is the fixed cost
 * counted against codemode's savings in docs/DESIGN.md.
 */
function buildPreamble() {
	// vanilla L1: names resident, schemas on demand. Putting the names in the
	// prompt is what makes this L1 rather than L0 — a first attempt hid them
	// behind a search tool, and the model never looked, falling back to curl.
	if (arm === "vanilla" && residency === "L1") {
		const catalogue = JSON.parse(readFileSync(SCHEMAS, "utf8")).catalogue.filter((s) =>
			task.exposedServers.includes(s.server),
		);
		const { toolDefs } = generate(catalogue);
		return [
			"## Tools",
			"",
			`${toolDefs.length} tools are available. Their names are listed below; their parameter`,
			"schemas are not, to keep this prompt small.",
			"",
			"Load a tool before calling it:",
			"",
			"  load_tool(names=[\"Some_Server__some_tool\"])",
			"",
			"That returns its parameter schema and makes it directly callable for the",
			"rest of the session. You can load several at once.",
			"",
			"Available tool names:",
			...toolDefs.map((d) => d.name),
		].join("\n");
	}
	if (arm !== "codemode") return "";

	const catalogue = JSON.parse(readFileSync(SCHEMAS, "utf8")).catalogue.filter((s) =>
		task.exposedServers.includes(s.server),
	);
	const { tocLines, names } = generate(catalogue);
	const pointer = buildCodemodePreamble(promptName, {
		toolCount: tocLines.length,
		serverCount: catalogue.length,
	});

	if (residency === "L0") return pointer;
	if (residency === "L1") return `${pointer}\n\nAvailable tools:\n${names.join("\n")}`;
	if (residency === "L2") return `${pointer}\n\nAvailable tools:\n${tocLines.join("\n")}`;
	throw new Error(`unsupported residency for codemode: ${residency}`);
}

/**
 * Base system prompt, identical for every arm.
 *
 * prime's own base prompt is 6,284 chars for codemode and 615 for vanilla —
 * whole sections are gated on `hasIpython`, so the code arm was receiving 10x
 * more workflow guidance (guidance prime describes as trained) plus RLM subagent
 * instructions this experiment does not use. That makes the comparison "tuned
 * code prompt vs bare tool prompt" rather than code vs tools.
 *
 * Replacing it with one neutral prompt restores the matched pair required by
 * docs/DESIGN.md: identical framing, with only the tool-specific instructions
 * differing in the appended preamble.
 */
const BASE_SYSTEM_PROMPT = [
	"You are an agent that completes tasks using the tools available to you.",
	"Work step by step: decide what you need, use your tools to get it, and",
	"reason over the results.",
	"",
	"Ground every claim in something a tool actually returned. Do not state facts",
	"you have not retrieved.",
	"",
	"When the task is complete, stop calling tools and give your final answer.",
].join("\n");

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
	promptVariant: arm === "codemode" ? promptName : undefined,
	startedAt: new Date().toISOString(),
};

// The agent sees the fuzzy phrasing, which names no tools — retrieval is part
// of what is being measured.
const prompt = task.fuzzy;

// `--tools` is an *allowlist* (agent-session.ts:8473), not just an initial
// selection — anything absent is filtered out even if an extension registered
// it. The vanilla arm therefore has to name every MCP tool explicitly, or its
// 250 tool definitions silently never reach the model and it falls back to bash.
// No `bash` for the vanilla arm.
//
// A shell is an escape hatch out of the tool surface under test: 78% of this
// arm's bash calls were `curl` straight to the APIs its MCP tools wrap, so it
// was not exercising tool-calling at all, and the judge scored the results as
// ungrounded because they never appeared in the proxy log. Blocking egress by
// proxy env vars helps but raw sockets still evade it — removing the shell is
// the fix that actually holds.
//
// The remaining tools are local file operations, which MCP-Bench tasks do not
// need but which keep the arm from being crippled in some unrelated way. The
// codemode arm keeps `%%bash` because a shell nested inside the code action is
// part of what "code as the action space" means; a separate bash *tool* is not.
const BUILTINS = ["read", "edit", "write", "grep", "find", "ls"];
let toolList;
if (arm === "notools") {
	toolList = [];
} else if (arm === "vanilla") {
	const catalogue = JSON.parse(readFileSync(SCHEMAS, "utf8")).catalogue.filter((s) =>
		task.exposedServers.includes(s.server),
	);
	const { toolDefs } = generate(catalogue);
	meta.mcpToolCount = toolDefs.length;
	// L4 names every tool; L1 defers behind three meta-tools, which is what a
	// modern harness ships. Both must be listed here because --tools is an
	// allowlist that filters extension-registered tools too.
	// Both levels allowlist every tool — `--tools` is a permission list, not the
	// active set. L1 additionally narrows the *active* set at session start via
	// pi.setActiveTools, so the schemas stay out of context until loaded.
	toolList = [...BUILTINS, ...toolDefs.map((d) => d.name)];
	if (residency === "L1") toolList.push("search_tools", "load_tool");
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
	...(arm === "notools" ? ["--no-tools"] : ["--tools", tools]),
	// L1 allowlists all 250 but activates only the base set; load_tool activates
	// the rest on demand. Requires the --active-tools flag added by
	// scripts/neutralize-prime.mjs.
	...(arm === "vanilla" && residency === "L1"
		? ["--active-tools", [...BUILTINS, "search_tools", "load_tool"].join(",")]
		: []),
	"--cwd",
	runDir,
	"--no-skills",
	"--no-context-files",
	"--no-prompt-templates",
	"--system-prompt",
	BASE_SYSTEM_PROMPT,
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
			// Selects the vanilla extension's registration strategy: L4 registers
			// all 250 tools up front, L1 registers only search_tools/load_tool and
			// adds real tools on demand.
			HARNESS_RESIDENCY: residency,
			// Force all outbound API access through the MCP proxy.
			//
			// Measured: 78% of the vanilla arm's bash calls were `curl` straight to
			// the same APIs its MCP tools wrap (codemode: 11%). That contaminates the
			// comparison twice over — the arm is not using the tool surface under
			// test, and the judge, which only sees proxy-logged MCP calls, scores
			// curl-obtained facts as ungrounded. Vanilla bypassed far more, so it was
			// penalized more, on precisely the dimension where it trailed.
			//
			// The agent process gets a dead proxy for general egress; the MCP servers
			// live in a separate process tree (bench/mcp-proxy.mjs) and keep their
			// network. curl, requests, urllib and httpx all honour these.
			...(process.env.HARNESS_ALLOW_DIRECT_NET === "1"
				? {}
				: {
						http_proxy: "http://127.0.0.1:9",
						https_proxy: "http://127.0.0.1:9",
						HTTP_PROXY: "http://127.0.0.1:9",
						HTTPS_PROXY: "http://127.0.0.1:9",
						// The harness proxy and the model API must still work.
						no_proxy: "127.0.0.1,localhost,api.anthropic.com",
						NO_PROXY: "127.0.0.1,localhost,api.anthropic.com",
					}),
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
				// Total context billed on the first turn: system prompt + tools + task.
				// This is what residency actually controls, so it is what the guard checks.
				if (summary.turns === 0) {
					const u = message.usage;
					summary.firstTurnPromptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
				}
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

	// Residency guard. A run labelled L1 whose first turn still carries the full
	// tool catalogue is silently an L4 run under a different name, which would
	// corrupt every comparison it appears in. Fail it loudly instead.
	//
	// Known broken: --active-tools (added by scripts/neutralize-prime.mjs) does
	// not reach the print-mode path, so vanilla L1 currently does NOT defer.
	if (summary.firstTurnPromptTokens !== undefined) {
		const budget = { L0: 6_000, L1: 8_000, L2: 20_000, L4: Infinity, none: 6_000 }[residency] ?? Infinity;
		if (summary.firstTurnPromptTokens > budget) {
			summary.residencyViolation =
				`${residency} first turn carried ${summary.firstTurnPromptTokens} prompt tokens ` +
				`(budget ${budget}) — the catalogue was resident, so this is not a ${residency} run`;
		}
	}
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
