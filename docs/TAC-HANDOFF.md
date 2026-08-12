# TheAgentCompany — status, findings, and the logging plan

> **VERDICT (read first): TheAgentCompany cannot test the code-vs-tool-calling
> thesis.** It ships **zero MCP servers** — grep the repo, there is no `mcp`
> anywhere — so there is no tool catalogue to render either as JSON schemas or as
> importable `api/` modules. The independent variable does not exist here.
> Measured: `import api`/`api.*` appears in **1 of 555** codemode cells (0.2%);
> instead 17.7% use raw `requests`, 15.5% hardcode the service URL and **14.4%
> hardcode credentials in plaintext**.
>
> Worse for the comparison: upstream's own agent (OpenHands CodeActAgent) already
> has an IPython tool, so "codemode" is approximately upstream's *baseline*, and
> vanilla's `bash` is code execution with worse ergonomics. The two arms barely
> differ, which explains **33/40 exact ties** without any story about office work.
> Upstream also gives the agent a **browser** (`BrowseInteractiveAction`,
> GOTO/FILL/CLICK, used by `pre_login`); both our arms substituted REST APIs.
>
> So the +0.035 / t=0.99 result below is a valid measurement of *code execution vs
> shell-and-file tools*, and **not** of tool representation. Do not cite it as
> evidence about the thesis either way. Checking for MCP support was a five-minute
> question that should have preceded a day of work.
>
> **What TAC is still good for:** a long-horizon, checkpoint-graded, multi-service
> substrate for the *durability/affordance* work — waiting, wake-on-condition,
> jobs, subagents, credential injection. The traces here produced real evidence on
> all of those (see §5). To make it test representation you would have to build the
> MCP layer yourself (wrap the four services), which is constructing a new
> benchmark on TAC's tasks and graders — legitimate, but a different project.



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
  <!-- SUPERSEDED 2026-08-12: not "questionable" — UNANSWERABLE. The NPCs could
  not reply at all (sotopia hard-codes temperature; sonnet-5 400s on it). Fixed;
  with colleagues actually conversing the task solves 5/5 in 7 turns. See the
  RETRACTION section below and docs/TAC-VALIDATION-RESULTS.md (authoritative). -->
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

---

## Jobs-runtime validation on TAC — five runs, and what they actually established

> **SUPERSEDED — read `docs/TAC-VALIDATION-RESULTS.md` for the authoritative TAC
> result.** This section and its 302-sleep / 48-thread baseline record what was
> believed before the mute-NPC bug was found. Those counts are an artefact of the
> agent polling colleagues who could never answer; on the fixed stack the task has
> no waiting at all. Retained as the trail of what was believed when. See RETRACTION
> below.

Run with `HARNESS_JOBS_RUNTIME=1` on `pm-schedule-meeting-2` (the worst recorded
offender: 302 raw sleep mentions, 48 thread mentions).

| run | condition | turns | cost | blocking-sleep cells | jobs cells |
|---|---|---|---|---|---|
| baseline (recorded) | partial jobs, weak guards | 43 | $0.67 | 24 | 14 |
| 1 | flag unset — **invalid** | 18 | $0.43 | 9 | 0 |
| 2 | staged, no guidance | 198 | $3.32 | 1 | 0 |
| 3 | staged + guidance | 265 | $4.56 | 0 | 0 |
| 4 | `IPYTHONDIR` set | 147 | $1.55 | 0 | 0 |
| 5 | + status recording | 87 | $0.70 | 0 | 1 |

### The runtime was present the whole time

Run 5 records `87 STARTED / 87 COMPLETED / jobs bound in builtins`. So the earlier
conclusion "jobs was never available" was **wrong about availability** — the agent had
it and used it in 1 of 87 cells.

Three verifications certified the wrong thing before this was known:

1. `import jobs` under a manual `sys.path` insert — proves the file imports.
2. a manual `runpy` of the startup file, printing `PRELUDE-OK` — proves it *can* run.
3. grepping `stream.jsonl` for the prelude banner — the banner never reaches the
   agent's cell output at all, so its absence proves nothing.

All three are the `find_spec` mistake in new clothes. What settled it was the prelude
writing `STARTED`/`FAILED <traceback>`/`COMPLETED` to a file that the runner copies out
**before the container is destroyed** — because container state cannot be re-derived
tomorrow, which is the actual test for sufficient logging.

Separately established: `ipykernel_launcher` *does* execute startup files when
`IPYTHONDIR` is set (tested with a marker file — prints go to iopub, not stdout).

### Two findings worth acting on

