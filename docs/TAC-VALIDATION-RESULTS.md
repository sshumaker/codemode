# Jobs runtime on TheAgentCompany — what TAC can and cannot say about it

**Verdict: TheAgentCompany is the wrong instrument for validating the jobs runtime,
and that is the finding.** A healthy TAC contains no genuine elapsed-time waiting, so
the axis the runtime targets does not exist here. What TAC *can* answer, and does
answer cleanly, is the safety question: on realistic office tasks that need no
waiting, does having the runtime on do any harm?

**It does not.** Across 13 runs on 7 tasks: **zero `jobs` calls, zero guard fires,
zero false refusals, and an exact tie on rule-based score in every pair.** Safe to
leave on; nothing to show for it here.

The affirmative case for the runtime belongs to the durability harness (A5) and to a
benchmark with real elapsed-time waiting. Not to TAC.

---

## 0. Why the "wait-heavy" task set was not wait-heavy

The task set was chosen from recorded sleep and thread counts:
`pm-schedule-meeting-2` (302 sleep mentions, 48 thread mentions),
`admin-ask-for-meeting-feedback` (335/5), `hr-collect-feedbacks` (215/5),
`pm-ask-for-issue-and-create-in-gitlab` (94/43).

**Those counts are an artefact of a broken harness.** `bench/tac/run-task.mjs`
configured the environment LLM — the model behind the NPC colleagues *and* the
grader's `evaluate_with_llm` — as `openai/claude-sonnet-5`. sotopia, which drives
every NPC, hard-codes `temperature: float = 0.7` on all generation paths
(`sotopia/generation_utils/generate.py`). That model rejects the parameter:

```
POST https://api.anthropic.com/v1/chat/completions → 400
{"code":"invalid_request_error","message":"`temperature` is deprecated for this model."}
```

Every colleague's every reply failed. The bot looped printing `"No message received,
waiting..."`, and **no NPC had ever answered on this stack.** The recorded 302 sleeps
are an agent grinding against colleagues who could not speak.

Nothing reported it. `ps` showed the processes alive and the runner's liveness check
("NPCs listening (N processes)") passed — **liveness is not capability**, the same
error as `find_spec` certifying a module it never executes. The only evidence was a
400 line inside `/tmp/npc_*.log`, in a container destroyed at teardown.

### Diagnosis, in order

1. The agent's DMs *were* delivered — confirmed by logging in as `emily_zhou` and
   calling `im.list` / `im_history` directly: both messages present.
2. So the bot was receiving and failing. `/tmp/npc_Emily_Zhou.log` showed the
   assembled sotopia prompt followed by `HTTP/1.1 400 Bad Request`.
3. Probing the endpoint isolated two independent 400 causes — `stop: ["\n"]`
   ("each stop sequence must contain non-whitespace") and `temperature`. sotopia
   sends the latter.
4. Model probe: `claude-sonnet-4-5`, `claude-opus-4-5`, `claude-haiku-4-5` all accept
   `temperature`; `claude-sonnet-5` 400s.

### The fix

- `NPC_ENV_LLM` in `bench/tac/run-task.mjs` — colleagues get
  `HARNESS_TAC_NPC_MODEL`, default `openai/claude-sonnet-4-5`. **The grader keeps
  `claude-sonnet-5`**, verified working, so the judge does not drift.
- `bench/tac/npc-llm-preflight.py` — makes sotopia's exact call, *with* temperature,
  before the agent starts; writes `npc-preflight.json` into the run directory and
  logs `NPC LLM pre-flight: ok=…`. Captured before teardown, because a verdict that
  cannot be re-derived tomorrow is not a verdict.
- `integrity.valid` goes false when a task's colleagues cannot reply.

**The grader was never affected**: `llm_complete` passes no temperature. Verified in
container — `evaluate_with_llm` returns True on a true predicate, False on a false
one.

### What the fix revealed

`pm-schedule-meeting-2`, previously "questionable — the two required NPCs never
replied to *any* arm", scored 2/5 at 43 turns / $0.67:

