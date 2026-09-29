"""
The wake sources of a turn that ended in `jobs.wait`.

`jobs.wait` ends the turn (bench/test/wait-ends-turn.test.mjs pins the loop side). A
new turn starts when the host sees one of these, and it opens with a message saying
which:

    a named target finished            condition jobs included: success / failure / timeout
    a named expect="stream" job        printed new output since the wait was armed
    a named agent wrote to its parent
    the wake_after deadline
    a user message                     whether or not the session was waiting

Every request here is produced by the real `JobStore.wait`, against real detached
jobs, and judged by the real `scheduler.reason_for` — the same function an RPC host
calls with the `request` it got on `agent_end` (`scheduler.py --reason-for-request`).
The last class SIGKILLs a real scheduler process mid-wait and shows a fresh one
still fires the condition.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import jobs as J
import scheduler as S
from agent_mailbox import Mailbox

HERE = os.path.dirname(os.path.abspath(__file__))


def wait_until(predicate, timeout=15.0, interval=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class Base(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="wake-")
        self.session = os.path.join(self.root, "s")
        self.jobs_dir = os.path.join(self.session, "jobs")
        os.makedirs(self.jobs_dir)
        self.woken = os.path.join(self.root, "woken.txt")
        with open(os.path.join(self.session, S.SESSION_FILE), "w") as fh:
            # The "harness": append the wake message (the trailing argv) to a file.
            json.dump(
                {
                    "argv": [
                        sys.executable,
                        "-c",
                        "import sys; open(sys.argv[1], 'a').write(sys.argv[-1] + '\\n---\\n')",
                        self.woken,
                    ],
                    "cwd": self.session,
                    "env": {"HARNESS_JOB_DIR": self.jobs_dir},
                },
                fh,
            )
        self.store = J.JobStore(self.jobs_dir, emit=lambda m: None, min_wait=1)
        self.env = mock.patch.dict(
            os.environ, {"HARNESS_WAKE_FILE": os.path.join(self.session, S.WAKE_FILE), "HARNESS_WAIT_MODE": ""}
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()
        for rec in self.store.list():
            if rec.get("state") in J.LIVE_STATES:
                self.store.kill(rec["name"])
        shutil.rmtree(self.root, ignore_errors=True)

    def wait(self, *names, wake_after=600, mode=None):
        """The agent's jobs.wait: returns the request it raised with."""
        with self.assertRaises(J.WaitSignal) as ctx:
            self.store.wait(*names, wake_after=wake_after, mode=mode)
        return ctx.exception

    def reason(self, now=time.time):
        return S.wake_reason(self.session, now)

    def woken_messages(self):
        try:
            with open(self.woken) as fh:
                return [m.strip() for m in fh.read().split("\n---\n") if m.strip()]
        except OSError:
            return []


class TestTheRequest(Base):
    def test_the_signal_carries_the_request_the_wake_file_holds(self):
        self.store.submit("sleep 30", name="build", strict=False)
        sig = self.wait("build", wake_after=120)
        self.assertEqual(sig.args[0], 120, "args[0] stays the clamped seconds")
        with open(os.path.join(self.session, S.WAKE_FILE)) as fh:
            self.assertEqual(json.load(fh), sig.request)
        req = sig.request
        self.assertEqual(req["targets"], ["build"])
        self.assertEqual(req["watch"], ["build"])
        self.assertEqual(req["mode"], "all")
        self.assertEqual(req["wake_after"], 120)
        self.assertEqual(req["job_dir"], self.jobs_dir)
        self.assertAlmostEqual(req["wake_at"] - req["armed_at"], 120, places=3)

    def test_a_bare_wait_names_nothing_and_watches_what_is_live(self):
        self.store.submit("sleep 30", name="a", strict=False)
        req = self.wait(wake_after=60).request
        self.assertEqual(req["targets"], [])
        self.assertEqual(req["watch"], ["a"])
        self.assertNotIn("mode", req)


