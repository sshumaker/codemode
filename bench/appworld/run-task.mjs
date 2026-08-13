#!/usr/bin/env node
/**
 * Run one AppWorld task through one arm, capturing everything.
 *
 *   bench/appworld/run-task.mjs <env-file> <model> <task-id> <arm> [options]
 *
 *   arms      codemode | vanilla | notools
 *   options   --residency L0|L1|L2|L4  --prompt a1  --vanilla-prompt b1|b2
 *             --timeout 900  --max-cost 1.0  --run-id X  --force
 *             --docs-gate[=redirect|inline]  --nav-tools
 *                                     (codemode only; both default OFF)
 *
 * Per-run artefacts under .run/appworld/<runId>/ — the answer to "could I
 * re-derive this verdict tomorrow, after the environment has been reset?":
 *
 *   meta.json          task, arm, residency, model, catalogue digest, versions
 *   system-prompt.json base prompt, preamble, and the EXACT tool list sent
 *   tools.json         the resolved tool definitions (vanilla) — what the model saw
 *   trajectory.jsonl   every stream event, each stamped `_t` on receipt
 *   stream.jsonl       the raw stream, unmodified
 *   env-calls.jsonl    every API call with its args AND its full response
 *   world-diff.json    every DB record added/changed/removed, before grading
 *   evaluation.json    grader verdicts, per-test tracebacks, AND its inputs
 *   dbs/               AppWorld's own state dump; replayable against base_dbs
 *   api/               (codemode) the tool tree the agent actually had
 *   result.json        parsed summary + phases + stopReason
 *   env-server.log     the world process's stderr
 *
 * The three things this project has been burned by, and where each is handled:
 *   - a verdict without its evidence      -> world-diff.json + dbs/ + evaluation.json
 *   - an arm reaching around its tools    -> one transport, env-server /call only
 *   - base prompts differing between arms -> one BASE, byte-identical, logged
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { docsGateMode, generate, renderFullDocs, renderTocLines } from "../generate.mjs";
import { BASE_PROMPTS, buildBase, buildPreamble, buildVanillaPreamble } from "./prompts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/cli.js");
const APPWORLD = join(ROOT, "vendor/appworld");
const PYTHON = join(APPWORLD, ".venv/bin/python3");
const ENV_SERVER = join(ROOT, "bench/appworld/env-server.py");
const CATALOGUE = join(ROOT, "bench/data/appworld-schemas.json");
// The vanilla arm's tool extension. Reused verbatim from the MCP-Bench arm: it
// reads the same catalogue shape and POSTs to the same /call protocol, so the
// AppWorld env-server is a drop-in for the MCP proxy. Not re-implemented.
const EXTENSION = join(ROOT, "bench/arms/mcp-tools-extension.ts");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const [envFile, model, taskId, arm] = positional;

if (!envFile || !model || !taskId || !arm) {
	console.error("usage: bench/appworld/run-task.mjs <env-file> <model> <task-id> <arm> [--residency L0|L1|L2|L4]");
	process.exit(2);
}
if (!["vanilla", "codemode", "notools"].includes(arm)) {
	console.error(`unknown arm: ${arm}`);
	process.exit(2);
}
for (const [label, path] of [["prime-agent CLI", CLI], ["appworld venv python", PYTHON], ["catalogue", CATALOGUE]]) {
	if (!existsSync(path)) {
		console.error(`missing ${label}: ${path}`);
		if (path === CATALOGUE) console.error("  run: node bench/appworld/build-catalogue.mjs");
		process.exit(2);
	}
}

const residency = flag("residency", arm === "codemode" ? "L0" : arm === "notools" ? "none" : "L4");
// Mirrors upstream's own baseline: bench/appworld/predict-apis.py narrows 469 APIs
// to <=20 with one LLM call before the agent starts, and only those are registered.
const PREDICTOR = join(ROOT, "bench/appworld/predict-apis.py");
const MAX_PREDICTED = Number(flag("max-predicted-apis", 20));
const timeoutSec = Number(flag("timeout", 900));
/**
 * Budget cap, in dollars, checked as usage streams in.
 *
 * Cost rather than turns: turns are not comparable units across arms, since
 * vanilla batches parallel tool calls into one turn while codemode issues one
 * cell per turn, so a turn cap silently penalises codemode's style.
 *
 * $3, not the $1 used on MCP-Bench. Measured on the first real pair: vanilla L4's
 * FIRST turn writes 101,113 prompt tokens of cache — $0.63 before it has done
 * anything — and it hit a $1 cap after 6 turns on a task it had already solved.
 * A cap that binds one arm and not the other stops being the arm-neutral control
 * it was chosen to be and starts truncating one arm's trajectories. Cost is still
 * reported per run; it is a result, not a constraint.
 */
