#!/usr/bin/env node
/**
 * Run one MCP-Bench task through Claude Code, as a third arm.
 *
 *   bench/run-claude-code.mjs <env-file> <task-id> [--timeout 1800]
 *
 * Claude Code is a production harness with its own tool set, prompting and
 * agent loop — none of which we control or tuned. That is the point: our two
 * arms are things we built, and a reference point we did not build says whether
 * either is actually good.
 *
 * Same footing as the other arms: the task's catalogue is exposed through
 * bench/mcp-shim.mjs under identical wire names, every call lands in the same
 * proxy log, and the judge reads the same trajectory format.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findTask } from "./tasks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const [envFile, taskId] = positional;

if (!envFile || !taskId) {
	console.error("usage: bench/run-claude-code.mjs <env-file> <task-id> [--timeout 1800]");
	process.exit(2);
}

const timeoutSec = Number(flag("timeout", 1800));
const task = findTask(taskId);
const runId = flag("run-id", `${taskId}__claude-code__native__claude-code`);
const runDir = join(ROOT, ".run/runs", runId);
mkdirSync(runDir, { recursive: true });

// One shim server carrying the task's whole catalogue, so Claude Code sees the
// same N tools the vanilla arm does rather than 27 separate connections.
const mcpConfig = {
	mcpServers: {
		harness: {
			command: "node",
			args: [join(ROOT, "bench/mcp-shim.mjs")],
			env: {
				HARNESS_MCP_SERVERS: task.exposedServers.join(","),
				HARNESS_RUN_ID: runId,
				HARNESS_MCP_PROXY: process.env.HARNESS_MCP_PROXY ?? "http://127.0.0.1:8765",
			},
		},
	},
};
const configPath = join(runDir, "mcp-config.json");
writeFileSync(configPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);

const meta = {
	runId,
	arm: "claude-code",
	residency: "native",
	model: "claude-code",
	promptVariant: "native",
	task: {
		id: task.id,
		tier: task.tier,
		servers: task.servers,
		exposedServers: task.exposedServers,
		droppedDistractors: task.droppedDistractors ?? [],
	},
	startedAt: new Date().toISOString(),
};
writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

const child = spawn(
	"bash",
	[
		"-c",
		`set -a; . "$1"; set +a; shift; exec "$@"`,
		"_",
		envFile,
		"claude",
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--mcp-config",
		configPath,
		"--dangerously-skip-permissions",
		task.fuzzy,
	],
	{
		cwd: runDir,
		env: {
			...process.env,
			PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`,
			// Same egress block as the other arms. Claude Code keeps its native
			// tools — it is a reference point, not a matched arm, and stripping them
			// would measure a harness nobody ships — but it must not reach the APIs
			// its MCP tools wrap. It used Bash 6 times in the smoke test, and
			// vanilla curling past its own tools was the worst confound in this
			// project.
			...(process.env.HARNESS_ALLOW_DIRECT_NET === "1"
				? {}
				: {
						http_proxy: "http://127.0.0.1:9",
						https_proxy: "http://127.0.0.1:9",
						HTTP_PROXY: "http://127.0.0.1:9",
						HTTPS_PROXY: "http://127.0.0.1:9",
						no_proxy: "127.0.0.1,localhost,api.anthropic.com",
						NO_PROXY: "127.0.0.1,localhost,api.anthropic.com",
					}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	},
);

const streamFile = createWriteStream(join(runDir, "stream.jsonl"));
const started = Date.now();
const summary = { turns: 0, toolCalls: 0, toolNames: [], toolErrors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, finalText: "" };
let buffer = "";
let stderr = "";

const killTimer = setTimeout(() => {
	summary.timedOut = true;
	child.kill("SIGKILL");
}, timeoutSec * 1000);

child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
child.stdout.on("data", (chunk) => {
	streamFile.write(chunk);
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.startsWith("{")) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		// Claude Code's stream-json: assistant messages carry usage and tool_use
		// blocks; the final "result" event carries the answer and total cost.
		if (e.type === "assistant" && e.message) {
			summary.turns++;
			const u = e.message.usage ?? {};
			summary.input += u.input_tokens ?? 0;
			summary.output += u.output_tokens ?? 0;
			summary.cacheRead += u.cache_read_input_tokens ?? 0;
			summary.cacheWrite += u.cache_creation_input_tokens ?? 0;
			for (const c of e.message.content ?? []) {
				if (c.type === "tool_use") {
					summary.toolCalls++;
					summary.toolNames.push(c.name);
				}
			}
		} else if (e.type === "user" && e.message) {
			for (const c of e.message.content ?? []) {
				if (c.type === "tool_result" && c.is_error) summary.toolErrors++;
			}
		} else if (e.type === "result") {
			summary.finalText = e.result ?? summary.finalText;
			if (typeof e.total_cost_usd === "number") summary.cost = e.total_cost_usd;
		}
	}
});

child.on("close", (code) => {
	clearTimeout(killTimer);
	streamFile.end();
	summary.exitCode = code;
	summary.wallMs = Date.now() - started;
	summary.stderrTail = stderr.split("\n").slice(-6).join("\n");
	summary.stopReason = summary.timedOut ? "timeout" : "completed";
	writeFileSync(join(runDir, "result.json"), `${JSON.stringify({ ...meta, summary }, null, 2)}\n`);
	const tally = [...new Set(summary.toolNames)].length;
	console.log(
		`claude-code ${taskId}: ${summary.turns} turns, ${summary.toolCalls} calls (${tally} distinct), ` +
			`${summary.toolErrors} errors, $${summary.cost.toFixed(4)}, ${(summary.wallMs / 1000).toFixed(0)}s` +
			`${summary.timedOut ? " [TIMEOUT]" : ""}`,
	);
	process.exit(0);
});