class TestConditionJobsExiting(Base):
    """A monitor is a condition job: `until <cond>; do sleep N; done`, expect='once'."""

    def test_the_condition_firing_wakes_it_as_a_success(self):
        flag = os.path.join(self.root, "ready")
        self.store.submit(f"until test -f {flag}; do sleep 0.1; done", name="ready", expect="once")
        self.wait("ready")
        self.assertIsNone(self.reason(), "not due before the condition holds")
        open(flag, "w").close()
        self.assertTrue(wait_until(lambda: self.reason() is not None))
        self.assertEqual(self.reason(), "job 'ready' finished: succeeded (exit 0)")

    def test_a_condition_that_fails_says_so(self):
        self.store.submit("test -f /definitely/not/here", name="probe", expect="once")
        self.wait("probe")
        self.assertTrue(wait_until(lambda: self.reason() is not None))
        self.assertEqual(self.reason(), "job 'probe' finished: failed (exit 1)")

    def test_a_condition_that_never_fires_times_out_and_says_so(self):
        self.store.submit("until false; do sleep 0.2; done", name="never", expect="once", max_runtime=1, strict=False)
        self.wait("never")
        self.assertTrue(wait_until(lambda: self.reason() is not None, timeout=10))
        self.assertTrue(self.reason().startswith("job 'never' finished: timed out"), self.reason())


class TestStreamingJobs(Base):
    """expect='stream' never exits: the wake is its first new output after the wait."""

    def test_only_output_after_the_wait_counts_and_it_is_in_the_message(self):
        go = os.path.join(self.root, "go")
        self.store.submit(
            f"echo old-line; until test -f {go}; do sleep 0.1; done; while true; do echo new-line; sleep 0.2; done",
            name="feed",
            expect="stream",
            strict=False,
        )
        log = self.store._read("feed")["log"]
        self.assertTrue(wait_until(lambda: os.path.exists(log) and "old-line" in open(log).read()))
        req = self.wait("feed").request
        self.assertIn("feed", req["streams"])
        self.assertIsNone(self.reason(), "output from before the wait does not wake it")
        open(go, "w").close()
        self.assertTrue(wait_until(lambda: self.reason() is not None))
        reason = self.reason()
        self.assertTrue(reason.startswith("job 'feed' printed new output since you waited:"), reason)
        self.assertIn("new-line", reason)
        self.assertNotIn("old-line", reason)

    def test_all_mode_needs_the_stream_to_speak_and_the_job_to_finish(self):
        go = os.path.join(self.root, "go")
        self.store.submit(
            f"until test -f {go}; do sleep 0.1; done; while true; do echo up; sleep 0.2; done",
            name="server",
            expect="stream",
            strict=False,
        )
        self.store.submit(
            f"until test -f {go}; do sleep 0.1; done; sleep 0.5", name="migrate", expect="once", strict=False
        )
        self.wait("server", "migrate", mode="all")
        self.assertIsNone(self.reason())
        open(go, "w").close()
        self.assertTrue(wait_until(lambda: self.reason() is not None))
        reason = self.reason()
        self.assertTrue(reason.startswith("all finished: server (new output), migrate (succeeded (exit 0))"), reason)
        self.assertIn("up", reason)


class TestAgentsAndDeadlines(Base):
    def test_a_named_agent_writing_to_its_parent_wakes_it(self):
        box = os.path.join(self.root, "child.d")
        os.makedirs(box)
        request = {
            "watch": ["child"],
            "targets": ["child"],
            "mode": "all",
            "wake_at": time.time() + 600,
            "wake_after": 600,
            "armed_at": time.time(),
            "mailboxes": {"child": box},
            "job_dir": self.jobs_dir,
        }
        self.assertIsNone(S.reason_for(request))
        Mailbox(box).ask("which region?")
        self.assertEqual(S.reason_for(request), "agent 'child' sent you a message: asks: which region?")

    def test_the_deadline_is_the_backstop(self):
        self.store.submit("sleep 30", name="slow", strict=False)
        req = self.wait("slow", wake_after=60).request
        self.assertIsNone(self.reason(now=lambda: req["armed_at"] + 59))
        self.assertEqual(self.reason(now=lambda: req["armed_at"] + 60), "the requested wait of 60s elapsed")


