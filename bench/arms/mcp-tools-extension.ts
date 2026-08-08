/**
 * vanilla arm: register the MCP catalogue as native tool definitions.
 *
 * This is the condition being baselined — every tool the task can reach sits in
 * the model's context as a JSON Schema on every request. At MCP-Bench scale
 * that is ~48k tokens per turn.
 *
 * Which servers are exposed comes from HARNESS_MCP_SERVERS so the runner can
 * reproduce MCP-Bench's own setup: the task's real servers plus its declared
 * distraction servers.
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

/** Mirrors wireName() in bench/generate.mjs — Anthropic allows [a-zA-Z0-9_-]{1,64}. */
function wireName(server: string, tool: string): string {
	const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
	const full = `${clean(server)}__${clean(tool)}`;
	if (full.length <= 64) return full;
	const toolPart = clean(tool).slice(0, 48);
	return `${clean(server).slice(0, Math.max(1, 64 - toolPart.length - 2))}__${toolPart}`;
}

export default function (pi: ExtensionAPI) {
	if (!CATALOGUE) {
		throw new Error("HARNESS_MCP_CATALOGUE is required (path to bench/data/mcp-schemas.json)");
	}

	const { catalogue } = JSON.parse(readFileSync(CATALOGUE, "utf8")) as {
		catalogue: Array<{ server: string; tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
	};

	const exposed = SERVERS.length > 0 ? catalogue.filter((s) => SERVERS.includes(s.server)) : catalogue;

	for (const { server, tools } of exposed) {
		for (const tool of tools) {
			const name = wireName(server, tool.name);
			pi.registerTool({
				name,
				label: `${server}: ${tool.name}`,
				// The server's own description, verbatim. The codemode arm's generated
				// module docstring carries the same text — see docs/DESIGN.md on
				// keeping the two containers semantically matched.
				description: tool.description ?? "",
				// Raw JSON Schema. TypeBox schemas are JSON Schema at runtime, so the
				// provider layer serializes this unchanged.
				parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
				async execute(_toolCallId: string, params: unknown) {
					const response = await fetch(`${PROXY}/call`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							server,
							tool: tool.name,
							args: params ?? {},
							meta: { arm: "vanilla", runId: RUN_ID },
						}),
					});
					const body = (await response.json()) as { ok: boolean; text?: string; error?: string };
					if (!body.ok) {
						// Surface as a thrown error so it reaches the model the same way a
						// built-in tool failure would.
						throw new Error(body.error ?? "MCP call failed");
					}
					return { content: [{ type: "text", text: body.text ?? "" }], details: {} };
				},
			});
		}
	}
}
