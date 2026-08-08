#!/usr/bin/env node
/**
 * Inspect a run: what the agent was told, what it did, what it cost.
 *
 *   bench/inspect.mjs <runId|path>            # readable transcript
 *   bench/inspect.mjs <runId> --prompt        # the exact appended system prompt
 *   bench/inspect.mjs <runId> --mcp           # MCP calls made, from the proxy log
 *   bench/inspect.mjs --list                  # all runs, newest first
 *   bench/inspect.mjs --compare <taskId>      # every arm that ran this task
 *
 * The point is complete visibility: a run that "worked" but never touched an
 * MCP server, or burned its turns grepping, looks identical in the summary
 * numbers and completely different here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, ".run/runs");
const MCP_LOG = join(ROOT, ".run/mcp-calls.jsonl");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const target = argv.find((a) => !a.startsWith("--"));

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

const runDir = (id) => (existsSync(id) ? id : join(RUNS, id));

function listRuns() {
	if (!existsSync(RUNS)) return [];
	return readdirSync(RUNS)
		.map((name) => ({ name, path: join(RUNS, name) }))
		.filter((r) => existsSync(join(r.path, "result.json")))
		.map((r) => ({ ...r, mtime: statSync(join(r.path, "result.json")).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
}

function readResult(dir) {
	return JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
}

/** Replay the event stream into the sequence of things that actually happened. */
function events(dir) {
	const path = join(dir, "stream.jsonl");
	if (!existsSync(path)) return [];
	const out = [];
	const seenText = new Set();
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.startsWith("{")) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type === "tool_execution_start") {
			out.push({ kind: "call", tool: e.toolName, args: e.args });
		} else if (e.type === "tool_execution_end") {
			const text = (e.result?.content ?? []).map((c) => c.text ?? "").join("\n");
			out.push({ kind: "result", tool: e.toolName, isError: !!e.isError, text });
		} else if (e.type === "message_end" && e.message?.role === "assistant") {
			for (const c of e.message.content ?? []) {
				if (c.type === "text" && c.text && !seenText.has(c.text)) {
					seenText.add(c.text);
					out.push({ kind: "text", text: c.text });
				}
			}
			const u = e.message.usage;
			if (u?.totalTokens && e.message.responseId && !seenText.has(e.message.responseId)) {
				seenText.add(e.message.responseId);
				out.push({ kind: "usage", usage: u });
			}
		}
	}
	return out;
}

function mcpCalls(runId) {
	if (!existsSync(MCP_LOG)) return [];
	return readFileSync(MCP_LOG, "utf8")
		.split("\n")
		.filter((l) => l.startsWith("{"))
		.map((l) => JSON.parse(l))
		.filter((r) => r.kind === "call" && (!runId || r.meta?.runId === runId));
}

function showRun(dir) {
	const r = readResult(dir);
	const s = r.summary;

	console.log(bold(`\n${r.arm}/${r.residency}  ${r.task.id}  (${r.model})`));
	console.log(dim(`  servers: ${r.task.servers.join(", ")}  |  exposed: ${r.task.exposedServers.length}`));
	if (r.task.droppedDistractors?.length) {
		console.log(dim(`  dropped distractors: ${r.task.droppedDistractors.join(", ")}`));
	}
	console.log(
		dim(
			`  ${s.turns} turns, ${s.toolCalls} calls, ${s.toolErrors} errors, ` +
				`$${s.cost.toFixed(4)}, ${(s.wallMs / 1000).toFixed(0)}s${s.timedOut ? red(" TIMED OUT") : ""}`,
		),
	);
	console.log(dim(`  preamble: ${r.preambleChars} chars`));

	const calls = mcpCalls(r.runId);
	const okCalls = calls.filter((c) => c.ok).length;
	console.log(
		dim(`  MCP: ${calls.length} calls (${okCalls} ok, ${calls.length - okCalls} failed)`) +
			(calls.length === 0 ? red("  <- never reached an MCP server") : ""),
	);

	console.log();
	for (const e of events(dir)) {
		if (e.kind === "call") {
			const args = JSON.stringify(e.args ?? {});
			const shown = e.args?.code ?? args;
			console.log(cyan(`  ▶ ${e.tool}`));
			for (const line of String(shown).split("\n").slice(0, 24)) console.log(`      ${line}`);
			if (String(shown).split("\n").length > 24) console.log(dim("      …"));
		} else if (e.kind === "result") {
			const head = e.text.split("\n").slice(0, 8).join("\n      ");
			console.log(e.isError ? red(`    ✗ ${head.slice(0, 500)}`) : dim(`    → ${head.slice(0, 500)}`));
			if (e.text.length > 500) console.log(dim(`      … ${e.text.length} chars total`));
		} else if (e.kind === "text") {
			console.log(green(`  ● ${e.text.slice(0, 1200)}`));
		} else if (e.kind === "usage") {
			const u = e.usage;
			console.log(
				dim(`    [in ${u.input} out ${u.output} cacheR ${u.cacheRead} cacheW ${u.cacheWrite} $${u.cost.total.toFixed(4)}]`),
			);
		}
	}
	console.log();
}

