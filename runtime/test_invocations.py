"""
The invocation store and the owed-items rule (docs/TOOL-INVOCATIONS.md), without
real processes: records, delivery modes, the job projection, the call-log fold, and
how the scheduler decides and delivers. The SIGKILL forms are in test_chaos.py.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import invocations as I
import jobs as J
import scheduler as S

HERE = os.path.dirname(os.path.abspath(__file__))


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="inv-")
        self.clock = Clock()
        self.store = I.InvocationStore(self.dir, now=self.clock, pid_alive=lambda pid: False)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class TestRecords(Base):
    def test_create_is_idempotent_and_ids_survive_odd_characters(self):
        a = self.store.create("call:msg/1:1", kind="call", name="pay.charge")
        b = self.store.create("call:msg/1:1", kind="call", name="something else")
        self.assertEqual(a, b)
        self.assertEqual(self.store.get("call:msg/1:1")["name"], "pay.charge")
        self.assertEqual([r["id"] for r in self.store.all()], ["call:msg/1:1"])

    def test_a_terminal_state_is_final(self):
        self.store.create("x", kind="call", name="t", state=I.RUNNING)
        self.store.transition("x", I.SUCCEEDED, {"summary": "ok"})
        self.store.transition("x", I.FAILED, {"summary": "late"})
        rec = self.store.get("x")
        self.assertEqual((rec["state"], rec["outcome"]["summary"]), ("succeeded", "ok"))

    def test_owed_means_terminal_and_undelivered(self):
        self.store.create("run", kind="job", name="r", state=I.RUNNING)
        self.store.create("done", kind="job", name="d", state=I.RUNNING)
        self.store.transition("done", I.SUCCEEDED)
        self.assertEqual([r["id"] for r in self.store.owed()], ["done"])
        self.store.mark_delivered(["done"], by="read")
        self.assertEqual(self.store.owed(), [])

    def test_two_phase_delivery_commits_or_rolls_back(self):
        for i in ("a", "b"):
            self.store.create(i, kind="job", name=i, state=I.RUNNING)
            self.store.transition(i, I.FAILED)
        self.assertEqual(self.store.begin_delivery(["a", "b"], "run1"), ["a", "b"])
        self.assertEqual(self.store.owed(), [], "items in flight do not wake again")
        self.assertEqual(len(self.store.owed(include_delivering=True)), 2)
        self.assertEqual(self.store.rollback_delivery("run1"), ["a", "b"])
        self.assertEqual(len(self.store.owed()), 2)
        self.store.begin_delivery(["a"], "run2")
        self.assertEqual(self.store.commit_delivery("run2"), ["a"])
        self.assertEqual([r["id"] for r in self.store.owed()], ["b"])
        self.assertEqual(self.store.get("a")["redelivered"], 1)

    def test_blocking_is_recomputed_per_choice(self):
        for i in ("a", "b", "c"):
            self.store.create(i, kind="job", name=i)
        self.store.set_blocking(["a", "b"])
        self.assertEqual([r["blocking"] for r in self.store.all()], [True, True, False])
        self.store.set_blocking(["c"])
        self.assertEqual([r["blocking"] for r in self.store.all()], [False, False, True])

    def test_a_deadline_expires_non_job_work(self):
        self.store.create("ask", kind="approval", name="deploy?", deadline=1010.0)
        self.store.create("job", kind="job", name="j", backend="local_job", deadline=1010.0)
        self.clock.t = 1011
        self.assertEqual(self.store.expire_due(), ["ask"])
        self.assertEqual(self.store.get("ask")["state"], "expired")
        self.assertEqual(self.store.get("job")["state"], "pending", "a job's own max_runtime binds it")

    def test_delivery_table(self):
        table = {"pay.charge": "at_most_once", "web.*": "read_only", "pay.refund": "lookup"}
        self.assertEqual(I.delivery_for("web.search", table), "read_only")
        self.assertEqual(I.delivery_for("pay.refund", table), "lookup")
        self.assertEqual(I.delivery_for("mystery.tool", table), "at_most_once", "undeclared is never resent")


class TestInlineDeliveryModes(Base):
    def sender(self, *outcomes):
        sent = []
        queue = list(outcomes)

        def send(key):
            sent.append(key)
            item = queue.pop(0)
            if isinstance(item, BaseException):
                raise item
            return item

        return send, sent

    def test_at_most_once_claims_before_sending_and_never_resends_an_unknown(self):
        send, sent = self.sender(TimeoutError("read timed out"))
        with self.assertRaises(I.UnknownOutcome) as ctx:
            I.call_inline(self.store, "c1", "pay.charge", send, delivery=I.AT_MOST_ONCE)
        self.assertIn("verify before retrying", str(ctx.exception))
        again, sent2 = self.sender({"ok": 1})
        with self.assertRaises(I.UnknownOutcome):
            I.call_inline(self.store, "c1", "pay.charge", again, delivery=I.AT_MOST_ONCE)
        self.assertEqual((len(sent), len(sent2)), (1, 0))

    def test_a_connection_refused_was_never_sent_and_is_retried_in_every_mode(self):
        send, sent = self.sender(ConnectionRefusedError(), "charged")
        self.assertEqual(I.call_inline(self.store, "c1", "pay.charge", send), "charged")
        self.assertEqual(len(sent), 2)
        self.assertEqual(self.store.get("c1")["attempts"], 2)

    def test_idempotent_resends_with_the_same_key(self):
        send, sent = self.sender(TimeoutError(), "done")
        self.assertEqual(I.call_inline(self.store, "c1", "q.put", send, delivery=I.IDEMPOTENT), "done")
        self.assertEqual(sent, ["c1", "c1"])

    def test_lookup_asks_before_resending(self):
        send, sent = self.sender(TimeoutError())
        found = []
        answer = I.call_inline(
            self.store,
            "c1",
            "pay.refund",
            send,
            delivery=I.LOOKUP,
            lookup=lambda key: found.append(key) or {"refund": "r1"},
        )
        self.assertEqual((answer, sent, found), ({"refund": "r1"}, ["c1"], ["c1"]))

    def test_a_settled_call_replays_its_outcome_instead_of_resending(self):
        send, sent = self.sender("first")
        I.call_inline(self.store, "c1", "web.search", send, delivery=I.READ_ONLY)
        again, sent2 = self.sender("second")
        self.assertEqual(I.call_inline(self.store, "c1", "web.search", again, delivery=I.READ_ONLY), "first")
        self.assertEqual(sent2, [])

    def test_an_error_answer_is_failed_not_unknown(self):
        send, _ = self.sender(I.ToolFailed("card declined"))
        with self.assertRaises(I.ToolFailed):
            I.call_inline(self.store, "c1", "pay.charge", send)
        self.assertEqual(self.store.get("c1")["state"], "failed")
        self.assertEqual(self.store.owed(), [], "the caller saw the error")

    def test_at_least_once_acts_before_recording(self):
        def send(key):
            self.assertIsNone(self.store.get(key), "at_least_once must act first")
            return "ok"

        I.call_inline(self.store, "c1", "log.append", send, delivery=I.AT_LEAST_ONCE)
        self.assertEqual(self.store.get("c1")["state"], "succeeded")


class TestCallLogFold(Base):
    def write_log(self, *events, torn=""):
        os.makedirs(self.store.dir, exist_ok=True)
        with open(os.path.join(self.store.dir, I.CALL_LOG), "w") as fh:
            for ev in events:
                fh.write(json.dumps(ev) + "\n")
            fh.write(torn)

    def test_settled_calls_are_delivered_and_a_dead_writers_open_claim_is_unknown(self):
        self.write_log(
            {"k": "open", "pid": 4242},
            {"k": "call", "n": 1, "msg": "m", "name": "a.read", "id": "call:m:1", "delivery": "read_only"},
            {"k": "end", "n": 1, "outcome": "completed", "summary": "ok"},
            {"k": "call", "n": 2, "msg": "m", "name": "pay.charge", "id": "call:m:2", "delivery": "at_most_once"},
            torn='{"k": "call", "n": 3, "ms',
        )
        self.store.fold_call_log()
        recs = {r["id"]: r for r in self.store.all()}
        self.assertEqual(set(recs), {"call:m:1", "call:m:2"}, "a torn line was never sent")
        self.assertEqual((recs["call:m:1"]["state"], bool(recs["call:m:1"]["delivered_at"])), ("succeeded", True))
        self.assertEqual(recs["call:m:2"]["state"], "unknown")
        self.assertEqual([r["id"] for r in self.store.owed()], ["call:m:2"])
        self.assertIn("call pay.charge (call:m:2): UNKNOWN", I.describe(recs["call:m:2"]))

    def test_a_live_writers_open_claim_is_still_running(self):
        live = I.InvocationStore(self.dir, now=self.clock, pid_alive=lambda pid: True)
        self.write_log({"k": "open", "pid": 1}, {"k": "call", "n": 1, "msg": "m", "name": "x.y"})
        live.fold_call_log()
        self.assertEqual(live.get("call:m:1")["state"], "running", "old journals without ids derive (msg, n)")

    def test_a_reported_cell_delivers_its_unknowns(self):
        self.write_log(
            {"k": "open", "pid": 4242},
            {"k": "call", "n": 1, "msg": "m", "name": "x.y", "id": "call:m:1"},
            {"k": "reported", "msg": "m", "at": 5},
        )
        self.store.fold_call_log()
        rec = self.store.get("call:m:1")
        self.assertEqual((rec["state"], rec["delivered_by"]), ("unknown", "dead-cell report"))


class JobBase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="inv-jobs-")
        self.t = [1000.0]
        self.alive = set()
        self.spawned = []

        def spawn(wrapped, log, cwd):
            pid = 50000 + len(self.spawned)
            self.spawned.append(pid)
            self.alive.add(pid)
            return pid

        self.jobs = J.JobStore(
            self.dir,
            now=lambda: self.t[0],
            spawn=spawn,
            kill=lambda pid: None,
            probe=lambda pid: ("alive" if pid in self.alive else "dead", "start"),
            emit=lambda m: None,
        )
        self.inv = I.InvocationStore(self.dir, now=lambda: self.t[0])

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def finish(self, name, code):
        with open(os.path.join(self.dir, f"{name}.exit"), "w") as fh:
            fh.write(str(code))


class TestJobsAreInvocations(JobBase):
    def test_a_job_projects_through_its_life_under_a_stable_id(self):
        self.jobs.submit("make", name="build")
        (rec,) = self.inv.all()
        self.assertEqual(
            (rec["id"], rec["kind"], rec["state"], rec["backend"]), ("job:build@1000000", "job", "running", "local_job")
        )
        self.finish("build", 2)
        self.t[0] = 1005
        self.jobs._refresh(self.jobs._read("build"))
        rec = self.inv.get("job:build@1000000")
        self.assertEqual((rec["state"], rec["outcome"]["exit_code"]), ("failed", 2))
        self.assertTrue(self.inv.is_owed(rec))

    def test_reading_a_finished_job_delivers_it(self):
        self.jobs.submit("make", name="build")
        self.finish("build", 0)
        self.assertEqual(len(self.inv.owed()), 0, "not terminal until something refreshes it")
        self.jobs._refresh(self.jobs._read("build"))
        self.assertEqual(len(self.inv.owed()), 1)
        self.assertEqual(self.jobs.get("build").state, "done")
        self.assertEqual(self.inv.owed(), [])
        self.assertEqual(self.inv.all()[0]["delivered_by"], "read")

    def test_resubmitting_a_name_is_a_new_invocation(self):
        self.jobs.submit("make", name="build")
        self.finish("build", 0)
        self.jobs._refresh(self.jobs._read("build"))
        self.t[0] = 2000
        self.jobs.submit("make", name="build")
        self.assertEqual([r["id"] for r in self.inv.all()], ["job:build@1000000", "job:build@2000000"])

    def test_a_died_job_is_unknown_and_a_deadline_is_expired(self):
        self.jobs.submit("deploy", name="deploy")
        self.jobs.submit("sleep 1000", name="slow", max_runtime=10)
        self.alive.clear()
        self.t[0] = 1002
        self.jobs._refresh(self.jobs._read("deploy"))
        self.t[0] = 1004
        self.jobs._refresh(self.jobs._read("deploy"))
        self.t[0] = 1020
        self.jobs._refresh(self.jobs._read("slow"))
        states = {r["name"]: r["state"] for r in self.inv.all()}
        self.assertEqual(states, {"deploy": "unknown", "slow": "expired"})
        self.assertIn("verify before retrying", I.describe(self.inv.get("job:deploy@1000000")))

    def test_sync_jobs_repairs_a_projection_lost_to_a_crash(self):
        self.jobs.submit("make", name="build")
        shutil.rmtree(self.inv.dir)
        self.inv.sync_jobs()
        self.assertEqual([r["state"] for r in self.inv.all()], ["running"])


class TestWaitChoosesTheBarrier(JobBase):
    def setUp(self):
        super().setUp()
        self.wake = os.path.join(self.dir, "wake.json")
        os.environ["HARNESS_WAKE_FILE"] = self.wake

    def tearDown(self):
        os.environ.pop("HARNESS_WAKE_FILE", None)
        super().tearDown()

    def wait(self, *names):
        with self.assertRaises(J.WaitSignal):
            self.jobs.wait(*names, wake_after=600)
        with open(self.wake) as fh:
            return json.load(fh)

    def test_named_items_block_and_the_rest_watch(self):
        for n in ("a", "b", "c"):
            self.jobs.submit("x", name=n)
        request = self.wait("a", "b")
        self.assertEqual(request["blocking"], ["job:a@1000000", "job:b@1000000"])
        self.assertEqual({r["name"]: r["blocking"] for r in self.inv.all()}, {"a": True, "b": True, "c": False})
        self.wait("c")
        self.assertEqual({r["name"]: r["blocking"] for r in self.inv.all()}, {"a": False, "b": False, "c": True})

    def decide(self, request):
        return S.decide_owed(request, self.dir, now=lambda: self.t[0])

    def test_a_watching_item_wakes_alone_while_the_barrier_waits(self):
        for n in ("a", "b", "c"):
            self.jobs.submit("x", name=n)
        request = self.wait("a", "b")
        self.finish("a", 0)
        self.assertEqual(self.decide(request)[:2], (None, None), "half a barrier is not a wake")
        self.finish("c", 1)
        source, reason, ids = self.decide(request)
        self.assertEqual(source, "owed")
        self.assertTrue(reason.startswith("job 'c': failed (exit 1)"), reason)
        self.assertIn("also: job 'a': succeeded (exit 0)", reason)
        self.assertEqual(sorted(ids), ["job:a@1000000", "job:c@1000000"])

    def test_the_barrier_fires_when_all_are_terminal_whatever_their_outcome(self):
        for n in ("a", "b"):
            self.jobs.submit("x", name=n)
        request = self.wait("a", "b")
        self.finish("a", 0)
        self.finish("b", 3)
        source, reason, ids = self.decide(request)
        self.assertEqual(source, "finished")
        self.assertIn("b (failed (exit 3))", reason)
        self.assertNotIn("also:", reason, "the barrier's own items are not repeated")
        self.assertEqual(len(ids), 2)

    def test_with_no_wait_at_all_an_owed_job_still_wakes(self):
        self.jobs.submit("x", name="forgotten")
        self.finish("forgotten", 0)
        source, reason, _ = S.decide_owed(None, self.dir)
        self.assertEqual((source, reason), ("owed", "job 'forgotten': succeeded (exit 0)"))

    def ask(self, request, *flags):
        out = subprocess.run([sys.executable, os.path.join(HERE, "scheduler.py"), "--reason-for-request", *flags],
                             input=json.dumps(request), capture_output=True, text=True, cwd=HERE, timeout=30)
        return json.loads(out.stdout)

    def test_a_host_that_cannot_mark_delivery_is_woken_only_by_what_ended_after_its_wait(self):
        self.jobs.submit("x", name="a")
        self.jobs.submit("x", name="c")
        self.finish("c", 0)
        self.jobs._refresh(self.jobs._read("c"))  # seen to end before the wait was armed
        request = self.wait("a")
        self.assertIsNone(self.ask(request)["reason"], "it would wake this host on every wait")
        self.assertEqual(self.ask(request, "--consume")["source"], "owed")
        self.assertEqual(self.inv.owed(), [])

    def test_consume_marks_what_it_reported_delivered(self):
        self.jobs.submit("x", name="a")
        request = self.wait("a")
        self.finish("a", 0)
        out = subprocess.run(
            [sys.executable, os.path.join(HERE, "scheduler.py"), "--reason-for-request", "--consume"],
            input=json.dumps(request),
            capture_output=True,
            text=True,
            cwd=HERE,
            timeout=30,
        )
        self.assertEqual(json.loads(out.stdout)["source"], "finished", out.stderr)
        self.assertEqual(self.inv.owed(), [])


class TestSchedulerDeliversInTwoPhases(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="inv-sched-")
        self.session = os.path.join(self.root, "s")
        self.jobs_dir = os.path.join(self.session, "jobs")
        os.makedirs(self.jobs_dir)
        with open(os.path.join(self.session, S.SESSION_FILE), "w") as fh:
            json.dump({"argv": ["true"]}, fh)
        self.inv = I.InvocationStore(self.jobs_dir)
        self.inv.create("job:x@1", kind="job", name="x", state=I.RUNNING)
        self.inv.transition("job:x@1", I.SUCCEEDED, {"summary": "completed", "exit_code": 0})
        self.messages = []

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def runner(self, code=0, check=None):
        def run(argv, cwd, env):
            self.messages.append(argv[-1])
            if check:
                check()
            return type("R", (), {"returncode": code})()

        return run

    def test_the_owed_item_rides_the_turn_and_is_delivered_when_it_returns(self):
        def during():
            self.assertEqual(self.inv.get("job:x@1")["delivering"], S._read_turn(self.session)["run_id"])

        self.assertEqual(S.scan_once(self.root, runner=self.runner(check=during), log=lambda m: None), ["s"])
        self.assertIn("[woken: job 'x': succeeded (exit 0)]", self.messages[0])
        self.assertTrue(self.inv.get("job:x@1")["delivered_at"])
        self.assertEqual(S.scan_once(self.root, runner=self.runner(), log=lambda m: None), [])

    def test_a_user_message_wake_carries_owed_outcomes_too(self):
        S.post_user_message(self.session, "status?")
        S.scan_once(self.root, runner=self.runner(), log=lambda m: None)
        self.assertIn("also: job 'x': succeeded (exit 0)", self.messages[0])
        self.assertIn("status?", self.messages[0])
        self.assertTrue(self.inv.get("job:x@1")["delivered_at"])

    def test_a_turn_that_never_started_gives_the_items_back(self):
        def boom(argv, cwd, env):
            raise OSError("no such harness")

        S.scan_once(self.root, runner=boom, log=lambda m: None)
        rec = self.inv.get("job:x@1")
        self.assertEqual((rec["delivering"], rec["delivered_at"]), (None, None))

    def test_idle_and_drain_see_owed_items(self):
        self.assertTrue(S._has_pending(self.session))


if __name__ == "__main__":
    unittest.main()
