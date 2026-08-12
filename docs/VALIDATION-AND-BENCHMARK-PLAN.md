# Plan: validating the jobs runtime, and standing up a new benchmark

Draft for review. Two independent plans. Each phase is written to be assignable to a
separate agent, with an explicit **gate** (do not proceed until met) and **falsifier**
(what result would kill the claim), because the failure mode this whole session hit is
a broken harness producing the same-looking number as a real result.

---

## STRATEGIC UPDATE (2026-08-12): TAC cannot validate the runtime — the wait was an artefact

Discovered mid-execution: TheAgentCompany's "wait-heavy" tasks were wait-heavy only
because the NPC colleagues could never reply (sotopia hard-codes temperature; our
env-LLM 400s on it). The 302 in-cell sleeps / 48 poll threads on pm-schedule-meeting-2
were the agent grinding against a mute channel. **Fix the colleagues and the task
solves in 6 clean cells with 0 sleeps, 0 threads, 0 jobs calls** — there is nothing to
wait for, because a healthy TAC world has no genuine elapsed-time waiting (no builds,
no training, no real latency; colleagues reply within a cell).

Consequences for the plan:

- **A1–A3 on TAC is demoted from "does the runtime help" to a SAFETY/NEUTRALITY check**
  (A4 promoted to primary): on realistic tasks with no waiting, does the runtime do
  harm — unnecessary `jobs` adoption, false guard fires, cost regression? ~6–8 runs,
  not a 24-run sweep. A clean "neutral, safe to have on" is the honest deliverable.
- **The runtime's real validation moves entirely off TAC** to (1) the durability
  harness (A5 — synthetic, controlled elapsed-time waits, kernel death, concurrency)
  and (2) a benchmark with *inherent* waiting (terminal-bench: long commands, real
  subprocesses). These are the only instruments that exercise submit/wait/get.
- This is itself a finding: **TAC is the wrong instrument for the runtime**, proven by
  measurement, not assumed.

---

## Plan A — validate the jobs runtime

### The claims, ranked, and what evidence each needs

