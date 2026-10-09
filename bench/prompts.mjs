/**
 * Codemode preamble variants.
 *
 * The preamble is the codemode arm's entire interface to its tools, so it is
 * the highest-leverage thing to tune — and the one place where "we measured it"
 * beats "it reads well". Every variant is scored by the same harness on the same
 * fixed task set, so improvements are comparable rather than anecdotal.
 *
 * Add a variant, run `bench/hillclimb.mjs`, keep it if it wins. Record what each
 * one was reacting to; a variant with no hypothesis is not worth a run.
 *
 * SAMPLE SIZE WARNING, measured rather than assumed. The same prompt on the same
 * task, run twice, differed by 29% in turns and 26% in cost. That run-to-run
 * noise is 2-5x larger than any prompt effect observed so far, so a 5-task
 * comparison cannot separate these variants at all. Detecting a 10% effect at
 * 80% power needs roughly 115 paired tasks per variant. Run hillclimb with high
 * --concurrency and repeats, or do not believe the ranking.
 *
 * Standing result so far: every variant that adds guidance has scored at or
 * below the minimal v1 on both cost and judge score. That is not yet significant,
 * but four attempts have now failed to beat "say less".
 */

/** Shared discovery instructions — the part no variant has reason to change. */
function discovery(toolCount, serverCount) {
	return [
		"## Tools",
		"",
		`The \`api/\` directory in your working directory contains ${toolCount} async tool functions`,
		`across ${serverCount} services, generated from their live API schemas.`,
		"",
		"Discover them:",
		"  cat api/INDEX.md              # services and their package names",
		"  cat api/<package>/INDEX.md    # one service's tools",
		"  grep -ril '<keyword>' api/    # search all tool documentation",
		"  cat api/<package>/<tool>.py   # full parameter docs for one tool",
		"",
		"Call them from the ipython tool:",
		"  import api.<package>",
		"  result = await api.<package>.<tool>(...)",
		"",
		"They are coroutines — always await them. Results are strings.",
	];
}

