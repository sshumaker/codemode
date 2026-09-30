"""Fire N calls through a generated `_client.call` with asyncio.gather and time them.

Run as: python3 concurrent_calls_probe.py <dir-containing-api> <n> <delay_s>

Prints `<calls> <elapsed_s> <peak_in_flight>`. The stub proxy is threaded and holds
every /call for delay_s, so concurrent calls finish in about one delay and serial
ones in n of them.
"""

import asyncio
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT, N, DELAY = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])

lock = threading.Lock()
state = {"calls": 0, "in_flight": 0, "peak": 0}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers["content-length"]))
        with lock:
            state["calls"] += 1
            state["in_flight"] += 1
            state["peak"] = max(state["peak"], state["in_flight"])
        time.sleep(DELAY)
        with lock:
            state["in_flight"] -= 1
        out = json.dumps({"ok": True, "text": "RESULT"}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
# _client reads the proxy address at import time, so it has to be set first.
os.environ["HARNESS_MCP_PROXY"] = f"http://127.0.0.1:{server.server_port}"

sys.path.insert(0, ROOT)
import api._client as client  # noqa: E402


async def main():
    start = time.monotonic()
    results = await asyncio.gather(*(client.call("svc", "make_thing", {"prompt": str(i)}) for i in range(N)))
    elapsed = time.monotonic() - start
    assert all(str(r) == "RESULT" for r in results), results
    print(state["calls"], f"{elapsed:.3f}", state["peak"])


asyncio.run(main())
