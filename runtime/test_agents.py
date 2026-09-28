"""
The `agents` surface and named waits: runtime/agents.py, runtime/agent_mailbox.py,
`jobs.wait(*names, ...)` and the scheduler's wake conditions.

The file transport is driven end to end through the real launcher with
fixtures/fake_agent.py standing in for prime's RPC process; the host transport
through a fake broker, the same way test_subagents_host.py does it.
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import agent_mailbox as M
import agents as A
import jobs as J
import scheduler as SCH
import subagents as S

FIXTURE_AGENT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "fake_agent.py")


def wait_until(predicate, timeout=20.0, interval=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


class FileBase(unittest.TestCase):
    """A real job dir, a real launcher, the fake RPC agent."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="agents-")
        self.store = J.JobStore(self.dir, cwd=self.dir, emit=lambda m: None)
        J.use_store(self.store)
        self.spawner = S.Subagents(
            self.store,
            env={"HARNESS_SUBAGENT_MODEL": "fake/model", "HARNESS_SUBAGENT_CLI": FIXTURE_AGENT},
            node=sys.executable,
            python=sys.executable,
        )
        S.use_spawner(self.spawner)
        self.agents = A.Agents()
        self._env = {
            k: os.environ.get(k)
            for k in ("FAKE_TURNS", "FAKE_DELAY", "FAKE_HANG", "HARNESS_WAKE_FILE", "HARNESS_WAIT_MODE")
        }

    def tearDown(self):
        for rec in self.store._all():
            if rec.get("state") in J.LIVE_STATES:
                try:
                    self.store.kill(rec["name"])
                except Exception:
                    pass
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        S.use_spawner(None)
        shutil.rmtree(self.dir, ignore_errors=True)


# ---------------------------------------------------------------------------------
# jobs.wait with names
# ---------------------------------------------------------------------------------


class TestNamedWait(FileBase):
    def wait_request(self, *names, **kw):
        wake = os.path.join(self.dir, "session", "wake.json")
        os.environ["HARNESS_WAKE_FILE"] = wake
        os.environ["HARNESS_WAIT_MODE"] = ""
        with self.assertRaises(J.WaitSignal):
            J.wait(*names, **kw)
        with open(wake) as fh:
            return json.load(fh)

    def test_varargs_and_a_list_watch_the_same_names_all_by_default(self):
        self.store.submit("sleep 30", name="a", strict=False)
        self.store.submit("sleep 30", name="b", strict=False)
        self.store.submit("sleep 30", name="c", strict=False)
        for form in (("a", "b"), (["a", "b"],), (("a", "b"),)):
            req = self.wait_request(*form, wake_after="10m")
            self.assertEqual(req["watch"], ["a", "b"], form)
            self.assertEqual(req["mode"], "all")
            self.assertEqual(req["wake_after"], 600)

    def test_handles_are_names(self):
        job = self.store.submit("sleep 30", name="build", strict=False)
        agent = A.AgentHandle("build", A._FileBackend(self.store))
        self.assertEqual(self.wait_request([job, agent], wake_after=60)["watch"], ["build"])

    def test_mode_any(self):
        self.store.submit("sleep 30", name="a", strict=False)
        self.assertEqual(self.wait_request("a", wake_after=60, mode="any")["mode"], "any")
        with self.assertRaises(ValueError):
            J.wait("a", wake_after=60, mode="some")

    def test_unknown_names_raise_at_call_time_naming_the_valid_ones(self):
        self.store.submit("sleep 30", name="build", strict=False)
        with self.assertRaises(J.JobError) as ctx:
            J.wait("biuld", wake_after=60)
        self.assertIn("'biuld'", str(ctx.exception))
        self.assertIn("build", str(ctx.exception))

    def test_a_nested_list_is_refused(self):
        self.store.submit("sleep 30", name="a", strict=False)
        with self.assertRaises(TypeError) as ctx:
            J.wait([["a"]], wake_after=60)
        self.assertIn("nested", str(ctx.exception))

    def test_no_names_keeps_the_original_contract(self):
        self.store.submit("sleep 30", name="a", strict=False)
        req = self.wait_request(wake_after=60)
        self.assertEqual(req["watch"], ["a"])
        self.assertNotIn("mode", req)
        # a bare number or duration string is still the deadline
        self.assertEqual(self.wait_request(90)["wake_after"], 90)
        self.assertEqual(self.wait_request("2m")["wake_after"], 120)

    def test_wake_mode_hands_names_and_mode_to_the_provider(self):
        seen = []

        class Provider:
            def live(self):
                return ["child"]

            def records(self):
                return [{"name": "child"}]

            def get(self, name):
                return None

            def manifest_lines(self):
                return []

            def arm_wake(self, seconds, watch, mode=None):
                seen.append((seconds, list(watch), mode))
                return "[wake armed]"

        J.use_external(Provider())
        try:
            os.environ["HARNESS_WAIT_MODE"] = "wake"
            with self.assertRaises(J.WaitSignal):
                J.wait("child", wake_after=120, mode="any")
            with self.assertRaises(J.WaitSignal):
                J.wait(wake_after=60)
        finally:
            J._EXTERNAL[:] = [p for p in J._EXTERNAL if type(p).__name__ != "Provider"]
        self.assertEqual(seen, [(120, ["child"], "any"), (60, ["child"], None)])