export const VARIANTS = {
	/**
	 * v1 — the original. One line of guidance about holding results in variables.
	 * Baseline for every comparison.
	 */
	v1: {
		note: "original; minimal guidance",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"Hold intermediate results in variables; only print what you need to reason about.",
			].join("\n"),
	},

	/**
	 * v2 — reaction to the v1 trace analysis: 48% of cells made no tool call, the
	 * median cell was 4 lines, and 45% of everything the agent put back into its
	 * own context came from printing local variables. Tried to suppress the
	 * notebook-style print-and-look loop with explicit rules.
	 *
	 * Result on game_trends_000: 17 turns / $0.144 against v1's 12 / $0.107 —
	 * WORSE. Kept as a recorded negative: a long list of prohibitions seems to
	 * cost more than the behaviour it prohibits.
	 */
	v2: {
		note: "explicit anti-notebook rules; measured worse than v1 on first task",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"## Working efficiently",
				"",
				"You are not at an interactive prompt. Every cell costs a full model turn,",
				"and everything you print re-enters your context.",
				"",
				"- Write ONE substantial cell per step: fetch, parse, filter, and summarize",
				"  together. Do not split parsing and printing across turns.",
				"- Keep large results in variables. Print only the small derived answer you",
				"  need to reason about — never a slice of raw data 'to have a look'.",
				"- Fetch independently-needed things concurrently:",
				"    a, b = await asyncio.gather(api.x.one(), api.y.two())",
				"- If you need to check a shape, print `len(x)` or `list(x)[:3]`, not `x[:2000]`.",
				"- Assume your code works. Do not add a verification cell that reprints what",
				"  you just computed.",
			].join("\n"),
	},

	/**
	 * v3 — same diagnosis as v2, opposite technique. Rather than prohibiting the
	 * failure mode, show the shape of a good cell once. Demonstration tends to
	 * transfer better than a rule list, and it is far shorter.
	 *
	 * REJECTED once scored. Cheap, but worse at the task. Paired over 23 cells
	 * against v1:
	 *
	 *   cost      0.77x   t = -3.60   significantly cheaper
	 *   SCORE     -0.40   t = -2.19   significantly WORSE
	 *
	 * It prints 47% less back into context, which is what it was designed to do,
	 * and buys that by doing less of the task. This is the trap in optimizing
	 * cost: a variant can win on every proxy metric by giving up sooner. Rank on
	 * `score`, use cost as a tiebreak.
	 */
	v3: {
		note: "one worked example; 0.77x cost vs v1, t=-3.11, n=24 paired",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"Each cell costs a turn, and whatever you print re-enters your context.",
				"So do a whole step per cell and print only the answer:",
				"",
				"  import asyncio, json",
				"  raw_a, raw_b = await asyncio.gather(api.svc_one.search(q='x'), api.svc_two.list())",
				"  a, b = json.loads(raw_a), json.loads(raw_b)",
				"  merged = [r for r in a['items'] if r['id'] in {x['id'] for x in b['items']}]",
				"  print(len(merged), [r['name'] for r in merged[:5]])",
				"",
				"The large payloads stay in `raw_a`/`raw_b`; only the small result is printed.",
			].join("\n"),
	},

	/**
	 * v4 — targets turn count directly rather than print volume, on the theory
	 * that the two are the same problem: the model takes a small step because it
	 * expects to look at the result before deciding the next one. Giving it an
	 * explicit plan-first instruction may collapse several steps into one.
	 */
	v4: {
		note: "plan-then-execute; targets turn count directly",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"Before writing code, decide the full sequence of calls the task needs.",
				"Then execute as much of that plan as possible in each cell — fetch",
				"everything independent concurrently with `asyncio.gather`, and carry the",
				"results forward in variables.",
				"",
				"Print only what you must read to make the next decision. Large payloads",
				"stay in variables; a slice printed 'to have a look' costs the same as",
				"having never held it in a variable at all.",
			].join("\n"),
	},

	/**
	 * v5 — v3 plus a concurrency push. v3 cut payload size but left turn count
	 * untouched (t=+0.58). Turns are the remaining cost: 48% of cells make no
	 * tool call, and the median cell is 4 lines. If the model fetched everything
	 * independent up front it would collapse several turns into one.
	 */
	v5: {
		note: "v3 + explicit concurrency push at turn count",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"Each cell costs a turn, and whatever you print re-enters your context.",
				"So do a whole step per cell and print only the answer:",
				"",
				"  import asyncio, json",
				"  raw_a, raw_b = await asyncio.gather(api.svc_one.search(q='x'), api.svc_two.list())",
				"  a, b = json.loads(raw_a), json.loads(raw_b)",
				"  merged = [r for r in a['items'] if r['id'] in {x['id'] for x in b['items']}]",
				"  print(len(merged), [r['name'] for r in merged[:5]])",
				"",
				"The large payloads stay in `raw_a`/`raw_b`; only the small result is printed.",
				"",
				"Before your first call, list every piece of data the task needs. Fetch all",
				"of it that does not depend on another result in a single `asyncio.gather`,",
				"then work on what came back. Most tasks need two or three cells, not ten.",
			].join("\n"),
	},

	/**
	 * v6 — v3 plus a direct prohibition on the single largest category of wasted
	 * turns. 39.8% of cells only re-print local variables: the model computes
	 * something, prints it, and looks at it before continuing. v2 showed that a
	 * list of rules backfires, so this adds exactly one rule to the winning
	 * example rather than a list.
	 */
	v6: {
		note: "v3 + one rule against verification prints",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"Each cell costs a turn, and whatever you print re-enters your context.",
				"So do a whole step per cell and print only the answer:",
				"",
				"  import asyncio, json",
				"  raw_a, raw_b = await asyncio.gather(api.svc_one.search(q='x'), api.svc_two.list())",
				"  a, b = json.loads(raw_a), json.loads(raw_b)",
				"  merged = [r for r in a['items'] if r['id'] in {x['id'] for x in b['items']}]",
				"  print(len(merged), [r['name'] for r in merged[:5]])",
				"",
				"The large payloads stay in `raw_a`/`raw_b`; only the small result is printed.",
				"",
				"Never spend a cell checking what you just computed. Parse, filter and",
				"format in the same cell that fetched the data.",
			].join("\n"),
	},

	/**
	 * v7 — v3 with the example doing the *whole* task shape rather than one step.
	 * v2 (rules) lost and v3 (one example) won, which suggests the model imitates
	 * the demonstrated shape closely. If that is right, demonstrating a complete
	 * fetch-to-answer flow should compress the trajectory more than telling it to.
	 *
	 * CURRENT BEST. Paired over 23 cells against v1:
	 *
	 *   cost      0.74x   t = -2.88   significantly cheaper
	 *   turns     -15%
	 *   SCORE     -0.15   t = -0.78   no significant loss
	 *
	 * and against v3, score +0.24 (t = +2.01). So v7 gets v3's savings without
	 * v3's quality regression — the whole-task example compresses the trajectory
	 * rather than truncating the work.
	 */
	v7: {
		note: "whole-task example; 0.74x cost vs v1 with no score loss — current best",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"Each cell costs a turn, and whatever you print re-enters your context.",
				"A whole task usually fits in two cells. First, find the tools and fetch",
				"everything independent at once:",
				"",
				"  import asyncio, json",
				"  import api.svc_one, api.svc_two",
				"  raw_a, raw_b = await asyncio.gather(api.svc_one.search(q='x'), api.svc_two.list())",
				"  a, b = json.loads(raw_a), json.loads(raw_b)",
				"  print(len(a['items']), len(b['items']), list(a['items'][0]))",
				"",
				"Then derive the answer and print only that:",
				"",
				"  ids = {x['id'] for x in b['items']}",
				"  merged = sorted((r for r in a['items'] if r['id'] in ids), key=lambda r: -r['score'])",
				"  for r in merged[:10]:",
				"      print(r['name'], r['score'])",
				"",
				"The large payloads never leave `raw_a`/`raw_b`.",
			].join("\n"),
	},

	/**
	 * v8 — teach the REPL's mental model rather than efficiency rules.
	 *
	 * v2/v4 (rules) lost; v3 (a worked example) won. But every variant so far has
	 * been about *economy* — print less, batch more. None told the model what the
	 * environment actually is: a kernel whose state survives between turns.
	 *
	 * The trace evidence says it does not know. It re-prints data it already
	 * holds, re-parses payloads it already parsed, and takes 4-line steps as if
	 * each cell were a fresh shell. A model that trusts its own state can hold a
	 * 182k-character payload in a variable and slice it repeatedly for free, and
	 * can recover from a failed cell without re-fetching anything.
	 *
	 * This is the hypothesis the project is actually about: the REPL is not a
	 * faster bash, it is memory the context window does not have to pay for.
	 */
	v8: {
		note: "teaches persistent kernel state, not economy rules",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"## The kernel",
				"",
				"This is one long-lived IPython kernel, not a fresh shell per cell.",
				"Everything you bind stays alive for the whole task:",
				"",
				"  raw = await api.svc.get_everything()   # 200k characters, in a variable",
				"  data = json.loads(raw)                  # parsed once, reusable",
				"  print(len(data['items']))               # 1 line reaches your context",
				"",
				"`raw` and `data` are still there next turn. You never re-fetch and never",
				"re-parse. Slice them as many times as you like — that costs nothing,",
				"because only what you print enters your context.",
				"",
				"This is the whole advantage: large results live in the kernel, and your",
				"context holds only the conclusions you drew from them. Fetching a big",
				"payload and then printing it back defeats the point entirely.",
				"",
				"If a cell raises, everything from earlier cells is untouched — fix the",
				"line and continue from the variables you already have.",
				"",
				"Define a helper once and reuse it. Fetch independent things together",
				"with `asyncio.gather`. Print only what you need to decide the next step.",
			].join("\n"),
	},

	/**
	 * v9 — collapse discovery into one cell.
	 *
	 * Trace of v7 (18 runs, 231 cells): the first three cells are discovery in
	 * 18/18, 18/18 and 14/18 runs — root index, then a server index, then a tool
	 * file — before any work begins. Discovery is 24% of all cells and it is
	 * purely mechanical.
	 *
	 * Every server's INDEX.md already lists each tool's full signature, so one
	 * glob over them yields everything needed to start, and the per-tool module
	 * is only worth opening when a parameter is genuinely unclear. That trades
	 * ~3 turns for ~1.5k tokens of index text, which at these turn costs is a
	 * good trade.
	 */
	v9: {
		note: "v7 + one-cell discovery via glob over INDEX.md",
		build: ({ toolCount, serverCount }) =>
			[
				"## Tools",
				"",
				`The \`api/\` directory holds ${toolCount} async tool functions across ${serverCount} services,`,
				"generated from their live API schemas.",
				"",
				"Start by reading every service index in ONE cell:",
				"",
				"  import glob",
				"  for f in sorted(glob.glob('api/*/INDEX.md')):",
				"      print(open(f).read())",
				"",
				"That gives you every tool's full signature. Only open",
				"`api/<package>/<tool>.py` if a parameter is still unclear after that.",
				"",
				"Each cell costs a turn, and whatever you print re-enters your context.",
				"After discovery, a task usually needs two more cells. Fetch everything",
				"independent at once:",
				"",
				"  import asyncio, json",
				"  import api.svc_one, api.svc_two",
				"  raw_a, raw_b = await asyncio.gather(api.svc_one.search(q='x'), api.svc_two.list())",
				"  a, b = json.loads(raw_a), json.loads(raw_b)",
				"  print(len(a['items']), len(b['items']), list(a['items'][0]))",
				"",
				"Then derive the answer and print only that:",
				"",
				"  ids = {x['id'] for x in b['items']}",
				"  merged = sorted((r for r in a['items'] if r['id'] in ids), key=lambda r: -r['score'])",
				"  for r in merged[:10]:",
				"      print(r['name'], r['score'])",
				"",
				"The large payloads never leave `raw_a`/`raw_b`. They persist across cells,",
				"so you never re-fetch or re-parse.",
			].join("\n"),
	},

	/**
	 * q1 — target the worst-scoring dimension directly.
	 *
	 * v7's rubric breakdown (n=24): parallelism_and_efficiency 2.99, fulfilment
	 * 4.81, dependency 4.83, tool-fit 5.35, params 6.18, grounding 6.47. The
	 * efficiency dimension has 7.01 of headroom — more than double any other —
	 * and MCP-Bench scores it on redundant calls and on whether parallelizable
	 * work was actually parallelized, which `asyncio.gather` makes trivial.
	 * Moving it 3 -> 8 is worth ~0.83 of overall score on its own.
	 */
	q1: {
		note: "attack parallelism_and_efficiency, the worst dimension",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"You are scored on avoiding redundant calls and on running independent",
				"work concurrently. Both are easy here and both are usually missed.",
				"",
				"Plan the full set of calls before the first one. Group them into waves:",
				"everything that does not depend on another result goes in one",
				"`asyncio.gather`; only genuinely dependent calls wait for a later wave.",
				"",
				"  import asyncio, json",
				"  a, b, c = await asyncio.gather(",
				"      api.svc_one.search(q='x'),",
				"      api.svc_two.list(),",
				"      api.svc_three.details(id=7),",
				"  )",
				"  ids = [r['id'] for r in json.loads(a)['items'][:20]]",
				"  details = await asyncio.gather(*[api.svc_one.get(id=i) for i in ids])",
				"",
				"Never call the same tool twice with the same arguments — results persist",
				"in variables, so reuse them. Fan out over a list with `gather`, never in",
				"a loop of separate cells.",
			].join("\n"),
	},

	/**
	 * q2 — target completion and dependency handling.
	 *
	 * Fulfilment 4.81 means roughly half of each task's stated requirements are
	 * met. MCP-Bench tasks are explicitly multi-part and numbered, and are scored
	 * against that structure, so enumerating the parts and checking them off
	 * before answering should convert directly into fulfilment and dependency
	 * score.
	 */
	q2: {
		note: "enumerate requirements, verify each before answering",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"These tasks are multi-part and you are scored on how many parts you",
				"actually complete, not on how good the answer sounds.",
				"",
				"First, write out every distinct requirement in the request as a numbered",
				"list, including the ones stated as asides or conditionals. Note which",
				"depend on the output of another.",
				"",
				"Work through them in dependency order. Before you answer, go back over",
				"your list and confirm each item is addressed with data you actually",
				"retrieved. If a requirement could not be met, say so explicitly rather",
				"than omitting it.",
				"",
				"Every claim must trace to a tool result. Do not fill gaps from memory.",
			].join("\n"),
	},

	/**
	 * q3 — q1 and q2 together, on the theory that they target disjoint dimensions
	 * (efficiency vs fulfilment/dependency) and should compose rather than
	 * interfere. v2 showed long prompts can backfire, so this is the test of
	 * whether that was length or content.
	 */
	q3: {
		note: "q1 + q2 combined",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"These tasks are multi-part and you are scored on how many parts you",
				"complete, on grounding every claim in a tool result, and on avoiding",
				"redundant or needlessly serial calls.",
				"",
				"Start by writing every requirement in the request as a numbered list,",
				"marking which depend on another's output.",
				"",
				"Then fetch. Everything independent goes in one `asyncio.gather`:",
				"",
				"  import asyncio, json",
				"  a, b = await asyncio.gather(api.svc_one.search(q='x'), api.svc_two.list())",
				"  ids = [r['id'] for r in json.loads(a)['items'][:20]]",
				"  details = await asyncio.gather(*[api.svc_one.get(id=i) for i in ids])",
				"",
				"Results persist in variables — never call the same tool twice with the",
				"same arguments, and never loop over separate cells to fan out.",
				"",
				"Before answering, check your numbered list item by item against data you",
				"actually retrieved. State explicitly anything you could not determine.",
			].join("\n"),
	},

	/**
	 * q4 — compose the per-dimension winners, kept short.
	 *
	 * Measured leaders (0-1): q1 owns fulfilment 0.502, tool-fit 0.630, params
	 * 0.688 and parallelism 0.453; q2 owns grounding 0.704. q3 concatenated both
	 * and beat neither, which — with v2's failure — suggests length itself costs
	 * something. So this takes q1 whole and adds only q2's grounding demand and
	 * its one-line requirement sweep, rather than both prompts end to end.
	 */
	q4: {
		note: "q1 + q2's grounding demand, kept tight",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"You are scored on completing every part of the request, on grounding each",
				"claim in a tool result, and on avoiding redundant or needlessly serial calls.",
				"",
				"Plan the full set of calls before the first one. Group them into waves:",
				"everything that does not depend on another result goes in one",
				"`asyncio.gather`; only genuinely dependent calls wait for a later wave.",
				"",
				"  import asyncio, json",
				"  a, b, c = await asyncio.gather(",
				"      api.svc_one.search(q='x'),",
				"      api.svc_two.list(),",
				"      api.svc_three.details(id=7),",
				"  )",
				"  ids = [r['id'] for r in json.loads(a)['items'][:20]]",
				"  details = await asyncio.gather(*[api.svc_one.get(id=i) for i in ids])",
				"",
				"Never call the same tool twice with the same arguments — results persist",
				"in variables, so reuse them. Fan out over a list with `gather`, never in",
				"a loop of separate cells.",
				"",
				"Before answering, check the request part by part and confirm each is",
				"covered by data you actually retrieved. Never fill a gap from memory —",
				"say explicitly what you could not determine.",
			].join("\n"),
	},

	/**
	 * q5 — q1 plus a rule against silent substitution.
	 *
	 * Measured failure: 34% of codemode answers substitute a different resource
	 * for the one asked about, and present it as equivalent. The worst run in the
	 * whole set does exactly this — asked to compare pagination across openai,
	 * github and cloudflare, it errored on cloudflare and silently swapped in
	 * Hugging Face, NixOS and DEX Paprika as "the closest analog", scoring 2.7/10
	 * on fulfilment.
	 *
	 * This is not a laziness failure; the agent works hard and writes a confident
	 * answer. It is a failure to treat "I could not get X" as a reportable result
	 * rather than a problem to route around. Grounding stays high because the
	 * substitutes *are* backed by tool output — which is why the rubric catches it
	 * only on fulfilment.
	 */
	q5: {
		note: "q1 + report gaps instead of substituting",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"You are scored on avoiding redundant calls and on running independent",
				"work concurrently. Both are easy here and both are usually missed.",
				"",
				"Plan the full set of calls before the first one. Group them into waves:",
				"everything that does not depend on another result goes in one",
				"`asyncio.gather`; only genuinely dependent calls wait for a later wave.",
				"",
				"  import asyncio, json",
				"  a, b, c = await asyncio.gather(",
				"      api.svc_one.search(q='x'),",
				"      api.svc_two.list(),",
				"      api.svc_three.details(id=7),",
				"  )",
				"  ids = [r['id'] for r in json.loads(a)['items'][:20]]",
				"  details = await asyncio.gather(*[api.svc_one.get(id=i) for i in ids])",
				"",
				"Never call the same tool twice with the same arguments — results persist",
				"in variables, so reuse them. Fan out over a list with `gather`, never in",
				"a loop of separate cells.",
				"",
				"Answer the question that was asked. If a specific thing is requested and",
				"you cannot retrieve it — the call errors, or nothing available covers it —",
				"retry once, then say plainly that you could not get it. Do NOT quietly",
				"analyse a different service, dataset or entity in its place and present",
				"that as the answer. A partial answer with an explicit gap scores far",
				"better than a complete-looking answer about the wrong thing.",
			].join("\n"),
	},

	/**
	 * q6 — q1 plus an explicit results ledger.
	 *
	 * Measured: 29% of all MCP calls in a run are byte-identical repeats, and 19
	 * of 40 runs contain at least one. The judge notices — "get_platform_usage
	 * was called 4 times for each of the 6 platforms", "the reference task
	 * required only 2 calls" against 61 made — and it is the single largest score
	 * gap (parallelism_and_efficiency 0.422).
	 *
	 * q1 already forbids this in words and it changes nothing, because the model
	 * cannot see what it already fetched: its only record is the transcript of
	 * code it wrote. So give it a structure to look at instead of an instruction
	 * to remember.
	 */
	q6: {
		note: "q1 + an explicit results ledger the model can inspect",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"You are scored on avoiding redundant calls and on running independent",
				"work concurrently.",
				"",
				"Keep every result in one dict, keyed by what produced it, and consult it",
				"before fetching. You cannot remember across turns what you already have —",
				"but you can look:",
				"",
				"  import asyncio, json",
				"  R = {}                       # results ledger; survives every turn",
				"",
				"  async def fetch(key, coro):",
				"      if key not in R:",
				"          R[key] = json.loads(await coro)",
				"      return R[key]",
				"",
				"  await asyncio.gather(",
				"      fetch('svc_one:x', api.svc_one.search(q='x')),",
				"      fetch('svc_two:list', api.svc_two.list()),",
				"  )",
				"  print(sorted(R))             # what you already have — check this first",
				"",
				"Fan out over a list with `gather`, never in a loop of separate cells.",
				"Plan the whole set of calls before the first one: everything independent",
				"goes in one wave, only genuinely dependent calls wait.",
			].join("\n"),
	},

	/**
	 * q7 — state persistence plainly, and point at the introspection that exists.
	 *
	 * The largest score gap is parallelism_and_efficiency (0.422), and reading the
	 * judge's reasoning it is almost entirely redundancy, not serialization: 29%
	 * of all MCP calls are byte-identical repeats, and the judge notices
	 * ("get_platform_usage called 4 times for each of 6 platforms"; "the reference
	 * task required only 2 calls" against 61 made).
	 *
	 * q1 forbids this in words and it changes nothing, because the model has no
	 * way to see what it already fetched — its only record is the transcript of
	 * code it wrote. Two fixes, both concrete rather than exhortative:
	 *
	 *   1. Say the kernel is persistent, in one unambiguous sentence.
	 *   2. Name `%whos`, which lists every live variable. IPython has always had
	 *      it; nothing had told the model it could look.
	 *
	 * Deliberately avoids v8's mistake of calling operations "free": that is true
	 * of context and false of turns, and v8 came back +24% on turns.
	 */
	q7: {
		note: "explicit persistence + %whos introspection; targets the 29% duplicate-call rate",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"## The kernel is persistent",
				"",
				"Every cell runs in the SAME long-lived IPython session. Any top-level",
				"variable you bind stays available in every later cell, for the whole task.",
				"Data you have already fetched is still in memory — you never need to",
				"fetch it twice.",
				"",
				"You will not remember across turns what you already have. So look:",
				"",
				"  %whos                        # every live variable, with its type and size",
				"",
				"Run that before fetching anything you might already hold. Re-requesting",
				"data you already have is the single most common mistake here, and it is",
				"scored against you directly.",
				"",
				"## Fetching",
				"",
				"Plan the full set of calls before the first one. Everything that does not",
				"depend on another result goes in ONE `asyncio.gather`; only genuinely",
				"dependent calls wait for a later wave.",
				"",
				"  import asyncio, json",
				"  a, b, c = await asyncio.gather(",
				"      api.svc_one.search(q='x'),",
				"      api.svc_two.list(),",
				"      api.svc_three.details(id=7),",
				"  )",
				"  ids = [r['id'] for r in json.loads(a)['items'][:20]]",
				"  details = await asyncio.gather(*[api.svc_one.get(id=i) for i in ids])",
				"",
				"Fan out over a list with `gather`, never in a loop of separate cells.",
				"Bind every result to a name so a later cell can reuse it.",
			].join("\n"),
	},

	/**
	 * q8 — q7 with the fan-out bounded.
	 *
	 * On the full grounded set codemode *loses* parallelism_and_efficiency
	 * (-0.069, t=-3.42), the only dimension where it trails. Cause: it makes 99.2
	 * MCP calls per task against vanilla's 22.7, and on collection-shaped tasks
	 * far worse — 429 calls where vanilla used 10, at a 52% duplicate rate.
	 *
	 * This is q7's own instruction misfiring. "Fan out over a list with gather,
	 * never in a loop of separate cells" fixed serialization on small tasks and,
	 * given a large collection, became unbounded enumeration. `gather` makes
	 * breadth free to *write*, which is exactly why it needs a stated limit.
	 *
	 * Note this was invisible on the fast subset, where it measured +0.15 the
	 * other way: fast tasks are fast partly because they need few calls.
	 */
	q8: {
		note: "q7 + bounded fan-out; fixes the 99-calls-per-task regression",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"## The kernel is persistent",
				"",
				"Every cell runs in the SAME long-lived IPython session. Any top-level",
				"variable you bind stays available in every later cell, for the whole task.",
				"Data you have already fetched is still in memory — you never need to",
				"fetch it twice.",
				"",
				"You will not remember across turns what you already have. So look:",
				"",
				"  %whos                        # every live variable, with its type and size",
				"",
				"## Fetching",
				"",
				"Plan the full set of calls before the first one. Everything that does not",
				"depend on another result goes in ONE `asyncio.gather`; only genuinely",
				"dependent calls wait for a later wave.",
				"",
				"  import asyncio, json",
				"  a, b = await asyncio.gather(api.svc_one.search(q='x'), api.svc_two.list())",
				"  ids = [r['id'] for r in json.loads(a)['items']][:15]",
				"  details = await asyncio.gather(*[api.svc_one.get(id=i) for i in ids])",
				"",
				"Keep the fan-out bounded. `gather` makes breadth cheap to write and it is",
				"not cheap to run: you are scored on making the FEWEST calls that answer the",
				"question, not the most. Before expanding a list into calls, slice it —",
				"ten to twenty items is almost always enough to support an answer, and",
				"enumerating an entire collection is scored as redundancy.",
				"",
				"If a first sample turns out not to answer the question, fetch more then.",
				"Do not fetch broadly in case you need it.",
			].join("\n"),
	},

	/**
	 * q9 — thoroughness-first, the opposite pressure to q8.
	 *
	 * Every variant so far has pushed toward economy: q8 says "bound the fan-out",
	 * "ten to twenty items is enough", "do not fetch broadly in case you need it".
	 * That produced parity with Claude Code (0.703 vs 0.711, t=-0.50) at a fifth
	 * of the cost — $0.41 against $2.08, 14 turns against 77.
	 *
	 * Claude Code buys its score with exploration. Nothing has tested what codemode
	 * does when told to spend rather than save, so the ceiling is unmeasured. The
	 * fan-out bound stays (unbounded enumeration was a real failure, -0.069 on
	 * parallelism); what changes is that verification and coverage are now
	 * explicitly worth turns.
	 *
	 * Expected to cost more. The question is only whether it scores higher.
	 */
	q9: {
		note: "thoroughness-first; tests the score ceiling rather than the cost floor",
		build: ({ toolCount, serverCount }) =>
			[
				...discovery(toolCount, serverCount),
				"",
				"## The kernel is persistent",
				"",
				"Every cell runs in the SAME long-lived IPython session. Any top-level",
				"variable you bind stays available in every later cell. You never need to",
				"fetch the same thing twice — check `%whos` before re-fetching.",
				"",
				"## Getting it right",
				"",
				"You are scored on how much of the request you actually complete and on",
				"whether every claim traces to a tool result. Completeness matters more",
				"than brevity: an extra call that confirms something is worth making.",
				"",
				"Work like this:",
				"",
				"1. Write out every distinct requirement in the request, including the",
				"   ones phrased as asides or conditionals. Note which depend on others.",
				"2. Fetch. Everything independent goes in one `asyncio.gather`:",
				"",
				"     a, b = await asyncio.gather(api.svc_one.search(q='x'), api.svc_two.list())",
				"     ids = [r['id'] for r in json.loads(a)['items']][:20]",
				"     details = await asyncio.gather(*[api.svc_one.get(id=i) for i in ids])",
				"",
				"   Slice before expanding a list into calls — twenty items is usually",
				"   plenty, and enumerating a whole collection is scored as redundancy.",
				"3. Check your list item by item against what you actually retrieved.",
				"   Anything unconfirmed, go back and confirm it. Anything you could not",
				"   determine, say so explicitly rather than omitting or substituting.",
				"",
				"Do not stop at the first plausible answer. Stop when every requirement",
				"is either satisfied by retrieved data or explicitly reported as unmet.",
			].join("\n"),
	},

	/**
	 * q10 — q8, described from the tree it ships with rather than from MCP-Bench's.
	 *
	 * q8's discovery lines name the per-method tree, the ipython tool and string
	 * results, and its fan-out bound is phrased as scoring. A port running the
	 * consolidated, typed tree had to rewrite those lines by pattern match (the product
	 * `shared/codemode/compile.mjs`), so every q8 edit risked breaking it. q10 reads
	 * the layout, the tool name and the result type from `generate()`'s
	 * `promptContext` instead, and drops the scoring language.
	 *
	 * Added from the product preamble ((product source)
	 * surface.py), each against a measured habit:
	 *  - read ONE API's docs with `grep -n -A30 'def <api>('`: 72% of rounds `cat` a
	 *    whole module (H54, generate.mjs renderRootIndex), ~16k tokens re-read on
	 *    every later turn;
	 *  - top-level `await`, not `asyncio.run`;
	 *  - an ArgumentError already carries the fix (only when arguments are checked);
	 *  - print slices, and a cell is a program: dependent calls chain in one cell;
	 *  - asset ids and `wait_for`, only when the tree has the wait surface.
	 *
	 * Unmeasured as of its introduction; q8 stays the default until a run ranks it.
	 */
	q10: {
		note: "q8 made layout- and tool-aware from generate()'s promptContext; adds the product preamble's measured cell habits",
		build: (ctx) => q10(ctx),
	},
};

