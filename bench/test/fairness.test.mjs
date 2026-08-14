/**
 * Fairness invariants.
 *
 * Every assertion here exists because its violation was found in a live run and
 * silently corrupted results. They are cheap to check and expensive to miss.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { generate, pyIdent, pyPackage } from "../generate.mjs";
import { loadTasks } from "../tasks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUN_TASK = readFileSync(join(ROOT, "bench/run-task.mjs"), "utf8");
const SCHEMAS = join(ROOT, "bench/data/mcp-schemas.json");
const haveSchemas = existsSync(SCHEMAS);

describe("the vanilla arm has no shell", () => {
	// 78% of this arm's bash calls were `curl` straight to the APIs its MCP tools
	// wrap, so it was not exercising tool-calling at all — and the judge, which
	// only sees proxy-logged calls, scored those facts as ungrounded.
	it("bash is not in the vanilla built-in set", () => {
		const match = RUN_TASK.match(/const BUILTINS = \[([^\]]*)\]/);
		assert.ok(match, "BUILTINS not found in run-task.mjs");
		assert.ok(!/"bash"/.test(match[1]), `vanilla regained bash: ${match[1]}`);
	});

	it("codemode keeps its REPL, which is the treatment", () => {
		assert.match(RUN_TASK, /toolList = \["ipython"\]/);
	});
});

describe("direct network egress is blocked", () => {
	// Proxy env vars stop curl/requests/urllib. Raw sockets still evade them,
	// which is why removing the shell matters more than this does.
	it("the agent process gets a dead proxy", () => {
		assert.match(RUN_TASK, /https_proxy: "http:\/\/127\.0\.0\.1:9"/);
	});

	it("the MCP proxy and the model API stay reachable", () => {
		const match = RUN_TASK.match(/no_proxy: "([^"]+)"/);
		assert.ok(match, "no_proxy not set");
		assert.match(match[1], /127\.0\.0\.1/);
		assert.match(match[1], /api\.anthropic\.com/);
	});

	it("the escape hatch is opt-in and off by default", () => {
		assert.match(RUN_TASK, /HARNESS_ALLOW_DIRECT_NET === "1"/);
	});
});

describe("both arms share one base system prompt", () => {
	// prime's own base prompt was 6,284 chars for codemode and 615 for vanilla:
	// whole sections gate on `hasIpython`, so the code arm received 10x more
	// workflow guidance plus RLM instructions this experiment does not use.
	it("a single BASE_SYSTEM_PROMPT is defined", () => {
		assert.match(RUN_TASK, /const BASE_SYSTEM_PROMPT = \[/);
	});

	it("it is passed to every arm, not built per-arm", () => {
		assert.match(RUN_TASK, /"--system-prompt",\s*\n\s*BASE_SYSTEM_PROMPT,/);
		// Check the definition itself for arm branching, not a byte window after
		// it — the following statement legitimately mentions `arm`.
		const start = RUN_TASK.indexOf("const BASE_SYSTEM_PROMPT = [");
		const body = RUN_TASK.slice(start, RUN_TASK.indexOf('].join("\\n");', start));
		assert.ok(!/\barm\b/.test(body), "the base prompt definition branches on arm");
	});

	it("it says nothing about ipython, python, or bash", () => {
		// Naming one arm's mechanics in the shared prompt would tilt the comparison.
		const body = RUN_TASK.slice(
			RUN_TASK.indexOf("const BASE_SYSTEM_PROMPT = ["),
			RUN_TASK.indexOf('].join("\\n");', RUN_TASK.indexOf("const BASE_SYSTEM_PROMPT = [")),
		);
		for (const word of ["ipython", "python", "bash", "REPL", "api/"]) {
			assert.ok(!new RegExp(word, "i").test(body), `base prompt mentions "${word}"`);
		}
	});
});

describe("both arms receive the same tool catalogue", { skip: haveSchemas ? false : "no schemas dumped" }, () => {
	const catalogue = () => JSON.parse(readFileSync(SCHEMAS, "utf8")).catalogue;

	it("tool-definition count equals api/ module count, per task", () => {
		// A tool present to one arm and absent from the other is a capability
		// difference wearing a token-saving costume.
		const all = catalogue();
		for (const task of loadTasks().slice(0, 25)) {
			const selected = all.filter((s) => task.exposedServers.includes(s.server));
			const { toolDefs, files } = generate(selected);
			const modules = Object.keys(files).filter(
				(p) => p.endsWith(".py") && !p.endsWith("__init__.py") && !p.endsWith("_client.py"),
			);
			assert.equal(toolDefs.length, modules.length, `${task.id}: ${toolDefs.length} defs vs ${modules.length} modules`);
		}
	});

	it("both renderings carry the same authored descriptions", () => {
		// Look the module up by its deterministic path rather than by scanning for
		// a substring, which matched the wrong file when tool names share a prefix.
		const selected = catalogue().slice(0, 4);
		const { toolDefs, files } = generate(selected);
		for (const server of selected) {
			for (const tool of server.tools) {
				if (!tool.description) continue;
				const module = files[`${pyPackage(server.server)}/${pyIdent(tool.name)}.py`];
				const def = toolDefs.find((d) => d._mcp.server === server.server && d._mcp.tool === tool.name);
				const first = tool.description.trim().split("\n")[0];
				assert.ok(module, `no module for ${server.server}.${tool.name}`);
				assert.ok(module.includes(first), `${tool.name}: api/ module lost the description`);
				assert.equal(def.description, tool.description.trim(), `${tool.name}: tool def altered the description`);
			}
		}
	});
});

describe("recorded runs remain interpretable", () => {
	it("run-task records what it would need to detect its own contamination", () => {
		for (const field of ["firstTurnPromptTokens", "residencyViolation", "promptVariant", "toolCount"]) {
			assert.match(RUN_TASK, new RegExp(field), `run-task no longer records ${field}`);
		}
	});

	it("a completed run cannot be silently overwritten", () => {
		assert.match(RUN_TASK, /run already exists/);
	});
});

/**
 * Confounds that live in the AppWorld harness.
 *
 * Kept in this file, alongside MCP-Bench's, because the invariants are the same
 * ones and this is where someone looks. The AppWorld-specific mechanics — the
 * catalogue renderings, the prompts, the evidence trail — are pinned in
 * bench/test/appworld-fairness.test.mjs.
 */
