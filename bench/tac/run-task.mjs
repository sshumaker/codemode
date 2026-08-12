#!/usr/bin/env node
/**
 * Run one TheAgentCompany task through one arm.
 *
 *   bench/tac/run-task.mjs <env-file> <task-name> [--arm codemode|vanilla]
 *
 * TheAgentCompany grades differently from MCP-Bench and that is why it is worth
 * running: instead of an LLM rubric over a trajectory, each task ships hidden
 * checkpoint code that inspects the *world* afterwards — the file that should
 * exist, the message that should have been sent, the merge request that should
 * have been opened. A harness cannot talk its way to a good score.
 *
 * The pipeline mirrors upstream's run_eval.py exactly except for the agent:
 *
 *   1. start the task container on the host network
 *   2. `/utils/init.sh`   — resets and seeds the company's services
 *   3. the arm under test — the only substituted step
 *   4. `/utils/eval.py`   — upstream's grader, unmodified, over the real world
 *
 * Upstream runs OpenHands in step 3. We run prime-agent with either one
 * persistent Python REPL (codemode) or discrete JSON tools (vanilla), both
 * executing inside the container. Steps 2 and 4 are untouched, so the score is
 * TheAgentCompany's own, not ours.
 */
import { spawn, execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildTacPreamble } from "./prompts.mjs";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** The real CLI, inside the container — see bench/tac/provision-agent-volume.sh. */
const PRIME_CLI = "/agent/prime-mono/packages/coding-agent/dist/cli.js";
const VERSION = "1.0.0";
/** Upstream's hard-coded key; the grader is shipped encrypted in every image. */
const DECRYPTION_KEY = "theagentcompany is all you need";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const [envFile, taskName] = positional;

if (!envFile || !taskName) {
	console.error("usage: bench/tac/run-task.mjs <env-file> <task-name> [--arm codemode|vanilla]");
	process.exit(2);
}

const arm = flag("arm", "codemode");
const model = flag("model", "anthropic/claude-opus-5");
const promptVariant = flag("prompt", arm === "codemode" ? "t1" : "w1");
const timeoutSec = Number(flag("timeout", 2400));
const image = flag("image", `ghcr.io/theagentcompany/${taskName}-image:${VERSION}`);
const runId = flag("run-id", `tac__${taskName}__${arm}__${promptVariant}__${model.replace(/\//g, "-")}`);
const runDir = join(ROOT, ".run/tac", runId);
const container = `tac-${arm}-${taskName}`.slice(0, 60).replace(/[^a-zA-Z0-9_.-]/g, "-");

// Resume skips *graded* runs only.
//
// A failed run still writes result.json, with graded:false — so a task that died
// to a full disk or an expired credential was being skipped forever on resume,
// turning an infrastructure failure into a permanent hole in the dataset with no
// arm ever attempting it. An ungraded result is a missing measurement, so it gets
// retried rather than honoured.
if (existsSync(join(runDir, "result.json")) && flag("overwrite", "0") !== "1") {
	let prior = null;
	try {
		prior = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
	} catch {
		// Unreadable result: treat as absent and redo.
	}
	if (prior?.graded) {
		console.log(`skip ${runId} — already graded (pass --overwrite 1 to redo)`);
		process.exit(0);
	}
	console.log(`redoing ${runId} — previous attempt was ungraded`);
}
mkdirSync(runDir, { recursive: true });

const docker = (args, opts = {}) => run("docker", args, { maxBuffer: 64 * 1024 * 1024, ...opts });
const log = (m) => console.log(`[${taskName}/${arm}] ${m}`);
/** Everything the seeding step emitted, kept for post-mortems. */
const seedLog = [];
/**
 * null when the task has no NPCs; true/false once their reply path is probed.
 * Read at the end to decide whether the world the agent worked in was intact.
 */
let npcLlmOk = null;

/**
 * The environment LLM, used by the NPC colleagues during seeding and by the
 * grader's `evaluate_with_llm` checkpoints.
 *
 * Omitting this is silent and expensive: 26 of 175 tasks grade at least one
 * checkpoint with an LLM and 41 seed NPC colleagues with one. Without a key,
 * `evaluate_with_llm` catches its own failure and returns False, so a correct
 * answer scores zero and nothing in the output says why. That is exactly what
 * happened to ds-answer-numerical-data-question: the arm produced the right
 * three figures and was marked 0/6.
 *
 * The vendored litellm is 1.23.16, which routes any model it does not recognise
 * to Anthropic's retired /v1/complete endpoint. Anthropic's OpenAI-compatible
 * endpoint sidesteps that without upgrading the grader's dependency stack — the
 * one thing that must not drift, since it is upstream's grading code.
 *
 * Upstream judged with gpt-4o. This judges with Sonnet, which is a deviation to
 * record with any results, though it applies identically to both arms.
 */
const ENV_LLM = [
	"-e", "LITELLM_API_KEY", // value forwarded from the sourced env file
	"-e", `LITELLM_BASE_URL=${process.env.HARNESS_TAC_LLM_BASE ?? "https://api.anthropic.com/v1/"}`,
	"-e", `LITELLM_MODEL=${process.env.HARNESS_TAC_LLM_MODEL ?? "openai/claude-sonnet-5"}`,
];

/**
 * The NPC colleagues need a *different* model from the grader, and the reason is
 * not a preference.
 *
 * sotopia hard-codes `temperature: float = 0.7` on every generation path, and
 * `claude-sonnet-5` rejects the parameter outright:
 *
 *     400 {"message": "`temperature` is deprecated for this model."}
 *
 * So every NPC's first reply 400s, the bot loops printing "No message received,
 * waiting...", and the colleague is silent for the whole task. Nothing anywhere
 * says so: `ps` shows the processes alive, the liveness check passes, and the
 * *arm* is blamed for a conversation that never happened. This is why
 * `pm-schedule-meeting-2` is recorded in TAC-HANDOFF.md as "questionable — the two
 * required NPCs never replied to any arm": they could not.
 *
 * The grader is unaffected — `llm_complete` passes no temperature — and it is the
 * component that must not drift, so it keeps its validated model and only the NPCs
 * move to one that still accepts the parameter.
 */
const NPC_ENV_LLM = [
	"-e", "LITELLM_API_KEY",
	"-e", `LITELLM_BASE_URL=${process.env.HARNESS_TAC_LLM_BASE ?? "https://api.anthropic.com/v1/"}`,
	"-e", `LITELLM_MODEL=${process.env.HARNESS_TAC_NPC_MODEL ?? "openai/claude-sonnet-4-5"}`,
];

/**
 * `docker` with the env file sourced in a subshell, so the API key reaches the
 * container without ever existing as a JavaScript value. `-e NAME` with no `=`
 * tells docker to forward the variable from the surrounding environment.
 */
