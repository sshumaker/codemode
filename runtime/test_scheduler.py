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


def dead_identity():
    """A {pid, pid_start} that provably names no live process: started, reaped."""
    proc = subprocess.Popen(["true"])
    proc.wait()
    return {"pid": proc.pid, "pid_start": "Thu Jan  1 00:00:00 1970"}


class Crash(BaseException):
    """The scheduler dying mid-run: nothing after the runner executes."""


class TurnBase(Base):
    def setUp(self):
        super().setUp()
        self.logs = []

    def scan(self, runner=None):
        return S.scan_once(self.root, now=self.clock, runner=runner or self.runner,
                           log=self.logs.append)

    def session(self, name, **kw):
        d = super().session(name, **kw)
        self.transcripts = os.path.join(self.root, f"{name}.transcripts")
        os.makedirs(self.transcripts, exist_ok=True)
        with open(os.path.join(d, S.SESSION_FILE)) as fh:
            spec = json.load(fh)
        spec["transcript_dir"] = self.transcripts
        with open(os.path.join(d, S.SESSION_FILE), "w") as fh:
            json.dump(spec, fh)
        return d

    def crashing_runner(self, *, child=None, transcript=False, waited=False):
        """
        A run that gets as far as a live harness, then its scheduler dies. The
        harness is recorded (dead by the time anyone looks), optionally after
        writing its opening message to the transcript or waiting again.
        """

        def run(argv, cwd=None, env=None):
            self.runs.append({"argv": argv, "env": env})
            turn_path, run_id = argv[3], argv[4]
            S._update_turn(turn_path, run_id, state="running", child=child or dead_identity(),
                           supervisor=dead_identity())
            if transcript:
                with open(os.path.join(self.transcripts, "s.jsonl"), "a") as fh:
                    fh.write(json.dumps({"role": "user", "content": argv[-1]}) + "\n")
            if waited:
                with open(env["HARNESS_WAKE_FILE"], "w") as fh:
                    json.dump({"wake_at": self.now + 500, "watch": []}, fh)
            raise Crash()

        return run

    def crash(self, **kw):
        with self.assertRaises(Crash):
            self.scan(self.crashing_runner(**kw))

    def inbox(self, d):
        return sorted(os.listdir(os.path.join(d, S.INBOX_DIR)))


class TestTheLeaseCoversTheAgent(TurnBase):
    """Fix: a dead scheduler's lease is not stale while the agent it started runs."""

    def stage_orphan(self, d, child):
        lease = os.path.join(d, S.LEASE_DIR)
        os.makedirs(lease)
        with open(os.path.join(lease, "owner.json"), "w") as fh:
            json.dump(dead_identity(), fh)
        wake = os.path.join(d, S.WAKE_FILE)
        os.replace(wake, wake + ".fired")  # as the dead scheduler's phase one left it
        S._write_json(os.path.join(d, S.TURN_FILE), {
            "run_id": "r1", "state": "running", "reason": "x", "started_at": self.now, "wake_fired": True,
            "messages": [], "child": child, "supervisor": dead_identity()})

    def test_a_live_child_keeps_a_dead_schedulers_lease(self):
        d = self.session("a", wake_at=900)
        self.stage_orphan(d, S._self_identity())  # this process stands in for prime
        self.assertEqual(self.scan(), [])
        self.assertEqual(self.runs, [], "a second harness started beside a live one")
        self.assertTrue(os.path.isdir(os.path.join(d, S.LEASE_DIR)), "the lease was reclaimed")
        self.assertTrue(any("still running" in m for m in self.logs), self.logs)

    def test_a_released_lease_does_not_free_a_session_whose_child_lives(self):
        d = self.session("a", wake_at=900)
        self.stage_orphan(d, S._self_identity())
        S.release_lease(os.path.join(d, S.LEASE_DIR))
        self.assertIsNone(S.acquire_lease(d))
        self.assertFalse(os.path.exists(os.path.join(d, S.LEASE_DIR)), "a refused lease must not linger")

    def test_a_reused_child_pid_does_not_hold_the_lease(self):
        d = self.session("a", wake_at=900)
        stranger = dict(S._self_identity(), pid_start="Thu Jan  1 00:00:00 1970")
        self.stage_orphan(d, stranger)
        self.assertEqual(self.scan(), ["a"])

    def test_a_recorded_live_supervisor_holds_the_lease(self):
        d = self.session("a", wake_at=900)
        self.stage_orphan(d, dead_identity())
        with open(os.path.join(d, S.LEASE_DIR, "supervisor.json"), "w") as fh:
            json.dump(S._self_identity(), fh)
        os.remove(os.path.join(d, S.TURN_FILE))
        self.assertEqual(self.scan(), [])

    def test_when_scheduler_and_child_are_both_gone_it_is_reclaimed(self):
        d = self.session("a", wake_at=900)
        self.stage_orphan(d, dead_identity())
        self.assertEqual(self.scan(), ["a"])
        self.assertIn("interrupted", self.runs[0]["argv"][-1])


