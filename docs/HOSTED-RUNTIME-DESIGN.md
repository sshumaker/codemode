# Hosted runtime design — kernel lifetime, jobs, and waiting

Referenced from `TAC-HANDOFF.md` §5, which holds the same conclusions in compressed
form plus the trace evidence. This file is the longer working-out: why the
primitives are shaped the way they are, what was measured, and what was got wrong
on the way.

Nothing here is implemented. Session `b29a3a9b-…`, 2026-08-08/09.

---

## 1. The organising rule

**Durability is a property of crossing the boundary, not of duration.**

The harness can only suspend, resume, or recover work at a boundary it sits in.
Everything else is opaque to it, permanently, by construction.

| mediated — suspendable, recoverable | internal — opaque |
|---|---|
| api `Call` (through the MCP proxy) | agent-defined coroutines |
| `submit`ted work (control plane) | local compute |
| `watch` on service state | `asyncio.sleep` in the agent's own loop |
| service HTTP (via the §4.1 egress proxy) | threads, held frames |
| subagent sessions | anything the harness isn't in the path of |

Two consequences that drive everything below:

- Agent code can never be made durable **in place** — only moved across the
  boundary (into a file, referenced by path) or interrupted.
- Conversely, if every wait the agent might want is available as a
  boundary-crossing primitive, it never has a reason to write a local wait loop.
  **Removing the reason beats policing the behaviour.**

This is also why *borrow the shape, refuse the type* (§5) is load-bearing rather
than stylistic: a `Call` and an agent-written `async def` are the **same shape with
opposite durability**. Accept any awaitable and the model picks between them by
accident.

---

## 2. Lifetimes

The kernel should be the **shortest-lived** thing in the system. Long-horizon work
is a property of the session record, not of any running process.

```
session   days–weeks    durable, event-log-backed     ← long-horizon lives here
jobs      min–hours     independent lifetime, parented to the session
kernel    seconds–min   disposable
files     forever       what crosses all three
```

This is the line both reference architectures already draw. Managed Agents:
*"state persists in the session log, not within sandboxes, enabling stateless
sandbox handling"* — and the in-memory guarantee is hedged precisely, the shell
keeps cwd/env/background processes ***while a single runner is alive***. Claude
Code: working directory persists between Bash calls, shell state does not.
Prime's forever-kernel is the outlier.

### Suspension

`await` gives the syntax for free but suspends the *coroutine*, not the process —
the frame stays on the heap, and it cannot be serialised out (verified:
`cannot pickle 'coroutine' object`, same for generators). So at the language
level a paused cell cannot be moved.

Snapshot **below** the language instead. A microVM snapshot doesn't care that
there's a coroutine mid-`await`; the frame is just pages. That converts a
40-minute wait from 40 minutes of RAM into 40 minutes of NVMe — ~2 orders of
magnitude cheaper, and **zero cooperation required from the model**.

Safe only for mediated awaits: completion arrives from the control plane and the
future is re-established on restore. An `await` on a raw socket resumes into an
error. Another argument for routing every wait through the proxy.

```
await pending
  ├─ resolves < ~30s        → hold hot
  ├─ still pending at 30s   → snapshot to local NVMe, release RAM
  └─ still pending at ~1h   → push to object store, release the node
```

Restore hides behind the completion event, the same way it hides behind inference
on ordinary turns. Past roughly a day, prefer that the agent structured the work
across turns — snapshots go stale against runtime upgrades and pin architecture.

Swap is an OOM backstop, not a design: you don't choose what pages out, can't
migrate it, and a cell touching a cold 180KB string stalls mid-turn, which the
model experiences as a hung tool.

---

## 3. `Call` — coroutine-shaped, not a coroutine

Generated api functions should return a deferred `Call` object, not a coroutine.

```python
class Call:                    # lives in api/_call.py — importable, not REPL-defined
    def __init__(self, fn, *args, **kw): ...
    def __await__(self):  ...  # executes in-process via the proxy
```

Verified behaviour:

```
picklable            : Call('api.arxiv.fetch_fulltext', ('http://x/1',))
await works          : yes
asyncio.gather works : yes
picklable AFTER await: yes
```

Why this matters:

- **The call site is identical regardless of consumption.**
  `await c` (in-process) and `submit(c)` (durable) take the same expression.
