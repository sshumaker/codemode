"""
Integration tests: a REAL subprocess, a real clock, real files.

Everything in test_jobs.py is mocked, which proves the state machine and proves
nothing about whether a job actually runs. That gap is the one this project keeps
falling into — `find_spec` certified a module containing a syntax error, because
locating a module does not execute it. So a small number of tests here pay real
wall-clock (< 3s total) to check the parts a mock cannot:

- the spawner actually starts a process and its output reaches the log
- the exit marker is really written by the shell wrapper, including for a command
  that ends in `exit N` (the subshell-vs-brace-group bug)
- a killed job is really dead
- detachment: the job survives the Python object that created it

Kept deliberately small and fast; the exhaustive cases live in the mocked suite.
"""

import os
import shutil
import signal
import subprocess
import tempfile
import time
import sys
import unittest

import jobs as J


def wait_until(predicate, timeout=5.0, interval=0.02):
    """Poll a real condition. Returns True if it became true before the timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


class RealBase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="jobs-integration-")
        self.emitted = []
        self.store = J.JobStore(self.dir, cwd=self.dir, emit=self.emitted.append)

    def tearDown(self):
        for rec in self.store._all():
            if rec.get("state") == "running":
                try:
                    self.store.kill(rec["name"])
                except Exception:
                    pass
        shutil.rmtree(self.dir, ignore_errors=True)


class TestRealExecution(RealBase):
    def test_job_runs_and_output_reaches_the_log(self):
        job = self.store.submit("echo hello-from-job", name="hello")
        self.assertTrue(wait_until(lambda: job.done), "job never completed")
        self.assertTrue(job.ok)
        self.assertEqual(job.exit_code, 0)
        self.assertIn("hello-from-job", job.output)

    def test_nonzero_exit_is_captured(self):
        job = self.store.submit("exit 7", name="fail")
        self.assertTrue(wait_until(lambda: job.done))
        self.assertEqual(job.exit_code, 7)
        self.assertFalse(job.ok)
        self.assertEqual(job.reason, "exited non-zero")

    def test_command_ending_in_exit_still_writes_its_marker(self):
        # The subshell-vs-brace-group bug: with `{ ... }` a trailing `exit N` exits the
        # OUTER shell, the marker is never written, and the job reports "running"
        # forever. This is the regression test for that, and it can only be written
        # against a real shell.
        job = self.store.submit("echo before; exit 3", name="exiter")
        self.assertTrue(wait_until(lambda: job.done), "trailing exit killed the wrapper")
        self.assertEqual(job.exit_code, 3)
        self.assertIn("before", job.output)

    def test_stderr_is_captured_too(self):
        job = self.store.submit("echo oops >&2", name="err")
        self.assertTrue(wait_until(lambda: job.done))
        self.assertIn("oops", job.output)

    def test_output_is_readable_while_still_running(self):
        job = self.store.submit("echo early; sleep 30", name="slow")
        self.assertTrue(wait_until(lambda: "early" in job.output))
        self.assertEqual(job.state, "running")
        self.store.kill("slow")

    def test_cwd_is_honoured(self):
        marker = os.path.join(self.dir, "in-cwd.txt")
        job = self.store.submit("pwd > in-cwd.txt", name="cwd")
        self.assertTrue(wait_until(lambda: job.done))
        self.assertTrue(os.path.exists(marker))
        with open(marker) as fh:
            self.assertIn(os.path.basename(self.dir), fh.read())


class TestRealKill(RealBase):
    def test_kill_actually_stops_the_process(self):
        job = self.store.submit("sleep 60", name="sleeper")
        pid = self.store._read("sleeper")["pid"]
        self.assertTrue(wait_until(lambda: _pid_alive(pid)), "process never started")
        self.assertTrue(self.store.kill("sleeper"))
        self.assertTrue(wait_until(lambda: not _pid_alive(pid)), "process survived kill")
        self.assertEqual(job.state, "killed")

    def test_kill_takes_the_whole_process_group(self):
        # The job is a shell that spawns a child; killing only the shell would leave
        # the child running and invisible. start_new_session + killpg is what prevents
        # that, and it cannot be verified with a mock.
        job = self.store.submit("sleep 60 & sleep 60", name="group")
        time.sleep(0.3)
        pgid = os.getpgid(self.store._read("group")["pid"])
        self.store.kill("group")
        self.assertTrue(
            wait_until(lambda: _count_in_group(pgid) == 0, timeout=5),
            "child processes survived the group kill",
        )
        self.assertEqual(job.state, "killed")


class TestRealDetachment(RealBase):
    def test_job_survives_the_store_that_created_it(self):
        # The whole premise of rehydration: state is files, so a brand-new store over
        # the same directory sees the same running job. This is the kernel-death case
        # without needing to kill a kernel.
        self.store.submit("sleep 1; echo done-anyway", name="survivor")

        # A second store sharing nothing but the directory is the fresh kernel. The
        # original is left alone so teardown can still clean up after both.
        fresh = J.JobStore(self.dir, cwd=self.dir, emit=lambda m: None)
        job = fresh.get("survivor")
        self.assertIsNotNone(job, "a new kernel could not find the running job")
        self.assertTrue(wait_until(lambda: job.done, timeout=8))
        self.assertIn("done-anyway", job.output)

    def test_job_is_not_a_child_of_this_process(self):
        # Detached via start_new_session, so it is in its own process group and will
        # not die when the kernel does.
        self.store.submit("sleep 5", name="detached")
        pid = self.store._read("detached")["pid"]
        self.assertTrue(wait_until(lambda: _pid_alive(pid)))
        self.assertNotEqual(os.getpgid(pid), os.getpgid(os.getpid()))
        self.store.kill("detached")


class TestInterruptedSubmit(RealBase):
    """
    The kill-during-submit window: the interval in which a job's process can exist
    while nothing on disk says so.

    Reproduced with a REAL process death, not a mock. A child process runs submit()
    with a spawner that starts the job and then SIGKILLs itself the instant Popen
    returns — which is exactly where a kernel OOM or a container restart can land.

    Measured before the fix (spawn-then-write): the job ran to completion and wrote
    its output, while `jobs.get(name)` returned None and `manifest()` reported "no
    jobs yet" — not merely unhelpful but an active assertion that nothing had been
    started. An agent that believes it re-submits, which runs an expensive job twice:
    the precise failure durability exists to prevent.

    These tests are the reason `submit` claims the name on disk before spawning and
    the job writes its own pid. Remove either and the first test here fails.
    """

    SCRIPT = """
