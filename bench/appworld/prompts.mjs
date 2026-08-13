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

/**
 * v2 — the same protocol, re-laid-out around the three rules that decide the outcome.
 *
 * Motivation, measured rather than supposed (docs/CC-WINS-TRIAGE.md, and the ADDENDUM
 * in docs/MORNING-REPORT-2026-08-13.md): the rules that decide pass/fail are already
 * in v1 and are ignored anyway.
 *
 *   - *"Get the current date and time from the `phone` app, never from your own
 *     clock"* is obeyed on **17/86** tasks by codemode, 20/86 by vanilla, 28/86 by
 *     claude-code. The failures use the real wall-clock year against a world whose
 *     date is 2023-05-18, and sweep 83 threads where 17 were wanted.
 *   - *"If the task asks a question, pass the answer"* requires a judgement the model
 *     keeps getting wrong on instructions whose surface form is interrogative.
 *   - Pagination is called the single most common way to fail, and sits last in a list
 *     of app trivia.
 *   - *"Ground every claim in something an API actually returned"* is an unmarked
 *     orphan below the last section.
 *
 * The hypothesis under test is that v1 is **flat**: every rule is an equal-weight
 * bullet, so the three that decide the outcome are indistinguishable from "file
 * system means the `file_system` app". v2 changes only the *shape* — hierarchy, a
 * pre-completion checklist, and one worked example of the answer/no-answer call. It
 * adds no task knowledge and encodes nothing about how the reference solutions
 * behave; that would be teaching to the test rather than testing the prompt.
 *
 * This project has repeatedly measured that error-channel corrections work where
 * prompt advisories do not (CLAUDE.md, "put the correction in the error, not in the
 * prompt"), so a rewrite is a real experiment with a real chance of a null. It is
 * selected by `--base-prompt=v2` and is **off by default**.
 *
 * One honest deviation from "same semantic content": rule 1 states outright that the
 * agent's own sense of today is not this world's date. v1 only implies it, by
 * forbidding the clock. Nothing else here is new information.
 *
 * Byte-identity across arms is the fairness invariant, asserted in
 * bench/test/appworld-fairness.test.mjs for v2 as well as v1, and confirmed live: a
 * 3-arm v2 run of 277d81d_3 records basePromptDigest f59d62b343083ae6 for codemode,
 * vanilla and claude-code alike.
 *
 * MEASURED — codemode, Opus 5, the 46 tasks baseline codemode failed, one rep each,
 * against the noise floor (that same baseline re-run twice on those tasks, 34/92 =
 * 37.0%; docs/MORNING-REPORT-2026-08-13.md §B). Size: 2,529 -> 3,960 chars (+57%).
 *
 *   pass rate            25/46 = 54.3% vs 37.0%   +17.4pp  two-proportion z=1.95 p=0.052
 *   paired vs floor mean                          +0.174   t=2.70 p=0.0098, sign 16/19 p=0.004
 *   grounded the date    80.4% vs 32.6%           +47.8pp  z=5.30  p<1e-6
 *   over-answered         0.0% vs 13.0%           -13.0pp  z=-2.56 p=0.010
 *   cost/task            $0.253 vs $0.225         +$0.027  t=2.68 p=0.010, sign 33/46 p=0.005
 *
 * 16 tasks improved, 3 regressed, 27 unchanged. **The behavioural effect is far
 * larger and far surer than the score effect**: the date rule went from ignored to
 * obeyed (z=5.3) and the over-answer bug — 6 of codemode's 46 failures — went to
 * zero, all six of those tasks now passing with `answer` omitted. Score moves less
 * because most remaining failures have causes v2 deliberately does not address
 * (window semantics on a53a8fd_*, the WishListEntry grader trap on 9871968_1); those
 * would need reference-fitting, which is out of bounds.
 *
 * Read the headline honestly: **the unpaired z is p=0.052, i.e. marginal.** The
 * paired test is significant and is the better instrument here (task difficulty
 * cancels), and the two agree in direction, but a variant whose primary test lands on
 * the line is not "a win" — it is a real effect measured at the edge of this sample's
 * power. It also costs 12% more per task, significantly.
 *
 * Two things this sample CANNOT tell you, both to be closed before v2 becomes the
 * default:
 *   - **Over-correction is untested.** Only 1 of these 46 tasks has a non-null ground
 *     truth answer (11% of the corpus overall does), so "v2 never over-answers" is
 *     measured while "v2 still answers when asked" is essentially not. Re-run on a
 *     question-heavy slice before adopting.
 *   - **Only codemode was measured.** The prompt is shared, so vanilla and
 *     claude-code must be re-measured too — v1's date rule was ignored by all three.
 */
