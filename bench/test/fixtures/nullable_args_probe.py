"""Send optional, explicit-None and nullable arguments through a generated `_client`.

Run as: python3 nullable_args_probe.py <dir-containing-api> <module>

Prints one JSON object: `sent` (the args of every /call the stub saw, in order),
`signature` (str(inspect.signature) of the wrapper) and `outcomes`.
"""

import asyncio
import importlib
import inspect
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT, MODULE = sys.argv[1], sys.argv[2]
sent: list = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        sent.append(body["args"])
        out = json.dumps({"ok": True, "text": json.dumps({"text": "ok"})}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ["HARNESS_MCP_PROXY"] = f"http://127.0.0.1:{server.server_port}"

sys.path.insert(0, ROOT)
import api._client as client  # noqa: E402

module = importlib.import_module(MODULE)
outcomes: dict = {}


async def attempt(label, coro):
    try:
        await coro
        outcomes[label] = "ok"
    except BaseException as exc:  # noqa: BLE001 - the probe reports every outcome
        outcomes[label] = f"{type(exc).__name__}: {exc}"


async def main():
    await attempt("explicit_none", module.gen("a", note=None, count=None))
    await attempt("omitted", module.gen("b"))
    await attempt("generic_call", client.call("maker", "gen", {"prompt": "c", "note": None}))
    await attempt("generic_non_nullable", client.call("maker", "gen", {"prompt": "d", "count": None}))


asyncio.run(main())
print(json.dumps({"sent": sent, "signature": str(inspect.signature(module.gen)), "outcomes": outcomes}))
