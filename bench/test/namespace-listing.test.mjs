/**
 * HARNESS_SHOW_NAMESPACE's listing, against a real ipykernel and the COMPILED tool.
 *
 * The listing tells the model what each name holds and where it came from, so a
 * stale origin is a wrong answer it acts on: `x += 41` left `x  # = 1`. And it was
 * unbounded, in rows and in the names it remembers.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const IPY = await import(join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/core/tools/ipython.js"));
const KERNEL_PYTHON = process.env.PRIME_AGENT_KERNEL_PYTHON ?? join(homedir(), ".prime/agent/kernel-venv/bin/python");
const KEYS = ["PRIME_AGENT_KERNEL_PYTHON", "HARNESS_KERNEL_SANDBOX", "HARNESS_SHOW_NAMESPACE"];

const text = (r) => r.content.map((c) => c.text ?? "").join("");
const listing = (r) => text(r).split("[kernel — already available")[1] ?? "";

describe("namespace listing", { skip: !existsSync(KERNEL_PYTHON) && "no kernel python" }, () => {
	let scratch;
	let provisioner;
	let cell;
	const saved = {};

	before(() => {
		for (const k of KEYS) saved[k] = process.env[k];
		process.env.PRIME_AGENT_KERNEL_PYTHON = KERNEL_PYTHON;
		process.env.HARNESS_KERNEL_SANDBOX = "off";
		process.env.HARNESS_SHOW_NAMESPACE = "1";
		scratch = mkdtempSync(join(tmpdir(), "namespace-listing-"));
		provisioner = new IPY.IpythonKernelProvisioner(scratch, {});
		const tool = IPY.createIpythonTool(scratch, { provisioner });
		let n = 0;
		cell = (code) => tool.execute(`n${++n}`, { code });
	});
	after(async () => {
		await provisioner?.dispose();
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
	});

	it("a name rebound by augmented assignment or inside a block loses its old origin", { timeout: 60_000 }, async () => {
		assert.match(listing(await cell("x = 1\ny = 2")), /x {2}# = 1, turn-\d+\.py:1/);
		const rebound = listing(await cell("x += 41\nif True:\n    y = 40"));
		assert.doesNotMatch(rebound, /x {2}# = 1/, "x still claims the line it no longer holds");
		assert.doesNotMatch(rebound, /y {2}# = 2/, "y still claims the line it no longer holds");
		assert.match(rebound, /^ {2}x$/m);
	});

	it("shows at most 50 rows, and counts the rest", { timeout: 60_000 }, async () => {
		const shown = listing(await cell(Array.from({ length: 80 }, (_, i) => `row${i} = ${i}`).join("\n")));
		const rows = shown.split("\n").filter((l) => /^ {2}\S/.test(l));
		assert.equal(rows.length, 51, shown);
		assert.match(rows.at(-1), /^ {2}\.\.\. and \d+ more \(%whos lists everything\)$/);
	});

	it("remembers the origins of at most 2,000 names, oldest forgotten first", { timeout: 60_000 }, async () => {
		const r = await cell(Array.from({ length: 2100 }, (_, i) => `a${i} = ${i}`).join("\n"));
		const rows = listing(r).split("\n");
		const a0 = rows.find((l) => /^ {2}a0\b/.test(l));
		assert.equal(a0, "  a0", "the oldest origin was kept past the cap");
		assert.match(rows.find((l) => /^ {2}a1000\b/.test(l)) ?? "", /a1000 {2}# = 1000/, "a recent origin was dropped");
	});
});
