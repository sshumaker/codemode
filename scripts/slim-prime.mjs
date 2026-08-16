#!/usr/bin/env node
/**
 * Excise prime-agent's *product* subsystems from the vendored tree.
 *
 * prime-agent is a shipped product; this repo runs its print-mode loop as a
 * benchmark harness and, per docs/CLOUD-HARNESS-DESIGN.md §4, as the basis of a
 * hosted runtime. The subsystems removed here exist to serve a human at a
 * terminal or to phone home, and every one of them is either dead on the print
 * path or an active liability there (telemetry, transcript upload, a migration
 * that rewrites the *cwd* on every `-p`).
 *
 * Runs AFTER scripts/neutralize-prime.mjs (see the pipeline in
 * bench/test/provenance.test.mjs). That ordering matters: neutralize patches
 * agent-session-services.ts to gate `installAgentTraceUpload`, and this script
 * then replaces the module that function lives in with a no-op. The gate is
 * kept anyway — it is the anchor neutralize asserts on, and a no-op behind a
 * flag is still a no-op.
 *
 * Idempotent: safe to re-run, and re-running prints only "present" lines.
 *
 * NOT removed, with reasons (each was on the audit's cut list and each turned
 * out to be load-bearing or not compile-safe with a modest stub):
 *
 *   core/package-manager.ts   ResourceLoader resolves skills, prompts, themes
 *                             AND --extension paths through DefaultPackageManager
 *                             .resolve()/.resolveExtensionSources(). Extension
 *                             loading is how both arms get their tools. Only the
 *                             CLI on top of it (package-manager-cli.ts) goes.
 *   modes/interactive/        Fan-in is too broad for one pass; the audit ranks it
 *                             as the biggest win and the biggest risk. Later.
 *   modes/daemon/             Kept and studied — the cloud harness reuses the
 *                             session-lease/cron/worker machinery.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// HARNESS_VENDOR_DIR retargets which vendored tree gets slimmed — the
// pristine-replay test points it at a scratch extraction of the base commit to
// prove scripts ≡ committed tree. Stub bodies always come from scripts/stubs/.
const VENDOR = process.env.HARNESS_VENDOR_DIR ?? join(ROOT, "vendor");
const PKG = join(VENDOR, "prime-agent/packages/coding-agent");
const PRIME = join(PKG, "src");

const log = (...a) => console.log(...a);

/** Replace `find` with `replace`, asserting the match is unique. See neutralize-prime.mjs. */
function sub(relPath, find, replace, label, marker) {
	subAt(join(PRIME, relPath), relPath, find, replace, label, marker);
}

function subAt(path, relPath, find, replace, label, marker) {
	const src = readFileSync(path, "utf8");
	if (src.includes(marker ?? replace)) return log(`  present ${relPath} :: ${label}`);
	const count = src.split(find).length - 1;
	if (count !== 1) throw new Error(`${relPath}: expected 1 match for ${label}, found ${count}`);
	// Function replacement: a string replacement treats $&, $`, $' as patterns.
	writeFileSync(path, src.replace(find, () => replace));
	log(`  patched ${relPath} :: ${label}`);
}

/**
 * Delete `find` from a file.
 *
 * `sub(..., "")` cannot express this: its already-applied guard is "the
 * replacement is present", and an empty replacement is present in every file.
 * A removal's own guard is the natural one — the text is gone.
 */
function drop(relPath, find, label) {
	dropAt(join(PRIME, relPath), relPath, find, label);
}

function dropAt(path, relPath, find, label) {
	const src = readFileSync(path, "utf8");
	const count = src.split(find).length - 1;
	if (count === 0) return log(`  present ${relPath} :: ${label}`);
	if (count !== 1) throw new Error(`${relPath}: expected 1 match for ${label}, found ${count}`);
	writeFileSync(path, src.replace(find, () => ""));
	log(`  patched ${relPath} :: ${label}`);
}

/**
 * Replace everything from `start` through the end of `end` (searched forward
 * from `start`) with `replacement`.
 *
 * Whole-block excisions are the bulk of this script, and pasting a 30-line
 * `find` string into JS is how the escaping bugs in scripts/patches/ happened.
 * Two short unique anchors say the same thing and survive upstream reflows of
 * the lines in between.
 */
function cut(relPath, start, end, replacement, label) {
	const path = join(PRIME, relPath);
	const src = readFileSync(path, "utf8");
	const startCount = src.split(start).length - 1;
	// Every `cut` here removes its own start anchor, so "anchor gone" is the
	// already-applied signal. The pristine-replay test is what catches the other
	// reading of a missing anchor (upstream moved it and the cut silently no-ops).
	if (startCount === 0) return log(`  present ${relPath} :: ${label}`);
	if (startCount !== 1) throw new Error(`${relPath}: expected 1 start anchor for ${label}, found ${startCount}`);
	const startIdx = src.indexOf(start);
	const endIdx = src.indexOf(end, startIdx + start.length);
	if (endIdx === -1) throw new Error(`${relPath}: end anchor for ${label} not found after start`);
	writeFileSync(path, src.slice(0, startIdx) + replacement + src.slice(endIdx + end.length));
	log(`  patched ${relPath} :: ${label}`);
}

