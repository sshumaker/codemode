"""
The SIGKILL-replay invariant, as a test (docs/CLOUD-HARNESS-DESIGN.md §3.1):

    After `kill -9` of every harness/kernel/job process at any instant, a fresh
    harness reading only the disk must reach a correct state: finished jobs
    report finished, dead jobs report dead-with-evidence (never `running`
    forever), the next turn is constructible, and no action is executed twice.

Everything here uses REAL processes, real SIGKILLs and real fresh JobStores —
no fakes — because the invariant is about what survives on disk when memory is
gone. "A fresh store over the same directory IS a new kernel."

These are the review's P2 findings converted from five patches into one
principle. Each test names the finding it pins.
"""

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import shutil
import unittest

import jobs as J


def wait_until(predicate, timeout=20.0, interval=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


class ChaosBase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="chaos-")
        self.store = J.JobStore(self.dir, cwd=self.dir, emit=lambda m: None)

    def tearDown(self):
        # Kill anything still running so the suite never leaks processes.
        for rec in self.store._all():
            pid = rec.get("pid")
            if pid:
                try:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                except OSError:
                    pass
        shutil.rmtree(self.dir, ignore_errors=True)

    def fresh_kernel(self):
        """A new store over the same directory: files, no memory."""
        return J.JobStore(self.dir, cwd=self.dir, emit=lambda m: None)

    def fresh_process_view(self, name):
        """
        The strongest form: a SEPARATE python process reads the store. Nothing
        held by this process — Popen handles, interned records — can leak in.
        """
        out = subprocess.run(
            [sys.executable, "-c",
             "import sys, json; sys.path.insert(0, sys.argv[1]); import jobs as J; "
             "s = J.JobStore(sys.argv[2], emit=lambda m: None); "
             "r = s._refresh(s._read(sys.argv[3])); "
             "print(json.dumps({k: r.get(k) for k in ('state', 'reason', 'exit_code')}))",
             os.path.dirname(os.path.abspath(__file__)), self.dir, name],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout.strip().splitlines()[-1])

    def sigkill(self, name):
        rec = self.store._read(name)
        os.killpg(os.getpgid(rec["pid"]), signal.SIGKILL)

    def confirm_death_window(self):
        """Death needs two sightings DEATH_CONFIRM_SECONDS apart; wait it out."""
        time.sleep(J.DEATH_CONFIRM_SECONDS + 0.1)


class TestFinishedWorkSurvivesEverything(ChaosBase):
    def test_a_completed_job_is_done_in_a_process_that_never_saw_it(self):
        self.store.submit("echo payload-42", name="quick")
        self.assertTrue(wait_until(lambda: self.store.get("quick").done))
        view = self.fresh_process_view("quick")
        self.assertEqual(view["state"], "done")
        self.assertEqual(view["exit_code"], 0)

    def test_a_failed_job_reports_its_exit_code_after_replay(self):
        self.store.submit("exit 7", name="bad", strict=False)
        self.assertTrue(wait_until(lambda: self.store.get("bad").done))
        view = self.fresh_process_view("bad")
        self.assertEqual(view["state"], "done")
        self.assertEqual(view["exit_code"], 7)


class TestEvictionIsNotForever(ChaosBase):
    """H2: the record said `running` forever after a marker-less death."""

    def test_a_sigkilled_job_is_declared_dead_with_evidence(self):
        self.store.submit("echo started; sleep 300", name="victim", strict=False)
        self.assertTrue(wait_until(
            lambda: (self.store._read("victim") or {}).get("state") == "running"))
        self.sigkill("victim")
        # First sighting stamps, second confirms — the fresh kernel polls.
        kernel = self.fresh_kernel()
        kernel.get("victim").state
        self.confirm_death_window()
        self.assertTrue(wait_until(lambda: kernel.get("victim").state == "died", timeout=10))
        rec = kernel._read("victim")
        self.assertIn("without writing an exit marker", rec["reason"])
        self.assertIn("started", rec["output_tail"], "the log tail is the evidence")
        self.assertTrue(kernel.get("victim").done, "died must be terminal")

    def test_a_transient_misread_does_not_kill_a_live_job(self):
        # The one-way flip needs two confirmed sightings: a probe that lies once
        # (ps under load) must not end a job that is still running.
        flaky = {"n": 0}

        def lying_probe(pid):
            flaky["n"] += 1
            return ("dead", None) if flaky["n"] == 1 else J._real_probe(pid)

        store = J.JobStore(self.dir, cwd=self.dir, emit=lambda m: None, probe=lying_probe)
        store.submit("sleep 300", name="alive", strict=False)
        wait_until(lambda: (store._read("alive") or {}).get("state") == "running")
        store.get("alive").state  # first (lying) sighting stamps dead_seen_at
        self.confirm_death_window()
        self.assertEqual(store.get("alive").state, "running",
                         "a single misread became a permanent death")
        self.assertIsNone(store._read("alive").get("dead_seen_at"),
                          "the live sighting must clear the stamp")