> Emily offers Mon/Wed/Fri. Liu offers Tue/Thu/Fri. The agent picks Friday, confirms
> to both, writes `conclusion.txt`. **5/5, 7 turns, $0.074, six cells.**

The task was never hard. It was unanswerable.

**So the re-run is not a repair, it is the first measurement that can carry weight at
all.** The behavioural substitution the runtime targets does not depend on the
colleague replying — the agent's *intent* to wait is the same either way — but the
magnitude and the score were both measured on an unsolvable world. On the fixed stack
the tasks are solvable, so the score means something and the sleep counts reflect
real waiting.

### And then the waiting disappeared

With colleagues working, **NPC reply latency is 2.0–3.7 s** (n=18 replies, from
`world-before-grading.json` message timestamps). The agent's own turn latency is
~5.5 s. **The colleague answers faster than the agent can ask again.** There is
nothing left to wait for, and the anti-pattern the runtime replaces has nothing to
attach to.

---

## 1. Method

- **Independent variable:** `HARNESS_JOBS_RUNTIME`. ON = runtime staged, `jobs` bound
  in the kernel, in-process anti-patterns guarded, jobs guidance appended to the
  preamble. OFF = none of it. Both conditions are the **codemode** arm, identical
  tools (`ipython,edit`), same model (`anthropic/claude-opus-5`).
- **Treatment is runtime + guidance, deliberately.** Staged with no guidance the
  agent never used `jobs` once in 197 cells; the error channel alone is insufficient.
  Cost of that choice: the ON preamble is 4,367 chars against OFF's 2,775, a ~400
  token per-turn tax that is **not** corrected for and slightly inflates ON cost.
- **Pairing:** `(task, rep)`, ON and OFF run back to back so each pair shares a
  service state that drifts.
- **Sequential, always.** Every `init.sh` calls `reset.sh`, which wipes the shared
  services; concurrent tasks corrupt each other's world and it surfaces as a *score*.
- **n = 1 per (task, condition).** The planned n=3 sweep was stopped once the
  wait-contrast was shown to be an artefact — see §5. Everything below is
  **direction and consistency, never significance**: at 4 pairs a perfect 4/4 sign
  split is p=0.125 and cannot clear 0.05 even in principle.

### The A0 integrity gate

Every run self-certifies before its numbers count:

| check | evidence |
|---|---|
| kernel executes, persists state, has `jobs` bound | `kernel-preflight.json` — a real ipykernel runs `6*7`, then `x=41` / `x+1`, then `type(jobs)` |
| colleagues can reply | `npc-preflight.json` — sotopia's exact call, with temperature |
| no wedged cells | zero `"kernel did not respond"` results |
| prelude ran | STARTED/COMPLETED counts copied out before teardown |

A run with `integrity.valid === false` is excluded from every comparison.
**All 13 runs are integrity-valid. Zero INVALID — §4 is empty.**

### Scoring rule — decided before looking at outcomes

**Score is computed over rule-based checkpoints only. Every LLM-judged checkpoint is
dropped, uniformly, for both conditions.**

Justification, measured: the recorded judge input for `hr-collect-feedbacks` cp4
("the person receiving the feedback had an average job performance", against a
message ending *"Overall, you did average last quarter"*) replayed 5×:

```
no / yes / no / yes / no
```

**2 yes, 3 no on byte-identical input** — the "yes" answers reason correctly, the
"no" answers are a bare `no`. A coin flip carrying no signal, worth 2 of 5 points.
Uniform structural exclusion keeps the denominator identical across conditions;
per-run majority-voting would not, because the two conditions write different
messages.

Only two tasks here have any LLM-judged checkpoint (`LLM_CHECKPOINTS` in
`bench/tac/jobs-ab-report.mjs`, read off each `evaluator.py`):

| task | LLM-judged | points dropped | rule-based points kept |
|---|---|---|---|
| pm-schedule-meeting-2 | cp3 | 3 | 2 |
| hr-collect-feedbacks | cp4 | 2 | 3 |
| all five other tasks | — | 0 | all |

