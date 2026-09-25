#!/usr/bin/env bash
# Boundary smoke: the five properties the container exists to provide.
#
# (a) a tool call reaches a HOST-side forwarder and comes back
# (b) a host binary does not exist inside
# (c) a host path outside the mounts is unreachable
# (d) the mounted api/ tree is read-only
# (e) the job dir is writable
#
# Runs on python:3.11-slim by default as a STAND-IN base — (b)-(e) are namespace
# properties, not image-content properties, so they hold identically on the full
# runtime image. Pass IMG=harness-runtime:<tag> to run the same assertions
# against the real one; smoke.sh needs only a python3 on PATH.
#
# Both python payloads live in their own files and are fed on stdin. They used to
# be heredocs inside this script, one nested inside the other, which mangled on
# every escape — same failure mode as the TypeScript-in-a-heredoc note in
# CLAUDE.md (scripts/patches/*.ts exists for exactly this reason).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMG="${IMG:-python:3.11-slim}"
PY_IN_IMAGE="${PY_IN_IMAGE:-python3}"
export DOCKER_HOST="${DOCKER_HOST:-unix:///Users/scottshumaker/.colima/default/docker.sock}"

# NOT `mktemp -d`: on colima only $HOME is shared into the VM over virtiofs, so a
# bind source under /var/folders (macOS $TMPDIR) does not exist on the daemon side
# and `docker run` refuses the mount. Every job dir has to live under $HOME.
TMP_ROOT="${HARNESS_CONTAINER_TMP:-$HOME/.cache/harness-container}"
mkdir -p "$TMP_ROOT"
JOB_DIR="$(mktemp -d "$TMP_ROOT/smoke.XXXXXX")"
FORWARDER=""
cleanup() {
	[ -n "$FORWARDER" ] && kill "$FORWARDER" 2>/dev/null
	rm -rf "$JOB_DIR"
}
trap cleanup EXIT

mkdir -p "$JOB_DIR/api"
echo "# api index" > "$JOB_DIR/api/INDEX.md"

python3 "$HERE/mock-forwarder.py" "$JOB_DIR/port" &
FORWARDER=$!
for _ in $(seq 40); do [ -s "$JOB_DIR/port" ] && break; sleep 0.2; done
PORT="$(cat "$JOB_DIR/port" 2>/dev/null)"
if [ -z "$PORT" ]; then
	echo "mock forwarder never reported a port" >&2
	exit 1
fi
echo "==> host forwarder on 127.0.0.1:$PORT, image $IMG"

docker run --rm -i \
	--mount type=bind,src="$JOB_DIR",dst=/job \
	--mount type=bind,src="$JOB_DIR/api",dst=/job/api,readonly \
	-w /job \
	-e "HARNESS_MCP_PROXY=http://host.docker.internal:$PORT" \
	"$IMG" "$PY_IN_IMAGE" - < "$HERE/smoke-payload.py"
