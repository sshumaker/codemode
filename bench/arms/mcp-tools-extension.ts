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
/**
 * Optional explicit subset of wire names to expose, comma-separated.
 *
 * Used by the `predicted` arm, which mirrors AppWorld's own APIPredictor: an LLM
 * call narrows the catalogue to <=20 APIs before the agent starts, and only those
 * are registered. Registration (not activation) is the right mechanism here
 * because the subset is fixed for the whole session — the failure mode documented
 * in the L1 branch only bites when the set changes mid-run.
 */
const SUBSET = (process.env.HARNESS_TOOL_SUBSET ?? "").split(",").map((s) => s.trim()).filter(Boolean);

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

	if (SUBSET.length > 0) {
		const unknown = SUBSET.filter((n) => !index.has(n));
		if (unknown.length > 0) throw new Error(`HARNESS_TOOL_SUBSET names tools that do not exist: ${unknown.join(",")}`);
		for (const name of [...index.keys()]) if (!SUBSET.includes(name)) index.delete(name);
	}

	if (RESIDENCY === "L4" || RESIDENCY === "predicted") {
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

	// L1: names resident, schemas on demand, dispatched through one call_tool.
	//
	// Three attempts, recorded because the first two each produced a run that
	// looked plausible and was not L1:
	//
	//  1. Allowlist all N via --tools and narrow with the --active-tools CLI flag.
	//     The flag does not reach print mode's session worker, which rebuilds argv,
	//     so the run was silently L4 under an L1 label. That is what the residency
	//     guard in run-task.mjs exists to catch.
	//
	//  2. Deferral by *registration* — register only the meta-tools, and have
	//     load_tool call pi.registerTool on demand. The schema comes back correctly,
	//     the model calls the tool, and prime answers "Tool <name> not found":
	//     `prepareToolCall` resolves against `currentContext.tools`, a per-turn
	//     snapshot of `agent.state.tools`
	//     (packages/agent/dist/agent-loop.js:538). Measured on AppWorld: 70 turns,
	//     78 tool calls, **0** reaching the transport, 32 errors, $1.71, failed.
	//
	//  3. Register everything up front and narrow with `pi.setActiveTools`. This
	//     half-worked and is the instructive one: residency was genuinely reduced
	//     (first turn 8,748 prompt tokens against L4's 101,137), so the model no
	//     longer saw the catalogue — but execution still answered "not found", so
	//     again 0 calls reached the transport. Advertisement and executability are
	//     controlled by the same per-turn snapshot, and an extension cannot update
	//     it mid-loop.
	//
	// So dynamic tool *identity* is not expressible in this harness. What is
	// expressible is a fixed set of tools whose *arguments* carry the identity:
	// `search_tools` / `describe_tool` / `call_tool`. All three are registered at
	// load time and never change, so `prepareToolCall` always resolves them, and the
	// N schemas stay out of context until asked for. This is also what a number of
	// real MCP harnesses ship.
	//
	// The honest cost to this arm, which must be reported with any result: the model
	// does not get provider-side validation of the inner call's arguments, because
	// as far as the provider is concerned it called `call_tool`. That is a small
	// ergonomic penalty relative to L4, and it is the price of not having the
	// schemas resident — which is the trade-off under study, not a handicap we
	// imposed. `describe_tool` returns the exact JSON Schema so the model can
	// satisfy it, and `call_tool` validates required parameters itself and says what
	// is missing.
	const summary = [...index].map(([name, { tool }]) => `${name} — ${firstLine(tool.description)}`);

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
		name: "describe_tool",
		label: "Describe tool",
		description:
			"Get the full JSON Schema for one or more tools by exact name. Call this before call_tool " +
			"unless you already know the parameters.",
		parameters: {
			type: "object",
			properties: { names: { type: "array", items: { type: "string" }, description: "Exact tool names." } },
			required: ["names"],
		} as never,
		async execute(_id: string, params: { names: string[] }) {
			const wanted = params?.names ?? [];
			const out = wanted.map((n) => {
				const e = index.get(n);
				if (!e) return { name: n, error: `Unknown tool. Use search_tools to find valid names.` };
				return {
					name: n,
					description: e.tool.description ?? "",
					input_schema: e.tool.inputSchema ?? { type: "object", properties: {} },
				};
			});
			return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], details: {} };
		},
	});

	pi.registerTool({
		name: "call_tool",
		label: "Call tool",
		description:
			"Call one of the available tools by exact name. `arguments` must match the tool's JSON Schema — " +
			"use describe_tool first if you do not know it. Returns the tool's result.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Exact tool name, e.g. spotify__login." },
				arguments: { type: "object", description: "Arguments object matching the tool's input schema." },
			},
			required: ["name", "arguments"],
		} as never,
		async execute(_id: string, params: { name: string; arguments?: Record<string, unknown> }) {
			const entry = index.get(params?.name);
			// Thrown, so it reaches the model as a tool error the same way an unknown
			// tool name would at L4. Otherwise a typo reads as a successful call.
			if (!entry) throw new Error(`Unknown tool "${params?.name}". Use search_tools to find valid names.`);
			// Deliberately NOT pre-validated against the inner tool's schema.
			//
			// A local required-parameter check here would be more helpful, and it would
			// make this arm's error text differ from what codemode and L4 receive for
			// the same mistake — which is a difference in error legibility, not in
			// representation. Every arm gets the server's own message verbatim; only
			// the delivery differs, and the delivery difference IS the independent
			// variable. Verified byte-for-byte by bench/appworld/error-symmetry.mjs.
			//
			// L4 does get provider-side validation of these arguments for free. That is
			// a real advantage of having the schema resident, and it should be visible
			// in the results rather than neutralised here.
			return invoke(entry.server, entry.tool.name, params?.arguments ?? {});
		},
	});
}