**1. Suppressing the bad wait without adoption is a regression, not a partial win.**
Blocking sleeps went 24 → 0 and threads 5 → 0, and turns went 43 → 87–265 at 1–7× the
cost. With no usable wait, the agent burns *turns* as its wait mechanism: whole cells
that are `print(38)` and `print("r21")`, labelled polling rounds. Zero seconds of
kernel held, so no guard fires. An error channel only teaches when an error fires, and
the cheapest escape route fires nothing.

**2. The 87 prelude starts were a false alarm, and chasing it found the real cause.**
87 starts for 87 cells with distinct pids looked like a non-persistent kernel, which
would have invalidated the whole codemode arm. It is not: the baseline reuses a
`requests.Session` bound in an early cell across **27 later cells with zero
NameErrors**, so state does carry. The extra starts are non-kernel Python processes
inheriting the `IPYTHONDIR` set on the whole `docker exec` — harmless but noisy, and
worth narrowing so the prelude only loads where it is needed.

**3. The real cause: one uninformative reply cost the entire adoption.** The agent
probed the API exactly once, with `jobs.manifest()`. There was no NameError — `jobs`
was bound — but the store was empty, `manifest()` returned the bare string `"no jobs"`,
and IPython rendered that as an effectively empty cell result. The agent never touched
the API again and spent the following 87 turns polling with cells that were literally
`print(38)`.

An empty state is the agent's likely *first* contact with an API, which makes it the
worst possible place to say nothing. `manifest()` now names the next step
(`submit` / `wait` / `get` / `help`) when there is nothing to list, pinned by a test
asserting the empty case is not bare — and by a second test asserting the advice does
**not** appear once there are real jobs to list, so it cannot crowd out the listing.

This was invisible in aggregate — 87 turns and 0/5 look like a weak agent — and took
reading one cell and its result. It is the clearest example in this file of why the
first few trajectories must be read end to end.

---

## The kernel-wedge bug, and the first valid run (tacval8, 2026-08-12)

Seven TAC runs produced no valid measurement. Root cause, found by starting the
kernel by hand in the container and reading its stderr (not inferring from the
trajectory):

```
File .../ipykernel/iostream.py, line 690, in flush
    if not evt.wait(self.flush_timeout):        # kernel stdout flush
File .../00-jobs.py, line 139, in _called_from_agent_code
    if name == __file__:
NameError: name '__file__' is not defined
```

Two compounding bugs:

1. `__file__` is undefined when IPython runs a startup file. The frame classifier
   referenced it, the NameError killed kernel init, and every cell returned "Kernel
   did not respond within 5000ms". It never reproduced locally because the eval
   harness loads the prelude via runpy.run_path, which SETS `__file__` — so the
   startup-file path TAC uses was never exercised.
2. `threading.Event.wait` was guarded, which put the classifier on ipykernel's
   stdout-flush path. Removed — the third instance of "do not instrument
   infrastructure" after %%bash and Popen.communicate.

Both pinned as tests. Verified in-container: cells execute, `jobs` binds, `x=99`
then `x+1` returns 100 (the kernel IS persistent — the earlier "not persistent"
alarm was wrong twice over: persistent, and never starting).

### First valid trajectory

5 cells before a harness-timeout cut it short (graded:false), but the behaviour is
exactly the target:

| | baseline | tacval8 |
|---|---|---|
| blocking-sleep cells | 24 | **0** |
| thread cells | 5 | **0** |
| jobs cells | 14 | 1 (of 5 before cutoff) |

Cell 5, unprompted and correct:

```python
jobs.submit("sleep 45", name="w1", max_runtime="2m")
jobs.wait(wake_after=50)
```

The agent messaged both colleagues, then reached for the primitive to wait for
replies — instead of the 24 in-cell sleeps and 48 threads of the recorded baseline.
This is the first real evidence the runtime does what it was built for on a genuine
long task. A completed, graded run (tacval9, 3000s cap) is needed before claiming a
score effect — but the wait-behaviour result does not depend on the score.

### tacval9 — completed and graded (n=1)

| | baseline | tacval9 |
|---|---|---|
| cells | 89 | 24 |
| blocking-sleep cells | 24 | 0 |
| thread cells | 5 | 0 |
| jobs cells | 14 | 8 |
| turns | 43 | 25 |
| cost | $0.67 | $0.57 |
| score | 2/5 | 2/5 |
| prelude starts | — | 2 |

`prelude starts: 2` (not one-per-cell) confirms the kernel-wedge fix holds end to
end. The runtime eliminates every anti-pattern (24→0 sleeps, 5→0 threads), runs ~40%
cheaper and shorter, and does not move the score. The "3–7x turn explosion" reported
from the broken runs is now confirmed as an artefact of the wedged kernel, not the
runtime — a working kernel with the runtime is FASTER than the baseline, not slower.

