#!/usr/bin/env bash
# Make TheAgentCompany's RocketChat MongoDB run natively on Apple Silicon.
#
# The upstream compose file pins `bitnamilegacy/mongodb:5.0`, which is amd64-only.
# On an arm64 host neither emulation path works:
#
#   QEMU     boots, but `mongod` burned 118 minutes of CPU at 99.5% without ever
#            finishing "Validating settings" — pathologically slow, not broken.
#   Rosetta  fast, but does not emulate AVX, which MongoDB 5.0 requires, so the
#            process dies immediately with "Illegal instruction".
#
# The official `mongo:5.0` image publishes arm64. It does not do Bitnami's
# replica-set bootstrap from env vars, so that is replaced with an explicit
# `--replSet` plus a one-shot `rs.initiate()` — RocketChat requires a replica set
# for its oplog tailing and will crash-loop without one.
#
# This changes the fixture, so record it with any results: MongoDB is upstream's
# version but not upstream's image.
set -euo pipefail

COMPOSE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/vendor/TheAgentCompany/servers/docker-compose.yml"
[ -f "$COMPOSE" ] || { echo "no compose file at $COMPOSE" >&2; exit 1; }

if grep -q "harness-arm64-patch" "$COMPOSE"; then
	echo "already patched"
	exit 0
fi

python3 - "$COMPOSE" <<'PY'
import re, sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()

old_start = s.index("  mongodb:\n")
old_end = s.index("  redis-stack:", old_start)

new = """  # harness-arm64-patch: official image (has arm64) instead of bitnamilegacy
  # (amd64-only). See scripts/patch-agentcompany-arm.sh.
  mongodb:
    image: mongo:${MONGODB_VERSION:-5.0}
    restart: always
    container_name: rocketchat-mongodb
    command: ["mongod", "--replSet", "${MONGODB_REPLICA_SET_NAME:-rs0}", "--bind_ip_all"]
    volumes:
      - mongodb_data:/data/db
    healthcheck:
      # Idempotent: initiate the replica set once, then report healthy.
      test:
        - CMD-SHELL
        - >-
          mongosh --quiet --eval
          'try { rs.status().ok } catch (e) { rs.initiate({_id:"${MONGODB_REPLICA_SET_NAME:-rs0}",members:[{_id:0,host:"mongodb:27017"}]}) }'
          | grep -qE '1|ok'
      interval: 5s
      timeout: 10s
      retries: 30
      start_period: 20s

"""
p.write_text(s[:old_start] + new + s[old_end:])
print("patched mongodb service")
PY

echo "done — recreate with: cd vendor/TheAgentCompany/servers && docker compose up -d"
