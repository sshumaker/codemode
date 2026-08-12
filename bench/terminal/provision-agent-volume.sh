#!/usr/bin/env bash
# Provision the shared `tb-agent` volume with the *real* harnesses, for
# terminal-bench.
#
# Same rule as bench/tac/provision-agent-volume.sh and the same reason: the thing
# under test is the harness, so every component swapped for a hand-written
# equivalent stops measuring it. prime-agent runs INSIDE the task container, as
# `dist/bundle/cli.js`, with its own ipykernel over localhost ZMQ.
#
# Three differences from the TAC version, each forced by terminal-bench:
#
#  1. **arm64, not amd64.** terminal-bench's base images are multi-arch and the
#     harness pins no platform, so tasks build natively. Forcing amd64 to reuse
#     the TAC volume would put every task under Rosetta — including the ones that
#     compile a Linux kernel or run a nested qemu.
#
#  2. **`dist/bundle/cli.js`, not `dist/cli.js`.** The bundle externalizes only
#     `zeromq` and `undici`, so the payload is ~50 MB instead of the 463 MB
#     node_modules tree TAC copies. Nothing else about the entry point differs.
#
#  3. **A standalone Python, not the image's.** TAC images all shipped a
#     `python_default`; terminal-bench's 241 tasks are built on ubuntu-24-04,
#     python-3-13, python:3.8-slim, debian:bullseye, taichi and more. A venv
#     built with `--system-site-packages` against one of those is a venv whose
#     interpreter symlink dangles in most of the others — the kernel then "does
#     not respond" and the arm gets blamed. uv installs a relocatable
#     python-build-standalone into /agent itself, so the interpreter travels with
#     the volume.
#
# Usage: bench/terminal/provision-agent-volume.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PRIME="$ROOT/vendor/prime-agent/packages/coding-agent"
IMG="${IMG:-ghcr.io/laude-institute/t-bench/ubuntu-24-04:20250624}"
VERIFY_IMG="${VERIFY_IMG:-ghcr.io/laude-institute/t-bench/python-3-13:20250620}"
C=tb-provision
NODE_VER=v22.14.0

export DOCKER_HOST="${DOCKER_HOST:-unix:///Users/scottshumaker/.colima/default/docker.sock}"

docker volume create tb-agent >/dev/null
docker rm -fv "$C" >/dev/null 2>&1 || true
docker pull -q "$IMG" >/dev/null
docker run -d --name "$C" -v tb-agent:/agent "$IMG" sleep infinity >/dev/null
trap 'docker rm -fv "$C" >/dev/null 2>&1 || true' EXIT

ARCH=$(docker exec "$C" uname -m)
case "$ARCH" in
  aarch64) NODE_ARCH=arm64 ;;
  x86_64)  NODE_ARCH=x64 ;;
  *) echo "unsupported arch $ARCH" >&2; exit 1 ;;
esac
echo "==> provisioning for $ARCH"

echo "==> node runtime"
# curl/xz unconditionally, not inside the `if`: once /agent/node is cached the
# guard skips the apt-get and a later step dies with `curl: command not found`.
docker exec "$C" bash -c 'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl xz-utils ca-certificates >/dev/null 2>&1'
docker exec "$C" bash -c "
set -e
if [ ! -x /agent/node/bin/node ]; then
  mkdir -p /agent/node
  curl -sL https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-$NODE_ARCH.tar.xz -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /agent/node --strip-components=1
fi
echo \"    node \$(/agent/node/bin/node --version)\""

echo "==> Claude Code (third arm, same container, same machine)"
docker exec "$C" bash -c '
export PATH=/agent/node/bin:$PATH
[ -x /agent/node/bin/claude ] || npm i -g --prefix /agent/node @anthropic-ai/claude-code >/dev/null 2>&1
echo "    claude $(claude --version 2>&1)"'

echo "==> prime-agent (dist/bundle/cli.js — the published bin entry)"
# Only the parent is pre-created. `docker cp src dest` copies *into* dest when it
# exists, so pre-creating dist/ yields dist/dist — the same trap as staging
# /workspace under a reused run directory.
docker exec "$C" bash -c 'rm -rf /agent/prime && mkdir -p /agent/prime'
docker cp "$PRIME/dist"    "$C:/agent/prime/dist"
docker cp "$PRIME/skills"  "$C:/agent/prime/skills"
docker exec "$C" bash -c '
set -e
export PATH=/agent/node/bin:$PATH
# The two externals the bundle does not inline. Built in the container so the
# native zeromq binding matches this arch — the copied macOS tree would not.
#
# A *minimal* package.json, deliberately not the real one: `npm i` reads whatever
# manifest it finds, and the real manifest lists workspace-internal packages
# (@earendil-works/pi-*) that do not resolve from a public registry. Copying it
# turns a two-package install into a 404.
cd /agent/prime && printf "%s" "{\"name\":\"prime-externals\",\"private\":true}" > package.json
npm i --no-package-lock --omit=dev zeromq undici 2>&1 | tail -3
node -e "require(\"/agent/prime/node_modules/zeromq\"); console.log(\"    zeromq ok\")"
echo "    prime $(node /agent/prime/dist/bundle/cli.js --version 2>&1 | tail -1)"'