class TestTwoPhaseDelivery(TurnBase):
    def test_messages_are_in_flight_during_the_run_and_delivered_after(self):
        d = self.session("a", wake_at=900)
        S.post_user_message(d, "hello")
        seen = {}

        def runner(argv, cwd=None, env=None):
            seen["inbox"] = self.inbox(d)
            with open(os.path.join(d, S.TURN_FILE)) as fh:
                seen["turn"] = json.load(fh)
            seen["fired"] = os.path.exists(os.path.join(d, "wake.json.fired"))
            return subprocess.CompletedProcess(argv, 3)

        self.assertEqual(self.scan(runner), ["a"])
        self.assertTrue(seen["inbox"][0].endswith(".json.delivering"), seen)
        self.assertEqual(seen["turn"]["state"], "starting")
        self.assertTrue(seen["turn"]["wake_fired"])
        self.assertTrue(seen["fired"])
        self.assertTrue(self.inbox(d)[0].endswith(".json.delivered"))
        self.assertFalse(os.path.exists(os.path.join(d, S.TURN_FILE)))
        with open(os.path.join(d, S.TURN_FILE + ".last")) as fh:
            last = json.load(fh)
        self.assertEqual((last["state"], last["returncode"]), ("done", 3), "any exit is a finished turn")

    def test_the_run_goes_through_the_supervisor(self):
        self.session("a", wake_at=900)
        self.scan()
        argv = self.runs[0]["argv"]
        self.assertEqual(argv[2], "--supervise-turn")
        self.assertEqual(argv[5], "--")
        self.assertEqual(argv[6:-1], ["harness", "--resume", "a.jsonl", "-p"])

    def test_every_message_has_an_id_and_the_opening_message_carries_it(self):
        d = self.session("a")
        S.post_user_message(d, "one")
        [msg] = S.pending_user_messages(d)
        self.assertTrue(msg["id"].startswith("u-"))
        self.scan()
        self.assertIn(f"[message ids: {msg['id']}]", self.runs[0]["argv"][-1])

    def test_a_message_queued_without_an_id_gets_its_file_name(self):
        d = self.session("a")
        box = os.path.join(d, S.INBOX_DIR)
        os.makedirs(box)
        with open(os.path.join(box, "1.5-legacy.json"), "w") as fh:
            json.dump({"from": "user", "text": "old"}, fh)
        [msg] = S.pending_user_messages(d)
        self.assertEqual(msg["id"], "1.5-legacy")


