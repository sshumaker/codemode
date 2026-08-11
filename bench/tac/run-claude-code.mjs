#!/usr/bin/env node
/**
 * Run one TheAgentCompany task through Claude Code, as a third arm.
 *
 *   bench/tac/run-claude-code.mjs <env-file> <task-name>
 *
 * Same reason as on MCP-Bench: both our arms are things we built and tuned, so a
 * production harness we did not build is the only thing that says whether either
 * is actually good. There it finished within noise of codemode at 4.7x the cost;
 * whether that holds on long-horizon office work is the open question.
 *
 * Claude Code runs *inside* the task container, with its own native tools.
 *
 * On MCP-Bench the comparable surface was a tool catalogue, so it got the same
 * catalogue through an MCP shim. Here the surface is the machine itself — the
 * workspace, the seeded services, the grader — so the harness has to be on that
 * machine. Running it on the host with its Bash pointed at macOS would measure
 * nothing. The task images carry no node, hence the runtime staged into the
 * shared volume by the same step that stages the codemode kernel.
 *
 * Seeding and grading are byte-identical to the other two arms, so a score here
 * is comparable to a score there.
 */
import { spawn, execFile } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const VERSION = "1.0.0";
const DECRYPTION_KEY = "theagentcompany is all you need";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const [envFile, taskName] = positional;

if (!envFile || !taskName) {
	console.error("usage: bench/tac/run-claude-code.mjs <env-file> <task-name>");
	process.exit(2);
}

const arm = "claude-code";
const timeoutSec = Number(flag("timeout", 2400));
const image = flag("image", `ghcr.io/theagentcompany/${taskName}-image:${VERSION}`);
const runId = flag("run-id", `tac__${taskName}__claude-code__native__claude-code`);
const runDir = join(ROOT, ".run/tac", runId);
const container = `tac-cc-${taskName}`.slice(0, 60).replace(/[^a-zA-Z0-9_.-]/g, "-");

if (existsSync(join(runDir, "result.json")) && flag("overwrite", "0") !== "1") {
	console.log(`skip ${runId} — already has result.json (pass --overwrite 1 to redo)`);
	process.exit(0);
}
mkdirSync(runDir, { recursive: true });

const docker = (args, opts = {}) => run("docker", args, { maxBuffer: 64 * 1024 * 1024, ...opts });
const log = (m) => console.log(`[${taskName}/claude-code] ${m}`);

const ENV_LLM = [
	"-e", "LITELLM_API_KEY",
	"-e", `LITELLM_BASE_URL=${process.env.HARNESS_TAC_LLM_BASE ?? "https://api.anthropic.com/v1/"}`,
	"-e", `LITELLM_MODEL=${process.env.HARNESS_TAC_LLM_MODEL ?? "openai/claude-sonnet-5"}`,
];

/** See bench/tac/run-task.mjs — the key reaches the container without ever being a JS value. */
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
	const meta = { runId, arm, model: "claude-code", promptVariant: "native", task: taskName, image, container, startedAt: new Date().toISOString() };
	writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

	await docker(["rm", "-fv", container]).catch(() => {});
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
	log("container up");

	const initStarted = Date.now();
	await seedWorld();
	log(`init.sh ok (${((Date.now() - initStarted) / 1000).toFixed(0)}s)`);

	const summary = await runAgent();
	log(`agent done: ${summary.turns} turns, ${summary.toolCalls} calls, $${summary.cost.toFixed(4)}${summary.timedOut ? " [TIMEOUT]" : ""}`);

	const grader = `${container}-grader`;
	let result = null;
	try {
		await docker(["rm", "-fv", grader]).catch(() => {});
		await docker(["run", "-d", "--name", grader, "--platform", "linux/amd64", "--network", "host", image, "sleep", "infinity"]);
		await docker(["exec", grader, "bash", "-c",
			`echo "$(ping -c 1 localhost | grep PING | awk -F'[()]' '{print $2}') the-agent-company.com" >> /etc/hosts`]);
		const stage = join(runDir, "workspace");
		rmSync(stage, { recursive: true, force: true });
		await docker(["cp", `${container}:/workspace`, stage]).catch(() => {});
		if (existsSync(stage)) await docker(["cp", `${stage}/.`, `${grader}:/workspace`]);
		await docker(["cp", join(runDir, "trajectory.json"), `${grader}:/tmp/traj.json`]);
		const { stdout } = await dockerWithKey(
			["exec", "-e", `DECRYPTION_KEY=${DECRYPTION_KEY}`, ...ENV_LLM, grader,
			 "bash", "-c", "python_default /utils/eval.py --trajectory_path /tmp/traj.json --result_path /tmp/result.json && cat /tmp/result.json"],
			{ timeout: 900_000 },
		);
		result = JSON.parse(stdout.slice(stdout.indexOf("{")));
	} catch (err) {
		log(`GRADER FAILED: ${(err.stderr ?? err.message ?? "").slice(-500)}`);
	}

	const score = result ? result.final_score : null;
	writeFileSync(
		join(runDir, "result.json"),
		`${JSON.stringify({ ...meta, summary, result, score, graded: result !== null, finishedAt: new Date().toISOString() }, null, 2)}\n`,
	);
	log(result ? `SCORE ${score.result}/${score.total}` : "SCORE ungraded (grader failed)");
	await docker(["rm", "-fv", container]).catch(() => {});
	await docker(["rm", "-fv", grader]).catch(() => {});
}