const maxCost = Number(flag("max-cost", 3.0));
const promptName = flag("prompt", "a1");
const vanillaPromptName = flag("vanilla-prompt", residency === "L1" ? "b2" : residency === "predicted" ? "b3" : "b1");
const promptSuffix = arm === "codemode" ? `__${promptName}` : arm === "vanilla" ? `__${vanillaPromptName}` : "";

/**
 * Two opt-in codemode variants, both OFF by default and both A/B'd before they
 * become anything.
 *
 * --docs-gate[=redirect|inline]
 *              First use of an API is answered with documentation instead of a
 *              result. Motivated by a measured loss: on 4242c97_1 the agent read
 *              only api/INDEX.md, whose one-liner for `complete_task` reads "Mark
 *              the currently active task as complete with the given answer", and
 *              volunteered answer="navy blue" where the ground truth wanted none.
 *              The file it never opened says to pass an answer only if the task
 *              asks a question. A summary is where the task was lost.
 *
 *              `redirect` (the default, and the primary form) sends the agent to
 *              api/<pkg>/DOCS.md and inlines nothing: the file carries the app's
 *              conventions, its siblings and its structure, which a single
 *              docstring cannot, and going to read a file is in-distribution
 *              behaviour. It costs one extra turn, which is what the A/B prices.
 *              `inline` is the alternate — docstring plus nearest siblings in the
 *              message — so the two can be compared rather than assumed.
 * --nav-tools  Adds prime's read/grep/find/ls to the codemode tool list, so
 *              looking at the tree is not something that has to be spelled as a
 *              shell escape inside a cell. NOT bash: a shell is an escape hatch
 *              out of the surface under test, and 78% of vanilla's bash calls on
 *              MCP-Bench were `curl` straight to the APIs its tools wrapped.
 *
 * Each appears in the runId, because a variant run that overwrites the run it is
 * being compared against destroys the comparison — the runId-collision failure
 * this file already guards against.
 */
function parseDocsGate() {
	const i = argv.findIndex((a) => a === "--docs-gate" || a.startsWith("--docs-gate="));
	if (i < 0) return "off";
	// `--docs-gate=inline`, `--docs-gate inline`, and a bare `--docs-gate` (the
	// primary form). An unknown mode throws rather than degrading to off: a run
	// labelled with a mode it is not in is the failure this project keeps finding.
	if (argv[i].includes("=")) return docsGateMode(argv[i].split("=").slice(1).join("="));
	const next = argv[i + 1];
	return docsGateMode(next && !next.startsWith("--") ? next : "redirect");
}
const docsGate = parseDocsGate();
const navTools = argv.includes("--nav-tools");
/**
 * --base-prompt=v1|v2 — which shared base prompt every arm receives.
 *
 * Arm-neutral by construction: this selects the string all three arms are given, so
 * a v2 run is only interpretable if every arm on the task is on v2. It lands in the
 * runId for the same reason the codemode variants do — a v2 run that overwrote the
 * v1 baseline it is being compared against would destroy the comparison.
 */
const basePromptVersion = (() => {
	const i = argv.findIndex((a) => a === "--base-prompt" || a.startsWith("--base-prompt="));
	if (i < 0) return "v1";
	const value = argv[i].includes("=") ? argv[i].split("=").slice(1).join("=") : argv[i + 1];
	if (!BASE_PROMPTS[value]) {
		console.error(`unknown --base-prompt: ${value} (have ${Object.keys(BASE_PROMPTS).join("|")})`);
		process.exit(2);
	}
	return value;
})();
if ((docsGate !== "off" || navTools) && arm !== "codemode") {
	console.error(`--docs-gate/--nav-tools apply to the codemode arm only, got arm=${arm}`);
	process.exit(2);
}
const variantSuffix =
	`${docsGate === "off" ? "" : `__gate-${docsGate}`}${navTools ? "__nav" : ""}` +
	// v1 contributes nothing, so every already-reported baseline keeps its runId.
	`${basePromptVersion === "v1" ? "" : `__bp-${basePromptVersion}`}`;
