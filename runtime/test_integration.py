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
import subprocess
import tempfile
import time
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
