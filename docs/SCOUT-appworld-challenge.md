# Scout report: the AppWorld `test_challenge` split

Pilot only. 54 agent runs over 17 held-out tasks, $28.36, Opus 5. No full sweep was
run and none should be until this is reviewed.

> **GO.** The challenge split grades correctly, the existing `bench/appworld/`
> harness runs on it unmodified, and the train+dev cost decomposition **reproduces**:
> residency is a flat $0.51/task tax regardless of task size (low $0.489, high $0.532,
> sign 5/5 in each stratum), while representation grows with the work done ($0.110 →
> ~$0.57, 5.2x across a 10x change in task size). Per API call the tools arm costs 2x
> what code does and its cost rises **4.2x faster per call**. Two defects were found and
> fixed — one in our harness, one in the benchmark.
>
> **The thing challenge does *not* buy is score headroom.** 52 of 54 runs passed,
> including 11 of 12 on deliberately-selected difficulty-3, 100+ call tasks. The
> held-out split is not harder for Opus 5 in any way this pilot could measure. If the
> reason to run challenge was "train+dev is saturated, the held-out split will
> discriminate", that premise is false and a full sweep buys nothing but a tighter
> interval around the same cost result.

---

## 1. Phase 0 — grader trust

The brief said Phase 0 would be cheap because "AppWorld ships ground-truth solutions".
**It does not ship them for the held-out splits**, and this is the first thing to know
about the challenge split:

| split | n | ground-truth mode | `solution.py` present |
|---|---|---|---|
| train | 90 | `full` | 90 |
| dev | 57 | `full` | 57 |
| test_normal | 168 | `minimal` | **0** |
| test_challenge | 417 | `minimal` | **0** |

The licence withholds test solutions. `appworld verify tasks`, upstream's own
positive control, works by executing `ground_truth.compiled_solution_code` — so it
**cannot run on challenge at all**, and the documented `147/147` in
BENCHMARK-SELECTION.md §5 is train+dev only. `minimal` mode still ships everything
the grader needs (`evaluation.py`, `answer.json`, `test_data`, `public_data`,
`private_data`); what it withholds is the solution and `required_apis`.

`bench/appworld/env-server.py` already anticipated this — it tries `full`, catches the
raise, and falls back to `minimal`. That is why the harness ran on challenge with no
changes. Good call by whoever wrote the comment at `env-server.py:262`.

Both controls were therefore rebuilt for the split, in
**`bench/appworld/challenge-p0.py`**, against the same `AppWorld.evaluate()` path the
harness uses. Everything each control saw is appended to
`.run/appworld/p0-challenge.jsonl` — solution source, execute output, per-test report,
answer — so a verdict can be re-derived after the world is gone.

**Negative control — a do-nothing run must fail. 12/12 correctly failed.**

```
ok  5800354_3  success=False pass=0/7    ok  f6f2e67_1  success=False pass=3/17
ok  1b988ac_2  success=False pass=1/10   ok  33e202d_3  success=False pass=1/10
ok  dcb2559_3  success=False pass=0/4    ok  cdaaea5_1  success=False pass=1/9
ok  07bb666_3  success=False pass=0/6    ok  7238049_3  success=False pass=0/8
ok  f86d850_1  success=False pass=1/14   ok  b6d1f70_3  success=False pass=1/13
ok  a97e35d_2  success=False pass=2/14   ok  fa327a6_1  success=False pass=0/6
```

Note the `pass=1/10`, `pass=3/17` columns: a do-nothing run passes some individual
checks (the "no collateral damage" ones pass trivially). This is the TAC
bonus-inflation bug that BENCHMARK-SELECTION §4.2 already documents. **Rank on
`success`, never on `passCount/totalCount`** — the harness already does.

**Positive control — a correct trajectory must pass.** With no reference solutions,
these were hand-written into `bench/appworld/challenge-solutions/`:

| task | difficulty | positive verdict | negative verdict on the *same* task |
|---|---|---|---|
| `07bb666_3` | 1 | `success=True`, 6/6 | `success=False`, 0/6 |
| `dcb2559_3` | 2 | `success=True`, 4/4 | `success=False`, 0/4 |

Both tasks carry **both halves of the pair on the same task**, which is stronger than
the two halves holding on different tasks: it rules out the third failure mode
`bench/grader-control.mjs` names — a non-discriminating task, where the ground truth
changes nothing observable and a do-nothing policy matches the correct end-state by
construction. Here the correct solution changes state (`0/6 → 6/6`, `0/4 → 4/4`), so
the control is informative rather than vacuous.

Two is still thin, and it is the weakest link in this report: it is the only part of
Phase 0 that cannot be scaled without a human writing more solutions. What supports it
is that the *machinery* is shared — the same `evaluate()`, the same `TestTracker`, the
same `models.changed_records` — and that machinery is verified 147/147 on train+dev.

### 1.0 The log said one positive was failing; it was a superseded attempt

`.run/appworld/p0-challenge.jsonl` is append-only, and iterating on a hand-written
solution leaves the failed attempts in it. `07bb666_3` appears twice: failing 2/6 at
`19:49:43` with a `> 4.3` boundary, then passing 6/6 at `19:51:24` with `>= 4.3`. A
downstream reader of the log reported the first record as a live wrong reference. It
is not — **there is no outstanding failing positive**; latest-per-(control, task) is
2/2 passing.

The finding was worth having anyway, because the log could not express the difference.
Fixed in `challenge-p0.py`: every positive record now carries a `solutionDigest`, the
append-only/latest-wins semantics are stated at the top of the file, and
`challenge-p0.py status` prints the current verdict per task plus a count of superseded
records. This is "log the inputs, not just the verdicts" failing in a new place —
the evidence was all there, and what was missing was **which record is current**.

Consumers should read `status`, or take the last record per `(control, taskId)`.
`bench/test/grader-control.test.mjs` currently asserts "at least one positive passed",
which is correct and robust; with latest-wins available it could be tightened to "every
task's current positive verdict passes" — its owner's call, and it would now hold.

### 1.1 REFERENCE defect found: "over 4.3" means `>= 4.3`

`07bb666_3` — *"Move all products with over 4.3 rating from my amazon cart to wish
list."* The literal reading fails. Product 1911's true mean rating is **4.2857**
(distribution: 1x3★ + 3x4★ + 3x5★ over 7 reviews), which `show_product` displays
rounded as `4.3`. The reference requires it **moved**.

So no reading of "over" admits it: `4.2857 > 4.3` is false, and `4.3 > 4.3` is false.
The generator compares `>=` against the rounded value. Confirmed against the
generator's own parameters — `public_data.json` carries
`{"over_under": "over", "threshold_rating": 4.3}`, and the sibling variants use the
same two-field scheme (`_1`: under 4.2, `_2`: over 3.7), so this is a **generator-wide
boundary convention**, not a one-off typo. The amazon generator is not among the ones
shipped in `generate/tasks/task_generators/`, so the operator cannot be read directly.

Scope: it only bites when a value sits exactly on the threshold. One of the three
variants in this family is affected. It is the same class as
`admin-arrange-meeting-rooms` in TAC (CLAUDE.md: reference says 4, truth is 5) —
**check the task's own `evaluation.py` and `public_data.json` before believing a
confident-looking failure.**

**The task is not excluded from the control set, and should not be.** A wrong reference
invites two different exclusions, and they are easy to run together — the lead and I
both did it on the first pass:

| operation | warranted here? | why |
|---|---|---|
| exclude the task from **AGENT attribution** | **yes** | an agent that reads "over 4.3" literally and fails has made a REFERENCE-class failure; counting it as an agent error is a false attribution |
| drop the task from the **positive control set** | **no** | the control tests only whether the grader can say *yes* to a correct solution. The grader grades its reference correctly; a solution matching that reference passes 6/6. A weird reference does not make the grader wrong, which is the only thing the control measures |

