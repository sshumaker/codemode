#!/usr/bin/env bash
# Bootstrap the local test environment: everything `npm test`, `npm run test:kernel`,
# `npm run test:remote-kernel` and `npm run test:integration` need, built from this
# checkout. Idempotent: re-run it any time; it only does what is missing or stale.
#
#   scripts/dev-env.sh           bring everything up to date
#   scripts/dev-env.sh --check   report what is ready / missing / stale; change nothing
#
# What it touches: this checkout (node_modules, vendor/prime-agent's node_modules and
# dist, vendor/mcp-bench, .venv-itest) and ONE thing outside it — the kernel venv
# prime uses (PRIME_AGENT_KERNEL_PYTHON, else PRIME_AGENT_KERNEL_VENV, else
# ~/.prime/agent/kernel-venv), into which it installs scripts/requirements/kernel.txt.
# It never installs system packages or edits dotfiles; a missing tool is reported with
# the command that would install it, and the script stops.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIME="$ROOT/vendor/prime-agent"
PKGS="$PRIME/packages"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

[ -x "$HOME/.local/bin/uv" ] && export PATH="$HOME/.local/bin:$PATH"

ready=() missing=() stale=()
say() { printf '==> %s\n' "$*"; }
why() { printf '    %s\n' "$@"; }
ok() { ready+=("$1"); printf '    ok: %s\n' "$1"; }
need() { missing+=("$1"); printf '    MISSING: %s\n' "$1"; [ -n "${2:-}" ] && printf '      fix: %s\n' "$2"; return 0; }
old() { stale+=("$1"); printf '    STALE: %s\n' "$1"; }
die() { printf '\nFAILED: %s\n' "$1" >&2; [ -n "${2:-}" ] && printf 'fix: %s\n' "$2" >&2; exit 1; }

# --- 1. tools ---------------------------------------------------------------------
say "tools (node, npm, python3, uv, git; temporal for the Temporal scenario)"
why "Checked, never installed: these are machine-wide and yours to manage."
for t in node npm python3 git; do
	if command -v "$t" >/dev/null; then ok "$t ($(command -v "$t"))"; else need "$t" "install $t (e.g. brew install $t)"; fi
done
if command -v uv >/dev/null; then ok "uv ($(command -v uv))"; else need "uv" "curl -LsSf https://astral.sh/uv/install.sh | sh"; fi
TEMPORAL="${HARNESS_TEMPORAL_CLI:-temporal}"
if command -v "$TEMPORAL" >/dev/null; then ok "temporal CLI ($("$TEMPORAL" --version 2>/dev/null | head -1))"
else need "temporal CLI (only the Temporal integration scenario needs it; it skips without)" "brew install temporal"; fi
if [ "$CHECK" = 0 ] && [ "${#missing[@]}" -gt 0 ]; then
	for m in "${missing[@]}"; do case "$m" in temporal*) ;; *) die "a required tool is missing: $m" "see the fix lines above" ;; esac; done
fi

# --- 2. npm dependencies -------------------------------------------------------------
# Stale when the lockfile is newer than npm's record of the install it made.
npm_stale() { [ ! -f "$1/node_modules/.package-lock.json" ] || [ "$1/package-lock.json" -nt "$1/node_modules/.package-lock.json" ]; }

say "npm dependencies (harness root, vendor/prime-agent)"
why "The prime install uses --ignore-scripts: its 'prepare' script runs husky, which would" \
	"rewrite this repository's git hooks config. Nothing prime needs comes from install scripts."
for spec in "$ROOT|npm ci --no-audit --no-fund" "$PRIME|npm ci --no-audit --no-fund --ignore-scripts"; do
	dir="${spec%%|*}" cmd="${spec#*|}" name="${dir#"$ROOT"}"; name="${name:-/}"
	if npm_stale "$dir"; then
		if [ "$CHECK" = 1 ]; then old "node_modules in $name"; else
			say "installing node_modules in $name ($cmd)"
			(cd "$dir" && $cmd >/dev/null) || die "npm install failed in $dir" "(cd $dir && $cmd)"
			ok "node_modules in $name"
		fi
	else ok "node_modules in $name"; fi
done

# --- 3. prime patches ----------------------------------------------------------------
say "prime patches (scripts/port-vanilla-tools.mjs, scripts/neutralize-prime.mjs)"
why "Replayed on a scratch copy first (the scripts' HARNESS_VENDOR_DIR seam) and compared" \
	"with vendor/prime-agent: the tree is committed patched, so normally there is nothing to" \
	"do and nothing is rewritten (a rewrite would bump mtimes and force a rebuild)."
