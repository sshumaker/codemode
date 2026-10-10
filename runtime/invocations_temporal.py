"""
The optional Temporal backend for invocations (docs/TOOL-INVOCATIONS.md).

Off by default and import-guarded: nothing in the runtime imports this module, and
it imports `temporalio` only when used. Choose it explicitly by constructing a
`TemporalBackend` with a connected client and running `make_worker` beside it.

One workflow per invocation:

  - workflow id = "inv-" + the invocation id, so submitting the same invocation twice
    attaches to the one execution instead of starting another;
  - the work is one activity, activity id = the invocation id, which the tool also
    receives as its idempotency key;
  - the retry policy comes from the delivery mode: idempotent / lookup / read_only /
    at_least_once let Temporal retry; at_most_once runs the activity with one attempt
    and the WORKFLOW retries only a failure the tool proved was never sent (NotSent).
    Anything else — a timeout, a crashed worker, an error after sending — is UNKNOWN;
  - a deadline is held in workflow code; whatever ends the run, a `finally` reports
    the outcome to the harness's invocation store (an activity, so it is durable).
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any, Awaitable, Callable, Dict, Optional

try:
    from temporalio import activity, workflow
    from temporalio.common import RetryPolicy
    from temporalio.exceptions import WorkflowAlreadyStartedError
    from temporalio.exceptions import ActivityError, ApplicationError
    from temporalio.worker import Worker

    AVAILABLE = True
except ImportError:  # pragma: no cover - exercised by the skip in the tests
    AVAILABLE = False

with_invocations = None
if AVAILABLE:
    with workflow.unsafe.imports_passed_through():
        import invocations as with_invocations

TASK_QUEUE = "harness-invocations"
NOT_SENT = "NotSent"
DEFAULT_ACTIVITY_TIMEOUT = timedelta(minutes=5)
ToolFn = Callable[[Dict[str, Any], str], Awaitable[Any]]


def workflow_id(invocation_id: str) -> str:
    return f"inv-{invocation_id}"


def retry_policy(delivery: str) -> "RetryPolicy":
    """Temporal's retries for a delivery mode. at_most_once never retries a sent request."""
    if delivery == "at_most_once":
        return RetryPolicy(maximum_attempts=1)
    return RetryPolicy(
        initial_interval=timedelta(seconds=1),
        backoff_coefficient=2.0,
        maximum_interval=timedelta(seconds=30),
        maximum_attempts=5,
        non_retryable_error_types=["ToolFailed"],
    )


if AVAILABLE:

    @workflow.defn(name="harness.invocation")
    class InvocationWorkflow:
        """
        One invocation, run to an outcome and reported.
        Owns: retries per delivery mode, the deadline, reporting. Not: the work itself.
        """

        @workflow.run
        async def run(self, spec: Dict[str, Any]) -> Dict[str, Any]:
            outcome: Dict[str, Any] = {"state": "unknown", "summary": "the workflow ended without an outcome"}
            try:
                task = asyncio.ensure_future(self._work(spec))
                deadline = spec.get("deadline_seconds")
                try:
                    await workflow.wait_condition(task.done, timeout=deadline)
                    outcome = task.result()
                except asyncio.TimeoutError:
                    # The work is abandoned, not awaited: its late answer must not
                    # overwrite the expiry the agent is about to be told about.
                    task.cancel()
                    outcome = {"state": "expired", "summary": f"deadline of {deadline}s reached"}
            finally:
                await workflow.execute_activity(
                    "harness.report",
                    {"job_dir": spec.get("job_dir"), "id": spec["id"], **outcome},
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=10),
                )
            return outcome

        async def _work(self, spec: Dict[str, Any]) -> Dict[str, Any]:
            delivery = spec.get("delivery", "at_most_once")
            not_sent_retries = int(spec.get("not_sent_retries", 2))
            for attempt in range(not_sent_retries + 1):
                try:
                    answer = await workflow.execute_activity(
                        "harness.invoke",
                        spec,
                        activity_id=spec["id"] if attempt == 0 else f"{spec['id']}#{attempt}",
                        start_to_close_timeout=timedelta(seconds=spec.get("timeout_seconds") or 300),
                        retry_policy=retry_policy(delivery),
                    )
                    return {"state": "succeeded", "summary": str(answer)[:200], "answer": answer}
                except ActivityError as err:
                    kind = getattr(err.cause, "type", None)
                    if kind == "ToolFailed":
                        return {"state": "failed", "summary": str(err.cause)[:200]}
                    if kind == NOT_SENT and attempt < not_sent_retries:
                        continue
                    if kind == NOT_SENT:
                        return {"state": "failed", "summary": f"not sent: {err.cause}", "not_sent": True}
                    # Sent (or possibly sent) with no answer, retries spent where the
                    # mode allows them: whether it took effect is not known.
                    return {
                        "state": "unknown",
                        "summary": f"sent, no outcome ({err.cause}); "
                        "may or may not have taken effect — verify before retrying",
                    }
            return {"state": "unknown", "summary": "unreachable"}

    @activity.defn(name="harness.report")
    async def _report(event: Dict[str, Any]) -> None:
        """The outcome event, applied to the harness's store. Idempotent: terminal is final."""
        store = with_invocations.InvocationStore(event["job_dir"])
        fields = {k: v for k, v in event.items() if k not in ("job_dir", "id", "state")}
        store.transition(event["id"], event["state"], fields)


