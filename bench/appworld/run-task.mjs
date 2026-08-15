#!/usr/bin/env node
/**
 * Run one AppWorld task through one arm, capturing everything.
 *
 *   bench/appworld/run-task.mjs <env-file> <model> <task-id> <arm> [options]
 *
 *   arms      codemode | vanilla | notools
 *   options   --residency L0|L1|L2|L4  --prompt a1  --vanilla-prompt b1|b2
 *             --timeout 900  --max-cost 1.0  --run-id X  --force
 *             --docs-gate[=redirect|inline]  --nav-tools  --validate-args
 *             --api-layout=per-method|consolidated  --read-gate
 *             --required-defaults     render the classifier's listed parameters
 *                                     with no default (bench/required-defaults.mjs)
 *                                     (codemode only; all default OFF/per-method)
 *             --catalogue <path>      the shared tool catalogue (arm-neutral)
 *             --base-prompt=v1|v2     the shared base prompt (arm-neutral, default v1)
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
import {
	chmodSync,
	copyFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiLayout, docsGateMode, generate, renderFullDocs, renderTocLines } from "../generate.mjs";
import { loadRequiredDefaults } from "../required-defaults.mjs";
import { BASE_PROMPTS, buildBase, buildPreamble, buildVanillaPreamble } from "./prompts.mjs";
import { seedPrimeSettings } from "../prime-settings.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/cli.js");
const APPWORLD = join(ROOT, "vendor/appworld");
const PYTHON = join(APPWORLD, ".venv/bin/python3");
const ENV_SERVER = join(ROOT, "bench/appworld/env-server.py");
/**
 * The tool catalogue every arm is rendered from.
 *
 * Overridable with `--catalogue` so an enriched catalogue (bench/enrich-catalogue.mjs)
 * can be swapped in — and deliberately NOT per-arm: this file is the single authored
 * source all four containers are rendered from, so a flag that could give one arm
 * better schemas than another would be aimed straight at the fairness invariant.
 */
const DEFAULT_CATALOGUE = "bench/data/appworld-schemas.json";
// The vanilla arm's tool extension. Reused verbatim from the MCP-Bench arm: it
// reads the same catalogue shape and POSTs to the same /call protocol, so the
// AppWorld env-server is a drop-in for the MCP proxy. Not re-implemented.
const EXTENSION = join(ROOT, "bench/arms/mcp-tools-extension.ts");
// The codemode read-gate arm's ledger writer. The ONLY writer of the evidence the
// gate in api/_client.py consults, so the precondition is verified rather than
// advertised. See --read-gate below.
const READ_LEDGER_EXTENSION = join(ROOT, "bench/arms/read-ledger-extension.ts");
/**
 * The codemode `--bash` arm's guard. Registers no tool — it intercepts prime's own
 * `bash` — and here it is doing one job the terminal-bench copy does not: refusing
 * network egress, so that adding a shell does not open a second route to the world.
 */
const BASH_EXTENSION = join(ROOT, "bench/arms/bash-tool-extension.ts");
const JOBS_PY = join(ROOT, "runtime/jobs.py");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const [envFile, model, taskId, arm] = positional;
const cataloguePath = flag("catalogue", DEFAULT_CATALOGUE);
// `resolve`, not `join`: an absolute --catalogue path joined onto ROOT silently
// becomes ROOT-relative and reads a file that is not the one that was asked for.
const CATALOGUE = resolve(ROOT, cataloguePath);

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
 * --read-gate — a VERIFIED read-precondition on every API, in Edit's shape.
 *
 * The docs gate above is skippable by construction (marked-before-raise) and was
 * measured being skipped: on the `ce73d68` family, zero of 12 codemode
 * configurations ever read `reply_to_email`'s contract, the docs-gate ones
 * included, and 35 of 36 runs then omitted the `email_addresses` argument whose
 * default silently redirects the reply to the user themselves.
 *
 * This one cannot be cleared by retrying. The evidence is prime's own `read` tool,
 * recorded by an extension into `api/.read-ledger.jsonl`; the gate in
 * `api/_client.py` re-checks it on every call. See READ_GATE in bench/generate.mjs.
 *
 * Two hard requirements rather than silent coercion, because a run whose label
 * over-claims is the failure this file guards against everywhere else:
 *   --api-layout=consolidated  the cited line span is a property of that layout,
 *   --nav-tools                without the read tool the gate is unsatisfiable.
 */
