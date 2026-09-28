"""
spawn() over the kernel↔host channel (HARNESS_SUBAGENT_TRANSPORT=host).

The kernel side only: what travels in each request, what the handle reads back,
how `jobs` sees host children, the wake, the bounded gather, and the gates. The
loop side (scripts/patches/subagent-host.ts) has its own tests in
bench/test/subagent-host.test.mjs; `TestInARealKernel` drives both halves of the
comm through a real ipykernel, replying on the control channel the way prime does.
"""

import asyncio
import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import jobs as J  # noqa: E402
import subagents as S  # noqa: E402

RUNTIME_SRC = os.path.join(HERE, "..", "vendor/prime-agent/prime-agent-runtime/src")


class FakeBroker:
    """
    Stands in for the loop's broker: the same request/reply shapes, a parent model,
    an allow-list and a concurrency cap, so refusals travel like real ones.
    """

    def __init__(self, parent_model="anthropic/claude-sonnet-5", allowed=None, cap=4):
        self.parent_model = parent_model
        self.allowed = allowed or [parent_model, "anthropic/claude-haiku-4-5"]
        self.cap = cap
        self.children = {}
        self.sent = []
        self.wakes = []

    def __call__(self, payload):
        self.sent.append(dict(payload))
        op = payload["op"]
        if op == "spawn":
            model = payload.get("model") or self.parent_model
            if model not in self.allowed:
                return {
                    "ok": False,
                    "error": f"model {model} is not allowed for subagents; allowed: {', '.join(self.allowed)}",
                }
            live = [c for c in self.children.values() if c["state"] == "running"]
            if len(live) >= self.cap:
                return {"ok": False, "error": f"{len(live)} subagents are already running and the limit is {self.cap}"}
            if payload["name"] in self.children:
                return {"ok": False, "error": f"a subagent named {payload['name']} already exists"}
            child = {
                "name": payload["name"],
                "state": "running",
                "model": model,
                "prompt": payload["prompt"],
                "tools": payload.get("tools") or ["ipython"],
            }
            self.children[payload["name"]] = child
            return {"ok": True, "child": dict(child)}
        if op == "status":
            return {
                "ok": True,
                "children": [dict(self.children.get(n) or {"name": n, "state": "missing"}) for n in payload["names"]],
            }
        if op == "list":
            return {"ok": True, "children": [dict(c) for c in self.children.values()]}
        if op == "kill":
            c = self.children.get(payload["name"])
            if c and c["state"] == "running":
                c.update(state="killed", reason="stopped by the parent")
                return {"ok": True, "killed": True}
            return {"ok": True, "killed": False}
        if op == "wait":
            self.wakes.append(payload)
            pending = [n for n in payload["watch"] if self.children.get(n, {}).get("state") == "running"]
            return {"ok": True, "armed": True, "pending": pending}
        return {"ok": False, "error": f"unknown op {op}"}

    def finish(self, name, result="the answer", **extra):
        self.children[name].update(state="done", ok=True, result=result, turns=3, cost=0.01, **extra)


class Base(unittest.TestCase):
    ENV = {"HARNESS_SUBAGENTS": "1", "HARNESS_SUBAGENT_TRANSPORT": "host"}

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="subagents-host-")
        self.store = J.JobStore(self.dir, emit=lambda m: None)
        J.use_store(self.store)
        self.broker = FakeBroker()
        self.spawner = S.Subagents(self.store, env=dict(self.ENV), host=self.broker)
        S.use_spawner(self.spawner)

    def tearDown(self):
        S.use_spawner(None)
        J._default = None if hasattr(J, "_default") else None
        shutil.rmtree(self.dir, ignore_errors=True)


