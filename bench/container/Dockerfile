# The harness runtime, whole, inside a linux container.
#
# NOT "kernel inside, harness outside": prime's CLI speaks ZMQ to ipykernel over
# ports that do not cross the colima VM boundary, and the first TAC attempt to
# work around that produced a hand-rolled kernel plus hand-rolled tools — two
# reimplementations whose divergences were invisible until one silently dropped
# image attachments and cost a task. So node, dist/bundle/cli.js and the kernel
# venv all live in here, and the only things that cross are the forwarder hop and
# model egress. See docs/CONTAINER-RUNTIME-DESIGN.md.
#
# Build via bench/container/build.sh — it stages a ~15MB context out of the
# vendored tree. Building with the repo root as context drags in node_modules and
# vendor/mcp-bench.
#
# aarch64. Everything pinned: an unpinned runtime is a runtime that changes
# between the measurement and the run that cites it.

FROM node:22.14.0-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
# python3.11 from bookworm — the same minor as the host kernel venv (3.11.15), so
# the cp311 wheels pinned in kernel-requirements.txt are the identical artefacts.
# No build-essential on purpose: every pinned package has an aarch64 manylinux
# wheel, and if one stops shipping it the build should fail loudly rather than
# quietly start compiling a different numpy than the host has.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# --- kernel venv -------------------------------------------------------------
ENV VENV=/agent/venv
RUN python3 -m venv "$VENV" && "$VENV/bin/pip" install --no-cache-dir --upgrade pip==26.2.1
COPY kernel-requirements.txt /agent/kernel-requirements.txt
RUN "$VENV/bin/pip" install --no-cache-dir -r /agent/kernel-requirements.txt

# --- the two externals dist/bundle does not inline ---------------------------
# Built here, not copied from the host tree: zeromq carries a native binding and
# the macOS one does not load on linux/arm64.
WORKDIR /agent/prime
# prime's OWN manifest (name/version/type/piConfig), minus its dependencies —
# build.sh derives it from the vendored package.json and explains why. A stub
# manifest here is not cosmetic: it renames every env var prime reads.
COPY package.json /agent/prime/package.json
RUN npm i --no-package-lock --omit=dev zeromq@6.6.0 undici@7.28.0 \
 && npm cache clean --force \
 && node -e "require('/agent/prime/node_modules/zeromq'); require('/agent/prime/node_modules/undici')"

# --- prime itself ------------------------------------------------------------
COPY dist /agent/prime/dist
COPY skills /agent/prime/skills
RUN "$VENV/bin/pip" install --no-cache-dir /agent/prime/dist/prime-agent-runtime \
 && for d in /agent/prime/skills/*/; do \
      [ -f "$d/pyproject.toml" ] && "$VENV/bin/pip" install --no-cache-dir "$d" || true; \
    done

# --- prove it, at build time -------------------------------------------------
# find_spec once certified a module that contained a syntax error, because
# locating a module does not execute it. This imports each one.
COPY verify-kernel.py /agent/verify-kernel.py
RUN "$VENV/bin/python" /agent/verify-kernel.py \
 && node /agent/prime/dist/bundle/cli.js --version

ENV PRIME_AGENT_KERNEL_PYTHON=/agent/venv/bin/python \
    NODE_PATH=/agent/prime/node_modules \
    PATH=/agent/venv/bin:/usr/local/bin:/usr/bin:/bin

# The job dir. Bind-mounted rw at run time; api/ goes under it read-only.
WORKDIR /job

# No ENTRYPOINT: bench/container/smoke.sh runs a python payload in this same
# image, and an entrypoint would prepend the CLI to it. Arms invoke explicitly:
#   node /agent/prime/dist/bundle/cli.js --tools ipython,edit -p …
CMD ["bash"]
