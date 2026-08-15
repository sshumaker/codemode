"""
Kernel prelude: expose `jobs`, announce prior work, and make the in-process forms
fail loudly.

Copied into the task container and executed before the agent's first cell. Three jobs:

1. `jobs` is available without an import, the way `api` is on MCP-Bench — and stays
   available after `%reset -f`, which clears the user namespace.
2. Jobs left by a previous kernel are *announced*, not rebound. `jobs.get(name)` is
   the only recovery mechanism; see the note in jobs.py on why auto-binding handles
   was built and then removed.
3. `threading.Thread`, `os.fork` and long sleeps raise, with the correct pattern in
   the message.

(3) is not paternalism. On one TheAgentCompany task the agent wrote
`threading.Thread(target=poll)` four separate times, spawning four pollers that raced
on one dict and were never stopped, plus ~3050s of `time.sleep` inside cells. It had
no reason to believe any of that would survive a kernel restart — it wrote the
in-process shape because that is what Python programmers write. A prior that strong
beats documentation, so the wrong path has to fail at the point of use.

Short sleeps stay legal: a 2s settle after a POST is ordinary code, not waiting. The
threshold is where computing stops and waiting begins — measured on the same traces,
legitimate compute cells topped out around 45–53s while every genuine wait was
120–235s.
"""

import os
import sys
import threading
import time
import traceback


def _unshadow_stdlib():
    """Guarantee stdlib `tokenize` wins over a task cwd that shadows it.

    The kernel runs with '' (the task cwd) at sys.path[0]. A task whose working
    directory contains a stdlib-named file — measured: train-bpe-tokenizer ships
    `/app/tokenize.py` — makes `import tokenize` return that file, and the FIRST
    traceback or source lookup dies in `tokenize.open` (called by `linecache`,
    which every traceback formats through) with `AttributeError: module 'tokenize'
    has no attribute 'open'`. That happens *during* prelude startup, so `jobs`
    never binds and the whole ON arm is silently invalid — a plausible number, not
    an error, which is the trap this project keeps hitting.

    Force the stdlib module into sys.modules with the cwd entries removed for the
    duration of the import, then restore sys.path untouched so the agent's own
    local imports still work. linecache caches its own `tokenize` reference at
    import, so repoint that too if it already grabbed the shadowing copy.

    Runs first, before anything here can raise into a broken traceback formatter.
    """
    import importlib

    cwd = os.getcwd()
    saved = list(sys.path)
    sys.path[:] = [p for p in sys.path if p not in ("", ".", cwd)]
    try:
        sys.modules.pop("tokenize", None)
        std_tok = importlib.import_module("tokenize")
        lc = sys.modules.get("linecache")
        if lc is not None and getattr(lc, "tokenize", None) is not std_tok:
            lc.tokenize = std_tok
    except Exception:
        pass  # never let the guard against a broken kernel break the kernel
    finally:
        sys.path[:] = saved


_unshadow_stdlib()

# This file's own path, or a sentinel.
#
# `__file__` is NOT defined when IPython executes a startup file directly, and the
# frame-skipping logic below referenced it. The result was a NameError raised from
# inside ipykernel's stdout flush, which killed kernel initialisation: every cell of
# seven TAC runs came back "Kernel did not respond to kernel_info_request".
#
# It never showed up locally because the eval harness loads this via
# `runpy.run_path`, which sets `__file__`. The startup-file path — the one TAC uses —
# was never exercised.
_SELF = globals().get("__file__") or "<harness-prelude>"

# Whether this file ran, and why it did not, recorded on disk.
#
# Four TAC runs were spent guessing at this. The prelude lives inside a container that
# is destroyed at the end of the run, so a failure left no trace: the agent simply had
# no `jobs`, which is indistinguishable from an agent choosing not to use it. Two
# separate "verifications" certified success without testing the actual hook — first
# `import jobs` under a manual sys.path insert, then a manual runpy of the startup
# file. Both are the find_spec mistake: locating or hand-running code is not the same
# as the runtime executing it.
_MARKER = os.environ.get("HARNESS_PRELUDE_MARKER", "/tmp/harness/prelude-status.txt")


def _record(status: str, detail: str = "") -> None:
    try:
        os.makedirs(os.path.dirname(_MARKER), exist_ok=True)
        with open(_MARKER, "a") as fh:
            fh.write(f"{status}\t{detail}\n")
    except Exception:
        pass


_record("STARTED", f"pid={os.getpid()} python={sys.version.split()[0]}")

sys.path.insert(0, os.environ.get("HARNESS_RUNTIME_DIR", "/agent/harness"))

import jobs  # noqa: E402  (exposed to the agent as `jobs`)

SLEEP_CEILING = int(os.environ.get("HARNESS_SLEEP_CEILING", "30"))
# Opt-in: adopt `cmd &` in shell cells as a durable job instead of leaving it
# untracked. See docs/sketches/shell-job-control.md §5 for the comparison this gates.
ADOPT_BACKGROUND = os.environ.get("HARNESS_ADOPT_BACKGROUND") == "1"
# Files-only variant: adopt, but advertise nothing beyond what a shell prints.
ADOPT_QUIET = os.environ.get("HARNESS_ADOPT_QUIET") == "1"

