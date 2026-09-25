# MCP-Bench: wall-clock truncation scores as agent failure, and it lands on prompt variants

**A fifth instrument defect, and the one that most directly corrupts variant
ranking.** Found 2026-08-31 by reading a trace from the "genuine signal" bucket —
`quick__reddit_001__codemode__q3__r1__anthropic-claude-sonnet-5`, score 2.78, whose
`wallSec` was **600.026**. Exactly 600.

## The ceiling is a flag, not a property — key on `stopReason`, never on the clock

I first detected the ceilings from the symptom: wall-clock values shared by ≥3 runs
at a round minute ≥300s, which gave {420, 600, 1800}. **That rule is wrong in two
ways and should not be reused.**

The deadline is configured, and the source is the citation:

```
bench/run-task.mjs:56    const timeoutSec = Number(flag("timeout", 900))
bench/run-task.mjs:403   setTimeout(() => { summary.timedOut = true; child.kill("SIGKILL") }, timeoutSec*1000)
```

Per-driver defaults: `quick.mjs` **300**, `sweep.mjs` **420**, `hillclimb.mjs`
**900**, `run-task.mjs` **900**, `run-claude-code.mjs` **1800**.

Empirically all 31 timed-out runs land on five values: 300s (1), 420s (4), **600s
(18)**, 900s (1), 1800s (7).

So the wall-clock rule **missed 300 and 900** — both real driver defaults, each with
a single run, which fell through the "≥3 runs" floor. And **600 is not a default
anywhere in `bench/`**, so those 18 runs were launched with an explicit
`--timeout 600`.

**The ceiling set is not closed.** Any `--timeout N` mints a new one, so a future run
can land on a value in nobody's list. The durable detector is what `run-task` writes
directly:

> `summary.timedOut === true`, or `summary.stopReason !== "completed"`.

There is also a dormant sixth reason: `turn-cap` (`summary.turnCapReached`, `maxTurns`
default 0 = disabled). Zero runs in this corpus hit it, but anyone passing
`--max-turns` would produce the same decapitation under a different label, and a
timeout-specific check would miss it. This is why the fix in `bench/judge.mjs` gates
on an **allowlist** — anything that is not `completed` is unscorable — rather than
denying a list of known-bad reasons.

## Three ceilings, and hitting one costs ~2.7 points

| | n | mean score |
|---|---|---|
| truncated at a ceiling | 30 | **3.61** |
| completed | 808 | **6.26** |

Within situation — same task, arm and model, so difficulty is held fixed:

| situation | truncated | completed | gap |
|---|---|---|---|
| game_trends_reddit_000 / codemode | 3.91 (n=15) | 6.10 (n=66) | +2.18 |
| reddit_001 / codemode | 3.77 (n=7) | 7.23 (n=74) | +3.46 |
| openapi_explorer_000 / codemode | 2.44 (n=1) | 5.89 (n=80) | +3.45 |
| metropolitan_museum_wikipedia_000 / codemode | 2.45 (n=1) | 5.53 (n=2) | +3.08 |
| wikipedia_paper_search_003 / codemode | 3.28 (n=1) | 6.00 (n=2) | +2.72 |
| + 3 more | | | |

**Mean gap +2.68, completed higher in 8 of 8 situations.**

## It is truncation causing the score, not slowness revealing a bad run

This is the alternative that had to be excluded, because "truncated" also means "took
longer", and a floundering run is slow. The per-dimension signature separates them
cleanly:

| dimension | truncated | completed | gap |
|---|---|---|---|
| **grounding** | 2.20 | 7.29 | **+5.09** |
| **task_fulfillment** | 1.90 | 5.78 | **+3.88** |
| dependency_awareness | 3.36 | 5.98 | +2.62 |
| parameter_accuracy | 5.83 | 7.36 | +1.53 |
| tool_appropriateness | 5.50 | 6.89 | +1.39 |
| parallelism_and_efficiency | 2.88 | 4.25 | +1.37 |

**The OUTPUT dimensions collapse while the PROCESS dimensions barely move.** A run
that was floundering would choose tools badly and pass bad parameters; these chose
tools at 5.50 against 6.89 and passed parameters at 5.83 against 7.36 — near normal —
and then scored 1.90 on fulfillment because they were cut off before answering.

