/**
 * The integration tier's world: real processes, real files, a scripted model.
 *
 * A `World` is one scenario's sandbox on disk — an agent home whose models.json points
 * prime at the scripted model, an IPython dir that loads the kernel prelude, a work
 * dir, a sessions root with one session, and a private prime daemon socket — plus
 * every process the scenario starts. `cleanup()` stops all of them, even after a
 * failed assertion, and `leaks()` says what is still alive under the world's root
 * (pid + start time, so a recycled pid is never mistaken for ours).
 *
 * Nothing here is mocked: the scheduler is runtime/scheduler.py, the harness is
 * prime's built CLI, the kernel is the kernel venv's ipykernel, jobs are real
 * subprocesses. Only the model is scripted (scripted-model.mjs).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedPrimeSettings } from "../../bench/prime-settings.mjs";
import { MODEL, modelsJson, startScriptedModel } from "./scripted-model.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const RUNTIME = join(ROOT, "runtime");
export const CLI = join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/cli.js");
export const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "scripts");
export const PYTHON = process.env.HARNESS_ITEST_PYTHON ?? "python3";

/** The kernel interpreter, resolved the way prime resolves it (core/kernel/bootstrap.ts). */
export function kernelPython() {
	if (process.env.PRIME_AGENT_KERNEL_PYTHON) return process.env.PRIME_AGENT_KERNEL_PYTHON;
	const venv = process.env.PRIME_AGENT_KERNEL_VENV ?? join(homedir(), ".prime/agent/kernel-venv");
	return join(venv, "bin/python");
}

/** Model API keys a live World forwards from the env file (never written to disk). */
export const LIVE_PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "ZAI_API_KEY"];

export const SYSTEM_PROMPT = "You are a scripted test agent working in a Python (IPython) kernel via the `ipython` tool.";

/** What is missing for the integration tier to run, or [] when it can. */
export function missingPrereqs() {
	const missing = [];
	if (!existsSync(CLI)) missing.push(`prime is not built (${CLI}); run scripts/dev-env.sh`);
	if (!existsSync(kernelPython())) missing.push(`no kernel venv at ${kernelPython()}; run scripts/dev-env.sh`);
	return missing;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, { timeoutMs = 60_000, everyMs = 200, what = "condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
		await sleep(everyMs);
	}
}

export function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** Run Python with runtime/ importable; returns parsed JSON from its last stdout line (or null). */
export function py(code, { env } = {}) {
	const r = spawnSync(PYTHON, ["-c", `import sys, json\nsys.path.insert(0, ${JSON.stringify(RUNTIME)})\n${code}`], {
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: 30_000,
	});
	if (r.status !== 0) throw new Error(`python failed (${r.status}): ${r.stderr.slice(-1500)}`);
	const last = r.stdout.trim().split("\n").at(-1);
	try {
		return JSON.parse(last);
	} catch {
		return last;
	}
}

// -- processes ---------------------------------------------------------------------------

/** {pid: lstart} for live processes; lstart is the start identity (a recycled pid differs). */
export function startTimes(pids) {
	if (!pids.length) return {};
	const r = spawnSync("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], { encoding: "utf8" });
	const out = {};
	for (const line of (r.stdout ?? "").split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(.+)$/);
		if (m) out[Number(m[1])] = m[2].trim();
	}
	return out;
}

/** Is the process this {pid, start} names still the one we recorded? */
export function identityAlive(ident) {
	if (!ident?.pid) return false;
	const now = startTimes([ident.pid])[ident.pid];
	return Boolean(now) && (!ident.start || now === ident.start);
}

export function identify(pid) {
	return { pid, start: startTimes([pid])[pid] };
}

