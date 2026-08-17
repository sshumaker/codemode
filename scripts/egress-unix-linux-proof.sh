#!/usr/bin/env bash
# Prove the unix-socket transport on LINUX, where it is the only one that works.
#
# The claim in docs/CLOUD-HARNESS-DESIGN.md §7.2 is platform-specific and cannot be
# checked on the macOS host at all: srt sandboxes through bubblewrap, whose network
# namespace makes the harness's 127.0.0.1 unreachable from inside the sandbox, so
# the proxy's TCP door — the one every measured run so far used — is dead there.
# This script runs the real proxy, the real srt and runtime/jobs.py's real client
# inside a Linux container and prints what each door does.
#
#   scripts/egress-unix-linux-proof.sh
#
# It is a TEST RIG, not a shipped posture, and it is honest about one cost: srt
# inside Docker needs --cap-add=SYS_ADMIN with seccomp, apparmor and systempaths
# unconfined (bwrap needs to create namespaces). That buys an inner boundary by
# materially weakening the outer one — fine for a container whose only job is to
# answer this question and which is removed at the end, not something to do to a
# benchmark container (see §7.3).
#
# Nothing is pulled and nothing is built inside the container image: node comes
# from the existing `tb-agent` volume, srt and the repo come from a read-only bind
# mount of the checkout, and the proxy is cross-compiled here. Three apt packages
# (bubblewrap, socat, ripgrep) are the only download — the docker disk on this
# machine has been filled by this project before.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMG="${IMG:-ghcr.io/laude-institute/t-bench/ubuntu-24-04:20250624}"
C="${C:-egress-unix-proof}"
BIN="$ROOT/.run/bin/egress-linux-arm64"
# Mounted separately and by its real path: in a git worktree node_modules is a
# symlink to the primary checkout, and a symlink inside a bind mount resolves to a
# host path the container does not have.
NM="$(cd "$ROOT/node_modules" && pwd -P)"
# Mounted at /node_modules so node's own upward resolution finds srt's deps
# (commander, zod) — /nm would leave them one directory to the side.
SRT="/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js"

case "$(docker info --format '{{.Architecture}}')" in
  aarch64|arm64) GOARCH=arm64 ;;
  x86_64) GOARCH=amd64 ;;
  *) echo "unsupported docker architecture" >&2; exit 1 ;;
esac