scratch="$(mktemp -d)"
rsync -a --exclude node_modules --exclude dist "$PRIME" "$ROOT/vendor/pi-mono" "$scratch/"
if ! { HARNESS_VENDOR_DIR="$scratch" node "$ROOT/scripts/port-vanilla-tools.mjs" \
	&& HARNESS_VENDOR_DIR="$scratch" node "$ROOT/scripts/neutralize-prime.mjs"; } >"$scratch/replay.log" 2>&1; then
	cat "$scratch/replay.log" | tail -20; rm -rf "$scratch"
	die "the patch scripts fail on this tree" "node scripts/neutralize-prime.mjs (and read its error)"
fi
if diff -rq -x node_modules -x dist "$scratch/prime-agent/packages" "$PKGS" >/dev/null; then
	ok "prime patches applied (replay matches vendor/prime-agent)"
elif [ "$CHECK" = 1 ]; then
	old "vendor/prime-agent differs from the patch scripts' output (run without --check)"
else
	node "$ROOT/scripts/port-vanilla-tools.mjs" >/dev/null || die "port-vanilla-tools failed" "node scripts/port-vanilla-tools.mjs"
	node "$ROOT/scripts/neutralize-prime.mjs" >/dev/null || die "neutralize-prime failed" "node scripts/neutralize-prime.mjs"
	ok "prime patches applied (vendor/prime-agent changed: commit it, the scripts and the tree must agree)"
fi
rm -rf "$scratch"

# --- 4. prime build ------------------------------------------------------------------
# Built package by package, never with `npm run build`: the ai package's build first
# runs generate-models, which fetches the model catalogue over the network, rewrites
# packages/ai/src/models.generated.ts, and fails offline. A dist older than its src
# is rebuilt — a stale dist once made seven remote-kernel tests fail for no reason
# anyone could see in the source.
say "prime build (tui -> ai -> agent -> coding-agent, no model-catalogue regeneration)"
GEN="packages/ai/src/models.generated.ts"
entry() { case "$1" in coding-agent) echo "dist/cli.js" ;; *) echo "dist/index.js" ;; esac; }
is_stale() {
	local pkg="$PKGS/$1" e
	e="$pkg/$(entry "$1")"
	[ ! -f "$e" ] && return 0
	[ -n "$(find "$pkg/src" -type f -newer "$e" -print -quit 2>/dev/null)" ]
}
build_pkg() {
	local pkg="$PKGS/$1"
	(cd "$pkg" && npx --no-install tsgo -p tsconfig.build.json) || die "tsgo failed in packages/$1" "(cd $pkg && npx tsgo -p tsconfig.build.json)"
	if [ "$1" = coding-agent ]; then
		(cd "$pkg" && chmod +x dist/cli.js && npm run -s copy-assets >/dev/null && npm run -s bundle >/dev/null) \
			|| die "coding-agent assets/bundle failed" "(cd $pkg && npm run copy-assets && npm run bundle)"
	fi
	touch "$pkg/$(entry "$1")"
}
rebuild_rest=0
for p in tui ai agent coding-agent; do
	if [ "$rebuild_rest" = 1 ] || is_stale "$p"; then
		if [ "$CHECK" = 1 ]; then old "prime packages/$p (dist missing or older than src)"; continue; fi
		say "building packages/$p"
		build_pkg "$p"
		rebuild_rest=1
		ok "packages/$p built"
	else ok "packages/$p dist is current"; fi
done
if ! git -C "$PRIME" diff --quiet -- "$GEN" 2>/dev/null; then
	if [ "$CHECK" = 1 ]; then old "$GEN is modified (a full 'npm run build' rewrote it)"
	else git -C "$PRIME" checkout -- "$GEN"; ok "restored $GEN (something regenerated it)"; fi
fi

# --- 5. the kernel venv prime uses ------------------------------------------------------
say "kernel venv (where prime starts ipykernel) + scripts/requirements/kernel.txt"
why "Resolved the way prime resolves it: PRIME_AGENT_KERNEL_PYTHON, else" \
	"PRIME_AGENT_KERNEL_VENV/bin/python, else ~/.prime/agent/kernel-venv/bin/python."
if [ -n "${PRIME_AGENT_KERNEL_PYTHON:-}" ]; then KPY="$PRIME_AGENT_KERNEL_PYTHON"
else KPY="${PRIME_AGENT_KERNEL_VENV:-$HOME/.prime/agent/kernel-venv}/bin/python"; fi
if [ ! -x "$KPY" ]; then
	if [ "$CHECK" = 1 ] || [ -n "${PRIME_AGENT_KERNEL_PYTHON:-}" ]; then
		need "kernel venv python at $KPY" "scripts/dev-env.sh (without --check) lets prime bootstrap it; or set PRIME_AGENT_KERNEL_PYTHON"
	else
		say "no kernel venv yet: asking prime to bootstrap it (its own ensureKernelPython)"
		node --input-type=module -e "const m = await import('$PKGS/coding-agent/dist/core/kernel/bootstrap.js'); console.log(await m.ensureKernelPython());" \
			|| die "prime could not bootstrap its kernel venv" "run any prime session once, or set PRIME_AGENT_KERNEL_PYTHON"
	fi
