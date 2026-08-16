"""
`jobs` — the hosted-runtime surface, injected into the agent's kernel.

Implements docs/HOSTED-RUNTIME-DESIGN.md: one namespace, a small surface, and work
that outlives the cell and the kernel.

    build = jobs.submit("gradle build", name="build", max_runtime="1h")
    ready = jobs.submit("until curl -sf localhost:5000/health; do sleep 2; done",
                        name="ready", expect="once")
    jobs.wait(wake_after=60)          # last statement of the cell
    jobs.get("build"); jobs.list(); jobs.kill("build"); jobs.manifest()

Why this exists
---------------
On TheAgentCompany the agent had no way to express waiting, so it wrote
`time.sleep(235)` inside cells — nine times on one task, ~3050s total — which holds a
single-threaded kernel, collides with the cell timeout, and spawned four
`threading.Thread` pollers that raced on one dict and were never stopped.

Three properties make this different from `time.sleep`:

1. **`wait` does not sleep here.** It prints a sentinel and returns immediately, so
   the cell finishes and the kernel is released. The *tool wrapper* on the host does
   the sleeping, between the cell finishing and the model being called again. Same
   wall-clock, but nothing is held: no kernel, no frame, no thread.
2. **`submit` detaches** and records the job as a file, so the work outlives both the
   cell and the kernel, and is discoverable after a restart. Nothing registered
   closes over the namespace — the payload is a command string, which is data.
3. **Failure is visible.** A condition that never fires is the characteristic silent
   failure of this kind of API; `expect=` lints the mechanism at arm time and the
   manifest turns silence into a line.

Deliberately absent: any handler taking a callable. `submit` accepts a shell command
or a script path, never a function, because a closure cannot be reconstructed once
the kernel is gone.

Testability
-----------
`JobStore` takes its clock, its spawner and its directory as arguments, so the whole
surface can be exercised without spawning a process or sleeping. Module-level
functions delegate to one default store bound to the real ones.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import signal
import subprocess
import sys
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

# The tool wrapper greps stdout for this. Deliberately unmistakable.
WAIT_SENTINEL = "__HARNESS_WAIT_SECONDS__"

def _default_job_dir(env: Optional[Dict[str, str]] = None, warn=None) -> str:
    """
    Where jobs live, scoped to ONE agent session.

    This cannot be keyed to the kernel process: surviving a kernel restart is the
    entire point, so a pid-scoped directory would lose exactly what it exists to
    keep. It must be keyed to the session, which only the harness knows.

    The previous default was a machine-global `/tmp/jobs`. The kernel itself is a
    separate OS process per session, so the guards and namespace cannot leak between
    agents — but this directory could, and it is the one piece of durable state here.
    Two agents on one host would have seen each other's jobs in list(), in manifest()
    and in the startup announcement, and would have collided on names: one agent's
    `submit(name="build")` refused because a *different* agent had a job called
    build. Silent cross-talk in the one component designed to outlive everything.
    """
    env = os.environ if env is None else env
    # Diagnostics go to stderr. This function runs at import, and `jobs.py --docs`
    # writes api/jobs.md from stdout — a warning on stdout would be embedded in the
    # generated documentation, which is the sort of thing nobody notices until the
    # agent reads it back.
    warn = warn or (lambda m: print(m, file=sys.stderr))
    explicit = env.get("HARNESS_JOB_DIR")
    if explicit:
        return explicit
    # PRIME_AGENT_CODING_AGENT_DIR is per-run in this harness, which makes it the
    # natural session key.
    agent_dir = env.get("PRIME_AGENT_CODING_AGENT_DIR")
    if agent_dir:
        return os.path.join(agent_dir, "jobs")
    session = env.get("HARNESS_SESSION_ID")
    if session:
        return os.path.join("/tmp", f"jobs-{session}")
    # Nothing identifies this session. Fall back to a private directory rather than a
    # shared one, and say so — a shared default is the failure this function exists to
    # prevent, and it would be invisible until two agents disagreed about a job.
    private = os.path.join("/tmp", f"jobs-{os.getuid()}-{os.getpid()}")
    warn(
        f"[jobs] no session identifier (HARNESS_JOB_DIR / PRIME_AGENT_CODING_AGENT_DIR / "
        f"HARNESS_SESSION_ID); using {private}, which does NOT survive a kernel restart. "
        f"Set one of those to make jobs recoverable."
    )
    return private


DEFAULT_JOB_DIR = _default_job_dir()
MAX_WAIT = int(os.environ.get("HARNESS_MAX_WAIT_SECONDS", "3600"))
# A wait shorter than this costs a whole turn to save a trivial pause, so it is a
# bad trade against just letting the cell finish. §9: median observed pause is 5s
# against a 60s floor, which is why pacing belongs in submit and not here.
MIN_WAIT = int(os.environ.get("HARNESS_MIN_WAIT_SECONDS", "60"))
# Fraction of max_runtime after which a job that has emitted nothing is flagged.
SILENCE_FRACTION = 0.4
# A marker-less job must be observed dead TWICE, this far apart, before its
# record flips to `died` — the flip is one-way, and `ps` can misread transiently.
DEATH_CONFIRM_SECONDS = float(os.environ.get("HARNESS_DEATH_CONFIRM_SECONDS", "1.0"))

VALID_EXPECT = ("once", "stream")

# States in which a job's process may exist. `starting` is the interval between
# claiming the name on disk and recording the pid — see submit().
LIVE_STATES = ("running", "starting")


class JobError(RuntimeError):
    """Raised for arming failures and for access to a dead job's results."""


class WaitSignal(BaseException):
    """
    Ends the cell at `jobs.wait(...)`.

    Not an error — control flow. `wait` cannot block (the whole design is that the
    host sleeps once the cell has finished and the kernel is released), so anything
    after it in the same cell would run *immediately*, before any waiting, and read
    state that has not changed yet:

        jobs.wait(wake_after=60)
        print(jobs.get("x").output)   # reads the job NOW, sees nothing, no error

    An earlier version detected this by parsing the cell with `ast` and refusing when
    the call was not the last statement. That works, but it checks an invariant
    instead of establishing one — and the machinery (frame walking, linecache, ast)
    produced two bugs of its own, including a version that passed every unit test and
    did nothing at all in a real kernel. Raising makes the trailing code unreachable
    by construction, and there is nothing left to get wrong.

    Derives from BaseException so a stray `except Exception:` around the agent's own
    code cannot swallow it and silently resurrect the bug.
    """


# --------------------------------------------------------------------------------
# duration parsing
# --------------------------------------------------------------------------------

def parse_duration(v: Any) -> int:
    """Accept 60, "60", "90s", "5m", "1h" — the doc's examples use all of them."""
    if isinstance(v, bool):
        raise TypeError(f"duration must be a number or string, got {v!r}")
    if isinstance(v, (int, float)):
        if v < 0:
            raise ValueError(f"duration must not be negative: {v}")
        return int(v)
    s = str(v).strip().lower()
    if not s:
        raise ValueError("duration must not be empty")
    unit = s[-1:]
    mult = {"s": 1, "m": 60, "h": 3600, "d": 86400}.get(unit)
    body = s[:-1] if mult else s
    try:
        n = float(body)
    except ValueError as exc:
        raise ValueError(f"cannot parse duration {v!r}") from exc
    if n < 0:
        raise ValueError(f"duration must not be negative: {v}")
    return int(n * (mult or 1))


# --------------------------------------------------------------------------------
# arming lint — the guard for the failure mode this API is most prone to
# --------------------------------------------------------------------------------
#
# A shell condition buys full expressiveness at the price of total unverifiability,
# and it fails *silently*: notification count is an emergent property of the
# script's control flow, not a declared intent. Three independent things must be
# right — does it exit, does every stage flush, does the filter cover failure — and
# nothing checks any of them.
#
# `expect=` makes the intent declarable, which is what lets the mechanism be linted.
# Design doc §4 "Arming failures, and the two guards worth having".