| # | claim | metric | status |
|---|---|---|---|
| A0 | the harness is intact (kernel starts, cells run, state persists) | 0 "kernel did not respond", persistence probe passes, PRELUDE-OK | **precondition — gates everything** |
| A1 | the runtime replaces the anti-patterns | blockingSleepCells→0, threadCells→0, jobsCells>0 | n=1 positive (tacval9) |
| A2 | it does not cost more | turns, $ paired vs baseline | n=1 positive (25/$0.57 vs 43/$0.67) |
| A3 | it does not hurt quality | score, paired | n=1 neutral (2/5 = 2/5) |
| A4 | it is neutral on tasks that need no waiting | negative control | **untested** |
| A5 | it survives kernel death / concurrency / long horizon | recovery via get(), N concurrent jobs, multi-minute waits | **untested (#7)** |

A1–A3 are "the runtime helps on the task it targets." A4 is "it doesn't hurt
elsewhere." A5 is the durability story that motivated the design and has no evidence
at all.

### A0 — the integrity gate (do this first, everything depends on it)

The bug that ate seven runs: a broken kernel and a weak agent produce identical
numbers. Every run in this plan must **self-certify** before its numbers count.

- [ ] every run logs its condition explicitly (`jobs runtime: ON|OFF`) — done
- [ ] prelude writes STARTED/FAILED/COMPLETED to a file copied out **before**
      teardown — done
- [ ] the runner asserts **0** "kernel did not respond" results, and marks the run
      INVALID otherwise rather than reporting a score
- [ ] a one-cell persistence probe (`x=1` then `x+1`) runs at startup and is recorded
- [ ] `compare-waits.mjs` refuses to emit a comparison for a run flagged INVALID

**Gate:** no A1–A5 run is trusted until A0 is green for it.
**Falsifier for the whole plan:** if the integrity checks cannot be made to pass
reliably, stop — there is nothing to measure.

### A1–A3 — the behavioral result (main sweep)

- **Design:** paired A/B, runtime ON vs OFF, same task. Use `--overwrite`/tag
  discipline so ON and OFF are contemporaneous (services drift).
- **Task set (wait-heavy, from recorded sleep/thread counts):**
  `pm-schedule-meeting-2` (302/48), `admin-ask-for-meeting-feedback` (335/5),
  `hr-collect-feedbacks` (215/5), `pm-ask-for-issue-and-create-in-gitlab` (94/43).
- **n:** ≥3 reps per (task, arm). Run-to-run noise here is ~27%, and CLAUDE.md is
  explicit that under ~20 paired cells cannot rank two variants — 4 tasks × 3 reps =
  12 paired cells is the floor, more if the signal is small.
- **Stats:** paired per task, **sign test** as the headline (cost is right-skewed),
  t-test secondary. Reuse `bench/stats.mjs`.
- **Primary metrics:** blockingSleepCells, threadCells, turns, cost. **Score is
  secondary and reported as underpowered** — TAC scores are noisy and at least one
  reference answer in the suite is wrong (check `evaluator.py` before believing a
  confident failure).
- [ ] read every trajectory in the first rep end to end before trusting the aggregate

**Falsifier:** if turns/cost are not better (or at least neutral) with the
anti-patterns gone, the runtime is trading kernel-holding for turn-burning and the
design needs rework — which is exactly what the *broken* runs falsely showed.

### A4 — negative control (does it hurt where waiting isn't needed?)

- Run the runtime ON on TAC tasks with **zero** recorded sleeps/threads.
- **Expectation:** identical behavior and cost to OFF. The guards must never fire, and
  `jobs` must not be reached for.
- **Falsifier:** if the agent reaches for `jobs` on trivial work, or the guards fire
  on normal code, the surface is too loud — same failure as an API used when it
  should not be.

### A5 — durability (the untested motivation, #7)

Three sub-tests, mostly hermetic (fast, cheap), one on TAC:

- [ ] **kernel death:** submit a long job, `%reset -f` (or kill+respawn the kernel),
      confirm `jobs.get(name)` recovers it and the work completed. Assert the agent is
      told the kernel restarted and recovers without re-doing work.
- [ ] **concurrency:** submit N jobs, `jobs.wait` once, collect all N. Assert no
      races, correct per-job output, `manifest()` lists all.
- [ ] **long horizon:** a genuinely multi-minute task (build + test, or a staged
      pipeline) where a single `wait` is not enough and the agent must poll across
      several waits. This is the only case that exercises the design's actual point;
      every eval task so far finishes inside one wait.

**Falsifier:** if recovery loses work, or concurrent jobs race, or the poll loop
degenerates (per-turn `print(N)` as seen in the broken runs — confirm it does NOT
recur with a working kernel), the durability claim fails.

### Parallelizable units (A)

1. **integrity + logging** (A0) — make every run self-certify; blocks the rest
2. **wait-heavy sweep** (A1–A3) — the main behavioral result
3. **negative control + guard regression** (A4) — cheap, independent
4. **durability harness** (A5) — mostly synthetic, independent of TAC

---

## Plan B — stand up a new benchmark suite

### Why

Everything is TAC + MCP-Bench + AppWorld. TAC's limits are documented (zero MCPs,
silent grading failures, disk fragility). For the **runtime** specifically we need a
benchmark with genuine long-horizon work — builds, training, external processes,
multi-stage waits — because that is the only thing that exercises submit/wait/get.
For the **codemode thesis** we additionally want a real tool surface.

### Selection criteria (hard-won, from BENCHMARK-SELECTION.md)

1. **Deterministic/programmatic grading** — so score is signal, not noise. Verify by
   grading a ground-truth answer (must pass) and a crippled run (must fail).
2. **Long horizon with real waiting or background work** — the axis the runtime
   targets. A benchmark of one-shot Q&A tests nothing here.
3. **A tool surface** (APIs/MCPs/filesystem+shell) — needed for codemode vs vanilla.
4. **Not saturated** by Opus — headroom to move a score.
5. **Runnable locally at reasonable cost**, ideally dockerized/hermetic.

