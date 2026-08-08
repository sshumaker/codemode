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
	 */
	v3: {
		note: "one worked example instead of a rule list",
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
};

/** Build a preamble for a named variant. Throws on an unknown name. */
export function buildPreamble(variant, ctx) {
	const spec = VARIANTS[variant];
	if (!spec) throw new Error(`unknown prompt variant: ${variant} (have: ${Object.keys(VARIANTS).join(", ")})`);
	return spec.build(ctx);
}

export const VARIANT_NAMES = Object.keys(VARIANTS);