The decider is §1.0: `07bb666_3` and `dcb2559_3` are the **only two tasks carrying both
halves of the pair on the same task**, which is what rules out the non-discriminating-task
failure mode. Dropping one would remove half the strongest evidence in Phase 0 to fix an
attribution problem that removal does not address anyway. So the finding is recorded and
acted on in attribution, not by deletion.

---

## 2. Phases 1–3 — the ratchet

Tiers were expanded only after the previous tier was clean.

| tier | tasks | cells | non-pass | classification |
|---|---|---|---|---|
| 1 | `dcb2559_3` | 2 | 0 | — |
| 3 | + `e775c78_1`, `7574325_1`, `5800354_2` | 6 | 0 | — |
| 5 | + `a132254_3`, `d37c235_2` | 4 | 0 | — |
| 10 | + 5 more (stratified draw complete) | 10 | 0 | — |
| hard probe | 6x difficulty-3, >=100 gt calls | 12 | 1 | AGENT |
| residency arm | codemode L4 on the 10 | 10 | 0 | — |
| L1 re-run (after the b1/b2 fix) | the 10 | 10 | 1 | AGENT |

Tier 1's trajectory was read end to end. The codemode arm `cat`s `api/INDEX.md`,
greps for `premium`, logs in, reads the subscription history, infers "yearly" from the
2022-05-17 → 2023-05-17 span, picks the card matching `payment_card_digits`, subscribes,
completes. Real work through the real transport; `env-calls.jsonl` shows all 10 calls.

### Failure taxonomy — 2 non-passes in 54 runs, both AGENT

**`c9458ed_1` / codemode L0 — 5/6.** Buy a Sole E95 Elliptical after collecting promo
codes from roommates and friends. All five world-state checks passed, including
*"the discount applied matches `private_data.max_possible_discount`"* — the agent
found the best code and bought the right thing. It failed `assert answers match`:
`'1966' == 'null'`. It passed `answer=1966` to `complete_task` on a task that asks for
something to be *done*, not asked. The base prompt is explicit — *"If the task asks a
question, pass the answer. If it only asks for something to be done, omit the answer
argument"* — and the vanilla arm on the same task obeyed it. **AGENT.**

**`3f3c139_1` / vanilla L1 — 4/8.** *"Remove expired payment cards from all my app
accounts."* Current date 2023-05-18; two of five cards are expired. The agent deleted
**all five, from all three apps** (`env-calls.jsonl`: fifteen `delete_payment_card`
calls, then three `show_payment_cards` returning `[]`). It had `expiry_year` /
`expiry_month` in every response it read. **AGENT** — and a destructive one, worth
noting on its own: the failure mode is over-deletion, not under-completion.

Zero HARNESS, zero GRADER, zero REFERENCE, zero INTEGRATION **in the graded results**.
The two defects below were found by reading the setup, not by a failing run — which is
the point of the phase-0/triage discipline, since neither would have raised.

### 2.1 INTEGRATION defect found and fixed: `sweep.mjs` mis-briefed the L1 arm

`sweep.mjs` hardcoded `flag("vanilla-prompt", "b1")` and passed it explicitly for
every residency, silently overriding `run-task.mjs`'s residency-aware default (b2 at
L1, b3 at `predicted`). So a `--vanilla-residency L1` arm was told:

> *"Their full parameter schemas are already in front of you; you do not need to look
> anything up before calling."*

while holding only `search_tools` / `describe_tool` / `call_tool`. The arm never called
`describe_tool` once — it guessed arguments straight into `call_tool`. It mostly
worked, so nothing raised and no number looked wrong. This is the shape CLAUDE.md keeps
naming: **the label was believed, the condition was not.**

Fixed in `sweep.mjs` (prompt now derived from residency per cell), and the ten L1 cells
were re-run under b2. **Measured effect of the bug, paired over the ten tasks:**