class TestCrashRecovery(TurnBase):
    def test_a_lost_message_is_delivered_again_with_the_interruption(self):
        d = self.session("a")
        S.post_user_message(d, "please deploy")
        self.crash()
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(self.scan(), ["a"])
        second = self.runs[1]["argv"][-1]
        self.assertIn("interrupted (crash)", second)
        self.assertIn("please deploy", second, "the message the crash swallowed was lost")
        self.assertTrue(self.inbox(d)[0].endswith(".json.delivered"))
        self.assertEqual(self.scan(), [], "recovered exactly once")
        with open(os.path.join(d, S.TURN_FILE + ".last")) as fh:
            self.assertEqual(json.load(fh)["state"], "done")

    def test_a_message_the_transcript_has_is_not_injected_twice(self):
        d = self.session("a")
        S.post_user_message(d, "please deploy")
        self.crash(transcript=True)
        self.assertEqual(self.scan(), ["a"])
        second = self.runs[1]["argv"][-1]
        self.assertIn("interrupted (crash)", second)
        self.assertIn("1 new message from user", self.runs[0]["argv"][-1])
        self.assertNotIn("please deploy", second, "the resumed transcript already holds it")
        self.assertIn("Check your jobs and continue", second)
        self.assertTrue(self.inbox(d)[0].endswith(".json.delivered"))

    def test_the_interrupted_wake_names_what_the_crashed_turn_was_for(self):
        self.session("a", wake_at=900)
        self.crash()
        self.scan()
        self.assertIn("it was woken for: the requested wait of 60s elapsed", self.runs[1]["argv"][-1])

    def test_a_crashed_recovery_still_names_the_original_wake(self):
        self.session("a", wake_at=900)
        self.crash()
        self.crash()
        self.scan()
        msg = self.runs[2]["argv"][-1]
        self.assertIn("it was woken for: the requested wait of 60s elapsed", msg)
        self.assertEqual(msg.count("interrupted"), 1, msg)

    def test_a_turn_that_died_after_waiting_again_is_not_rewoken_early(self):
        d = self.session("a", wake_at=900)
        self.crash(waited=True)
        self.assertEqual(self.scan(), [], "the new wait is not due; the crash cost nothing")
        with open(os.path.join(d, S.TURN_FILE + ".last")) as fh:
            self.assertEqual(json.load(fh)["state"], "ended-in-wait")
        self.now += 600
        self.assertEqual(self.scan(), ["a"])
        self.assertNotIn("interrupted", self.runs[1]["argv"][-1])

    def test_a_run_that_never_started_a_harness_fires_its_original_wake(self):
        d = self.session("a", wake_at=900)
        S.post_user_message(d, "hi")

        def dies_before_spawning(argv, cwd=None, env=None):
            raise Crash()

        with self.assertRaises(Crash):
            self.scan(dies_before_spawning)
        self.assertTrue(os.path.exists(os.path.join(d, "wake.json.fired")))
        self.assertEqual(self.scan(), ["a"])
        msg = self.runs[0]["argv"][-1]
        self.assertNotIn("interrupted", msg, "nothing ran, so nothing was interrupted")
        self.assertIn("hi", msg)
        self.assertIn("cancelled", msg, "the restored wait is cancelled by the message as before")

    def test_an_exited_turn_whose_scheduler_died_is_just_finished(self):
        d = self.session("a")
        S.post_user_message(d, "hi")

        def exits_then_scheduler_dies(argv, cwd=None, env=None):
            S._update_turn(argv[3], argv[4], state="exited", exit_code=0, supervisor=dead_identity())
            raise Crash()

        with self.assertRaises(Crash):
            self.scan(exits_then_scheduler_dies)
        self.assertEqual(self.scan(), [], "a turn that returned is not a crash")
        self.assertTrue(self.inbox(d)[0].endswith(".json.delivered"))
        with open(os.path.join(d, S.TURN_FILE + ".last")) as fh:
            last = json.load(fh)
        self.assertEqual((last["state"], last["exit_code"], last["settled_by"]), ("done", 0, "recovery"))

    def test_a_crash_loop_stops_after_the_bound_and_leaves_evidence(self):
        d = self.session("a")
        S.post_user_message(d, "never lands")
        for _ in range(S.MAX_CRASH_RECOVERIES + 1):
            self.crash()
        self.assertEqual(len(self.runs), S.MAX_CRASH_RECOVERIES + 1)
        self.assertEqual(self.scan(), [], "a crash-looping turn was re-woken past the bound")
        self.assertFalse(os.path.exists(os.path.join(d, S.TURN_FILE)))
        with open(os.path.join(d, S.TURN_FILE + ".abandoned")) as fh:
            self.assertEqual(json.load(fh)["state"], "abandoned")
        self.assertTrue(self.inbox(d)[0].endswith(".json.undelivered"))
        self.assertTrue(any("not re-waking" in m for m in self.logs), self.logs)
        # A new message is a new conversation: it wakes the session, counter reset.
        S.post_user_message(d, "try again")
        self.assertEqual(self.scan(), ["a"])

    def test_a_clean_turn_resets_the_crash_count(self):
        self.session("a", wake_at=900)
        self.crash()
        self.assertEqual(self.scan(), ["a"])  # the recovery run returns cleanly
        self.now += 1
        with open(os.path.join(self.root, "a", S.WAKE_FILE), "w") as fh:
            json.dump({"wake_at": 0}, fh)
        self.crash()
        self.scan()
        with open(os.path.join(self.root, "a", S.TURN_FILE + ".last")) as fh:
            self.assertEqual(json.load(fh)["recoveries"], 1)

    def test_drain_waits_on_a_turn_that_has_not_been_settled(self):
        d = self.session("a")
        S.post_user_message(d, "hi")
        self.crash()
        ok = S.drain(self.root, interval=0.01, deadline=5, now=self.clock,
                     runner=self.runner, log=lambda m: None)
        self.assertTrue(ok)
        self.assertIn("interrupted", self.runs[-1]["argv"][-1])


