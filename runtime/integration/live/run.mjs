#!/usr/bin/env node
/**
 * `npm run test:live -- --env-file PATH [--max-cost USD] [<node --test args>]`
 *
 * The live tier: the same worlds as test:integration, with a real model and (when
 * DAYTONA_API_KEY is set) real Daytona sandboxes. It costs money, so it never runs by
 * default and never reads credentials itself:
 *
 *   - the env file is SOURCED BY A SUBSHELL (`bash -c 'set -a; . FILE; exec node --test …'`),
 *     so its values exist only in the test processes' environment; this runner never
 *     opens it, and refuses one inside the repository (it must never be committed);
 *   - no env file → a clear skip message and exit 0;
 *   - --max-cost (default $1.00, HARNESS_LIVE_MAX_COST) caps the run: every live
 *     scenario records what it spent in a per-run ledger and the next one is skipped
 *     once the cap is reached;
 *   - every Daytona sandbox carries a per-run owner label and is deleted in the
 *     suite's `after`, which then asserts none remain.
 *
 * Env file variables: ANTHROPIC_API_KEY (or OPENROUTER_API_KEY / ZAI_API_KEY with
 * HARNESS_LIVE_MODEL), optional DAYTONA_API_KEY (+ DAYTONA_API_URL, DAYTONA_TARGET),
 * optional HARNESS_LIVE_MODEL (default anthropic/claude-haiku-4-5).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, missingPrereqs, processesUnder, stopProcesses } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// package.json runs this as `run.mjs -- <args>`: Node 25 treats an `--env-file` that
// follows the script as ITS OWN flag — it would load the credentials into this
// runner's environment (and exit 9 if the file is absent). After `--` it is ours.
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const take = (flag) => {
	const i = args.indexOf(flag);
	return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const envFile = resolve(take("--env-file") ?? process.env.HARNESS_LIVE_ENV_FILE ?? join(homedir(), ".config/harness/live.env"));
const maxCost = Number(take("--max-cost") ?? process.env.HARNESS_LIVE_MAX_COST ?? "1.00");

if (!existsSync(envFile)) {
	console.log(
		`test:live: SKIPPED — no env file at ${envFile}.\n` +
			"Create one OUTSIDE the repository, e.g. ~/.config/harness/live.env:\n" +
			"  ANTHROPIC_API_KEY=...        # the model scenarios\n" +
			"  DAYTONA_API_KEY=...          # optional: the Daytona backend scenarios\n" +
			"then: npm run test:live -- --env-file ~/.config/harness/live.env [--max-cost 1.00]",
	);
	process.exit(0);
}
const real = realpathSync(envFile);
if (real.startsWith(`${realpathSync(ROOT)}/`)) {
	console.error(`test:live: refusing an env file inside the repository (${real}); keep credentials outside it.`);
	process.exit(2);
}
if (!(maxCost > 0)) {
	console.error("test:live: --max-cost must be a positive number of USD");
	process.exit(2);
}
const missing = missingPrereqs();
if (missing.length) {
	console.error(`test:live cannot run:\n  - ${missing.join("\n  - ")}\nRun scripts/dev-env.sh.`);
	process.exit(2);
}

const files = readdirSync(HERE)
	.filter((f) => f.endsWith(".live.test.mjs"))
	.sort()
	.map((f) => join(HERE, f));
const base = realpathSync(mkdtempSync("/tmp/hit-live-"));
const ledger = join(base, "cost.jsonl");
const t0 = Date.now();
// The env file is sourced here, in bash, and exported only to the test processes.
const r = spawnSync(
	"bash",
	["-c", 'set -a; . "$0"; set +a; exec "$@"', real, process.execPath, "--test", "--test-concurrency=1", ...args, ...files],
	{
		stdio: "inherit",
		env: { ...process.env, HARNESS_LIVE: "1", HARNESS_LIVE_MAX_COST: String(maxCost), HARNESS_LIVE_LEDGER: ledger, HARNESS_ITEST_BASE: base },
	},
);
const spent = existsSync(ledger)
	? readFileSync(ledger, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
	: [];
const total = spent.reduce((s, e) => s + (e.cost ?? 0), 0);
console.log(`[live] spent $${total.toFixed(4)} of $${maxCost.toFixed(2)}: ${spent.map((e) => `${e.label} $${e.cost.toFixed(4)}`).join(", ") || "nothing"}`);
const leaked = processesUnder(base);
if (leaked.length) {
	console.error(`[live] LEAK: ${leaked.map((p) => `${p.pid} ${p.command.slice(0, 120)}`).join("; ")}`);
	await stopProcesses(leaked);
}
const kept = readdirSync(base).filter((n) => n !== "cost.jsonl");
if (kept.length) console.log(`[live] kept for inspection: ${base}`);
else rmSync(base, { recursive: true, force: true });
console.log(`[live] ${r.status === 0 && !leaked.length ? "passed" : "FAILED"} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(r.status === 0 && !leaked.length ? 0 : 1);