function dockerWithKey(args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"bash",
			["-c", 'set -a; . "$1"; set +a; shift; export LITELLM_API_KEY="$ANTHROPIC_API_KEY"; exec docker "$@"', "_", envFile, ...args],
			{ stdio: ["ignore", "pipe", "pipe"], ...opts },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		const timer = opts.timeout ? setTimeout(() => child.kill("SIGKILL"), opts.timeout) : undefined;
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve({ stdout, stderr });
			else reject(Object.assign(new Error(`docker exited ${code}`), { stdout, stderr, code }));
		});
	});
}

async function main() {
	const phases = {};
	const mark = (name) => { phases[name] = new Date().toISOString(); };
	mark("start");
	const meta = { runId, arm, model, promptVariant, task: taskName, image, container, startedAt: new Date().toISOString(), phases };
	writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

	// Exactly what produced this number: image digest, harness versions, the
	// prompt variant. Without it a result six weeks old cannot be reproduced or
	// trusted, and this harness has already changed under its own results twice.
	// Each probe guarded separately: an image pulled without a RepoDigest used to
	// throw and take the whole provenance block down with it.
	const provenance = {};
	try {
		const { stdout: digest } = await docker(["image", "inspect", image, "-f", "{{index .RepoDigests 0}}"]);
		provenance.imageDigest = digest.trim();
	} catch {
		provenance.imageDigest = "(none)";
	}
	try {
		const { stdout: versions } = await docker([
			"run", "--rm", "--platform", "linux/amd64", "-v", "tac-agent:/agent:ro", image,
			"bash", "-c",
			"echo node=$(/agent/node/bin/node --version); " +
			"echo claude=$(PATH=/agent/node/bin:$PATH claude --version 2>&1); " +
			"echo prime=$(cd /agent/prime-mono/packages/coding-agent && PATH=/agent/node/bin:$PATH node dist/cli.js --version 2>&1 | tail -1); " +
			"echo python=$(/agent/venv/bin/python --version 2>&1)",
		]);
		provenance.versions = versions.trim().split("\n");
	} catch (e) {
		provenance.versions = [`(unavailable: ${String(e.message ?? e).slice(0, 120)})`];
	}
	writeFileSync(join(runDir, "env.json"), `${JSON.stringify(provenance, null, 2)}\n`);

	// ---- 1. container -------------------------------------------------------
	await docker(["rm", "-fv", container]).catch(() => {});
	// --network host puts the container on the same network as the company's
	// services; --platform because every task image is amd64-only and this host
	// is arm64 (Rosetta handles it — none of this needs AVX).
	await docker([
		"run", "-d", "--name", container, "--platform", "linux/amd64", "--network", "host",
		// Read-only, and this is not paranoia. The volume holds the harness the
		// arm is being measured on, and an agent that hits trouble will try to
		// fix it: one run used the `edit` tool on jupyter_client inside this
		// volume, wrote invalid Python, and broke the kernel for every task that
		// ran afterwards. The agent can still install into the container's own
		// system python, which the kernel venv sees via --system-site-packages,
		// so nothing legitimate is lost.
		"-v", "tac-agent:/agent:ro", image, "sleep", "infinity",
	]);
	mark("containerUp");
	log("container up");

	// ---- 2. seed the world --------------------------------------------------
	const initStarted = Date.now();
	// Fail loudly if the volume's build predates the patches this run depends on.
	//
	// The volume is provisioned from a *built* tree, so patching the source and
	// rebuilding is not enough — provisioning has to run again. It did not, once,
	// and the container silently executed the pre-patch binary: every jobs.wait
	// returned in ~2s with the sentinel unconsumed, so 2,950s of requested waiting
	// became ~0s and the run looked like a wall-clock win. The patch existed in
	// the source and in the host build; it was absent from the only copy that runs.
	try {
		const expect = [
			["HARNESS_CELL_TIMEOUT_MS", "per-cell timeout"],
			...(process.env.HARNESS_JOBS_RUNTIME === "1" ? [["__HARNESS_WAIT_SECONDS__", "host-side jobs.wait"]] : []),
		];
		const { stdout } = await docker([
			"exec", container, "bash", "-c",
			"cat /agent/prime-mono/packages/coding-agent/dist/core/tools/ipython.js 2>/dev/null | head -c 400000",
		]);
		const missing = expect.filter(([marker]) => !stdout.includes(marker)).map(([, name]) => name);
		if (missing.length > 0) {
			throw new Error(
				`the tac-agent volume holds a build without: ${missing.join(", ")}. ` +
					"Run bench/tac/provision-agent-volume.sh — patching and rebuilding does not update the volume.",
			);
		}
	} catch (err) {
		if (String(err.message).includes("tac-agent volume holds")) throw err;
		log(`WARNING: could not verify the volume build (${String(err.message).slice(0, 100)})`);
	}

	mark("seedStart");
	await seedWorld();
	mark("seedEnd");
	// Seeding decides what world the agent walks into; when it half-fails the
	// agent looks incompetent instead of unlucky.
	writeFileSync(join(runDir, "seed.log"), seedLog.join("\n"));
	log(`init.sh ok (${((Date.now() - initStarted) / 1000).toFixed(0)}s)`);

	// ---- 3. the arm under test ---------------------------------------------
	await startServiceProxy();
	await stageJobsRuntime();

	mark("agentStart");
	const summary = await runAgent();
	mark("agentEnd");
	log(`agent done: ${summary.turns} turns, ${summary.toolCalls} calls, $${summary.cost.toFixed(4)}${summary.timedOut ? " [TIMEOUT]" : ""}`);

	// ---- 4. upstream's grader ----------------------------------------------
	// The trajectory is read by the grader as a raw string; some checkpoints
	// search it for values the agent was supposed to discover. Ours is the
	// message log, which carries the same information as OpenHands'.
	// Graded in a *fresh* container off the same image, not in the one the agent
	// just spent an hour in.
	//
	// The agent shares a Python environment with the grader and is free to
	// install into it. One run pip-installed easyocr, which pulled torch and
	// upgraded numpy, and `/utils/eval.py` then died on `from common import
	// grader` — recorded as ungraded, but it would have been a silent zero if the
	// import had merely degraded rather than failed. The agent can also write to
	// /utils/evaluator.py outright.
	//
	// A pristine grader removes both. /workspace is carried across because that
	// is genuine work product; everything else the agent touched is discarded,
	// and the services it changed are inspected over the network regardless.
	const trajectory = join(runDir, "trajectory.json");
	// Snapshot the world the grader is about to inspect. Rule-based checkpoints
	// read the services, and the next task's reset.sh destroys that state — so
	// without this a contested rule-based verdict is as unreproducible as the LLM
	// one was.
	try {
		await docker(["cp", join(ROOT, "bench/tac/world-snapshot.py"), `${container}:/tmp/world-snapshot.py`]);
		const { stdout } = await docker(["exec", container, "python_default", "/tmp/world-snapshot.py"], { timeout: 300_000 });
		await docker(["cp", `${container}:/tmp/world-before-grading.json`, join(runDir, "world-before-grading.json")]);
		log(stdout.trim().split("\n").pop());
	} catch (err) {
		log(`WARNING: world snapshot failed (${String(err.message ?? err).slice(0, 120)})`);
	}

	// The prelude's own status, copied out before the container dies.
	//
	// Four runs were spent guessing at this. The prelude lives in a container that is
	// destroyed at the end of the run, so a failure left no trace — the agent simply
	// had no `jobs`, which looks identical to an agent choosing not to use it. Two
	// separate "verifications" certified success without exercising the actual hook:
	// `import jobs` under a manual sys.path insert, then a manual runpy of the startup
	// file. Both are the find_spec mistake — locating or hand-running code is not the
	// runtime executing it. The test for sufficient logging is whether the verdict can
	// be re-derived tomorrow, and container state cannot.
	if (process.env.HARNESS_JOBS_RUNTIME === "1") {
		try {
			await docker(["cp", `${container}:/tmp/harness/prelude-status.txt`, join(runDir, "prelude-status.txt")]);
			const lines = readFileSync(join(runDir, "prelude-status.txt"), "utf8").trim().split("\n");
			const started = lines.filter((l) => l.startsWith("STARTED")).length;
			const completed = lines.filter((l) => l.startsWith("COMPLETED"));
			log(`prelude: ${started} start(s), ${completed.length} completion(s)`);
			for (const l of lines.filter((l) => l.startsWith("FAILED")).slice(0, 2)) {
				log(`  prelude FAILED: ${l.slice(0, 220)}`);
			}
			if (completed.length === 0) log("  WARNING: prelude never completed — this run had no primitives");
			else if (completed.some((l) => l.includes("NOT bound"))) log("  WARNING: prelude ran but did not bind `jobs`");
		} catch {
			log("  WARNING: no prelude-status.txt — the startup hook never ran at all");
		}
	}

	// NPC stdout, which is where a colleague's side of a conversation lives. The
	// launcher log alone showed 10 launch lines and zero conversation, so a task
	// that failed because nobody replied could only be diagnosed by inference.
	await docker(["exec", container, "bash", "-c",
		"mkdir -p /tmp/npc-out && for f in /npc/*.log /tmp/npc_*.log; do [ -f \"$f\" ] && cp \"$f\" /tmp/npc-out/ 2>/dev/null; done; true"]).catch(() => {});
	await docker(["cp", `${container}:/tmp/npc-out`, join(runDir, "npc-out")]).catch(() => {});

	mark("gradeStart");
	const grader = `${container}-grader`;
	let result = null;
	try {
		await docker(["rm", "-fv", grader]).catch(() => {});
		await docker(["run", "-d", "--name", grader, "--platform", "linux/amd64", "--network", "host",
			image, "sleep", "infinity"]);
		// Point the fresh container's hosts entry at the services, the way init.sh
		// would have; it never runs init.sh, so nothing is reset before grading.
		await docker(["exec", grader, "bash", "-c",
			`echo "$(ping -c 1 localhost | grep PING | awk -F'[()]' '{print $2}') the-agent-company.com" >> /etc/hosts`]);
		// Cleared first, and this is not defensive tidying.
		//
		// `docker cp src dest` creates `dest` when it is absent but copies *into*
		// it when it exists. The staging directory lives under the run directory,
		// which a re-run reuses — so the previous attempt's artefacts survived and
		// were handed to the grader. A deliberately crippled 12-second run scored
		// 3/3 on work the run before it had done.
		const stage = join(runDir, "workspace");
		rmSync(stage, { recursive: true, force: true });
		await docker(["cp", `${container}:/workspace`, stage]).catch(() => {});
		if (existsSync(stage)) await docker(["cp", `${stage}/.`, `${grader}:/workspace`]);
		await docker(["cp", trajectory, `${grader}:/tmp/traj.json`]);
		// Record the judge's *inputs*, not just its verdicts — see bench/tac/judge-trace.py.
		await docker(["cp", join(ROOT, "bench/tac/judge-trace.py"), `${grader}:/utils/judge_trace.py`]).catch(() => {});

		const graded = await dockerWithKey(
			["exec", "-e", `DECRYPTION_KEY=${DECRYPTION_KEY}`, ...ENV_LLM, grader,
			 "bash", "-c",
			 // 2>&1 into a file rather than the pipe: eval.py logs its per-checkpoint
			 // reasons via `logging` (stderr), and those lines are the only record of
			 // *why* a checkpoint failed. Kept separate so stdout stays parseable JSON.
			 "cd /utils && python_default -c \"import sys; sys.path.insert(0,'/utils'); import judge_trace; sys.argv=['eval.py','--trajectory_path','/tmp/traj.json','--result_path','/tmp/result.json']; exec(open('/utils/eval.py').read())\" 2>/tmp/eval.err; echo '===== eval.py diagnostics =====' >&2; cat /tmp/eval.err >&2; cat /tmp/result.json"],
			{ timeout: 900_000 },
		);
		// eval.py logs a line per checkpoint saying *why* it failed — the missing
		// file, the empty chat history, the predicate the LLM judge rejected. That
		// is the only place the reason exists, and parsing just the JSON threw it
		// away.
		writeFileSync(join(runDir, "grader.log"), `${graded.stdout}\n===== stderr =====\n${graded.stderr}\n`);
		result = JSON.parse(graded.stdout.slice(graded.stdout.indexOf("{")));
	} catch (err) {
		// A grader crash is a failed *measurement*, not a zero. Recording it as
		// 0/N would quietly bias whichever arm happens to trip it.
		log(`GRADER FAILED: ${(err.stderr ?? err.message ?? "").slice(-500)}`);
	}

	mark("gradeEnd");
	const score = result ? result.final_score : null;

	// A0 integrity verdict, computed from the run's own evidence rather than inferred.
	// A run is INVALID — its numbers must not enter any comparison — when the machinery
	// under it was broken, which is indistinguishable from a weak agent by score alone.
	const preflight = existsSync(join(runDir, "kernel-preflight.json"))
		? JSON.parse(readFileSync(join(runDir, "kernel-preflight.json"), "utf8"))
		: null;
	const invalidReasons = [];
	if (process.env.HARNESS_JOBS_RUNTIME === "1" && preflight && !(preflight.exec && preflight.persist && preflight.jobs)) {
		invalidReasons.push(`kernel pre-flight failed (${JSON.stringify(preflight)})`);
	}
	if ((summary.kernelNoResponse ?? 0) > 0) {
		invalidReasons.push(`${summary.kernelNoResponse} cells got "kernel did not respond"`);
	}
	if ((summary.turns ?? 0) === 0 && !summary.timedOut) {
		invalidReasons.push("agent produced zero turns");
	}
	// A conversation task whose colleagues cannot answer is a broken world, not a
	// hard task: the agent waits for a reply that the harness has made impossible,
	// and the score records that as the agent's failure. Same class as a wedged
	// kernel — plausible number, no error anywhere.
	if (npcLlmOk === false) {
		invalidReasons.push("NPC colleagues could not reply (env-LLM rejected sotopia's request)");
	}
	const integrity = { valid: invalidReasons.length === 0, reasons: invalidReasons, preflight, npcLlmOk };
	if (!integrity.valid) log(`  !! RUN INVALID: ${invalidReasons.join("; ")} — numbers must not be compared`);

	writeFileSync(
		join(runDir, "result.json"),
		`${JSON.stringify({ ...meta, summary, result, score, graded: result !== null, integrity, finishedAt: new Date().toISOString() }, null, 2)}\n`,
	);
	// NPC colleagues answer over RocketChat; when a conversation task fails, their
	// log is usually the only place that says whether anyone was listening.
	await docker(["cp", `${container}:/tmp/npc.log`, join(runDir, "npc.log")]).catch(() => {});
	// The judge trace lives in the grader container, not the agent's.
	await docker(["cp", `${container}-grader:/tmp/judge.jsonl`, join(runDir, "judge.jsonl")]).catch(() => {});
	await docker(["cp", `${container}:/tmp/service-calls.jsonl`, join(runDir, "service-calls.jsonl")]).catch(() => {});
	log(result ? `SCORE ${score.result}/${score.total}` : "SCORE ungraded (grader failed)");
	await docker(["rm", "-fv", container]).catch(() => {});
	await docker(["rm", "-fv", `${container}-grader`]).catch(() => {});
}