class TestNothingRunsTwice(ChaosBase):
    """The other half of the invariant: replay must not double-execute."""

    def test_an_interrupted_submit_is_refused_on_replay(self):
        # A `starting` record with no process is the crash-between-write-and-spawn
        # window. The fresh kernel must refuse the name, not run the work again.
        rec = {
            "name": "half", "cmd": "expensive", "expect": "once", "pid": None,
            "log": self.store._log_path("half"),
            "exit_marker": os.path.join(self.dir, "half.exit"),
            "pid_file": self.store._pid_path("half"),
            "state": "starting", "reason": None, "started_at": time.time(),
            "max_runtime": None, "lint": [], "events": 0, "silent": False,
            "kind": "job", "meta": {},
        }
        self.store._write(rec)
        kernel = self.fresh_kernel()
        with self.assertRaises(J.JobError) as ctx:
            kernel.submit("expensive", name="half")
        self.assertIn("run the work twice", str(ctx.exception))

    def test_a_done_job_stays_done_it_is_never_respawned(self):
        self.store.submit("echo once >> ran.txt", name="once", strict=False)
        self.assertTrue(wait_until(lambda: self.store.get("once").done))
        # Replay from three fresh kernels; the work must have run exactly once.
        for _ in range(3):
            self.assertEqual(self.fresh_kernel().get("once").state, "done")
        with open(os.path.join(self.dir, "ran.txt")) as fh:
            self.assertEqual(fh.read().count("once"), 1)


class TestKillSignalsOnlyWhatItCanVouchFor(ChaosBase):
    """H3: killpg on a stale pid must never reach a stranger."""

    def test_kill_on_a_reused_pid_does_not_signal_the_stranger(self):
        # A record whose pid now belongs to a DIFFERENT process (start identities
        # differ). kill() must decline to signal and say so.
        decoy = subprocess.Popen(["sleep", "60"], start_new_session=True)
        try:
            self.store.submit("sleep 300", name="stale", strict=False)
            wait_until(lambda: (self.store._read("stale") or {}).get("state") == "running")
            rec = self.store._read("stale")
            original_pid = rec["pid"]
            # Simulate reuse: the record now points at the decoy with the ORIGINAL
            # process's start identity.
            os.killpg(os.getpgid(original_pid), signal.SIGKILL)
            rec["pid"] = decoy.pid
            rec["pid_start"] = "Thu Jan  1 00:00:00 1970"  # not the decoy's
            self.store._write(rec)

            self.store.kill("stale")
            self.assertIsNone(decoy.poll(), "kill() signalled a process it could not vouch for")
            self.assertIn("nothing was signalled", self.store._read("stale")["reason"])
        finally:
            try:
                os.killpg(os.getpgid(decoy.pid), signal.SIGKILL)
            except OSError:
                pass


class TestConfigIsReadAtConstruction(ChaosBase):
    """M6: a host that re-targets HARNESS_JOB_DIR before resuming must win."""

    def test_env_retarget_after_import_is_honoured(self):
        other = tempfile.mkdtemp(prefix="chaos-retarget-")
        saved = os.environ.get("HARNESS_JOB_DIR")
        try:
            os.environ["HARNESS_JOB_DIR"] = other
            self.assertEqual(J.JobStore(emit=lambda m: None).job_dir, other)
        finally:
            if saved is None:
                os.environ.pop("HARNESS_JOB_DIR", None)
            else:
                os.environ["HARNESS_JOB_DIR"] = saved
            shutil.rmtree(other, ignore_errors=True)


class TestBoundedReads(ChaosBase):
    """M2: a verbose job's log must not OOM the kernel at .output."""

    def test_output_is_tail_bounded_and_names_the_full_log(self):
        self.store.submit("yes x | head -c 500000", name="loud", strict=False)
        self.assertTrue(wait_until(lambda: self.store.get("loud").done))
        out = self.store.get("loud").output
        self.assertLess(len(out), 300_000, "output is not bounded")
        self.assertIn("earlier bytes in", out, "the truncation must name the full log")


if __name__ == "__main__":
    unittest.main()
