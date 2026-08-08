#!/usr/bin/env node
/**
 * Neutralize prime-agent behaviours that make benchmark runs non-reproducible.
 *
 * prime-agent is a product, and carries state that is a feature there and a
 * confound here. Nothing in this script is a judgement about whether those
 * features work — only that a benchmark cannot measure a harness whose prompt
 * changes between runs.
 *
 * Disabled (restore any of them by setting the env var to "1"):
 *
 *   PRIME_HARNESS_STATE  The /refine continual-harness state. It persists to
 *                        harness_state.json and is folded into the system
 *                        prompt, so run N's prompt depends on run N-1. Fatal for
 *                        reproducibility and for run-order independence.
 *
 * Deliberately NOT disabled:
 *
 *   - The conversation-log path (`Conversation log: <file>` in the prompt). It
 *     is one line, it is identical across arms, and it is the mechanism by which
 *     an agent recovers context after a compaction or kernel reset. Removing it
 *     would handicap both arms for no experimental gain. See docs/DESIGN.md.
 *   - IPython kernel prewarm. Already gated upstream on `ipython` being an
 *     active tool, so the vanilla arm never starts a kernel.
 *
 * Idempotent: safe to re-run after bumping the vendored upstream.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRIME = join(ROOT, "vendor/prime-agent/packages/coding-agent/src");

const log = (...a) => console.log(...a);

/** Replace `find` with `replace`, asserting the match is unique. */
function sub(relPath, find, replace, label) {
	const path = join(PRIME, relPath);
	const src = readFileSync(path, "utf8");
	if (src.includes(replace)) return log(`  present ${relPath} :: ${label}`);
	const count = src.split(find).length - 1;
	if (count !== 1) throw new Error(`${relPath}: expected 1 match for ${label}, found ${count}`);
	writeFileSync(path, src.replace(find, replace));
	log(`  patched ${relPath} :: ${label}`);
}

log("neutralizing prime-agent for reproducible runs\n");

// The continual-harness state injected into the system prompt. Opt back in with
// PRIME_HARNESS_STATE=1 if we ever want to measure it as its own variable.
sub(
	"core/agent-session.ts",
	`			harnessState: this._loadMergedHarnessState(),`,
	`			// Benchmark reproducibility: harness state persists across runs and
			// mutates the system prompt, making run N depend on run N-1.
			// See scripts/neutralize-prime.mjs.
			harnessState: process.env.PRIME_HARNESS_STATE === "1" ? this._loadMergedHarnessState() : undefined,`,
	"harness-state prompt injection",
);

log("\ndone.");
