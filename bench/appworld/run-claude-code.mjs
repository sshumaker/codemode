#!/usr/bin/env node
/**
 * Run one AppWorld task through Claude Code, consuming AppWorld's NATIVE MCP server.
 *
 *   bench/appworld/run-claude-code.mjs <env-file> <model> <task-id> [options]
 *
 *   options   --prompt c1  --timeout 900  --max-cost 3  --run-id X  --force
 *             --allow-bash            give it the Bash tool (bypass measurement only)
 *             --keep-servers          leave the APIs server up for post-mortem
 *
 * The third arm of docs/APPWORLD-3ARM-MCP-VS-APIS.md. codemode compiles AppWorld's
 * tool surface into importable `api/` files; vanilla hands the same surface over as
 * JSON tool-calling; this arm hands it over as **MCP**, to the real product, the way
 * a user actually would — `claude -p --mcp-config`.
 *
 * The chain, and why each link is upstream's rather than ours
 * ----------------------------------------------------------
 *
 *   appworld serve apis            the world's databases, behind HTTP
 *          ^                    ^
 *          | POST /dbs          | every API call
 *          |                    |
 *   env-server.py            appworld serve mcp (stdio)
 *   (--remote-apis-url)             ^
 *   binds + grades                  | MCP
 *                              claude -p --mcp-config
 *
 * An MCP server is a separate process, so it cannot share an in-process world with
 * the grader; AppWorld's own answer to that is remote-APIs mode, and this arm uses
 * it verbatim. `env-server.py --remote-apis-url` opens the task with
 * `AppWorld(remote_apis_url=...)`, whose `ApiCollection.setup()` POSTs `/dbs` and
 * points the APIs server at THIS task's databases (requester.py:374). The MCP
 * server loads its own `ApiCollection` with `skip_setup=True` against the same URL
 * (serve/_mcp.py:314-323), so it reads the world we bound instead of rebinding it.
 * Grading then runs through the same `env-server /evaluate` every other arm uses —
 * different transport, identical task, identical verifier.
 *
 * Fairness, and where it is enforced
 * ----------------------------------
 * - **Same base prompt**, byte-identical to the other arms (`buildBase`), digested
 *   into meta.json. The preamble is `c1`, matched to vanilla's `b1` clause for
 *   clause, because this arm is the same residency (all 469 schemas resident on
 *   turn one) and the same representation (JSON tool-calls) — the variable is the
 *   *product*, and any extra guidance here would confound it on the first run.
 * - **No shell.** `--tools Read,Write,Edit,Grep,Glob` mirrors run-task.mjs's
 *   BUILTINS; neither prime arm gets bash, so neither does this one. That is also
 *   what makes the MCP-Bench bypass structurally impossible rather than merely
 *   discouraged — 78% of vanilla's bash calls there were `curl` past its own tools.
 *   `--allow-bash` exists to *measure* the bypass, not to run the comparison.
 * - **Dead egress proxy**, identical to run-task.mjs: everything but 127.0.0.1 and
 *   the model API is unreachable.
 * - **Every API call logged anyway.** The MCP server is upstream's and does not log
 *   responses, so this runner puts a recording reverse proxy between it and the
 *   APIs server. `env-calls.jsonl` therefore exists for this arm too, with the same
 *   fields, read off the wire rather than off the agent's account of itself. World
 *   setup and grading talk to the APIs server *directly*, so anything the proxy saw
 *   is by construction an agent-initiated call.
 *
 * Per-run artefacts under .run/appworld/<runId>/ — same shape as run-task.mjs, plus:
 *   mcp-config.json    the exact config handed to Claude Code
 *   argv.json          the exact argv, env keys, and cwd
 *   apis-server.log    the APIs server's own output
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createSocketServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_PROMPTS, buildBase, buildClaudePreamble } from "./prompts.mjs";
import { makeArgv } from "../argv.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const APPWORLD = join(ROOT, "vendor/appworld");
const PYTHON = join(APPWORLD, ".venv/bin/python3");
const VENV_BIN = join(APPWORLD, ".venv/bin");
const ENV_SERVER = join(ROOT, "bench/appworld/env-server.py");

const argv = process.argv.slice(2);
const { flag } = makeArgv(argv);
const has = (name) => argv.includes(`--${name}`);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const [envFile, model, taskId] = positional;

if (!envFile || !model || !taskId) {
	console.error("usage: bench/appworld/run-claude-code.mjs <env-file> <model> <task-id> [--prompt c1]");
	process.exit(2);
}
for (const [label, path] of [["appworld venv python", PYTHON], ["env-file", envFile]]) {
	if (!existsSync(path)) {
		console.error(`missing ${label}: ${path}`);
		process.exit(2);
	}
}

const arm = "claude-code";
// Claude Code registers every MCP tool up front, so this arm's residency is not a
// dial — it is L4 by construction. Recorded rather than accepted on faith: the
// first-turn prompt tokens are checked against it below.
const residency = "L4";
const promptName = flag("prompt", "c1");
const timeoutSec = Number(flag("timeout", 900));
const maxCost = Number(flag("max-cost", 3.0));
const allowBash = has("allow-bash");
// --base-prompt=v1|v2 — the shared base prompt, parsed exactly as run-task.mjs does
// so the two runners cannot drift on which string "v2" names.
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
const runId = flag(
	"run-id",
	`${taskId}__${arm}__${residency}__${promptName}${allowBash ? "__bash" : ""}` +
		`${basePromptVersion === "v1" ? "" : `__bp-${basePromptVersion}`}__${model.replace(/[^a-z0-9]/gi, "-")}`,
);
const runDir = join(ROOT, ".run/appworld", runId);

if (existsSync(join(runDir, "result.json")) && !has("force")) {
	console.error(`run already exists: ${runId}\n  pass --force to overwrite, or delete the directory`);
	process.exit(3);
}
if (existsSync(runDir)) {
	for (const stale of ["env-calls.jsonl", "world-diff.json", "evaluation.json", "phases.json", "env-server.json", "trajectory.jsonl", "stream.jsonl", "env-server.log", "apis-server.log", "http-calls.jsonl"]) {
		rmSync(join(runDir, stale), { force: true });
	}
	for (const staleDir of ["appworld-output", "agent-home"]) rmSync(join(runDir, staleDir), { recursive: true, force: true });
}
mkdirSync(runDir, { recursive: true });

const phases = {};
const mark = (name) => {
	phases[name] = Date.now();
};
mark("startedAt");

const digest = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A free TCP port. Asked for and released, rather than hardcoded: two concurrent
 *  runs on AppWorld's default 9000/10000 would silently share one world. */