export const BASE_INSTRUCTIONS_V2 = [
	"You are an AI assistant completing a day-to-day task for your supervisor,",
	"fully autonomously, by interacting with their personal apps.",
	"",
	"Your supervisor is {{supervisor}}.",
	"",
	"Apps you have access to:",
	"{{apps}}",
	"",
	"## IMPORTANT — three rules decide whether you pass or fail",
	"",
	"**1. NEVER use your own clock.** Your sense of today's date is not this world's",
	"date. Before you reason about any period — \"this year\", \"the last 2 days\",",
	"\"recently\" — get the current date and time from the `phone` app. A date you",
	"assumed instead of retrieved silently selects the wrong records, and every count",
	"and action downstream of it is wrong.",
	"",
	"**2. NEVER answer from the first page.** Collection APIs are paginated: they take",
	"`page_index` (from 0) and `page_limit` (usually capped at 20) and return one page.",
	"Loop until a page comes back short or empty. A library of 92 songs looks like 5",
	"from page 0. This is the single most common way to fail one of these tasks.",
	"",
	"**3. NEVER state a fact you did not retrieve.** Every claim, count, and value you",
	"report or act on must come from a response an API actually returned. Do not infer",
	"it, estimate it, or carry it forward from your own earlier reasoning.",
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
	"- There is a single, default time zone. For a period like \"yesterday\", use the",
	"  complete range 00:00:00 to 23:59:59.",
	"- \"File system\" means the `file_system` app, not the machine's filesystem.",
	"",
	"## Finishing",
	"",
	"You must call the `supervisor` app's complete-task API when you are done.",
	"",
	"**Decide, deliberately, whether the task ASKS you something or only INSTRUCTS you",
	"to do something.** Pass an answer if and only if it asks. For example:",
	"",
	"- *\"How many X do I have?\"* — a question. Pass the value.",
	"- *\"Check whether any X are Y, and if so, fix them.\"* — NOT a question. It reads",
	"  like one, but the deliverable is the fix; the check is only how you decide what",
	"  to do. Omit the answer argument.",
	"",
	"Making a choice in order to carry out an instruction does not make that choice an",
	"answer. If you had to pick a colour, a card, or an item to do what was asked, the",
	"value you picked is not an answer — omit it.",
	"",
	"- Keep an answer minimal: the entity, number, or value asked for, not a sentence.",
	"  For a song title, pass just the title.",
	"- Numbers must be numeric: 10, not \"ten\".",
	"- The task is doable. If you genuinely cannot find a way, complete it with",
	"  status=\"fail\" rather than leaving it open.",
	"",
	"## Check all four before you call complete-task",
	"",
	"1. Did I get the current date from the `phone` app, rather than assuming one?",
	"2. Did I page every collection I used to exhaustion, rather than stopping early?",
	"3. Is every value I am reporting or acting on taken from a real API response?",
	"4. Does this task actually ASK me something, or does it only INSTRUCT me? If it",
	"   only instructs, omit the answer argument.",
	"",
	"If any of the four is a no, fix it before you finish.",
].join("\n");

/**
 * The selectable base prompts. `v1` is the default everywhere; adding a key here is
 * all a new variant needs, and an unknown one throws rather than silently falling
 * back — a run labelled with a condition it is not in is the failure mode this repo
 * keeps finding.
 */
export const BASE_PROMPTS = { v1: BASE_INSTRUCTIONS, v2: BASE_INSTRUCTIONS_V2 };

export function buildBase({ supervisor, apps, version = "v1" }) {
	const text = BASE_PROMPTS[version];
	if (!text) throw new Error(`unknown base prompt: ${version} (have ${Object.keys(BASE_PROMPTS)})`);
	return text.replace("{{supervisor}}", supervisor).replace("{{apps}}", apps);
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
		build: ({ toolCount, serverCount, apiLayout = "per-method" }) =>
			[
				"## Your tools",
				"",
				`Every API is already written for you as a Python function on disk: ${toolCount}`,
				`functions across ${serverCount} apps, under \`api/\` in your working directory.`,
				"Nothing is listed in this prompt — you find what you need by looking.",
				"",
				"  cat api/INDEX.md                    # the apps, and how many APIs each has",
				// The ONLY thing --api-layout changes in this prompt: which files exist
				// and therefore which ones to open. Everything below — async, the
				// persistent kernel, the call-site example — is byte-identical, so the
				// A/B measures the shape of the tree rather than a reworded prompt.
				...(apiLayout === "consolidated"
					? [
							"  grep -ril '<keyword>' api/          # search every API's documentation",
							"  cat api/<app>.py                    # one app: every API, with full parameter docs",
						]
					: [
							"  cat api/<app>/INDEX.md              # one line per API in that app",
							"  grep -ril '<keyword>' api/          # search every API's documentation",
							"  cat api/<app>/<api>.py              # full parameter documentation",
						]),
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

// --- claude-code -------------------------------------------------------------

/**
 * c1 — the real product, consuming AppWorld's own MCP server.
 *
 * Deliberately `b1` with the names re-rendered in MCP's wire form and nothing
 * else changed. This arm is the same residency condition as vanilla L4 — Claude
 * Code registers every MCP tool up front, so all 469 schemas are resident on turn
 * one — and the same representation (JSON tool-calling). What differs is the
 * *product*: a different harness, its own system prompt, its own tool loop.
 *
 * So the guidance has to be matched to b1 clause for clause, exactly as b1/b2/b3
 * are matched to each other. If this preamble said anything b1 does not, a
 * claude-code-vs-vanilla difference would be partly a prompt difference, and the
 * one thing this arm exists to isolate — harness, not surface — would be
 * confounded on its first run.
 *
 * The only content that is genuinely new is the tool-name prefix, which the agent
 * cannot guess: Claude Code namespaces MCP tools as `mcp__<server>__<tool>`, and
 * the server is registered as `appworld`.
 */
export const CLAUDE_VARIANTS = {
	c1: {
		note: "L4-equivalent: every MCP tool schema resident; matched to vanilla b1",
		build: ({ toolCount, serverCount }) =>
			[
				"## Your tools",
				"",
				`${toolCount} functions are available to you, covering every API of the`,
				`${serverCount} apps. They come from the \`appworld\` MCP server, so each is`,
				"named `mcp__appworld__<app>__<api>` — `mcp__appworld__spotify__login` is the",
				"Spotify app's login API. Their full parameter schemas are already in front",
				"of you; you do not need to look anything up before calling.",
				"",
				...VANILLA_SHARED_GUIDANCE,
			].join("\n"),
	},
};

export function buildClaudePreamble(variant, ctx) {
	const spec = CLAUDE_VARIANTS[variant];
	if (!spec) throw new Error(`unknown claude-code variant: ${variant} (have ${Object.keys(CLAUDE_VARIANTS)})`);
	return spec.build(ctx);
}
