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

/**
 * Every constraint keyword the runtime validator claims to enforce, once each.
 *
 * Shaped after what AppWorld's own function-calling schemas actually carry —
 * `minimum`/`maximum` on pagination, `minLength` on names, `format: email`,
 * `enum` on a handful of string parameters, `exclusiveMinimum` on amounts — plus
 * the keywords a real MCP server ships that AppWorld does not (`pattern`,
 * `maxItems`, `anyOf`, a nested object) so the validator is exercised beyond one
 * benchmark's dialect.
 *
 * The bool/int cases are deliberate: Python's `bool` is an `int` subclass, so a
 * naive isinstance check lets `page_limit=True` through and `verified=1` through,
 * and both are rejected downstream.
 */
export const constrained = [
	{
		server: "strict",
		tools: [
			{
				name: "search",
				description: "Search the catalogue.",
				inputSchema: {
					type: "object",
					properties: {
						email: { type: "string", format: "email", description: "Who is searching." },
						name: { type: "string", minLength: 1, maxLength: 8, description: "Display name." },
						sort_by: { type: "string", enum: ["+price", "-price", "+rating"], description: "Sort order." },
						page_index: { type: "integer", minimum: 0, description: "Page, from 0." },
						page_limit: { type: "integer", minimum: 1, maximum: 20, description: "Page size." },
						amount: { type: "number", exclusiveMinimum: 0.0, description: "Minimum price." },
						verified: { type: "boolean", description: "Only verified sellers." },
						code: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "Coupon code." },
						tags: { type: "array", items: { type: "string" }, maxItems: 3, description: "Tags." },
						filters: {
							type: "object",
							properties: { seller: { type: "integer" }, region: { type: "string", enum: ["us", "eu"] } },
							required: ["seller"],
							description: "Structured filters.",
						},
						answer: { anyOf: [{ type: "number" }, { type: "string" }], description: "Free-form answer." },
					},
					required: ["email"],
				},
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

/**
 * An app with enough APIs to trip the docs gate's neighbour bound (>20).
 *
 * Names deliberately share tokens the way a real app's do — `show_song_details`
 * next to `show_song_library` and `create_playlist` — because the gate ranks
 * siblings by shared name-tokens, and a fixture of unrelated names would let a
 * broken ranking pass.
 */
export const wide = [
	{
		server: "wide",
		tools: [
			"show_song_details",
			"show_song_library",
			"show_song_reviews",
			"show_song_lyrics",
			"play_song",
			"download_song",
			"show_album_details",
			"show_album_library",
			"show_album_reviews",
			"show_artist_details",
			"show_artist_library",
			"show_playlist_details",
			"show_playlist_library",
			"create_playlist",
			"delete_playlist",
			"update_playlist",
			"show_queue",
			"add_to_queue",
			"clear_queue",
			"login",
			"logout",
			"show_account",
			"update_account",
			"show_payment_cards",
			"add_payment_card",
		].map((name) => ({
			name,
			description: `${name.split("_").join(" ")} — one line about what it does.`,
			inputSchema: {
				type: "object",
				properties: {
					song_id: { type: "string", description: "Identifier." },
					page_index: { type: "integer", description: "Page, from 0." },
				},
				required: ["song_id"],
			},
		})),
	},
];

/**
 * The hostile catalogue: every input-domain trap the 2026-08-15 review found
 * the compiler survives on AppWorld only by luck. Each entry names the failure
 * it pins. Used by bench/test/hostile.test.mjs, whose gate is IMPORT, not
 * ast.parse — findings 2a and 3 both parse cleanly and fail at import.
 */
export const hostile = [
	{
		// Two servers that normalize to one package name. The docs/TOC once cited
		// `api.math_mcp.sub` while the module lived in `math_mcp_2/`.
		server: "Math MCP",
		tools: [
			{
				name: "add",
				description: "Add two numbers.",
				inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
			},
		],
	},
	{
		server: "math-mcp",
		tools: [
			{
				name: "sub",
				description: "Subtract b from a.",
				inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
			},
		],
	},
	{
		server: "traps",
		tools: [
			{
				// A `"""` and a backslash in the description: SyntaxError in the
				// docstring unless sanitized, whole app module lost when consolidated.
				name: "inject_doc",
				description: 'Bad """ docstring with a trailing backslash \\',
				inputSchema: { type: "object", properties: { a: { type: "string", description: 'also """ here \\' } } },
			},
			{
				// Tool-name collision under pyIdent: `dup-name` and `dup_name`. The
				// second def silently shadowed the first (consolidated) or one module
				// file overwrote the other (per-method).
				name: "dup-name",
				description: "First of a colliding pair.",
				inputSchema: { type: "object", properties: {} },
			},
			{
				name: "dup_name",
				description: "Second of a colliding pair.",
				inputSchema: { type: "object", properties: {} },
			},
			{
				// Parameter-name collision: SyntaxError (duplicate argument).
				name: "kwcollide",
				description: "Two params, one identifier.",
				inputSchema: {
					type: "object",
					properties: {
						"page-index": { type: "integer", description: "Kebab twin." },
						page_index: { type: "integer", description: "Snake twin." },
					},
				},
			},
			{
				// Non-string enum members: Literal[true, false, null] parses and then
				// NameErrors at import — past any ast.parse gate.
				name: "boolenum",
				description: "Enum of booleans and null.",
				inputSchema: {
					type: "object",
					properties: {
						x: { type: "boolean", enum: [true, false, null] },
						y: { type: "string", const: "fixed" },
						z: { type: "integer", enum: [1, 2, 3] },
						w: { type: "object", enum: [{ bad: 1 }], description: "Object member degrades to base type." },
					},
				},
			},
			{
				// A schema default that must surface in the docstring (P1.5).
				name: "defaulted",
				description: "Carries a server-side default.",
				inputSchema: {
					type: "object",
					properties: { page_limit: { type: "integer", minimum: 1, maximum: 20, default: 5 } },
				},
			},
		],
	},
];