/** The q10 preamble. `ctx` is generate()'s `promptContext` plus `toolName`. */
function q10({
	toolCount,
	serverCount,
	moduleCount = serverCount,
	toolName = "ipython",
	apiLayout = "per-method",
	moduleIndex = false,
	typedReturns = false,
	validateArgs = false,
	waitSurface = false,
	waitCalls = null,
}) {
	const consolidated = apiLayout === "consolidated";
	const unit = consolidated ? "module" : "package";
	const find = [
		["!cat api/INDEX.md", `every ${unit} and what it holds`],
		["!grep -ril '<keyword>' api/", "search all API documentation"],
		...(consolidated
			? [
					...(moduleIndex ? [["!head -60 api/<module>.py", "one module's APIs, one line each with its signature"]] : []),
					["!grep -n -A30 'def <api>(' api/<module>.py", "one API's full docs"],
				]
			: [
					["!cat api/<package>/INDEX.md", "one package's APIs"],
					["!cat api/<package>/<api>.py", "one API's full docs"],
				]),
	];
	const width = Math.max(...find.map(([cmd]) => cmd.length));
	const sample = typedReturns ? "ids = [r.id for r in a.results][:15]" : "ids = [r['id'] for r in json.loads(a)['results']][:15]";
	return [
		"## Tools",
		"",
		`The \`api/\` directory in your working directory holds ${toolCount} async API function${toolCount === 1 ? "" : "s"}`,
		`in ${moduleCount} ${unit}${moduleCount === 1 ? "" : "s"}, generated from their schemas.`,
		"",
		"Find one (a cell runs a shell command prefixed with `!`):",
		...find.map(([cmd, what]) => `  ${cmd.padEnd(width)}   # ${what}`),
		...(consolidated
			? ["", "Read one API's block, not the whole module: a module holds many APIs, and", "everything you print is re-read on every later turn. A signature alone is not", "enough for a nested argument; read its block."]
			: []),
		"",
		`Call them from the ${toolName} tool. \`await\` works at the top level of a cell —`,
		"do not wrap calls in `asyncio.run(...)` or a helper function:",
		`  import api.<${unit}>`,
		`  result = await api.<${unit}>.<api>(...)`,
		"",
		typedReturns
			? "Results are typed objects: fields are attributes (`r.results`), dict access works too, and `.raw` is the whole payload."
			: "Results are the server's text, usually JSON: `json.loads` it before indexing.",
		...(validateArgs
			? ["", "An `ArgumentError` already contains the fix: it names the argument, its schema and,", "for a nested one, an example literal. Correct the call from the message rather than", "retrying variations blind."]
			: []),
		"",
		"## The kernel is persistent",
		"",
		"Every cell runs in the SAME long-lived IPython session. Any top-level",
		"variable you bind stays available in every later cell, for the whole task.",
		"Data you have already fetched is still in memory — you never need to",
		"fetch it twice.",
		"",
		"You will not remember across turns what you already have. So look:",
		"",
		"  %whos                        # every live variable, with its type and size",
		"",
		"## A cell is a program",
		"",
		"Put independent calls in ONE `asyncio.gather`, and chain the calls that depend",
		"on them in the same cell: two calls in one cell cost one turn, in two cells two,",
		"and each turn re-reads everything above it. Print slices and summaries, never",
		"whole payloads.",
		"",
		`  import asyncio${typedReturns ? "" : ", json"}`,
		`  a, b = await asyncio.gather(api.<${unit}>.search(q='x'), api.<other>.list())`,
		`  ${sample}`,
		`  details = await asyncio.gather(*[api.<${unit}>.get(id=i) for i in ids])`,
		"  print(len(details), details[0])",
		"",
		"Keep the fan-out bounded: `gather` makes breadth cheap to write, not cheap to",
		"run. Make the fewest calls that answer the question. Slice a list before",
		"expanding it into calls — ten to twenty items is almost always enough — and",
		"fetch more only if a first sample does not answer the question.",
		...(waitSurface ? ["", ...waitBlock({ unit, typedReturns, readCall: waitCalls?.read ?? null })] : []),
	].join("\n");
}