The rule-based figure also strips TAC's `bonus_for_completing_final` inflation, since
it sums checkpoints rather than reading `final_score`. Visible on
`hr-check-attendance-one-day`: `final_score` 3/3, checkpoints 2/3 — identical in both
conditions.

### Deviations to record

- **NPC model is `claude-sonnet-4-5`, grader is `claude-sonnet-5`.** Applied to both
  conditions identically — NPCs are shared world state — so it cannot be a
  differential confound. Before this change the NPCs used *nothing* (dead), so any
  working model is strictly better.
- Upstream judged with gpt-4o. MongoDB is official `mongo:5.0` (arm64), not Bitnami.

### Commands

```bash
node bench/tac/jobs-ab-sweep.mjs  ~/src/goals/web/.env.local --tasks <t,…> --reps 1 --prefix a1
node bench/tac/jobs-ab-report.mjs --prefix a1 --md
```

---

## 2. A1–A3 — the four wait-heavy tasks

Per run (`sleepC` = cells holding the kernel in a blocking sleep; `guard` = guard
refusals; `rule` = rule-based score):

| task | cond | cells | sleepC | threadC | jobsC | guard | turns | cost | secs | rule |
|---|---|---|---|---|---|---|---|---|---|---|
| admin-ask-for-meeting-feedback | ON | 7 | **0** | 0 | **0** | **0** | 8 | $0.111 | 55.6 | 6/6 |
| admin-ask-for-meeting-feedback | OFF | 6 | 3 | 0 | 0 | 0 | 7 | $0.093 | 86.7 | 6/6 |
| hr-collect-feedbacks | ON | 8 | **0** | 0 | **0** | **0** | 9 | $0.097 | 47.6 | 3/3 |
| hr-collect-feedbacks | OFF | 6 | 1 | 0 | 0 | 0 | 7 | $0.074 | 59.4 | 3/3 |
| pm-ask-for-issue-and-create-in-gitlab | ON | 20 | **0** | 0 | **0** | **0** | 21 | $0.335 | 97.7 | 5/5 |
| pm-ask-for-issue-and-create-in-gitlab | OFF | 14 | 3 | 0 | 0 | 0 | 15 | $0.298 | 192.4 | 5/5 |
| pm-schedule-meeting-2 | ON | 6 | **0** | 0 | **0** | **0** | 7 | $0.074 | 41.3 | 2/2 |
| pm-schedule-meeting-2 | OFF | 5 | 1 | 0 | 0 | 0 | 6 | $0.075 | 44.2 | 2/2 |

Paired ON − OFF, 4 pairs:

| metric | ON mean | OFF mean | Δ (ON−OFF) | sign test | t-test |
|---|---|---|---|---|---|
| blockingSleepCells | 0.00 | 2.00 | −2.00 ± 1.15 | 0/4, p=0.125 | t=−3.46, p=0.041 |
| threadCells | 0.00 | 0.00 | 0.00 | — | — |
| **jobsCells** | **0.00** | 0.00 | **0.00** | — | — |
| **guardFires** | **0.00** | 0.00 | **0.00** | — | — |
| turns | 11.25 | 8.75 | +2.50 ± 2.38 | 4/4, p=0.125 | t=2.10, p=0.127 |
| cost | $0.154 | $0.135 | +$0.019 ± 0.016 | 3/4, p=0.625 | t=2.41, p=0.095 |
| agentSeconds | 60.6 | 95.7 | −35.1 ± 41.4 | 0/4, p=0.125 | t=−1.70, p=0.188 |
| **ruleScoreFrac** | **1.000** | **1.000** | **0.000 ± 0.000 — every pair ties exactly** | — | — |
| scoreFrac *(do not read)* | 0.900 | 1.000 | −0.100 ± 0.200 | 0/1, p=1.000 | t=−1.00, p=0.391 |

### The runtime is never reached for

