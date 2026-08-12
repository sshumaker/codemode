# Scout report: τ-bench — **NO-GO**

Scouted 2026-08-12. Verdict reached in **Phase 0, at $0 of agent spend** (budget was
~$40). No agent run was ever justified: the benchmark fails the selection criteria on
measurements that require no LLM at all, and its grader fails the crippled-run control.

Everything below is measured in this repo, not read off the paper.

**Reproducing it.** Probes are kept in `vendor/tau-bench/`; the venv and the τ³ clone
were deleted afterwards to reclaim 1.2 GB on a disk that was at 99%. Both repos are
pinned, so every number here is re-derivable:

```bash
# v1 — phase0_probe.py (structure + grader controls), _probe2 (auto-pass mechanism),
#      _probe3 (the one-step transfer_to_human_agents exploit)
git clone https://github.com/sierra-research/tau-bench vendor/tau-bench
git -C vendor/tau-bench checkout 59a200c6d575d595120f1cb70fea53cef0632f6b   # 2026-03-18
uv venv vendor/tau-bench/.venv && uv pip install -e vendor/tau-bench
vendor/tau-bench/.venv/bin/python vendor/tau-bench/phase0_probe.py

# tau3 — tau3_probe.py (dials + reward_basis), tau3_probe2.py (inherited auto-pass).
# Both read data/tau2/domains/*/tasks.json directly; no install needed.
git clone https://github.com/sierra-research/tau2-bench vendor/tau2-bench
git -C vendor/tau2-bench checkout 79975ac5741e23fbb1d2ac44262d62398a6d87bd  # 2026-08-13
python3 vendor/tau-bench/tau3_probe.py
```

No API key is needed for any of it — every probe uses `user_strategy="human"`, which
constructs a user that never calls an LLM, and grades by replaying actions directly.

---

## Verdict in one paragraph