_real_sleep = time.sleep

# Retroactive attribution (design §6): the only genuinely soft channel. The model
# exists at turn boundaries, so nothing can be said about an in-flight cell — but a
# cell that spent 187 of its 203 seconds asleep can be told so afterwards, for free.
_slept = {"seconds": 0.0}


def _guarded_sleep(seconds):
    # `>=` for the same reason as jobs.blocking_sleep: the round number nearest a
    # limit is the limit, and that is exactly what an agent reaches for.
    if seconds is not None and seconds >= SLEEP_CEILING:
        raise RuntimeError(
            f"time.sleep({seconds}) holds this kernel for {seconds}s and nothing else can run.\n"
            f"To wait, end the cell with:  jobs.wait(wake_after={int(seconds)})\n"
            f"The wait then happens outside the kernel, your variables survive, and you are "
            f"called again afterwards.  `jobs.help()` for the full surface."
        )
    if seconds:
        _slept["seconds"] += seconds
    return _real_sleep(seconds)


_real_thread = threading.Thread

# Directories whose code is machinery, not the agent's. A thread created from here is
# the kernel doing its job and must not be blocked.
def _library_dirs():
    import sysconfig

    paths = set()
    for key in ("purelib", "platlib", "stdlib", "platstdlib"):
        p = sysconfig.get_paths().get(key)
        if p:
            paths.add(os.path.realpath(p))
    return tuple(paths)


# The runtime's own directory counts as machinery: jobs.submit() spawns through
# subprocess.Popen, so a guard that did not exempt it would refuse the very primitive
# it exists to redirect people toward.
_LIB_DIRS = _library_dirs() + (
    os.path.realpath(os.path.dirname(_SELF)) if _SELF != "<harness-prelude>"
    else os.path.realpath(os.environ.get("HARNESS_RUNTIME_DIR", "/agent/harness")),
)


# A notebook cell, by filename. ipykernel and a bare InteractiveShell disagree about
# the form, so both are recognised.
_CELL_NAMES = ("<ipython-input", "<cell line", "<stdin>")


def _is_cell(name: str) -> bool:
    return name.startswith(_CELL_NAMES) or "/ipykernel_" in name


def _called_from_agent_code() -> bool:
    """
    True only when the immediate caller is a notebook cell.

    Inverted from a path-based rule ("anything not under site-packages is the agent"),
    which was too fragile in the wrong direction: if the interpreter's library paths
    were not detected exactly, ipykernel's own lazy `import threading` during startup
    counted as agent code and was refused — so the kernel never answered
    kernel_info_request, and every cell for six TAC runs came back "Kernel did not
    respond within 5000ms" while the agent degenerated into `print('a')` probes.
    A guard that can wedge the kernel it guards is worse than a missing guard.

    So: recognise cells, and default to machinery. A missed guard costs one teaching
    moment; a wedged kernel costs the entire run.
    """
    frame = sys._getframe(1)
    while frame is not None:
        name = frame.f_code.co_filename
        if name == _SELF:
            frame = frame.f_back
            continue
        return _is_cell(name)
    return False


class CellHeldError(BaseException):
    """
    The cell watchdog's refusal.

    BaseException, not Exception, for the same reason jobs.WaitSignal is: the
    raise lands inside whatever agent code is running, and retry loops wrap
    their bodies in `except Exception:` — which swallowed the teaching text and
    left the kernel held with the (now re-armed) timer as the only recourse
    (2026-08-15 review, M8). Agent code has no legitimate handler for "you are
    holding the kernel", so it must not be catchable by the reflexive one.
    """


def _redirect(problem: str, suggestion: str = "your command") -> str:
    """
    One message shape for every guard.

    All of them are refusing the same thing — work that holds the kernel or escapes
    it untracked — so they should all name the same replacement and the same place
    to read more. The measured lesson is that the error is the strongest teaching
    channel there is, which makes it the right place to put the pointer.
    """
    return (
        f"{problem}\n"
        f"Hand it to a job instead — it outlives this cell and this kernel:\n"
        f"    jobs.submit({suggestion!r}, name='pick-a-name')\n"
        f"    jobs.wait(wake_after=60)   # last statement of the cell\n"
        f"then jobs.get('pick-a-name') to collect it.  `jobs.help()` for the full surface."
    )


_PATCHES_PRE = [(time, "sleep", time.sleep)]
time.sleep = _guarded_sleep

# asyncio.sleep is the same hazard inside an await-ing cell.
try:
    import asyncio

    _real_async_sleep = asyncio.sleep

    async def _guarded_async_sleep(seconds, *a, **k):
        # `>=` for the same reason as jobs.blocking_sleep: the round number nearest a
        # limit is the limit, and that is exactly what an agent reaches for.
        if seconds is not None and seconds >= SLEEP_CEILING:
            raise RuntimeError(
                f"asyncio.sleep({seconds}) holds this kernel. Use jobs.wait(wake_after={int(seconds)}) "
                f"as the last statement of the cell instead."
            )
        if seconds:
            _slept["seconds"] += seconds
        return await _real_async_sleep(seconds, *a, **k)

    asyncio.sleep = _guarded_async_sleep
