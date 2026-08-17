"""prime-agent as a terminal-bench agent.

Plugged in with `--agent-import-path bench.terminal.prime_agent:PrimeAgent`, which
is upstream's supported seam — the repo is not forked and `terminal_bench/` is not
touched.

The rule this file exists to honour is `CLAUDE.md`'s: **run the real harness, not
a reimplementation of it.** prime-agent runs inside the task container, as
`dist/bundle/cli.js` — the same entry its `package.json` publishes as `pi` — with
its own IPython kernel over localhost ZMQ, its own skills, and its own tools. The
alternative (driving a hand-written kernel over `docker exec` from the host) is
the specific mistake that cost this project TheAgentCompany, and it failed
invisibly: the clone silently dropped image attachments and a multimodal model
went blind on a third of the tasks.

Two properties of that in-container payload are load-bearing:

*   It arrives as a **read-only volume mount at /agent**, staged by
    `bench/terminal/stage-dataset.py`. It is ~1 GB, so `docker cp` per trial is
    not viable, and terminal-bench composes each task from the task's own
    `docker-compose.yaml` with no hook for extra volumes.
*   Skills stay **enabled**. `--no-skills` removes `attach_image`, the only way a
    vision-capable model can actually see a file, and `edit`, whose exact-match
    contract is the entire value of the tool.

Not run through the tmux session
--------------------------------
terminal-bench's own installed agents (`claude-code`, `codex`, …) are typed into
the tmux pane, so their stdout is captured as terminal output. prime is instead
spawned with `container.exec_run(..., stream=True)`, for one reason: its
`--mode json` stream is the trajectory, and reading it back out of a pane that
tmux has hard-wrapped at 160 columns is lossy. The claude-code arm's own
`total_cost_usd` had to be recovered by de-wrapping the pane, and
`results.json` recorded `total_input_tokens: 0` because upstream's agent cannot
see its own numbers. Here the stream is read directly, so turns, tool calls,
tokens and cost are exact.

The container, the filesystem and the tests are unchanged by that choice — the
agent still acts on the real task container, and `run-tests.sh` still grades that
same container afterwards. What is lost is the asciinema recording of the agent's
actions; `trajectory.jsonl` replaces it, and it is strictly richer.

Self-certification (the A0 gate, ported)
----------------------------------------
Every run writes `condition.json` before the model is called and asserts on the
observable effect rather than on the absence of an error:

*   the arm, the model and the exact argv are recorded,
*   `/agent` is proven present and the CLI proven to *execute* (`--version`
    returns), not merely to exist,
*   the kernel interpreter is proven to **import** `ipykernel`, `jupyter_client`
    and `rlm` — `find_spec` once certified a module that contained a syntax
    error, so the check imports rather than locates,
*   the staged kernel venv is proven **writable**, by writing to it,
*   after the run, the number of tool calls that reached prime's dispatch is
    counted, and `kernelRestarted` on every tool result is summed.

A trial with zero tool calls is marked `"valid": false` and classified HARNESS by
`report.py`, never as a weak agent. That is the lesson from the
deferred-registration episode: a residency guard caught "schemas are still
resident" and nothing caught "narrowing worked and execution broke".

What is deliberately *not* claimed here: there is no separate kernel-persistence
probe. prime owns its kernel's lifetime, so a probe run outside the agent would
be testing a different kernel than the one the run uses. Persistence is instead
observed from the run itself — `kernelRestarts` is read off every tool result,
and the cell sources are retained so a lost binding is visible in the trajectory.
"""

from __future__ import annotations

import json
import os
import shlex
import time
from pathlib import Path

from terminal_bench.agents.base_agent import AgentResult, BaseAgent
from terminal_bench.agents.failure_mode import FailureMode
from terminal_bench.terminal.tmux_session import TmuxSession

AGENT_ROOT = "/agent"
PRIME_CLI = f"{AGENT_ROOT}/prime/dist/bundle/cli.js"
NODE = f"{AGENT_ROOT}/node/bin/node"

# The kernel runs from a WRITABLE copy, not from the read-only mount.
#
# Measured, on `csv-to-parquet`, the first real task: the agent spent **8 of its
# 12 cells** trying to get `pyarrow` into a kernel it could not write to. It
# found `/agent/uv`, ran `uv pip install pyarrow`, watched it fail against the
# read-only prefix, probed `sys.executable`, tried again with `VIRTUAL_ENV=`,
# and finally built a throwaway venv in /tmp and shelled out to it. The task was
# solved and the tests passed, so nothing in the score said anything was wrong —
# it just cost 8 extra turns.
#
# That is a harness artefact being measured as agent behaviour, and it is not
# arm-neutral: it lands on whichever arm reaches for its own interpreter. The
# volume stays read-only (an agent corrupted the shared TAC venv twice), and the
# venv is copied into the container instead: 394 MB, **2 seconds**, entirely
# local to the container's own layer.
STAGED_VENV = "/tmp/agent-venv"
KERNEL_PYTHON = f"{STAGED_VENV}/bin/python"

# Where the jobs runtime lives inside the task container when `jobs=on`.
RUNTIME_DIR = "/tmp/harness"
# Scheduler mode: one session per task, under the runtime dir.
SESSIONS_ROOT = f"{RUNTIME_DIR}/sessions"
SESSION_DIR = f"{SESSIONS_ROOT}/task"
REPO = Path(__file__).resolve().parents[2]

# codemode keeps its single execution tool and gains `edit` for safe targeted
# writes. vanilla gets prime's real shell/file set — including bash, which
# MCP-Bench withheld only because it let that arm curl past the MCP tools under
# test. Here the machine *is* the surface, so withholding it would model no
# harness anyone ships. Both arms are levelled up, never down.
#
# codemode's `bash` is GUARDED whenever the jobs runtime is on — see
# BASH_EXTENSION below. An unguarded one silently removes the thing the arm is
# being measured for: the kernel's guards are Python-side, so `bash make` blocks
# the turn for twenty minutes with no redirect and no watchdog, and codemode
# behaves like the blocking arms while still wearing the codemode label.
ARM_TOOLS = {
    "codemode": "ipython,bash,edit",
    "vanilla": "bash,read,edit,write,grep,find,ls",
}