τ-bench's reward function is genuinely programmatic and **correct on ground truth
(140/140)** — but it is **not correct on a null policy**: an agent that calls
`transfer_to_human_agents` as its first and only action scores **1.0 on 38% of airline
tasks** and 6.1% of retail. Separately, the benchmark sits at the extreme low end of
both dials this project measures — **13–17 tools** (vs AppWorld's 469) and an empirical
**5.8–7.7 tool calls per task** (vs AppWorld's median 36) — so by our own stratified
result the expected codemode-vs-vanilla difference is ~$0.05/task against ~27%
run-to-run noise, diluted further by a large arm-invariant user-simulator cost. And
there is **no waiting of any kind**: every tool in both versions is a pure in-memory
dict mutation, so the jobs runtime has nothing to touch. Upstream itself deprecates v1
("the tasks in this repo are not updated") and the successor ships **75+ task fixes**.

---

## Phase 0 — grader trust (NO agent runs)

### The reward function

`tau_bench/envs/base.py::calculate_reward` — two programmatic components, no LLM:

1. **`r_actions`** — hash the DB after the agent's episode; reload a fresh DB, replay
   the task's ground-truth actions, hash again; require equality.
2. **`r_outputs`** — for each expected output string, require it to appear as a
   substring of some `respond` message: `output.lower() in content.lower().replace(",", "")`.

`pass^k` (`tau_bench/run.py::display_metrics`) is
`mean_over_tasks( C(c,k) / C(n,k) )` where `c` = successes for that task over `n`
trials. **This matches the paper's formula.** It is the one thing about τ-bench that is
unambiguously well-built.

### Control 1: does ground truth pass? — **YES, 140/140**

Replaying each task's GT actions plus a synthesized `respond` containing every expected
output scores 1.0 on every task sampled across all four splits. The reward function
does what it says.

### Control 2: does a crippled run fail? — **NO. This is the blocker.**

A do-nothing agent (zero actions, zero responses) scores **1.0**:

| split | do-nothing scores 1.0 | of which GT has 0 actions | of which GT is read-only |
|---|---|---|---|
| **airline/test** | **19/50 = 38.0%** | 7 | 12 |
| retail/test | 7/115 = 6.1% | 1 | 4 |
| retail/dev | 1/20 | — | — |
| retail/train | 0/500 | — | — |

**Mechanism:** `r_actions` compares *database state*, so it only ever detects **writes**.
A task whose ground truth is read-only (`get_reservation_details`, `search_direct_flight`,
`transfer_to_human_agents`) mutates nothing, so a do-nothing agent's hash matches
trivially. If that task also has `outputs == []`, there is literally nothing left to
check and the reward is 1.0 by default.

**It is reachable in one step, not just in theory.** `terminate_tools =
['transfer_to_human_agents']`, so that call sets `done=True` and triggers grading
immediately. Verified end-to-end through the real `env.step`:

```
airline/test: one-step 'transfer_to_human_agents' policy scores 1.0 on 19/50 = 38.0%
              tasks=[12,13,15,17,18,21,24,29,35,36,37,38,39,40,41,42,47,48,49]
retail/test:  one-step 'transfer_to_human_agents' policy scores 1.0 on  7/115 = 6.1%
```

Task 12 (airline) is representative — the user *insists* on a cancellation and refund;
the correct behaviour is to refuse. `actions=[]`, `outputs=[]`, so refusing and
capitulating and saying nothing all score 1.0. The intended check exists only in prose.

This is the CLAUDE.md failure shape verbatim: *"a deliberately crippled 12-second run
scored 3/3 on work it never did."* Per the plan's Phase-0 gate — **if either verdict is
wrong, stop** — this alone ends the scout.

### Control 3: does the output check bind where it exists? — **yes**

GT actions *without* a natural-language response fail 17/40 retail-test tasks (exactly
those carrying `outputs`). Where `outputs` is populated the grader is sound. It is only
populated on **37/115** retail-test and **4/50** airline-test tasks.

### Grader traps found (none fatal on their own, all worth recording)

- `calculate_reward` calls `self.step()` on GT actions, which **appends to
  `self.actions`** — the same list the output check scans. Harmless today only because
  no task's GT contains a `respond` action (verified: 0 across all 685 tasks). Any
  future task that adds one would let the ground truth satisfy the agent's output check.
- The substring check strips commas from the haystack but **not the needle**, so an
  expected output containing a comma could never match. Verified: 0 such outputs today.
  A latent trap, not a live bug.
- **Reward is only computed when `done`.** If the user simulator never emits
  `###STOP###` within `max_num_steps=30`, `reward` stays at its initialized `0.0`
  regardless of how correct the agent was. A correct agent that ends untidily scores
  zero, indistinguishably from a wrong one.

---

## The two dials, measured

This is the part that would have made τ-bench a poor fit even with a perfect grader.
`CLAUDE.md`: **cost ≈ actions × context**; representation acts on *actions*, residency
acts on *tokens per action*.

| | τ-bench v1 | τ³-bench | AppWorld (our reference) |
|---|---|---|---|
| tools (catalogue) | retail 16, airline 14 | retail 17, airline 15, telecom 13 | **469** |
| catalogue tokens | ~2,300–2,900 | comparable | **61,719** (L4 first-turn 101,137) |
| GT actions/task (median) | retail 5, airline 2 | retail 5, airline 2, telecom 6 | **36** (mean 52.7, max 244) |
| **actual** tool calls/task | **5.8–7.7** (n=1,980 shipped trajectories) | — | — |

The 5.8–7.7 figure is empirical, from the four trajectory sets the repo ships
(`historical_trajectories/`, gpt-4o and sonnet-3.5 × airline/retail, 1,980 runs).

**Projection against our own stratified result** (`docs/BENCHMARK-SELECTION.md` §10.4):

- *Residency* is a **fixed per-task tax proportional to resident tokens**: $0.524/task
  at AppWorld's 61.7k-token catalogue. τ-bench's catalogue is **~22× smaller**
  → expect **~$0.02/task**.
- *Representation* is **proportional to work done**: $0.070/task at the low stratum's
  11.5 calls, $0.764 at the high stratum's 101.8. τ-bench's 5.8–7.7 calls is *below*
  the low stratum → expect **~$0.03/task**.

Combined expected arm difference **~$0.05/task**, against ~27% run-to-run noise.

**And it is worse than that ratio suggests.** τ-bench trajectories are 25–30 messages
but only 6–8 tool calls: the task is mostly *dialogue with the user simulator*. That
conversational cost is **identical across arms** — it is common-mode. So the small
arm-differentiating term is diluted by a large invariant one, further depressing SNR.
τ-bench is dialogue-heavy and tool-light, which is precisely the wrong shape for us.
`docs/BENCHMARK-SELECTION.md` §2 already read this correctly at desk-research time
("multi-turn dialogue, few calls"); this scout confirms it with numbers.

---

## Waiting: none. The jobs runtime has nothing to touch.

Every tool in **both** versions is a pure synchronous function over an in-memory dict.
`grep` for `sleep|asyncio|await|requests|httpx|subprocess` across all tool modules
returns nothing in v1 and one false positive (a variable named `request_count`) in τ³.

τ-bench's "multi-turn" means **dialogue turns**, not elapsed time or background work.
There is no build, no external process, no polling, no state that outlives a step. A
task takes ~6 tool calls that each return instantly.

The `pass^k` metric is reliability *across independent restarts* — a real and
interesting property, but it is **policy consistency, not durability over a horizon**.
Nothing persists between trials, so it does not exercise submit/wait/get either.

**For Plan A (the runtime), τ-bench is a non-starter on the axis it was nominated for.**

---

## τ³-bench (the maintained successor) — better, still NO-GO

v1's README: *"the tasks in this repo are not updated… please use τ³-bench."* τ³ ships
**75+ task fixes** ("removed incorrect expected actions, clarified ambiguous
instructions, fixed impossible constraints"), citing SABER (arXiv 2512.07850). That is
upstream confirming v1's task set is a REFERENCE-class hazard, at scale.

τ³ measured directly from `data/tau2/domains/*/tasks.json`:

| domain | tasks | actions/task (mean/median) | reward basis | vacuous auto-pass |
|---|---|---|---|---|
| airline | 50 | 2.84 / 2 | DB + COMMUNICATE | **7/50 = 14.0%** |
| retail | 114 | 4.82 / 5 | DB + **NL_ASSERTION (98.2%)** | 1/114 = 0.9% |
| telecom | 2,285 | 5.78 / 6 | ENV_ASSERTION (programmatic) | 0/2,285 = 0% |

Three findings:

1. **τ³ airline inherits the auto-pass hole** — 14% of tasks have no in-basis criterion
   at all. In **all 7 cases** the task *does* carry an `nl_assertions` entry stating the
   real requirement (task 0: *"Agent should refuse to proceed with the cancellation"*) —
   and `NL_ASSERTION` is deliberately **excluded from `reward_basis`**. The check is
   written down and then not used. Same defect as v1, now with the intent visible in the
   data.
2. **τ³ retail reintroduces an LLM judge into 98.2% of rewards.** `CLAUDE.md` lists
   single-sample LLM judging as a confound that already invalidated a whole result set
   here. `telecom` (ENV_ASSERTION, 0% vacuous, 2,285 tasks) is the only clean domain.
3. **The dials do not move.** 13–17 tools, median 2–6 actions. τ³ fixes task quality; it
   does not change the benchmark's shape, and the shape is the disqualifier.

τ³ also warns that **v1.0.1 changed grading and results are not comparable across
versions** — a moving target for any longitudinal claim.

---

## Integration cost (assessed, not paid)

Non-trivial but tractable, and *not* the reason for the NO-GO.

τ-bench inverts control: `Agent.solve(env)` owns the loop and calls `litellm` directly,
against an **in-process Python** `Env` object. Running prime-agent faithfully means
keeping `Env` + `calculate_reward` real and replacing only the agent — i.e. a
`tau_bench.agents.base.Agent` subclass that stands up an MCP/HTTP shim over `env.step`
and drives prime-agent (Node) against it, with `respond` exposed as a tool mapping to
the user simulator. That is a real integration, not a reimplementation, and is the
correct shape per the "run the real harness" rule. Estimate **0.5–1 day**.

Per-task cost would be low (small catalogue, ~30 messages), but a `pass^k` result needs
`k` trials per task: a 50-task airline sweep at k=4 is 200 runs **plus** 200
user-simulator conversations.

---

## Failure taxonomy

No agent runs, so no AGENT-attributable fraction — Phase 0 gated before Phase 1, which
is the gate working as designed. The defects found are all in the benchmark itself:

| cause | count | evidence |
|---|---|---|
| **GRADER** | 38% of airline, 6.1% of retail v1; 14% of τ³ airline | crippled control scores 1.0; `r_actions` detects writes only |
| **REFERENCE** | 75+ tasks (upstream's own count) | τ³ release notes / SABER |
| **GRADER (latent)** | 3 traps | GT-actions appended to the scanned list; comma asymmetry; reward only on `done` |
| HARNESS / INTEGRATION | not reached | — |

---

## Recommendation

**NO-GO on τ-bench v1 and τ³-bench, for both threads.**

- *For the runtime (Plan A):* no waiting exists anywhere in the benchmark. Reject
  outright. **terminal-bench is the right nomination for this axis** — long-running
  commands are genuine elapsed time.
- *For the codemode thesis (Plan B):* 13–17 tools and ~6 calls/task put it below the
  low stratum on both dials, where our own paired measurement already found the
  representation effect to be $0.070 and needing 10/10 sign tests to see. Adding n here
  buys a tighter interval around approximately zero — the exact trap CLAUDE.md names
  ("sample on the axis you are measuring"). **AppWorld's challenge split remains the
  better instrument**, since it varies the dials rather than pinning both at minimum.

**If τ-bench is ever revisited**, the only defensible configuration is **τ³ `telecom`**:
2,285 tasks, purely programmatic ENV_ASSERTION grading, zero vacuous tasks, and the
highest action count of any domain (median 6). It still has no waiting and a 13-tool
catalogue, so it would be a *reliability* instrument (`pass^k`), never a
representation-vs-residency one. Any use of airline or retail must first exclude the 7
vacuous airline tasks and confront retail's 98% LLM-judged reward.

**One transferable control for our own harness:** τ-bench's grader passes ground truth
and *also* passes doing nothing, because it compares end-state and the end-state is
unchanged for read-only tasks. Any state-diff grader we build inherits this. The
null-policy control belongs next to the ground-truth control in
`bench/test/fairness.test.mjs` — a documented check is not an executed check.
