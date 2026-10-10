import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HARNESS_ROOT, stageRuntime } from "../prelude.mjs";

const RUNTIME = join(HARNESS_ROOT, "runtime");
const LOCAL = new Set(readdirSync(RUNTIME).filter((f) => f.endsWith(".py")).map((f) => f.slice(0, -3)));

/** Runtime modules a Python file imports, guarded (try/except ImportError) or not. */
function localImports(file) {
	const out = new Set();
	for (const m of readFileSync(file, "utf8").matchAll(/^\s*(?:from\s+([A-Za-z_]\w*)|import\s+([A-Za-z_][\w, ]*))/gm)) {
		const names = m[1] ? [m[1]] : m[2].split(",").map((n) => n.trim().split(/\s+/)[0]);
		for (const n of names) if (LOCAL.has(n) && !n.startsWith("test_")) out.add(`${n}.py`);
	}
	return out;
}

test("every runtime module the prelude and the staged runtime import is staged with them", () => {
	const dir = mkdtempSync(join(tmpdir(), "hk-rt-"));
	stageRuntime(HARNESS_ROOT, dir);
	const staged = new Set(readdirSync(dir));
	const missing = new Set();
	for (const file of [join(RUNTIME, "kernel-prelude.py"), ...[...staged].map((f) => join(dir, f))]) {
		for (const dep of localImports(file)) if (!staged.has(dep)) missing.add(`${dep} (imported by ${file.split("/").pop()})`);
	}
	assert.deepEqual([...missing], [], "a module missing here fails only inside the kernel, where the host sees nothing");
});