class TestSpawnFailures(TurnBase):
    """A harness that cannot even be started is retried a bounded number of times, loudly."""

    def broken(self, argv, cwd=None, env=None):
        self.runs.append({"argv": argv})
        raise FileNotFoundError(2, "No such file or directory", "harness")

    def test_a_failed_spawn_puts_the_wake_and_message_back_and_says_why(self):
        d = self.session("a", wake_at=900)
        S.post_user_message(d, "hi")
        self.assertEqual(self.scan(self.broken), [])
        self.assertTrue(os.path.exists(os.path.join(d, S.WAKE_FILE)), "the wake was lost")
        self.assertTrue(self.inbox(d)[0].endswith(".json"), self.inbox(d))
        self.assertTrue(any("failed to start (attempt 1/3)" in m and "No such file" in m
                            for m in self.logs), self.logs)
        self.assertEqual(self.scan(), ["a"], "a later healthy spawn delivers both")
        self.assertIn("hi", self.runs[-1]["argv"][-1])
        self.assertFalse(os.path.exists(os.path.join(d, S.TURN_FILE)), "a clean run resets the count")

    def test_repeated_spawn_failures_stop_after_the_bound_with_evidence(self):
        d = self.session("a", wake_at=900)
        S.post_user_message(d, "never lands")
        for _ in range(S.MAX_SPAWN_FAILURES + 2):
            self.scan(self.broken)
        self.assertEqual(len(self.runs), S.MAX_SPAWN_FAILURES, "retried past the bound")
        self.assertFalse(os.path.exists(os.path.join(d, S.TURN_FILE)))
        with open(os.path.join(d, S.TURN_FILE + ".abandoned")) as fh:
            ev = json.load(fh)
        self.assertEqual((ev["state"], ev["spawn_failures"]), ("abandoned", S.MAX_SPAWN_FAILURES))
        self.assertIn("No such file", ev["last_error"])
        self.assertTrue(self.inbox(d)[0].endswith(".json.undelivered"), self.inbox(d))
        self.assertTrue(any("NOT retrying" in m for m in self.logs), self.logs)
        S.post_user_message(d, "try again")
        self.assertEqual(self.scan(), ["a"], "a new message starts over")

    def test_a_crash_owed_a_rewake_keeps_it_across_a_failed_spawn(self):
        self.session("a", wake_at=900)
        self.crash()
        self.scan(self.broken)
        self.assertEqual(self.scan(), ["a"])
        self.assertIn("interrupted (crash)", self.runs[-1]["argv"][-1])


class TestTranscriptLocation(unittest.TestCase):
    def test_prime_precedence(self):
        argv = ["prime", "-c", "--session-dir", "/x"]
        self.assertEqual(S._transcript_dirs({"argv": argv}, {"PRIME_AGENT_SESSION_DIR": "/y"}), ["/x"])
        self.assertEqual(S._transcript_dirs({"argv": []}, {"PRIME_AGENT_SESSION_DIR": "/y"}), ["/y"])
        self.assertEqual(S._transcript_dirs({"argv": []}, {"PRIME_AGENT_CODING_AGENT_SESSION_DIR": "/l"}), ["/l"])
        self.assertEqual(S._transcript_dirs({"argv": []}, {"PRIME_AGENT_CODING_AGENT_DIR": "/a"}), ["/a/sessions"])
        self.assertEqual(S._transcript_dirs({"argv": []}, {"HOME": "/h"}), ["/h/.prime/agent/sessions"])
        self.assertEqual(S._transcript_dirs({"argv": argv, "transcript_dir": "/t"}, {}), ["/t"])


if __name__ == "__main__":
    unittest.main()
