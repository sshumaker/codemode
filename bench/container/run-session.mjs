#!/usr/bin/env node
/**
 * Run prime, for real, inside the containerized runtime — and time it.
 *
 *   node bench/container/run-session.mjs --env <file> --probe --repeat 3
 *   node bench/container/run-session.mjs --env <file> --probe --in-container 2
 *   node bench/container/run-session.mjs --env <file> --full
 *
 * The whole harness is in the container: node, dist/bundle/cli.js and the kernel
 * venv. Two things cross the boundary, onto two host-side hops:
 *
 *   HARNESS_MCP_PROXY   -> {forwarder}  -> the MCP servers      (mock-forwarder.py)
 *   ANTHROPIC_BASE_URL  -> {relay}      -> api.anthropic.com    (model-relay.py)
 *
 * TWO hops, not one, and that is a finding rather than an accident: proxy/egress
 * refuses at config-load to route to any model provider (main.go:204), because in
 * the deployed shape only cells are sandboxed and intelligence is supposed to
 * reach them as spawn(). Containerizing the harness puts prime's own provider
 * traffic inside the boundary, which that guard will not carry — so the model
 * flow gets its own relay and the guard stays intact.
 *
 * The tool hop goes straight to the forwarder rather than through
 * {egress}/r/mcp, which is what a benchmark run under the posture uses. Tried
 * that first and it 401s: the api/ tree in .run was compiled before
 * generate.mjs learned to send `x-egress-token`, so its _client.py presents no
 * credential. Regenerating the tree would fix it; the design record's boundary
 * table names the forwarder directly, so this matches the design as written.
 *
 * ANTHROPIC_API_KEY inside the container is the relay's per-run token, not the
 * model key: the key is read host-side from the env file and injected at the
 * boundary. That is the design record's key decision, executed rather than
 * asserted — `docker exec … env` during a run shows the token and nothing else,
 * and TAC has already leaked a real key into an agent-visible container once.
 *
 * `--probe` runs the same trivial `print(6*7)` cell bench/appworld/prewarm.mjs
 * uses, so the numbers here are comparable to the host numbers already recorded.
 * `--full` runs a cell that imports the read-only api/ tree and calls a compiled
 * tool, which exercises the transport end to end.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedPrimeSettings } from "../prime-settings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? fallback : argv[i + 1];
};

const IMAGE = flag("image", "harness-runtime:aarch64");
const ENV_FILE = flag("env", join(homedir(), "src/goals/web/.env.local"));
const API_DIR = flag("api", join(homedir(), "src/harness/.run/api"));
const MODEL = flag("model", "anthropic/claude-haiku-4-5-20251001");
const REPEAT = Number(flag("repeat", "1"));
const IN_CONTAINER = Number(flag("in-container", "0"));
const FULL = argv.includes("--full");
// The same session, on the host, for the delta the design record asks for.
// Everything else identical — same prompt, same model, same relay hop — so the
// difference that remains is the container.
const HOST_BASELINE = argv.includes("--host");
const DOCKER_HOST = process.env.DOCKER_HOST ?? "unix:///Users/scottshumaker/.colima/default/docker.sock";

// Under $HOME — colima shares only $HOME into the VM, so a bind source under
// macOS $TMPDIR (/var/folders/…) does not exist on the daemon side.
const TMP_ROOT = process.env.HARNESS_CONTAINER_TMP ?? join(homedir(), ".cache/harness-container");
mkdirSync(TMP_ROOT, { recursive: true });
const RUN_DIR = mkdtempSync(join(TMP_ROOT, "session."));

const PROBE_PROMPT =
	"Run one ipython cell containing exactly: print(6*7). Then reply with only the number.";
const FULL_PROMPT = [
	"Run one ipython cell containing exactly these three lines:",
	"import sys; sys.path.insert(0, '/job')",
	"from api.fruityvice import get_fruit_nutrition",
	"print(await get_fruit_nutrition('apple'))",
	"Then reply with only the text that the cell printed.",
].join("\n");

/** Read the model key host-side. It is never put in the container's env. */
function hostApiKey() {
	const shown = spawnSync("bash", ["-c", `set -a; . "$1"; set +a; printf %s "$ANTHROPIC_API_KEY"`, "_", ENV_FILE], {
		encoding: "utf8",
	});
	const key = shown.stdout?.trim();
	if (!key) throw new Error(`no ANTHROPIC_API_KEY in ${ENV_FILE}`);
	return key;
}

