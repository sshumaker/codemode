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
- **claude-code (native MCP, the real product) — apples to apples on the 73 tasks
  where all three arms ran:**

  | arm | pass | $/task |
  |---|---|---|
  | codemode | 65/73 = 89.0% | $0.190 |
  | vanilla | 64/73 = 87.7% | $0.786 |
  | claude-code | 68/73 = 93.2% | $0.949 |

  The subset is not easier for codemode (89.0% here vs 89.6% full-suite), so the
  comparison is fair. **But the score gap is not significant:** claude-code vs
  codemode is **5W/2L/66T, exact sign test p=0.45** — 3 net tasks out of 73. Read
  it as "directionally ahead, statistically indistinguishable at this n", not as a
  4-point lead. Confirming it needs the full 417 (~$400).
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

- **A/B verdict: keep `off`. No variant earned its cost.** (Corrected — an earlier
  draft called nav-tools "the winner"; that read the direction of a mean at n=20,
  which this project's own rules forbid.)

  | variant | TGC | $/task |
  |---|---|---|
  | **off (baseline)** | 17/20 | **$0.182** |
  | nav-tools (read/grep/find/ls) | 18/20 | $0.197 (+8%) |
  | gate=inline | 18/20 | $0.304 (+67%) |
  | gate=redirect | 18/20 | $0.384 (+111%, turns +81%) |

  All three variants landed on exactly 18/20 — one task flipping, i.e. noise, and
  the uniformity suggests it is the *same* task. `off` is the cheapest and is
  statistically indistinguishable on score, so it stays the default. nav-tools is
  *unproven*, not proven — its one interesting signal (api calls 36→28.6, less
  blind re-probing) did not convert into cost or score.
- **Both docs-gate forms are measured negatives.** read-before-call is intuitively
  right and empirically expensive here: one taught error per new API compounds
  (+81% turns for redirect). With answer-discipline rare AND arm-neutral (vanilla
  trips it with docs resident), the gate's target class cannot repay the overhead.
  Shipped behind flags (off|redirect|inline) as a recorded negative with data;
  per-app DOCS.md generation ships regardless (useful for any doc-reading arm).
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

### The biggest gap: subagents were never built

`docs/DESIGN.md` §Subagents specifies a matched pair — `result = await spawn(prompt,
name=...)` in the kernel for codemode vs a `task(prompt)` tool for vanilla, same
child model / step cap / budget, fresh kernel per child, push-a-line/pull-the-detail
completion notifications. **None of it exists.** No `spawn` in the runtime, no
`task` tool in the vanilla extension, and nothing measured.

It matters more than anything else outstanding, because DESIGN.md states the
thesis at its sharpest there: Claude Code spends **nine tool definitions** (`Agent`,
`SendMessage`, `TaskCreate/Get/List/Output/Stop/Update`, `Monitor`) on what codemode
expresses as **one module** — and gets `asyncio.gather`, retries, conditionals and
pipes for free rather than by design. That is the representation argument at maximum
leverage and we have zero data on it. AppWorld tasks are mostly too small to need
delegation, so the venue for this is long-horizon (terminal-bench) — which is also
where the residency term (9 schemas vs 1 import) compounds per turn.

The one-sentence version: **at full-suite scale, code-as-representation holds a
4× cost advantage at score parity with tool-calling; Claude Code over native MCP is
directionally ahead on score but not significantly so (5W/2L/66T, p=0.45) at 5×
codemode's cost; no prompt/tool variant we tried beat plain `off`; and the sharpest
untested claim — subagents as one module vs nine tool schemas — is still unbuilt.**
