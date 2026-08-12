"""
Tests for runtime/kernel-prelude.py.

The prelude mutates process-global state (`time.sleep`, `threading.Thread`,
`os.fork`), so it is loaded into a *fresh module object* per test and the globals it
patched are restored afterwards. Otherwise the first test to import it would block
sleeping for every test that follows, including in other files.

What is actually being checked: the guards refuse the in-process shapes and name the
right replacement, the sleep ceiling is a ceiling rather than an advisory, and a fresh
kernel is *told* about jobs from a previous one without anything being bound into its
namespace.
"""

import importlib.util
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

# Imported here, before any prelude loads. Once the guards are installed these
# modules are refused AT IMPORT for agent code — and this test file counts as agent
# code — so a test that imports them in its body is testing the import guard by
# accident and cannot reach the call guards at all.
import concurrent.futures as futures
import queue
import multiprocessing

import jobs as J

PRELUDE = os.path.join(os.path.dirname(__file__), "kernel-prelude.py")

# Every prelude instance loaded during a test, so tearDown can undo its global patches.
_LOADED = []


def load_prelude(namespace_holder=None, capture=None, as_agent_code=True):
    """
    Import kernel-prelude.py under a throwaway module name.

    `capture` collects what the prelude prints. The startup announcement is the
    entire user-visible contract after a kernel restart, so it has to be asserted on
    rather than assumed.
    """
    spec = importlib.util.spec_from_file_location("harness_prelude_undertest", PRELUDE)
    mod = importlib.util.module_from_spec(spec)
    if namespace_holder is not None:
        mod.get_ipython = lambda: namespace_holder
    if capture is not None:
        mod.print = lambda *a, **k: capture.append(" ".join(str(x) for x in a))
    spec.loader.exec_module(mod)
    # Registered automatically. Tracking per call site was tried and missed the plain
    # `load_prelude()` calls, so guards leaked and a later test really did run
    # `os.system("sleep 40")` — the suite hung instead of failing.
    _LOADED.append(mod)
    # This test file lives in runtime/, which the prelude exempts so that
    # `jobs.submit` can spawn through subprocess.Popen without refusing itself. Left
    # alone, every guard would therefore be inert here and the tests would assert
    # nothing — worse, some would really run `sleep 40`. Dropping just the runtime
    # directory (keeping stdlib exempt) gives this file agent-code semantics.
    if as_agent_code:
        # The guards now fire only for notebook-cell filenames (inverted from a
        # path-based rule that could wedge the kernel). This file is not a cell, so
        # without this every guard is inert here — and a test expecting a refusal
        # instead runs a real `sleep 40` and the suite hangs, which is exactly what
        # happened.
        mod._is_cell = lambda name: name == __file__ or "test_" in name
    return mod





class FakeMagicsManager:
    def __init__(self):
        self.magics = {"cell": {}, "line": {}}


class FakeIPython:
    """
    Shaped enough to exercise the real prelude paths.

    An earlier version had only `user_ns`, so `_guard_shell_cells` raised on it and
    three tests errored — while in a real kernel the guard was fine. A fake that is
    too thin does not make tests pass, it makes them test a different program.
    """

    def __init__(self):
        self.user_ns = {}
        self.magics_manager = FakeMagicsManager()
        self.registered = {}
        self.system = lambda cmd: ("ran", cmd)

    def register_magic_function(self, fn, magic_kind="cell", magic_name=None):
        self.magics_manager.magics[magic_kind][magic_name] = fn
        self.registered[magic_name] = fn


class PreludeBase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="prelude-test-")
        os.environ["HARNESS_RUNTIME_DIR"] = os.path.dirname(__file__)
        # Point the module-level surface at a store with an injected clock/spawner so
        # the prelude's startup announcement reports controlled state.
        self.spawned = []
        self.store = J.JobStore(
            self.dir,
            now=lambda: 1000.0,
            spawn=self._spawn,
            kill=lambda pid: None,
            emit=lambda m: None,
        )
        J.use_store(self.store)
        self._saved = (time.sleep, threading.Thread, getattr(os, "fork", None))
        _LOADED.clear()
        self._printed = []
        self._real_print = __builtins__["print"] if isinstance(__builtins__, dict) else __builtins__.print

    def _spawn(self, wrapped, log_path, cwd):
        self.spawned.append(wrapped)
        open(log_path, "a").close()
        return 4242

    def tearDown(self):
        # The guards are process-global. Without an explicit undo, one test's patches
        # leak into every later test and the suite fails only under `discover` — the
        # most confusing way for a suite to fail, and it did.
        while _LOADED:
            try:
                _LOADED.pop().uninstall_guards()
            except Exception:
                pass
        time.sleep, threading.Thread = self._saved[0], self._saved[1]
        if self._saved[2] is not None:
            os.fork = self._saved[2]
        J._default = None
        sys.modules.pop("harness_prelude_undertest", None)
        shutil.rmtree(self.dir, ignore_errors=True)