// --- entry points -------------------------------------------------------------

if (has("list") || (!target && !has("compare"))) {
	const runs = listRuns();
	if (runs.length === 0) {
		console.log("no runs yet");
		process.exit(0);
	}
	const rows = runs.map(({ name, path }) => {
		const r = readResult(path);
		const s = r.summary;
		const calls = mcpCalls(r.runId);
		return {
			task: r.task.id.slice(0, 34),
			arm: `${r.arm}/${r.residency}`,
			turns: s.turns,
			tools: s.toolCalls,
			mcp: calls.length,
			err: s.toolErrors,
			cost: `$${s.cost.toFixed(4)}`,
			sec: Math.round(s.wallMs / 1000),
			ok: s.timedOut ? "TIMEOUT" : s.exitCode === 0 ? "ok" : `exit ${s.exitCode}`,
		};
	});
	console.table(rows);
	process.exit(0);
}

if (has("compare")) {
	const taskId = argv[argv.indexOf("--compare") + 1];
	const runs = listRuns().filter((r) => readResult(r.path).task.id === taskId);
	if (runs.length === 0) {
		console.error(`no runs for task ${taskId}`);
		process.exit(1);
	}
	console.table(
		runs.map(({ path }) => {
			const r = readResult(path);
			const s = r.summary;
			const calls = mcpCalls(r.runId);
			return {
				arm: `${r.arm}/${r.residency}`,
				turns: s.turns,
				tools: s.toolCalls,
				mcp: calls.length,
				mcpOk: calls.filter((c) => c.ok).length,
				err: s.toolErrors,
				tokens: s.input + s.output + s.cacheRead + s.cacheWrite,
				cost: `$${s.cost.toFixed(4)}`,
				sec: Math.round(s.wallMs / 1000),
			};
		}),
	);
	process.exit(0);
}

const dir = runDir(target);
if (!existsSync(join(dir, "result.json"))) {
	console.error(`no run at ${dir}`);
	process.exit(1);
}

if (has("prompt")) {
	console.log(readFileSync(join(dir, "prompt.txt"), "utf8"));
	process.exit(0);
}

if (has("mcp")) {
	const r = readResult(dir);
	const calls = mcpCalls(r.runId);
	if (calls.length === 0) {
		console.log("no MCP calls recorded for this run");
		process.exit(0);
	}
	for (const c of calls) {
		const status = c.ok ? green("ok") : red("FAIL");
		console.log(`${status} ${c.server}.${c.tool} ${dim(`${c.ms}ms ${c.resultChars ?? 0} chars`)}`);
		console.log(dim(`    args: ${JSON.stringify(c.args).slice(0, 200)}`));
		if (!c.ok) console.log(red(`    ${c.error}`));
		else if (c.resultPreview) console.log(dim(`    → ${c.resultPreview.slice(0, 200).replace(/\n/g, " ")}`));
	}
	process.exit(0);
}

showRun(dir);