/** q10's asset-id and waiting section, for a tree that has the wait surface. */
function waitBlock({ unit, typedReturns, readCall }) {
	return [
		"## Asset ids and waiting",
		"",
		"A call that makes something returns as soon as the work is submitted, with the",
		typedReturns
			? "output's asset id. Pass the result straight on: it works wherever an id is expected"
			: "output's asset id in its result. Pass that id on wherever an id is expected",
		"(`references=[img]`). A call that needs a finished input waits for it, or raises",
		"`NotReady` naming what to wait for. Submit, then wait for everything in ONE call:",
		"",
		...(typedReturns
			? [
					"  import asyncio",
					`  made = await asyncio.gather(*[api.<${unit}>.<make>(prompt=p) for p in prompts])`,
					"  print(made)                      # every asset id, available at once",
					"  await api.wait_for(made)         # one wait for everything",
				]
			: [
					"  import asyncio, json",
					`  made = await asyncio.gather(*[api.<${unit}>.<make>(prompt=p) for p in prompts])`,
					"  ids = [json.loads(m)['<id field>'] for m in made]",
					"  print(ids)                       # every asset id, available at once",
					"  await api.wait_for(ids)          # one wait for everything",
				]),
		"",
		"Time only passes when you LOOK at something. `wait_for` takes several ids at once,",
		"waits in place up to about 100 s (most work finishes inside that), and prints each",
		"asset's type and size once it is ready. Wait before you judge or describe an",
		"output, and before you say it is done. If it is still not ready, the cell ends",
		"there: call `wait_for` again, or end your turn and you are woken when it is ready.",
		...(readCall ? ["", `To look at an asset, call \`${readCall}\` with its id.`] : []),
	];
}