/** Spawn a host-side python helper that announces its port in a file. */
function startHelper(script, args, portFile, env = process.env) {
	const proc = spawn("python3", [join(HERE, script), ...args], { stdio: "ignore", env });
	const deadline = Date.now() + 10_000;
	let port = "";
	while (Date.now() < deadline) {
		if (existsSync(portFile)) {
			port = readFileSync(portFile, "utf8").trim();
			if (port) break;
		}
		// Synchronous by design: nothing else may run until the port is known, and
		// an async sleep here would let main() proceed with an empty URL.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
	}
	if (!port) throw new Error(`${script} never reported a port`);
	return { url: `http://127.0.0.1:${port}`, stop: () => proc.kill("SIGKILL") };
}

/** Host-side mock MCP forwarder. Answers {ok,text} on any path, incl. /call. */
const startForwarder = () =>
	startHelper("mock-forwarder.py", [join(RUN_DIR, "forwarder-port")], join(RUN_DIR, "forwarder-port"));

/**
 * Host-side model relay. The key lives in THIS process's env and nowhere else;
 * the container is given `token` instead.
 */
const startRelay = (token) =>
	startHelper(
		"model-relay.py",
		["--token", token, "--port-file", join(RUN_DIR, "relay-port"), "--audit", join(RUN_DIR, "relay-audit.jsonl")],
		join(RUN_DIR, "relay-port"),
		{ ...process.env, ANTHROPIC_API_KEY: hostApiKey() },
	);

/** The env the container gets. Note what is NOT here: the model key. */
function containerEnv(forwarderUrl, relayUrl, relayToken) {
	const fromContainer = (url) => url.replace("127.0.0.1", "host.docker.internal");
	return {
		HARNESS_MCP_PROXY: fromContainer(forwarderUrl),
		ANTHROPIC_BASE_URL: fromContainer(relayUrl),
		ANTHROPIC_API_KEY: relayToken,
		PRIME_AGENT_KERNEL_PYTHON: "/agent/venv/bin/python",
		PRIME_AGENT_CODING_AGENT_DIR: "/job/.agent",
		DO_NOT_TRACK: "1",
		PRIME_AGENT_TELEMETRY: "0",
	};
}

const HOST_CLI = join(HERE, "../../vendor/prime-agent/packages/coding-agent/dist/bundle/cli.js");
const HOST_KERNEL = join(homedir(), ".prime/agent/kernel-venv/bin/python");

const cliArgs = (prompt) => [
	"node", "/agent/prime/dist/bundle/cli.js",
	"-p", "--mode", "json",
	"--model", MODEL,
	"--tools", "ipython",
	"--cwd", "/job",
	"--no-context-files", "--no-prompt-templates", "--no-extensions",
	prompt,
];

/**
 * Watch prime's json stream for the first executed cell.
 *
 * Timed from just before spawn, so the number includes container create/start,
 * node boot, kernel boot and one model round trip — the same envelope
 * prewarm.mjs reports for the host, and therefore comparable to it.
 */