function lsofPids(args) {
	const r = spawnSync("lsof", ["-w", ...args, "-Fpn"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	const out = [];
	let pid;
	for (const line of (r.stdout ?? "").split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n")) out.push({ pid, name: line.slice(1) });
	}
	return out;
}

/**
 * Every live process that belongs to a directory: its command line names it, its cwd
 * is under it, or it holds a unix socket under it (prime's daemon renames its process
 * title, so the socket is the only thing that still names it).
 */
export function processesUnder(dirs) {
	const roots = [...new Set([dirs].flat().flatMap((d) => [d, safeRealpath(d)]))];
	const hit = (s) => roots.some((r) => s.includes(r));
	const pids = new Set();
	const ps = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	for (const line of (ps.stdout ?? "").split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(.*)$/);
		if (m && Number(m[1]) !== process.pid && hit(m[2])) pids.add(Number(m[1]));
	}
	for (const { pid, name } of [...lsofPids(["-d", "cwd"]), ...lsofPids(["-U"])]) {
		if (pid && pid !== process.pid && name && hit(name)) pids.add(pid);
	}
	const times = startTimes([...pids]);
	return [...pids].filter((p) => times[p]).map((pid) => ({ pid, start: times[pid], command: commandOf(pid) }));
}

export function commandOf(pid) {
	const r = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
	return (r.stdout ?? "").trim();
}

function safeRealpath(p) {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** SIGTERM, a grace, then SIGKILL — each only if the pid is still the process we named. */
export async function stopProcesses(idents, { graceMs = 3000 } = {}) {
	const live = idents.filter(identityAlive);
	for (const p of live) {
		try {
			process.kill(p.pid, "SIGTERM");
		} catch {}
	}
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline && live.some(identityAlive)) await sleep(100);
	for (const p of live.filter(identityAlive)) {
		try {
			process.kill(p.pid, "SIGKILL");
		} catch {}
	}
	await until(() => !live.some(identityAlive), { timeoutMs: 5000, what: "processes to die" }).catch(() => {});
}

/** Every ipykernel whose connection file or cwd lives under `dirs`. */
export function kernelsUnder(dirs) {
	return processesUnder(dirs).filter((p) => /ipykernel/.test(p.command));
}

// -- a tool proxy ------------------------------------------------------------------------

/**
 * A stand-in for the MCP tool proxy a kernel calls (HARNESS_MCP_PROXY): POST
 * {server, tool, args} -> {ok, text}. Every request is recorded on arrival; a tool
 * named in `hold` is never answered (the kernel is killed while it waits).
 */
export async function startToolProxy({ hold = [] } = {}) {
	const { createServer } = await import("node:http");
	const calls = [];
	const held = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => {
			body += d;
		});
		req.on("end", () => {
			let payload = {};
			try {
				payload = JSON.parse(body);
			} catch {}
			calls.push({ at: Date.now(), tool: payload.tool, server: payload.server, args: payload.args });
			if (hold.includes(payload.tool)) {
				held.push(res);
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, text: `${payload.tool}-result` }));
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return {
		url: `http://127.0.0.1:${server.address().port}/`,
		calls,
		count: (tool) => calls.filter((c) => c.tool === tool).length,
		close: () =>
			new Promise((r) => {
				for (const res of held) res.destroy();
				server.closeAllConnections?.();
				server.close(() => r());
			}),
	};
}

// -- the world --------------------------------------------------------------------------

export class World {
	/**
	 * @param label  scenario name (the temp dir prefix)
	 * @param opts.script   the scripted model's turns (a path or {turns})
	 * @param opts.vars     extra {{VARS}} for the script
	 * @param opts.env      extra env for every prime/scheduler process
	 * @param opts.session  extra session.json fields (deadline, ...)
	 */
	static async create(label, opts = {}) {
		const w = new World(label);
		await w.init(opts);
		return w;
	}

