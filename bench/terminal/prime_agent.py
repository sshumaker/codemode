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
REPO = Path(__file__).resolve().parents[2]

# codemode keeps its single execution tool and gains `edit` for safe targeted
# writes. vanilla gets prime's real shell/file set — including bash, which
# MCP-Bench withheld only because it let that arm curl past the MCP tools under
# test. Here the machine *is* the surface, so withholding it would model no
# harness anyone ships. Both arms are levelled up, never down.
ARM_TOOLS = {
    "codemode": "ipython,edit",
    "vanilla": "bash,read,edit,write,grep,find,ls",
}


class PrimeAgent(BaseAgent):
    def __init__(
        self,
        model_name: str | None = None,
        arm: str = "codemode",
        jobs: str = "off",
        max_cost: float | None = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        if arm not in ARM_TOOLS:
            raise ValueError(f"arm must be one of {sorted(ARM_TOOLS)}, got {arm!r}")
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
        r = self._exec(session, ["sh", "-c",
                                 f"cat {AGENT_ROOT}/prime/dist/bundle/*.js"])
        blob = r.output
        checks["build_markers"] = {
            m: (m.encode() in blob) for m in want
        }
        checks["build_ok"] = all(checks["build_markers"].values())
        return checks

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
        preamble = self._jobs_prompt() if self._jobs == "on" else ""

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
            "--no-context-files", "--no-prompt-templates", "--no-extensions",
            *(["--append-system-prompt", preamble] if preamble else []),
            instruction,
        ]

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

        buf = b""
        summary["ctx0"] = 0
        summary["kernelRestarts"] = 0
        summary["cells"] = []
        with raw_path.open("wb") as raw, traj_path.open("w") as traj:
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
                        # Not a protocol line (node warnings, stderr interleaved).
                        # Kept in stream.jsonl, which is why that file is raw.
                        continue
                    ev["_t"] = time.clock_gettime(time.CLOCK_REALTIME)
                    traj.write(json.dumps(ev) + "\n")
                    traj.flush()
                    self._accumulate(ev, summary)

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
            r = self._exec(session, ["sh", "-c",
                                     f"cat {RUNTIME_DIR}/jobs/*/meta.json 2>/dev/null"])
            (logging_dir / "jobs-manifest.txt").write_bytes(r.output)

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
                    if isinstance(args.get("code"), str):
                        # The cell source verbatim. Wait-behaviour analysis for
                        # the jobs runtime (blocking sleeps, threads, poll loops)
                        # is only possible if this is kept, and the environment
                        # is gone by the time anyone asks.
                        s["cells"].append(args["code"])
                elif part.get("type") == "text" and part.get("text"):
                    s["finalText"] = part["text"]

        elif role == "toolResult":
            if msg.get("isError"):
                s["toolErrors"] += 1
            details = msg.get("details") or {}
            if details.get("kernelRestarted"):
                s["kernelRestarts"] += 1
