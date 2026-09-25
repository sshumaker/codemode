#!/usr/bin/env bash
# SPIKE: assemble the in-sandbox kernel-server package (pkg/) from the built vendored prime.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CA="$HERE/../../vendor/prime-agent/packages/coding-agent"
(cd "$CA" && npx tsgo -p tsconfig.build.json && node scripts/bundle.mjs)
rm -rf "$HERE/pkg" && mkdir -p "$HERE/pkg/dist"
"$CA/../../node_modules/.bin/esbuild" "$CA/dist/core/kernel/remote-server.js" --bundle --platform=node --format=esm \
  --external:zeromq --external:koffi --external:undici --outfile="$HERE/pkg/dist/kernel-server.mjs" \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --define:__PI_BUNDLED__=true --define:__PI_BUILD_ID__='"spike"' --log-level=warning
cp "$CA/package.json" "$HERE/pkg/"
cp -R "$CA/dist/skills" "$CA/dist/prime-agent-runtime" "$HERE/pkg/dist/"
