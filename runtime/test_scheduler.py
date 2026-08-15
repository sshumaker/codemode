"""
Tests for runtime/scheduler.py — the wake scheduler.

The harness under the scheduler is FAKE (a recording runner), because the
scheduler's contract is orchestration, not agency: wake the right session, at
the right moment, exactly once, under a lease, from disk alone. The real-prime
end-to-end run is the compile-compcert demo, not a unit test.

The properties pinned here are the ones prime's daemon needed 18k lines for:
single-writer, stale-lease reclaim, no double-fire, crash-resume from disk.
"""

import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest

import jobs as J
import scheduler as S


class Base(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="sched-")
        self.runs = []  # what the fake harness was invoked with
        self.now = 1000.0

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def clock(self):
        return self.now

    def runner(self, argv, cwd=None, env=None):
        self.runs.append({"argv": argv, "cwd": cwd, "env": env})
        return subprocess.CompletedProcess(argv, 0)

    def session(self, name, wake_at=None, watch=None, wake_after=60):
        d = os.path.join(self.root, name)
        os.makedirs(os.path.join(d, "jobs"), exist_ok=True)
        with open(os.path.join(d, S.SESSION_FILE), "w") as fh:
            json.dump({"argv": ["harness", "--resume", f"{name}.jsonl", "-p"], "cwd": d}, fh)
        if wake_at is not None or watch is not None:
            with open(os.path.join(d, S.WAKE_FILE), "w") as fh:
                json.dump({"wake_at": wake_at, "watch": watch or [],
                           "wake_after": wake_after}, fh)
        return d

    def scan(self):
        return S.scan_once(self.root, now=self.clock, runner=self.runner,
                           log=lambda m: None)


class TestDeadlineWakes(Base):
    def test_a_due_deadline_wakes_the_session_with_the_reason(self):
        self.session("a", wake_at=900)  # due: now=1000
        self.assertEqual(self.scan(), ["a"])
        self.assertEqual(len(self.runs), 1)
        # The wake message is the trailing positional — the same shape as the
        # prompt in every prime invocation this project makes.
        self.assertIn("[woken:", self.runs[0]["argv"][-1])
        self.assertIn("elapsed", self.runs[0]["argv"][-1])

    def test_an_undue_deadline_does_not_wake(self):
        self.session("a", wake_at=2000)
        self.assertEqual(self.scan(), [])
        self.assertEqual(self.runs, [])

    def test_a_session_with_no_wake_file_is_finished_business(self):
        self.session("a")  # no wake.json at all
        self.assertEqual(self.scan(), [])

    def test_the_harness_env_names_the_session_jobs_and_wake_file(self):
        d = self.session("a", wake_at=900)
        self.scan()
        env = self.runs[0]["env"]
        self.assertEqual(env["HARNESS_JOB_DIR"], os.path.join(d, "jobs"))
        self.assertEqual(env["HARNESS_WAKE_FILE"], os.path.join(d, S.WAKE_FILE))


class TestJobCompletionWakesEarly(Base):
    """`wake_after` is a deadline, not a sleep — the job finishing wins."""

    def test_a_finished_watched_job_wakes_before_the_deadline(self):
        d = self.session("a", wake_at=99999, watch=["build"])
        store = J.JobStore(os.path.join(d, "jobs"), emit=lambda m: None)
        store.submit("echo done", name="build")
        # Real spawn: wait for the marker so the job is genuinely done on disk.
        deadline = time.monotonic() + 10
        while not store.get("build").done and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.scan(), ["a"])
        self.assertIn("job 'build' finished", self.runs[0]["argv"][-1])

    def test_a_still_running_watched_job_does_not_wake(self):
        d = self.session("a", wake_at=99999, watch=["build"])
        store = J.JobStore(os.path.join(d, "jobs"), emit=lambda m: None)
        store.submit("sleep 300", name="build", strict=False)
        try:
            self.assertEqual(self.scan(), [])
        finally:
            store.kill("build")


