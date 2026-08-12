/**
 * AppWorld prompts: one shared base, one preamble per arm.
 *
 * Why not reuse bench/prompts.mjs
 * -------------------------------
 * The MCP-Bench winner `q8` says "ten to twenty items is almost always enough",
 * "enumerating an entire collection is scored as redundancy", "do not fetch
 * broadly in case you need it". That is tuned for MCP-Bench's
 * `parallelism_and_efficiency` dimension. On AppWorld it is **actively wrong**:
 * grading is exact-answer plus database state, collections are paginated at
 * `page_limit <= 20`, and upstream's own instruction is "always process all
 * results, looping through the page_index; don't stop at the first page." A
 * sampled answer is a failed task here. Carrying `q8` over would have measured
 * how badly a cost-tuned prompt does on a completeness-graded benchmark.
 *
 * The base/preamble split
 * ----------------------
 * `BASE_INSTRUCTIONS` is AppWorld protocol: who the supervisor is, where
 * credentials live, pagination, time handling, collateral damage, how to submit
 * an answer. It is **identical for every arm**, and it is adapted from the block
 * that upstream's function-calling and full-code prompts already share verbatim
 * (`experiments/prompts/{function_calling_agent,full_code_agent}/*.txt`). Taking
 * it from upstream rather than writing it here matters: prime's own base prompts
 * differ 10x in length between the code and non-code paths, and that confound
 * already invalidated one result set in this project.
 *
 * The preambles carry only tool-surface guidance — how to find a tool and how to
 * call it. That is the independent variable. Both arms get real guidance for
 * their own surface; stripping one to "make it fair" measures which
 * representation survives a bad prompt, which nobody cares about.
 */

/**
 * Arm-neutral. Every arm receives exactly this string as its system prompt.
 *
 * `{{supervisor}}` and `{{apps}}` are filled per task. Nothing here mentions
 * tools, functions, code, or files.
 */
export const BASE_INSTRUCTIONS = [
	"You are an AI assistant completing a day-to-day task for your supervisor,",
	"fully autonomously, by interacting with their personal apps.",
	"",
	"Your supervisor is {{supervisor}}.",
	"",
	"Apps you have access to:",
	"{{apps}}",
	"",
	"## General",
	"",
	"- Act entirely on your own. Make every decision yourself; never ask for",
	"  confirmation or clarification, and never hand back instructions to follow.",
	"- You have complete permission to operate across all of these accounts.",
	"- Never invent or guess a value. If you need a song's id, look it up; do not",
	"  assume it is 123. Never leave a placeholder like \"your_username\".",
	"- Where the task omits a detail, choose any valid value. If it does not say",
	"  which payment card, any of the supervisor's cards will do.",
	"- Avoid collateral damage. Do only what was asked. Buying something does not",
	"  license deleting emails or cancelling orders — unrequested changes to the",
	"  world count against you.",
	"",
	"## These apps in particular",
	"",
	"- All of the supervisor's personal information — biographical details, app",
	"  credentials, addresses, payment cards — lives in the `supervisor` app.",
	"  Passwords come from its account-passwords API; each other app then needs a",
	"  login call, which returns an access token that its other APIs require.",
	"- Any reference to a friend, family member, or other person means someone in",
	"  the `phone` app's contacts.",
	"- Get the current date and time from the `phone` app, never from your own",
	"  clock or the machine's.",
	"- There is a single, default time zone. For a period like \"yesterday\", use",
	"  the complete range 00:00:00 to 23:59:59.",
	"- \"File system\" means the `file_system` app, not the machine's filesystem.",
	"- **Collection APIs are paginated.** They take `page_index` (from 0) and",
	"  `page_limit` (usually capped at 20) and return one page. Loop until a page",
	"  comes back short or empty. Answering from the first page is the single most",
	"  common way to fail one of these tasks: a library of 92 songs looks like 5.",
	"",
	"## Finishing",
	"",
	"You must call the `supervisor` app's complete-task API when you are done.",
	"",
	"- If the task asks a question, pass the answer. If it only asks for something",
	"  to be done, omit the answer argument.",
	"- Keep an answer minimal: the entity, number, or value asked for, not a",
	"  sentence. For a song title, pass just the title.",
	"- Numbers must be numeric: 10, not \"ten\".",
	"- The task is doable. If you genuinely cannot find a way, complete it with",
	"  status=\"fail\" rather than leaving it open.",
	"",
	"Ground every claim in something an API actually returned. Do not state facts",
	"you have not retrieved.",
].join("\n");