| | actions | tool errors | cost | pass |
|---|---|---|---|---|
| b1 (mis-briefed) | 253 | 2 | $4.44 | 10/10 |
| b2 (correct) | 262 | 0 | $4.64 | 9/10 |

b2 costs **+$0.020/task more**. The misbrief made the tools arm look slightly *cheaper*
than it is, so it was understating the representation gap — the opposite direction from
the one I assumed when I found it. Small either way; the reason to fix it is that the
arm was not in the condition its label claimed.

Pinned as three assertions in `bench/test/appworld-fairness.test.mjs`
("the vanilla preamble matches the residency it describes"), per CLAUDE.md's *a
documented check is not an executed check*. All 35 tests pass.

Everything before the L1 re-run — the tier-3/5/10 vanilla numbers and all six
hard-probe vanilla runs — is b1 and is labelled as such in the run table. **Only the
b2 runs are used in the analysis below.**

---

## 3. Does the challenge split reproduce the train+dev result?

Yes, for the two contrasts CLAUDE.md calls defensible: **residency measured on the code
row**, and **representation measured with docs non-resident**. `vanilla L4` was not run
— neither contrast uses it, and the budget was better spent on the strata.

Sample: `bench/appworld/stratify.mjs --split test_challenge --per-stratum 5 --seed 0`,
one variant per generator, low = 5 tasks at 14–17 ground-truth calls, high = 5 tasks at
76–230.

```
node bench/appworld/factorial.mjs --cells "code / docs out,code / docs in,tools / docs out" \
     --tasks <the ten>
```

| cell | n | TGC | turns | actions | ctx0 | out tok | cost |
|---|---|---|---|---|---|---|---|
| code / docs out (L0) | 10 | 10/10 | 12.1 | 11.1 | 4,642 | 1,983 | **$0.216** |
| code / docs in (L4) | 10 | 10/10 | 7.6 | 6.6 | 68,027 | 1,384 | $0.726 |
| tools / docs out (L1) | 10 | 9/10 | 10.3 | 26.2 | 9,004 | 5,526 | $0.464 |

Paired per-task differences (`bench/stats.mjs`, paired t + exact sign test):

| contrast | low (n=5) | high (n=5) | both (n=10) |
|---|---|---|---|
| **residency**, code row | $0.489 ± 0.038, t=28.9, sign 5/5 | $0.532 ± 0.045, t=26.6, sign 5/5 | $0.510 ± 0.045, t=35.8, sign 10/10 p=0.002 |
| **representation**, docs-out | $0.110 ± 0.084, t=2.94, sign 5/5 | $0.386 ± 0.299, t=2.89, sign 5/5 | $0.248 ± 0.253, t=3.10, sign 10/10 p=0.002 |

Against train+dev (BENCHMARK-SELECTION §10.4):

| | train+dev low | challenge low | train+dev high | challenge high |
|---|---|---|---|---|
| residency | $0.521 | **$0.489** | $0.506 | **$0.532** |
| representation | $0.067 | **$0.110** | $0.766 | **$0.386 → ~$0.57** (§3.1) |

**Residency reproduces almost exactly, and reproduces the *shape* that matters** — flat
across a ~10x change in task size, which is the claim ("a fixed per-task tax") rather
than the number. **Representation reproduces in direction and in scaling** — 5.2x from
low to high stratum here (using the work-adjusted high figure) against 11x there.

The mechanism reproduces too, and it is the part that is not a cost artefact:
**actions, not round trips.** At matched work, code takes 11.1 actions to tools' 26.2,
and emits 1,983 output tokens to tools' 5,526 (2.8x). In the high stratum it is 13.6 vs
39.4 actions and 2,790 vs 8,633 output tokens. Same story as §10.3: one code block per
turn against N tool-call blocks.

### 3.1 The work-parity caveat, resolved: high stratum is ~$0.57, not $0.386