/**
 * Reset and re-seed the services this task depends on, retrying the whole thing.
 *
 * `reset.sh` waits on the api-server's healthcheck, which for GitLab goes green
 * before GitLab's REST API will actually serve `/api/v4/*`. `populate_data.py`
 * then runs against a half-awake GitLab, gets an error document where it expects
 * a list, and dies with `TypeError: string indices must be integers` — leaving
 * the world half-seeded and the run ungradeable. GitLab is 71 of 175 tasks, so
 * this is worth waiting out rather than absorbing as attrition.
 *
 * Probing the real endpoint each arm will use is the only reliable readiness
 * signal; the healthcheck is upstream's and it is too optimistic.
 */
async function seedWorld() {
	const { stdout: depsRaw } = await docker(["exec", container, "cat", "/utils/dependencies.yml"]);
	const deps = depsRaw.split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);

	const probes = {
		// Not "does the endpoint answer" — "are the projects actually there".
		//
		// reset.sh waits on the api-server healthcheck, which goes green while
		// GitLab is still importing repositories. populate_data.py then asks for a
		// milestone, gets `{"message":"404 Project Not Found"}`, iterates the dict,
		// and dies with `TypeError: string indices must be integers` — a seeding
		// failure that reads like a code bug. Requiring a non-empty project list is
		// the condition the seeding scripts actually depend on.
		gitlab: "test \"$(curl -s -H 'PRIVATE-TOKEN: root-token' 'http://the-agent-company.com:8929/api/v4/projects?per_page=1' | head -c 2)\" = '[{'",
		rocketchat: "curl -sf -o /dev/null http://the-agent-company.com:3000/api/info",
		owncloud: "curl -sf -o /dev/null http://the-agent-company.com:8092/status.php",
		plane: "curl -sf -o /dev/null http://the-agent-company.com:8091/",
	};

	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			// NPC colleagues in 41 tasks are seeded by an LLM; without a key they
			// simply do not exist, and the task becomes unsolvable in a way no
			// error reports.
			// Keep the GitLab token alive *while* init.sh runs.
			//
			// init.sh calls reset.sh, which restores GitLab from a snapshot carrying
			// the token that expired 2025-11-18, and only then runs populate_data.py.
			// Renewing before or after init.sh is useless: reset undoes the former and
			// populate_data has already failed by the latter. So the renewal has to
			// happen inside that window, which we cannot hook — hence a loop. A direct
			// SQL update takes 0.2s against ~25s for `gitlab-rails runner`, which is
			// what makes polling affordable.
			const keepTokenAlive = deps.includes("gitlab") ? startGitlabTokenKeepalive() : undefined;
			let seeded;
			try {
				seeded = await dockerWithKey(["exec", "-e", "SERVER_HOSTNAME=localhost", ...ENV_LLM, container, "bash", "/utils/init.sh"], {
					timeout: 900_000,
				});
			} finally {
				keepTokenAlive?.stop();
			}
			seedLog.push(`--- init.sh attempt ${attempt} ---`, seeded.stdout, seeded.stderr);
			await reviveNpcs();
			await renewGitlabToken(deps);
			return;
		} catch (err) {
			seedLog.push(`--- init.sh attempt ${attempt} FAILED ---`, String(err.stdout ?? ""), String(err.stderr ?? ""));
			if (attempt === 3) {
				writeFileSync(join(runDir, "seed.log"), seedLog.join("\n"));
				throw err;
			}
			log(`init.sh failed (attempt ${attempt}/3), waiting for services to settle`);
			// init.sh writes the hosts entry before it fails, so probes resolve.
			for (const dep of deps) {
				const probe = probes[dep];
				if (!probe) continue;
				// Up to 10 minutes: a GitLab reset re-imports repositories, and the
				// window where it answers but has no data is minutes wide.
				let ready = false;
				for (let i = 0; i < 120; i++) {
					try {
						await docker(["exec", container, "bash", "-c", probe], { timeout: 30_000 });
						ready = true;
						break;
					} catch {
						await new Promise((r) => setTimeout(r, 5_000));
					}
				}
				seedLog.push(`probe ${dep}: ${ready ? "ready" : "NEVER became ready"}`);
			}
		}
	}
}

