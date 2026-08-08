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
	 * WINNER, and the first prompt change with a significant effect. Paired over
	 * 24 (task, repeat) cells against v1:
	 *
	 *   cost            0.77x geometric mean   t = -3.11   better on 16/24
	 *   turns           +1.0                   t = +0.58   (no effect)
	 *   text printed    47% less back into context
	 *
	 * The win is entirely in payload size per turn, not in turn count — exactly
	 * the mechanism the example demonstrates. An earlier 5-task comparison ranked
	 * v3 *worse*; that sample was far below the noise floor. Verified with
	 * `bench/quick.mjs --variants v1,v3 --repeat 4 --concurrency 48`.
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
	 */
	v7: {
		note: "v3 but the example spans the whole task, not one step",
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
};


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
