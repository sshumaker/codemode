# Benchmark selection — replacing MCP-Bench/TAC for the representation thesis

> **PICK: AppWorld** (`vendor/appworld`, pinned `a072b7a`, data `0.2.0`).
> Installed, its own test suite passes (**110 passed, 2 skipped**), and its own
> end-to-end task verification passes **147/147 in 26s** locally with no network,
> no Docker, no credentials.
>
> The single reason it wins: **473 APIs with schemas, all exposed to every task.**
> Measured on the wire, the JSON-tool-calling arm carries **101,137 prompt tokens
> on its first turn**; the codemode arm carries **4,630** — 21.8x, and $0.63 of
> that first turn is cache-write before the agent has done anything. Enough that
> upstream's *own* baselines cannot fit the catalogue and run a separate LLM "API
> predictor" to guess ≤20 tools first — in **both** their function-calling and
> their full-code agent. The context-bloat half of the thesis is not a hypothesis
> on this benchmark; it is a constraint upstream already had to engineer around.
>
> **The primary result is a 2×2 (§10), not a head-to-head.** Representation (code
> vs JSON tool calls) and documentation residency (in-prompt vs on-disk) have been
> confounded in every measurement this project has taken — and in upstream's, whose
> *full-code* agent runs the same ≤20-API LLM pre-pass as their tool-calling agent
> because it interpolates the docs into the prompt. Separated, on 8 tasks × 5 cells
> including upstream's own predictor baseline:
>
> | cost | docs resident | docs non-resident |
> |---|---|---|
> | **code** | $0.682 | **$0.156** |
> | **tools** | $1.213 | $0.731 (predictor: $0.644) |
>
> **TGC is 6–7 of 8 in every cell** — no score signal at this sample size, and the
> variance flips TGC on re-runs of an identical configuration (§10.6). Cost and
> context are the endpoints; score is reported and not read.
>
> On a larger stratified sample (20 tasks, 10 per stratum, §10.4) the two factors
> separate into different *kinds* of quantity:
>
> | per-task saving | low stratum (11.5 calls) | high stratum (101.8 calls) |
> |---|---|---|
> | residency | $0.524 | $0.504 |
> | representation | $0.070 | $0.764 |
>
> These are the thesis's own two mechanisms — schemas need not be resident, and code
> composes — so the result reassigns credit rather than overturning the claim. But
> the two are **not the same kind of quantity**, which a single 2×2 hides and
> stratification (§10.4) exposes: **residency is a fixed ~$0.51 tax regardless of task
> size; representation is proportional to the work done, $0.07 on a ten-call task and
> $0.76 on a hundred-call one.** Any single-number decomposition describes its
> sample's median task and nothing more.
>
> Within the representation term, **emission outweighs reception about 7 to 1**
> (§10.5): forbidding the code arm to filter anything raises its context 115% and its
> cost 74% while barely moving its output tokens, and it remains 3.8x cheaper than
> tool-calling anyway — because one code block per turn against one tool-call block
> per call is a property of the interface that no amount of filtering, batching or
> server-side projection can recover. The pagination caveat (§6) bites the magnitude
> of the representation term, not the direction of either.
>
> **Both representations are constructible from one source**, which is the thing
> TheAgentCompany could not offer. AppWorld ships the same 473 API descriptions
> pre-rendered in five containers (`standard`, `function_calling`, `mcp`,
> `smolagents`, `openapi`) from one authored description per API. We add a sixth
> (importable Python modules) with the existing `bench/generate.mjs` renderer.
> The fairness mechanism in `docs/DESIGN.md` — one authored description, N
> containers, no paraphrase — transfers unchanged.
>
> **The honest caveat, stated up front:** AppWorld was designed for interactive
> *coding* agents, and its APIs are paginated (`show_playlist_library(page_index=…)`),
> which rewards loops, which favours code. MCP-Bench had the mirror bias.
> Neither benchmark is neutral; the defence is running on both and reporting both.
> See [§6 Threats to validity](#6-threats-to-validity).

---

## 1. What the four criteria actually demanded

Restating them as pass/fail questions, because "composition-heavy" and
"objective grading" are the kind of phrases that survive contact with a
benchmark that does not have them:

- **(a) Catalogue.** Can I build *both* a JSON-tool-definition arm and an
  importable-`api/`-tree arm from one authored source, at a scale where schema
  residency actually costs something? TAC failed here at zero tools.
- **(b) Composition.** Does the median task need many calls, across apps, with
  joins and filtering? A single-call task cannot distinguish the arms at all.
- **(c) Grading.** Programmatic. MCP-Bench's LLM judge already cost this project
  a result set (single-sample judging with noise the size of the effect).
- **(d) Operations.** Local or stably credentialed. MCP-Bench lost result sets to
  403s and rate limits; TAC lost a day to a token that expired in 2025.

---

## 2. Comparison

| | **AppWorld** ✅ | τ²-bench | BFCL v4 | StableToolBench | MCP-Universe | *(TheAgentCompany)* |
|---|---|---|---|---|---|---|
| **(a) catalogue** | **473 APIs / 11 apps**, all exposed every task. Pre-rendered in 5 containers from one description each. 101K measured prompt tokens as resident JSON fn-defs | ~15–30 tools/domain, 5 domains | Varies; often ≤5 tools per case | 7,000+ RapidAPI endpoints, but descriptions are scraped and wildly uneven | 11 MCP servers, ~100s of tools | **0 (no MCP, no tool catalogue)** |
| **(b) composition** | **median 36 API calls/task** (mean 52.7, max 244); 2–4 apps; 11.6 writes/task | multi-turn dialogue, few calls | agentic subset multi-step; non-live/live largely single-call | multi-call but shallow | multi-step, cross-server | long-horizon, but no tool surface |
| **(c) grading** | **DB-state diff + unit tests + answer match. No LLM anywhere** | state-based + action checks; strong | **deterministic AST match** — most reproducible of the five | GPT-4 judge (solvable pass/win rate) | execution-based, static + dynamic evaluators | rule-based checkpoints **+ LLM judge on 26/175** |
| **(d) operations** | **fully local, in-memory SQLite, 147 tasks in 26s, no creds** | local sim + user-simulator LLM | local; executable subset calls live REST | local cache server, ~large download | **needs live GitHub / Google Maps / Yahoo Finance / Blender** | Docker stack, no parallelism, expired token |
| **licence** | Apache-2.0 (protected parts in encrypted bundles) | MIT | Apache-2.0 | Apache-2.0 | Apache-2.0 | MIT |
| **headroom** | not saturated (GPT-4 launch: 48.7 TGC / 21.0 SGC) | not saturated | high on non-live | partly saturated | GPT-5 fails >50% | ~19/40 here |

### Scores, verified rather than remembered

Everything in the AppWorld column was measured in this repo, not read off a paper.
Reproduce with the probes in §5.

```
apps/APIs           11 apps, 473 APIs   (amazon 75, spotify 92, splitwise 65,
                                         todoist 56, venmo 54, gmail 48,
                                         phone 30, file_system 26, simple_note 17,
                                         supervisor 6, api_docs 4)
tasks               train 90 | dev 57 | test_normal 168 | test_challenge 417
catalogue tokens    function_calling  76,118   (cl100k, as shipped)
(all 473 APIs)      smolagents        76,335
                    standard         110,616
                    mcp              155,427
                    openapi          207,795
as built for the arm (469 tools — api_docs excluded, canary strings and
`"default": null` stripped):
                    JSON fn-defs (L4)  61,719
                    TOC lines    (L2)  12,004
                    names        (L1)   3,039
measured on the wire, Anthropic tokenizer, first-turn prompt including base
prompt and tool-definition framing:
                    vanilla L4        101,137
                    codemode L0         4,630     <- 21.8x
for scale — MCP-Bench, this repo: 250 tools / 51,240 tokens, and it narrows to
task-relevant servers; AppWorld narrows to nothing.
```

Ground-truth solutions executed over all 147 train+dev tasks:

```
API calls / task      mean  52.73   median  36   min 5   max 244
distinct APIs / task  mean  26.41   median  12   min 5   max 119
apps touched / task   mean   2.39   median   2   min 2   max 4
write calls / task    mean  11.60   median   5   min 1   max 102
grader tests / task   mean   5.33   median   6   min 2   max  10
difficulty            1:66  2:60  3:21
```

A median of 36 calls across 2 apps with 5 writes is composition, not tool-lookup.
For comparison, MCP-Bench tasks in this repo run ~10 calls.

---

## 3. Why AppWorld, in one paragraph each

**The catalogue is the whole point.** 473 APIs are exposed to *every* task —
there is no per-task narrowing, so retrieval is genuinely part of the problem and
the resident-schema cost is a constant ~101K prompt tokens rather than something that
varies with the task and confounds the comparison. AppWorld ships an `api_docs`
app (`show_api_descriptions(app_name=…)`, `show_api_doc(app_name=…, api_name=…)`)
which is *itself* a deferred-schema surface, authored by the benchmark rather than
by us — evidence that "names resident, schemas on demand" is the shape upstream
also reached for. It is excluded from both arms' catalogues so that neither gets a
second residency mechanism on top of the one under test.

**Upstream already conceded the bloat claim — in both representations.** Read
`vendor/appworld/experiments/code/simplified/function_calling_agent.py:117-121`.
Before the agent takes a single step, an `APIPredictor` LLM call guesses up to 20
API names, and *only those* schemas are passed as `tools=`. Upstream did not do
this for elegance; 473 function definitions do not fit alongside a task.

The sharper observation is that their **code** agent does the same thing:
`full_code_agent.py:119-123` builds `api_documentation_string` from
`self.predicted_apis` and interpolates it into the prompt. So upstream's code
agent is *also* pre-filtered to ≤20 APIs — because it puts the documentation in
the prompt rather than on disk.

That reframes the thesis more precisely than "code beats tool-calling". **The win
is documentation residency; code is what makes non-resident documentation
usable.** A code agent whose docs are in its prompt has exactly vanilla's problem.
Our codemode arm's difference from upstream's own code agent is `grep`, and that
is the difference that removes the predictor. Worth stating this way in the
writeup, because it predicts something a "code is better" framing does not: an
L4 codemode arm should lose most of its advantage.

**Grading has no LLM in it.** The grader is Python that reads the database.
Two representative assertions, verbatim from `82e2fac_1`:

```python
test.answer(predicted_answer, ground_truth_answer)   # answer match
test.case(models.changed_model_names(), "is_falsy")  # no collateral damage
```

`models.end.<app>.<Model>.all()` reads end-state; `models.changed_model_names()`
catches writes the task did not ask for. Nothing to re-judge, nothing to
k-sample, no judge-noise error bar. The one thing to remember is in §4.

**Operations are a different league.** 147 tasks, ground truth, evaluation
included: **26 seconds wall-clock, 6 processes, zero network calls, zero
credentials, zero containers, 188 MB of data.** TAC needed a Docker stack that
could not run two tasks in parallel because every `init.sh` called `reset.sh`.
AppWorld worlds are independent in-memory SQLite databases; `--num-processes 6`
just works. This is the difference between iterating tonight and iterating next
week.

---

## 4. Traps, and the shapes they came in

### 4.1 `raise_on_failure` must be `False`, or codemode is systematically penalised

`AppWorld(...)` defaults to raising a Python exception inside the interpreter when
an API returns an error. Under that default, **11 of 147 ground-truth solutions
fail** — measured, then diagnosed by flipping the one flag:

```
raise_on_failure=True   0d8a4ee_1: success=False 1/5   'Execution failed. Traceback: …'
raise_on_failure=True   37a8675_1: success=False 0/6   'Execution failed. Traceback: …'
raise_on_failure=True   3ab5b8b_1: success=False 4/6   'Execution failed. Traceback: …'
raise_on_failure=True   57c3486_1: success=False 3/5   'Execution failed. Traceback: …'
raise_on_failure=False  0d8a4ee_1: success=True  5/5   'Execution successful.'
raise_on_failure=False  37a8675_1: success=True  6/6   'Execution successful.'
raise_on_failure=False  3ab5b8b_1: success=True  6/6   'Execution successful.'
raise_on_failure=False  57c3486_1: success=True  5/5   'Execution successful.'
```

Upstream's verifier passes `raise_on_failure=False` (`src/appworld/verify.py:154`).
This is not cosmetic and it is not arm-neutral: **an uncaught exception kills the
rest of the cell.** Codemode issues many calls per cell, so one failing probe
destroys the work after it; vanilla loses exactly one tool call. Left at the
default, the harness would have quietly biased against the arm under test — the
same shape as the `curl`-bypass and base-prompt-length confounds in `CLAUDE.md`.

### 4.2 `pass_count/total_count` is the TAC bonus-inflation bug again

A run that does *literally nothing* scores **1/2** on a read-only task, because
the "no collateral damage" assertion passes trivially. Measured:

```
82e2fac_1  gt         success=True   2/2 tests  api_calls=71
82e2fac_1  nothing    success=False  1/2 tests  api_calls=0
82e2fac_1  wrong      success=False  1/2 tests  api_calls=1
82e2fac_1  no_answer  success=False  1/2 tests  api_calls=1
```

Identical on `82e2fac_2` and `82e2fac_3`. **Rank by `tracker.success` (TGC — all
tests pass), never by test fraction.** The fraction is `hr-check-attendance-one-day`
reporting 3/3 for both arms while both fail checkpoint 1, in a new costume. Report
TGC and SGC (scenario-level: every task in a scenario passes), which is what the
leaderboard uses; keep the fraction only as a diagnostic.

### 4.3 The frozen clock: `time.clock_gettime` is the only real one

AppWorld freezes the process clock to the task's own datetime with freezegun, so
every timestamp any harness code takes comes back as the same value —
`1684411200.0` for every event of every run of that task.

**Saving a reference to `time.time` before the freeze does not work.** freezegun
walks `sys.modules` and swaps every alias of the functions it fakes, so a
module-level name captured at import time is replaced along with everything else.
That is the fix everybody tries first. Measured under `freeze_time`:

```
time.time()                            1684411200.0
saved reference to time.time           1684411200.0   <- the obvious fix, and it fails
time.monotonic()                       1684411200.0
time.time_ns()                         1684411200000000000
time.perf_counter_ns()                 1684411200000000000
time.clock_gettime(CLOCK_REALTIME)     1786434734.086358   <- real
```

`time.clock_gettime(time.CLOCK_REALTIME)` is the one clock freezegun leaves alone.
Any harness process that shares an interpreter with a frozen clock — timestamps,
phase boundaries, durations — has to read the wall clock through it.

Nothing about this is AppWorld-specific: it applies to any benchmark that freezes
time in-process, which is most of the ones that need deterministic dates.

### 4.4 A rule that was documented and never executed

`CLAUDE.md` has said "always run the paired t-test, never eyeball the means" since the
v3 episode, when an early 5-task comparison ranked a variant *worse* that 24 cells
later showed significantly better. **No code in this repository implemented one.**
`bench/compare.mjs` spawns arms and parses streams; `bench/report.mjs` computes
per-task deltas and reports mean cost and turn *ratios* and stops. Every comparison
this project has made since was ratios-over-paired-tasks with the test statistic
missing.

That is the same failure as the vanilla L1 arm that was never L1 (§8): **the check was
documented, not executed**, and nothing distinguished the two states from the outside.
A rule written into a project's own instructions reads as being in force.

`bench/stats.mjs` is the missing implementation — paired t with a real incomplete-beta
p-value, an exact two-sided sign test, validated in `bench/test/stats.test.mjs`
against published critical values at df=9 and df=10. It is shared so `compare.mjs` and
`report.mjs` can adopt it. The rule that matters when the two tests disagree — believe
the sign test, because cost is right-skewed — lives in the module's own docstring
rather than in a convention someone has to remember.

The generalisable version: **for every rule in `CLAUDE.md` that describes a check,
there should be something that fails when the check is absent.** Prose cannot tell you
it is not running.

**And a second clause, which caught a bug the first would have missed.** Moving a
number out of a scratch script into committed, shared code is *itself* a check —
because the act of making it re-derivable forces its inputs into the open. On the
other track, the priced decomposition was moved into `bench/factorial.mjs` purely so
the write-up's numbers could be reproduced, and it immediately exposed that the scratch
version had averaged over all completed runs per tier rather than over the paired
tasks. The published figures were wrong and the totals did not reconcile with the
contrasts they were supposed to explain.

Note what the first clause would *not* have caught: `factorial.mjs` asserts that the
prompt and output terms reconstruct the measured cost difference to within $0.005, and
that assertion passes on both the wrong and the right denominators — it validates the
prices, not the population. Guarding a known invariant and making a number
re-derivable are different mechanisms, and only the second catches "computed correctly
over the wrong set of runs".

The actionable form of clause 2, from where the errors actually clustered across both
tracks: **wrong-input errors come from not checking the shape of the data you are
computing over** — which tasks, which cells, which replicates, which runs got averaged.
The arithmetic is rarely the problem. Naming the population in committed code is what
forces that check, because a scratch script lets the denominator stay implicit.

### 4.5 The recurring failure shape: no error, no output, looks like slowness

Four separate hangs tonight had the same signature — a live parent process, no
exception, no output, and something that reads as "this is just slow":

1. **`multiprocessing` under `spawn`.** macOS defaults to the `spawn` start method,
   which re-imports the main module in every child. A script passed with `python -c`
   has no module to re-import, so `Pool(6)` produced a live parent, **zero workers in
   `ps`**, and silence for 11 minutes. Writing the same script to a file runs it in
   28s.
2. **Print mode waiting on stdin.** The CLI emits *nothing at all* if stdin is open
   and empty, so two ten-minute probes looked like kernel hangs. The real runner
   passes `stdio: ["ignore", …]`.
3. **The 285 MB kernel venv page-faulting in** (§10.1) — 70s cold, 4.8s warm on an
   identical configuration, which reads as "codemode is slower".
4. **`SafetyGuard` disabling `open`** (§8) — logging that silently did not happen,
   swallowed by an `except: pass` whose comment said logging must never break a run.

The general rule, which is `CLAUDE.md`'s: **assert on the observable effect, never on
the absence of an error.** Workers exist. The transport was reached. Bytes were
written. A cell ran. Each of those is a cheap positive check, and each of these four
would have been caught in seconds by one.

### 4.6 Smaller notes

- The task's `AnswerType` is submitted via `apis.supervisor.complete_task(answer=…)`.
  An agent that computes the right answer and never calls that API scores zero.
  Both arms must be told this; it is arm-neutral guidance and belongs in the base
  prompt, not in either preamble.
- `num_solution_code_lines` returns 3 for every task — it parses the uncompiled
  stub, not the compiled solution. Do not use it as a difficulty proxy; use
  executed API-call counts (§2) or the shipped `difficulty` 1/2/3.
- Ground truth exists only for `train`/`dev` and requires
  `load_ground_truth=True, ground_truth_mode="full"`. `required_apis` throws a
  confusing exception in `"partial"` mode.
- `train`/`dev` only exercise 5 of 9 apps (spotify, phone, venmo, file_system,
  simple_note). **Do not stratify a validation set off train/dev and assume it
  covers the catalogue** — that is precisely the mistake that hid every
  `sde-*`/GitLab failure in the TAC sweep. Use `test_normal` for the real run.
- Viewing `test_*` solutions is prohibited by the licence; error analysis goes on
  train/dev only.
- `black` and `pytest` are needed for ground-truth line counting and the test
  suite but are not package dependencies.
- Python 3.14 is the homebrew default here and `pydantic>=2.12` is pinned *for*
  3.14 compatibility, but the install is on **3.12.2** to stay on the version the
  classifiers list first and CI exercises.

---

## 5. What is installed, and how to reproduce it

```bash
cd vendor/appworld                       # gitignored
git log -1                               # a072b7a  2026-02-17
uv venv --python 3.12 .venv && . .venv/bin/activate
uv pip install -e . && uv pip install black pytest
appworld install --repo                  # unpacks encrypted app/task bundles
appworld download data                   # 188 MB -> ./data, version 0.2.0

appworld verify tests                    # 110 passed, 2 skipped, 64s
appworld verify tasks --num-processes 6   # 147/147, 26s
```

Pins that matter: `appworld` 0.2.0.dev0 (editable, commit `a072b7a`),
`pydantic` 2.13.4, `fastapi` 0.141.1, `sqlmodel` 0.0.39, `ipython` 9.16.1,
`starlette` 1.6.0, Python 3.12.2. The two skipped tests are the MCP-server tests,
which need the `mcp` package — install `mcp>=1.19.0` only if we decide to route an
arm through `appworld serve mcp`.

`data/api_docs/{standard,function_calling,mcp,smolagents,openapi}/*.json` are the
five pre-rendered containers. `function_calling` is the source for our catalogue —
it is already JSON Schema, converted by the benchmark, and it is exactly what
upstream passes as `tools=`. `standard` states its constraints as prose
(`"value in ['charcoal', 'red', …]"`, `"length >= 10, <= 10"`), and putting a
hand-written prose-to-schema converter between the benchmark and the arm under
test is a bug waiting to deform one arm's view of a tool. `standard` is read only
for `response_schemas`, behind `--with-response-schemas` (off by default so
vanilla matches upstream's baseline).

---

## 6. Threats to validity

### 6.0 Limitations, in the order they should worry you

1. **Partly reproduced, with one claim refined.** MCP-Bench has now been run as the
   same 2×2 (`docs/MCPBENCH-2X2.md`, §10.4a). **Composition-scales-with-work
   reproduces**; **residency-is-a-flat-tax does not**, and the reason is that AppWorld
   pins both inputs to residency cost while MCP-Bench varies both — so the AppWorld
   figure measures a special case. Treat composition's *ordering* as portable and its
   *magnitude* as benchmark-specific (pagination, §6.1); treat residency as
   `extra prompt tokens × price`, which is exact, and ask what the harness does to
   those tokens rather than expecting a constant. Still only two benchmarks, one model,
   and MCP-Bench at n=1 per cell with no measured noise floor.
2. **Score is not measured, only cost and context.** TGC is 19–20/20 in every core
   cell and §10.6 shows an identical configuration flipping 8/8 → 3/8 on a re-run.
   Nothing here says code produces *better* answers, only cheaper ones at equal
   outcomes. A score claim needs `test_normal`/`test_challenge` and far more paired
   cells than exist.
3. **train+dev only.** Ground-truth call counts — the stratification variable — exist
   only there, because the licence withholds test-set solutions.
4. **One model — Opus 5 throughout — and the two terms should generalise differently.**
   The residency tax is a **token-price** phenomenon: it is a fixed number of resident
   tokens billed per turn, so it scales with price-per-token and would shrink in
   absolute terms on a cheaper model while staying the same in tokens. The
   representation term is a **capability** phenomenon: it requires the model to write
   a correct pagination loop, aggregate across apps, and choose what to print, and it
   may simply not survive a weaker model — a model that cannot use the REPL well gets
   none of it. Neither is tested. `CLAUDE.md` already records that Opus and Sonnet
   disagree about configuration on MCP-Bench, so do not generalise across models on
   our behalf.
5. **Two conditions are confounded and are excluded from the conclusions**, not merely
   caveated: `tools/docs-in` did materially less work than `tools/docs-out` in the high
   stratum (37.6 vs 63.0 API calls), so both contrasts that involve it fail the sign
   test and are not quoted (§10.4).
6. **The mirror test is a lower bound on reception cost**, not a perfect proxy for a
   projected tool: `a2` still returns one cell result per turn rather than 63 separate
   tool results. Hence a bracket rather than a point (§10.5).
7. **One cell is cost-censored.** On `34d9492_2`, `tools/docs-in` hit the `--max-cost`
   $3 cap on **all three replicates** ($3.022 / $3.029 / $3.014), so its true cost is
   above $3 and the recorded figure is a lower bound. Consequences, stated precisely
   because a censored value averaged in silently is exactly the kind of thing a reader
   should not have to discover:
   - **Neither surviving claim is affected.** `residency, code row` and
     `representation, docs-out` do not involve that cell.
   - The two **already-excluded** contrasts do involve it, and censoring biases them
     **toward zero** — `representation, docs-in` reads $0.531 and the truth is higher.
     That is a fifth independent reason not to rehabilitate them on these numbers.
   - The **2×2 cell table understates `tools/docs-in`**, and therefore understates the
     `docs-in` column of §10.2.
   `factorial.mjs` now prints censored cells before anything else and tags affected
   contrasts `[CENSORED: lower bound]`. The fix, if it ever matters, is to raise the cap
   and re-run **all four cells** under a new tag — raising it for the expensive cell
   only would make the treatment asymmetric.

   Note the direction differs from the mirror case on MCP-Bench, which caps in the
   *cheap* cell at `--max-cost 1.0` and drops capped tasks whole: that yields an
   unbiased estimate over a range truncated on the axis being measured. Here the cap
   binds the *expensive* cell and the value was averaged in rather than dropped, which
   biases one cell low instead of narrowing the sample. Both are censoring; they need
   opposite corrections.



**The benchmark is code-native, and that is a real bias.** AppWorld's paper is
about interactive coding agents; the interpreter with `apis.<app>.<api>(…)` is the
native action space; the APIs are paginated so `find_all_from_pages`-shaped loops
are the intended idiom. A JSON-tool-calling arm has to issue one call per page.
That is a genuine advantage for codemode which is *not* about representation.

Three things keep this honest rather than fatal:

1. **We construct both arms ourselves, from the same schema files.** Upstream's
   choice of action space does not propagate into our independent variable; the
   only difference between our arms is how the catalogue is shown.
2. **MCP-Bench is the mirror-image control** — designed for JSON tool calling,
   and codemode won there anyway (+0.050, t=+2.14). A thesis that wins on both a
   code-friendly and a tool-call-friendly benchmark is worth more than one that
   wins on either. Report both; do not retire MCP-Bench.
3. **Pagination is separable and must be reported separately.** Log calls per
   task per arm; if codemode's margin is entirely explained by page-fetch loops,
   say so. That is a finding about API surfaces, not about representation, and
   `parallelism_and_efficiency` on MCP-Bench already showed this project will
   mistake one for the other if it does not look.

**A second-order worry:** the `api_docs` app means the codemode arm has two
discovery paths (grep the `api/` tree, or call `api_docs`) while vanilla L4 has
its schemas resident and no need to discover. Fine, but it means "turns spent on
discovery" is not comparable across arms without care. Count *distinct APIs
correctly invoked* alongside turns.

**Canary string.** `appworld:d17ac3f:26b5c67b-…` appears in every shipped doc
file. It exists so labs can filter training data; its presence in the catalogue we
inject is harmless but should be stripped from prompts so it does not eat tokens
or trip filters.

---

## 7. What each rejected option would and would not have told us

**τ²-bench** — the best *grading* of the five and a genuine user simulator, so it
would have told us how each representation behaves when information has to be
elicited from a human mid-task, which is a real weakness of code-first agents
(you cannot `await input()`). It would **not** have told us anything about schema
residency: 15–30 tools per domain fit in context with room to spare, so the
independent variable's main mechanism is absent. Worth revisiting *specifically*
for the wait/ask-the-user affordance in `HOSTED-RUNTIME-DESIGN.md`, where its user
simulator is the asset.

**BFCL v4** — the most reproducible grader in existence for this problem (AST
match against a reference invocation, no judge, no state). It would have told us
about single-call *accuracy* per representation with essentially zero measurement
noise. It would **not** have told us about composition: the AST matcher compares
against one reference call sequence, which is exactly the thing a code arm is
allowed to reach differently, so the metric structurally penalises the arm under
test. Its v4 agentic subset (40% weight) is closer, but then grading is no longer
AST-deterministic and the tool counts per case stay small. Good future *sanity
check* on whether our generated `api/` modules preserve call correctness; wrong
instrument for the thesis.

**StableToolBench** — 7,000+ endpoints is the only catalogue that dwarfs
AppWorld's, and the cached virtual API server is a genuinely good answer to
ToolBench's dead-API problem, so it would have told us how the two
representations scale to a catalogue too large for *any* residency strategy. It
would **not** have given us objective grading: pass/win rate is a GPT-4 judge,
which is the exact weakness we are moving away from, and RapidAPI descriptions are
scraped and uneven — so the "one authored description, N containers" fairness
mechanism degrades into "which container best survives bad prose", which is a
question `CLAUDE.md` explicitly says nobody cares about.

**MCP-Universe** — MCP-native and execution-graded, so it would have told us about
real MCP servers rather than our rendering of them, with dynamic evaluators that
handle live data honestly. It would **not** have run reliably: GitHub, Google
Maps, Yahoo Finance and Blender are live external services. This project has
already lost whole result sets to 403s and rate limits and a day to an expired
token; criterion (d) exists because of that history, and this candidate fails it
by construction.

**TheAgentCompany** — kept for the record. Zero MCP servers, so no catalogue, so
no independent variable. Still the right substrate for the durability/wait work
(`docs/TAC-HANDOFF.md` §5), and its 40-task result stands as a valid measurement
of *code execution vs shell-and-file tools* — which is a different claim.

---

## 8. The integration, as built

```
bench/appworld/build-catalogue.mjs   data/api_docs/function_calling/*.json
                                     -> bench/data/appworld-schemas.json
                                     (10 apps, 469 tools — the MCP catalogue shape
                                      bench/generate.mjs already consumes)
bench/appworld/prompts.mjs           one shared BASE, one preamble per arm
bench/appworld/env-server.py         one AppWorld world per task, HTTP in front
    POST /call   {server,tool,args}  -> world.execute("print(apis.<app>.<api>(**{…}))")
    POST /execute {code}             -> world.execute(code)   [native control arm]
    GET  /snapshot                   -> world diff, before grading
    POST /evaluate                   -> verdicts + the grader's inputs
bench/appworld/run-task.mjs          prime-agent, one arm, one task, full trace
bench/appworld/sweep.mjs             the ONE way to run more than one task
```

**No new renderer was written.** `bench/generate.mjs` produces all four containers
from the AppWorld catalogue unchanged, and the vanilla arm reuses
`bench/arms/mcp-tools-extension.ts` verbatim, because the env-server speaks the
MCP proxy's `/call` protocol. That is why the fairness invariants in
`bench/test/fairness.test.mjs` still apply: one authored description per API, four
renderings, one transport.

Both arms go through `POST /call`. Non-negotiable: it is the invariant that
stopped vanilla `curl`-ing around its own tool surface on MCP-Bench, and it means
one log holds every call either arm made. `/call` dispatches via
`world.execute("print(apis.<app>.<api>(**args))")`, which is literally what
upstream's function-calling agent builds (`function_calling_agent.py:185`) — using
upstream's own mechanism instead of poking `world.requester` is the direct lesson
from TAC bug #1.

### Arms

| arm | tool surface | catalogue | ctx0 | built |
|---|---|---|---|---|
| `codemode` L0 | `ipython` | generated `api/` tree on disk, pointer only in prompt | 4,627 | ✅ |
| `vanilla` L1 | `search_tools`/`describe_tool`/`call_tool` | names resident, schemas on demand | 8,989 | ✅ |
| `vanilla` L4 | 469 JSON tool defs | resident every turn | 101,134 | ✅ |
| `notools` | none | validity control | 1,246 | ✅ |
| `vanilla-predictor` | ≤20 JSON tool defs | upstream's own APIPredictor pre-filter | — | not yet |
| `appworld-native` | upstream `simplified_*` agents | external-validity anchor | — | not yet |

**L1 is the honest competitor and it is now working.** Comparing only against
all-469-resident answers "don't paste 469 schemas into context", which nobody
disputes; upstream ships an LLM pre-filter *precisely because* L4 is infeasible.
L1 is the architectural version of the same answer, and it costs no extra model
call. Getting there took three mechanisms, and the two that failed both produced
runs that looked fine:

1. **`--active-tools` CLI flag** — never reaches print mode's session worker,
   which rebuilds argv. Result: a run labelled L1 that was silently L4. That is
   what the residency guard in `run-task.mjs` exists to catch.
2. **Deferral by lazy registration** (what the extension used to do): `load_tool`
   calls `pi.registerTool`, the schema comes back correctly, the model calls the
   tool, and prime answers **"Tool `<name>` not found"** — `prepareToolCall`
   resolves against `currentContext.tools`, a per-turn snapshot of
   `agent.state.tools` (`packages/agent/dist/agent-loop.js:538`). Measured on
   AppWorld: **70 turns, 78 tool calls, 0 reaching the transport**, 32 errors,
   $1.71, task failed.
3. **Register everything up front, narrow with `pi.setActiveTools`** — the
   instructive near-miss. Residency was genuinely reduced (first turn 8,748 tokens
   against L4's 101,137), so the model really did stop seeing the catalogue, and
   execution *still* answered "not found". Advertisement and executability come
   from the same per-turn snapshot, and an extension cannot update it mid-loop.

So **dynamic tool identity is not expressible in this harness.** What is
expressible is a fixed tool set whose *arguments* carry the identity:
`search_tools` / `describe_tool` / `call_tool`, all registered at load time so
`prepareToolCall` always resolves them. This is also what a number of real MCP
harnesses ship. All three attempts are recorded in
`bench/arms/mcp-tools-extension.ts` so they are not retried, and the fix applies
to MCP-Bench too — whose L1 was broken in the same way (`bench/run-task.mjs`
already carried a "Known broken" note about it).

**The cost this arm pays, which must be reported with any result:** the provider
validates `call_tool`'s schema, not the inner tool's, so L1 loses the
argument-validation that L4 gets for free from a resident schema. That is a real
benefit of residency and is deliberately *not* neutralised — `call_tool` does no
local pre-validation, precisely so every arm receives the same error text
(see §8.1).

`vanilla-predictor` remains worth building as an external-validity anchor against
upstream's published numbers, but it is no longer the gap it was: L1 is a stronger
baseline than the predictor, since it defers schemas without spending an extra LLM
call.

### The prompts, and why MCP-Bench's winner was not reused

`q8` — the best MCP-Bench codemode prompt — says *"ten to twenty items is almost
always enough"*, *"enumerating an entire collection is scored as redundancy"*,
*"do not fetch broadly in case you need it"*. That is tuned for MCP-Bench's
`parallelism_and_efficiency` dimension and is **actively wrong here**: AppWorld
grades exact answers and database state, collections paginate at `page_limit <= 20`,
and upstream's own instruction is *"always process all results, looping through the
page_index."* A sampled answer is a failed task. Carrying `q8` over would have
measured how badly a cost-tuned prompt does on a completeness-graded benchmark.

`BASE_INSTRUCTIONS` in `bench/appworld/prompts.mjs` is AppWorld protocol only —
supervisor credentials, pagination, time handling, collateral damage, how to
submit an answer — **byte-identical for every arm**, digested into `meta.json` so
a divergence is a diff rather than an argument. It is adapted from the block
upstream's function-calling and full-code prompts already share verbatim, rather
than written here: prime's own base prompts differ 10x in length between the code
and non-code paths, and that confound already invalidated one result set.

### 8.1 Do the arms see the same errors?

If vanilla gets a clean tool-error where codemode gets a Python traceback, the arms
differ in error *legibility*, not representation — an agent that can read its
failure recovers, one that cannot burns turns. `bench/appworld/error-symmetry.mjs`
drives each arm's real transport against a live world and diffs what the model
would receive. Current state, all three cases **byte-identical**:

| failure | text both arms receive | codemode delivery | vanilla delivery |
|---|---|---|---|
| unknown api | `Execution failed. Traceback: … Exception: No API named 'no_such_api' found in the spotify app.` | string returned into the cell | tool result |
| missing required parameter | `{"message": "Validation error. Reason: \nsong_id: Input should be a valid integer…"}` | string returned into the cell | tool result |
| api-level refusal | `{"message": "Invalid credentials"}` | string returned into the cell | tool result |

Delivery differs, and that difference *is* the independent variable. Two design
choices keep the content matched:

- **A malformed call is not turned into a transport failure.** Returning
  `{"ok": false}` would make codemode's `_client` raise `McpError` inside the cell
  and destroy the remaining statements, while vanilla lost only the one tool call —
  the same batching-proportional asymmetry as `raise_on_failure`. Both arms get
  AppWorld's text; `execFailed` in the log is how the failure is still counted.
- **`call_tool` does no local argument validation.** A friendlier
  "missing required parameter: song_id" would have been more helpful and would have
  made L1's error differ from what codemode and L4 see for the same mistake.

The one asymmetry that cannot be removed, and should not be: at L4 the provider
validates arguments against a resident schema *before* the call is made, so some
malformed calls never reach the transport at all. That is a genuine benefit of
residency and belongs in the results.

### Logging (task 4), and the four bugs it took to get right

Per run, in `.run/appworld/<runId>/`:

| file | contents |
|---|---|
| `env-calls.jsonl` | the **arm's action log**: every API call with arm, app, api, args, **the exact code executed**, the **full response**, ok/error, `execFailed`, interaction number, real start and end timestamps |
| `http-calls.jsonl` | the **world's ledger**: every underlying HTTP request with method, path, request body, **status code** and full response body, flagged `tracked` to separate agent-initiated calls from AppWorld's own plumbing. Produced by `requester_trace.py`, which wraps `Requester._get/_post/_put/_patch/_delete` in-process — the same technique as `bench/tac/judge-trace.py`, not a proxy. It answers what `env-calls.jsonl` cannot: fan-out inside one cell (the `/execute` path can make fifty requests and print one line), the response when the agent prints a summary or prints nothing, and the HTTP status — "invalid credentials" as a 401 and as a 200-with-a-message are different facts about the world |
| `world-diff.json` | every DB record added / updated / removed, with full field values, taken **before** grading |
| `evaluation.json` | per-test verdicts *with the assertion source and the actual comparison*, plus the grader's inputs: ground-truth answer, committed answer, ground-truth mode |
| `appworld-output/dbs/` | AppWorld's own state dump; diff against the pinned `data/base_dbs` and the verdict is re-derivable without this process |
| `appworld-output/logs/` | AppWorld's own `api_calls.jsonl` and `environment_io.md` (every cell it executed) |
| `system-prompt.json` | base prompt, preamble, both digested, and the exact `--tools` list in order |
| `tools.json` | the resolved tool definitions the model actually saw |
| `trajectory.jsonl` | every stream event, each stamped `_t` on receipt |
| `stream.jsonl` | the raw stream, unmodified |
| `phases.json`, `result.json` | world-up / agent / snapshot / grade boundaries, summary, `stopReason` |

Four bugs, all found by **reading artefacts rather than trusting them**, all of
which produced plausible-looking output:

1. **`world.execute` only works on the main thread.** It installs a `signal.alarm`
   for its cell timeout, and `signal.signal` raises
   `"signal only works in main thread of the main interpreter"` anywhere else — so
   a mutex around the world is not enough, the call has to be *handed to* the main
   thread. The env-server's main thread is a job queue; HTTP handlers enqueue and
   block.

2. **AppWorld's `SafetyGuard` disabled our own logging, in proportion to
   parallelism.** It replaces `builtins.open`, `os.open`, `os.write`, `io.open`,
   `shutil.copy*` process-wide for the duration of *every* `world.execute`
   (`environment.py:1000`/`1020`) — it cannot tell agent code from harness code. A
   log write issued while any cell was mid-execution hit the disabled `open` and
   raised, and `record()` swallowed it because "logging must never break the run".
   **Measured: 8 concurrent `/call`s produced 1 log line; the first real vanilla
   run lost 3 of its 8 calls.** Note the shape — lines are lost in proportion to
   how many calls an arm issues *concurrently*, so the arm that batches more is
   logged less, silently. Fix: hold the file handle (and a reference to the real
   `open`) captured before `import appworld`; count and report failures instead of
   swallowing them.

3. **Every timestamp was `1684411200.0`.** AppWorld freezes the clock to the
   task's datetime with freezegun. Saving a reference to `time.time` before the
   freeze does **not** work — freezegun walks `sys.modules` and swaps every alias
   of the functions it fakes, including ours. Measured under `freeze_time`:
   `time.time()`, a saved reference, `time.monotonic()`, `time.time_ns()` and
   `time.perf_counter_ns()` are all frozen;
   `time.clock_gettime(CLOCK_REALTIME)` is the one clock it leaves alone.

4. **`changed_model_names(include=[…])` *restricts* rather than adds.**
   `candidate_model_names = include_model_names` (`collections/models.py:407`), so
   the obvious one-liner `include=["supervisor.Task"]` — needed because the
   no-argument form ignores that model by design — silently reduced the entire
   world diff to one record. Caught by reading one run: the grader passed 8/8 on
   assertions about `file_system.File` and `file_system.Directory` while
   `world-diff.json` claimed nothing but the task record had changed. Fix: union
   two calls. Now the same run records all 28 created files *with their content*.

Plus two smaller ones with the same signature — a plausible artefact that was
wrong:

- **`--force` merged runs instead of replacing them.** `env-calls.jsonl` is opened
  in append mode on purpose (a crashed run keeps everything up to the crash), so a
  re-run reported *122 api calls with 61 duplicates* where the run had made 61
  with none. The duplicates were the previous attempt. `--force` now clears the
  artefacts it does not own the lifetime of.
- **`appworld-output/` was silently missing from every run.** The env-server copies
  AppWorld's `dbs/` and `logs/` on shutdown, and `run-task.mjs` sent `SIGTERM`
  immediately after `/shutdown` — winning the race against a multi-megabyte
  `copytree`. Now it waits for exit, and sets `missingAppworldOutput` if the copy
  is absent.

And one that would have failed on exactly the split the real run uses: the
env-server hardcoded `ground_truth_mode="full"`, which **raises** on `test_normal`
and `test_challenge` (the licence ships only `minimal` ground truth for them). It
would have worked on every task validated so far and failed on every task that
matters — the TAC validation mistake precisely. It now tries `full`, falls back to
`minimal`, and records which it used.

---

## 9. Sample runs

> **Provenance warning for this section.** The `codemode L0` cells below were later
> re-run post-pre-warm **under the same runIds**, so the artefacts now in
> `.run/appworld/` are §10's numbers, not this section's. That is precisely the
> "runId scheme silently overwriting already-reported runs" hazard `CLAUDE.md`
> names, and I did it to myself: `--force` clears artefacts, but a re-run with an
> unchanged runId still replaces a result that has been written down. The tables
> here are retained as the record of the pre-pre-warm state — read §10 for anything
> current, and treat this section's latency figures as the artefact they were.
> A future sweep should put the pre-warm state in the runId, or never re-use one.

Five train tasks, stratified by app family, read/write mix, and call volume — not
by speed. `82e2fac_1` read-only spotify; `6c2c621_1` file_system+simple_note, 31
ground-truth writes; `22cc237_2` three apps; `4fab96f_2` phone+venmo, 19 writes;
`57c3486_1` the 176-call outlier. Opus 5, `codemode` L0/`a1` vs `vanilla` L4/`b1`.

```
task          arm       res   pass  tests turns tools  api dupes    ctx0    cost  secs
82e2fac_1     codemode  L0    PASS    2/2     6     5   61     0    4608  0.1060   255
82e2fac_1     vanilla   L4    PASS    2/2     8    62   62     0  101115  1.3888    64
6c2c621_1     codemode  L0    PASS    8/8     6     5   64     0    4645  0.0729   106
6c2c621_1     vanilla   L4    PASS    8/8    13    66   65     0  101152  2.4149   267
22cc237_2     codemode  L0    PASS    4/4    10     9   18     0    4667  0.1989   193
22cc237_2     vanilla   L4    PASS    4/4    12    21   21     0  101174  1.4764   120
4fab96f_2     codemode  L0    PASS    8/8     9     8   26     0    4628  0.1429   346
4fab96f_2     vanilla   L4    PASS    8/8     7    26   26     0  101135  0.7099    80
57c3486_1     codemode  L0    PASS    5/5     7     6  100     0    4604  0.1099   214
57c3486_1     vanilla   L4    PASS    5/5    13   104  104     0  101111  2.2959   200

codemode   TGC 5/5  turns 7.6  toolCalls  6.6  apiCalls 53.8  ctx0   4630  $0.1261
vanilla    TGC 5/5  turns 10.6  toolCalls 55.8  apiCalls 55.6  ctx0 101137  $1.6572
notools    TGC 0/5  turns 1.0  toolCalls  0.0  apiCalls  0.0  ctx0   1246  $0.0817
```

Then four `test_normal` tasks, drawn with a fixed seed
(`--sample 4 --split test_normal --seed 0`) rather than picked:

```
task          arm       res   pass  tests turns tools  api    ctx0    cost  secs
32616b5_3     codemode  L0    fail   5/10     8     7   37    4651  0.2504   351
32616b5_3     vanilla   L4    fail   5/10     9    38   38  101158  1.0743   136
425a494_2     codemode  L0    PASS    2/2     7     6   42    4605  0.1081   199
425a494_2     vanilla   L4    PASS    2/2     6    10   10  101112  0.4530    47
b6d1104_1     codemode  L0    PASS  10/10    11    10   16    4622  0.1785   205
b6d1104_1     vanilla   L4    PASS  10/10     9    13   13  101129  0.6229    75
c77c005_2     codemode  L0    PASS    5/5     9     8   25    4616  0.1339   115
c77c005_2     vanilla   L4    PASS    5/5     8    27   27  101123  0.6572    98

codemode   TGC 3/4  turns 8.8  toolCalls  7.8  apiCalls 30.0  ctx0   4624  $0.1677
vanilla    TGC 3/4  turns 8.0  toolCalls 22.0  apiCalls 22.0  ctx0 101131  $0.7019
```

`test_normal` does produce failures, and **both arms failed the same task**, which
is the reassuring shape: difficulty is task-level, not representation-level, at
this sample size.

### 9.1 Three conditions, nine tasks — and where the advantage actually comes from

All nine tasks, all three conditions:

```
task         split         codemode/L0      vanilla/L1       vanilla/L4
82e2fac_1    train         PASS   $0.093    PASS   $0.542    PASS   $1.389
6c2c621_1    train         PASS   $0.073    PASS   $1.270    PASS   $2.415
22cc237_2    train         PASS   $0.199    PASS   $0.334    PASS   $1.476
4fab96f_2    train         PASS   $0.143    PASS   $0.473    PASS   $0.710
57c3486_1    train         PASS   $0.110    PASS   $2.062    PASS   $2.296
32616b5_3    test_normal   fail   $0.250    fail   $0.697    fail   $1.074
425a494_2    test_normal   PASS   $0.108    PASS   $0.222    PASS   $0.453
b6d1104_1    test_normal   PASS   $0.179    PASS   $0.367    PASS   $0.623
c77c005_2    test_normal   PASS   $0.134    PASS   $0.427    PASS   $0.657

condition        TGC   turns  tools    api     ctx0     cost  secs
codemode/L0      8/9     8.1    7.1   43.3     4627   0.1431   204
vanilla/L1       8/9    11.7   44.1   42.4     8989   0.7103   118
vanilla/L4       8/9     9.4   40.8   40.7   101134   1.2326   121
```

**Every condition scores identically — 8/9, and the same task fails in all three.**
At n=9 there is no score signal at all, in either direction.

The cost gap decomposes, and this is the part worth acting on. Per-task cost ratios
against codemode, ordered by how many API calls the task needed:

```
task         cm_api    cm$     L1$     L4$   L1/cm   L4/cm
b6d1104_1        16  0.179   0.367   0.623     2.1     3.5
22cc237_2        18  0.199   0.334   1.476     1.7     7.4
c77c005_2        25  0.134   0.427   0.657     3.2     4.9
4fab96f_2        26  0.143   0.473   0.710     3.3     5.0
32616b5_3        37  0.250   0.697   1.074     2.8     4.3
425a494_2        42  0.108   0.222   0.453     2.1     4.2
82e2fac_1        62  0.093   0.542   1.389     5.9    15.0
6c2c621_1        64  0.073   1.270   2.415    17.4    33.1
57c3486_1       100  0.110   2.062   2.296    18.8    20.9

Pearson r(api_calls, L1/cm cost ratio) = +0.870   (n=9)
Pearson r(api_calls, L4/cm cost ratio) = +0.736   (n=9)
low-call  (<=20 calls, n=2):  L1/cm  1.9x   L4/cm  5.5x
high-call ( >20 calls, n=7):  L1/cm  7.6x   L4/cm 12.5x
```

Two separable effects:

- **Residency** — the L4→L1 step. Roughly a fixed per-turn tax: ctx0 falls 101,134
  → 8,989 and cost falls $1.23 → $0.71. It is present even on the low-call tasks
  (L4/cm 5.5x against L1/cm 1.9x there), i.e. it does not depend on how much work
  the task needs. **L1 closes about half the gap to codemode.**
- **Batching / looping** — the L1→codemode step. This one scales with call count:
  1.9x on ≤20-call tasks, 7.6x on >20-call tasks, r=+0.87. Codemode makes 43.3 API
  calls in 7.1 actions; L1 needs 44.1 actions for 42.4 calls.

**So a large part of codemode's cost advantage is the ability to loop, and part of
it is the ability to keep schemas off-context.** §10 separates the two properly with
a factorial and supersedes this section's framing: looping is *mechanism (2) of the
thesis*, not a confound, and calling it one was wrong. What §6's pagination caveat
bites is how large that term is on this particular benchmark — APIs that paginate at
20 reward a `while` loop, and a JSON-tool-calling arm cannot write one.

Caveats on the correlation, which is descriptive rather than inferential: n=9;
`cm_api` is endogenous (codemode chose how many calls to make); and cost ratios
are heavy-tailed, so the two low-call tasks carry a lot of weight in that split.
Treat it as a decomposition to test properly on ≥20 paired cells, not as a
coefficient.

**What this does and does not show.**

- **It does not rank the arms.** 8/9 for all three conditions, same task failing.
  A score comparison needs ≥20 paired cells with the paired t-test, per `CLAUDE.md`;
  nine tasks cannot rank anything. Do not quote these as parity either — the train
  tasks are a ceiling and the test sample is too small.
- **The context and cost gaps are real and large**, and §9.1 decomposes them:
  4,627 vs 101,134 first-turn prompt tokens against L4, for the *same* outcome on
  the *same* number of API calls (43.3 vs 40.7). Codemode is not cheaper because it
  did less. But most of the *cost* advantage over a properly deferred baseline is
  looping, not residency.
- **The action-count gap is the mechanism**: 6.6 tool calls versus 55.8 for ~55
  API calls. Codemode averages ~8 API calls per action; vanilla is 1:1. On
  `57c3486_1` it is 6 cells against 104 tool calls.
- **`notools` 0/5 confirms the tasks need tools**, and confirms §4.2's warning
  concretely: every do-nothing run scored exactly 1/N tests.

**Controls, all behaving:**

| control | expected | observed |
|---|---|---|
| ground truth, all train+dev | pass | 147/147 (`appworld verify tasks`) |
| do nothing | fail | 1/2, `success=False` |
| commit a wrong answer | fail | 1/2, `success=False` |
| commit no answer | fail | 1/2, `success=False` |
| `notools`, 5 tasks | fail | 0/5 TGC |
| known-correct answer committed by hand | pass | 2/2, `success=True` |

**Trajectories read end to end, not scores.** Both arms genuinely use the surface
they are supposed to. Codemode's `22cc237_2` run: `cat api/INDEX.md`, then
per-app `INDEX.md`, then `asyncio.gather` over three logins, then a cross-app join
(simple_note shares → phone contacts for emails → venmo received transactions to
exclude → `create_payment_request` for the remainder) in 9 cells / 18 API calls.
Vanilla's runs are all `<app>__<api>` tool calls, no `%%bash`, no `curl`, nothing
outside its tool list. Neither arm reached the network: `env-calls.jsonl` accounts
for every world interaction.

**The one failure is fully diagnosable from the artefacts, which is the point of
task 4.** On `32616b5_3` ("record the expenses from my Simple Note in the right
Splitwise groups") both arms scored 5/10. Reading `evaluation.json` alone gives the
cause: the grader prints its expected set beside the observed one, and both arms
recorded expenses for **seven** groups (274–280) where the ground truth has
**five** (274–278). `world-diff.json` corroborates it with the 22 expenses, 73
expense shares and 77 notifications actually created, field by field. No re-run,
no live services, no guessing — and the world that produced it stopped existing
when the process exited.

**One artefact to fix before reporting wall-clock.** Codemode's *first action*
takes a mean of **190s** (max 310s) — 87% of its mean agent time — because
prime-agent's IPython kernel boots a uv-managed environment on first use, and
running six workers concurrently makes the contention worse. Vanilla's first
action is instantaneous. So codemode's apparent slowness (223s vs 146s mean) is a
one-off cold start, not per-turn latency, and it must not be reported as a
property of the representation. Pre-warm the kernel the way TAC's
`provision-agent-volume.sh` did.

### How to run it

```bash
node bench/appworld/build-catalogue.mjs                    # once, after data download
node bench/appworld/sweep.mjs ~/src/goals/web/.env.local \
    --tasks 82e2fac_1,6c2c621_1 --arms codemode,vanilla
node bench/appworld/sweep.mjs ~/src/goals/web/.env.local \
    --sample 20 --split test_normal --seed 0 --repeat 2 --concurrency 6
node bench/appworld/sweep.mjs --report --tasks …            # re-print without re-running
```

`sweep.mjs` is the only entry point — same rule as `npm run iterate` for
MCP-Bench, for the same reason. `--sample` draws with a fixed seed and prints the
draw; it never selects by speed, because on AppWorld fast means few API calls,
which is the axis under study.

---

## 10. The 2×2: separating representation from residency

> **If you read one paragraph of this document, read this one.**
>
> **Composition scales with the work done: $0.067 on ~12-call tasks, $0.766 on
> ~100-call tasks — and this reproduces on MCP-Bench ($0.213 → $0.480 across tiers).
> Residency was a flat ~$0.51 tax *here*, but that is a property of this benchmark, not
> a law: AppWorld pins both the catalogue size and the turn count, and on MCP-Bench —
> where harder tasks attach more servers and take more turns — residency rises 1.8x
> (§10.4a). Residency cost is just `extra prompt tokens × price`, exactly.**
>
> Decision-useful, with the condition made explicit: *if your resident catalogue is
> fixed and your tasks are small, fix residency first; if your catalogue grows with task
> difficulty, both terms scale and you cannot separate them by task size; and for large
> workloads the REPL is the thing, since neither deferring schemas nor batching nor
> server-side projection substitutes for it.* Within composition, **emission outweighs reception
> about 7 to 1**, and emission is a property of the interface rather than of what the
> agent does with a result.
>
> An earlier version of this paragraph said "on small tasks you do not need a REPL".
> That was wrong: paired, the small-task representation saving is $0.067 ± 0.029,
> t=7.41, sign 10/10 — **small, not absent.** Code is always cheaper here; only the
> margin changes.
>
> Caveats that travel with that paragraph: it is a **cost** result on train+dev, on
> **Opus 5 only**, with score too noisy to read (§10.6); the magnitude of the
> composition term is amplified on this benchmark by APIs that paginate at 20 (§6);
> and it is now **partly reproduced on MCP-Bench, with the residency claim refined**
> rather than confirmed (§10.4a, limitation 1).

> **Provenance of the trees these numbers came from.** Every cost figure in §10
> was measured on `api/` trees generated at `725e693` or earlier — i.e. before the
> pythonic-argument adapters. `scott/bridge-adapters` (T1 `23db15a`, T2 `fcda594`)
> widens **23 of AppWorld's 1,544 parameter signatures**: each gains `| str` or
> `| float` on an array-of-scalars type, a one-line docstring note, and a coercion
> line in its module. Measured on the L4 docs-resident render: **1,453 added
> characters against 210,043, i.e. 0.69%** (~360 tokens of a ~52k-token cell) —
> about 40x smaller than the ~27% run-to-run noise floor (§10.7), not invisible.
> The schemas themselves are untouched, so vanilla's `toolDefs` are byte-identical,
> and no example literals reach any AppWorld container, since nothing in that
> catalogue is a nested shape.
>
> Consequence, stated so nobody has to rediscover it: a re-run on the current tree
> is **not byte-comparable** to these numbers, and should be compared as ratios
> rather than as absolute cents. For a byte-exact reproduction, generate from
> `725e693`. The adapted-parameter count is pinned as a literal in
> `bench/test/pythonic-args.test.mjs`, so a future rule change that widens 200
> parameters instead of 23 fails a test rather than quietly moving the baseline.

Every measurement this project has taken confounds two factors — and so does
upstream's. AppWorld's function-calling agent narrows 469 APIs to ≤20 with an LLM
pre-pass because the schemas do not fit (`function_calling_agent.py:117`), and
their **full-code** agent runs *the same pre-pass*, because it interpolates
`api_documentation_string` into the prompt (`full_code_agent.py:119-123`). So
"code beats tool-calling" and "non-resident docs beat resident docs" have never
been separated by anyone, including them.

|  | docs resident | docs non-resident |
|---|---|---|
| **code** | `codemode L4` — the whole `api/` tree's documentation inline | `codemode L0` — `api/` on disk, pointer only |
| **tools** | `vanilla L4` — 469 JSON schemas resident | `vanilla L1` — `search_tools`/`describe_tool`/`call_tool` |

plus **`vanilla predicted`**, upstream's own baseline: a third point on the tools
row where the docs *are* resident but only ≤20 of them, bought with an extra LLM
call.

`codemode L4` is rendered by `renderFullDocs` in `bench/generate.mjs` from the
same fields `renderToolModule` writes into each module docstring, so the resident
text and the on-disk text cannot drift. It is the same container relocated into the
prompt — 43,163 rendered tokens against vanilla-L4's 61,719 — which is the contrast
wanted. Run the analysis with `node bench/appworld/factorial.mjs`.

**`vanilla predicted` mirrors upstream rather than reimplementing it.**
`bench/appworld/predict-apis.py` imports their `APIPredictor` and calls
`build_messages` and `predicted_output_to_apis` directly: their prompt, their YAML
description block, their "prioritize high recall" instruction, their forced
`supervisor.complete_task`, their dedupe, their cap. Two recorded deviations — the
predictor model is Opus 5 rather than their gpt-4.1-mini (a weaker predictor would
handicap the arm it feeds), and `temperature` is rejected outright by Opus 5
("`temperature` is deprecated for this model"), so the prediction is **not**
reproducible run to run and the logged `rawOutput` is the only record of what the
arm was given.

One leakage trap, guarded in code: upstream's predictor few-shots on
`["82e2fac_1", "29caf6f_1", "d0b1f43_1"]` and puts their **ground-truth
`required_apis` in the prompt**. `82e2fac_1` is in our sample, so `predict-apis.py`
refuses to run on any of the three unless `--no-demos` is passed, and that task
drops out of every comparison involving the predictor arm.

### 10.1 Latency is now measurable, and it was an artefact

Codemode's first action was taking a mean of 190s and a max of 310s — 87% of its
agent time — while vanilla's was instant. Diagnosed by measuring one trivial
`print(6*7)` cell per configuration rather than by reasoning about it:

```
dead egress proxy, cold                     70.9s
no proxy                                     8.9s
PRIME_AGENT_KERNEL_PYTHON pinned              5.9s
dead egress proxy again, warm                 4.8s   <- same config as line 1
```

Lines 1 and 4 are the **same configuration** and differ by 15x, so the cost is
one-time and global, not per-run and not proxy-related: the kernel venv is 285 MB
and the first boot faults it in from disk. Pinning `PRIME_AGENT_KERNEL_PYTHON`
buys ~1s and is not the fix. Six workers all faulting cold pages is what turned
70s into 310s.

`bench/appworld/prewarm.mjs` boots one kernel and throws it away; `sweep.mjs` calls
it before the pool starts and warns if it failed. Effect on the codemode arm's mean
wall-clock: **204s → 32s.** Until a sweep has pre-warmed, do not report latency for
either arm — the number describes the machine, not the representation.

(Two ten-minute probes were lost to a self-inflicted version of the same mistake:
in print mode the CLI waits on an open stdin and emits *nothing*, so a probe that
looked like a kernel hang was a probe with stdin attached to the terminal. The
real runner passes `stdio: ["ignore", …]`.)

### 10.2 The 2×2, on a mixed sample

All five cells, on the eight tasks where every cell exists (`82e2fac_1` is excluded
throughout because the predictor cannot run on it without leakage). Opus 5, one run
per cell, post-pre-warm:

```
cell                   TGC   turns  actions    api     ctx0     cost   secs
code / docs out        6/8     9.9      8.9   43.0     4630   0.1562     41
code / docs in         7/8     7.0      6.0   37.1    68015   0.6816     33
tools / docs out       7/8    12.1     41.6   39.9     8992   0.7313    125
tools / docs in        7/8     9.6     38.1   38.0   101137   1.2131    128
tools / predicted      6/8     8.9     36.9   36.9     6490   0.6435    118
```

**TGC is 6–7 of 8 in every cell.** No score signal in any direction, and §10.3's
variance means the 6 vs 7 is noise.

In *ratios* the factors look multiplicative with a large interaction (representation
is worth 1.8x with docs resident, 4.7x without). On this mixed sample they also look
**roughly additive in absolute cost** — four differences in a $0.48–$0.58 band, which
an earlier draft of this section reported as "two roughly equal, roughly independent
savings".

> **That framing was wrong, and §10.5 supersedes it.** Stratifying by task size shows
> the two terms are not the same kind of quantity at all: residency is a **fixed**
> ~$0.51 tax independent of how much work a task needs, while representation is
> **proportional to work**, ranging $0.07 to $0.76. They only look equal when averaged
> over a sample whose median task happens to sit where the two curves cross. Read
> §10.5 before quoting any single-number decomposition.

(An earlier nine-task cut of the same four cells had all four differences agreeing
to within $0.0001. That was luck, not precision, and is recorded as a warning: at one
run per cell, four-decimal agreement means nothing — and as it turned out, the
quantity it was agreeing about was itself an artefact of the sample.)

### What this does to the thesis

It refutes the two *simplified* stories, and it maps almost exactly onto the
original claim, which had **two** mechanisms:

1. *Schemas need not be resident.* → the residency term, ~$0.48–$0.53, a fixed
   per-turn tax present even on low-call tasks. **Confirmed.**
2. *Code is better represented in post-training than tool-call syntax.* → the
   representation term, ~$0.53–$0.58, which shows up as actions: one cell issuing 40
   calls versus 40 tool calls issuing 40.

The second is worth being careful about, because an earlier draft of this document
called it a confound. **It is not.** Writing a loop is a genuine capability of code
execution that tool-calling structurally lacks; a cell that paginates a collection
in four lines is mechanism (2) doing exactly what mechanism (2) claims. It is not
unfair to vanilla that it cannot write a `while`.

So the honest headline is neither "the thesis is wrong" nor "code wins":

> **The context-bloat mechanism explains about half the advantage and composition
> explains the rest — and on this benchmark the composition half is amplified by
> APIs that paginate at 20.**

What the pagination caveat (§6) bites is the **magnitude of the second term, not the
direction of either.** A benchmark with unpaginated APIs should show a smaller
representation term and a residency term of roughly the same size; that is a
prediction, and it is why MCP-Bench stays alive as the mirror-image control.

Two claims that are now dead, and should not be repeated:

- "Code beats tool-calling." Code with its docs resident ($0.682) costs about what
  tools with docs deferred cost ($0.731). One mechanism is not enough.
- "It is really just residency." That was my own reframing after seeing the
  call-count correlation, and it predicted codemode-L4 would lose *most* of its
  advantage. It loses about half.

**Upstream's predictor is the strongest tool-calling condition, and it makes the
mechanism unmistakable.** It has the *lowest* first-turn context of any tools cell —
6,490 tokens, below even our L1's 8,992, because ≤20 schemas is a very small
catalogue — and it still costs $0.6435, essentially L1's $0.7313. Residency is fully
solved in that cell and most of the cost remains. What remains is **36.9 sequential
tool calls**. Codemode L0 does 43.0 API calls in 8.9 actions for $0.1562.

So the two factors act on visibly different quantities, which is why they compose:

- **Representation moves actions.** 6.0–8.9 tool calls for code against 36.9–41.6
  for tools, at a matched 37–43 API calls — a ~5x difference across every tools
  cell, essentially unaffected by residency.
- **Residency moves tokens per action.** ctx0 101,137 → 8,992 → 6,490 along the
  tools row, and 68,015 → 4,630 on the code row, with actions barely changing.

Cost is roughly actions × context, so the win needs both. That is more defensible
than either headline, and it is falsifiable: it predicts the gap widens with task
length (more actions) and with catalogue size (more resident tokens), and that a
tool-calling arm with *parallel* tool calls should close part of the action gap.

**Latency, now that it means something.** Post-pre-warm the code cells run 33–41s
against 118–128s for every tools cell. Vanilla never boots a kernel, so its number
was never inflated — the earlier "codemode is slower" was entirely the cold start,
and the direction is in fact **reversed**. One run per cell on one machine, so read
it as a direction rather than a measurement.

> **Footnote, required with any latency number from this project.** These figures
> hold only for a sweep that has pre-warmed the IPython kernel. Without
> `bench/appworld/prewarm.mjs` (which `sweep.mjs` runs automatically unless
> `--no-prewarm`), the code arms pay a one-time 285 MB page-fault on first boot —
> mean 190s, max 310s on the first action, 87% of agent time, and worse under
> concurrency. A run made without it will reproduce the old, wrong conclusion that
> codemode is slower. `sweep.mjs` prints a warning if the pre-warm failed and
> `result.json` carries the phase boundaries to check against.

### 10.3 What the representation term actually is: code can discard

The obvious reading of "representation moves actions" is round trips — a code arm
batches, a tool arm does not. **That reading is wrong, and the data already
contained the refutation.** Tool calls per turn, measured across every run:

```
cell                  n  turns  tools    api  tools/turn  meanBatch  maxBatch
codemode/L0          28    8.7    7.7   38.6        0.89       1.00        1
codemode/L4          28    6.4    5.4   36.9        0.84       1.00        1
vanilla/L1           19    9.9   26.6   25.3        2.68       2.69      6.4
vanilla/L4            9    9.4   40.8   40.7        4.32       4.61     11.0
vanilla/predicted     8    8.9   36.9   36.9        4.15       4.38     12.1
```

**The tools arms are already issuing parallel tool calls** — vanilla L4 averages 4.6
per turn and peaks at 11, the predictor 4.4 and 12 — because `b1`/`b2`/`b3` tell them
to batch page fetches and they do. Codemode is strictly **1.00** actions per turn and
*still* takes fewer turns (8.7 against 9.4). So a "parallel tool calls" condition
would test something already present in three cells, and parallelism does not close
the gap.

What differs is what enters the context per unit of work:

```
cell                  out_tokens   ctx accumulated beyond catalogue   per api call
codemode/L0                1,265                             39,407         1,865
codemode/L4                  954                             10,239           549
vanilla/L1                 6,174                             91,822         3,395
vanilla/L4                 9,627                            117,121         2,885
vanilla/predicted         10,072                            107,774         2,643
```

1. **Output tokens: the tools arms emit 5–8x more.** 954–1,265 against
   6,174–10,072 — one code block per turn versus 37–41 JSON tool-call blocks. Output
   is the expensive direction and this has nothing to do with residency.
2. **Accumulated context: ~2.7x more for the same work.** Every tool result lands in
   context verbatim; a cell prints what the code chose to print. 39k against 108k at
   matched API calls (38.6 vs 36.9).

**Output tokens are the primary endpoint; accumulated context is secondary.** The
output column is exact. The accumulation column models the fixed catalogue cost as
`ctx0 × turns`, which is rough once prompt caching is involved. If the two ever
disagree, believe the output tokens and say so — the finding must not rest on the
approximate column when the direct one carries it.

**So the mechanism is not batching. It is that code can discard.** Stated precisely,
the difference is *who decides what survives*:

- With code, the **caller** decides, per call, at call time. The response exists in a
  variable and only what the agent chooses to print enters the context.
- With tool-calling, the **tool author** decided — at schema-design time, for every
  future call. The agent cannot project, filter or aggregate before the result lands.

That is why batching cannot help: eleven parallel calls still return eleven full
payloads. And it is why the two sub-mechanisms above are two faces of one thing —
5–8x the output tokens because the arm must *emit* a block per call, and 2.7x the
accumulated context because it must *receive* every payload whole.

The actionable sentence for a harness author is therefore not "add parallel tool
calls" — they have those — but "let the model post-process a tool result before it
enters the context."

**The design implication this predicts, recorded before it was tested.** If reception
is the recoverable half, then giving tools a *response-projection* argument — a field
selection or jq-style expression evaluated server-side, before the payload is
serialised into the transcript — should recover a large share of the gap **without a
REPL**. That is a concrete recommendation for MCP tool design and it follows from the
mechanism rather than from taste.

> **Measured afterwards, in §10.5: the share is ~13%, not "large".** The prediction
> was directionally right and quantitatively over-optimistic. Even forbidden to
> discard anything, the code arm stays 3.8x cheaper than the tools arm, because
> emission — one code block per turn against one tool-call block per call — dominates
> and projection cannot touch it. The recommendation survives as a worthwhile
> optimisation with a now-known ceiling, not as the headline. Left in place with the
> correction attached, rather than quietly revised, because the gap between the
> predicted and measured share is the informative part.

**Emission versus reception.** The mirror test below separates them. If codemode's
output tokens rise under `a2` but stay well below the tools arms' — because even
printing everything it emits one code block per turn rather than 37 tool-call blocks
— then the representation term splits into:

- **emission**, one block versus N blocks, which is *irreducible* for tool-calling
  and inherent to the protocol, and
- **reception**, filterable versus not, which is *recoverable* by better tool design.

Only the second is addressable without a REPL. That prediction was stated before the
cell finished running, and §10.5 confirms it — with emission out-weighing reception
about 7 to 1, which neither of us expected.

**The mirror test.** `a2` in `bench/appworld/prompts.mjs` is `a1` with one clause
added: every API response must be printed in full, no summarising, slicing or field
selection. Same tree, same discovery, same kernel, same `gather` — loops are *not*
forbidden, so pagination still costs one cell. Filtering is the only factor removed,
which is what makes it a clean contrast rather than a second confound. If codemode's
accumulated context and cost move toward the tools arms', "code can discard" is
confirmed; if they do not, this explanation is wrong and needs replacing before
anyone writes it up.

Preliminary, on the cheapest task in the pinned sample (`396c5a2_1`, 7 ground-truth
calls) — and it is one task, so it is a smoke test rather than a result:

```
                   api  turns   out   ctxAccum     cost
a1 (can filter)      7      7   837     32,275   0.1144
a2 (cannot)          8      8   989     50,229   0.1553
```

Accumulated context +56% and cost +36% from removing filtering alone, on a task with
seven API calls. The trajectory confirms the manipulation took: `a2` writes
`print(json.dumps(p, indent=1))` inside its pagination loop where `a1` wrote
`print(len(p))`. The full 20-task cell is running.

### 10.4 Stratified: residency flat *here*, representation proportional to work

10 tasks per stratum, one variant per generator, **3 replicates per (task, cell)**
averaged before pairing, drawn from the pinned list in
`.run/appworld/stratified-tasks.json`.

```
low stratum (mean 11.5 gt calls)      n   TGC   turns  actions   api    ctx0     out  ctxAccum     cost
code / docs out                      20 20/20     8.2      7.2  36.4    4637    1132     35395   0.1263
code / docs in                       20 20/20     6.3      5.3  36.6   68022     922      9164   0.6479
tools / docs out                     20 19/20     9.9     38.0  36.7    8999    7574     94834   0.5442
tools / docs in                      20 19/20    10.3     25.3  25.3  101144    5539     82814   0.9471
```

(cell means above are over all 20 tasks; the per-stratum split is in the paired
statistics below, which is where the claims live)

**Paired per-task cost differences, with the measured noise floor beside each:**

```
                                  mean ± sd        t (df=9)      sign      noise floor
low stratum
  residency, code row          $0.525 ± 0.058   28.72 ***      10/10 **    $0.044
  representation, docs-out     $0.068 ± 0.027    7.87 ***      10/10 **    $0.027
high stratum
  residency, code row          $0.518 ± 0.025   64.84 ***      10/10 **    $0.040
  representation, docs-out     $0.768 ± 0.338    7.19 ***      10/10 **    $0.145
```

**Residency is flat across these strata.** $0.525 and $0.518 across a 9x difference in
task size — agreeing to within **$0.007**, an order of magnitude inside either SD, and
22–33x the run-to-run noise. It is the tightest number in the document, and §10.4a
explains *why* it is flat: AppWorld holds both inputs to residency cost constant, so
this is a correct measurement of a special case rather than a general law. On MCP-Bench,
where the catalogue grows with task difficulty, residency rises 1.8x.

**Representation is proportional to the work done.** $0.068 → $0.768, an eleven-fold
increase, both significant on both tests.

**The small effect is small in magnitude, not marginal in evidence.**

An earlier version of this paragraph said $0.068 was "only about twice the noise". That
compared the effect against the spread of `r2 − r1`, which is the wrong quantity and
double-counts twice over:

- `Var(r2 − r1) = 2σ²`, so that spread is **√2** larger than single-run noise; and
- replicates are **averaged before pairing**, so the noise on a cell mean is `σ/√k`,
  not `σ`.

Together that overstates the relevant noise by `√(2k)` = **√6 ≈ 2.45** at k=3. Computing
σ directly from all three replicates instead (pooled within-task, df=20 per cell, no
correction factor to get wrong):

```
low stratum          pooled within-task σ
  code / docs out    $0.0229
  tools / docs out   $0.0127
noise on one paired difference of 3-replicate means:  $0.0151
effect $0.0680 / that noise:                            4.5x
residual task-to-task heterogeneity:                  $0.0227
```

So the honest form is:

> The low-stratum representation saving is small — $0.068 — but well determined: **4.5x
> the measured run-to-run noise** on a single paired difference, and 10/10 in the same
> direction while the replicate control splits 3/10 to 6/10. Small in magnitude, not
> marginal in evidence.

Two notes on what not to add to that. **"7.9x its own standard error" is the
t-statistic restated**, so quoting it beside the 4.5x as separate evidence would be
double-counting in the other direction; the effect-against-measured-noise ratio is the
independent figure. And the pooled σ **overstates** noise for small tasks (a 191-call
task has more absolute spread than a 7-call one), so 4.5x is conservative.

**Residual heterogeneity says the effect is present in nearly every task.** Observed
paired SD is $0.0273 and predicted noise $0.0151, leaving √(0.0273² − 0.0151²) =
**$0.0227** of real task-to-task variation. So the $0.068 is not an average carried by
a few tasks — most small tasks show a saving of roughly this size, which is a better
reason to believe it than the p-value and is exactly what 10/10 on the sign test
implies.

The high stratum has the opposite structure: effect $0.7679 ± 0.3375 against noise of
only $0.0497, so **almost all** of that spread ($0.3338) is real variation. The
large-task effect is consistently signed but varies widely in size.

Sensitivity: dropping the single largest-contributing task (`34d9492_2`) takes the
high-stratum representation effect from $0.7679 ± 0.3375 to $0.6949 ± 0.2610 over n=9 —
about 10%. So the effect is not carried by one task, and that task is *not* censored in
either cell of this contrast (limitation 7 concerns a different cell).

> **Provenance, which travels with these numbers.** Ground-truth call counts — the
> stratification variable — exist only for `train`/`dev`, because AppWorld's licence
> withholds test-set solutions. These are a **cost** result on train+dev, Opus 5 only.
> They say nothing about score: TGC is 19–20/20 in every cell and §10.7 shows an
> identical configuration flipping 8/8 → 3/8.

**Two controls run on every report.** A degenerate one — a cell compared with itself,
which must give $0.000 ± 0.000 and does, catching any pairing that crosses tasks rather
than staying within them. And a non-degenerate one — replicate r2 against r1 of the
same cell, whose mean should be ~0 (it is: −$0.004 to $0.025 on the clean cells, sign
tests 3/10 to 6/10) and whose SD *is* the noise floor quoted above, measured rather
than assumed.

**The replicate control indicts the excluded cell twice more.** `tools/docs-in` has a
pooled within-task σ of **$0.18–$0.19** against $0.009–$0.033 for every other cell — an
order of magnitude less stable. And the contrast that uses it, `representation,
docs-in`, has an **effect/noise ratio of 0.6x** in the low stratum: the difference is
*smaller than the measurement noise*. That cell was already excluded for doing less
work (37.6 vs 63.0 API calls) and for failing the sign test; instability and a
sub-unity signal-to-noise ratio are the third and fourth independent reasons.

### 10.4a Reproduced on MCP-Bench — and "fixed tax" was a special case

`docs/MCPBENCH-2X2.md` runs the same four cells on MCP-Bench, n=20 tasks, live
servers, per-task catalogues, opposite pagination bias. **The representation finding
reproduces cleanly** — monotonic with work, $0.213 → $0.426 → $0.480 across tiers of
8.7 → 12.5 → 18.9 tool calls, all four contrasts positive and significant on both
tests.

**The residency finding does not reproduce as flat, and the reason falsifies the way
this document originally stated it.** There residency rises $0.198 → $0.203 → $0.355,
a 1.8x increase, because MCP-Bench exposes the task's own servers plus distractors, so
a harder task carries a bigger catalogue (29.7k vs 23.5k tokens) *and* takes more turns
(8.8 → 16.0) that re-bill it. AppWorld pins both: a fixed 469 APIs regardless of task,
and 6.3 vs 6.4 turns across the two strata.

Tested on AppWorld's own data, the relationship holds and explains the flatness:

```
stratum  row   extra resident ctx  turns  token-turns  residency $
low      code             63,385    6.3        399k        0.525
high     code             63,385    6.4        404k        0.518
```

**Token-turns moved 1.01x; residency moved 0.99x.** So "flat in task size" was a
consequence of neither input moving — not a property of residency. **The AppWorld
measurement is a correct measurement of a special case.**

And the relationship is tighter than token-turns, because it is not empirical at all.
Weighting billed tokens by what they actually cost (cache read 0.1x, cache write 1.25x)
gives $0.495 / $0.491 / $0.495 per 100k across the three clean cells — 1% spread,
against a 6x spread for raw token-turns. Fitting all 297 completed runs:

```
cost = $5.00/M weighted-prompt-tokens + $25.00/M output-tokens
median relative residual 0.00%, max 0.00%
```

So **residency cost is arithmetic**: the extra prompt tokens the catalogue causes,
priced. Raw token-turns varies only because it cannot distinguish a cache read from a
cache write, and the arms have different cache mixes. What is worth measuring is
therefore not the price but **how large the resident catalogue is and how many turns
re-bill it** — and those are properties of the harness, not of the benchmark.

The one cell that misses the identity ($0.376) is the censored and confounded
`tools/docs-in` (limitation 7, §10.6). The identity holding wherever the data is clean
and failing exactly where it is known-bad is a **sixth** independent reason that
exclusion was right.

**Residency partly refunds itself.** The identity has two terms, and for a *difference* between cells the
output term is not negligible:

```
residency = $5/M x Δweighted_prompt  +  $25/M x Δoutput
```

Decomposed on AppWorld (the assertion that these reconstruct the measured residency
cost to within $0.002 runs in the analysis):

```
stratum row     turns out→in   output out→in   prompt term  output term   total  refund
low     code      8.1 → 6.3     973 →   768        0.5301      -0.0051   0.5250    1.0%
high    code      8.3 → 6.4    1292 →  1076        0.5238      -0.0054   0.5184    1.0%
low     tools     8.6 → 7.7    2080 →  1701        0.5343      -0.0095   0.5248    1.8%
high    tools    11.3 → 12.8  13067 →  9376        0.3732      -0.0923   0.2809   24.7%
```

Making the catalogue resident **cuts turns by ~22%** on the code row (8.1 → 6.3 and
8.3 → 6.4) because the agent stops reading `api/` to find things, and output bills at
5x cached prompt tokens — so some of the tax is refunded. But the refund is **1% on
the code row and 24.7% on the tools row**, and the reason is not that turns move
differently: they move by about the same fraction everywhere. It is that **codemode's
absolute output is tiny** (768–1,292 tokens) while the tools arm's is an order of
magnitude larger (9,376–13,067). The same proportional turn saving is worth ten times
more dollars where the arm is output-heavy.

**Emission volume is the driver across arms; consolidation modulates it within one.**

This paragraph has been wrong twice and the sequence is worth keeping. It first said
the driver was output volume. It was then rewritten to say consolidation — resident
docs producing fewer, longer cells — because MCP-Bench appeared to show refunds
$0.00 → $0.044 → $0.007 against monotonically rising output volume. **Those MCP-Bench
figures were withdrawn**: they had been averaged over all completed runs per tier
rather than over the paired tasks, and did not reconcile with the contrasts they were
meant to explain. On the corrected figures volume is the driver, as originally stated.

What both benchmarks now agree on, on the surviving numbers:

```
                     turns   output   out/turn   refund   emission scale
AppWorld  code       -23%     -21%       +2%      1.0%    ~1.0k tok/task
AppWorld  code       -23%     -17%       +8%      1.0%    ~1.3k
AppWorld  tools      -10%     -18%       -9%      1.8%    ~2.1k
MCP-Bench code       -18%      -3%      +18%      2.0%    ~4.5-10.9k
MCP-Bench tools      -22%     -19%       +4%     21.0%    high
```

**Turns fall by a similar fraction in every row — and the refund still differs
tenfold.** 1–2% on both code arms, 21% on the tools arm. That is not explained by how
much the turn saving survives; it is explained by how much the arm emits per turn at
all. A tool-calling arm frames every result into context, so the same proportional turn
saving converts to roughly ten times the dollars.

Consolidation is real and is *secondary*: out/turn rises in three of the five rows
(+2%, +8%, +18%), most strongly on MCP-Bench's code arm, where turns fall 18% and
output only 3%. So it modulates how much of a turn saving becomes an output saving. It
does not explain the cross-arm gap.

> **Net residency tax = the catalogue's billed tokens − $25/M × Δoutput.** Resident docs
> remove search turns; only part of that becomes an output saving, because the surviving
> turns partly absorb the work; and the dollar value of what survives scales with how
> much the arm emits at all — which is why the refund is ~1–2% for a code arm and
> ~21–25% for a tool-calling one.

(The AppWorld `tools/high` row is excluded: its turns *rose* 14% and it made 37.6 API
calls against 63.0, so its 24.7% was never a turn-saving story. MCP-Bench's tools row
is the measured instance of the large refund.)

**Consequence for the actionable sentence.** "On small tasks, fix residency first"
assumed a fixed tax. If the catalogue grows as tasks get harder — the normal MCP
pattern, since you attach more servers for harder work — residency scales too and the
two terms no longer separate by task size. The abstract now says so.

**One thing MCP-Bench establishes that AppWorld could not.** There codemode **loses on
turns and still wins on cost**: 14.4 turns / 13.4 calls / $0.368 against 10.0 turns /
26.4 calls / $0.738. On AppWorld codemode won both, leaving round trips alive as a
rival explanation. It is now eliminated — per-action context is the mechanism, as
§10.3 argued.

### 10.5 The mirror test: emission dominates reception, ~7 to 1

`a2` is `a1` with one clause added — every API response must be printed in full, no
summarising, slicing or field selection. Same tree, same tools, same tasks, loops not
forbidden. Filtering is the only factor removed.

```
high stratum         out    ctxAccum      cost    TGC
a1 (can filter)    1,317      37,880    0.1356  10/10
a2 (cannot)        1,251      81,387    0.2355  10/10     +115% ctx, +74% cost
tools / docs-out  13,056     163,053    0.8998  10/10
```

**Output tokens moved −5%. Accumulated context more than doubled.** That is the
predicted separation, cleanly:

- **Emission** — one code block per turn versus one tool-call block per call — is
  *unaffected* by filtering. 1,251 against 13,056 is a **10.4x** gap that discarding
  has nothing to do with.
- **Reception** — what lands in context — is exactly what filtering controls.

Decomposing the high-stratum representation term of $0.764:

```
reception / filtering        a2 - a1     = $0.100   ~13%
emission + per-result framing tools - a2 = $0.664   ~87%
```

**Even forbidden to discard anything, the code arm is still 3.8x cheaper than the
tools arm.** Emission dominates, and it is a property of the interface rather than of
what the agent does with a result.

This **downgrades the response-projection recommendation** made in §10.3. A
server-side projection argument addresses reception, which is ~13% of the
representation term here — real and worth having, but not the large share we assumed
before measuring. The honest bracket: projection recovers **at least $0.100 and less
than $0.664**, because `a2` is a lower bound on reception cost — it still returns one
cell result per turn rather than 63 separate tool results, so some of the $0.664 is
per-result framing that projection would also touch.

Verification that the manipulation took, on the heaviest task (`6104387_3`, 191
ground-truth calls): a1 ctxAccum 50,396 → a2 125,516, output 1,622 → 1,476, both PASS,
62 vs 61 API calls. The a2 trajectories print `json.dumps(p, indent=1)` inside their
pagination loops where a1 printed `len(p)`.

### 10.6 A worked example of a result we do not believe

The most instructive contrast in this document is one that is **not** quoted in any
conclusion. Paired, per task, on cost:

```
                                          mean ± sd      t-test        sign test
representation, docs-out (tools - code)  $0.766 ± 0.352  p=7.2e-5***   10/10  p=0.002
representation, docs-in  (tools - code)  $0.524 ± 0.762  p=5.8e-2      7/10   p=0.344
residency, tools row     (in - out)      $0.263 ± 0.543  p=1.6e-1      8/10   p=0.109
```

The second line has a t-test p of 0.058. Round it, squint at a mean of $0.524, and it
reads as "a large effect, marginally short of significance" — the kind of number that
gets quoted with a "trending" next to it. **The sign test says 7 of 10, p=0.34: the
tasks do not agree on the direction.** The mean is being carried by a minority of
tasks with large differences, which is exactly what a heavy-tailed cost distribution
does to a t-test at n=10.

And there is a mechanical reason to distrust it, visible in the cell table: in the
high stratum `tools/docs-in` made **37.6 API calls against `tools/docs-out`'s 63.0**
and scored 9/10. It did *less work*. A cost comparison against a cell that solved less
of the task is not a comparison of representations, so both contrasts that involve it
are excluded — not caveated, excluded.

Two things worth taking from this:

- **Report both tests and believe the sign test when they disagree.** Here the
  near-assumption-free test caught a confound the parametric one nearly waved through.
  That rule is written into `bench/stats.mjs` itself rather than into a convention
  someone has to remember.
- **A surviving-contrasts-only writeup teaches nothing.** A reader who sees only the
  clean numbers cannot tell whether anything was discarded, or on what basis. "Here is
  a p=0.06 we do not believe, and here is how we knew" is more useful than the four
  results that passed.

The defensible claim, after this narrowing, is: **residency measured on the code row,
representation measured with documentation non-resident.** Both are clean, paired,
and significant on both tests in both strata.

### 10.7 Run-to-run variance is large enough to flip TGC

`4fab96f_2` under `codemode L0` scored **8/8 (PASS)** on one run and **3/8 (fail)**
on a re-run of the identical configuration. That is the ~27% noise `CLAUDE.md`
already warns about, now visible on the score itself rather than on turns or cost.

It is the reason the 2×2 below is reported as cost and context and not as a
ranking, and the reason the next step is `--repeat 2+` on ≥20 paired cells.

---

## 11. Status and next steps

- [x] **Task 3** — evaluated, picked, cloned, pinned, installed. Upstream test
      suite green (110 passed / 2 skipped); upstream task verification green
      (147/147 in 26s). Two arm-biasing traps documented before any run.
- [x] **Task 4** — logging built and verified against real runs. Six bugs found and
      fixed, four of which silently corrupted the evidence while producing
      plausible artefacts (§8).
- [x] **Task 5** — 5 stratified train tasks × 2 arms + `notools`, then 4 seeded
      `test_normal` tasks × 2 arms. Every trajectory read end to end; all six
      controls behave; the one failure diagnosed from artefacts alone. No
      multi-hour run launched.
- [x] **The 2×2** — `codemode L0/L4`, `vanilla L1/L4`, plus upstream's own
      APIPredictor baseline and a no-filtering mirror cell (§10). Separates
      representation from residency for the first time in this project. Latency made
      reportable by `prewarm.mjs` (204s → 39s mean).
- [x] **Stratified replication** — 20 tasks × 4 cells × **3 replicates**, stratified by
      executed ground-truth call count, paired within task, with two null controls and
      a measured noise floor (§10.4). Both surviving claims hold; the small one is
      correctly described as small.
- [x] **`bench/stats.mjs`** — the paired t-test and sign test CLAUDE.md has mandated
      since the v3 episode and which no code implemented (§4.4).
- [x] **Regression tests** — `bench/test/appworld-fairness.test.mjs` (28 cases,
      source-level) plus AppWorld confounds in `bench/test/fairness.test.mjs`
      (`raise_on_failure`, the SafetyGuard log-loss, error-content symmetry, and a
      **run-level** guard that no arm may make tool calls without any reaching the
      transport — the invariant that was missing when vanilla L1 silently never
      worked). `npm test` is **177 passing** (was 141). The transport guard was
      verified by planting a synthetic `result.json` with the measured failure
      signature and confirming it fires.

### 11.1 The stratified sweep (in flight)

The next run does **not** just add n. All conditions score 6–8 of 9 and fail the
same tasks, so more paired cells only tightens a confidence interval around zero.
The live variable is §10's cost decomposition, and the thing that drives it is how
many API calls a task needs — so the sample varies *that*, on purpose:

```bash
node bench/appworld/stratify.mjs --per-stratum 10 --seed 0    # prints the draw
node bench/appworld/sweep.mjs <env> --tasks "$(node bench/appworld/stratify.mjs)" \
    --arms codemode,vanilla --concurrency 6
```

`stratify.mjs` splits train+dev by **executed** ground-truth call count (≤20 vs ≥60;
the distribution is p25=18, p50=36, p75=71, max=244) and draws a seeded sample from
each stratum. It measures call counts by running each ground-truth solution rather
than counting `required_apis`, which is *distinct* APIs (mean 26) and not the
quantity that drives cost (mean 53 calls).

This is `CLAUDE.md`'s "do not hillclimb efficiency on the fast subset" turned the
right way round. A convenient sample silently selects on the axis being measured —
`quick.mjs` picks fast tasks, and tasks are fast because they need fewer calls.
Choosing on the axis deliberately makes it a test rather than a bias.

**The prediction.** If the representation term is composition, the tools/code cost
ratio stays small in the low stratum and grows in the high one. If residency is
doing more work than §10 suggests, the ratio persists in the low stratum too — and
that would mean the decomposition understates residency, which is the result worth
escalating fastest.

Two things it controls for, both of which would otherwise inflate the effective n:

- **Family pseudo-replication.** Ids are `<generator>_<variant>` and the three
  variants of a generator are one scenario with different data, so ten blind draws
  can be three scenarios. At most one variant per generator.
- **Predictor leakage.** Generators `82e2fac / 29caf6f / d0b1f43` are upstream's
  predictor few-shots, with their ground-truth `required_apis` in the prompt, so they
  are excluded outright rather than just from the predictor arm.

Strata are matched on grader tests per task (~5.8 vs ~5.9) and apps per task (2.26
vs 2.30), so they differ on call volume and writes, not on structural complexity.
Ground-truth call counts exist only for train+dev — the licence withholds test
solutions — which is why the draw comes from there. That is sound for a *cost*
question and irrelevant to train's score ceiling; any **score** claim still needs
`test_normal`.

---

**Next, in order:**

1. **`--repeat 2` on the existing cells**, then `bench/compare.mjs` for the paired
   t-test. Everything in §10 rests on one run per cell, and §10.6 shows an identical
   configuration on an identical task flipping TGC 8/8 → 3/8. Reducing the noise on
   what already exists is now worth more than any new condition — including the
   projection cell, whose ceiling §10.5 has already measured at ~13%.
2. **The response-projection cell**, with expectations set by §10.5: add a `select`
   parameter to `call_tool` taking a jq-style expression applied server-side before
   the payload is serialised, and see where in the $0.100–$0.664 bracket it lands. It
   is the only recommendation here actionable by an **MCP tool author** rather than an
   agent author, which is why it stays on the list — but it is an optimisation with a
   measured ceiling, not the headline it looked like before the mirror test ran.
3. **Vary catalogue size.** §10.4 shows residency is a fixed tax; the mechanism says
   its size should scale with resident tokens. AppWorld's per-app catalogues (6 to 92
   APIs) are a free dial, and it is the cheapest remaining test of the residency half.
4. **Move to `test_normal`/`test_challenge` for any score claim.** Everything in §10.4
   and §10.5 is a cost result on train+dev, because ground-truth call counts — the
   stratification variable — exist only there.
5. **Report the 2×2 as the primary result** everywhere, with three caveats attached:
   pagination (§6), residency-vs-representation (§10), and task-size dependence
   (§10.4). The three most likely ways to overclaim are quoting the code/docs-in →
   tools/docs-in gap as if it were all representation, quoting the tools row as if it
   were all residency, and quoting any single-number decomposition without saying what
   task size it describes.
6. **Keep MCP-Bench alive** as the mirror-image control, and re-run its vanilla L1
   arm: it was broken in exactly the way described in §8, so any earlier L1 number
   from that benchmark is not an L1 number. MCP-Bench's +0.050 is also a
   representation-and-residency measurement, not a representation one.

**Done since this list was written:** the mirror cell (§10.5) and the stratified
sweep (§10.4).

**Dropped from this list:** *add a parallel-tool-call tools cell.* It was the obvious
next experiment and the data already refutes its premise — the tools arms issue 4.4–4.6
tool calls per turn (max 11–12) while codemode is strictly 1.00 and still takes fewer
turns, so parallel dispatch is a condition already present in three cells and it does
not close the gap (§10.3). Recorded rather than deleted, per the negative-results
convention in `CLAUDE.md`.

**Sources consulted:** [AppWorld repo](https://github.com/StonyBrookNLP/appworld) ·
[AppWorld paper](https://arxiv.org/abs/2407.18901) ·
[τ²-bench](https://github.com/sierra-research/tau2-bench) ·
[BFCL leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html) ·
[StableToolBench](https://arxiv.org/abs/2403.07714) ·
[MCP-Universe](https://github.com/SalesforceAIResearch/MCP-Universe)
