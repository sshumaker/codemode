"""
Record every HTTP call the agent makes to the company's services.

Runs inside the task container as a **forward proxy**, and the agent's process is
given `http_proxy`/`HTTP_PROXY`. Both `requests` (trust_env) and `curl` honour
that, so ordinary agent code needs no changes; calls arrive here, are logged, and
are forwarded unchanged.

A transparent port-shadowing proxy was tried first and cannot work here: the
container runs on --network host and the services bind 0.0.0.0, so every
loopback address:port is already occupied — 127.0.0.2:3000 included.

Why this exists
---------------
Without it the only record of a service interaction is the agent's own code plus
whatever it chose to `print`. If it doesn't print a response, the response is
gone — and the services are wiped by the next task's reset.sh, so it cannot be
recovered afterwards. That is the same gap that made one disputed checkpoint
permanently undiagnosable: two arms posted byte-identical text, one passed and
one failed, and the deciding input had never been written down.

MCP-Bench had this (mcp-calls.jsonl, via the proxy). TheAgentCompany had nothing.

It is also the seam where credential injection belongs: the agent would hold a
handle, and this process would attach the real token per host. Nothing here does
that yet, but the placement is deliberate.

Design notes
------------
- Streams bodies rather than buffering: ownCloud serves multi-MB xlsx/PDF files
  and WebDAV, and buffering would change behaviour under test.
- Bodies are truncated in the log with the true length recorded, so a large
  download costs a bounded number of bytes on disk.
- Authorization / X-Auth-Token / cookies are redacted. The point is to see the
  conversation, not to copy secrets into the run directory — the benchmark
  already leaks enough of those.
"""

import http.server
import json
import os
import socket
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.request

LOG_PATH = os.environ.get("HARNESS_SERVICE_LOG", "/tmp/service-calls.jsonl")
LISTEN_PORT = int(os.environ.get("HARNESS_PROXY_PORT", "18080"))
MAX_BODY_LOG = int(os.environ.get("HARNESS_MAX_BODY_LOG", "4000"))

REDACT = {"authorization", "x-auth-token", "x-user-id", "cookie", "set-cookie", "private-token", "x-api-key"}
_write_lock = threading.Lock()


def clip(raw: bytes):
    """Return (text, original_length). Bodies can be megabytes; the log cannot."""
    if raw is None:
        return None, 0
    n = len(raw)
    head = raw[:MAX_BODY_LOG]
    try:
        text = head.decode("utf-8", "replace")
    except Exception:
        text = repr(head[:200])
    return text, n


def safe_headers(items):
    return {k: ("<redacted>" if k.lower() in REDACT else v) for k, v in items}


def record(entry):
    with _write_lock:
        try:
            with open(LOG_PATH, "a") as fh:
                fh.write(json.dumps(entry) + "\n")
        except Exception:
            # Logging must never break the run it is observing.
            pass


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # silence stderr spam
        pass

    def _proxy(self):
        started = time.time()
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        # Forward-proxy request lines carry the absolute URI.
        url = self.path if self.path.startswith("http") else f"http://127.0.0.1{self.path}"
        req = urllib.request.Request(url=url, data=body, method=self.command)
        for k, v in self.headers.items():
            if k.lower() in ("host", "connection", "content-length"):
                continue
            req.add_header(k, v)

        entry = {
            "t": time.time(),
            "method": self.command,
            "url": url,
            "request_headers": safe_headers(self.headers.items()),
        }
        entry["request_body"], entry["request_body_len"] = clip(body)

        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                payload = resp.read()
                status, headers = resp.status, list(resp.headers.items())
        except urllib.error.HTTPError as e:
            payload = e.read()
            status, headers = e.code, list(e.headers.items())
        except Exception as e:
            entry.update({"status": None, "error": f"{type(e).__name__}: {e}",
                          "seconds": round(time.time() - started, 3)})
            record(entry)
            self.send_error(502, "proxy upstream failure")
            return

        entry["status"] = status
        entry["response_headers"] = safe_headers(headers)
        entry["response_body"], entry["response_body_len"] = clip(payload)
        entry["seconds"] = round(time.time() - started, 3)
        record(entry)

        self.send_response(status)
        for k, v in headers:
            if k.lower() in ("transfer-encoding", "connection", "content-length"):
                continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _proxy
    # WebDAV, which ownCloud uses for file listings and uploads.
    do_PROPFIND = do_MKCOL = do_MOVE = do_COPY = do_OPTIONS = do_LOCK = do_UNLOCK = _proxy


class Threaded(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    address_family = socket.AF_INET


if __name__ == "__main__":
    Threaded(("127.0.0.1", LISTEN_PORT), Handler).serve_forever()
