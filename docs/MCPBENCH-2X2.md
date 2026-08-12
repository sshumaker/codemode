# MCP-Bench 2×2 — does the AppWorld decomposition reproduce?

Status: complete. 96 runs at $1 + 44 uncapped repair runs = 140 runs, $118 total.
Owner: team-lead. Companion to `docs/BENCHMARK-SELECTION.md` §10, which holds the
AppWorld result this document tests.

## 1. Why this exists

`docs/BENCHMARK-SELECTION.md` establishes, on AppWorld with Opus 5 at n=3:

- **residency** is a fixed per-task tax — $0.525 (low stratum) vs $0.518 (high),
  i.e. within $0.007 across a 9× difference in task size;
- **representation** scales with work — $0.068 → $0.768 across the same strata.

Every number there comes from one benchmark, whose APIs paginate at 20. That was
listed as the document's top open question, and this is the answer to it.

MCP-Bench is the right control because its bias runs the **other way**: real
third-party MCP servers with heterogeneous response shapes, per-task catalogues of
82–145 tools rather than one fixed 469-tool surface, and live data. If the
decomposition is an artefact of AppWorld's response shapes, it should not survive.

**Reproduction here means the sign and the ordering, not the magnitude.** The
catalogues differ by 2–3×, so the residency tax *should* differ in dollars. A
matching sign with a different magnitude is a reproduction; a flipped sign is not.

## 2. Design — the same four cells, deliberately

| cell | arm | residency | prompt | ctx0 (measured) |
|---|---|---|---|---|
| code / docs out | codemode | L0 | q8 | 1,747 |
| code / docs in | codemode | L4 | q8 | 25,382 |
| tools / docs out | vanilla | L1 | w3 | 4,919 |
| tools / docs in | vanilla | L4 | w2 | 37,856 |

The residency dial spans 14× within the code arm and 7.7× within the tools arm, with
no overlap between the docs-out and docs-in cells — the same clean separation the
retro-check found on AppWorld (§4.1).

24 tasks from `sampleTasks(8)` — 8 per tier, tiers being `single`/`multi2`/`multi3`
(one, two, three servers). Tier is MCP-Bench's work axis, so it plays the role
AppWorld's ground-truth-call strata play there.

Three things are shared with AppWorld's factorial rather than reimplemented, because
two benchmarks running two different analyses answer nothing:

- `renderFullDocs` — the *same* function renders the docs-in preamble in both. Had
  they rendered documentation differently, a difference between benchmarks would be
  unattributable: benchmark, or wording?
- `bench/stats.mjs` — same paired t-test, same exact sign test, same formatting.
- The cell definitions, contrasts, and null controls.

`bench/factorial.mjs` is the analysis; `bench/quick.mjs --cells 2x2` runs the same
four cells on the fast subset for smoke-testing.

### 2.1 What had to be built first

**codemode L4 did not exist.** MCP-Bench's runner supported L0/L1/L2 for the code
arm and no docs-resident cell, so there was no code/docs-in to compare against.

**The vanilla L1 arm had never worked.** Three previous mechanisms all failed, and
two of them failed *silently* — see `bench/arms/mcp-tools-extension.ts` for the full
history. The working form is a fixed tool set whose *arguments* carry the tool
identity (`search_tools` / `describe_tool` / `call_tool`), registered at load time.
Validated before spending: `describe_tool` + `call_tool` in the trace, and **3 calls
reaching the real FruityVice server with `ok=true`**. The prior mechanisms reached
**zero** at the transport while appearing correct from outside, so "the model called
the tool" is not the check — "the transport was reached" is.

**The tools row was confounded.** Vanilla L1 built its own preamble and so never
received the efficiency guidance the L4 cell gets from `w2` — a difference *inside*
the row, sitting on the axis the 2×2 varies. Fixed by `w3`, which shares the two
levers with `w2` through a single `VANILLA_EFFICIENCY_GUIDANCE` constant, pinned by a
test asserting **byte-identity** of the shared tail rather than "both mention
parallelism".

## 3. Results in one paragraph

**Both AppWorld findings reproduce in sign and ordering.** Code is cheaper than
tools and docs-out cheaper than docs-in, all four contrasts significant on both the
paired t-test and the exact sign test at n=20. **Representation scales with work**
($0.213 → $0.426 → $0.480 across tiers), reproducing the central claim. **Residency
does not come out flat here**, and §7.2 shows this identifies what AppWorld was
holding fixed rather than contradicting it: cost is an *identity* in priced tokens
(residual 0.000% over 114 runs), residency is just the catalogue's extra billed
tokens, and AppWorld pins both the catalogue size and the turn count by construction.
Separately, codemode here **loses on turns and still wins on cost**, which rules out
round trips as the mechanism more cleanly than AppWorld could (§7.3).

