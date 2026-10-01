"""Pass typed results to adapted parameters of a generated `_client`, against a recording stub.

Run as: python3 adapters_accept_results_probe.py <dir-containing-api>

Prints one JSON object: `requests` (parsed body of every /call the stub saw) and
`outcomes` (per scenario, the exception type and message, or "ok").
"""

import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = sys.argv[1]
seen: list = []

RESULTS = {
    "make_image": [{"asset_id": "img_1"}, {"asset_id": "img_2"}],
}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        seen.append(body)
        result = RESULTS.get(body["tool"], [{}])
        payload = result.pop(0) if len(result) > 1 else result[0]
        out = json.dumps({"ok": True, "text": json.dumps(payload)}).encode()
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
import api  # noqa: E402
import api.session  # noqa: E402

outcomes: dict = {}


async def attempt(label, coro):
    try:
        await coro
        outcomes[label] = "ok"
    except BaseException as exc:  # noqa: BLE001 - the probe reports every outcome
        outcomes[label] = f"{type(exc).__name__}: {exc}"


async def main():
    first = await api.session.make_image(prompt="p")
    second = await api.session.make_image(prompt="p")
    await attempt("labeled_results", api.session.judge(assets=[first, second]))
    await attempt("labeled_mixed", api.session.judge(assets=[first, "img_bare", {"label": "hero", "asset_id": second}]))
    await attempt("labeled_dict_results", api.session.judge(assets={"hero": first}))
    await attempt("singleton_result", api.session.wait_ids(ids=first))
    await attempt("singleton_mixed", api.session.wait_ids(ids=[first, "img_bare"]))
    await attempt("singleton_unrecognised", api.session.wait_ids(ids=5))


asyncio.run(main())
print(json.dumps({"requests": [b for b in seen if b["tool"] != "make_image"], "outcomes": outcomes}))
