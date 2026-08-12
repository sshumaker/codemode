# A5 — durability: does work actually outlive the cell and the kernel?

Answers plan item **A5** (`docs/VALIDATION-AND-BENCHMARK-PLAN.md`) and TODO #7. Every
eval task before this one finishes inside a single `jobs.wait`, in the kernel that
started it — so the three properties the runtime exists for had no evidence at all.

Three tasks, wired into `runtime/eval/tasks.mjs`, run against a real Opus 5 agent:

| task | property | n | verdict |
|---|---|---|---|
| `kernel-death` | a job survives its kernel being SIGKILLed, and is recovered without redoing the work | 2 | **holds** |
| `concurrent` | four jobs armed at once genuinely overlap, with no crossed records | 2 | **holds** |
| `long-horizon` | the agent polls check-then-wait across a horizon one wait cannot cover | 3 | **holds — but the first version of the task did not test it** |

**Falsifier, stated up front:** if recovery loses work, or concurrent jobs race, or the
poll loop degenerates into per-turn probes, the durability claim fails. None of those
happened. Two other things did, and neither was the runtime: **prime cannot replace a
dead kernel** (§2) and **a staged pipeline does not force a poll loop** (§4).

Reproduce:

```bash
node runtime/eval/run.mjs ~/src/goals/web/.env.local kernel-death  --run-id kd1
node runtime/eval/run.mjs ~/src/goals/web/.env.local concurrent    --run-id c1
node runtime/eval/run.mjs ~/src/goals/web/.env.local long-horizon  --run-id lh1
```

Every run recorded here, including the two negative conditions and the discarded first
attempts:

| run | task | turns | cells | waits | cost | wall |
|---|---|---|---|---|---|---|
| `dur_kd_2` | kernel-death | 4 | 3 | [80] | $0.039 | 90s |
| `dur_kd_3` | kernel-death | 4 | 3 | [80] | $0.039 | 93s |
| `dur_kd_nowedgefix` | kernel-death, **autorestart off** | 13 | 12 | [80] | $0.094 | 118s |
| `dur_conc_1` | concurrent | 4 | 3 | [60] | $0.047 | 71s |
| `dur_conc_2` | concurrent | 4 | 3 | [60] | $0.052 | 72s |
| `dur_lh_1` | long-horizon, **no wait cap** | 4 | 3 | [200] | $0.048 | 211s |
| `dur_lh_2` | long-horizon | 7 | 6 | [60,60,60] | $0.065 | 201s |
| `dur_lh_3` | long-horizon | 7 | 6 | [60,60,60] | $0.066 | 204s |
| `dur_lh_4` | long-horizon | 7 | 6 | [60,60,60] | $0.065 | 199s |
| `dur_kd_postfix` | kernel-death, **after the §4b fix** | 4 | 3 | [90] | $0.039 | 99s |
| `dur_conc_postfix` | concurrent, **after the §4b fix** | 4 | 3 | [60] | $0.052 | 70s |

**Under $0.65 of model spend for the whole exercise**, including the watchdog-debugging
run, the process-tree probe and a re-run of the `control` negative case, none of which
are listed above. Work is simulated with `sleep` and marker files, so there is no
network, no service and no fixture to keep alive; the wall clock is dominated by the
simulated work itself, which is the one thing that cannot be made cheaper without
destroying what is being measured.

The three long-horizon runs are worth a second look: **7 turns, 6 cells, `[60,60,60]`,
identical, three times**. Against the ~27% run-to-run noise this project sees on cost
and turns, a poll loop driven by a real elapsed-time constraint is essentially
deterministic — the agent is not choosing how often to look, the work is telling it.

---

## 0. What is measured, and why not the answer

Each task is graded on the state of the world, not on the transcript. That distinction
cost three rewrites here, all in the same direction — the first version of a check read
the agent's Python and reached a confident wrong verdict:

- `submitted four jobs` counted `jobs.submit(` in the cell source and **failed a run
  that was correct**: the agent submitted all four from a `for` loop, which is one
  occurrence and the better code. It now counts records in the job store.
- `the agent got a working kernel back` counted cells the agent *attempted* and
  **passed a run where all eleven threw** `Kernel has been shut down`. It now counts
  cells that succeeded, which needed per-cell outcomes to be recorded positionally.