## 4. Guards, and the bugs they caught

### 4.1 The residency guard had no floor

It caught "labelled L1, secretly L4". It could not catch the mirror: a cell labelled
L4 whose documentation never reached the prompt is an L0 run wearing an L4 label —
and it reads as **"docs-in costs nothing"**, the opposite of the truth, in the
direction that flatters the headline.

Now a floor derived from `meta.preambleChars`. The first attempt was a *constant* and
was wrong: MCP-Bench catalogues are per-task (8k–24k tokens against AppWorld's
uniform ~62k), so any constant large enough to catch a dropped catalogue also fails
the small tasks legitimately — and a check that cries wolf gets disabled, which is
how you end up with no check at all.

Retro-applied to the 243 AppWorld runs already collected: **L0 4604–4939, L1
8966–9077, L4 67989–101219.** No overlap between levels, no violations, and the
tightest real ratio is 1.38 against a 0.6 threshold.

The L0 band being only 335 tokens wide across 88 runs is worth noting, but for a
narrower reason than first written here: it confirms AppWorld's resident catalogue is
constant across tasks — the *input* to residency — not that residency is a fixed
cost. §7.2 is the correction; conflating the two is precisely the error this document
ends up diagnosing in the AppWorld claim, so it should not be committed on the way
there.

### 4.2 A provider refusal was recorded as `completed`

`osint_intelligence_000` asks for typo-squat and exposed-service enumeration against
a domain. The provider refuses, prime retries three times, the run makes zero tool
calls and costs $0.02 — and it entered the data as a legitimate observation. Same
family as the rate-limited server whose 429s were counted as successful MCP
responses.

Now classified `refused`, and any task not completed in *every* cell is dropped
whole rather than per-cell — a refusal in some cells and not others biases exactly
those cells toward zero. Scanned all 842 historical runs: 4 contain refusals, all on
this one task, all 3 pre-fix ones mis-recorded. Bounded, but it was in the sample.

### 4.3 Sweep computed a runId it never passed

`bench/sweep.mjs` derived a runId for its own existence check and let `run-task.mjs`
re-derive its own independently. The two agreed by coincidence until `--tag` was
added, at which point sweep looked for a tagged directory, found none, spawned — and
run-task wrote the *untagged* path and refused as "already exists". Every tagged run
bounced and the sweep reported success. Same duplicated-naming-scheme family as the
runId change that once silently overwrote reported v1 runs. Sweep is now
authoritative and passes `--run-id`.

### 4.4 A wrapper reported success over two dead cells

`onlyTasks` was first declared *below* the line that used it — a temporal dead zone,
so `node --check` passes and the file only throws at run time. Because the edit
landed **while the sweep was in flight**, the two cells that had not yet started
spawned into the broken file and died on load. The wrapper logged `done (exit 1)`
twice and then printed `ALL CELLS COMPLETE`.

Two lessons, both cheap: a cell-level failure must abort the run rather than print a
completion banner, and **do not edit a script mid-sweep** — the running process is
fine, but everything it spawns afterwards picks up the new file.

### 4.5 Replicate tags and repair tags are not the same thing

`--tag a,b` means "another run of the same configuration", so they average — that is
what buys a measured noise floor. The budget repair is *not* that: it re-runs a task
at a higher cap because the original was **truncated**. Averaging a censored $1.06
with its uncensored replacement produces a number that is neither, and it would look
entirely reasonable.

Separated into `--override-tag`, whose runs *replace* rather than join, extracted
into `bench/select-tags.mjs` and unit-tested — including a case asserting that
averaging **would have changed the answer**, so the test is not vacuous.

## 5. The budget cap censored the sample — on the axis under measurement

The dominant methodological problem, and it was invisible until the cells ran.

MCP-Bench had been running at `--max-cost 1.0`; AppWorld uses `$3`. Caps by cell:

| cell | capped / 24 |
|---|---|
| code / docs out | 1 |
| code / docs in | 3 |
| tools / docs out | 6 |
| tools / docs in | 9 |

The prediction was that the cap would bind on the *residency*-heavy cells. It bound
hardest on **vanilla L1**, which has the smallest resident context of any tools cell
(ctx0 4,911). The reason is the mechanism under study: L1 is cheap in schemas and
expensive in **actions**, and each action returns a full payload into context.