fi
if [ -x "$KPY" ]; then
	req="$ROOT/scripts/requirements/kernel.txt"
	if "$KPY" - "$req" <<'PY' 2>/dev/null
import sys
from importlib.metadata import version
for line in open(sys.argv[1]):
    line = line.split("#")[0].strip()
    if not line:
        continue
    name, want = line.split("==")
    if version(name) != want:
        raise SystemExit(1)
PY
	then ok "kernel venv $KPY has scripts/requirements/kernel.txt"
	elif [ "$CHECK" = 1 ]; then old "kernel venv $KPY lacks pins from scripts/requirements/kernel.txt"
	else
		say "installing scripts/requirements/kernel.txt into $KPY"
		uv pip install --quiet --python "$KPY" -r "$req" || die "kernel requirements install failed" "uv pip install --python $KPY -r $req"
		ok "kernel venv $KPY has scripts/requirements/kernel.txt"
	fi
fi

# --- 6. MCP-Bench task set --------------------------------------------------------------
say "vendor/mcp-bench (task-driven tests read it)"
if [ -e "$ROOT/vendor/mcp-bench" ]; then ok "vendor/mcp-bench"
else
	PRIMARY="$(git -C "$ROOT" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')"
	if [ "$CHECK" = 1 ]; then need "vendor/mcp-bench" "scripts/dev-env.sh (links the primary checkout's copy in a worktree, else clones)"
	elif [ -f "$ROOT/.git" ] && [ -n "$PRIMARY" ] && [ -d "$PRIMARY/vendor/mcp-bench" ]; then
		why "a worktree: linking the primary checkout's copy instead of cloning 53MB again"
		ln -s "$PRIMARY/vendor/mcp-bench" "$ROOT/vendor/mcp-bench"; ok "vendor/mcp-bench -> $PRIMARY/vendor/mcp-bench"
	else
		"$ROOT/scripts/setup-mcp-bench.sh" --clone-only || die "mcp-bench clone failed" "scripts/setup-mcp-bench.sh --clone-only"
		ok "vendor/mcp-bench"
	fi
fi

# --- 7. the integration tier's venv -------------------------------------------------------
say ".venv-itest (temporalio, for the Temporal scenario and unit tests)"
why "Project-local and gitignored; scripts/requirements/itest.txt is the pin."
VPY="$ROOT/.venv-itest/bin/python"
ireq="$ROOT/scripts/requirements/itest.txt"
if [ -x "$VPY" ] && "$VPY" -c "import temporalio, sys; sys.exit(temporalio.__version__ != '$(sed -n 's/^temporalio==//p' "$ireq")')" 2>/dev/null; then
	ok ".venv-itest"
elif [ "$CHECK" = 1 ]; then old ".venv-itest missing or not at the pinned temporalio"
else
	[ -x "$VPY" ] || uv venv --quiet --python 3.11 "$ROOT/.venv-itest" || die "could not create .venv-itest" "uv venv --python 3.11 .venv-itest"
	VIRTUAL_ENV="$ROOT/.venv-itest" uv pip install --quiet -r "$ireq" || die "itest requirements install failed" "VIRTUAL_ENV=.venv-itest uv pip install -r $ireq"
	ok ".venv-itest"
fi

# --- 8. outside this checkout, reported only ---------------------------------------------
say "reported, not managed here"
RK="${RK_TEST_VENV:-$HOME/.cache/harness-remote-kernel-test/kernel-venv}"
if [ -x "$RK/bin/python" ]; then ok "remote-kernel test venv ($RK)"
else why "remote-kernel test venv ($RK) is absent: test:remote-kernel builds it on its first run (a few minutes)"; fi

# --- summary ---------------------------------------------------------------------------
echo
echo "ready: ${#ready[@]}   missing: ${#missing[@]}   stale: ${#stale[@]}"
for m in ${missing[@]+"${missing[@]}"}; do echo "  missing: $m"; done
for s in ${stale[@]+"${stale[@]}"}; do echo "  stale:   $s"; done
if [ "${#missing[@]}" -gt 0 ] || [ "${#stale[@]}" -gt 0 ]; then
	[ "$CHECK" = 1 ] && echo "run scripts/dev-env.sh to fix what it can"
	only_temporal=1
	for m in ${missing[@]+"${missing[@]}"}; do case "$m" in temporal*) ;; *) only_temporal=0 ;; esac; done
	[ "${#stale[@]}" -eq 0 ] && [ "$only_temporal" = 1 ] && exit 0
	exit 1
fi
echo "environment ready: npm test, npm run test:kernel, npm run test:remote-kernel, npm run test:integration"