# ---------------------------------------------------------------------------------
# the scheduler's wake conditions
# ---------------------------------------------------------------------------------


class TestSchedulerWake(unittest.TestCase):
    def setUp(self):
        self.session = tempfile.mkdtemp(prefix="sched-")
        self.jobs = os.path.join(self.session, "jobs")
        self.store = J.JobStore(self.jobs, emit=lambda m: None)

    def tearDown(self):
        shutil.rmtree(self.session, ignore_errors=True)

    def arm(self, **req):
        with open(os.path.join(self.session, SCH.WAKE_FILE), "w") as fh:
            json.dump({"wake_at": time.time() + 600, "wake_after": 600, **req}, fh)

    def finish(self, name):
        self.store.submit("true", name=name, strict=False)
        self.assertTrue(wait_until(lambda: self.store.get(name).done))

    def test_all_waits_for_every_named_job(self):
        self.store.submit("sleep 30", name="slow", strict=False)
        self.finish("fast")
        self.arm(watch=["fast", "slow"], mode="all", armed_at=time.time(), mailboxes={})
        self.assertIsNone(SCH.wake_reason(self.session))
        self.store.kill("slow")
        self.assertIn("all finished", SCH.wake_reason(self.session))

    def test_any_wakes_on_the_first(self):
        self.store.submit("sleep 30", name="slow", strict=False)
        self.finish("fast")
        self.arm(watch=["fast", "slow"], mode="any", armed_at=time.time(), mailboxes={})
        self.assertIn("'fast' finished", SCH.wake_reason(self.session))
        self.store.kill("slow")

    def test_a_named_agents_message_wakes_it(self):
        self.store.submit("sleep 30", name="eu", strict=False)
        box = os.path.join(self.session, "eu.d")
        armed = time.time()
        M.Mailbox(box).report("an old note")  # before the wait: not a wake
        self.arm(watch=["eu"], mode="all", armed_at=armed + 0.5, mailboxes={"eu": box})
        self.assertIsNone(SCH.wake_reason(self.session))
        time.sleep(0.6)
        M.Mailbox(box).ask("which date range?")
        self.assertIn("'eu' sent you a message: asks: which date range?", SCH.wake_reason(self.session))
        self.store.kill("eu")

    def test_the_legacy_request_still_wakes_on_any_listed_job(self):
        self.finish("done-one")
        self.arm(watch=["done-one"])
        self.assertIn("'done-one' finished", SCH.wake_reason(self.session))

    def test_the_deadline_is_the_backstop(self):
        with open(os.path.join(self.session, SCH.WAKE_FILE), "w") as fh:
            json.dump({"wake_at": time.time() - 1, "wake_after": 5, "watch": [], "mode": "all"}, fh)
        self.assertIn("elapsed", SCH.wake_reason(self.session))


# ---------------------------------------------------------------------------------
# the mailbox
# ---------------------------------------------------------------------------------