class TestExactlyOnce(Base):
    def test_a_consumed_wake_never_fires_twice(self):
        self.session("a", wake_at=900)
        self.assertEqual(self.scan(), ["a"])
        # The fake harness wrote no new wake.json → the session is done waiting.
        self.assertEqual(self.scan(), [])
        self.assertEqual(len(self.runs), 1)
        # ...and the fired request is preserved as evidence, not deleted.
        self.assertTrue(os.path.exists(os.path.join(self.root, "a", "wake.json.fired")))

    def test_a_harness_that_waits_again_is_woken_again(self):
        d = self.session("a", wake_at=900)

        def waiting_runner(argv, cwd=None, env=None):
            self.runs.append({"argv": argv})
            with open(env["HARNESS_WAKE_FILE"], "w") as fh:
                json.dump({"wake_at": self.now + 50, "watch": []}, fh)
            return subprocess.CompletedProcess(argv, 0)

        S.scan_once(self.root, now=self.clock, runner=waiting_runner, log=lambda m: None)
        self.assertEqual(len(self.runs), 1)
        # Not due yet…
        self.assertEqual(self.scan(), [])
        # …until the clock passes the NEW deadline.
        self.now += 60
        self.assertEqual(self.scan(), ["a"])
        self.assertEqual(len(self.runs), 2)


class TestLease(Base):
    def test_a_live_holder_is_never_preempted(self):
        d = self.session("a", wake_at=900)
        lease = os.path.join(d, S.LEASE_DIR)
        os.makedirs(lease)
        with open(os.path.join(lease, "owner.json"), "w") as fh:
            json.dump(S._self_identity(), fh)  # this test process: alive
        self.assertEqual(self.scan(), [])
        self.assertEqual(self.runs, [])

    def test_a_dead_holders_lease_is_reclaimed_and_the_session_woken(self):
        d = self.session("a", wake_at=900)
        lease = os.path.join(d, S.LEASE_DIR)
        os.makedirs(lease)
        # A pid that is certainly gone, with an identity that cannot match.
        dead = subprocess.Popen(["true"])
        dead.wait()
        with open(os.path.join(lease, "owner.json"), "w") as fh:
            json.dump({"pid": dead.pid, "pid_start": "Thu Jan  1 00:00:00 1970"}, fh)
        self.assertEqual(self.scan(), ["a"])

    def test_a_corrupt_owner_file_is_treated_as_stale(self):
        d = self.session("a", wake_at=900)
        lease = os.path.join(d, S.LEASE_DIR)
        os.makedirs(lease)
        with open(os.path.join(lease, "owner.json"), "w") as fh:
            fh.write("{half a record")
        self.assertEqual(self.scan(), ["a"])

    def test_the_lease_is_released_after_the_run(self):
        d = self.session("a", wake_at=900)
        self.scan()
        self.assertFalse(os.path.exists(os.path.join(d, S.LEASE_DIR)))


class TestDrain(Base):
    """--drain: the finite-run mode a single terminal-bench task wants."""

    def test_drains_when_the_last_session_stops_waiting(self):
        self.session("a", wake_at=900)
        ok = S.drain(self.root, interval=0.01, now=self.clock,
                     runner=self.runner, log=lambda m: None)
        self.assertTrue(ok)
        self.assertEqual(len(self.runs), 1)

    def test_gives_up_at_the_deadline_when_a_wait_is_never_due(self):
        self.session("a", wake_at=10**9)  # never due on this clock

        def ticking():
            self.now += 10
            return self.now

        ok = S.drain(self.root, interval=0.0, deadline=25, now=ticking,
                     runner=self.runner, log=lambda m: None)
        self.assertFalse(ok)
        self.assertEqual(self.runs, [])


class TestCrashReplay(Base):
    """The scheduler's own SIGKILL-replay: every decision derives from disk."""

    def test_a_fresh_scheduler_process_reaches_the_same_verdicts(self):
        self.session("due", wake_at=900)
        self.session("undue", wake_at=99999)
        out = subprocess.run(
            [os.sys.executable, "-c",
             "import sys, json; sys.path.insert(0, sys.argv[1]); import scheduler as S; "
             "verdicts = {n: bool(S.wake_reason(sys.argv[2] + '/' + n, now=lambda: 1000.0)) "
             "for n in ('due', 'undue')}; print(json.dumps(verdicts))",
             os.path.dirname(os.path.abspath(__file__)), self.root],
            capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout.strip().splitlines()[-1]),
                         {"due": True, "undue": False})


if __name__ == "__main__":
    unittest.main()