An earlier draft of this section said the arms "did not do the same amount of work" —
codemode 55.0 API calls per task against vanilla-L1's 37.8 in the high stratum — and
quoted $0.386 as a lower bound. That framing was **wrong about the structure**, and the
correction moves the number. `bench/appworld/work-parity.mjs` resolves it from the runs
already on disk, at no API cost.

**The imbalance is bidirectional, not a handicap.** Per-task tools/code call ratios run
from **0.18 to 3.14**:

| task | stratum | code API | tools API | ratio | diff (tools − code) |
|---|---|---|---|---|---|
| `5800354_2` | high | 76 | 14 | 0.18 | $0.041 |
| `d37c235_2` | high | 70 | 20 | 0.29 | $0.137 |
| `33e202d_2` | high | 64 | 46 | 0.72 | $0.740 |
| `7574325_1` | low | 9 | 8 | 0.89 | $0.019 |
| `cdaaea5_1` | high | 44 | 43 | 0.98 | $0.401 |
| `eb5ad85_1` | low | 8 | 9 | 1.13 | $0.210 |
| `a132254_3` | low | 6 | 7 | 1.17 | $0.066 |
| `e775c78_1` | low | 5 | 7 | 1.40 | $0.068 |
| `3f3c139_1` | low | 18 | 28 | 1.56 | $0.188 |
| `a1d3dfd_2` | high | 21 | 66 | 3.14 | $0.614 |

The "31% less work" was a property of the **mean**, produced by two tasks where
codemode paginated a collection exhaustively and vanilla did not. Averaging a ratio hid
that. The decisive line: **code is cheaper on 10/10 tasks, including the 5 where the
tools arm made *more* calls** — on `a1d3dfd_2` vanilla issued 3.1x the calls and still
cost $0.614 more. A saving that survives on the tasks where the other arm did more work
cannot be an artefact of the code arm doing more work.

Three views, two of them assumption-free:

| view | low (n=5) | high (n=5) | both (n=10) |
|---|---|---|---|
| **unadjusted** | $0.110, sign 5/5 | $0.386, sign 5/5 | $0.248 ± 0.253, t=3.10, sign 10/10 p=0.002 |
| **matched-work subset** (ratio in [0.63, 1.60]) | $0.110, **all 5 already matched** | $0.570 (n=2) | $0.242 ± 0.254, t=2.51, sign 7/7 p=0.016 |
| **cost per API call** | $0.008/call | $0.014/call | $0.011 ± 0.008, t=4.29, sign 10/10 p=0.002 |
| **work-adjusted counterfactual** (model-based) | — | $0.567 ± 0.194, t=6.54, sign 5/5 | $0.344 ± 0.286, t=3.80, sign 10/10 |

Reading them:

- **The low stratum needed no adjustment at all.** All five tasks are already inside the
  parity band, and the tools arm made *more* calls (11.8 vs 9.2). $0.110 stands as
  measured.
- **The pooled figure barely moves** — $0.248 unadjusted, $0.242 on 7 matched tasks
  where mean call counts are 22.0 vs 21.1, i.e. essentially exact parity. The confound
  was not doing any work.
- **The high stratum does move, upward.** The matched subset ($0.570, n=2, too thin to
  test on its own) and the model-based adjustment ($0.567 ± 0.194, t=6.54) land on the
  same number by independent routes. **Take ~$0.57 as the corrected high-stratum
  representation term**, and note it closes most of the gap to train+dev's $0.766.
- **The cleanest single statement is the rate.** Per API call, the tools arm costs
  $0.022 against code's $0.011 — 2x pooled, and its cost rises **4.2x faster per call**
  (5.6x within the high stratum; fits r=0.96 and r=0.89). That is the representation
  effect as a rate, defined on every task, independent of parity.

So $0.386 was a lower bound and is now bounded: **~$0.57**. The caveat is discharged,
and the direction of the original correction was right even though its stated mechanism
was not.

### 3.2 Score is not an endpoint here, and challenge does not fix that

