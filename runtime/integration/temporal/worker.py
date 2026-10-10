"""
An invocation worker for the integration tier: runtime/invocations_temporal.make_worker
with two test tools, run as its own process so a test can SIGKILL it mid-activity.

    python worker.py <address> <task_queue> <ledger.jsonl>

Every attempt appends {"event": "start"|"done", "key", "pid", "tool"} to the ledger
BEFORE and AFTER its work: the ledger is how a test sees how many times a tool was
actually sent, and under which idempotency key, across worker deaths.
"""

import asyncio
import json
import os
import sys

from temporalio.client import Client

import invocations_temporal as T


def main(address: str, queue: str, ledger: str) -> None:
    def note(event: str, key: str, tool: str) -> None:
        with open(ledger, "a") as fh:
            fh.write(json.dumps({"event": event, "key": key, "pid": os.getpid(), "tool": tool}) + "\n")
            fh.flush()
            os.fsync(fh.fileno())

    def slow(tool: str):
        async def run(args, key):
            note("start", key, tool)
            await asyncio.sleep(float(args.get("seconds", 3)))
            note("done", key, tool)
            return f"{tool}-done"

        return run

    async def serve() -> None:
        client = await Client.connect(address)
        worker = T.make_worker(client, {"itest.slow": slow("itest.slow"), "itest.once": slow("itest.once")},
                               task_queue=queue)
        print("worker ready", flush=True)
        await worker.run()

    asyncio.run(serve())


if __name__ == "__main__":
    main(*sys.argv[1:4])