	constructor(label) {
		this.label = label;
		// Short and under /tmp: prime's daemon socket must fit in sun_path (104 bytes).
		const base = process.env.HARNESS_ITEST_BASE ?? "/tmp";
		mkdirSync(base, { recursive: true });
		const prefix = base === "/tmp" ? "hit-" : "";
		this.root = realpathSync(mkdtempSync(join(base, `${prefix}${label.slice(0, 12)}-`)));
		// TMPDIR is its own short directory: prime's daemon puts each session worker's unix
		// socket under it, and sun_path is 104 bytes on macOS (a deeper TMPDIR made every
		// worker fail to listen, EINVAL, and every turn time out).
		this.tmp = realpathSync(mkdtempSync(join(base, `${prefix}t-`)));
		this.roots = [this.root, this.tmp];
		this.started = [];
		this.schedulers = [];
		this.notes = [];
		this.cleanups = [];
	}

	/**
	 * @param opts.liveModel  a real model id ("anthropic/claude-haiku-4-5"): no scripted
	 *   model; the provider keys come from this process's env (the live tier's env file).
	 */
	async init({ script, vars = {}, env = {}, session = {}, delivery, liveModel } = {}) {
		const r = this.root;
		this.work = join(r, "work");
		this.sessions = join(r, "sessions");
		this.session = join(this.sessions, "s");
		this.jobs = join(this.session, "jobs");
		this.socket = join(r, "d.sock");
		for (const d of [this.work, this.session]) mkdirSync(d, { recursive: true });
		const startup = join(r, "ipython/profile_default/startup");
		mkdirSync(startup, { recursive: true });
		writeFileSync(
			join(startup, "00-jobs.py"),
			`import runpy\nrunpy.run_path(${JSON.stringify(join(RUNTIME, "kernel-prelude.py"))}, run_name="__prelude__")\n`,
		);
		this.vars = { ROOT: r, WORK: this.work, JOBS: this.jobs, SESSION: this.session, RUNTIME, ...vars };
		const home = seedPrimeSettings(join(r, "agent-home"));
		let providerKeys = {};
		if (liveModel) {
			this.model = null;
			this.modelId = liveModel;
			this.systemPrompt = `${SYSTEM_PROMPT}\n\n${spawnSync(PYTHON, [join(RUNTIME, "jobs.py"), "--prompt"], { encoding: "utf8" }).stdout}`;
			for (const k of LIVE_PROVIDER_KEYS) if (process.env[k]) providerKeys[k] = process.env[k];
			// The keys are the loop's; the kernel gets the harness's allow-listed env only.
			const { KERNEL_ENV_ALLOW } = await import("../posture.mjs");
			providerKeys.HARNESS_KERNEL_ENV_ALLOW = KERNEL_ENV_ALLOW;
		} else {
			this.model = await startScriptedModel({ script, vars: this.vars, dir: join(r, "model") });
			writeFileSync(join(home, "models.json"), JSON.stringify(modelsJson(this.model.baseUrl), null, 2));
		}
		this.env = {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			TMPDIR: this.tmp,
			DO_NOT_TRACK: "1",
			PRIME_AGENT_TELEMETRY: "0",
			PRIME_AGENT_CODING_AGENT_DIR: home,
			PRIME_AGENT_KERNEL_PYTHON: kernelPython(),
			IPYTHONDIR: join(r, "ipython"),
			HARNESS_RUNTIME_DIR: RUNTIME,
			HARNESS_JOB_CWD: this.work,
			HARNESS_KERNEL_SANDBOX: "off",
			HARNESS_KERNEL_AUTORESTART: "1",
			HARNESS_MIN_WAIT_SECONDS: "1",
			HARNESS_WAIT_TOKEN: randomBytes(8).toString("hex"),
			HARNESS_ITEST_ROOT: r,
			...providerKeys,
			// The turn's agent goes with the prime client the scheduler supervises
			// (scripts/neutralize-prime.mjs, "client-owned worker lifetime").
			HARNESS_OWNED_WORKER_GRACE_MS: "0",
			...(delivery ? { HARNESS_TOOL_DELIVERY: this.writeFile("tool-delivery.json", JSON.stringify(delivery)) } : {}),
			...env,
		};
		this.writeSession(session);
	}

	writeFile(name, content) {
		const path = join(this.root, name);
		writeFileSync(path, content);
		return path;
	}