class TestMailbox(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="box-")
        self.box = M.Mailbox(self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_send_queues_and_delivery_is_tracked(self):
        self.assertEqual(self.box.send("also check 2025")["kind"], "follow_up")
        self.assertEqual(self.box.send("stop that", mode="steer")["kind"], "steer")
        self.assertEqual([m["mode"] for m in self.box.pending()], ["follow_up", "steer"])
        self.box.mark_delivered(1)
        self.assertEqual([m["text"] for m in self.box.pending()], ["stop that"])

    def test_caps(self):
        with self.assertRaises(M.MailboxError):
            self.box.send("x" * (M.MAX_CHARS + 1))
        with self.assertRaises(M.MailboxError):
            self.box.send("")
        with self.assertRaises(M.MailboxError):
            self.box.send("hi", mode="shout")
        for i in range(M.MAX_PENDING):
            self.box.send(f"m{i}")
        with self.assertRaises(M.MailboxError) as ctx:
            self.box.send("one too many")
        self.assertIn("waiting to be delivered", str(ctx.exception))

    def test_an_open_question_takes_the_next_send_as_its_answer(self):
        qid = self.box.ask("which date range?")
        self.assertEqual(self.box.open_question()["id"], qid)
        self.assertEqual(self.box.send("2024 and 2025")["kind"], "answer")
        self.assertEqual(self.box.answer_for(qid), "2024 and 2025")
        self.assertIsNone(self.box.open_question())
        self.assertEqual(self.box.pending(), [], "an answer is not also delivered as a turn")

    def test_a_closed_question_is_not_answered(self):
        qid = self.box.ask("still there?")
        self.box.close_question(qid)
        self.assertEqual(self.box.send("yes")["kind"], "follow_up")
        self.assertIsNone(self.box.answer_for(qid))

    def test_messages_both_ways_and_unread(self):
        self.box.report("found 3 sources")
        self.box.send("check 2025 too")
        self.box.ask("which currency?")
        kinds = [(m["direction"], m["kind"]) for m in self.box.messages()]
        self.assertEqual(kinds, [("from_child", "report"), ("to_child", "follow_up"), ("from_child", "ask")])
        self.assertEqual(self.box.unread(), 2)
        self.box.mark_read()
        self.assertEqual(self.box.unread(), 0)


# ---------------------------------------------------------------------------------
# agents.* over the file transport, with the real launcher
# ---------------------------------------------------------------------------------


class TestAgentsFile(FileBase):
    def test_spawn_returns_a_handle_that_is_also_a_job(self):
        os.environ["FAKE_TURNS"] = "1"
        a = self.agents.spawn("count the files", name="a")
        self.assertIsInstance(a, A.AgentHandle)
        self.assertTrue(wait_until(lambda: a.done), repr(a))
        self.assertTrue(a.ok)
        self.assertIn("turn 1: count the files", a.result)
        self.assertEqual(a.turns, 1)
        self.assertIsNotNone(J.get("a"), "it is a job too")
        self.assertFalse(hasattr(J.get("a"), "send"), "messaging belongs to agents, never to jobs")

    def test_follow_up_reaches_a_running_child_and_its_result_reflects_it(self):
        os.environ["FAKE_TURNS"] = "4"
        os.environ["FAKE_DELAY"] = "0.4"
        a = self.agents.spawn("research the thing", name="a")
        self.assertTrue(wait_until(lambda: a.state == "running"))
        a.send("also check 2025", mode="follow_up")
        self.assertTrue(wait_until(lambda: a.done, timeout=30), repr(a))
        self.assertIn("also check 2025", a.result)
        self.assertEqual(a.messages[0].kind, "follow_up")
        stream = open(a.transcript).read()
        self.assertIn('"command": "prompt"', stream)

    def test_steer_goes_in_as_a_steer(self):
        os.environ["FAKE_TURNS"] = "4"
        os.environ["FAKE_DELAY"] = "0.4"
        a = self.agents.spawn("research the thing", name="a")
        self.assertTrue(wait_until(lambda: a.state == "running"))
        a.send("stop and summarise", mode="steer")
        self.assertTrue(wait_until(lambda: a.done, timeout=30))
        self.assertIn("stop and summarise", a.result)
        log = self.store.get("a").output
        self.assertIn("<- parent (steer)", log)

    def test_a_message_after_the_last_turn_still_runs_before_it_exits(self):
        os.environ["FAKE_TURNS"] = "1"
        os.environ["FAKE_DELAY"] = "0.6"
        a = self.agents.spawn("one quick thing", name="a")
        time.sleep(0.2)
        a.send("and one more")
        self.assertTrue(wait_until(lambda: a.done, timeout=30))
        self.assertIn("one more", a.result)

    def test_a_finished_child_cannot_be_sent_to(self):
        os.environ["FAKE_TURNS"] = "1"
        a = self.agents.spawn("x", name="a")
        self.assertTrue(wait_until(lambda: a.done))
        with self.assertRaises(J.JobError) as ctx:
            a.send("too late")
        self.assertIn("already finished", str(ctx.exception))

    def test_get_list_and_validation(self):
        os.environ["FAKE_TURNS"] = "1"
        self.agents.spawn("x", name="a")
        self.store.submit("sleep 5", name="not-an-agent", strict=False)
        with self.assertRaises(J.JobError) as ctx:
            self.agents.get("b")
        self.assertIn("Your agents: a", str(ctx.exception))
        with self.assertRaises(J.JobError):
            self.agents.get("not-an-agent")
        rows = self.agents.list()
        self.assertEqual([r["name"] for r in rows], ["a"])
        self.assertEqual(set(rows[0]), {"name", "model", "state", "turns", "cost", "unread"})
        with self.assertRaises(J.JobError):
            self.agents.get("a").send("x" * (M.MAX_CHARS + 1))
        with self.assertRaises(J.JobError):
            self.agents.get("a").send("hi", mode="shout")

    def test_handle_wait_is_a_named_wait(self):
        os.environ["FAKE_TURNS"] = "1"
        os.environ["FAKE_HANG"] = "5"
        a = self.agents.spawn("x", name="a")
        wake = os.path.join(self.dir, "s", "wake.json")
        os.environ["HARNESS_WAKE_FILE"] = wake
        os.environ["HARNESS_WAIT_MODE"] = ""
        with self.assertRaises(J.WaitSignal):
            a.wait(wake_after="5m")
        req = json.load(open(wake))
        self.assertEqual((req["watch"], req["mode"]), (["a"], "all"))
        self.assertEqual(req["mailboxes"], {"a": os.path.join(self.dir, "a.d")})

    def test_the_child_env_carries_its_mailbox(self):
        spec = self.spawner._build_spec("a", "p", S.Agent())
        env = spec["env"]
        self.assertEqual(env["HARNESS_SUBAGENT_SELF_DIR"], os.path.join(self.dir, "a.d"))
        self.assertEqual(env["HARNESS_SUBAGENT_NAME"], "a")
        self.assertNotIn("HARNESS_SUBAGENT_SIBLINGS", env)


class TestChildSide(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="child-")
        self.box_dir = os.path.join(self.dir, "eu.d")
        self.env = {
            "HARNESS_SUBAGENT_DEPTH": "1",
            A.SELF_DIR_VAR: self.box_dir,
            A.SELF_NAME_VAR: "eu",
            A.PARENT_JOB_DIR_VAR: self.dir,
        }
        self.child = A.ChildAgents(A._FileChannel(self.env), self.env)
        self.parent_box = M.Mailbox(self.box_dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_report_is_non_blocking_and_reaches_the_parent(self):
        with mock.patch("builtins.print"):
            self.child.report("found 3 candidates")
        self.assertEqual(self.parent_box.messages()[0]["text"], "found 3 candidates")

    def test_ask_parent_returns_the_parents_answer(self):
        def parent():
            self.assertTrue(wait_until(lambda: self.parent_box.open_question() is not None))
            self.parent_box.send("2024 and 2025")

        t = threading.Thread(target=parent)
        t.start()
        with mock.patch.object(A, "ASK_POLL_SECONDS", 0.05):
            answer = self.child.ask_parent("which date range?", timeout=10)
        t.join()
        self.assertEqual(answer, "2024 and 2025")

    def test_ask_parent_times_out_to_none_and_closes_the_question(self):
        with mock.patch.object(A, "ASK_POLL_SECONDS", 0.05), mock.patch("builtins.print"):
            self.assertIsNone(self.child.ask_parent("anyone?", timeout=0.3))
        self.assertIsNone(self.parent_box.open_question())
        self.assertEqual(self.parent_box.send("late")["kind"], "follow_up", "a late send is a follow-up, not an answer")

    def test_ask_parent_stays_under_the_cell_watchdog(self):
        with mock.patch.dict(os.environ, {"HARNESS_CELL_CEILING": "60", "HARNESS_CELL_CEILING_MARGIN": "15"}):
            self.assertEqual(A._ask_budget(600), 40)

    def test_a_child_cannot_spawn_and_has_no_siblings_by_default(self):
        with self.assertRaises(J.JobError):
            self.child.spawn("x", name="y")
        with self.assertRaises(J.JobError) as ctx:
            self.child.get("us")
        self.assertIn("off", str(ctx.exception))

    def test_siblings_when_the_harness_allows_it(self):
        store = J.JobStore(self.dir, emit=lambda m: None)
        store.submit(
            "sleep 20", name="us", strict=False, kind="subagent", meta={"child_dir": os.path.join(self.dir, "us.d")}
        )
        try:
            env = dict(self.env, **{A.SIBLINGS_VAR: "1"})
            child = A.ChildAgents(A._FileChannel(env), env)
            self.assertEqual([r["name"] for r in child.list()], ["us"])
            with mock.patch("builtins.print"):
                child.get("us").send("I have the EU numbers")
            msg = M.Mailbox(os.path.join(self.dir, "us.d")).pending()[0]
            self.assertEqual((msg["from"], msg["text"]), ("eu", "I have the EU numbers"))
        finally:
            store.kill("us")

    def test_the_kernel_gets_the_right_agents(self):
        self.assertIsInstance(A.for_this_kernel(self.env), A.ChildAgents)
        S.use_spawner(S.Subagents(env={"HARNESS_SUBAGENT_DEPTH": "1"}))
        try:
            self.assertIsNone(
                A.for_this_kernel({"HARNESS_SUBAGENT_DEPTH": "1"}), "a child with no channel gets no agents at all"
            )
        finally:
            S.use_spawner(None)


# ---------------------------------------------------------------------------------
# agents.* over the host transport
# ---------------------------------------------------------------------------------


class FakeBroker:
    def __init__(self):
        self.sent = []
        self.children = {}
        self.questions = {}

    def __call__(self, payload):
        self.sent.append(dict(payload))
        op = payload["op"]
        if op == "spawn":
            self.children[payload["name"]] = {
                "name": payload["name"],
                "state": "running",
                "model": "m",
                "unread": 0,
                "messages": [],
            }
            return {"ok": True, "child": dict(self.children[payload["name"]])}
        if op == "status":
            return {
                "ok": True,
                "children": [dict(self.children.get(n) or {"name": n, "state": "missing"}) for n in payload["names"]],
            }
        if op == "list":
            return {"ok": True, "children": [dict(c) for c in self.children.values()]}
        if op == "send":
            return {"ok": True, "kind": payload["mode"]}
        if op == "messages":
            return {"ok": True, "messages": [{"direction": "from_child", "kind": "ask", "text": "which year?"}]}
        if op == "wait":
            return {"ok": True, "pending": payload["watch"], "mode": payload.get("mode")}
        if op == "report":
            return {"ok": True}
        if op == "ask":
            self.questions["q1"] = None
            return {"ok": True, "id": "q1"}
        if op == "ask_poll":
            return {
                "ok": True,
                "answered": self.questions.get(payload["id"]) is not None,
                "text": self.questions.get(payload["id"]),
            }
        if op == "ask_close":
            return {"ok": True}
        return {"ok": False, "error": f"unknown op {op}"}


class TestAgentsHost(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="agents-host-")
        J.use_store(J.JobStore(self.dir, emit=lambda m: None))
        self.broker = FakeBroker()
        S.use_spawner(
            S.Subagents(env={"HARNESS_SUBAGENTS": "1", "HARNESS_SUBAGENT_TRANSPORT": "host"}, host=self.broker)
        )
        self.agents = A.Agents()

    def tearDown(self):
        S.use_spawner(None)
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_send_messages_and_the_named_wait_go_to_the_broker(self):
        with mock.patch("builtins.print"):
            a = self.agents.spawn("research", name="eu")
            a.send("also 2025")
            a.send("stop", mode="steer")
        self.assertEqual(
            [p for p in self.broker.sent if p["op"] == "send"],
            [
                {"op": "send", "name": "eu", "text": "also 2025", "mode": "follow_up"},
                {"op": "send", "name": "eu", "text": "stop", "mode": "steer"},
            ],
        )
        self.assertEqual(a.messages[0].text, "which year?")
        with mock.patch.dict(os.environ, {"HARNESS_WAIT_MODE": "wake"}), mock.patch("builtins.print"):
            with self.assertRaises(J.WaitSignal):
                J.wait([a], wake_after="10m")
        self.assertEqual(self.broker.sent[-1], {"op": "wait", "wake_after": 600, "watch": ["eu"], "mode": "all"})

    def test_result_is_empty_until_done(self):
        with mock.patch("builtins.print"):
            a = self.agents.spawn("research", name="eu")
        self.broker.children["eu"]["result"] = "narration so far"
        self.assertEqual(a.result, "")
        self.broker.children["eu"].update(state="done", ok=True)
        self.assertEqual(a.result, "narration so far")

    def test_the_child_end_over_the_host(self):
        child = A.ChildAgents(A._HostChannel(S.HostSubagents(self.broker)), {})
        with mock.patch("builtins.print"):
            child.report("halfway")
        self.assertEqual(self.broker.sent[-1], {"op": "report", "text": "halfway"})
        threading.Timer(0.2, lambda: self.broker.questions.update(q1="2025")).start()
        with mock.patch.object(A, "ASK_POLL_SECONDS", 0.05):
            self.assertEqual(child.ask_parent("which year?", timeout=5), "2025")
        self.assertEqual(self.broker.sent[-1]["op"], "ask_poll")


if __name__ == "__main__":
    unittest.main()