/** Delete a file or directory outright. */
function del(rel, label) {
	const path = join(PRIME, rel);
	if (!existsSync(path)) return log(`  present (gone) ${rel} :: ${label}`);
	rmSync(path, { recursive: true, force: true });
	log(`  deleted ${rel} :: ${label}`);
}

/**
 * Replace a module wholesale with a typed no-op from scripts/stubs/.
 *
 * The stubs are real .ts files, not escaped string literals — same reason
 * scripts/patches/*.ts are (CLAUDE.md: a heredoc-inside-python mangled every
 * backslash and produced a file that would not compile).
 */
function stub(rel, stubFile, label) {
	const path = join(PRIME, rel);
	const body = readFileSync(join(ROOT, "scripts/stubs", stubFile), "utf8");
	if (existsSync(path) && readFileSync(path, "utf8") === body) return log(`  present ${rel} :: ${label}`);
	writeFileSync(path, body);
	log(`  stubbed ${rel} :: ${label}`);
}

log("slimming prime-agent: removing product subsystems\n");

// --- 1. agents-view (4,052 LOC) ----------------------------------------------
// The fleet browser: a full-screen TUI over the daemon's session list. Reached
// by `prime-agent agents` or left-arrow from a chat. Nothing on the print path
// touches it; modes/daemon/daemon-session-list.ts only mentions it in comments.
log("agents-view:");

del("modes/agents-view", "the fleet-browser TUI");

cut(
	"modes/index.ts",
	`export { type AgentsViewModeOptions, runAgentsViewMode } from "./agents-view/agents-view-mode.js";`,
	`} from "./agents-view/agents-view-state.js";\n`,
	"",
	"agents-view barrel exports",
);

drop("main.ts", `\ttype AgentsViewScopeKey,\n`, "drop the AgentsViewScopeKey import");

drop("main.ts", `\trunAgentsViewMode,\n`, "drop the runAgentsViewMode import");

// Inlined rather than kept: it is three fields, and keeping the directory for a
// type is exactly the "stub the dir" outcome this pass exists to avoid.
sub(
	"main.ts",
	`// \`prime-agent agents\` opens the agents view directly.`,
	`/** Inlined from the removed agents-view module. See scripts/slim-prime.mjs. */
interface AgentsViewScopeKey {
	sessionId: string;
	activeSessionId?: string;
}

// \`prime-agent agents\` opens the agents view directly.`,
	"inline AgentsViewScopeKey",
	"interface AgentsViewScopeKey {",
);

cut(
	"main.ts",
	`		const launchAgentsView = async (initialSession?: SessionSummary, initialScopeKey?: AgentsViewScopeKey) => {`,
	`\t\t\t});\n\t\t};`,
	`		// The agents view was removed in the slim build (scripts/slim-prime.mjs).
		// Its two call sites below are the daemon-interactive startup path, which a
		// print-mode harness never reaches; failing loudly beats a silent no-op that
		// would leave an interactive user staring at nothing.
		const launchAgentsView = async (
			_initialSession?: SessionSummary,
			_initialScopeKey?: AgentsViewScopeKey,
		): Promise<void> => {
			throw new Error("agents view removed in slim build");
		};`,
	"stub launchAgentsView",
);

// --- 2. ACP mode (864 LOC) ---------------------------------------------------
// Agent Client Protocol: an editor-integration transport (Zed et al.). Its own
// process mode, no overlap with print mode, and it drags in @agentclientprotocol/sdk.
log("\nacp:");

del("modes/acp", "the Agent Client Protocol mode");

cut(
	"modes/index.ts",
	`export {\n\ttype AcpModeOptions,`,
	`} from "./acp/index.js";\n`,
	"",
	"acp barrel exports",
);

drop("main.ts", `\trunAcpMode,\n\trunAcpModeWithConnection,\n`, "drop the acp imports");

sub(
	"main.ts",
	`		if (appMode === "acp") {
			return await runAcpModeWithConnection(connection);
		}`,
	`		if (appMode === "acp") {
			throw new Error("acp mode removed in slim build");
		}`,
	"acp daemon-client branch errors",
	`throw new Error("acp mode removed in slim build");\n\t\t}`,
);

sub(
	"main.ts",
	`	} else if (appMode === "acp") {
		printTimings();
		await runAcpMode(runtime);`,
	`	} else if (appMode === "acp") {
		throw new Error("acp mode removed in slim build");`,
	"acp in-process branch errors",
	`	} else if (appMode === "acp") {\n\t\tthrow new Error("acp mode removed in slim build");`,
);

