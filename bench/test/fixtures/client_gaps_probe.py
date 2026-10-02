"""Drive a generated `_client` through every route against a stub proxy that records.

Run as: python3 client_gaps_probe.py <dir-containing-api>

Prints one JSON object: `requests` (method, path, lowercased headers, parsed body for
every request the stub saw) and `outcomes` (per scenario, the exception type and
message, or "ok"). HARNESS_EGRESS_TOKEN is set before import, so every route should
carry it.
"""

import asyncio
import contextlib
import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = sys.argv[1]
seen: list = []

RESULTS = {
    "start_job": {"job_id": "job_ref_1"},
    "legacy_job": {"job": "job_ref_legacy"},
    "make_image": {"asset_id": "img_1"},
    "echo": {"text": "hi"},
}


class Handler(BaseHTTPRequestHandler):
    def _record(self, body):
        seen.append(
            {
                "method": self.command,
                "path": self.path,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": body,
            }
        )

    def _send(self, obj):
        out = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        self._record(body)
        if self.path == "/call":
            self._send({"ok": True, "text": json.dumps(RESULTS.get(body["tool"], {}))})
        elif self.path == "/spawn":
            self._send({"ok": True, "name": "judge_1", "kind": "judge"})
        elif "img_failed" in body.get("assets", []):
            pending = [a for a in body["assets"] if a != "img_failed"]
            self._send(
                {
                    "ready": False,
                    "waiting_on": pending,
                    "failed": [{"id": "img_failed", "reason": "upstream auth failed"}],
                }
            )
        elif "artifact:img_described" in body.get("assets", []):
            self._send(
                {
                    "ready": True,
                    "failed": [],
                    "facts": [
                        {"id": "image:img_described", "kind": "image", "content_type": "image/png", "width": 1024, "height": 768},
                        {"id": "video:vid_1", "kind": "video", "content_type": "video/mp4", "width": 1280, "height": 720, "duration_s": 5.0},
                        {"id": "doc:doc_1", "kind": "document"},
                    ],
                }
            )
        else:
            self._send({"ready": True, "failed": []})

    def do_GET(self):
        self._record(None)
        self._send({"state": "done", "text": "{}"})

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ["HARNESS_MCP_PROXY"] = f"http://127.0.0.1:{server.server_port}"
os.environ["HARNESS_EGRESS_TOKEN"] = "tok-123"

sys.path.insert(0, ROOT)
import api  # noqa: E402
import api._client as client  # noqa: E402
import api.jobs  # noqa: E402
import api.session  # noqa: E402

outcomes: dict = {}


printed: dict = {}


def attempt(label, fn):
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            fn()
        outcomes[label] = "ok"
    except BaseException as exc:  # noqa: BLE001 - the probe reports every outcome
        outcomes[label] = f"{type(exc).__name__}: {exc}"
    printed[label] = out.getvalue()


async def main():
    job = await api.jobs.start_job(prompt="p")
    legacy = await api.jobs.legacy_job(prompt="p")
    image = await api.session.make_image(prompt="p")
    attempt("wait_job_record", lambda: client.wait_for(job))
    attempt("wait_legacy_job_record", lambda: client.wait_for(legacy))
    attempt("wait_job_id_dict", lambda: client.wait_for({"job_id": "job_dict_1"}))
    attempt("wait_mixed_list", lambda: client.wait_for([image, job, "img_bare", {"job_id": "job_dict_2"}]))
    attempt("wait_unrecognised", lambda: client.wait_for(42))
    attempt("wait_failed", lambda: client.wait_for("img_failed"))
    attempt("wait_failed_and_pending", lambda: client.wait_for(["img_pending", "img_failed"]))
    attempt("wait_ready_plain", lambda: client.wait_for("img_plain"))
    attempt("wait_ready_with_facts", lambda: client.wait_for(["artifact:img_described", "vid_1", "doc_1", "job:j_done"]))
    try:
        await api.session.echo(text=5)
        outcomes["argument_error"] = "ok"
    except BaseException as exc:  # noqa: BLE001
        outcomes["argument_error"] = f"{type(exc).__name__}: {exc}"
    handle = api.jobs.spawn_judge(prompt="p")
    attempt("job_status", lambda: handle.state)


asyncio.run(main())
print(json.dumps({"requests": seen, "outcomes": outcomes, "printed": printed}))
