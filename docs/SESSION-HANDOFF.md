# Session handoff — codemode benchmarking & hardening

Branch: `scott/jobs-runtime` (all work pushed). Last commits worth knowing:
`0f26422` (required-param + held-out parity), `1abec4b` (batch-reads),
`ad6f9fb` (terminal-bench cc-fails-long-build + `--src-root` seam),
`2357a6b` (guarded bash). Tests: **471 JS + 275 Python, green.**

## Where things stand — the one-paragraph version

Codemode (our hardened kernel runtime) **ties Claude Code on quality** (44/46 vs
44/46, held-out, fresh seed) at **2.3× lower cost, ~20× less first-turn context,
1.4× faster**, and **4× cheaper than the same harness in tool-calling mode** on the
full 417-task AppWorld suite (n=432, paired t=−25.8). On terminal-bench it PASSED a
30-min build via the jobs runtime where **Claude Code FAILED** (ended its turn
mid-build; a `-p` loop has no resume seam) — n=1, an existence proof of the wait
mechanism, not a rate. The accumulated-config regression is clean (92.5% on fresh
tasks, no gate over-firing).

## The deliverable this session produced

**`docs/codemode.html`** — published artifact
(https://claude.ai/code/artifact/87ab0c0e-1a8d-4804-9e19-1e20110f63ea), a
team-facing explainer: thesis (harness shifts tasks into the model's *local
distribution*, cites Alex Zhang 2026), the MCP→Python pipeline, the wait/turn-seam,
the cloud-schedulable jobs design, the systems, and clean large-n metrics. If you
edit it, republish the **same file path** to keep the URL.

## Systems built & shipped (all on the branch)

- **Jobs runtime** (`runtime/jobs.py`): submit/wait/get/manifest/kill, file-backed,
  kernel-death recovery. `wait(wake_after=N)` = a **deadline** (wakes early on job
  finish), ends the turn. Designed for *remote* hosting: schedulable, resumable,
  evictable kernel → small micro-VMs, not a long-running VM.
- **Cell watchdog + kernel guards** (`runtime/kernel-prelude.py`): threading /
  subprocess / long-sleep → jobs redirect; SIGALRM wall-clock ceiling at 120s.
- **MCP→API compiler** (`bench/generate.mjs`): typed Python (anyOf/oneOf/enum fixed),
  consolidated one-file-per-app layout, LLM enrichment (schemas-only, narrowing-only,
  guardrailed), runtime arg validation.
- **Read-gate** (Edit-tool semantics: verified precondition, no path through).
- **Required-param transform** (consequential runtime-state defaults → required;
  fixed the ce73d68 family 0/12→12/12).
- **Subagents on jobs** (`runtime/subagents.py`): `spawn(prompt, name=, agent=…)`,
  9/9 live smoke. Found + fixed 2 hosted-harness bugs (sandbox denies child network;
  global daemon-socket cross-run leak).
- **Guarded bash** (`bench/arms/bash-tool-extension.ts`): intercepts prime's real
  bash, reuses `jobs.blocking_sleep` + 120s ceiling; AppWorld egress-locked.

## Key learnings (about codemode, not the benchmark plumbing)

1. **Cost = actions × context.** Representation (code vs tool-calls) acts on actions;
   residency acts on tokens/action. The advantage is two additive factors: residency
   is a fixed per-task tax, representation is proportional to the work. On a large
   task they compound.
2. **Context management is representation-linked, not a scaffold feature.** A REPL's
   "caller decides what survives" cannot be ported to a tool-calling arm — but
   *programmatic tool calling* recovers part of it (documented honestly in the
   artifact). It's a spectrum, codemode is the far end.
3. **Corrections belong in the error channel, not the prompt.** Guard-fires →
   adoption next cell; prompt advisories get clamped-and-missed. Measured repeatedly.
4. **For a consequential default, required > optional > documented.** The model
   won't read a docstring it feels certain about; visible-but-optional (even at L4)
   doesn't fix it; making the param *required* does. Read-gate proved reading alone
   doesn't elicit the situational inference.
5. **Match the idiom, deviate on one verb.** `wait` (ends the turn) is the only
   forced deviation; everything else is ordinary code/Read/Grep/bash the model
   already knows.
6. **The bash-tool tax was real and now fixed.** Without a bash tool, codemode
   hand-rolled `subprocess` dumping stdout[-4000:] → 8× the context ingestion
   (55k vs 7k chars on compcert). This inflated the old terminal-bench cost numbers;
   the guarded bash tool closes it (ctx0 55k→~7k).
7. **Cold-start is one-time & global**, not per-session: ~5s warm, ~70s cold boot
   (285MB venv page-fault), up to 190s only under concurrent cold boots. Prewarm
   pool erases it → a hosting launch requirement.

## Discipline that must carry forward (this bit earned its keep)

- **Always read the agent trace before diagnosing.** Every proxy-based diagnosis this
  session (eval diffs, greps, ledgers) was wrong at least once; the cells were right.
  `/diagnose-run-fail` skill (`.claude/skills/`) encodes it: A0 → read trace →
  paired-arm → grader frame → classify → n-discipline → log evidence.
- **Verify agent reports against raw artifacts before committing.** Caught: a dead
  `rg` binary (grep advertised, never executable — the L1-that-was-L4 class), a
  wedge-detector false-negative, mis-classified failures, a smoke documented-not-run,
  a selection-biased cc corpus. Never trust a subagent summary; run the test yourself.
- **Score is underpowered; rank on cost/context.** ~27% run-to-run noise; identical
  config scored 8/8 then 3/8. Always paired t + sign test (`bench/stats.mjs`); when
  they disagree, believe the sign test.
- **Measure against the noise floor.** Baseline re-run ×2 established a 37% floor on
  "codemode failures"; a third were flaky. Every "fix" number is vs that floor.

## Open threads / next steps

1. **Benchmark direction decision (awaiting Scott).** CyberGym vs SWE-bench.
   - **CyberGym** (`docs/CYBERGYM-3ARM.md` if created; #45): unsaturated (~20% top),
     real, but PoC-*exploit* generation tripped Opus's safety classifier. **HALTED —
     do NOT reword to evade the flag.** Needs explicit user authorization + tight
     scope (10 historical tasks, no fan-out) or drop it.
   - **SWE-bench** (recommended): hard, unsaturated, *defensive* (fix bugs), adapter
     already in `vendor/terminal-bench/adapters/swebench`, same big-codebase context
     stress, no dual-use tension. My recommendation.
   - Cybench is set up but **saturated (~96%)** — parked (`docs/CYBENCH-3ARM.md`,
     setup-only, $0 spent). Its `--src-root` seam carries to any new dataset.
2. **Subagents #34: the vanilla `task()` tool** (matched counterpart to `spawn`) is
   the unbuilt half. And subagents (1-module-vs-9-schemas) are **untested on a
   long-horizon benchmark** — terminal-bench phase 2 was designed for it, never run.
3. **Punch list #35** (small, benign): symmetric API-error logging (HTTP status for
   prime); capture cc `thinking_tokens` (currently logged as "" — a logging bug that
   makes cc's thinking undiagnosable).
4. **terminal-bench**: only Phase 1a ran (compcert/cartpole/sqlite). The clean
   thesis demo — a wait that *exceeds* the budget (where blocking also breaks, only
   jobs survives) — was designed but not run. And the guarded-bash compcert re-run
   never completed grading (cut off) — a clean with-bash long-horizon cost number is
   still missing.

## Env / how to run (so the next session doesn't rediscover it)

- API key env file: `~/src/goals/web/.env.local`.
- AppWorld: `node bench/appworld/sweep.mjs ~/src/goals/web/.env.local --sample N
  --split test_challenge --seed S --arms codemode --codemode-api-layout=consolidated
  --codemode-nav-tools --base-prompt=v2 --codemode-read-gate --codemode-required-defaults`
  (that flag stack = the shipped hardened codemode). `--codemode-bash` adds guarded bash.
- terminal-bench: `bash bench/terminal/sweep.sh --arm codemode --jobs on --tasks <id>`;
  `--agent claude-code` / `--arm vanilla` for the other arms; oracle screen first.
  colima docker host; `df -h` before runs; prune only `tb-*` images, **never TAC**.
- Prewarm is automatic in the AppWorld sweep; cold-start caveat above.
- Verify tools: `npm test` (471), `cd runtime && python3 -m unittest discover` (275),
  `node bench/appworld/... ` cost identity via `bench/stats.mjs`.