const readGate = argv.includes("--read-gate");
/**
 * --bash — give codemode a shell, guarded so it cannot become a second transport.
 *
 * `--nav-tools` above says why bash was withheld: 78% of vanilla's bash calls on
 * MCP-Bench were `curl` straight to the APIs its tools wrapped, and here the world
 * is reachable only through the env-server. That reason is about EGRESS, not about
 * shells — so the honest form is not "no bash" but "bash that cannot reach the
 * network", which is what bench/arms/bash-tool-extension.ts enforces and records.
 *
 * Opt-in, and in the runId, because this is a regression question: does adding the
 * tool cost anything on a benchmark that is API work rather than shell work? A run
 * that overwrote the no-bash baseline would destroy the comparison it exists to
 * make.
 */
const bashTool = argv.includes("--bash");
/**
 * --validate-args — check every call's arguments against the source MCP schema
 * inside the agent's process, before the request is sent.
 *
 * Rendered into api/_client.py + api/_schemas.json at generate time for the same
 * reason the docs gate is, and NOT read from the environment by the client: the
 * kernel is a grandchild process, and an env var that failed to propagate would
 * silently produce an unvalidated run wearing a validated label. `HARNESS_VALIDATE_ARGS=1`
 * is accepted here, in the parent, as an equivalent way to ask for it — it selects
 * what gets rendered, and lands in the runId either way.
 */
const validateArgs = argv.includes("--validate-args") || process.env.HARNESS_VALIDATE_ARGS === "1";
/**
 * --required-defaults — render the classifier's listed parameters with no default.
 *
 * The last untested cell of the `ce73d68` mechanism (docs/CC-EDGE-TRACES.md §M1).
 * `gmail.reply_to_email.email_addresses` defaults to "the sender", which on an
 * outbox thread is the user; 35 of 36 codemode runs omitted it and every one
 * failed. Residency did not fix it, and neither did the verified read-gate, which
 * PROVED the model had read that sentence and it omitted the argument anyway.
 * Visible-and-optional loses. This makes the slot impossible to leave empty: the
 * signature carries no default, so omission is a Python TypeError in the cell
 * that made the mistake.
 *
 * The list is never authored by hand — `bench/required-defaults.mjs` derives it
 * from schemas and docstrings only, and every entry carries the verbatim sentence
 * that justifies it. Missing file is a hard failure rather than an empty index,
 * because a `__reqd` run that transformed nothing is a label that over-claims.
 */
const requiredDefaultsFile = flag("required-defaults-file", "bench/data/appworld-required-defaults.json");
const requiredDefaultsOn = argv.includes("--required-defaults");
let requiredDefaults = null;
if (requiredDefaultsOn) {
	const path = resolve(ROOT, requiredDefaultsFile);
	if (!existsSync(path)) {
		console.error(`missing required-defaults list: ${path}\n  run: node bench/required-defaults.mjs <env-file>`);
		process.exit(2);
	}
	requiredDefaults = loadRequiredDefaults(path);
	if (requiredDefaults.size === 0) {
		console.error(`${path} lists no parameters — a --required-defaults run would transform nothing`);
		process.exit(2);
	}
}
/**
 * --api-layout=per-method|consolidated — how the api/ tree is arranged on disk.
 *
 * `consolidated` is one module per app (`api/gmail.py`) instead of one file per
 * method, which is the shape every real SDK and every API reference already has.
 * The call site is identical in both, so this changes what it costs to READ the
 * documentation and nothing else. See API_LAYOUTS in bench/generate.mjs.
 */
