/**
 * MCP catalogue fixtures.
 *
 * `realistic` mirrors the shape of real servers (Linear, Notion). `adversarial`
 * collects the things real MCP schemas actually do that break naive codegen —
 * hyphenated tool names, Python reserved words as parameters, enums, nested
 * arrays, absent descriptions. The generator must survive all of it, because a
 * module that fails to import silently removes a tool from the codemode arm
 * while leaving it present in vanilla.
 */

export const realistic = [
	{
		server: "linear",
		tools: [
			{
				name: "list_issues",
				description:
					"List issues in a team.\n\nResults are ordered by most recently updated first and are capped at 50 unless a limit is given.",
				inputSchema: {
					type: "object",
					properties: {
						team: { type: "string", description: "Team key, e.g. ENG." },
						status: { type: "string", enum: ["todo", "in_progress", "done"], description: "Filter by status." },
						limit: { type: "integer", description: "Maximum number of issues to return." },
					},
					required: ["team"],
				},
			},
			{
				name: "create_issue",
				description: "Create an issue in a team.",
				inputSchema: {
					type: "object",
					properties: {
						team: { type: "string", description: "Team key." },
						title: { type: "string", description: "Issue title." },
						labels: { type: "array", items: { type: "string" }, description: "Label names." },
					},
					required: ["team", "title"],
				},
			},
		],
	},
	{
		server: "notion",
		tools: [
			{
				name: "search",
				description: "Search pages and databases.",
				inputSchema: {
					type: "object",
					properties: { query: { type: "string", description: "Search text." } },
					required: ["query"],
				},
			},
		],
	},
];

export const adversarial = [
	{
		server: "messy",
		tools: [
			{
				// Hyphens and dots are legal in MCP tool names, illegal in Python.
				name: "get-user.profile",
				description: "Fetch a user profile.",
				inputSchema: {
					type: "object",
					// `from`, `class`, `import`, `lambda` are Python reserved words.
					properties: {
						from: { type: "string", description: "Start date." },
						class: { type: "string", description: "Record class." },
						id: { type: "string" },
					},
					required: ["from"],
				},
			},
			{
				// No description at all — some servers ship this.
				name: "undocumented",
				inputSchema: { type: "object", properties: {} },
			},
			{
				// Leading digit, nullable union, nested array.
				name: "2fa_verify",
				description: "Verify a two-factor code.",
				inputSchema: {
					type: "object",
					properties: {
						code: { type: ["string", "null"], description: "The code, or null to resend." },
						matrix: { type: "array", items: { type: "array", items: { type: "integer" } } },
					},
					required: ["code"],
				},
			},
			{
				// No inputSchema key whatsoever.
				name: "ping",
				description: "Health check.",
			},
		],
	},
];

/** A catalogue of `count` synthetic tools, for residency scaling measurements. */
export function synthetic(count, server = "bulk") {
	return [
		{
			server,
			tools: Array.from({ length: count }, (_, i) => ({
				name: `tool_${i}`,
				description: `Performs operation ${i} against the ${server} service and returns its result.`,
				inputSchema: {
					type: "object",
					properties: {
						target: { type: "string", description: "The resource to operate on." },
						force: { type: "boolean", description: "Skip confirmation." },
					},
					required: ["target"],
				},
			})),
		},
	];
}
