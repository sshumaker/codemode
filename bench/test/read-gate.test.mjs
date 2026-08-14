/**
 * The verified read-precondition — the codemode gate with no path through.
 *
 * It exists because of a measured, near-deterministic loss. On the `ce73d68`
 * family (docs/CC-EDGE-TRACES.md) `api.gmail.reply_to_email` was called without
 * `email_addresses`, whose documented default is "the sender" — which on an outbox
 * thread is the supervisor themselves. 35 of 36 codemode runs omitted it and every
 * one of those failed, invariant to residency, prompt, layout, docs gating,
 * catalogue enrichment and argument validation. **Zero of 12 configurations ever
 * read that contract**, including the two running the docs gate, because that gate
 * marks the pair delivered BEFORE it raises and so clears itself on the retry.
 *
 * This one is Edit's precondition: refuse until the file was actually Read, and
 * re-check on retry. What is pinned here, per "a documented check is not an
 * executed check":
 *
 *   - the line map's spans match the file that was emitted, for every API,
 *   - the refusal names the API, the file, the span, and the read TOOL,
 *   - a covering read satisfies; a read stopping one line short does not,
 *   - one whole-file read bulk-satisfies every API in that app,
 *   - NO PATH THROUGH: retrying without a read refuses again, forever,
 *   - off is byte-identical to the tree every earlier run used,
 *   - the runner refuses the combinations that would make the label a lie.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { generate, normalizeTool, renderAppModuleParts, renderClient } from "../generate.mjs";
import { buildPreamble } from "../appworld/prompts.mjs";
import { realistic, wide } from "./fixtures/catalogue.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = readFileSync(join(ROOT, "bench/appworld/run-task.mjs"), "utf8");
const SWEEP = readFileSync(join(ROOT, "bench/appworld/sweep.mjs"), "utf8");
const EXTENSION = readFileSync(join(ROOT, "bench/arms/read-ledger-extension.ts"), "utf8");
const PROBE = join(ROOT, "bench/test/fixtures/read_gate_probe.py");
const CATALOGUE = [...realistic, ...wide];
const gated = () => generate(CATALOGUE, { readGate: true, apiLayout: "consolidated" });

describe("the read gate is off by default", () => {
	it("generate() without the option renders the tree it always rendered", () => {
		// The A/B compares two trees. "The same file with a dormant branch in it" is
		// not the same file, so the gate is rendered in rather than switched on.
		assert.deepEqual(
			generate(CATALOGUE, { apiLayout: "consolidated" }),
			generate(CATALOGUE, { readGate: false, apiLayout: "consolidated" }),
		);
	});

	it("renders no gate machinery and no line map", () => {
		const { files } = generate(CATALOGUE, { apiLayout: "consolidated" });
		assert.equal(/ReadFirst|_linemap|_read_windows/.test(files["_client.py"]), false, "gate-off client carries gate code");
		assert.equal(Object.keys(files).includes("_linemap.json"), false, "gate-off tree carries a line map");
		for (const [rel, content] of Object.entries(files)) {
			if (rel.endsWith(".py")) assert.equal(/_path=/.test(content), false, `${rel} carries gate plumbing with the gate off`);
		}
	});

	it("no INDEX announces a precondition that will not fire", () => {
		assert.equal(/ReadFirst/.test(generate(CATALOGUE, { apiLayout: "consolidated" }).files["INDEX.md"]), false);
	});
});

describe("combinations that would make the label a lie are refused, not coerced", () => {
	it("refuses per-method, where there is no span to cite", () => {
		// The refusal cites `api/<app>.py` lines N-M. In per-method that file does not
		// exist, so the citation would be a lie and the gate unsatisfiable.
		assert.throws(() => generate(CATALOGUE, { readGate: true }), /requires --api-layout=consolidated/);
		assert.throws(() => renderClient({ readGate: true, apiLayout: "per-method" }), /requires --api-layout=consolidated/);
	});

	it("refuses to stack on the docs gate, which clears itself on the same retry", () => {
		for (const mode of ["redirect", "inline"]) {
			assert.throws(
				() => generate(CATALOGUE, { readGate: true, docsGate: mode, apiLayout: "consolidated" }),
				/alternatives, not a stack/,
			);
		}
	});

	it("the runner refuses --read-gate without consolidated + nav tools", () => {
		// Without the read tool the gate is a deadlock; without consolidated it has no
		// spans. Either coercion would produce a run whose `__rg` label over-claims.
		assert.match(RUNNER, /const readGate = argv\.includes\("--read-gate"\)/);
		assert.match(RUNNER, /if \(readGate && \(layout !== "consolidated" \|\| !navTools\)\)/);
		assert.match(SWEEP, /if \(codemodeReadGate && \(codemodeApiLayout !== "consolidated" \|\| !codemodeNavTools\)\)/);
	});

	it("is codemode-only and lands in the runId, in both the runner and the sweep", () => {
		// A variant run that overwrote the run it is compared against destroys the
		// comparison — the runId-collision failure this project has already had.
		assert.match(RUNNER, /\|\| validateArgs \|\| readGate \|\|[^)]*\) && arm !== "codemode"/);
		assert.match(RUNNER, /\$\{readGate \? "__rg" : ""\}/);
		assert.match(SWEEP, /\$\{codemodeReadGate \? "__rg" : ""\}/);
	});
});

describe("the line map is exact, because we emit the file", () => {
	it("every span starts at that API's `async def` and ends at its call", () => {
		const { files } = gated();
		const map = JSON.parse(files["_linemap.json"]);
		let checked = 0;
		for (const [pkg, functions] of Object.entries(map)) {
			const lines = files[`${pkg}.py`].split("\n");
			for (const [name, [start, end]] of Object.entries(functions)) {
				assert.ok(lines[start - 1].startsWith(`async def ${name}(`), `${pkg}.${name}: span starts at ${JSON.stringify(lines[start - 1])}`);
				assert.equal(lines[end - 1].trim(), ")", `${pkg}.${name}: span ends at ${JSON.stringify(lines[end - 1])}`);
				assert.ok(end > start, `${pkg}.${name}: empty span`);
				checked++;
			}
		}
		assert.equal(checked, CATALOGUE.reduce((n, s) => n + s.tools.length, 0));
	});

	it("the span contains the whole docstring, which is where the trap lives", () => {
		// The `ce73d68` loss is one sentence inside the Args block: "If passed, it'll
		// reply to all recipients in the list, otherwise, to the sender." A span that
		// covered only the signature would certify a contract the agent never saw.
		const { files } = gated();
		const [start, end] = JSON.parse(files["_linemap.json"]).linear.list_issues;
		const section = files["linear.py"].split("\n").slice(start - 1, end).join("\n");
		assert.match(section, /Args:/);
		assert.match(section, /Team key, e\.g\. ENG\./);
		assert.match(section, /capped at 50/);
		assert.match(section, /return await _call\(/);
	});

	it("survives a renderer that emits a block as one multi-line string", () => {
		// The first version counted array elements, and the gated `_call` is ONE
		// element carrying four newlines — so every span after the first was short by
		// two lines while looking entirely plausible. Counting newlines is the only
		// accounting that survives that, so pin it against a real multi-line element.
		const tools = realistic[0].tools.map(normalizeTool);
		const { text, lineMap } = renderAppModuleParts(tools, { server: "linear", pkg: "linear", readGate: true });
		const lines = text.split("\n");
		assert.ok(text.includes('        _path="api.linear.list_issues",'), "the multi-line _call element is not present");
		for (const [name, [start, end]] of Object.entries(lineMap)) {
			assert.ok(lines[start - 1].startsWith(`async def ${name}(`));
			assert.equal(lines[end - 1].trim(), ")");
		}
	});

	it("is not emitted when the gate is off, and covers every app when it is on", () => {
		const map = JSON.parse(gated().files["_linemap.json"]);
		assert.deepEqual(Object.keys(map).sort(), ["linear", "notion", "wide"]);
		assert.equal(Object.keys(map.wide).length, 25);
	});
});

describe("the refusal speaks the read tool's language", () => {
	const client = renderClient({ readGate: true, apiLayout: "consolidated" });

	it("names the read tool and rules out the alternatives", () => {
		// The model's strongest habit is the read tool, and it is the ONLY thing the
		// ledger records — so a message that said `cat` would teach the one move that
		// cannot clear the gate. Affordance rule: match the idiom, do not invent one.
		assert.match(client, /with the read tool/);
		assert.match(client, /cat, help\(\) and open\(\) inside a cell do not count/);
	});

	it("cites the file and the span, and says one read covers the app", () => {
		assert.match(client, /Read api\/\{pkg\}\.py \(this API is lines/);
		assert.match(client, /then re-issue the call/);
		assert.match(client, /One read of that file covers all/);
	});

	it("marks NOTHING before raising — the property the docs gate lacks", () => {
		// The docs gate's `_DOCS_DELIVERED.add(key)` before its raise is deliberate
		// and is exactly why it was skippable. There must be no analogue here: the
		// only state is the ledger, which this process cannot write.
		assert.equal(/_DOCS_DELIVERED|\.add\(key\)/.test(client), false, "the read gate records a delivery, so it can be cleared without reading");
		const raise = client.indexOf("raise ReadFirst(");
		const body = client.slice(client.indexOf("def _read_first("), raise);
		assert.equal(/open\([^)]*\)\s*as[^:]*:\s*handle\.write|append/.test(body), false, "the gate writes to its own evidence");
	});

	it("ReadFirst subclasses McpError, so existing handling still catches it", () => {
		assert.match(client, /class ReadFirst\(McpError\):/);
	});

	it("announces itself in INDEX.md as a precondition, not a first-use hint", () => {
		const index = gated().files["INDEX.md"];
		assert.match(index, /raises `ReadFirst`/);
		assert.match(index, /Retrying without reading/);
		assert.match(index, /one read covers/);
	});
});

describe("the preamble, which is the only place the agent is told any of this", () => {
	const ctx = { toolCount: 469, serverCount: 10, apiLayout: "consolidated" };

	it("says read/grep TOOLS and never cat, under the gate", () => {
		const text = buildPreamble("a1", { ...ctx, readGate: true });
		assert.match(text, /ALWAYS use the `read` and\n?`grep` TOOLS/);
		assert.match(text, /read api\/<app>\.py/);
		assert.equal(/cat api\//.test(text), false, "the read-gate preamble teaches `cat`, which cannot clear the gate");
	});

	// The measured failure this wording exists to fix: given read/grep/find/ls the
	// agent grepped once, ineffectively, then hand-rolled
	// `[l for l in open('api/phone.py') if l.startswith('async def')]` — which
	// strips the docstrings the gate is about. 54 of 703 cells across 62 nav+rg
	// runs read an api/ file from Python. The counter-wording is Claude Code's own
	// (`tool-description-bash-prefer-dedicated-tools`, `tool-description-grep`),
	// so assert on both halves: the prohibition, and the motion that replaces it.
	it("forbids hand-rolled reads and teaches locate-then-window", () => {
		const text = buildPreamble("a1", { ...ctx, readGate: true });
		assert.match(text, /NEVER read or search/);
		assert.match(text, /Python \(`open\(\)`/);
		assert.match(text, /grep 'def reply_to_email' api\//);
		assert.match(text, /read api\/gmail\.py offset=412 limit=60/);
	});

	// The entry point sets the mode for the whole trajectory. MEASURED: the very
	// first action of the ce73d68_1 nav+rg run was
	// `import subprocess; print(open('api/INDEX.md').read())` — the run began in
	// read-files-with-Python mode and never left it. So the FIRST instruction about
	// the tree has to name the tool, not just the file, in Claude Code's own
	// imperative form ("Start by using the Read tool on …").
	it("models the read tool in the first instruction, before any other guidance", () => {
		const text = buildPreamble("a1", { ...ctx, readGate: true });
		const first = text.indexOf("Start by using the `read` TOOL on api/INDEX.md");
		assert.ok(first > 0, "the preamble never tells the agent which tool opens the tree first");
		assert.ok(
			first < text.indexOf("ALWAYS use"),
			"the entry-point instruction must come before the general rule, or it is not the entry point",
		);
	});

	it("states the precondition and that one read covers the app", () => {
		const text = buildPreamble("a1", { ...ctx, readGate: true });
		assert.match(text, /raises `ReadFirst`/);
		assert.match(text, /retrying without reading raises\n?again/);
		assert.match(text, /one read per app, not one per API/);
	});

	it("is byte-identical to the shipped preamble when the gate is off", () => {
		// Every other line — async, the persistent kernel, the call site — must not
		// move, or the A/B measures a reworded prompt instead of a precondition.
		assert.equal(buildPreamble("a1", ctx), buildPreamble("a1", { ...ctx, readGate: false }));
		assert.match(buildPreamble("a1", ctx), /cat api\/<app>\.py/);
	});
});

describe("the ledger extension is the only writer, and records what was SEEN", () => {
	it("hooks prime's tool_result, which fires for builtins too", () => {
		assert.match(EXTENSION, /pi\.on\("tool_result"/);
		assert.match(EXTENSION, /event\.toolName !== "read" && event\.toolName !== "grep"/);
	});

	it("records the truncated line count, not the range that was asked for", () => {
		// read truncates at 2000 lines / 50KB and AppWorld's api/spotify.py is 66KB, so
		// a whole-file read of it delivers roughly the first 1,150 lines. Recording the
		// request would certify a contract the model never received — the same class as
		// `find_spec` certifying a module with a syntax error in it.
		assert.match(EXTENSION, /truncation\?\.firstLineExceedsLimit/);
		assert.match(EXTENSION, /truncation\.outputLines/);
	});

	it("appends synchronously, because the reader is another process", () => {
		assert.match(EXTENSION, /appendFileSync/);
	});

	it("logs grep as evidence and gives it no window", () => {
		assert.match(EXTENSION, /tool: "grep"[^}]*pattern/);
	});
});

describe("the runner proves the gate bound, rather than trusting the flag", () => {
	it("asserts every app it called was read first, and that refusals happened", () => {
		// The sibling failure: a residency guard caught "the schemas are still
		// resident" and NOTHING caught "narrowing worked and execution broke". The
		// equivalent here is a gate that silently never fires.
		assert.match(RUNNER, /summary\.readGateViolation =/);
		assert.match(RUNNER, /the gate did not bind, so this is not a read-gate run/);
		assert.match(RUNNER, /the extension did not load, so this is not a read-gate run/);
		assert.match(RUNNER, /readBeforeFirstCall/);
	});

	it("persists every refusal with the turn it landed on, not just a count", () => {
		// "Log the inputs, not just the verdicts": a count cannot answer whether the
		// correction in the error channel was acted on next cell.
		assert.match(RUNNER, /readFirstRaises\.push\(\{ turn: summary\.turns, message/);
	});

	it("keeps the ledger inside api/, which --force wipes", () => {
		// A ledger that survived a re-run would satisfy the gate with the PREVIOUS
		// attempt's reads — the TAC `docker cp` staging bug through another door.
		assert.match(RUNNER, /const READ_LEDGER = join\(runDir, "api", "\.read-ledger\.jsonl"\)/);
		assert.match(RUNNER, /for \(const staleDir of \[[^\]]*"api"/);
	});
});

describe("executed against a stub proxy and a real ledger", () => {
	// String assertions certify that the text is there. `find_spec` once certified a
	// module that contained a syntax error, because locating a module does not
	// execute it — so the gate is also driven, through a full refuse/read/retry loop.
	const dirs = [];
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	it("refuses, stays refused, and is satisfied only by a covering read", () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-readgate-"));
		dirs.push(dir);
		for (const [rel, content] of Object.entries(gated().files)) {
			const path = join(dir, "api", rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		assert.match(execFileSync("python3", [PROBE, dir], { encoding: "utf8", stdio: "pipe" }), /OK/);
	});

	it("every generated module still compiles", () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-readgate-parse-"));
		dirs.push(dir);
		for (const [rel, content] of Object.entries(gated().files)) {
			if (!rel.endsWith(".py")) continue;
			const path = join(dir, rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
			assert.doesNotThrow(
				() => execFileSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", path], { stdio: "pipe" }),
				`generated module does not parse: ${rel}`,
			);
		}
	});
});