class TestTheRequest(Base):
    def test_every_parameter_travels_and_nothing_is_forked_here(self):
        with mock.patch("builtins.print"):
            S.spawn(
                "research A",
                name="a",
                tools=["read", "grep"],
                model="anthropic/claude-haiku-4-5",
                max_turns=12,
                max_cost=0.5,
                timeout="10m",
                system_prompt="be brief",
                cwd="sub",
            )
        req = self.broker.sent[0]
        self.assertEqual(
            req,
            {
                "op": "spawn",
                "name": "a",
                "prompt": "research A",
                "tools": ["read", "grep"],
                "model": "anthropic/claude-haiku-4-5",
                "max_turns": 12,
                "max_cost": 0.5,
                "timeout": 600,
                "system_prompt": "be brief",
                "cwd": "sub",
            },
        )
        self.assertEqual(os.listdir(self.dir), [], "the host transport wrote into the job directory")

    def test_the_model_is_left_to_the_broker_so_it_can_be_the_parents(self):
        with mock.patch("builtins.print"):
            child = S.spawn("x", name="a")
        self.assertIsNone(self.broker.sent[0]["model"])
        self.assertEqual(child.model, "anthropic/claude-sonnet-5")

    def test_an_agent_definition_is_resolved_before_it_travels(self):
        scout = S.Agent(tools="read,grep", max_turns=5, model="anthropic/claude-haiku-4-5")
        with mock.patch("builtins.print"):
            S.spawn("x", name="a", agent=scout, max_turns=9)
        req = self.broker.sent[0]
        self.assertEqual(
            (req["tools"], req["max_turns"], req["model"]), (["read", "grep"], 9, "anthropic/claude-haiku-4-5")
        )

    def test_a_refused_model_raises_with_the_allowed_list(self):
        with self.assertRaises(J.JobError) as ctx:
            S.spawn("x", name="a", model="openai/gpt-9")
        self.assertIn("anthropic/claude-haiku-4-5", str(ctx.exception))

    def test_the_brokers_cap_is_the_error_the_agent_sees(self):
        self.broker.cap = 1
        with mock.patch("builtins.print"):
            S.spawn("x", name="a")
        with self.assertRaises(J.JobError) as ctx:
            S.spawn("y", name="b")
        self.assertIn("limit is 1", str(ctx.exception))

    def test_the_local_guards_still_apply(self):
        with self.assertRaises(TypeError):
            S.spawn("x")
        with self.assertRaises(TypeError):
            S.spawn("", name="a")
        with self.assertRaises(ValueError):
            S.spawn("x", name="bad name")
        self.assertEqual(self.broker.sent, [])


class TestGates(Base):
    def test_off_means_refused_before_anything_is_sent(self):
        spawner = S.Subagents(self.store, env={"HARNESS_SUBAGENT_TRANSPORT": "host"}, host=self.broker)
        with self.assertRaises(J.JobError) as ctx:
            spawner.spawn("x", name="a")
        self.assertIn("not enabled", str(ctx.exception))
        self.assertEqual(self.broker.sent, [])

    def test_a_child_at_the_depth_limit_cannot_spawn(self):
        spawner = S.Subagents(self.store, env=dict(self.ENV, HARNESS_SUBAGENT_DEPTH="1"), host=self.broker, max_depth=1)
        with self.assertRaises(J.JobError) as ctx:
            spawner.spawn("x", name="a")
        self.assertIn("cannot spawn subagents", str(ctx.exception))
        self.assertEqual(self.broker.sent, [])

    def test_the_depth_limit_is_configurable(self):
        spawner = S.Subagents(self.store, env=dict(self.ENV, HARNESS_SUBAGENT_DEPTH="1"), host=self.broker, max_depth=2)
        with mock.patch("builtins.print"):
            spawner.spawn("x", name="a")
        self.assertEqual(len(self.broker.sent), 1)


class TestTheHandle(Base):
    def test_reads_are_live_from_the_broker(self):
        with mock.patch("builtins.print"):
            child = S.spawn("x", name="a")
        self.assertFalse(child.done)
        self.assertEqual(child.state, "running")
        self.broker.finish("a", result="42")
        self.assertTrue(child.done)
        self.assertTrue(child.ok)
        self.assertEqual((child.result, child.turns, child.cost, child.exit_code), ("42", 3, 0.01, 0))
        self.assertIn("a done on anthropic/claude-sonnet-5", repr(child))

    def test_is_not_awaitable(self):
        with mock.patch("builtins.print"):
            child = S.spawn("x", name="a")
        with self.assertRaises(TypeError):
            child.__await__()

    def test_jobs_get_finds_a_host_child_the_store_has_never_seen(self):
        with mock.patch("builtins.print"):
            S.spawn("x", name="a")
        got = J.get("a")
        self.assertIsInstance(got, S.HostSubagent)
        self.assertIsNone(J.get("nope"))

    def test_the_manifest_and_list_include_host_children(self):
        with mock.patch("builtins.print"):
            S.spawn("research the thing", name="a")
        self.assertIn("subagent on anthropic/claude-sonnet-5: research the thing", J.manifest())
        self.assertEqual([r["name"] for r in J.list()], ["a"])

    def test_kill_goes_to_the_broker(self):
        with mock.patch("builtins.print"):
            S.spawn("x", name="a")
        self.assertTrue(S._spawner().host().kill("a"))
        self.assertEqual(J.get("a").state, "killed")