export function buildBase({ supervisor, apps }) {
	return BASE_INSTRUCTIONS.replace("{{supervisor}}", supervisor).replace("{{apps}}", apps);
}

// --- codemode ----------------------------------------------------------------

/**
 * a1 — the default codemode preamble.
 *
 * Three things it has to do, and nothing else:
 *   1. say the tree exists and how to search it (an agent that does not know to
 *      look fails for a reason unrelated to the hypothesis — the fixed cost
 *      counted against codemode in docs/DESIGN.md),
 *   2. say the calls are `async`,
 *   3. say the kernel persists, because AppWorld tasks re-read the same
 *      collections and 88% redundancy was measured on TAC when this was unsaid.
 *
 * Deliberately absent: any pressure toward economy. See the module docstring.
 */
export const VARIANTS = {
	a1: {
		note: "baseline: discovery + async + persistent kernel, no economy pressure",
		build: ({ toolCount, serverCount }) =>
			[
				"## Your tools",
				"",
				`Every API is already written for you as a Python function on disk: ${toolCount}`,
				`functions across ${serverCount} apps, under \`api/\` in your working directory.`,
				"Nothing is listed in this prompt — you find what you need by looking.",
				"",
				"  cat api/INDEX.md                    # the apps, and how many APIs each has",
				"  cat api/<app>/INDEX.md              # one line per API in that app",
				"  grep -ril '<keyword>' api/          # search every API's documentation",
				"  cat api/<app>/<api>.py              # full parameter documentation",
				"",
				"Call one from a cell. They are all `async`:",
				"",
				"  import api.supervisor, api.spotify",
				"  profile = json.loads(await api.supervisor.show_profile())",
				"",
				"Independent calls can go out together:",
				"",
				"  pages = await asyncio.gather(*[",
				"      api.spotify.show_playlist_library(access_token=token, page_index=i, page_limit=20)",
				"      for i in range(5)",
				"  ])",
				"",
				"Each returns the API's response as a JSON string; `json.loads` it.",
				"",
				"## The kernel is persistent",
				"",
				"Every cell runs in the SAME long-lived IPython session. Any top-level",
				"variable you bind stays available in every later cell, for the whole task.",
				"Data you have already fetched is still in memory — you never need to fetch",
				"it twice. You will not remember across turns what you already have, so look:",
				"",
				"  %whos                               # every live variable, with type and size",
				"",
				"Write a helper once and reuse it. Paginating is a loop, not thirty turns:",
				"",
				"  async def all_pages(fn, **kw):",
				"      out, i = [], 0",
				"      while True:",
				"          page = json.loads(await fn(page_index=i, page_limit=20, **kw))",
				"          out += page",
				"          if len(page) < 20: return out",
				"          i += 1",
			].join("\n"),
	},
};