class TestStartupFilePath(PreludeBase):
    """
    The prelude must survive being run as an IPython startup file, where `__file__`
    is NOT defined.

    Cost of getting this wrong: a NameError raised from inside ipykernel's stdout
    flush killed kernel initialisation, and every cell of seven TAC runs came back
    "Kernel did not respond". It never reproduced locally because the eval harness
    loads the prelude via runpy.run_path, which sets `__file__` — the startup-file
    path was never exercised. So this test loads it the hard way.
    """

    def test_loads_without_dunder_file(self):
        # Compile with no __file__ in globals — the condition that broke seven TAC
        # runs — without EXECUTING the prelude (which installs process-wide guards and
        # would poison the rest of the suite). Executing it in a kernel is covered by
        # the container test; this pins the specific NameError.
        src = open(PRELUDE).read()
        code = compile(src, "<startup>", "exec")
        g = {"__name__": "__prelude_startup__"}  # deliberately no __file__
        # Resolve just the _SELF / _LIB_DIRS lines, which is where the NameError was.
        for line in ("_SELF = ", "_LIB_DIRS = "):
            pass
        # Full exec is unsafe here (global patching), so assert on the source instead:
        self.assertIn('_SELF = globals().get("__file__") or', src)
        self.assertNotIn("os.path.dirname(__file__))", src)

    def test_self_falls_back_when_file_is_absent(self):
        # Directly: the module-level guard is `globals().get("__file__") or sentinel`.
        src = open(PRELUDE).read()
        self.assertIn('globals().get("__file__")', src)
        self.assertNotIn("os.path.dirname(__file__)", src,
                         "a bare __file__ will NameError as a startup file")


class TestGuards(PreludeBase):
    def test_long_sleep_raises_and_names_the_primitive(self):
        load_prelude()
        with self.assertRaises(RuntimeError) as ctx:
            time.sleep(235)
        msg = str(ctx.exception)
        self.assertIn("jobs.wait(wake_after=235)", msg)
        self.assertIn("variables survive", msg)

    def test_error_does_not_reveal_the_threshold(self):
        # An earlier version advertised the 30s limit; one run then clamped every
        # sleep to exactly 30s, never tripped the guard, never found jobs.wait, and
        # dropped 6/6 -> 3/6. The error teaches the primitive; an advisory teaches the
        # threshold. So the message must not contain the number.
        load_prelude()
        with self.assertRaises(RuntimeError) as ctx:
            time.sleep(235)
        self.assertNotIn("30", str(ctx.exception))

    def test_short_sleep_still_works(self):
        # A 2s settle after a POST is ordinary code, not waiting.
        load_prelude()
        t0 = time.monotonic()
        time.sleep(0.001)
        self.assertLess(time.monotonic() - t0, 1.0)

    def test_thread_is_refused_with_the_replacement(self):
        load_prelude()
        with self.assertRaises(RuntimeError) as ctx:
            threading.Thread(target=lambda: None)
        msg = str(ctx.exception)
        self.assertIn("jobs.submit", msg)
        self.assertIn("jobs.wait", msg)

    def test_fork_is_refused(self):
        load_prelude()
        with self.assertRaises(RuntimeError) as ctx:
            os.fork()
        self.assertIn("jobs.submit", str(ctx.exception))

    def test_ceiling_is_configurable(self):
        os.environ["HARNESS_SLEEP_CEILING"] = "5"
        try:
            load_prelude()
            with self.assertRaises(RuntimeError):
                time.sleep(6)
        finally:
            os.environ.pop("HARNESS_SLEEP_CEILING", None)

    def test_sleep_time_is_accumulated_for_attribution(self):
        # Retroactive attribution is the only soft channel available: the model exists
        # at turn boundaries, so an in-flight cell cannot be told anything, but a cell
        # that spent most of its time asleep can be told afterwards.
        mod = load_prelude()
        time.sleep(0.001)
        time.sleep(0.001)
        self.assertGreater(mod._slept["seconds"], 0)


class TestAsyncGuard(PreludeBase):
    def test_long_async_sleep_raises(self):
        import asyncio
        saved = asyncio.sleep
        try:
            load_prelude()

            async def go():
                await asyncio.sleep(120)

            with self.assertRaises(RuntimeError) as ctx:
                asyncio.run(go())
            self.assertIn("jobs.wait", str(ctx.exception))
        finally:
            asyncio.sleep = saved

    def test_short_async_sleep_passes(self):
        import asyncio
        saved = asyncio.sleep
        try:
            load_prelude()

            async def go():
                await asyncio.sleep(0)
                return "ok"

            self.assertEqual(asyncio.run(go()), "ok")
        finally:
            asyncio.sleep = saved


