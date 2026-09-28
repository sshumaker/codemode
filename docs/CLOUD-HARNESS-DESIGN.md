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

### 3.4 Subagent spawn is a request, not a fork

The credential rule above has one consequence sharp enough to name: **a subagent
is a brain**, so it may not be started from the kernel. `spawn()` originally
`Popen`'d the child's prime loop as a descendant of the kernel, which put a
credential-holding model loop inside the sandbox and handed it the kernel's
environment — and once that environment is built from an allow-list
(`HARNESS_KERNEL_ENV_ALLOW`, eval task `keyleak`) the child fails as a *weak
subagent* rather than as a harness error, which is the failure shape this
project keeps paying for.

So `spawn()` writes a REQUEST (`jobs.submit(via_broker=True)`, job state
`requested`) and `runtime/subagent_broker.py` — running in the loop's world, with
the loop's environment — claims it and starts the child `setsid`-detached, so it
outlives the broker, the loop and the kernel. **The agent-facing API does not
move**: `spawn` still returns immediately, and the result still arrives through
`jobs.get(name)`, because a brokered job records itself on disk exactly like any
other job (pid file, exit marker, log).

Exactly-once is the request file itself: brokers claim by `rename`, which two
processes cannot both win — the same token the scheduler's `wake.json` ->
`wake.json.fired` uses. A pre-fork *intent* marker makes the one genuinely
ambiguous window nameable from disk, so recovery never has to guess:

| a dead broker left | what a fresh broker does |
|---|---|
| claim, no intent | nothing was forked — reclaim and launch |
| intent + pid file / exit marker | it launched — adopt, never relaunch |
| intent, neither | unknowable — fail the job and say so, do not retry |

The last row is `submit`'s `starting` rule one level up: refuse to double-run, and
make the ambiguity visible instead of resolving it by guessing. Pinned by
`runtime/test_chaos.py::TestBrokerServicesEachRequestExactlyOnce`, including a
real broker SIGKILLed at each stage of the chain.

Wired today in `runtime/eval/run.mjs` only. The in-container runners
(`bench/tac/run-task.mjs`, `bench/terminal/prime_agent.py`) put the whole brain
inside the sandbox deliberately and have no harness side to broker from, so they
keep the direct path; a kernel that has had credentials scrubbed and no broker
configured now refuses to spawn rather than producing a child that cannot reach
the provider.

### 3.5 The host-request transport (2026-09-28)