Capped tasks are excluded whole, which removes the truncation bias — but it removes
tasks non-randomly:

| tier | sampled | lost to cap | surviving |
|---|---|---|---|
| single | 8 | 1 | 7 |
| multi2 | 8 | 5 | 3 |
| multi3 | 8 | 5 | 3 |

**62% of the high-work tiers, 12% of the low.** A task is dropped precisely because
the tools arm was too expensive — that is, because the representation effect was
large. **That is selection on the dependent variable**, and it is why representation
appears to collapse at the top tier: the surviving multi3 tasks are the ones where
tools happened to be cheap.

The residency contrast is *not* contaminated the same way. It lives inside the code
row, and the exclusions were driven by *vanilla's* cost — a correlated variable (task
size), not that contrast's dependent variable. It truncates range without selecting
on the effect.

Repair: re-run the 11 affected tasks in **all four cells** at `$3`. A cap that is
never reached has no effect on a run, so tasks nowhere near $1 are identical at
either setting and need not be re-run — but *within* a task all four cells must share
one cap, or the treatment differs across the contrast being computed. The task list
is derived from `factorial.mjs --list-capped`, not transcribed, so it cannot drift
from what the analysis actually excluded.

This is the same shape as the fast-subset trap already in `CLAUDE.md`: **unbiased
estimate, range truncated on the axis being measured.** It is distinct from the
censoring found in the AppWorld set, where the cap bound the *expensive* cell and the
truncated value was averaged in — sample intact, one cell biased low. Same
phenomenon, opposite corrections.

## 6. Limitations

1. **n=1 per cell.** The replicate null control is unavailable, so the noise floor is
   **unmeasured** and every effect is provisional. `factorial.mjs` prints this rather
   than letting a floor-less number be quoted as floor-checked. `--tag a,b` averages
   replicates before pairing, so a second pass drops straight in.
2. **Strata are small** — n=7/6/7. Sign tests are the readable statistic; the
   per-stratum point estimates carry wide intervals ($0.480 ± 0.539 at multi3).
3. **3 tasks remain censored** even at $3, all in the tools cells, so the
   representation term is still a mild lower bound. The 11 repaired tasks moved it
   from an apparent collapse to a clean monotonic trend, so the direction of this
   residual bias is known and it works against the finding, not for it.
4. **Live servers.** Costs depend on third-party payload sizes that move between
   days, so all four cells are read from one `--tag` and the run span is printed.
   Reusing a cell's runs from another day would put API drift on the cell axis.
5. **Opus 5 only**, and the two mechanisms should generalise in opposite directions:
   residency is a *token-price* effect that shrinks in dollars on a cheaper model
   while staying identical in tokens; representation is a *capability* effect that a
   weaker model may not realise at all.
6. **Score is not measured.** MCP-Bench's judge was not run on these cells; this is a
   cost comparison, and cost comparisons are only meaningful at equal outcomes.
   Turns and calls are reported as a proxy.

## 7. Numbers

n=20 tasks complete in all four cells, cost in USD, paired per task. Base pass at
`--max-cost 1.0` with the 11 censored tasks **replaced** (not averaged) by `$3`
re-runs; 4 tasks excluded whole — 1 refusal and 3 that hit the cap even at $3.

| cell | cost | turns | calls | ctx0 |
|---|---|---|---|---|
| code / docs out | $0.368 | 14.4 | 13.4 | 1,747 |
| code / docs in | $0.623 | 11.8 | 10.8 | 25,382 |
| tools / docs out | $0.738 | 10.0 | 26.4 | 4,919 |
| tools / docs in | $0.899 | 7.8 | 21.7 | 37,856 |

| contrast | mean ± sd | t (df=19) | sign |
|---|---|---|---|
| residency, code row (in − out) | $0.255 ± 0.195 | 5.86*** | 19/20 |
| residency, tools row (in − out) | $0.161 ± 0.275 | 2.62* | 16/20 |
| representation, docs-in (tools − code) | $0.277 ± 0.255 | 4.85*** | 18/20 |
| representation, docs-out (tools − code) | $0.371 ± 0.356 | 4.65*** | 18/20 |
| NULL CONTROL (a cell vs itself) | $0.000 ± 0.000 | — | — |

All four positive and significant on both tests: **code is cheaper than tools, and
docs-out is cheaper than docs-in.** The signs and the ordering reproduce.