/** Build a preamble for a named variant. Throws on an unknown name. */
export function buildPreamble(variant, ctx) {
	const spec = VARIANTS[variant];
	if (!spec) throw new Error(`unknown prompt variant: ${variant} (have: ${Object.keys(VARIANTS).join(", ")})`);
	return spec.build(ctx);
}

export const VARIANT_NAMES = Object.keys(VARIANTS);

/**
 * Vanilla preamble variants.
 *
 * The codemode arm was given a preamble from the start and the vanilla arm was
 * given an empty string, which measured "which representation survives having no
 * instructions" rather than which architecture is better. Each arm needs to be
 * told how to use its own tool surface well; the comparison worth making is
 * best-against-best, not stripped-against-stripped.
 *
 * Vanilla's efficiency lever is the mirror of codemode's `asyncio.gather`:
 * several independent tool calls issued in a single assistant turn. Nothing had
 * ever told it that.
 */
/**
 * The two efficiency levers, shared by every vanilla variant that gets guidance.
 *
 * Shared as one constant rather than copied into each variant so that a change to
 * the guidance cannot land in one cell of the 2x2 and not the other — which is
 * precisely the confound w3 exists to remove.
 */
const VANILLA_EFFICIENCY_GUIDANCE = [
	"Two things make a large difference here:",
	"",
	"1. Issue independent calls together in ONE turn. If you need a park's",
	"   details and its weather, call both in the same turn rather than waiting",
	"   for the first. Only chain calls when one genuinely needs the other's",
	"   output.",
	"2. Every result you request enters your context in full. Prefer the",
	"   narrowest call that answers the question — pass limits and filters when",
	"   the tool accepts them, and do not fetch a broad listing when you already",
	"   know the specific id you need.",
	"",
	"Ground every claim in something a tool returned.",
];