- the trivial-probe detector was "a short cell starting with `print(`" and **failed a
  clean long-horizon run** on `print(repr(open('release.txt').read()))` — the cell that
  reads the answer. It now requires the body to be literals and operators and nothing
  else, and lives in `runtime/eval/poll-shape.mjs` so it can be tested directly.

All three are the same mistake — grading the shape of the transcript instead of the
state of the world — and all three are now pinned in
`bench/test/durability-checks.test.mjs`, which feeds every check a hand-built right
world and a hand-built wrong world and asserts it can tell them apart. A check that
cannot fail is not a check.

That the same error recurred three times in one afternoon is the transferable part.
Cell source is the cheapest thing to reach for and it is a proxy for behaviour, never
behaviour itself; the job store, the process table, the artefact on disk and the
per-cell outcome are the things that cannot be written two different ways.

New instrumentation in `runtime/eval/run.mjs`, all of it in `result.json`:

| field | what it answers |
|---|---|
| `kernelKill` | which pids were killed, at which cell, and the process table at the time |
| `preludeStartPids` | one per kernel boot — proof a replacement kernel re-ran the runtime |
| `cellsAfterKernelKill` / `failedCellsAfterKernelKill` | recovery vs. flailing at a corpse |
| `restartNotices` / `preludeAnnouncements` | which channel actually reached the model |
| `poll.waitCells` / `bareWaitCells` / `trivialPollCells` | check-then-wait vs. turn-burning |
| `submitsBeforeFirstWait` | fan-out vs. serialize |

---

## 1. Kernel death — the job survived, and the work was not redone

`%reset -f` (the pre-existing `recover` task) clears the namespace and proves close to
nothing: the process that owns the job's parentage, the guards and the prelude is still
alive. So this task kills the kernel *process*, unannounced, from outside.

The watchdog (`--kill-kernel`) arms on the appearance of a job record and SIGKILLs three
seconds later — which lands during the host-side wait, where a kernel realistically
dies and nothing of ours is running. Finding the kernel took two attempts and the first
one is worth recording:

> Walking down from the spawned child finds **nothing**. prime's print mode hands the
> work to a session worker that retitles its argv to `prime-agent` and is reparented, so
> the kernel is not our descendant at all. Matching on the command line is no better — a
> bare kernel's argv names only a connection file under `TMPDIR`, and this machine
> already had two orphaned `ipykernel_launcher` processes from earlier runs that such a
> match would happily have killed.

The kernel identifies itself instead: the prelude already writes `STARTED pid=…` to its
marker file, now scoped per run. That doubles as the restart evidence — a second
`STARTED` line with a different pid is the replacement kernel re-running the runtime.

### The trajectory (`.run/jobs/dur_kd_2`, PASS, 4 turns, 3 cells, $0.039, 90s)

```python
# cell 1
print(jobs.submit("bash build.sh", name="build", max_runtime="10m"))
# -> submitted build (pid 1440); log .../jobs/build.log
#    <Job build running>

# cell 2
jobs.wait(wake_after=80)
# -> [waiting 80s outside the kernel; nothing is held. running jobs: build]
#    [waited 80s outside the kernel]
```

The kernel was killed 6.6 seconds into that wait:

```json
{ "atMs": 6585, "atCell": 2, "preludePids": [1431],
  "killed": [{"pid": 1431, "cmd": ".../python -m ipykernel_launcher -f .../connection.json"},
             {"pid": 1420, "cmd": "node .../srt --settings .../srt-settings.json ..."}] }
```

The agent's next cell was already the right shape, and the harness rebuilt the kernel
underneath it:

```python
# cell 3
j = jobs.get("build")
if j.done:
    print(j.ok, j.reason)
    print(open("build.out").read())
else:
    jobs.wait(wake_after=30)
```
```
<ipython_kernel_restarted>
The IPython kernel process died and a fresh one was started. Every variable, import and
in-memory object defined before this point is gone; recreate anything you still need.
</ipython_kernel_restarted>

True completed
BUILD-OK-26e6e8
```

Evidence, all of it re-derivable from the run directory after the fact:

```
prelude-status.txt   STARTED pid=1431 … COMPLETED   ← the kernel that was killed
                     STARTED pid=3237 … COMPLETED   ← the replacement, runtime re-bound
build.trace          START 1786564723 pid=1441
                     FINISH 1786564798              ← ran 75s, straight through the kill
```