function freePort() {
	return new Promise((resolve, reject) => {
		const server = createSocketServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

// --- task facts ---------------------------------------------------------------

/** The task instruction and supervisor, read out of AppWorld rather than guessed.
 *  Verbatim from run-task.mjs so both arms are briefed from the same source. */
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

/**
 * The MCP config, built by AppWorld's own `build_mcp_config` rather than written here.
 *
 * Two overrides, both because upstream's builder assumes it is generating a config
 * for a human to paste into a client that shares its interpreter:
 *
 *  - `command` comes from `shutil.which("python")` (serve/_mcp.py:54), which resolves
 *    against whatever PATH the *generator* had. On this machine that is
 *    /opt/homebrew/bin/python — no appworld, no mcp. The stdio server then dies on
 *    import, and because a stdio server's stderr goes nowhere the client simply
 *    **hangs forever** (MCPClient waits on ready_event with no timeout). Measured:
 *    the first probe sat wedged for three minutes with no output. Pin the venv.
 *  - `env` is `{PYTHONPATH: "."}` — relative to the client's cwd, not AppWorld's.
 */
function buildMcpConfig(apisUrl) {
	const script = [
		"import warnings, json; warnings.filterwarnings('ignore')",
		"from appworld.apps import get_all_apps",
		"from appworld.serve._mcp import build_mcp_config",
		"apps = get_all_apps(skip_admin=True, skip_api_docs=True)",
		// content_only is what upstream's own generate_mcp_config.py defaults to for
		// Claude. It also happens to be the only arm-neutral choice: `both` returns the
		// payload twice (text AND structured), which would inflate this arm's context
		// against vanilla, whose /call returns one text body.
		`print('<<<JSON>>>' + json.dumps(build_mcp_config(transport='stdio', app_names=apps, output_type='content_only', remote_apis_url='${apisUrl}')))`,
	].join("\n");
	const out = execFileSync(PYTHON, ["-c", script], { cwd: APPWORLD, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
	const params = JSON.parse(out.slice(out.indexOf("<<<JSON>>>") + 10));
	params.command = PYTHON;
	params.env = { PYTHONPATH: APPWORLD, PATH: `${VENV_BIN}:${process.env.PATH}` };
	return { mcpServers: { appworld: params } };
}

// --- the servers --------------------------------------------------------------

/** AppWorld's APIs server: the databases this task's world will be bound into. */
async function startApisServer(port) {
	const logStream = createWriteStream(join(runDir, "apis-server.log"));
	const child = spawn(PYTHON, ["-m", "appworld.cli", "serve", "apis", "--port", String(port), "--root", "."], {
		cwd: APPWORLD,
		env: { ...process.env, PATH: `${VENV_BIN}:${process.env.PATH}` },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.pipe(logStream);
	child.stderr.pipe(logStream);
	const deadline = Date.now() + 300_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`apis server exited early (${child.exitCode}); see apis-server.log`);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/dbs`, { signal: AbortSignal.timeout(3000) });
			if (response.ok) return child;
		} catch {
			// not up yet
		}
		await sleep(1000);
	}
	child.kill("SIGKILL");
	throw new Error("apis server did not become ready in 300s");
}

/**
 * A recording reverse proxy in front of the APIs server, for the MCP server only.
 *
 * This is this arm's `env-calls.jsonl`. Upstream's MCP server does not log, and
 * AppWorld's own `api_calls.jsonl` records `{method, url, data}` and **no response**
 * (requester.py:82) — so without this we would have the agent's account of what it
 * did and not what the world answered, on a world that stops existing when the
 * process exits. Responses are kept whole; they are the grounding evidence.
 *
 * Setup and grading address the APIs server directly, so every request arriving
 * here came from the agent.
 */
function startCallProxy(listenPort, upstreamPort, logStream) {
	const server = createServer((req, res) => {
		const started = Date.now();
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", async () => {
			const body = Buffer.concat(chunks);
			const url = `http://127.0.0.1:${upstreamPort}${req.url}`;
			const headers = { ...req.headers };
			delete headers.host;
			delete headers["content-length"];
			let status = 0;
			let text = "";
			let error = null;
			try {
				const upstream = await fetch(url, {
					method: req.method,
					headers,
					body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
				});
				status = upstream.status;
				text = await upstream.text();
				res.writeHead(status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
				res.end(text);
			} catch (e) {
				error = String(e);
				res.writeHead(502, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: error }));
			}
			let args = null;
			try {
				args = body.length > 0 ? JSON.parse(body.toString()) : null;
			} catch {
				args = { _raw: body.toString().slice(0, 2000) };
			}
			// `/<app>/<api>` is how AppWorld routes; the app/api split makes this log
			// line-for-line comparable with the other arms' env-calls.jsonl.
			const [, app = "", ...rest] = req.url.split("?")[0].split("/");
			logStream.write(
				`${JSON.stringify({
					t: started / 1000,
					kind: "call",
					arm,
					runId,
					app,
					api: rest.join("/"),
					method: req.method,
					url: req.url,
					args,
					ok: status >= 200 && status < 300,
					status,
					error,
					response: text,
					response_len: text.length,
					// AppWorld returns 4xx for a malformed call and the MCP server passes the
					// body through as text, exactly as the other arms see a traceback as text.
					execFailed: status >= 400,
					seconds: (Date.now() - started) / 1000,
					t_end: Date.now() / 1000,
				})}\n`,
			);
		});
	});
	return new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(listenPort, "127.0.0.1", () => resolve(server));
	});
}

