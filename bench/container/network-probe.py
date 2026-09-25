#!/usr/bin/env python3
"""Four reachability probes, run inside the container by network-posture.sh.

REACHED / BLOCKED is decided at the *network* layer, not the application one: an
HTTP 401 from api.anthropic.com means the packet arrived and the boundary did not
hold. Classifying that as BLOCKED because the status code was not 200 is how a
run gets reported as sandboxed when it is not.
"""
import os
import socket
import sys
import urllib.error
import urllib.request

PORT = int(os.environ.get("PROBE_PORT", "0"))
# Which name carries the tool hop. host.docker.internal on the default bridge;
# the sidecar container's name when the runtime is on an --internal network.
HOP_HOST = os.environ.get("PROBE_HOST", "host.docker.internal")


def probe(name, fn):
    try:
        fn()
        verdict, detail = "REACHED", ""
    except urllib.error.HTTPError as exc:
        # The server answered. Reached.
        verdict, detail = "REACHED", f"(HTTP {exc.code})"
    except Exception as exc:  # noqa: BLE001 — the exception type is the evidence
        verdict, detail = "BLOCKED", f"{type(exc).__name__}: {str(exc)[:60]}"
    print(f"  {name:<28} {verdict:<8} {detail}")
    return verdict == "REACHED"


reached = {
    "dns": probe("dns example.com", lambda: socket.gethostbyname("example.com")),
    "raw": probe("tcp 1.1.1.1:443", lambda: socket.create_connection(("1.1.1.1", 443), 5).close()),
    "api": probe(
        "https api.anthropic.com",
        lambda: urllib.request.urlopen("https://api.anthropic.com/v1/models", timeout=8),
    ),
    "host": probe(
        f"tool hop {HOP_HOST}",
        lambda: socket.create_connection((HOP_HOST, PORT), 5).close(),
    ),
}

outbound = reached["dns"] or reached["raw"] or reached["api"]
print(f"  => outbound {'OPEN' if outbound else 'DENIED'}, "
      f"host hop {'UP' if reached['host'] else 'DOWN'}")
sys.exit(0)