# Sources that never terminate on their own.
_UNBOUNDED = (
    (re.compile(r"\btail\b[^|;]*\s-(?:-follow\b|\w*f)"), "tail -f"),
    (re.compile(r"\bwhile\s+(?:true|:)\b"), "while true"),
    (re.compile(r"\byes\b(?:\s|$)"), "yes"),
    (re.compile(r"\bsleep\s+infinity\b"), "sleep infinity"),
    (re.compile(r"\b(?:journalctl|kubectl\s+logs|docker\s+logs)\b[^|;]*\s-(?:-follow\b|\w*f)"), "log follow"),
    (re.compile(r"\bwatch\b\s"), "watch"),
)

# A loop whose exit is a condition — the recommended one-shot shape.
_CONDITION_LOOP = re.compile(r"\b(?:until|while\s+!)\b")


def _stages(command: str) -> List[str]:
    """Split a pipeline into stages. Crude on purpose — it only informs warnings."""
    return [s.strip() for s in re.split(r"\|(?!\|)", command) if s.strip()]


def _unbounded_hits(command: str) -> List[str]:
    return [label for pattern, label in _UNBOUNDED if pattern.search(command)]


def lint_condition(command: str, expect: str) -> List[Tuple[str, str]]:
    """
    Return [(code, message)] for mechanisms that cannot deliver the declared intent.

    Pure function of the command string, so it is cheap to test exhaustively and
    carries no I/O. Codes are stable identifiers; messages are for the agent.
    """
    if expect not in VALID_EXPECT:
        return [("BAD_EXPECT", f"expect must be one of {VALID_EXPECT}, got {expect!r}")]

    problems: List[Tuple[str, str]] = []
    stages = _stages(command)
    unbounded = _unbounded_hits(command)
    has_condition_loop = bool(_CONDITION_LOOP.search(command))

    if expect == "once":
        # "fires, stays armed": an unbounded source for a one-shot need lingers until
        # its deadline. `grep -m 1` does NOT rescue it — if the stream goes quiet,
        # tail never receives SIGPIPE and never exits.
        if unbounded:
            problems.append((
                "ONCE_NEVER_EXITS",
                f"expect='once' but the command never exits on its own ({', '.join(unbounded)}). "
                "It will linger until max_runtime. Prefer exit status over output matching:\n"
                "    until curl -sf localhost:5000/health; do sleep 2; done\n"
                "Note `grep -m 1` does not fix this: if the stream goes quiet the source "
                "never gets SIGPIPE.",
            ))
    else:  # stream
        # "exits immediately": a bounded command when a watch was wanted performs one
        # check and returns, which looks exactly like success.
        if not unbounded and not has_condition_loop:
            problems.append((
                "STREAM_EXITS_IMMEDIATELY",
                "expect='stream' but the command terminates after one pass, so it will "
                "emit once and exit rather than watching. Use a following source "
                "(e.g. `tail -f`) or a loop.",
            ))

    # "armed, never fires": a non-flushing stage in the middle of a pipeline holds
    # output in a 4KB buffer, so events arrive late or never. Only matters when
    # something is actually streaming through the pipe.
    streaming = bool(unbounded) or expect == "stream"
    if streaming and len(stages) > 1:
        for i, stage in enumerate(stages):
            downstream = i < len(stages) - 1
            if re.search(r"\bgrep\b", stage) and not re.search(r"--line-buffered|\s-u\b", stage) and downstream:
                problems.append((
                    "NON_FLUSHING",
                    f"stage {i + 1} `{stage}` buffers: add --line-buffered to grep, or output "
                    "will arrive in 4KB blocks and may never arrive at all.",
                ))
            if re.search(r"\bawk\b", stage) and "fflush" not in stage and downstream:
                problems.append((
                    "NON_FLUSHING",
                    f"stage {i + 1} `{stage}` buffers: awk needs fflush() to emit line by line.",
                ))
            if re.search(r"\bsed\b", stage) and not re.search(r"\s-u\b|--unbuffered", stage) and downstream:
                problems.append((
                    "NON_FLUSHING",
                    f"stage {i + 1} `{stage}` buffers: sed needs -u to emit line by line.",
                ))
            if re.search(r"\bhead\b", stage):
                problems.append((
                    "CANNOT_FLUSH",
                    f"stage {i + 1} `{stage}` uses head, which cannot flush incrementally; "
                    "it will hold output until its count is reached or the stream closes.",
                ))
    return problems


# --------------------------------------------------------------------------------
# blocking waits inside a shell script
# --------------------------------------------------------------------------------
#
# `time.sleep(40)` is guarded at the point of use. `%%bash` + `sleep 40` is the same
# act — it holds the single-threaded kernel for 40 seconds — and no Python guard can
# see it, because the sleeping happens in a subprocess.
#
# Measured: once %%bash was un-broken, an agent with no resident guidance blocked the
# kernel twice with `%%bash\nsleep 40` and still produced the right answer. Right
# answer, wrong mechanism, and nothing caught it.
#
# A full bash grammar is not needed and not wanted (it would mean a parser dependency
# inside the agent's kernel venv). What is needed is: which sleeps run in the
# foreground, and does anything loop around one. shlex tokenises with correct quote
# handling, which is the part regex gets wrong.

_LOOP_OPENERS = ("while", "until", "for")


