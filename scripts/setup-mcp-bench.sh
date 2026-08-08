#!/usr/bin/env bash
# Set up MCP-Bench's 28 servers with a strictly local install.
#
# Deliberately does NOT run mcp-bench's own mcp_servers/install.sh. That script
# does `brew install node`, `sudo apt-get install`, and `npm install -g pnpm
# yarn tsx` — global machine state this experiment has no business changing. It
# is also less reproducible: whatever is already installed globally silently
# becomes part of the environment under test.
#
# Everything here lands inside vendor/mcp-bench: a uv-managed .venv for the
# Python servers, per-directory node_modules for the Node ones. Nothing is
# installed globally and nothing needs sudo.
#
#   scripts/setup-mcp-bench.sh [--clone-only]
set -uo pipefail

REPO="https://github.com/Accenture/mcp-bench"
PIN="7a8eaeae83a842a2949080acc5473f65e1569daf"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH="$ROOT/vendor/mcp-bench"
SERVERS="$BENCH/mcp_servers"

[ -x "$HOME/.local/bin/uv" ] && export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null || { echo "uv not found; install it first" >&2; exit 1; }

if [ ! -d "$BENCH" ]; then
	echo "==> cloning mcp-bench @ ${PIN:0:8}"
	git clone -q "$REPO" "$BENCH"
	git -C "$BENCH" checkout -q "$PIN"
	rm -rf "$BENCH/.git"
fi
[ "${1:-}" = "--clone-only" ] && exit 0

# --- Python servers -----------------------------------------------------------
# One shared venv. mcp-bench's requirements.txt covers the non-uv servers; the
# uv-managed ones (biomcp, wikipedia-mcp, mcp-reddit, nasa-mcp) bring their own.
echo "==> python venv"
if [ ! -d "$BENCH/.venv" ]; then
	uv venv --python 3.12 "$BENCH/.venv" >/dev/null 2>&1
fi
VENV_PY="$BENCH/.venv/bin/python"

echo "==> python deps (shared venv)"
VIRTUAL_ENV="$BENCH/.venv" uv pip install -q -r "$SERVERS/requirements.txt" 2>&1 | tail -2
VIRTUAL_ENV="$BENCH/.venv" uv pip install -q fastmcp mcp 2>&1 | tail -1

# Editable installs for the Python servers that are packages rather than scripts.
for pkg in unit-converter-mcp time-mcp paper-search-mcp medcalc mcp-nixos; do
	[ -f "$SERVERS/$pkg/pyproject.toml" ] || [ -f "$SERVERS/$pkg/setup.py" ] || continue
	echo "    editable: $pkg"
	VIRTUAL_ENV="$BENCH/.venv" uv pip install -q -e "$SERVERS/$pkg" >/dev/null 2>&1 \
		|| echo "    (skipped $pkg — install failed, server will be excluded)"
done

# --- uv-managed servers -------------------------------------------------------
echo "==> uv-managed servers"
for pkg in wikipedia-mcp biomcp mcp-reddit nasa-mcp; do
	[ -d "$SERVERS/$pkg" ] || continue
	echo "    sync: $pkg"
	(cd "$SERVERS/$pkg" && uv sync -q >/dev/null 2>&1) \
		|| echo "    (skipped $pkg — uv sync failed)"
done

# --- Node servers -------------------------------------------------------------
echo "==> node servers"
for dir in "$SERVERS"/*/; do
	[ -f "$dir/package.json" ] || continue
	name="$(basename "$dir")"
	echo "    npm: $name"
	(cd "$dir" && npm install --silent --no-audit --no-fund >/dev/null 2>&1) \
		|| { echo "    (npm install failed for $name)"; continue; }
	# Build only when the entry point the launcher expects is absent.
	if node -e "process.exit(require('$dir/package.json').scripts?.build?0:1)" 2>/dev/null; then
		if [ ! -d "$dir/build" ] && [ ! -d "$dir/dist" ]; then
			(cd "$dir" && npm run build --silent >/dev/null 2>&1) \
				|| echo "    (build failed for $name)"
		fi
	fi
done

echo "==> done. verify with: node bench/mcp-schemas.mjs --probe"