/** Identical to run-task.mjs: retry init, then revive the NPCs detached. */
async function seedWorld() {
	const { stdout: depsRaw } = await docker(["exec", container, "cat", "/utils/dependencies.yml"]);
	const deps = depsRaw.split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
	const probes = {
		gitlab: "curl -sf -o /dev/null -H 'PRIVATE-TOKEN: root-token' http://the-agent-company.com:8929/api/v4/projects?per_page=1",
		rocketchat: "curl -sf -o /dev/null http://the-agent-company.com:3000/api/info",
		owncloud: "curl -sf -o /dev/null http://the-agent-company.com:8092/status.php",
		plane: "curl -sf -o /dev/null http://the-agent-company.com:8091/",
	};
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			await dockerWithKey(["exec", "-e", "SERVER_HOSTNAME=localhost", ...ENV_LLM, container, "bash", "/utils/init.sh"], { timeout: 900_000 });
			await reviveNpcs();
			return;
		} catch (err) {
			if (attempt === 3) throw err;
			log(`init.sh failed (attempt ${attempt}/3), waiting for services to settle`);
			for (const dep of deps) {
				if (!probes[dep]) continue;
				for (let i = 0; i < 60; i++) {
					try {
						await docker(["exec", container, "bash", "-c", probes[dep]], { timeout: 30_000 });
						break;
					} catch {
						await new Promise((r) => setTimeout(r, 5_000));
					}
				}
			}
		}
	}
}

async function reviveNpcs() {
	const hasNpcs = await docker(["exec", container, "test", "-f", "/npc/scenarios.json"]).then(() => true, () => false);
	if (!hasNpcs) return;
	await docker(["exec", container, "bash", "-c", "pkill -f run_one_npc.py || true"]).catch(() => {});
	await dockerWithKey(["exec", "-d", ...ENV_LLM, container, "bash", "-c",
		"cd /npc && setsid python_default /npc/run_multi_npc.py > /tmp/npc.log 2>&1"]);
	for (let i = 0; i < 30; i++) {
		const { stdout } = await docker(["exec", container, "bash", "-c", "ps ax | grep -c '[r]un_one_npc' || true"]);
		if (Number(stdout.trim()) > 0) return log(`NPCs listening (${stdout.trim()} processes)`);
		await new Promise((r) => setTimeout(r, 5_000));
	}
	log("WARNING: NPCs never came up — task may be unsolvable");
}

/**
 * Claude Code with its own tools, its own prompting and its own agent loop —
 * none of which we tune. It gets upstream's framing and nothing else, exactly
 * like the arms we built.
 */
function runAgent() {
	return new Promise((resolve) => {
		const child = spawn(
			"bash",
			["-c",
			 // IS_SANDBOX=1 because the task containers run as root and Claude Code
			 // refuses --dangerously-skip-permissions as root otherwise. The
			 // container *is* a disposable sandbox, which is exactly the case the
			 // flag exists for.
			 'set -a; . "$1"; set +a; shift; exec docker exec -i -e ANTHROPIC_API_KEY -e IS_SANDBOX=1 -e PATH=/agent/node/bin:/usr/local/bin:/usr/bin:/bin -w /workspace "$@"',
			 "_", envFile, container,
			 "claude", "-p", "--output-format", "stream-json", "--verbose",
			 "--dangerously-skip-permissions",
			 "Complete the task in /instruction/task.md"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		const events = [];
		const summary = { turns: 0, toolCalls: 0, toolErrors: 0, toolNames: [], cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, finalText: "", timedOut: false };
		let buffer = "";
		let stderr = "";

		const killTimer = setTimeout(() => {
			summary.timedOut = true;
			child.kill("SIGKILL");
		}, timeoutSec * 1000);

		child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
		child.stdout.on("data", (chunk) => {
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
				events.push(e);
				if (e.type === "assistant" && e.message) {
					summary.turns++;
					const u = e.message.usage ?? {};
					summary.input += u.input_tokens ?? 0;
					summary.output += u.output_tokens ?? 0;
					summary.cacheRead += u.cache_read_input_tokens ?? 0;
					summary.cacheWrite += u.cache_creation_input_tokens ?? 0;
					for (const c of e.message.content ?? []) {
						if (c.type === "tool_use") {
							summary.toolCalls++;
							summary.toolNames.push(c.name);
						}
					}
				} else if (e.type === "user" && e.message) {
					for (const c of e.message.content ?? []) if (c.type === "tool_result" && c.is_error) summary.toolErrors++;
				} else if (e.type === "result") {
					summary.finalText = e.result ?? summary.finalText;
					if (typeof e.total_cost_usd === "number") summary.cost = e.total_cost_usd;
				}
			}
		});

		// exit, not close — see run-task.mjs; an orphaned child holding the pipes
		// open is what wedged a run twenty minutes past its own timeout.
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

main().catch(async (err) => {
	console.error(`[${taskName}/claude-code] FAILED: ${err.stderr ?? err.message}`);
	writeFileSync(join(runDir, "error.json"), `${JSON.stringify({ error: String(err.stderr ?? err.message) }, null, 2)}\n`);
	await docker(["rm", "-fv", container]).catch(() => {});
	await docker(["rm", "-fv", `${container}-grader`]).catch(() => {});
	process.exit(1);
});