	/** The argv the scheduler appends a wake message to: a print-mode `prime -c` on a private daemon. */
	primeArgv() {
		return [
			process.execPath,
			CLI,
			"-c",
			"-p",
			"--mode",
			"json",
			"--daemon-socket",
			this.socket,
			"--model",
			this.modelId ?? MODEL,
			"--tools",
			"ipython",
			"--cwd",
			this.work,
			"--no-context-files",
			"--no-prompt-templates",
			"--no-extensions",
			"--system-prompt",
			this.systemPrompt ?? SYSTEM_PROMPT,
		];
	}

	writeSession(extra = {}) {
		writeFileSync(
			join(this.session, "session.json"),
			JSON.stringify(
				{
					argv: this.primeArgv(),
					cwd: this.work,
					env: {
						HARNESS_JOB_DIR: this.jobs,
						HARNESS_WAIT_MODE: "exit",
						HARNESS_WAKE_FILE: join(this.session, "wake.json"),
						HARNESS_OWNED_WORKER_GRACE_MS: "0",
					},
					...extra,
				},
				null,
				2,
			),
		);
	}

	/** Queue a user message the way a host does (scheduler.post_user_message). */
	post(text, sender = "user") {
		return py(`import scheduler\nprint(json.dumps(scheduler.post_user_message(${JSON.stringify(this.session)}, ${JSON.stringify(text)}, ${JSON.stringify(sender)})))`);
	}

	/** Start `scheduler.py <sessions> --interval` (serve mode) in its own process group. */
	startScheduler({ interval = 0.5, label = `sched${this.schedulers.length + 1}` } = {}) {
		const proc = spawn(PYTHON, ["-u", join(RUNTIME, "scheduler.py"), this.sessions, "--interval", String(interval)], {
			cwd: RUNTIME,
			env: this.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const s = { label, proc, out: "", ident: null, exited: null };
		s.ident = identify(proc.pid);
		proc.stdout.on("data", (d) => {
			s.out += d;
		});
		proc.stderr.on("data", (d) => {
			s.out += d;
		});
		proc.on("exit", (code, signal) => {
			s.exited = { code, signal };
		});
		this.schedulers.push(s);
		this.started.push(s.ident);
		return s;
	}

	/** Scheduler log lines (the `[scheduler] ...` ones) across every scheduler this world ran. */
	schedulerLog() {
		return this.schedulers.flatMap((s) => s.out.split("\n").filter((l) => l.startsWith("[scheduler]")));
	}

	wakes() {
		return this.schedulerLog().filter((l) => l.includes("[scheduler] waking"));
	}

	/** Every prime event (JSON line) the harness printed under the schedulers. */
	primeEvents() {
		return this.schedulers.flatMap((s) =>
			s.out
				.split("\n")
				.filter((l) => l.startsWith("{"))
				.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return null;
					}
				})
				.filter(Boolean),
		);
	}

	turn() {
		return readJson(join(this.session, "turn.json"));
	}

	lastTurn() {
		return readJson(join(this.session, "turn.json.last"));
	}

	invocations() {
		const dir = join(this.jobs, "invocations");
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((n) => n.endsWith(".json"))
			.map((n) => readJson(join(dir, n)))
			.filter(Boolean);
	}

	inbox() {
		const dir = join(this.session, "inbox");
		return existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".")).sort() : [];
	}

	/** Model requests whose input contains `text` anywhere. */
	requestsContaining(text) {
		return this.model.requests.filter((r) => JSON.stringify(r.messages).includes(text));
	}

	/** How many times `text` occurs across the messages of one request (duplicates show here). */
	static occurrences(request, text) {
		return request.messages.filter((m) => JSON.stringify(m.content ?? "").includes(text)).length;
	}

	/** Prime client processes (`cli.js ... --daemon-socket <ours>`) alive now. */
	primeClients() {
		return processesUnder(this.roots).filter((p) => p.command.includes("cli.js") && p.command.includes(this.socket));
	}

	/** pid identities the daemon owns (holds our socket). */
	daemons() {
		return lsofPids(["-U"])
			.filter((e) => e.name?.includes(this.socket))
			.map((e) => e.pid)
			.filter((v, i, a) => a.indexOf(v) === i)
			.map(identify);
	}

	/** Job records' pids, as identities (start time from the OS now — only while alive). */
	jobProcesses() {
		if (!existsSync(this.jobs)) return [];
		return readdirSync(this.jobs)
			.filter((n) => n.endsWith(".json"))
			.map((n) => readJson(join(this.jobs, n)))
			.filter((r) => r?.pid)
			.map((r) => identify(r.pid))
			.filter((i) => i.start);
	}

	async stopSchedulers() {
		for (const s of this.schedulers) {
			if (s.exited) continue;
			try {
				process.kill(-s.proc.pid, "SIGTERM");
			} catch {}
		}
		await until(() => this.schedulers.every((s) => s.exited), { timeoutMs: 8000, what: "schedulers to exit" }).catch(
			() => {
				for (const s of this.schedulers) {
					try {
						process.kill(-s.proc.pid, "SIGKILL");
					} catch {}
				}
			},
		);
	}

	/** Stop everything this world started, in dependency order. Never throws. */
	async cleanup() {
		try {
			await this.stopSchedulers();
			const clients = this.primeClients();
			await stopProcesses(clients);
			await stopProcesses([...this.daemons(), ...this.jobProcesses()]);
			await stopProcesses(processesUnder(this.roots));
			for (const fn of this.cleanups) await fn();
			await this.model?.close();
		} catch (e) {
			this.notes.push(`cleanup: ${e.message}`);
		}
	}

	/** Remove the world's directory unless HARNESS_ITEST_KEEP=1 (or the scenario failed and keep is asked). */
	dispose({ failed = false } = {}) {
		if (process.env.HARNESS_ITEST_KEEP === "1" || (failed && process.env.HARNESS_ITEST_KEEP_FAILED !== "0")) {
			this.dump();
			return this.root;
		}
		for (const d of this.roots) rmSync(d, { recursive: true, force: true });
		return null;
	}

	/** Write the in-memory evidence (scheduler output) next to the on-disk state. */
	dump() {
		try {
			writeFileSync(join(this.root, "scheduler.log"), this.schedulers.map((s) => `## ${s.label}\n${s.out}`).join("\n"));
		} catch {}
	}
}

