/**
 * The boundary posture, pinned as executed checks.
 *
 * CLAUDE.md: "A documented check is not an executed check." Everything asserted
 * here was, at some point in building this, true only in a comment — and two of
 * them (the duplicated allow-list, the default being off) are the kind that fail
 * silently and produce a plausible number rather than an error.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KERNEL_ENV_ALLOW, srtSettings } from "../../runtime/posture.mjs";
import { renderClient } from "../generate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

describe("the kernel env allow-list has one definition", () => {
	// prime_agent.py cannot import the .mjs, so it carries its own copy. A name
	// added on one side only would give the container kernel a quietly different
	// boundary from the host kernels — visible nowhere, since both runs would
	// still say posture=boundary.
	it("bench/terminal/prime_agent.py matches runtime/posture.mjs", () => {
		const py = read("bench/terminal/prime_agent.py");
		const block = /KERNEL_ENV_ALLOW = ",".join\(\[(.*?)\]\)/s.exec(py);
		assert.ok(block, "prime_agent.py no longer defines KERNEL_ENV_ALLOW as a joined list");
		const names = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
		assert.deepEqual(names, KERNEL_ENV_ALLOW.split(","));
	});

	it("names no credential-shaped variable", () => {
		// The whole point is that the list is short and boring. A KEY/TOKEN/SECRET
		// on it would reintroduce exactly what the allow-list exists to exclude.
		for (const name of KERNEL_ENV_ALLOW.split(",")) {
			assert.doesNotMatch(name, /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i, `allow-list carries ${name}`);
		}
		// HARNESS_* is a prefix and is deliberate — runtime settings, including the
		// egress token, which is scoped to one run and is the sandbox's own.
		assert.ok(KERNEL_ENV_ALLOW.split(",").includes("HARNESS_*"));
	});
});

describe("the posture is off unless asked for", () => {
	// The fairness invariant. Every number in docs/ was measured without it, so a
	// default flip would move measured conditions under a label saying nothing
	// moved.
	const runners = [
		["bench/run-task.mjs", /const posture = argv\.includes\("--posture"\) \|\| process\.env\.HARNESS_POSTURE === "boundary"/],
		["bench/appworld/run-task.mjs", /const posture = argv\.includes\("--posture"\) \|\| process\.env\.HARNESS_POSTURE === "boundary"/],
		["bench/tac/run-task.mjs", /const posture = flag\("posture", "off"\) === "boundary" \|\| process\.env\.HARNESS_POSTURE === "boundary"/],
	];
	for (const [file, pattern] of runners) {
		it(`${file} opts in explicitly`, () => {
			assert.match(read(file), pattern);
		});
	}

	it("bench/terminal/prime_agent.py defaults posture=off and validates it", () => {
		const py = read("bench/terminal/prime_agent.py");
		assert.match(py, /posture: str = "off"/);
		assert.match(py, /posture must be off\|boundary/);
	});

	it("each runner records the posture in its provenance", () => {
		assert.match(read("bench/run-task.mjs"), /meta\.posture = posture \? "boundary" : "off"/);
		// AppWorld writes provenance twice (system-prompt.json and meta.json) and a
		// condition recorded in only one of them is not recorded.
		const aw = read("bench/appworld/run-task.mjs");
		assert.equal((aw.match(/posture: posture \? "boundary" : "off"/g) ?? []).length, 2);
		assert.match(read("bench/tac/run-task.mjs"), /posture: posture \? "boundary" : "off"/);
		assert.match(read("bench/terminal/prime_agent.py"), /"posture": self\._posture/);
	});
});

describe("the container runners refuse a posture the volume cannot honour", () => {
	// Measured: neither agent volume carries the env allow-list patch, while
	// tb-agent DOES honour HARNESS_KERNEL_SANDBOX_*. So the sandbox half can be
	// switched on and seen to work while the kernel still inherits the API key.
	// Setting the variable without checking the build is a silent no-op.
	it("terminal-bench adds the marker to its preflight want-list", () => {
		const py = read("bench/terminal/prime_agent.py");
		assert.match(py, /if self\._posture == "boundary":\s*\n\s*want\.append\("HARNESS_KERNEL_ENV_ALLOW"\)/);
	});

	it("TAC checks the kernel module, not only the ipython tool", () => {
		const tac = read("bench/tac/run-task.mjs");
		assert.match(tac, /posture \? \[\["HARNESS_KERNEL_ENV_ALLOW", "kernel env allow-list"\]\] : \[\]/);
		// The marker lives in kernel/index.js; checking only ipython.js would pass
		// a volume that cannot honour the posture at all.
		assert.match(tac, /dist\/core\/kernel\/index\.js/);
	});
});

describe("srt settings deny the region that holds the credentials", () => {
	const s = srtSettings({ runDir: "/run/x", home: "/home/u", readable: ["/run/x", "/usr"], writable: ["/tmp"] });

	it("denies the whole home directory and re-allows only named paths", () => {
		assert.deepEqual(s.filesystem.denyRead, ["/home/u"]);
		assert.deepEqual(s.filesystem.allowRead, ["/run/x", "/usr"]);
	});

	it("writes nowhere but the run directory and the named scratch", () => {
		assert.deepEqual(s.filesystem.allowWrite, ["/run/x", "/tmp"]);
	});

	it("allows no domain at all", () => {
		// The kernel reaches the egress proxy over loopback (macOS) rather than
		// through this list. An entry here would be a second route out.
		assert.deepEqual(s.network.allowedDomains, []);
	});
});

describe("the MCP transports carry the egress token only when there is one", () => {
	// Off-posture the request has to be byte-identical to every run already
	// reported, so the header is conditional on the variable rather than always
	// present-and-empty.
	it("the generated python client adds the header conditionally", () => {
		// Asserted on the RENDERED client rather than on generate.mjs's source, so
		// this tests what the kernel actually imports.
		const client = renderClient();
		assert.match(client, /_EGRESS_TOKEN = os\.environ\.get\("HARNESS_EGRESS_TOKEN", ""\)/);
		assert.match(client, /if _EGRESS_TOKEN:\n\s+headers\["x-egress-token"\] = _EGRESS_TOKEN/);
		// And the header dict is what the request is built from — a conditional
		// that assigns into a dict nobody passes would be inert.
		assert.match(client, /headers=headers,/);
	});

	it("the vanilla extension adds the header conditionally", () => {
		const ext = read("bench/arms/mcp-tools-extension.ts");
		assert.match(ext, /EGRESS_TOKEN \? \{ "x-egress-token": EGRESS_TOKEN \} : \{\}/);
	});
});