def make_worker(client: Any, tools: Dict[str, ToolFn], task_queue: str = TASK_QUEUE) -> "Worker":
    """A worker that runs invocation workflows; `tools` maps a tool name to `async fn(args, key)`."""
    _require()

    @activity.defn(name="harness.invoke")
    async def invoke(spec: Dict[str, Any]) -> Any:
        fn = tools.get(spec["name"])
        if fn is None:
            raise ApplicationError(f"no tool {spec['name']!r} on this worker", non_retryable=True)
        try:
            return await fn(spec.get("args") or {}, spec["id"])
        except with_invocations.ToolFailed as exc:
            raise ApplicationError(str(exc), type="ToolFailed", non_retryable=True) from exc
        except Exception as exc:  # noqa: BLE001 - classified for the workflow
            if with_invocations._is_not_sent(exc):
                raise ApplicationError(str(exc) or type(exc).__name__, type=NOT_SENT) from exc
            raise

    return Worker(client, task_queue=task_queue, workflows=[InvocationWorkflow], activities=[invoke, _report])


class TemporalBackend:
    """
    `submit(invocation) -> events` for Temporal: records the invocation, starts (or
    attaches to) its workflow, and returns the outcome event the workflow reported.
    """

    def __init__(self, client: Any, store: Any, task_queue: str = TASK_QUEUE):
        _require()
        self.client, self.store, self.task_queue = client, store, task_queue

    async def submit(
        self,
        invocation_id: str,
        name: str,
        args: Optional[Dict[str, Any]] = None,
        *,
        delivery: Optional[str] = None,
        deadline_seconds: Optional[float] = None,
        timeout_seconds: Optional[float] = None,
        blocking: bool = False,
    ) -> Dict[str, Any]:
        delivery = delivery or with_invocations.delivery_for(name)
        self.store.create(
            invocation_id,
            kind="call",
            name=name,
            delivery=delivery,
            backend="temporal",
            params=args,
            state=with_invocations.RUNNING,
            blocking=blocking,
            workflow_id=workflow_id(invocation_id),
        )
        spec = {
            "id": invocation_id,
            "name": name,
            "args": args or {},
            "delivery": delivery,
            "deadline_seconds": deadline_seconds,
            "timeout_seconds": timeout_seconds,
            "job_dir": self.store.job_dir,
        }
        try:
            handle = await self.client.start_workflow(
                "harness.invocation", spec, id=workflow_id(invocation_id), task_queue=self.task_queue)
        except WorkflowAlreadyStartedError:
            # The same invocation again (a retry, a second host): attach, never start another.
            handle = self.client.get_workflow_handle(workflow_id(invocation_id))
        return await handle.result()


def _require() -> None:
    if not AVAILABLE:
        raise RuntimeError(
            "the temporal invocation backend needs `pip install temporalio`; it is optional and off by default"
        )