The trace that surfaced it is the archetype: 13 cells of real Reddit thread content
gathered, tools returning valid data throughout, `tool_appropriateness` 5.33 and
`parameter_accuracy` 4.33, and `task_fulfillment` 1 / `grounding` 1. Gathered, never
answered.

## Why this one matters more than the other four

The other instrument defects hit particular *servers*, so they contaminate particular
*tasks*. This one hits *slow runs* — and how slow a run is depends on the prompt
variant. On `reddit_001 / codemode / sonnet-5`:

| variant | runs at the 600s ceiling | score band |
|---|---|---|
| q2 | **5 of 5** | 3.44–4.39 |
| q3 | 1 of 4 | 2.78, and 6.78–8.78 for the rest |
| q1 | 0 of 8 | 6.39–8.61 |
| q7-ns | 0 of 5 | 7.72–8.83 |

**q2 looks like a bad prompt variant and is mostly a slow one.** A variant that
makes the agent take longer is scored as if it made the agent worse, and the penalty
(~2.7 points) dwarfs any real prompt effect measured on this corpus. Every
variant ranking that mixes truncated and completed runs is confounded, and the
confound is largest exactly where a variant changes how much work the agent does —
which is what most of these variants were designed to change.

## What to do

1. **Exclude truncated runs from variant comparisons**, or report them separately.
   Detect on `summary.timedOut` / `stopReason !== "completed"` — NOT on `wallSec`
   against a list of ceilings, per the first section. (This line said the opposite
   until the ceiling turned out to be a flag; a stale instruction in the "what to do"
   section is worse than none, because it is the part someone copies.)
2. **Do not read a truncated run as an agent failure.** Its `fulfillment` and
   `grounding` measure the clock.
3. If variant effects on *speed* are interesting — and they are, since turns are a
   real cost — measure them as **wall-clock and turns directly**, not through a score
   that truncation has already collapsed.
4. Raising the ceilings would trade one artifact for another (longer runs, same
   cliff). The fix is to record truncation as an outcome and filter on it, which the
   data already supports.

## The triage queue was an instrument backlog: 1 of 41 survives

Full accounting of the 41-entry backlog, after all five instrument defects plus
truncation:

| cause | entries |
|---|---|
| truncated (`stopReason=timeout`) | **20** |
| in ≥1 instrument cluster | 16 |
| oversized payload (≥1MB) | 13 |
| h20, graded blind to file reads (product rung) | 1 |
| causes per entry | 1 cause: 29 · 2 causes: 10 · **zero causes: 1** |

**Truncation is the single largest cause**, ahead of the server clusters, and it
overlaps them heavily — 9 entries carry both an HF cluster and truncation. My earlier
"at least 9 are truncation" understated it by half.

The sole survivor is `huge_icons_000__vanilla__L4__anthropic-claude-sonnet-5`, score
3.67: `wallSec` 52 against a nearest ceiling of 300, `stopReason` completed, max
payload 0.11MB, no cluster. It produced a genuine 8,811-character answer — a
structured table of icon names with a per-name verdict and a recommended pick — and
scored fulfilment 3.0. Its sibling on the **identical** surface
(`__w2__opus-5`, also 1 turn) scored 6.56 with fulfilment 7.0, and codemode q7/q8/q9
on the same task scored 6.61/6.56/6.83. Every other cell answers this task well and
the sonnet-L4 cell does not. **AGENT, model-capability gap, candidate at n=1** — not a
rate off one trace.

So: stop working this queue. It is an instrument backlog, and saying so is the
finding.

### The 39-of-41 figure must not migrate into a sentence about the benchmark

This queue is the **worst-scoring tail**, and it is exactly where instrument defects
concentrate, because every one of them pushes a run downward. "39 of 41 were
instrument" is true of the tail and says nothing about the corpus.

Corpus-level contamination is far smaller: truncation is **30 of 808 scored runs
(3.7%)**, and `%2F` appears in 157–211 runs depending on detection surface. Those are
the numbers to quote about MCP-Bench. The tail figure is a statement about what a
score-ranked backlog selects for.