echo "==> cross-compiling the proxy for linux/$GOARCH"
mkdir -p "$(dirname "$BIN")"
( cd "$ROOT/proxy/egress" && CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" go build -o "$BIN" . )
file "$BIN" 2>/dev/null || true

docker rm -fv "$C" >/dev/null 2>&1 || true
# The srt requirements, spelled out rather than implied: without SYS_ADMIN and the
# unconfined seccomp/apparmor/systempaths, bwrap cannot unshare and srt exits.
docker run -d --name "$C" \
  --cap-add=SYS_ADMIN \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -v "$ROOT:/host:ro" \
  -v "$NM:/node_modules:ro" \
  -v tb-agent:/agent:ro \
  -v "$BIN:/usr/local/bin/egress:ro" \
  "$IMG" sleep infinity >/dev/null
trap 'docker rm -fv "$C" >/dev/null 2>&1 || true' EXIT

echo "==> srt's dependencies (bubblewrap, socat, ripgrep — absent from every task image)"
docker exec "$C" bash -c 'apt-get update -qq && apt-get install -y -qq bubblewrap socat ripgrep >/dev/null && bwrap --version'

docker exec "$C" bash -c 'mkdir -p /work/run/jobs/requests /work/probe'
docker exec "$C" bash -c 'cat > /work/run/egress-config.json <<JSON
{"routes": [], "spawn_dir": "/work/run/jobs/requests"}
JSON'
docker exec "$C" bash -c '/usr/local/bin/egress --mint proof > /work/run/tokens.txt && cat /work/run/tokens.txt'
TOKEN=$(docker exec "$C" bash -c "cut -d\  -f2 /work/run/tokens.txt")

echo "==> the proxy, on BOTH doors at once (the TCP one is the control)"
docker exec -d "$C" bash -c '/usr/local/bin/egress \
  --listen 127.0.0.1:8099 --listen-unix /work/run/egress.sock \
  --addr-file /work/run/addr.txt --config /work/run/egress-config.json \
  --tokens /work/run/tokens.txt --audit /work/run/audit.jsonl > /work/run/egress.log 2>&1'
docker exec "$C" bash -c 'for i in $(seq 50); do [ -S /work/run/egress.sock ] && break; sleep 0.1; done; cat /work/run/egress.log; ls -l /work/run/egress.sock; cat /work/run/addr.txt; echo'

# THE CONTROL. Every "the sandbox cannot reach it" line below is worthless unless
# the same address answers from a process that is not sandboxed: a dead proxy and
# an enforced boundary produce identical transcripts. This project has already
# reported a boundary that was only a stale port.
echo "==> control: unsandboxed, in the same container, both doors answer"
# No `|| true` here: if the control fails, everything after it is unattributable and
# the script must stop rather than print a boundary it cannot vouch for.
docker exec "$C" bash -c "set -o pipefail; cd /host && python3 scripts/egress-unix-probe-control.py '$TOKEN' 2>&1 | grep -v 'jobs\]'"

echo "==> srt settings (the posture: nothing writable but the run dir, no domains)"
docker exec "$C" bash -c 'cat > /work/run/srt-settings.json <<JSON
{
  "filesystem": {
    "allowWrite": ["/work/run", "/tmp"],
    "denyWrite": [],
    "denyRead": ["/root"],
    "allowRead": ["/work", "/host", "/usr", "/lib", "/etc", "/tmp", "/agent"]
  },
  "network": {
    "allowedDomains": [],
    "deniedDomains": [],
    "allowLocalBinding": true,
    "allowAllUnixSockets": true
  }
}
JSON'

echo "==> INSIDE the sandbox: the four claims"
set +e
docker exec "$C" bash -c "cd /host && /agent/node/bin/node $SRT \
  --settings /work/run/srt-settings.json \
  /usr/bin/python3 /host/scripts/egress-unix-probe.py /host/runtime unix:/work/run/egress.sock '$TOKEN' http://127.0.0.1:8099"
PROBE=$?
set -e

# SIGKILL is how runtime/posture.mjs reaps a per-run proxy, and a killed process
# never unlinks its socket. So the second run in a reused run directory always finds
# debris, and a proxy that could not bind over it would fail every other run.
echo "==> stale socket: SIGKILL the proxy, leave the file, bind again"
# pgrep/kill by pid rather than `pkill -f`: the pattern would also match the shell
# running it, which then kills itself and takes this script's `set -e` with it.
PROXY_PID=$(docker exec "$C" pgrep -f '^/usr/local/bin/egress')
docker exec "$C" kill -9 "$PROXY_PID"
docker exec "$C" bash -c 'sleep 0.3; ls -l /work/run/egress.sock; pgrep -f "^/usr/local/bin/egress" || echo "proxy gone, socket file left behind"'
docker exec -d "$C" bash -c '/usr/local/bin/egress \
  --listen-unix /work/run/egress.sock \
  --addr-file /work/run/addr2.txt --config /work/run/egress-config.json \
  --tokens /work/run/tokens.txt --audit /work/run/audit.jsonl > /work/run/egress2.log 2>&1'
docker exec "$C" bash -c 'for i in $(seq 50); do [ -s /work/run/addr2.txt ] && break; sleep 0.1; done
  cat /work/run/egress2.log
  echo "announced: $(cat /work/run/addr2.txt)"
  # And unix-only really is unix-only: nothing on the old port.
  (exec 3<>/dev/tcp/127.0.0.1/8099 && echo "FAIL 8099 still open") 2>/dev/null || echo "no TCP listener on 8099 (unix-only)"'
docker exec "$C" bash -c "set -o pipefail; cd /host && python3 scripts/egress-unix-probe-control.py '$TOKEN' unix 2>&1 | grep -v 'jobs\]'"

echo "==> the spawn request the sandboxed POST caused, on the harness side"
docker exec "$C" bash -c 'ls -l /work/run/jobs/requests/ && cat /work/run/jobs/requests/*.json'
echo "==> audit log (the evidence, and the only record of what crossed)"
docker exec "$C" bash -c 'cat /work/run/audit.jsonl'

echo
if [ "$PROBE" -eq 0 ]; then echo "PROOF OK"; else echo "PROOF FAILED (probe exit $PROBE)"; fi
exit "$PROBE"
