#!/usr/bin/env node
/**
 * Rule-based schema metrics, matching MCP-Bench's evaluator.
 *
 *   bench/schema-score.mjs [--prefix quick__]
 *
 * MCP-Bench's published Overall Score is not the six LLM-judged dimensions
 * alone — it also averages in rule-based measures computed from the trajectory
 * (`benchmark/evaluator.py`):
 *
 *   valid_tool_name_rate      valid_tool_calls / total_calls
 *   input_schema_compliance   schema_compliant_calls / valid_tool_calls
 *
 * These sit near 1.0 for a competent model, so omitting them makes our numbers
 * look far worse than the leaderboard rather than merely different. Computing
 * them from the proxy log is what makes a comparison honest.
 *
 * Writes `schemaScore` into each run's result.json.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, ".run/runs");
const MCP_LOG = join(ROOT, ".run/mcp-calls.jsonl");
const SCHEMAS = join(ROOT, "bench/data/mcp-schemas.json");

const argv = process.argv.slice(2);
const prefix = argv.includes("--prefix") ? argv[argv.indexOf("--prefix") + 1] : null;

const { catalogue } = JSON.parse(readFileSync(SCHEMAS, "utf8"));
const toolIndex = new Map();
for (const s of catalogue) {
	for (const t of s.tools) toolIndex.set(`${s.server}::${t.name}`, t);
}

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
	if (!id) continue;
	if (!byRun.has(id)) byRun.set(id, []);
	byRun.get(id).push(c);
}

/** A call is schema-compliant when every required arg is present and no arg is unknown. */
function compliant(tool, args) {
	const schema = tool.inputSchema ?? {};
	const props = Object.keys(schema.properties ?? {});
	const required = schema.required ?? [];
	const given = Object.keys(args ?? {});
	if (required.some((r) => !given.includes(r))) return false;
	// Servers with no declared properties accept anything.
	if (props.length === 0) return true;
	return given.every((g) => props.includes(g));
}

const rows = [];
for (const name of readdirSync(RUNS)) {
	if (prefix && !name.startsWith(prefix)) continue;
	const path = join(RUNS, name, "result.json");
	if (!existsSync(path)) continue;
	const run = JSON.parse(readFileSync(path, "utf8"));
	const mine = byRun.get(run.runId) ?? [];
	if (mine.length === 0) continue;

	let valid = 0;
	let ok = 0;
	for (const c of mine) {
		const tool = toolIndex.get(`${c.server}::${c.tool}`);
		if (!tool) continue;
		valid++;
		if (compliant(tool, c.args)) ok++;
	}

	run.schemaScore = {
		totalCalls: mine.length,
		validToolNameRate: mine.length ? valid / mine.length : 0,
		inputSchemaCompliance: valid ? ok / valid : 0,
	};
	writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
	rows.push({ run: name.slice(0, 46), variant: run.promptVariant ?? run.arm, ...run.schemaScore });
}

const mean = (f) => (rows.length ? rows.reduce((a, r) => a + f(r), 0) / rows.length : 0);
console.log(`${rows.length} runs scored`);
console.log(`  valid_tool_name_rate    ${mean((r) => r.validToolNameRate).toFixed(3)}`);
console.log(`  input_schema_compliance ${mean((r) => r.inputSchemaCompliance).toFixed(3)}`);