except Exception:
    pass


def _shell():
    """
    The running IPython shell, or None.

    `get_ipython()` is injected into the interactive namespace, not into arbitrary
    modules — and this prelude is loaded with runpy, so the bare name was undefined
    and every IPython-dependent guard silently did nothing. The magic was never
    replaced, `%%bash sleep 40` ran unguarded, and nothing said so. `IPython.get_ipython()`
    is the module-level API and works from anywhere.
    """
    injected = globals().get("get_ipython")
    if injected is not None:
        # Tests substitute a fake shell by setting this before the module executes.
        try:
            return injected()
        except Exception:
            return None
    try:
        from IPython import get_ipython as _gi

        return _gi()
    except Exception:
        return None


# --------------------------------------------------------------------------------
# the enumeration
# --------------------------------------------------------------------------------
#
# Two failure modes, and every entry below is one or the other:
#
#   HOLD    the call blocks this single-threaded kernel, so nothing else can run and
#           the cell collides with its own timeout
#   ESCAPE  the call starts work the kernel cannot name, recover after a restart, or
#           stop — every property `submit` exists to provide, improvised
#
# Completeness is not achievable and the design doc says so (§6): an agent can always
# write `getattr(threading, "Thr" + "ead")`, or compute a command at run time, or busy-
# wait in pure Python. The cell wall-clock ceiling is the universal backstop. What
# this table buys is that every *idiomatic* route fails at the point of use with a
# message naming the replacement — which is the channel measured to work.
#
# Declarative on purpose. The first version patched functions ad hoc in three separate
# places and it was already hard to see what was covered; a table can be read, tested
# against, and printed to the agent.

def _hold(what):
    return f"{what} blocks this kernel, and nothing else can run while it does."


def _escape(what):
    return f"{what} starts work this kernel cannot name, recover after a restart, or stop."


def _hold_if_long(what, arg=0, kw=None, default=None):
    """Block only when the duration is over the ceiling, or unbounded."""

    def policy(args, kwargs):
        v = kwargs.get(kw, args[arg] if len(args) > arg else default)
        if v is None:
            return f"{what} with no timeout waits forever and blocks this kernel."
        try:
            if float(v) > SLEEP_CEILING:
                return f"{what} for {v}s blocks this kernel for that long."
        except (TypeError, ValueError):
            return None
        return None

    return policy


def _hold_if_blocking_command(api):
    """subprocess/os.system: refuse a command that blocks, or one that detaches."""

    def policy(args, kwargs):
        cmd = args[0] if args else kwargs.get("args", kwargs.get("command"))
        if cmd is None:
            return None
        text = cmd if isinstance(cmd, str) else " ".join(str(x) for x in cmd)
        reason = jobs.blocking_sleep(text, SLEEP_CEILING)
        if reason:
            return f"{api}: this command blocks the kernel — {reason}."
        if kwargs.get("start_new_session") or kwargs.get("preexec_fn"):
            return (
                f"{api} with start_new_session detaches this work, so nothing can name it, "
                "recover it after a kernel restart, or stop it."
            )
        return None

    return policy


def _always(reason):
    # `reason` is the finished string. An earlier version took a zero-arg callable
    # here, and 13 of 19 guards forgot the trailing () — so the agent was handed
    # `<function _escape.<locals>.<lambda> at 0x…>` where the correction should be.
    # The error channel is the teaching channel; it must never carry a repr.
    return lambda args, kwargs: reason


# (module path, attribute, policy). A policy returns a reason string, or None to allow.
_GUARDS = [
    # -- ESCAPE: work that outlives the cell without being a job -----------------
    ("threading", "Thread", _always(_escape("threading.Thread"))),
    ("threading", "Timer", _always(_escape("threading.Timer"))),
    ("concurrent.futures", "ThreadPoolExecutor", _always(_escape("ThreadPoolExecutor"))),
    ("concurrent.futures", "ProcessPoolExecutor", _always(_escape("ProcessPoolExecutor"))),
    ("multiprocessing", "Process", _always(_escape("multiprocessing.Process"))),
    ("multiprocessing", "Pool", _always(_escape("multiprocessing.Pool"))),
    ("multiprocessing.pool", "ThreadPool", _always(_escape("multiprocessing.pool.ThreadPool"))),
    ("os", "fork", _always(_escape("os.fork"))),
    ("os", "forkpty", _always(_escape("os.forkpty"))),
    ("os", "posix_spawn", _always(_escape("os.posix_spawn"))),
    ("os", "popen", _always(_escape("os.popen"))),
    ("pty", "spawn", _always(_escape("pty.spawn"))),
    ("pty", "fork", _always(_escape("pty.fork"))),
    # -- conditional: the command decides ---------------------------------------
    ("subprocess", "Popen", _hold_if_blocking_command("subprocess.Popen")),
    ("subprocess", "run", _hold_if_blocking_command("subprocess.run")),
    ("subprocess", "call", _hold_if_blocking_command("subprocess.call")),
    ("subprocess", "check_call", _hold_if_blocking_command("subprocess.check_call")),
    ("subprocess", "check_output", _hold_if_blocking_command("subprocess.check_output")),
    ("os", "system", _hold_if_blocking_command("os.system")),
    # -- HOLD: blocks the kernel -------------------------------------------------
    ("signal", "pause", _always(_hold("signal.pause"))),
    ("os", "wait", _always(_hold("os.wait"))),
    ("select", "select", _hold_if_long("select.select", arg=3, kw="timeout")),
]