import os, signal, sys
sys.path.insert(0, {runtime!r})
import jobs as J
store = J.JobStore(sys.argv[1], cwd=sys.argv[2])
real = store._spawn

def spawn_then_die(cmd, log, cwd):
    pid = real(cmd, log, cwd)
    os.kill(os.getpid(), signal.SIGKILL)   # the window
    return pid

store._spawn = spawn_then_die
store.submit(sys.argv[3], name="victim")
"""

    def _submit_and_die(self, command):
        """Run one submit in a child that dies between the spawn and the record write."""
        script = os.path.join(self.dir, "interrupted_submit.py")
        with open(script, "w") as fh:
            fh.write(self.SCRIPT.format(runtime=os.path.dirname(os.path.abspath(J.__file__))))
        proc = subprocess.run(
            [sys.executable, script, self.dir, self.dir, command],
            capture_output=True, text=True,
        )
        # -9: the child really was killed mid-submit rather than returning normally.
        self.assertEqual(proc.returncode, -signal.SIGKILL,
                         f"child did not die in the window: rc={proc.returncode} {proc.stderr[-300:]}")

    def test_a_job_started_by_an_interrupted_submit_is_still_findable(self):
        marker = os.path.join(self.dir, "survived.txt")
        self._submit_and_die(f"sleep 1; echo alive > {marker}")

        # A brand-new store over the same directory is the replacement kernel.
        fresh = J.JobStore(self.dir, cwd=self.dir, emit=lambda m: None)
        job = fresh.get("victim")
        self.assertIsNotNone(
            job, "a job whose submit was interrupted is invisible — this is the orphan window"
        )
        self.assertIn(job.state, J.LIVE_STATES + ("done",))
        self.assertNotIn("no jobs yet", fresh.manifest())

        # And the work itself really did run, which is what makes the invisibility bad
        # rather than merely untidy.
        self.assertTrue(wait_until(lambda: os.path.exists(marker), timeout=8),
                        "the orphaned job never ran, so this is not the window under test")
        self.assertTrue(wait_until(lambda: job.done, timeout=8))
        self.assertTrue(job.ok)

    def test_resubmitting_the_same_name_is_refused_so_the_work_is_not_redone(self):
        # The falsifier, stated as a test: an interrupted submit must not let the agent
        # silently start a second copy of expensive work.
        trace = os.path.join(self.dir, "invocations.txt")
        self._submit_and_die(f"echo ran >> {trace}; sleep 1")

        fresh = J.JobStore(self.dir, cwd=self.dir, emit=lambda m: None)
        with self.assertRaises(J.JobError) as caught:
            fresh.submit(f"echo ran >> {trace}; sleep 1", name="victim")
        self.assertIn("victim", str(caught.exception))

        self.assertTrue(wait_until(lambda: fresh.get("victim").done, timeout=8))
        with open(trace) as fh:
            self.assertEqual(fh.read().count("ran"), 1, "the work ran more than once")

    def test_the_recovered_job_is_killable(self):
        # Recovery is worth little if the job cannot then be stopped: the pid Popen
        # returned died with the kernel, so the job has to have recorded its own.
        self._submit_and_die("sleep 30")
        fresh = J.JobStore(self.dir, cwd=self.dir, emit=lambda m: None)
        self.assertTrue(wait_until(lambda: fresh.get("victim").state == "running", timeout=5),
                        "never adopted the pid the job wrote for itself")
        pid = fresh._read("victim")["pid"]
        self.assertTrue(_pid_alive(pid))
        self.assertTrue(fresh.kill("victim"))
        self.assertTrue(wait_until(lambda: not _pid_alive(pid)), "recovered job could not be killed")

    def test_the_name_is_claimed_before_anything_can_run_under_it(self):
        # The ordering invariant itself, checked without killing anything: at the
        # moment the spawner is called, the record must already be on disk. Assert it
        # from inside the spawner, which is the only point that can see the interval.
        seen = {}

        def spy(cmd, log, cwd):
            seen["record"] = self.store._read("ordered")
            return real(cmd, log, cwd)

        real = self.store._spawn
        self.store._spawn = spy
        self.store.submit("true", name="ordered")
        self.assertIsNotNone(seen["record"], "spawned before the name was claimed on disk")
        self.assertEqual(seen["record"]["state"], "starting")
        self.assertIsNone(seen["record"]["pid"])

    def test_a_torn_write_leaves_the_previous_record_readable(self):
        # A record is the only evidence a job exists, so a half-written one is as bad
        # as none: _read swallows the ValueError and returns None, _all skips it,
        # manifest says "no jobs yet" and the name becomes reusable — the same
        # invisibility as the orphan window, reached by a different route.
        #
        # Simulated by failing json.dump after it has emitted a valid-looking prefix,
        # which is what a full disk or a process death mid-write produces. Writing in
        # place truncates on open, so the prefix IS the file; writing to a sibling and
        # renaming leaves the previous record untouched.
        self.store.submit("sleep 5", name="atomic")
        rec = self.store._read("atomic")
        self.assertIsNotNone(rec)

        real_dump = J.json.dump

        def torn_dump(obj, fh):
            fh.write('{"name": "atomic", "state": "run')
            raise OSError("no space left on device")

        J.json.dump = torn_dump
        try:
            with self.assertRaises(OSError):
                self.store._write(rec)
        finally:
            J.json.dump = real_dump

        recovered = self.store._read("atomic")
        self.assertIsNotNone(recovered, "a torn write destroyed the record")
        self.assertEqual(recovered["name"], "atomic")
        self.assertIsNotNone(self.store.get("atomic"))
        self.assertNotIn("no jobs yet", self.store.manifest())
        # And the debris must not be mistaken for a job of its own.
        self.assertEqual([f for f in os.listdir(self.dir) if f.endswith(".json")], ["atomic.json"])
        self.store.kill("atomic")


class TestRealDeadline(RealBase):
    def test_deadline_kills_a_real_runaway_and_reports_never_fired(self):
        job = self.store.submit("sleep 60", name="runaway", max_runtime=1)
        pid = self.store._read("runaway")["pid"]
        self.assertTrue(wait_until(lambda: _pid_alive(pid)))
        # Refreshing after the deadline is what triggers enforcement.
        self.assertTrue(wait_until(lambda: job.state == "deadline", timeout=6))
        self.assertEqual(job.reason, "deadline reached, never fired")
        self.assertTrue(wait_until(lambda: not _pid_alive(pid)), "deadline did not kill it")

    def test_condition_that_succeeds_completes_before_its_deadline(self):
        # The recommended one-shot shape, executed for real.
        job = self.store.submit(
            "until [ -f ready.flag ]; do sleep 0.1; done", name="ready", max_runtime=30
        )
        time.sleep(0.3)
        self.assertEqual(job.state, "running")
        open(os.path.join(self.dir, "ready.flag"), "w").close()
        self.assertTrue(wait_until(lambda: job.done, timeout=6))
        self.assertTrue(job.ok)
        self.assertEqual(job.reason, "completed")


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A zombie answers signal 0, so confirm against the process table — this is the
    # same trap that made completed jobs report as running.
    out = subprocess.run(["ps", "-o", "state=", "-p", str(pid)],
                         capture_output=True, text=True).stdout.strip()
    return bool(out) and not out.startswith("Z")


def _count_in_group(pgid):
    out = subprocess.run(["ps", "-o", "pgid=,state=", "-A"], capture_output=True, text=True).stdout
    n = 0
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == str(pgid) and not parts[1].startswith("Z"):
            n += 1
    return n


if __name__ == "__main__":
    unittest.main()