const layout = (() => {
	const i = argv.findIndex((a) => a === "--api-layout" || a.startsWith("--api-layout="));
	if (i < 0) return "per-method";
	// A bare `--api-layout` means the non-default form; an unknown value throws
	// rather than degrading, since a run labelled with a layout it is not in is the
	// failure this file already guards against elsewhere.
	if (argv[i].includes("=")) return apiLayout(argv[i].split("=").slice(1).join("="));
	const next = argv[i + 1];
	return apiLayout(next && !next.startsWith("--") ? next : "consolidated");
})();
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
if ((docsGate !== "off" || navTools || validateArgs || readGate || requiredDefaultsOn || bashTool || layout !== "per-method") && arm !== "codemode") {
	console.error(
		`--docs-gate/--nav-tools/--validate-args/--read-gate/--required-defaults/--bash/--api-layout apply to the codemode arm only, got arm=${arm}`,
	);
	process.exit(2);
}
if (bashTool && !existsSync(JOBS_PY)) {
	// Refused, not degraded. The guard's verdict comes from jobs.blocking_sleep, and
	// a `__bash` run whose guard could not load is an unguarded shell wearing a
	// guarded label — the exact failure this file guards against everywhere else.
	console.error(`--bash needs the jobs runtime for its guard: ${JOBS_PY} is missing`);
	process.exit(2);
}
if (readGate && (layout !== "consolidated" || !navTools)) {
	// Refused, not coerced. Coercing would produce a run whose runId says `__rg` and
	// whose tree cannot express the gate (per-method) or whose agent cannot satisfy
	// it (no read tool) — a deadlock reported as a weak arm.
	console.error("--read-gate requires --api-layout=consolidated and --nav-tools");
	process.exit(2);
}
const variantSuffix =
	`${docsGate === "off" ? "" : `__gate-${docsGate}`}${navTools ? "__nav" : ""}${validateArgs ? "__val" : ""}${readGate ? "__rg" : ""}${requiredDefaultsOn ? "__reqd" : ""}${bashTool ? "__bash" : ""}` +
	`${layout === "per-method" ? "" : `__layout-${layout}`}` +
	// v1 contributes nothing, so every already-reported baseline keeps its runId.
	`${basePromptVersion === "v1" ? "" : `__bp-${basePromptVersion}`}` +
	// A different catalogue is a different experiment; without this an enriched run
	// would overwrite the baseline run it is being compared against — the runId
	// collision this file already guards against, arriving through a new door.
	`${cataloguePath === DEFAULT_CATALOGUE ? "" : `__cat-${cataloguePath.split("/").pop().replace(/\.json$/, "").replace(/[^a-z0-9]+/gi, "-")}`}`;