/** The task world + grader. Same process, same endpoints, same artefacts as every
 *  other arm — only `--remote-apis-url` differs. */
function startEnvServer(apisUrl) {
	const logStream = createWriteStream(join(runDir, "env-server.log"));
	const child = spawn(
		PYTHON,
		[ENV_SERVER, "--task-id", taskId, "--run-dir", runDir, "--arm", arm, "--appworld-root", APPWORLD, "--remote-apis-url", apisUrl],
		{ cwd: APPWORLD, env: { ...process.env, PATH: `${VENV_BIN}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stderr.pipe(logStream);
	return new Promise((resolve, reject) => {
		let out = "";
		const timer = setTimeout(() => reject(new Error(`env-server did not become ready in 300s\n${out}`)), 300_000);
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

const post = async (port, path, body) =>
	(
		await fetch(`http://127.0.0.1:${port}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		})
	).json();
const get = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();

// --- run ----------------------------------------------------------------------

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
	// The A0 checks. A run where MCP never connected is not a weak agent, it is a
	// broken harness, and the two produce the same-looking score.
	mcpServers: null,
	mcpToolsAdvertised: null,
	nonMcpToolCalls: [],
	bashCommands: [],
};

async function main() {
	const facts = loadTaskFacts();
	const supervisorName =
		`${facts.supervisor.first_name} ${facts.supervisor.last_name}` +
		` (email ${facts.supervisor.email}, phone ${facts.supervisor.phone_number})`;
	const appsBlock = Object.entries(facts.appDescriptions)
		.map(([app, description]) => `  ${app} — ${String(description).trim().split("\n")[0]}`)
		.join("\n");

	mark("worldStart");
	const apisPort = await freePort();
	const apisServer = await startApisServer(apisPort);
	mark("apisReady");

	const proxyPort = await freePort();
	const callLog = createWriteStream(join(runDir, "env-calls.jsonl"), { flags: "a" });
	const proxy = await startCallProxy(proxyPort, apisPort, callLog);

	// The world binds through the REAL port; only the agent's MCP server goes through
	// the recorder. Otherwise setup and grading would appear in the agent's call log.
	const { child: env, port: envPort } = await startEnvServer(`http://127.0.0.1:${apisPort}`);
	mark("worldReady");
	console.log(`[appworld] apis :${apisPort} (agent via :${proxyPort}), world :${envPort} for ${taskId}`);

	const mcpConfig = buildMcpConfig(`http://127.0.0.1:${proxyPort}`);
	const mcpConfigPath = join(runDir, "mcp-config.json");
	writeFileSync(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);

	// --- prompts ---
	const basePrompt = buildBase({ supervisor: supervisorName, apps: appsBlock, version: basePromptVersion });
	// 469 tools / 11 apps, the same catalogue the other arms count. Read off the MCP
	// server's own tool list below and asserted, rather than asserted here.
	const toolCount = 469;
	const serverCount = Object.keys(facts.appDescriptions).length;
	const preamble = buildClaudePreamble(promptName, { toolCount, serverCount });

	// `--bare` narrows Claude Code's built-in set to exactly Bash/Edit/Read (measured:
	// `--tools default --bare` advertises those three, and Write/TodoWrite cannot be
	// added back). Dropping Bash leaves Read+Edit, which is the same *kind* of surface
	// run-task.mjs gives its arms — scratch file tools, no shell — and there is nothing
	// on disk for this arm to read anyway.
	const builtins = allowBash ? "Read,Edit,Bash" : "Read,Edit";
	const allowed = `mcp__appworld,${builtins}`;
	const cliArgs = [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--model",
		model.replace(/^anthropic\//, ""),
		"--mcp-config",
		mcpConfigPath,
		"--strict-mcp-config",
		"--tools",
		builtins,
		"--allowedTools",
		allowed,
		"--max-budget-usd",
		String(maxCost),
		"--no-session-persistence",
		// prime's arms run with --no-context-files --no-prompt-templates for
		// reproducibility. --bare is the Claude Code equivalent: no CLAUDE.md
		// discovery, no hooks, no auto-memory, no keychain — and auth strictly from
		// ANTHROPIC_API_KEY, so the cost this run reports is a real API cost and not a
		// subscription's.
		"--bare",
		"--system-prompt",
		basePrompt,
		"--append-system-prompt",
		preamble,
		facts.instruction,
	];

	writeFileSync(
		join(runDir, "system-prompt.json"),
		`${JSON.stringify(
			{
				runId,
				arm,
				residency,
				variants: { basePromptVersion },
				basePrompt,
				basePromptDigest: digest(basePrompt),
				preamble,
				preambleDigest: digest(preamble),
				basePromptChars: basePrompt.length,
				preambleChars: preamble.length,
				toolList: allowed.split(","),
				userPrompt: facts.instruction,
			},
			null,
			1,
		)}\n`,
	);
	writeFileSync(
		join(runDir, "argv.json"),
		`${JSON.stringify({ command: "claude", args: cliArgs, cwd: runDir, envFile, mcpConfig }, null, 1)}\n`,
	);

	const meta = {
		runId,
		benchmark: "appworld",
		arm,
		residency,
		model,
		task: { id: taskId, instruction: facts.instruction, allowedApps: facts.allowedApps, dbVersion: facts.dbVersion },
		promptVariant: promptName,
		variants: { basePromptVersion },
		basePromptDigest: digest(basePrompt),
		preambleChars: preamble.length,
		allowBash,
		startedAt: new Date().toISOString(),
	};
	writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

	const child = spawn("bash", ["-c", `set -a; . "$1"; set +a; shift; exec claude "$@"`, "_", envFile, ...cliArgs], {
		cwd: runDir,
		env: {
			...process.env,
			PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`,
			DO_NOT_TRACK: "1",
			DISABLE_TELEMETRY: "1",
			DISABLE_ERROR_REPORTING: "1",
			DISABLE_AUTOUPDATER: "1",
			DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
			// Same dead proxy as run-task.mjs. AppWorld is entirely local, so there is no
			// legitimate egress; this is what stops an arm reaching around its own tool
			// surface.
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
	const trajectoryFile = createWriteStream(join(runDir, "trajectory.jsonl"));
	let buffer = "";
	let stderr = "";
	const counted = new Set();
	const countedBlocks = new Set();
	const countedResults = new Set();
	mark("agentStart");

	const killTimer = setTimeout(() => {
		summary.timedOut = true;
		child.kill("SIGKILL");
	}, timeoutSec * 1000);

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
			if (event.type === "system" && event.subtype === "init") {
				summary.mcpServers = event.mcp_servers ?? null;
				summary.mcpToolsAdvertised = (event.tools ?? []).filter((t) => String(t).startsWith("mcp__appworld__")).length;
				summary.builtinsAdvertised = (event.tools ?? []).filter((t) => !String(t).startsWith("mcp__")).sort();
			} else if (event.type === "assistant" && event.message) {
				const message = event.message;
				for (const block of message.content ?? []) {
					if (block.type === "text" && block.text) summary.finalText = block.text;
					if (block.type !== "tool_use") continue;
					// Blocks are re-emitted too; id-dedupe rather than trusting arrival.
					if (block.id && countedBlocks.has(block.id)) continue;
					if (block.id) countedBlocks.add(block.id);
					summary.toolCalls++;
					summary.toolNames.push(block.name);
					if (!String(block.name).startsWith("mcp__appworld__")) {
						summary.nonMcpToolCalls.push({ name: block.name, input: JSON.stringify(block.input).slice(0, 400) });
						if (block.name === "Bash") summary.bashCommands.push(String(block.input?.command ?? "").slice(0, 400));
					}
				}
				// Claude Code emits ONE assistant event per content block, and every one of
				// them repeats the whole message's usage. Summing per event inflated the
				// first haiku run to 29 turns and 2.2M cache-read tokens against a true 8
				// and 610k — a 3.6x error that looks like a plausible number, which is the
				// only kind this project has ever shipped. run-task.mjs dedupes on
				// `responseId` for the same reason; this is that check, keyed on message id.
				const usage = message.usage;
				if (usage && message.id && !counted.has(message.id)) {
					counted.add(message.id);
					if (summary.turns === 0) {
						summary.firstTurnPromptTokens =
							(usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
					}
					summary.turns++;
					summary.input += usage.input_tokens ?? 0;
					summary.output += usage.output_tokens ?? 0;
					summary.cacheRead += usage.cache_read_input_tokens ?? 0;
					summary.cacheWrite += usage.cache_creation_input_tokens ?? 0;
				}
			} else if (event.type === "user" && event.message) {
				for (const block of event.message.content ?? []) {
					if (block.type === "tool_result" && block.is_error) {
						if (block.tool_use_id && countedResults.has(block.tool_use_id)) continue;
						if (block.tool_use_id) countedResults.add(block.tool_use_id);
						summary.toolErrors++;
						const text = Array.isArray(block.content)
							? block.content.map((c) => c.text ?? "").join(" ")
							: String(block.content ?? "");
						summary.errorMessages.push(text.slice(0, 300));
					}
				}
			} else if (event.type === "result") {
				// Claude Code's own accounting, preferred over our sum: it is what the
				// product bills and it includes turns we may not have seen usage for.
				summary.cost = event.total_cost_usd ?? summary.cost;
				/**
				 * Token totals come from here, not from summing the stream.
				 *
				 * The streamed assistant events carry a *partial* `output_tokens` — the
				 * count at the moment the block was emitted. Measured on the first haiku
				 * run: summing the stream gave **27** output tokens against a true
				 * **4,854**, a 180x undercount, while input and cache figures matched
				 * exactly. Output tokens are the headline of the representation result
				 * ("5-8x the output tokens at matched API calls"), so this is the one
				 * number that could not be allowed to be wrong.
				 */
				const usage = event.usage ?? {};
				summary.streamedTokens = { input: summary.input, output: summary.output, cacheRead: summary.cacheRead, cacheWrite: summary.cacheWrite };
				summary.input = usage.input_tokens ?? summary.input;
				summary.output = usage.output_tokens ?? summary.output;
				summary.cacheRead = usage.cache_read_input_tokens ?? summary.cacheRead;
				summary.cacheWrite = usage.cache_creation_input_tokens ?? summary.cacheWrite;
				summary.modelUsage = event.modelUsage ?? null;
				summary.claudeTurns = event.num_turns ?? null;
				summary.resultSubtype = event.subtype ?? null;
				summary.isError = event.is_error ?? null;
				// In print mode a tool that needs approval is denied silently, and a run
				// whose tools were all denied looks exactly like a weak agent.
				summary.permissionDenials = event.permission_denials ?? [];
				summary.terminalReason = event.terminal_reason ?? null;
				if (typeof event.result === "string" && event.result) summary.finalText = event.result;
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
	summary.stopReason = summary.timedOut ? "timeout" : summary.resultSubtype === "error_max_budget" ? "budget" : "completed";
	summary.maxCost = maxCost;

	// A0: did this arm ever reach the surface it is supposed to be testing? A deferred
	// registration bug once produced 78 tool calls, 0 of which reached the transport,
	// under a label that said otherwise.
	const connected = (summary.mcpServers ?? []).some((s) => s.name === "appworld" && s.status === "connected");
	if (!connected) summary.armViolation = `MCP server 'appworld' not connected: ${JSON.stringify(summary.mcpServers)}`;
	else if ((summary.mcpToolsAdvertised ?? 0) < 400)
		summary.armViolation = `only ${summary.mcpToolsAdvertised} appworld MCP tools advertised (expected 469)`;

	if (summary.firstTurnPromptTokens !== undefined && summary.firstTurnPromptTokens < 40_000) {
		// The mirror of run-task.mjs's residency guard. All 469 schemas resident is what
		// makes this arm comparable to vanilla L4; a small first turn means they were not.
		summary.residencyViolation =
			`${residency} first turn carried only ${summary.firstTurnPromptTokens} prompt tokens — ` +
			"the MCP catalogue does not appear to have been resident";
	}

	mark("snapshotStart");
	let snapshot = null;
	let evaluation = null;
	try {
		snapshot = await get(envPort, "/snapshot");
	} catch (error) {
		summary.snapshotError = String(error);
	}
	mark("snapshotEnd");
	mark("gradeStart");
	try {
		evaluation = await post(envPort, "/evaluate", {});
	} catch (error) {
		summary.evaluateError = String(error);
	}
	mark("gradeEnd");
	try {
		await post(envPort, "/phases", phases);
		await post(envPort, "/shutdown", {});
	} catch {
		// The world is going away regardless.
	}
	// Wait for the env-server to copy AppWorld's own artefacts out before killing it.
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
	if (!existsSync(join(runDir, "appworld-output", "dbs"))) summary.missingAppworldOutput = true;

	proxy.close();
	callLog.end();
	if (!has("keep-servers")) apisServer.kill("SIGKILL");

	summary.success = evaluation?.success ?? null;
	summary.passCount = evaluation?.passCount ?? null;
	summary.totalCount = evaluation?.totalCount ?? null;
	summary.difficulty = evaluation?.report?.difficulty ?? null;
	summary.committedAnswer = evaluation?.committedAnswer ?? null;
	summary.groundTruthAnswer = evaluation?.groundTruthAnswer ?? null;
	summary.changedModels = snapshot?.diff?.changedModelNames ?? null;

	// Calls read off the wire, not off the agent's account of what it did.
	let envCalls = [];
	const logPath = join(runDir, "env-calls.jsonl");
	if (existsSync(logPath)) {
		envCalls = readFileSync(logPath, "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	}
	summary.apiCalls = envCalls.length;
	summary.apiCallsOk = envCalls.filter((c) => c.ok).length;
	summary.apiCallsFailed = envCalls.filter((c) => c.execFailed).length;
	/**
	 * `distinctApis` must mean the same thing it means for the other arms: how many
	 * distinct APIs the agent used. That is the tool name, not the wire route.
	 *
	 * AppWorld's routes are parameterised — `/amazon/products/820` and
	 * `/amazon/products/821` are two paths and one API (`amazon__show_product`) — so
	 * counting off the proxy log gave **32** where the tool names give **12**, on the
	 * same run. Counting the wire would have made this arm look 2.7x more varied in its
	 * API use than an identically-behaved vanilla run, in the summary field a reader
	 * would reach for first.
	 */
	summary.distinctApis = new Set(
		summary.toolNames.filter((n) => n.startsWith("mcp__appworld__")).map((n) => n.replace("mcp__appworld__", "")),
	).size;
	summary.distinctRoutes = new Set(envCalls.map((c) => `${c.method} ${c.app}.${c.api}`)).size;
	summary.duplicateCalls = envCalls.length - new Set(envCalls.map((c) => `${c.method} ${c.url} ${JSON.stringify(c.args)}`)).size;
	// The MCP-Bench lesson, as a number rather than a hope: every call the agent made
	// that did not go through an appworld MCP tool.
	summary.bypassSuspected = summary.bashCommands.filter((c) => /curl|wget|http:\/\/|https:\/\/|requests\.|urllib/.test(c));
	summary.wallMs = phases.gradeEnd - phases.startedAt;
	summary.phases = phases;

	writeFileSync(join(runDir, "result.json"), `${JSON.stringify({ ...meta, summary }, null, 2)}\n`);

	const tally = [...new Set(summary.toolNames)].length;
	console.log(
		`${arm}/${residency} ${taskId}: ` +
			`${summary.success === true ? "PASS" : "FAIL"} ${summary.passCount}/${summary.totalCount} tests, ` +
			`${summary.turns} turns, ${summary.toolCalls} tool calls (${tally} distinct), ${summary.apiCalls} api calls ` +
			`(${summary.distinctApis} distinct, ${summary.duplicateCalls} dupes), ${summary.toolErrors} errors, ` +
			`$${summary.cost.toFixed(4)}, ${((summary.wallMs ?? 0) / 1000).toFixed(0)}s` +
			`${summary.stopReason === "completed" ? "" : ` [${summary.stopReason.toUpperCase()}]`}`,
	);
	if (summary.armViolation) console.log(`  !! ${summary.armViolation}`);
	if ((summary.permissionDenials ?? []).length > 0)
		console.log(`  !! ${summary.permissionDenials.length} permission denial(s): ${JSON.stringify(summary.permissionDenials.slice(0, 3))}`);
	if (summary.residencyViolation) console.log(`  !! ${summary.residencyViolation}`);
	if (summary.nonMcpToolCalls.length > 0) console.log(`  non-MCP tool calls: ${summary.nonMcpToolCalls.length}`);
	if (summary.bypassSuspected.length > 0) console.log(`  !! BYPASS SUSPECTED: ${JSON.stringify(summary.bypassSuspected)}`);
	console.log(`  answer: ${JSON.stringify(summary.committedAnswer)} vs gt ${JSON.stringify(summary.groundTruthAnswer)}`);
	console.log(`  -> ${runDir}`);
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	writeFileSync(
		join(runDir, "result.json"),
		`${JSON.stringify({ runId, arm, taskId, summary: { ...summary, harnessError: String(error), phases } }, null, 2)}\n`,
	);
	process.exit(1);
});
