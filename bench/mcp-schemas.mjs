#!/usr/bin/env node
/**
 * Extract real tool schemas from MCP-Bench's 28 servers.
 *
 *   node bench/mcp-schemas.mjs           # dump to bench/data/mcp-schemas.json
 *   node bench/mcp-schemas.mjs --probe   # report which servers start, no write
 *   node bench/mcp-schemas.mjs --server "Math MCP"
 *
 * Each server is a local process speaking JSON-RPC over stdio. We run the
 * standard handshake — initialize, notifications/initialized, tools/list — then
 * kill it. Nothing is executed beyond tool discovery, so no server-side side
 * effects and no API keys are needed for listing (only for calling).
 *
 * The output replaces the synthetic catalogue in the residency measurements:
 * real descriptions, real schemas, real token costs.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = join(ROOT, "vendor/mcp-bench");
const SERVERS = join(BENCH, "mcp_servers");
const VENV_PY = join(BENCH, ".venv/bin/python");
const OUT = join(ROOT, "bench/data/mcp-schemas.json");

const STARTUP_MS = 45_000;

const args = process.argv.slice(2);
const probeOnly = args.includes("--probe");
const onlyServer = args.includes("--server") ? args[args.indexOf("--server") + 1] : null;

if (!existsSync(SERVERS)) {
	console.error("vendor/mcp-bench missing — run: scripts/setup-mcp-bench.sh");
	process.exit(2);
}

const commands = JSON.parse(readFileSync(join(SERVERS, "commands.json"), "utf8"));

/**
 * Resolve a launch spec into argv + cwd.
 *
 * commands.json cwd values look like "../math-mcp", relative to a server
 * directory, so they resolve against mcp_servers/. Bare `python` must become
 * the venv interpreter — the system one has none of the dependencies.
 */
function resolveLaunch(spec) {
	const cwd = resolve(SERVERS, spec.cwd.replace(/^\.\.\//, ""));
	let cmd = spec.cmd;
	if (/^python\b/.test(cmd) && existsSync(VENV_PY)) {
		cmd = cmd.replace(/^python\b/, VENV_PY);
	}
	const parts = cmd.split(/\s+/);
	return { command: parts[0], argv: parts.slice(1), cwd };
}

/** Run the MCP stdio handshake and return the server's tool list. */
function listTools(name, spec) {
	return new Promise((resolvePromise) => {
		const { command, argv, cwd } = resolveLaunch(spec);
		if (!existsSync(cwd)) {
			return resolvePromise({ name, ok: false, error: `missing dir: ${cwd}` });
		}

		const env = { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` };
		const child = spawn(command, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

		let buffer = "";
		let stderr = "";
		let settled = false;

		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			resolvePromise(result);
		};

		const timer = setTimeout(
			() => finish({ name, ok: false, error: `timeout after ${STARTUP_MS / 1000}s`, stderr: stderr.slice(-200) }),
			STARTUP_MS,
		);

		const send = (msg) => {
			try {
				child.stdin.write(`${JSON.stringify(msg)}\n`);
			} catch {
				/* server already gone; the timeout or exit handler reports it */
			}
		};

		child.on("error", (err) => finish({ name, ok: false, error: err.message }));
		child.on("exit", (code) =>
			finish({ name, ok: false, error: `exited ${code} before tools/list`, stderr: stderr.slice(-300) }),
		);
		child.stderr.on("data", (d) => (stderr += d));

		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim().startsWith("{")) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (msg.id === 1 && msg.result) {
					// Handshake accepted; announce readiness, then ask for tools.
					send({ jsonrpc: "2.0", method: "notifications/initialized" });
					send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
				} else if (msg.id === 2) {
					if (msg.error) return finish({ name, ok: false, error: `tools/list: ${msg.error.message}` });
					finish({ name, ok: true, tools: msg.result?.tools ?? [] });
				}
			}
		});

		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "harness-schema-dump", version: "1.0.0" },
			},
		});
	});
}

const entries = Object.entries(commands).filter(([name]) => !onlyServer || name === onlyServer);
console.log(`probing ${entries.length} servers\n`);

const results = [];
// Sequential: several servers bind fixed ports, and concurrent starts collide.
for (const [name, spec] of entries) {
	const result = await listTools(name, spec);
	results.push(result);
	const status = result.ok ? `${String(result.tools.length).padStart(3)} tools` : `  FAIL  ${result.error}`;
	console.log(`  ${status}  ${name}`);
}

const ok = results.filter((r) => r.ok);
const totalTools = ok.reduce((n, r) => n + r.tools.length, 0);
console.log(`\n${ok.length}/${results.length} servers up, ${totalTools} tools discovered`);

if (!probeOnly && ok.length > 0) {
	mkdirSync(dirname(OUT), { recursive: true });
	const catalogue = ok.map((r) => ({ server: r.server ?? r.name, tools: r.tools }));
	writeFileSync(OUT, `${JSON.stringify({ generatedFrom: "Accenture/mcp-bench", catalogue }, null, 2)}\n`);
	console.log(`wrote ${OUT}`);
}

if (results.some((r) => !r.ok)) {
	console.log("\nfailures:");
	for (const r of results.filter((x) => !x.ok)) {
		console.log(`  ${r.name}: ${r.error}${r.stderr ? `\n    ${r.stderr.split("\n").slice(-2).join(" ")}` : ""}`);
	}
}