The file-backed request above needs a broker that shares the kernel's filesystem. A
remote kernel (Daytona, `runtime/daytona/`) does not, so `spawn()` has a second
transport, `HARNESS_SUBAGENT_TRANSPORT=host`: the same request travels as a
`harness.subagent` kernel host request — the channel prime already runs for every
kernel, local or remote — and `scripts/patches/subagent-host.ts`, in the loop, forwards
it to `HARNESS_SUBAGENT_BROKER_URL` with the loop's egress token and the loop's own
model and thinking level. The broker (the assistant's gateway) owns defaults, caps, the
model allow-list and where the child's kernel runs. `spawn()` stays synchronous: prime
answers host requests on the control channel, which ipykernel serves on its own thread
while the cell blocks (pinned against a real kernel in `runtime/test_subagents_host.py`).

Two waits, both bounded, and the wake is the default. `jobs.wait(*names,
wake_after=..., mode="all" | "any")` — names or handles, varargs or one list — under
`HARNESS_WAIT_MODE=wake` arms a broker-side wake instead of the host sleep: the turn
ends, and the broker resumes the conversation when the named children finish (all, or
the first), when one of them writes to the parent, or at the deadline, and says which.
Unknown names raise at the call, naming the valid ones. With no names the watch set is
every running job, as before; under the scheduler (`HARNESS_WAKE_FILE`) a named wait
also records its mode and each named child's mailbox, and `scheduler.wake_reason`
wakes on a message too. `gather_children(...)` is for short waits only, children
expected to finish within about a minute: it holds the cell for at most its timeout
(default 300 s, under the cell watchdog when one is set) and returns what finished,
with `.pending` naming the rest — it never holds the kernel for a child's whole life,
which is why `spawn` is a job and not an await.

The model-facing surface is `agents` (`runtime/agents.py`): `agents.spawn` returns an
`AgentHandle` (`.result` `.messages` `.send(text, mode)` `.wait(...)`), `agents.get`,
`agents.list`. Messaging belongs to agents, never to job handles. A child's kernel gets
the other end, `agents.report(text)` and `agents.ask_parent(question)` (blocking,
bounded, None on timeout); it has no `spawn`, and reaches its siblings only with
`HARNESS_SUBAGENT_SIBLINGS=1`. Delivery follows prime's agent-message model: `steer`
interrupts the child's turn, `follow_up` queues after it, 16 KB per message, 20
pending. To deliver mid-run, children run in prime's RPC mode, not `-p`: the file and
broker transports' launcher (`subagent_run.py`) keeps stdin open and pumps the child's
mailbox (`runtime/agent_mailbox.py`) into it as `prompt` commands with
`streamingBehavior`; the host transport's broker (the assistant gateway) does the same
over its own RPC connection. prime runs a queued follow-up as a separate run after
`agent_end`, so the launcher closes stdin only when nothing it handed over is
outstanding. The bare `spawn()` builtin is an alias of `agents.spawn`.

Gates: `HARNESS_SUBAGENTS=1` binds `spawn`/`gather_children` (the prelude binds nothing
at or past `HARNESS_SUBAGENT_MAX_DEPTH`, default 1) and registers the loop handler;
without it the host refuses the request type. The broker enforces depth again from the
requesting agent's token.

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

## 7. The boundary posture as built (2026-08-16)

Three things, and they only mean anything together. One module,
`runtime/posture.mjs`, so the eval loop and the benchmark runners can say they
ran the *same* boundary rather than three convergent clones.

| piece | what it does | where it is real |
|---|---|---|
| srt sandbox | what the kernel may read, write, reach | host runners (macOS) |
| kernel env allow-list | the kernel env is BUILT, not scrubbed | everywhere, incl. containers |
| egress proxy | the one route out + `/control/spawn` | host runners; runs fine in containers, but see §7.2 |

The eval loop runs all three on every run. `spawn()` from a cell is now an HTTP
POST to the proxy, which writes the request file the broker already services —
same durability log, different transport. Proven by the `subagent` task, which
greps the run's own audit for the spawn verdict: the job records look identical
whichever door the request came through, so without that assertion a run with
the proxy up and silently unused passes every other check.

### 7.1 The benchmark runners get it behind a flag, default OFF

`--posture` / `HARNESS_POSTURE=boundary`, recorded in each runner's provenance.
Off by default deliberately: every number in `docs/` was measured without it,
and the posture changes things the benchmarks are sensitive to — what the kernel
can read, whether a cell can reach the network, one extra hop per MCP call.
Flipping the default would move measured conditions under a label saying nothing
moved, which is the failure the fairness tests exist to catch.
`bench/test/posture.test.mjs` pins the default and the provenance.

Under the posture, MCP traffic for BOTH arms goes to `{egress}/r/mcp` with the
session token — one door, whichever representation is under test. Measured on
the 6-task quick set: 6/6 completed, all 50 MCP calls in the audit on the `mcp`
route with status 200, cost and turns inside the ~27% noise band against off.

### 7.2 macOS and Linux disagree about loopback, and it is load-bearing

On macOS the kernel reaches the proxy at `127.0.0.1:<port>`, and it works
*because* `allowLocalBinding: true` — which ipykernel's ZMQ already requires.
With it false the connect fails "Operation not permitted". So on macOS all of
loopback is open, not just our port: **the proxy's authority is its token, not
srt.**

**This does not hold on Linux.** srt sandboxes through bubblewrap, which gives
the process its own network namespace, so `127.0.0.1` is not the host's
loopback. Measured inside a container with the proxy provably up: no connection
at all, and an empty audit log.

**The Linux form is a unix socket** (built 2026-08-17). A socket is a path, and
the sandbox shares the filesystem even where it does not share the network
namespace; `allowAllUnixSockets` was already true, so nothing about the posture
had to be loosened to allow it. The proxy takes `--listen-unix <path>` alongside
or instead of `--listen`, one handler behind both listeners, and the address
travels to the sandbox in the form a client needs it:

```
HARNESS_EGRESS_PROXY = unix:/path/to/egress.sock     # Linux, the default there
HARNESS_EGRESS_PROXY = http://127.0.0.1:<port>       # macOS, the default there
```

`runtime/posture.mjs` picks per platform (`defaultEgressListen`), because a
boundary that depends on each caller remembering a flag is several boundaries.
`runtime/jobs.py` speaks both — `http.client` over an `AF_UNIX` socket, stdlib
only, since the kernel's environment is not a place to acquire a dependency.

Measured in a Linux container, from inside a real srt/bwrap sandbox
(`scripts/egress-unix-linux-proof.sh`, which is the re-runnable transcript):

| from inside the sandbox | result |
|---|---|
| socket + the run's token | **201**, and the request file appears harness-side |
| socket + a wrong token | **401** |
| socket + no token | **401** |
| the proxy's own TCP loopback | **unreachable** (`ECONNREFUSED`, the netns) |
| `api.anthropic.com` | **refused** (403 at srt's own tunnel) |

The control matters as much as the probes: the *same* TCP port answers 201 from
an unsandboxed process in that container, so the sandbox's failure is
attributable to the namespace rather than to a dead proxy — the shape of mistake
this project has already made once. The rig needs `--cap-add=SYS_ADMIN` with
seccomp/apparmor/systempaths unconfined for bwrap to unshare inside Docker; that
is acceptable for a throwaway verification container and **not** a posture to
ship (§7.3).

Two details that are load-bearing rather than incidental:

- **A stale socket file is the normal case, not an exotic one.** The harness
  reaps a per-run proxy with SIGKILL, which never runs the unlink, so the next
  run in a reused directory always finds debris. Bind asks the socket first: one
  that accepts a connection is a live proxy and the bind refuses; one that
  refuses is debris and is removed. Both directions are tested, because
  unconditional removal would evict a neighbour's running proxy.
- **`sun_path` caps at 104 bytes** (macOS; 108 on Linux). Run directories are
  named after task, variant and run id, so this is reachable in ordinary use —
  `egressSocketPath` falls back to a short name under `TMPDIR`, and the proxy
  reports the ceiling by name rather than letting `bind()` say "invalid
  argument".

**What the socket does not carry yet: MCP.** `/control/spawn` is reached over it
by `jobs.py`, but the `mcp` route is used by the generated python client and the
vanilla extension, and both speak HTTP over TCP. So `--posture` on the two MCP
runners (`bench/run-task.mjs`, `bench/appworld/run-task.mjs`) pins `listen:
"tcp"` and **refuses outright on Linux** rather than running under a boundary
whose only route out is unreachable — a condition that would surface as an
ungrounded agent, not as an error. Closing that gap means an MCP client with a
unix-socket transport on both arms.

The older **domain-alias** form — alias the proxy in `/etc/hosts`, name it in
`allowedDomains`, and srt's own parent-namespace proxy carries the hop (verified
end to end: 201 with the run's token, 401 with a wrong one, `api.anthropic.com`
still refused) — still works and remains the fallback. It costs a domain entry,
which is a second route out of the sandbox; the socket costs nothing that was
not already permitted.

### 7.3 In a container the posture means less, and says so

The brain lives inside the task container for terminal-bench and TAC, so the
host-side halves do not apply. What remains real is the env allow-list — worth
having, since TAC leaks its env-LLM key into the container by design.

srt is deliberately **not** wired in there. Measured inside both task images it
needs bubblewrap, socat and ripgrep (none present), srt 0.0.71 (the `tac-agent`
volume carries 0.0.55, which fails), and a container launched with
`--cap-add=SYS_ADMIN` plus seccomp, apparmor and systempaths all unconfined.
That buys an inner boundary by materially weakening the outer one, and it is a
decision to take deliberately rather than a flag's side effect. Note also that
the seccomp half is unavailable in a container regardless
(`allowAllUnixSockets: false` cannot apply).

**Both agent volumes currently lack the env allow-list patch**, so setting the
variable in-container is a silent no-op today. `tb-agent` is the sharper trap: it
*does* honour `HARNESS_KERNEL_SANDBOX_*`, so the sandbox half can be switched on
and seen to work while the kernel still inherits `ANTHROPIC_API_KEY` — a run
labelled confined, demonstrably sandboxed, and leaking the key throughout. Both
container runners therefore check the volume's build for the marker and **fail
preflight** rather than run under a boundary they do not have. Re-provision
(`bench/*/provision-agent-volume.sh`) before using `posture=boundary` there.

## 8. Hosted topology (agreed 2026-08-16): orchestrator, worker pool, provider abstraction

The single-machine harness above generalizes to a hosted service along three
pillars. Every interface needed already exists; what changes is where each
piece runs.

### 8.1 Brains are a queue, sandboxes are a pool

The brain is stateless and rebuilds from the session log, so "a brain" is not
a resident process — it is a function any worker executes when a wake fires.
Brains need a **work queue**, not registration.

The sandbox is the thing with placement: files and running jobs live on a
machine. **Sandbox workers register with the orchestrator**, which owns the
session→worker mapping and routes a session's turns to wherever its sandbox
lives. The scheduler (runtime/scheduler.py) is the single-node miniature of
this orchestrator: its lease primitive (pid + process-start identity)
generalizes to worker heartbeats, its directory scan to a real queue, and its
exactly-once rename-claims carry over unchanged. The session log moves to
shared storage (object store) so a brain on any machine can rebuild — a
storage swap, not a redesign, because the log was already the only truth.

Spawn-as-API-call and the egress token (§7) were the load-bearing changes:
they removed the last assumptions that kernel and harness share a filesystem
or an environment.

### 8.2 The sandbox is an abstraction ("hands"), with a certification suite

What the brain needs from hands is five verbs; everything else is backend
implementation detail:

1. **run code** — a kernel/exec channel
2. **stage and read files** — runtime in, artifacts and job records out
3. **run processes that outlive a turn** — and observe them from outside
   (jobs are files + pids inside the sandbox, deliberately)
4. **enforce the network posture** — egress-only-to-proxy, however the
   backend does it
5. **lifecycle** — create, evict, destroy

`SandboxProvider` implementations: **local-srt** (eval, built), **docker**
(TAC/terminal-bench — the in-container harness install is this backend,
built once already), **SaaS** (Daytona/E2B/Modal-shaped: their SDKs are
exactly create/exec/fs; posture is their network-policy config). The pattern
that makes any backend identical: a small self-contained payload runs inside
the sandbox (kernel + jobs.py + prelude — dependency-free Python), and the
harness talks to it over one channel. A provider only has to answer "can you
run a process and expose a socket." On Linux that channel is the unix socket of
§7.2 — never bare loopback, which bwrap's netns makes unreachable, and the
domain-alias only as a fallback.

The certification suite already exists: `sandbox-check` plus the
keyleak/eviction/subagent live tasks run *from inside* and report what the
boundary actually holds. Point them at a backend and get pass/fail on
whether it delivers the posture — that is the acceptance gate for any
provider, instead of its marketing page. The scheduler's one assumption to
break is "I can read the sandbox's files locally": behind the provider it
becomes `provider.fs.read`, and wake-on-job-completion becomes a poll or
webhook per backend — contained, because everything is already files.

### 8.3 Survivorship: one recovery experience, computed, never promised

"Machine died" reuses the kernel-death experience — same notice, different
survivor set. Three configurations of one message:

| lost | memory | files | running jobs | session log |
|---|---|---|---|---|
| kernel died (tested live) | gone | intact | intact | intact |
| machine died, no replication | gone | **gone** | **gone** | intact (off-machine) |
| machine died, files replicated | gone | intact | dead ("machine lost") | intact |

The discipline — the lesson the eviction work taught once already — is that
the notice **reports what is verifiably there, not a promise**. The current
notice hardcodes "your files are intact," true for kernel eviction and a lie
after unreplicated machine loss. The fix: the fresh sandbox enumerates the
job records and files it can actually see, and the notice says exactly that.
Jobs on a dead machine are marked "machine lost" rather than silently
vanishing; the agent decides what is worth re-running. Replication is then a
deployment knob (shared FS buys a better survivorship report), while the
invariant — *the agent is never lied to about what survived* — holds in
every configuration.

Two hard prerequisites: the session log always lives off-machine, and job
records carry enough off-machine (name, command, purpose) that the loss
report is meaningful even when the job's files went with the machine.

Testable the same way eviction was: destroy the sandbox, create a fresh one
under the chosen storage policy, assert the notice matches reality, assert
the agent completes.
