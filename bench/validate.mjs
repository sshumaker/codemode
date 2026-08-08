#!/usr/bin/env node
/**
 * Check recorded runs for known contamination, and optionally delete them.
 *
 *   bench/validate.mjs           # report
 *   bench/validate.mjs --delete  # remove contaminated runs so a sweep re-does them
 *
 * Every check here corresponds to a confound that was found live and silently
 * corrupted results. Running this before analysis is cheaper than discovering
 * afterwards that a headline was measured under a broken condition.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, ".run/runs");
const MCP_LOG = join(ROOT, ".run/mcp-calls.jsonl");
const doDelete = process.argv.includes("--delete");

const calls = existsSync(MCP_LOG)
	? readFileSync(MCP_LOG, "utf8")
			.split("\n")
			.filter((l) => l.startsWith("{"))
			.map((l) => JSON.parse(l))
			.filter((r) => r.kind === "call")
	: [];
const byRun = new Map();
for (const c of calls) {
	const id = c.meta?.runId;
	if (id) (byRun.get(id) ?? byRun.set(id, []).get(id)).push(c);
}

const RATE_LIMIT = /rate.?limit|too many requests|429/i;
/** Direct API access that skipped the MCP proxy entirely. */
const BYPASS = /\bcurl\b|\bwget\b|requests\.get|urllib\.request|httpx\./;

const problems = [];
for (const name of existsSync(RUNS) ? readdirSync(RUNS) : []) {
	const dir = join(RUNS, name);
	if (!existsSync(join(dir, "result.json"))) continue;
	const run = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
	const reasons = [];

	// Residency mislabelling: a run whose first turn contradicts its level.
	if (run.summary.residencyViolation) reasons.push("residency violation");

	// Rate-limited responses reaching the model as tool results.
	const mine = byRun.get(run.runId) ?? [];
	const limited = mine.filter((c) => RATE_LIMIT.test(c.resultPreview ?? "")).length;
	if (limited > 0) reasons.push(`${limited} rate-limited tool results`);

	// Network bypass: the arm left the tool surface under test.
	const stream = join(dir, "stream.jsonl");
	if (existsSync(stream)) {
		let bypass = 0;
		for (const line of readFileSync(stream, "utf8").split("\n")) {
			if (!line.startsWith("{")) continue;
			let e;
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			if (e.type !== "tool_execution_start") continue;
			const body = (e.args ?? {}).code ?? (e.args ?? {}).command ?? "";
			if (BYPASS.test(body) && !body.includes("127.0.0.1")) bypass++;
		}
		if (bypass > 0) reasons.push(`${bypass} network-bypass attempts`);
	}

	// Zero tool calls on a task that requires tools means the arm was never wired
	// up — an extension that failed to load, or an empty allowlist. It scores at
	// the floor and is indistinguishable from a genuine capability result.
	if (run.arm !== "notools" && run.summary.toolCalls === 0) {
		reasons.push("no tool calls at all — arm likely not wired up");
	}
	if (/Failed to load extension/.test(run.summary.stderrTail ?? "")) {
		reasons.push("extension failed to load");
	}

	// A judged run with no stability estimate predates multi-sample judging.
	if (run.judge && !run.judge.samples) reasons.push("single-sample judge score");

	if (reasons.length > 0) problems.push({ run: name, reasons });
}

const total = existsSync(RUNS) ? readdirSync(RUNS).filter((n) => existsSync(join(RUNS, n, "result.json"))).length : 0;
console.log(`${total} runs, ${problems.length} contaminated\n`);
for (const p of problems) console.log(`  ${p.run.slice(0, 62)}\n      ${p.reasons.join("; ")}`);

if (doDelete && problems.length > 0) {
	for (const p of problems) rmSync(join(RUNS, p.run), { recursive: true, force: true });
	console.log(`\ndeleted ${problems.length} runs — re-run the sweep to refill`);
} else if (problems.length > 0) {
	console.log("\npass --delete to remove them, then re-run the sweep");
}
