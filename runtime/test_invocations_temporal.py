"""
The optional Temporal backend, against temporalio's own time-skipping test server.
Skipped cleanly when temporalio is not installed (it is not a dependency).
"""

import asyncio
import shutil
import tempfile
import unittest
import uuid

import invocations as I
import invocations_temporal as T

if T.AVAILABLE:
    from temporalio.testing import WorkflowEnvironment


@unittest.skipUnless(T.AVAILABLE, "temporalio is not installed (optional backend)")
class TestTemporalBackend(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.dir = tempfile.mkdtemp(prefix="inv-temporal-")
        self.store = I.InvocationStore(self.dir)
        self.env = await WorkflowEnvironment.start_time_skipping()
        self.calls = []
        self.queue = f"q-{uuid.uuid4().hex[:8]}"

    async def asyncTearDown(self):
        await self.env.shutdown()
        shutil.rmtree(self.dir, ignore_errors=True)

    def tools(self, script):
        """`script` is the per-attempt behaviour: an exception to raise, or a value to return."""
        steps = list(script)

        async def tool(args, key):
            self.calls.append(key)
            step = steps.pop(0) if steps else "done"
            if isinstance(step, (int, float)) and not isinstance(step, bool):
                await asyncio.sleep(step)
                return "slept"
            if isinstance(step, BaseException):
                raise step
            return step

        return {"svc.op": tool}

    async def invoke(self, script, delivery, inv_id="call:cell:1", **kw):
        backend = T.TemporalBackend(self.env.client, self.store, task_queue=self.queue)
        async with T.make_worker(self.env.client, self.tools(script), task_queue=self.queue):
            return await backend.submit(inv_id, "svc.op", {"x": 1}, delivery=delivery, **kw)

    async def test_idempotent_retries_under_one_key_and_reports_success(self):
        out = await self.invoke([TimeoutError("lost"), TimeoutError("lost"), "ok"], "idempotent")
        self.assertEqual(out["state"], "succeeded")
        self.assertEqual(self.calls, ["call:cell:1"] * 3, "every attempt carries the invocation id")
        rec = self.store.get("call:cell:1")
        self.assertEqual(
            (rec["state"], rec["backend"], rec["workflow_id"]), ("succeeded", "temporal", "inv-call:cell:1")
        )

    async def test_at_most_once_never_resends_a_request_that_may_have_left(self):
        out = await self.invoke([TimeoutError("no answer"), "ok"], "at_most_once")
        self.assertEqual(out["state"], "unknown")
        self.assertEqual(len(self.calls), 1)
        rec = self.store.get("call:cell:1")
        self.assertEqual(rec["state"], "unknown")
        self.assertTrue(self.store.is_owed(rec))
        self.assertIn("verify before retrying", I.describe(rec))

    async def test_at_most_once_retries_what_provably_never_left(self):
        out = await self.invoke([ConnectionRefusedError(), "ok"], "at_most_once")
        self.assertEqual((out["state"], len(self.calls)), ("succeeded", 2))

    async def test_an_error_answer_is_failed_and_not_retried(self):
        out = await self.invoke([I.ToolFailed("declined"), "ok"], "idempotent")
        self.assertEqual((out["state"], len(self.calls)), ("failed", 1))

    async def test_a_deadline_in_workflow_code_expires_and_still_reports(self):
        out = await self.invoke([3600], "read_only", deadline_seconds=2)
        self.assertEqual(out["state"], "expired")
        self.assertEqual(self.store.get("call:cell:1")["state"], "expired")

    async def test_the_same_invocation_submitted_twice_runs_once(self):
        backend = T.TemporalBackend(self.env.client, self.store, task_queue=self.queue)
        async with T.make_worker(self.env.client, self.tools([1, "never"]), task_queue=self.queue):
            first, second = await asyncio.gather(
                backend.submit("call:cell:9", "svc.op", delivery="at_most_once"),
                backend.submit("call:cell:9", "svc.op", delivery="at_most_once"),
            )
        self.assertEqual(first, second)
        self.assertEqual(self.calls, ["call:cell:9"])


class TestImportGuard(unittest.TestCase):
    def test_the_module_imports_without_temporalio_and_says_what_is_missing(self):
        if T.AVAILABLE:
            self.skipTest("temporalio is installed")
        with self.assertRaisesRegex(RuntimeError, "pip install temporalio"):
            T.TemporalBackend(None, None)


if __name__ == "__main__":
    unittest.main()
