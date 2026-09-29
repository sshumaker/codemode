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
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KERNEL_ENV_ALLOW, SYSTEM_READABLE, defaultEgressListen, egressSocketPath, srtSettings } from "../../runtime/posture.mjs";
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

describe("srt settings are an allow-list from the root", () => {
	const s = srtSettings({ runDir: "/run/x", home: "/home/u", readable: ["/run/x", "/opt/venv"], writable: ["/run/scratch"], platform: "linux" });

	it("denies the root and re-allows only the system paths and the named ones", () => {
		assert.deepEqual(s.filesystem.denyRead, ["/"]);
		assert.deepEqual(s.filesystem.allowRead, [...SYSTEM_READABLE.linux, "/run/x", "/opt/venv"]);
	});

	it("writes nowhere but the run directory and the named scratch", () => {
		assert.deepEqual(s.filesystem.allowWrite, ["/run/x", "/run/scratch"]);
	});

	it("allows no domain at all", () => {
		// The kernel reaches the egress proxy over loopback (macOS) rather than
		// through this list. An entry here would be a second route out.
		assert.deepEqual(s.network.allowedDomains, []);
	});

	it("refuses an entry that re-opens a shared region, in either list", () => {
		const home = homedir();
		for (const bad of ["/", "/tmp", "/private/tmp", tmpdir(), home, dirname(home), "/var", "/private"]) {
			assert.throws(() => srtSettings({ runDir: "/run/x", home, readable: [bad] }), /covers the shared region/, bad);
			assert.throws(() => srtSettings({ runDir: "/run/x", home, readable: [], writable: [bad] }), /covers the shared region/, bad);
		}
	});

	it("accepts a run's own directory under the shared temp dir, in both spellings", () => {
		const own = mkdtempSync(join("/tmp", "posture-own-"));
		try {
			const t = srtSettings({ runDir: own, home: homedir(), readable: [], writable: [join(own, "later")] });
			assert.ok(t.filesystem.allowRead.includes(own));
			if (process.platform === "darwin") {
				assert.ok(t.filesystem.allowRead.includes(realpathSync(own)), "the resolved spelling seatbelt matches");
				// Not created yet, and still resolved through its existing ancestor.
				assert.ok(t.filesystem.allowWrite.includes(join(realpathSync(own), "later")));
			}
		} finally {
			rmSync(own, { recursive: true, force: true });
		}
	});
});

