#!/usr/bin/env python3
"""Host-side stand-in for the MCP forwarder, for bench/container/smoke.sh.

Binds 127.0.0.1 on an ephemeral port and writes the port to argv[1] so the
caller does not have to guess one. Answers the same shape bench/mcp-shim.mjs
posts to `$HARNESS_MCP_PROXY/call`: {server, tool, args} -> {ok, text}.

Its only job in the smoke test is to prove the hop exists: a process bound to
host loopback, reached from inside the container over host.docker.internal.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        out = json.dumps({"ok": True, "text": f"forwarded:{body['tool']}"}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


def main():
    server = HTTPServer(("127.0.0.1", 0), Handler)
    port_file = sys.argv[1]
    # Written last and in one shot: the caller polls for a non-empty file, so a
    # partial write would hand it a truncated port number.
    with open(port_file, "w") as fh:
        fh.write(str(server.server_port))
    server.serve_forever()


if __name__ == "__main__":
    main()