52 of 54 runs passed. The hard probe was chosen adversarially — difficulty 3, >=100
ground-truth calls, up to 649 — and went 11/12. TGC is 10/10, 10/10, 9/10 across the
three cells.

The premise that the held-out split would discriminate where train+dev saturates is
**not supported**. Both non-passes are protocol-and-judgement errors (an unwanted
`answer=`, an over-broad delete), not capability limits. Anything score-shaped from
this benchmark on this model remains underpowered — and CLAUDE.md's note that an
identical config scored 8/8 then 3/8 on re-run is reproduced in miniature here:
`3f3c139_1` passed 8/8 under b1 and failed 4/8 under b2, a prompt change worth
$0.02.

---

## 4. Cost per task, and what a full sweep would cost

Measured means over the stratified ten (b2 for L1), and cost regressed on
ground-truth call count so the projection is not read off a sample that deliberately
over-weights both tails:

| cell | low stratum | high stratum | fit | split-weighted $/task |
|---|---|---|---|---|
| codemode L0 | $0.134 | $0.298 | $0.151 + $0.00091/call (r=0.74) | **$0.193** |
| vanilla L1 (b2) | $0.244 | $0.684 | $0.320 + $0.00202/call (r=0.51) | **$0.414** |
| codemode L4 | $0.623 | $0.829 | $0.634 + $0.00129/call (r=0.81) | **$0.694** |

The split's own distribution is mean 46.8 ground-truth calls, median 25, p90 80 —
closer to the low stratum than to the high, which is why the split-weighted figure sits
below the stratified mean in every cell. Note the slopes, which are the same result as
§3 in another form: the tools arm's cost rises **2.2x faster per API call** than the
code arm's, while residency adds a near-constant $0.48–0.63 to the intercept.

| scope | 2 cells (L0 + L1) | 3 cells (+ L4) |
|---|---|---|
| 30-task stratified sample | ~$18 | ~$39 |
| 100-task sample | ~$61 | ~$130 |
| all 417 challenge tasks | **~$254** | **~$544** |

Wall clock: 20–26 s/run amortised at `--concurrency 5–6` (measured: 10 cells in 201 s,
12 in 309 s, 10 in 217 s), so ~1.3 h for a 100-task two-cell sweep. No shared service,
no disk growth, no reset between tasks — none of TAC's failure modes apply.

One run came within $0.0005 of the `--max-cost 3` cap: `80acbaf_1` vanilla L1 at
$2.9995 (151 ground-truth calls, 139 actions). It reports `stopReason: completed` and
is not flagged `capped`, but a value that close to the ceiling should not be trusted as
an uncensored measurement. It is a b1 run and is **not** in the §3 analysis set. No cell
in the analysis set exceeded $1.04.

---

## 5. Recommendation

**GO for cost work, NO-GO for score work.**

1. **Do not run the full 417** (~$254 for two cells, ~$544 for three). It buys a
   tighter interval on a result already at t=35.8 / sign 10/10, and no score signal at
   all. A 30-task stratified sample at ~$18 (2 cells) would triple the n on both
   contrasts and is the most this deserves.
2. ~~Spend the next dollar on the API-call-parity question.~~ **Done, §3.1** — at zero
   API cost, via `bench/appworld/work-parity.mjs`. High stratum is ~$0.57, the low
   stratum needed no adjustment, and the pooled figure moved $0.248 → $0.242 on a
   parity-matched subset. There is no outstanding caveat on the representation term.
3. **If a discriminating score is wanted, challenge is not it.** Both non-passes were
   protocol errors. Look at `scout-terminal` or `scout-tau` for headroom.
4. **Carry the `>= threshold` convention forward.** Any AppWorld task with a numeric
   threshold in `public_data` should have its boundary checked before a failure on it
   is called AGENT.

### Limitations

In the order they should worry a reader.

