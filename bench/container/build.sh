#!/usr/bin/env bash
# Build the containerized harness runtime, and report what it cost.
#
# Stages a small build context out of the vendored prime tree. The repo root is
# not usable as a context — node_modules and vendor/mcp-bench are gigabytes, and
# docker would upload all of it before reading the first FROM.
#
# Usage: bench/container/build.sh [--no-cache]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PRIME="$ROOT/vendor/prime-agent/packages/coding-agent"
TAG="${TAG:-harness-runtime:aarch64}"
export DOCKER_HOST="${DOCKER_HOST:-unix:///Users/scottshumaker/.colima/default/docker.sock}"

# Under $HOME: on colima only $HOME is shared into the VM, and while the build
# context is streamed rather than mounted, keeping every container-facing path
# under one root avoids the /var/folders trap that bites the bind mounts.
CTX="${HARNESS_CONTAINER_TMP:-$HOME/.cache/harness-container}/ctx"
rm -rf "$CTX"; mkdir -p "$CTX"

cp "$HERE/kernel-requirements.txt" "$HERE/verify-kernel.py" "$HERE/Dockerfile" "$CTX/"

# prime reads the nearest package.json ABOVE dist/bundle and derives its whole
# identity from it: `envPrefix` comes from piConfig.name, so the manifest decides
# whether the agent-dir variable is PRIME_AGENT_CODING_AGENT_DIR or PI_CODING_AGENT_DIR.
# A stub manifest silently renames it — measured: with the stub, `--version`
# printed 0.0.0, PRIME_AGENT_CODING_AGENT_DIR was ignored, and models.json was
# read from ~/.prime/agent instead of the mounted job dir.
#
# So: the real name/version/type/piConfig, and NOT the real dependencies —
# those list workspace-internal @earendil-works/pi-* packages that do not
# resolve from a public registry, which turns the externals install into a 404.
python3 - "$PRIME/package.json" "$CTX/package.json" <<'PYEOF'
import json, sys
real = json.load(open(sys.argv[1]))
keep = {k: real[k] for k in ("name", "version", "type", "piConfig") if k in real}
json.dump(keep, open(sys.argv[2], "w"), indent=2)
PYEOF
# The WHOLE dist, not just dist/bundle. The bundle loads assets by path from its
# siblings — dist/modes/interactive/theme/prime.json is opened at startup — so a
# bundle-only copy dies at boot with ENOENT before the kernel is ever reached.
cp -R "$PRIME/dist"    "$CTX/dist"
cp -R "$PRIME/skills"  "$CTX/skills"
echo "==> context $(du -sh "$CTX" | cut -f1)"

START=$(date +%s)
docker build "$@" --platform linux/arm64 -t "$TAG" "$CTX"
ELAPSED=$(( $(date +%s) - START ))

SIZE=$(docker image inspect "$TAG" --format '{{.Size}}')
echo
echo "==> image      $TAG"
echo "==> size       $(python3 -c "print(f'{$SIZE/1e9:.2f} GB ({$SIZE} bytes)')")"
echo "==> build time ${ELAPSED}s"
