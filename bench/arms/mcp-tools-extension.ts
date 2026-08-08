/**
 * vanilla arm: expose the MCP catalogue as native tool definitions.
 *
 * Two residency modes, selected by HARNESS_RESIDENCY:
 *
 *   L4  every tool registered individually. All ~250 JSON Schemas sit in the
 *       model's context on every request — the naive baseline, ~48k tokens.
 *
 *   L1  three meta-tools instead: search_tools, describe_tool, call_tool. Only
 *       names are cheap to surface and schemas are fetched on demand. This is
 *       what a modern harness actually ships (Claude Code's own Task tools are
 *       deferred behind ToolSearch), so L4 alone would be a strawman.
 *
 * Which servers are exposed comes from HARNESS_MCP_SERVERS, reproducing
 * MCP-Bench's setup: the task's real servers plus its declared distractors.
 *
 * Execution goes through the shared proxy rather than a direct MCP connection,
 * so both arms use the identical transport and every call lands in one log.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CATALOGUE = process.env.HARNESS_MCP_CATALOGUE ?? "";
const PROXY = process.env.HARNESS_MCP_PROXY ?? "http://127.0.0.1:8765";
const SERVERS = (process.env.HARNESS_MCP_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const RUN_ID = process.env.HARNESS_RUN_ID ?? "";
const RESIDENCY = process.env.HARNESS_RESIDENCY ?? "L4";

interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}
interface Server {
	server: string;
	tools: McpTool[];
}

/** Mirrors wireName() in bench/generate.mjs — Anthropic allows [a-zA-Z0-9_-]{1,64}. */
function wireName(server: string, tool: string): string {
	const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
	const full = `${clean(server)}__${clean(tool)}`;
	if (full.length <= 64) return full;
	const toolPart = clean(tool).slice(0, 48);
	return `${clean(server).slice(0, Math.max(1, 64 - toolPart.length - 2))}__${toolPart}`;
}

const firstLine = (text?: string) => (text ?? "").trim().split("\n")[0] ?? "";

async function invoke(server: string, tool: string, args: unknown) {
	const response = await fetch(`${PROXY}/call`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ server, tool, args: args ?? {}, meta: { arm: "vanilla", residency: RESIDENCY, runId: RUN_ID } }),
	});
	const body = (await response.json()) as { ok: boolean; text?: string; error?: string };
	// Thrown so it reaches the model the same way a built-in tool failure would.
	if (!body.ok) throw new Error(body.error ?? "MCP call failed");
	return { content: [{ type: "text", text: body.text ?? "" }], details: {} };
}

export default function (pi: ExtensionAPI) {
	if (!CATALOGUE) {
		throw new Error("HARNESS_MCP_CATALOGUE is required (path to bench/data/mcp-schemas.json)");
	}

	const { catalogue } = JSON.parse(readFileSync(CATALOGUE, "utf8")) as { catalogue: Server[] };
	const exposed = SERVERS.length > 0 ? catalogue.filter((s) => SERVERS.includes(s.server)) : catalogue;

	// Flat index shared by both modes, keyed by the name the model will use.
	const index = new Map<string, { server: string; tool: McpTool }>();
	for (const { server, tools } of exposed) {
		for (const tool of tools) index.set(wireName(server, tool.name), { server, tool });
	}

	if (RESIDENCY === "L4") {
		for (const [name, { server, tool }] of index) {
			pi.registerTool({
				name,
				label: `${server}: ${tool.name}`,
				// The server's own description, verbatim — the codemode arm's generated
				// module docstring carries the same text. See docs/DESIGN.md on keeping
				// the two containers semantically matched.
				description: tool.description ?? "",
				// Raw JSON Schema; TypeBox schemas are JSON Schema at runtime.
				parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
				execute: (_id: string, params: unknown) => invoke(server, tool.name, params),
			});
		}
		return;
	}

	if (RESIDENCY !== "L1") throw new Error(`unsupported vanilla residency: ${RESIDENCY}`);

	// L1 mirrors how deferred tools actually work in a modern harness (Claude
	// Code's ToolSearch): names are cheap and visible, schemas are fetched on
	// demand, and once fetched the tool becomes *directly callable*. An earlier
	// attempt returned only the schema and left the model to route every call
	// through a generic call_tool; it repeatedly tried to invoke the listed names
	// directly and burned 16 turns on errors. Making load_tool activate the tool
	// removes that friction without giving L1 the resident cost of L4.
	const summary = [...index].map(([name, { tool }]) => `${name} — ${firstLine(tool.description)}`);

	// Every MCP tool is registered so it *can* be activated, but only the base
	// set is active initially — registration is not residency; activation is.
	for (const [name, { server, tool }] of index) {
		pi.registerTool({
			name,
			label: `${server}: ${tool.name}`,
			description: tool.description ?? "",
			parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
			execute: (_id: string, params: unknown) => invoke(server, tool.name, params),
		});
	}

	const BASE = ["read", "bash", "edit", "write", "grep", "find", "ls", "search_tools", "load_tool"];
	const active = new Set(BASE);

	pi.on("session_start", async () => {
		// Narrow to the base set: the 250 registered tools stay dormant until loaded.
		pi.setActiveTools([...active]);
	});

	pi.registerTool({
		name: "search_tools",
		label: "Search tools",
		description:
			`Search the ${index.size} available tools by keyword. Returns matching names with a one-line ` +
			"summary each. The full list of names is also in your system prompt. Omit the query to list all.",
		parameters: {
			type: "object",
			properties: { query: { type: "string", description: "Keywords to match against names and summaries." } },
		} as never,
		async execute(_id: string, params: { query?: string }) {
			const q = (params?.query ?? "").toLowerCase().trim();
			const hits = q ? summary.filter((l) => q.split(/\s+/).some((w) => l.toLowerCase().includes(w))) : summary;
			const text = hits.length > 0 ? hits.join("\n") : `No tools match "${params?.query}".`;
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "load_tool",
		label: "Load tool",
		description:
			"Load one or more tools by exact name. Returns their parameter schemas AND makes them directly " +
			"callable for the rest of this session. Load a tool before calling it.",
		parameters: {
			type: "object",
			properties: {
				names: { type: "array", items: { type: "string" }, description: "Exact tool names to load." },
			},
			required: ["names"],
		} as never,
		async execute(_id: string, params: { names: string[] }) {
			const wanted = params?.names ?? [];
			const unknown = wanted.filter((n) => !index.has(n));
			if (unknown.length > 0) {
				throw new Error(`Unknown tool(s): ${unknown.join(", ")}. Use search_tools to find valid names.`);
			}
			for (const n of wanted) active.add(n);
			pi.setActiveTools([...active]);
			const schemas = wanted.map((n) => {
				const e = index.get(n)!;
				return {
					name: n,
					description: e.tool.description ?? "",
					input_schema: e.tool.inputSchema ?? { type: "object", properties: {} },
				};
			});
			return {
				content: [
					{
						type: "text",
						text: `Loaded ${wanted.length} tool(s); they are now directly callable.\n\n${JSON.stringify(schemas, null, 2)}`,
					},
				],
				details: {},
			};
		},
	});
}