**The falsifier — work being redone — did not fire.** `build.sh` appends a `START` line
per invocation and mints a fresh random token, so a re-run would show two `START`s and a
token the agent could not have reported. One `START`; the reported token matches the
file.

The mechanism is visible in the process table: the job's shell is a *child* of the
kernel process (`pid=1441` under kernel `1431`). It survives, is reparented to init and
keeps running — and the job record on disk is what makes it findable afterwards, which
is the part that matters, since a surviving process nobody can name is not recovery.

Worth being precise about what `subprocess.Popen(..., start_new_session=True)` buys
here, because it is easy to over-credit: a child survives a SIGKILL aimed at its parent's
pid whether or not it was detached. The new session buys protection from signals sent to
the *group* and from terminal hangup — which is the more common way background work dies
— and it is what makes the job independent of the kernel's own teardown path rather than
merely of this particular kill.

### The channel that did not reach the model

`preludeAnnouncements: 0`, in every kernel-death run. The prelude's
`[N job(s) from a previous kernel, M still running — reach them with jobs.get('<name>')]`
is printed during kernel **boot**, before any cell, and never appears in a tool result.
The agent is told about the restart only by the host-side notice.

That did not cost anything here — `jobs.get(name)` works regardless, and the resident
prompt already says *"A kernel restart loses your variables but not your jobs"* — but it
means `_announce_existing_jobs()` is, in this harness, dead code as far as the model is
concerned. It is worth either routing to the first post-restart cell result or dropping
the claim that it is one of the runtime's channels.

The notice deliberately says **nothing about jobs**. Whether the agent knows its
background work survived is the property under test, and putting the answer in the
harness notice would have measured instruction-following instead.

---

## 2. prime cannot replace a dead kernel — the harness limit that hid the property

Before any of the above could be observed, the harness had to be able to give the agent
another kernel. **Upstream prime cannot.** `IpythonKernelProvisioner.ensure()` memoises
the `KernelManager`; a kernel killed from outside sets `state = "shutdown"`, and every
later cell throws `Kernel has been shut down` for the rest of the run. The only
rebuild path upstream has is the busy-kernel prompt, where a *human* picks "Kill kernel
and restart" — and print mode has no human.

Measured with `--no-kernel-autorestart` (`.run/jobs/dur_kd_nowedgefix`, 13 turns, 12
cells, 11 errors, $0.094):

```
cell 1   jobs.submit("bash build.sh", name="build", max_runtime="10m")   ok
         jobs.wait(wake_after=80)
cell 2   j = jobs.get("build") …                    -> Kernel has been shut down
cell 3   j = jobs.get("build"); print(j.done…)      -> Kernel has been shut down
cell 4   print("hi")                                -> Kernel has been shut down
cell 5   %%bash cat build.out                       -> Kernel has been shut down
cell 6   1+1                                        -> Kernel has been shut down
…        (cells 7–12, all identical)
```

> The build job was submitted and ran (I did not re-run it), but the IPython kernel has
> since shut down and every subsequent call returns "Kernel has been shut down" —
> including plain `print("ping")`, so it's not recoverable from my side.
>
> I therefore cannot read `build.out` and won't guess at its contents.

The agent's conduct was faultless: it did not re-run the expensive build, it probed with
`print("hi")` and `1+1` to establish that the kernel and not its own code was broken, it
diagnosed the situation correctly and it declined to invent an answer. Meanwhile
`build.trace` shows the job ran to completion and `build.out` held `BUILD-OK-4cd9c8` the
whole time. **The work survived; the agent's access to it did not.**

`prelude-status.txt` has exactly one `STARTED` line, which is the assertion that
separates the two readings: no second kernel ever booted, so this is not an agent that
failed to recover.

The fix is in `scripts/neutralize-prime.mjs`, gated on `HARNESS_KERNEL_AUTORESTART=1`:
on a dead-kernel error, drop the memoised corpse, boot a fresh kernel, and prepend a
notice — the same recovery the busy path already performs, minus the human. Bounded to
three restarts per call so a kernel that dies on every boot fails the call rather than
spinning. `runtime/eval/run.mjs` sets the flag by default and
`--no-kernel-autorestart` turns it off, so the wedge stays reproducible and the two
conditions are the same code path.