class TestUserMessages(Base):
    def test_a_user_message_wakes_a_waiting_session_and_is_delivered(self):
        self.store.submit("sleep 30", name="build", strict=False)
        self.wait("build")
        self.assertIsNone(self.reason())
        S.post_user_message(self.session, "actually, deploy to staging")
        self.assertEqual(self.reason(), "1 new message from user")
        self.assertEqual(S.scan_once(self.root, log=lambda m: None), ["s"])
        [message] = self.woken_messages()
        self.assertTrue(message.startswith("[woken: 1 new message from user]"), message)
        self.assertIn("pending jobs.wait was cancelled", message)
        self.assertIn("actually, deploy to staging", message)
        self.assertIsNone(self.reason(), "a delivered message never re-fires")
        self.assertEqual(S.pending_user_messages(self.session), [])
        box = os.path.join(self.session, S.INBOX_DIR)
        self.assertTrue(any(n.endswith(".delivered") for n in os.listdir(box)), "kept as evidence")

    def test_a_user_message_wakes_a_session_that_was_not_waiting(self):
        S.post_user_message(self.session, "one more thing", sender="scott")
        self.assertEqual(S.scan_once(self.root, log=lambda m: None), ["s"])
        [message] = self.woken_messages()
        self.assertTrue(message.startswith("[woken: 1 new message from scott]"), message)
        self.assertNotIn("cancelled", message)

    def test_drain_counts_an_undelivered_message_as_work_left(self):
        S.post_user_message(self.session, "hello")
        self.assertTrue(S.drain(self.root, interval=0.01, deadline=5, log=lambda m: None))
        self.assertEqual(len(self.woken_messages()), 1)


class TestReasonForRequestCli(Base):
    """What an RPC host runs with the `request` from `agent_end`."""

    def ask(self, request, *flags):
        out = subprocess.run(
            [sys.executable, os.path.join(HERE, "scheduler.py"), "--reason-for-request", *flags],
            input=json.dumps(request),
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout)

    def test_null_until_due_then_the_reason_and_the_message(self):
        flag = os.path.join(self.root, "ready")
        self.store.submit(f"until test -f {flag}; do sleep 0.1; done", name="ready", expect="once")
        req = self.wait("ready").request
        self.assertEqual(self.ask(req), {"reason": None, "message": None})
        open(flag, "w").close()
        self.assertTrue(wait_until(lambda: self.ask(req)["reason"] is not None))
        got = self.ask(req)
        self.assertEqual(got["reason"], "job 'ready' finished: succeeded (exit 0)")
        self.assertEqual(
            got["message"], "[woken: job 'ready' finished: succeeded (exit 0)] Check your jobs and continue the task."
        )

    def test_consume_marks_a_waking_message_read(self):
        box = os.path.join(self.root, "child.d")
        os.makedirs(box)
        Mailbox(box).report("done early")
        req = {
            "watch": ["child"],
            "mode": "all",
            "wake_at": time.time() + 600,
            "wake_after": 600,
            "mailboxes": {"child": box},
            "job_dir": self.jobs_dir,
        }
        self.assertIsNotNone(self.ask(req)["reason"])
        self.assertIsNotNone(self.ask(req, "--consume")["reason"])
        self.assertIsNone(self.ask(req)["reason"], "consumed: the same message does not wake it twice")


class TestSchedulerKilledMidWait(Base):
    """
    Monitor durability: the condition job and the wait are files, so a scheduler
    SIGKILLed while the session waits loses nothing — a fresh one fires the wake.
    """

    def test_a_fresh_scheduler_fires_a_condition_that_came_true_while_none_was_running(self):
        flag = os.path.join(self.root, "ready")
        self.store.submit(f"until test -f {flag}; do sleep 0.1; done", name="ready", expect="once")
        self.wait("ready")
        first = subprocess.Popen(
            [sys.executable, os.path.join(HERE, "scheduler.py"), self.root, "--interval", "0.1"],
            cwd=HERE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            time.sleep(0.8)  # several scans with nothing due
            self.assertIsNone(first.poll(), "the scheduler died on its own")
            os.killpg(first.pid, signal.SIGKILL)
            first.wait(timeout=10)
        finally:
            if first.poll() is None:
                os.killpg(first.pid, signal.SIGKILL)
        self.assertEqual(self.woken_messages(), [], "nothing fired before the condition held")
        self.assertTrue(os.path.exists(os.path.join(self.session, S.WAKE_FILE)), "the wait survived the kill")
        open(flag, "w").close()
        self.assertTrue(wait_until(lambda: self.store.get("ready").done), "the condition job outlived the scheduler")
        second = subprocess.run(
            [
                sys.executable,
                os.path.join(HERE, "scheduler.py"),
                self.root,
                "--drain",
                "--interval",
                "0.1",
                "--deadline",
                "20",
            ],
            cwd=HERE,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(
            self.woken_messages(),
            ["[woken: job 'ready' finished: succeeded (exit 0)] Check your jobs and continue the task."],
        )


if __name__ == "__main__":
    unittest.main()
