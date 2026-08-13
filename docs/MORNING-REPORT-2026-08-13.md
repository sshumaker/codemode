# Morning report — AppWorld full-suite 3-arm ramp (2026-08-13)

Overnight goal: ramp to AppWorld's entire challenge suite, fix harness issues along
the way, diagnose codemode's weak spots vs vanilla and Claude Code.
**The full 417-task suite ran to completion on both prime arms, zero harness errors.**

## 1. Overall perf vs vanilla and Claude Code

Homogeneous configs (codemode L0/a1, vanilla L4/b1, claude-code L4/c1), Opus 5:

| arm | n | pass | $/task | total spend |
|---|---|---|---|---|
| **codemode** | 444 | **89.6%** | **$0.208** | $92.55 |
| **vanilla** | 432 | 89.4% | $0.826 | $356.69 |
| **claude-code** | 74 (subset) | 93.2% | $0.958 | $70.86 |

- **codemode vs vanilla (the full-suite pair, n=432):** score is dead even —
  TGC 22W / 21L / 389T. Cost is decisively codemode: **−$0.618/task, t=−25.8**,
  i.e. codemode does the same work at **4.0× lower cost**. The MCP-vs-APIs cost
  decomposition replicates at full-suite scale.
- **claude-code (native MCP, the real product), on its 74-task paired subset:**
  93.2% vs codemode's 89.5% and vanilla's 88.2% *on the same subset* — the best
  score of the three arms, at 4.6× codemode's cost. Caveat: subset (seeds 42/43/44),
  not the full suite; the ~4-point gap is n≈74 and unconfirmed by a full run.
- Turns: codemode ~12 (one code block/turn), vanilla ~10, cc ~10. codemode makes
  ~2× the raw API calls (loops are cheap in code) but each costs far less context.

**Thesis verdict so far:** representation (code vs tool-calls) buys a 4× cost
advantage at score parity with an identically-provisioned tool-calling arm. The
real product (Claude Code over native MCP) currently buys ~4 points of score over
both prime arms on the measured subset — worth running to full suite to confirm.

## 2. Where codemode had issues (all trace-diagnosed, /diagnose-run-fail)

- **Answer-discipline** (complete_task with a volunteered/misformed answer):
  n=2 across 508 runs — and it is **arm-neutral**: vanilla tripped it with the
  docstring fully resident (`answer:"yes"` on a null-answer task). Trigger is the
  instruction's question-like surface form, not doc residency. My initial
  residency-based diagnosis was wrong; the trace triage corrected it.
- **Ignore-list asymmetry cleanup** (6d59d90_3): codemode preserved the user's
  pre-existing cart items by moving them to the wishlist before ordering —
  semantically defensible, but WishListEntry isn't on the grader's ignore-list
  while CartEntry is. Part benchmark strictness, part scope discipline.
- **Cross-cell re-fetching** (953b296_1): re-ran a fetch loop for data already
  held in kernel variables (34 duplicate calls). Cost-only (task passed) but the
  clearest "call-cost blindness inside code" instance.
- Vanilla's own failure modes were symmetric in batch 3 (4 vanilla-only vs 1
  codemode-only); full triage in docs/BATCH3-TRIAGE.md.

## 3. What we did about them

- **Nav-tools variant — the winner, recommended default going forward:** give
  codemode read/grep/find/ls alongside ipython (never bash — one-transport
  invariant). A/B on 20 paired tasks: +1 TGC, api calls 36→28.6, **+8% cost**.
- **Docs-gate (read-before-call) — built both forms, measured negative:**
  redirect-to-DOCS.md doubles cost (+111%, turns +81%); inline docstring-in-error
  +67%. With answer-discipline rare and arm-neutral, the gate can't repay its
  overhead on this distribution. Shipped behind flags (off|redirect|inline),
  kept as a recorded negative with data. Per-app DOCS.md generation ships (useful
  with nav-tools regardless).
- **claude-code arm built and verified honest:** AppWorld's native MCP server +
  recording reverse proxy, so env-calls.jsonl exists for all three arms; verified
  from the trace: 36/36 calls MCP-only, zero bash bypass; null control fails (no
  state leaks); ctx0 ~105k confirms real L4 residency. 12 fairness invariants as
  executed tests.
- **Harness fixes along the way:** appworld venv was missing the [mcp] extra
  (installed); `/diagnose-run-fail` skill added (.claude/skills, local) encoding
  trace-first triage; 289/289 JS tests green (suite grew from 141).

## 4. Where we stand

- **Done:** full 417 both prime arms; 74-task 3-arm paired subset; variant A/B
  with a winner (nav-tools) and two honest negatives (gates); failure taxonomy
  with trace citations; all work committed on scott/jobs-runtime.
- **Not done / next:** (a) claude-code on the full 417 (~$400 at $0.96/task) to
  confirm its score edge; (b) adopt nav-tools as codemode default + rerun the
  76-task subset for a confirmed config; (c) terminal-bench 3-arm long-horizon
  (#26) — not run overnight, AppWorld took the budget; (d) study WHY cc scores
  higher on the subset (read its wins' traces vs codemode's losses — top of my
  list, trace-first this time).
- **Spend:** ~$520 total across all overnight runs (codemode $93 + vanilla $357 +
  cc $71), within the "$400+" envelope with the full-suite goal explicitly set.

The one-sentence version: **at full-suite scale, code-as-representation holds a
4× cost advantage at score parity with tool-calling; the real Claude Code product
scores ~4 points higher on the measured subset at 4.6× codemode's cost — and
whether that gap survives the full suite is the next question worth $400.**
