# Session handoff — code review, cloud-harness design, and the hardening crank

Branch: merged to `main` (all pushed). This session: 2026-08-15, the review +
design + Phases 0–4 crank. Prior handoff content is superseded; the codemode
results summary lives in `docs/codemode.html` (published artifact) and
`TB-3ARM-CAMPAIGN.md` §8–9.

Tests at handoff: **489 JS + 301 Python, green** (ran ×2–3 for flake checks).

## What this session produced

1. **Four-agent fine-tooth-comb review** → `CODE-REVIEW-2026-08-15.md`.
   Every HIGH finding empirically verified. Headlines: 13/19 kernel guards
   emitted a lambda repr instead of the correction; the patch scripts had
   diverged from the committed tree four ways (incl. a marker collision that
   silently dropped the measured-best namespace patch); the compiler was safe
   on AppWorld's dialect by luck; jobs had real eviction/PID-reuse holes;
   auto-refine was never actually neutralized; `schema-score.mjs` mis-scored
   codemode tool names (**re-check quoted MCP-Bench `valid_tool_name_rate`**).

2. **The architecture decision** → `CLOUD-HARNESS-DESIGN.md`. Pattern
   comparison (Anthropic Managed Agents post vs prime's daemon): prime-shaped
   *within* a turn (colocated loop+kernel), MA-shaped *between* turns (the log
   is the only truth, harness stateless, eviction = process exit). Codemode's
   1-action/turn + tiny context makes the decoupled pattern uniquely cheap for
   it — an argument worth adding to the explainer. Resolves D1 (subagents on
   our jobs substrate) and D2 (no prime daemon, no MA dependency: our loop +
   log-as-truth + a small wake scheduler).

3. **Phases 0–4, all committed with gates green:**
   - *Phase 0* (`e59e5a4`): guard strings + message-content tests; container-
     kernel path deleted; **pristine-replay test** (scripts must reproduce the
     committed vendor tree byte-for-byte — caught three patcher bug classes on
     its first run, incl. `String.replace` `$`-pattern splicing); pathExists
     async; wait sentinel line-anchored/token-gated/abortable; schema-score
     imports the real pyIdent; autoRefine off in every runner
     (`bench/prime-settings.mjs`); TB jobs-manifest glob fixed; H5 turn dedup.
   - *Phase 1* (`e11793e`): compiler hardened — `pyDocstring`/`pyLiteral`,
     collision registry (servers/tools/params), deduped pkg threaded through
     all renderers, schema defaults surfaced to both arms, `hostile` fixture +
     import-gated `bench/test/hostile.test.mjs` (16 tests).
   - *Phase 2* (`39e2990`): **`runtime/test_chaos.py` — the SIGKILL-replay
     invariant executable** (9 tests, real kills, fresh stores). Fixes it
     forced: liveness fallback with two-sighting confirmation (single `ps`
     misreads happen — measured), start-identity-checked kills, fsync'd
     writes, bounded log reads, config-at-construction, `CellHeldError`
     (BaseException) + re-arming watchdog, cross-cell adoption names,
     subagents staged into containers with in-container import check.
   - *Phase 3* (`7d9c4d3`): **`runtime/scheduler.py`** (~200 lines) + 13
     tests. Sessions are directories; wake = deadline ∨ watched-job-finished;
     leases carry pid+start-identity with rename-race stale reclaim;
     `jobs.wait` writes `wake.json` under `HARNESS_WAKE_FILE`;
     `HARNESS_WAIT_MODE=exit` makes the ipython wait patch end the run instead
     of sleeping — prime `--resume` is the wake seam cc lacked on compcert.
   - *Phase 4* (`fa2241c`, partial): 501k lines of vendored upstream
     tests/docs/examples deleted; pi-mono → 9 files; **agent-traces upload
     gated behind `PRIME_AGENT_TRACES=1`** (was the one call-home no env var
     could stop).

4. **Validation run this session** (shipped flag stack, all mechanism-checked):
   ce73d68_{1,2,3} 3/3 PASS 11/11 · edge tasks 82e2fac_1 PASS, 92fe421_3 4/5
   (known-marginal, within noise) · high-call 692c77d_3 (68 api) + 57c3486_1
   (100 api) both PASS · final assembled-tree canary 2/2 PASS. ctx0 ~6.5k and
   costs in the normal band throughout.

## Scheduler demo: DONE — Phase 3 accepted (2026-08-15)

`compile-compcert`, `--wait-mode exit`, run `scheduler-compcert-demo5`:
**PASS, tier CLEAN** — 27 turns / 27 tool calls / **$0.387** / 643s,
**wakes=6 (every one evidence-driven — including a wake on a FAILED opam job
the agent then diagnosed and recovered)**, 0 blocking sleeps, 0 kernel
restarts, 12 jobs cells, clean drain ("nothing left waiting"). The harness
process exited at every wait (~13 separate prime processes across the task);
`prime -c` + the wake message is the resume seam. Compare sleep-mode campaign
PASS at $0.726 and claude-code FAIL at $0.902 (n=1 each; not a ranking).

It took five attempts, each finding a real defect from artifacts:
(1) stale volume — exit mode now REQUIRES its own build marker in preflight;
(2+3) the model busy-polled instant wait returns through two escalations of
stop-language — **the run now ends by MECHANISM** (`process.exit` after a
grace period; HARNESS_WAIT_EXIT_GRACE_MS), and the kernel-side wait message is
mode-aware (it used to say "the host waits Ns and calls you again", directly
contradicting the stop);
(4) wake writes lost to ENOENT — session dir now exists from staging, jobs.py
makedirs defensively, and a wake-less drain records drainNote;
(5) scheduler stdout was block-buffered under the pipe — now `python3 -u`.
The measured generalization: **a deviation the prose requests, the mechanism
must enforce** — prompt-escalation lost to the sampling prior twice.

## Open threads, in priority order

1. **Scheduler hardening follow-ups**: orphaned kernel per wake (the exiting
   prime leaves its ipykernel child in-container — harmless per-run, a leak
   for long-lived hosts); a scheduler kill -9 mid-build resilience run (the
   unit suite covers replay; the live variant is unrun); steer vs follow_up
   delivery modes.
2. **Phase 4 remainder**: in-src excision (interactive 24k, agents-view, ACP,
   refinement, telemetry) — needs a scripted slim step so pristine-replay
   keeps refereeing. The base-harness audit in CODE-REVIEW-2026-08-15.md §base
   is the cut list. Also parked: daemon-socket ownership (bench runs share a
   per-uid supervisor — force in-process or per-run `--daemon-socket`).
3. **Deferred dedup** (review P3): `loadCatalogue()` (6 copies + 5×
   `generate()` per run in bench/run-task.mjs), argv `flag()` (17 files),
   enrich-catalogue/required-defaults twin merge, 5 JSON-stream collectors →
   one (TB turn counts are still a different unit than other benchmarks).
4. **Re-check MCP-Bench numbers** after the schema-score fix (P0.1).
5. **Benchmark direction** (pre-existing): SWE-bench recommended over CyberGym
   (safety-flag halt stands). Subagents still untested long-horizon.
6. **Product port spike** on the Phase 0–3 substrate.

## How to run (unchanged + new)

- Env: `~/src/goals/web/.env.local`. AppWorld flag stack: `--codemode-api-layout=consolidated
  --codemode-nav-tools --base-prompt=v2 --codemode-read-gate --codemode-required-defaults`.
- New gates: `python3 -m unittest test_chaos` (SIGKILL-replay),
  `test_scheduler`; pristine-replay runs inside `npm test` (provenance suite).
- **Editing vendored prime src**: change the SCRIPT (`scripts/neutralize-prime.mjs`
  / `port-vanilla-tools.mjs`) and the tree together — the pristine-replay test
  fails on any one-sided edit. `sub()` is literal-safe now; keep markers unique
  to their patch bodies.
- New env vars: `HARNESS_WAIT_TOKEN` (sentinel provenance), `HARNESS_WAIT_MODE=exit`
  + `HARNESS_WAKE_FILE` (scheduler mode), `HARNESS_DEATH_CONFIRM_SECONDS`,
  `PRIME_AGENT_TRACES=1` (opt back into trace upload), `HARNESS_VENDOR_DIR`
  (patcher retarget, test-only).