1. **Two positive controls, both hand-written by me.** `07bb666_3` (d1) and
   `dcb2559_3` (d2). The challenge split ships no reference solutions, so there is no
   way to scale this without a human authoring more. Both carry the full control pair on
   their own task (§1), and the grading *machinery* is verified 147/147 on train+dev —
   but a systematic defect in challenge-only `evaluation.py` files would not be caught
   by n=2. This is the weakest link in the report.
2. **`07bb666_3` carries a REFERENCE defect** (§1.1): "over 4.3" is graded as `>= 4.3`
   against the *rounded* rating. It is a generator-wide boundary convention. The task is
   retained as a control because it is self-consistent and gradeable; what it changes is
   **attribution** — an agent failing a threshold task by reading the instruction
   literally has made a REFERENCE failure, not an AGENT one, and must not be counted as
   an agent error. Any future AppWorld work touching numeric-threshold tasks inherits
   this.
3. **One replicate per cell.** `factorial.mjs` prints
   `REPLICATE NULL CONTROL: not available` on every table here; the noise floor for this
   split is unmeasured. The residency effect (t=26–36) is far outside any plausible
   noise, but the representation effect is not so far outside that a replicate would be
   wasted.
4. **The high-stratum work-adjusted figure rests on n=2 matched tasks** plus a
   model-based extrapolation that happens to agree with them. Two independent routes
   landing on ~$0.57 is reassuring, not conclusive.
5. **Opus 5 only.** Residency is a token-price effect and scales with model cost;
   representation is a capability effect and may not survive a weaker model. Untested
   here, as everywhere else in this project.
6. **b1-contaminated runs are excluded from the analysis but present in the run table**
   — the six hard-probe vanilla cells and the tier-3/5/10 vanilla cells (§2.1). They are
   labelled by prompt in the table and are not averaged into anything in §3.
7. **`tools / docs in` was never run**, so the interaction term and both `docs-in`
   contrasts are unmeasured on this split. `factorial.mjs` names them as SKIPPED rather
   than computing them from a smaller task set.

### What changed in the repo

| file | change |
|---|---|
| `bench/appworld/challenge-p0.py` | new — negative/positive grader controls for the held-out splits, logging inputs alongside verdicts; `status` subcommand + `solutionDigest` so a superseded attempt cannot read as an open failure (§1.0) |
| `bench/appworld/challenge-solutions/*.py` | new — two hand-written reference solutions, the positive control |
| `bench/appworld/stratify.mjs` | `--split test_challenge`; call counts from shipped metadata, validated exact on 147/147 train+dev |
| `bench/appworld/sweep.mjs` | vanilla prompt derived from residency per cell instead of hardcoded `b1` |
| `bench/appworld/factorial.mjs` | `--cells` for a deliberately partial design; contrasts needing an absent cell are skipped and named, never computed from a smaller task set |
| `bench/appworld/work-parity.mjs` | new — resolves the API-call-parity confound from runs on disk: per-task parity table, matched-work subset, cost-per-call, and a labelled model-based counterfactual (§3.1) |
| `bench/test/appworld-fairness.test.mjs` | 3 new assertions pinning the prompt/residency pairing |
| `bench/test/fairness.test.mjs` | updated the `usable`-set assertion for the `--cells` refactor; added one pinning that a contrast whose cell was not run is *skipped and named*, never computed from fewer tasks |

### Provenance

All 54 runs are under `.run/appworld/<task>__<arm>__<residency>__<prompt>__<model>/`
with `trajectory.jsonl`, `env-calls.jsonl`, `world-diff.json`, `evaluation.json`,
`system-prompt.json` and `dbs/`. Phase-0 control evidence is in
`.run/appworld/p0-challenge.jsonl`. Grading is `minimal` ground-truth mode on every
challenge run, recorded per run as `groundTruthMode`.

Opus 5 only, one replicate per cell. `factorial.mjs` prints
`REPLICATE NULL CONTROL: not available` on every table above — the noise floor for
this split is unmeasured, and every effect here is provisional in that specific sense.
