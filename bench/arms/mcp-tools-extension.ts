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

	// Deferral by *registration*, not activation.
	//
	// The obvious route — allowlist all 250 via --tools, activate a few via
	// initialActiveToolNames — does not work: _buildRuntime unconditionally
	// activates every allowed tool (patched), and the CLI flag is then dropped
	// again when print mode re-spawns a session worker with a rebuilt argv.
	//
	// Only *registered* tools are sent to the provider, so registering a tool
	// lazily achieves the same deferral with none of that plumbing. load_tool
	// registers on demand; everything else stays unknown to the model.
	const summary = [...index].map(([name, { tool }]) => `${name} — ${firstLine(tool.description)}`);
	const loaded = new Set<string>();

	function registerReal(name: string) {
		if (loaded.has(name)) return;
		const entry = index.get(name);
		if (!entry) throw new Error(`Unknown tool "${name}". Use search_tools to find valid names.`);
		loaded.add(name);
		pi.registerTool({
			name,
			label: `${entry.server}: ${entry.tool.name}`,
			description: entry.tool.description ?? "",
			parameters: (entry.tool.inputSchema ?? { type: "object", properties: {} }) as never,
			execute: (_id: string, params: unknown) => invoke(entry.server, entry.tool.name, params),
		});
	}

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
			return { content: [{ type: "text", text: hits.join("\n") || `No tools match "${params?.query}".` }], details: {} };
		},
	});

	pi.registerTool({
		name: "load_tool",
		label: "Load tool",
		description:
			"Load one or more tools by exact name. Returns their parameter schemas AND makes them directly " +
			"callable for the rest of this session. You must load a tool before you can call it.",
		parameters: {
			type: "object",
			properties: { names: { type: "array", items: { type: "string" }, description: "Exact tool names." } },
			required: ["names"],
		} as never,
		async execute(_id: string, params: { names: string[] }) {
			const wanted = params?.names ?? [];
			for (const n of wanted) registerReal(n);
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
					{ type: "text", text: `Loaded ${wanted.length} tool(s); now directly callable.\n\n${JSON.stringify(schemas, null, 2)}` },
				],
				details: {},
			};
		},
	});
}