/**
 * Run `body(world)` in a fresh World; always cleans up, asserts no process outlives the
 * scenario, and keeps the directory (printing it) when the scenario failed.
 */
export async function scenario(label, opts, body) {
	const w = await World.create(label, opts);
	let failed = true;
	try {
		await body(w);
		failed = false;
	} finally {
		await w.cleanup();
		const leaked = processesUnder(w.roots);
		const kept = w.dispose({ failed: failed || leaked.length > 0 });
		if (kept) console.log(`[itest] ${label}: kept ${kept}`);
		if (!failed && leaked.length) {
			throw new Error(`${label}: processes outlived cleanup: ${leaked.map((p) => `${p.pid} ${p.command.slice(0, 120)}`).join("; ")}`);
		}
	}
}

export { execFileSync };

/**
 * One print-mode prime run to exit (no scheduler): `prime -p --mode json <message>`
 * with this world's model and daemon. Resolves {code, events, stderr}.
 */
export function runPrime(w, { env, cwd, message, timeoutMs = 120_000 }) {
	const argv = w.primeArgv().filter((a) => a !== "-c");
	argv[argv.indexOf("--cwd") + 1] = cwd;
	return new Promise((resolve) => {
		const child = spawn(argv[0], [...argv.slice(1), message], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		w.started.push(identify(child.pid));
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			err += d;
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			const events = out
				.split("\n")
				.filter((l) => l.startsWith("{"))
				.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return null;
					}
				})
				.filter(Boolean);
			resolve({ code, events, stderr: err });
		});
	});
}
