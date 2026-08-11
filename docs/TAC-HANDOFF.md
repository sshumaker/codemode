# TheAgentCompany — status, findings, and the logging plan

Written before a context compaction. Everything a fresh session needs to pick
this up, plus the design discussion that was in flight.

---

## 1. Where things stand

**The full 40-task sweep is complete: 80/80 runs graded, 0 ungraded, 0 timeouts.**
All artefacts are in `.run/tac/<runId>/`.

| | codemode | vanilla |
|---|---|---|
| checkpoints scored | **68.6%** (133/194) | 65.5% (127/194) |
| raw checkpoints (ignoring TAC's bonus strategies) | **70.7%** (99/140) | 68.6% (96/140) |
| fully solved | **19/40** | 17/40 |
| cost | **$12.20** | $12.58 |
| tool errors | **1** | 33 |

**Paired: codemode − vanilla = +0.035, t=0.99, 33 of 40 tasks exact ties.**

Read that as **parity**. The MCP-Bench result (+0.050, t=+2.14) does *not*
transfer to office work. The durable differences are the tool-error count and
equal cost in fewer turns — neither of which the score captures.

### Claude Code, on the 8-task disagreement subset

`cm 0.775 / van 0.583 / claude-code 0.529`, $10.07 for 8 tasks. Selected for
disagreement, so **not comparable to full-set means** — it is a tiebreaker.
Claude Code matched **vanilla on 4 of 6** disagreements and codemode on 2, which
says codemode's wins are the unusual results rather than vanilla's losses. Both
controls behaved (both-solve → 1.00, both-fail → 0.00).

---

## 2. How to run it

```bash
bash bench/tac/provision-agent-volume.sh          # one-time, ~5 min
node bench/tac/sweep.mjs ~/src/goals/web/.env.local --tasks a,b,c
node bench/tac/watchdog.mjs --interval 120 --halt &
node bench/tac/report.mjs                          # per-checkpoint, not just totals
node bench/tac/claude-code-sweep.mjs <env> --n 6 --controls 2
```

Env file is `~/src/goals/web/.env.local` (note: `.env.local`, not `.env` — an
earlier search for `.env` missed it and silently used a different key).

### Architecture

The **real harness runs inside the task container** — not a reimplementation.
`provision-agent-volume.sh` stages into the `tac-agent` volume: node 22, Claude
Code, the whole prime-agent tree (`dist/cli.js`, the same entry MCP-Bench uses),
and a kernel venv with ipykernel + `prime-agent-runtime` (imports as `rlm`) +
prime's 12 default packages + every skill.

- **codemode** — `--tools ipython,edit`
- **vanilla** — `--tools bash,read,edit,write,grep,find,ls` (prime's real built-ins)
- **claude-code** — its own CLI, `IS_SANDBOX=1` (containers run as root)
- **Skills are ENABLED.** `--no-skills` removes `attach_image` (the only way a
  multimodal model can see a file) and `edit` (whose uniqueness contract is the
  entire tool).
- `/agent` mounts **read-only**; grading happens in a **pristine container**.

Pipeline per run: container → `init.sh` (seeds services) → arm → upstream
`eval.py` in a fresh container. Only the arm is substituted, so scores are TAC's.

---

## 3. Bugs found (all fixed; each produced a plausible number, not an error)

1. **Reimplemented harness.** First version hand-rolled the ipython kernel over
   `docker exec` and the vanilla tools. Measured the clone, not the harness, and
   silently dropped image attachments — a multimodal model went blind on ~35% of
   tasks. Fix: run the real binaries in-container.
2. **`--no-skills` blinded codemode.** Also true on MCP-Bench, so **0.809 there
   was measured on a deliberately reduced harness**. Probe: 19 turns + wrong
   answer → 5 turns + exact once `attach_image` was available.
3. **Expired GitLab token.** Images hardcode `GITLAB_ACCESS_TOKEN="root-token"`,
   which expired 2025-11-18. Affects 71/175 tasks. `populate_data.py` iterates
   the error dict and dies with `TypeError: string indices must be integers`,
   which reads like a code bug. `reset.sh` restores the expiry, and the window is
   *inside* `init.sh`, so renewal runs as a **3s keepalive loop during seeding**
   (direct SQL: 0.2s vs ~25s for `gitlab-rails runner`).
4. **No per-cell timeout.** `bash` exposes one; `ipython` had none. All three
   codemode timeouts were one wedged cell eating a 40-min budget with ~5% spent
   executing. Kernel already had `interrupt_request` wired to abort — nothing
   triggered it. `HARNESS_CELL_TIMEOUT_MS` (default 600s) now does, and
   **tells the model** — a silent interrupt is worse than a hang, because the
   agent reported a `sleep(600)` cut at 45s as "completed with no output".
5. **Disk exhaustion, twice, different causes.** Image pulls (fixed by pre-task
   prune at ≥50%) then agent build activity mid-task (fixed by the watchdog
   **reclaiming at 82%** instead of halting).
6. **Watchdog false positive.** Halted a healthy sweep because GitLab was
   mid-`reset.sh`. Now needs 6 consecutive bad checks (~12 min).
7. **Resume skipped ungraded runs.** A failed run writes `result.json` with
   `graded:false`, so infrastructure failures became permanent dataset holes.
   Resume now retries anything ungraded.
8. **`docker cp` copies *into* an existing dir.** Bit twice: staged `/workspace`
   handed a previous attempt's artefacts to the grader (a crippled 12s run scored
   3/3), and `packages/` became `packages/packages`.
9. **`--system-site-packages` hid an incomplete venv.** pip saw `pandas` in the
   provisioning image and installed nothing; the check then imported it from the
   system and reported success. Fix: `--ignore-installed` + verify on a *second*
   image.
10. **`find_spec` doesn't execute a module** — certified a `jupyter_client`
    containing a syntax error. Verification now really imports.
11. **Agent corrupted the shared harness** via `edit` on `jupyter_client` inside
    the writable volume. Hence read-only.
12. **My own comment broke the provisioner** — an apostrophe in "image's" closed
    a single-quoted `bash -c`, so half the venv setup ran in the outer shell.

### Benchmark properties to record with any result

- **26/175 tasks grade at least one checkpoint by LLM**, judged here with Sonnet
  (upstream used gpt-4o).
- `bonus_for_completing_final` / `bonus_for_completing_any` inflate totals —
  `hr-check-attendance-one-day` reports 3/3 for both arms while both fail
  checkpoint 1. **Always read `report.mjs`'s raw line, not the total.**
- **`admin-arrange-meeting-rooms` is mis-keyed**: reference answer 4, correct
  answer 5 (five meetings overlap 12:00–12:15). Excluded from the subset.
- **`pm-schedule-meeting-2` is questionable**: the two required NPCs never
  replied to *any* arm. Codemode and Claude Code both waited and reported "no
  meeting"; vanilla scheduled Friday unilaterally and took 3/3. Rewards acting
  without information.
- **MongoDB swapped** to official `mongo:5.0` (arm64) — Bitnami is amd64-only and
  MongoDB 5.0 needs AVX, which Rosetta lacks. Fixture differs from upstream.
- **The benchmark leaks the env-LLM API key** to the agent (`run_multi_npc.py`
  interpolates it into a shell command → visible in `ps` and `/tmp/npc.log`).
  Use a throwaway key.
- Tasks **cannot run in parallel** on one service stack: every `init.sh` calls
  `reset.sh`. Parallelism needs one stack per worker on its own Docker network
  with an edge proxy aliased to `the-agent-company.com` (hostname *and* ports are
  baked into `external_url`, `ROOT_URL` and task prose).

---

## 4. THE LOGGING PLAN — mostly DONE

**Status: §4.1, 4.2, 4.3, 4.4, 4.5, 4.6 all implemented.** Per-run artefacts now:

| file | contents |
|---|---|
| `service-calls.jsonl` | every HTTP call the agent made: method, URL, headers (auth redacted), request body, status, response body, duration |
| `world-before-grading.json` | service state the grader is about to read — RocketChat channels/DMs with full transcripts, GitLab issues/MRs/milestones/branches, ownCloud listing, Plane projects; scoped by `dependencies.yml` |
| `judge.jsonl` | every LLM-judge call with its exact input content, predicate, verdict, model |
| `npc-out/` | per-NPC stdout — the colleague's side of every conversation |
| `system-prompt.json` | base prompt, appended preamble, exact tool list |
| `trajectory.json` | every event, each stamped `_t` on receipt (was 1 timestamp in 125) |
| `result.json` → `phases` | container up / seed / agent / grade wall-clock boundaries |
| plus | `stream.jsonl` (raw), `seed.log`, `grader.log`, `stderr.log`, `workspace/` incl. `.cells/`, `env.json` |

Implementation notes worth keeping:

- **The proxy is a forward proxy** (`http_proxy` on the agent's exec only), not a
  transparent one. Port-shadowing on `127.0.0.2` cannot work: `--network host`
  plus services bound to `0.0.0.0` occupies every loopback address:port. Seeding
  and grading stay direct, so only agent traffic is recorded.
- The proxy **verifies it is listening** before the agent starts. An unrecorded
  run otherwise looks identical to a recorded one.
- **NPC launching now replaces `run_multi_npc.py`** rather than supplementing it —
  that script loops the same `scenarios.json` keys into `run_one_npc.py` with
  stdout to DEVNULL. Running both would put two bots in every conversation.
- `bench/tac/rejudge.mjs <env> --k 5` replays recorded judge inputs offline and
  reports stable / unstable / flipped per predicate. Decide the rule for handling
  instability *before* seeing which arm it favours.

### Original plan (for reference)


Audited state. **Captured:** tool inputs and outputs, every assistant message
with usage, raw stream, every executed cell, seeding output, grader stdout+stderr,
judge inputs/outputs (`judge.jsonl`, added last), final `/workspace`, image digest
and versions.

**Five gaps, in priority order.**

### 4.1 Service calls and responses — the big one

Today we record the agent's *code* and whatever it chose to `print`. If it
doesn't print a response, it is gone. MCP-Bench had `mcp-calls.jsonl` from the
proxy; TAC has no equivalent. This is the same class as the judge-input gap: we
log what the agent said about the world, not what the world returned.

**Build an egress proxy inside the task container**, logging every request and
response to the company services.

- Route the container's traffic to `the-agent-company.com` through a local proxy
  process (the container already has `/etc/hosts` pointing that name at the
  service host — point it at the proxy instead, and have the proxy forward).
- Log per call: timestamp, method, URL, request headers (redacted), request body,
  status, response headers, response body (truncated with a recorded original
  length), duration, and which arm/run.
- Write to `/tmp/service-calls.jsonl`; copy into the run dir at teardown.
- **This is also where credential injection lands** (see §5) — building it for
  logging buys the mechanism for secrets later.

Care: must not break WebDAV/large downloads (stream, don't buffer); cap bodies;
never log the `Authorization`/`X-Auth-Token` values.

### 4.2 Final service state snapshot

Only `/workspace` is copied, so any disputed **rule-based** verdict is as
unreproducible as the LLM one was. After the agent finishes and **before**
grading, dump the state the checkpoints read:

- RocketChat: channel + DM history for rooms touched (`channels.history`,
  `im.history`), user list
- GitLab: projects, issues, MRs, milestones for the task's repos
- ownCloud: file listing (+ hashes) under the task's paths
- Plane: issues/projects for the workspace

Write `world-before-grading.json`. Scope by the task's `dependencies.yml` so it
stays cheap.

### 4.3 Timestamps — currently 1 of 125 events

Stamp every stream event on receipt when writing `stream.jsonl`/`trajectory.json`
(`{"_t": <iso>, ...}`). Cheap, and it is why locating a 2,300s hole took
inference from `durationMs` instead of reading it off. Also record: container
start, seed start/end, agent start/end, grade start/end in `meta.json`.

### 4.4 The assembled system prompt

`prompt.txt` holds only our preamble. Prime's own base prompt, skill
descriptions and the tool schemas actually sent are not recorded, so "what did
the model see" is only reconstructable from source at that commit. Dump the
resolved prompt + tool list once at session start (`system-prompt.txt`,
`tools.json`).

### 4.5 NPC conversation content

`npc.log` is 1,449 bytes of launcher output — 10 launch lines, **zero
conversation**. When `pm-schedule-meeting-2` failed because colleagues never
replied, that had to be inferred from the agent's own polling. Capture each NPC's
stdout/stderr to `/npc/<name>.log` and copy them out. (§4.1 partly covers this
via the proxy, but the NPC side of the conversation is server-side.)

### 4.6 Then: k-sample re-judging

With `judge.jsonl` in place, add `bench/tac/rejudge.mjs` to replay recorded judge
inputs k times offline (no agent runs, no live services) and report agreement.
Apply a stated rule — e.g. LLM-judged checkpoints require k=3 agreement — decided
**before** looking at which arm it favours.

---

## 5. Design notes: the wait/wake affordance

> **Full working-out in [`HOSTED-RUNTIME-DESIGN.md`](./HOSTED-RUNTIME-DESIGN.md)** —
> the boundary rule that organises all of this, the `Call` design, the API shape,
> rehydration, the ceiling-placement correction to this section, offline
> measurements over `.run/runs`, and a list of wrong turns not to repeat. This
> section is the compressed version plus the trace evidence.

From the parallel session (`b29a3a9b-…`) plus what this run's traces showed. The
empirical case: on `pm-schedule-meeting-2` the agent wrote **~3050s of in-cell
`sleep`**, spawned **4 daemon poll threads** that raced on one dict and were never
stopped, and re-dumped chat history in 13 of 32 cells (**88% redundant**: 24
message tuples, 3 unique, one read 8 times). All three of its "slow" runs were
one wedged cell, not per-turn latency (~5.5s/turn in isolation).

**Established:**

- *Nothing registered for the future may close over the kernel namespace.* The
  agent violated this four times unprompted — the in-distribution pull toward
  `threading.Thread` is strong, so **block it and error with the correct pattern**
  (override `threading.Thread.__init__`, `subprocess.Popen`, `os.fork`,
  `time.sleep` > ~30s; import-blocking is worse, libraries import `threading`).
- *Borrow the shape, refuse the type.* `await`/`add_done_callback`/Go's `select`/
  TS promises all import in-process liveness. Erlang's mailbox is the only
  mainstream idiom already out-of-process.
- **Anything that suspends keeps the frame** — generators, coroutines, context
  managers, blocking calls. So the Python equivalent of `select` is *no call at
  all*: register interest, end the turn, be re-entered, read the delta.
- **The handle is a view over control-plane state, never the owner of the work.**
  That is what lets the same object be both `await`-able (fast path) and
  `wait()`-able (long path) and survive snapshot/restore, which `asyncio.Task`
  cannot.
- **Bind handles before the wait.** `jobs = [...submit(...)]` executes and
  survives; `wait(jobs, …)` is terminal and returns nothing; on wake read
  `jobs[i].value`. No assignment to reconstruct, no generated names, no parsing.
  (Though the namespace-provenance regex already parses tuple targets if needed.)
- **`wake_after=` not `timeout=`.** `timeout` conflates *stop waiting*, *kill the
  work* and *call it an error*. Split: `max_runtime=` at submit (about the work),
  `wake_after=` at wait (about the agent's attention), explicit `kill()`.
  Single-shot — the agent re-arms — because recurring subscriptions are the
  thread leak in a new costume. Backstop is the **task** budget, not per-wait.
- Ceiling on the in-kernel path lives in `Job.__await__` (no asyncio hooking;
  `gather` inherits it). **60s**, justified by data: legitimate compute cells
  topped out at 45–53s, every *wait* was 120–235s. It is the line between
  computing and waiting.
- For sets, mirror `asyncio.wait` — `(done, pending)`, no cancellation. Do **not**
  borrow `asyncio.wait_for`'s name for something that doesn't cancel.
- `gather(..., return_exceptions=True)` already answers partial failure.

**Open:** whether `submit` is the primitive or a consequence of wake-on-condition;
whether cancellation is expressible (four leaked pollers say it must be);
what the agent sees on wake (must be a delta, or we rebuild the 88% redundancy).

---

## 6. Corrections I made and should not repeat

- Claimed `pm-create-teammate-channel-from-spreadsheet` was LLM-judge noise. It
  was not — both arms posted byte-identical text and it judges **False 10/10**.
  The difference was the surrounding channel history in the judge's input, which
  I had not logged and which `reset.sh` had destroyed. **Cause now permanently
  undeterminable for that run.** I then hung a broader claim ("parity with an
  untested error bar due to judge noise") on it — unevidenced. Parity stands on
  t=0.99 and 33/40 ties.
- Ran a 40-task sweep after validating on 4 fast near-ceiling tasks. Every
  subsequent failure lived in the `sde-*`/GitLab tasks the validation set did not
  contain. **Validate on a stratified set, and read the trajectories.**
- Sat idle ~6h waiting on a scope question that was already answered.
