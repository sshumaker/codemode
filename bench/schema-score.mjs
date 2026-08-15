#!/usr/bin/env node
/**
 * Rule-based schema metrics, matching MCP-Bench's evaluator.
 *
 *   bench/schema-score.mjs [--prefix quick__]
 *
 * MCP-Bench's published Overall Score is not the six LLM-judged dimensions
 * alone — it also averages in rule-based measures (`benchmark/evaluator.py`):
 *
 *   valid_tool_name_rate      valid_tool_calls / total_calls
 *   input_schema_compliance   schema_compliant_calls / valid_tool_calls
 *
 * The denominator is every call the agent ATTEMPTED. An earlier version computed
 * these from the proxy log, which only records calls that already resolved to a
 * real tool with parseable arguments — so both metrics were 1.000 by
 * construction, for every arm and every model, and inflated the overall score.
 *
 * Attempts are therefore reconstructed from the harness event stream:
 *
 *   vanilla   one tool_execution_start per attempt. The provider rejects unknown
 *             names before they reach us, and prime reports "Tool X not found",
 *             so both failure modes appear as errored executions.
 *   codemode  attempts live inside Python. Calls are parsed out of the cell
 *             source (`await <alias>.<tool>(...)`), and an AttributeError or
 *             TypeError in the result marks a bad name or bad arguments.
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
/** Every real tool, indexed by both its MCP name and its python identifier. */
const byMcpName = new Map();
const byPyName = new Map();
// The REAL identifier mapping, imported — a local re-implementation here lacked
// the leading-digit prefix and keyword suffix generate.mjs applies, so a tool
// emitted as `from_` / `t_2fa_verify` missed byPyName and was scored as an
// INVALID tool name against codemode, depressing valid_tool_name_rate
// (2026-08-15 review, P0.1). Import it; never copy it.
const { pyIdent } = await import("./generate.mjs");
for (const s of catalogue) {
	for (const t of s.tools) {
		byMcpName.set(`${s.server}::${t.name}`, t);
		byPyName.set(pyIdent(t.name), t);
	}
}

const proxyCalls = existsSync(MCP_LOG)
	? readFileSync(MCP_LOG, "utf8")
			.split("\n")
			.filter((l) => l.startsWith("{"))
			.map((l) => JSON.parse(l))
			.filter((r) => r.kind === "call")
	: [];
const proxyByRun = new Map();
for (const c of proxyCalls) {
	const id = c.meta?.runId;
	if (!id) continue;
	if (!proxyByRun.has(id)) proxyByRun.set(id, []);
	proxyByRun.get(id).push(c);
}

/** Required args present, no unknown args. */
function compliant(tool, args) {
	const schema = tool.inputSchema ?? {};
	const props = Object.keys(schema.properties ?? {});
	const required = schema.required ?? [];
	const given = Object.keys(args ?? {});
	if (required.some((r) => !given.includes(r))) return false;
	if (props.length === 0) return true;
	return given.every((g) => props.includes(g));
}

const BUILTINS = new Set(["read", "edit", "write", "grep", "find", "ls", "bash", "ipython"]);
const BAD_NAME = /not found|unknown tool|no attribute|AttributeError|ModuleNotFoundError|ImportError/i;
const BAD_ARGS = /TypeError|unexpected keyword|missing \d+ required|invalid_?type|validation error/i;

function events(dir) {
	const path = join(dir, "stream.jsonl");
	if (!existsSync(path)) return [];
	const out = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			/* truncated tail */
		}
	}
	return out;
}

