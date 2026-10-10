#!/usr/bin/env node
/**
 * `npm run test:integration [-- --repeat N] [-- <node --test args>]`
 *
 * Runs every runtime/integration/*.test.mjs (real scheduler, real prime, real kernels,
 * the scripted model) one file at a time, under one per-run base directory, then
 * asserts that no process the suite started is still alive. `--repeat N` runs the whole
 * suite N times in a row and stops at the first failure — the flake check.
 *
 * Fails, rather than skipping, when the environment is not built: a suite that skips
 * everything reads as green. `scripts/dev-env.sh --check` says what is missing.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { missingPrereqs, processesUnder, stopProcesses } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const at = args.indexOf("--repeat");
const repeat = at >= 0 ? Number(args.splice(at, 2)[1]) : 1;

const missing = missingPrereqs();
if (missing.length) {
	console.error(`test:integration cannot run:\n  - ${missing.join("\n  - ")}\nRun scripts/dev-env.sh (or --check to see what is ready).`);
	process.exit(2);
}

const files = readdirSync(HERE)
	.filter((f) => f.endsWith(".test.mjs"))
	.sort()
	.map((f) => join(HERE, f));

let failed = false;
const timings = [];
for (let i = 1; i <= repeat && !failed; i++) {
	const base = realpathSync(mkdtempSync("/tmp/hit-run-"));
	const t0 = Date.now();
	if (repeat > 1) console.log(`\n=== integration run ${i}/${repeat} (${base}) ===`);
	const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...args, ...files], {
		stdio: "inherit",
		env: { ...process.env, HARNESS_ITEST_BASE: base },
	});
	const seconds = ((Date.now() - t0) / 1000).toFixed(1);
	timings.push(seconds);
	if (r.status !== 0) failed = true;

	const leaked = processesUnder(base);
	if (leaked.length) {
		failed = true;
		console.error(`\n[itest] LEAK: ${leaked.length} process(es) outlived the suite:`);
		for (const p of leaked) console.error(`  ${p.pid} (started ${p.start}) ${p.command.slice(0, 160)}`);
		await stopProcesses(leaked);
	}
	const kept = readdirSync(base);
	if (kept.length) console.log(`[itest] kept for inspection: ${kept.map((k) => join(base, k)).join(", ")}`);
	else rmSync(base, { recursive: true, force: true });
	console.log(`[itest] run ${i}: ${r.status === 0 && !leaked.length ? "passed" : "FAILED"} in ${seconds}s, no leaked processes: ${!leaked.length}`);
}
if (repeat > 1) console.log(`[itest] runs: ${timings.map((t) => `${t}s`).join(", ")}`);
process.exit(failed ? 1 : 0);