# Methods on classes, which the table above cannot reach.
_METHOD_GUARDS = [
    # Deliberately NOT guarded: threading.Event.wait and queue.Queue.get.
    #
    # ipykernel calls `evt.wait(self.flush_timeout)` on every stdout flush, so a guard
    # here runs inside the kernel's hottest I/O path — and anything that raises there
    # takes the kernel down rather than teaching the agent anything. Same class as
    # Popen.wait/communicate (removed for breaking subprocess.run) and the %%bash
    # thread guard (removed for breaking every shell cell): do not instrument
    # infrastructure. An agent blocking on an Event is rare; a dead kernel is total.
    # Deliberately NOT guarded: Popen.wait and Popen.communicate.
    #
    # They were, on a "no timeout means forever" rule, and it refused
    # `subprocess.run(["echo","hi"])` — which calls communicate() internally with no
    # timeout, as does every correct use on a short command. How long they block is
    # decided by the command, and the command is already vetted when the process is
    # constructed. Guarding here adds nothing and breaks the ordinary case.
]


def _resolve(path):
    import importlib

    try:
        return importlib.import_module(path)
    except Exception:
        return None


# Every patch this module applies, as (owner, attribute, original), so it can be
# undone. Needed because the patches are process-global: without an undo, one test's
# guards leak into every later test and the suite fails only under `discover`, which
# is the most confusing way for a suite to fail.
_PATCHES = []


def uninstall_guards():
    """Restore every patched attribute. Used by tests; harmless in production."""
    while _PATCHES:
        owner, name, original = _PATCHES.pop()
        try:
            setattr(owner, name, original)
        except Exception:
            pass


def _install_guards():
    """
    Wrap everything in the table. Agent code only — library and runtime code is
    machinery and must keep working, including `jobs.submit` itself, which spawns
    through subprocess.Popen.
    """
    installed, skipped = [], []

    def check(policy, args, kwargs):
        if not _called_from_agent_code():
            return
        reason = policy(args, kwargs)
        if not reason:
            return
        first = args[0] if args else None
        suggestion = first if isinstance(first, str) else "your command"
        raise RuntimeError(_redirect(reason, suggestion))

    def wrap(owner, name, policy, label):
        original = getattr(owner, name, None)
        if original is None:
            skipped.append(label)
            return
        if getattr(original, "_harness_guarded", False):
            return

        if isinstance(original, type):
            # A class must stay subclassable. Replacing `threading.Thread` with a
            # function broke `concurrent.futures`, which does
            # `class _ExecutorManagerThread(threading.Thread)` at import time — the
            # same over-broad-patching mistake that broke %%bash. So: subclass, and
            # check at construction, where the agent's intent actually appears.
            class Guarded(original):  # type: ignore[misc, valid-type]
                def __new__(cls, *args, **kwargs):
                    check(policy, args, kwargs)
                    try:
                        return super().__new__(cls)
                    except TypeError:
                        return super().__new__(cls, *args, **kwargs)

            Guarded.__name__ = original.__name__
            Guarded.__qualname__ = getattr(original, "__qualname__", original.__name__)
            Guarded.__doc__ = original.__doc__
            Guarded._harness_guarded = True
            setattr(owner, name, Guarded)
        else:
            def guarded(*args, **kwargs):  # noqa: E306
                check(policy, args, kwargs)
                return original(*args, **kwargs)

            guarded._harness_guarded = True
            guarded.__name__ = getattr(original, "__name__", name)
            guarded.__doc__ = getattr(original, "__doc__", None)
            setattr(owner, name, guarded)
        _PATCHES.append((owner, name, original))
        installed.append(label)

    for path, attr, policy in _GUARDS:
        mod = _resolve(path)
        if mod is None:
            skipped.append(f"{path}.{attr}")
            continue
        wrap(mod, attr, policy, f"{path}.{attr}")

    for path, cls_name, meth, policy in _METHOD_GUARDS:
        mod = _resolve(path)
        cls = getattr(mod, cls_name, None) if mod else None
        if cls is None:
            skipped.append(f"{path}.{cls_name}.{meth}")
            continue
        wrap(cls, meth, policy, f"{path}.{cls_name}.{meth}")

    return installed, skipped


