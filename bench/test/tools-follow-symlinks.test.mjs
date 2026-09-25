// The arm links the compiled api package into the agent's working directory as a
// symlink. fd and rg do not follow symlinks by default, so the find and grep tools
// returned "No files found" / "No matches found" for the whole api tree in every
// run from 2026-09-03 until this was read out of a trace on 2026-09-16 (h83 pos 8).
// Pin the patch on the vendored source the artifact is built from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PRIME = join(import.meta.dirname, "../../vendor/prime-agent/packages/coding-agent/src");

test("find tool passes --follow to fd (api/ is a symlink)", () => {
  const src = readFileSync(join(PRIME, "core/tools/find.ts"), "utf8");
  assert.match(src, /\["--glob", "--color=never", "--hidden", "--follow"\]/);
});

test("grep tool passes --follow to rg (api/ is a symlink)", () => {
  const src = readFileSync(join(PRIME, "core/tools/grep.ts"), "utf8");
  assert.match(src, /\["--json", "--line-number", "--color=never", "--hidden", "--follow"\]/);
});