class TestWake(Base):
    def test_wait_in_wake_mode_arms_the_broker_and_emits_no_sentinel(self):
        emitted = []
        self.store._emit = emitted.append
        with mock.patch("builtins.print"):
            S.spawn("x", name="a")
        with mock.patch.dict(os.environ, {"HARNESS_WAIT_MODE": "wake"}):
            with self.assertRaises(J.WaitSignal):
                J.wait(wake_after=120)
        self.assertEqual(self.broker.wakes, [{"op": "wait", "wake_after": 120, "watch": ["a"]}])
        self.assertFalse(any(J.WAIT_SENTINEL in m for m in emitted), emitted)
        self.assertTrue(any("resumed when a finishes" in m for m in emitted), emitted)

    def test_outside_wake_mode_the_sentinel_path_is_unchanged(self):
        emitted = []
        self.store._emit = emitted.append
        with mock.patch.dict(os.environ, {"HARNESS_WAIT_MODE": ""}):
            with self.assertRaises(J.WaitSignal):
                J.wait(wake_after=120)
        self.assertTrue(any(J.WAIT_SENTINEL in m for m in emitted))
        self.assertEqual(self.broker.wakes, [])


class TestGather(Base):
    def gather(self, *names, **kw):
        async def status(payload):
            return self.broker(payload)

        with mock.patch.object(S, "_host_request_async", status), mock.patch.object(S, "GATHER_POLL", 0.01):
            return asyncio.run(S.gather_children(*names, **kw))

    def test_returns_each_childs_text_once_all_are_done(self):
        with mock.patch("builtins.print"):
            a = S.spawn("x", name="a")
            S.spawn("y", name="b")
        self.broker.finish("a", result="A!")
        self.broker.finish("b", result="B!")
        got = self.gather(a, "b", timeout=5)
        self.assertEqual(dict(got), {"a": "A!", "b": "B!"})
        self.assertEqual((got.pending, got.failed), ([], {}))
        self.assertEqual(got.models["a"], "anthropic/claude-sonnet-5")

    def test_returns_at_the_deadline_with_the_rest_pending_rather_than_raising(self):
        with mock.patch("builtins.print"):
            S.spawn("x", name="a")
            S.spawn("y", name="b")
        self.broker.finish("a", result="A!")
        t0 = time.monotonic()
        got = self.gather("a", "b", timeout=0.2)
        self.assertLess(time.monotonic() - t0, 3)
        self.assertEqual(got.pending, ["b"])
        self.assertEqual(got["a"], "A!")
        self.assertIn("jobs.wait", repr(got))

    def test_a_failed_child_is_reported_not_hidden(self):
        with mock.patch("builtins.print"):
            S.spawn("x", name="a")
        self.broker.children["a"].update(state="limit", reason="turn cap (5) reached")
        got = self.gather("a", timeout=1)
        self.assertEqual(got.failed, {"a": "turn cap (5) reached"})

    def test_no_names_means_every_running_child(self):
        with mock.patch("builtins.print"):
            S.spawn("x", name="a")
        self.broker.finish("a")
        got = self.gather(timeout=1)
        self.assertEqual(list(got), ["a"])

    def test_the_wait_is_bounded_by_the_cell_watchdog(self):
        with mock.patch.dict(os.environ, {"HARNESS_CELL_CEILING": "120", "HARNESS_CELL_CEILING_MARGIN": "15"}):
            self.assertEqual(S._gather_budget(600), 100)
        with mock.patch.object(S, "GATHER_MAX", 50):
            self.assertEqual(S._gather_budget("10m"), 50)
        self.assertEqual(S._gather_budget(None), S.GATHER_DEFAULT)