**`jobsCells` is 0 in all four ON runs**, including a 20-cell GitLab negotiation. The
agent had `jobs` bound, was told about it in the preamble, and correctly never used
it — because a colleague answers in 3 seconds. The `compare-waits.mjs` warning applies
in full: *"a run with all three at zero did no waiting at all and proves nothing"*.

### The sleep difference is NOT attributable to the runtime

ON has 0 blocking-sleep cells, OFF has 1–3. Tempting, and wrong to claim. **Every OFF
sleep is below the guard threshold:**

| task | sleep durations | total |
|---|---|---|
| pm-schedule-meeting-2 | 5s | 5s |
| hr-collect-feedbacks | 15s | 15s |
| admin-ask-for-meeting-feedback | 5s, 10s, 25s | 40s |
| pm-ask-for-issue-and-create-in-gitlab | 20s, 20s, 20s | 60s |

The guard fires at `>= 30`. **Maximum observed is 25s**, so the runtime would have
permitted every one of these on the ON arm too — nothing was mechanically removed.
The 0-vs-1/3 difference is either the preamble nudging the agent away from sleeping,
or plain trajectory variance, and at n=1 against this project's ~27% run-to-run noise
it **cannot be attributed to the runtime**. `guardFires = 0` everywhere is the direct
confirmation: no guard ever fired, so no guard ever removed anything.

Incidentally, the OFF agent's own voluntary sleeps cluster just under a ceiling it was
never told about (20s, 25s) — weak independent evidence that 30s sits in a sensible
place.

### Wall-clock: a mechanism illustration, and a tautology

ON finishes faster in all four pairs (−3s, −11s, −31s, −95s), and the gap tracks each
OFF run's sleep total. **That is the sleep restated, not an effect.** OFF slept for N
seconds, therefore OFF took ~N seconds longer. The only non-circular content is the
design premise it illustrates: *a blocking sleep costs real wall-clock, and neither
turns nor cost can see it* — a held kernel spends no tokens. It is **not** evidence
the runtime caused ON not to sleep; that is the same n=1, sub-guard attribution
retracted above.

### Turns and wall-clock can disagree in sign

`pm-ask-for-issue-and-create-in-gitlab`: ON took **more** turns (21 vs 15) and **less**
wall-clock (97.7s vs 192.4s), at near-identical cost ($0.335 vs $0.298) and identical
5/5. A single "efficiency" number would have to pick one and would mislead either way.
Methodological note, n=1.

### Score

Under the pre-registered rule, **all four pairs tie exactly** (Δ = 0.000 ± 0.000). The
apparent −0.100 in the unfiltered column is entirely `hr-collect-feedbacks` ON scoring
3/5 against OFF's 5/5 — the coin-flip checkpoint from §1. Both arms are 3/3 on the
rule-based checkpoints.

---

## 3. A4 — negative control, promoted to primary

Three tasks with zero recorded sleeps/threads and no LLM-judged checkpoints:

| task | cond | cells | sleepC | threadC | jobsC | guard | turns | cost | secs | rule |
|---|---|---|---|---|---|---|---|---|---|---|
| admin-make-spreadsheet | ON | 18 | 0 | 0 | **0** | **0** | 19 | $0.392 | 114.2 | 4/5 |
| admin-make-spreadsheet | OFF | 19 | 0 | 0 | 0 | 0 | 20 | $0.774 | 141.4 | 4/5 |
| admin-read-survey-and-summarise | ON | 17 | 0 | 0 | **0** | **0** | 18 | $0.276 | 102.3 | 2/3 |
| admin-read-survey-and-summarise | OFF | 19 | 0 | 0 | 0 | 0 | 20 | $0.418 | 128.4 | 3/3 |
| hr-check-attendance-one-day | ON | 3 | 0 | 0 | **0** | **0** | 4 | $0.042 | 29.0 | 2/3 |
| hr-check-attendance-one-day | OFF | 3 | 0 | 0 | 0 | 0 | 4 | $0.040 | 29.3 | 2/3 |