This matters beyond the eval. **Any long-running deployment of this runtime inherits the
wedge**: the durability design is explicitly built for kernels that die, and the harness
it runs on could not survive one. Note also the two orphaned `ipykernel_launcher`
processes found on this machine (ppid 1, from earlier runs) — kernels leak on this path
as well, which is a separate defect worth its own look.

---

## 3. Concurrency — four jobs, one wait, genuine overlap

`broadcast` (the pre-existing task) asks three colleagues at once, but the concurrency
is done by `ask.sh`'s own `&`; the agent submits nothing concurrent and the runtime is
not on trial. Here each of four jobs is real background work of a different length
(20/30/40/50s), and each writes `OPEN`/`CLOSE` timestamps to a shared `timeline.txt`.
Per-job outputs are digests of per-job input files, so they cannot be guessed, derived
from each other, or produced without running the work.

### The trajectory (`.run/jobs/dur_conc_1`, 4 turns, 3 cells, $0.047, 71s)

```python
# cell 2 — fan-out and a single wait, in one cell
for n in ["alpha","beta","gamma","delta"]:
    jobs.submit(f"bash analyse.sh {n}", name=n, expect="once", max_runtime="5m")
jobs.wait(wake_after=60)
```
```
submitted alpha (pid 4186); … submitted beta (pid 4187); …
submitted gamma (pid 4188); … submitted delta (pid 4190); …
[waiting 60s outside the kernel; nothing is held. running jobs: alpha, beta, delta, gamma]
```
```python
# cell 3 — collect, with the poll branch present but not needed
js=[jobs.get(n) for n in ["alpha","beta","gamma","delta"]]
if all(j.done for j in js):
    for j in js: print(j.name, j.ok, j.output.strip())
else:
    jobs.wait(wake_after=20)
```
```
alpha True RESULT alpha 94f4c11d11
beta  True RESULT beta  7317392339
gamma True RESULT gamma 21ce4e7937
delta True RESULT delta b129d7bd57
```

What the checks establish from the artefacts rather than the text:

- **all four armed within 0.0s** of each other (`started_at` in the four job records)
- **all four alive at one instant** — `max(OPEN) < min(CLOSE)` over the timeline
- **wall clock 50s**, against ~140s if they had been run one after another
- **no record crossed another**: each `alpha|beta|gamma|delta.json` names its own
  command, its own `.log` and its own `.exit` marker. This is the race a file-backed
  store could plausibly lose, and it would be invisible in the answer — every digest
  would still be *a* digest.
- **each digest matches its own input file**, recomputed by the checker.

**No races** — but be precise about what that does and does not cover. Nothing had to be
added to `jobs.py` to make it hold, and the reason is structural rather than lucky: the
four `submit` calls are sequential Python in one cell, so the *store* is never written
concurrently; the kernel is single-threaded and the guards make sure it stays that way.
What runs concurrently is the work, and the four jobs touch only their own
`name.log` / `name.exit` files plus one append-only `timeline.txt`.

So this establishes that concurrent *jobs* do not corrupt each other's records. It does
**not** exercise concurrent *writers* to the store, and in this runtime nothing can be
one — which is worth saying out loud, because "no races" would otherwise read as a
stronger claim than the design actually needs. The store's concurrency safety rests on
the kernel being single-threaded; if that ever stops being true, this test would not
notice.

The `for` loop is the detail that broke the first version of this check. It is also the
better answer, and it is worth noting that the runtime's surface admits it: `submit`
takes a command string, so building four of them in a comprehension is the obvious move,
where a callable-taking API would have invited `gather` over four closures.

---

## 4. Long horizon — and a task-design negative result worth more than the pass

This is the only task that exercises the design's actual point: a horizon where one
`wait` is not enough and the agent must come back, look, and wait again.

**The first version did not test that, and the run proved it.** The fixture was a
three-stage pipeline (`build` → `test` → `package`, ~60s each) where each stage refuses
to run until the previous stage's artefact exists. The assumption was that the
dependency would force three round trips. Measured (`.run/jobs/dur_lh_1`, 3 cells,
$0.048, 211s):

```python
jobs.submit("bash stage.sh build && bash stage.sh test && bash stage.sh package",
            name="pipeline", expect="once", max_runtime="15m")
jobs.wait(wake_after=200)
```