- `submit` takes one argument rather than `(fn, *args)`, and the batch may be
  **heterogeneous** — `submit([arxiv.fetch(u), wiki.summary(t), oe.overview(s)])`
  is strictly more expressive than `Executor.map`.
- **The `Call` *is* the effect key.** `(fn, args)` content-hashed is exactly what
  a partially-completed batch is memoised on for reconstruction.

**It is already what the model assumes.** Across 7,902 api calls in the corpus,
genuinely unconsumed calls ≈ **0**, and the dominant staging idiom is:

```python
tasks.append(reddit.fetch_reddit_post_content(post_id=pid, comment_limit=8))
...
results = await asyncio.gather(*tasks)
```

That code *only works* because the returned object is inert — a value you stash in
a list and consume later. The model named them `*_task` unprompted. Swapping
coroutine → `Call` is invisible to code it already writes.

Caveats, each of which should error loudly at the point of the mistake:

- `Call` must live in a real module. A class defined in a cell pickles as
  `__main__.Call` and won't resolve in a worker.
- Arguments must pickle. Fail at `submit`, naming the offending argument.
- An unconsumed `Call` does nothing, silently — the same situation as an
  un-awaited coroutine, which CPython warns about at GC. Replicate that
  (`Call.__del__`) and surface unconsumed calls in the manifest. Insurance, not
  load-bearing, given the measured rate.
- Re-awaiting currently re-calls. Borrow the shape, borrow the error: **raise on
  re-await.** A model that re-awaits meant to reuse the result.

---

## 4. Surface

```python
# WATCH — the primary wait. 83% of observed waits (§10). Nothing to submit:
#   the agent sent a message and needs the reply.
inbox = watch(rc.messages("#project-x", since="now"))    # declarative, no user code
rc.send_message("#project-x", "confirm Friday 2pm?")
#   ...then STOP → woken on arrival → inbox.new is a DELTA

# SUBMIT — work that outlives the kernel. 9% of observed waits: builds, servers.
batch = submit(calls, name="fulltext", max_runtime="1h") # one handle over N items
run("gradle build", name="build")                        # shell form — see §10

# CALL — in-kernel, unchanged
texts = await arxiv.fetch_fulltext(url)                  # ceiling applies
rows  = await asyncio.gather(*calls)

wait(batch, wake_after=1800)                             # the only thing quiescence can't say
job("fulltext"); jobs(); kill(batch)
```

Verbs: `watch`, `submit`/`run`, `wait`, `job`/`jobs`, `kill`. Everything else is
`await`, which the cells already use, and stopping, which the agent already does.

**`watch` must be declarative — it cannot take a user-supplied predicate.** The
traces show why: the polling the agent actually wrote closes over cell-local state
*and* a cell-defined helper —

```python
def poll():
    for i in range(60):
        time.sleep(20)
        state['e'] = hist2('CZYW...')      # captures state AND hist2
threading.Thread(target=poll, daemon=True).start()
```