const runId = flag("run-id", `${taskId}__${arm}__${residency}${promptSuffix}${variantSuffix}__${model.replace(/[^a-z0-9]/gi, "-")}`);
const runDir = join(ROOT, ".run/appworld", runId);

// Never silently overwrite a completed run. A runId scheme change once replaced
// two already-reported runs mid-experiment.
if (existsSync(join(runDir, "result.json")) && !argv.includes("--force")) {
	console.error(`run already exists: ${runId}\n  pass --force to overwrite, or delete the directory`);
	process.exit(3);
}
// `--force` has to clear the append-only artefacts, not just let result.json be
// rewritten over them.
//
// env-calls.jsonl is opened in append mode on purpose — a crashed run should keep
// everything up to the crash. Combined with --force that silently *merged* two
// runs: a re-run reported 122 api calls with 61 duplicates where the run had
// actually made 61 with none. The duplicate count was the previous attempt. Same
// family as the runId collision that once replaced two already-reported runs.
if (existsSync(runDir)) {
	for (const stale of ["env-calls.jsonl", "world-diff.json", "evaluation.json", "phases.json", "env-server.json", "trajectory.jsonl", "stream.jsonl", "env-server.log"]) {
		rmSync(join(runDir, stale), { force: true });
	}
	for (const staleDir of ["appworld-output", "api", "agent-home"]) {
		rmSync(join(runDir, staleDir), { recursive: true, force: true });
	}
}
mkdirSync(runDir, { recursive: true });

const phases = {};
const mark = (name) => {
	phases[name] = Date.now();
};
mark("startedAt");

// --- catalogue ---------------------------------------------------------------

const catalogueRaw = readFileSync(CATALOGUE, "utf8");
const { catalogue, appworldDataVersion, withResponseSchemas } = JSON.parse(catalogueRaw);
const { toolDefs, tocLines, names, files, normalized } = generate(catalogue, { docsGate });