GUARDS_INSTALLED, GUARDS_SKIPPED = _install_guards()


# --------------------------------------------------------------------------------
# refusing the import outright
# --------------------------------------------------------------------------------
#
# For modules whose whole purpose is concurrency, the import is the right place to
# refuse. It is the earliest and clearest signal, and — unlike a table of individual
# functions — it does not have to be complete: `threading.Barrier`,
# `threading.Semaphore`, `concurrent.futures.wait` and everything else become
# unreachable without being enumerated.
#
# Which modules: only those with no legitimate use in a single-threaded kernel that
# the agent does not own. Every use of `threading` here is an escape.
#
# `subprocess` is deliberately NOT in this list, and the difference is worth stating.
# `subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True)` reads a result
# back into Python, which a %%bash cell cannot do — that is ordinary work, not an
# escape. Refusing the module would remove a real capability to prevent a misuse the
# call-level guards already catch. The rule stays: refuse what holds the kernel or
# escapes it, not the library that can be used to do either.
_BANNED_IMPORTS = {
    "threading": "threading",
    "_thread": "the low-level thread module",
    "multiprocessing": "multiprocessing",
    "concurrent.futures": "concurrent.futures",
    "concurrent": "concurrent.futures",
}

_real_import = __import__


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0, _real=_real_import):
    # `_real` is bound as a default so the real import survives module teardown.
    #
    # At interpreter shutdown Python clears this module's globals, but weakref
    # finalizers can still trigger imports through this hook — at which point
    # `_BANNED_IMPORTS` and `_called_from_agent_code` are already gone and
    # referencing them raises `NameError: name '_BANNED_IMPORTS' is not defined`
    # from inside `weakref._exitfunc`. Harmless (the binding already happened) but
    # noise in the run tail, and noise is exactly what hides a real error. So the
    # guard's own state is accessed defensively: if it has been torn down, there is
    # nothing left to guard and the plain import is correct.
    try:
        banned = _BANNED_IMPORTS
        flagged = name in banned and _called_from_agent_code()
    except Exception:
        flagged = False
    if flagged:
        what = banned[name]
        raise ImportError(_redirect(
            f"{what} is not available in this kernel: it is single-threaded and shared, so "
            f"anything started with {what} cannot be tracked, recovered after a restart, or stopped."
        ))
    return _real(name, globals, locals, fromlist, level)


_guarded_import._harness_guarded = True
if not getattr(__builtins__.get("__import__") if isinstance(__builtins__, dict) else __builtins__.__import__,
               "_harness_guarded", False):
    _bi = __builtins__ if not isinstance(__builtins__, dict) else None
    if _bi is not None:
        _PATCHES.append((_bi, "__import__", _real_import))
        _bi.__import__ = _guarded_import
    else:
        import builtins as _builtins_mod

        _PATCHES.append((_builtins_mod, "__import__", _real_import))
        _builtins_mod.__import__ = _guarded_import
_PATCHES.extend(_PATCHES_PRE)


