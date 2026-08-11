#!/usr/bin/env node
/**
 * Re-run the LLM judge k times over recorded inputs, and report agreement.
 *
 *   bench/tac/rejudge.mjs <env-file> [--k 5] [--dir .run/tac] [--task <name>]
 *
 * Offline: it replays `judge.jsonl`, so it needs no agent runs and no live
 * services. That is the whole point — the services are wiped by the next task's
 * reset.sh, and until judge inputs were recorded a disputed verdict could not be
 * re-examined at all. One checkpoint in this project is permanently
 * undiagnosable for exactly that reason.
 *
 * What it answers: is a given verdict stable, or is it a coin flip? 26 of 175
 * tasks grade at least one checkpoint this way, and the paired difference
 * between arms on the full set was +0.035 — small enough that judge instability
 * would matter if it existed. An earlier ad-hoc probe found 10/10 agreement on
 * one predicate, which is one predicate; this measures it properly.
 *
 * Deliberately reports disagreement rather than silently "fixing" scores. Any
 * rule for what to do about an unstable checkpoint (drop it, majority-vote it)
 * should be chosen before seeing which arm it favours.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 ? argv[i + 1] : d;
};
const envFile = argv.find((a) => !a.startsWith("--") && (a.includes("/") || a.includes(".env")));
if (!envFile) {
	console.error("usage: bench/tac/rejudge.mjs <env-file> [--k 5] [--task <name>]");
	process.exit(2);
}
const K = Number(flag("k", 5));
const RUNS = join(ROOT, flag("dir", ".run/tac"));
const onlyTask = flag("task", "");
const IMAGE_FOR = (t) => `ghcr.io/theagentcompany/${t}-image:1.0.0`;

/** Collect every recorded judge call, tagged with the run it came from. */
const calls = [];
for (const d of readdirSync(RUNS)) {
	const f = join(RUNS, d, "judge.jsonl");
	if (!existsSync(f)) continue;
	const meta = JSON.parse(readFileSync(join(RUNS, d, "result.json"), "utf8"));
	if (onlyTask && meta.task !== onlyTask) continue;
	for (const line of readFileSync(f, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			calls.push({ ...JSON.parse(line), task: meta.task, arm: meta.arm, dir: d });
		} catch {
			// A truncated trailing line is not worth failing the analysis over.
		}
	}
}

if (calls.length === 0) {
	console.error(`no judge.jsonl found under ${RUNS} — only runs graded after judge tracing was added have one`);
	process.exit(1);
}
console.log(`${calls.length} recorded judge calls across ${new Set(calls.map((c) => c.task)).size} tasks; k=${K}\n`);

/** One container per task image, reused for all that task's predicates. */
const byTask = new Map();
for (const c of calls) {
	if (!byTask.has(c.task)) byTask.set(c.task, []);
	byTask.get(c.task).push(c);
}

const sh = (cmd) =>
	new Promise((resolve) => {
		const p = spawn("bash", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", () => {});
		p.on("close", () => resolve(out));
	});

const results = [];
for (const [task, taskCalls] of byTask) {
	const cname = `tac-rejudge-${task}`.slice(0, 60);
	await sh(`docker rm -fv ${cname} 2>/dev/null`);
	await sh(`docker run -d --name ${cname} --platform linux/amd64 --network host ${IMAGE_FOR(task)} sleep infinity`);

	// The payload goes in as a file: predicates contain quotes and newlines, and
	// shell-escaping them is how you get a corrupted experiment.
	const payload = taskCalls.map((c) => ({ content: c.content, predicate: c.predicate, verdict: c.verdict }));
	const tmp = join(RUNS, `.rejudge-${task}.json`);
	writeFileSync(tmp, JSON.stringify(payload));
	await sh(`docker cp ${tmp} ${cname}:/tmp/payload.json`);

	const script = `
import json, sys
sys.path.insert(0, "/utils")
from common import evaluate_with_llm
calls = json.load(open("/tmp/payload.json"))
for i, c in enumerate(calls):
    votes = [bool(evaluate_with_llm(c["content"], c["predicate"])) for _ in range(${K})]
    print(json.dumps({"i": i, "original": c["verdict"], "votes": votes}))
`;
	writeFileSync(tmp, script);
	await sh(`docker cp ${tmp} ${cname}:/tmp/rejudge.py`);

	const out = await sh(
		`set -a; . "${envFile}"; set +a; docker exec ` +
			`-e LITELLM_API_KEY="$ANTHROPIC_API_KEY" ` +
			`-e LITELLM_BASE_URL="${process.env.HARNESS_TAC_LLM_BASE ?? "https://api.anthropic.com/v1/"}" ` +
			`-e LITELLM_MODEL="${process.env.HARNESS_TAC_LLM_MODEL ?? "openai/claude-sonnet-5"}" ` +
			`${cname} python_default /tmp/rejudge.py 2>/dev/null`,
	);
	await sh(`docker rm -fv ${cname} 2>/dev/null`);

	for (const line of out.split("\n")) {
		if (!line.trim().startsWith("{")) continue;
		const r = JSON.parse(line);
		const c = taskCalls[r.i];
		const trues = r.votes.filter(Boolean).length;
		results.push({ task, arm: c.arm, predicate: c.predicate, original: r.original, trues, k: K, votes: r.votes });
	}
}

console.log("=".repeat(78));
const unstable = results.filter((r) => r.trues !== 0 && r.trues !== r.k);
const flipped = results.filter((r) => (r.trues > r.k / 2) !== r.original);
for (const r of results) {
	const stable = r.trues === 0 || r.trues === r.k;
	const mark = !stable ? "UNSTABLE" : (r.trues > 0) !== r.original ? "FLIPPED " : "stable  ";
	console.log(`${mark} ${r.task.slice(0, 34).padEnd(34)} ${r.arm.padEnd(9)} orig=${String(r.original).padEnd(5)} ${r.trues}/${r.k} true`);
	if (!stable) console.log(`         predicate: ${r.predicate.slice(0, 96)}`);
}
console.log(
	`\n${results.length} predicates re-judged: ${results.length - unstable.length} stable, ` +
		`${unstable.length} unstable, ${flipped.length} whose majority disagrees with the recorded verdict`,
);
if (unstable.length === 0) {
	console.log("Judge is deterministic on this sample — LLM-judge noise is not an explanation for score differences.");
}
