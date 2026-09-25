# MCP-Bench defect #5: timed-out runs are scored as if they had answered

**Status: diagnosed, not fixed.** Found 2026-08-31 while diagnosing three
"genuine signal" traces from the lab queue — two of the three turned out to be
this. Read-only; nothing changed.

## The defect

`bench/run-task.mjs` SIGKILLs a run at a wall-clock deadline and records
`stopReason: "timeout"`, `timedOut: true`. The run is then **judged and ingested
like any completed run.** The agent never got a turn in which to write an answer,
so the judge scores the absence of a deliverable as a bad deliverable.

**The harness already has the right behaviour for the neighbouring cases and
simply does not apply it here:**

| `stopReason` | runs | scored? |
|---|---|---|
| `completed` | 946 | 808 ✔ |
| **`timeout`** | **31** | **30 — scored anyway** |
| `budget` | 23 | 0 — correctly excluded |
| `refused` | 4 | 0 — correctly excluded |

`budget` and `refused` are excluded. `timeout` is not. That asymmetry is the whole
bug, and it makes this a small fix rather than a design question.

## Signature: fulfilment and grounding floor, tool metrics barely move

| criterion | timed out | completed | delta |
|---|---|---|---|
| task_fulfillment | 1.79 | 5.78 | **−3.99** |
| grounding | 1.97 | 7.30 | **−5.33** |
| tool_appropriateness | 5.48 | 6.89 | −1.41 |
| parameter_accuracy | 5.81 | 7.37 | −1.55 |
| **overall** | **3.55** | **6.26** | −2.71 |

The tool use is fine because the tool use *happened*. Fulfilment and grounding
floor because there is nothing to fulfil or ground. **A run showing floored
fulfilment+grounding beside mid-high tool metrics should be checked for
`timedOut` before any other diagnosis.**

## Mechanism, verified across all 31

`summary.finalText` is a mid-work fragment or empty in **29 of 31** timed-out runs,
against 26 of 946 completed runs — a 34× rate difference. Samples:

```
len=   0  quick__reddit_001__codemode__q3__r1__…                ''
len=  20  paper_search_call_for_papers_wikipedia_002__codemode…  'Now the conferences.'
len=  23  quick__reddit_001__codemode__q2__r4__…                 'Let me retry this call.'
len=  43  hugging_face_paper_search_001__codemode__L0__q9__…     "I'll start by exploring the available APIs."
```

Worked example — `wikipedia_paper_search_003__codemode__L0__q9__opus-5`:

```json
{"turns": 29, "toolCalls": 29, "toolErrors": 0, "cost": 0.98,
 "wallMs": 1800018, "timedOut": true, "stopReason": "timeout",
 "finalText": "Wikipedia article **does** contain clinical applications/trials
               content — so I'll pivot to recent clinical trial literature."}
```

29 tool calls, **zero tool errors**, $0.98 spent, killed at exactly 1,800,000 ms.
Scored `task_fulfillment 1.0 / grounding 2.33`. The judge is not wrong — it scored
what it was given. The harness gave it a decapitated run.

The deadline is **not uniform**: `wallMs` on timed-out runs ranges 300,008 to
1,800,019 (5 to 30 minutes, median 10). So the cap varies by invocation, and which
runs get decapitated depends on how they were launched rather than on anything
about the arm.

## This one does NOT reverse under the within-task check

Every cluster in `MCPBENCH-INSTRUMENT-SCAN.md` reversed sign when restricted to
tasks containing both groups, because "affected" selected for runs that engaged.
**This one does not:**

| | value |
|---|---|
| tasks with both timed-out and completed runs | 10 |
| mean within-task delta | **−2.35** |
| median within-task delta | −2.39 |
| tasks where the timed-out run scored lower | **10/10** |

The penalty is real, and the mechanism is direct rather than selectional: the
process was killed before it could write an answer, and `finalText` proves the
answer is absent. This is the one place today where a naive affected-vs-clean
comparison happens to be right — and it is right for a reason that had to be
checked, not assumed.

## Contamination

- **30 scored runs (3.7% of the 808-run scored corpus)** are decapitated runs scored as answers, dragging their tasks' means down by ~2.4 points each.
- **58 runs (5.8% of 1,004)** did not complete normally; 28 of those are correctly excluded already.
- Concentrated in codemode (the arm that takes more turns) and in multi-server research tasks, so it is **not arm-neutral** — which matters, because it biases exactly the comparison the campaign cares about, in codemode's disfavour.

## Fix

One line, in the same place the other two exclusions live: treat `timeout` like
`budget` and `refused` — do not ingest for scoring, or ingest with an
`incomplete` flag the report excludes. Then re-derive any affected task mean.

**Do not "fix" it by raising the deadline.** The deadline is a legitimate cost
control; scoring a killed run is the defect. Raising it would convert a scoring
error into a spend increase and leave the asymmetry in place.

As with the other four, applying this changes the instrument mid-campaign: the 30
runs' scores would change, so pre- and post-fix populations cannot be pooled.
Scott's call.
