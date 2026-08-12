# Scout: terminal-bench

Written as the work happens, per the Plan-B brief. **The deliverable is a GO/NO-GO,
not a score.** Section 6 is the verdict; everything before it is the evidence.

> **GO — for the wait / long-horizon claim (Plan A's A5), and only for that.**
>
> - **The grader works.** Oracle 15/16 (2 excluded, both diagnosed); nop 5/5
>   fail; resolution is all-or-nothing so there is no partial-credit inflation;
>   no LLM anywhere in grading. Every task ships a reference solution and
>   upstream ships an agent that runs it, so **the admission screen costs $0**.
> - **prime-agent is wired in for real** — in-container, `dist/bundle/cli.js`,
>   its own ipykernel, upstream's own `--agent-import-path` seam, no fork.
>   Six files, `bench/terminal/`.
> - **It is the only scouted benchmark with genuine long-horizon work**: 61
>   tasks with an agent budget ≥1800s, 24 ≥3600s, up to 86,400s. And the jobs
>   runtime's motivating failure — a daemon's inherited pipe wedging the kernel
>   forever — **happened unprompted on the first daemon-starting task tried**
>   (§7.2).
> - **It cannot measure residency.** No tool catalogue; `ctx0` ≈ 6.1K either arm.
>   Do not try to replicate the 2×2 here.
> - **Tier 5 is DIRTY and must be re-run before scaling** — the wedged-cell bug
>   is a harness gap (`HARNESS_CELL_TIMEOUT_MS` was unset), now fixed, not yet
>   re-validated.
> - Scout spend: **under $3** of $40. Projected: **$45–70 per arm** for a
>   67-task core-equivalent, **$150–250 per arm** for all 241.

Status: **Phases 0–3 complete; tier 5 dirty pending one re-run.**

---

## 0. What terminal-bench is, mechanically

Upstream: `laude-institute/terminal-bench`, cloned to `vendor/terminal-bench`
(gitignored), pinned at `d28711d0` (2026-07-10, "Update citation to ICLR 2026").

A task is a directory. `original-tasks/hello-world/` is the whole contract:

| file | role |
|---|---|
| `task.yaml` | instruction prose, `parser_name`, `max_agent_timeout_sec`, `max_test_timeout_sec`, difficulty, category |
| `Dockerfile` | the task image, usually `FROM ghcr.io/laude-institute/t-bench/<base>` |
| `docker-compose.yaml` | one `client` service, `sleep infinity`, with the logs dirs bind-mounted |
| `solution.sh` (or `solution.yaml`) | **the reference solution — shipped, in-repo, for every task** |
| `run-tests.sh` | the grader's entry point, run *inside* the container |
| `tests/test_outputs.py` | the assertions |

The harness (`terminal_bench/harness/harness.py`) does, per trial:

1. `docker compose up` the task image, start a **tmux** session in it
   (`terminal/tmux_session.py`; tmux and asciinema must exist in the image),
2. hand the agent `perform_task(instruction, session, logging_dir)`,
3. copy `run-tests.sh` + `tests/` into the container and `bash run-tests.sh`,
4. parse the tmux pane with `parsers/pytest_parser.py`,
5. **resolved iff every parsed test is PASSED** (`_is_resolved`).

Two things follow immediately, and both are good news relative to TAC:

- **The reference solution is in the repo for every task**, and there is a
  first-class `oracle` agent (`agents/oracle_agent.py`) that copies `solution.sh`
  into the container and runs it. Phase 0's positive control is a supported mode,
  not something to hand-roll.
- **There is a `nop` agent** (`agents/null_agent.py`) that returns immediately.
  Phase 0's negative control is likewise built in.

`--agent-import-path some.module:SomeAgent` accepts a custom agent without
forking the repo. That is the intended integration seam.

### Grading: what is and is not deterministic

No LLM anywhere in the default path. `parser_name: pytest` splits the pane on
`=== short test summary info ===` and reads `PASSED`/`FAILED` lines. Note two
properties that matter:

- **`_is_resolved` requires *all* tests to pass**, so there is no partial-credit
  fraction to be fooled by — this benchmark does not have AppWorld's §4.2 /
  TAC's bonus-inflation shape where a do-nothing run scores 1/N.
- **The parser reads the terminal pane, not a machine-readable report.** If the
  test output scrolls past the tmux history limit (50,000 lines), or the agent
  leaves the pane in a state where the summary banner never appears, the parser
  raises and the trial is recorded `PARSE_ERROR` — a *harness* outcome that is
  scored as unresolved. This is the first thing to watch in triage.
- `SKIPPED` and `XFAIL` map to `PASSED` (`pytest_parser.py`). A task whose tests
  skip themselves on an unmet precondition grades as resolved.

---

## 1. Phase 0 — grader trust

### 1.1 INTEGRATION trap found before the first agent run

The very first `tb run` reported:

```
Running tasks (1/1, Accuracy: 0.00%) - Last: hello-world ✗
| Resolved Trials   | 0       |
| Accuracy          | 0.00%   |
```

The cause was not the task. It was:

```
RuntimeError: ("Error creating docker client: Error while fetching server API
version: ('Connection aborted.', FileNotFoundError(2, 'No such file or
directory'))", 'Please ensure that Docker is installed and running.')
```

Docker here is **colima**, whose socket is `~/.colima/default/docker.sock`, not
`/var/run/docker.sock`. terminal-bench's harness catches the per-trial exception,
marks the trial unresolved, and **prints an accuracy**. A completely
non-functional Docker connection produces `Accuracy: 0.00%` — the exact
"plausible number, not an error" signature `CLAUDE.md` warns about, on the first
command of the scout.

Fix: `export DOCKER_HOST=unix:///Users/scottshumaker/.colima/default/docker.sock`.
With it, `hello-world` oracle → **resolved, 37s wall-clock**.

**Consequence for any sweep:** a run's accuracy is meaningless unless
`FailureMode` is inspected per trial. `results.json` carries it; the summary
table does not.

### 1.2 Environment

```
colima, vmType vz, aarch64, rosetta: true, 8 cpu / 28 GiB / 100 GiB disk
docker 29.5.2, overlayfs
free space in the VM at scout start: 36.0 GB of 97.9 GB
  (the TAC stack owns ~57 GB of that and is live — another agent's)
uv 0.12.3, terminal-bench installed via `uv sync --frozen`
```

`ghcr.io/laude-institute/t-bench/python-3-13:20250620` is multi-arch
(amd64 + arm64). The harness does **not** pin a platform and no
`DOCKER_DEFAULT_PLATFORM` is set anywhere in `terminal_bench/`, so tasks build
**arm64 natively** on this machine while upstream authored and validated them on
amd64. Whether the reference solutions survive that is a Phase-0 question, not an
assumption — see §1.3.

### 1.3 Oracle and nop batteries

Six tasks chosen as a spread (filesystem, env-repair, data, git, security, a long
build), plus `hello-world`. Oracle = runs the shipped `solution.sh`. Nop = does
nothing. Both are upstream's own agents; nothing hand-rolled.

```
### oracle (must PASS)
  hello-world          resolved=True   {exists: passed, content: passed}
  broken-python        resolved=True   {pip_installed: passed, pip_install: passed}
  csv-to-parquet       resolved=True   {parquet_exists: passed, data_matches: passed}
  fix-git              resolved=True   {about_file: passed, layout_file: passed}
  fix-permissions      resolved=True   {script_permissions: passed}
  sanitize-git-repo    resolved=True   {removal: passed, replacement: passed, no_other: passed}
  build-tcc-qemu       resolved=False  ERROR collecting test_outputs.py - IndexError

### nop (must FAIL)
  csv-to-parquet       resolved=False  {parquet_exists: failed, data_matches: failed}
  fix-git              resolved=False  {about_file: failed, layout_file: failed}
  fix-permissions      resolved=False  {script_permissions: failed}
  sanitize-git-repo    resolved=False  {no_other: passed, removal: failed, replacement: failed}
  broken-python        resolved=None   fm=parse_error
```

**Verdict: the grader works.** 6/6 arch-clean oracle runs pass; 5/5 nop runs are
unresolved. No partial-credit inflation — `_is_resolved` is all-or-nothing, and
`sanitize-git-repo` shows the shape: nop passes the "nothing else changed"
assertion trivially (the AppWorld §4.2 / TAC bonus trap) and is still correctly
unresolved because the two real assertions fail.

Two of the eleven cells are not clean, and both are informative.

#### `build-tcc-qemu`: the oracle fails, and it is the *host architecture*

Not a reference bug and not the agent. The task's `Dockerfile` does
`make defconfig && make -j$(nproc)` on the Linux 6.9 tree, and its test file
hardcodes:

```python
spawn qemu-system-x86_64 -kernel /app/linux-6.9/arch/x86/boot/bzImage ...
```

Built on this arm64 host, `make defconfig` produces an **arm64** kernel — there
is no `arch/x86/boot/bzImage` — so `expect` gets `spawn id exp4 not open`, pytest
raises `IndexError` during *collection*, and the harness records **one failed
"test" whose name is the collection error string**. An agent that solved this
task perfectly would score exactly the same.

**How common:** grepping the 241 tasks for `x86_64|amd64|i386|arch/x86|
qemu-system-x86|--platform=linux/amd64` hits **24 tasks (10%)**. Eight of those
already pin `--platform=linux/amd64` in their own Dockerfile and are therefore
safe anywhere. The dangerous set is the ones that *assume* x86 without pinning:
`build-tcc-qemu`, `build-initramfs-qemu`, `qemu-alpine-ssh`, `qemu-startup`,
`count-call-stack`, `install-windows-3.11`, `caffe-cifar-10`,
`compile-compcert`, `hdfs-deployment`, `slurm-simple-node-monitoring`,
`setup-custom-dev-env` — roughly 5–7% of the suite.

Forcing `DOCKER_DEFAULT_PLATFORM=linux/amd64` globally is the obvious fix and is
the wrong one here: several of these tasks *compile a Linux kernel* or *run a
nested qemu*, and doing that under Rosetta emulation is either hours-slow or
doesn't work at all (an x86 qemu binary emulating x86, itself emulated).

**The recommendation is the cheap one: the oracle screen is the admission test.**
Oracle runs cost **$0** — no model is called — so any candidate task set should
be run through the oracle first and any task the oracle cannot pass excluded
before a single dollar of agent time is spent. That is Phase 0 executed at the
scale of the actual sweep, and it is the only way to tell this failure from an
agent failure, because in aggregate they are the same number.

#### `broken-python` under nop: the grader cannot run

```
File "/usr/local/bin/pip", line 5, in <module>
    from pip._internal.cli.main import main
ModuleNotFoundError: No module named 'pip'
/tests/run-tests.sh: line 5: pytest: command not found
```

`broken-python`'s premise is a broken Python install; its `run-tests.sh` invokes
the container's own `pytest`. So **the grader only runs if the agent has already
fixed the thing being graded.** Under nop the verdict (`unresolved`) is right,
but it was reached by the grader crashing, recorded as `failure_mode=parse_error`
rather than as failing tests.

This is the class of failure to watch, and it is not hypothetical for the sweep:
a partially-successful agent, or one that breaks apt/DNS/TLS in a networking
task, produces `parse_error` too — a GRADER outcome that is indistinguishable
from an AGENT one unless `failure_mode` is read per trial. Note also that
`hello-world`'s `run-tests.sh` bootstraps its own `uv` + `pytest` **over the
network at grade time** (`apt-get update`, `curl https://astral.sh/uv/...`),
while `broken-python`'s does not: **there is no single grader, there are 241 of
them**, each with its own dependencies.

Triage rule adopted for this scout: **`failure_mode != unset` is never an AGENT
result.** It is HARNESS or GRADER until proven otherwise.

### 1.4 A second oracle screen, on ten harder / server-shaped tasks

Ten candidates drawn from the wait-and-background slice (§7), screened at $0
before any agent money was committed:

```
configure-git-webserver  PASS      mailman                  PASS
fibonacci-server         PASS      pypi-server              PASS
hf-model-inference       PASS      vul-flask                PASS
jupyter-notebook-server  PASS      make-mips-interpreter    FAIL
git-multibranch          (slow build)   write-compressor    (slow build)
```

#### `make-mips-interpreter`: a wall-clock assumption inside the grader

The oracle's own solution failed all three assertions:

```
FAILED test_vm_execution - TimeoutError: Timeout waiting for frame.bmp to be created
FAILED test_frame_bmp_exists - AssertionError: File /tmp/frame.bmp does not exist
FAILED test_frame_bmp_similar_to_reference - FileNotFoundError: '/tmp/frame.bmp'
```

`tests/test_outputs.py:26` reads, in full: `timeout = 30  # 30 seconds timeout`.
The task's reference solution is a MIPS VM written in JavaScript, and the test
gives it thirty wall-clock seconds to render a Doom frame. This is a **different
failure mechanism from `build-tcc-qemu`** and a more insidious one: it is not
about the architecture, it is about **how fast the machine happens to be at that
moment**.

The screen ran at `--n-concurrent 3` on a machine also hosting a live TAC stack,
so the obvious hypothesis was contention. **Re-run solo, at `--n-concurrent 1`,
it fails identically** — so on this machine the 30s budget is simply too tight
for the reference solution, independent of load. Classified REFERENCE, excluded.

The load hypothesis is therefore *not* established, and is not claimed. What is
established is weaker and still actionable: **at least one task in the suite
grades on wall-clock, with a hard-coded budget and no headroom.** A budget with
no headroom is by construction sensitive to whatever else the machine is doing,
so the admission test has two parts rather than one — **screen with the oracle,
and screen at the concurrency the real sweep will use** — but the second part is
a precaution, not a demonstrated failure.

Note also what the taxonomy tool got wrong here, and what fixing it cost.
`report.py` initially printed `AGENT: tests ran and failed` for this trial and
concluded **"AGENT-attributable 1/1"** — for a run in which *no model was
called*. A taxonomy that can assign a cause the run could not have had will do so
silently, and the output looks identical either way. `report.py` now reads
`agent_name` from the run metadata and an oracle non-pass is REFERENCE by
construction; `bench/terminal/test_report.py` pins it, along with seven other
classification rules.

## 2. Wiring prime-agent (the real harness, not a reimplementation)

**The integration is not hard, and upstream provides the seam.** `tb run
--agent-import-path bench.terminal.prime_agent:PrimeAgent` loads a custom
`BaseAgent` without forking the repo, and `perform_task(instruction, session,
logging_dir)` hands over a live `docker-py` container object. Total: four files,
about a day's work including the bugs below, no patch to `terminal_bench/`.

```
bench/terminal/provision-agent-volume.sh   builds the `tb-agent` volume
bench/terminal/stage-dataset.py            mirrors tasks, mounts /agent, digests the rest
bench/terminal/prime_agent.py              the BaseAgent subclass + A0 gate
bench/terminal/report.py                   the taxonomy, not an accuracy
bench/terminal/sweep.sh                    the ONE entry point
bench/terminal/test_prime_agent.py         pins the stream shapes (7 tests)
```

prime runs **inside the task container**, as `dist/bundle/cli.js` — the entry its
own `package.json` publishes as `pi` — with its real ipykernel over localhost ZMQ
and skills enabled. Nothing is reimplemented.

### 2.1 Three integration decisions worth recording

**The payload arrives as a read-only volume, which required mutating the
dataset.** The agent tree is ~1 GB, so `docker cp` per trial is not viable, and
terminal-bench composes each task from the task's own `docker-compose.yaml` with
no hook for extra volumes. `stage-dataset.py` mirrors each task directory and
adds exactly one thing — `tb-agent:/agent:ro` on the `client` service — then
sha256s every other file to prove nothing else moved. **The mutation was then
controlled for**: the oracle battery re-run against the *staged* dataset is
**6/6**, so the mount does not change what the reference solutions do.

**A standalone Python, not the image's.** TAC could rely on every image shipping
`python_default`; terminal-bench's 241 tasks sit on ubuntu-24-04, python-3-13,
`python:3.8-slim`, `debian:bullseye-slim`, `taichidev` and more. `uv` installs a
relocatable python-build-standalone into `/agent` itself, so the kernel does not
depend on the task image at all. Verified by importing all 17 required modules on
three deliberately different bases (ubuntu-24-04, python:3.8-slim,
debian:bullseye-slim): clean on all three. This is strictly better than TAC's
`--system-site-packages` venv, which hid an incomplete install whenever the
provisioning image happened to supply a package system-wide.

**prime is spawned via `container.exec_run(stream=True)`, not typed into tmux.**
Upstream's installed agents are typed into the pane, so their output is terminal
text. That is lossy for a JSON protocol: tmux hard-wraps at 160 columns, and
recovering the claude-code arm's own `total_cost_usd` meant de-wrapping a 43 KB
pane. Reading the stream directly makes turns, tool calls, tokens, cost, `ctx0`
and **every cell's source** exact. The container, the filesystem and the grader
are untouched by that choice; what is given up is the asciinema recording of the
agent's actions, which `trajectory.jsonl` more than replaces.

### 2.2 Three bugs found by reading artefacts, each of which produced a plausible number

**(a) The validity gate fired on a healthy run.** `_accumulate` was first written
against Claude Code's `tool_use`/`tool_result` vocabulary. prime does not use it
— it emits `message_end` with `toolCall` *parts* inside assistant content. So the
first prime trial recorded `"toolCalls": 0, "valid": false` for a run that
executed one cell, wrote the file and **passed both tests**. A gate that can fire
on the wrong evidence is worse than no gate. Fixed, and the shapes are now pinned
by `bench/terminal/test_prime_agent.py` against a verbatim recorded trajectory —
including an assertion that a run which never reaches the transport is caught,
which is the check that was missing when the "L1" arm advertised tools it could
never call.

**(b) The read-only mount cost 6 turns per task, invisibly.** On `csv-to-parquet`
the agent spent **8 of 12 cells** trying to get `pyarrow` into a kernel whose
prefix was read-only: `uv pip install`, fail; probe `sys.executable`; retry with
`VIRTUAL_ENV=`; finally build a throwaway venv in `/tmp` and shell out to it. The
task passed and the tests passed, so **nothing in the score said anything was
wrong.** It was a harness artefact being measured as agent behaviour, and it is
not arm-neutral — it lands on whichever arm reaches for its own interpreter.

The fix keeps the volume read-only (an agent corrupted the shared TAC venv
twice) and copies the venv into the container: 394 MB, **2 seconds**, local to
the container's own layer. Then `uv venv --seed` so the kernel has pip at all,
`/agent/uv` on PATH, and `VIRTUAL_ENV` pointed at the staged copy.

The staged venv's `bin` is deliberately **not** on PATH: putting it first would
silently redefine `python` and `python3` for every shell command, and a good many
of these 241 tasks are *about* the container's own Python.

Measured on the same task, same model, three consecutive configurations:

| configuration | turns | tool calls | cost | secs |
|---|---|---|---|---|
| read-only kernel venv | 13 | 12 | $0.131 | 55.1 |
| + writable staged venv | 10 | 9 | $0.113 | 36.9 |
| + seeded pip, uv on PATH, `VIRTUAL_ENV` | **7** | **6** | **$0.096** | **33.5** |

A 46% turn reduction and a 27% cost reduction from harness plumbing, on a task
that "passed" in all three states. Run-to-run noise here is ~27%, so the cost
numbers are indicative; the mechanism is not — the eight install-fighting cells
are simply gone from the trajectory.

**(c) `--dataset-path` silently runs the wrong dataset.** Pointing at
`original-tasks` rather than the staged mirror produces containers with no
`/agent`, and every prime trial then fails preflight. That is caught now
(`preflight` is recorded in `condition.json` and forces `HARNESS`), but the
generic form is the one that matters: **the flag that selects the world under
test looks identical whether or not it is right.** `sweep.sh` stages before every
run so the two cannot diverge.

### 2.3 How to run it

```bash
# once — builds the tb-agent volume (node, prime bundle, claude-code,
# standalone python + kernel venv), and verifies it on a SECOND base image
bench/terminal/provision-agent-volume.sh

# the $0 admission screen — always first
bench/terminal/sweep.sh --agent oracle --tasks <ids> --concurrency <the real one>

# the arms
bench/terminal/sweep.sh --arm codemode --tasks <ids>
bench/terminal/sweep.sh --arm vanilla  --tasks <ids>
bench/terminal/sweep.sh --agent claude-code --tasks <ids>

# re-print a run's taxonomy without re-running it
bench/terminal/report.py <run-id>

# the checks that are executed rather than described
PYTHONPATH=. vendor/terminal-bench/.venv/bin/python -m pytest bench/terminal/ -q
```

`sweep.sh` is the only entry point, for the same reason `npm run iterate` is on
MCP-Bench: `DOCKER_HOST`, `PYTHONPATH` and the *staged* dataset path have each
already been got wrong by hand once, and each failure printed a score rather than
an error.

### 2.4 Does the agent reach the real terminal?

Yes, for both arms tested, verified by reading trajectories rather than assuming:

- **claude-code** on `csv-to-parquet`: 13 `Bash` tool calls, all executed in the
  task container's tmux pane, captured in `panes/post-agent.txt`.
- **prime codemode** on `csv-to-parquet`: 6 `ipython` cells against the task
  container's real filesystem — `pd.read_csv('/app/data.csv')`,
  `uv pip install pyarrow`, `%%bash` shelling out — and the parquet file the
  grader then reads is the one those cells wrote. Cell sources are recorded
  verbatim in `agent-logs/result.json`.

---

## 3. Failure log

| # | task | symptom | class | cause | status |
|---|---|---|---|---|---|
| 1 | *(all)* | `Accuracy: 0.00%` on the very first run | INTEGRATION | colima's docker socket is not `/var/run/docker.sock`; the harness catches the error per trial and prints a score | fixed in `sweep.sh` |
| 2 | `build-tcc-qemu` | oracle fails, `IndexError` during test *collection* | HARNESS (platform) | task hardcodes `qemu-system-x86_64` + `arch/x86/boot/bzImage`; the arm64 host builds an arm64 kernel | excluded; ~5–7% of the suite is arch-hazardous, screen with the oracle |
| 3 | `broken-python` | `failure_mode=parse_error` under nop | GRADER | the task breaks Python and its `run-tests.sh` uses the container's own pytest, so the grader only runs if the agent already fixed it | inherent to the task; classified, not fixed |
| 4 | `hello-world` (prime) | `toolCalls: 0, valid: false` on a run that passed | INTEGRATION | parser written against the wrong event vocabulary | fixed + 7 tests |
| 5 | `csv-to-parquet` (prime) | 8 of 12 cells fighting a read-only kernel prefix | HARNESS | agent volume mounted read-only with no writable interpreter | fixed (staged venv + seeded pip) |
| 6 | `make-mips-interpreter` | oracle fails all 3 assertions, `TimeoutError` | REFERENCE | the test gives a JS MIPS VM a hard-coded **30 wall-clock seconds** to render a Doom frame; fails solo as well as at concurrency 3 | excluded |
| 7 | `mailman` (prime) | a 3-second cell still running after 6 minutes; kernel held, agent unable to take another turn | HARNESS | `su list -c "mailman start" \| tail -5` — the daemons daemonised holding the inherited **write end** of the pipe `tail` reads, so EOF never arrives (§7.2, evidence persisted) | fixed: `HARNESS_CELL_TIMEOUT_MS` now set; **tier 5 is DIRTY until re-run** |
| 8 | `p3-oracle-screen10` | report printed `AGENT-attributable 1/1` for a run with no model in it | INTEGRATION | the taxonomy did not know an oracle failure cannot be an agent failure | fixed + 8 tests in `test_report.py` |
| 9 | *(environmental)* | docker VM free space 36 GB → 16.5 GB during the scout | OPERATIONS | ~19 GB of dangling 9–10 GB volumes appeared, GitLab/ownCloud-shaped — **not** this scout's (its whole footprint is ~600 MB of images and one 1 GB volume) | reported, **not pruned** — `CLAUDE.md` is explicit that a broad prune destroyed Plane's `pgdata` last time |

Nothing so far has been classified REFERENCE. Note that `build-tcc-qemu` *looks*
like a reference bug and is not one — the reference is correct on the
architecture it was written for.

## 4. Cost

Per-trial, Opus 5, measured (not projected):

| arm | task | turns | tool calls | ctx0 | cost | agent secs |
|---|---|---|---|---|---|---|
| oracle | any | — | — | — | **$0.000** | 3–800 |
| nop | any | — | — | — | **$0.000** | ~0 |
| claude-code | csv-to-parquet | 14 | 13 (Bash) | — | $0.295 | 61 |
| prime codemode | csv-to-parquet | 7 | 6 (ipython) | 6,121 | $0.096 | 34 |
| prime codemode | hello-world | 2 | 1 | 6,098 | $0.039 | 8 |
| prime codemode | fix-permissions | 3 | 2 | 6,107 | $0.050 | 15 |
| prime codemode | fix-git | 6 | 5 | 6,113 | $0.129 | 38 |
| prime codemode | sanitize-git-repo | 9 | 9 | 6,345 | $0.370 | 64 |
| prime codemode | vul-flask | 25 | 24 | — | $0.607 | 210 |

Tier 3 (`fix-permissions`, `fix-git`, `sanitize-git-repo`) was **3/3 PASS,
taxonomy CLEAN**, which is what licensed the ratchet to tier 5. Tier 5 then
surfaced the wedged-cell bug (§7.2) — which is the ratchet working exactly as
intended: each tier finds the trap the smaller one could not.

**Tier 5 status, stated precisely rather than rounded off.** Five tasks
(`configure-git-webserver`, `fibonacci-server`, `mailman`, `pypi-server`,
`vul-flask`) at `--n-concurrent 2`. At the time of writing `vul-flask` has
graded (PASS, $0.607); `mailman` is the wedged cell of §7.2 and is being held to
its in-container deadline; `pypi-server` and the remaining two are still in
flight. **The tier is DIRTY regardless of how they land**, because `mailman`'s
cause is HARNESS and the ratchet rule says a dirty tier is debugged rather than
scaled. The fix (`HARNESS_CELL_TIMEOUT_MS`) is in `prime_agent.py`; the tier has
**not** been re-run under it. That re-run is condition 0 in §6 and is the one
blocking item before a pilot.

Two things to note before anyone multiplies these by 241.

**These are the cheapest tasks in the suite.** `hello-world` and
`csv-to-parquet` are `difficulty: easy`, 1–2 assertions, sub-minute. The suite's
distribution is 64 easy / 120 medium / 57 hard, and 61 tasks carry an agent
timeout of ≥1800s — i.e. tasks upstream expects to run half an hour. A projection
from these two numbers is a lower bound and should be labelled as one.

**`ctx0` is ~6.1K for the codemode arm and there is no tool catalogue to make it
otherwise.** terminal-bench has no MCP surface: the tool set is `ipython,edit` or
prime's shell/file builtins. So the *residency* factor of the 2×2 —
`docs/BENCHMARK-SELECTION.md` §10's fixed ~$0.51/task tax — **is not measurable
on this benchmark at all.** What is measurable is representation (code vs
shell/file tools) and, uniquely, the wait/long-horizon axis.

## 5. terminal-bench's own traps

- **`--dataset terminal-bench-core==head` points at `./tasks`, which no longer
  exists on `main`** — the directory was renamed `original-tasks` (241 tasks).
  Only the pinned `0.1.1` entry (branch `dataset/terminal-bench-core/v0.1.x`,
  80 tasks) resolves. Of those 80 ids, 67 exist under `original-tasks` by name;
  the other 13 are `.easy`/`.hard` variants packaged only on the dataset branch,
  plus `eval-mteb` which is absent entirely. **A local `--dataset-path
  original-tasks` run is therefore not the leaderboard set** and must not be
  compared to published numbers without saying so.
- **The grader needs the network at grade time.** `run-tests.sh` for
  `hello-world` does `apt-get update`, installs curl, then
  `curl -LsSf https://astral.sh/uv/0.7.13/install.sh | sh` and
  `uv pip install pytest==8.4.1` — *inside the task container, after the agent
  has run*. An agent that breaks apt/DNS/TLS in the container (several tasks are
  explicitly about breaking and fixing networking) breaks its own grader, and the
  result is a PARSE_ERROR scored as a failure. This is a GRADER-class failure
  that will look like an AGENT one.
- **Tests run in the agent's own container**, immediately after the agent
  finishes — the exact configuration `CLAUDE.md` says cost this project a TAC
  result ("grade in a fresh container, never the agent's"). An agent that
  installs a conflicting package, changes the working directory, or leaves a
  process attached to the pane can break grading rather than the task.
- **`SKIPPED`/`XFAIL` count as passes** (`pytest_parser.py`), so a task whose
  tests skip themselves on an unmet precondition grades as *resolved*.
- **The verdict is parsed out of a tmux pane, not a report file.** `_parse_results`
  splits `panes/post-test.txt` on `=== short test summary info ===`. Output that
  scrolls past the 50,000-line history limit, or a pane the agent left in a
  strange state, yields `PARSE_ERROR` — recorded as unresolved.
- **The agent times out but the tests still run.** `_run_agent` catches
  `asyncio.TimeoutError`, records `AGENT_TIMEOUT`, and *continues to grading*.
  Since the agent runs in a `run_in_executor` thread that cannot be cancelled,
  an agent process that ignores the deadline is **still acting while the grader
  runs**. `bench/terminal/prime_agent.py` bounds its own process with an
  in-container `timeout` set from the task's own `max_agent_timeout_sec`, which
  is the only fix that does not depend on killing a thread. This is the TAC
  orphaned-`docker exec` bug with a different mechanism.
- **`--platform` is never set**, so tasks build for the host architecture while
  ~10% of them contain x86 assumptions (§1.3).
- **Upstream's own `--n-concurrent` defaults to 4 and genuinely works** — task
  containers are independent, with no shared service stack. This is the single
  biggest operational advantage over TAC, where `reset.sh` made parallelism
  impossible.
- **`--n-attempts` exists**, so pass^k-style reliability over repeats is
  available without extra plumbing.
- **The `original-tasks` mirror is not the leaderboard set** (§5, first bullet).
- **Co-tenancy is the real operational risk here, not terminal-bench.** Free
  space in the single 98 GB colima VM moved between 36 GB and 16.5 GB during this
  scout while the TAC stack was live in the same VM. This scout's own footprint
  is ~600 MB of task images (removed after each trial by upstream's default
  `--cleanup`) plus one 1 GB `tb-agent` volume, and each running trial adds a
  394 MB copy of the kernel venv to its container layer. The ~19 GB of dangling
  9–10 GB volumes that appeared are GitLab/ownCloud-shaped and were **not
  pruned** — `CLAUDE.md` records that a broad prune destroyed Plane's `pgdata`
  last time. A terminal-bench sweep and the TAC stack should not share a VM.

## 6. Verdict

### GO — but for one experiment, not for the one this project has been running

**GO for the wait / long-horizon claim (Plan A's A5).** terminal-bench is the
only candidate scouted that contains genuine multi-minute-to-multi-hour work —
61 tasks with an agent budget ≥1800s, 24 ≥3600s, up to `chem-rf`'s 86,400s — and
the blocking-wait behaviour the jobs runtime targets **occurred unprompted in the
first server-shaped task run** (§7.1). Every TAC task finishes inside one wait
and every AppWorld task is an API call; A5's "the only case that exercises the
design's actual point" has, until now, had no venue.

**NO-GO as a venue for the residency half of the 2×2.** There is no tool
catalogue — the arms are `ipython,edit` versus prime's shell/file builtins, and
`ctx0` is ~6.1K either way. The fixed ~$0.51/task residency tax has no analogue
here. Do not attempt to replicate `docs/BENCHMARK-SELECTION.md` §10 on this
benchmark.

**Conditionally GO for representation**, as a programmatically-graded
replacement for the TheAgentCompany 40-task code-vs-shell result. Same claim,
better grading, no LLM judge, and parallelism that actually works.

### Why the grader is trustworthy

| control | expected | observed |
|---|---|---|
| oracle, 6-task spread + `hello-world` | pass | **6/6** arch-clean (1 excluded, §1.3) |
| oracle, 10 harder / server-shaped tasks | pass | **9/10** (1 excluded, §1.4) |
| oracle, on the *staged* dataset with the /agent mount | pass | **6/6** — the mutation is inert |
| nop | fail | **5/5** unresolved |
| do-nothing partial credit | none possible | `_is_resolved` is all-or-nothing |
| LLM anywhere in grading | none | none |

Two of 16 oracle trials failed, both diagnosed, neither a grading bug:
`build-tcc-qemu` (x86 assumption on an arm64 host) and `make-mips-interpreter`
(a hard-coded 30s wall-clock budget in the test, which also fails solo). **Both
were caught for $0**, because upstream ships the reference solution for every
task and a first-class agent that runs it. That is the strongest operational
property this benchmark has, and it should be exploited as policy: **oracle-screen
every task set before spending a dollar of agent money on it.**

### The conditions

0. **Set `HARNESS_CELL_TIMEOUT_MS` and re-run tier 5 before anything else.** The
   wedged-cell bug (§7.2) is a harness gap, now closed in code and **not yet
   re-validated**. By the ratchet rule the current tier is DIRTY, and a dirty
   tier gets debugged, never scaled. This is the one blocking item.
1. **Screen first, always.** Expect to exclude roughly **5–12%** of any task set
   (2 of 16 here, and the arch grep predicts 5–7% suite-wide independently).
   Screen at the concurrency the real sweep will use.
2. **Read `failure_mode`, never the accuracy.** `parse_error` is a *grader*
   outcome and `broken-python` shows it arising from the task's own design. Use
   `bench/terminal/report.py`, which prints the taxonomy and refuses to call a
   tier CLEAN while any non-AGENT cause remains.
3. **Do not co-tenant with the TAC stack.** One 98 GB colima VM held both during
   this scout and free space moved between 36 GB and 16.5 GB. terminal-bench's
   own footprint is modest and self-cleaning; the risk is the neighbour.
4. **Budget the long-horizon subset separately.** Nothing measured here bounds
   the cost of a task with a 2-hour agent budget.
5. **`original-tasks` is not the leaderboard set.** If external comparability
   matters, use `terminal-bench-core==0.1.1` and say which.

### Cost

Measured, prime codemode, Opus 5:

| task | difficulty | turns | cost |
|---|---|---|---|
| hello-world | easy | 2 | $0.039 |
| fix-permissions | easy | 3 | $0.050 |
| csv-to-parquet | easy | 7 | $0.096 |
| fix-git | easy | 6 | $0.129 |
| sanitize-git-repo | medium | 9 | $0.370 |
| vul-flask | medium | 25 | $0.607 |

Scout spend to date: **under $3** of the $40 budget, most of it on the
configuration comparison in §2.2(b). Oracle and nop screening — 22 trials — cost
**$0**.

Projecting the full 241-task suite from these anchors, with the suite's own
64 easy / 120 medium / 57 hard split and no hard-task measurement yet:

```
64 easy   x ~$0.10  =  $6
120 medium x ~$0.50  = $60
57 hard   x ~$1.50  = $86        <- extrapolated, NOT measured
                       ----
one arm, one attempt   ~$150-250
```

Take the hard column as a guess with a wide interval: the six measured tasks span
$0.039–$0.607 and none of them is hard, so the hard estimate is an extrapolation
across a boundary the data does not cross. The 67-task
`terminal-bench-core`-equivalent subset is roughly **$45–70 per arm per attempt**,
which is the right size for a first real comparison.

### Work parity: terminal-bench ships no work counter, so one is instrumented

Handed forward from scout-appworld: a paired cost delta between two arms only
measures the *treatment* if the arms did comparable work, and a mean-based "arm X
did N% less work" can be an artefact of averaging a **bidirectional** per-task
imbalance — on AppWorld the tools/code call ratio ran from 0.18 to 3.14, so the
high-stratum mean of "31% less work" was a property of the mean, not of the
sample. `bench/appworld/work-parity.mjs` is benchmark-agnostic in shape and takes
paired `(cost, work-count)` records.

The problem transferring it here is that **AppWorld has an arm-independent work
counter and terminal-bench has none.** API calls work on AppWorld because both
arms reach the same `/call` transport. On terminal-bench nothing is shared, and
the obvious candidates are disqualified:

| candidate | why not |
|---|---|
| tool calls / cells | **This is the mechanism, not the work.** Code makes 6–9 actions where tools makes 37–42 at matched work (§10, BENCHMARK-SELECTION). Dividing by it divides out the effect. |
| wall-clock agent seconds | model latency and cold starts, not work |
| files changed / bytes written | an outcome, and grader-shaped |
| `/proc/stat`'s `processes` | **not namespaced** — reports host-wide forks (3.2M on this machine) |

So `prime_agent.py` now instruments one: **the highest PID in the container's own
PID namespace, read before and after the agent.** The difference counts processes
created inside the task container, identically for either arm, whether a command
arrived through the `bash` tool, a `%%bash` cell or `subprocess.run` inside
Python. Verified namespaced and monotonic (11 → 26 across ten `/bin/true`s in a
fresh task container). It lands in `result.json` as `procsCreated`, and as `None`
rather than `0` when it cannot be read.

Two limits, stated because a work counter that flatters one arm is worse than
none: it **undercounts pure in-process work** (a `pd.read_csv` creates no
process, so the code arm's work is understated against a shell arm's), and it is
a lower bound on execs. It is a good instrument for "how much did the machine get
asked to do", not for "how much computation happened".

**Consequences for the pilot design**, in the order they bite:

1. For the **runtime ON/OFF** comparison recommended below, both arms are the
   same representation, so parity is near-guaranteed by construction and this is
   a check rather than a correction. Run it anyway — that is the whole point of
   the lesson.
2. For any **code-vs-tools** comparison here, do not quote a mean cost delta.
   Quote the paired **sign test**, the **cost per process created** (defined on
   every task, independent of parity), and — if it holds — the decisive form:
   *cheaper on N/N tasks, including the ones where the other arm created more
   processes.* A saving that survives on the tasks where the other arm did more
   work cannot be an artefact of the measured arm doing more.
3. None of this is available from the runs in this scout: `procsCreated` was
   added after them, so the six measured tasks have no work count. It applies to
   the pilot, not retroactively.

### Recommended next step, sized

Not a sweep. In order:

1. **Oracle-screen the 61 long-timeout tasks** — $0, several hours of wall clock,
   and it produces the admissible long-horizon set. This is the single
   highest-value next action and it costs nothing but time.
2. **A 12–16 task stratified pilot**, half from the wait/background slice and
   half from the ordinary suite, codemode vs vanilla, `--n-attempts 2`, with a
   per-task cost cap. Roughly **$40–120**. Endpoint: blocking-sleep and
   thread-cell counts (Plan A's A1 metrics) plus turns and cost — not score,
   which at that n is underpowered. Report cost through the work-parity views
   above, never as a mean delta.
3. Only then decide whether the runtime ON/OFF comparison moves here from TAC.

---

## 7. What terminal-bench can and cannot measure for this project

Stated separately from the go/no-go because it is the part that determines
*which* experiment to run, not whether to run one.

**It cannot measure residency.** There is no tool catalogue: the arms are
`ipython,edit` versus prime's shell/file builtins, and measured `ctx0` is ~6.1K
either way. The fixed ~$0.51/task residency tax in
`docs/BENCHMARK-SELECTION.md` §10 has no analogue here. Anyone hoping to
replicate the 2×2 on this benchmark should stop now — AppWorld and MCP-Bench are
the benchmarks with a catalogue.

**It can measure representation, in the form that matters for a terminal.** Code
execution versus shell-and-file tools is exactly the contrast TheAgentCompany's
40-task result covered, on a substrate with programmatic grading instead of
LLM-judged checkpoints. That is a strict upgrade on TAC for the same claim.

**It is the only candidate that can measure the wait/long-horizon axis, and it
genuinely can.** Concretely, from the 241 tasks:

| slice | count |
|---|---|
| agent timeout ≥ 1800s | **61** |
| agent timeout ≥ 3600s | **24** |
| solution or tests background a process / wait on one | **47** |
| both (≥1800s *and* background/wait shaped) | **13** |

The 13: `build-pov-ray`, `enemy-grid-escape`, `hdfs-deployment`,
`install-windows-3.11`, `install-windows-xp`, `mailman`,
`make-mips-interpreter`, `play-lord`, `sam-cell-seg`, `spring-messaging-vul`,
`sql-injection-attack`, `train-fasttext`, `video-processing`.

Above them sit the genuinely multi-minute-to-multi-hour ones — `chem-rf` carries
a **86,400s** agent timeout and a 28,800s *test* timeout, `leelachess0-pytorch-
conversion` 30,000s, `build-pov-ray` 12,000s, `install-windows-xp` and
`sam-cell-seg` 7,200s. These are builds, model training and nested-VM installs:
work where a single `wait` is not enough and the agent must hold a job across
several polls. `docs/VALIDATION-AND-BENCHMARK-PLAN.md` A5 calls that case "the
only one that exercises the design's actual point"; every TAC task finishes
inside one wait, and every AppWorld task is an API call. **This is the benchmark
that has it.**

### 7.1 The wait behaviour is not hypothetical — it appeared in the first server task

From the live trajectory of `mailman` (prime codemode, cell 4 of the run):

```python
%%bash
postfix start 2>&1 | tail -3; sleep 2
mkdir -p /run/mailman3 /var/log/mailman3; chown list:list /run/mailman3 /var/log/mailman3
su list -s /bin/bash -c "mailman start" 2>&1 | tail -5; sleep 3
ps aux | grep -c mailman
su list -s /bin/bash -c "mailman info"
```

Two daemons started and **two blocking `sleep`s inside a single cell**, holding
the kernel while waiting for services to come up. That is precisely the
anti-pattern `runtime/jobs.py` exists to replace, occurring unprompted, in the
first server-shaped task run on this benchmark. On the same tier `vul-flask` used
no sleeps at all in sixteen cells — so the axis varies across tasks, which is
what makes it measurable rather than uniform.

TAC produced this behaviour too, but only via NPC conversation polling. Here it
arises from *service startup and build waits*, which is a broader and more
natural source, and the tasks that generate it are identifiable in advance from
`task.yaml` timeouts and solution shape (§7).

### 7.2 …and it wedged the kernel, on the first daemon-starting task tried

The same `mailman` cell never returned. Diagnosed live and recorded in
`.run/terminal-bench/p3-tier5-codemode/mailman/evidence/` (`ps.txt`,
`wedged-fds.txt`, `DIAGNOSIS.md`) **before the container was destroyed**, because
the verdict is not re-derivable afterwards.

Process tree six minutes into a cell that should take three seconds:

```
240 python (prime kernel) -> 304 bash (the cell) -> 400 tail -5
402 python3 mailman master        (reparented to init)
407..419 python3 mailman runners
```

Scanning every `/proc/<pid>/fd` for the pipe `tail` is reading:

```
400 tail   /proc/400/fd/0 -> pipe:[18612950]     # the read end
402 master /proc/402/fd/1 -> pipe:[18612950]     # mailman stdout
402 master /proc/402/fd/2 -> pipe:[18612950]     # mailman stderr
407 runner /proc/407/fd/1 -> pipe:[18612950]
```

**The daemons inherited the write end of the pipe that `tail` is reading.**
`mailman start` daemonised without closing or redirecting its inherited
stdout/stderr, so the pipe never reaches EOF, `tail` never exits, and the cell
never returns. The kernel is held forever by a cell that cannot finish.

This is not a model error — the daemons started correctly and the task was going
well — and it is not specific to prime: the same `cmd | tail` would wedge any
shell. It is `CLAUDE.md`'s "kill the agent on `exit`, not `close`" in its
canonical upstream form.

Two consequences, and the second is the more interesting one:

1. **A per-cell timeout is mandatory here, and this integration lacked it.** TAC
   patches one in (`HARNESS_CELL_TIMEOUT_MS`, via `scripts/neutralize-prime.mjs`);
   the terminal-bench wiring did not, and one cell consumed a 30-minute task
   budget. The in-container `timeout -k 10 <max_agent_timeout_sec − 30>` wrapper
   still bounded the *trial*, so the harness was never left hanging — but
   bounding the trial is not the same as bounding the cell. **Port the per-cell
   timeout before the pilot.** Until then this tier is DIRTY and does not scale.

2. **The jobs runtime's motivating failure occurred unprompted, on the first
   daemon-starting task tried.** The agent did not choose to block. It wrote an
   ordinary `cmd | tail` idiom and an inherited file descriptor did the rest.
   Plan A's A5 has been looking for a venue where holding the kernel is a real
   hazard rather than a stylised one; this is it, and it took one task to find.

Two cautions on that slice specifically:

- The cheap tasks measured so far cost $0.04–$0.37. A 2-hour training task will
  not. Budget the long-horizon subset separately and cap it.
- The long tasks are also the ones most likely to be arch- or speed-sensitive
  (§1.3, §3 #7). Oracle-screen every one of the 13 before spending agent money on
  it — that screen is free.

---

## 8. The mailman ON/OFF measurement — a detector mistake, corrected

> **This section originally reported a "null result on n=1." That was wrong — it
> was a mis-detection, and the correction is the point.** The first pass keyed
> `wedged` on `compare-jobs.py`'s legacy heuristic (`hitDeadline and turns<=6`),
> which false-negatived a wedge the per-cell timeout *bounds*: the cell is killed at
> the ceiling, the agent recovers and keeps taking turns, so the agent-level
> deadline is never hit. Both arms were scored `wedged=False` when both had held the
> kernel to the ceiling. The detector now reads the per-cell interrupt notice from
> the stream (`_cell_wedge_indices`), pinned by `bench/terminal/test_compare_jobs.py`.

`mailman` (the §7.2 wedge task), prime codemode, Opus 5, cell timeout 600s. A0
confirmed first: `jobs bound in builtins` in a real terminal-bench container. Two
paired runs, re-scored with the corrected detector:

| endpoint | OFF p8m-off | ON p8m-on | OFF p8m-off2 | ON p8m-on2 |
|---|---|---|---|---|
| resolved | PASS | PASS | PASS | PASS |
| **wedged** | **True** | **True** | **True** | **True** |
| wedging cell | `mailman … start \| tail` | same | same | same |
| blocking sleeps | 7 | 9 | 5 | 9 |
| jobs cells | 0 | **2** | 0 | **0** |
| turns | 29 | 48 | 15 | 42 |
| cost | $1.054 | $1.566 | $0.515 | $1.360 |

**The mailman wedge is reliable, not stochastic — 4/4 arms wedged — and the runtime
ON does NOT prevent it.** This is the honest, corrected result, and it is more
interesting than the "null" it replaces:

1. **The wedge reproduces every time.** `su list -c "mailman start" 2>&1 | tail -5`
   daemonises; the runners inherit the pipe's write end; `tail` never sees EOF; the
   cell hangs to the ceiling. Both OFF and both ON runs hit it.
2. **ON does not prevent it, because the agent never submits the wedging command.**
   p8m-on2 used `jobs` zero times; p8m-on applied `jobs.submit` to a *different*
   command (an `mbox-perm-fix` loop), not the daemon start. The agent writes
   `mailman start | tail` as a bash reflex — it is not a sleep, thread, or import, so
   no guard fires, and nothing steers it to a job. The runtime *can* prevent this
   wedge (submit the daemon → output to a file → no blocking reader), but the
   affordance is never reached for this pattern.

**This is the gap §8.1 closes at the harness level and §8.3 measures.** Contrast it
with `compile-compcert` (§8.2), where the wait is an *explicit long build* the agent
recognises and voluntarily hands to `jobs` — there ON does prevent the wedge. The
distinction is the finding: **the runtime helps when the agent recognises work as
long-running; it does not help when the block is an unrecognised side-effect of an
idiomatic command — which is exactly the class the teaching backstop (§8.3) exists
for.**

## 8.1 The detector fix and the fresh-pair confirmation

`compare-jobs.py` now counts a cell as wedged if its result carries either the
harness interrupt notice (`INTERRUPTED after`, a bare kill) **or** the prelude
watchdog's teaching interrupt (`held the kernel for`, §8.3) — because the watchdog
fires at ceiling−margin and *preempts* the harness marker, so keying on the harness
marker alone would score a fixed run `wedged=False` and make the teaching backstop
look like a cure. Both mean "the cell held the kernel to the ceiling"; the watchdog
one is additionally tracked as `taught`. Tests: `test_compare_jobs.py`, 7 passing,
including `test_watchdog_interrupt_counts_as_a_wedge_and_is_tracked_as_taught`.

The fresh pair (p8m-off2/on2) was run to confirm reproducibility and is in the table
above: both wedged, ON adopted no jobs for the daemon. The wedge is not a one-off.

## 8.2 The cleaner test — a DETERMINISTIC long build (compile-compcert)

§8's mailman is stochastic and benign: the wait is a 2–3s service settle, and when the
wedge doesn't reproduce there is nothing to save. The cleaner existence-check the
handoff asked for is a task whose long wait is *deterministic* and long enough to
collide with the 600s cell ceiling — a build or train the agent cannot make finish
faster. This section runs that. **n=1 per arm; existence-check, not a rate.**

### Task selection — what actually has a >600s single wait, and what only looks like it

Screened the five candidates by *shape*, not just budget, because the budget lies:

| task | budget | verdict | why |
|---|---|---|---|
| `cartpole-rl-training` | 900s | **run OFF (null)** | REINFORCE trains to reward>400 in ~90s — far under the ceiling |
| `build-pov-ray` | 12000s | **rejected** | POV-Ray 2.2 is a 1990s C program; the *compile* is seconds. The 12000s is agent *difficulty* (arcane `.TAR.Z` download + K&R-C patching), not a wait |
| `compile-compcert` | 2400s | **the task** | `opam install coq.8.16.1` compiles Coq **from source** — an unavoidable multi-minute wait, and the 8.16.1 pin blocks the fast `apt coq` shortcut (Ubuntu 24.04 ships a newer Coq) |
| `build-linux-kernel-qemu` | 1800s | not run | `--platform=linux/amd64` → kernel build under Rosetta, arch-emulation-slow (§1.3) |
| `hf-train-lora-adapter` | 1800s | not run | needs a HF-hub download; compcert is the cleaner deterministic-CPU wait |

**General finding worth recording: terminal-bench's ≥1800s budgets are mostly agent
*difficulty*, not single deterministic waits.** POV-Ray is the clean example — a
12000s budget on a compile that takes seconds. Only tasks that *compile something
large from source* (Coq, a kernel) or *train for real* have an unavoidable >600s
single operation. That narrows the venue for this claim considerably.

### Oracle screens (both $0, both PASS)

- `cartpole-rl-training` — PASS, 2:27 total (incl. torch-CPU image build).
- `compile-compcert` — PASS, **6:46 total** (22:25:19→22:32:05). **Arch-clean:** the
  reference explicitly branches `aarch64|arm64) COMP_TARGET="aarch64-linux"` and the
  test only checks `ccomp -version`/compiles a probe, so §1.3's arch-hazard listing of
  this task **does not bite** on this host. Note the whole from-source build fits in
  ~350s of compute on this 8-core box — i.e. the *oracle's* one-shot recipe is under
  the ceiling; the stress comes from the *agent* decomposing and polling it.

### cartpole OFF — a NULL, and why (the fast-train case)

`p82-cartpole-off`: PASS, 6 turns, $0.177, **134s**, `blockingSleepCells=0`. The agent
ran training as one foreground cell — `%%bash cd /app && timeout 3000 python train.py`
— holding the kernel, but training finished in ~90s, **well under the 600s ceiling**,
so nothing was stressed. (It even set `timeout 3000` > the 600s cell ceiling, so had
training been that slow the cell would have been killed first.) **Same shape as
mailman: the wait is real but too short to bite.** No ON run was warranted.

### compile-compcert OFF vs ON — the demonstration

Both `--arm codemode`, Opus 5, cell ceiling 600s. A0 on the ON run confirmed
`jobs_staging.bound = true` ("jobs bound in builtins"), `valid = true`.

| endpoint | OFF (`p82-compcert-off`) | ON (`p82-compcert-on`) |
|---|---|---|
| resolved | **PASS** | **PASS** |
| **wedged cell** (600s ceiling interrupt) | **True — cell 16** | **False** |
| **blocking-sleep cells** | **5** (120/60/600/300/400s) | **0** |
| jobs cells | 0 | **10** |
| daemon cells | 3 | 0 |
| turns | 26 | 25 |
| procs created | 42,815 | 34,387 |
| cost | $0.562 | $0.554 |
| wall-clock | 1697.6s | 1857.2s |

**OFF blocked the kernel, unprompted, and hit the ceiling.** Its natural idiom for the
long build was *background-and-poll-with-sleep*:

```
[ 8] nohup make -j$(nproc) > /tmp/build.log 2>&1 &   ... sleep 120
[15] nohup bash -c 'opam init … && opam switch create …' &   ... (poll)
[16] sleep 600; tail -3 /tmp/opam.log        <-- ABORTED at 600.0s: "Process was interrupted."
[18] … make …                                (300s foreground)
[19] sleep 400; tail -5 /tmp/build2.log …
```

Cell 16's `sleep 600` **collided with the 600s cell ceiling and was interrupted** —
`compare-jobs.py`'s `cellWedgeCells=[16]` (it now reads the `INTERRUPTED after` mark
from `stream.jsonl`; the old `hitDeadline and turns<=6` heuristic false-negatived this,
as it did on §8). The coq build actually *finished* inside that sleep, so the wasted
cell was non-fatal — but it is precisely the self-collision the runtime exists to
remove, occurring on a deterministic build. Five cells (~1480s of 1698s) were spent
holding the kernel on sleeps.

**ON adopted jobs and never blocked.** The `%%bash sleep`/`time.sleep` guards refuse
in-cell blocking, so the agent went to `jobs.submit` + `jobs.get`/`jobs.wait` from cell
5 onward (10 jobs cells). Every wait released the kernel — the submit cells print
`[waiting 600s outside the kernel; nothing is held. running jobs: opam]` and return in
0s; `jobs.get("opam") → done` on the next turn. **Zero blocking sleeps, zero wedged
cells**, `ccomp --version → 3.13`, PASS.

### Honest verdict

**What IS demonstrated (and was not before): on a genuine deterministic long build the
runtime eliminates the kernel-blocking pattern (5→0 blocking sleeps) and the
cell-ceiling wedge (OFF wedged cell 16; ON wedged none).** This is the mechanism §8/
mailman could not exercise, because there the wait was benign and neither arm wedged.
Here the wait is real, OFF demonstrably wedged a cell on it, and ON demonstrably did
not. A0 valid, both arms real (jobs bound in a real terminal-bench container).

**What is NOT demonstrated: an outcome, cost, or turn win.** Both PASS; cost ($0.562 vs
$0.554) and turns (26 vs 25) are within noise; ON's wall-clock was *higher* (1857 vs
1698s) — expected, since the build's compute is fixed and the runtime changes only how
the wait is held, not its length. The reason the wedge was non-fatal is the load-
bearing point: **Opus OFF already self-mitigates by backgrounding the build with
`nohup … &` and polling** — a hand-rolled approximation of `jobs.submit`. So the
runtime converts a *working-but-kernel-holding* pattern into a clean one; on this
task/model it does not enable an otherwise-impossible completion. (This is the
CLAUDE.md "match the idiom" lesson from the other side: the agent already reached for
`cmd > log &` + `cat log`.)

**Where a completion/cost win would actually appear:** a task or model where the long
command is run *foreground with no detach*, so the ceiling interrupt loses the build
and forces a costly restart — or a build with no incremental-resume, where the wasted
600s cell is not recoverable. Neither is what Opus does on compcert. The `%%bash` guard
is also relevant here: it only catches literal `sleep N`, **not** an arbitrary long
foreground command (`make`, `python train.py`), so ON cannot *force* jobs adoption on a
foreground build — it relies on the agent choosing `sleep`-poll (which the guard then
redirects) or adopting `jobs.submit` from the preamble. Opus did the latter cleanly.

**Bottom line, updated:** the runtime's *mechanistic* benefit on deterministic long
work is now DEMONSTRATED (no kernel block, no ceiling wedge, where OFF has both); its
benefit *to the score/cost* remains UNDEMONSTRATED and, on a self-mitigating model like
Opus, may require a task shaped to punish foreground blocking specifically. n=1 — treat
as an existence proof of the mechanism, not a rate.

(Minor, since fixed: the ON A0 probe tail carried a benign shutdown-time
`NameError: name '_BANNED_IMPORTS' is not defined` from `_guarded_import` during
`weakref._exitfunc`. `_guarded_import` now accesses its own state defensively and
binds the real import as a default arg, so teardown imports fall through cleanly.
Pinned by `test_import_guard_survives_module_teardown`.)

## 8.3 Closing the mailman gap — a teaching backstop, and what it does not do

§8 showed the mailman wedge passes every guard (no sleep/thread/import) and ON never
prevents it because the agent does not submit the daemon. The runtime's own design
(§6) names the cell wall-clock ceiling as the universal backstop for exactly this
residue — the problem was that the harness kills the wedged cell with a *bare*
interrupt that teaches nothing, so the agent writes the same line again.

**The fix** (`kernel-prelude.py`, `_install_cell_watchdog`): a SIGALRM watchdog armed
only for the span of a cell (`pre_run_cell`→arm, `post_run_cell`→disarm, so it can
never fire in kernel machinery) trips just under the ceiling, interrupts the held
cell, and raises the same `jobs.submit` redirect the other guards do — quoting the
agent's own command. Gated on `HARNESS_CELL_CEILING`, derived from the harness cell
timeout so the two cannot drift. Tests: 4 in `test_prelude.py`.

**Re-measure** (p8m-on-fix, mailman ON, watchdog live, n=1):

| | OFF p8m-off | ON+fix p8m-on-fix |
|---|---|---|
| resolved | PASS | PASS |
| wedged | True (bare kill) | **True (taught)** |
| what the agent did next | muddled on | recovered; final script drops `\| tail` for `>/dev/null` |
| turns / wall-clock | 29 / 961s | 50 / 1165s |

**What the fix does:** the watchdog fired once (the daemon-pipe cell), converted the
silent kill into an actionable message, and the agent recovered and fixed the *right*
thing — its final start script redirects to `/dev/null` instead of piping the daemon
through `tail`. That is a real improvement over the bare-kill runs, where the agent
never fixed the wedge.

**What the fix does NOT do — stated plainly:** it does not prevent the ~585s kernel
hold. The watchdog trips at ceiling−margin *by design*, to avoid false-positiving
legitimately long foreground compute. So `wedged` is `taught`, not `False` — the
kernel was still held, the interrupt just taught instead of bare-killing, and
aggregate cost is within noise of the bare-kill run. The agent also did **not** adopt
`jobs.submit` (it found its own `/dev/null` fix); the message names both the `| tail`
problem and the primitive, and the agent took the former.

**The real cure — tripping earlier — is a separate, measured step.** Firing the
watchdog at ~90–120s would cut the hold, but risks interrupting a genuine 90s+
foreground compile. That threshold can only be set with data on how long real
foreground builds run (cartpole's foreground train was ~90s; compcert backgrounded
its build). Tracked as a follow-up gated on the long-task corpus, not guessed.

**Bottom line across §8–§8.3:** two distinct wedge classes, two distinct answers.
Recognised long work (compcert): the runtime *prevents* the wedge, because the agent
adopts `jobs`. Unrecognised idiomatic blocking (mailman's daemon-pipe): the runtime
cannot prevent it (the agent never submits it), and the ceiling watchdog makes the
inevitable wedge *recoverable and taught* rather than a silent kill — a mitigation,
not a cure. Both are honest, and neither is a score/cost win on a self-mitigating
model like Opus.