One job, one wait, three stages, correct answer in three cells — and `waits [200]`, so
the poll loop was never entered.

That is good work rather than a cheat, and the lesson generalises: **given a primitive
for durable background work, an agent hoists the sequencing into the job.** The
inter-stage dependency then gets enforced inside the shell instead of across turns, and
a staged fixture measures *composition* while claiming to measure polling. Any task
built to force multi-turn waiting by chaining dependent steps has this hole.

What actually forces a poll loop is a horizon longer than a single wait may cover, so
the task now caps `HARNESS_MAX_WAIT_SECONDS` at 60 against ~190s of work. That is the
honest version of the constraint rather than a contrivance — `MAX_WAIT` exists precisely
because a host will not park a model indefinitely — and the agent learns the cap through
the runtime's own channel, since `wait` reports that the request was clamped.

### The trajectory under the cap (`.run/jobs/dur_lh_2`, 7 turns, 6 cells, $0.065, 201s)

The agent still composed the pipeline into one job. It then discovered the cap the way
it discovers everything else here — from the runtime, at the point of use:

```python
jobs.submit("bash stage.sh build && bash stage.sh test && bash stage.sh package",
            name="pipeline", expect="once", max_runtime="15m")
jobs.wait(wake_after=200)
```
```
submitted pipeline (pid 18062); log .../jobs/pipeline.log
[waiting 60s outside the kernel; nothing is held (requested 200s, clamped to [5, 60]).
 running jobs: pipeline]
[waited 60s outside the kernel]
```

and then asked for exactly 60 for the rest of the run. The next three cells are
byte-identical, and are the shape the whole API is built around:

```python
j=jobs.get("pipeline")
if j.done: print(j.output)
else: jobs.wait(wake_after=60)
```
```
# x2:  [waiting 60s outside the kernel; nothing is held. running jobs: pipeline]
# x1:  build complete
#      test complete
#      package complete
```

```python
print(repr(open('release.txt').read()))
# -> 'RELEASE-c2d9e8d6\n'
```

`waits [60,60,60]`, four wait cells, **zero bare waits** (every one preceded by a check
in the same cell), zero trivial probes, six cells total. `pipeline.log` confirms the
stages ran in order and end to end: `build 1786565267→1786565327`,
`test →1786565387`, `package →1786565447`.

`dur_lh_3` and `dur_lh_4` reproduce it exactly — same turn count, same cell count, same
`[60,60,60]`, the same three-line poll cell.

### Degeneracy: it does not recur

The failure this check exists for is the one the *broken* kernel produced on
`pm-schedule-meeting-2`: 87 consecutive turns whose cells were literally `print(38)` —
the model using its own turn boundary as a clock because it had no way to say "wake me
later". With a working kernel and a working `wait`, **it does not recur**: three
long-horizon runs across ~190s of work each produced 0 trivial poll cells and 0 bare
waits, and the poll cell is the same three lines every time.

The contrast is the mechanism, not the model: the degenerate loop appears when the agent
has no way to express "wake me later", and `jobs.wait` is that way.

Worth noting where the shape *did* appear: in the wedged run of §2, cells 4, 6, 11 and
12 were `print("hi")`, `1+1`, `print("ping")`, `print("ping2")`. `trivialPollCells`
counted four. Those are liveness probes against a dead kernel, not turn-burning — the
same syntax for the opposite reason, which is why the check is scoped to the task where
polling is the thing under test rather than applied globally.

---

## 4b. The kill-during-submit window — it was open, and it is now closed

§5 originally listed this as the one interval still untested: between `_spawn`
returning and `_write(rec)`, a job can be *running* with nothing on disk saying so.
Reproduced directly, with a real process death rather than a mock — a child runs
`submit()` with a spawner that starts the job and then SIGKILLs itself the instant
Popen returns, which is exactly where an OOM or a container restart can land.

**The window was open, and its failure mode was the worst available one:**

```
child exit: 137                      ← really died in the window
--- job dir ---
victim.log                           ← no victim.json
--- what a fresh kernel sees ---
get      -> None
manifest -> no jobs yet. Start durable work with: ...
--- 3 seconds later ---
marker.txt: alive                    ← the orphan ran to completion
victim.exit written
```