class TestPreludeBinding(unittest.TestCase):
    """The prelude binds spawn only when the harness says so, and never at the depth limit."""

    def bind(self, env):
        import builtins
        import runpy

        for name in ("spawn", "Agent", "gather_children"):
            if hasattr(builtins, name):
                delattr(builtins, name)
        marker = tempfile.mktemp(prefix="prelude-")
        full = dict(env, HARNESS_RUNTIME_DIR=HERE, HARNESS_PRELUDE_MARKER=marker, HARNESS_JOB_DIR=tempfile.mkdtemp())
        with mock.patch.dict(os.environ, full, clear=False):
            for var in ("HARNESS_SUBAGENTS", "HARNESS_SUBAGENT_DEPTH"):
                if var not in env:
                    os.environ.pop(var, None)
            ns = runpy.run_path(os.path.join(HERE, "kernel-prelude.py"), run_name="prelude")
            ns["uninstall_guards"]()
        bound = {n: hasattr(builtins, n) for n in ("spawn", "gather_children")}
        for name in ("spawn", "Agent", "gather_children"):
            if hasattr(builtins, name):
                delattr(builtins, name)
        with open(marker) as fh:
            status = fh.read()
        os.remove(marker)
        return bound, status

    def test_off_by_default(self):
        with mock.patch("builtins.print"):
            bound, status = self.bind({})
        self.assertEqual(bound, {"spawn": False, "gather_children": False})
        self.assertIn("SUBAGENTS\toff", status)

    def test_on_binds_spawn_and_gather(self):
        with mock.patch("builtins.print"):
            bound, status = self.bind({"HARNESS_SUBAGENTS": "1", "HARNESS_SUBAGENT_TRANSPORT": "host"})
        self.assertEqual(bound, {"spawn": True, "gather_children": True})
        self.assertIn("transport=host", status)

    def test_startup_never_waits_on_the_host(self):
        # The host does not answer while the kernel is still starting: a host request
        # from the prelude held kernel_info_request past prime's readiness check.
        calls = []
        with mock.patch.object(S, "host_request_sync", lambda payload, timeout=30.0: calls.append(payload) or {}):
            with mock.patch("builtins.print"):
                self.bind({"HARNESS_SUBAGENTS": "1", "HARNESS_SUBAGENT_TRANSPORT": "host"})
        self.assertEqual(calls, [])

    def test_a_child_gets_nothing_to_call(self):
        with mock.patch("builtins.print"):
            bound, status = self.bind({"HARNESS_SUBAGENTS": "1", "HARNESS_SUBAGENT_DEPTH": "1"})
        self.assertEqual(bound, {"spawn": False, "gather_children": False})
        self.assertIn("off at depth 1", status)


def _kernel_python():
    candidate = os.path.expanduser("~/.prime/agent/kernel-venv/bin/python")
    return candidate if os.path.exists(candidate) else None