function timeSession(args, jobDir, label, onHost = false) {
	return new Promise((resolve) => {
		const started = Date.now();
		// The whole stream, kept. A verdict without its evidence cannot be
		// re-derived once the container is gone, and these containers are --rm.
		const transcript = createWriteStream(join(jobDir, `${label}.jsonl`));
		let firstCellMs = null;
		let reply = "";
		const child = onHost
			? spawn(args[0], args.slice(1), { cwd: jobDir, env: args.env, stdio: ["ignore", "pipe", "pipe"] })
			: spawn("docker", args, { env: { ...process.env, DOCKER_HOST }, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (c) => {
			stderr += String(c);
			transcript.write(c);
		});
		child.stdout.on("data", (chunk) => {
			transcript.write(chunk);
			for (const line of String(chunk).split("\n")) {
				if (!line.startsWith("{")) continue;
				if (firstCellMs === null && line.includes('"tool_execution_end"')) firstCellMs = Date.now() - started;
				try {
					const event = JSON.parse(line);
					// The final answer is the text blocks of the last assistant turn;
					// thinking blocks sit in the same array and are not the answer.
					if (event.type === "turn_end" && Array.isArray(event.message?.content)) {
						const text = event.message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("")
							.trim();
						if (text) reply = text;
					}
				} catch {}
			}
		});
		child.on("close", (code) => {
			transcript.end();
			resolve({ firstCellMs, totalMs: Date.now() - started, code, reply: reply.trim().slice(0, 200), stderr: stderr.slice(-400), jobDir });
		});
	});
}

/**
 * A job dir, with the agent home prime will read from inside the container.
 *
 * models.json is the ONLY supported way to move prime off api.anthropic.com.
 * ANTHROPIC_BASE_URL does not work: every anthropic entry in prime's built-in
 * registry carries `baseUrl: "https://api.anthropic.com"` explicitly, and
 * createClient passes it to `new Anthropic({ baseURL })`, so the SDK's env
 * fallback never fires. Measured, not assumed — with ANTHROPIC_BASE_URL pointed
 * at a dead port the run still reached the real API and came back with a genuine
 * 401 and an Anthropic request_id. Re-declaring the model here with the relay's
 * baseUrl is the documented override (ModelRegistry.loadCustomModels).
 *
 * The costs are the built-in numbers, copied. models.json defaults them to zero,
 * and a run that reports $0.00 because its price table is empty is worse than one
 * that reports nothing.
 */
function newJobDir(relayUrl) {
	const dir = mkdtempSync(join(RUN_DIR, "job."));
	const agentHome = seedPrimeSettings(join(dir, ".agent"));
	if (!relayUrl) return dir;
	writeFileSync(
		join(agentHome, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					anthropic: {
						baseUrl: relayUrl,
						models: [
							{
								id: MODEL.split("/").pop(),
								name: "Claude Haiku 4.5 (via host relay)",
								api: "anthropic-messages",
								reasoning: true,
								input: ["text", "image"],
								cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
								contextWindow: 200000,
								maxTokens: 64000,
							},
						],
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	return dir;
}

const mounts = (jobDir) => [
	"--mount", `type=bind,src=${jobDir},dst=/job`,
	"--mount", `type=bind,src=${API_DIR},dst=/job/api,readonly`,
];
const envFlags = (env) => Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

async function main() {
	const forwarder = startForwarder();
	// Minted here, never written to disk, handed only to the container.
	const relayToken = randomBytes(24).toString("hex");
	const relay = startRelay(relayToken);
	const relayForContainer = relay.url.replace("127.0.0.1", "host.docker.internal");
	const env = containerEnv(forwarder.url, relay.url, relayToken);
	const prompt = FULL ? FULL_PROMPT : PROBE_PROMPT;
	const rows = [];

	try {
		if (IN_CONTAINER > 0) {
			// One container, N sequential sessions: the second boot pays no image
			// page-in and no container create, which is the prewarmed number.
			const jobDir = newJobDir(relayForContainer);
			const name = `harness-runtime-probe-${process.pid}`;
			spawnSync("docker", ["rm", "-f", name], { env: { ...process.env, DOCKER_HOST }, stdio: "ignore" });
			spawnSync(
				"docker",
				["run", "-d", "--name", name, ...mounts(jobDir), ...envFlags(env), IMAGE, "sleep", "infinity"],
				{ env: { ...process.env, DOCKER_HOST }, stdio: "inherit" },
			);
			try {
				for (let i = 0; i < IN_CONTAINER; i++) {
					const row = await timeSession(["exec", "-w", "/job", name, ...cliArgs(prompt)], jobDir, `session-${i + 1}`);
					rows.push({ ...row, kind: i === 0 ? "in-container #1 (cold)" : `in-container #${i + 1} (prewarmed)` });
					console.log(`  ${rows.at(-1).kind}: first cell ${row.firstCellMs}ms, total ${row.totalMs}ms, exit ${row.code}`);
				}
			} finally {
				spawnSync("docker", ["rm", "-f", name], { env: { ...process.env, DOCKER_HOST }, stdio: "ignore" });
			}
		} else if (HOST_BASELINE) {
			for (let i = 0; i < REPEAT; i++) {
				// The baseline is the runtime as it exists TODAY: prime on the host,
				// the host kernel venv, and the model key in the agent's own process.
				// No relay and no models.json override — putting those in the baseline
				// would measure the relay rather than the container.
				const jobDir = newJobDir(null);
				// --daemon-socket, per run, is NOT optional here. Print mode attaches to
				// a SHARED daemon on a default socket, and a stale one on this machine
				// fails every request with the bare string "Connection error." — for
				// any provider and any dist, which is what made it look like a node 25
				// problem. Paired A/B, same command, back to back: default socket FAIL,
				// fresh socket PASS, default socket FAIL. Containers do not need this;
				// each one boots its own daemon.
				const hostArgs = [
					"node", HOST_CLI,
					"--daemon-socket", join(jobDir, "daemon.sock"),
					...cliArgs(prompt).slice(2).map((a) => (a === "/job" ? jobDir : a)),
				];
				hostArgs.env = {
					...process.env,
					HARNESS_MCP_PROXY: forwarder.url,
					ANTHROPIC_API_KEY: hostApiKey(),
					PRIME_AGENT_KERNEL_PYTHON: HOST_KERNEL,
					PRIME_AGENT_CODING_AGENT_DIR: join(jobDir, ".agent"),
					DO_NOT_TRACK: "1",
					PRIME_AGENT_TELEMETRY: "0",
				};
				const row = await timeSession(hostArgs, jobDir, `session-${i + 1}`, true);
				rows.push({ ...row, kind: `host #${i + 1}` });
				console.log(`  ${rows.at(-1).kind}: first cell ${row.firstCellMs}ms, total ${row.totalMs}ms, exit ${row.code} reply=${JSON.stringify(row.reply)}`);
				if (row.code !== 0 && row.stderr) console.log(`    stderr: ${row.stderr}`);
			}
		} else {
			for (let i = 0; i < REPEAT; i++) {
				const jobDir = newJobDir(relayForContainer);
				const row = await timeSession(["run", "--rm", ...mounts(jobDir), ...envFlags(env), IMAGE, ...cliArgs(prompt)], jobDir, `session-${i + 1}`);
				rows.push({ ...row, kind: `fresh container #${i + 1}` });
				console.log(`  ${rows.at(-1).kind}: first cell ${row.firstCellMs}ms, total ${row.totalMs}ms, exit ${row.code} reply=${JSON.stringify(row.reply)}`);
				if (row.code !== 0 && row.stderr) console.log(`    stderr: ${row.stderr}`);
			}
		}
	} finally {
		forwarder.stop();
		relay.stop();
	}

	writeFileSync(join(RUN_DIR, "timings.json"), `${JSON.stringify(rows, null, 2)}\n`);
	console.log(`\nrun dir ${RUN_DIR}`);
	console.log(`relay audit ${join(RUN_DIR, "relay-audit.jsonl")}`);
	const cells = rows.map((r) => r.firstCellMs).filter((n) => n !== null);
	if (cells.length) {
		const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
		console.log(`first-cell: n=${cells.length} mean ${(mean / 1000).toFixed(1)}s min ${(Math.min(...cells) / 1000).toFixed(1)}s max ${(Math.max(...cells) / 1000).toFixed(1)}s`);
	} else {
		console.log("NO CELL RAN in any session — the number above is not a latency, it is a failure");
	}
	process.exit(rows.every((r) => r.code === 0) ? 0 : 1);
}

process.on("exit", () => {
	if (!process.env.HARNESS_KEEP_RUN_DIR) rmSync(RUN_DIR, { recursive: true, force: true });
});
await main();