// --- 3. package-manager CLI (1,641 LOC) --------------------------------------
// `prime-agent package install/remove/update` and `prime-agent update` — a
// self-updater that downloads and unzips releases over the running install.
// A hosted harness must never rewrite its own binary; a benchmark must never
// have its harness version change under it mid-sweep.
//
// core/package-manager.ts itself STAYS: ResourceLoader resolves skills, prompts,
// themes and `--extension` paths through it, so it is on the path that gives
// both arms their tools.
log("\npackage-manager CLI:");

stub("package-manager-cli.ts", "package-manager-cli.ts", "self-update / package install CLI");

// --- 4. version check + HTML export (918 LOC) --------------------------------
// version-check pings a release endpoint on startup; export-html renders a
// session to a standalone HTML page (a share feature, plus 4,185 lines of
// bundled highlight.js/marked/CSS/JS assets that ship in dist).
log("\nversion check + html export:");

stub("utils/version-check.ts", "version-check.ts", "startup release-endpoint ping");

del("core/export-html/ansi-to-html.ts", "ansi renderer for the html export");
del("core/export-html/template.css", "html export asset");
del("core/export-html/template.html", "html export asset");
del("core/export-html/template.js", "html export asset");
del("core/export-html/vendor", "bundled highlight.js + marked");
stub("core/export-html/index.ts", "export-html-index.ts", "session-to-HTML exporter");
stub("core/export-html/tool-renderer.ts", "export-html-tool-renderer.ts", "html tool renderer");

// copy-assets copies the templates into dist and fails the build once they are
// gone. Patched here rather than left to a human because the build is gate (a).
dropAt(
	join(PKG, "package.json"),
	"package.json",
	` && shx mkdir -p dist/core/export-html/vendor && shx cp src/core/export-html/template.html src/core/export-html/template.css src/core/export-html/template.js dist/core/export-html/ && shx cp src/core/export-html/vendor/*.js dist/core/export-html/vendor/`,
	"drop export-html assets from copy-assets",
);

dropAt(
	join(PKG, "package.json"),
	"package.json",
	` && shx mkdir -p dist/export-html/vendor && shx cp src/core/export-html/template.html dist/export-html/ && shx cp src/core/export-html/vendor/*.js dist/export-html/vendor/`,
	"drop export-html assets from copy-binary-assets",
);

// --- 5. refinement (1,018 LOC) -----------------------------------------------
// The continual-harness: a model call every 25 turns that writes "learned
// memories" into harness_state.json and folds them back into the system prompt.
// neutralize-prime already cut the prompt injection (run N would otherwise
// depend on run N-1); the review found the *review call itself* still firing in
// print mode and 78 harness_state.json files written by it. The scratch
// settings turn it off; this removes the machinery so it cannot come back.
//
// The module is stubbed rather than deleted: agent-session.ts imports 20 names
// from it and core/extensions/types.ts publishes a RefineCompleteEvent. The
// types stay, the behaviour does not.
log("\nrefinement:");

del("core/refinement/refinement.ts", "the continual-harness engine");
stub("core/refinement/index.ts", "refinement-index.ts", "inert refinement surface");

// --- 6. telemetry + agent traces (1,765 LOC) ---------------------------------
// Product analytics (default ON for every print session) and a full-transcript
// upload that PUTs the session JSONL with cwd/git headers. The upload is
// installed unconditionally upstream and no env var gates it — the one
// call-home a host cannot switch off. Both become typed no-ops.
log("\ntelemetry + traces:");

stub("core/telemetry.ts", "telemetry.ts", "product analytics -> no-op");
stub("core/agent-traces.ts", "agent-traces.ts", "transcript upload -> no-op");

// --- 7. migrations on every -p ------------------------------------------------
// runMigrations rewrites agent-dir state AND cwd state (it moves/creates config
// files next to wherever the agent happens to be invoked) on every single print
// run. For a benchmark that is mutation of the task's working directory by the
// harness; for a hosted runtime it is a write to someone else's filesystem.
log("\nmigrations:");

sub(
	"main.ts",
	`	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);`,
	`	// Migrations rewrite agent-dir state AND \`cwd\` state — they move sessions,
	// rewrite auth.json, relocate tools, and rewrite the extension config next to
	// wherever the agent was invoked — on every single \`-p\` run. For a benchmark
	// that is the harness mutating the task's working directory before the task
	// starts; for a hosted runtime it is a write to someone else's filesystem.
	// Off by default; set PRIME_AGENT_RUN_MIGRATIONS=1 to restore.
	// See scripts/slim-prime.mjs.
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } =
		process.env.PRIME_AGENT_RUN_MIGRATIONS === "1"
			? runMigrations(cwd)
			: { migratedAuthProviders: [] as string[], deprecationWarnings: [] as string[] };`,
	"gate runMigrations",
	"PRIME_AGENT_RUN_MIGRATIONS",
);

log("\ndone.");
