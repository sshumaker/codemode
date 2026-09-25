/**
 * The generated transport's per-call timeout is host-configurable. A host that holds a
 * call open on a human (an approval prompt, a clarifying question) needs minutes; the
 * default stays 180s so every benchmark condition is unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generate } from "../generate.mjs";

const CATALOGUE = [{ server: "Demo", tools: [{ name: "ping", description: "Ping.", inputSchema: { type: "object", properties: {} } }] }];

function timeoutWith(env) {
	const dir = mkdtempSync(join(tmpdir(), "client-timeout-"));
	try {
		for (const [rel, content] of Object.entries(generate(CATALOGUE).files)) {
			mkdirSync(dirname(join(dir, "api", rel)), { recursive: true });
			writeFileSync(join(dir, "api", rel), content);
		}
		const r = spawnSync("python3", ["-c", "import api._client as c; print(c._TIMEOUT)"], {
			cwd: dir,
			env: { PATH: process.env.PATH, ...env },
			encoding: "utf8",
		});
		assert.equal(r.status, 0, r.stderr);
		return Number(r.stdout.trim());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("the client timeout defaults to 180s", () => {
	assert.equal(timeoutWith({}), 180);
});

test("HARNESS_MCP_TIMEOUT_S overrides the client timeout", () => {
	assert.equal(timeoutWith({ HARNESS_MCP_TIMEOUT_S: "1020" }), 1020);
});

test("a malformed HARNESS_MCP_TIMEOUT_S falls back to the default", () => {
	assert.equal(timeoutWith({ HARNESS_MCP_TIMEOUT_S: "soon" }), 180);
});