`hist2` is defined in a cell, so the file-path escape hatch ("write the handler to
`work/poll.py`") doesn't rescue this case — the agent would have to relocate its
helper too, and it won't. A predicate parameter would reconstruct exactly this.
So the condition has to be something the control plane can evaluate on its own:
message-arrival, job status, file existence, an HTTP probe. Small set, and it
covers every wait observed.

### Jobs are NOT awaitable

`await submit(...)` must raise. The measured reason is that this agent awaits in
**bulk**: `asyncio.gather` appears in 1,934 of 10,245 cells (18.9%), and
`create_task` in zero. Hand it awaitable handles and the natural thing to write is

```python
results = await asyncio.gather(*[submit(c) for c in calls])
```

— durable out-of-process jobs, consumed synchronously, in one blocking cell. Same
class as `threading.Thread` in the traces: an in-distribution construct that
silently imports in-process liveness. Same treatment (§5): block it and error with
the correct pattern.

```
TypeError: jobs are not awaitable — they outlive this kernel.
           End your turn and you'll be woken, or wait(batch, wake_after=1800).
```

Promotion therefore goes **one way only**: a long `await call` can be refused
upward toward `submit`; a `submit` can never be awaited downward into a block.

### Implicit suspend at quiescence

Default: a session with live control-plane records **suspends** rather than
terminates when the agent stops. Wake when *nothing* is pending — not per job,
which would give N wakes, N turns and fragmentary state for N jobs.

> **Stopping means you're blocked. Being woken means you're unblocked.**

That's a behaviour the model already has rather than an API it must learn, and it
means the common case needs no verb. `wait()` exists for exactly one thing
quiescence can't express: **a deadline on the agent's attention rather than on the
work.**

*First of N* and *this or that* were in an earlier draft and are cut — see §13.
Nothing in the corpus asks for them: across 10,245 cells, `asyncio.wait(` /
`FIRST_COMPLETED` / `as_completed` / `.cancel()` are each used **zero** times,
against 1,934 uses of `gather`. They also convert one wake into N.

Edge: the agent may stop because it is **finished** and doesn't care about a job
it left running. Suspend only when its final message isn't a terminal answer;
otherwise terminate and reap the tree.

### Where the timeouts live

§5's split, kept intact:

| | where | about |
|---|---|---|
| `max_runtime=` | `submit` | the **work** — exceed it and the work is killed |
| `wake_after=` | `wait` | the **agent's attention** — work continues |
| `kill()` | explicit | ending the work deliberately |

`wake_after` does **not** belong on `submit`; putting it there re-fuses attention
with work-lifetime, which is what the split exists to prevent. And the verb is
`wait`, not `wait_for` — `asyncio.wait_for` cancels on timeout and this doesn't.

Enforce a **floor** on `wake_after`. Re-arm is polling at turn granularity, and at
~$0.012/turn the same mechanism spans two orders of magnitude: re-armed every
5 min over 40 min ≈ $0.10 (fine); every 30s ≈ $0.95, five times the cost of the
whole task. 60s is the natural floor — the same measured line as the ceiling.
The manifest should show re-arm count, because a loop that is individually
reasonable and collectively pointless is what nobody notices until the budget is
gone.

---

## 5. Rehydration

`job("fulltext")` is the **primitive**; auto-rehydration is the harness
pre-writing that exact call into a fresh kernel before the agent's next cell.

```python
# turn 12
batch = submit(calls, name="fulltext")
# ---- kernel dies, agent wakes; harness prelude, shown as [rehydrated] ----
batch = job("fulltext")
```

One mechanism, not two, which avoids the awkward dual rule ("handles come back,
data doesn't"). If rehydration fails the agent writes the same line itself, using
a verb visible in the manifest. It also covers what rehydration can't: a job never
bound, a job from a previous session, enumeration.

Visibility is what separates this from magic — the manifest must say
`[rehydrated]`. Invisible reconstruction produces an agent reasoning confidently
about a binding that isn't what it thinks.

**`name` is required**, per the same reasoning settled earlier for `spawn`: it is
what appears in `jobs()`, the manifest and the wake event, and an unnamed job
makes all three unreadable.

Failure modes:

- **Shadowing** — a later `batch = "done"` makes the handle-table entry stale.
  Use the latest recorded binder per name and skip if it isn't handle-valued
  (the `binder`-dict logic in `analyze_carryover.py` already does this).
- **Aliasing** — `b2 = batch`. Intern handles by job id so both rehydrate to the
  same object.
- **Containers** — `jobs = [submit(c) for c in calls]` buries handles in a list
  and rehydration needs structural reconstruction. **Constraint: a handle may be
  bound to a bare name and nowhere else**, and burying one is a loud error at
  assignment rather than a silent absence at wake. This is the argument for
  `submit(calls)` returning one handle over N items rather than N handles.
- **Dead job** — rehydrate to a tombstone that raises with the reason, same
  contract as PRUNED.

---

## 6. The ceiling — §5 correction

§5 places the ceiling in `Job.__await__` with no asyncio hooking. That only covers
awaitables the harness constructed. **An agent-defined coroutine bypasses it
entirely:**

```python
async def poll_until_ready():
    while not check():
        await asyncio.sleep(10)   # 12 iterations = 120s; no single sleep > 30s
await poll_until_ready()          # never touches Call.__await__
```

And this is the case the traces actually show — the ~3050s wasn't a slow tool, it
was the agent's own polling loop. Blocking `time.sleep` > 30s doesn't catch it
either.

**So the limit must be on cell wall-clock**, which already exists:
`HARNESS_CELL_TIMEOUT_MS` + `interrupt_request` + a message to the model
(handoff §3 bug 4). Same mechanism, lower threshold, no asyncio hooking, and it
catches every shape uniformly — `Call`, `gather`, agent coroutine, `time.sleep`,
a wedged C extension.

### There is no soft tier

The model only exists at turn boundaries. A notice is a message; messages are read
at the start of a turn; a turn begins when the tool call returns. **The only way to
tell the agent anything about an in-flight cell is to end the cell.** A "soft
notice at 60s" is undeliverable.

What is actually available:

- **hard interrupt** — cell dies, model gets a turn, message explains. Loses the
  cell's work. Threshold ~120s: comfortably above the 45–53s legitimate compute
  observation, well below the 120–235s waits.
- **retroactive attribution** — the genuinely soft channel, and free:
  `cell completed in 203s — 187s waiting, 16s computing.` No interrupt, no
  concurrency.

Upstream, the hole shouldn't exist: mediated waits end the cell themselves, and
internal waits are prevented (blocked `time.sleep`/`threading.Thread`) or
interrupted. A cell blocked at 60s means the agent went around the primitives.

### What an exceeded ceiling should say

Not auto-promotion — that needs a synthesised handle name, and §5 rules out
generated names. Fail, and name the fix:

```
WaitTooLong: 'fetch_fulltext' exceeded the 60s in-kernel ceiling and was cancelled.
             Work this long needs a handle that outlives the kernel:
                 batch = submit(arxiv.fetch_fulltext(url), name="fulltext")
```

The waste is affordable because **the threshold sits in a gap in the
distribution**, not a dense region: compute topped out at 45–53s, every wait was
120–235s. Few calls land near the line. Keep that justification attached to the
number in the spec.

For a *local* coroutine the advice differs, because you can't submit
`__main__.poll_until_ready` at all:

```
  · waiting on an external event? register interest and end your turn
  · need this loop out-of-process? it has to live in a file:
    write work/poll.py, then submit("work/poll.py:poll_until_ready")
```

One rule covering handlers, submitted work, and polling: **anything that must
outlive the kernel has to be nameable from outside it.** A path is nameable; a
cell-local `async def` isn't.

---

## 7. Monitoring

Split the two things bundled under the word:

- **watching** — "is it done / stalled / erroring." No intelligence required.
  Control-plane condition plus an event. Free.
- **judging** — "is this going wrong in a way that matters." Needs a model, but
  only when there is something to judge.

A long-lived monitor *subagent* relocates the wait rather than solving it, and
costs: polling burns turns (~$0.95 to watch one 40-minute job at 30s intervals,
×10 jobs = ~$9.50); two kernels instead of one; the monitor's context fills with
log output and compacts away the criteria; split ownership races on kill/retry;
and nothing notices if the monitor itself dies. OTP's answer is that supervisors
are **dumb and reliable** — a direct argument against an LLM in the restart path.

What a model *is* good for here is **context reduction**: 200k tokens of log →
500-token triage. That is a **reducer, not a monitor** — one invocation, on a
trigger or at completion, reads a file, returns a summary, exits.

Keep separate: **supervision handles liveness** (crash, restart, reap);
**handlers handle semantics**.

> **Wake the parent for decisions, not for progress.**

Progress updates the manifest without waking anyone. Handlers must not close over
the kernel namespace, so they are specs, not closures — `agent="…"` (prompt) or
`script="work/handlers.py:summarize"` (importable path, as Celery/RQ/Airflow do
it). Type the parameter as a spec so a lambda is unrepresentable, and reject a
callable at registration naming the captured variables. The failure otherwise is
a 3am no-op.

**v1 probably shouldn't have handlers at all**: job completes → event → parent
wakes → reads manifest → decides. The closure problem then doesn't exist.

---

## 8. Manifest: two listings, opposite policies

The full-vs-delta debate conflates two things that want different answers.

| listing | what it is | policy |
|---|---|---|
| namespace manifest | which bindings exist | **full** for Sonnet (0.776 vs 0.760), **delta** for Opus (0.809 vs 0.799) — measured |
| world-on-wake | what changed while asleep | **always delta** |

The 88% redundancy in the traces was re-dumping *chat history* — world state, not
namespace. So it argues for a world delta ("2 new messages in #project-x since
turn 14"), while the namespace listing can stay full. The measured finding that
repetition prevents re-fetching applies to bindings, not to the world.

For Sonnet, full uses **fewer** total tokens than delta (246k vs 271k): the
repeated listing is what prevents re-fetching, and each avoided call saves more
than the listing costs. The repetition is the mechanism, not the overhead.

Jobs, waits and pruned bindings belong in the same listing, because the recovery
story is identical and the agent shouldn't have to remember any of them:

```
batch     job:running    fulltext 340/512            turn 12  → work/jobs/fulltext.json  [rehydrated]
inbox     watch:pending  #project-x, since turn 14
tests     wait:armed     re-armed 4×, wake_after=300
results   (PRUNED)       = await batch                turn 12  → work/turn-12.json
```

The wake event must carry **why** — condition fired / `wake_after` elapsed /
errored. Three different next actions; if the agent can't distinguish them it
re-derives by inspecting state, which is where the redundancy came from.

---

## 9. Long-running work: the inventory

| work | duration | shape | existing substrate? |
|---|---|---|---|
| regression/test suites | min–hours | one command, big log, pass/fail | **yes** — CI |
| builds | min | one command, cacheable | **yes** |
| batch/ETL | min–hours | fan-out per item | **yes** — orchestrators |
| bulk API fetch | min–hours | fan-out, rate-limit-bound | no |
| training / heavy compute | hours–days | one job, checkpointed | **yes** — schedulers |
| waiting on a human | unbounded | pure event | n/a |
| subagent doing its own task | min–hours | recursive session | ours |

**Almost all of it already has a substrate.** The agent doesn't need to be a
workflow engine — it needs to submit to one and observe it. That is the answer to
"Airflow/Prefect/Temporal are heavyweight": don't reimplement, interoperate. The
two rows without a substrate are both plain fan-out.

Real orchestration earns its weight under three conditions — inter-step
dependencies that must survive mid-way failure, compensation/rollback, and
schedules. Agent work mostly has none of them; it has fan-out and wait.

Waiting on a human is *unbounded* but the **cleanest** wait: purely event-driven,
nobody expects a kernel alive across it, and Managed Agents already models it
(`requires_action`, resume on event).

### MCP calls should not become jobs

The common case is 0.7s (563s across 756 calls). Wrapping that in a control-plane
record, a result file and an event is absurd overhead, and it would wreck the
composition ergonomics that produce the score delta.

The same syntax spans 0.7s to 20 minutes, and duration is a property of the
*invocation*, not the API — DEX Paprika is the clean example, fine against one
server and minutes of 429-throttled serialisation against another. Nothing in the
code says which.

> **The model decides lifetime; the runtime decides scheduling.**

`submit` means *"this should outlive me"* — an intent the model genuinely knows.
Duration is the runtime's problem. Precedent for the pattern: dask/ray/Spark take
ordinary code and let the runtime pick the strategy.

The proxy is already most of the way there — it already throttles (median gap
2.01s). What's missing is recording partial results and surviving the kernel.

**Correctness catch.** An interrupted batch, later resumed, must **collect
recorded results** rather than re-calling: a naive re-run stitches one result set
from two points in time and the model reasons over it as one snapshot. That is
consistent with the CLAUDE.md rule, not a violation of it —
**memoise on replay, never on forward progress.** Worth stating explicitly in the
batch semantics.

---

## 10. Measurements taken for this design

All offline over `.run/runs` (462 runs, 370 codemode). Analyzer:
`bench/analyze_carryover.py` on branch `scott/carryover-analysis`, worktree
`~/src/harness-carryover`.

**Cross-cell state reliance** (5,540 cells):

| | cells | share |
|---|---|---|
| standalone (would run in a fresh interpreter) | 1,799 | 32.5% |
| needs carry-over | 3,736 | **67.4%** |
| — of which tool-derived only (ingress cache covers) | 2,636 | 70.6% |
| — of which local-derived (**true cost of TTL=1**) | 1,100 | **19.9% of all cells** |

Carry depth median **3**, mean 4.9, max **61**; only 29.7% of references reach back
one cell. It is a workspace, not a pipeline — "merge adjacent cells" doesn't cover
it. Two reasons 19.9% is an **upper bound**: static tool-call detection undercounts
(0.64 vs the proxy log, loops count once), and these prompts advertise persistence.

**Live bindings, for manifest cost:** median 26 at end of run, p90 46, max 100 →
~364 tok/turn median, 644 at p90 (~14 tok/line). A large share are scratch names,
which is why dropping imports and loop targets mattered.

**Introspection is never used** (6,269 cells): `Out[...]` 0, `_3`-style backrefs 0,
`%whos`/`%who` **0**, `globals()` 0, `dir()` 1. Two consequences: the manifest has
to be *pushed*, never offered; and `cache_size = 0` in the kernel config is free
(output history otherwise pins every result — `del` frees the name, not the bytes).

**Un-awaited calls** (7,902 api calls): genuinely unconsumed ≈ **0**.

**Serialisability:** coroutines and generators are not picklable; a `Call` object
is, before and after being awaited, and works with `asyncio.gather`.

**No partial-completion primitives are ever used** (10,245 cells): `asyncio.wait(`
0, `FIRST_COMPLETED` 0, `FIRST_EXCEPTION` 0, `as_completed` 0, `create_task` 0,
`.cancel()` 0 — against `gather` in 1,934 (18.9%). The agent fans out and waits for
all, always. This is why `count=`/first-of-N is cut, and why jobs must not be
awaitable (it would `gather` a list of submitted handles).

### What the waits are actually for — TAC, 2,263 codemode cells

191 cells (8.4%) contain `sleep`/poll-loop/`Thread`, spread across **14 tasks** —
pervasive, not one outlier. Of 176 classifiable:

| waiting for | cells | share |
|---|---|---|
| **a reply to a message it sent** | **146** | **83.0%** |
| a process it launched (build, server, log tail) | 16 | 9.1% |
| both / unclassified | 14 | 7.9% |

**11,257 s of in-cell `sleep` in total** (3.1 h), median 45 s, max 400 s — with
hand-rolled backoff across cells, the same cell repeated at escalating durations
(`range(6)/30s` ×7 → `range(8)/45s` ×10 → `range(10)/60s` ×12).

Two consequences:

- `watch` is the **primary** primitive, not the secondary one. `submit` addresses
  9%.
- The 9% collapses into `submit` only if it accepts a **shell command**, not just a
  `Call` — the observed cases launch builds and servers via `Popen`/`nohup &`.
  Hence `run(cmd, name=…)` alongside `submit(calls, name=…)`, which is the form
  handoff §5 already sketched.

---

## 11. File tools — product, not benchmark

**Use a tool when the value is the error contract or being always-resident; use
code when the value is composition.**

| op | mechanism | why |
|---|---|---|
| `edit` | **native tool** | the contract *is* the tool — `str.replace` silently replaces all 3 or 0 |
| `read` | native, or a resident helper | line numbers + predictable truncation; too common to discover |
| `write` | REPL | `open(f,'w').write(s)` has nothing to get wrong |
| glob / grep | REPL | composition — scan many, filter, aggregate in one cell |

File read/edit is the one surface where the in-distribution argument runs
**backwards**: it's where frontier post-training is heaviest, so the tools are the
well-trodden path and the Python is the improvisation.

Nothing is lost by doing this — on file-shaped tasks both arms produced identical
answers with codemode 19% more expensive, and codemode reached for `%%bash` and ran
the same `find` command.

**Do not do this to the benchmark arm.** The independent variable is the tool
registry; adding read/write/grep to codemode mid-experiment is the pi-vs-prime
confound again. Experiment: one tool. Product: give it `edit`.

It matters more now than it did: files carry durable state, job results, handler
definitions and PRUNED targets. A botched edit corrupts the persistence layer
rather than costing a retry.

---

## 12. Open

- **Is the primitive set complete?** From the traces the agent wanted: a reply to a
  message it sent (`watch(messages)`), work it started to finish (implicit
  suspend), a condition on service state (`watch(predicate)`), and time to pass
  (`wake_after`). **Checkable now**: classify every cell containing `sleep`, a poll
  loop, or a `threading.Thread` by what it was waiting for. A fifth category is
  exactly where the agent will write `while True: sleep(10)`.
- **Does the agent yield rather than spin** when handed these primitives? The
  traces say it spins when it has nothing else, but that's without the primitives.
  Crash-injection rig answers it, and it's the first test of failure recovery —
  the dimension MCP-Bench structurally cannot score.
- **Recompute the 19.9%** against q7+ns runs. It was measured over v1–v9/q1–q5 and
  injection changed cell structure substantially (MCP calls 41.9 → 17.4).
- **Terminology collision.** §5's `Job.__await__` implies §5's "Job" is the
  api-call awaitable (that's what `gather` inherits from), not the `submit` handle.
  Two objects; a build that conflates them produces the awaitable submission by
  accident. Rename before implementing.
- Whether the wait/compute split can be attributed automatically per cell (it is
  what the retroactive message needs, and what justifies the threshold).

### P2 / deferred

- **Concurrent cell with fresh context** while another blocks. Rejected for now:
  it can't touch the blocked namespace, so it's a kill switch with a Python
  prompt, which the interrupt already is — at the cost of two kernels, two
  namespaces and a manifest that must explain which is which.
- **Replay-based transparent continuation** (Temporal-shaped). Only earns its
  determinism discipline past the horizon where holding a snapshot stops being
  reasonable, which is narrower than it first appears. `await` + snapshot covers
  minutes-to-hours with no dialect and no changes for the model.
- **Ingress blob handles / content-addressed values.** Superseded in priority by
  the burst-scoped kernel: if the kernel doesn't live long, shrinking its heap
  matters less. Keep for the batch-result store, where content-addressing is load
  bearing.

---

## 13. Corrections — do not repeat these

Recorded per the CLAUDE.md rule that negative results are more informative than
wins.

- **Claimed handles shrink the resident namespace 50–100×.** Wrong: iteration
  forces materialisation, and cell classification says the majority of cells do
  local wrangling, so ingress interception addresses the minority. Realistic is
  3–5×, and the win is reconstructability, not heap size.
- **Cited v7 as the leading prompt variant** and built an argument on it (that the
  hillclimb was selecting toward statelessness). v7 is one of the worst; q1/q5
  lead. The correlation runs the **other** way — `r(score, TTL=1 cost) = +0.42`,
  t=1.39, ns at n=11 variants. Winning prompts lean on the namespace *more*.
  Always re-read the current numbers; never argue from a remembered ranking.
- **Proposed `add_done_callback`.** It's an in-process API and I imported its
  liveness assumption along with its shape — the exact thing §5's *borrow the
  shape, refuse the type* warns about, invoked one message earlier.
- **Claimed `submit` can't take a coroutine, therefore needs `(fn, *args)`.** True
  of coroutines, irrelevant given a custom awaitable. `Call` is the better design
  and it was reachable from the rule already written down.
- **Claimed an un-awaited api call "starts a coroutine and Python complains."**
  It doesn't start anything — coroutines are inert and the warning fires at GC.
  Same case as an unconsumed `Call`, not a new failure mode.
- **Proposed silent promotion of a long `await` into a named job.** Needs a
  synthesised handle name, which §5 explicitly forbids; and same-line-different-
  behaviour on wall-clock is the invisible semantics this project keeps getting
  burned by.
- **Proposed a "soft notice at 60s".** Undeliverable — the model only exists at
  turn boundaries, so any notice about an in-flight cell requires ending the cell.
- **Added `count=1` / first-of-N to `wait` because it mirrored
  `asyncio.wait(return_when=FIRST_COMPLETED)`.** Nothing asked for it: zero uses of
  any partial-completion primitive across 10,245 cells, and zero `.cancel()`, so
  even the race-then-cancel pattern it exists for never appears. It also converts
  one wake into N. Cut. *Symmetry with an existing stdlib API is not evidence.*
- **Justified "jobs must not be awaitable" with the `create_task` + `await task`
  idiom.** `create_task` appears **zero** times. The real risk is bulk: 1,934
  `gather` calls, so the agent would write
  `await asyncio.gather(*[submit(c) for c in calls])`. Conclusion unchanged, worse
  than I said, wrong reason given.
- **Built the design around `submit` and justified `watch` from a single task.**
  Backwards: 83% of observed waits are message-reply, which `submit` cannot express
  at all; `submit`-shaped waits are 9%.
- **Two analysis bugs, both returning clean wrong answers**, which is the
  house failure mode: a literal `api.` match missed aliased imports
  (`import api.reddit as reddit`), and `symtable.get_children()[0]` on Python 3.14
  is an `__annotate__` scope (PEP 649), not the wrapper function — that one
  reported a tidy 0% carry-over across all 5,540 cells. Both fixed; the analyzer
  now cross-checks static detection against the proxy log and prints the ratio.
