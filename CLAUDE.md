# harness — working notes

## Never hand-roll a benchmark run

There is exactly one iteration command. Use it.

```bash
npm run iterate -- --variants v7,v10          # ~5 min, unjudged, cost/turns only
npm run iterate -- --variants v7,v10 --judge  # ~8 min, adds the MCP-Bench score
```

Do not invoke `bench/run-task.mjs` in a shell loop, do not spawn `bench/judge.mjs`
per run, and do not pick concurrency by hand. Every one of those has already cost
45 minutes of wall-clock in this project:

- a sequential bash loop over tasks (should have been `pool()`),
- `judge.mjs` spawned once per run with `--concurrency 1`, which serialized the
  entire scoring stage and took longer than the runs it was scoring,
- concurrency left at the default while the API key comfortably supports 48+.

`bench/quick.mjs` enforces the right shape and refuses obviously wrong settings.

## The objective is the score, not the cost

MCP-Bench asks whether the task was completed with the right tools. Turns and
cost are cheap proxies worth watching, but a variant can be cheaper simply
because it gave up sooner. **Rank by `score`/`fulfil`; use cost as a tiebreak.**
Several hours went into optimizing cost before this was checked.

## Sample size: ~27% run-to-run noise

The same prompt on the same task, run twice, differed by 29% in turns and 26% in
cost. Anything under ~20 paired cells cannot rank two variants — an early 5-task
comparison ranked v3 *worse* when 24 cells later showed it significantly better.

Prefer `--repeat 4` over more tasks. Always run the paired t-test, never eyeball
the means.

## Before trusting any result

```bash
node bench/validate.mjs      # residency, rate limits, network bypass, judge noise
npm test                     # 141 tests, fairness invariants included
```

Confounds that already invalidated whole result sets, each now pinned by a test
in `bench/test/fairness.test.mjs`:

- the vanilla arm reaching APIs with `curl`, bypassing the tools under test
- the two arms receiving base system prompts differing 10x in length
- single-sample LLM judging, whose noise matched the effect being claimed
- a rate-limited server returning 429s as *successful* MCP responses
- a runId scheme change silently overwriting already-reported runs

## Both arms get real guidance

Each arm is told how to use its own tool surface — codemode via
`VARIANTS`, vanilla via `VANILLA_VARIANTS` in `bench/prompts.mjs`. Stripping one
arm's guidance to "make it fair" measures which representation survives a bad
prompt, which is not a question anyone cares about. Level up, not down.

## Record negative results

`bench/prompts.mjs` keeps every variant that lost, with its measured numbers and
why it was expected to win. v2 (rules) and v8 ("slicing costs nothing", which is
true for context and false for turns) are more informative than the winners.

## Never cache tool results transparently

Deduplicating identical MCP calls in `_client.py` looks like free efficiency —
29% of calls in a run are byte-identical repeats — and it is not safe.
**Read-only is not idempotent.** Reddit hot threads, Steam trending and market
prices change between calls, so a cache serves stale data the model then reasons
over; for any server with side effects it is simply wrong.

Deduplication is the agent's judgement call, per tool, which is what the `q6`
ledger prompt asks for. Do not move it into the transport.