if (arm === "codemode") {
	for (const [rel, content] of Object.entries(files)) {
		const path = join(runDir, "api", rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
}

// --- the world --------------------------------------------------------------

/**
 * Start the AppWorld world and block until it says it is listening.
 *
 * Blocking matters: an unrecorded run looks identical to a recorded one, which is
 * why TAC's proxy also verifies it is up before the agent starts.
 */
function startEnvServer() {
	const logStream = createWriteStream(join(runDir, "env-server.log"));
	const child = spawn(
		PYTHON,
		[ENV_SERVER, "--task-id", taskId, "--run-dir", runDir, "--arm", arm, "--appworld-root", APPWORLD],
		{ cwd: APPWORLD, stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stderr.pipe(logStream);
	return new Promise((resolve, reject) => {
		let out = "";
		const timer = setTimeout(() => reject(new Error(`env-server did not become ready in 180s\n${out}`)), 180_000);
		child.stdout.on("data", (d) => {
			out += d;
			logStream.write(d);
			const m = /ENV_SERVER_READY port=(\d+)/.exec(out);
			if (m) {
				clearTimeout(timer);
				resolve({ child, port: Number(m[1]) });
			}
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`env-server exited early with code ${code}; see env-server.log`));
		});
	});
}

const post = async (port, path, body) => {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	return response.json();
};
const get = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();

/** The task instruction and supervisor, read out of AppWorld rather than guessed. */
function loadTaskFacts() {
	const script = [
		"import warnings, json; warnings.filterwarnings('ignore')",
		"from appworld.task import Task",
		`t = Task.load(task_id="${taskId}")`,
		"apps = {k: v for k, v in t.app_descriptions.items() if k not in ('api_docs', 'admin')}",
		"print('<<<JSON>>>' + json.dumps({",
		"  'instruction': t.instruction,",
		"  'supervisor': dict(t.supervisor),",
		"  'appDescriptions': apps,",
		"  'allowedApps': list(t.allowed_apps),",
		"  'dbVersion': t.db_version,",
		"}))",
	].join("\n");
	const out = execFileSync(PYTHON, ["-c", script], { cwd: APPWORLD, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	return JSON.parse(out.slice(out.indexOf("<<<JSON>>>") + 10));
}

const facts = loadTaskFacts();

/**
 * Run upstream's APIPredictor and return the wire names it chose.
 *
 * The prediction is a full artefact in the run directory, not a side effect: it
 * determines which tools this arm ever sees, so a verdict without it is not
 * reproducible. It also costs a real LLM call, which is the price this baseline
 * pays and which L1 does not.
 */
function predictedToolNames() {
	const out = join(runDir, "prediction.json");
	execFileSync(
		"bash",
		[
			"-c",
			`set -a; . "$1"; set +a; shift; exec "$@"`,
			"_",
			envFile,
			PYTHON,
			PREDICTOR,
			"--task-id",
			taskId,
			"--out",
			out,
			"--model",
			model.replace(/^anthropic\//, ""),
			"--max-apis",
			String(MAX_PREDICTED),
			"--appworld-root",
			APPWORLD,
		],
		{ cwd: APPWORLD, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	const prediction = JSON.parse(readFileSync(out, "utf8"));
	// `app.api` -> the wire name the extension and the tool list use.
	const wanted = new Set(prediction.predictedApis.map((a) => a.replace(".", "__")));
	const names = toolDefs.map((d) => d.name).filter((n) => wanted.has(n));
	const missing = [...wanted].filter((n) => !names.includes(n));
	if (missing.length > 0) console.error(`[predicted] ${missing.length} predicted name(s) not in catalogue: ${missing.join(",")}`);
	if (names.length === 0) throw new Error("predictor returned no usable tools");
	return { names, prediction };
}

let predicted = null;
if (arm === "vanilla" && residency === "predicted") predicted = predictedToolNames();
const supervisorName = `${facts.supervisor.first_name} ${facts.supervisor.last_name}` +
	` (email ${facts.supervisor.email}, phone ${facts.supervisor.phone_number})`;
const appsBlock = Object.entries(facts.appDescriptions)
	.map(([app, description]) => `  ${app} — ${String(description).trim().split("\n")[0]}`)
	.join("\n");

// --- prompts ----------------------------------------------------------------

// One base prompt, byte-identical across arms. Digested into meta.json so a
// divergence between two runs is detectable rather than something to be trusted.
const basePrompt = buildBase({ supervisor: supervisorName, apps: appsBlock, version: basePromptVersion });

function preambleFor() {
	const ctx = { toolCount: toolDefs.length, serverCount: catalogue.length };
	if (arm === "notools") return "";
	if (arm === "vanilla") {
		if (residency === "predicted") {
			// The count the agent is told is the count it actually has, not 469.
			return buildVanillaPreamble(vanillaPromptName, { ...ctx, toolCount: predicted.names.length });
		}
		const body = buildVanillaPreamble(vanillaPromptName, ctx);
		if (residency === "L4") return body;
		// This arm calls tools by their wire name, so its name list and TOC have to
		// be addressed that way. `generate()` renders both in python style for
		// codemode; a TOC the agent cannot act on is worse than no TOC.
		if (residency === "L1") return `${body}\n\nAvailable functions:\n${toolDefs.map((d) => d.name).join("\n")}`;
		if (residency === "L2") {
			const wireToc = normalized.flatMap(({ server, tools }) => renderTocLines(tools, { server, style: "wire" }));
			return `${body}\n\nAvailable functions:\n${wireToc.join("\n")}`;
		}
		throw new Error(`unsupported vanilla residency: ${residency}`);
	}
	const pointer = buildPreamble(promptName, ctx);
	if (residency === "L0") return pointer;
	if (residency === "L1") return `${pointer}\n\nAvailable functions:\n${names.join("\n")}`;
	if (residency === "L2") return `${pointer}\n\nAvailable functions:\n${tocLines.join("\n")}`;
	if (residency === "L4") {
		// The docs-resident code cell of the 2x2. Same container as the api/ tree,
		// relocated into the prompt — which is what upstream's own full-code agent
		// does, and why it needs the same <=20-API predictor as their tool-calling
		// agent. If codemode's advantage survives this, the mechanism is
		// representation; if it does not, the mechanism is residency.
		const docs = normalized.map(({ server, tools }) => renderFullDocs(tools, { server })).join("\n");
		return `${pointer}\n\n## Full API documentation\n\nEvery function is documented below, so you do not need to read \`api/\` at all.\n\n${docs}`;
	}
	throw new Error(`unsupported codemode residency: ${residency}`);
}
const preamble = preambleFor();

const BUILTINS = ["read", "edit", "write", "grep", "find", "ls"];
let toolList;
if (arm === "notools") toolList = [];
else if (arm === "vanilla") {
	// `--tools` is an allowlist that filters extension-registered tools too, so
	// every MCP tool has to be named or its definition never reaches the model and
	// the arm silently falls back to whatever else it has.
	// L1 does NOT allowlist the 469: its tools are never registered individually,
	// so naming them would be dead weight in the allowlist. L4 must name every one,
	// because `--tools` filters extension-registered tools too and an unnamed tool's
	// definition silently never reaches the model.
	toolList =
		residency === "L1"
			? [...BUILTINS, "search_tools", "describe_tool", "call_tool"]
			: residency === "predicted"
				? [...BUILTINS, ...predicted.names]
				: [...BUILTINS, ...toolDefs.map((d) => d.name)];
} else {
	// No `bash` tool for either arm: a shell is an escape hatch out of the surface
	// under test. codemode keeps `%%bash` inside a cell, which is part of what
	// "code as the action space" means; a separate bash tool is not.
	toolList = ["ipython"];
	// --nav-tools: read-only navigation of the api/ tree the arm already has.
	// Still no bash, edit or write — the one-transport invariant is about egress,
	// and none of these four can reach the network.
	if (navTools) toolList = [...toolList, "read", "grep", "find", "ls"];
}

const digest = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

writeFileSync(
	join(runDir, "system-prompt.json"),
	`${JSON.stringify(
		{
			runId,
			arm,
			residency,
			variants: { docsGate, navTools, basePromptVersion },
			// The two halves, separately, so "was the base identical?" is a diff and
			// not an argument.
			basePrompt,
			basePromptDigest: digest(basePrompt),
			preamble,
			preambleDigest: digest(preamble),
			basePromptChars: basePrompt.length,
			preambleChars: preamble.length,
			// The exact list handed to --tools, in order.
			toolList,
			userPrompt: facts.instruction,
		},
		null,
		1,
	)}\n`,
);
// What the model actually saw as schemas. For codemode this is empty by
// construction, which is the point; api/ on disk is the counterpart.
writeFileSync(
	join(runDir, "tools.json"),
	`${JSON.stringify(arm === "vanilla" && residency === "L4" ? toolDefs : [], null, 1)}\n`,
);

const meta = {
	runId,
	benchmark: "appworld",
	arm,
	residency,
	model,
	task: { id: taskId, instruction: facts.instruction, allowedApps: facts.allowedApps, dbVersion: facts.dbVersion },
	catalogue: {
		apps: catalogue.length,
		tools: toolDefs.length,
		digest: digest(catalogueRaw),
		appworldDataVersion,
		withResponseSchemas,
	},
	promptVariant: arm === "codemode" ? promptName : arm === "vanilla" ? vanillaPromptName : undefined,
	// Which opt-in codemode variants were on. A run compared against another must
	// be able to say which condition it was in without re-reading the api/ tree.
	variants: { docsGate, navTools, basePromptVersion },
	basePromptDigest: digest(basePrompt),
	preambleChars: preamble.length,
	toolCount: toolList.length,
	startedAt: new Date().toISOString(),
};
writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

// --- run --------------------------------------------------------------------

const summary = {
	turns: 0,
	toolCalls: 0,
	toolNames: [],
	toolErrors: 0,
	errorMessages: [],
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	finalText: "",
};

async function main() {
	mark("worldStart");
	const { child: env, port } = await startEnvServer();
	mark("worldReady");
	console.log(`[appworld] world up on :${port} for ${taskId}`);

	const cliArgs = [
		CLI,
		"-p",
		"--mode",
		"json",
		"--model",
		model,
		...(arm === "notools" ? ["--no-tools"] : ["--tools", toolList.join(",")]),
		"--cwd",
		runDir,
		// Skills stay ENABLED. `--no-skills` on MCP-Bench removed `attach_image` and
		// `edit`, and 0.809 was measured on a deliberately reduced harness as a
		// result (TAC bug #2). Context files and prompt templates are still off:
		// those are reproducibility hazards, not capabilities.
		"--no-context-files",
		"--no-prompt-templates",
		"--system-prompt",
		basePrompt,
	];
	if (arm === "vanilla") cliArgs.push("--extension", EXTENSION);
	else cliArgs.push("--no-extensions");
	if (preamble) cliArgs.push("--append-system-prompt", preamble);
	cliArgs.push(facts.instruction);

	const proxy = `http://127.0.0.1:${port}`;
	const child = spawn("bash", ["-c", `set -a; . "$1"; set +a; shift; exec node "$@"`, "_", envFile, ...cliArgs], {
		cwd: runDir,
		env: {
			...process.env,
			PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`,
			DO_NOT_TRACK: "1",
			PRIME_AGENT_TELEMETRY: "0",
			PRIME_AGENT_CODING_AGENT_DIR: join(runDir, "agent-home"),
			// Both arms' transports read these. The env-server speaks the MCP proxy's
			// protocol precisely so nothing here needs an AppWorld-specific branch.
			HARNESS_MCP_PROXY: proxy,
			HARNESS_MCP_CATALOGUE: CATALOGUE,
			HARNESS_MCP_SERVERS: catalogue.map((s) => s.server).join(","),
			HARNESS_RUN_ID: runId,
			HARNESS_RESIDENCY: residency,
			// Provenance only. The gate itself is rendered into api/_client.py at
			// generate time, not switched on here: the kernel is a grandchild process
			// and an env var that failed to propagate would silently produce a
			// gate-off run wearing a gate-on label.
			...(docsGate === "off" ? {} : { HARNESS_DOCS_GATE: docsGate }),
			// Optional narrowing, passed straight through from the environment so a
			// targeted gate needs no new flag: HARNESS_DOCS_GATE_ONLY=supervisor.complete_task
			...(process.env.HARNESS_DOCS_GATE_ONLY
				? { HARNESS_DOCS_GATE_ONLY: process.env.HARNESS_DOCS_GATE_ONLY }
				: {}),
			...(predicted ? { HARNESS_TOOL_SUBSET: predicted.names.join(",") } : {}),
			// AppWorld is entirely local, so there is no legitimate egress. A dead
			// proxy for everything except the world and the model API is what stops an
			// arm reaching around its own tool surface — 78% of vanilla's bash calls on
			// MCP-Bench were `curl` to the APIs its tools wrapped.
			...(process.env.HARNESS_ALLOW_DIRECT_NET === "1"
				? {}
				: {
						http_proxy: "http://127.0.0.1:9",
						https_proxy: "http://127.0.0.1:9",
						HTTP_PROXY: "http://127.0.0.1:9",
						HTTPS_PROXY: "http://127.0.0.1:9",
						no_proxy: "127.0.0.1,localhost,api.anthropic.com",
						NO_PROXY: "127.0.0.1,localhost,api.anthropic.com",
					}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	const streamFile = createWriteStream(join(runDir, "stream.jsonl"));
	// Every event stamped on receipt. On TAC exactly 1 of 125 events carried a
	// timestamp, and locating a 2,300s hole had to be inferred from durationMs.
	const trajectoryFile = createWriteStream(join(runDir, "trajectory.jsonl"));
	const counted = new Set();
	let buffer = "";
	let stderr = "";
	mark("agentStart");

	const killTimer = setTimeout(() => {
		summary.timedOut = true;
		child.kill("SIGKILL");
	}, timeoutSec * 1000);

	function enforceBudget() {
		if (maxCost > 0 && summary.cost >= maxCost) {
			summary.budgetExceeded = true;
			child.kill("SIGKILL");
		}
	}

	child.stderr.on("data", (d) => {
		stderr = (stderr + d).slice(-8000);
	});

	child.stdout.on("data", (chunk) => {
		streamFile.write(chunk);
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("{")) continue;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			trajectoryFile.write(`${JSON.stringify({ _t: new Date().toISOString(), ...event })}\n`);
			if (event.type === "tool_execution_start") {
				summary.toolCalls++;
				summary.toolNames.push(event.toolName);
			} else if (event.type === "tool_execution_end" && event.isError) {
				summary.toolErrors++;
				const text = (event.result?.content ?? []).map((c) => c.text ?? "").join(" ");
				summary.errorMessages.push(text.slice(0, 300));
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				const message = event.message;
				const texts = (message.content ?? []).filter((c) => c.type === "text" && c.text);
				if (texts.length > 0) summary.finalText = texts.map((c) => c.text).join("");
				const id = message.responseId;
				if (id && !counted.has(id) && message.usage?.totalTokens) {
					counted.add(id);
					if (summary.turns === 0) {
						const u = message.usage;
						summary.firstTurnPromptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
					}
					summary.turns++;
					for (const k of ["input", "output", "cacheRead", "cacheWrite"]) summary[k] += message.usage[k] ?? 0;
					summary.cost += message.usage.cost?.total ?? 0;
					enforceBudget();
				}
			}
		}
	});

	const exitCode = await new Promise((resolve) => child.on("close", resolve));
	clearTimeout(killTimer);
	streamFile.end();
	trajectoryFile.end();
	mark("agentEnd");

	summary.exitCode = exitCode;
	summary.stderrTail = stderr.split("\n").slice(-8).join("\n");
	summary.stopReason = summary.budgetExceeded ? "budget" : summary.timedOut ? "timeout" : "completed";
	summary.maxCost = maxCost;

	// Residency guard. A run labelled L0 whose first turn carries 60k prompt tokens
	// is an L4 run under a different name, and would corrupt every comparison it
	// appears in. AppWorld's catalogue is 469 tools / ~62k tokens, so the L4 budget
	// is genuinely large and the others genuinely small.
	if (summary.firstTurnPromptTokens !== undefined) {
		const budget = { L0: 8_000, L1: 12_000, L2: 24_000, L4: Infinity, predicted: 20_000, none: 8_000 }[residency] ?? Infinity;
		if (summary.firstTurnPromptTokens > budget) {
			summary.residencyViolation =
				`${residency} first turn carried ${summary.firstTurnPromptTokens} prompt tokens ` +
				`(budget ${budget}) — the catalogue was resident, so this is not a ${residency} run`;
		}
		// The mirror bug, which the upper bound cannot catch: a cell whose
		// documentation never reached the prompt is an L0 run wearing an L4 label,
		// and it reads as "docs-in costs nothing" — the opposite of the true answer,
		// in the direction that flatters the headline.
		//
		// Derived from the preamble this run built rather than a constant, so the
		// same check works on MCP-Bench, whose catalogue is per-task and an order of
		// magnitude smaller than AppWorld's uniform ~62k. Retro-applied to the 243
		// runs already collected: L0 4604-4939, L1 8966-9077, L4 67989-101219 — no
		// overlap between levels and no violations, so the residency dial on the
		// existing AppWorld result is real.
		const preambleTokens = meta.preambleChars / 4;
		if (preambleTokens > 1_000 && summary.firstTurnPromptTokens < preambleTokens * 0.6) {
			summary.residencyViolation =
				`${residency} first turn carried only ${summary.firstTurnPromptTokens} prompt tokens ` +
				`against a preamble of ~${Math.round(preambleTokens)} — the preamble did not reach the model`;
		}
	}

	// Snapshot BEFORE grading, then grade. Order matters: the snapshot is the
	// grader's input, and taking it afterwards would record a world the verdict was
	// not computed from.
	mark("snapshotStart");
	let snapshot = null;
	let evaluation = null;
	try {
		snapshot = await get(port, "/snapshot");
	} catch (error) {
		summary.snapshotError = String(error);
	}
	mark("snapshotEnd");
	mark("gradeStart");
	try {
		evaluation = await post(port, "/evaluate", {});
	} catch (error) {
		summary.evaluateError = String(error);
	}
	mark("gradeEnd");
	try {
		await post(port, "/phases", phases);
		await post(port, "/shutdown", {});
	} catch {
		// The world is going away regardless.
	}
	// Wait for the world process to exit on its own before killing it.
	//
	// Its shutdown path copies AppWorld's own artefacts — `dbs/` (the state dump the
	// verdict is re-derivable from), `logs/api_calls.jsonl`, `logs/environment_io.md`
	// — into the run directory, and that is a multi-megabyte copytree. An immediate
	// SIGTERM won the race and every run silently shipped without `appworld-output/`.
	await new Promise((resolve) => {
		const deadline = setTimeout(() => {
			summary.envServerKilled = true;
			env.kill("SIGKILL");
			resolve();
		}, 60_000);
		env.on("exit", () => {
			clearTimeout(deadline);
			resolve();
		});
	});
	if (!existsSync(join(runDir, "appworld-output", "dbs"))) {
		// Loud, because the alternative is a run that looks complete and is not
		// re-derivable.
		summary.missingAppworldOutput = true;
	}

	// TGC is the metric. Never the test fraction: a do-nothing run scores 1/2 on a
	// read-only task because "no collateral damage" passes trivially.
	summary.success = evaluation?.success ?? null;
	summary.passCount = evaluation?.passCount ?? null;
	summary.totalCount = evaluation?.totalCount ?? null;
	summary.difficulty = evaluation?.report?.difficulty ?? null;
	summary.committedAnswer = evaluation?.committedAnswer ?? null;
	summary.groundTruthAnswer = evaluation?.groundTruthAnswer ?? null;
	summary.changedModels = snapshot?.diff?.changedModelNames ?? null;

	// Calls, read off the one transport rather than from the agent's own account of
	// what it did.
	let envCalls = [];
	const callLog = join(runDir, "env-calls.jsonl");
	if (existsSync(callLog)) {
		envCalls = readFileSync(callLog, "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	}
	summary.apiCalls = envCalls.length;
	summary.apiCallsOk = envCalls.filter((c) => c.ok).length;
	// Malformed calls. `summary.toolErrors` cannot see these: an AppWorld traceback
	// comes back as ordinary text on purpose, so that a bad call does not destroy
	// the rest of a codemode cell while costing vanilla only one tool call. See the
	// execFailed note in env-server.py.
	summary.apiCallsFailed = envCalls.filter((c) => c.execFailed).length;
	summary.distinctApis = new Set(envCalls.map((c) => `${c.app}.${c.api}`)).size;
	// Byte-identical repeats. Not deduplicated anywhere — read-only is not
	// idempotent — but worth measuring, since it is the agent's judgement call.
	summary.duplicateCalls = envCalls.length - new Set(envCalls.map((c) => c.code)).size;
	summary.wallMs = phases.gradeEnd - phases.startedAt;
	summary.phases = phases;

	writeFileSync(join(runDir, "result.json"), `${JSON.stringify({ ...meta, summary }, null, 2)}\n`);

	const tally = [...new Set(summary.toolNames)].join(",") || "none";
	console.log(
		`${arm}/${residency} ${taskId}: ` +
			`${summary.success === true ? "PASS" : "FAIL"} ${summary.passCount}/${summary.totalCount} tests, ` +
			`${summary.turns} turns, ${summary.toolCalls} tool calls (${tally}), ${summary.apiCalls} api calls ` +
			`(${summary.distinctApis} distinct, ${summary.duplicateCalls} dupes), ${summary.toolErrors} errors, ` +
			`$${summary.cost.toFixed(4)}, ${((summary.wallMs ?? 0) / 1000).toFixed(0)}s` +
			`${summary.stopReason === "completed" ? "" : ` [${summary.stopReason.toUpperCase()}]`}`,
	);
	if (summary.residencyViolation) console.log(`  !! ${summary.residencyViolation}`);
	console.log(`  answer: ${JSON.stringify(summary.committedAnswer)} vs gt ${JSON.stringify(summary.groundTruthAnswer)}`);
	console.log(`  -> ${runDir}`);
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	writeFileSync(
		join(runDir, "result.json"),
		`${JSON.stringify({ ...meta, summary: { ...summary, harnessError: String(error), phases } }, null, 2)}\n`,
	);
	process.exit(1);
});
