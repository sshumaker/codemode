"""Drive the compiled wait tool against a stub proxy and a stub hosted runtime.

Run as: python3 wait_bridge_probe.py <dir-containing-api>

What this pins is the property the design rests on: **no cell ever blocks**. The
harness's wait primitive ends the cell and lets the HOST spend the wall-clock with
the kernel released (runtime/jobs.py), so the compiled wrapper must hand back
control in milliseconds no matter how long the caller asked to wait. A wrapper that
slept in-kernel would pass every assertion about arguments and still be the exact
thing the affordance doctrine forbids — hence the wall-clock assertion.

The `jobs` module is stubbed rather than imported: this is the seam where the
kernel's hosted runtime would be, and stubbing it also lets the last case prove the
wrapper degrades to today's behaviour in a kernel that has no `jobs` at all.
"""

import asyncio
import json
import os
import sys
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = sys.argv[1]
CALLS = []


# What the stub answers next: the shapes from real streams (resolved / suspended)
# plus one the wrapper has never seen, which must be surfaced rather than guessed.
REPLY = {"text": json.dumps({"suspended": True})}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        CALLS.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
        out = json.dumps({"ok": True, "text": REPLY["text"]}).encode()
        self.send_response(200)
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ["HARNESS_MCP_PROXY"] = f"http://127.0.0.1:{server.server_port}"

sys.path.insert(0, ROOT)
import api._client as client  # noqa: E402
import api.agent_tools as lat  # noqa: E402


class WaitSignal(BaseException):
    """The real one is runtime/jobs.py's: control flow, not an error."""


WAITS = []


def install_jobs():
    """A stand-in for the kernel prelude's `jobs`, recording the wake request."""
    module = types.ModuleType("jobs")

    def wait(wake_after=None):
        WAITS.append(wake_after)
        raise WaitSignal(wake_after)

    module.wait = wait
    module.WaitSignal = WaitSignal
    sys.modules["jobs"] = module


def check(condition, message):
    if not condition:
        raise SystemExit(f"FAIL: {message}")


async def main():
    install_jobs()

    # --- the gate is OFF: the tree behaves exactly as it always did ------------
    os.environ.pop("HARNESS_WAIT_BRIDGE", None)
    before = len(CALLS)
    try:
        await lat.wait_for_assets(ids=["a1"], max_timeout=300, reason="r")
        raise SystemExit("FAIL: 300 was accepted with the bridge off")
    except client.ArgumentError as exc:
        check("max_timeout must be <= 60" in str(exc), f"wrong error with the bridge off: {exc}")
    check(len(CALLS) == before, "a refused call reached the transport")
    check(WAITS == [], "the bridge waited with the gate off")

    # --- the gate is ON: one legal hop, then the cell ends ---------------------
    os.environ["HARNESS_WAIT_BRIDGE"] = "1"
    started = time.monotonic()
    try:
        await lat.wait_for_assets(ids=["a1"], max_timeout=300, reason="r")
        raise SystemExit("FAIL: the cell did not end at the wait")
    except WaitSignal:
        pass
    elapsed = time.monotonic() - started
    # The whole design: the kernel is released, the HOST spends the time. A wrapper
    # that slept here would hold a single-threaded kernel and hit the cell ceiling.
    check(elapsed < 1.0, f"the cell blocked for {elapsed:.1f}s instead of yielding")
    check(len(CALLS) == before + 1, f"expected one hop, got {len(CALLS) - before}")
    sent = CALLS[-1]["args"]
    check(sent["max_timeout"] == 60, f"the hop exceeded the server's cap: {sent!r}")
    check(sent["ids"] == ["a1"] and sent["reason"] == "r", f"the hop altered other arguments: {sent!r}")
    check(WAITS == [240.0], f"the remaining time was not handed to the host: {WAITS!r}")

    # --- a request within the cap is untouched, and never yields ---------------
    WAITS.clear()
    before = len(CALLS)
    text = await lat.wait_for_assets(ids=["a1"], max_timeout=30, reason="r")
    check(json.loads(text) == {"suspended": True}, f"the result was altered: {text!r}")
    check(len(CALLS) == before + 1 and CALLS[-1]["args"]["max_timeout"] == 30, "a short wait was rewritten")
    check(WAITS == [], "a wait within the cap ended the cell")

    # --- a kernel with no hosted runtime degrades to the hop -------------------
    del sys.modules["jobs"]
    WAITS.clear()
    text = await lat.wait_for_assets(ids=["a1"], max_timeout=300, reason="r")
    check(json.loads(text) == {"suspended": True}, f"degraded path altered the result: {text!r}")
    check(WAITS == [], "waited without a jobs module")

    install_jobs()

    # --- resolved on the first hop: no yield at all, one turn total -----------
    RESOLVED = json.dumps(
        {"results": [{"asset_id": "a1", "state": "completed", "type": "image/png"}], "completed": True}
    )
    REPLY["text"] = RESOLVED
    WAITS.clear()
    before = len(CALLS)
    text = await lat.wait_for_assets(ids=["a1"], max_timeout=300, reason="r")
    check(text == RESOLVED, f"a resolved wait altered the result: {text!r}")
    check(WAITS == [], "a resolved wait yielded the REPL anyway")
    check(len(CALLS) == before + 1, "a resolved wait hopped more than once")

    # `completed: false` is the other in-flight spelling and must still yield.
    REPLY["text"] = json.dumps({"completed": False})
    try:
        await lat.wait_for_assets(ids=["a1"], max_timeout=300, reason="r")
        raise SystemExit("FAIL: completed=false did not yield")
    except WaitSignal:
        pass
    check(WAITS == [240.0], f"the remaining time was wrong: {WAITS!r}")

    # --- a shape the wrapper has never seen is surfaced, never guessed --------
    for unknown in ['{"status": "queued"}', "not json at all", "[]"]:
        REPLY["text"] = unknown
        WAITS.clear()
        text = await lat.wait_for_assets(ids=["a1"], max_timeout=300, reason="r")
        check(text == unknown, f"an unknown shape was altered: {text!r}")
        check(WAITS == [], f"an unknown shape was treated as in flight: {unknown!r}")


asyncio.run(main())
print("OK")
