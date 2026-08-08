#!/usr/bin/env node
/**
 * MCP proxy — one process holding the server pool, shared by both arms.
 *
 *   node bench/mcp-proxy.mjs [--port 8765] [--log run.jsonl]
 *
 * Both arms reach MCP the same way, through this one HTTP endpoint: the vanilla
 * arm's registered tools POST here from their `execute`, and the codemode arm's
 * generated `api/` modules POST here from `_client.call`. That is deliberate —
 * it holds the transport constant so the arms differ only in how the model is
 * shown the tools, and it puts every tool call in the experiment through a
 * single point that can log it.
 *
 * Endpoints:
 *   GET  /health              pool status per server
 *   GET  /tools               the discovered catalogue
 *   POST /call                {server, tool, args} -> {ok, result|error, ms}
 *   POST /mark                {event, ...} — arms annotate the log (task start etc.)
 */
import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerPool } from "./mcp-client.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};

const PORT = Number(flag("port", 8765));
const LOG = flag("log", join(ROOT, ".run/mcp-calls.jsonl"));
mkdirSync(dirname(LOG), { recursive: true });

const pool = new ServerPool();
let seq = 0;

/** Every call is logged. This is the experiment's ground truth for tool usage. */
function log(record) {
	appendFileSync(LOG, `${JSON.stringify({ seq: seq++, at: new Date().toISOString(), ...record })}\n`);
}

const readBody = (req) =>
	new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
			if (body.length > 8e6) reject(new Error("body too large"));
		});
		req.on("end", () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch (err) {
				reject(err);
			}
		});
	});

const send = (res, code, payload) => {
	const body = JSON.stringify(payload);
	res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
	res.end(body);
};

/** Flatten an MCP tool result into text, mirroring what an agent would see. */
function resultText(result) {
	if (!result) return "";
	const content = result.content ?? [];
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

const server = createServer(async (req, res) => {
	try {
		if (req.method === "GET" && req.url === "/health") {
			const servers = [...pool.servers.entries()].map(([name, s]) => ({
				name,
				state: s.state,
				tools: s.tools.length,
			}));
			return send(res, 200, { ok: true, pid: process.pid, log: LOG, servers });
		}

		if (req.method === "GET" && req.url === "/tools") {
			const servers = [...pool.servers.values()].map((s) => ({ server: s.name, tools: s.tools }));
			return send(res, 200, { servers });
		}

		if (req.method === "POST" && req.url === "/mark") {
			const body = await readBody(req);
			log({ kind: "mark", ...body });
			return send(res, 200, { ok: true });
		}

		if (req.method === "POST" && req.url === "/call") {
			const { server: serverName, tool, args: toolArgs, meta } = await readBody(req);
			if (!serverName || !tool) return send(res, 400, { ok: false, error: "server and tool are required" });

			const started = Date.now();
			try {
				const result = await pool.call(serverName, tool, toolArgs);
				const text = resultText(result);
				const ms = Date.now() - started;
				log({
					kind: "call",
					server: serverName,
					tool,
					args: toolArgs,
					ok: true,
					ms,
					resultChars: text.length,
					// Truncated: full payloads would dominate the log, and the arms
					// already record what actually reached the model.
					resultPreview: text.slice(0, 400),
					meta,
				});
				return send(res, 200, { ok: true, result, text, ms });
			} catch (err) {
				const ms = Date.now() - started;
				const detail = pool.servers.get(serverName)?.stderr?.slice(-300) ?? "";
				log({ kind: "call", server: serverName, tool, args: toolArgs, ok: false, ms, error: err.message, meta });
				return send(res, 200, { ok: false, error: err.message, stderr: detail, ms });
			}
		}

		send(res, 404, { ok: false, error: "not found" });
	} catch (err) {
		send(res, 500, { ok: false, error: err.message });
	}
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`mcp-proxy listening on http://127.0.0.1:${PORT}`);
	console.log(`logging calls to ${LOG}`);
});

const shutdown = () => {
	pool.stopAll();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 2000);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
