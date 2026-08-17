"""
The control for scripts/egress-unix-linux-proof.sh: both doors, NOT sandboxed.

    python3 egress-unix-probe-control.py <token> [unix|tcp ...]

"The sandbox could not reach the proxy" means nothing on its own — a proxy that
died, a port nothing listens on and an enforced boundary all produce the same
transcript, and this project has already reported the first as the third. So the
same two addresses are exercised from an ordinary process in the same container:
both must answer, which makes the sandboxed TCP failure attributable to the
network namespace rather than to a dead proxy.
"""

import json
import os
import sys

sys.path.insert(0, "/host/runtime")
import jobs  # noqa: E402

token = sys.argv[1]
doors = sys.argv[2:] or ["unix", "tcp"]
headers = {"Content-Type": "application/json", "x-egress-token": token}
bad = 0
attempt = 0

DOORS = {
    "unix": ("unix socket", "unix:/work/run/egress.sock"),
    "tcp": ("TCP loopback", "http://127.0.0.1:8099"),
}

for door in doors:
    label, url = DOORS[door]
    # A fresh name per attempt AND per process: the proxy is idempotent by name, so
    # a name this rig has used before answers 200 already_requested — which would
    # report the previous run's POST as this one's success.
    attempt += 1
    name = f"control-{door}-{os.getpid()}-{attempt}"
    body = json.dumps({"name": name, "body": {"cmd": "echo hi", "control": True}}).encode()
    try:
        status, reason = jobs._egress_post(url, "/control/spawn", body, headers, timeout=8)
        ok = status == 201
        print(f"{'PASS' if ok else 'FAIL'}  {label:<14} {status} {reason}")
        bad += 0 if ok else 1
    except OSError as exc:
        print(f"FAIL  {label:<14} unreachable: {exc}")
        bad += 1

sys.exit(1 if bad else 0)