The job ran, produced its output and wrote its exit marker. `jobs.get(name)` returned
`None`, and `manifest()` did not merely fail to help — it **asserted that nothing had
been started**. An agent reading that re-submits, and running an expensive job twice is
precisely the failure durability exists to prevent. It is also the failure that would
have been hardest to diagnose afterwards: two identical runs of the same command, no
error anywhere, and a plausible-looking answer.

### The fix: claim the name before anything can run under it

Three changes in `runtime/jobs.py`, none of them large:

1. **Record before spawn.** `submit` writes a `state: "starting"`, `pid: None` record,
   *then* spawns, *then* rewrites with the pid and `state: "running"`.
2. **The job records its own pid.** The wrapper is now
   `echo $$ > name.pid ; ( cmd ) ; echo $? > name.exit`. In `sh -c`, `$$` is the shell's
   pid — the same number Popen returns, written by the process that survives rather
   than by the one expected to die. `_refresh` adopts it and promotes `starting` to
   `running`. Without it a recovered job would be findable but unkillable.
3. **Writes are atomic** — sibling file plus `os.replace`. A torn write was a second
   route to the same invisibility: `_read` swallows the `ValueError`, `_all` skips the
   record, `manifest()` says "no jobs yet" and the name becomes reusable.

`submit` now refuses a name in `starting` state, which is where the protection actually
lives:

```
job 'build' was submitted but the submit did not complete — most likely the kernel died
between starting the work and recording it. The work may or may not be running.
  jobs.get('build').output   to see whether it has produced anything
  jobs.kill('build')         to give up on it and free the name
Re-submitting under this name is refused because it would run the work twice.
```

Same reproduction, after:

```
--- job dir ---
victim.json   victim.log   victim.pid
get      -> <Job victim running>
manifest -> victim  running  0s  0 bytes  — recovered: submit was interrupted after this job started
RESUBMIT REFUSED: job 'victim' is already running.
--- and it completes normally ---
state done | done True | ok True | exit 0 | reason completed
```

### Why the reordering cannot lose work

The window does not disappear; it moves, and the direction it moves in is the whole
point. Ordering write-then-spawn leaves a residual interval — a crash between the
record and the spawn — which produces a `starting` record with **no process**. That is a
job that is *visible and may not exist*. The old ordering produced a process with **no
record**: a job that exists and is *invisible*.

The first is recoverable by looking: `jobs.get` returns a handle, `.output` says whether
anything ran, `jobs.kill` frees the name. The second is not recoverable at all, because
nothing anywhere names it. There is no ordering of two non-atomic operations that has
neither window, so the engineering question is only which side to fail on, and it is
this one.

The residual case is also *narrower than it looks*, because `starting` reconciles
itself: the pid file and the exit marker are both written by the job, so a job that did
start is promoted to `running` the first time anything refreshes it. `starting` is only
ever observed for a job that genuinely may not have been spawned.

### Tests, mutation-verified

Two suites, because they answer different questions.

**`runtime/test_integration.py::TestInterruptedSubmit`** — five tests, real
subprocesses, a real SIGKILL in the window, 2.2s. This is what proves the window is
reachable at all:

| mutation | tests that fail |
|---|---|
| spawn-then-write (the original ordering) | still-findable, resubmit-refused, name-claimed-first (+ killable errors) |
| drop `echo $$ > name.pid` from the wrapper | recovered-job-is-killable |
| `_write` back to in-place `open(path, "w")` | torn-write-leaves-previous-record |
| `submit` stops refusing a `starting` name | resubmit-refused |

**`runtime/test_jobs.py::TestStartingStateRecovery`** — seven tests, mocked, 7ms. These
exist because the real-kill tests *cannot pin the reconciliation*: which branch a
SIGKILL lands in depends on whether the child had time to write its pid file, so the
same test protects the work through the `running` path on one run and the `starting`
path on the next. It always passes, and it does not say which mechanism held.

The ambiguous branch — started or not, nobody knows — is the one an agent is most
likely to meet and the one no real-kill test reliably produces, so each on-disk state is
constructed directly:

| on-disk state after the crash | recovered as |
|---|---|
| `starting` + pid file | `running`, pid adopted, `reason` says recovered — and killable |
| `starting`, nothing else | stays `starting`, visible in `get()` and `manifest()`, re-submit refused |
| `starting` + exit marker | `done`, with the real exit code and output |