const runId = flag("run-id", `${taskId}__${arm}__${residency}${promptSuffix}${variantSuffix}__${model.replace(/[^a-z0-9]/gi, "-")}`);
const runDir = join(ROOT, ".run/appworld", runId);
// Inside api/ so `--force`'s existing tree wipe clears it: a ledger that survived
// a re-run would satisfy the gate with the PREVIOUS attempt's reads, which is the
// `docker cp` staging bug from TAC arriving through a different door.
const READ_LEDGER = join(runDir, "api", ".read-ledger.jsonl");
// Every bash command and its verdict. NOT inside api/, because it is the evidence
// for "did the shell reach around the transport" and that question has to survive
// a --force re-run's tree wipe being read afterwards; it is cleared explicitly
// alongside the other append-only artefacts below.
const BASH_LEDGER = join(runDir, "bash-calls.jsonl");

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
	for (const stale of ["env-calls.jsonl", "world-diff.json", "evaluation.json", "phases.json", "env-server.json", "trajectory.jsonl", "stream.jsonl", "env-server.log", "bash-calls.jsonl"]) {
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
const { catalogue, appworldDataVersion, withResponseSchemas, enrichment } = JSON.parse(catalogueRaw);
const { toolDefs, tocLines, names, files, normalized } = generate(catalogue, {
	docsGate,
	readGate,
	validateArgs,
	apiLayout: layout,
	requiredDefaults,
});
// What the transform actually did to THIS catalogue, recorded before the run so
// the artefacts answer "which parameters were promoted" without re-deriving it.
// A listed parameter whose tool is not in the catalogue promotes nothing, and a
// run that promoted nothing is not a `__reqd` run.
const promoted = requiredDefaults
	? normalized.flatMap(({ server, tools }) =>
			tools.flatMap((t) => t.params.filter((p) => p.requiredDefault).map((p) => `${server}.${t.name}.${p.name}`)),
		)
	: [];
if (requiredDefaultsOn && promoted.length === 0) {
	console.error("--required-defaults promoted no parameter in this catalogue — the transform did not bind");
	process.exit(2);
}

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
	// `apiLayout` reaches only the codemode preamble, and changes only the lines
	// that say which files to open.
	const ctx = { toolCount: toolDefs.length, serverCount: catalogue.length, apiLayout: layout, readGate };
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
			const wireToc = normalized.flatMap(({ server, pyServer, tools }) => renderTocLines(tools, { server, pkg: pyServer, style: "wire" }));
			return `${body}\n\nAvailable functions:\n${wireToc.join("\n")}`;
		}
		throw new Error(`unsupported vanilla residency: ${residency}`);
	}
	// Which tool for what. Three lines, added only when the tool is: guidance for a
	// capability the arm does not have is the worst of the three states, because the
	// agent follows it and cannot tell whether it misread.
	//
	// The second sentence is load-bearing and is the whole point of saying anything.
	// A shell in a directory full of `api/*.py` invites `curl`, and here there is
	// nothing at any URL — the guard refuses it, but a refusal costs a turn and the
	// prompt is free.
	const pointer =
		buildPreamble(promptName, ctx) +
		(bashTool
			? "\n\nYou also have `bash`, for looking around the filesystem and for local commands. " +
				"It cannot reach the network, and it does not need to: the only way to this environment " +
				"is the `api` package inside `ipython`, and there is nothing at any URL. State lives in " +
				"the kernel, so variables do not survive into a `bash` call."
			: "");
	if (residency === "L0") return pointer;
	if (residency === "L1") return `${pointer}\n\nAvailable functions:\n${names.join("\n")}`;
	if (residency === "L2") return `${pointer}\n\nAvailable functions:\n${tocLines.join("\n")}`;
	if (residency === "L4") {
		// The docs-resident code cell of the 2x2. Same container as the api/ tree,
		// relocated into the prompt — which is what upstream's own full-code agent
		// does, and why it needs the same <=20-API predictor as their tool-calling
		// agent. If codemode's advantage survives this, the mechanism is
		// representation; if it does not, the mechanism is residency.
		const docs = normalized.map(({ server, pyServer, tools }) => renderFullDocs(tools, { server, pkg: pyServer })).join("\n");
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
	// --bash: prime's own bash, with the guard extension intercepting it. Named in
	// --tools because the guard registers no tool of its own; without the name the
	// builtin is filtered out and the extension would intercept a tool that is not
	// there.
	if (bashTool) toolList = [...toolList, "bash"];
}

/**
 * Seed `<agent-home>/bin` with the binaries prime's `grep` and `find` tools shell
 * out to, or refuse to start.
 *
 * MEASURED: every one of the 50 `grep` calls across the first 62 `--nav-tools`
 * runs returned `ripgrep (rg) is not available and could not be downloaded`. The
 * arm was advertised four navigation tools and could execute two — the same class
 * of bug as the deferred-registration "L1" that was really L4, and it produced a
 * plausible number rather than an error: the agent fell back to hand-rolled
 * `open()` scans, and the *arm* got blamed for the reflex.
 *
 * The cause is this file. `PRIME_AGENT_CODING_AGENT_DIR` is pointed at a fresh
 * per-run `agent-home` for hermeticity, and prime resolves its managed binaries
 * under `<agent dir>/bin` — so the copy it downloaded once into `~/.prime/agent/bin`
 * is invisible to every run. It then falls through to a GitHub download, which the
 * network-restricted arm blocks. `rg` additionally has no `systemBinaryNames`
 * entry in prime's tools-manager, so a system `rg` would not be found either.
 *
 * Seeding the per-run dir keeps the hermeticity the override was for. A silent
 * fall-through would recreate the original bug exactly, so a missing source is
 * fatal and names the fix.
 */