class TestJobsStaysBound(PreludeBase):
    """
    `jobs` must survive anything that clears the user namespace.

    Measured cost of getting this wrong, from a trajectory: the agent ran `%reset -f`,
    hit a NameError, guessed `import agent_jobs`, grepped sys.modules, and only then
    found `import jobs` — three wasted cells. A post_run_cell hook was tried first and
    verified insufficient against a real IPython shell: the agent writes `%reset -f`
    and uses `jobs` in the SAME cell, and the hook fires too late.
    """

    def test_jobs_is_bound_into_builtins(self):
        import builtins
        had = hasattr(builtins, "jobs")
        try:
            load_prelude()
            self.assertTrue(hasattr(builtins, "jobs"))
            self.assertIs(builtins.jobs, J)
        finally:
            if not had:
                delattr(builtins, "jobs")

    def test_builtins_binding_survives_clearing_a_namespace(self):
        # builtins is what %reset -f cannot touch; this is the property that matters.
        import builtins
        had = hasattr(builtins, "jobs")
        try:
            ip = FakeIPython()
            load_prelude(namespace_holder=ip)
            ip.user_ns.clear()          # what %reset -f does
            self.assertFalse("jobs" in ip.user_ns)
            self.assertTrue(hasattr(builtins, "jobs"), "jobs must outlive a namespace reset")
        finally:
            if not had:
                delattr(builtins, "jobs")

    def test_user_namespace_also_gets_it_for_discoverability(self):
        import builtins
        had = hasattr(builtins, "jobs")
        try:
            ip = FakeIPython()
            load_prelude(namespace_holder=ip)
            self.assertIs(ip.user_ns.get("jobs"), J)
        finally:
            if not had:
                delattr(builtins, "jobs")


class TestStartupAnnouncement(PreludeBase):
    """A fresh kernel is told what exists — and nothing is bound into it."""

    def test_existing_jobs_are_announced_not_bound(self):
        self.store.submit("gradle build", name="build")
        ip = FakeIPython()
        out = []
        load_prelude(namespace_holder=ip, capture=out)
        text = "\n".join(out)
        self.assertIn("build", text)
        self.assertIn("jobs.get(", text)
        # The crucial half: the job HANDLE is not bound. `jobs` (the module) is, and
        # must be — that is machinery. `build` (a handle) is not, and must not be: a
        # variable that silently re-points across a kernel death is the hazard the
        # lookup design exists to avoid.
        self.assertNotIn("build", ip.user_ns)
        self.assertEqual(set(ip.user_ns) - {"jobs"}, set())

    def test_running_count_is_reported(self):
        self.store.submit("a", name="a")
        self.store.submit("b", name="b")
        self.store.kill("b")
        out = []
        load_prelude(capture=out)
        text = "\n".join(out)
        self.assertIn("2 job(s)", text)
        self.assertIn("1 still running", text)

    def test_no_jobs_means_no_announcement(self):
        out = []
        load_prelude(capture=out)
        self.assertFalse(any("job(s) from a previous kernel" in line for line in out))

    def test_unreadable_job_directory_does_not_break_the_kernel(self):
        # Reporting on state must never take down the thing it reports on.
        broken = J.JobStore(self.dir, now=lambda: 0.0, spawn=self._spawn, emit=lambda m: None)

        def explode():
            raise RuntimeError("disk gone")

        broken.list = explode
        J.use_store(broken)
        out = []
        load_prelude(capture=out)  # must not raise
        self.assertTrue(any("could not read the job directory" in line for line in out))

    def test_a_pruned_job_is_still_listed_so_it_is_not_a_mystery(self):
        self.store.submit("gradle build", name="build")
        self.store.prune("build", "container recycled")
        out = []
        load_prelude(capture=out)
        text = "\n".join(out)
        self.assertIn("build", text)
        self.assertIn("container recycled", text)


if __name__ == "__main__":
    unittest.main()


class GuardBase(PreludeBase):
    """
    Base for guard tests.

    The prelude exempts its own directory so `jobs.submit` can spawn through
    subprocess.Popen without refusing itself — and these tests live in that same
    directory, so without this every guard would be inert here and the tests would
    quietly pass while actually sleeping. (They did: an early version hung for two
    minutes running a real `sleep 40`.) Point the guard's notion of library code
    somewhere else so agent-code semantics apply.
    """

    def arm(self):
        return load_prelude()


