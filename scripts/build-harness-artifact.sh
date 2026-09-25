#!/usr/bin/env bash
# Build a SELF-IDENTIFYING harness artifact and record it in harness.lock.json.
#
# Replaces `cp -r . /tmp/harness-<whatever>`, which produced five untracked roots
# whose bundles were built four days apart, one of them containing code that is in
# no commit (W44). The directory name IS the provenance, so an unidentifiable
# artifact is not constructible.
#
#   scripts/build-harness-artifact.sh [--out .harness] [--no-build]
#
# The arm needs exactly three things from a harness root, so that is all this
# copies:
#   vendor/prime-agent/packages/coding-agent/dist/**   the bundle it execs
#   runtime/**                                         the kernel startup hooks
#   node_modules                                       symlinked, for .bin/srt
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/.harness"; BUILD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --no-build) BUILD=0; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

SHA=$(git -C "$ROOT" rev-parse HEAD)
DIRTY=""
if [ -n "$(git -C "$ROOT" status --porcelain -- vendor runtime scripts 2>/dev/null)" ]; then
  DIRTY="-dirty"
fi
ID="${SHA:0:12}${DIRTY}"
DEST="$OUT/$ID"

if [ "$BUILD" = "1" ]; then
  echo "==> patching the vendored tree (idempotent since 573b7db)"
  node "$ROOT/scripts/neutralize-prime.mjs" >/dev/null
  echo "==> building the bundle"
  npm --prefix "$ROOT/vendor/prime-agent/packages/coding-agent" run build >/dev/null
fi

CLI="vendor/prime-agent/packages/coding-agent/dist/cli.js"
[ -f "$ROOT/$CLI" ] || { echo "FATAL: $CLI missing — build did not produce a bundle" >&2; exit 1; }

rm -rf "$DEST"; mkdir -p "$DEST/vendor/prime-agent/packages/coding-agent" "$DEST/runtime"
cp -R "$ROOT/vendor/prime-agent/packages/coding-agent/dist" "$DEST/vendor/prime-agent/packages/coding-agent/dist"
# The package BOUNDARY. dist/config.js getPackageDir() walks up from __dirname
# until it finds a package.json, and everything shipped with the package (themes,
# HTML templates) is resolved from there. Copy only dist/ and that walk sails past
# the package, past the artifact, and lands on the HARNESS REPO's package.json --
# so getThemesDir() returned <repo>/dist/modes/interactive/theme and the session
# died ENOENT on prime.json at zero cells. The /tmp roots never hit this because
# `cp -r` swept the package.json in by accident.
cp "$ROOT/vendor/prime-agent/packages/coding-agent/package.json" "$DEST/vendor/prime-agent/packages/coding-agent/package.json"
cp -R "$ROOT/runtime/." "$DEST/runtime/"
ln -sfn "$ROOT/node_modules" "$DEST/node_modules"
# The vendored package's OWN deps. node resolution walks UP from
# dist/cli.js looking for node_modules, and the repo satisfies it from
# vendor/prime-agent/node_modules -- which the first version of this script did
# not copy. Result: the artifact launched, warmed the venv, wrote its condition
# stamp, and then died `ERR_MODULE_NOT_FOUND: proper-lockfile` at 0 cells, 3 of 3
# jobs. Symlinked rather than copied: it is ~hundreds of MB and identical to the
# repo's, whose SHA the artifact id already pins.
ln -sfn "$ROOT/vendor/prime-agent/node_modules" "$DEST/vendor/prime-agent/node_modules"

# The stamp travels WITH the artifact, so a root can always say what it is even
# if the lock file is lost or someone points at it by hand.
cat > "$DEST/harness-provenance.json" <<JSON
{
  "id": "$ID",
  "git_sha": "$SHA",
  "dirty": $([ -n "$DIRTY" ] && echo true || echo false),
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "$ROOT",
  "cli": "$CLI"
}
JSON

# The lock is what workers read instead of hardcoding a path.
cat > "$ROOT/harness.lock.json" <<JSON
{
  "harness_root": "$DEST",
  "id": "$ID",
  "git_sha": "$SHA",
  "dirty": $([ -n "$DIRTY" ] && echo true || echo false)
}
JSON

echo "==> $DEST"
echo "    id=$ID  cli=$(du -sh "$DEST/vendor" | cut -f1)  runtime=$(ls "$DEST/runtime" | wc -l | tr -d ' ') files"

# ACCEPTANCE: run the CLI out of the artifact and require it to answer. Assembling
# the right paths is not the same as being able to execute -- the first version of
# this script passed every existence check and every pre-execution signal (no
# launch refusal, venv warmed, provenance stamped) while failing 3 of 3 jobs at
# zero cells. Existence checks cannot see a missing transitive dependency.
echo "==> acceptance: executing the artifact's CLI"
# --help alone did NOT catch the theme failure: assets load on the interactive
# path. Assert the package boundary resolves to the artifact, which is the
# property that broke.
PKGDIR="$DEST/vendor/prime-agent/packages/coding-agent"
[ -f "$PKGDIR/package.json" ] || { echo "FATAL: package.json missing -- getPackageDir() will escape the artifact" >&2; exit 1; }
[ -f "$PKGDIR/dist/modes/interactive/theme/prime.json" ] || { echo "FATAL: theme assets missing from dist" >&2; exit 1; }
if ! out=$(cd "$DEST" && node "$CLI" --help 2>&1); then
  echo "FATAL: the artifact cannot execute its own CLI." >&2
  echo "$out" | tail -5 >&2
  exit 1
fi
echo "    CLI runs ($(echo "$out" | wc -l | tr -d ' ') lines of help)"

echo "==> harness.lock.json updated"
