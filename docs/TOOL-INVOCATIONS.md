# Tool invocations and owed items

Companion to `CLOUD-HARNESS-DESIGN.md` (the scheduler, two-phase delivery) and
`HOSTED-RUNTIME-DESIGN.md` (jobs, waits). Code: `runtime/invocations.py`.

## The problem

Three things tracked work a session started, each on its own:

|                               | record                                     | who wakes on it                                        |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| sync proxy / host calls (#25) | per-cell `calls.jsonl` + the host's memory | nobody; read once when a kernel dies                   |
| background jobs, stream jobs  | `jobs/<name>.json`                         | the scheduler, only if the latest `wake.json` names it |
| subagents                     | a job record + broker request + mailbox    | same                                                   |

`wake.json` is overwritten by every `jobs.wait`, and the scheduler wakes only on
what the latest one names. So a job the agent started and never waited on could
finish with nothing waking the agent and nothing recording that its result was
still owed. There was no notion of a result having been _delivered_, and no
per-tool rule for what a retry may do.

## The model

One record per piece of work a session started: an **invocation**. The store is
`<job_dir>/invocations/`, one JSON file per invocation, written like job records
(temp file, fsync, rename, fsync the directory). Python owns it; hosts reach it
through `scheduler.py`.

```
id            stable across retries; derived from something already persisted
kind          call | job | subagent | approval
name          tool name ("server.tool", host request type) or job name
params_hash   sha256 of the canonical params; params_ref points at where they live
delivery      idempotent | lookup | at_most_once | at_least_once | read_only
backend       inline | local_job | temporal
state         pending -> running -> succeeded | failed | unknown | cancelled | expired
outcome       {summary, exit_code?, error?}
blocking      the agent's current choice (see waking); not fixed at creation
deadline      epoch seconds or null
created_at, started_at, finished_at, updated_at
delivering    run id of the turn carrying the outcome to the model, or null
delivered_at  when the model was given the outcome, or null
```

**Identity.** Never generated on retry:

- a job or subagent: `job:<name>@<started_at ms>` — `started_at` is written to
  the job record before anything is spawned, and recovery reads it back;
- a sync call: `call:<execution id>:<seq>`, #25's identity, where the execution id
  is the cell's message id and `seq` its position among that cell's calls. A cell
  is never re-run once started (#20), so the pair is never reissued.

**UNKNOWN is first-class.** A request that was sent with no answer recorded, or a
claim with no outcome whose writer is dead, is `unknown`. It is terminal (nothing
will resolve it by waiting) and is shown to the model as _may or may not have taken
effect — verify before retrying_. A job whose process died without an exit marker
is `unknown` for the same reason.

## Delivery modes

Declared per tool in a JSON file named by `HARNESS_TOOL_DELIVERY`
(`{"server.tool": "read_only", "server.*": "idempotent"}`); exact name beats
`server.*` beats the default. **The default is `at_most_once`**, because an
unknown tool may have side effects.

| mode            | before acting                                                    | on a retry after a crash or lost answer                          |
| --------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `read_only`     | nothing durable is required                                      | resend freely                                                    |
| `idempotent`    | record the intent; send the invocation id as the idempotency key | resend with the same key                                         |
| `lookup`        | record the intent                                                | ask the tool by id first; resend only if it says it never saw it |
| `at_most_once`  | **claim and fsync before sending**                               | never resend; a claim without an outcome is `unknown`            |
| `at_least_once` | act, then record                                                 | resend; only for tools where a duplicate is harmless             |

A transport failure _before_ the request left (connection refused, no route) is
known-not-sent: the outcome is `failed` with `not_sent: true`, and a retry is safe
in every mode.

`invocations.call_inline()` implements the table for Python callers. The kernel's
proxy wrapper (`scripts/patches/call-journal.py`, #25) is the chokepoint for a
local kernel's tool calls: it already wrote its "call" line before the request
left; it now carries the invocation id and delivery mode, and fsyncs the line for
every mode but `read_only`. It never retries; it only records.

## Backends

One interface, `submit(invocation) -> events`; events are `(state, outcome)`
transitions the store applies.

- **inline** — a synchronous call (proxy, host request). Its events are the lines of
  the call log (`call` = claim/running, `end` = outcome). The call log is the
  inline backend's append-only event stream; the store folds it into records
  (`InvocationStore.fold_call_log`). There is one journal: the host's dead-cell
  report (#25) and the store read the same file.
- **local_job** — today's `jobs.py` subprocesses and brokered subagents. The job
  record stays as the backend's private state (pid, log, exit marker, request
  file); every write of it projects onto the job's invocation record
  (`JobStore._write` is the one place). The agent-facing `jobs.*` and `agents.*`
  APIs do not change.
- **temporal** (optional, off by default) — one workflow per invocation, workflow id
  derived from the invocation id, activity retry policy chosen by the delivery mode.
  See `runtime/invocations_temporal.py` once it lands.

## Owed items and waking

An invocation is **owed** when it is terminal and `delivered_at` is null.

- **Blocking** items wake as a set: the barrier fires when all are terminal
  (whatever their outcome). `jobs.wait(names...)` marks the named items blocking
  and every other item watching — recomputed on every wait, so it is the agent's
  current choice.
- **Watching** items wake individually: any watching item that is owed wakes the
  session, whether or not a wait is pending. This is what makes a job the agent
  started and never waited on wake it when it finishes.
- **User messages and interrupts** always wake, regardless of the barrier.
- **Deadlines.** An invocation past its deadline becomes `expired` and is owed. A
  job's `max_runtime` is its deadline. The session deadline (#26) is unchanged and
  outranks everything.

Delivery is part of the woken turn and uses #24's two-phase shape: the scheduler
marks the owed items `delivering: <run id>` before the run, lists them in the wake
message, and marks them `delivered_at` when the run returns. A turn that crashes
is recovered by clearing `delivering`, so the next wake carries them again — a
duplicate beats a loss. An outcome the agent reads for itself during a turn
(`jobs.get`, a handle's state, `jobs.list`) is delivered by that read. A dead cell's
calls are delivered by the dead-cell report.

Other hosts keep calling `scheduler.reason_for(request)` / `--reason-for-request`;
the request in `wake.json` gained only fields (`invocations`, `blocking`), so an old
reader still works. A host that marks delivery — print-mode self-wake and the
subagent launcher (`--consume`, `decide_owed` + `mark_owed_delivered`) — gets the full
owed rule, in one phase (it has no turn record to roll back). A host that does not
(`reason_for`, `--reason-for-request` without `--consume`: RPC hosts, the Daytona
provider) is woken only by owed items that ended after its wait was armed, so the
same undelivered item cannot wake it on every wait; such an item is still listed
the next time the scheduler or a consuming host wakes the session.

## What is not covered

Files, subprocesses and network traffic a cell causes directly are not
invocations. Host-owned subagents (the gateway broker's) are facts the host passes
to `reason_for`, not records in this store. Calls through a remote kernel's tool
tunnel and host requests are journaled in the host's memory (#25) and are durable
only through the dead-cell report.