export const VANILLA_VARIANTS = {
	/** w1 — no guidance. What the arm had until now; kept as the baseline. */
	w1: {
		note: "no guidance (original)",
		build: () => "",
	},

	/**
	 * w2 — the counterpart to codemode's v3: name the arm's efficiency lever and
	 * show it once, rather than listing rules. v3's measured win came from
	 * returning less into context per turn, so the same idea is applied here —
	 * request narrowly, and batch independent calls into one turn.
	 */
	w2: {
		note: "parallel calls + selective retrieval, shown once",
		build: ({ toolCount }) =>
			[
				"## Tools",
				"",
				`You have ${toolCount} tools, named \`Service__operation\`. Their full parameter`,
				"schemas are already in your context — you do not need to look anything up.",
				"",
				...VANILLA_EFFICIENCY_GUIDANCE,
			].join("\n"),
	},

	/**
	 * w3 — w2's counterpart for deferred schemas (vanilla L1).
	 *
	 * Added 2026-08-11 for the MCP-Bench 2x2. Without it the tools row was
	 * confounded: the L1 cell returned its own preamble early and so never received
	 * w2's efficiency guidance, while the L4 cell did. That difference sits on the
	 * same axis the 2x2 varies, so any gap between the two cells would have been
	 * part residency and part missing instructions, with no way to separate them.
	 *
	 * The two levers are shared verbatim with w2 via VANILLA_EFFICIENCY_GUIDANCE;
	 * only the retrieval paragraph differs, because it must describe a different
	 * mechanism — w2's "already in your context" is simply false here.
	 */
	w3: {
		note: "w2's guidance, for deferred schemas (L1)",
		build: ({ toolCount }) =>
			[
				"## Tools",
				"",
				`${toolCount} tools are available, named \`Service__operation\`. Their names are`,
				"listed below; their parameter schemas are not, to keep this prompt small.",
				"",
				"Two steps. Get a schema, then call through the dispatcher:",
				"",
				'  describe_tool(names=["Some_Server__some_tool"])',
				'  call_tool(name="Some_Server__some_tool", arguments={...})',
				"",
				"`describe_tool` returns the exact JSON Schema — ask for several at once.",
				"`search_tools(query=...)` matches names and one-line summaries. You only",
				"need to describe a tool once; after that call it directly.",
				"",
				...VANILLA_EFFICIENCY_GUIDANCE,
			].join("\n"),
	},
};

export const VANILLA_VARIANT_NAMES = Object.keys(VANILLA_VARIANTS);

/** Build a vanilla preamble. Throws on an unknown name. */
export function buildVanillaPreamble(variant, ctx) {
	const spec = VANILLA_VARIANTS[variant];
	if (!spec) {
		throw new Error(`unknown vanilla variant: ${variant} (have: ${VANILLA_VARIANT_NAMES.join(", ")})`);
	}
	return spec.build(ctx);
}