### Candidates (independent scouting workstreams)

| benchmark | waiting? | grading | tool surface | note |
|---|---|---|---|---|
| **AppWorld challenge split** | little | programmatic | 469 APIs | cheapest — harness already built; short tasks though |
| **terminal-bench** | yes (long cmds) | programmatic | shell+fs | strong fit for the runtime |
| **SWE-bench Verified** | some (test runs) | tests | fs+shell | long, real, but compute not waiting |
| **τ-bench** | multi-turn | programmatic + consistency | tool APIs | reliability-over-horizon metric |
| **RE-bench / MLE-bench** | hours (training) | programmatic | fs+compute | where durability actually bites; expensive |

Rough read: **terminal-bench** and **τ-bench** are the best runtime fits;
**AppWorld challenge split** is the cheapest confirmation of the codemode result;
**MLE-bench** is the maximal durability test if budget allows.

### The method: incremental, failure-driven buildup (NOT "run the suite")

A new benchmark's failure modes are unknown, and a low score has at least five causes
that look identical in aggregate. The agent's job in the pilot is to earn trust in the
harness one task at a time by diagnosing **why** each non-passing task failed — not to
report a number. Scaling is a reward for a clean tier, never the first move.

**The five causes of a non-passing task, and how to tell them apart:**

| cause | what it is | how to distinguish | counts as a result? |
|---|---|---|---|
| **AGENT** | the agent genuinely did the wrong thing | read the trajectory: it had the tools, reached the surface, and chose wrong | **yes — the only kind that does** |
| **HARNESS** | env/tooling broke under it | kernel didn't start, a tool call never reached the surface, an image/attachment was dropped | no — fix and re-run |
| **GRADER** | grading misfired | grade a *ground-truth* solution — if it doesn't pass, the grader is broken (the `evaluate_with_llm`-returns-False-on-its-own-error trap) | no — fix the grader |
| **REFERENCE** | the reference answer is wrong | recompute the expected answer by hand; read the task's `evaluator.py` (cf. `admin-arrange-meeting-rooms`, ref says 4, truth is 5) | no — exclude the task |
| **INTEGRATION** | our own wiring | condition flag unset, prompt not passed, wrong path — the class that ate seven TAC runs tonight | no — fix the wiring |

Only AGENT failures are data. The pilot exists to drive HARNESS / GRADER / REFERENCE /
INTEGRATION to zero so that the *next* tier's failures are trustworthy.

**Phase 0 — grader trust, before any agent runs.** Grade a ground-truth solution
(must pass) and a deliberately-crippled one (must fail). Read the grader source. If
either verdict is wrong, stop: no agent number from this benchmark means anything yet.
This is ~1 hour and it gates everything.

**Phase 1 — one task, one run, read it whole.** Run the agent on a single task. Read
the entire trajectory *and* the graded result. Classify the outcome into the taxonomy
above. Do not run a second task yet.

**Phase 2 — the triage loop.** For every non-passing task, classify the cause *before
running anything else*. Persist the evidence: the trajectory, the grader's input and
verdict, and the world/artifacts the grader saw — because the environment resets and a
verdict you cannot re-derive tomorrow is a verdict you cannot trust (this is the
"log the inputs, not just the verdicts" rule). Maintain a running failure log for the
benchmark, in the shape of `docs/TAC-HANDOFF.md`.

**Phase 3 — the ratchet.** Expand the task set only when the current tier is CLEAN —
every non-passing task in it classified AGENT, with zero HARNESS/GRADER/REFERENCE/
INTEGRATION left. Tiers: 1 → 3 → 5 → 10 → …. A dirty tier never scales; it gets
debugged. Each new tier is likely to surface a new harness/grader trap the smaller one
could not (TAC's disk-fill at task 8 is the canonical example — invisible below the
tier that triggered it).

