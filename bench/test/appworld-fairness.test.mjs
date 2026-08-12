/**
 * Fairness invariants for the AppWorld arms.
 *
 * Same purpose as bench/test/fairness.test.mjs: every confound that has already
 * invalidated a result set gets pinned here, so it cannot come back quietly. The
 * ones specific to AppWorld are asserted against the real source files, because
 * each of them was a bug that produced plausible output.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { generate } from "../generate.mjs";
import { BASE_INSTRUCTIONS, VANILLA_VARIANTS, VARIANTS, buildBase, buildPreamble, buildVanillaPreamble } from "../appworld/prompts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CATALOGUE = join(ROOT, "bench/data/appworld-schemas.json");
const RUNNER = readFileSync(join(ROOT, "bench/appworld/run-task.mjs"), "utf8");
const SERVER = readFileSync(join(ROOT, "bench/appworld/env-server.py"), "utf8");
const haveCatalogue = existsSync(CATALOGUE);

describe("one base prompt, byte-identical across arms", () => {
	// prime's own base prompt is 6,284 chars for the code path and 615 for the
	// non-code path. Receiving both would make the comparison "tuned code prompt vs
	// bare tool prompt" rather than code vs tools.
	it("BASE_INSTRUCTIONS mentions no tool surface", () => {
		const forbidden = [/\bipython\b/i, /\bapi\/\b/, /json schema/i, /tool call/i, /function definition/i, /\bgrep\b/i];
		for (const pattern of forbidden) {
			assert.equal(pattern.test(BASE_INSTRUCTIONS), false, `base prompt leaks a tool-surface detail: ${pattern}`);
		}
	});

	it("the runner passes --system-prompt exactly once, from buildBase", () => {
		assert.match(RUNNER, /const basePrompt = buildBase\(/);
		assert.equal((RUNNER.match(/"--system-prompt"/g) ?? []).length, 1);
	});

	it("the base prompt is digested into meta.json so divergence is detectable", () => {
		assert.match(RUNNER, /basePromptDigest: digest\(basePrompt\)/);
	});

	it("every arm's preamble is additive, never a replacement for the base", () => {
		// A preamble is appended; if an arm could replace the base, the matched pair
		// required by docs/DESIGN.md is gone.
		assert.match(RUNNER, /if \(preamble\) cliArgs\.push\("--append-system-prompt", preamble\)/);
	});
});

describe("neither arm gets a shell tool", () => {
	// A shell is an escape hatch out of the surface under test: 78% of vanilla's
	// bash calls on MCP-Bench were `curl` to the APIs its own tools wrapped.
	it("the vanilla tool list is builtins plus catalogue tools only", () => {
		const builtins = /const BUILTINS = \[([^\]]*)\]/.exec(RUNNER);
		assert.ok(builtins, "BUILTINS not found");
		assert.equal(/bash|shell|exec/.test(builtins[1]), false, `vanilla builtins include a shell: ${builtins[1]}`);
	});

	it("the codemode tool list is ipython only", () => {
		assert.match(RUNNER, /toolList = \["ipython"\]/);
	});
});

describe("direct network egress is blocked", () => {
	// AppWorld is entirely local, so there is no legitimate egress at all.
	it("the runner points the agent at a dead proxy unless explicitly overridden", () => {
		assert.match(RUNNER, /HARNESS_ALLOW_DIRECT_NET/);
		assert.match(RUNNER, /http_proxy: "http:\/\/127\.0\.0\.1:9"/);
	});
});

describe("both arms reach the world through one transport", () => {
	it("the runner points both arms' transports at the env-server", () => {
		// _client.py (codemode) and mcp-tools-extension.ts (vanilla) both read this.
		assert.match(RUNNER, /HARNESS_MCP_PROXY: proxy/);
	});

	it("the env-server dispatches through world.execute, not world.requester", () => {
		// TAC bug #1: a reimplemented harness measures the clone, not the harness.
		assert.match(SERVER, /WORLD\.execute\(code\)/);
		assert.equal(/WORLD\.requester\.|world\.requester\./.test(SERVER), false);
	});
});

describe("the grader is used the way upstream uses it", () => {
	it("raise_on_failure is False", () => {
		// Not cosmetic and not arm-neutral: an uncaught API error kills the rest of a
		// cell, so codemode loses many calls where vanilla loses one. 11 of 147
		// ground-truth solutions fail under the default.
		assert.match(SERVER, /raise_on_failure=False/);
	});

	it("success is taken from tracker.success, never from a test fraction", () => {
		// A do-nothing run scores 1/2 on a read-only task, because "no collateral
		// damage" passes trivially.
		assert.match(SERVER, /"success": bool\(tracker\.success\)/);
		assert.match(RUNNER, /summary\.success = evaluation\?\.success/);
	});

	it("ground-truth mode falls back to minimal for the test splits", () => {
		// `full` raises on test_normal/test_challenge, which is the split the real run
		// uses. Hardcoding it would pass every validation task and fail every real one.
		assert.match(SERVER, /_open_world\("minimal"\)/);
	});

	it("required_apis never reaches an arm", () => {
		// Ground-truth API lists are analysis-only. Upstream's demo prompt template
		// interpolates them, which is legitimate for few-shot demos and would be
		// cheating here.
		assert.equal(/requiredApis|required_apis/.test(RUNNER), false, "run-task.mjs must not read required_apis");
	});
});

describe("evidence survives the environment", () => {
	it("responses are logged, not just requests", () => {
		// AppWorld's own api_calls.jsonl records {method, url, data} and no response.
		assert.match(SERVER, /"response": text/);
	});

	it("timestamps do not come from the frozen clock", () => {
		// freezegun pins time.time to the task's datetime and swaps every alias of it,
		// including a reference saved before the freeze.
		assert.match(SERVER, /time\.clock_gettime\(time\.CLOCK_REALTIME\)/);
		assert.equal(/[^_]\btime\.time\(\)/.test(SERVER.replace(/#.*$/gm, "")), false, "a frozen clock reached a timestamp");
	});

	it("log writes bypass the SafetyGuard and are never silently dropped", () => {
		// The guard disables builtins.open process-wide during every cell, so writes
		// were lost in proportion to how concurrent an arm's calls were.
		assert.match(SERVER, /_LOG_FH = _REAL_OPEN\(CALL_LOG, "a", buffering=1\)/);
		assert.match(SERVER, /_dropped_log_lines \+= 1/);
	});

	it("the world diff is not restricted to one model", () => {
		// changed_model_names(include=[...]) *restricts* the candidate set, so the
		// obvious one-liner threw the whole diff away.
		assert.match(SERVER, /changed_model_names\(\)\) \| set\(pair\.changed_model_names\(include=\["supervisor\.Task"\]\)\)/);
	});

	it("--force clears append-only artefacts instead of merging runs", () => {
		assert.match(RUNNER, /rmSync\(join\(runDir, stale\), \{ force: true \}\)/);
		assert.match(RUNNER, /"env-calls\.jsonl"/);
	});

	it("the runner waits for the world to finish copying its artefacts", () => {
		assert.match(RUNNER, /missingAppworldOutput/);
		assert.equal(/env\.kill\("SIGTERM"\);\s*\n\s*\/\/ TGC/.test(RUNNER), false, "SIGTERM must not race the artefact copy");
	});
});

describe("prompts are matched, not levelled down", () => {
	// "Both arms get real guidance" — stripping one arm's guidance measures which
	// representation survives a bad prompt, which is not a question anyone cares
	// about.
	const ctx = { toolCount: 469, serverCount: 10 };
	it("every codemode variant explains discovery and calling", () => {
		for (const name of Object.keys(VARIANTS)) {
			const text = buildPreamble(name, ctx);
			assert.match(text, /grep|INDEX\.md/, `${name} does not say how to find a tool`);
			assert.match(text, /await/, `${name} does not say how to call one`);
		}
	});

	it("every vanilla variant explains its own surface and batching", () => {
		for (const name of Object.keys(VANILLA_VARIANTS)) {
			const text = buildVanillaPreamble(name, ctx);
			assert.match(text, /<app>__<api>|app__api/, `${name} does not name the calling convention`);
			assert.match(text, /page_index/, `${name} omits the pagination point codemode is given`);
		}
	});

	it("no preamble carries MCP-Bench's economy pressure", () => {
		// q8's "ten to twenty items is almost always enough" is a failed task here:
		// AppWorld grades exact answers over collections paginated at 20.
		for (const build of [
			...Object.keys(VARIANTS).map((n) => buildPreamble(n, ctx)),
			...Object.keys(VANILLA_VARIANTS).map((n) => buildVanillaPreamble(n, ctx)),
		]) {
			assert.equal(/ten to twenty|slice it|do not fetch broadly/i.test(build), false);
		}
	});

	it("the pagination instruction lives in the shared base, not one arm's preamble", () => {
		const base = buildBase({ supervisor: "X Y", apps: "  spotify — music" });
		assert.match(base, /paginated/i);
	});
});

describe("both arms are rendered from one catalogue", { skip: haveCatalogue ? false : "run bench/appworld/build-catalogue.mjs" }, () => {
	const { catalogue, excludedApps } = JSON.parse(readFileSync(CATALOGUE, "utf8"));
	const { toolDefs, names, tocLines, files, normalized } = generate(catalogue);

	it("every container covers exactly the same tools", () => {
		const total = catalogue.reduce((n, s) => n + s.tools.length, 0);
		assert.equal(toolDefs.length, total);
		assert.equal(names.length, total);
		assert.equal(tocLines.length, total);
		const modules = Object.keys(files).filter((f) => f.endsWith(".py") && !f.startsWith("_") && f !== "__init__.py");
		assert.equal(
			modules.filter((f) => !f.endsWith("__init__.py")).length,
			total,
			"the api/ tree and the tool definitions cover different tools",
		);
	});

	it("descriptions are carried verbatim into both containers", () => {
		for (const { server, tools } of normalized) {
			for (const tool of tools) {
				if (!tool.description) continue;
				const def = toolDefs.find((d) => d.name === `${server}__${tool.name}`);
				assert.ok(def, `no tool definition for ${server}__${tool.name}`);
				assert.equal(def.description, tool.description);
				const module = files[`${server}/${tool.pyName}.py`];
				assert.ok(module.includes(tool.description.split("\n")[0]), `module docstring paraphrases ${tool.name}`);
			}
		}
	});

	it("api_docs is excluded from both arms, not just one", () => {
		// It is AppWorld's own deferred-schema surface. Given to vanilla it would be a
		// second residency mechanism on top of the one under test; given to codemode it
		// duplicates grep.
		assert.ok(excludedApps.includes("api_docs"));
		assert.equal(catalogue.some((s) => s.server === "api_docs"), false);
		assert.equal(Object.keys(files).some((f) => f.startsWith("api_docs/")), false);
	});

	it("supervisor is present, or every task is unsolvable", () => {
		const supervisor = catalogue.find((s) => s.server === "supervisor");
		assert.ok(supervisor, "supervisor app missing");
		const apis = supervisor.tools.map((t) => t.name);
		assert.ok(apis.includes("complete_task"), "no way to submit an answer");
		assert.ok(apis.includes("show_account_passwords"), "no way to log in to anything");
	});

	it("L1 and L2 are materially cheaper than L4, or residency means nothing", () => {
		const chars = (s) => s.length;
		const l4 = chars(JSON.stringify(toolDefs));
		assert.ok(chars(tocLines.join("\n")) < l4 / 3, "L2 is not meaningfully smaller than L4");
		assert.ok(chars(names.join("\n")) < l4 / 10, "L1 is not meaningfully smaller than L4");
	});
});

describe("the vanilla variants differ only in the residency mechanism", () => {
	// The MCP-Bench track found its L1 cell building its own preamble and therefore
	// never receiving the efficiency guidance its L4 cell got — a difference sitting on
	// the axis the 2x2 varies. Same check on this side.
	//
	// Byte-identity, not "both mention parallelism": a test that checks for a topic
	// passes while the wording drifts, and wording is what the model reads.
	const ctx = { toolCount: 20, serverCount: 10 };
	const tail = (text) => text.slice(text.indexOf("You can issue several calls"));

	it("every variant carries the shared guidance", () => {
		for (const name of Object.keys(VANILLA_VARIANTS)) {
			const text = buildVanillaPreamble(name, ctx);
			assert.ok(text.includes("You can issue several calls"), `${name} lost the shared guidance`);
		}
	});

	it("the shared guidance is byte-identical across variants", () => {
		const tails = Object.keys(VANILLA_VARIANTS).map((n) => tail(buildVanillaPreamble(n, ctx)));
		for (const t of tails) assert.equal(t, tails[0], "vanilla variants have drifted apart on shared guidance");
	});

	it("what differs between variants never touches how to use the tools", () => {
		// A *negative* check, deliberately.
		//
		// The first version of this test matched each differing line against a list of
		// permitted topics, and failed on `"not sure what exists. You only need to
		// describe a function once; after that"` — a hard-wrapped continuation of the
		// `search_tools` sentence, which is squarely about the dispatcher. Line-level
		// positive matching cannot survive wrapped prose, and loosening the word list
		// until it passes would have made the test vacuous.
		//
		// What actually matters is the absence of a specific class of difference: the
		// variants must not differ on *usage* guidance — batching, parallelism,
		// pagination strategy, efficiency — because that is the axis the 2x2 varies.
		const lines = (name) =>
			buildVanillaPreamble(name, ctx)
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
		const onlyIn = (a, b) => a.filter((l) => !b.includes(l));
		const usageGuidance = /several calls in one turn|page_index 0,1,2,3,4|in parallel|batch|efficien|fewest|redundan|do not fetch/i;
		const names = Object.keys(VANILLA_VARIANTS);
		for (const a of names) {
			for (const b of names) {
				if (a === b) continue;
				for (const line of onlyIn(lines(a), lines(b))) {
					assert.doesNotMatch(
						line,
						usageGuidance,
						`${a} carries usage guidance that ${b} does not — that difference is inside the contrast: ${line}`,
					);
				}
			}
		}
	});

	it("the predictor variant is told its real tool count, not the full catalogue", () => {
		// It has <=20 tools; telling it 469 would make a prediction miss read to the
		// model as its own failure to find a tool that was never there.
		const runner = readFileSync(join(ROOT, "bench/appworld/run-task.mjs"), "utf8");
		assert.match(runner, /toolCount: predicted\.names\.length/);
	});
});

describe("the vanilla preamble matches the residency it describes", () => {
	// Found on the challenge-split scout: `sweep.mjs` hardcoded `--vanilla-prompt b1`
	// and passed it explicitly for every residency, overriding run-task.mjs's
	// residency-aware default. An L1 arm was therefore told "their full parameter
	// schemas are already in front of you; you do not need to look anything up" while
	// holding only search_tools/describe_tool/call_tool.
	//
	// It produced no error. The arm skipped `describe_tool` entirely, guessed arguments
	// into `call_tool`, and mostly succeeded. Paired b1-vs-b2 on ten challenge tasks
	// the misbrief was worth -$0.020/task — it made the tools arm look slightly cheaper
	// than it is. The point is not the magnitude: the arm was not in the condition its
	// label claimed, and no number in the output would ever have said so.
	const ctx = { toolCount: 469, serverCount: 10 };
	const SWEEP = readFileSync(join(ROOT, "bench/appworld/sweep.mjs"), "utf8");

	it("the non-resident variant does not claim resident schemas", () => {
		// b1 (L4) and b3 (predicted) both genuinely hold schemas — 469 and <=20. b2 is
		// the only variant whose schemas are not in the prompt, so it is the only one
		// for which the claim would be false.
		const resident = /already in front|do not need to look anything up/i;
		assert.match(buildVanillaPreamble("b1", ctx), resident);
		assert.doesNotMatch(buildVanillaPreamble("b2", ctx), resident, "b2 is the L1 variant and holds no schemas");
	});

	it("b2 tells the L1 arm about the dispatcher it actually holds", () => {
		const text = buildVanillaPreamble("b2", ctx);
		for (const tool of ["describe_tool", "call_tool", "search_tools"]) {
			assert.ok(text.includes(tool), `b2 never mentions ${tool}, which is all the L1 arm has`);
		}
	});

	it("sweep.mjs derives the vanilla prompt from residency rather than hardcoding one", () => {
		assert.doesNotMatch(
			SWEEP,
			/flag\("vanilla-prompt",\s*"b1"\)/,
			'sweep.mjs hardcodes --vanilla-prompt b1; it must default per residency (b2 at L1, b3 at predicted)',
		);
		assert.match(SWEEP, /residency === "L1" \? "b2"/);
		// …and the per-cell value must reach the runner, not a module-level constant.
		assert.match(SWEEP, /"--vanilla-prompt", cell\.vanillaPromptName/);
	});
});
