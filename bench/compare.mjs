#!/usr/bin/env node
/**
 * Run one task through both arms and emit a comparable record.
 *
 *   bench/compare.mjs <env-file> <model> "<prompt>" [--json]
 *
 * Arms run sequentially against identical prompts, identical flags, and a fresh
 * agent home each time — nothing carries between them. Emits per-arm turns,
 * tool calls, token usage, cost, and the final text, so results accumulate into
 * something aggregatable rather than needing to be read off a terminal.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARMS = ["vanilla", "codemode"];

const [envFile, model, prompt, ...rest] = process.argv.slice(2);
const asJson = rest.includes("--json");

if (!envFile || !model || !prompt) {
	console.error('usage: bench/compare.mjs <env-file> <model> "<prompt>" [--json]');
	process.exit(2);
}

/** Run one arm, parsing the JSON event stream into a summary. */
function runArm(arm) {
	return new Promise((resolve, reject) => {
		// A fresh agent home per arm: no session, kernel snapshot, or harness state
		// can leak from one arm into the other.
		const home = mkdtempSync(join(tmpdir(), `harness-${arm}-`));
		const started = Date.now();
		const child = spawn(join(ROOT, "bench/run.sh"), [envFile, arm, model, prompt], {
			env: { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: home },
			stdio: ["ignore", "pipe", "pipe"],
		});

		const summary = {
			arm,
			turns: 0,
			toolCalls: 0,
			toolNames: [],
			toolErrors: 0,
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

		child.stderr.on("data", (d) => (stderr += d));
		child.stdout.on("data", (chunk) => {
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
				} else if (event.type === "message_end" && event.message?.role === "assistant") {
					const message = event.message;
					const text = (message.content ?? []).filter((c) => c.type === "text" && c.text);
					if (text.length > 0) summary.finalText = text.map((c) => c.text).join("");

					// Assistant messages are emitted repeatedly; count usage once.
					const id = message.responseId;
					if (id && !counted.has(id) && message.usage?.totalTokens) {
						counted.add(id);
						summary.turns++;
						for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
							summary[k] += message.usage[k] ?? 0;
						}
						summary.cost += message.usage.cost?.total ?? 0;
					}
				}
			}
		});

		child.on("error", reject);
		child.on("close", (code) => {
			rmSync(home, { recursive: true, force: true });
			summary.exitCode = code;
			summary.wallMs = Date.now() - started;
			// Total context billed on the first turn: system prompt + tools + task.
			summary.firstTurnPrompt = summary.cacheWrite > 0 || summary.cacheRead > 0 ? undefined : undefined;
			if (code !== 0) summary.stderr = stderr.trim().split("\n").slice(-3).join("\n");
			resolve(summary);
		});
	});
}

const results = [];
for (const arm of ARMS) {
	results.push(await runArm(arm));
}

if (asJson) {
	console.log(JSON.stringify({ model, prompt, results }, null, 2));
} else {
	console.log(`\ntask: ${prompt}`);
	console.log(`model: ${model}\n`);
	console.table(
		results.map((r) => ({
			arm: r.arm,
			turns: r.turns,
			tools: r.toolCalls,
			errors: r.toolErrors,
			used: [...new Set(r.toolNames)].join(",") || "—",
			tokens: r.input + r.output + r.cacheRead + r.cacheWrite,
			cost: `$${r.cost.toFixed(5)}`,
			sec: (r.wallMs / 1000).toFixed(1),
			answer: r.finalText.slice(0, 40).replace(/\n/g, " "),
		})),
	);
	const [v, c] = results;
	if (v.cost > 0) {
		console.log(`codemode/vanilla cost: ${(c.cost / v.cost).toFixed(2)}x   turns: ${c.turns} vs ${v.turns}\n`);
	}
}
