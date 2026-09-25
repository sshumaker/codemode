/**
 * The filesystem guard: the correction that lives in the error, not the prompt.
 *
 * Measured provenance (H1 probe, job `6p8nIAVw`): **62 of 75 cells hunted the
 * harness itself** for a tool named in the job brief — `grep -r start_media_job`
 * over `~/src/harness`, daemon sockets, session state, and its own system prompt
 * recovered from a daemon state JSON — with the complete tool index AND an explicit
 * "do not search the filesystem" rule in its system prompt for the whole run. That
 * is in-context guidance at its ceiling, so H2 moves the correction to the channel
 * this project has measured to change behaviour on the very next cell.
 *
 * Imported from the COMPILED tree the arms actually run. A source assertion passes
 * against a stale dist, which is exactly how a condition leaked into two eval jobs
 * earlier today, so the last test here reads the patch source and the built bundle
 * together.
 *
 * The refusal text IS the intervention, so it is pinned verbatim rather than by
 * substring: if someone edits the wording, this test should make them decide to.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/core/tools/ipython.js");

/**
 * The round directory a cell runs in, with the REAL geometry.
 *
 * Not a `mkdtemp` directory: a temp path sits under a temp root, and allowing
 * TMPDIR would then also allow this directory's parent — which is the session
 * directory holding `system-prompt.txt`. Testing against a temp cwd hid exactly
 * that, and the guard needs no filesystem access, so the path need not exist.
 */
const CWD = "/Users/scottshumaker/src/harness/.run/port-w5/runs/6c847cc1/6p8nIAVw/round-1";

/** The cells from the measured failure, in the spellings the trace actually used. */
const HUNTING = {
	"grep over the harness checkout": "%%bash\ngrep -r start_media_job /Users/scottshumaker/src/harness --include=*.py",
	"the same grep via a tilde": "%%bash\ngrep -rn 'start_media_job' ~/src/harness | head -50",
	"reading daemon state": "import json\nstate = json.load(open('/Users/scottshumaker/.prime/agent/daemon-state.json'))",
	"its own system prompt": "print(open('/Users/scottshumaker/src/harness/.run/port-w5/runs/x/session/system-prompt.txt').read())",
	"a whole-machine find": '%%bash\nfind / -name "*.sock" 2>/dev/null | head',
	"subprocess, list form": "import subprocess\nsubprocess.run(['grep', '-r', 'media_job', '/Users/scottshumaker/src/product'])",
	"os.walk over home": "import os\nfor root, dirs, files in os.walk('/Users/scottshumaker/src'):\n    print(root)",
	"$HOME spelling": "%%bash\nls $HOME/.prime/agent",
};

/** Home-relative spellings that must still be refused. */
const TILDE_OFFENCES = {
	// The other half of the tilde bound. A matcher loosened until nothing false
	// fires is a disabled guard; these are the spellings that must keep failing.
	"tilde home path": "%%bash\ngrep -r start_media_job ~/src/harness",
	"tilde user path": "%%bash\ncat ~root/.ssh/id_rsa",
	"bare tilde in a search": "%%bash\ngrep -r start_media_job ~",
};

/** Cells the job legitimately runs, which must be untouched. */
const LEGITIMATE = {
	"the api index, relatively": "print(open('api/INDEX.md').read())",
	"an api module": "import api.agent_tools as lat\nresult = await lat.judge_tool(query='q', assets=['a1'])",
	"a dotted relative path": "open('./api/agent_tools/judge_tool.py').read()",
	"a relative subdirectory": "from pathlib import Path\nPath('out/frames').mkdir(parents=True, exist_ok=True)",
	"scratch in /tmp": "open('/tmp/scratch.txt', 'w').write('x')",
	"scratch via TMPDIR": "import os\npath = os.path.join(os.environ['TMPDIR'], 'work.json')",
	"pure computation": "total = sum(range(10)) / 3\nprint(total)",
	"a division that is not a path": "ratio = width / height\nprint(ratio)",
	"a regex with slashes": "import re\nre.compile(r'/\\\\d+/')",
	"the proxy URL": "import urllib.request\nurllib.request.urlopen('http://127.0.0.1:8765/call')",
	"an mcp route string": 'payload = {"route": "/r/mcp", "tool": "judge_tool"}',
	"a bash cell with no paths": "%%bash\necho hello && python3 -c 'print(1)'",
	// Prose approximations, not paths. Measured in a 40-round arm: `~45`, `~3`,
	// `~1.5`, `~50`, `~60` and `~9` were each expanded to `$HOME + <junk>` and the
	// whole cell refused. Tilde expansion bypasses the SYSTEM_ROOTS bound by
	// construction -- everything under `~` begins `/Users` or `/home` -- so the
	// bluntness has to be bounded in the MATCHER, which is what these pin.
	"a tilde approximation in a markdown table":
		'prompt = "| Product Staging | Athletic-build subjects, arms bent ~45\u00b0 for outerwear |"',
	"tilde approximations in prose": 'brief = "takes ~3 minutes, about ~1.5x, roughly ~50 words"',
	"a tilde approximation before a unit": 'spec = "hold ~60s, then ~9 frames"',
};

