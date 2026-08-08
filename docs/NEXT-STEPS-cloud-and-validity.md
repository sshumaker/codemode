# Next steps: benchmark validity and the cloud design

Written 2026-08-08. Scope: two questions that came out of reviewing the results —
(1) what MCP-Bench can and cannot establish, and (2) what it would take to run
codemode as a hosted service. Nothing here has been implemented; several items
are answerable offline from runs already on disk.

This file is deliberately separate from `FINDINGS.md` (measured results) and
`DESIGN.md` (the experiment design). Fold anything that graduates into those.

---

## Part 1 — MCP-Bench is a sanity check, not an agency benchmark

Verified against `vendor/mcp-bench`, not from memory.

### What it genuinely tests

Multi-step tool orchestration under distraction, with real dependency structure.
Across all 104 tasks: 60 describe sequential chains, 80 describe parallelizable
branches, ~72 contain conditional logic. Representative `dependency_analysis`:

> `search-models` → model_id list → `get-model-info` → BLEU scores → *decision
> point* → arXiv `search` → `download` → `read_paper` … Wikipedia enrichment runs
> parallel to metric validation, both converge into the final report.

Tasks carry real branches ("if none of the search operations support pagination,
re-use `getApiOverview` and check the `list` endpoints instead"), `fuzzy_description`
never names a tool, and ~10 distraction servers load alongside each task.
Measured turn counts confirm it is multi-step: vanilla 12.8 turns / 22.7 MCP calls,
codemode 32.4 / 49.7. (MCP-Bench's own reference agent caps at
`max_execution_rounds: 20` — that governs their runner, not ours.)

### What it does not test

| dimension | MCP-Bench | benchmark that would |
|---|---|---|
| interaction | one prompt in, one synthesized answer out; no user simulator, no clarification, no follow-up | τ-bench |
| side effects | **all 28 servers are read-only** (Wikipedia, arXiv, HF, NASA, Met Museum, weather, market data) | AppWorld, τ-bench |
| ground truth | 6-dimension LLM rubric; no verifiable world state | SWE-bench (tests), AppWorld (unit-checked state) |
| horizon | ~20 rounds, minutes | long-running / multi-session |
| failure recovery | nothing adversarial, no injected faults | — |
| grading | proportional partial credit ("7/10 steps scores like 14/20") | pass/fail |

Judge dimensions (`benchmark/evaluator.py`): Task Fulfillment, Grounding, Tool
Appropriateness, Parameter Accuracy, Dependency Awareness, Parallelism & Efficiency.
Nothing scores *acting correctly in a world that can be damaged*. The cost of a
wrong call is a wasted call.

### Three consequences for the result

**1. Well-matched to Claim 1, only partly to Claim 2.** The mechanism caught in the
wild — a 182,433-char payload bound to a variable and sliced to 3,552 tokens — is a
*data-volume* advantage, and MCP-Bench surfaces it well. CodeAct's deeper claim is
about code as a *control-flow* representation: loops, retries, conditional recovery.
MCP-Bench has conditionals but no failures to recover from, so the half of Claim 2
with the strongest published support is the half it exercises least.

**2. ~~The rubric is structurally kind to codemode.~~ MEASURED AND FALSE — see the
attribution table below. Retained for the record.** "Parallelism and Efficiency"
rewards batching — that is `asyncio.gather`. "Grounding" rewards claims traceable to
tool output — codemode makes 2.2x the calls. Meanwhile the measured failure mode
(48% of cells make no tool call; 45% of context is reprinted local variables) is
**invisible to the judge**. The +0.50 score delta may be partly a rubric artifact.

**3. The predicted loss is untestable here.** The early prediction was that codemode
*loses* on policy compliance, because code routes around guardrails encoded at tool
boundaries. With zero writes across all 28 servers there are no guardrails to bypass.
The sharpest falsifiable prediction of the thesis cannot be evaluated on this benchmark.

### Action items

- [x] **Attribute the score delta by subdimension** — DONE, and it refutes the
      hypothesis. Over 16 paired tasks from the clean sweep (codemode - vanilla,
      0-1 scale):

      | dimension | vanilla | codemode | delta | t |
      |---|---|---|---|---|
      | task_fulfillment | 0.319 | 0.423 | **+0.104** | **+3.04** |
      | grounding | 0.481 | 0.581 | +0.100 | +1.92 |
      | dependency_awareness | 0.371 | 0.450 | **+0.079** | **+2.73** |
      | tool_appropriateness | 0.515 | 0.552 | +0.038 | +1.67 |
      | parameter_accuracy | 0.575 | 0.590 | +0.014 | +0.39 |
      | parallelism_and_efficiency | 0.354 | 0.354 | **+0.000** | **+0.01** |
      | OVERALL | 0.436 | 0.492 | +0.056 | |

      The suspected artifact is **exactly zero**. Parallelism — the dimension
      `asyncio.gather` was supposed to farm — shows no difference at all, and
      grounding is only borderline. The delta is carried by task fulfillment and
      dependency awareness, i.e. codemode completing more of the task. Section
      "2. The rubric is structurally kind to codemode" should be struck.
- [ ] **Promote τ-bench to the next target.** Writes, a simulated user, and policy
      compliance as the score — it tests the opposite capability and is where the
      thesis was predicted to break. Worth more than additional MCP-Bench tasks.
- [ ] Restate MCP-Bench's role in `FINDINGS.md` as a sanity check on tool
      orchestration under context pressure, not as evidence about agency.

---

## Part 2 — Running codemode in the cloud

Grounded in Anthropic's [Managed Agents engineering post](https://www.anthropic.com/engineering/managed-agents)
and the [platform docs](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes).

### The collision

Managed Agents splits brain from hands. The harness is stateless and calls sandboxes
through `execute(name, input) → string`. The session is a durable append-only event
log *outside* the context window (`emitEvent` / `getSession` / `getEvents`). Sandboxes
are provisioned on demand, and **a dead container is just a tool-call error** — Claude
sees a normal failure and retries against a fresh one. Scaling to many brains is
"starting many stateless harnesses, and connecting them to hands only if needed."
That decoupling produced p50 TTFT −60% / p95 −90%, because inference stopped waiting
on provisioning.

The load-bearing sentence: **"State persists in the session log, not within sandboxes,
enabling stateless sandbox handling."** The API docs hedge the in-memory guarantee
precisely — the shell keeps cwd, env, and background processes ***while a single
runner is alive***. Durable = event log + disk. RAM = best effort.

Codemode inverts this. It relocates context from the transcript into a kernel
namespace, which makes the sandbox load-bearing state — exactly the thing the
architecture scales by assuming it isn't.

So the cloud question is not "how do I host a REPL." It is: **can codemode's state be
projected into the session log, so the sandbox goes back to being disposable?**

### Why blob-handles alone don't work

First idea was to intercept at ingress (`api/*/_client.py`) and bind large tool
results as lazy content-addressed handles rather than Python objects. That is still
worth doing, but it solves only the easy fraction. The moment the agent writes:

```python
issues = await linear.list_issues(...)                 # handle — fine
urgent = [i for i in issues if i["priority"] == 1]     # both claims die here
```

…iteration **forces materialization** (the full payload lands in the heap), and
`urgent` is a top-level binding with **no content address** — nothing produced it but
a cell of Python. And this is the main case, not an edge case: cell classification appeared to be
45.2% local compute, 39.8% variable inspection, **6.8% actual tool calls**.

**That 6.8% is a measurement artifact and the argument above depends on it.** The
classifier matched a literal `api.`, but the model imports under aliases
(`import api.reddit as reddit`), which hid 1,090 of 4,576 cells. Recounted on
`await` presence: **38.6% of cells make tool calls, not 6.8%** — so pure local
compute is ~61%, not 93%.

The lineage design survives but the ratio is less favourable than stated: replay
touches tool calls in nearly two cells in five, so it leans much harder on ingress
memoization being complete, and the effectful-derived row of the recovery
taxonomy is correspondingly larger than a read-only benchmark can reveal.

### The design: store the recipe, not the value

`urgent` is a pure function of `issues` and the cell text, and `issues` *is* content
addressed. So every top-level binding gets a provenance entry:

```
issues  ← ingress(linear.list_issues, args)      → blake3:abc…
urgent  ← derive(cell_7, inputs={issues: blake3:abc…})
```

The namespace becomes a Merkle DAG of recipes. On kernel loss: rehydrate `issues`
from its blob, re-run cell 7, `urgent` is back. This is Spark RDD lineage —
checkpoint the derivation, recompute on loss, materialize selectively where recompute
is expensive.

The ratio is unusually favorable, and our own traces say so: the expensive part (tool
calls) is already memoized at ingress, and the recomputed part is the ~61% of cells
that make no tool call (corrected from 93% — see above). Most lineage systems have
the opposite problem, but the margin here is thinner than first claimed.

Better framing than snapshotting RAM: **the session log already contains the program
that rebuilds the namespace** — cells are events. The work is making that replay cheap
and verifiable.

### Recovery taxonomy

| binding kind | recovery | example |
|---|---|---|
| ingress leaf | blob hash, immutable | `issues` |
| pure derived | recompute from lineage | `urgent` |
| effectful derived | replay against logged tool results | value built from a `create_issue` |
| external handle | rebind to durable ID | `spawn()` child |
| opaque | **lost — tell the model** | live socket, open file, C object |

Only the last row is unrecoverable, and it shrinks by design (subagents → durable
session IDs; files → sandbox disk, which Managed Agents already persists).

### Determinism

Recompute needs cells to be reproducible. Real hazards are narrow: `set` iteration
order (CPython randomizes `str` hashing — pin `PYTHONHASHSEED=0`), `time` / `random` /
`id()`, and network. **The egress block added for fairness already kills the last
one** — the third time a fairness control turns out to be load-bearing for durability
(the others: removing bash, and the dollar budget).

Guaranteed determinism isn't required, only *detected* nondeterminism: digest each
binding at cell exit, compare on replay, fall back to an honest reset notice on
mismatch.

### Residency

With a reconstruction path for every binding, eviction becomes a cache policy over the
DAG — evict by `size × recency ÷ recompute_cost`. A comprehension is cheap to rebuild,
so drop it freely; a binding that took 40 tool calls to build gets materialized and
pinned. This is `persist()`, and it is the honest version of the "hook into GC"
instinct: not a GC hook (CPython refcounts; the cycle collector never sees a large
string, and by GC time you are serializing arbitrary graphs including sockets), but a
**cache with a recompute path**, evaluated at cell boundaries — the only moment the
interpreter is quiescent and the model cannot observe the swap.

Tiering, if still needed after the above:

| tier | for | mechanism |
|---|---|---|
| hot | mid-task, idle 5–30s | resident; overcommit hard |
| warm | idle minutes, node drains | VM snapshot → local NVMe, UFFD lazy page-in (~100ms restore) |
| cold | human walked away | snapshot → object store; node-agnostic |
| expired | older | event log only; rebuild via lineage |

Two properties make this cheap. **The duty cycle is extreme**: 323s wall over 32.4
turns ≈ 10s/turn, MCP latency 563s across 756 calls ≈ 0.74s/call, 93% of cells are
local compute — kernel-busy is roughly 5–10% of wall clock. And **restore latency is
free**: the model streams the cell 5–30s before it can execute, so a restore kicked
off at generation-start is warm before the `tool_use` block closes. (This is the
inverse of Anthropic's optimization — they decoupled so provisioning left the critical
path; our kernel *is* the critical path, so we hide it behind inference instead.)

On swap: works, NVMe makes it non-crazy, but it is the wrong control surface — you
don't choose what pages out, can't migrate paged-out state to another node, and a cell
touching a cold 180KB string stalls mid-turn, which the model experiences as a hung
tool. Keep swap as an OOM backstop, not as the design.

### Subagents

`spawn()` returning a Popen handle is the piece that translates worst: the handle is a
PID in a namespace that can vanish independently of the child (already flagged locally
— a kernel reset orphans a child that keeps burning tokens).

Keep the sugar, change the referent: the handle's identity becomes a **durable session
ID in the control plane**, not a PID. `.send()` is an event POST, `.stop()` an
interrupt event, `.result()` a stream. The pretraining argument survives because what
is attested is the *shape*, not the syscall. Children then outlive parent kernel
death, re-attach is a lookup, fan-out is scheduling rather than `fork()`, and budgets
are enforceable across the tree — which closes the unbounded-spend hole where
`--autonomous-max-*` is per-process, not per-tree.

This is Managed Agents' own session model, recursively. Their budget design converged
on the same control we did: a hard list-cost ceiling enforced between model requests.

### Pyodide

The attractive property is real — the whole heap is one linear `ArrayBuffer`, so
snapshot is a memcpy and migration is shipping bytes, with no CRIU/UFFD and thousands
per node. It remains disqualified for *this* workload by our own measurement: no
subprocess means no `%%bash`, and Sonnet reached for `%%bash` on both smoke tests and
ran the identical shell command vanilla ran.

The right response is to steal the property without the runtime: small namespace +
content-addressed blobs + lineage manufactures most of Pyodide's snapshot-ability
inside real CPython while keeping bash and real wheels. Pyodide stays interesting as a
*different product* (browser/edge-resident codemode, no server sandbox), testable on
this rig as a runtime variant scored the same way.

### Correction to an earlier estimate

An earlier version of this argument claimed handles shrink the resident namespace
50–100x. That was wrong, for the materialization reason above. Realistic estimate:
a 182KB JSON payload parses to ~3–5x in Python objects; a few of those plus derived
copies puts a live session near 100–300MB RSS against a ~20MB interpreter baseline —
call it 3–5x from handles, not 50–100x. The win moves from "shrink the heap" to
"make any part of the heap reconstructible." Replace this estimate with the measured
number from the first action item below.

---

## Part 3 — Ordered next steps

Free (offline, over runs already on disk — no new spend, no new runs):

1. **Binding taxonomy census.** Across the 573 recorded cells, classify every live
   top-level binding into the five recovery rows above, weighted by bytes. This is the
   decision point: ≥90% of resident bytes in the ingress-leaf or pure-derived rows
   means lineage recovery works and the sandbox stays reconstructible — codemode fits
   the architecture that already scales. A material opaque row means it doesn't, and
   the cloud version needs a stateful fleet with real snapshotting.
   *Caveat to record with the result:* MCP-Bench is read-only, so the effectful-derived
   and opaque rows are structurally under-represented. This census is a best case.
2. **Residency profile.** Per turn, naive resident bytes vs bytes with >8KB values as
   handles. Replaces the corrected estimate above with a measurement.
3. **Duty cycle.** From event timestamps: kernel-busy seconds / wall seconds, plus the
   idle-gap distribution (expected bimodal — intra-turn vs human-in-the-loop). Sets
   tier boundaries and the overcommit ratio; turns this from architecture into a
   capacity model.
4. **Score attribution by judge subdimension** (Part 1). Cheap, and it may restate the
   headline.

Costs money / needs runs:

5. **Handle prototype as a runtime variant**, A/B'd on score via
   `npm run iterate -- --variants … --judge`. It changes the object model the agent
   writes against, so it can hurt. ~8 minutes per comparison on the current loop.
6. **τ-bench adapter.** The benchmark that tests what MCP-Bench structurally cannot.

Steps 1–4 materially de-risk 5 and 6 and cost nothing.

---

## Sources

- [Managed Agents engineering post](https://www.anthropic.com/engineering/managed-agents)
- [Self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
- [Cloud sandbox reference](https://platform.claude.com/docs/en/managed-agents/cloud-sandboxes-reference)
- [Environments](https://platform.claude.com/docs/en/managed-agents/environments) · [Sessions](https://platform.claude.com/docs/en/managed-agents/sessions)
- `vendor/mcp-bench/benchmark/evaluator.py` (judge dimensions), `vendor/mcp-bench/tasks/*runner_format.json` (task structure), `vendor/mcp-bench/config/benchmark_config.yaml`