def _tokens(script: str) -> List[str]:
    """
    Tokenise with shlex so quoted text is not mistaken for structure.

    `echo "sleep 40"` is a string, not a wait, and a regex over raw source cannot
    tell the difference.
    """
    lexer = shlex.shlex(script, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        return _list(lexer)
    except ValueError:
        # Unbalanced quotes: the shell will fail on this anyway, so decline to judge.
        return []


# shlex consumes the iterator; bind the builtin before this module's own `list()`
# shadows it further down.
_list = list

_SEPARATORS = (";", "&&", "||", "|", "&", "\n")


def blocking_sleep(script: str, ceiling: int = 30) -> Optional[str]:
    """
    Describe the blocking wait in a shell script, or None if it does not hold.

    Conservative by design: a backgrounded sleep does not hold the kernel and is
    allowed, because starting work in the background is legitimate — the problem is
    waiting for it in the foreground. That includes backgrounded *subshells*
    (`(sleep 40; touch f) &`), which the first version of this got wrong: it split on
    separators without tracking parentheses, so the `&` attached to the closing paren
    and the inner sleep looked like a foreground wait. That shape is exactly how an
    agent legitimately starts a background process.
    """
    tokens = _tokens(script)
    if not tokens:
        return None

    # Which token indices sit inside a subshell that is backgrounded as a whole.
    backgrounded: set = set()
    stack: List[int] = []
    for i, tok in enumerate(tokens):
        if tok == "(":
            stack.append(i)
        elif tok == ")" and stack:
            open_at = stack.pop()
            if i + 1 < len(tokens) and tokens[i + 1] == "&":
                backgrounded.update(range(open_at, i + 1))

    total = 0.0
    depth = 0
    for i, tok in enumerate(tokens):
        if tok in ("while", "until", "for"):
            depth += 1
        elif tok == "done":
            depth = max(0, depth - 1)
        if tok != "sleep" or i in backgrounded:
            continue
        # Foreground only: `sleep 40 &` is fine, so look ahead for the separator that
        # terminates this statement and check whether it is `&`.
        j = i + 1
        while j < len(tokens) and tokens[j] not in _SEPARATORS:
            j += 1
        if j < len(tokens) and tokens[j] == "&":
            continue
        if depth > 0:
            return "a polling loop (`sleep` inside a while/until/for) holds this cell for an unbounded time"
        arg = tokens[i + 1] if i + 1 < len(tokens) else ""
        try:
            total += float(arg)
        except ValueError:
            continue
    # `>=`, not `>`. Measured: with no guidance an agent wrote `%%bash ... sleep 30`
    # against a ceiling of 30 and slipped through, twice — models reach for round
    # numbers, and the round number nearest a limit IS the limit. Same off-by-one as
    # the silence fraction.
    if total >= ceiling:
        return f"`sleep` totalling {total:g}s in the foreground holds this cell for that long"
    return None


# --------------------------------------------------------------------------------
# the same guard, for a bash TOOL rather than a %%bash cell
# --------------------------------------------------------------------------------
#
# `_guard_shell_cells` in kernel-prelude.py calls `blocking_sleep` directly, because
# it runs inside the kernel. A bash *tool* runs in the harness process, in
# TypeScript, and it is the same act: a command that waits holds the agent's turn
# and the long-wait advantage disappears. Measured on compile-compcert — the arm
# with a kernel handed a 30-minute build to `jobs.submit` and passed; the arms that
# blocked on it failed.
#
# The guard must therefore be reachable from outside Python, and it must be THE
# guard rather than a port of it. A TypeScript reimplementation would be a second
# implementation wearing one name, and the first divergence would be invisible —
# the exact shape of every bug in this project's history. So the tool shells out to
# `jobs.py --check-blocking`, and there is one `blocking_sleep` in the world.
#
# The message is generated here for the same reason `--prompt` is: a harness that
# hard-codes its own copy is one refactor away from naming a function that no
# longer exists.


def shell_job_redirect(problem: str, command: str = "") -> str:
    """
    What to say to an agent whose bash command was refused.

    Structurally the prelude's `_redirect`, with one difference that matters: this
    reader is holding a *shell* tool, so it has to be told that `jobs` is Python
    living in the ipython tool. Without that line the obvious next move is to run
    `jobs.submit(...)` as a shell command, which fails in a way that teaches the
    agent the primitive is broken rather than that it is elsewhere.
    """
    first = (command.strip().splitlines() or ["your command"])[0][:60]
    return (
        f"{problem}\n"
        "Hand it to a job instead — it runs outside your turn, outlives the cell and "
        "the kernel, and nothing is held while it runs:\n"
        f"    jobs.submit({first!r}, name='pick-a-name', max_runtime='1h')\n"
        "    jobs.wait(wake_after=300)   # last statement of the cell\n"
        "then jobs.get('pick-a-name') to collect it: .done, .ok, .output.\n"
        "`jobs` is Python and lives in the ipython tool — run those three lines "
        "there, not as a shell command."
    )


def check_blocking(command: str, ceiling: int = 30) -> dict:
    """The bash tool's pre-flight verdict, as data. Pure, so it is cheap to test."""
    reason = blocking_sleep(command, ceiling)
    return {
        "blocking": reason is not None,
        "reason": reason,
        "message": None if reason is None else shell_job_redirect(
            f"this bash command blocks your turn: {reason}", command),
    }


def timeout_message(seconds: float, command: str = "") -> str:
    """
    What to say when a bash command was killed at the ceiling.

    The counterpart to the prelude's cell watchdog, and it exists for the same
    reason: `blocking_sleep` finds no sleep in `make`, so the pre-flight check
    passes and a 20-minute build blocks the turn anyway. A wall-clock ceiling is
    the universal backstop (design §6), and the whole value of it is that the kill
    arrives with the replacement named — a bare "timed out" teaches nothing and the
    agent writes the same line again.
    """
    return shell_job_redirect(
        f"this bash command ran for {seconds:g}s without returning and was stopped. "
        "Nothing else could happen while it ran, and a command that long has no way "
        "to report progress, survive a restart, or be stopped",
        command,
    )


# --------------------------------------------------------------------------------
# handles
# --------------------------------------------------------------------------------

class Job:
    """
    A view over control-plane state. Its whole durable identity is `name`.

    Deliberately NOT awaitable (§4). The risk is bulk — 1,934 `gather` calls in the
    observed cells — so `await asyncio.gather(*[submit(c) for c in calls])` is the
    shape to prevent, and making the handle awaitable is what would allow it.
    """

    __slots__ = ("name", "_store")

    def __init__(self, name: str, store: "JobStore"):
        self.name = name
        self._store = store

    def __repr__(self) -> str:
        rec = self._store._refresh(self._store._read(self.name)) or {"state": "missing"}
        extra = ""
        if rec.get("state") in LIVE_STATES and rec.get("silent"):
            extra = " ⚠ never fired"
        return f"<Job {self.name} {rec.get('state')}{extra}>"

    def __await__(self):
        raise TypeError(
            f"Job {self.name!r} is not awaitable. A job outlives this kernel, so there is "
            "nothing to await inside it.\n"
            "  end the cell with:  jobs.wait(wake_after=60)\n"
            "  then check:         jobs.get(%r)" % (self.name,)
        )

    # Equality/hash by name so aliasing (`b2 = batch`) behaves and rehydration can
    # intern handles to one object per job id (§5 aliasing failure mode).
    def __eq__(self, other: object) -> bool:
        return isinstance(other, Job) and other.name == self.name

    def __hash__(self) -> int:
        return hash(("Job", self.name))

    @property
    def state(self) -> str:
        rec = self._store._refresh(self._store._read(self.name)) or {}
        return rec.get("state", "missing")

    @property
    def done(self) -> bool:
        return self.state in ("done", "killed", "deadline", "died")

    @property
    def ok(self) -> bool:
        rec = self._store._refresh(self._store._read(self.name)) or {}
        return rec.get("state") == "done" and rec.get("exit_code") == 0

    @property
    def exit_code(self) -> Optional[int]:
        rec = self._store._refresh(self._store._read(self.name)) or {}
        return rec.get("exit_code")

    @property
    def reason(self) -> Optional[str]:
        """Why this job ended. A deadline that never fired says so explicitly."""
        rec = self._store._refresh(self._store._read(self.name)) or {}
        return rec.get("reason")

    @property
    def output(self) -> str:
        """Whatever the job has written so far — it is a file, so peeking is free."""
        rec = self._store._read(self.name) or {}
        return self._store._read_log(rec)


class Subagent(Job):
    """
    A job that is a child agent (see subagents.py).

    Everything a Job does, plus the three things that are only meaningful for a
    child: what it answered, what it cost, and where its trajectory is. All of them
    are read from files the child wrote, so they survive the parent's kernel exactly
    as the job record does — and a partial result (a child stopped at its turn cap)
    is readable rather than discarded.

    Lives here rather than in subagents.py so that `jobs.get(name)` can return it
    without jobs.py importing the module that imports jobs.py.
    """

    __slots__ = ()

    def _meta(self) -> dict:
        rec = self._store._read(self.name) or {}
        path = (rec.get("meta") or {}).get("meta_path")
        try:
            with open(path) as fh:
                return json.load(fh)
        except (OSError, ValueError, TypeError):
            return {}

    def _spec(self) -> dict:
        return (self._store._read(self.name) or {}).get("meta") or {}

    def __repr__(self) -> str:
        rec = self._store._refresh(self._store._read(self.name)) or {"state": "missing"}
        meta = self._meta()
        extra = f" {meta['turns']} turns ${meta['cost']:.4f}" if meta.get("turns") else ""
        return f"<Subagent {self.name} {rec.get('state')}{extra}>"

    @property
    def result(self) -> str:
        """
        The child's final text — the answer, without the job log around it.

        Empty until the child has produced one. A child killed at a cap still writes
        whatever it had said, so this is worth reading even when `.ok` is False.
        """
        path = self._spec().get("result")
        try:
            with open(path) as fh:
                return fh.read()
        except (OSError, TypeError):
            return ""

    @property
    def transcript(self) -> str:
        """Path to the child's full JSON stream. Read it when the answer surprises you."""
        return self._spec().get("transcript", "")

    @property
    def turns(self) -> Optional[int]:
        return self._meta().get("turns")

    @property
    def cost(self) -> Optional[float]:
        return self._meta().get("cost")

    @property
    def tool_calls(self) -> Optional[int]:
        return self._meta().get("toolCalls")

    @property
    def model(self) -> str:
        return self._spec().get("model", "")

    @property
    def tools(self) -> str:
        return self._spec().get("tools", "")

    @property
    def prompt(self) -> str:
        """What the child was asked. The whole input side of the handoff."""
        return self._spec().get("prompt", "")


class Tombstone(Job):
    """
    A handle to a job that is gone.

    Rehydration binds one of these rather than leaving the name undefined, so the
    agent gets an explanation at the point of use instead of a NameError three lines
    later (§5 "Dead job — rehydrate to a tombstone that raises with the reason").
    """

    __slots__ = ("_reason",)

    def __init__(self, name: str, store: "JobStore", reason: str):
        super().__init__(name, store)
        self._reason = reason

    def __repr__(self) -> str:
        return f"<Job {self.name} GONE: {self._reason}>"

    def _raise(self):
        raise JobError(
            f"job {self.name!r} is gone: {self._reason}. "
            "Re-submit it if you still need the work; its results are not recoverable."
        )

    @property
    def state(self) -> str:
        return "gone"

    @property
    def done(self) -> bool:
        return True

    @property
    def ok(self) -> bool:
        return False

    @property
    def output(self) -> str:
        self._raise()

    @property
    def exit_code(self) -> Optional[int]:
        self._raise()


# --------------------------------------------------------------------------------
# the store
# --------------------------------------------------------------------------------

SpawnFn = Callable[[str, str, Optional[str]], int]


def _real_spawn(wrapped_command: str, log_path: str, cwd: Optional[str]) -> int:
    """Detach with setsid so the job survives the cell, the tool call and the kernel."""
    with open(log_path, "wb") as out:
        proc = subprocess.Popen(
            wrapped_command,
            shell=True,
            stdout=out,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            cwd=cwd,
        )
    return proc.pid


def _real_probe(pid: int):
    """
    ("dead" | "alive", start_identity) for a pid this process may not own.

    `ps` rather than os.kill(pid, 0): a SIGKILLed child of a still-living kernel
    stays a zombie until reaped, and kill(0) counts a zombie as alive — so the
    marker-less death this probe exists to detect would read as "running". `ps`
    reports state Z directly, and `lstart` is the start identity that survives
    nothing: a reused pid has a different one, which is what makes signalling a
    recorded pid safe (2026-08-15 review, H2/H3; same defence prime's
    session-lease uses).
    """
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", "state=,lstart="],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except Exception:
        return ("alive", None)  # cannot probe: never report death on no evidence
    if not out:
        return ("dead", None)
    state, _, lstart = out.partition(" ")
    if state.startswith("Z"):
        return ("dead", None)
    return ("alive", lstart.strip() or None)


class JobStore:
    """
    The whole surface. Clock, spawner and directory are injected so tests never
    spawn a process, never sleep, and never touch a shared path.
    """

    def __init__(
        self,
        job_dir: Optional[str] = None,
        *,
        now: Callable[[], float] = time.time,
        spawn: SpawnFn = _real_spawn,
        kill: Optional[Callable[[int], None]] = None,
        probe: Optional[Callable[[int], tuple]] = None,
        cwd: Optional[str] = None,
        emit: Callable[[str], None] = print,
        max_wait: Optional[int] = None,
        min_wait: Optional[int] = None,
    ):
        # Resolved HERE, not at import: module-level defaults froze the config at
        # class-definition time, so a host that re-targets HARNESS_JOB_DIR before
        # resuming a session onto a new volume was silently ignored (review, M6).
        self.job_dir = job_dir or os.environ.get("HARNESS_JOB_DIR") or _default_job_dir()
        self._now = now
        self._spawn = spawn
        self._kill = kill if kill is not None else self._default_kill
        self._cwd = cwd or os.environ.get("HARNESS_JOB_CWD") or os.getcwd()
        self._probe = probe if probe is not None else _real_probe
        self._emit = emit
        self._max_wait = max_wait if max_wait is not None else int(os.environ.get("HARNESS_MAX_WAIT_SECONDS", "3600"))
        self._min_wait = min_wait if min_wait is not None else int(os.environ.get("HARNESS_MIN_WAIT_SECONDS", "60"))
        # Intern handles by name so aliases resolve to one object (§5 aliasing).
        self._handles: Dict[str, Job] = {}
        os.makedirs(self.job_dir, exist_ok=True)

    # -- storage ---------------------------------------------------------------
    @staticmethod
    def _default_kill(pid: int) -> None:
        os.killpg(os.getpgid(pid), signal.SIGKILL)

    def _path(self, name: str) -> str:
        return os.path.join(self.job_dir, f"{name}.json")

    def _log_path(self, name: str) -> str:
        return os.path.join(self.job_dir, f"{name}.log")

    def _pid_path(self, name: str) -> str:
        """
        Where the job records its OWN pid.

        The pid returned by Popen is known only to the process that called it, and that
        process is exactly the one this design expects to die. A job that writes its own
        pid is findable by a kernel that never saw the spawn — same reasoning as the
        exit marker, which exists because a completed child of a dead kernel cannot be
        reported by anything held in memory.
        """
        return os.path.join(self.job_dir, f"{name}.pid")

    def _read(self, name: str) -> Optional[dict]:
        try:
            with open(self._path(name)) as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    def _write(self, rec: dict) -> None:
        """
        Atomically. A record is the only evidence a job exists, so a half-written one is
        indistinguishable from no job at all: `_read` catches the ValueError and returns
        None, `_all` skips it, `manifest()` says "no jobs yet" and `submit` allows the
        name to be reused. Write to a sibling and rename, so a reader sees either the
        previous record or the new one and never a prefix of either.
        """
        path = self._path(rec["name"])
        tmp = f"{path}.tmp"
        with open(tmp, "w") as fh:
            json.dump(rec, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        # The rename is atomic but not durable: on a hard host stop the rename can
        # be visible with the data not yet on disk, reintroducing the work-exists-
        # record-does-not window the write ordering exists to close (review, M3).
        try:
            dfd = os.open(self.job_dir, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:
            pass

    def _read_log(self, rec: dict, limit: int = 200_000) -> str:
        """The log's TAIL, bounded. A verbose build writes hundreds of MB, and an
        unbounded read of it OOMs the kernel at jobs.get(name).output (review, M2).
        The full file stays on disk at rec["log"] for targeted reads."""
        try:
            with open(rec.get("log", ""), "rb") as fh:
                fh.seek(0, os.SEEK_END)
                size = fh.tell()
                fh.seek(max(0, size - limit))
                text = fh.read().decode(errors="replace")
                if size > limit:
                    text = f"[...{size - limit} earlier bytes in {rec.get('log')}]\n" + text
                return text
        except OSError:
            return rec.get("output_tail", "")

    def _log_bytes(self, rec: dict) -> int:
        try:
            return os.path.getsize(rec.get("log", ""))
        except OSError:
            return 0

    def _all(self) -> List[dict]:
        out = []
        try:
            names = sorted(os.listdir(self.job_dir))
        except OSError:
            return out
        for f in names:
            if f.endswith(".json"):
                rec = self._read(f[:-5])
                # `started_at` is written by submit() and by nothing else, so it is
                # what distinguishes a job record from any other JSON that happens to
                # share the directory. Without this check a sibling file — the first
                # one written was a subagent's `<name>.meta.json` — is read back as a
                # job named "<name>.meta", and manifest() raises KeyError while
                # listing it. That takes out the manifest, jobs.list() and the
                # prelude's startup announcement at once, for a file that is not a
                # job at all. Skipping is right: a record missing the field submit
                # always writes is not a job, whoever wrote it.
                if rec and "started_at" in rec:
                    out.append(rec)
        return out

    # -- lifecycle -------------------------------------------------------------
    def _refresh(self, rec: Optional[dict]) -> Optional[dict]:
        """
        Liveness is read from the OS, not remembered in the heap.

        Deliberately not `os.kill(pid, 0)`: a finished child of a still-running
        kernel is a zombie and that check succeeds on zombies, which reported
        completed jobs as running. The exit marker is also the only signal that
        survives the kernel dying.
        """
        if not rec or rec.get("state") not in LIVE_STATES:
            return rec
        # A `starting` record is one whose submit was interrupted between claiming the
        # name and recording the pid. The job may or may not have been spawned, and the
        # only two things that can say are written by the job itself: its pid file and
        # its exit marker. Adopt the pid the moment it appears, so a recovered job is an
        # ordinary running job — killable, and not a special case anywhere else.
        if rec.get("state") == "starting":
            try:
                with open(self._pid_path(rec["name"])) as fh:
                    rec["pid"] = int(fh.read().strip())
                rec["pid_start"] = self._probe(rec["pid"])[1]
                rec["state"] = "running"
                rec["reason"] = "recovered: submit was interrupted after this job started"
                self._write(rec)
            except (OSError, ValueError):
                pass
        marker = rec.get("exit_marker")
        if marker and os.path.exists(marker):
            try:
                with open(marker) as fh:
                    rec["exit_code"] = int((fh.read().strip() or "-1"))
            except (OSError, ValueError):
                rec["exit_code"] = None
            rec["state"] = "done"
            rec["reason"] = "completed" if rec.get("exit_code") == 0 else "exited non-zero"
            rec["finished_at"] = self._now()
            # Also on the way out, not only while running. Otherwise the byte count
            # freezes at whatever the last refresh saw — and a job never observed
            # while running is reported as "0 bytes" forever, which reads as "it
            # produced nothing" about a job that produced everything. Visible the
            # moment subagents made the log worth reading.
            rec["events"] = self._log_bytes(rec)
            rec["output_tail"] = self._read_log(rec)[-4000:]
            self._write(rec)
            return rec

        elapsed = self._now() - rec["started_at"]
        limit = rec.get("max_runtime")
        if limit and elapsed > limit:
            # max_runtime is about the work, not the agent's attention. A deadline
            # that elapses with nothing emitted is reported as exactly that, rather
            # than as a silent kill — Monitor's timeout says nothing, and that is the
            # difference between a diagnosable failure and a mystery.
            fired = self._log_bytes(rec) > 0
            self._terminate(rec, state="deadline",
                            reason="deadline reached, condition fired" if fired
                            else "deadline reached, never fired")
            return self._read(rec["name"]) or rec

        # Liveness fallback (review, H2): the exit marker is written by the dying
        # process, so a SIGKILL or a host eviction leaves no marker and the record
        # said "running" FOREVER — precisely the event a schedulable runtime must
        # survive. If the recorded process is gone (or its pid was reused by a
        # stranger — start identities differ), the work is provably not running.
        #
        # Two observations, a grace interval apart, before the record flips: the
        # died write is one-way (a terminal state is never re-refreshed), so a
        # single transient `ps` misread — seen flaking under a loaded test suite —
        # would permanently kill a live job. A first dead sighting only stamps
        # `dead_seen_at`; death is declared when a SECOND sighting confirms it
        # after the grace period with the marker still absent. A live process
        # observed in between clears the stamp.
        pid = rec.get("pid")
        if pid:
            status, start = self._probe(pid)
            recorded = rec.get("pid_start")
            reused = status == "alive" and recorded and start and start != recorded
            if status == "dead" or reused:
                seen = rec.get("dead_seen_at")
                if seen is None:
                    rec["dead_seen_at"] = self._now()
                    self._write(rec)
                elif self._now() - seen >= DEATH_CONFIRM_SECONDS:
                    rec["state"] = "died"
                    rec["reason"] = (
                        "process died without writing an exit marker — killed or evicted; "
                        "the log tail below is everything it produced"
                    )
                    rec["finished_at"] = self._now()
                    rec["events"] = self._log_bytes(rec)
                    rec["output_tail"] = self._read_log(rec)[-4000:]
                    self._write(rec)
                    return rec
            elif rec.get("dead_seen_at") is not None:
                rec["dead_seen_at"] = None
                self._write(rec)

        # Silence flag: cannot prove a filter will fire, but can say it hasn't.
        rec["events"] = self._log_bytes(rec)
        # `>=`, not `>`: the doc's worked example is "0 events in 240s of 600s ⚠ never
        # fired", which is exactly the 0.4 boundary. A strict inequality silently
        # withholds the warning at the moment it is first due.
        rec["silent"] = bool(limit) and rec["events"] == 0 and elapsed >= limit * SILENCE_FRACTION
        return rec

    def _terminate(self, rec: dict, *, state: str, reason: str) -> None:
        pid = rec.get("pid")
        if pid:
            # Never signal a pid this record can no longer vouch for: records can
            # be arbitrarily old, and killpg on a reused pid SIGKILLs an unrelated
            # process GROUP (review, H3). The eval harness re-validated before
            # signalling; the shipped module did not.
            status, start = self._probe(pid)
            recorded = rec.get("pid_start")
            if status == "dead" or (recorded and start and start != recorded):
                reason = f"{reason}; the recorded process was already gone, nothing was signalled"
            else:
                try:
                    self._kill(pid)
                except OSError:
                    pass
        elif rec.get("state") == "starting":
            # Nothing to signal, and saying "killed" without qualification would be a
            # lie in the one case where it matters: the job may be running and simply
            # never got as far as writing its pid. Record what was actually done.
            reason = f"{reason}; no pid was recorded, so nothing was signalled — if the work did start it is still running"
            # Machine-readable: submit() refuses to reuse this name, because the
            # caveat above lives in a string nothing reads back (review, M5).
            rec["unconfirmed"] = True
        rec["state"] = state
        rec["reason"] = reason
        rec["finished_at"] = self._now()
        rec["output_tail"] = self._read_log(rec)[-4000:]
        self._write(rec)

    # -- surface ---------------------------------------------------------------
    def submit(
        self,
        payload: Any,
        name: Optional[str] = None,
        *,
        max_runtime: Any = None,
        expect: str = "once",
        cwd: Optional[str] = None,
        strict: bool = True,
        kind: str = "job",
        meta: Optional[dict] = None,
    ) -> Job:
        """
        Start work that outlives this cell and this kernel.

        `payload` must be a shell command or a script path — data, never a callable.
        `name` is required: it is what appears in `jobs.list()`, the manifest and the
        wake event, and an unnamed job makes all three unreadable (§5).

        `kind` and `meta` are for callers built ON this surface — `spawn()` submits a
        subagent as `kind="subagent"` with the child's paths in `meta`, which is what
        makes a subagent a job rather than a parallel mechanism. Both are recorded
        verbatim and are not part of the agent-facing surface.
        """
        if callable(payload):
            raise TypeError(
                "jobs.submit takes a shell command or script path, not a callable — a "
                "function cannot be reconstructed once the kernel is gone. Write the work "
                "to a file and submit its path, e.g. jobs.submit('python work/fetch.py', "
                "name='fetch')."
            )
        if not name or not isinstance(name, str) or not name.strip():
            raise TypeError(
                "jobs.submit requires name=. It is what appears in jobs.list(), the "
                "manifest and the wake event, and it is how the job is recovered after a "
                "kernel restart — an unnamed job is unrecoverable."
            )
        name = name.strip()
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
            raise ValueError(f"job name {name!r} must be alphanumeric plus _ . -")
        existing = self._refresh(self._read(name))
        if existing and existing.get("state") == "running":
            raise JobError(
                f"job {name!r} is already running. Use a different name, or jobs.kill({name!r}) first."
            )
        # `starting` means a previous submit of this name was interrupted, and whether
        # its work is running is unknown. Refusing is the whole protection: silently
        # allowing the name back is how an interrupted submit becomes a second copy of
        # an expensive job, which is the failure the durability design exists to prevent.
        if existing and existing.get("unconfirmed"):
            # kill() on a pid-less job frees the name — that is the point of giving
            # up, and refusing here would strand names forever. But the caveat used
            # to live only in a reason string nothing read back (review, M5): say it
            # at the exact moment it matters, on the resubmit that could double-run.
            self._emit(
                f"[warn] a previous {name!r} was killed before it recorded a pid, so "
                "nothing was signalled — if that work did start, it may still be "
                "running alongside this submission."
            )
        if existing and existing.get("state") == "starting":
            raise JobError(
                f"job {name!r} was submitted but the submit did not complete — most likely the "
                "kernel died between starting the work and recording it. The work may or may "
                "not be running.\n"
                f"  jobs.get({name!r}).output   to see whether it has produced anything\n"
                f"  jobs.kill({name!r})         to give up on it and free the name\n"
                "Re-submitting under this name is refused because it would run the work twice."
            )

        command = payload if isinstance(payload, str) else " ".join(shlex.quote(str(x)) for x in payload)
        problems = lint_condition(command, expect)
        if problems and strict:
            detail = "\n".join(f"  [{code}] {msg}" for code, msg in problems)
            raise JobError(
                f"jobs.submit({name!r}) will not do what expect={expect!r} declares:\n{detail}\n"
                "Fix the command, change expect=, or pass strict=False to arm it anyway."
            )

        log = self._log_path(name)
        marker = os.path.join(self.job_dir, f"{name}.exit")
        pidfile = self._pid_path(name)
        for stale in (log, marker, pidfile):
            try:
                os.remove(stale)
            except OSError:
                pass

        rec = {
            "name": name,
            "cmd": command,
            "expect": expect,
            "pid": None,
            "log": log,
            "exit_marker": marker,
            "pid_file": pidfile,
            "state": "starting",
            "reason": None,
            "started_at": self._now(),
            "max_runtime": parse_duration(max_runtime) if max_runtime is not None else None,
            "lint": [c for c, _ in problems],
            "events": 0,
            "silent": False,
            "kind": kind,
            "meta": meta or {},
        }
        # Claim the name on disk BEFORE anything can be running under it.
        #
        # Spawn-then-write leaves a window in which the work exists and no record of it
        # does. Measured, with a real SIGKILL landing between the two: the job ran to
        # completion, wrote its output, and `jobs.get(name)` returned None while
        # `manifest()` reported "no jobs yet" — which does not merely fail to help, it
        # asserts that nothing was started. An agent that believes it re-submits, and
        # running an expensive job twice is precisely the failure durability is for.
        #
        # Ordering it the other way cannot lose work. The residual window — a crash
        # between this write and the spawn — leaves a `starting` record with no process,
        # which is a job that is *visible and may not exist* rather than one that exists
        # and is invisible. That asymmetry is the whole point: the first is recoverable
        # by looking, the second is not recoverable at all.
        self._write(rec)

        # A subshell, not a brace group: a command ending in `exit N` inside `{ }`
        # exits the *outer* shell, so the marker was never written and every job
        # reported "running" forever.
        #
        # `echo $$` first, so the job records its own pid. In `sh -c`, `$$` is the
        # shell's pid, which is exactly what Popen returns — so this is the same number,
        # written by the process that survives rather than by the one expected to die.
        # Without it a job recovered from `starting` would be unkillable.
        wrapped = (
            f"echo $$ > {shlex.quote(pidfile)} ; "
            f"( {command} ) ; echo $? > {shlex.quote(marker)}"
        )
        try:
            pid = self._spawn(wrapped, log, cwd or self._cwd)
        except BaseException:
            # A spawn that never happened must not leave a name claimed forever.
            self._terminate(rec, state="killed", reason="failed to start")
            raise
        rec["pid"] = pid
        # The pid's start identity, so a later kill/refresh can tell THIS process
        # from a stranger that inherited its number (review, H3).
        rec["pid_start"] = self._probe(pid)[1]
        rec["state"] = "running"
        self._write(rec)

        if problems and not strict:
            for code, msg in problems:
                self._emit(f"[warn {code}] {msg}")
        self._emit(f"submitted {name} (pid {pid}); log {log}")
        return self._handle(name)

    def _handle(self, name: str) -> Job:
        handle = self._handles.get(name)
        if handle is None or isinstance(handle, Tombstone):
            # The record decides which handle, so a job submitted by spawn() comes
            # back as a Subagent in a FRESH kernel too — the recovery path is a file
            # read, and it would be a poor kind of durability if the recovered handle
            # were missing .result.
            rec = self._read(name) or {}
            cls = Subagent if rec.get("kind") == "subagent" else Job
            handle = cls(name, self)
            self._handles[name] = handle
        return handle

    def wait(self, wake_after: Any = None) -> None:
        """
        Put a deadline on the agent's attention. **Must be the last statement in the
        cell**, and it does not block: the kernel is released and the host waits.

        This is also how you poll — check first, then wait, in one cell.
        """
        if wake_after is None:
            raise TypeError(
                "jobs.wait(wake_after=…) requires a duration, e.g. wake_after='5m'. "
                "Check your jobs first, then wait — both in this cell."
            )
        seconds = parse_duration(wake_after)
        clamped = max(self._min_wait, min(seconds, self._max_wait))
        pending = []
        for rec in self._all():
            fresh = self._refresh(rec)
            if fresh and fresh.get("state") in LIVE_STATES:
                mark = " ⚠ never fired" if fresh.get("silent") else ""
                pending.append(f"{fresh['name']}{mark}")
        note = ""
        if clamped != seconds:
            note = f" (requested {seconds}s, clamped to [{self._min_wait}, {self._max_wait}])"
        # Context line first, sentinel last. The host replaces the sentinel in place
        # with "[waited Ns outside the kernel]", so emitting it first produced output
        # reading "waited 90s" above "waiting 90s" — past tense before future tense.
        self._emit(
            f"[waiting {clamped}s outside the kernel; nothing is held{note}. "
            f"running jobs: {', '.join(pending) or 'none'}]"
        )
        # Scheduler mode (runtime/scheduler.py): the wake request goes on DISK,
        # where a host that exits between turns can find it. {wake_at, watch}
        # is the whole contract — deadline OR any watched job finishing, first
        # one wins. Written atomically for the same reason job records are.
        wake_file = os.environ.get("HARNESS_WAKE_FILE")
        if wake_file:
            try:
                # The kernel is usually the FIRST thing to touch the session dir
                # (demo4: five ENOENT wake writes, zero wakes, and the grader ran
                # against a 35-second build). Same pattern as _record's makedirs.
                os.makedirs(os.path.dirname(wake_file) or ".", exist_ok=True)
                tmp = f"{wake_file}.tmp"
                with open(tmp, "w") as fh:
                    json.dump({
                        "wake_at": time.time() + clamped,
                        "wake_after": clamped,
                        "watch": [p.split(" ")[0] for p in pending],
                    }, fh)
                os.replace(tmp, wake_file)
            except OSError as exc:
                self._emit(f"[jobs] could not record the wake request ({exc}); "
                           "the host-side deadline is the only wake")
        # The host matches the sentinel line-anchored, and — when HARNESS_WAIT_TOKEN
        # is set — only with the token the kernel inherited via env. Without it,
        # any stdout containing the bare sentinel (a cat of a transcript, a printed
        # log) could arm an hour-long host-side sleep.
        token = os.environ.get("HARNESS_WAIT_TOKEN", "")
        self._emit(f"{WAIT_SENTINEL}:{clamped}:{token}" if token else f"{WAIT_SENTINEL}:{clamped}")
        # Sentinel first, then end the cell. Anything below the call is unreachable by
        # construction rather than by inspection — see WaitSignal.
        raise WaitSignal(clamped)

    def get(self, name: str) -> Optional[Job]:
        """
        The recovery mechanism. Works in the kernel that created the job and equally
        in a fresh one, because the job is a file rather than an object.

        A job that is gone comes back as a Tombstone rather than None, so touching it
        explains itself instead of raising AttributeError on None three lines later.
        """
        rec = self._read(name)
        if rec is None:
            return None
        fresh = self._refresh(rec) or rec
        if fresh.get("state") == "pruned":
            existing = self._handles.get(name)
            if not isinstance(existing, Tombstone):
                existing = Tombstone(name, self, fresh.get("reason") or "pruned")
                self._handles[name] = existing
            return existing
        return self._handle(name)

    def list(self) -> List[dict]:
        return [self._refresh(rec) for rec in self._all()]

    def kill(self, name: str) -> bool:
        rec = self._refresh(self._read(name))
        if not rec or rec.get("state") not in LIVE_STATES:
            return False
        self._terminate(rec, state="killed", reason="killed by agent")
        return True

    # -- surviving a kernel restart --------------------------------------------
    #
    # There is deliberately no "rehydration" that binds handles back into the
    # namespace. `jobs.get(name)` IS the recovery mechanism, and it is the only one.
    #
    # An earlier version of this module auto-bound every job to its name in a fresh
    # kernel. That is the design doc's §5, and building it made the case against it:
    # every failure mode §5 then has to handle — shadowing (`batch = "done"`),
    # aliasing (`b2 = batch`), burial (`js = [submit(c) for c in calls]`), names that
    # are not legal Python identifiers — exists *only because* of the auto-binding.
    # Remove the binding and the entire class of problem goes with it, along with the
    # constraint that a handle may live at a bare name and nowhere else.
    #
    # It also fails §5's own test. The stated reason to make rehydration visible is
    # that "invisible reconstruction produces an agent reasoning confidently about a
    # binding that isn't what it thinks" — but a name that silently changes identity
    # across a kernel death is that hazard, not a mitigation of it. A job is durable
    # state living in a file; reaching it through a lookup is honest about that, and a
    # local variable pretending to be it is not.
    #
    # What a fresh kernel needs is not bindings but *knowledge that jobs exist*, which
    # is `manifest()`, printed by the prelude at startup.

    def prune(self, name: str, reason: str = "pruned") -> bool:
        """Mark a job gone so rehydration produces a tombstone rather than a handle."""
        rec = self._read(name)
        if not rec:
            return False
        if rec.get("state") in LIVE_STATES:
            self._terminate(rec, state="pruned", reason=reason)
        else:
            rec["state"] = "pruned"
            rec["reason"] = reason
            self._write(rec)
        self._handles[name] = Tombstone(name, self, reason)
        return True

    # -- manifest (§8) ---------------------------------------------------------
    def manifest(self) -> str:
        """
        The listing the agent reads. Silence becomes a line here.

        You cannot prove a filter will fire, but you can flag a job that has emitted
        nothing by a fraction of its deadline — which converts the characteristic
        silent failure of this API into something visible before the deadline, not
        after it.
        """
        rows = self.list()
        if not rows:
            # An empty state is the agent's likely FIRST contact with this API, so it
            # is the worst possible place to say nothing useful.
            #
            # Measured on a real TAC task: the agent probed once with
            # `jobs.manifest()`, got back "no jobs" (which IPython rendered as an
            # empty cell result), never touched the API again, and spent the next 87
            # turns polling with cells that were literally `print(38)`. One
            # uninformative reply cost the entire adoption.
            return (
                "no jobs yet. Start durable work with:\n"
                "    jobs.submit('your command', name='pick-a-name')\n"
                "    jobs.wait(wake_after=60)   # last statement of the cell\n"
                "then jobs.get('pick-a-name') to collect it. `jobs.help()` for more."
            )
        out = []
        for rec in rows:
            elapsed = int((rec.get("finished_at") or self._now()) - rec["started_at"])
            bits = [f"{rec['name']:<16}", f"{rec['state']:<9}"]
            if rec.get("max_runtime"):
                bits.append(f"{elapsed}s of {rec['max_runtime']}s")
            else:
                bits.append(f"{elapsed}s")
            bits.append(f"{rec.get('events', 0)} bytes")
            if rec.get("kind") == "subagent":
                # Which line is a child agent, and what it was told to do. A manifest
                # that listed a subagent as an anonymous command would make the one
                # question worth asking about it — "what is it doing?" — cost a turn.
                task = (rec.get("meta") or {}).get("prompt", "").strip().replace("\n", " ")
                bits.append(f"subagent: {task[:60]}" + ("…" if len(task) > 60 else ""))
            if rec.get("silent"):
                bits.append("⚠ never fired")
            if rec.get("reason"):
                bits.append(f"— {rec['reason']}")
            out.append("  ".join(bits))
        return "\n".join(out)


# --------------------------------------------------------------------------------
# telling the model this exists
# --------------------------------------------------------------------------------
#
# Three channels, and the split is decided by what each one costs.
#
#   system prompt   resident — re-billed on every turn of every task, whether or not
#                   the task needs a job. So: name the capability, nothing more.
#   jobs.help()     free until called, and MEASURED NEVER CALLED: 0 uses across 135
#                   recorded runs, despite a prompt that named its contents and gave a
#                   trigger for reading it. So the resident pointer shrank to one line
#                   and the few facts the agent actually reaches for moved inline.
#                   Usage across those runs: wait 109, submit 93, get 86,
#                   max_runtime 59, expect 58, .ok 41, .done 40, .output 26,
#                   .state 22, .exit_code 10, manifest 2, and list/kill/help/.reason
#                   zero. help() stays for humans and for the api/ listing; it is no
#                   longer sold to the model as a step it should take.
#   errors          free, and arrive exactly when the agent is doing the wrong thing.
#                   Measured to be the strongest teacher of the three: the runs that
#                   hit the sleep guard adopted jobs.wait on the very next cell.
#
# The one thing PROMPT must not do is state a threshold. An earlier prelude advertised
# "do not sleep more than 30s"; a run then clamped every sleep to exactly 30s, never
# tripped the guard, never discovered jobs.wait, and dropped 6/6 to 3/6. Name the
# capability and let the guard explain the limit if it fires.
#
# `submit` is the reason PROMPT exists at all. `wait` teaches itself — sleeping too
# long raises and names it — but an agent that has never heard of `submit` simply runs
# long work inline, and there is no wrong action to correct. Its only error channel is
# the cell-timeout interrupt, which now names it too.

PROMPT = """\
## Work that outlives a cell

Long-running work goes to a job. Waiting happens outside the kernel, so nothing is
held while it happens and your variables survive.

    jobs.submit("gradle build", name="build", max_runtime="1h")
    jobs.wait(wake_after=300)      # LAST statement of the cell
    # ...you are called again afterwards:
    j = jobs.get("build")
    if j.done and j.ok: print(j.output)

Poll by checking first and then waiting, both in ONE cell:

    j = jobs.get("build")
    if j.done: print(j.output)
    else:      jobs.wait(wake_after=120)

Wait for a condition by submitting a command that exits when it is true. Prefer exit
status over matching output — it has two outcomes instead of several silent ones:

    jobs.submit("until curl -sf localhost:5000/health; do sleep 2; done",
                name="ready", expect="once", max_runtime="10m")

Use expect="stream" instead for something that keeps running and keeps emitting.
submit() rejects commands that cannot do what expect= declares, and says why.

Two things that do not work here: sleeping in a cell and starting threads. Both hold
the kernel, and neither survives it. That includes `%%bash` with a foreground
`sleep`. A kernel restart loses your variables but not your jobs — there is nothing
to restore, jobs.get(name) simply works in the new kernel.

A Job tells you `.done`, `.ok` and `.output`; `.reason` says why it ended, including
"deadline reached, never fired" when a condition was wrong rather than merely slow.
`jobs.manifest()` lists everything. Full surface: `jobs.help()`, also in `api/jobs.md`.\
"""


HELP = """\
jobs — work that outlives a cell and the kernel

  jobs.submit(command, name=..., max_runtime=None, expect="once") -> Job
  jobs.wait(wake_after=...)      # last statement of a cell; does not block
  jobs.get(name) -> Job | None   # the recovery mechanism, in any kernel
  jobs.list() -> [record]        # every job, as data
  jobs.manifest() -> str         # the same thing, printed
  jobs.kill(name) -> bool

A background command
    b = jobs.submit("gradle build", name="build", max_runtime="1h")
    jobs.wait(wake_after=300)          # last line; the kernel is released
    # ... next turn:
    j = jobs.get("build")
    if j.done and j.ok: print(j.output)

Waiting for something to become true
    jobs.submit("until curl -sf localhost:5000/health; do sleep 2; done",
                name="ready", expect="once", max_runtime="10m")
    jobs.wait(wake_after=60)

  expect="once"   the command exits when the thing happens   (default)
  expect="stream" the command keeps running and keeps emitting

  Prefer exit status over matching output — `until <cmd>; do sleep 2; done` has two
  outcomes (it exits, or it hits max_runtime) where a `tail -f | grep` pipeline has
  several ways to silently never fire. submit() rejects the shapes that cannot do
  what expect= declares, and says why.

Polling — check first, then wait, in ONE cell
    j = jobs.get("build")
    if j.done:
        print(j.output)
    else:
        print(jobs.manifest())
        jobs.wait(wake_after=120)

After a kernel restart
    Your variables are gone; the jobs are not. There is nothing to restore —
    jobs.get("build") works in the new kernel exactly as in the old one.
    jobs.manifest() lists what is still around.

Job
    .state    running | done | killed | deadline | gone
    .done     .ok     .exit_code     .output
    .reason   why it ended — including "deadline reached, never fired", which
              means the condition was wrong rather than merely slow

Not available, on purpose
    submit() takes a command string, never a function: a closure cannot be
    reconstructed once the kernel is gone. Write the work to a file and submit
    its path. Jobs are not awaitable — end the cell with wait() instead.

How this kernel differs from stock Python
    It is shared and single-threaded, so anything that holds it stops everything,
    and anything that escapes it cannot be tracked, recovered after a restart, or
    stopped. Two rules, and every error names the replacement.

    Refused at import — there is no correct use of these here:

      threading, _thread, multiprocessing, concurrent.futures  -> jobs.submit(...)

    Refused at the call, only when the call itself would hold or escape:

      time.sleep / asyncio.sleep beyond a short settle    -> jobs.wait(...)
      os.fork / os.popen / os.posix_spawn / pty.spawn     -> jobs.submit(...)
      subprocess.* or os.system running a blocking or
        detached command                                  -> jobs.submit(...)
      %%bash or !cmd with a foreground sleep or poll loop -> jobs.submit(...)
      Event.wait() / Queue.get() with no timeout          -> jobs.wait(...)

    Untouched: short sleeps, ordinary subprocess calls that read a result back
    (`subprocess.run([...], capture_output=True)`), normal shell cells, and
    starting work in the background from a shell cell (`(cmd) &`). The rule is
    about holding the kernel or escaping it, not about the library.\
"""


def help() -> str:  # noqa: A001 - deliberately shadows builtins inside the kernel
    """
    The full surface and the idioms, printed on demand.

    Lives here rather than in the system prompt because it is only needed by the
    minority of tasks that have long-running work, and resident text is paid for on
    every turn of every task.

    Prints *and* returns, so an agent gets it by calling and a caller that only wants
    the string uses HELP directly — printing as a side effect of asking for the text
    made `--docs` emit it twice.
    """
    print(HELP)
    return HELP


# --------------------------------------------------------------------------------
# module-level surface, bound to one default store
# --------------------------------------------------------------------------------

_default: Optional[JobStore] = None


def _store() -> JobStore:
    global _default
    if _default is None:
        _default = JobStore(DEFAULT_JOB_DIR)
    return _default


def use_store(store: JobStore) -> None:
    """Point the module-level functions at another store. Used by tests and by the prelude."""
    global _default
    _default = store


def submit(payload, name=None, **kw) -> Job:
    return _store().submit(payload, name, **kw)


def wait(wake_after=None) -> None:
    return _store().wait(wake_after)


def get(name: str) -> Optional[Job]:
    return _store().get(name)


def list() -> List[dict]:  # noqa: A001 - deliberately mirrors the doc's surface
    return _store().list()


def kill(name: str) -> bool:
    return _store().kill(name)


def prune(name: str, reason: str = "pruned") -> bool:
    return _store().prune(name, reason)


def manifest() -> str:
    return _store().manifest()


# --------------------------------------------------------------------------------
# emitting the guidance, for harnesses that are not Python
# --------------------------------------------------------------------------------
#
# The prompt block and the API listing are generated from this module rather than
# copied into a harness, so they cannot drift from the implementation they describe.
# A harness that hard-codes its own copy is one refactor away from telling the model
# about a function that no longer exists — which is worse than saying nothing,
# because the agent follows it and cannot tell whether it misread.
#
#   python3 runtime/jobs.py --prompt   -> the system-prompt section
#   python3 runtime/jobs.py --docs     -> the api/ listing, same text as jobs.help()

if __name__ == "__main__":
    import os as _os
    import sys as _sys

    if "--spawn" in _sys.argv:
        # Used by the shell-job-control sketch: `cmd &` in a %%bash cell is rewritten
        # to call this. Routing adoption through submit() rather than reimplementing
        # detachment in shell means an adopted job and a submitted one are identical
        # by construction — and it is portable, which the first version was not:
        # `setsid` does not exist on macOS, so every adopted job died instantly with
        # "setsid: command not found" while still writing a plausible job record.
        i = _sys.argv.index("--spawn")
        name, command = _sys.argv[i + 1], _sys.argv[i + 2]
        job = submit(command, name=name)
        print(f"[{name}] {_store()._read(name)['pid']}")
        raise SystemExit(0 if job else 1)
    if "--check-blocking" in _sys.argv:
        # The bash tool's guard, called once per bash tool call by
        # bench/arms/bash-tool-extension.ts. JSON on stdout, and exit 0 whenever the
        # check itself succeeded — a non-zero exit means the CHECKER failed, which
        # the extension must be able to tell apart from "allowed". It refuses to
        # load if it cannot, because a guard that silently fails open reproduces
        # exactly the bug it was built to close.
        i = _sys.argv.index("--check-blocking")
        command = _sys.argv[i + 1] if i + 1 < len(_sys.argv) else ""
        ceiling = 30
        if "--ceiling" in _sys.argv:
            ceiling = int(_sys.argv[_sys.argv.index("--ceiling") + 1])
        print(json.dumps(check_blocking(command, ceiling)))
        raise SystemExit(0)
    if "--timeout-message" in _sys.argv:
        i = _sys.argv.index("--timeout-message")
        print(timeout_message(float(_sys.argv[i + 1]), _sys.argv[i + 2] if i + 2 < len(_sys.argv) else ""))
        raise SystemExit(0)
    if "--prompt" in _sys.argv:
        print(PROMPT)
        # Subagents are jobs, so their guidance ships with the jobs guidance rather
        # than through a second channel a harness would have to remember to wire.
        # Imported here rather than at module scope: subagents.py imports this
        # module, and the prelude must be able to load jobs with no subagent support
        # present at all.
        #
        # OPT-IN, and that direction is deliberate. This CLI runs on the HOST, where
        # subagents.py is always importable, while the prelude runs wherever the
        # harness staged the runtime — and `bench/terminal/prime_agent.py` and
        # `bench/tac/run-task.mjs` stage jobs.py and kernel-prelude.py and nothing
        # else. Defaulting to on would therefore have told those agents about a
        # `spawn` that is not bound in their kernel, which is the worst of the three
        # possible states: guidance for a capability that does not exist is followed,
        # and the agent cannot tell whether it misread. Absent-but-unadvertised is
        # merely a missed opportunity. One variable governs both channels.
        if (_os.environ.get("HARNESS_SUBAGENTS") == "1") or "--subagents" in _sys.argv:
            try:
                import subagents as _sub

                print()
                print(_sub.PROMPT)
            except Exception as exc:  # never let an optional section break the prompt
                print(f"[jobs] subagent guidance unavailable ({exc})", file=_sys.stderr)
    elif "--docs" in _sys.argv:
        print(f"# jobs\n\nAvailable in every cell as `jobs`; no import needed.\n\n```\n{HELP}\n```")
    else:
        print(__doc__)
        print("usage: jobs.py [--prompt | --docs]")
        raise SystemExit(2)
