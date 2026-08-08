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

	async callTool(name, args) {
		await this.start();
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