/**
 * a2 — codemode with filtering forbidden. The mirror test.
 *
 * Measured on the a1 runs, the tools arms are **already** issuing parallel tool
 * calls — vanilla L4 averages 4.6 per turn, up to 11 — while codemode is strictly
 * 1.00 actions per turn and still takes fewer turns. So the representation term is
 * not round trips, and a "parallel tool calls" condition tests something already
 * present in three cells.
 *
 * What differs is what enters the context per unit of work: vanilla emits 5-8x more
 * output tokens (one JSON tool-call block per API call, 37-41 of them, against one
 * code block per turn) and accumulates ~2.7x more conversation context, because
 * every tool result lands verbatim while a cell prints only what the code chose.
 *
 * The hypothesis is therefore **code can discard**. This variant removes exactly
 * that ability and changes nothing else: same tree, same discovery, same persistent
 * kernel, same async calls — but every response must be printed in full. If
 * codemode's accumulated context and cost move toward vanilla's, the mechanism is
 * confirmed. If they do not, the explanation is wrong and needs finding before this
 * is written up.
 *
 * Note what this does NOT do: it does not forbid loops or `gather`, so pagination
 * still costs one cell rather than N tool calls. Filtering is the only factor
 * removed, which is what makes it a clean contrast with a1 rather than a second
 * confound.
 */
VARIANTS.a2 = {
	/**
	 * MEASURED, 20 tasks (10 low-call / 10 high-call), Opus 5, against a1:
	 *
	 *   high stratum      out    ctxAccum      cost    TGC
	 *   a1 (can filter)  1,317     37,880    0.1356  10/10
	 *   a2 (cannot)      1,251     81,387    0.2355  10/10
	 *   tools/docs-out  13,056    163,053    0.8998  10/10
	 *
	 * Output tokens moved -5%; accumulated context +115%; cost +74%. So filtering
	 * controls reception and not emission, exactly as hypothesised — but the split
	 * is lopsided: reception (a2-a1) is $0.100 of the $0.764 representation term,
	 * ~13%, and emission plus per-result framing (tools-a2) is $0.664, ~87%. Even
	 * forbidden to discard anything the code arm is still 3.8x cheaper.
	 *
	 * Kept per the negative-results convention in CLAUDE.md even though it confirmed:
	 * the informative part is that the recoverable share is an eighth, which
	 * downgrades the server-side-projection recommendation it was run to inform.
	 */
	note: "a1 with filtering forbidden — every response printed verbatim; the mirror test. CONFIRMED: -5% output, +115% context, +74% cost; reception is ~13% of the representation term",
	build: (ctx) =>
		[
			VARIANTS.a1.build(ctx),
			"",
			"## Print every response in full",
			"",
			"For this task you must not summarise, slice, or select fields out of an API",
			"response before printing it. Every call's complete response must appear in",
			"your cell output, exactly as the API returned it:",
			"",
			"  pages = await asyncio.gather(*[",
			"      api.spotify.show_playlist_library(access_token=token, page_index=i, page_limit=20)",
			"      for i in range(5)",
			"  ])",
			"  for p in pages:",
			"      print(p)                    # the whole response, not len(p) or a field",
			"",
			"Do not print counts, lengths, or extracts in place of the response. You may",
			"still compute over the data afterwards — bind it, loop over it, filter it for",
			"your own reasoning — but the raw response has to be printed first.",
		].join("\n"),
};

export function buildPreamble(variant, ctx) {
	const spec = VARIANTS[variant];
	if (!spec) throw new Error(`unknown codemode variant: ${variant} (have ${Object.keys(VARIANTS)})`);
	return spec.build(ctx);
}

// --- vanilla -----------------------------------------------------------------

/**
 * b1 — L4: every function definition resident.
 * b2 — L1: names resident, schemas fetched with load_tool.
 *
 * Matched to a1 clause for clause: what exists, how to find it, how to call it,
 * and the same pagination-as-a-loop point rendered in this arm's idiom (batch
 * the page calls in one turn rather than writing a `while`).
 */