/**
 * Repeatedly un-expire GitLab's tokens until told to stop.
 *
 * Returns a handle whose `stop()` ends the loop. Errors are swallowed: GitLab is
 * mid-restart for much of this window, so failures are expected and only the
 * successful passes matter.
 */
function startGitlabTokenKeepalive() {
	let running = true;
	(async () => {
		while (running) {
			await docker([
				"exec", "gitlab", "gitlab-psql", "-c",
				"UPDATE personal_access_tokens SET expires_at='2027-08-10', revoked=false WHERE expires_at < '2027-01-01' OR revoked = true;",
			]).catch(() => {});
			await new Promise((r) => setTimeout(r, 3_000));
		}
	})();
	return { stop: () => { running = false; } };
}

/**
 * Un-expire GitLab's baked-in `root-token`.
 *
 * The task images hardcode `GITLAB_ACCESS_TOKEN = "root-token"` and the image was
 * built in 2024 with a personal access token that expired 2025-11-18. Every
 * seeding script and every grader checkpoint that touches the GitLab API now gets
 * `{"error":"invalid_token"}` — populate_data.py iterates that error object and
 * dies with `TypeError: string indices must be integers`, which reads like a bug
 * in the benchmark rather than an expired credential.
 *
 * 71 of 175 tasks depend on GitLab, so without this they either fail to seed or
 * grade as confident zeros. Applied after every seed because reset.sh restores
 * GitLab from a baked snapshot and may restore the expiry with it.
 */