### 7.1 Representation scales with work — reproduced

| tier | mean tool calls | representation, docs-out |
|---|---|---|
| single | 8.7 | $0.213 ± 0.153 |
| multi2 | 12.5 | $0.426 ± 0.224 |
| multi3 | 18.9 | $0.480 ± 0.539 |

Monotonic, and a 2.3× increase across a 2.2× increase in tool calls. This is
AppWorld's central claim about the representation term, on a different benchmark.

**Note this is the row that pass 1 got backwards** ($0.196 → $0.292 → $0.010,
apparently collapsing). The collapse was entirely the budget cap selecting against
the effect (§5); repairing the censoring reversed the conclusion. A truncated sample
did not merely widen the error bars — it inverted the trend.

### 7.2 Residency is NOT flat here — and that refines the AppWorld claim

| tier | residency, code row |
|---|---|
| single | $0.198 ± 0.112 (sign 7/7) |
| multi2 | $0.203 ± 0.195 (sign 6/6) |
| multi3 | $0.355 ± 0.240 (sign 6/7) |

Residency rises 1.8× from `single` to `multi3`, where AppWorld's was flat to within
$0.007 across a 9× task-size range. **This is not a contradiction — it identifies
what AppWorld was holding fixed.**

### Cost is an identity, not a regularity

There is no need to model this at all. At published Opus 5 prices, weighting prompt
tokens by kind (cache read 0.1×, cache write 1.25×):

```
cost = $5.00/M weighted-prompt-tokens + $25.00/M output-tokens
```

Verified on **114 completed MCP-Bench runs: median and max relative residual
0.000%**, and independently on 297 AppWorld runs. Cost is *exactly* linear in billed
tokens, so "residency cost" is nothing more than the extra billed tokens the resident
catalogue causes, priced.

(An earlier version of this section proposed `residency ≈ resident tokens × turns`.
That is an unnecessary model — the run summaries already carry true billed totals —
and it is also wrong in detail, because `ctx0 × turns` cannot distinguish a cache read
from a cache write, and the arms have different cache mixes. Its `$/100k token-turns`
looked constant only across a narrow range of cells.)

### So residency decomposes exactly into two terms

| tier | prompt term | output term | total | refund |
|---|---|---|---|---|
| single | $0.210 | −$0.012 | $0.198 | 5% |
| multi2 | $0.220 | −$0.017 | $0.203 | 8% |
| multi3 | $0.346 | +$0.009 | $0.355 | −3% |

Totals reconcile exactly with the paired means in the table above, and
`factorial.mjs` asserts that reconstruction rather than assuming it — a third
independent confirmation of the identity, after 114/114 here and the 297-run fit on
AppWorld.

(An earlier draft of this table quoted $0.218 / $0.190 / $0.285 from a scratch script
that averaged over *all* completed runs per tier rather than the 20 paired tasks, so
its totals did not reconcile with the contrasts they were meant to explain. Moving the
decomposition into `factorial.mjs` surfaced that immediately — which is the argument
for the rule: a number nobody can re-derive tomorrow is a number nobody can check.)

Two things follow, neither visible on AppWorld:

**1. The prompt term grows because both of its factors grow.** MCP-Bench exposes the
task's own servers plus distractors, so a `multi3` task carries a larger resident
catalogue (29.7k vs 23.5k tokens), *and* harder tasks take more turns, each re-billing
it. AppWorld pins both — a fixed 469 APIs regardless of task, and 6.3 vs 6.4 actions
across its two strata, so its token-turns moved 1.01× while residency moved 0.99×.
**Its flatness is a correct measurement of a special case, not a law.**

**2. Making the catalogue resident partially pays for itself — but unpredictably.**
The output term is a *credit*, worth 23% of the prompt cost at `multi2`. Resident docs
cut turns because the agent no longer explores `api/` to find things, and output bills
at 5× cached prompt tokens.

**How big the credit is depends on which arm, not on the tier.** Over the paired set:

| contrast | prompt term | output term | total | refund | turns | output |
|---|---|---|---|---|---|---|
| residency, code row | $0.261 | −$0.006 | $0.255 | **2%** | −18% | −3% |
| residency, tools row | $0.204 | −$0.043 | $0.161 | **21%** | −22% | −19% |