n=1, score unchanged rather than improved. But it is the first end-to-end valid
measurement and it is positive on the axis the runtime targets.

---

## RETRACTION: tacval9 (and every prior conversation-task run) measured a mute world

Found by tac-runner during A1 setup, from the live `/tmp/npc_*.log`, not inferred:
**no NPC colleague has ever been able to reply on this stack.** sotopia hard-codes
`temperature: float = 0.7` on every generation path; our env-LLM
`openai/claude-sonnet-5` returns `400 "temperature is deprecated for this model"` on
Anthropic's OpenAI-compatible endpoint. The NPC receives the agent's DM, builds the
prompt, calls the LLM, gets 400, and loops `"No message received, waiting..."`
forever. `ps` shows it alive and the liveness check passes — so nothing reported a
failure and the *arm* was blamed for a conversation that never happened. Same class
as `find_spec`: liveness certified the wrong thing.

**What this retracts:**

- **tacval9's 2/5 and its turn/cost numbers are void.** It has no integrity field and
  no npc-preflight (it predates both the A0 gate and this fix), so it fails the gate
  retroactively. It was reported up-thread as "the first valid positive result"; it
  was not. `pm-schedule-meeting-2`'s 302-sleep baseline is partly an artefact of
  polling a reply that could never arrive.
- **The 40-task sweep's conversation tasks** measured the same mute world; the parity
  conclusion on those should be re-read with that in mind.

**What survives:** the behavioral *direction* (runtime → jobs.wait instead of
time.sleep) does not depend on the colleague replying — the agent's intent to wait is
identical — so it likely holds. The magnitude and the score do not. The grader is
unaffected: `evaluate_with_llm` passes no temperature, verified end to end
(true→True, false→False).

**Fix (owned by tac-runner, in run-task.mjs):** NPCs get their own `NPC_ENV_LLM`
(default `claude-sonnet-4-5`, which accepts temperature; sonnet-5/opus-4-5/haiku-4-5
probed — 4-5 family 200, sonnet-5 400); the grader keeps validated sonnet-5 so the
judge does not drift. `npc-llm-preflight.py` makes sotopia's exact call before the
agent starts and writes `npc-preflight.json`; `integrity.valid` goes false when
colleagues cannot reply. NPC model recorded as a deviation applied symmetrically to
both arms (before, they used nothing).

The A1–A3 sweep on the fixed stack supersedes tacval9 entirely.

---

## TAC TRACK COMPLETE (2026-08-12) — authoritative summary

Full result in `docs/TAC-VALIDATION-RESULTS.md`. 13 runs, 7 tasks, 0 INVALID (every
ON run: exec/persist/jobs true, npcLlmOk true, no "kernel did not respond", no
timeout). Bottom line: **the runtime is safe to leave on, and TAC is the wrong
instrument to show its value.**

- **A4 (safety/neutrality), promoted to primary, passes on every axis:** 0 guard
  fires across 79 cells, 0 unnecessary `jobs` adoption, no turn/cost penalty (ON
  nominally cheaper, sign 1/3 — read as "no penalty", not a saving).
- **Score is neutral under the honest rule.** Restricted to programmatic checkpoints
  (LLM-judged dropped uniformly, decided before looking at the arm split), every pair
  ties: Δ = 0.000. The apparent −0.133 was one coin-flip LLM checkpoint.
- **The wait-heavy premise was an artefact.** Fix the NPCs and the "wait-heavy" tasks
  have no waiting — colleagues reply within a cell. TAC-when-healthy contains no
  genuine elapsed-time waiting, so the runtime has nothing to attach to. The
  affirmative case lives in `docs/DURABILITY-RESULTS.md` and terminal-bench, not here.
- **Three more benchmark defects, each checked before believing, none about the
  runtime:** `admin-read-survey-and-summarise` has an undefined reference under a
  third-place tie (answering precisely fails, dumping the full tally passes);
  `hr-check-attendance-one-day` shows `bonus_for_completing_final` inflation
  (final_score 3/3 vs checkpoints summing 2/3 — the rule-based figure strips it);
  plus the already-recorded `admin-arrange-meeting-rooms` mis-key.

New/changed for this track: `bench/tac/npc-llm-preflight.py`,
`bench/tac/jobs-ab-sweep.mjs`, `bench/tac/jobs-ab-report.mjs`,
`bench/tac/run-task.mjs` (NPC_ENV_LLM + kernel pre-flight + integrity gate).