echo "==> standalone python + kernel venv"
docker exec "$C" bash -c '
set -e
export PATH=/agent/node/bin:$PATH
if [ ! -x /agent/uv/uv ]; then
  mkdir -p /agent/uv
  curl -LsSf https://astral.sh/uv/0.7.13/install.sh | UV_INSTALL_DIR=/agent/uv sh >/dev/null 2>&1
fi
export UV_PYTHON_INSTALL_DIR=/agent/python
# Always rebuilt, never patched in place. The TAC venv was corrupted twice and
# each time the damage was invisible until a task failed.
rm -rf /agent/venv
/agent/uv/uv python install 3.12 >/dev/null 2>&1
PY=$(/agent/uv/uv python find 3.12)
echo "    interpreter $PY"
# NOT --system-site-packages: the whole point is that this venv does not depend
# on what the task image happens to ship.
# --seed installs pip/setuptools/wheel INTO the venv. Without it the kernel
# has no way to install anything into itself, and the agent burns turns
# rediscovering that fact — measured at 8 of 12 cells on csv-to-parquet.
/agent/uv/uv venv --seed --python "$PY" /agent/venv >/dev/null 2>&1
export VIRTUAL_ENV=/agent/venv
/agent/uv/uv pip install -q ipython ipykernel jupyter_client
/agent/uv/uv pip install -q /agent/prime/dist/prime-agent-runtime
# Prime refuses to run a cell unless the kernel has all of these; the error names
# only the first few missing, so install the whole list at once.
/agent/uv/uv pip install -q requests httpx pyyaml tomli python-dotenv pandas numpy scipy beautifulsoup4 lxml pydantic tyro
cd /agent/prime/skills
# The ./ prefix is required — a bare name resolves against PyPI, where these do
# not exist, and pip reports a confusing "no matching version".
for d in */; do [ -f "$d/pyproject.toml" ] && /agent/uv/uv pip install -q "./$d" >/dev/null 2>&1 || true; done
# Actually import each one. find_spec only locates a module without executing it,
# so it once reported "kernel ready" while jupyter_client contained a syntax error.
/agent/venv/bin/python - <<PY
import importlib
bad = []
for m in ["rlm","ipykernel","jupyter_client","attach_image","edit","requests","pandas","scipy","bs4","numpy","lxml","pydantic","tyro"]:
    try: importlib.import_module(m)
    except Exception as e: bad.append(f"{m} ({type(e).__name__})")
print("    kernel ready" if not bad else f"    BROKEN: {bad}")
PY'

echo "==> verifying on a SECOND base image, read-only, as a run mounts it"
# Deliberately not the provisioning image. A venv that only works where it was
# built certifies nothing — this is the check that caught pandas missing on TAC.
docker pull -q "$VERIFY_IMG" >/dev/null
docker run --rm -v tb-agent:/agent:ro "$VERIFY_IMG" bash -c '
/agent/venv/bin/python -c "
import importlib
mods = [\"rlm\",\"ipykernel\",\"jupyter_client\",\"attach_image\",\"edit\",\"requests\",\"httpx\",
        \"yaml\",\"tomli\",\"dotenv\",\"pandas\",\"numpy\",\"scipy\",\"bs4\",\"lxml\",\"pydantic\",\"tyro\"]
bad = []
for m in mods:
    try: importlib.import_module(m)
    except Exception as e: bad.append(m + \" (\" + type(e).__name__ + \")\")
print(\"    python verified on second image\" if not bad else \"    BROKEN ON SECOND IMAGE: \" + str(bad))
"
/agent/node/bin/node /agent/prime/dist/bundle/cli.js --version >/dev/null 2>&1 \
  && echo "    prime verified on second image" || echo "    PRIME BROKEN ON SECOND IMAGE"'

docker run --rm -v tb-agent:/agent alpine du -sh /agent

echo
echo "provisioned. Arms run inside the task container as:"
echo "  codemode    /agent/node/bin/node /agent/prime/dist/bundle/cli.js --tools ipython,edit"
echo "  vanilla     …same binary, prime's shell/file tool set"
echo "  claude-code /agent/node/bin/claude -p"
echo "with PRIME_AGENT_KERNEL_PYTHON=/agent/venv/bin/python and skills ENABLED."
