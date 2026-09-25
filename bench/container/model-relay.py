#!/usr/bin/env python3
"""Host-side model relay for the containerized runtime. PROTOTYPE.

Why this exists at all, and why it is NOT proxy/egress
-----------------------------------------------------
proxy/egress refuses at config-load to route to any model provider
(`isProviderHost`, main.go:204): "Intelligence reaches the sandbox as spawn() — a
subagent the harness starts, budgeted and traced — not as a provider call from a
cell." That guard is right for the deployed shape, where the *harness* is on the
host and only cells are sandboxed.

The containerized runtime moves the harness inside the boundary, so prime's own
provider traffic has to leave the container, and the egress proxy will not carry
it. This relay carries exactly that one flow and nothing else. It is a separate
binary on purpose: the guard in proxy/egress stays intact.

What it buys, honestly
----------------------
The model key never enters the container — the container gets this relay's
per-run token instead. That kills key *exfiltration* (a cell reading
/proc/self/environ gets a token scoped to one run, which the harness can revoke,
budget and audit). It does NOT stop a cell from spending model budget through
the relay: inside the container, whatever the harness can reach a cell can reach.
Only a second boundary between harness and cell restores that, and this
prototype does not have one. See docs/CONTAINER-RUNTIME-DESIGN.md.

Usage: model-relay.py --token <tok> --port-file <path> [--audit <jsonl>]
       ANTHROPIC_API_KEY read from this process's env, once, at startup.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "https://api.anthropic.com"
# Hop-by-hop plus the ones we replace. The client's credential header is dropped
# and re-set from the host's env: whatever the container sent is only a token.
DROP = {"host", "connection", "keep-alive", "transfer-encoding", "content-length",
        "x-api-key", "authorization", "proxy-authorization", "te", "trailer", "upgrade",
        # urllib does not decompress, so a forwarded accept-encoding would hand the
        # SDK gzipped bytes labelled text/event-stream. Measured: the turn came back
        # 200 with empty content, zero usage and stopReason "stop" — a success-shaped
        # failure, exactly the kind this repo keeps getting bitten by.
        "accept-encoding"}


def make_handler(api_key, token, audit_path):
    class Relay(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _audit(self, status, nbytes, started):
            if not audit_path:
                return
            row = {"ts": time.time(), "method": self.command, "path": self.path,
                   "status": status, "bytes": nbytes, "ms": round((time.time() - started) * 1000)}
            with open(audit_path, "a") as fh:
                fh.write(json.dumps(row) + "\n")

        def _deny(self, code, message):
            body = json.dumps({"type": "error", "error": {"type": "relay", "message": message}}).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _relay(self):
            started = time.time()
            # The token is the container's whole authority. Accept it in either
            # header an unmodified SDK would use, so nothing in prime has to know
            # this relay exists.
            presented = self.headers.get("x-api-key") or ""
            bearer = self.headers.get("authorization") or ""
            if bearer.lower().startswith("bearer "):
                presented = presented or bearer[7:]
            if presented != token:
                self._deny(403, "bad or missing relay token")
                self._audit(403, 0, started)
                return

            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length) if length else None
            headers = {k: v for k, v in self.headers.items() if k.lower() not in DROP}
            headers["x-api-key"] = api_key
            headers["accept-encoding"] = "identity"
            request = urllib.request.Request(UPSTREAM + self.path, data=body,
                                             headers=headers, method=self.command)
            try:
                upstream = urllib.request.urlopen(request, timeout=600)
                status = upstream.status
            except urllib.error.HTTPError as exc:
                upstream, status = exc, exc.code
            except Exception as exc:  # noqa: BLE001 — surfaced to the client as a 502
                self._deny(502, f"upstream unreachable: {type(exc).__name__}: {exc}")
                self._audit(502, 0, started)
                return

            # Streamed, not buffered. Prime asks for stream:true and the latency
            # this whole file exists to let us measure is time-to-first-cell;
            # buffering the response would fold the model's entire generation into
            # it and quietly inflate every number.
            self.send_response(status)
            self.send_header("content-type", upstream.headers.get("content-type", "application/json"))
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            total = 0
            try:
                while True:
                    chunk = upstream.read(8192)
                    if not chunk:
                        break
                    total += len(chunk)
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            finally:
                upstream.close()
            self._audit(status, total, started)

        do_POST = do_GET = _relay

        def log_message(self, *args):
            pass

    return Relay


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--token", required=True)
    parser.add_argument("--port-file", required=True)
    parser.add_argument("--audit", default="")
    args = parser.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        sys.exit("model-relay: ANTHROPIC_API_KEY not set in the relay's own env")

    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(api_key, args.token, args.audit))
    with open(args.port_file, "w") as fh:
        fh.write(str(server.server_port))
    server.serve_forever()


if __name__ == "__main__":
    main()