const navToolBinaries = {};
if (navTools) {
	const seedBin = join(runDir, "agent-home", "bin");
	mkdirSync(seedBin, { recursive: true });
	for (const tool of ["rg", "fd"]) {
		const source = process.env[`HARNESS_${tool.toUpperCase()}_PATH`] ?? join(process.env.HOME, ".prime/agent/bin", tool);
		if (!existsSync(source)) {
			console.error(
				`--nav-tools needs a ${tool} binary at ${source}, and there is none.\n` +
					`prime's grep/find tools shell out to it and cannot download one from inside\n` +
					`this arm's network sandbox, so the tools would be advertised to the model and\n` +
					`fail on every call. Point HARNESS_${tool.toUpperCase()}_PATH at a ${tool} binary, or run\n` +
					`prime once outside the harness to populate ~/.prime/agent/bin.`,
			);
			process.exit(1);
		}
		const seeded = join(seedBin, tool);
		copyFileSync(source, seeded);
		// prime's getToolPath() only accepts a seeded binary if it actually runs
		// (`commandWorks`), so the executable bit is load-bearing, not cosmetic.
		chmodSync(seeded, 0o755);
		// Provenance, and the discriminator the fairness test needs: runs recorded
		// before this seeding existed are a different harness, and asserting the
		// invariant against them would leave the suite permanently red instead of
		// catching a regression.
		navToolBinaries[tool] = source;
	}
}

const digest = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

