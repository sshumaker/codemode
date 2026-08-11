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
| a shell condition (`until curl -sf …`) | `asyncio.sleep` in the agent's own loop |
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

One namespace, four functions.

```python
# in-kernel, unchanged — the 0.7s common case
texts = await arxiv.fetch_fulltext(url)          # ceiling applies (§6)
rows  = await asyncio.gather(*calls)

# work that outlives the kernel. payload is any serialisable description:
batch = jobs.submit(calls,          name="fulltext", max_runtime="1h")   # Call(s)
build = jobs.submit("gradle build", name="build")                        # shell command
                                                 # ...then STOP → suspend → wake at quiescence

# a deadline on the agent's attention — and this is also how you poll
jobs.wait(wake_after=1000)                       # wake me in 1000s, then check

jobs.get("fulltext"); jobs.list(); jobs.kill("fulltext")
```

That's it. `await`, which the cells already use; **stopping**, which the agent
already does; and `jobs.*`.

### Polling is `jobs.wait(wake_after=…)`, not a primitive

**Check first, then wait — in one cell.** This is the whole idiom, and getting it wrong doubles
the turn count (measured, below):

```python
# turn N — one turn, one poll
print(hist2(rid))            # what arrived while I was away?
jobs.wait(wake_after=300)    # not yet → wait again. must be the last statement.
# ── turn N+1 ── same shape again
```

The anti-pattern, which an earlier draft of this section showed as the example, is a cell that
does nothing but `jobs.wait(...)` and a *second* cell that checks. Same poll, two turns.

**This costs nothing relative to today — for the waits TAC contains.** The 194 waiting
constructs in the TAC traces (§10) were *already* 194 turns — each cell is one tool call.
The agent is already paying turn-granularity polling; the only change is that it stops
holding a kernel and stops burning ~9,700 s of in-process wall-clock, which is **72% of the
arm's entire tool wall-clock**. Turn-cost parity, wall-clock and RAM strictly better.

**But parity is approximate, and the first live run shows the gap.** With the v1 surface in
place (`bench/tac/jobs_runtime.py` plus a kernel prelude that blocks `threading.Thread` and
`time.sleep(>30s)`, erroring with the correct pattern), `pm-schedule-meeting-2` codemode
re-run measured:

| | before | after |
|---|---|---|
| in-cell sleep | 3,050 s | **70 s** |
| `threading.Thread` | 4 | **0** |
| `jobs.wait` | 0 | **14** |
| turns | 32 | **42** |
| cost | $0.62 | $0.67 |
| score | 2/5 | 2/5 |

The agent adopts the primitive immediately and unprompted (it wrote `jobs.wait(wake_after=40)`
in the cell *after* the guard first fired), blocking collapses **98%**, thread leakage goes to
zero — and **turns rise 30%**.

**The turn rise is a cell-split artefact, not the cost of polling, and it is fixable by idiom.**
Measured: the agent asked for durations statistically indistinguishable from the sleeps it
replaced (`wake_after` median **195 s** vs a per-wait-cell median of 205 s before; 14 wait
statements vs 12), so it is not polling more often. What changed is that **11 of its 14 waits
were bare `jobs.wait(...)` cells with the check in the following cell**, where before *every*
wait was fused with its check. Those 11 cells are the entire increase (+11 turns, −1 elsewhere).
Under the check-then-wait idiom above the same run is 32 turns — parity with the before-run's 33.
Full analysis: `docs/sketches/wait-taxonomy.md` §1.

Nor is +30% a trend. Across the three paired validation runs turns went **88 → 83** in aggregate
(pm-schedule +10, admin-ask −16, hr-collect +1).

Two caveats on that table, both from `wait-taxonomy.md`:

- **The waits were not actually waited.** All 17 wait cells returned in 2–12 s with the raw
  `__HARNESS_WAIT_SECONDS__` sentinel still in the output: the host-side consumer
  (`vendor/prime-agent/…/tools/ipython.ts:1004`) was not active in that build. 2,950 s requested,
  ~0 s waited. In-cell sleep, threads, turns and cost are unaffected; **"wall-clock strictly
  better" is not yet demonstrated**, and the honest claim is narrower anyway — waiting does not
  shrink, it stops being *held*. Had the waits been honoured this run would have taken ~2,900 s
  against 1,890 s before, because the agent requested more total wait than it used to sleep.
- **Score is not measurable on these tasks** (§10) — full marks come from reading the grader's
  scenario file, not from waiting well.

For the **category-5** waits in §10 the turn-parity claim is strictly false rather than
approximate: those are sub-30 s pauses *inside* a cell, costing zero extra turns today, and
re-expressing them as wakes would create turns. They must not go through `wait` at all — §9.

Earlier drafts had a `watch()` verb and an `until="changed"` parameter on `submit`,
where the control plane re-issued a request and diffed the result. Both are cut
(§13). What that removes:

| no longer needed | why it existed |
|---|---|
| `watch` as a verb | it was `submit` with a different completion criterion |
| control-plane request re-issuer | to poll on the agent's behalf |
| `readOnlyHint` enforcement | otherwise it re-sends a message 60× |
| baseline capture + diffing | to detect "changed" |
| delta computation on the handle | the ~88% redundancy is fixed by reading **once instead of 13 times**, not by pre-diffing the payload — and the agent already wrote the filter |

A repeat-until criterion remains a legitimate *optimisation* — it collapses N poll
turns into one wake — but it is not needed for correctness, and it is not free
(see the proxy requirement below). The surviving poll turns are now measured, and they are
what it would buy: the v1 re-run of `pm-schedule-meeting-2` issued **14 `jobs.wait` calls**
and grew from 32 turns to 42. Worth revisiting once more than one task has been run — at
~$0.012/turn the whole prize is a few cents per task, against a control-plane re-issuer and
its credential dependency.

