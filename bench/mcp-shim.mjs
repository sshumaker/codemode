#!/usr/bin/env node
/**
 * A single stdio MCP server exposing one task's whole catalogue.
 *
 *   HARNESS_MCP_SERVERS="Wikipedia,Paper Search" HARNESS_RUN_ID=... bench/mcp-shim.mjs
 *
 * Exists so a third-party harness — Claude Code — can be measured on exactly the
 * same footing as our two arms. It advertises the same tools under the same wire
 * names, forwards every call to the same proxy, and therefore lands in the same
 * `mcp-calls.jsonl`. The judge then sees an identical trajectory format and
 * cannot tell which harness produced it.
 *
 * Speaking MCP directly (rather than pointing Claude Code at the 27 upstream
 * servers) also keeps the comparison honest in a subtler way: Claude Code gets
 * one server with N tools, exactly as the vanilla arm does, rather than 27
 * connections whose startup cost and failure modes we would not be measuring.
 */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./generate.mjs";
import { loadCatalogue } from "./catalogue.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "bench/data/mcp-schemas.json");
const PROXY = process.env.HARNESS_MCP_PROXY ?? "http://127.0.0.1:8765";
const RUN_ID = process.env.HARNESS_RUN_ID ?? "";
const SERVERS = (process.env.HARNESS_MCP_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const catalogue = loadCatalogue(SCHEMAS);
const selected = SERVERS.length > 0 ? catalogue.filter((s) => SERVERS.includes(s.server)) : catalogue;
const { toolDefs } = generate(selected);

/** Wire name -> real (server, tool), so the proxy sees the same identifiers. */
const index = new Map(toolDefs.map((d) => [d.name, d._mcp]));

const tools = toolDefs.map((d) => ({
	name: d.name,
	description: d.description,
	inputSchema: d.input_schema ?? { type: "object", properties: {} },
}));

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32603, message } });

async function callTool(name, args) {
	const target = index.get(name);
	if (!target) throw new Error(`unknown tool: ${name}`);
	const response = await fetch(`${PROXY}/call`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			server: target.server,
			tool: target.tool,
			args: args ?? {},
			meta: { arm: "claude-code", runId: RUN_ID },
		}),
	});
	const body = await response.json();
	if (!body.ok) throw new Error(body.error ?? "MCP call failed");
	return body.text ?? "";
}

createInterface({ input: process.stdin }).on("line", async (line) => {
	if (!line.trim().startsWith("{")) return;
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}

	if (msg.method === "initialize") {
		return reply(msg.id, {
			protocolVersion: "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: { name: "harness-shim", version: "1.0.0" },
		});
	}
	if (msg.method === "tools/list") return reply(msg.id, { tools });
	if (msg.method === "tools/call") {
		try {
			const text = await callTool(msg.params?.name, msg.params?.arguments);
			return reply(msg.id, { content: [{ type: "text", text }] });
		} catch (err) {
			// Surfaced as a tool error, matching how the other arms see failures.
			return reply(msg.id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
		}
	}
	// Notifications carry no id and need no response.
	if (msg.id !== undefined) fail(msg.id, `unsupported method: ${msg.method}`);
});
