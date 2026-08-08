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

// --- experiment-only CLI surface ---------------------------------------------
// `--tools` sets both the allowlist and the initially-active set, so there is no
// way from the CLI to allow a tool while leaving it dormant. The vanilla arm's
// L1 (deferred) condition needs exactly that: all 250 MCP tools permitted, only
// a handful active until `load_tool` activates one. The SDK already supports it
// (`initialActiveToolNames`); this only exposes it.
log("\nexperiment CLI surface:");

sub(
	"cli/args.ts",
	`\t\t} else if (arg === "--thinking" && i + 1 < args.length) {`,
	`\t\t} else if (arg === "--active-tools" && i + 1 < args.length) {
			// Initially-active subset of --tools. See scripts/neutralize-prime.mjs.
			result.activeTools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if (arg === "--thinking" && i + 1 < args.length) {`,
	"--active-tools flag",
);

sub(
	"cli/args.ts",
	`\ttools?: string[];`,
	`\ttools?: string[];\n\tactiveTools?: string[];`,
	"activeTools on Args",
);

sub(
	"core/agent-session-config.ts",
	`\ttools?: string[];`,
	`\ttools?: string[];\n\t/** Initially-active subset of \`tools\`. See scripts/neutralize-prime.mjs. */\n\tinitialActiveToolNames?: string[];`,
	"initialActiveToolNames on AgentSessionRuntimeConfig",
);

sub(
	"main.ts",
	`\t\ttools: parsed.tools,`,
	`\t\ttools: parsed.tools,\n\t\tinitialActiveToolNames: parsed.activeTools,`,
	"pass activeTools into session options",
);

// The missing link: prepareRuntimeServices maps config -> session options, and
// mapped `tools` but not the active subset, so the flag died here.
sub(
	"main.ts",
	`\tif (config.tools) {\n\t\toptions.tools = [...config.tools];\n\t}`,
	`\tif (config.tools) {\n\t\toptions.tools = [...config.tools];\n\t}\n` +
		`\tif (config.initialActiveToolNames) {\n\t\toptions.initialActiveToolNames = [...config.initialActiveToolNames];\n\t}`,
	"map initialActiveToolNames through prepareRuntimeServices",
);

sub(
	"main.ts",
	`\t\tinitialActiveToolNames: runtimeSessionOptions?.initialActiveToolNames,`,
	`\t\tinitialActiveToolNames:\n\t\t\truntimeSessionOptions?.initialActiveToolNames ?? sessionOptions.initialActiveToolNames,`,
	"fall back to CLI activeTools",
);

// `initialActiveToolNames` is dead whenever an allowlist is present: _buildRuntime
// unconditionally activates every allowed tool, overriding the explicit active
// set. That makes "allow a tool but leave it dormant" unexpressible, which is
// exactly what the vanilla L1 (deferred) condition needs. Restrict the blanket
// activation to the case where no explicit active set was supplied — existing
// behaviour is unchanged when the caller does not pass one.
sub(
	"core/agent-session.ts",
	`\t\tif (allowedToolNames) {\n\t\t\tfor (const toolName of this._toolRegistry.keys()) {\n\t\t\t\tif (allowedToolNames.has(toolName)) {\n\t\t\t\t\tnextActiveToolNames.push(toolName);\n\t\t\t\t}\n\t\t\t}\n\t\t} else if (options?.includeAllExtensionTools) {`,
	`\t\tif (allowedToolNames && !options?.activeToolNames) {\n\t\t\tfor (const toolName of this._toolRegistry.keys()) {\n\t\t\t\tif (allowedToolNames.has(toolName)) {\n\t\t\t\t\tnextActiveToolNames.push(toolName);\n\t\t\t\t}\n\t\t\t}\n\t\t} else if (options?.includeAllExtensionTools && !options?.activeToolNames) {`,
	"honour an explicit active set over the allowlist",
);

// mergeAgentSessionRuntimeConfig and its clone helper copy known fields one by
// one, so a new config field is silently dropped between the CLI and the
// session. This is the last link in the --active-tools chain.
sub(
	"core/agent-session-config.ts",
	`\t\ttools: cloneArray(override.tools ?? base.tools),`,
	`\t\ttools: cloneArray(override.tools ?? base.tools),\n\t\tinitialActiveToolNames: cloneArray(override.initialActiveToolNames ?? base.initialActiveToolNames),`,
	"merge initialActiveToolNames",
);

sub(
	"core/agent-session-config.ts",
	`\t\ttools: cloneArray(config.tools),`,
	`\t\ttools: cloneArray(config.tools),\n\t\tinitialActiveToolNames: cloneArray(config.initialActiveToolNames),`,
	"clone initialActiveToolNames",
);

log("\ndone.");