# The guard, staged into the container alongside the runtime it calls.
#
# It registers no tool: it intercepts prime's own `bash` through tool_call /
# tool_result, so the arm keeps the real tool with its real truncation and its
# real process-tree kill. See the module docstring for why a replacement tool
# would be the hand-rolled-kernel mistake again.
BASH_EXTENSION = "bench/arms/bash-tool-extension.ts"

# The kernel environment allow-list, under posture=boundary.
#
# Duplicated from runtime/posture.mjs because this runner is Python and that one
# is the source of truth for every other runner; the two are pinned equal by
# bench/test/posture.test.mjs, so a name added on one side and not the other
# fails a test rather than quietly giving the container kernel a different
# boundary than the host kernels get.
KERNEL_ENV_ALLOW = ",".join([
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP",
    "USER", "LOGNAME", "SHELL", "TERM", "TZ",
    "LANG", "LC_ALL", "LC_CTYPE",
    "IPYTHONDIR",
    "HARNESS_*",
])


class PrimeAgent(BaseAgent):
    def __init__(
        self,
        model_name: str | None = None,
        arm: str = "codemode",
        jobs: str = "off",
        wait_mode: str = "sleep",
        posture: str = "off",
        max_cost: float | None = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        if arm not in ARM_TOOLS:
            raise ValueError(f"arm must be one of {sorted(ARM_TOOLS)}, got {arm!r}")
        # posture=boundary — and here it means LESS than it does on the host
        # runners, which is why the name is validated and recorded rather than
        # quietly reused.
        #
        # The brain lives inside the task container, so the host-side pieces do
        # not apply: there is no loop environment out here to keep a credential
        # out of, and the container IS the sandbox. What remains that is real is
        # the kernel env allow-list — the key reaches the container because the
        # agent needs it, so keeping it out of the KERNEL is still worth doing.
        #
        # srt is deliberately NOT wired in here. Measured inside these images it
        # needs bubblewrap, socat and ripgrep (absent from both), srt 0.0.71 (the
        # tac-agent volume carries 0.0.55, which fails), and a container launched
        # with --cap-add=SYS_ADMIN plus seccomp, apparmor and systempaths all
        # unconfined. That trade buys an inner boundary by materially weakening
        # the outer one, and it is a decision to take deliberately, not a flag's
        # side effect. The egress proxy cross-compiles and runs fine in these
        # images (verified: 201/401 on the control surface), but the kernel
        # cannot reach it through srt on Linux anyway — bwrap gives the sandbox
        # its own network namespace, so 127.0.0.1 is not the host's loopback.
        if str(posture) not in ("off", "boundary"):
            raise ValueError(f"posture must be off|boundary, got {posture!r}")
        self._posture = str(posture)
        if self._posture == "boundary" and arm != "codemode":
            raise ValueError("posture=boundary requires arm=codemode (it confines the kernel)")
        # sleep: the host-side in-process wait (the measured default).
        # exit:  scheduler mode — the harness process EXITS at a wait and
        #        runtime/scheduler.py re-invokes `prime -c` when the wake is due.
        #        The Phase 3 acceptance condition (CLOUD-HARNESS-DESIGN.md §5).
        if str(wait_mode) not in ("sleep", "exit"):
            raise ValueError(f"wait_mode must be sleep|exit, got {wait_mode!r}")
        self._wait_mode = str(wait_mode)
        if self._wait_mode == "exit" and str(jobs).lower() != "on":
            raise ValueError("wait_mode=exit requires jobs=on (the wait IS a jobs feature)")
        if str(jobs).lower() not in ("on", "off"):
            raise ValueError(f"jobs must be on|off, got {jobs!r}")
        self._arm = arm
        # The jobs runtime is ORTHOGONAL to the arm: it is a property of the
        # kernel the codemode arm executes in, not of the tool surface. Only
        # codemode has a kernel, so `jobs=on` with `arm=vanilla` is meaningless
        # and is rejected rather than silently ignored — a condition flag that
        # does nothing is the class of bug that ate seven TAC runs.
        self._jobs = str(jobs).lower()
        if self._jobs == "on" and arm != "codemode":
            raise ValueError("jobs=on requires arm=codemode (it is a kernel feature)")
        self._model = (model_name or os.environ.get("PRIME_MODEL")
                       or "anthropic/claude-opus-5")
        self._max_cost = max_cost

    @staticmethod
    def name() -> str:
        return "prime"

    # ---------------------------------------------------------------- helpers

    def _exec(self, session: TmuxSession, cmd: list[str], **kw):
        return session.container.exec_run(cmd, **kw)

    def _workdir(self, session: TmuxSession) -> str:
        return session.container.attrs["Config"].get("WorkingDir") or "/app"

    def _env(self) -> dict[str, str]:
        env = {
            "ANTHROPIC_API_KEY": os.environ["ANTHROPIC_API_KEY"],
            # `/agent/uv` is on PATH; the staged venv's `bin` deliberately is
            # NOT. Putting it first would silently redefine `python` and
            # `python3` for every shell command the agent runs, and a good number
            # of these 241 tasks are *about* the container's own Python. The
            # kernel is reachable as an explicit path; the ambient environment is
            # left as the task authored it.
            "PATH": f"{AGENT_ROOT}/node/bin:{AGENT_ROOT}/uv:/usr/local/sbin:"
                    "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "PRIME_AGENT_KERNEL_PYTHON": KERNEL_PYTHON,
            # So `uv pip install X` targets the kernel the agent is running in,
            # which is what a normal prime install looks like. Without it the
            # agent has to discover `VIRTUAL_ENV=` for itself, and did.
            "VIRTUAL_ENV": STAGED_VENV,
            # Not $HOME: the task container's home is part of the task's world and
            # several tasks assert on it. Prime's own state goes somewhere it
            # cannot be mistaken for the agent's work.
            "PRIME_AGENT_CODING_AGENT_DIR": "/tmp/prime-home",
            # Scheduler mode: jobs.wait records the wake on disk and the ipython
            # patch skips the in-process sleep — the run ends, the scheduler
            # resumes it. Present only in exit mode so sleep-mode runs are
            # byte-identical to every prior campaign run.
            **({"HARNESS_WAIT_MODE": "exit",
                "HARNESS_WAKE_FILE": f"{SESSION_DIR}/wake.json"}
               if self._wait_mode == "exit" else {}),
            "DO_NOT_TRACK": "1",
            "PRIME_AGENT_TELEMETRY": "0",
            # Bound each cell, or one wedged cell consumes the whole task.
            #
            # Found the hard way on `mailman`: the agent ran
            # `su list -c "mailman start" 2>&1 | tail -5`, the daemons
            # daemonised **holding the inherited write end of that pipe**, `tail`
            # never saw EOF, and the cell never returned. Six minutes into a
            # three-second cell the kernel was still held. Evidence in
            # `.run/terminal-bench/p3-tier5-codemode/mailman/evidence/`.
            #
            # prime's `ipython` tool has no built-in per-cell timeout; the
            # neutralize-prime patch adds one behind this variable and the
            # vendored `dist/bundle` already carries it. Setting it costs
            # nothing and its absence cost a task. The cap exists to break
            # deadlocks, not to punish waiting — an interrupt keeps the
            # namespace, and the model is told the cell was cut off rather than
            # being left to believe it finished.
            "HARNESS_CELL_TIMEOUT_MS": os.environ.get(
                "HARNESS_CELL_TIMEOUT_MS", "600000"),
            # The one half of the posture that is real in a container. The kernel
            # is BUILT from these names rather than having the key removed from
            # it, so a credential nobody has thought of yet is absent too. Only
            # under posture=boundary, and _preflight refuses the run unless the
            # volume's bundle actually honours the variable — see the note there.
            **({"HARNESS_KERNEL_ENV_ALLOW": KERNEL_ENV_ALLOW}
               if self._posture == "boundary" else {}),
        }
        if self._jobs == "on":
            # IPYTHONDIR explicitly, not ~/.ipython. Staging the prelude into
            # /root/.ipython and hoping the hook fires cost two whole TAC runs
            # (198 and 265 turns, $3.32 and $4.56) in which the kernel had no
            # `jobs` at all — and the staging check said "jobs importable",
            # which proves the FILE imports under a manual sys.path insert and
            # says nothing about whether the startup hook ran.
            env["IPYTHONDIR"] = f"{RUNTIME_DIR}/ipython"
            env["HARNESS_RUNTIME_DIR"] = RUNTIME_DIR
            env["HARNESS_JOB_DIR"] = f"{RUNTIME_DIR}/jobs"
            env["HARNESS_JOBS_RUNTIME"] = "1"
            # The prelude's cell watchdog fires just under this ceiling, turning
            # the harness's silent kill into a message that names jobs.submit —
            # the mailman wedge (`daemon start | tail`) blocks past every other
            # guard and only this backstop catches it. Derived from the same cell
            # timeout so the two can never drift out of sync.
            env["HARNESS_CELL_CEILING"] = str(
                int(env["HARNESS_CELL_TIMEOUT_MS"]) // 1000)
            # Early wedge-suspect trip (docs §8.4). The ceiling backstop above only
            # fires at ~585s, so the mailman daemon-pipe wedge holds the kernel that
            # whole span before it is taught. A true wedge blocks forever, so
            # tripping at 120s is identical in correctness and cuts ~465s of dead
            # kernel per wedge. 120s sits above the largest measured *legitimate*
            # foreground compute (cartpole's ~72s train, §8.4) with headroom; longer
            # real builds background themselves or finish foreground in <35s. The
            # clamp in the prelude keeps this <= the ceiling backstop.
            env["HARNESS_WEDGE_SUSPECT_SECONDS"] = os.environ.get(
                "HARNESS_WEDGE_SUSPECT_SECONDS", "120")
            # --- the same two guards, on the bash TOOL -----------------------
            #
            # The kernel's guards cannot see a bash tool call: `%%bash` goes
            # through the magics manager and the watchdog is a SIGALRM inside
            # the kernel process, while the tool runs in the harness. Without
            # these the codemode arm's `bash make` blocks the turn for the
            # whole build, which is the advantage this arm exists to
            # demonstrate, deleted by the tool that was meant to help it.
            env["HARNESS_JOBS_PY"] = f"{RUNTIME_DIR}/jobs.py"
            # The staged venv, not `python3`: it is the interpreter this run has
            # already proven imports (`_preflight`), and several of these 241
            # tasks are *about* the container's own Python — one of them
            # replacing `python3` would silently disarm the guard.
            env["HARNESS_JOBS_PYTHON"] = KERNEL_PYTHON
            # Both guards read the same number rather than each defaulting to 30
            # independently. Two guards that disagree about the threshold is the
            # drift this project pins with tests everywhere else.
            env["HARNESS_SLEEP_CEILING"] = os.environ.get("HARNESS_SLEEP_CEILING", "30")
            # The bash ceiling IS the wedge-suspect trip, for the same reason and
            # at the same number: `blocking_sleep` finds no sleep in `make`, so a
            # wall-clock backstop is the only thing that can see it. Derived from
            # one variable so the shell and the kernel cannot drift apart.
            env["HARNESS_BASH_CEILING_SECONDS"] = env["HARNESS_WEDGE_SUSPECT_SECONDS"]
            env["HARNESS_BASH_LEDGER"] = f"{RUNTIME_DIR}/bash-calls.jsonl"
        return env

    @staticmethod
    def _deadline(logging_dir: Path) -> int:
        """The task's own `max_agent_timeout_sec`, minus a margin.

        Read from the staged dataset rather than passed in, because
        `BaseAgent.perform_task` is not given the task. The trial directory is
        named `<task-id>.<attempt>.<run-id>`, which is the only handle available
        — recorded in `condition.json` so a wrong derivation is visible rather
        than silently defaulting.
        """
        default = 1800
        try:
            task_id = logging_dir.parent.name.split(".")[0]
            import yaml  # terminal-bench already depends on it
            spec = (Path(__file__).resolve().parents[2] / ".run" / "terminal-bench"
                    / "dataset" / task_id / "task.yaml")
            value = (yaml.safe_load(spec.read_text()) or {}).get("max_agent_timeout_sec")
            # 30s of margin so the process is killed and its stream flushed
            # *before* the harness stops waiting and starts grading.
            return max(60, int(float(value)) - 30) if value else default
        except Exception:
            return default

    # Highest PID in the container's own PID namespace. Read before and after the
    # agent, the difference is a count of processes created inside the task
    # container — **the same quantity for either arm**, whether a command arrived
    # through the `bash` tool, a `%%bash` cell, or `subprocess.run` inside Python.
    #
    # It exists because a paired cost delta between two arms only measures the
    # treatment if the arms did comparable work, and a mean-based "arm X did N%
    # less work" can be an artefact of averaging a bidirectional per-task
    # imbalance (bench/appworld/work-parity.mjs, and §10.4 of
    # docs/BENCHMARK-SELECTION.md where a t-test nearly waved one through).
    # AppWorld has API calls as its arm-independent work counter. terminal-bench
    # ships nothing equivalent, so one has to be instrumented, and it must not be
    # tool calls or cells — those are the *mechanism* representation acts on
    # (6-9 actions against 37-42 at matched work), so dividing by them would
    # divide out the effect being measured.
    #
    # Two honest limits: it undercounts pure in-process work (a `pd.read_csv`
    # creates no process, so the code arm's work is understated relative to a
    # shell arm's), and it is a lower bound on execs since PIDs are allocated
    # once per process rather than once per `execve`. `/proc/stat`'s `processes`
    # counter is NOT usable here — it reports host-wide forks (3.2M on this
    # machine) because it is not namespaced.
    _MAX_PID = "ls /proc | grep -E '^[0-9]+$' | sort -n | tail -1"

    def _max_pid(self, session: TmuxSession) -> int:
        try:
            r = self._exec(session, ["sh", "-c", self._MAX_PID])
            return int(r.output.decode(errors="replace").strip().splitlines()[-1])
        except Exception:
            return -1

    def _stage_venv(self, session: TmuxSession) -> float:
        """Copy the kernel venv out of the read-only mount so the agent can
        install into its own interpreter. Returns seconds taken."""
        t0 = time.time()
        self._exec(session, ["rm", "-rf", STAGED_VENV])
        # `cp -a`, not `cp -r`: the venv's bin/ is full of symlinks into
        # /agent/python, and the interpreter itself must stay a link rather than
        # become 400 MB of duplicated binary.
        self._exec(session, ["cp", "-a", f"{AGENT_ROOT}/venv", STAGED_VENV])
        return round(time.time() - t0, 1)

    # Which tool for what, for the arm that has two execution surfaces.
    #
    # Given `ipython` and `bash` and nothing said, the split is left to a coin
    # flip — and the two are not interchangeable here: state lives in the kernel
    # and dies with a bash call, while a build belongs in a shell. Three lines,
    # because resident text is re-billed on every turn of every task.
    #
    # Given to codemode in BOTH jobs conditions, deliberately. The ON/OFF
    # contrast must be exactly "the jobs runtime and its guidance"; adding tool
    # routing to one side only would make the comparison measure two things. The
    # tool surface it describes is identical in both.
    TOOL_ROUTING = """\
## Which tool

`ipython` for code, data and anything whose state you want to keep — variables
persist across cells, `bash` calls do not share them. `bash` for shell and system
work: builds, package installs, services, git. `edit` for a targeted change to a
file you have already looked at.\
"""

    @staticmethod
    def _jobs_prompt() -> str:
        """The guidance, from the runtime itself — never a paraphrase.

        `runtime/jobs.py --prompt` is the single source, exactly as TAC uses it.
        A second hand-written copy would drift, and then the two harnesses would
        be measuring different treatments under one name.
        """
        import subprocess
        out = subprocess.run(
            ["python3", str(REPO / "runtime" / "jobs.py"), "--prompt"],
            capture_output=True, text=True, check=True).stdout
        # The module warns on stderr about the job dir when run outside a
        # container; stdout is the prompt. Strip the leading warning line if the
        # module emitted it to stdout instead.
        return "\n".join(l for l in out.splitlines()
                          if not l.startswith("[jobs] no session identifier")).strip()

    def _stage_jobs(self, session: TmuxSession) -> dict:
        """Install `runtime/jobs.py` into the container's IPython startup path.

        Mirrors `bench/tac/run-task.mjs:stageJobsRuntime` rather than inventing a
        second mechanism, because the mechanism is what is under test.
        """
        if self._jobs != "on":
            return {"staged": False}

        session.copy_to_container(
            [REPO / "runtime" / "jobs.py"], container_dir=RUNTIME_DIR)
        session.copy_to_container(
            [REPO / "runtime" / "kernel-prelude.py"], container_dir=RUNTIME_DIR)
        # Unshadow stdlib at INTERPRETER STARTUP, before IPython imports `executing`
        # (which does `from tokenize import detect_encoding` at import time). A task
        # cwd that ships e.g. /app/tokenize.py otherwise breaks that import during
        # shell init — before the startup file runs — so `jobs` never binds and the
        # ON arm is silently invalid. Installed as a .pth in the kernel venv's
        # site-packages so it runs earlier than any startup file could. See
        # runtime/harness_unshadow.py. Measured on train-bpe-tokenizer.
        session.copy_to_container(
            [REPO / "runtime" / "harness_unshadow.py"], container_dir=RUNTIME_DIR)
        # The wake scheduler travels with the runtime it schedules (exit mode).
        session.copy_to_container(
            [REPO / "runtime" / "scheduler.py"], container_dir=RUNTIME_DIR)
        # The session dir must exist BEFORE the first cell: the kernel writes
        # wake.json into it, and demo4 lost every wake to ENOENT here.
        if self._wait_mode == "exit":
            self._exec(session, ["mkdir", "-p", SESSION_DIR])
        # Subagents travel with the flag that advertises them. The prompt is
        # generated on the HOST (where `import subagents` always succeeds), so
        # without this the guidance said `spawn(...)` while the container had no
        # such module — every prelude-status this campaign produced said
        # "SUBAGENTS off" and the run read as "the agent chose not to delegate"
        # (2026-08-15 review, H4/P1.8).
        if os.environ.get("HARNESS_SUBAGENTS") == "1":
            session.copy_to_container(
                [REPO / "runtime" / "subagents.py"], container_dir=RUNTIME_DIR)
            session.copy_to_container(
                [REPO / "runtime" / "subagent_run.py"], container_dir=RUNTIME_DIR)
            # Assert the capability is REACHABLE in the container, not merely
            # copied — the L1-that-was-L4 lesson: advertise nothing unverified.
            r = self._exec(session, ["sh", "-c",
                f"cd {RUNTIME_DIR} && {KERNEL_PYTHON} -c 'import subagents' 2>&1"])
            if r.exit_code != 0:
                raise RuntimeError(
                    f"HARNESS_SUBAGENTS=1 but `import subagents` fails in the "
                    f"container: {r.output.decode(errors='replace')[:400]}")
        # The bash guard travels with the runtime it calls, gated on the same
        # flag, for the reason the guidance is: an extension staged without
        # jobs.py would refuse to load and take the whole run with it, and a
        # jobs.py staged without the extension would leave bash unguarded while
        # everything else said the runtime was on.
        session.copy_to_container(
            [REPO / BASH_EXTENSION], container_dir=RUNTIME_DIR)
        self._exec(session, ["sh", "-c", (
            f'SP=$({KERNEL_PYTHON} -c "import site; print(site.getsitepackages()[0])") '
            f'&& cp {RUNTIME_DIR}/harness_unshadow.py "$SP/harness_unshadow.py" '
            f'&& printf "import harness_unshadow\\n" > "$SP/_harness_unshadow.pth"')])
        self._exec(session, ["sh", "-c", (
            f"mv {RUNTIME_DIR}/kernel-prelude.py {RUNTIME_DIR}/kernel_prelude.py; "
            f"sed -i 's#/agent/harness#{RUNTIME_DIR}#' {RUNTIME_DIR}/kernel_prelude.py; "
            # IPython runs everything in profile_default/startup/ before the
            # first cell. Both locations, because IPYTHONDIR is set here but a
            # kernel respawn under a different environment would fall back.
            f"mkdir -p {RUNTIME_DIR}/ipython/profile_default/startup "
            f"&& cp {RUNTIME_DIR}/kernel_prelude.py "
            f"{RUNTIME_DIR}/ipython/profile_default/startup/00-jobs.py "
            f"&& mkdir -p /root/.ipython/profile_default/startup "
            f"&& cp {RUNTIME_DIR}/kernel_prelude.py "
            f"/root/.ipython/profile_default/startup/00-jobs.py")])

        # Assert the *effect*: start a real IPython with the same IPYTHONDIR and
        # ask whether the startup file bound the name. A `find_spec`-style check
        # ("the file imports") certified a broken configuration twice.
        env = {k: v for k, v in self._env().items() if k != "ANTHROPIC_API_KEY"}
        r = self._exec(session, [
            KERNEL_PYTHON, "-c",
            "from IPython import start_ipython; import sys; "
            "sys.argv = ['ipython', '--quick', '--no-banner', '-c', "
            "'print(\"JOBS-BOUND\" if \"jobs\" in dir(__import__(\"builtins\")) "
            "else \"JOBS-NOT-BOUND\")']; start_ipython()",
        ], environment=env)
        out = r.output.decode(errors="replace")
        return {"staged": True, "bound": "JOBS-BOUND" in out,
                "probe_tail": out.strip()[-300:]}

    def _preflight(self, session: TmuxSession) -> dict:
        """Positive checks only. Never `no error was raised`."""
        checks: dict[str, object] = {}

        r = self._exec(session, ["test", "-x", NODE])
        checks["node_present"] = r.exit_code == 0

        r = self._exec(session, [NODE, PRIME_CLI, "--version"], environment=self._env())
        checks["cli_executes"] = r.exit_code == 0
        checks["cli_version"] = r.output.decode(errors="replace").strip().splitlines()[-1:] or [""]

        r = self._exec(session, [KERNEL_PYTHON, "-c",
                                 "import ipykernel, jupyter_client, rlm; print('KERNEL-IMPORTS-OK')"])
        checks["kernel_imports"] = b"KERNEL-IMPORTS-OK" in r.output

        # Assert the *effect*, not that a copy command exited 0: the point of
        # staging the venv is that the agent can add a package to its own kernel.
        r = self._exec(session, ["sh", "-c",
                                 f"touch {STAGED_VENV}/.writable && echo VENV-WRITABLE"])
        checks["kernel_writable"] = b"VENV-WRITABLE" in r.output

        # tmux is terminal-bench's own precondition; if it is missing the trial
        # would have failed before the agent was reached, but record it anyway so
        # a run is diagnosable from its own artefacts.
        checks["tmux"] = self._exec(session, ["which", "tmux"]).exit_code == 0

        # Does the BUILD in the volume carry the patches this run depends on?
        #
        # Ported from bench/tac/run-task.mjs, where its absence produced the
        # worst kind of result: the volume held a pre-patch build, every
        # `jobs.wait` returned in ~2s with the sentinel unconsumed, 2,950s of
        # requested waiting became ~0s, and **the run looked like a wall-clock
        # win**. The patch existed in the source and in the host build; it was
        # missing from the only copy that runs.
        want = ["HARNESS_CELL_TIMEOUT_MS"]
        if self._jobs == "on":
            want.append("__HARNESS_WAIT_SECONDS__")
        # A mode's marker travels with the mode. The first scheduler-mode run
        # passed every check while the volume's bundle predated the exit-mode
        # patch: condition.json said wait_mode=exit, the container slept
        # in-process, and only the ARTIFACTS said so (0 exit-mode texts, 8
        # sleep-mode texts). Same trap as the pre-patch wait sentinel this list
        # exists for — the run must fail preflight, not lie in its label.
        if self._wait_mode == "exit":
            want.append("HARNESS_WAIT_MODE")
        # The sharpest instance of this whole class of trap. The tb-agent volume
        # HONOURS HARNESS_KERNEL_SANDBOX_* while carrying no env allow-list at
        # all (measured: 0 matches for HARNESS_KERNEL_ENV_ALLOW anywhere under
        # /agent/prime, against 1 in the host bundle), so the sandbox half can be
        # switched on and seen to work while the kernel still inherits
        # ANTHROPIC_API_KEY — a run that is labelled confined, demonstrably
        # sandboxed, and leaking the key the whole time. Setting the variable
        # without this check is a silent no-op, so the run must fail preflight
        # until the volume is re-provisioned from a current build.
        if self._posture == "boundary":
            want.append("HARNESS_KERNEL_ENV_ALLOW")
        r = self._exec(session, ["sh", "-c",
                                 f"cat {AGENT_ROOT}/prime/dist/bundle/*.js"])
        blob = r.output
        checks["build_markers"] = {
            m: (m.encode() in blob) for m in want
        }
        checks["build_ok"] = all(checks["build_markers"].values())
        return checks

    def _consume(self, stream, raw, traj, summary) -> None:
        """Feed one process's merged output through the JSON-line accumulator.

        Non-JSON lines (node warnings, the scheduler's own log) stay in the raw
        stream file; counting scheduler wakes here keeps the wake count derived
        from the artefact rather than asserted."""
        buf = b""
        for chunk in stream:
            raw.write(chunk)
            raw.flush()
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode(errors="replace").strip()
                if not text:
                    continue
                try:
                    ev = json.loads(text)
                except json.JSONDecodeError:
                    if "[scheduler] waking" in text:
                        summary["wakes"] = summary.get("wakes", 0) + 1
                    continue
                ev["_t"] = time.clock_gettime(time.CLOCK_REALTIME)
                traj.write(json.dumps(ev) + "\n")
                traj.flush()
                self._accumulate(ev, summary)

    def _drain_wakes(self, session, raw, traj, summary, remaining: float, *,
                     tools: str, cwd: str, preamble: str, logging_dir) -> None:
        """Scheduler mode: after the first run exits, hand the session to
        runtime/scheduler.py --drain, which re-invokes `prime -c` per due wake
        until nothing is waiting. Its output (the resumed runs' JSON stream)
        feeds the SAME accumulator, so turns/cost/cells span the whole task."""
        r = self._exec(session, ["test", "-f", f"{SESSION_DIR}/wake.json"])
        if r.exit_code != 0:
            # Recorded, not silent: "never waited" and "wake writes failed" look
            # identical from here, and demo4 was the second one.
            summary["drainNote"] = "no wake.json after the first run — nothing drained"
            return
        remaining = max(60, int(remaining) - 30)
        resume_argv = [
            "timeout", "-k", "10", str(remaining),
            NODE, PRIME_CLI, "-c",
            "-p", "--mode", "json",
            "--model", self._model,
            "--tools", tools,
            "--cwd", cwd,
            "--no-context-files", "--no-prompt-templates",
            *(["--extension", f"{RUNTIME_DIR}/{Path(BASH_EXTENSION).name}"]
              if self._arm == "codemode" else ["--no-extensions"]),
            *(["--append-system-prompt", preamble] if preamble else []),
        ]
        spec = {
            "argv": resume_argv,
            "cwd": cwd,
            # The spec's env WINS in scheduler.run_wake: the kernel's jobs live
            # at the runtime dir, not under the session. Secrets stay OUT of
            # this file — the scheduler process inherits them via exec env.
            "env": {
                "HARNESS_JOB_DIR": f"{RUNTIME_DIR}/jobs",
                "HARNESS_WAIT_MODE": "exit",
                "HARNESS_WAKE_FILE": f"{SESSION_DIR}/wake.json",
            },
        }
        spec_path = logging_dir / "session.json"
        spec_path.write_text(json.dumps(spec, indent=2) + "\n")
        self._exec(session, ["mkdir", "-p", SESSION_DIR])
        session.copy_to_container([spec_path], container_dir=SESSION_DIR)
        # The drain is RELAUNCHED while a wake is still pending and time remains:
        # the scheduler process is cattle like everything else in this design —
        # a SIGKILL (host eviction, oom, the resilience test) must cost a poll
        # interval, not the task. Every decision it makes derives from disk, so
        # a fresh drain resumes correctly by construction (test_scheduler pins
        # the replay; this loop is the live seam).
        drain_started = time.time()
        relaunches = 0
        while True:
            left = int(remaining - (time.time() - drain_started))
            if left <= 0:
                summary["drainNote"] = f"drain deadline exhausted after {relaunches} relaunches"
                break
            _, stream = self._exec(
                session,
                # -u: stdout is a pipe here, and block-buffered prints held every
                # "[scheduler] waking" line until exit — the wakes were invisible
                # in the live stream (demo5) even while they were happening.
                ["python3", "-u", f"{RUNTIME_DIR}/scheduler.py", SESSIONS_ROOT,
                 "--drain", "--interval", "5", "--deadline", str(left)],
                environment=self._env(), workdir=cwd, stream=True, demux=False,
            )
            self._consume(stream, raw, traj, summary)
            r = self._exec(session, ["test", "-f", f"{SESSION_DIR}/wake.json"])
            if r.exit_code != 0:
                break  # nothing left waiting: the drain finished its job
            relaunches += 1
            summary["drainRelaunches"] = relaunches
        

    # ------------------------------------------------------------------ main

    def perform_task(
        self,
        instruction: str,
        session: TmuxSession,
        logging_dir: Path | None = None,
    ) -> AgentResult:
        started = time.time()
        logging_dir = logging_dir or Path("/tmp")
        logging_dir.mkdir(parents=True, exist_ok=True)

        cwd = self._workdir(session)
        tools = ARM_TOOLS[self._arm]
        deadline = self._deadline(logging_dir)
        # The guidance travels WITH the runtime, gated on the same flag.
        #
        # Measured on TAC: with the runtime staged but no guidance the agent
        # never used `jobs` once in 197 cells and no guard ever fired — it did
        # not try to sleep, it polled once per TURN, which holds the kernel for
        # zero seconds and so trips nothing. Turns went 43 -> 198 and cost
        # $0.67 -> $3.32. Suppressing the bad wait without the agent adopting the
        # good one converts a kernel-holding problem into a turn-burning one.
        parts = []
        if self._arm == "codemode":
            parts.append(self.TOOL_ROUTING)
        if self._jobs == "on":
            parts.append(self._jobs_prompt())
        preamble = "\n\n".join(parts)

        argv = [
            # `timeout` inside the container, not only the harness's own clock.
            #
            # terminal-bench enforces `max_agent_timeout_sec` with
            # `asyncio.wait_for` around `run_in_executor` — and a thread in an
            # executor cannot be cancelled. When the deadline passes the harness
            # gives up waiting and **proceeds to run the tests**, while this
            # method is still streaming and the agent inside the container is
            # still acting. The grader would then be racing the agent.
            #
            # This is the shape of the TAC bug where a `docker exec -i` orphan
            # outlived the agent that spawned it and held the pipes open past its
            # own timeout by twenty minutes. Bounding the process in-container is
            # the fix that does not depend on being able to kill a thread.
            "timeout", "-k", "10", str(deadline),
            NODE, PRIME_CLI,
            "-p", "--mode", "json",
            "--model", self._model,
            "--tools", tools,
            "--cwd", cwd,
            "--no-context-files", "--no-prompt-templates",
            # The guard is the ONLY extension, and it is loaded exactly when the
            # runtime it redirects to exists. `--no-extensions` otherwise, so a
            # stray extension in the image can never join a run.
            *(["--extension", f"{RUNTIME_DIR}/{Path(BASH_EXTENSION).name}"]
              if self._jobs == "on" and self._arm == "codemode" else ["--no-extensions"]),
            *(["--append-system-prompt", preamble] if preamble else []),
            instruction,
        ]

        # autoRefine OFF for every arm: neutralize-prime only removes the prompt
        # injection; the review model calls themselves default on past turn 25 —
        # an unbudgeted cost confound (2026-08-15 review, P0.2). Mirrors
        # bench/prime-settings.mjs for the local runners.
        self._exec(session, ["sh", "-c", (
            "mkdir -p /tmp/prime-home && "
            "printf '{\\n\\t\"autoRefine\": {\\n\\t\\t\"enabled\": false\\n\\t}\\n}\\n' "
            "> /tmp/prime-home/settings.json")])
        stage_secs = self._stage_venv(session)
        jobs_status = self._stage_jobs(session)
        checks = self._preflight(session)
        condition = {
            "venv_staged_secs": stage_secs,
            "deadline_sec": deadline,
            "cell_timeout_ms": self._env()["HARNESS_CELL_TIMEOUT_MS"],
            "arm": self._arm,
            "model": self._model,
            "tools": tools.split(","),
            "cwd": cwd,
            "skills_enabled": True,
            "argv": argv[:-1] + ["<instruction>"],
            "instruction": instruction,
            "jobs_runtime": self._jobs,
            "wait_mode": self._wait_mode,
            "posture": self._posture,
            "jobs_staging": jobs_status,
            "jobs_preamble_chars": len(preamble),
            "preflight": checks,
            "agent_payload": "tb-agent volume, read-only at /agent",
        }
        (logging_dir / "condition.json").write_text(json.dumps(condition, indent=2) + "\n")

        jobs_ok = self._jobs == "off" or jobs_status.get("bound") is True
        if not (checks["node_present"] and checks["cli_executes"]
                and checks["kernel_imports"] and checks["kernel_writable"]
                and checks["build_ok"] and jobs_ok):
            (logging_dir / "result.json").write_text(
                json.dumps({"valid": False, "reason": "preflight failed",
                            "preflight": checks, "jobs_staging": jobs_status},
                           indent=2) + "\n")
            return AgentResult(failure_mode=FailureMode.AGENT_INSTALLATION_FAILED)

        pid_before = self._max_pid(session)

        # The key is passed through docker's exec environment, never interpolated
        # into a shell string that would land in `ps` inside the container the
        # agent works in. TheAgentCompany leaks its env-LLM key exactly that way.
        _, stream = self._exec(
            session, argv, environment=self._env(), workdir=cwd,
            stream=True, demux=False,
        )

        raw_path = logging_dir / "stream.jsonl"
        traj_path = logging_dir / "trajectory.jsonl"
        summary = {
            "turns": 0, "toolCalls": 0, "toolErrors": 0, "toolNames": [],
            "cost": 0.0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
            "finalText": "",
        }

        summary["ctx0"] = 0
        summary["kernelRestarts"] = 0
        summary["cells"] = []
        summary["wakes"] = 0
        with raw_path.open("wb") as raw, traj_path.open("w") as traj:
            self._consume(stream, raw, traj, summary)
            if self._wait_mode == "exit":
                self._drain_wakes(session, raw, traj, summary,
                                  deadline - (time.time() - started),
                                  tools=tools, cwd=cwd, preamble=preamble,
                                  logging_dir=logging_dir)

        pid_after = self._max_pid(session)
        # The arm-independent work counter. Recorded even when it fails (-1), so a
        # missing value is visible rather than silently defaulting to zero.
        # Derived metrics can never be allowed to erase the metrics. The first
        # version of this block raised KeyError after the agent had finished, so
        # the trial passed and `result.json` was never written at all — a PASS
        # with every number blank. Any failure here is recorded as a field.
        try:
            # The behavioural endpoints for the ON/OFF measurement, computed from the
            # cell sources rather than asserted. `blockingSleepCells` and
            # `threadCells` are Plan A's A1 metrics; `jobsCells` is adoption.
            cells = summary["cells"]
            import re as _re
            summary["blockingSleepCells"] = sum(
                1 for c in cells
                if _re.search(r"time\.sleep\(\s*(\d{2,}|[6-9])", c)
                or _re.search(r"(^|[;&|])\s*sleep\s+\d", c, _re.M))
            summary["threadCells"] = sum(
                1 for c in cells if _re.search(r"threading\.Thread|os\.fork", c))
            summary["jobsCells"] = sum(1 for c in cells if _re.search(r"\bjobs\.", c))
            summary["daemonCells"] = sum(
                1 for c in cells
                if _re.search(r"nohup|&\s*$|systemctl\s+start|service\s+\w+\s+start"
                              r"|\bstart\b.*(server|daemon)", c, _re.M))
            # A cell that never returned. The agent process is killed by the
            # in-container `timeout` at its deadline, so a run whose wall-clock sits
            # on the deadline with few turns is the wedge signature — recorded as a
            # number so it does not have to be re-derived from a destroyed container.
            summary["procsCreated"] = (
                pid_after - pid_before if pid_before >= 0 and pid_after >= 0 else None)
            summary["seconds"] = round(time.time() - started, 1)
            # Ordered AFTER `seconds` is set, because the first version read it one
            # line too early and raised KeyError *after* the agent had finished — so
            # the trial passed, `result.json` was never written, and the report
            # printed a PASS with every metric blank. An exception in the metrics is
            # not supposed to be able to erase the metrics.
            summary["hitDeadline"] = summary["seconds"] >= deadline - 15
        except Exception as exc:  # noqa: BLE001 - recorded, never raised
            summary["derivedMetricsError"] = f"{type(exc).__name__}: {exc}"
            summary.setdefault("seconds", round(time.time() - started, 1))
        summary["valid"] = summary["toolCalls"] > 0
        summary["validityNote"] = (
            "toolCalls counts calls that reached prime's tool dispatch. Zero means "
            "the arm never acted — an integration failure, not a weak agent."
        )
        # The prelude's own status, copied out BEFORE the container dies. Four
        # TAC runs were spent guessing at this: the prelude lives in a container
        # that is destroyed at the end of the run, so a failure left no trace and
        # "the agent had no jobs" is indistinguishable from "the agent chose not
        # to use jobs".
        if self._jobs == "on":
            r = self._exec(session, ["sh", "-c",
                                     f"cat {RUNTIME_DIR}/prelude-status.txt 2>&1"])
            (logging_dir / "prelude-status.txt").write_bytes(r.output)
            # Flat `<name>.json` records — jobs.py has never written `*/meta.json`,
            # so this artifact was EMPTY on every prior run (2026-08-15 review,
            # P0.4): a vacuous log that read as "no jobs were used".
            r = self._exec(session, ["sh", "-c",
                                     f"cat {RUNTIME_DIR}/jobs/*.json 2>/dev/null"])
            (logging_dir / "jobs-manifest.txt").write_bytes(r.output)
            # The bash guard's own evidence, copied out before the container dies.
            #
            # `bashGuardLoaded` is the load marker, not an inference from refusals:
            # an extension that never loaded and one that was never given a
            # blocking command both leave zero refusals behind, and the run would
            # be scored as an arm that chose to block. That ambiguity cost four
            # TAC runs when the prelude silently failed to bind.
            r = self._exec(session, ["sh", "-c",
                                     f"cat {RUNTIME_DIR}/bash-calls.jsonl 2>/dev/null"])
            (logging_dir / "bash-calls.jsonl").write_bytes(r.output)
            rows = [json.loads(l) for l in r.output.decode(errors="replace").splitlines()
                    if l.strip().startswith("{")]
            summary["bashGuardLoaded"] = any(x.get("phase") == "loaded" for x in rows)
            summary["bashRefusals"] = sum(
                1 for x in rows if str(x.get("verdict", "")).startswith("blocked"))
            summary["bashTimeouts"] = sum(1 for x in rows if x.get("phase") == "timeout")
            summary["bashAllowed"] = sum(1 for x in rows if x.get("verdict") == "allowed")
            if self._arm == "codemode" and not summary["bashGuardLoaded"]:
                # Loud, and it invalidates the trial. An unguarded bash on this arm
                # is not the arm the result will be filed under.
                summary["valid"] = False
                summary["invalidReason"] = (
                    "the bash guard extension did not load, so this codemode run had an "
                    "unguarded shell — it is not a jobs=on codemode run")

        (logging_dir / "result.json").write_text(json.dumps(summary, indent=2) + "\n")

        return AgentResult(
            total_input_tokens=summary["input"] + summary["cacheRead"] + summary["cacheWrite"],
            total_output_tokens=summary["output"],
            failure_mode=FailureMode.NONE,
        )

    # --------------------------------------------------------------- parsing

    @staticmethod
    def _accumulate(ev: dict, s: dict) -> None:
        """Parse prime's `--mode json` stream.

        The shapes here were read off a real run, not guessed — and the first
        version of this method *was* guessed, against Claude Code's
        `tool_use`/`tool_result` vocabulary. It counted 0 tool calls for a run
        that made one and succeeded, so the validity gate reported INVALID on a
        healthy trial. A gate that can fire on the wrong evidence is worse than
        no gate; the fixture in `bench/terminal/test_prime_agent.py` pins these
        shapes so the next schema change fails a test instead of a sweep.

        prime emits, per turn: `turn_start`, streaming `message_update`s, one
        `message_end` per message (roles `user` / `assistant` / `toolResult`),
        then `turn_end`. Usage and priced cost ride on the assistant messages;
        tool calls are `toolCall` parts inside assistant content, not events.
        """
        t = ev.get("type")
        msg = ev.get("message") or {}

        if t == "turn_end":
            s["turns"] += 1
            return  # turn_end repeats the message; counting it would double

        if t != "message_end":
            return

        role = msg.get("role")

        if role == "assistant":
            usage = msg.get("usage") or {}
            cost = usage.get("cost") or {}
            first = s["input"] + s["cacheRead"] + s["cacheWrite"] == 0
            s["input"] += usage.get("input", 0) or 0
            s["output"] += usage.get("output", 0) or 0
            s["cacheRead"] += usage.get("cacheRead", 0) or 0
            s["cacheWrite"] += usage.get("cacheWrite", 0) or 0
            s["cost"] += float(cost.get("total", 0) or 0)
            if first:
                # First-turn resident context: the residency measurement, taken
                # on the wire rather than inferred from a catalogue file.
                s["ctx0"] = ((usage.get("input", 0) or 0)
                             + (usage.get("cacheRead", 0) or 0)
                             + (usage.get("cacheWrite", 0) or 0))
            for part in msg.get("content") or []:
                if part.get("type") == "toolCall":
                    s["toolCalls"] += 1
                    s["toolNames"].append(part.get("name") or "?")
                    args = part.get("arguments") or {}
                    # The executed source verbatim. Wait-behaviour analysis for
                    # the jobs runtime (blocking sleeps, threads, poll loops)
                    # is only possible if this is kept, and the environment
                    # is gone by the time anyone asks.
                    #
                    # BOTH argument names, because the two arms do not share one.
                    # codemode's `ipython` tool takes `code`; vanilla's `bash`
                    # tool takes `command` (packages/coding-agent/src/core/tools/
                    # bash.ts:25). Reading only `code` gave the vanilla arm an
                    # empty `cells` list, so `blockingSleepCells`,
                    # `daemonCells` and `threadCells` were all a structural 0 —
                    # not "vanilla never blocks" but "we never looked". A metric
                    # that can only report zero for one arm is the false-null
                    # shape this repo keeps paying for.
                    src = args.get("code")
                    if not isinstance(src, str):
                        src = args.get("command")
                    if isinstance(src, str):
                        s["cells"].append(src)
                elif part.get("type") == "text" and part.get("text"):
                    s["finalText"] = part["text"]

        elif role == "toolResult":
            if msg.get("isError"):
                s["toolErrors"] += 1
            details = msg.get("details") or {}
            if details.get("kernelRestarted"):
                s["kernelRestarts"] += 1