describe("the filesystem guard", () => {
	let guard;
	before(async () => {
		guard = await import(DIST);
	});

	it("is OFF by default: every hunting cell is allowed through untouched", () => {
		// Byte-faithful when unset. An unflagged build runs exactly the cells it
		// always ran — including the ones this guard exists to refuse.
		assert.equal(process.env.HARNESS_FS_GUARD, undefined, "the suite leaked the flag");
		for (const [name, code] of Object.entries(HUNTING)) {
			assert.equal(guard.fsGuardCheck(code, CWD), null, `${name} was refused with the guard off`);
		}
	});

	it("only the documented value enables it", () => {
		const before = process.env.HARNESS_FS_GUARD;
		try {
			for (const value of ["", "0", "true", "yes", "on", "2"]) {
				process.env.HARNESS_FS_GUARD = value;
				assert.equal(
					guard.fsGuardCheck(HUNTING["grep over the harness checkout"], CWD),
					null,
					`HARNESS_FS_GUARD=${JSON.stringify(value)} enabled the guard`,
				);
			}
		} finally {
			if (before === undefined) delete process.env.HARNESS_FS_GUARD;
			else process.env.HARNESS_FS_GUARD = before;
		}
	});

	describe("with the guard on", () => {
		/** Run `body` with the guard enabled, restoring the environment after. */
		const guarding = (body) => {
			const before = process.env.HARNESS_FS_GUARD;
			process.env.HARNESS_FS_GUARD = "1";
			try {
				return body();
			} finally {
				if (before === undefined) delete process.env.HARNESS_FS_GUARD;
				else process.env.HARNESS_FS_GUARD = before;
			}
		};

		it("refuses every cell shape from the measured failure", () => {
			guarding(() => {
				for (const [name, code] of Object.entries(HUNTING)) {
					const refusal = guard.fsGuardCheck(code, CWD);
					assert.ok(refusal, `${name} was not refused`);
					assert.match(refusal, /^Refused: \S+ is outside this job's working directory/, name);
				}
			});
		});

		it("permits everything the job legitimately does", () => {
			// The expensive half of a blunt guard is here: a false positive costs a
			// redirected cell, and a false positive on `api/` would break the arm.
			guarding(() => {
				for (const [name, code] of Object.entries(LEGITIMATE)) {
					assert.equal(guard.fsGuardCheck(code, CWD), null, `${name} was wrongly refused`);
				}
			});
		});

		it("still refuses every real home-relative spelling", () => {
			// Paired with the prose cases in LEGITIMATE. The tilde matcher was
			// delimited to stop reading `~45` as a path; a delimiter loose enough to
			// also drop `~/src/harness` would have disabled the guard's original
			// measured offence, so both halves are asserted or neither means anything.
			guarding(() => {
				for (const [name, code] of Object.entries(TILDE_OFFENCES)) {
					const refusal = guard.fsGuardCheck(code, CWD);
					assert.ok(refusal, `${name} was NOT refused -- the tilde bound is a hole`);
				}
			});
		});

		it("permits absolute paths inside the job's own directory", () => {
			guarding(() => {
				assert.equal(guard.fsGuardCheck(`open('${CWD}/api/INDEX.md').read()`, CWD), null);
				assert.equal(guard.fsGuardCheck(`%%bash\nls ${CWD}/api`, CWD), null);
				// The PARENT is refused on purpose: it holds system-prompt.txt and the
				// live stream.jsonl, and reading its own transcript back into context is
				// P7 in the failure ledger.
				assert.ok(guard.fsGuardCheck(`open('${dirname(CWD)}/system-prompt.txt')`, CWD));
			});
		});

		it("names the path it refused, in the spelling the cell used", () => {
			guarding(() => {
				assert.match(guard.fsGuardCheck("%%bash\nls ~/src/harness", CWD), /^Refused: ~\/src\/harness /);
				assert.match(guard.fsGuardCheck("open('/etc/passwd')", CWD), /^Refused: \/etc\/passwd /);
				assert.match(guard.fsGuardCheck('%%bash\nfind / -name "*.py"', CWD), /^Refused: \/ /);
			});
		});

		it("delivers the correction verbatim, in three lines and no traceback", () => {
			// Pinned exactly. This text is the experiment: it is what the model reads
			// instead of the result it wanted, and a reworded version is a different
			// intervention that should be a deliberate edit rather than a drift.
			const refusal = guarding(() => guard.fsGuardCheck("%%bash\ngrep -r x /Users/someone/src", CWD));
			assert.equal(
				refusal,
				"Refused: /Users/someone/src is outside this job's working directory, and nothing was executed.\n" +
					"This machine is not part of the job. Your tools are Python packages under ./api — the index is in your system prompt.\n" +
					"A tool named in the brief that is not under api/ belongs to a different agent; deliver the outcome with the tools you have.",
			);
			assert.equal(refusal.split("\n").length, 3, "the refusal grew past three lines");
		});

		it("names the skills surface too when the job declares a skills tree (H20 n7Lw6uhp: the refusal taught api-only and the job walked past skills/)", () => {
			const prev = process.env.HARNESS_SKILLS_ROOT;
			try {
				process.env.HARNESS_SKILLS_ROOT = "/nonexistent/skills";
				const refusal = guarding(() => guard.fsGuardCheck("%%bash\ngrep -r x /Users/someone/src", CWD));
				assert.match(refusal, /Playbooks are files under \.\/skills\./);
				assert.equal(refusal.split("\n").length, 3, "the refusal grew past three lines");
			} finally {
				if (prev === undefined) delete process.env.HARNESS_SKILLS_ROOT;
				else process.env.HARNESS_SKILLS_ROOT = prev;
			}
		});
	});

	it("is read per call, so one dist can serve both arms of an A/B", () => {
		const code = HUNTING["grep over the harness checkout"];
		assert.equal(guard.fsGuardCheck(code, CWD), null);
		process.env.HARNESS_FS_GUARD = "1";
		assert.ok(guard.fsGuardCheck(code, CWD), "the flag did not enable the guard");
		delete process.env.HARNESS_FS_GUARD;
		assert.equal(guard.fsGuardCheck(code, CWD), null, "the guard stayed on after the flag was cleared");
	});

	it("the REAL patched tool refuses the cell, with no kernel and no model", async () => {
		// Drives `createIpythonToolDefinition(...).execute(...)` — the actual arm — not
		// just the helper. This is the test that matters, and it is only possible
		// because the refusal happens before any kernel work: 0ms, no venv, no API key.
		//
		// It found a real bug that no unit test of `fsGuardOffence` would have: driven
		// with a malformed argument the guard threw on `undefined.matchAll`, turning a
		// refusable cell into a dead tool call. Hence the typeof check in the patch.
		//
		// Only ever called with the guard ON and a hunting cell. With the guard off
		// this same call would boot a kernel, which a unit test has no business doing.
		const { createIpythonToolDefinition } = guard;
		const def = createIpythonToolDefinition(CWD);
		const before = process.env.HARNESS_FS_GUARD;
		process.env.HARNESS_FS_GUARD = "1";
		try {
			const started = Date.now();
			const res = await def.execute("call-1", { code: HUNTING["the same grep via a tilde"] }, undefined, undefined, {});
			assert.equal(res.isError, true, "the refusal did not come back as an error");
			assert.equal(res.details?.errorEname, "FilesystemGuard");
			assert.equal(res.details?.durationMs, 0, "the cell was executed before being refused");
			assert.ok(Date.now() - started < 1_000, "something booted before the guard ran");
			assert.equal(res.content[0].text, guard.fsGuardRefusal("~/src/harness"));
		} finally {
			if (before === undefined) delete process.env.HARNESS_FS_GUARD;
			else process.env.HARNESS_FS_GUARD = before;
		}
	});

	it("never throws, whatever it is handed", () => {
		// The guard is the first thing in the tool's hot path, so an exception here is
		// a dead tool rather than a refused cell.
		process.env.HARNESS_FS_GUARD = "1";
		try {
			for (const [code, cwd] of [
				[undefined, CWD],
				["", CWD],
				[null, CWD],
				["open('/etc/passwd')", undefined],
				[{ not: "a string" }, CWD],
			]) {
				assert.doesNotThrow(() => guard.fsGuardCheck(code, cwd), `threw on ${JSON.stringify(code)}`);
			}
		} finally {
			delete process.env.HARNESS_FS_GUARD;
		}
	});

	it("refuses BEFORE the kernel runs the cell, as that cell's own error", () => {
		// The mechanism is that the model reads this as an ordinary cell error in the
		// turn that made the mistake. If the check moved after execution, the hunting
		// would have already happened and the guard would be decoration.
		const source = readFileSync(join(ROOT, "vendor/prime-agent/packages/coding-agent/src/core/tools/ipython.ts"), "utf8");
		// All the guards, one path: `fsGuardCheck(...) ?? execGuardCheck(...) ?? ...`.
		const chain = /const fsRefusal = fsGuardCheck\(code, cwd\)((?:\s*\?\?\s*\w+\(code\))*);/.exec(source);
		const check = chain ? chain.index : -1;
		const execute = source.indexOf("await executeWithBusyKernelChoice(");
		assert.ok(check > 0, "the guard is not wired into the tool");

		// The invariant, not the literal: every gate this module DEFINES must appear
		// in that chain. A gate can otherwise be written, tested in isolation, and
		// never reached -- which is exactly how the vanilla L1 arm shipped tools the
		// model could see and never call, and every "L1" number became an L4 number
		// under an L1 label. A guard that is not wired is decoration with tests.
		const defined = [...source.matchAll(/export function (\w+(?:Gate|Guard)Check)\(/g)].map((m) => m[1]);
		assert.ok(defined.length >= 3, `expected several gates, found ${defined.join(", ")}`);
		for (const name of defined) {
			assert.ok(
				chain[0].includes(`${name}(code`),
				`${name} is defined but never reaches the pre-execution chain:\n  ${chain[0]}`,
			);
		}
		assert.ok(check < execute, "the guard runs after the cell has already executed");
		assert.match(source.slice(check, execute), /errorEname: "FilesystemGuard"/);
		assert.match(source.slice(check, execute), /isError: true/);
	});

	describe("the exec guard: a bare name on PATH is the hole the FS guard leaves", () => {
		// Found live (job dl3D-iS5): the FS guard blocks rooted paths, so
		// `grep -r x /Users/…` is refused while `which opsctl` walks past it.
		// A bare name reaches the whole host, and the job hunted exactly there once
		// the paths stopped working. Separate flag from HARNESS_FS_GUARD, because two
		// interventions firing on the same cells are two conditions.
		const REFUSED = {
			"which, on the operator's own binary": "%%bash\nwhich opsctl",
			"pip, through subprocess": "import subprocess\nsubprocess.run(['pip', 'list'])",
			"a bare name that is his binary": "%%bash\njobs",
			"the second half of a pipeline": "%%bash\ncat urls.txt | curl -K -",
			"a command after a semicolon": "%%bash\nls -la; env",
			"bang magic": "!pip install together",
			"os.system": "import os\nos.system('ps aux | grep prime')",
		};
		const PERMITTED = {
			"reading the index": "%%bash\ncat api/INDEX.md",
			"ffmpeg, which the job legitimately uses": "%%bash\nffmpeg -i in.mp4 -vf scale=1280:-1 out.mp4",
			"a pure python cell": "import json\ntotal = sum(range(10))",
			"shell syntax around an allowed command": "%%bash\ncd out && cat frame.txt | head -5",
			"an env assignment before an allowed command": "%%bash\nNO_COLOR=1 python3 -c 'print(1)'",
			"a rooted path, which is the other guard's business": "%%bash\n/usr/bin/env python3 -c 'print(1)'",
		};

		const guarding = (body) => {
			const before = process.env.HARNESS_EXEC_GUARD;
			process.env.HARNESS_EXEC_GUARD = "1";
			try {
				return body();
			} finally {
				if (before === undefined) delete process.env.HARNESS_EXEC_GUARD;
				else process.env.HARNESS_EXEC_GUARD = before;
			}
		};

		it("is OFF by default, and only the literal 1 enables it", () => {
			for (const code of Object.values(REFUSED)) {
				assert.equal(guard.execGuardCheck(code), null, "refused with the guard off");
			}
			const before = process.env.HARNESS_EXEC_GUARD;
			try {
				for (const value of ["", "0", "true", "yes", "2"]) {
					process.env.HARNESS_EXEC_GUARD = value;
					assert.equal(guard.execGuardCheck(REFUSED["which, on the operator's own binary"]), null, value);
				}
			} finally {
				if (before === undefined) delete process.env.HARNESS_EXEC_GUARD;
				else process.env.HARNESS_EXEC_GUARD = before;
			}
		});

		it("refuses every command this environment does not have", () => {
			guarding(() => {
				for (const [name, code] of Object.entries(REFUSED)) {
					assert.match(guard.execGuardCheck(code) ?? "", /^Refused: \S+ is not available here/, name);
				}
			});
		});

		it("permits the commands legitimate cells actually used", () => {
			guarding(() => {
				for (const [name, code] of Object.entries(PERMITTED)) {
					assert.equal(guard.execGuardCheck(code), null, `${name} was wrongly refused`);
				}
			});
		});

		it("delivers the correction verbatim, sharing the FS guard's last line", () => {
			// Same third line on purpose: a model that has seen it once should read the
			// same boundary being drawn, not two unrelated complaints.
			const refusal = guarding(() => guard.execGuardCheck("%%bash\nwhich opsctl"));
			assert.equal(
				refusal,
				"Refused: which is not available here, and nothing was executed.\n" +
					"This environment is minimal and fully known: Python stdlib, preinstalled packages, and ./api — there are no other commands or services.\n" +
					"A tool named in the brief that is not under api/ belongs to a different agent; deliver the outcome with the tools you have.",
			);
			assert.equal(refusal.split("\n").length, 3);
			assert.equal(refusal.split("\n")[2], guard.fsGuardRefusal("/x").split("\n")[2]);
		});

		it("the REAL patched tool refuses it, on the same pre-execution path", async () => {
			// One path, two checks: `fsGuardCheck(...) ?? execGuardCheck(...)`. Driven
			// through the tool, so the wiring is proven rather than assumed.
			const def = guard.createIpythonToolDefinition(CWD);
			const before = process.env.HARNESS_EXEC_GUARD;
			process.env.HARNESS_EXEC_GUARD = "1";
			try {
				const res = await def.execute("call-2", { code: "%%bash\nwhich opsctl" }, undefined, undefined, {});
				assert.equal(res.isError, true);
				assert.equal(res.details?.durationMs, 0, "the cell ran before being refused");
				assert.equal(res.content[0].text, guard.execGuardRefusal("which"));
			} finally {
				if (before === undefined) delete process.env.HARNESS_EXEC_GUARD;
				else process.env.HARNESS_EXEC_GUARD = before;
			}
		});

		it("never throws, whatever it is handed", () => {
			process.env.HARNESS_EXEC_GUARD = "1";
			try {
				for (const code of [undefined, null, "", "%%bash", "%%bash\n", { no: "string" }]) {
					assert.doesNotThrow(() => guard.execGuardCheck(code), JSON.stringify(code));
				}
			} finally {
				delete process.env.HARNESS_EXEC_GUARD;
			}
		});

		it("the patch source and the built dist agree about the flag", () => {
			const patch = readFileSync(join(ROOT, "scripts/patches/exec-guard.ts"), "utf8");
			const dist = readFileSync(DIST, "utf8");
			for (const text of [patch, dist]) assert.match(text, /process\.env\.HARNESS_EXEC_GUARD !== "1"/);
			assert.match(dist, /is not available here, and nothing was executed/);
			// The two guards must remain separable: one flag must not arm the other.
			assert.match(dist, /fsGuardCheck\(code, cwd\) \?\? execGuardCheck\(code\)/);
		});
	});

	it("the patch source and the built dist agree about the flag", () => {
		// The trap that cost a condition bleed this morning: a dist built before the
		// gate landed passes every behavioural test above and still behaves wrongly
		// when the flag is unset.
		const patch = readFileSync(join(ROOT, "scripts/patches/fs-guard.ts"), "utf8");
		const dist = readFileSync(DIST, "utf8");
		for (const text of [patch, dist]) {
			assert.match(text, /process\.env\.HARNESS_FS_GUARD !== "1"/);
		}
		assert.match(dist, /is outside this job's working directory, and nothing was executed/);
	});
});

describe("the one-time read-batching gate (H55)", () => {
	let guard;
	before(async () => {
		guard = await import(DIST);
	});

	/** Run `body` with the gate enabled and its streak state zeroed. */
	const gating = (body) => {
		const prev = process.env.HARNESS_READ_BATCH_GUARD;
		process.env.HARNESS_READ_BATCH_GUARD = "1";
		guard.readBatchGateReset();
		try {
			return body();
		} finally {
			if (prev === undefined) delete process.env.HARNESS_READ_BATCH_GUARD;
			else process.env.HARNESS_READ_BATCH_GUARD = prev;
			guard.readBatchGateReset();
		}
	};

	const READS = [
		"print(open('api/INDEX.md').read())",
		"print(open('skills/INDEX.md').read())",
		"print(open('skills/brand-creative-system/SKILL.md').read())",
		"print(open('skills/brand-creative-system/references/palette.md').read())",
	];

	it("is off by default, whatever the streak", () => {
		assert.equal(process.env.HARNESS_READ_BATCH_GUARD, undefined, "the suite leaked the flag");
		guard.readBatchGateReset();
		for (const code of READS) assert.equal(guard.readBatchGateCheck(code), null);
	});

	it("permits TWO consecutive reads: an index read then the file it names is dependent, not batchable", () => {
		// The whole risk of this gate. The agent cannot know the SKILL.md path until
		// the index has named it, so refusing the second read would refuse the only
		// order the job allows. Pinned so a future tightening has to argue with it.
		gating(() => {
			assert.equal(guard.readBatchGateCheck(READS[0]), null, "first read refused");
			assert.equal(guard.readBatchGateCheck(READS[1]), null, "second read refused");
		});
	});

	it("refuses the third consecutive read-only cell, once, and names the plain-Python fix", () => {
		gating(() => {
			guard.readBatchGateCheck(READS[0]);
			guard.readBatchGateCheck(READS[1]);
			const refusal = guard.readBatchGateCheck(READS[2]);
			assert.ok(refusal, "the third consecutive read was not refused");
			assert.match(refusal, /third cell in a row that only reads/);
			// The correction must be an idiom the model already knows, not our API.
			assert.match(refusal, /for p in \[a, b, c\]: print\(p, open\(p\)\.read\(\)\)/);
			assert.match(refusal, /__doc__/);
			assert.match(refusal, /will not fire again this session/);
			// Once only: the fourth read runs.
			assert.equal(guard.readBatchGateCheck(READS[3]), null, "the gate fired twice");
		});
	});

	it("a cell that acts breaks the streak, so reading between real steps is free", () => {
		gating(() => {
			guard.readBatchGateCheck(READS[0]);
			guard.readBatchGateCheck(READS[1]);
			assert.equal(
				guard.readBatchGateCheck("result = await api.agent_tools.judge_tool(query='q', assets=['a'])"),
				null,
				"an acting cell was treated as a read",
			);
			// Streak reset: two more reads must still be allowed.
			assert.equal(guard.readBatchGateCheck(READS[2]), null);
			assert.equal(guard.readBatchGateCheck(READS[3]), null);
		});
	});

	it("a cell that reads AND acts is never a pure read", () => {
		gating(() => {
			const mixed = "spec = open('skills/x/SKILL.md').read()\nout = await api.image.create(prompt=spec)";
			for (let i = 0; i < 4; i++) assert.equal(guard.readBatchGateCheck(mixed), null, `fired on pass ${i}`);
		});
	});
});