async function renewGitlabToken(deps) {
	if (!deps.includes("gitlab")) return;
	try {
		const { stdout } = await docker([
			"exec", "gitlab", "gitlab-rails", "runner",
			't = PersonalAccessToken.find_by_token("root-token"); ' +
			'if t then t.expires_at = Date.today + 365; t.revoked = false; t.save!(validate: false); puts "token ok until #{t.expires_at}" else puts "token missing" end',
		], { timeout: 300_000 });
		seedLog.push(`gitlab token: ${stdout.trim()}`);
		log(`gitlab token renewed (${stdout.trim().split("\n").pop()})`);
	} catch (err) {
		seedLog.push(`gitlab token renewal FAILED: ${String(err.stderr ?? err.message).slice(0, 300)}`);
		log("WARNING: could not renew the GitLab token — API-based checkpoints may score zero");
	}
}

/**
 * Stage the hosted-runtime v1 surface (docs/HOSTED-RUNTIME-DESIGN.md §4).
 *
 * `jobs` becomes available in the kernel without an import, and the in-process
 * forms (threading.Thread, long time.sleep, os.fork) raise with the correct
 * pattern. Gated on HARNESS_JOBS_RUNTIME=1 so it is a condition that can be
 * measured against the runs that lacked it, not a silent change to the arm.
 */
async function stageJobsRuntime() {
	// Say which condition this run is in, always. A silent `return` here cost a
	// 40-minute validation run: the flag was unset, the runtime was never staged, and
	// the trace looked exactly like an agent that ignored a primitive it in fact never
	// had — 9 blocking sleeps, 0 jobs cells, and a plausible 2/5 score. A broken
	// harness and a weak agent produce the same-looking number, so the condition has
	// to be in the log rather than inferred from the absence of a banner.
	if (process.env.HARNESS_JOBS_RUNTIME !== "1") {
		log("jobs runtime: OFF (HARNESS_JOBS_RUNTIME != 1) — no `jobs`, no guards in this run");
		return;
	}
	log("jobs runtime: ON");
	try {
		await docker(["exec", container, "mkdir", "-p", "/agent/harness"]).catch(() => {});
		// /agent is read-only, so the runtime lives in a writable path.
		await docker(["exec", container, "mkdir", "-p", "/tmp/harness"]);
		await docker(["cp", join(ROOT, "runtime/jobs.py"), `${container}:/tmp/harness/jobs.py`]);
		await docker(["cp", join(ROOT, "runtime/kernel-prelude.py"), `${container}:/tmp/harness/kernel_prelude.py`]);
		await docker(["exec", container, "bash", "-c", "sed -i 's#/agent/harness#/tmp/harness#' /tmp/harness/kernel_prelude.py"]);
		// IPython runs everything in profile_default/startup/ before the first cell,
		// which is the only hook that reaches the kernel's own namespace.
		// Stage into the directory IPYTHONDIR points at (set on the agent exec), and
		// keep the legacy ~/.ipython copy as a belt-and-braces fallback.
		await docker(["exec", container, "bash", "-c",
			"mkdir -p /tmp/harness/ipython/profile_default/startup " +
			"&& cp /tmp/harness/kernel_prelude.py /tmp/harness/ipython/profile_default/startup/00-jobs.py " +
			"&& mkdir -p /root/.ipython/profile_default/startup " +
			"&& cp /tmp/harness/kernel_prelude.py /root/.ipython/profile_default/startup/00-jobs.py"]);
		// Verify the HOOK fires, not merely that the file exists. `import jobs` with a
		// manual sys.path insert certified two runs in which `jobs` was never present
		// in a single cell. This starts a real IPython with the same IPYTHONDIR and
		// asks whether the startup file bound the name.
		const { stdout } = await docker(["exec", container, "bash", "-c",
			"IPYTHONDIR=/tmp/harness/ipython HARNESS_RUNTIME_DIR=/tmp/harness HARNESS_JOB_DIR=/tmp/harness/jobs " +
			"/agent/venv/bin/python -c \"from IPython.core.interactiveshell import InteractiveShell as S; " +
			"ip=S.instance(); ip.init_extensions if False else None; " +
			"import IPython, glob, runpy; " +
			"[runpy.run_path(f, run_name='__prelude__') for f in sorted(glob.glob('/tmp/harness/ipython/profile_default/startup/*.py'))]; " +
			"print('PRELUDE-OK' if 'jobs' in dir(__import__('builtins')) else 'PRELUDE-DID-NOT-BIND')\""]);
		const verdict = stdout.trim().split("\n").pop();
		log(`jobs runtime staged (${verdict})`);
		if (!verdict.includes("PRELUDE-OK")) {
			log("WARNING: the prelude did not bind `jobs` — this run has no primitives");
		}

		// A0 pre-flight: start the REAL kernel the way the agent will, and prove it
		// executes cells, keeps state across them, and binds `jobs` — before spending
		// a multi-minute agent run on a wedged kernel.
		//
		// This is the check the earlier "verifications" were not. `import jobs` under a
		// manual sys.path insert and a manual runpy of the startup file both certified
		// success while the live kernel answered every cell "did not respond" — the
		// find_spec mistake. This uses jupyter_client to launch ipykernel_launcher with
		// the same IPYTHONDIR/env, which is the path that was actually broken.
		const probe = [
			"import os, queue, json",
			"from jupyter_client import KernelManager",
			"km = KernelManager()",
			"km.kernel_cmd = ['/agent/venv/bin/python','-m','ipykernel_launcher','-f','{connection_file}']",
			"km.start_kernel(env=dict(os.environ))",
			"kc = km.client(); kc.start_channels(); kc.wait_for_ready(timeout=30)",
			"def run(code):",
			"    mid = kc.execute(code); out = []",
			"    while True:",
			"        try: m = kc.get_iopub_msg(timeout=15)",
			"        except queue.Empty: break",
			"        c = m['content']",
			"        if m['msg_type'] == 'stream': out.append(c.get('text',''))",
			"        elif m['msg_type'] == 'error': out.append('ERR')",
			"        elif m['msg_type'] == 'status' and c.get('execution_state')=='idle' and m['parent_header'].get('msg_id')==mid: break",
			"    return ''.join(out)",
			"a = run('print(6*7)').strip()",
			"run('x = 41')",
			"b = run('print(x + 1)').strip()",
			"j = run('print(type(jobs).__name__)').strip()",
			"km.shutdown_kernel(now=True)",
			"print('PROBE ' + json.dumps({'exec': a=='42', 'persist': b=='42', 'jobs': j=='module'}))",
		].join("\n");
		try {
			// Copy the probe in as a file rather than passing it via `-c`: it contains
			// `{connection_file}`, quotes and newlines that shell-quoting through
			// docker exec mangles. And parse stdout for the PROBE line rather than
			// trusting the exit code — jupyter_client emits a harmless __del__
			// traceback at interpreter shutdown that would otherwise fail the check on
			// a kernel that is in fact fine.
			await docker(["exec", container, "bash", "-c",
				`cat > /tmp/kernel-preflight.py <<'PROBE_EOF'\n${probe}\nPROBE_EOF`]);
			const { stdout: probeOut } = await docker(["exec",
				"-e", "IPYTHONDIR=/tmp/harness/ipython",
				"-e", "HARNESS_RUNTIME_DIR=/tmp/harness",
				"-e", "HARNESS_JOB_DIR=/tmp/harness/jobs",
				container, "bash", "-c", "/agent/venv/bin/python /tmp/kernel-preflight.py 2>/dev/null"],
				{ timeout: 120_000 }).catch((e) => ({ stdout: e.stdout ?? "" }));
			const line = probeOut.split("\n").find((l) => l.startsWith("PROBE ")) ?? "PROBE {}";
			const r = JSON.parse(line.slice(6));
			writeFileSync(join(runDir, "kernel-preflight.json"), JSON.stringify(r, null, 2));
			log(`kernel pre-flight: exec=${r.exec} persist=${r.persist} jobs=${r.jobs}`);
			if (!(r.exec && r.persist && r.jobs)) {
				log("  !! kernel pre-flight FAILED — the live kernel is broken; this run's numbers will be INVALID");
			}
		} catch (err) {
			writeFileSync(join(runDir, "kernel-preflight.json"), JSON.stringify({ error: String(err.message ?? err).slice(0, 200) }));
			log(`  !! kernel pre-flight could not run (${String(err.message ?? err).slice(0, 100)})`);
		}
	} catch (err) {
		log(`WARNING: jobs runtime not staged (${String(err.message ?? err).slice(0, 120)})`);
	}
}