Turns fall by about the same fraction in both rows (−18%, −22%), and the refund still
differs tenfold. The reason is **absolute output volume**: the tools arm emits far more
(26.4 calls per task against 13.4, each result framed in context), so the same
proportional turn saving converts to ten times the dollars. This is the same pattern
AppWorld shows — 1% on its code rows, 24.7% on `tools/docs-in` — from an arm mix that
differs by 10× in output tokens.

A second, independent effect runs alongside it: **turn savings only partly become
output savings**, because resident docs consolidate work into fewer, longer cells. On
the code row turns fall 18% and output only 3%; per tier, −21%/−23%/−14% of turns
yields −10%/−10%/+4% of output.

The two terms separate cleanly across the benchmarks, and neither dataset shows both:

| | output/turn baseline | consolidation (out/turn change) | refund |
|---|---|---|---|
| AppWorld, code rows | 120–156 | +2%, +8% (≈absent) | 1% |
| MCP-Bench, code rows | 460–680 | +6% to +25% | 2% |
| AppWorld, tools/high | high | −37% | 24.7% (censored cell) |
| MCP-Bench, tools row | high | −19% vs −22% turns | 21% |

**AppWorld's code rows are the separating case**: consolidation is essentially zero
there, so the turn saving survives intact — and the refund is *still* only 1%, which
can only be the low emission volume. Conversely MCP-Bench's code arm emits 3–4× more
per turn, which is why consolidation is visible here at all. The arithmetic reconciles
both ways: AppWorld's low code row is 1.8 turns × ~120 tokens = $0.005; MCP-Bench's
`multi3` is 4.6 turns × ~530 tokens gross, less ~25% consolidation, ≈ $0.008 against a
measured $0.007.

So: **consolidation is why volume doesn't predict the refund within an arm; emission
volume is why it differs across arms. Only Δoutput is predictive, and it must be
measured.** The practical form: expect a refund where resident docs remove *search*
turns without the surviving turns absorbing the work.

(An earlier draft of this section claimed the refund was 23% at `multi2` and driven by
consolidation rather than volume. Both came from a scratch script using the wrong task
set — see the note above. The corrected numbers support the volume account.)

> **Net residency tax = gross catalogue tokens − $25/M × Δoutput.**

Expect a refund where resident docs remove *search* turns without the surviving turns
absorbing the work — which is not predictable from turn count or task size, only
measurable from Δoutput.

**This changes the practical advice.** "On small tasks fix residency first" assumed a
fixed tax. If your catalogue grows as tasks get harder — the normal MCP pattern, since
you attach more servers for harder work — residency scales too, and the two terms do
not cleanly separate by task size. What is fixed and known is the *price*; the only
levers are how many tokens the catalogue costs and how many turns re-bill them.

### 7.3 A mechanism result stronger than AppWorld's

On AppWorld codemode won on *both* turns and cost, leaving round trips as a live
explanation. Here it **loses on turns and still wins on cost**:

| cell | turns | calls | calls/turn | ctx0 | cost |
|---|---|---|---|---|---|
| code / docs out | 14.4 | 13.4 | 0.93 | 1,747 | $0.368 |
| tools / docs out | 10.0 | 26.4 | 2.64 | 4,919 | $0.738 |

Vanilla batches 2.6 calls per turn against codemode's ~1, and takes **30% fewer
turns** — and is still **twice** the cost. Dispatch is not the constraint. That
isolates the mechanism to **per-action context**: every tool result enters context
verbatim, while a cell prints only what the code chose to print. It is what the
emission/reception decomposition predicts and what the earlier falsified
parallel-calls hypothesis could not settle.

The call counts also differ by 2×, which the matched-calls AppWorld comparison did
not show — worth its own investigation, since it means the tools arm is doing more
API work for the same task, not merely paying more per call.

## 8. Reproducing

```bash
# smoke-test the four cells on the fast subset, then dry-run the argv
node bench/quick.mjs <env> --cells 2x2 --dry-run
node bench/quick.mjs <env> --cells 2x2 --tasks huge_icons_000

# a full pass (one tag = one replicate), then the analysis
node bench/sweep.mjs <env> anthropic/claude-opus-5 --tasks 8 --concurrency 8 \
  --max-cost 3.0 --tag p1 --arms codemode --residency L0 --prompt q8
# ... one invocation per cell; see scratchpad/mcpbench-2x2.sh
node bench/factorial.mjs --tag p1
node bench/factorial.mjs --tag p1,p2                 # two passes: noise floor
node bench/factorial.mjs --tag p1 --override-tag c3   # repaired cells replace
```

Run at `--max-cost 3.0`. `$1` censors this benchmark (§5).
