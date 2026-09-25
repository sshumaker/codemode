# Decision: repair the scoring defects, control for the environment defects

Closes the open question in task #85 — "repair MCP-Bench's five instrument
defects, or control for them". Companion to `MCPBENCH-INSTRUMENT-SCAN.md`
(the six-cluster survey), `MCPBENCH-HF-ENCODING-DEFECT.md`,
`MCPBENCH-TIMEOUT-SCORING-DEFECT.md` and `MCPBENCH-TIMEOUT-TRUNCATION.md`.

## The rule that decides it

The question was framed as one choice over five defects. It is two choices, and
the line between them is not severity or ownership — it is **whether the defect
lives in the scoring path or in the environment.**

> **A scoring-path defect can be repaired RETROACTIVELY without splitting the
> corpus, because the score is re-derived from stored traces. An environment
> defect cannot: fixing it changes what future runs experience, so pre-fix and
> post-fix runs are no longer one population.**

That asymmetry, not the defect count, is what makes this decidable.

## Repair: the two timeout defects. Ours, scoring-path, retroactive.

`bench/run-task.mjs` SIGKILLs at a wall-clock deadline, records
`stopReason: "timeout"`, and the run was then **judged and ingested like any
completed run** — the agent never had a turn in which to write an answer, so the
judge scored the absence of a deliverable as a bad deliverable. Worse, the
truncation **lands on prompt variants**, which is the one failure mode that
directly corrupts variant ranking.

These are ours, in our code, and the fix is a filter on ingest rather than a
change to the world the agent runs in. Applying it re-scores the whole corpus
uniformly; it does not create two populations.

**Status: already applied.** `bench/judge.mjs:291` now carries
`SCORABLE_STOP_REASON = "completed"`, and a non-completed run is recorded as
`unscorable: {reason, finalTextChars}` instead of receiving a score. Every
existing run can be re-judged from its stored `stream.jsonl` — no re-runs.

## Control, do not repair: the six upstream server clusters.

`%2F` over-encoding, the unfollowed 307, Met Museum 403, the stale nixos ES
index, HF 401, double-encoded `%252F`. Five of six are upstream in
`vendor/mcp-bench`; one needs a trace read to attribute.

Three reasons not to touch them mid-campaign, in increasing order of force:

1. **`vendor/mcp-bench` is untracked**, so a patch has no provenance — the exact
   condition this project has already been burned by ("a runId scheme change
   silently overwriting already-reported runs").
2. **It splits 1,005 runs into two non-poolable populations.** Every comparison
   spanning the boundary becomes uninterpretable, which is a larger cost than the
   defects impose.
3. **The benefit is not estimable, in either direction.** This is the scan's own
   headline and it is the decisive point: naively, affected runs score 5.60 vs
   6.26 clean; restricted to tasks containing both, the delta **reverses to
   +2.06, with affected higher in 12 of 12 tasks.** The mechanism is selection —
   *being affected requires having called the broken tool*, so the unaffected
   group is mostly runs that barely engaged (median 4 tool-result blobs against
   39). There is no defensible "repair recovers N points" figure to weigh against
   the cost of splitting the corpus.

**How to control instead.** Record, per run, whether it touched a broken
endpoint, keyed on **the URL inside the error text** rather than the tool name
(naming differs per arm: `mcp__harness__<Server>__<tool>`, `<Server>__<tool>`,
`call_tool`, `ipython`). Then treat "touched a broken tool" as a **covariate, not
an exclusion filter.** Excluding affected runs selects on engagement and would
reproduce the confound above with the sign hidden.

## What would change this decision

Repair the environment only when a new campaign starts from an empty corpus, so
there is no boundary to straddle. At that point fix all six upstream clusters
before the first run, and record the vendored tree's commit so the population is
identifiable afterwards.

## The generalisation worth keeping

Two things learned the same night, from a different bank, that both apply here:

- **Check that a defect's effect is resolvable before spending on it.** The
  Decomposed campaign spent an evening on six prompt rungs against a metric
  needing ~9 runs per arm to resolve +0.10, measured with one run per arm
  (`a private write-up` §3c). "Fix it and recover N points" is
  only worth acting on when N is estimable — and here it is not.
- **A confounded comparison can point the wrong way with total confidence.** The
  affected-vs-clean sign reversal here and the lucky-baseline effect there are the
  same error: a group defined by an outcome-correlated property compared against
  one that is not. In the Decomposed case a single baseline run showed +0.154 over
  the pooled mean at p=0.0047 and made six unrelated interventions all look
  harmful.
