#!/usr/bin/env bash
# Provision the shared `tac-agent` volume with the *real* harnesses.
#
# TheAgentCompany requires the agent to act inside a task container. The first
# version of this harness solved that by reimplementing primes ipython tool over
# `docker exec` and hand-rolling bash/read/write/str_replace for the vanilla arm.
# That measured the clone, not the harness — and the clone silently lost image
# attachments, so a multimodal model went blind on ~35% of tasks.
#
# This provisions the genuine article instead, once, into a volume every task
# container mounts at /agent:
#
#   node + Claude Code       — the third arm, running natively in the container
#   prime-agent (whole tree) — dist/cli.js, the same entry the host uses
#   a kernel venv            — ipykernel, prime-agent-runtime, primes default
#                              packages, and every skill package
#
# The skills matter more than they look. `--no-skills` removes `attach_image`,
# which is the only way a vision-capable model can actually SEE a file — without
# it the agent decodes PNGs pixel-by-pixel as ASCII. On a probe image it took 19
# turns and still dropped a character; with the skill installed, 5 turns and an
# exact answer. It also removes `edit`, whose exact-match/uniqueness contract is
# the whole value of the tool.
#
# Usage: bench/tac/provision-agent-volume.sh [task-image]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMG="${1:-ghcr.io/theagentcompany/hr-check-attendance-one-day-image:1.0.0}"
C=tac-provision
PRIME="$ROOT/vendor/prime-agent"

docker volume create tac-agent >/dev/null
docker rm -fv "$C" >/dev/null 2>&1 || true
docker pull -q --platform linux/amd64 "$IMG" >/dev/null
docker run -d --name "$C" --platform linux/amd64 --network host -v tac-agent:/agent "$IMG" sleep infinity >/dev/null
trap 'docker rm -fv "$C" >/dev/null 2>&1 || true' EXIT

echo "==> node runtime"
docker exec "$C" bash -c '
set -e
if [ ! -x /agent/node/bin/node ]; then
  mkdir -p /agent/node
  curl -sL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /agent/node --strip-components=1
fi
echo "    node $(/agent/node/bin/node --version)"'

echo "==> Claude Code (third arm)"
docker exec "$C" bash -c '
export PATH=/agent/node/bin:$PATH
[ -x /agent/node/bin/claude ] || npm i -g --prefix /agent/node @anthropic-ai/claude-code >/dev/null 2>&1
echo "    claude $(claude --version 2>&1)"'

echo "==> prime-agent (real tree, same dist/cli.js entry the host runs)"
# Only the parent. `docker cp src dest` copies *into* dest when it exists, so
# pre-creating packages/ yields packages/packages — the same trap as staging
# /workspace under a reused run directory.
docker exec "$C" bash -c 'rm -rf /agent/prime-mono && mkdir -p /agent/prime-mono'
docker cp "$PRIME/node_modules" "$C:/agent/prime-mono/node_modules"
docker cp "$PRIME/packages" "$C:/agent/prime-mono/packages"
docker exec "$C" bash -c '
export PATH=/agent/node/bin:$PATH
# The copied tree carries darwin binaries. Only zeromq is loaded at runtime (it
# is how the kernel is driven); the rest are TUI/build tooling that print mode
# never touches. Build it in isolation and swap the single package — never
# `npm install` inside the copied tree, which prunes everything absent from a
# package.json and destroys the workspace links.
mkdir -p /tmp/ext && cd /tmp/ext && npm init -y >/dev/null 2>&1
npm i zeromq undici >/dev/null 2>&1
rm -rf /agent/prime-mono/node_modules/zeromq
cp -r /tmp/ext/node_modules/zeromq /agent/prime-mono/node_modules/zeromq
cd /agent/prime-mono/packages/coding-agent
echo "    prime-agent $(node dist/cli.js --version 2>&1 | tail -1)"'

