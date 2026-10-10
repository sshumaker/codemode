"""
Submit one invocation through the Temporal backend, the way a host does, and print its
outcome event as JSON once the workflow reports it.

    python submit.py <address> <task_queue> <job_dir> <invocation_id> <tool> <delivery> <args-json> <timeout_s>

The record is created in <job_dir>'s invocation store before the workflow starts; the
workflow's report activity — not this process — writes the outcome, so the outcome is
durable even if this process is gone by then.
"""

import asyncio
import json
import sys

from temporalio.client import Client

import invocations as I
import invocations_temporal as T


async def main(address, queue, job_dir, inv_id, tool, delivery, args, timeout_s):
    client = await Client.connect(address)
    backend = T.TemporalBackend(client, I.InvocationStore(job_dir), task_queue=queue)
    out = await backend.submit(inv_id, tool, json.loads(args), delivery=delivery, timeout_seconds=float(timeout_s))
    print(json.dumps(out), flush=True)


if __name__ == "__main__":
    asyncio.run(main(*sys.argv[1:9]))
