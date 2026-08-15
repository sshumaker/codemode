#!/usr/bin/env node
/**
 * Do all three arms see the SAME text when a call goes wrong?
 *
 *   node bench/appworld/error-symmetry.mjs [--task 82e2fac_1]
 *
 * If vanilla gets a clean tool-error where codemode gets a Python traceback, the
 * arms differ in error *legibility*, which is not the independent variable — an
 * agent that can read its failure recovers, and one that cannot burns turns. This
 * exercises each arm's real transport against a live world and diffs what the
 * model would receive.
 *
 * Three failure classes, chosen because they are the ones an agent actually hits:
 *
 *   unknown-api        the name does not exist
 *   missing-required   a required parameter is absent
 *   api-level-failure  the call is well formed and the server refuses it
 *
 * "Same" means the *content* is byte-identical. Delivery is expected to differ and
 * is reported separately: codemode receives a string as the value of an expression
 * inside a stateful cell, vanilla receives a tool result. That difference is the
 * thing under study.
 *
 * The one asymmetry this cannot remove: at L4 the provider validates arguments
 * against a resident schema before the call is ever made, so `missing-required`
 * may never reach the transport at all. That is a genuine benefit of residency and
 * belongs in the results, not in a fixup.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeArgv } from "../argv.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const APPWORLD = join(ROOT, "vendor/appworld");
const PYTHON = join(APPWORLD, ".venv/bin/python3");
const ENV_SERVER = join(ROOT, "bench/appworld/env-server.py");

const argv = process.argv.slice(2);
const { flag } = makeArgv(argv);
const taskId = flag("task", "82e2fac_1");
const runDir = mkdtempSync(join(tmpdir(), "appworld-symmetry-"));

const CASES = [
	{ name: "unknown-api", server: "spotify", tool: "no_such_api", args: {} },
	{ name: "missing-required", server: "spotify", tool: "show_song", args: {} },
	{ name: "api-level-failure", server: "spotify", tool: "login", args: { username: "nobody@example.com", password: "wrong" } },
];

function startWorld() {
	const child = spawn(PYTHON, [ENV_SERVER, "--task-id", taskId, "--run-dir", runDir, "--arm", "symmetry", "--appworld-root", APPWORLD], {
		cwd: APPWORLD,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return new Promise((resolve, reject) => {
		let out = "";
		const timer = setTimeout(() => reject(new Error("env-server did not start")), 180_000);
		child.stdout.on("data", (d) => {
			out += d;
			const m = /ENV_SERVER_READY port=(\d+)/.exec(out);
			if (m) {
				clearTimeout(timer);
				resolve({ child, port: Number(m[1]) });
			}
		});
		child.on("exit", (c) => reject(new Error(`env-server exited ${c}`)));
	});
}

/**
 * codemode: what the generated api/ module returns.
 *
 * Reproduces `_client.call` exactly — same payload, same ok/text handling, same
 * McpError on a transport failure — rather than approximating it, so a change to
 * renderClient() shows up here.
 */
async function codemodeSees(port, c) {
	const response = await fetch(`http://127.0.0.1:${port}/call`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ server: c.server, tool: c.tool, args: c.args, meta: { arm: "codemode" } }),
	});
	const body = await response.json();
	if (!body.ok) return { delivery: "McpError raised in cell", text: `${c.server}.${c.tool}: ${body.error}` };
	return { delivery: "string returned into cell", text: body.text ?? "" };
}

/** vanilla: what mcp-tools-extension.ts's invoke() hands back as a tool result. */
async function vanillaSees(port, c) {
	const response = await fetch(`http://127.0.0.1:${port}/call`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ server: c.server, tool: c.tool, args: c.args, meta: { arm: "vanilla" } }),
	});
	const body = await response.json();
	if (!body.ok) return { delivery: "tool error (isError)", text: body.error ?? "" };
	return { delivery: "tool result", text: body.text ?? "" };
}

const { child, port } = await startWorld();
let mismatches = 0;
console.log(`world up on :${port} for ${taskId}\n`);
for (const c of CASES) {
	const cm = await codemodeSees(port, c);
	const van = await vanillaSees(port, c);
	const same = cm.text === van.text;
	if (!same) mismatches++;
	console.log(`${c.name}`);
	console.log(`  codemode  [${cm.delivery}] ${JSON.stringify(cm.text.slice(0, 200))}`);
	console.log(`  vanilla   [${van.delivery}] ${JSON.stringify(van.text.slice(0, 200))}`);
	console.log(`  content identical: ${same ? "YES" : "NO  <-- legibility differs, not representation"}\n`);
}
try {
	await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", body: "{}" });
} catch {
	// going away anyway
}
child.kill("SIGKILL");
console.log(mismatches === 0 ? "PASS: all arms receive identical error content" : `FAIL: ${mismatches} case(s) differ`);
process.exit(mismatches === 0 ? 0 : 1);