Paired ON − OFF, 3 pairs: `blockingSleepCells` 0.00, `threadCells` 0.00, **`jobsCells`
0.00, `guardFires` 0.00**; turns −1.00 ± 1.00; cost −$0.174 ± 0.194 (sign 1/3,
p=1.000); agentSeconds −17.9 ± 15.2; ruleScoreFrac −0.111 ± 0.192 (sign 0/1, p=1.000).

**The negative control passes on every axis it was built to test:**

- **No over-adoption.** `jobs` is bound and advertised in the preamble; the agent
  never touches it on work that needs no waiting.
- **No false refusals.** Zero guard fires across 6 runs and 79 cells. The guards do
  not trip on ordinary code — no `%%bash`, no subprocess, no library import provoked
  one.
- **No cost or turn penalty.** ON is nominally *cheaper* and shorter, but sign 1/3
  and 0/2 at n=1 — read as "no penalty", not as a saving. The `admin-make-spreadsheet`
  cost gap ($0.392 vs $0.774) is a single noisy pair, not an effect.

### The one score difference is a task defect, not runtime harm

`admin-read-survey-and-summarise` ON 2/3 vs OFF 3/3. Checked before believing it, per
the rule about reference answers. **Both arms computed identical tallies** — Coke 9,
Mountain Dew 6, then **a tie for third: Sprite 4, Apple Juice 4.** The evaluator
requires `'apple' and 'sprite'` both present:

- ON answered the question as asked — top 3: Coke, Mountain Dew, Apple Juice → cp3
  fails on the missing `sprite`.
- OFF happened to dump the full tally including Sprite → cp3 passes.

The task asks for "the top 3 most popular drinks" while the grader demands both tied
fourth-place-equal drinks be named. **An agent that answers precisely fails; one that
answers verbosely passes.** Add it to the list beside `admin-arrange-meeting-rooms`:
the reference answer is not well-defined under a tie. Nothing to do with the runtime.

---

## 4. INVALID runs

**None.** All 13 runs passed the A0 gate: `exec/persist/jobs` true on every ON run,
`npcLlmOk` true on every run with colleagues, zero "kernel did not respond" results,
zero timeouts.

---

## 5. What this establishes

1. **The runtime is safe to leave on.** On seven realistic office tasks in both
   conditions: no over-adoption, no false guard fires, no score cost (exact ties on
   every rule-based pair in A1), no turn or cost penalty beyond the ~400-token
   preamble. That is a real, publishable result — "nothing to do here, and it costs
   nothing to have".
2. **TAC cannot show the runtime's value, because a healthy TAC contains no waiting.**
   Colleagues answer in 2–4 s, faster than the agent's own turn. The "wait-heavy" task
   set was an artefact of colleagues who could never answer. Fixing the world removed
   the phenomenon.
3. **No claim is made that the runtime removes blocking sleeps.** Every observed sleep
   was below the guard threshold and no guard ever fired. Untested here.
4. **Score on TAC is unusable, not merely underpowered, wherever an LLM judges.** One
   checkpoint replayed 2 yes / 3 no on identical input. Rule-based checkpoints remain
   sound.

### Where the runtime's validation actually lives

- **A5 durability** — kernel-death recovery, N concurrent jobs, multi-minute waits.
  Nothing in TAC exercises submit/wait/get across a real elapsed-time gap.
- **A benchmark with genuine waiting** — builds, test runs, external processes.

### Results this supersedes

- **`tacval9` is not a baseline.** Measured on the degenerate stack, no integrity
  field, no NPC pre-flight; it retroactively fails the A0 gate. Its 2/5, its 24→0
  sleep count and its 43→25 turn comparison all describe an unsolvable world.
- **The recorded sleep/thread baselines** (302/48, 335/5, 215/5, 94/43) measure
  polling against mute colleagues, not a preference for blocking waits.
- **The 40-task codemode-vs-vanilla parity result (+0.035, t=0.99)** is doubly
  caveated — mute NPCs on every conversation task, and judge noise on the 26 of 175
  tasks with an LLM checkpoint. **Not to be cited.**