/** Attempted MCP calls for one run: {total, validName, compliant}. */
function attempts(dir, run) {
	const evs = events(dir);
	let total = 0;
	let validName = 0;
	let ok = 0;

	if (run.arm === "vanilla") {
		for (let i = 0; i < evs.length; i++) {
			const e = evs[i];
			if (e.type !== "tool_execution_start" || BUILTINS.has(e.toolName)) continue;
			total++;
			const end = evs.slice(i + 1).find((x) => x.type === "tool_execution_end" && x.toolCallId === e.toolCallId);
			const text = ((end?.result?.content ?? []).map((c) => c.text ?? "").join(" ") || "").slice(0, 400);
			if (end?.isError && BAD_NAME.test(text)) continue;
			validName++;
			// Resolve the wire name back to a real tool to check its arguments.
			const match = [...byMcpName.entries()].find(([k]) => k.endsWith(`::${e.toolName.split("__").slice(1).join("__")}`));
			if (!match) {
				ok++;
				continue;
			}
			if (!(end?.isError && BAD_ARGS.test(text)) && compliant(match[1], e.args)) ok++;
		}
		return { total, validName, compliant: ok };
	}

	// codemode: attempts are `await <alias>.<tool>(...)` inside a cell.
	const CALL = /await\s+(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*)\s*\(/g;
	for (let i = 0; i < evs.length; i++) {
		const e = evs[i];
		if (e.type !== "tool_execution_start" || e.toolName !== "ipython") continue;
		const code = (e.args ?? {}).code ?? "";
		const end = evs.slice(i + 1).find((x) => x.type === "tool_execution_end" && x.toolCallId === e.toolCallId);
		const text = ((end?.result?.content ?? []).map((c) => c.text ?? "").join(" ") || "").slice(0, 800);
		for (const m of code.matchAll(CALL)) {
			const fn = m[1];
			// asyncio plumbing is not a tool call.
			if (["gather", "sleep", "wait", "run", "create_task", "to_thread"].includes(fn)) continue;
			const tool = byPyName.get(fn);
			if (!tool && !byPyName.has(fn)) {
				// Only count it as an attempted tool call if it looks like one.
				if (!/^[a-z][\w]*$/i.test(fn)) continue;
				total++;
				if (BAD_NAME.test(text)) continue;
				validName++;
				ok++;
				continue;
			}
			total++;
			if (BAD_NAME.test(text)) continue;
			validName++;
			if (!BAD_ARGS.test(text)) ok++;
		}
	}
	// Fall back to the proxy count when parsing found nothing but calls happened.
	const proxied = (proxyByRun.get(run.runId) ?? []).length;
	if (total === 0 && proxied > 0) return { total: proxied, validName: proxied, compliant: proxied };
	return { total, validName, compliant: ok };
}

const rows = [];
for (const name of readdirSync(RUNS)) {
	if (prefix && !name.startsWith(prefix)) continue;
	const path = join(RUNS, name, "result.json");
	if (!existsSync(path)) continue;
	const run = JSON.parse(readFileSync(path, "utf8"));
	if (run.arm === "notools") continue;

	const a = attempts(join(RUNS, name), run);
	if (a.total === 0) continue;

	run.schemaScore = {
		attemptedCalls: a.total,
		validToolNameRate: a.validName / a.total,
		inputSchemaCompliance: a.validName ? a.compliant / a.validName : 0,
	};
	writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
	rows.push({ arm: run.arm, ...run.schemaScore });
}

const by = {};
for (const r of rows) (by[r.arm] ??= []).push(r);
const mean = (xs, f) => (xs.length ? xs.reduce((a, r) => a + f(r), 0) / xs.length : 0);
console.log(`${rows.length} runs scored\n`);
console.log(`${"arm".padEnd(10)}${"n".padStart(5)}${"attempts".padStart(11)}${"valid_name".padStart(12)}${"schema_ok".padStart(11)}`);
for (const [arm, xs] of Object.entries(by)) {
	console.log(
		arm.padEnd(10) +
			String(xs.length).padStart(5) +
			mean(xs, (r) => r.attemptedCalls).toFixed(1).padStart(11) +
			mean(xs, (r) => r.validToolNameRate).toFixed(3).padStart(12) +
			mean(xs, (r) => r.inputSchemaCompliance).toFixed(3).padStart(11),
	);
}