echo "==> kernel venv (ipykernel + runtime + default packages + skills)"
docker exec "$C" bash -c '
set -e
# Always rebuilt, never patched in place. This venv has been corrupted twice —
# once by an agent editing jupyter_client through a writable mount, once by a
# --force-reinstall that removed pip itself — and each time the damage was
# invisible until a task failed. It costs a couple of minutes to recreate and
# buys a known state.
rm -rf /agent/venv
python_default -m venv --system-site-packages /agent/venv
# `python -m pip` rather than the pip script: the entry point is one of the
# things that went missing.
/agent/venv/bin/python -m pip install -q --upgrade pip
# --force-reinstall because a corrupted file is still a satisfied requirement:
# an agent once edited jupyter_client inside this volume into invalid Python and
# a plain install silently left the damage in place.
/agent/venv/bin/python -m pip install -q ipython ipykernel jupyter_client
/agent/venv/bin/python -m pip install -q /agent/prime-mono/packages/coding-agent/dist/prime-agent-runtime
# Prime refuses to run a cell unless the kernel has all of these; the error names
# only the first few missing, so install the whole list at once.
# --ignore-installed is load-bearing. The venv is --system-site-packages, so pip
# treats anything present in the provisioning image system packages as already
# satisfied and installs nothing — leaving the venv incomplete and the kernel
# dead on any task image lacking those packages system-wide. pandas went missing
# exactly this way, and the verification below imported it from the system and
# happily reported success.
/agent/venv/bin/python -m pip install -q --ignore-installed requests httpx pyyaml tomli python-dotenv pandas numpy scipy beautifulsoup4 lxml pydantic tyro
cd /agent/prime-mono/packages/coding-agent/skills
# The ./ prefix is required — a bare name is resolved against PyPI, where these
# do not exist, and pip reports a confusing "no matching version".
for d in */; do [ -f "$d/pyproject.toml" ] && /agent/venv/bin/python -m pip install -q "./$d" >/dev/null 2>&1 || true; done
# Actually import each one. find_spec only locates a module without executing it,
# so it reported "kernel ready" while jupyter_client contained a syntax error.
/agent/venv/bin/python - <<PY
import importlib
bad = []
for m in ["rlm","ipykernel","jupyter_client","attach_image","edit","requests","pandas","scipy","bs4","numpy","lxml","pydantic","tyro"]:
    try:
        importlib.import_module(m)
    except Exception as e:
        bad.append(f"{m} ({type(e).__name__})")
print("    kernel ready" if not bad else f"    BROKEN: {bad}")
PY'

echo "==> verifying on a SECOND task image"
# Deliberately not the provisioning image, and read-only exactly as a run mounts
# it. A --system-site-packages venv hides an incomplete install whenever the
# provisioning image happens to supply the package system-wide, so a check that
# runs only there certifies a venv that dies everywhere else.
VERIFY_IMG="${VERIFY_IMG:-ghcr.io/theagentcompany/admin-make-spreadsheet-image:1.0.0}"
docker pull -q --platform linux/amd64 "$VERIFY_IMG" >/dev/null
docker run --rm --platform linux/amd64 -v tac-agent:/agent:ro "$VERIFY_IMG" \
  /agent/venv/bin/python -c '
import importlib
mods = ["rlm","ipykernel","jupyter_client","attach_image","edit","requests","httpx",
        "yaml","tomli","dotenv","pandas","numpy","scipy","bs4","lxml","pydantic","tyro"]
bad = []
for m in mods:
    try:
        importlib.import_module(m)
    except Exception as e:
        bad.append(m + " (" + type(e).__name__ + ")")
print("    verified on second image" if not bad else "    BROKEN ON SECOND IMAGE: " + str(bad))
'

echo
echo "provisioned. Arms run inside the task container as:"
echo "  codemode    node /agent/prime-mono/packages/coding-agent/dist/cli.js --tools ipython,edit"
echo "  vanilla     …same binary, prime's built-in tool set"
echo "  claude-code /agent/node/bin/claude -p  (IS_SANDBOX=1, containers run as root)"
echo "with PRIME_AGENT_KERNEL_PYTHON=/agent/venv/bin/python and skills ENABLED."