writeFileSync(
	join(runDir, "system-prompt.json"),
	`${JSON.stringify(
		{
			runId,
			arm,
			residency,
			variants: { docsGate, navTools, validateArgs, readGate, requiredDefaults: requiredDefaultsOn, bash: bashTool, apiLayout: layout, basePromptVersion, navToolBinaries },
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
		path: cataloguePath,
		// Present only on an enriched catalogue; provenance for the schemas the arm
		// was actually rendered from, so a verdict is re-derivable from the run alone.
		enrichment: enrichment ?? undefined,
	},
	promptVariant: arm === "codemode" ? promptName : arm === "vanilla" ? vanillaPromptName : undefined,
	// Which opt-in codemode variants were on. A run compared against another must
	// be able to say which condition it was in without re-reading the api/ tree.
	variants: { docsGate, navTools, validateArgs, readGate, requiredDefaults: requiredDefaultsOn, bash: bashTool, apiLayout: layout, basePromptVersion, navToolBinaries },
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
	// Populated only when --validate-args rendered a validator into the tree.
	argumentErrors: [],
	// Populated only under --read-gate: every refusal the gate issued, with the turn
	// it landed on. A count alone cannot answer the question the variant exists to
	// answer -- whether the correction was acted on next cell.
	readFirstRaises: [],
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
	// codemode is extension-free by default. Two variants add exactly one each — the
	// read gate's evidence channel, and the bash guard — and they compose. Named
	// explicitly rather than left to discovery; `--no-extensions` otherwise, so
	// nothing sitting on disk can join a run.
	const extensions =
		arm === "vanilla"
			? [EXTENSION]
			: [...(readGate ? [READ_LEDGER_EXTENSION] : []), ...(bashTool ? [BASH_EXTENSION] : [])];
	if (extensions.length === 0) cliArgs.push("--no-extensions");
	else for (const path of extensions) cliArgs.push("--extension", path);
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
			PRIME_AGENT_CODING_AGENT_DIR: seedPrimeSettings(join(runDir, "agent-home")),
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
			// Provenance only, for the same reason: validation is rendered into
			// api/_client.py, not switched on by this variable.
			...(validateArgs ? { HARNESS_VALIDATE_ARGS: "1" } : {}),
			// NOT provenance: the extension needs somewhere to write, and the gate
			// rendered into api/_client.py reads the same path. If it failed to
			// propagate the extension would throw at load rather than silently produce
			// a gate-on run with an empty ledger, which is why it is required there.
			...(readGate ? { HARNESS_READ_LEDGER: READ_LEDGER } : {}),
			// The bash guard. Required rather than provenance for the same reason as
			// the read ledger: the extension throws at load without them, so a
			// variable that failed to propagate fails the run instead of silently
			// producing an unguarded shell under a `__bash` label.
			//
			// NO_EGRESS is the AppWorld-specific half. terminal-bench sets neither,
			// because there the machine IS the surface; here the world is reachable
			// only through the env-server and a shell must not become a second route
			// to it. There is deliberately no ceiling: AppWorld tasks are API work,
			// nothing legitimately runs for minutes, and a wall-clock kill would be a
			// treatment this regression is not trying to price.
			...(bashTool
				? {
						HARNESS_JOBS_PY: JOBS_PY,
						HARNESS_BASH_NO_EGRESS: "1",
						HARNESS_BASH_LEDGER: BASH_LEDGER,
					}
				: {}),
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
			} else if (event.type === "tool_execution_end") {
				const text = (event.result?.content ?? []).map((c) => c.text ?? "").join(" ");
				if (event.isError) {
					summary.toolErrors++;
					summary.errorMessages.push(text.slice(0, 300));
				}
				// Every ArgumentError the validator raised, with the turn it landed on and
				// its full text. A count alone cannot answer the question the variant exists
				// to answer — whether the correction in the error channel was acted on next
				// cell — and CLAUDE.md's rule is to persist what a check saw, not only its
				// verdict. Outside the isError branch on purpose: an exception the agent
				// caught inside its own cell is still a correction that was delivered.
				// `api.<app>.<api>:` is required, because the string "ArgumentError:" also
				// appears in _client.call's own Raises docstring, which IPython prints in
				// every traceback through it — counting those would inflate the number by
				// one per unrelated failure.
				for (const m of text.matchAll(/ArgumentError: (api\.[\w.]+: [^\n]+)/g)) {
					summary.argumentErrors.push({ turn: summary.turns, message: m[1].slice(0, 400) });
				}
				// Same treatment, same reason, for the read gate's refusals. Outside the
				// isError branch on purpose: an exception the agent caught inside its own
				// cell is still a refusal that was delivered.
				for (const m of text.matchAll(/ReadFirst: (api\.[\w.]+ has not been read[^\n]*)/g)) {
					summary.readFirstRaises.push({ turn: summary.turns, message: m[1].slice(0, 300) });
				}
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

	/**
	 * The bash guard's own evidence, and the one-transport invariant it exists for.
	 *
	 * Two silent failures are possible and neither raises: the extension not loading
	 * (an unguarded shell wearing a `__bash` label), and a network command getting
	 * through (a second route to the world, which is the reason bash was withheld in
	 * the first place). Both are answered from the ledger rather than from the
	 * absence of an error, and the ledger records the command itself, so "did the
	 * shell reach around the transport" is re-derivable after the world is reset.
	 */
	if (bashTool) {
		const rows = existsSync(BASH_LEDGER)
			? readFileSync(BASH_LEDGER, "utf8")
					.split("\n")
					.filter((l) => l.trim())
					.map((l) => JSON.parse(l))
			: [];
		const calls = rows.filter((r) => r.phase === "call");
		summary.bashGuard = {
			loaded: rows.some((r) => r.phase === "loaded"),
			calls: calls.length,
			allowed: calls.filter((r) => r.verdict === "allowed").length,
			refusedEgress: calls.filter((r) => r.verdict === "blocked-egress").length,
			refusedBlocking: calls.filter((r) => r.verdict === "blocked-blocking").length,
			checkerFailed: calls.filter((r) => r.verdict === "checker-failed").length,
			commands: calls.map((r) => ({ verdict: r.verdict, command: String(r.command).slice(0, 200) })),
		};
		if (!summary.bashGuard.loaded) {
			summary.bashGuardViolation = "the guard extension never loaded — this run had an unguarded shell, so it is not a --bash run";
		} else {
			// The invariant, asserted on what was ALLOWED rather than on what was
			// refused: a refusal count of zero is the expected case on a benchmark
			// that is API work, and would prove nothing either way.
			const leaked = calls.filter((r) => r.verdict === "allowed" && /https?:\/\/|\b(curl|wget|nc|netcat|telnet|socat)\b/.test(String(r.command)));
			if (leaked.length > 0) {
				summary.bashGuardViolation =
					`${leaked.length} network command(s) were allowed through the shell: ` +
					`${leaked.map((r) => JSON.stringify(String(r.command).slice(0, 120))).join(", ")} — the one-transport invariant did not hold`;
			}
		}
	}

	/**
	 * The read gate's own evidence, and the guard that it actually bound.
	 *
	 * "A documented check is not an executed check", and the sibling failure this is
	 * modelled on is the deferred-registration one: a residency guard caught "the
	 * schemas are still resident" and NOTHING caught "narrowing worked and execution
	 * broke". Here the equivalent silent failure is a gate that never fires — an
	 * extension that failed to load, or a ledger the client could not find — which
	 * would produce an ordinary-looking run wearing an `__rg` label.
	 *
	 * So assert the observable effect in both directions: every app the arm reached
	 * must have been read first, and the gate must have refused at least once.
	 */
	if (readGate) {
		const ledger = existsSync(READ_LEDGER)
			? readFileSync(READ_LEDGER, "utf8")
					.split("\n")
					.filter((l) => l.trim())
					.map((l) => JSON.parse(l))
			: [];
		const reads = ledger.filter((e) => e.tool === "read" && !e.isError);
		const firstCallAt = new Map();
		for (const call of envCalls) {
			const at = Number(call.t);
			if (!firstCallAt.has(call.app) || at < firstCallAt.get(call.app)) firstCallAt.set(call.app, at);
		}
		const readAt = new Map();
		for (const entry of reads) {
			const at = Date.parse(entry.ts) / 1000;
			if (!readAt.has(entry.pkg) || at < readAt.get(entry.pkg)) readAt.set(entry.pkg, at);
		}
		summary.readGate = {
			reads: reads.length,
			greps: ledger.filter((e) => e.tool === "grep").length,
			appsRead: [...readAt.keys()].sort(),
			appsCalled: [...firstCallAt.keys()].sort(),
			raises: summary.readFirstRaises.length,
			// Per app: did a read land before the first call to it? The gate makes this
			// true by construction, which is exactly why it is worth checking.
			readBeforeFirstCall: Object.fromEntries(
				[...firstCallAt].map(([app, at]) => [app, readAt.has(app) && readAt.get(app) < at]),
			),
		};
		const unread = [...firstCallAt.keys()].filter((app) => !readAt.has(app) || readAt.get(app) >= firstCallAt.get(app));
		if (unread.length > 0) {
			summary.readGateViolation = `called ${unread.join(",")} with no prior read — the gate did not bind, so this is not a read-gate run`;
		} else if (reads.length === 0) {
			summary.readGateViolation = "the ledger is empty — the extension did not load, so this is not a read-gate run";
		}
	}

	/**
	 * The required-default transform's own evidence, read off the transport.
	 *
	 * Same reason the read gate has one: "a documented check is not an executed
	 * check", and the silent failure here is a stale `api/` tree — a run whose
	 * runId says `__reqd` and whose signatures still carry the default. That would
	 * look exactly like a weak arm. So assert the observable effect: every call to
	 * a promoted (app, api) MUST carry the promoted parameter, because there is no
	 * longer a signature that permits otherwise.
	 *
	 * The VALUE is logged, not just the presence, because presence is guaranteed by
	 * construction and the falsifier is about the value: an agent forced to fill the
	 * slot could fill it with its own address, in which case the mechanism was never
	 * representational and the transform fixes nothing.
	 */
	if (requiredDefaultsOn) {
		const wanted = new Map();
		for (const key of requiredDefaults.keys()) {
			const [app, api, param] = key.split("\u0000");
			wanted.set(`${app}.${api}`, [...(wanted.get(`${app}.${api}`) ?? []), param]);
		}
		const calls = [];
		for (const call of envCalls) {
			const params = wanted.get(`${call.app}.${call.api}`);
			if (!params) continue;
			for (const param of params) {
				calls.push({ api: `${call.app}.${call.api}`, param, supplied: param in (call.args ?? {}), value: call.args?.[param] ?? null });
			}
		}
		summary.requiredDefaults = { promoted: promoted.length, calls };
		const omitted = calls.filter((c) => !c.supplied);
		if (omitted.length > 0) {
			// The tree is generated from the same object `promoted` was derived from and
			// the run refuses to start if that is empty, so a stale signature is ruled
			// out before the agent runs. What is left is the one escape Python allows:
			// `email_addresses=None` is a legal call against a no-default parameter, and
			// `_client` drops Nones before sending. That is a DELIBERATE choice of "no
			// recipients" rather than an omission — but it reproduces the same bug, so it
			// is reported as loudly as a broken transform would be.
			summary.requiredDefaultsViolation =
				`${omitted.length} call(s) to ${[...new Set(omitted.map((c) => c.api))].join(",")} reached the transport` +
				" without a promoted parameter — the signature has no default for it, so the value was passed" +
				" explicitly as None (--validate-args would refuse this; it was not on)";
		}
	}

	summary.wallMs = phases.gradeEnd - phases.startedAt;
	summary.phases = phases;

	writeFileSync(join(runDir, "result.json"), `${JSON.stringify({ ...meta, summary }, null, 2)}\n`);

	const tally = [...new Set(summary.toolNames)].join(",") || "none";
	console.log(
		`${arm}/${residency} ${taskId}: ` +
			`${summary.success === true ? "PASS" : "FAIL"} ${summary.passCount}/${summary.totalCount} tests, ` +
			`${summary.turns} turns, ${summary.toolCalls} tool calls (${tally}), ${summary.apiCalls} api calls ` +
			`(${summary.distinctApis} distinct, ${summary.duplicateCalls} dupes), ${summary.toolErrors} errors, ` +
			`${validateArgs ? `${summary.argumentErrors.length} argErrs, ` : ""}` +
			`${readGate ? `${summary.readFirstRaises.length} readFirst, ` : ""}` +
			`$${summary.cost.toFixed(4)}, ${((summary.wallMs ?? 0) / 1000).toFixed(0)}s` +
			`${summary.stopReason === "completed" ? "" : ` [${summary.stopReason.toUpperCase()}]`}`,
	);
	if (summary.residencyViolation) console.log(`  !! ${summary.residencyViolation}`);
	if (summary.readGate) {
		console.log(
			`  read-gate: ${summary.readGate.raises} refusals, ${summary.readGate.reads} reads ` +
				`(${summary.readGate.appsRead.join(",") || "none"}), ${summary.readGate.greps} greps`,
		);
	}
	if (summary.readGateViolation) console.log(`  !! ${summary.readGateViolation}`);
	if (summary.bashGuard) {
		const g = summary.bashGuard;
		console.log(
			`  bash: ${g.calls} call(s), ${g.allowed} allowed, ${g.refusedEgress} egress-refused, ` +
				`${g.refusedBlocking} blocking-refused${g.loaded ? "" : " [GUARD NOT LOADED]"}`,
		);
	}
	if (summary.bashGuardViolation) console.log(`  !! ${summary.bashGuardViolation}`);
	if (summary.requiredDefaults) {
		const { promoted: n, calls } = summary.requiredDefaults;
		console.log(
			`  required-defaults: ${n} params promoted, ${calls.length} call(s) to one` +
				`${calls.map((c) => `\n    ${c.api}.${c.param} = ${JSON.stringify(c.value)}`).join("")}`,
		);
	}
	if (summary.requiredDefaultsViolation) console.log(`  !! ${summary.requiredDefaultsViolation}`);
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
