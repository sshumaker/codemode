"""Shared Daytona helpers for the remote-kernel spike. Reads DAYTONA_* from env only."""
import os
from daytona import AsyncDaytona, DaytonaConfig, ListSandboxesQuery

LABELS = {"purpose": "harness-remote-kernel-spike", "owner": "scott"}


def client() -> AsyncDaytona:
    return AsyncDaytona(DaytonaConfig(
        api_key=os.environ["DAYTONA_API_KEY"],
        api_url=os.environ.get("DAYTONA_API_URL") or None,
        target=os.environ.get("DAYTONA_TARGET") or "us",
    ))


async def list_spike(d: AsyncDaytona):
    return [s async for s in d.list(ListSandboxesQuery(labels=LABELS))]