**Phase 4 — the deliverable is a go/no-go, not a score.** The pilot reports: does the
grader work (Phase 0 result); the failure taxonomy with counts; the fraction of
failures that are genuinely AGENT-attributable; cost per task and projected sweep cost;
and the benchmark's own traps discovered. A score is reported only once the taxonomy is
clean, and even then marked underpowered per the decision above.

**Two rules carried from Plan A:** run the *real* harness (never a reimplementation —
the mistake that cost this project a benchmark), and port the A0 integrity gate so
every run self-certifies (condition logged, kernel-up asserted, prelude self-status
captured pre-teardown).

### Per-scout-agent brief (hand-off template)

Each scout agent gets the same five phases, plus benchmark-specific Phase-0 pointers:

- **scout-appworld:** harness already exists (`bench/appworld/`). Phase 0 is cheap —
  AppWorld ships ground-truth solutions; grade one, confirm it passes. Fastest to a
  clean tier. Watch: challenge split is held-out, so tasks may be harder than dev.
- **scout-terminal:** find the grader (terminal-bench uses per-task test scripts).
  Phase 0 = run the reference solution's tests. Watch: long commands are where the
  runtime matters, so pick wait-heavy tasks deliberately, and confirm the agent's
  shell actually reaches the real terminal (not a reimplementation).
- **scout-tau:** grading is programmatic + a consistency metric (pass^k over repeats).
  Phase 0 = confirm a ground-truth policy passes and that the consistency metric is
  computed as documented. Watch: the reliability metric needs repeats, so budget for
  n>1 per task from the start.

Every scout's Phase-4 report is reviewed by the lead before any scaling spend.

### Parallelizable units (B)

- one agent per candidate benchmark does **scout + pilot only**, and reports back a
  go/no-go with a cost estimate and the grader-integrity result. No scaling until a
  human picks winners. This keeps spend bounded — the expensive part (full sweeps) is
  gated behind a review.

---

## Decisions (locked 2026-08-12)

1. **Primary claim:** BOTH — push n on A1–A3 *and* land A5 durability, in parallel.
2. **Benchmarks to scout:** terminal-bench, τ-bench, AppWorld challenge split (not
   MLE-bench).
3. **Score:** behavior + cost primary; score reported as underpowered secondary.
4. **Budget:** ~$400+, so agents size their own runs generously.

## The constraint that reshapes parallelism: TAC tasks share one stack

CLAUDE.md: *tasks cannot run in parallel on one TAC stack* — each `init.sh` calls
`reset.sh`, which wipes the shared services, so concurrent TAC tasks corrupt each
other's world and it surfaces as a score, not an error. Standing up N parallel stacks
is possible but heavy (one service stack per worker on its own network + edge proxy).

So the real split is:

- **Serial on the one TAC stack** (one agent owns it): A1–A3 wait-heavy sweep, then
  A4 negative control. Same stack, sequential.
- **Fully parallel** (own repos/envs, no TAC stack): A5 durability (mostly synthetic),
  and the three benchmark scouts.

## Agent roster

Prereq (not an agent — foundation, done by lead first): **A0 integrity gate** finished
and shared, so every downstream run self-certifies.

| agent | scope | env | budget | gate |
|---|---|---|---|---|
| **lead (now)** | A0: INVALID-marking, persistence probe, compare-waits refuses invalid | local | — | blocks TAC agents |
| **tac-runner** | A1–A4, serial on the TAC stack: 4 wait-heavy tasks ×3 reps ON/OFF, then negative control | TAC stack | ~$80 | after A0 |
| **durability** | A5: kernel-death recovery, N-concurrent jobs, one long-horizon multi-wait task | synthetic + 1 TAC | ~$40 | after A0 |
| **scout-terminal** | terminal-bench scout+pilot, go/no-go + cost + grader-integrity | own | ~$40 | — |
| **scout-tau** | τ-bench scout+pilot | own | ~$40 | — |
| **scout-appworld** | AppWorld challenge-split scout+pilot (harness exists) | own | ~$30 | — |

Scaling any benchmark past pilot is gated on lead review — the expensive part stays
behind a human check.

