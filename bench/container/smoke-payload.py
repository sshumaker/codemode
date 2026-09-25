#!/usr/bin/env python3
"""In-container half of bench/container/smoke.sh. Fed on stdin, not as a mount.

Five assertions, each one a property the container exists to provide:

  (a) a tool call reaches the HOST-side forwarder and comes back
  (b) a host binary does not exist inside
  (c) a host path outside the mounts is unreachable
  (d) the mounted api/ tree is read-only
  (e) the job dir is writable

(b) and (c) are the ones that replace HARNESS_EXEC_GUARD / HARNESS_FS_GUARD:
a cell that greps for opsctl fails because the binary is not there,
not because a regex caught the string.
"""
import json
import os
import shutil
import sys
import urllib.request

fails = []

# (a) the tool transport reaches the host forwarder.
proxy = os.environ["HARNESS_MCP_PROXY"]
request = urllib.request.Request(
    proxy,
    data=json.dumps({"server": "s", "tool": "judge_tool", "args": {}}).encode(),
    headers={"content-type": "application/json"},
    method="POST",
)
try:
    body = json.loads(urllib.request.urlopen(request, timeout=10).read())
except Exception as exc:  # noqa: BLE001 - the failure text is the result
    body = {"error": f"{type(exc).__name__}: {exc}"}
print("(a) forwarder:", body)
if body.get("text") != "forwarded:judge_tool":
    fails.append("(a) forwarder hop failed")

# (b) host binaries simply are not here. shutil.which, not `which`: the slim
# base has no /usr/bin/which, and a missing which would pass this vacuously.
absent = []
for binary in ("opsctl", "colima", "brew", "osascript", "security"):
    found = shutil.which(binary)
    if found:
        fails.append(f"(b) {binary} EXISTS inside the container at {found}")
    else:
        absent.append(binary)
print("(b) host binaries absent:", ", ".join(absent))

# (c) host paths outside the mounts are unreachable.
unreachable = []
for path in (
    "/Users/scottshumaker/src/harness",
    "/Users/scottshumaker/.prime/agent",
    "/Users/scottshumaker/.claude",
    "/etc/colima",
):
    if os.path.exists(path):
        fails.append(f"(c) {path} is visible inside the container")
    else:
        unreachable.append(path)
print("(c) host paths unreachable:", len(unreachable), "of 4")

# (d) the api/ mount is readable and read-only.
try:
    open("api/INDEX.md").read()
except OSError as exc:
    fails.append(f"(d) api/ was not readable: {exc}")
try:
    with open("api/INDEX.md", "w") as fh:
        fh.write("x")
    fails.append("(d) api/ was WRITABLE")
except OSError:
    print("(d) api/ readable, read-only")

# (e) the job dir is writable.
try:
    with open("scratch.txt", "w") as fh:
        fh.write("ok")
    os.unlink("scratch.txt")
    print("(e) job dir writable")
except OSError as exc:
    fails.append(f"(e) job dir was not writable: {exc}")

if fails:
    print("FAIL:")
    for line in fails:
        print("   ", line)
    sys.exit(1)
print("PASS: 5/5")
