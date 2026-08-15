# Cloud harness design — the host side

Companion to `HOSTED-RUNTIME-DESIGN.md` (kernel lifetime, jobs, waits — the
*inside* of a turn). This document is the *outside*: what owns sessions, what
survives crashes, what wakes a sleeping agent, and which architecture pattern
we commit to. Written 2026-08-15, after the code review
(`CODE-REVIEW-2026-08-15.md`), the prime daemon deep-read, and Anthropic's
Managed Agents engineering post ("Scaling Managed Agents: decoupling the brain
from the hands"). We are NOT building on Managed Agents — we are adopting the
pattern where it wins and rejecting it where it doesn't.

## 1. The two patterns, and the one thing they disagree on

**Managed-Agents pattern:** three virtualized components — Session (append-only
event log), Harness (stateless loop, cattle), Sandbox (execution env behind a
tool interface). The log is the *only* truth. A harness crash is recovered by
starting another harness and replaying the log. A sandbox crash is a tool-call
error the *model* sees and retries. Credentials are injected at egress, never
resident in the sandbox.

**Prime pattern:** client → per-user supervisor daemon → per-session worker
that owns the live `AgentSession` (loop + kernel + tools in one process).
Truth is distributed: session JSONL *plus* worker memory *plus* the journals
that patch the gap — command-recovery journal (exactly-once commands against a
live process), worker-recovery journal (who was mid-turn), and an
update-restart manifest that serializes `wasStreaming / wasCompacting /
wasBashRunning / hadRunningRlmChildren` so a new worker can impersonate a dead
one. All well-engineered; all existing **only because the worker is a pet**.
Prime's own protocol header concedes the shape ("not the final remote gateway
protocol… a future gateway can wrap this local transport").

The disagreement is singular: **where does truth live between turns?** Every
other difference (journals vs replay, drain choreography vs kill -9, 18k lines
vs a small scheduler) is downstream of that.

## 2. Why codemode is the agent for which the decoupled pattern is cheapest

The honest defense of prime's coupling: colocated loop+kernel makes each action
a function call. A tool-calling agent at ~40 calls/task would pay ~40 network
round-trips across a decoupled `execute()` boundary — for that agent the
coupling is load-bearing, and MA pays it deliberately for the scaling win.

Codemode measured: **1.00 actions per turn, ~9 turns per task** (AppWorld,
n=432), and ~5k first-turn context vs ~100k. The representation collapses 40
dispatches into 9 chunky cells, so the decoupled boundary costs codemode ~9
hops where it costs a tools arm ~40 — and the stateless-harness move
("rebuild from the log") is nearly free when the per-turn log is one cell plus
what the code chose to print. **The representation choice and the architecture
choice compound.** This argument is additive to the explainer's thesis and is
not made in Anthropic's post (their harness is tool-calling).

## 3. The committed architecture: prime-shaped turns, MA-shaped seams

Split at the turn boundary:

**Within a turn — coupled (prime-shaped).** Loop + kernel colocated in one
process; cells are function calls; extensions in-process. This is where all
our measurements live (cost = actions × context; warm-kernel latency 33–41s
end-to-end) and where coupling earns its keep. No change.

**Between turns — decoupled (MA-shaped).** The turn boundary is the ONLY
durable commit point. Everything that crosses it must be derivable from disk:

- the transcript (already prime's JSONL),
- the jobs store (`runtime/jobs.py`, file-backed by design),
- kernel state — explicitly NOT durable; `HOSTED-RUNTIME-DESIGN.md` §5
  ("there is no rehydration") already commits to rebuild-not-restore, and the
  restart notice tells the model what died.

A **wake scheduler** is the one new component: (job finished ∨ deadline hit ∨
scheduled time reached ∨ user message) → re-invoke a fresh harness on the
session. Small by construction, because it never has to coordinate with a live
process — there is none.

### 3.1 The invariant (test this, don't document it)

> **SIGKILL-replay:** after `kill -9` of every harness/kernel/job process at
> any instant, a fresh harness reading only the disk must reach a correct
> state: finished jobs report finished, dead jobs report dead-with-evidence
> (never `running`), the next turn is constructible, and no action is executed
> twice.

Per the repo's own rule ("a documented check is not an executed check"), this
ships as a test — a chaos harness that kills the process tree at random points
in the jobs lifecycle and asserts the replay — alongside the existing fairness
and pristine-replay suites. The code review's P2 findings are all instances of
this invariant failing today:

| review finding | invariant violation |
|---|---|
| H2 — evicted job `running` forever | completion truth lives in the dying process (exit marker), not derivable from disk |
| H3 — killpg on stale pid | identity truth (pid) not validated against disk-recorded start-time |
| M3 — no fsync | rename visible, data not durable |
| M6 — config frozen at import | assumes process ≡ session |
| M5 — kill-then-resubmit double-run | "did it start?" not answerable from disk |

Fixing them is not five patches; it is one principle applied five times.

### 3.2 Failures surface into the model loop, all the way down

The guard result (correction-in-the-error-channel → adoption next cell,
measured repeatedly) generalizes: kernel death, sandbox provisioning failure,
and job-host loss are *model-visible events with recovery instructions*, not
infra choreography. The kernel-restart notice ("variables are gone; jobs still
running: build, coq16") is the template. Anything the infra silently "handles"
is a place the model can't help; anything surfaced with the right error text
is a place we've measured that it does.

### 3.3 Credential boundary as a hard rule

API credentials live host-side; the kernel reaches the world only through the
`_client` transport (already true in the bench). Promoted to invariant for the
product port: **no secret is resident where agent-authored code executes.**
Injection happens at the transport/egress, MA-style. (Motivating incident
from the base-harness audit: prime's `resolve-config-value.ts:29-33` executes
credential values beginning with `!` as shell — the coupled pattern's
credential story is exactly what we must not inherit.)

## 4. What we take from prime, what we drop

**Take:**
- The print-mode loop + kernel + extension host (the measured harness).
- The session-lease pattern — `pid` + `processStartId`
  (`/proc/<pid>/stat` field 22 / `ps lstart`) with atomic
  mkdir-candidate+rename acquisition (`core/session-lease.ts`). This is
  the direct fix shape for review finding H3, lifted nearly verbatim into
  `jobs.py`.
- The one-line settings kill-switch for auto-refine (review P0.2) while the
  refinement subsystem is excised.

**Drop (do not port, do not imitate):**
- The daemon protocol, both recovery journals, the update-restart manifest,
  supervisor ownership/fencing — solutions to the pet problem the architecture
  no longer has.
- The per-uid shared daemon socket and everything downstream of it.
- Product subsystems per the base-harness audit (interactive UI, agents-view,
  ACP, package manager/self-update, telemetry/traces, migrations-on-`-p`).

**Steal the *idea* only:**
- Cron/heartbeat with `steer` vs `follow_up` delivery — our wake scheduler
  wants the same two delivery modes eventually (interrupt a running turn vs
  queue behind it), but as scheduler features over the log, not as
  daemon-process features.
- Idle eviction thresholds (`canEvictWorker`) — becomes trivial when the
  worker is stateless: evict always, on every turn end; "idle eviction" stops
  being a policy and becomes the default.

## 5. Components (target shape)

```
┌────────────┐   turn request    ┌──────────────────────────────┐
│   wake      │ ────────────────▶ │ harness (stateless, per-turn │
│  scheduler  │                   │  or per-burst): prime loop    │
│ (job done / │ ◀──────────────── │  + kernel + extensions        │
│  deadline / │   turn committed  └──────────────┬───────────────┘
│  cron /     │                                  │ function calls
│  user msg)  │                   ┌──────────────▼───────────────┐
└──────┬─────┘                    │ kernel (rebuildable) +        │
       │ watches                  │ jobs runtime (file-backed) +  │
┌──────▼──────────────────────┐   │ api/ modules + _client ───────┼──▶ egress proxy
│ session store (the truth):  │   └──────────────────────────────┘    (creds injected
│ transcript JSONL + jobs     │                                        here, throttle,
│ manifest + artifacts        │                                        audit)
└─────────────────────────────┘
```

- **Session store** — transcript + jobs manifest + artifacts on disk (or any
  durable KV/blob later; the interface is "files").
- **Harness** — prime's loop invoked per wake; reads the log, runs one turn
  (or a burst until `wait`), commits, exits. Eviction = process exit.
- **Kernel** — per HOSTED-RUNTIME-DESIGN.md; prewarm pool per the cold-start
  measurements.
- **Wake scheduler** — watches jobs manifests + deadlines + cron entries +
  inbound messages; enforces the lease before invoking a harness.
- **Egress proxy** — credential injection, throttling, audit (already
  required by HOSTED-RUNTIME-DESIGN.md §4's shell-condition design).

## 6. What this resolves

- **D2 (cloud substrate):** our loop + log-as-truth + small wake scheduler.
  Neither prime's daemon nor a Managed-Agents dependency.
- **D1 (subagents):** children are sessions under the same scheduler; `spawn`
  submits a child session + wake registration. The jobs substrate already
  models this (`subagents.py` builds on jobs); the staging gap (review P1.8)
  is fixed as part of PR-3 rather than by adopting prime's rlm-runtime.
- The review's PR-3 (hosting correctness) gets its spec: implement the
  SIGKILL-replay invariant, then the point fixes fall out of it.