/**
 * Put a recording proxy between the agent and the company's services.
 *
 * init.sh points `the-agent-company.com` at 127.0.0.1, where the real services
 * listen (the container is on --network host). So the proxies bind 127.0.0.2 —
 * also loopback on Linux — and the hosts entry is repointed there *after*
 * seeding. Seeding and grading therefore talk to the services directly, and only
 * the agent's own traffic is recorded, which is exactly the traffic in question.
 *
 * Without this the sole record of a service interaction is the agent's code plus
 * whatever it chose to print, and reset.sh destroys the service state before anyone
 * can go back and look.
 */
async function startServiceProxy() {
	if (process.env.HARNESS_SERVICE_PROXY === "0") return;
	try {
		await docker(["cp", join(ROOT, "bench/tac/service-proxy.py"), `${container}:/tmp/service-proxy.py`]);
		await docker(["exec", "-d", container, "python_default", "/tmp/service-proxy.py"]);
		// Confirm it is actually listening rather than assuming — an unrecorded run
		// looks identical to a recorded one until you go looking for the evidence.
		for (let i = 0; i < 20; i++) {
			const { stdout } = await docker([
				"exec", container, "bash", "-c",
				"curl -s -o /dev/null -w '%{http_code}' -m 2 -x http://127.0.0.1:18080 http://the-agent-company.com:3000/api/info || true",
			]);
			if (stdout.trim() === "200") {
				log("service proxy recording");
				return;
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		log("WARNING: service proxy never answered — calls will be unrecorded");
	} catch (err) {
		// Instrumentation. A run without it is worse, not invalid.
		log(`WARNING: service proxy not started (${String(err.message ?? err).slice(0, 120)})`);
	}
}

/**
 * Relaunch the NPC colleagues detached, so they outlive the seeding session.
 *
 * 41 tasks require talking to a colleague, and `init.sh` starts one long-lived
 * process per NPC to answer on RocketChat. Started from inside `docker exec`,
 * they are killed the moment that exec session ends — the container was left
 * with five `<defunct>` shells and no NPCs, so every one of those tasks would
 * have been quietly unsolvable, with the arm blamed for the silence.
 *
 * Upstream does not hit this because OpenHands drives the container through a
 * persistent action-execution server, so the NPCs inherit a parent that stays
 * alive. `docker exec -d` plus `setsid` reproduces that property; this restores
 * upstream's intent rather than departing from it.
 */
async function reviveNpcs() {
	const hasNpcs = await docker(["exec", container, "test", "-f", "/npc/scenarios.json"]).then(() => true, () => false);
	if (!hasNpcs) return;
	// init.sh's own attempt has already died; clear any survivor so a second
	// bot does not answer every message twice.
	await docker(["exec", container, "bash", "-c", "pkill -f run_one_npc.py || true"]).catch(() => {});
	// Capability before liveness. See bench/tac/npc-llm-preflight.py: a colleague can
	// be running, connected and reading the agent's DM and still unable to answer,
	// and the only place that shows up is a 400 buried in /tmp/npc_*.log.
	try {
		await docker(["cp", join(ROOT, "bench/tac/npc-llm-preflight.py"), `${container}:/tmp/npc-llm-preflight.py`]);
		const { stdout } = await dockerWithKey([
			"exec", ...NPC_ENV_LLM, container, "python_default", "/tmp/npc-llm-preflight.py",
		]);
		const line = stdout.split("\n").find((l) => l.startsWith("NPCLLM ")) ?? "NPCLLM {}";
		const verdict = JSON.parse(line.slice(7));
		writeFileSync(join(runDir, "npc-preflight.json"), `${JSON.stringify(verdict, null, 2)}\n`);
		npcLlmOk = !!verdict.ok;
		log(`NPC LLM pre-flight: ok=${verdict.ok} model=${verdict.model}${verdict.ok ? "" : ` — ${verdict.body ?? verdict.error ?? "?"}`}`);
		if (!verdict.ok) {
			log("  !! colleagues will NEVER reply — a conversation task is unsolvable and the arm will look weak");
		}
	} catch (err) {
		writeFileSync(join(runDir, "npc-preflight.json"), `${JSON.stringify({ ok: false, error: String(err.message ?? err).slice(0, 300) }, null, 2)}\n`);
		npcLlmOk = false;
		log(`  !! NPC LLM pre-flight could not run (${String(err.message ?? err).slice(0, 120)})`);
	}

	await dockerWithKey([
		"exec", "-d", ...NPC_ENV_LLM, container,
		// Replaces run_multi_npc.py rather than supplementing it — that script loops
		// the same scenarios.json keys into run_one_npc.py with stdout to DEVNULL, so
		// running both would put two bots in every conversation. Launching them here
		// keeps each colleague's output, which is where their side of the exchange
		// lives; the launcher log alone had 10 launch lines and zero conversation.
		"bash", "-c",
		"cd /npc && python_default -c \"import json;print('\\n'.join(json.load(open('/npc/scenarios.json')).keys()))\" | " +
		"while IFS= read -r n; do [ -z \"$n\" ] && continue; " +
		"safe=$(echo \"$n\" | tr ' ' '_'); " +
		"setsid python_default /npc/run_one_npc.py --agent_name=\"$n\" > \"/tmp/npc_$safe.log\" 2>&1 & " +
		"done; sleep 2; true",
	]);

	// Wait for them to actually be listening; a task that messages a colleague
	// before the bot connects gets no reply and fails for the wrong reason.
	for (let i = 0; i < 30; i++) {
		const { stdout } = await docker(["exec", container, "bash", "-c", "ps ax | grep -c '[r]un_one_npc' || true"]);
		if (Number(stdout.trim()) > 0) {
			log(`NPCs listening (${stdout.trim()} processes)`);
			return;
		}
		await new Promise((r) => setTimeout(r, 5_000));
	}
	log("WARNING: NPCs never came up — task may be unsolvable");
}

/** Spawn prime-agent with the arm's tool surface and collect its stream. */
/**
 * Run the real prime-agent, inside the task container.
 *
 * Not a reimplementation of it. The first version of this ran a hand-written
 * kernel over `docker exec` for codemode and a hand-written bash/read/write
 * extension for vanilla, which measured the clone rather than the harness — and
 * the clone had silently dropped image attachments, blinding a multimodal model
 * on every document task. The container now carries the genuine tree
 * (bench/tac/provision-agent-volume.sh), so `dist/cli.js` here is the same entry
 * MCP-Bench runs on the host, with prime's own ipykernel over localhost ZMQ.
 *
 * Skills stay ENABLED, which is the other half of that bug. `--no-skills`
 * removes `attach_image` — the only way the model can actually see a file — and
 * `edit`, whose exact-match/uniqueness contract is the entire value of the tool.
 * With it off the agent decoded a PNG pixel-by-pixel across 19 turns and still
 * got the answer wrong; with it on, 5 turns and exact. MCP-Bench ran with skills
 * off, so its numbers describe a deliberately reduced harness.
 */
function runAgent() {
	let preamble = buildTacPreamble(arm, promptVariant);

	// The jobs guidance travels WITH the jobs runtime, gated on the same flag.
	//
	// Measured the hard way: with the runtime staged but no guidance, the agent never
	// used jobs once in 197 cells, and no guard ever fired. It did not try to sleep —
	// it polled once per TURN (`print("r21")` as a whole cell), which holds the kernel
	// for zero seconds and so trips nothing. Blocking sleeps fell 24 -> 1 and threads
	// 5 -> 0, and turns went 43 -> 198 with cost $0.67 -> $3.32. Suppressing the bad
	// wait without the agent adopting the good one converts a kernel-holding problem
	// into a 5x turn-cost problem.
	//
	// So the error channel is NOT sufficient on its own, contrary to what the small
	// hermetic evals suggested: an error can only teach when it fires, and the agent's
	// cheapest escape route fires nothing.
	if (process.env.HARNESS_JOBS_RUNTIME === "1" && arm === "codemode") {
		const jobsPrompt = execFileSync("python3", [join(ROOT, "runtime/jobs.py"), "--prompt"], {
			encoding: "utf8",
		});
		preamble = `${preamble}\n\n${jobsPrompt.trim()}`;
	}
	writeFileSync(join(runDir, "prompt.txt"), preamble);

	// codemode keeps its single execution tool and gains `edit` for safe targeted
	// writes; the same contract is also callable from the REPL as a skill.
	// vanilla gets prime's real built-in set — including bash, which MCP-Bench
	// withheld only because it let that arm curl past the MCP tools under test.
	// Here the machine *is* the surface, so withholding it would model no harness
	// anyone ships.
	const tools = arm === "codemode" ? "ipython,edit" : "bash,read,edit,write,grep,find,ls";

	// What the model was actually given. prompt.txt holds only our preamble, so
	// without this "what did the model see" is answerable only by reading the
	// source at that commit. The resolved prime base prompt and skill
	// descriptions still are not visible from outside the CLI — recorded as a
	// known limitation rather than silently implied to be complete.
	writeFileSync(
		join(runDir, "system-prompt.json"),
		`${JSON.stringify(
			{
				baseSystemPrompt: BASE_SYSTEM_PROMPT,
				appendedPreamble: preamble,
				tools: tools.split(","),
				skillsEnabled: true,
				note: "prime's own base prompt and skill descriptions are assembled inside the CLI and are not captured here",
			},
			null,
			2,
		)}\n`,
	);

	const cliArgs = [
		"node", PRIME_CLI, "-p", "--mode", "json", "--model", model,
		"--tools", tools,
		"--cwd", "/workspace",
		"--no-context-files", "--no-prompt-templates", "--no-extensions",
		"--system-prompt", BASE_SYSTEM_PROMPT,
		...(preamble ? ["--append-system-prompt", preamble] : []),
		// Upstream's own framing, verbatim, so the arms are told what OpenHands
		// was told and no more.
		"Complete the task in /instruction/task.md",
	];

	return new Promise((resolve) => {
		// The key is sourced in a subshell and forwarded by name, so it never
		// exists as a JavaScript value.
		const child = spawn(
			"bash",
			["-c",
			 'set -a; . "$1"; set +a; shift; exec docker exec -i ' +
			 '-e ANTHROPIC_API_KEY -e DO_NOT_TRACK=1 -e PRIME_AGENT_TELEMETRY=0 ' +
			 '-e PATH=/agent/node/bin:/usr/local/bin:/usr/bin:/bin ' +
			 '-e PRIME_AGENT_KERNEL_PYTHON=/agent/venv/bin/python ' +
			 '-e PRIME_AGENT_CODING_AGENT_DIR=/tmp/prime-home ' +
			 // Only the agent's traffic is recorded; seeding and grading talk to the
			 // services directly. requests(trust_env) and curl both honour these.
			 '-e http_proxy=http://127.0.0.1:18080 -e HTTP_PROXY=http://127.0.0.1:18080 ' +
			 '-e no_proxy=api.anthropic.com -e NO_PROXY=api.anthropic.com ' +
			 // Bound each cell so one blocking cell cannot consume the run. See the
			 // per-cell timeout patch in scripts/neutralize-prime.mjs.
			 // 600s, not 240s. The cap exists to break deadlocks, not to punish waiting:
			 // on conversational tasks the arm legitimately sleeps ~235s inside a cell
			 // polling for a colleague's reply, which a 240s cap sits right on top of.
			 // Vanilla waits between tool calls and pays nothing for it.
			 `-e HARNESS_CELL_TIMEOUT_MS=${process.env.HARNESS_CELL_TIMEOUT_MS ?? 600000} ` +
			 `-e HARNESS_SHOW_NAMESPACE=${process.env.HARNESS_SHOW_NAMESPACE ?? "1"} ` +
			 // Point IPython at a directory we control instead of relying on ~/.ipython.
			 //
			 // The prelude was staged into /root/.ipython/profile_default/startup and
			 // never ran: two full TAC runs (198 and 265 turns, $3.32 and $4.56) had no
			 // `jobs` in the kernel at all. The staging check said "jobs importable",
			 // which proves the FILE imports under a manual sys.path insert and says
			 // nothing about whether the startup hook fires — the same false
			 // certification as find_spec approving a module with a syntax error.
			 // Setting IPYTHONDIR explicitly is what the working eval harness does.
			 (process.env.HARNESS_JOBS_RUNTIME === "1" ? "-e IPYTHONDIR=/tmp/harness/ipython " : "") +
			 `-e HARNESS_RUNTIME_DIR=/tmp/harness ` +
			 `-e HARNESS_JOB_DIR=/tmp/harness/jobs ` +
			 '-w /workspace "$@"',
			 "_", envFile, container, ...cliArgs],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		const events = [];
		const summary = { turns: 0, toolCalls: 0, toolErrors: 0, toolNames: [], cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, finalText: "", timedOut: false };
		const counted = new Set();
		let buffer = "";
		let stderr = "";

		const killTimer = setTimeout(() => {
			summary.timedOut = true;
			child.kill("SIGKILL");
		}, timeoutSec * 1000);

		child.stderr.on("data", (d) => {
			stderr = (stderr + d).slice(-4000);
			appendFileSync(join(runDir, "stderr.log"), d);
		});
		child.stdout.on("data", (chunk) => {
			// The raw stream, before any parsing. trajectory.json is what this
			// runner understood; stream.jsonl is what actually came back, which is
			// what you want when the two disagree.
			appendFileSync(join(runDir, "stream.jsonl"), chunk);
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("{")) continue;
				let e;
				try {
					e = JSON.parse(line);
				} catch {
					continue;
				}
				// Stamped on receipt. trajectory.json had 1 timestamp in 125 events, which
				// is why locating a 2,300s hole took inference from durationMs instead of
				// reading it off. stream.jsonl stays raw; this is the parsed view.
				events.push({ _t: new Date().toISOString(), ...e });
				// Same accounting as bench/run-task.mjs: count completed messages,
				// not streamed deltas. Summing content blocks across message_update
				// events counted one tool call nine times.
				if (e.type === "tool_execution_start") {
					summary.toolCalls++;
					summary.toolNames.push(e.toolName);
				} else if (e.type === "tool_execution_end") {
					if (e.isError) summary.toolErrors++;
					// A0 integrity: a wedged kernel answers every cell with "Kernel did
					// not respond to kernel_info_request". Seven TAC runs scored a
					// plausible 0–2/5 that way. Counting it here is what lets the run
					// self-flag INVALID instead of reporting the number.
					const txt = (e.result?.content ?? []).map((c) => c.text ?? "").join("");
					if (/kernel.*did not respond|Kernel did not respond/i.test(txt)) {
						summary.kernelNoResponse = (summary.kernelNoResponse ?? 0) + 1;
					}
				} else if (e.type === "message_end" && e.message?.role === "assistant") {
					const m = e.message;
					const texts = (m.content ?? []).filter((c) => c.type === "text" && c.text);
					if (texts.length > 0) summary.finalText = texts.map((c) => c.text).join("");
					const id = m.responseId;
					if (id && !counted.has(id) && m.usage?.totalTokens) {
						counted.add(id);
						summary.turns++;
						for (const k of ["input", "output", "cacheRead", "cacheWrite"]) summary[k] += m.usage[k] ?? 0;
						summary.cost += m.usage.cost?.total ?? 0;
					}
				}
			}
		});

		// `exit`, not `close`.
		//
		// The codemode kernel is a `docker exec -i` spawned by the agent process,
		// and it inherits the agent's stdio pipes. When the timeout SIGKILLs the
		// agent, that exec is orphaned and holds the pipes open — so `close`, which
		// waits for every pipe to drain, never fires and the run hangs indefinitely.
		// One task sat wedged for twenty minutes past its own timeout this way,
		// which across an overnight sweep would have been the whole sweep.
		let settled = false;
		child.on("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			summary.exitCode = code;
			summary.stderrTail = stderr.split("\n").slice(-8).join("\n");
			writeFileSync(join(runDir, "trajectory.json"), `${JSON.stringify(events, null, 2)}\n`);
			writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
			resolve(summary);
		});
	});
}

/**
 * The same neutral base prompt both MCP-Bench arms get, so a result here is
 * comparable to a result there. It describes no arm mechanics — those live
 * entirely in the per-arm preamble.
 */
const BASE_SYSTEM_PROMPT = [
	"You are an agent that completes tasks using the tools available to you.",
	"Work step by step: decide what you need, use your tools to get it, and",
	"reason over the results.",
	"",
	"Ground every claim in something a tool actually returned. Do not state facts",
	"you have not retrieved.",
	"",
	"When the task is complete, stop calling tools and give your final answer.",
].join("\n");

main().catch(async (err) => {
	console.error(`[${taskName}/${arm}] FAILED: ${err.stderr ?? err.message}`);
	writeFileSync(join(runDir, "error.json"), `${JSON.stringify({ error: String(err.stderr ?? err.message) }, null, 2)}\n`);
	await docker(["rm", "-fv", container]).catch(() => {});
	process.exit(1);
});