def _guard_shell_cells():
    """
    Apply the same rule to `%%bash` that applies to `time.sleep`.

    A subprocess sleep holds the single-threaded kernel exactly as a Python one does,
    and no Python-level guard can see it. Measured: with `%%bash` working, an agent
    with no resident guidance blocked the kernel twice with `%%bash\\nsleep 40` and
    still produced the right answer — right answer, wrong mechanism, nothing caught
    it. That is the last uncovered route to the behaviour these primitives replace.

    Hooked at the cell magic rather than at an input transformer or a pre_run_cell
    event, because this is the one place that owns the entry point: transformers
    would have to re-implement magic dispatch to know which cells are shell, and an
    exception raised in an event callback is caught and printed by IPython while the
    cell runs anyway — it cannot refuse.

    `!cmd` goes through ip.system, which is wrapped for the same reason.

    Not closed: `subprocess.run(["sleep", "40"])`, and anything that computes its
    command at run time. The cell wall-clock ceiling is the universal backstop for
    those (design §6) — this hook removes the *idiomatic* route, not every route.
    """
    ip = _shell()
    if ip is None:
        return

    def refuse(reason, script):
        raise RuntimeError(
            f"this shell command blocks the kernel: {reason}.\n"
            "Hand it to a job instead, so the wait happens outside the kernel:\n"
            f"    jobs.submit({script.strip().splitlines()[0][:60]!r}, name='pick-a-name')\n"
            "    jobs.wait(wake_after=60)   # last statement of the cell\n"
            "then jobs.get('pick-a-name') to collect it."
        )

    # Everything below is best-effort. A kernel whose magics manager is shaped
    # differently must still boot: a guard that breaks the thing it guards is worse
    # than a missing guard.
    try:
        cell_magics = ip.magics_manager.magics["cell"]
    except Exception as exc:
        print(f"[jobs] shell-cell guard not installed ({exc}); %%bash sleeps are unguarded")
        return

    for name in ("bash", "sh", "script"):
        original = cell_magics.get(name)
        if original is None or getattr(original, "_harness_guarded", False):
            continue

        def guarded(line, cell, _original=original, _name=name):
            reason = jobs.blocking_sleep(cell, SLEEP_CEILING)
            if reason:
                refuse(reason, cell)
            # Adoption (docs/sketches/shell-job-control.md), opt-in so the two arms of
            # the comparison are the same code path with a flag. `cmd &` already runs
            # today — it is just untracked, so the agent has no handle and falls back
            # to polling. Adopting it makes the idiom it already reaches for durable.
            if ADOPT_BACKGROUND:
                try:
                    import shell_jobs

                    existing = {r.get("name") for r in jobs.list()}
                    rewritten, adopted = shell_jobs.rewrite_background(cell, taken=existing)
                except Exception:
                    rewritten, adopted = cell, []
                if adopted:
                    cell = rewritten
                    if ADOPT_QUIET:
                        # Files-only arm. Say nothing a shell would not say. The agent
                        # redirected its own output somewhere it named, so the file IS
                        # the handle — measured: with the full surface advertised, the
                        # agent still ignored %1 and .output and just read its file.
                        pass
                    else:
                        names = ", ".join(f"{n} ({c[:40]})" for n, c in adopted)
                        print(f"[adopted as durable job(s): {names}]")
                        print("[reach them with jobs.get('%1') / jobs.manifest(); "
                              "jobs.wait(wake_after=N) as a cell's last statement]")
            return _original(line, cell)

        guarded._harness_guarded = True
        ip.register_magic_function(guarded, magic_kind="cell", magic_name=name)

    original_system = getattr(ip, "system", None)
    if original_system is None:
        return

    def guarded_system(cmd):
        reason = jobs.blocking_sleep(cmd, SLEEP_CEILING)
        if reason:
            refuse(reason, cmd)
        return original_system(cmd)

    if not getattr(ip.system, "_harness_guarded", False):
        guarded_system._harness_guarded = True
        ip.system = guarded_system


_guard_shell_cells()


def _keep_jobs_bound():
    """
    Keep `jobs` reachable even after the user namespace is cleared.

    `%reset -f` wipes user_ns and the startup file only runs at kernel boot, so the
    name vanishes mid-session. Observed cost in a run that was otherwise perfect: the
    agent hit a NameError, guessed `import agent_jobs`, grepped `sys.modules`, and
    only then found `import jobs` — three wasted cells to recover a name the runtime
    had taken away from it.

    This restores the *module*, which is machinery. It is not the same as rebinding
    job handles: those stay reachable only through jobs.get(name), which is the whole
    point of the design.

    Bound into `builtins`, not into the user namespace, because `%reset -f` clears
    user_ns and a post-cell hook is too late for the common shape — the agent writes
    `%reset -f` and uses `jobs` in the *same* cell, and even the following cell came
    back NameError when this was tried as a hook. Verified against a real IPython
    shell rather than assumed.

    A failure here is reported, not swallowed: a silently missing binding is exactly
    the shape that cost three cells last time.
    """
    import builtins

    builtins.jobs = jobs
    ip = _shell()
    if ip is not None:
        try:
            ip.user_ns.setdefault("jobs", jobs)
        except Exception:
            pass  # builtins is enough


_keep_jobs_bound()


def _bind_subagents():
    """
    Make `spawn` available the way `jobs` is: no import, survives `%reset -f`.

    A bare name, not `jobs.spawn`, because that is what docs/DESIGN.md §Subagents
    specifies and what the resident prompt shows — and because the thing an agent
    types without being taught is `spawn(...)`. It is bound in builtins for the same
    reason `jobs` is: `%reset -f` clears the user namespace mid-session, and an agent
    that hit a NameError there spent three cells rediscovering a name the runtime had
    taken away from it.

    OPT-IN, on the same `HARNESS_SUBAGENTS=1` that gates the resident guidance, so
    the two can never disagree — an agent told it has `spawn` and given a NameError
    is worse off than one never told, because it follows the guidance and cannot tell
    whether it misread.

    Failure-tolerant beyond that: a harness may set the flag and still stage `jobs.py`
    without `subagents.py`. The kernel must come up regardless — the guards and
    `jobs` are the load-bearing part, and a prelude that raised here would take down
    the whole runtime for a feature the task may not need. So the outcome is RECORDED
    rather than assumed: a missing `spawn` is otherwise indistinguishable from an
    agent that chose not to delegate, which is exactly the ambiguity that cost four
    TAC runs.
    """
    if os.environ.get("HARNESS_SUBAGENTS") != "1":
        _record("SUBAGENTS", "off (set HARNESS_SUBAGENTS=1 to enable)")
        return
    import builtins

    try:
        import subagents
    except Exception as exc:
        _record("SUBAGENTS", f"not available: {type(exc).__name__}: {exc}")
        return
    builtins.spawn = subagents.spawn
    builtins.Agent = subagents.Agent
    ip = _shell()
    if ip is not None:
        try:
            ip.user_ns.setdefault("spawn", subagents.spawn)
            ip.user_ns.setdefault("Agent", subagents.Agent)
        except Exception:
            pass  # builtins is enough
    _record("SUBAGENTS", f"spawn bound (depth={subagents._spawner().depth()})")