@unittest.skipUnless(_kernel_python(), "no prime kernel venv on this machine")
class TestInARealKernel(unittest.TestCase):
    """
    The sync host request is the one piece a fake cannot vouch for: it blocks the
    cell's thread while the reply lands on ipykernel's control thread. So: a real
    kernel, the real prelude, and a host that answers on the control channel exactly
    as prime's KernelManager does (sendCommMessage -> control).
    """

    DRIVER = r"""
import json, os, queue, sys, time
from jupyter_client.manager import start_new_kernel
sys.path.insert(0, sys.argv[2])
from test_subagents_host import FakeBroker
broker = FakeBroker()
env = dict(os.environ, PYTHONPATH=sys.argv[1], HARNESS_SUBAGENTS="1",
           HARNESS_SUBAGENT_TRANSPORT="host", HARNESS_RUNTIME_DIR=sys.argv[2],
           HARNESS_JOB_DIR=sys.argv[3], HARNESS_PRELUDE_MARKER=sys.argv[3] + "/marker",
           HARNESS_GATHER_POLL_SECONDS="0.05")
km, kc = start_new_kernel(kernel_name="python3", env=env)
code = open(sys.argv[4]).read()
msg_id = kc.execute(code)
out = []
deadline = time.time() + 60
comms = {}
while time.time() < deadline:
    try:
        m = kc.get_iopub_msg(timeout=0.5)
    except queue.Empty:
        continue
    t = m["msg_type"]
    if t == "comm_open" and m["content"].get("target_name") == "host.request":
        data = dict(m["content"]["data"])
        rtype = data.pop("type")
        if rtype == "harness.subagent":
            reply = broker(data)
        elif rtype == "model.info":
            reply = {"id": "fake", "provider": "anthropic", "input": ["text", "image"]}
        else:
            reply = {"ok": False, "error": "host request type " + rtype + " is not available"}
        if data.get("op") == "spawn" and reply.get("ok") is not False:
            broker.finish(data["name"], result="answer from " + data["name"])
        status = {"status": "ok", **reply} if reply.get("ok") is not False else {"status": "error", "error": reply["error"]}
        kc.control_channel.send(kc.session.msg("comm_msg", {"comm_id": m["content"]["comm_id"], "data": status}))
    elif t == "stream":
        out.append(m["content"]["text"])
    elif t == "display_data":
        out.append("DISPLAY " + ",".join(sorted(m["content"]["data"])) + "\n")
    elif t == "error":
        out.append("ERROR " + m["content"]["ename"] + ": " + m["content"]["evalue"])
    elif t == "status" and m["content"]["execution_state"] == "idle" and m["parent_header"].get("msg_id") == msg_id:
        break
kc.stop_channels()
km.shutdown_kernel(now=True)
print(json.dumps({"out": "".join(out), "sent": broker.sent}))
"""

    CELL = r"""
exec(open(os.environ["HARNESS_RUNTIME_DIR"] + "/kernel-prelude.py").read(), {"__file__": os.environ["HARNESS_RUNTIME_DIR"] + "/kernel-prelude.py"})
import builtins
a = builtins.spawn("research A", name="a", model="anthropic/claude-haiku-4-5", max_turns=7)
b = builtins.spawn("research B", name="b")
results = await builtins.gather_children("a", "b", timeout=20)
print("RESULTS", dict(results), results.pending, results.models)
try:
    builtins.spawn("x", name="c", model="nope/model")
except Exception as e:
    print("REFUSED", type(e).__name__, e)
"""

    def run_cell(self, cell_code):
        import json
        import subprocess

        tmp = tempfile.mkdtemp(prefix="subagents-kernel-")
        try:
            driver = os.path.join(tmp, "driver.py")
            cell = os.path.join(tmp, "cell.py")
            with open(driver, "w") as fh:
                fh.write(self.DRIVER)
            with open(cell, "w") as fh:
                fh.write("import os\n" + cell_code.replace("__TMP__", tmp))
            proc = subprocess.run(
                [_kernel_python(), driver, RUNTIME_SRC, HERE, tmp, cell], capture_output=True, text=True, timeout=120
            )
            self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
            return json.loads(proc.stdout.strip().splitlines()[-1])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_attach_image_still_works_with_rlm_run_hidden(self):
        # attach_image reaches the host through rlm.host_request ("model.info"): the rlm
        # module stays infrastructure even though rlm.run refuses.
        skill = os.path.join(HERE, "..", "vendor/prime-agent/packages/coding-agent/skills/attach-image/src")
        got = self.run_cell(
            "import sys, base64, rlm\n"
            f"sys.path.insert(0, {skill!r})\n"
            "import attach_image\n"
            'png = "__TMP__/dot.png"\n'
            'open(png, "wb").write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))\n'
            'print("RESULT", await attach_image.run(png))\n'
            "try:\n"
            '    await rlm.run("x")\n'
            "except RuntimeError as e:\n"
            '    print("RLM", e)\n'
        )
        out = got["out"]
        self.assertIn("DISPLAY application/vnd.prime-agent.attachment+json,text/plain", out)
        self.assertIn("RESULT Loaded 1 image(s) into context", out)
        self.assertIn("RLM rlm.run is disabled in this harness", out)
        self.assertNotIn("ERROR", out)

    def test_spawn_and_gather_through_a_real_kernel(self):
        got = self.run_cell(self.CELL)
        out = got["out"]
        self.assertIn("RESULTS {'a': 'answer from a', 'b': 'answer from b'} []", out)
        self.assertIn("'a': 'anthropic/claude-haiku-4-5'", out)
        self.assertIn("'b': 'anthropic/claude-sonnet-5'", out)
        self.assertIn("REFUSED JobError model nope/model is not allowed", out)
        spawns = [s for s in got["sent"] if s["op"] == "spawn"]
        self.assertEqual(spawns[0]["max_turns"], 7)
        self.assertNotIn("ERROR", out)


if __name__ == "__main__":
    unittest.main()
