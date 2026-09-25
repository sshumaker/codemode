#!/usr/bin/env bash
# What can the container actually reach? Measured, per network mode.
#
# The design record wants "no network except the host gateway". Whether this
# runtime can deliver that is not a matter of opinion — it is four probes under
# three network modes, and this script runs them. The mode that keeps the
# forwarder reachable while denying the internet is the answer; if no mode does
# both, the honest statement is "outbound is open, the boundary is filesystem and
# executables only", and that belongs in the doc's table rather than a footnote.
#
# Usage: bench/container/network-posture.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMG="${IMG:-harness-runtime:aarch64}"
NET="harness-posture-probe"
export DOCKER_HOST="${DOCKER_HOST:-unix:///Users/scottshumaker/.colima/default/docker.sock}"

TMP_ROOT="${HARNESS_CONTAINER_TMP:-$HOME/.cache/harness-container}"
mkdir -p "$TMP_ROOT"
PORT_FILE="$(mktemp "$TMP_ROOT/posture-port.XXXXXX")"
FORWARDER=""
cleanup() {
	[ -n "$FORWARDER" ] && kill "$FORWARDER" 2>/dev/null
	rm -f "$PORT_FILE"
	docker network rm "$NET" >/dev/null 2>&1
}
trap cleanup EXIT

python3 "$HERE/mock-forwarder.py" "$PORT_FILE" &
FORWARDER=$!
for _ in $(seq 40); do [ -s "$PORT_FILE" ] && break; sleep 0.2; done
PORT="$(cat "$PORT_FILE")"
echo "==> host forwarder on 127.0.0.1:$PORT, image $IMG"

docker network rm "$NET" >/dev/null 2>&1
# --internal: docker installs no NAT rule for this network, so nothing routes off
# the bridge. The question is whether the host gateway survives that.
docker network create --internal "$NET" >/dev/null

run_probes() {
	local label="$1"; shift
	echo
	echo "--- $label"
	docker run --rm -i -e "PROBE_PORT=$PORT" "$@" "$IMG" python3 - < "$HERE/network-probe.py"
}

run_probes "default bridge (what a plain \`docker run\` gives)"
run_probes "--network $NET --add-host host.docker.internal:host-gateway" \
	--network "$NET" --add-host "host.docker.internal:host-gateway"
run_probes "--network none" --network none

# Mode 4: the one that satisfies the design record. The runtime stays on the
# internal network (no route anywhere) and reaches the harness's forwarder
# through a sidecar container attached to BOTH networks.
SIDE="harness-posture-sidecar"
docker rm -f "$SIDE" >/dev/null 2>&1
# Staged under $HOME, then mounted. Two traps at once: `docker run -d -i … < file`
# does not deliver the redirect to a detached container (the sidecar came up with
# an empty program and refused every connection, which reads exactly like a
# blocked network), and this checkout lives under /tmp, which colima does not
# share into the VM — so the bind source has to be copied somewhere it does.
STAGE="$TMP_ROOT/sidecar"
mkdir -p "$STAGE"; cp "$HERE/sidecar-forward.py" "$STAGE/"
docker run -d --name "$SIDE" --network bridge \
	--mount "type=bind,src=$STAGE,dst=/opt/hop,readonly" "$IMG" \
	python3 /opt/hop/sidecar-forward.py --upstream "host.docker.internal:$PORT" >/dev/null
docker network connect "$NET" "$SIDE"
for _ in $(seq 25); do
	docker logs "$SIDE" 2>&1 | grep -q "sidecar: :" && break
	sleep 0.2
done
echo
echo "--- --network $NET + dual-homed sidecar (PROXY_HOST=$SIDE:9000)"
docker run --rm -i --network "$NET" -e "PROBE_PORT=9000" -e "PROBE_HOST=$SIDE" \
	"$IMG" python3 - < "$HERE/network-probe.py"
docker rm -f "$SIDE" >/dev/null 2>&1
