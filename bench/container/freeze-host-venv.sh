#!/usr/bin/env bash
# Regenerate kernel-requirements.txt from the host kernel venv.
#
# The container kernel and the host kernel must hold the same set at the same
# versions, or a measurement taken in one does not transfer to the other. Run
# this whenever the host venv moves, then rebuild.
#
# Usage: bench/container/freeze-host-venv.sh [path-to-venv-python]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PY="${1:-$HOME/.prime/agent/kernel-venv/bin/python}"
[ -x "$VENV_PY" ] || { echo "no interpreter at $VENV_PY" >&2; exit 1; }

# Run BY the venv's own interpreter, and use sys.executable inside: a bare
# `python -m pip` resolves against PATH and will happily freeze some other
# environment, which is how this file first landed with honcho and PyMuPDF in it.
"$VENV_PY" - > "$HERE/kernel-requirements.txt" <<'PY'
import subprocess, sys

LOCAL = {  # installed from the vendored tree, not PyPI
    "prime-agent-runtime", "prime-agent-skill-attach-image", "prime-agent-skill-websearch",
    "agent-message", "agent-observe", "compact", "edit", "goal", "refine", "rlm-heartbeat",
}
SEED = {"pip", "setuptools", "wheel"}   # venv --seed provides these
HOST_ONLY = {"appnope"}                 # darwin-only

out = []
for line in subprocess.check_output(
    [sys.executable, "-m", "pip", "list", "--format=freeze"], text=True
).splitlines():
    name = line.split("==")[0].lower().replace("_", "-")
    if name in LOCAL | SEED | HOST_ONLY:
        continue
    out.append(line)

print(f"# Pinned from the host kernel venv, python {sys.version.split()[0]}.")
print("# Generated, not hand-written: the container kernel and the host kernel must hold")
print("# the same set at the same versions, or a measurement taken in one does not")
print("# transfer to the other. Regenerate with bench/container/freeze-host-venv.sh.")
print("#")
print("# Excluded: prime's runtime shim and the skills/ packages (installed from the")
print("# vendored tree), pip/setuptools/wheel (venv --seed), appnope (darwin-only).")
print("\n".join(sorted(out, key=str.lower)))
PY

echo "wrote $HERE/kernel-requirements.txt ($(grep -vc '^#' "$HERE/kernel-requirements.txt") packages)"
