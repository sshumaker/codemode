"""
What a bwrap-sandboxed process can and cannot reach, run from INSIDE the sandbox.

    python3 egress-unix-probe.py <runtime-dir> <unix:socket> <token> <tcp-url>

Four claims, printed with their evidence and exiting non-zero if any of them is
false (docs/CLOUD-HARNESS-DESIGN.md §7.2):

  1. the run's token over the unix socket   -> 201, and the request file appears
  2. a wrong token over the same socket     -> 401 (the socket is not authority)
  3. the proxy's TCP loopback address       -> unreachable (bwrap's netns)
  4. api.anthropic.com                      -> refused (no second route out)

(3) is the point of the whole exercise, so it is asserted rather than assumed:
the harness's 127.0.0.1 is not the sandbox's, which is why a socket is needed at
all. The caller checks separately that the SAME port answers from outside the
sandbox — without that control, a dead proxy would produce this transcript too.

The POSTs go through runtime/jobs.py's own client (`_egress_post`), not a local
reimplementation of it: what has to be certified is the thing `spawn()` uses.
"""

import json
import sys
import urllib.error
import urllib.request

runtime_dir, unix_url, token, tcp_url = sys.argv[1:5]
sys.path.insert(0, runtime_dir)
import jobs  # noqa: E402  (the path has to be set first)

failures = []


def check(label, ok, detail):
    print(f"{'PASS' if ok else 'FAIL'}  {label:<34} {detail}")
    if not ok:
        failures.append(label)


def spawn(url, tok, name):
    body = json.dumps({"name": name, "body": {"cmd": "echo hi", "probe": True}}).encode()
    headers = {"Content-Type": "application/json"}
    if tok is not None:
        headers["x-egress-token"] = tok
    return jobs._egress_post(url, "/control/spawn", body, headers, timeout=8)


# 1 + 2: the door, and the lock on it.
try:
    status, reason = spawn(unix_url, token, "probe-child")
    check("unix socket, run's token", status == 201, f"{status} {reason}")
except OSError as exc:
    check("unix socket, run's token", False, f"unreachable: {exc}")

for label, tok in (("unix socket, wrong token", "egr-not-the-token"), ("unix socket, no token", None)):
    try:
        status, reason = spawn(unix_url, tok, "probe-sneak")
        check(label, status == 401, f"{status} {reason}")
    except OSError as exc:
        check(label, False, f"unreachable: {exc}")

# 3: the reason this transport exists.
try:
    status, reason = spawn(tcp_url, token, "probe-tcp")
    check("proxy over TCP loopback", False, f"answered {status} {reason} — the netns claim is wrong")
except OSError as exc:
    check("proxy over TCP loopback", True, f"unreachable: {exc}")

# 4: no second route out. A real answer from the provider (401 without a key, or
# any 2xx) would mean the sandbox reaches the internet; srt's own refusal or a
# connection error is the passing outcome.
try:
    resp = urllib.request.urlopen("https://api.anthropic.com/v1/models", timeout=10)
    check("api.anthropic.com", False, f"answered {resp.status} — the sandbox reaches the internet")
except urllib.error.HTTPError as exc:
    exc.close()
    check("api.anthropic.com", exc.code not in (200, 401), f"HTTP {exc.code} {exc.reason}")
except Exception as exc:  # URLError, socket errors, srt's own refusal
    check("api.anthropic.com", True, f"refused: {type(exc).__name__}: {exc}")

print(f"\n{len(failures)} failed" if failures else "\nall four claims hold")
sys.exit(1 if failures else 0)