describe("the proxy's address form follows the platform's sandbox", () => {
	// The Linux half of §7.2, as an executed check. bwrap gives the sandbox its own
	// network namespace, so a TCP default there is a boundary with no working door —
	// and the failure looks like "the agent never called spawn", not like an error.
	it("linux defaults to the unix socket, macOS keeps the proven TCP loopback", () => {
		const real = process.platform;
		try {
			for (const [platform, want] of [["linux", "unix"], ["darwin", "tcp"], ["win32", "tcp"]]) {
				Object.defineProperty(process, "platform", { value: platform, configurable: true });
				assert.equal(defaultEgressListen(), want, `${platform} should listen ${want}`);
			}
		} finally {
			Object.defineProperty(process, "platform", { value: real, configurable: true });
		}
	});

	it("the socket-path ceiling is the same number in the proxy and in the harness", () => {
		// Two copies of a kernel constant, in two languages. Disagreement is a run
		// that dies at bind() with "invalid argument" — the proxy refusing a path
		// this module handed it.
		const go = /unixPathMax = (\d+)/.exec(read("proxy/egress/main.go"));
		const js = /UNIX_PATH_MAX = (\d+)/.exec(read("runtime/posture.mjs"));
		assert.ok(go && js, "one of the two ceilings is no longer a named constant");
		assert.equal(js[1], go[1]);
	});

	it("a socket path too long for the run directory falls back inside the ceiling", () => {
		const ceiling = Number(/UNIX_PATH_MAX = (\d+)/.exec(read("runtime/posture.mjs"))[1]);
		assert.equal(egressSocketPath("/run/x"), "/run/x/egress.sock");
		const deep = `/run/${"nested-run-directory/".repeat(8)}`;
		const fallback = egressSocketPath(deep, "s");
		assert.ok(fallback.length < ceiling, `fallback ${fallback} is ${fallback.length} bytes`);
		assert.notEqual(fallback, join(deep, "egress.sock"));
	});

	it("the MCP runners ask for TCP and refuse Linux, where their clients cannot reach it", () => {
		// The MCP route is used by clients that speak HTTP over TCP only. Taking the
		// platform default there would give a Linux run a socket its arms cannot dial
		// — a posture whose single route out is dead, which reads as an ungrounded
		// agent rather than as a broken boundary.
		for (const file of ["bench/run-task.mjs", "bench/appworld/run-task.mjs"]) {
			const src = read(file);
			assert.match(src, /listen: "tcp"/, `${file} does not pin the MCP transport`);
			assert.match(src, /process\.platform === "linux"/, `${file} does not refuse the Linux case`);
			assert.match(src, /unix socket \(docs\/CLOUD-HARNESS-DESIGN\.md §7\.2\)/, `${file}'s refusal cites no reason`);
		}
	});

	it("a unix-only proxy is told to open no port", () => {
		// --listen has a real default, so the socket case has to say "none" out loud;
		// forgetting it would leave a TCP listener open on the platform where TCP is
		// exactly what does not work. (The rule itself is pinned in Go —
		// TestSocketOnlyRunOpensNoPort.)
		assert.match(read("runtime/posture.mjs"), /"--listen", listen === "unix" \? "none" : "127\.0\.0\.1:0"/);
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

describe("the kernel fails closed", () => {
	// The variable is the transport for the posture, never the policy. The old
	// gate ran bare on silence, and silence is how the product arm shipped
	// model-authored code execution with no boundary for weeks: nothing forced
	// any launcher to set the variable, and nothing recorded that it hadn't.
	const kernel = read("vendor/prime-agent/packages/coding-agent/src/core/kernel/index.ts");

	it("the vendored kernel refuses silence", () => {
		assert.match(kernel, /!sandboxSettings && process\.env\.HARNESS_KERNEL_SANDBOX !== "off"/);
		assert.match(kernel, /refusing to start an unsandboxed kernel/);
	});

	it("the patch generator produces the same refusal", () => {
		// The vendored tree is patch OUTPUT; a fix applied there but not in
		// scripts/neutralize-prime.mjs evaporates on the next re-vendor.
		const gen = read("scripts/neutralize-prime.mjs");
		assert.match(gen, /refusing to start an unsandboxed kernel/);
		assert.match(gen, /HARNESS_KERNEL_SANDBOX !== "off"/);
	});

	// Every launcher that can legitimately run bare must SAY so — otherwise its
	// next run dies at kernel start, which is the fail-closed behaviour working,
	// but dying in CI is not how the condition should be discovered.
	const explicitOff = [
		["runtime/eval/run.mjs", /HARNESS_KERNEL_SANDBOX: "off"/],
		["bench/run-task.mjs", /HARNESS_KERNEL_SANDBOX: "off"/],
		["bench/appworld/run-task.mjs", /HARNESS_KERNEL_SANDBOX: "off"/],
		["bench/terminal/prime_agent.py", /"HARNESS_KERNEL_SANDBOX": "off"/],
	];
	for (const [file, pattern] of explicitOff) {
		it(`${file} says bare explicitly when it chooses bare`, () => {
			assert.match(read(file), pattern);
		});
	}

	it("the subagent spec carries the choice to children", () => {
		// A child that inherits settings but not the off-marker would refuse to
		// start under a parent that chose bare; one that inherits neither would
		// run less confined than its parent. Both are boundary state.
		const py = read("runtime/subagents.py");
		assert.match(py, /"HARNESS_KERNEL_SANDBOX",/);
	});
});