/**
 * Guidance shared verbatim by every vanilla variant.
 *
 * One constant, not three copies. The variants differ only in how a schema is
 * reached — which is the residency mechanism, i.e. the independent variable — and
 * anything else that differed between them would sit *inside* the contrast the 2x2
 * measures. The MCP-Bench track found exactly this: its L1 cell built its own
 * preamble and so never received the efficiency guidance its L4 cell got, a
 * difference lying on the axis being varied.
 *
 * Byte-identity across b1/b2/b3 is asserted in bench/test/appworld-fairness.test.mjs.
 * Asserting identity rather than "both mention parallelism" is the point: a test that
 * checks for a topic passes while the wording drifts.
 */
const VANILLA_SHARED_GUIDANCE = [
	"You can issue several calls in one turn, and should whenever they do not",
	"depend on each other — including the pages of one paginated collection:",
	"request `page_index` 0,1,2,3,4 together rather than one per turn, then",
	"continue if page 4 came back full.",
];

export const VANILLA_VARIANTS = {
	b1: {
		note: "L4 baseline: all schemas resident; matched to a1",
		build: ({ toolCount, serverCount }) =>
			[
				"## Your tools",
				"",
				`${toolCount} functions are available to you, covering every API of the`,
				`${serverCount} apps. Each is named \`<app>__<api>\` — \`spotify__login\` is the`,
				"Spotify app's login API. Their full parameter schemas are already in front",
				"of you; you do not need to look anything up before calling.",
				"",
				...VANILLA_SHARED_GUIDANCE,
			].join("\n"),
	},
	b2: {
		note: "L1: names resident, schemas on demand via describe_tool + call_tool",
		build: ({ toolCount, serverCount }) =>
			[
				"## Your tools",
				"",
				`${toolCount} functions are available to you, covering every API of the`,
				`${serverCount} apps. Each is named \`<app>__<api>\` — \`spotify__login\` is the`,
				"Spotify app's login API. Their names are listed below; their parameter",
				"schemas are not, to keep this prompt small.",
				"",
				"Two steps. Get a schema, then call through the dispatcher:",
				"",
				"  describe_tool(names=[\"spotify__login\", \"spotify__show_playlist_library\"])",
				"  call_tool(name=\"spotify__login\", arguments={\"username\": ..., \"password\": ...})",
				"",
				"`describe_tool` returns the exact JSON Schema — ask for several at once.",
				"`search_tools(query=...)` matches names and one-line summaries if you are",
				"not sure what exists. You only need to describe a function once; after that",
				"call it directly.",
				"",
				...VANILLA_SHARED_GUIDANCE,
			].join("\n"),
	},
};

/**
 * b3 — the `predicted` arm: <=20 schemas resident, chosen by an LLM pre-pass.
 *
 * Upstream's own baseline. Matched to b1 clause for clause, minus the claim that
 * the catalogue is complete — because it is not, and telling the agent otherwise
 * would make a prediction miss read as a capability failure. Upstream's predictor
 * prompt says "prioritize high recall" for the same reason; the agent has no
 * recourse if the pre-pass dropped what it needs.
 */
VANILLA_VARIANTS.b3 = {
	note: "predicted: <=20 schemas resident, selected by upstream's APIPredictor",
	build: ({ toolCount, serverCount }) =>
		[
			"## Your tools",
			"",
			`${toolCount} functions are available to you, selected in advance as the ones`,
			`this task most likely needs, out of every API of the ${serverCount} apps.`,
			"Each is named `<app>__<api>` — `spotify__login` is the Spotify app's login",
			"API. Their full parameter schemas are already in front of you.",
			"",
			"This selection was made before the task started and may be incomplete. If",
			"something you need is genuinely absent, say so in your final answer rather",
			"than guessing at an API that is not listed.",
			"",
			...VANILLA_SHARED_GUIDANCE,
		].join("\n"),
};

export function buildVanillaPreamble(variant, ctx) {
	const spec = VANILLA_VARIANTS[variant];
	if (!spec) throw new Error(`unknown vanilla variant: ${variant} (have ${Object.keys(VANILLA_VARIANTS)})`);
	return spec.build(ctx);
}