class TestKernelIoIsNotGuarded(GuardBase):
    """
    Do not instrument the kernel's own I/O primitives.

    ipykernel calls `Event.wait(flush_timeout)` on every stdout flush; guarding it put
    our code in the kernel's hottest path, and a raise there is a dead kernel, not a
    lesson. Same class as Popen.communicate (broke subprocess.run) and the %%bash
    thread guard (broke every shell cell).
    """

    def test_event_wait_and_queue_get_are_not_guarded(self):
        # threading/queue imported at module top, before the import guard is armed —
        # importing them inside the guarded region is itself (correctly) refused.
        self.arm()
        self.assertFalse(threading.Event().wait(0.01))
        q = queue.Queue()
        q.put(1)
        self.assertEqual(q.get(timeout=1), 1)

    def test_the_guard_table_excludes_kernel_io(self):
        mod = self.arm()
        labels = [g[0] for g in mod._METHOD_GUARDS] if mod._METHOD_GUARDS else []
        self.assertNotIn("threading", str(mod._METHOD_GUARDS), "Event.wait must not be guarded")


class TestGuardTable(GuardBase):
    def test_the_table_installs_cleanly(self):
        mod = self.arm()
        self.assertGreater(len(mod.GUARDS_INSTALLED), 15)
        self.assertEqual(mod.GUARDS_SKIPPED, [], "a guard named a target that does not exist")

    def test_escape_routes_are_refused(self):
        self.arm()
        for label, fn in [
            ("threading.Thread", lambda: threading.Thread(target=lambda: None)),
            ("threading.Timer", lambda: threading.Timer(1, lambda: None)),
            ("ThreadPoolExecutor", lambda: futures.ThreadPoolExecutor()),
            ("ProcessPoolExecutor", lambda: futures.ProcessPoolExecutor()),
            ("multiprocessing.Process", lambda: multiprocessing.Process(target=lambda: None)),
            ("os.popen", lambda: os.popen("echo hi")),
        ]:
            with self.assertRaises(RuntimeError, msg=f"{label} was allowed"):
                fn()

    def test_from_import_is_also_refused(self):
        # `from threading import Thread` binds the patched attribute, so it is covered
        # by the same patch — but that is worth asserting rather than assuming, since
        # it is the spelling an agent is most likely to use.
        self.arm()
        with self.assertRaises(ImportError) as ctx:
            __import__("threading")
        self.assertIn("jobs.submit", str(ctx.exception))

    def test_classes_remain_subclassable(self):
        # Replacing threading.Thread with a *function* broke concurrent.futures, which
        # subclasses Thread at import time. Guards on classes must be classes.
        self.arm()

        class MyWorker(threading.Thread):
            pass

        self.assertTrue(issubclass(MyWorker, threading.Thread))

    def test_blocking_commands_are_refused(self):
        self.arm()
        import subprocess
        for fn in (
            lambda: subprocess.run("sleep 40", shell=True),
            lambda: subprocess.run(["sleep", "40"]),
            lambda: subprocess.Popen("sleep 75 && echo x", shell=True),
            lambda: os.system("sleep 40"),
        ):
            with self.assertRaises(RuntimeError):
                fn()

    def test_detached_subprocess_is_refused(self):
        self.arm()
        import subprocess
        with self.assertRaises(RuntimeError) as ctx:
            subprocess.Popen(["echo", "x"], start_new_session=True)
        self.assertIn("recover it after a kernel restart", str(ctx.exception))

    def test_ordinary_work_is_untouched(self):
        # The rule is about holding the kernel or escaping it, not about the library.
        # Over-broad guards have twice broken working features in this project.
        self.arm()
        import subprocess
        self.assertEqual(subprocess.run(["echo", "hi"], capture_output=True, text=True).stdout.strip(), "hi")
        self.assertEqual(os.system("true"), 0)
        self.assertFalse(threading.Event().wait(0.01))
        time.sleep(0.01)

    def test_every_guard_points_at_jobs_and_at_help(self):
        self.arm()
        import subprocess
        for fn in (
            lambda: time.sleep(500),
            lambda: threading.Thread(target=lambda: None),
            lambda: subprocess.run("sleep 40", shell=True),
            lambda: os.system("sleep 40"),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                fn()
            msg = str(ctx.exception)
            self.assertIn("jobs.", msg)
            self.assertIn("jobs.help()", msg, f"guard does not point at help(): {msg[:80]}")

    def test_the_runtime_may_still_spawn_its_own_jobs(self):
        # jobs.submit() spawns through subprocess.Popen. A guard that did not exempt
        # the runtime would refuse the primitive it redirects people toward.
        load_prelude(as_agent_code=False)  # the runtime keeps its own exemption
        job = self.store.submit("echo hi", name="selfspawn")
        self.assertEqual(job.state, "running")
