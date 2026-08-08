#!/usr/bin/env node
/**
 * Combine run metrics and judge scores into the experiment's answer.
 *
 *   bench/report.mjs [--model ...] [--paired] [--csv]
 *
 * `--paired` restricts to tasks where every arm completed, which is the only
 * honest basis for comparison: an arm that timed out on the hard half of the
 * sample would otherwise look cheap and effective.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, ".run/runs");
const MCP_LOG = join(ROOT, ".run/mcp-calls.jsonl");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const modelFilter = flag("model", null);
const pairedOnly = argv.includes("--paired");

const calls = existsSync(MCP_LOG)
	? readFileSync(MCP_LOG, "utf8")
			.split("\n")
			.filter((l) => l.startsWith("{"))
			.map((l) => JSON.parse(l))
			.filter((r) => r.kind === "call")
	: [];

/** A well-formed MCP response can still carry an error payload. */
const looksLikeError = (preview) =>
	/"error"|status code [45]\d\d|\bexception\b|unauthorized|forbidden/i.test(preview ?? "");

const runs = readdirSync(RUNS)
	.map((n) => join(RUNS, n))
	.filter((d) => existsSync(join(d, "result.json")))
	.map((d) => JSON.parse(readFileSync(join(d, "result.json"), "utf8")))
	.filter((r) => !modelFilter || r.model === modelFilter);

for (const r of runs) {
	const mine = calls.filter((c) => c.meta?.runId === r.runId);
	r.mcp = {
		total: mine.length,
		failed: mine.filter((c) => !c.ok).length,
		contentErrors: mine.filter((c) => c.ok && looksLikeError(c.resultPreview)).length,
		resultChars: mine.reduce((n, c) => n + (c.resultChars ?? 0), 0),
	};
	r.armKey = `${r.arm}/${r.residency}`;
}

const armKeys = [...new Set(runs.map((r) => r.armKey))].sort();
const taskIds = [...new Set(runs.map((r) => r.task.id))].sort();

const complete = (r) => !r.summary.timedOut && r.summary.exitCode === 0;
const pairedTasks = taskIds.filter((id) => {
	const forTask = runs.filter((r) => r.task.id === id);
	return armKeys.every((a) => forTask.some((r) => r.armKey === a && complete(r)));
});

const scope = pairedOnly ? pairedTasks : taskIds;
const selected = runs.filter((r) => scope.includes(r.task.id));

console.log(`\nruns: ${runs.length}  tasks: ${taskIds.length}  fully-paired tasks: ${pairedTasks.length}`);
if (pairedOnly) console.log(`reporting on ${scope.length} paired tasks only`);
if (modelFilter) console.log(`model: ${modelFilter}`);

// --- per-run detail -----------------------------------------------------------
console.log("\nper run:");
console.table(
	selected
		.sort((a, b) => a.task.id.localeCompare(b.task.id) || a.armKey.localeCompare(b.armKey))
		.map((r) => ({
			task: r.task.id.slice(0, 26),
			arm: r.armKey,
			turns: r.summary.turns,
			mcp: r.mcp.total,
			bad: r.mcp.failed + r.mcp.contentErrors,
			tokens: r.summary.input + r.summary.output + r.summary.cacheRead + r.summary.cacheWrite,
			cost: +r.summary.cost.toFixed(3),
			sec: Math.round(r.summary.wallMs / 1000),
			score: r.judge?.overall ?? "—",
			fulfil: r.judge?.scores?.task_fulfillment ?? "—",
			status: r.summary.timedOut ? "TIMEOUT" : "ok",
		})),
);

// --- per-arm aggregate --------------------------------------------------------
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

console.log("\nper arm:");
console.table(
	armKeys.map((arm) => {
		const rs = selected.filter((r) => r.armKey === arm);
		const judged = rs.filter((r) => r.judge);
		return {
			arm,
			runs: rs.length,
			completed: rs.filter(complete).length,
			timeouts: rs.filter((r) => r.summary.timedOut).length,
			"no MCP": rs.filter((r) => r.mcp.total === 0).length,
			avgTurns: +mean(rs.map((r) => r.summary.turns)).toFixed(1),
			avgMcp: +mean(rs.map((r) => r.mcp.total)).toFixed(1),
			avgTokens: Math.round(
				mean(rs.map((r) => r.summary.input + r.summary.output + r.summary.cacheRead + r.summary.cacheWrite)),
			),
			avgCost: `$${mean(rs.map((r) => r.summary.cost)).toFixed(3)}`,
			avgSec: Math.round(mean(rs.map((r) => r.summary.wallMs / 1000))),
			avgScore: judged.length ? +mean(judged.map((r) => r.judge.overall)).toFixed(2) : "—",
			fulfil: judged.length ? +mean(judged.map((r) => r.judge.scores.task_fulfillment)).toFixed(2) : "—",
			ground: judged.length ? +mean(judged.map((r) => r.judge.scores.grounding)).toFixed(2) : "—",
		};
	}),
);

// --- head-to-head on paired tasks ---------------------------------------------
if (armKeys.length === 2 && pairedTasks.length > 0) {
	const [a, b] = armKeys;
	const deltas = pairedTasks
		.map((id) => {
			const ra = runs.find((r) => r.task.id === id && r.armKey === a && complete(r));
			const rb = runs.find((r) => r.task.id === id && r.armKey === b && complete(r));
			if (!ra || !rb) return null;
			return {
				task: id.slice(0, 30),
				[`${a} $`]: +ra.summary.cost.toFixed(3),
				[`${b} $`]: +rb.summary.cost.toFixed(3),
				costRatio: +(rb.summary.cost / ra.summary.cost).toFixed(2),
				turnRatio: +(rb.summary.turns / Math.max(1, ra.summary.turns)).toFixed(2),
				scoreDelta: ra.judge && rb.judge ? +(rb.judge.overall - ra.judge.overall).toFixed(2) : "—",
			};
		})
		.filter(Boolean);

	console.log(`\nhead to head (${b} relative to ${a}), paired tasks only:`);
	console.table(deltas);

	const ratios = deltas.map((d) => d.costRatio);
	const turns = deltas.map((d) => d.turnRatio);
	const scored = deltas.filter((d) => typeof d.scoreDelta === "number").map((d) => d.scoreDelta);
	console.log(`  mean cost ratio : ${mean(ratios).toFixed(2)}x  (${b} / ${a})`);
	console.log(`  mean turn ratio : ${mean(turns).toFixed(2)}x`);
	if (scored.length) {
		const wins = scored.filter((d) => d > 0).length;
		console.log(`  mean score delta: ${mean(scored) > 0 ? "+" : ""}${mean(scored).toFixed(2)}  (${b} wins ${wins}/${scored.length})`);
	} else {
		console.log("  mean score delta: not scored — run bench/judge.mjs");
	}
	console.log();
}
