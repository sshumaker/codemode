"""
rlm.run is hidden unless the harness opts in (scripts/neutralize-prime.mjs, subagents).

Runs the VENDORED rlm module, the one the kernel imports, rather than a copy: the
gate is a patch on that file, and a test of anything else would pass while the
kernel still spawned prime's own child.
"""

import asyncio
import importlib
import os
import sys
import unittest
from unittest import mock

RUNTIME_SRC = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "vendor/prime-agent/prime-agent-runtime/src"
)


def _fresh_rlm():
    if RUNTIME_SRC not in sys.path:
        sys.path.insert(0, RUNTIME_SRC)
    for name in [m for m in sys.modules if m == "rlm" or m.startswith("rlm.")]:
        del sys.modules[name]
    return importlib.import_module("rlm")


class TestRlmRunGate(unittest.TestCase):
    def run_rlm(self, env, call):
        with mock.patch.dict(os.environ, env, clear=False):
            for var in ("HARNESS_RLM", "HARNESS_SUBAGENTS"):
                if var not in env:
                    os.environ.pop(var, None)
            rlm = _fresh_rlm()
            sent = []

            async def fake_host_request(request_type, payload=None):
                sent.append((request_type, payload))
                return {"rlm_child_id": "c", "name": "n", "session_dir": "/tmp/s", "model": "m"}

            rlm.host_request = fake_host_request
            try:
                return asyncio.run(call(rlm)), sent
            except RuntimeError as exc:
                return exc, sent

    def test_refused_by_default_and_nothing_reaches_the_host(self):
        for call in (lambda r: r.run("task"), lambda r: r.rlm("task"), lambda r: r.rlm.run("task")):
            got, sent = self.run_rlm({}, call)
            self.assertIsInstance(got, RuntimeError)
            self.assertIn("rlm.run is disabled", str(got))
            self.assertIn("Do the work here", str(got))
            self.assertNotIn("spawn", str(got))
            self.assertEqual(sent, [])

    def test_with_subagents_on_the_refusal_names_spawn(self):
        got, sent = self.run_rlm({"HARNESS_SUBAGENTS": "1"}, lambda r: r.run("task"))
        self.assertIsInstance(got, RuntimeError)
        self.assertIn("spawn(prompt, name=...)", str(got))
        self.assertEqual(sent, [])

    def test_harness_rlm_opts_back_in(self):
        got, sent = self.run_rlm({"HARNESS_RLM": "1"}, lambda r: r.run("task", model="a/b"))
        self.assertEqual(got.name, "n")
        self.assertEqual(sent, [("rlm.run", {"prompt": "task", "kwargs": {"model": "a/b"}})])

    def test_the_rest_of_rlm_stays_infrastructure(self):
        rlm = _fresh_rlm()
        for attr in ("host_request", "find_models", "list_subagents", "harness", "get_harness_state"):
            self.assertTrue(hasattr(rlm, attr), attr)
        # The kernel bootstrap's readiness check asserts rlm.run exists and rlm is callable.
        self.assertTrue(callable(rlm.run))
        self.assertTrue(callable(rlm))


if __name__ == "__main__":
    unittest.main()
