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

# Version pins mcp-bench's requirements.txt lacks. Its `mcp[cli]>=1.9.0` is
# unbounded, so a fresh resolve picks up mcp 2.x, which dropped
# `mcp.server.fastmcp` and renamed McpError -> MCPError. That alone breaks 14 of
# the 28 servers. pydantic >=2.12 additionally rejects `default` alongside
# `default_factory`, breaking 4 more. Without these pins only 11/28 servers start.
echo "==> pinning SDK versions (mcp<2, pydantic<2.12)"
VIRTUAL_ENV="$BENCH/.venv" uv pip install -q \
	"mcp>=1.9,<2" "fastmcp<2.4" "pydantic>=2.10,<2.12" pydantic-settings 2>&1 | tail -1

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
	# Build when the entry point the launcher expects is missing. Checking for
	# "build/ or dist/ exists" is not enough — metmuseum-mcp ships a build/ but
	# is launched from dist/, so it silently stayed unbuilt.
	entry="$(node -e "
		const c = require('$SERVERS/commands.json');
		const d = Object.values(c).find(v => v.cwd && v.cwd.replace(/^\.\.\//,'') === '$name');
		const m = d && /(?:^|\s)((?:build|dist|src)\/\S+\.js)/.exec(d.cmd);
		process.stdout.write(m ? m[1] : '');
	" 2>/dev/null)"
	[ -n "$entry" ] && [ -f "$dir/$entry" ] && continue

	if node -e "process.exit(require('$dir/package.json').scripts?.build?0:1)" 2>/dev/null; then
		(cd "$dir" && npm run build --silent >/dev/null 2>&1) || echo "    (npm build failed for $name)"
	elif [ -f "$dir/tsconfig.json" ]; then
		# No build script, just a tsconfig — mcp-bench's own installer relied on a
		# globally installed tsc for these. Install it locally instead.
		echo "    tsc: $name"
		(cd "$dir" && npm install --silent --no-audit --no-fund typescript @types/node >/dev/null 2>&1 \
			&& ./node_modules/.bin/tsc >/dev/null 2>&1) || true
	fi
	[ -n "$entry" ] && [ ! -f "$dir/$entry" ] && echo "    (warning: $name still missing $entry)"
done

echo "==> done. verify with: node bench/mcp-schemas.mjs --probe"