_bind_subagents()


def _render_wait_signal_cleanly():
    """
    Present the end-of-cell signal as control flow, not as a crash.

    `jobs.wait()` raises WaitSignal so that trailing statements are unreachable by
    construction. Left alone, IPython renders that as a traceback ending in
    `WaitSignal: 60` and marks the cell failed — which teaches the agent that the
    primitive it just used correctly is broken. That is the same mistake as the false
    "cell INTERRUPTED" notice: the harness telling the model it failed when it did
    exactly the right thing.
    """
    ip = _shell()
    if ip is None:
        return

    def handler(shell, etype, value, tb, tb_offset=None):
        seconds = value.args[0] if value.args else "?"
        print(
            f"[cell ended here so the kernel is free; the host waits {seconds}s and then "
            f"calls you again. Anything written after jobs.wait() in this cell did NOT run — "
            f"put it in the next cell.]"
        )
        return None

    try:
        ip.set_custom_exc((jobs.WaitSignal,), handler)
    except Exception as exc:
        print(f"[jobs] could not install the wait handler ({exc}); jobs.wait will show a traceback")


_render_wait_signal_cleanly()


# --------------------------------------------------------------------------------
# the backstop that teaches
# --------------------------------------------------------------------------------
#
# The tables above cover every *idiomatic* route to holding the kernel — sleep,
# thread, subprocess, the shell magics. They cannot see a command that blocks for a
# reason visible only at run time. The measured case is the mailman wedge:
#
#     mailman --run-as-root start 2>&1 | tail -5
#
# `mailman start` daemonises; the daemon inherits the pipe's write end; `tail` never
# reaches EOF and the cell hangs until the harness kills it at the cell ceiling.
# `jobs.blocking_sleep` finds no sleep, it is not a thread or an import, so nothing
# in the enumeration fires — verified: ON and OFF both wedged on exactly this line.
#
# The design has always named the cell wall-clock ceiling as the universal backstop
# for this residue (§6). The gap was never that the backstop is missing — it is that
# the harness kills the cell with a *bare* interrupt, which teaches nothing, so the
# agent writes the same line again. This makes the backstop behave like every other
# guard: interrupt the held cell and name jobs.submit.
#
# TWO trip points (docs §8.3, §8.4):
#
#   ceiling - margin  the HARD backstop. Fires just under the harness ceiling. A
#                     cell that reaches this was going to be killed anyway, so it
#                     adds no false positives — only a teaching moment where there
#                     was a silent kill.
#   WEDGE_SUSPECT     an AGGRESSIVE early trip. A true wedge blocks *forever*, so
#                     interrupting it at 120s versus at the 585s backstop is
#                     identical in correctness and saves the ~465s difference in
#                     held kernel time — a cost paid on *every* real wedge (mailman's
#                     daemon-pipe holds the kernel the full span otherwise, §8.3).
#                     The asymmetry favours firing early: a false positive costs one
#                     re-run, and the interrupt correctly names jobs.submit — which
#                     is the right move for a genuinely long *foreground* command in
#                     a single-threaded kernel anyway. Set from the measured
#                     foreground-compute surface (§8.4): the longest legitimate
#                     foreground compute observed was cartpole's ~72s train; every
#                     real build (compcert, gcc, sqlite) was either backgrounded or
#                     finished foreground in <35s. 0 = disabled, i.e. the ceiling
#                     backstop is the only trip (the pre-§8.4 behaviour).
#
# SIGALRM, not a watchdog thread: the interrupt must land in the main thread where
# the cell is blocked, and a thread cannot raise there. Armed only for the span of a
# cell (pre_run_cell -> arm, post_run_cell -> disarm) so it can never fire inside
# kernel machinery — the Event.wait mistake that once took the kernel down. Disabled
# unless the harness declares its ceiling, and on any platform without setitimer.
CELL_CEILING = int(os.environ.get("HARNESS_CELL_CEILING", "0"))  # 0 = disabled
CELL_CEILING_MARGIN = int(os.environ.get("HARNESS_CELL_CEILING_MARGIN", "15"))
# Early wedge-suspect trip. Clamped to the ceiling backstop so it can never fire
# later than it. 0 = disabled (ceiling backstop only).
WEDGE_SUSPECT_SECONDS = int(os.environ.get("HARNESS_WEDGE_SUSPECT_SECONDS", "0"))
_current_cell = {"src": ""}


