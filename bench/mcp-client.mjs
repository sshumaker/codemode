/**
 * Minimal MCP stdio client.
 *
 * Speaks JSON-RPC over a child process's stdin/stdout. Connections are held
 * open so a task's repeated tool calls reuse one server process rather than
 * paying startup each time — several of MCP-Bench's servers take 10-30s to boot.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = join(ROOT, "vendor/mcp-bench");
const SERVERS = join(BENCH, "mcp_servers");
const VENV_PY = join(BENCH, ".venv/bin/python");

/**
 * Tools that must not be called concurrently, from MCP-Bench's own
 * benchmark_config.yaml (`sequential_only_tools`).
 */
export const SEQUENTIAL_ONLY = new Set([
	"Google Maps:search_nearby",
	"Google Maps:get_place_details",
	"Google Maps:maps_geocode",
	"Google Maps:maps_reverse_geocode",
]);

/**
 * Servers with free-tier rate limits that trip under parallel runs.
 *
 * Observed at concurrency 12: DEX Paprika returned "Rate limit exceeded" as a
 * *successful* MCP response, so the agent saw an error that had nothing to do
 * with its own behaviour — and whichever arm happened to run when the limit
 * tripped absorbed the penalty. Calls to these servers are spaced out and
 * retried rather than handed to the model.
 */
export const RATE_LIMITED = new Map([["DEX Paprika", 1100]]);
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|429/i;
const MAX_RATE_LIMIT_RETRIES = 4;

export const START_TIMEOUT_MS = 60_000;
export const CALL_TIMEOUT_MS = 120_000;

let commandsCache;
export function loadCommands() {
	return (commandsCache ??= JSON.parse(readFileSync(join(SERVERS, "commands.json"), "utf8")));
}

/** Resolve a commands.json entry into argv + cwd, pointing python at the venv. */
export function resolveLaunch(spec) {
	const cwd = resolve(SERVERS, spec.cwd.replace(/^\.\.\//, ""));
	let cmd = spec.cmd;
	if (/^python\b/.test(cmd) && existsSync(VENV_PY)) cmd = cmd.replace(/^python\b/, VENV_PY);
	const parts = cmd.split(/\s+/);
	return { command: parts[0], argv: parts.slice(1), cwd };
}

/**
 * A live connection to one MCP server.
 *
 * Requests are correlated by id; a pending map resolves them as replies stream
 * in, since JSON-RPC responses may arrive out of order.
 */
export class McpServer {
	constructor(name, spec) {
		this.name = name;
		this.spec = spec;
		this.nextId = 1;
		this.pending = new Map();
		this.buffer = "";
		this.stderr = "";
		this.tools = [];
		this.state = "stopped";
	}

	async start() {
		if (this.state === "ready") return;
		if (this.startPromise) return this.startPromise;
		this.startPromise = this._start();
		return this.startPromise;
	}

	async _start() {
		const { command, argv, cwd } = resolveLaunch(this.spec);
		if (!existsSync(cwd)) throw new Error(`${this.name}: missing dir ${cwd}`);

		this.state = "starting";
		const env = { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` };
		this.child = spawn(command, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

		this.child.stderr.on("data", (d) => {
			this.stderr = (this.stderr + d).slice(-4000);
		});
		this.child.on("exit", (code) => {
			this.state = "exited";
			for (const [, p] of this.pending) p.reject(new Error(`${this.name} exited (${code})`));
			this.pending.clear();
		});
		this.child.stdout.on("data", (chunk) => this._onData(chunk));

		await this._request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "harness", version: "1.0.0" },
		});
		this._notify("notifications/initialized");
		const listed = await this._request("tools/list", {});
		this.tools = listed?.tools ?? [];
		this.state = "ready";
	}

	_onData(chunk) {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim().startsWith("{")) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			const p = this.pending.get(msg.id);
			if (!p) continue;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new Error(msg.error.message ?? "mcp error"));
			else p.resolve(msg.result);
		}
	}

	_notify(method, params = {}) {
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	_request(method, params, timeoutMs = START_TIMEOUT_MS) {
		const id = this.nextId++;
		return new Promise((res, rej) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				rej(new Error(`${this.name}.${method} timed out after ${timeoutMs / 1000}s`));
			}, timeoutMs);
			this.pending.set(id, { resolve: res, reject: rej, timer });
			try {
				this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				rej(err);
			}
		});
	}

	/** Space calls to a rate-limited server, serialized across concurrent runs. */
	async _throttle() {
		const interval = RATE_LIMITED.get(this.name);
		if (!interval) return;
		const prior = this.throttleChain ?? Promise.resolve();
		let release;
		this.throttleChain = new Promise((r) => (release = r));
		await prior;
		const wait = interval - (Date.now() - (this.lastCallAt ?? 0));
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		this.lastCallAt = Date.now();
		setTimeout(release, 0);
	}

	async callTool(name, args) {
		await this.start();

		if (RATE_LIMITED.has(this.name)) {
			// Retry a rate-limited reply rather than letting it reach the model as a
			// tool result; the agent has no way to act on it and it corrupts scoring.
			for (let attempt = 0; ; attempt++) {
				await this._throttle();
				const result = await this._request("tools/call", { name, arguments: args ?? {} }, CALL_TIMEOUT_MS);
				const text = (result?.content ?? []).map((c) => c.text ?? "").join(" ");
				if (!RATE_LIMIT_PATTERN.test(text) || attempt >= MAX_RATE_LIMIT_RETRIES) return result;
				await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
			}
		}
		// A few servers cannot take concurrent calls (MCP-Bench lists them under
		// `sequential_only_tools`). Chain those onto a per-server queue so parallel
		// runs do not produce server-side errors that look like agent mistakes.
		if (SEQUENTIAL_ONLY.has(`${this.name}:${name}`)) {
			const prior = this.queue ?? Promise.resolve();
			this.queue = prior
				.catch(() => {})
				.then(() => this._request("tools/call", { name, arguments: args ?? {} }, CALL_TIMEOUT_MS));
			return this.queue;
		}
		return this._request("tools/call", { name, arguments: args ?? {} }, CALL_TIMEOUT_MS);
	}

	stop() {
		try {
			this.child?.kill("SIGKILL");
		} catch {
			/* already gone */
		}
		this.state = "stopped";
	}
}

/** Lazily-started pool of MCP servers, keyed by their MCP-Bench display name. */
export class ServerPool {
	constructor() {
		this.commands = loadCommands();
		this.servers = new Map();
	}

	get(name) {
		if (!this.servers.has(name)) {
			const spec = this.commands[name];
			if (!spec) throw new Error(`unknown MCP server: ${name}`);
			this.servers.set(name, new McpServer(name, spec));
		}
		return this.servers.get(name);
	}

	async call(serverName, toolName, args) {
		return this.get(serverName).callTool(toolName, args);
	}

	stopAll() {
		for (const s of this.servers.values()) s.stop();
		this.servers.clear();
	}
}