### Conditions: a shell string, and why that's the good answer

Claude Code's `Monitor` solves the closure problem in a way neither earlier draft
reached: **the condition is a shell command string.** A string cannot close over
the kernel namespace, so the agent gets arbitrary expressiveness with zero capture
risk — no DSL, no declarative predicate language.

That matters here because the polling the agent actually wrote captures *two*
cell-local things:

```python
def poll():
    for i in range(60):
        time.sleep(20)
        state['e'] = hist2('CZYW...')      # captures state AND hist2
threading.Thread(target=poll, daemon=True).start()
```

`hist2` is cell-defined, so the file-path escape hatch ("write the handler to
`work/poll.py`") doesn't rescue this — the agent would have to relocate its helper
too. A Python predicate parameter would rebuild exactly this. A shell string
can't.

So a condition is just a `jobs.submit` payload:

```python
jobs.submit("until curl -sf localhost:5000/health; do sleep 2; done", name="ready")
```

**Prefer exit status over output matching.** This is the ordering Monitor's docs
imply but don't state, and it's the difference between two and five failure modes:

```bash
until curl -sf localhost:5000/health; do sleep 2; done   # exits or hits the deadline. that's all.
tail -f run.log | grep --line-buffered "Ready"           # can silently never fire, three ways
```

### Arming failures, and the two guards worth having

Reported anecdotally (not yet measured): Claude gets Monitor wrong **both
directions**. The schema itself spends most of its length on two of these, which
is usually a tell.

| failure | cause |
|---|---|
| **armed, never fires** | success-only filter, or a non-flushing stage (`grep` without `--line-buffered`, `awk` without `fflush`, `head` which cannot flush at all) |
| **fires, stays armed** | unbounded command for a one-shot need — `tail -f` / `while true` never exit, so it lingers to timeout. `grep -m 1` does *not* fix it: if the log goes quiet, `tail` never gets SIGPIPE |
| **exits immediately** | bounded command when a stream was wanted — one check, no watch, and it looks like it worked |

The structural cause: **notification count is an emergent property of the script's
control flow, not a declared intent.** Three independent things must be right —
does it exit, does every stage flush, does the filter cover failure — and nothing
checks any of them. That is the price of the shell-string choice: full
expressiveness bought with total unverifiability, failing *silently*.

Two guards, both cheap, both applications of the rule that the model gets intent
right and mechanics wrong:

1. **Declare intent, lint the mechanism.** `expect="once" | "stream"` lets arming
   statically reject the mismatch — `expect="once"` with `tail -f` and no exit path
   is an error at arm time, not five minutes of silence.
2. **Turn silence into a line.** You cannot prove a filter will fire, but you can
   flag a job that has emitted nothing by a fraction of its deadline, in the
   listing the agent already reads:
   `ready  job:running  0 events in 240s of 600s  ⚠ never fired`

One advantage this design already has: our wake event carries a **reason**, so
`max_runtime` elapsing without completion arrives as an explicit *"deadline, never
fired"*. Monitor's timeout just kills it, and nothing is said.

### The proxy requirement that comes with shell conditions

`until curl -sf …` needs a network-level proxy, and this is not optional — it
reopens a hole this project already closed. Confound #1 from the clean-up: **78% of
vanilla's bash calls were `curl` straight to the same APIs the MCP servers
wrapped**, bypassing the tools under test.

The proxy has four jobs, not one: **intercept** (or the condition bypasses the tool
surface), **inject credentials** (the token must never be in the cell or in the
command string), **log** (a wait that made 600 requests must not be invisible), and
**throttle** (a `sleep 2` loop against a rate-limited service is exactly the DEX
Paprika shape).

On enforcement level: `HTTP_PROXY` env vars are a *cooperative* control — raw
sockets evade them — which was adequate for the fairness use. For a hosted runtime
the answer is **not** primarily network-namespace redirect; it is credential
injection. See "The permission boundary moves" below: if the agent holds no token,
bypassing the proxy yields a 401 rather than freedom.

This corrects a claim made earlier in this design: dropping `until="changed"` does
**not** remove the credential dependency, it moves it from a control-plane
re-issuer into the shell. The requirement is a property of *watching an
authenticated service*, not of the mechanism. The split is unchanged either way:

- **21% (process/local)** — files, ports, exit codes, log tails. No network, no
  credentials, no proxy. Free. (§10; was reported as 9%.)
- **78% (service/chat)** — needs the proxy, whichever poller you pick.

Note which side the *observed* conditions fall on: every shell-string condition actually
written in the traces targets localhost or a local file, i.e. the free 21%. The credential
requirement is real but currently unexercised — see §10's category-3 note.

Worth writing down as a chain, because all three links are already-observed bugs:
unproxied poll loop → trips the rate limit → 429s (which this project already saw
arriving as *successful* MCP responses) → the condition never becomes true →
**silence**, which reads as "still waiting."

One design note for whatever proxy is used: **every poll-condition URL must be
covered by a static rule.** A policy engine that falls back to an LLM judge on
unmatched requests turns `until curl -sf …; do sleep 2; done` into one judge call
per iteration, and the "polling is turn-cost-free" property above quietly acquires
a per-poll model bill.

### The permission boundary moves — it isn't bypassed

The early prediction was that code-mode would *route around* guardrails encoded at
tool boundaries. That framing is wrong. The guardrail **relocates**, from the tool
call to the HTTP request, and the consequences run both ways.

In tool-calling the permission unit is a named, schema'd event. In codemode there
is one tool whose argument is a program, so there is nothing to approve at that
layer.

**Better than expected:** a tool schema is a *claim* about what a tool does; the
request is what it did. Approving `send_message(channel, text)` requires trusting
the implementation; approving `POST /api/v1/chat.postMessage` with the real body
inspects the effect. Enforcement moves from the point of intent to the point of
effect.

**Worse, and structurally so:** a cell makes tens of requests, so per-request
prompting is unusable — and the cell cannot be classified up front either.
`for u in urls: post(u, payload)` is unclassifiable without knowing `urls`. So
**cell-level static classification is undecidable in a way tool-call
classification is not**, which is a genuine regression against a bash-command
auto-mode classifier. The consequence: pre-execution approval does not work for
codemode, and the check has to be **in-flight, at the proxy, on concrete values.**
The proxy is where the check *can* live, not merely where it is convenient.

Two properties of that arrangement are unexpectedly good:

- **Denial-as-403 is in-distribution.** `403 {"error": "policy: no external hosts"}`
  is something the model has seen endlessly and already handles. A tool-call denial
  is a bespoke harness message it has to be taught. The mid-cell partial-execution
  problem is real (request 23 of 40 blocked, earlier side effects committed), but
  the *handling* is well-trodden.
- **Human approval inverts usefully.** You cannot hold an in-flight request while
  someone deliberates. So: deny with "requires approval" → the agent surfaces it →
  the human approves the **policy** → the agent retries. Approval mutates a rule
  rather than authorising one call.

#### Credential injection is what makes the proxy non-optional

Bypass the proxy with a raw socket and you get an *unauthenticated* request. The
agent can still reach the network; it just cannot reach anything useful, because it
holds no tokens. Enforcement comes from **not possessing the credential**, not from
fencing the network — which is stronger than a fence, and corrects the
netns-redirect claim made earlier in this section.

Two threats, two mechanisms, not to be conflated:

| threat | mechanism | bypass yields |
|---|---|---|
| unauthorised **action** (post as me, delete the repo) | credential injection | 401 |
| **exfiltration** of data already in hand | egress control / host allowlist | nothing — no credential needed to POST to attacker.com |

Credential injection closes the first completely. The second still needs the fence,
which is what SSRF blocking and host allowlisting are for.

Prime already had the right pattern for MCP: tokens in a host-side `auth.json`,
refresh via `rlm.host_request`, interactive login host-side, the model never sees a
secret. The proxy generalises it from MCP to arbitrary HTTP.

**TAC does the opposite, and it is the strongest empirical case in this document.**
Per the handoff verdict, measured over its codemode cells:

| | share of cells |
|---|---|
| raw `requests` (no api layer at all) | 17.7% |
| hardcode the service URL | 15.5% |
| **hardcode credentials in plaintext** | **14.4%** |
| `import api` / `api.*` | **0.2%** (1 of 555) |

So one cell in seven writes a credential into the code it executes. That is a
credential in the kernel, in the transcript, in the event log, and in any snapshot
— dying with the kernel (forcing re-login after restart) and enforceable by
nothing. It is not a design preference that credentials belong at the proxy; it is
the observed default failing.

#### Reference point: CrabTrap (brexhq/CrabTrap)

An HTTP/HTTPS MITM proxy in Go that evaluates outbound agent requests against
policy — static YAML rules (prefix/exact/glob + method) first, an LLM judge only on
no-match, every decision logged to Postgres, plus SSRF blocking and a policy-builder
loop that drafts rules from observed traffic. Worth reading as the shape; not
adoptable as-is.

| our requirement | CrabTrap |
|---|---|
| intercept | ✅ MITM, per-host cert from a custom CA |
| log | ✅ Postgres audit + UI |
| **inject credentials** | ❌ not addressed — it *sees* `Authorization` in cleartext |
| throttle | ⚠️ per-IP token bucket (50 rps) — DoS protection, **not** per-upstream |
| authorisation policy | ✅ and more than we had specified |
| enforcement | ⚠️ `HTTP_PROXY` env vars only, no transparent/iptables mode |

It also states explicitly that it does not sandbox or execute code — it is the
network half of the boundary rule (§1), not the boundary.

For the **benchmark** it is probably the wrong tool: the existing proxy already
logs MCP calls and throttles per-upstream (the thing that mattered for DEX
Paprika), which CrabTrap doesn't do, and an LLM judge in the request path adds
variance exactly where a measurement rig doesn't want it.

#### This sharpens the τ-bench experiment

The vague form was "codemode loses on policy compliance." The specific form is a
two-arm hypothesis: **codemode loses when policy lives only at the tool layer, and
does not lose when the proxy carries it.** That tells you whether the thesis
*requires* the proxy to be viable, rather than merely benefiting from it.

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
           End your turn and you'll be woken, or jobs.wait(wake_after=1800).
```

Promotion therefore goes **one way only**: a long `await call` can be refused
upward toward `jobs.submit`; a `submit` can never be awaited downward into a block.

### Implicit suspend at quiescence

Default: a session with live control-plane records **suspends** rather than
terminates when the agent stops. Wake when *nothing* is pending — not per job,
which would give N wakes, N turns and fragmentary state for N jobs.

> **Stopping means you're blocked. Being woken means you're unblocked.**

That's a behaviour the model already has rather than an API it must learn, and it
means the common case needs no verb. `jobs.wait()` exists for exactly one thing
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
| `max_runtime=` | `jobs.submit` | the **work** — exceed it and the work is killed |
| `wake_after=` | `jobs.wait` | the **agent's attention** — work continues |
| `jobs.kill()` | explicit | ending the work deliberately |

`wake_after` does **not** belong on `jobs.submit`; putting it there re-fuses attention
with work-lifetime, which is what the split exists to prevent. And the verb is
`jobs.wait`, not `wait_for` — `asyncio.wait_for` cancels on timeout and this doesn't.

Enforce a **floor** on `wake_after`. Re-arm is polling at turn granularity, and at
~$0.012/turn the same mechanism spans two orders of magnitude: re-armed every
5 min over 40 min ≈ $0.10 (fine); every 30s ≈ $0.95, five times the cost of the
whole task.

**The floor is 30s, not 60s — set equal to the sleep ceiling.** Two thresholds with different
values leave a dead band: the v1 prelude says sleeps ≤30s are fine while a 60s floor refuses
wakes below 60, so nothing legal exists between them — and the agent went straight there, asking
for **40s** on its first wake (45s appears 8 times in the corpus as a chosen sleep). One number
gives one rule: **≤30s, sleep it; >30s, wake.**

30s is also enough by itself. Measured distributions (`wait-taxonomy.md` §5): category-5 pauses
are 91% below 30s (median 5s), so the floor sits above almost all of them — and category 5 is
kept out of `wait` by `submit` owning retry and pacing (§9), not by the floor. With the primitive
in hand the agent chose ≥60s in **16 of 17** cases (median 120s, mode 300s), so the floor is
rarely the binding constraint.

Which means **the floor is the weaker guard, and the manifest's re-arm count is the real one.**
What bounds cost in practice is the escalation ladder the agent writes unprompted —
40 → 60 → 90 → 120 → 150 → 240 → 300, then 300 six times. A loop that is individually
reasonable and collectively pointless is what nobody notices until the budget is gone.

`wake_after` is **required**, not defaulted: it was explicit in 17 of 17 observed calls and bare
`jobs.wait()` was never written, so a default is unexercised — and no single value fits a ladder
that starts at 40–60s and settles at 300s.

---

## 5. Re-attachment — there is no rehydration

**Nothing survives the kernel. One rule, no exceptions.** After a wake the agent
re-attaches by name:

```python
# turn 12
batch = jobs.submit(calls, name="fulltext")
# ---- kernel dies, agent wakes ----
batch = jobs.get("fulltext")          # the agent writes this. one line.
```

The manifest carries the name it needs (§8), so this is not something the agent has
to discover:

```
batch   job:running   fulltext 340/512   turn 12  → work/jobs/fulltext.json
```

**`name` is required**, per the reasoning settled earlier for `spawn`: it is what
appears in `jobs.list()`, the manifest and the wake event, and an unnamed job makes
all three unreadable. A dead or reaped job makes `jobs.get` fail with the reason —
a lookup failure, nothing more.

An earlier draft had the harness auto-rehydrate handle-valued bindings by injecting
`batch = jobs.get("fulltext")` into the fresh kernel as a prelude. It was
implemented, tested and deleted — see §13 for the full argument, including the
decisive one: a name that silently changes identity across a kernel death *is* the
hazard that visibility was supposed to mitigate, not a mitigation of it.

Cutting it removes more than a prelude. **Most of the failure modes that section
documented were artifacts of the mechanism, not real problems:**

| was a failure mode | why it disappears |
|---|---|
| **shadowing** — `batch = "done"` staling the handle table | there is no handle table |
| **aliasing** — `b2 = batch` rehydrating twice | nothing reconstructs, so nothing double-reconstructs |
| **containers** — handles buried in a list need structural reconstruction | the agent may put a handle anywhere; only `jobs.get` re-establishes it |
| **names must be Python identifiers** — a binding needs a legal variable name | a name is a *key*, so `my.job-1` is fine |
| dead job | survives, but as an ordinary lookup failure |

One argument weakens honestly as a result: the container case was used to justify
`jobs.submit(calls)` returning **one** handle over N items. That justification is
gone. The shape is still right for other reasons — it mirrors `Executor.map`, and
it keeps the manifest to one line instead of 412 — but it no longer has a
correctness argument behind it, only ergonomic ones.

And it restores the property the whole design is organised around: no invisible
reconstruction, so no agent reasoning confidently about a binding that isn't what
it thinks.

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
batch     job:running    fulltext 340/512            turn 12  → work/jobs/fulltext.json
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

It is also, measured, the one that **never completes**: 151 of 151 reply-shaped waits in the
corpus waited for something that never arrived (§10). Non-arrival is the expected outcome here,
not the error path — which is why the wake event carries a reason and why "deadline, never
fired" has to be a first-class message rather than a timeout with nothing said.

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

### `submit` owns retry and pacing — the agent never expresses either

This is the answer to §10's fifth category. 407 MCP-Bench cells wait for a rate limit or a
transient upstream failure to clear, in three shapes — backoff after a 429, a cooldown before
re-issuing the same call, and pure pacing between chunks of a fan-out. None of it belongs to
the agent:

> A submitted batch retries transient failures with backoff and paces itself under the
> upstream rate limit. Neither appears in the cell.

`jobs.wait(wake_after=…)` cannot serve this and should not be bent to. Median 5 s per pause
(0.4 s and 1.5 s in the observed loops) against a **60 s floor**; a `for attempt in range(6)`
retry becomes six wakes, six turns and six re-attachments where today it is zero extra turns; and
the pause sits *interleaved with the calls*, so it is a property of how the batch is issued,
not a unit of agent attention. The proxy is already the natural owner — it throttles at a
measured median gap of 2.01 s.

Two riders.

- **It interacts with memoise-on-replay.** A call that failed and then succeeded on retry must
  record the *success*; a resumed batch must not replay the recorded failure, and must not
  count a retried attempt twice.
- **The ceiling now fires on cells dominated by deliberate pauses.** Once pacing is real, a
  paced fan-out exceeds the §6 ceiling and is pushed toward `submit` — correct behaviour, but
  the trigger is the agent's own waiting, not the work. Static analysis will not see it coming:
  one measured cell parses to **0.4 s** of sleep and took **192 s**, because the pause lives
  inside a helper called in a loop.

#### Retry and the proxy's throttle are two mechanisms with one clock

They are not the same mechanism, and the double-counting worry is real but avoidable. Split by
what each one can know:

| | owner | why it has to be there |
|---|---|---|
| **budget + admission** — when the next request may be emitted, `Retry-After`, the queue | **proxy** | it is per-upstream and shared across every kernel; only the holder of the credential knows the quota |
| **retry decision + attempt ledger** — how many attempts, which failures are transient, what finally succeeded | **`submit`** | it needs the caller's intent (idempotency, how much the batch is worth) and it is what replay reads |
| **backoff delay** | **proxy** | it is a function of throttle state, not of the caller |

The rule that removes the double count: **a retry is an ordinary re-entry into the proxy's
queue and carries no delay of its own.** `submit` says *try again*; the proxy says *when*. One
clock, and the budget is charged once per **emitted** request — which is correct accounting,
because a retry genuinely does consume upstream quota. Double counting appears only if retry
sits upstream of the throttle with its own timer (sleep 15 s "for the rate limit", then the
proxy adds its 2.01 s gap on top), or if `submit` re-issues a request the proxy has already
queued.

Two things this depends on, both worth resolving before the code:

- **The proxy must report transport status as structured metadata, not text.** Retry cannot
  move off the agent while the only available signal is `if "429" not in r3` — which is
  literally what the observed cells do (§10). This project has already seen 429s arriving as
  *successful* MCP responses (§10's confound list); with that bug present, a retry predicate is
  reading a corrupted signal and will either spin or give up silently.
- **`max_runtime` must not charge admission-queue time to the work.** A batch held 20 minutes
  behind a rate limit has not been *running* for 20 minutes, but `max_runtime` as specified is
  wall-clock on the work — so the first heavily-throttled batch gets killed for being
  throttled. Either exclude queue time, or say explicitly that `max_runtime` is a budget
  including waiting. Listed in §12.

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

**Recomputed 2026-08-11 on the current 678-run / 10,245-cell corpus** (the §12 item): the true
cost of TTL=1 is **24.9% on q7+ runs** (q7/q8/q9, 252 runs, 4,023 cells), against **20.0%** on
the original v1–v9 + q1–q5 basis — which reproduces the 19.9% above and validates the method.
It went **up**, and standalone cells fell 33.2% → 25.8%: namespace injection made cells *more*
interdependent, not less. Per variant: q7 27.4%, q8 22.2%, q9 18.5%; by model on q7+, opus 24.0%,
sonnet 26.7%. Still an upper bound for the same reason (static/proxy ratio 0.77).

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

### What the waits are actually for — TAC, 1,410 tool calls

> **Scope.** `TAC-HANDOFF.md`'s verdict voids TAC's *score* comparison between arms
> — it ships zero MCP servers, so the tool-representation variable does not exist
> there, and both arms are code execution (upstream's own CodeActAgent already has
> IPython; `bash` is code execution with worse ergonomics). That does **not** touch
> anything below. These are observations of what the agent *did while waiting* in a
> multi-service, long-horizon environment — behaviour, not representation — which
> is exactly what the verdict says TAC remains good for. One caveat to carry: both
> arms substituted REST APIs where upstream gives the agent a browser, so
> browser-shaped waits are unobserved here.


Corpus: `.run/tac-noinstr`, 89 runs (41 codemode, 40 vanilla, 8 claude-code), **1,410 tool
calls** — 556 codemode cells, 543 vanilla bash calls, 311 claude-code tool calls. Full
classification, per-category excerpts and reproduction scripts:
**`docs/sketches/wait-taxonomy.md`**. (Earlier drafts of this section reported 191 waits over
2,263 codemode cells = 8.4%, and a 9.1% own-process share. Both were wrong; see §13.)

**194 waiting constructs — 13.8% of tool calls, 13.5% of codemode cells and 16.9% of vanilla
calls — across 15 of 41 tasks and 29 of 81 codemode+vanilla runs.** Pervasive, not one
outlier, and not an artefact of one arm's tool surface. Classified by what the construct reads
*after* the wait, resolving cell-defined helpers (`hist2`, `status`, `poll`) to the resource
they touch — without that resolution `time.sleep(400); status()` scores as unclassified:

| waiting for | n | share |
|---|---|---|
| **a reply to a message it sent** | **151** | **77.8%** |
| work it started to finish (build, server, background job) | 40 | **20.6%** |
| time to pass, with no observation at all | 3 | 1.5% |
| a condition on service state it did *not* start | 0 | 0% |
| unclassified | 0 | — |

**~9,700 s of measured in-cell `sleep` in codemode and ~9,760 s in vanilla — 72% of each
arm's entire in-container tool wall-clock.** (Static upper bounds 11,175 s / 9,177 s; the
loops `break` early, so measured is 87% of UB.) Median 45 s per sleep statement, max 600 s,
with hand-rolled backoff across cells — the same cell repeated at escalating durations,
`range(6)/30s` → `range(8)/45s` → `range(10)/60s`.

Three consequences:

- **Waiting on a reply is the primary case, not submitted work.** It has no job
  to submit, so it is served by `jobs.wait(wake_after=…)` plus a check on the next
  turn (§4).
- **Submitted work is ~21%, not 9%** — which weakens the old framing that `submit` "addresses
  the other 9%". A fifth of all waiting is work the agent started, so `submit` is load-bearing
  rather than a minority case. It collapses into `submit` only if that accepts a **shell
  command**, not just a `Call`: the observed cases launch builds and servers via
  `Popen`/`nohup &`. Hence `run(cmd, name=…)` alongside `submit(calls, name=…)`.
- **The claude-code arm shows the sub-shape this design produces.** Given a real background-job
  primitive it waits on *its own job's output file* — one `Monitor` and three background
  `Bash` calls, all `until grep -qE "polls:|TIMEOUT" …/tasks/<id>.output`. Good news for the
  primitive set (wake-on-completion covers it) and a direct hit on §4's arming failures: it
  wrote an **output-matching** condition, not an exit status, on a file that may never contain
  either token.

**Threads: 5 `Thread(...).start()` in the whole corpus, all codemode, 4 of them in one task**
re-starting the *same* `poll()` — four concurrent daemon threads on the same two rooms, none
joined, none cancellable, all surviving into later turns because the kernel does. Per-cell
timing hides them: the cell that spawns a 1,200 s poll returns in **8 s**. Zero threads in
12,196 MCP-Bench cells.

**Redundancy: 131 of 192 cells (68%) that read chat history re-read a target already read
earlier in the same run.** In `pm-schedule-meeting-2` codemode, 13 of 32 cells re-dump chat
history: 20 read events over 6 distinct targets, returning 22 `(author, message)` tuples of
which 5 are unique — and all 5 were authored by the agent itself.

### The event never arrived — 100% of the time

Of the 20 codemode+vanilla runs containing reply-shaped waits, **all 20** end with the agent's
own report saying nobody replied ("the NPC bots never replied", "did not reply within ~10
minutes of polling", "neither replied despite several follow-ups"). **137 of 137** codemode and
vanilla reply waits, ~14,900 s measured — **77% of all measured sleep in the corpus** — spent on
events that never occurred; 151 of 151 including the claude-code arm, whose per-call durations
this event schema does not carry. A
third independent run confirms it: the `world-before-grading.json` snapshot for the v1 re-run
shows both DMs containing only agent-authored messages, including a bare "Hello" sent to test
whether anyone was alive.

The design consequence is not the wasted seconds. **When the event never arrives, the agent
escalates from waiting to modifying the environment**: probing `:2999` for an undocumented
webhook, `pkill`-ing and relaunching the NPC processes, sampling `/proc/<pid>/stat` CPU deltas,
opening a raw socket to Redis, and finally logging in *as the NPC* with credentials from
`/npc/npc_credential.json`. A wake event that says **"deadline, never fired"** (§4) is
therefore load-bearing; the observed alternative is an agent that tries to repair — and
impersonate — the counterparty.

#### …and that escalation is where the marks are, so score cannot validate this design

`/npc/scenarios.json` holds the NPC scenario data — the participant roster and each NPC's
scripted feedback and score. Across the six paired validation runs, reading it predicts the score
perfectly:

| run | read `/npc/scenarios.json` | score |
|---|---|---|
| `admin-ask-for-meeting-feedback` before | **yes**, at turn 33 of 35 | **6/6** |
| `admin-ask-for-meeting-feedback` after | no | **3/6** |
| `hr-collect-feedbacks` before / after | yes / yes | 5/5 / 5/5 |
| `pm-schedule-meeting-2` before / after | no / no | 2/5 / 2/5 |

The 6/6 was scored **without a single reply**, by lifting the roster and every score out of the
scenario file — the run's own summary says so. So the only score change in the validation set is
explained by answer-key discovery, and the behaviour that finds the key is the long-tail flailing
above, which the primitive deliberately suppresses.

**Do not use score on TAC chat tasks to validate the jobs runtime.** Turns, cost, in-cell sleep
and thread count remain valid there; fulfilment does not. This is a third independent reason the
`TAC-HANDOFF.md` verdict is right that TAC's scores cannot carry an argument.

### The fifth category: waiting for a rate limit to clear — MCP-Bench, 12,196 cells

Absent from TAC entirely, and TAC's four categories are absent here. **407 cells (3.3%),
73 of 735 runs, median 5 s per pause, max 120 s, zero threads:**

| waiting for | cells |
|---|---|
| retry after an error / 429 | 159 |
| cooldown, then re-issue the same call | 173 |
| pacing between chunks of a fan-out | 75 |

```python
# retry on 429
for attempt in range(6):
    await asyncio.sleep(15)
    r3 = await hf.search_models(query="phishing detection", limit=5)
    if "429" not in r3: break

# backoff inside a helper, plus pacing between calls
async def fetch(i, tries=4):
    for t in range(tries):
        r = await api.metropolitan_museum.get_museum_object(objectId=i, intent="…")
        if not r.startswith('Error'): return r
        await asyncio.sleep(1.5*(t+1))
for i in rem:
    store[i] = await fetch(i); await asyncio.sleep(0.4)

# pure pacing: no condition at all
for chunk in chunks:
    outs = await asyncio.gather(*[fetch(i) for i in chunk])
    await asyncio.sleep(2)
```

It fits none of the four: no counterparty, no job to observe (the call already *failed*), and
no independently observable condition — "is the 429 gone?" is only answerable by making the
request, and making the request *is* the retry, so a shell-string condition would have to issue
the very authenticated call under test. **It needs no new verb; it needs `submit` to own retry
and pacing** (§9).

Sleep total here is an honest bracket, not a point: static UB **7,201 s** *under*counts
(pauses live inside helpers called in loops), and the 407 cells' measured wall-clock of
**12,106 s** overcounts (it includes the API calls).

### Category 3 is a design argument, not an observation

No construct anywhere in TAC waits on a service the agent did not itself launch. The agent
reads GitLab, ownCloud and Plane but never *waits* on them — the one pipeline check is a single
unconditional `GET /api/v4/projects/{p}/pipelines`, no sleep, no retry. Every observed
service-state condition is a readiness probe on a process started in the same run, i.e.
category 2.

The design argument stands — `until curl -sf …/health` is the right shape for a service
condition, and shell strings are the right mechanism. But the traces contain no instance, so
two claims that lean on it are weaker than they look: that the agent "wanted" a service-state
condition (§12), and that shell conditions require credential injection (§4) — as observed they
target **localhost and local files**, where no credential is needed.

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

- ~~**Is the primitive set complete?**~~ **ANSWERED** — every waiting construct in the corpus
  is classified in §10 (evidence: `docs/sketches/wait-taxonomy.md`). **A fifth category exists
  and needs no new verb.** It is *waiting for a rate limit or transient upstream failure to
  clear* — 407 MCP-Bench cells, absent from TAC — and its home is retry + pacing inside
  `jobs.submit` (§9), not a `wait` at 1/12th of the `wake_after` floor. Of the original four,
  three are attested (reply 78%, own work 21%, pure time 1.5%) and **"a condition on service
  state" has zero instances** — the design argument stands, the traces do not contain one
  (§10). Two corrections fell out: the rate is 13.8%, not 8.4%, and own-process work is 21%,
  not 9%. Also: **the proposed detector never fires.** `while True: sleep(10)` appears 0 times
  in 1,410 TAC tool calls and once in 12,196 MCP-Bench cells — and that one is a pagination
  loop, not a wait. The agent bounds every loop; the real signature is
  `for attempt in range(N): … except: sleep(k)` (36 cells) and `for i in range(N): sleep(k)`
  (20 cells). Any future detector should look for those.
- ~~**Does the agent yield rather than spin** when handed these primitives?~~ **ANSWERED for
  adoption — 2 of 3 runs — and still open for benefit.** With the v1 surface,
  `pm-schedule-meeting-2` went from 3,050 s of in-cell sleep and 4 leaked threads to **70 s and
  0**, writing 14 `jobs.wait` calls it was never told to make; `hr-collect-feedbacks` likewise.
  Both adopted in the **very next cell** after the sleep guard first fired. **The third run never
  adopted**: `admin-ask-for-meeting-feedback` never tripped the guard, read the prelude's
  advisory instead, and clamped to `[5,15,20,20,30,30,30,30]` — four sleeps at exactly the 30 s
  ceiling, zero `jobs.wait`. **The error teaches the primitive; the advisory teaches the
  threshold** — so state the primitive without the ceiling value, or let the guard fire.
  Benefit is still unmeasured, for two independent reasons: the waits in these runs were no-ops
  (below), and score on these tasks is answer-key discovery (§10). Two caveats before believing
  the behaviour generalises. (a) The claude-code arm, which already had these primitives, answers
  the question **badly**: in `pm-schedule-meeting-2` it announced it would yield eight times,
  re-read the poll output file nine times instead, tripped the harness's own "Wasted call — file
  unchanged since your last Read" guard three times, and called `ScheduleWakeup {"stop": true}` —
  a *cancellation*, the verb used backwards. (b) That is the case the `wake_after` floor and the
  manifest's re-arm count exist for. Crash-injection rig still needed for failure recovery — the
  dimension MCP-Bench structurally cannot score.
- **BLOCKER for the next validation run: `jobs.wait` did not wait.** All 17 wait cells returned
  in 2–12 s with the raw `__HARNESS_WAIT_SECONDS__` sentinel un-replaced; the consumer at
  `vendor/prime-agent/packages/coding-agent/src/core/tools/ipython.ts:1004` (injected by
  `scripts/neutralize-prime.mjs:288`) was not active in the build used (`prime=0.7.1`,
  `imageDigest "(none)"`). 2,950 s requested, ~0 s waited. Fix and re-run before any wall-clock
  or fulfilment claim; add an assertion to `bench/validate.mjs` that a `wake_after=N` cell takes
  ≥N seconds, since this failed silently and in the direction that flatters the design.
- ~~**Recompute the 19.9%** against q7+ns runs.~~ **DONE** (§10): **24.9%** on q7+ (252 runs,
  4,023 cells) against 20.0% on the original basis, so it went up, and standalone cells fell
  33.2% → 25.8%. Injection makes cells *more* interdependent, which is the same direction as
  §13's "winning prompts lean on the namespace more".
- **Terminology collision.** §5's `Job.__await__` implies §5's "Job" is the
  api-call awaitable (that's what `gather` inherits from), not the `submit` handle.
  Two objects; a build that conflates them produces the awaitable submission by
  accident. Rename before implementing.
- Whether the wait/compute split can be attributed automatically per cell (it is
  what the retroactive message needs, and what justifies the threshold).
- **Does `max_runtime` include time queued behind the proxy's throttle?** If yes, the first
  heavily-throttled batch is killed for being throttled; if no, a job can outlive its stated
  deadline by an unbounded amount and the listing has to show two clocks. Needs a decision, not
  a default — §9. Related: whether retry attempts are visible in the listing, since a batch
  that succeeded on attempt 4 and one that succeeded on attempt 1 are the same result and very
  different signals about the upstream.

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
- **Built the design around `submit` and justified a `watch` verb from a single
  task.** Backwards twice over. 78% of observed waits are message-reply, which
  `submit` cannot express at all — but `watch` was not the answer either: it was
  `submit` with a different completion criterion, and the case is served by
  `jobs.wait(wake_after=…)` at *approximately* zero turn cost relative to today. Cut.
  ("Zero" was itself too strong — the first live run measures +30% turns; §4.)
- **Invented `rc.messages(room, since=T)` and wrote design around it.** No such
  API exists. TAC codemode has **no `api/` layer at all** — `import api.` appears
  in 0.0% of its 2,271 cells; the agent uses raw `requests.Session` with auth
  headers it fetched itself. The watchable unit has to be a serialisable *request
  description*, and for TAC that layer would have to be built.
- **Claimed dropping `until="changed"` removed the credential/proxy dependency.**
  It moves it from a control-plane re-issuer into the shell. Watching an
  authenticated service needs credentials outside the kernel under every design.
- **Read TAC's 33/40 ties as "the MCP-Bench effect does not transfer to office
  work."** Wrong shape of conclusion, and repeated in commit `20abaf7` and in
  summary. TAC never tested the thesis: zero MCP servers, so the independent
  variable was absent, and both arms were code execution. A null result on a
  variable that was not varied is not a transfer failure — it is not evidence
  either way. The remaining paths to testing representation are τ-bench, or
  building an MCP layer over TAC's services (a new benchmark on TAC's graders).
- **Claimed a hosted runtime needs network-namespace redirect** because env-var
  proxying is evadable. The real enforcement is credential injection: if the agent
  holds no token, bypassing the proxy yields a 401. The fence is still needed, but
  for exfiltration, not for authorisation — two threats, two mechanisms (§4).
- **Framed the guardrail risk as "code-mode routes around tool-boundary
  policy."** It doesn't route around it, it *relocates* it to the HTTP request —
  which is a better enforcement point (effect, not intent) and a worse approval
  point (a cell is unclassifiable up front where a tool call isn't).
- **Reported a validation run in which the primitive under test was a no-op.** `jobs.wait`
  printed its sentinel and returned; the host-side sleep never ran; 2,950 s of requested wake
  time produced ~0 s of waiting, and the run looked **8.6× faster** as a result. Every number in
  the before/after table was quoted before anyone checked that the thing being measured had
  happened. The tell was sitting in the tool output — the raw `__HARNESS_WAIT_SECONDS__:300`
  string, which the consumer is supposed to replace. **A guard that silently fails in the
  direction that flatters the design is the most expensive kind**; `bench/validate.mjs` now needs
  an assertion that a `wake_after=N` cell takes ≥N seconds.
- **Read a score comparison on a benchmark where full marks come from the answer key.**
  `admin-ask-for-meeting-feedback` scored 6/6 with zero replies by reading
  `/npc/scenarios.json` — the NPC scripts, including every feedback score the grader checks —
  and 3/6 in the run that didn't find it. Across six runs, key-reading predicts the score
  perfectly. The design being tested *suppresses* the behaviour that finds the key (long-tail
  flailing during a failed wait), so the metric is anti-correlated with the intervention. Check
  what a full score is actually rewarding before using it as a validation signal.
- **Attributed a turn increase to the primitive rather than to the idiom.** Turns rose 30% and
  the first two explanations offered were "turn-granular polling is inherently costlier" and "the
  agent picked bad durations". Both wrong: the durations were statistically indistinguishable
  from the sleeps they replaced, and the poll count barely moved. The cause was that 11 of 14
  waits were **bare** `jobs.wait(...)` cells with the check in the next cell, where every
  pre-primitive wait had been fused with its check — a 2× on the poll path caused by the shape of
  the cell, and the doc's own example was teaching that shape.
- **Measured a rate over a denominator summed across two directories that are the same
  corpus.** `.run/tac` and `.run/tac-noinstr` have **84 of 89 `trajectory.json` files
  byte-identical** (same md5, same session id); only 5 runs differ, and between them they
  contribute one extra `sleep 5`. Summing both doubles everything. That produced "191 waits in
  2,263 codemode cells = 8.4%" — where 191 is the correct count for the *whole* corpus (all
  three arms) and 2,263 is 1.6× the entire corpus of 1,410 tool calls. Real rate: **13.8%**.
  This failure mode has now bitten the project repeatedly in different costumes — a duplicated
  run directory here, `stream.jsonl` retaining an abandoned session there (47 ipython events
  where `trajectory.json` and `.cells/` both say 32). **Before quoting a rate, count the
  denominator's runs and check them for duplicates and multiple `session` records.**
- **Classified waits with a detector that could not see through cell-defined helpers**, and
  reported the residue as "both / unclassified: 14". `time.sleep(400); status()` waits on a
  Maven build, but only if you resolve `status()` to the cell that defined it. Resolving helpers
  moves own-process work from 16 (9.1%) to **40 (20.6%)** and unclassified to **0** — and
  weakens the argument built on the old number, that `submit` "addresses the other 9%". It is a
  fifth of all waiting, not a rounding error.
- **Two analysis bugs, both returning clean wrong answers**, which is the
  house failure mode: a literal `api.` match missed aliased imports
  (`import api.reddit as reddit`), and `symtable.get_children()[0]` on Python 3.14
  is an `__annotate__` scope (PEP 649), not the wrapper function — that one
  reported a tidy 0% carry-over across all 5,540 cells. Both fixed; the analyzer
  now cross-checks static detection against the proxy log and prints the ratio.

- **Specified auto-rehydration, and building it made the case against it.** §5 binds
  every job back to its name in a fresh kernel. Implemented, tested, then deleted.
  Every failure mode §5 goes on to handle — shadowing (`batch = "done"`), aliasing
  (`b2 = batch`), burial (`js = [submit(c) for c in calls]`), names that are not legal
  Python identifiers — exists *only because* of the binding. Remove it and the entire
  family goes with it, along with the constraint that a handle may live at a bare name
  and nowhere else.

  It also fails §5's own stated test. The reason given for making rehydration visible
  is that "invisible reconstruction produces an agent reasoning confidently about a
  binding that isn't what it thinks" — but a name that silently changes identity across
  a kernel death *is* that hazard, not a mitigation of it. A job is durable state in a
  file; a lookup is honest about that and a local variable pretending to be it is not.

  What a fresh kernel actually needs is not its old names back but the knowledge that
  the work exists, which is one line of `manifest()` at startup plus `jobs.get(name)`.
  Dropping the binding also removed the identifier restriction as a side effect —
  `my.job-1` is a fine job name now, because it is a key rather than a variable.

  One further note on why it was proposed at all: the argument was that 0 of 6,269
  cells use `%whos`, so the model won't re-establish state itself. Wrong evidence
  class — `%whos` is a *pull* affordance, and the manifest is *push*. Push
  demonstrably works (`q7+full ns`: 0.747 → 0.776, duplicate calls 25% → 3%), so an
  agent handed the name every turn will write the lookup.

  The general form, worth keeping: **a convenience that reconstructs local state is
  paying in failure modes for something a lookup gives away free.** Prefer the lookup.