def _install_cell_watchdog():
    import signal

    if CELL_CEILING <= 0:
        return  # no harness ceiling declared; nothing to backstop against
    if threading.current_thread() is not threading.main_thread():
        return  # SIGALRM/setitimer only work from the main thread
    if not hasattr(signal, "SIGALRM") or not hasattr(signal, "setitimer"):
        return  # Windows: the harness ceiling stays the only backstop there

    ip = _shell()
    if ip is None or not hasattr(ip, "events"):
        return

    ceiling_trip = max(1, CELL_CEILING - CELL_CEILING_MARGIN)
    fire_at = ceiling_trip
    if WEDGE_SUSPECT_SECONDS > 0:
        fire_at = max(1, min(WEDGE_SUSPECT_SECONDS, ceiling_trip))
    early = fire_at < ceiling_trip

    def on_alarm(signum, frame):
        # Re-arm rather than disarm: the raise below can land inside agent code
        # wrapped in `except Exception:` (retry loops do exactly this), and a
        # watchdog that fires once and goes dark leaves the kernel held for the
        # rest of the cell with no second trip (2026-08-15 review, M8). Re-armed,
        # a swallowed refusal fires again a ceiling later; the `finally` in the
        # cell runner still disarms on the way out.
        signal.setitimer(signal.ITIMER_REAL, CELL_CEILING)
        lines = [
            ln for ln in _current_cell["src"].strip().splitlines()
            if ln.strip() and not ln.strip().startswith("%%")
        ]
        suggestion = lines[0][:80] if lines else "your command"
        tail = (
            f"long enough to suspect it is blocked rather than computing"
            if early else
            f"so it was stopped just before the {CELL_CEILING}s ceiling"
        )
        raise CellHeldError(_redirect(
            f"this cell held the kernel for {fire_at}s without returning, {tail}. Something in "
            f"it blocks the kernel — a server or daemon started in the foreground, a "
            f"`| tail`/`| cat` reading a process that never closes its output, or a blocking "
            f"read waiting on work that has not finished. If it is real foreground work that "
            f"needs this long, it belongs in a job so the kernel is not held",
            suggestion,
        ))

    try:
        signal.signal(signal.SIGALRM, on_alarm)
    except Exception as exc:
        print(f"[jobs] cell watchdog not installed ({exc}); the harness ceiling is the only backstop")
        return

    def arm(info):
        _current_cell["src"] = getattr(info, "raw_cell", "") or ""
        try:
            signal.setitimer(signal.ITIMER_REAL, fire_at)
        except Exception:
            pass  # non-main execution thread; fall back to the harness ceiling

    def disarm(result):
        try:
            signal.setitimer(signal.ITIMER_REAL, 0)
        except Exception:
            pass

    try:
        ip.events.register("pre_run_cell", arm)
        ip.events.register("post_run_cell", disarm)
    except Exception as exc:
        signal.signal(signal.SIGALRM, signal.SIG_DFL)
        print(f"[jobs] cell watchdog not installed ({exc}); the harness ceiling is the only backstop")


_install_cell_watchdog()


def _announce_existing_jobs():
    """
    Tell a fresh kernel what is already running. Deliberately does NOT bind anything.

    A kernel restart loses every variable, but the jobs themselves are files and keep
    running. What the agent needs at that moment is not its old local names back — it
    is the knowledge that the work exists, plus the one verb that reaches it:
    `jobs.get(name)`.

    Auto-binding was tried and removed. It buys nothing `jobs.get` does not already
    give, and it creates the whole family of problems that come with a local variable
    pretending to be durable state: shadowing, aliasing, burial in a list, names that
    are not legal identifiers. A handle reached by lookup cannot go stale; a variable
    silently re-pointed across a kernel death can, and that is the failure it was
    supposedly preventing.
    """
    try:
        rows = jobs.list()
    except Exception as exc:  # never let this break the kernel it is reporting on
        print(f"[jobs] could not read the job directory ({exc}); jobs.list() to retry")
        return
    if not rows:
        return
    # `starting` counts as live: it is a job whose submit was interrupted, which is
    # exactly the state a fresh kernel is most likely to be looking at.
    live = [r for r in rows if r.get("state") in jobs.LIVE_STATES]
    print(f"[{len(rows)} job(s) from a previous kernel, {len(live)} still running — "
          f"reach them with jobs.get('<name>')]")
    print(jobs.manifest())


_announce_existing_jobs()

# Deliberately does NOT state the sleep threshold.
#
# An earlier version advertised "do not sleep for more than 30s". One run then clamped
# every sleep to exactly 30s — four times — never tripped the guard, and so never
# discovered `jobs.wait` at all; its total waiting fell from 493s to 180s and its
# score dropped 6/6 to 3/6. The two runs that *did* hit the error adopted the
# primitive on the very next cell.
#
# The error teaches the primitive; the advisory teaches the threshold. Name the
# capability, let the guard explain the limit if it fires.
print(
    "[waiting and background work: jobs.wait(wake_after=…) as a cell's last statement, "
    "jobs.submit(cmd, name=…) for work that should outlive the cell, jobs.get/list/manifest "
    "to check on it. Prefer these over sleeping or threading inside a cell.]"
)

_record("COMPLETED", "jobs bound in builtins" if hasattr(__import__("builtins"), "jobs") else "jobs NOT bound")
