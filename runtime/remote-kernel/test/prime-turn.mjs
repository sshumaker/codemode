/**
 * One real prime print-mode turn with the kernel behind HARNESS_REMOTE_KERNEL_URL:
 * the model calls a fixture tool through the tunnel, writes the answer to a file in
 * the sandbox, and reads it back with the read tool. Shared by the fake and live
 * tests; the caller supplies the connection env and the fixture proxy.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CA } from "./fake-server.mjs";

export const PRIME_TURN_PROMPT =
	"Use the ipython tool. In one cell: `import os` and `from api.fixture import echo`, then `r = await echo(text='sandbox-turn')`, " +
	"write str(r) to outputs/tool.txt (create outputs/ if needed), and print 'cell-sees-key: ' followed by 'yes' if " +
	"os.environ.get('ANTHROPIC_API_KEY') is set, else 'no' (never print a value). Then use the read tool to read outputs/tool.txt. " +
	"Finish by quoting the file's contents exactly and the cell-sees-key line.";

export function loadModelEnv() {
	const file = process.env.RK_MODEL_ENV_FILE ?? join(process.env.HOME, "src/goals/web/.env.local");
	const env = {};
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
		if (m) env[m[1]] = m[2];
	}
	if (!env.ANTHROPIC_API_KEY) throw new Error(`no ANTHROPIC_API_KEY in ${file}`);
	return env;
}

export function hasModelKey() {
	try {
		loadModelEnv();
		return true;
	} catch {
		return false;
	}
}

/**
 * Run the turn; returns the parsed events, the transcript path, and timings. Async on
 * purpose: the fixture proxy lives in this process, and a spawnSync would block the
 * very event loop that has to answer the tool call.
 */
export async function runPrimeTurn({ connectionEnv, proxyUrl, egressToken, label }) {
	const localCwd = mkdtempSync(join(tmpdir(), "rk-prime-turn-"));
	writeFileSync(join(localCwd, "DECOY.txt"), "if you can read this the read tool ran on the loop\n");
	const env = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		ANTHROPIC_API_KEY: loadModelEnv().ANTHROPIC_API_KEY,
		...connectionEnv,
		HARNESS_MCP_PROXY: proxyUrl,
		HARNESS_EGRESS_TOKEN: egressToken,
		HARNESS_KERNEL_AUTORESTART: "1",
	};
	const t0 = Date.now();
	const p = await new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				join(CA, "dist/cli.js"),
				"-p",
				"--mode",
				"json",
				"--model",
				"anthropic/claude-haiku-4-5",
				"--tools",
				"ipython,read",
				"--cwd",
				localCwd,
				"--no-context-files",
				"--no-prompt-templates",
				"--no-extensions",
				PRIME_TURN_PROMPT,
			],
			{ env, cwd: localCwd, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 540_000);
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, stdout, stderr });
		});
	});
	const wallMs = Date.now() - t0;
	const transcript = join(tmpdir(), `rk-prime-turn-${label}-${Date.now()}.jsonl`);
	writeFileSync(transcript, p.stdout ?? "");
	const events = (p.stdout ?? "")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return {};
			}
		});
	const tools = events.filter((e) => e.type === "tool_execution_end").map((e) => ({ name: e.toolName, isError: e.isError, text: JSON.stringify(e.result).slice(0, 400) }));
	const usage = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").map((e) => e.message.usage);
	const cost = usage.reduce((s, u) => s + (u?.cost?.total ?? 0), 0);
	return { status: p.status, stderr: p.stderr ?? "", events, text: JSON.stringify(events), tools, transcript, wallMs, localCwd, cost };
}

/** What the turn must show, whichever backend ran it. */
export function assertPrimeTurn(r, { proxy, callsBefore, egressToken }) {
	assert.equal(r.status, 0, r.stderr.slice(-2000));
	assert.ok(r.tools.some((t) => t.name === "ipython" && !t.isError), "the model ran a cell");
	assert.ok(r.tools.some((t) => t.name === "read" && !t.isError), "the model used the read tool");
	const readText = r.tools.filter((t) => t.name === "read").map((t) => t.text).join("\n");
	assert.match(readText, /echo:.*sandbox-turn/, "read returned the file the cell wrote");
	assert.doesNotMatch(r.text, /the read tool ran on the loop/);
	assert.ok(proxy.calls.length > callsBefore, "the tool call reached the loop's proxy");
	assert.equal(proxy.calls.at(-1).headers["x-egress-token"], egressToken);
	assert.match(r.text, /cell-sees-key:\s*no/);
	assert.ok(!existsSync(join(r.localCwd, "outputs/tool.txt")), "the file exists only on the kernel's side");
}