describe("the AppWorld env-server does not penalise batching", () => {
	const ENV_SERVER = join(ROOT, "bench/appworld/env-server.py");
	const haveAppworld = existsSync(ENV_SERVER);
	const server = haveAppworld ? readFileSync(ENV_SERVER, "utf8") : "";

	it("raise_on_failure is False", { skip: haveAppworld ? false : "no appworld harness" }, () => {
		// AppWorld defaults it to True, which raises inside the interpreter on any API
		// error and kills the remaining statements of the cell. That is a penalty
		// proportional to how many calls an arm puts in one action: codemode loses the
		// rest of the cell, vanilla loses one tool call. It penalises precisely the
		// behaviour codemode exists to do.
		//
		// Measured: 11 of 147 ground-truth solutions fail under the default. Upstream's
		// own verifier passes False (vendor/appworld/src/appworld/verify.py:154).
		assert.match(server, /raise_on_failure=False/);
	});

	it("the call log cannot be silently dropped, least of all in proportion to batching", () => {
		// The most dangerous bug found on this benchmark, and the reason it belongs
		// here rather than only in the AppWorld-specific file.
		//
		// AppWorld's SafetyGuard replaces `builtins.open`, `os.open`, `os.write`,
		// `io.open` and `shutil.copy*` with functions that refuse — process-wide, for
		// the duration of every `world.execute`, restored afterwards
		// (environment.py:1000 enable / 1020 disable). It exists to stop agent code
		// touching the machine and it cannot tell agent code from harness code.
		//
		// So a log write issued from an HTTP thread while ANY cell was mid-execution
		// hit the disabled `open` and raised, and `record()` swallowed it under
		// "logging must never break the run it is observing". Measured: 8 concurrent
		// /call requests produced ONE log line; the first real vanilla run lost 3 of
		// its 8 calls.
		//
		// The shape of the bias is what makes it dangerous rather than merely
		// annoying: lines are lost in proportion to how many calls an arm issues
		// CONCURRENTLY, so the arm that batches more is logged less. That is exactly
		// where codemode is supposed to win, and the loss is silent.
		//
		// Two invariants: hold a file handle captured before `import appworld` (the
		// guard swaps the factory, not open handles), and count failures instead of
		// swallowing them.
		assert.match(server, /_REAL_OPEN = open/);
		assert.match(server, /_LOG_FH = _REAL_OPEN\(CALL_LOG, "a", buffering=1\)/);
		assert.match(server, /_dropped_log_lines \+= 1/);
		assert.match(server, /droppedLogLines/);
		// No path that writes evidence may go through the patched builtin.
		const code = server.replace(/^\s*#.*$/gm, "").replace(/"""[\s\S]*?"""/g, "");
		const bareOpens = [...code.matchAll(/(?<![_A-Za-z])open\(/g)].length;
		assert.equal(bareOpens, 0, `${bareOpens} bare open() call(s) in env-server.py — use _REAL_OPEN`);
	});

	it("a malformed call is not converted into a transport failure", () => {
		// Returning {"ok": false} would make codemode's _client raise McpError inside
		// the cell — destroying the rest of that cell's statements — while vanilla lost
		// only the one tool call. Same asymmetry as raise_on_failure, one layer up.
		// Both arms get AppWorld's traceback as ordinary text; `execFailed` is how the
		// failure is still counted.
		assert.match(server, /"execFailed":/);
	});

	it("neither arm's error text is embellished by the harness", () => {
		// Verified end-to-end by bench/appworld/error-symmetry.mjs: unknown api,
		// missing required parameter, and api-level refusal all arrive byte-identical
		// in both arms. If vanilla got a friendlier message, the comparison would be
		// measuring error legibility rather than representation.
		const extension = readFileSync(join(ROOT, "bench/arms/mcp-tools-extension.ts"), "utf8");
		assert.equal(
			/missing required parameter\(s\)/.test(extension),
			false,
			"call_tool pre-validates arguments, so vanilla L1 sees a different error than codemode",
		);
	});
});

describe("vanilla has a deferred-residency condition that actually works", () => {
	const EXTENSION = join(ROOT, "bench/arms/mcp-tools-extension.ts");
	const extension = readFileSync(EXTENSION, "utf8");

	it("L1 dispatches through fixed tools, not dynamically registered ones", () => {
		// Two earlier mechanisms both produced runs that looked fine and were not L1:
		// the --active-tools CLI flag never reaches print mode (silently L4), and
		// lazily registered or lazily activated tools are advertised but answer
		// "Tool <name> not found" at execution, because prepareToolCall resolves
		// against a per-turn snapshot of agent.state.tools. Measured: 70 turns, 78
		// tool calls, 0 reaching the transport.
		assert.match(extension, /name: "call_tool"/);
		assert.match(extension, /name: "describe_tool"/);
		// Comments are stripped first: the failed mechanisms are deliberately described
		// in the source so they are not retried, and matching the prose would fail on
		// its own documentation.
		const code = extension.replace(/^\s*\/\/.*$/gm, "");
		assert.equal(/registerReal|pi\.setActiveTools/.test(code), false, "L1 is back on dynamic tool identity");
	});

	it("L4 is not the only tool-calling baseline the runner can produce", () => {
		// Comparing only against all-N-resident answers "don't paste 469 schemas into
		// context", which nobody disputes. Upstream ships an LLM pre-filter precisely
		// because L4 is infeasible, so a deferred condition is the honest competitor.
		const runner = readFileSync(join(ROOT, "bench/appworld/run-task.mjs"), "utf8");
		assert.match(runner, /residency === "L1"/);
		assert.match(runner, /"search_tools", "describe_tool", "call_tool"/);
	});
});

/**
 * The invariant that was missing when vanilla L1 silently never worked.
 *
 * A residency guard catches "the schemas are still resident". Nothing was catching
 * the opposite failure: **narrowing worked and execution broke.** Deferral by lazy
 * registration reduced first-turn context exactly as intended and then answered
 * "Tool <name> not found" for every call, because `prepareToolCall` resolves against
 * a per-turn snapshot of `agent.state.tools`. Its signature, measured:
 *
 *     70 turns, 78 tool calls, 0 reaching the transport, 32 errors, $1.71, failed
 *
 * The run looks busy and expensive and produces a plausible-looking result.json.
 * The only thing that distinguishes it from a working run is that the world was
 * never touched — so that is what gets asserted, against recorded runs rather than
 * against source.
 */
describe("every arm that has tools actually reaches the world", () => {
	const RUNS = join(ROOT, ".run/appworld");
	const haveRuns = existsSync(RUNS);

	it("no recorded run made tool calls without any of them reaching the transport", { skip: haveRuns ? false : "no appworld runs recorded" }, async () => {
		const { readdirSync } = await import("node:fs");
		const offenders = [];
		let checked = 0;
		for (const dir of readdirSync(RUNS)) {
			const path = join(RUNS, dir, "result.json");
			if (!existsSync(path)) continue;
			let run;
			try {
				run = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				continue;
			}
			const { arm, summary } = run;
			// `notools` is the control that is *supposed* to reach nothing.
			if (!summary || arm === "notools") continue;
			checked++;
			if ((summary.toolCalls ?? 0) > 0 && (summary.apiCalls ?? 0) === 0) {
				offenders.push(`${dir}: ${summary.toolCalls} tool calls, 0 api calls, ${summary.toolErrors} errors`);
			}
		}
		assert.equal(
			offenders.length,
			0,
			`${offenders.length} of ${checked} run(s) never reached the world:\n  ${offenders.join("\n  ")}`,
		);
	});

	it("a deferred-residency run is only credible if it also transacted", { skip: haveRuns ? false : "no appworld runs recorded" }, async () => {
		// Both halves together: L1/predicted must be BOTH narrow (residency worked)
		// and productive (execution worked). Either alone was achievable by a bug.
		const { readdirSync } = await import("node:fs");
		let seen = 0;
		for (const dir of readdirSync(RUNS)) {
			const path = join(RUNS, dir, "result.json");
			if (!existsSync(path)) continue;
			let run;
			try {
				run = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				continue;
			}
			if (!["L1", "predicted"].includes(run.residency) || !run.summary) continue;
			if (run.summary.stopReason !== "completed") continue;
			seen++;
			assert.ok(
				run.summary.firstTurnPromptTokens < 30_000,
				`${dir}: first turn carried ${run.summary.firstTurnPromptTokens} tokens — not deferred`,
			);
			assert.ok(run.summary.apiCalls > 0, `${dir}: deferred but never reached the world`);
		}
		if (seen === 0) console.log("      (no completed L1/predicted runs recorded yet)");
	});
});

/**
 * The same invariant one level down: a tool can be registered, advertised, callable,
 * and still not *work*.
 *
 * Deferred registration produced an arm that could see tools and never call them.
 * `--nav-tools` produced an arm that could call `grep` and always got an error:
 * prime's grep and find shell out to `rg`/`fd`, resolve them under
 * `<PRIME_AGENT_CODING_AGENT_DIR>/bin`, and `run-task.mjs` points that at a fresh
 * per-run directory — so the binaries prime had already downloaded to
 * `~/.prime/agent/bin` were invisible, and the fallback GitHub download is blocked
 * by the arm's network sandbox.
 *
 * MEASURED before the fix: **50 grep calls across 62 `--nav-tools` runs, 50 failures**,
 * every one `ripgrep (rg) is not available and could not be downloaded`. The agent
 * fell back to hand-rolled `open()` scans, which read as a *model* reflex — the
 * failure mode this repo keeps meeting, a plausible number instead of an error.
 *
 * So: assert the binary the runner will seed actually *executes on this machine*,
 * and assert no recorded run advertised a navigation tool that failed for want of it.
 */
describe("advertised navigation tools actually execute", () => {
	const rgPath = process.env.HARNESS_RG_PATH ?? join(process.env.HOME ?? "", ".prime/agent/bin/rg");
	const fdPath = process.env.HARNESS_FD_PATH ?? join(process.env.HOME ?? "", ".prime/agent/bin/fd");

	it("the runner seeds the per-run agent dir instead of trusting the download", () => {
		const runner = readFileSync(join(ROOT, "bench/appworld/run-task.mjs"), "utf8");
		// Seeded under the same agent-home the runner overrides, or prime cannot see it.
		assert.match(runner, /join\(runDir, "agent-home", "bin"\)/);
		assert.match(runner, /for \(const tool of \["rg", "fd"\]\)/);
		// A missing source must be fatal. Silently continuing is the original bug.
		assert.match(runner, /process\.exit\(1\)/);
	});

	it("the seed binaries run, rather than merely existing", async () => {
		const { spawnSync } = await import("node:child_process");
		for (const [name, path] of [
			["rg", rgPath],
			["fd", fdPath],
		]) {
			assert.ok(existsSync(path), `${name} seed source missing at ${path} — --nav-tools runs would advertise a dead tool`);
			// `existsSync` certifies a path, not a program — the `find_spec` mistake.
			// Only an exit code proves the thing the agent's tool shells out to works.
			const probe = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
			assert.equal(probe.status, 0, `${name} at ${path} did not execute: ${probe.error ?? probe.stderr}`);
		}
	});

	it("no recorded nav-tools run failed for want of a navigation binary", async () => {
		const RUNS = join(ROOT, ".run/appworld");
		if (!existsSync(RUNS)) return;
		const { readdirSync } = await import("node:fs");
		const offenders = [];
		let checked = 0;
		let legacy = 0;
		for (const dir of readdirSync(RUNS)) {
			const path = join(RUNS, dir, "result.json");
			if (!existsSync(path)) continue;
			let run;
			try {
				run = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				continue;
			}
			if (!run.variants?.navTools || !run.summary) continue;
			const dead = (run.summary.errorMessages ?? []).filter((m) => /is not available and could not be downloaded/.test(m));
			// Runs recorded before the seeding existed cannot satisfy this and are not
			// a regression — they are the evidence for it. Asserting over them would
			// leave the suite permanently red, which is how a check stops being read.
			// `navToolBinaries` is written only by the seeding path, so it is exactly
			// the "this run came from the fixed harness" discriminator.
			if (!run.variants.navToolBinaries || Object.keys(run.variants.navToolBinaries).length === 0) {
				if (dead.length > 0) legacy++;
				continue;
			}
			checked++;
			if (dead.length > 0) offenders.push(`${dir}: ${dead.length}x ${dead[0]}`);
		}
		if (legacy > 0) {
			console.log(`      (${legacy} pre-seeding run(s) carry the dead-tool error; re-run before citing them)`);
		}
		assert.equal(
			offenders.length,
			0,
			`${offenders.length} of ${checked} nav-tools run(s) advertised a tool that could not execute:\n  ${offenders.join("\n  ")}`,
		);
	});
});

/**
 * Invariants on the *analysis*, not on a run.
 *
 * The fifth instance tonight of a check producing a plausible number instead of an
 * error, and the most dangerous, because it corrupted the analysis rather than a
 * single run: `factorial.mjs` substituted 0 for a task a cell had not run and
 * divided by the full set, so a half-finished cell rendered as a cheap one — the
 * still-running mirror cell showed "1/10, 0.7 turns, $0.0192" as though it had
 * solved a stratum for two cents.
 *
 * Missing is not zero. And a condition added to the comparison must never be able to
 * shrink the design it is compared against.
 */
describe("the factorial analysis cannot silently compare incomplete cells", () => {
	const FACTORIAL = join(ROOT, "bench/appworld/factorial.mjs");
	const haveFactorial = existsSync(FACTORIAL);
	const source = haveFactorial ? readFileSync(FACTORIAL, "utf8") : "";

	it("means are taken over tasks a cell actually ran", { skip: haveFactorial ? false : "no factorial.mjs" }, () => {
		assert.match(source, /const present = \(cell, taskSet\)/);
		assert.match(source, /const agg = \(cell, taskSet, field\) => mean\(present\(cell, taskSet\)/);
		// The specific shape that caused it: `?? 0` inside the mapped lookup, so a
		// missing run contributed a zero to the numerator and a one to the denominator.
		assert.equal(
			/\.map\(\(t\) => table\.get\(`\$\{t\}\|\$\{cell\.key\}`\)\?\.\[field\] \?\? 0\)/.test(source),
			false,
			"agg is back to counting a missing run as zero",
		);
	});

	it("a partial cell is announced rather than quietly averaged", { skip: haveFactorial ? false : "no factorial.mjs" }, () => {
		assert.match(source, /incomplete cells, means are over fewer tasks and NOT comparable/);
		// Per-cell n is printed, so a partial cell is visibly partial in the table.
		assert.match(source, /String\(present\(cell, taskSet\)\.length\)\.padStart/);
	});

	it("the core design is defined by inclusion, so a new condition cannot shrink it", { skip: haveFactorial ? false : "no factorial.mjs" }, () => {
		// `col !== "predicted"` meant adding the mirror cell pulled it into the 2x2 and
		// collapsed the whole design to n=1 while that cell was still running.
		assert.match(source, /const core = CELLS\.filter\(\(c\) => c\.col === "in" \|\| c\.col === "out"\)/);
		assert.equal(/const core = CELLS\.filter\(\(c\) => c\.col !== /.test(source), false, "core is defined by exclusion again");
	});
});

describe("the paired analysis carries its own null control", () => {
	const FACTORIAL = join(ROOT, "bench/appworld/factorial.mjs");
	const haveFactorial = existsSync(FACTORIAL);
	const source = haveFactorial ? readFileSync(FACTORIAL, "utf8") : "";

	it("every report compares one cell with itself and checks the result is zero", { skip: haveFactorial ? false : "no factorial.mjs" }, () => {
		// A statistic that reports significance on identical inputs has broken pairing —
		// comparing across tasks rather than within them. Printing the control on every
		// report means the reader sees the analysis is sound on the same page as the
		// numbers, rather than trusting a check that ran once.
		assert.match(source, /NULL CONTROL \(a cell vs itself\)/);
		assert.match(source, /NULL CONTROL FAILED/);
		assert.match(source, /selfControl\.mean !== 0 \|\| Number\.isFinite\(selfControl\.t\)/);
	});

	it("paired contrasts use only tasks present in every compared cell", { skip: haveFactorial ? false : "no factorial.mjs" }, () => {
		assert.match(source, /const usable = taskSet\.filter\(\(t\) =>/);
		assert.match(source, /Number\.isFinite\(costOf\(r, c, t\)\)/);
	});

	it("a contrast whose cell was not run is skipped, never computed from fewer tasks", { skip: haveFactorial ? false : "no factorial.mjs" }, () => {
		// `--cells` lets a deliberately partial design be analysed (the challenge-split
		// pilot ran three of the four corners). The danger it introduces is the one this
		// file already guards elsewhere: a missing cell quietly shrinking the sample a
		// contrast is computed over. So contrasts are filtered by cell availability and
		// the omitted ones are named in the output rather than silently absent.
		assert.match(source, /\.filter\(\(\[a, b\]\) => have\(\.\.\.a\) && have\(\.\.\.b\)\)/);
		assert.match(source, /SKIPPED — a cell it needs was not run/);
		assert.match(source, /interaction: SKIPPED — needs all four corners/);
	});
});