| mutation | tests that fail |
|---|---|
| `_refresh` stops reading the pid file | pid-adopted-and-becomes-running |
| `_refresh` ignores `starting` entirely | pid-adopted, finished-unobserved, nonzero-exit |
| `_terminate` stops qualifying a pid-less kill | giving-up-frees-the-name |
| `submit` stops refusing a `starting` name | resubmit-refused-and-explains |

### Confirmed end to end after the fix

The fix touches `submit`'s ordering, the wrapper and every record write, so the whole
thing was re-run against a real agent rather than trusted to the unit tests:
`kernel-death` **PASS** (kernel SIGKILLed at cell 2, replacement booted, job recovered,
`build.sh` started once, `BUILD-OK-5de65e` reported) and `concurrent` **PASS** (four
records, armed within 0.0s, overlapped, 50s wall, no record crossed another). The agent
never sees the `starting` state on a healthy submit — it is only reachable through a
death in the window — so nothing about the ordinary path changed for it.

One pre-existing test had to change, and it is the same lesson as §0 a fourth time:
`test_wraps_in_a_subshell_so_exit_does_not_kill_the_wrapper` asserted
`cmd.startswith("( ")`. The invariant it exists for is that the command sits inside a
subshell and the marker is written after it closes — but it checked *where the subshell
is*, not *that there is one*, so it broke the moment something legitimate was prepended.
It now asserts the property.

---

## 5. What this does and does not establish

**Established, on a real agent, with the artefacts to re-derive it:**

- a submitted job outlives a SIGKILL of the kernel that started it, and is recoverable
  by name in the replacement kernel
- the recovery does not redo the work — verified by a per-invocation trace and an
  unguessable token, not by the agent's word for it
- four jobs armed together genuinely overlap, and their records do not cross
- the check-then-wait loop holds over a multi-minute horizon without degenerating

**Not established:**

- **n = 2–3 per task.** These are existence proofs of a mechanism, not a rate. Run-to-run
  noise in this project is ~27%; nothing here is a ranking and none of it should be
  quoted as one. The long-horizon triple being identical is suggestive, not a variance
  estimate on three samples.
- **Concurrent readers/writers of the store** (§3). Concurrent *jobs* are covered;
  concurrent *access to the job store* cannot happen while the kernel is single-threaded,
  so nothing here would catch it if that changed.
- **Opus 5 only.** Every trajectory here shows an agent that reached for `jobs.get`
  unprompted after a restart. A weaker model may need the prelude announcement that, as
  §1 shows, currently never arrives.
- **A kill during a running cell.** The kernel dies during the host-side wait, which is
  where it is most likely to. A kill landing mid-cell is untested. (The other window
  originally listed here — during `submit` itself — was tested, found open, and closed;
  see §4b.)
- **macOS, single host.** The watchdog reads `ps` and the prelude marker; the reparenting
  behaviour that defeated descendant-walking is prime's, not the OS's, but neither has
  been checked on Linux or in the TAC container.
- **Nothing about cost or benefit.** These tasks establish that the mechanism works. They
  say nothing about whether it beats the alternative, which is what the terminal-bench
  work is for.

## 6. Follow-ups this produced

1. **`_announce_existing_jobs()` never reaches the model** (§1). Route it into the first
   post-restart cell result, or stop counting it as a channel.
2. **Kernels leak.** Two orphaned `ipykernel_launcher` processes were found with ppid 1
   from earlier runs, independent of the kills performed here.
3. **The dead-kernel wedge is upstream** (§2). The patch is ours and gated; upstream
   print-mode users still lose the rest of the run to a kernel that dies.
4. ~~**Kill during `submit`**~~ — **done (§4b).** The window was open: a real SIGKILL
   between the spawn and the record write left a job running with `manifest()` reporting
   "no jobs yet". Fixed by claiming the name before spawning, having the job record its
   own pid, and making record writes atomic; refusing a re-submit under a `starting`
   name is what stops the work being redone. Five mutation-verified tests.
5. **Re-run on Linux / in the TAC container** before quoting any of this for a
   containerised deployment. The reparenting that defeated descendant-walking is prime's
   behaviour, not the OS's, but the watchdog's `ps` parsing is not portable-by-proof.
