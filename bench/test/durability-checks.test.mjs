/**
 * The A5 durability checks have to discriminate, not merely pass.
 *
 * Every one of these assertions exists because the first version of the check it
 * covers was wrong in a way that produced a plausible verdict rather than an error:
 *
 *   - `submitted four jobs` counted `jobs.submit(` in the cell source and FAILED a run
 *     that had submitted all four from a `for` loop — one occurrence, better code.
 *   - `the agent got a working kernel back` counted cells the agent *attempted* and
 *     PASSED a run whose eleven cells all threw "Kernel has been shut down".
 *
 * Both are the same mistake: grading the shape of the transcript instead of the state
 * of the world. So the tests here feed each check a hand-built world that is right and
 * a hand-built world that is wrong, and assert it can tell them apart. A check that
 * cannot fail is not a check, and the run it certifies is not evidence.
 *
 * These use fixtures on disk rather than a live agent, so they run in milliseconds and
 * belong in `npm test`; the live runs live in docs/DURABILITY-RESULTS.md.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { TASKS } from "../../runtime/eval/tasks.mjs";
import { isTrivialCell, pollShape } from "../../runtime/eval/poll-shape.mjs";

const scratch = [];
after(() => {
	for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A run directory with a jobs/ subdirectory, populated by the caller. */
function world(files = {}) {
	const dir = mkdtempSync(join(tmpdir(), "durability-"));
	scratch.push(dir);
	mkdirSync(join(dir, "jobs"), { recursive: true });
	for (const [rel, body] of Object.entries(files)) {
		writeFileSync(join(dir, rel), body);
	}
	return dir;
}

/** The summary shape run.mjs produces, with the fields a check reads. */
function summaryOf(over = {}) {
	const cellSources = over.cellSources ?? [];
	return {
		cells: cellSources.length,
		turns: cellSources.length + 1,
		cellSources,
		cellOutcomes: cellSources.map(() => "ok"),
		completedCells: cellSources,
		refusedCells: [],
		waits: [],
		errors: [],
		restartNotices: [],
		preludeAnnouncements: [],
		preludeStartPids: [],
		deadKernelErrors: 0,
		poll: { waitCells: 0, bareWaitCells: 0, trivialPollCells: 0, trivialPollSources: [] },
		submitsBeforeFirstWait: 0,
		used: { submit: true, wait: true, get: true, manifest: false, help: false, sleep: false, thread: false },
		finalText: "",
		...over,
	};
}

const named = (checks, name) => {
	const c = checks.find((x) => x.name === name);
	assert.ok(c, `no check named ${name}; have: ${checks.map((x) => x.name).join(", ")}`);
	return c;
};

// --------------------------------------------------------------------------------
describe("the trivial-cell detector, which has cried wolf before", () => {
	// Observed on `pm-schedule-meeting-2` (the degeneracy) and in the wedged
	// kernel-death run (liveness probes against a dead kernel — same syntax, opposite
	// meaning, which is why the check using this is scoped to one task).
	for (const src of ['print(38)', 'print("ping")', "print('hi')", "1+1", "pass", "  42  "]) {
		it(`flags ${JSON.stringify(src)}`, () => assert.equal(isTrivialCell(src), true));
	}

	// Every one of these was produced by a real run doing real work. The third failed a
	// passing long-horizon run under a "short cell starting with print(" rule.
	for (const src of [
		"print(repr(open('release.txt').read()))",
		'print(open("build.out").read())',
		"import os; print(os.getcwd())",
		'print(jobs.manifest())',
		'j = jobs.get("build")\nprint(j.output)',
		"print(len(rows))",
	]) {
		it(`leaves ${JSON.stringify(src.slice(0, 40))} alone`, () => assert.equal(isTrivialCell(src), false));
	}

	it("counts a wait cell with no check as a bare pause", () => {
		const shape = pollShape([
			'j = jobs.get("b")\nif not j.done: jobs.wait(wake_after=60)',
			"jobs.wait(wake_after=60)",
		]);
		assert.equal(shape.waitCells, 2);
		assert.equal(shape.bareWaitCells, 1);
	});
});

// --------------------------------------------------------------------------------
describe("concurrency: fan-out is read from the store, not from the source text", () => {
	const jobRecord = (name, startedAt) => ({
		name,
		cmd: `bash analyse.sh ${name}`,
		log: `/tmp/jobs/${name}.log`,
		exit_marker: `/tmp/jobs/${name}.exit`,
		state: "done",
		started_at: startedAt,
	});
	const names = ["alpha", "beta", "gamma", "delta"];

	/** Four records armed `spread` seconds apart, and a timeline with `gap` between runs. */
	function concurrentWorld({ spread, sequential }) {
		const base = 1_700_000_000;
		const files = {};
		names.forEach((n, i) => {
			files[`jobs/${n}.json`] = JSON.stringify(jobRecord(n, base + i * spread));
			files[`${n}.in`] = `${n}-payload\n`;
		});
		const durations = { alpha: 20, beta: 30, gamma: 40, delta: 50 };
		let cursor = base;
		const lines = [];
		for (const n of names) {
			const open = sequential ? cursor : base;
			const close = open + durations[n];
			if (sequential) cursor = close;
			lines.push(`${n} OPEN ${open}`, `${n} CLOSE ${close}`);
		}
		files["timeline.txt"] = `${lines.join("\n")}\n`;
		return world(files);
	}

	it("passes a single-cell `for` loop, which submits four jobs in one call site", () => {
		const dir = concurrentWorld({ spread: 0, sequential: false });
		const checks = TASKS.concurrent.check({
			runDir: dir,
			jobDir: join(dir, "jobs"),
			summary: summaryOf({
				cellSources: ['for n in ["alpha","beta","gamma","delta"]:\n    jobs.submit(f"bash analyse.sh {n}", name=n)\njobs.wait(wake_after=60)'],
				submitsBeforeFirstWait: 1,
			}),
		});
		assert.equal(named(checks, "four jobs in the store, one per analysis").ok, true);
		assert.equal(named(checks, "fanned out rather than run one after another").ok, true);
		assert.equal(named(checks, "the four ran concurrently, not one after another").ok, true);
	});

	it("fails a sequential run even though it submits four jobs and answers correctly", () => {
		const dir = concurrentWorld({ spread: 60, sequential: true });
		const checks = TASKS.concurrent.check({
			runDir: dir,
			jobDir: join(dir, "jobs"),
			summary: summaryOf({
				cellSources: names.map((n) => `jobs.submit("bash analyse.sh ${n}", name="${n}")\njobs.wait(wake_after=60)`),
				submitsBeforeFirstWait: 1,
			}),
		});
		// The store still holds four correct records — this is exactly the run that
		// looks right in the transcript and took three times the wall clock.
		assert.equal(named(checks, "four jobs in the store, one per analysis").ok, true);
		assert.equal(named(checks, "fanned out rather than run one after another").ok, false);
		assert.equal(named(checks, "the four ran concurrently, not one after another").ok, false);
	});

	it("catches a record that points at another job's log", () => {
		const dir = concurrentWorld({ spread: 0, sequential: false });
		const crossed = jobRecord("beta", 1_700_000_000);
		crossed.log = "/tmp/jobs/gamma.log";
		writeFileSync(join(dir, "jobs/beta.json"), JSON.stringify(crossed));
		const checks = TASKS.concurrent.check({
			runDir: dir,
			jobDir: join(dir, "jobs"),
			summary: summaryOf({ cellSources: ["jobs.submit(...)"] }),
		});
		assert.equal(named(checks, "no record crossed another").ok, false);
	});
});

// --------------------------------------------------------------------------------
describe("kernel death: recovery is cells that ran, not cells that were tried", () => {
	const traceOnce = "START 1700000000 pid=99\nFINISH 1700000075\n";
	const collect = 'j = jobs.get("build")\nprint(j.output)';

	it("fails when every cell after the kill threw, however many were attempted", () => {
		const dir = world({ "build.trace": traceOnce, "build.out": "BUILD-OK-abc123\n" });
		const cellSources = ['jobs.submit("bash build.sh", name="build")', ...Array(11).fill(collect)];
		const checks = TASKS["kernel-death"].check({
			runDir: dir,
			jobDir: join(dir, "jobs"),
			summary: summaryOf({
				cellSources,
				// One good cell, then a dead kernel for the rest of the run.
				cellOutcomes: ["ok", ...Array(11).fill("failed")],
				deadKernelErrors: 11,
				preludeStartPids: [3894],
				kernelKill: { atCell: 1, atTurn: 1, atMs: 6000, killed: [{ pid: 1 }, { pid: 2 }] },
				cellsAfterKernelKill: 0,
				failedCellsAfterKernelKill: 11,
				recoveredAfterKill: false,
				finalText: "the kernel has been shut down",
			}),
		});
		assert.equal(named(checks, "the agent got a working kernel back").ok, false);
		assert.equal(named(checks, "a second kernel booted and re-ran the runtime").ok, false);
	});

	it("fails a run that redid the work, even though the answer is right", () => {
		const dir = world({
			"build.trace": "START 1700000000 pid=99\nFINISH 1700000075\nSTART 1700000090 pid=120\nFINISH 1700000165\n",
			"build.out": "BUILD-OK-abc123\n",
		});
		const checks = TASKS["kernel-death"].check({
			runDir: dir,
			jobDir: join(dir, "jobs"),
			summary: summaryOf({
				cellSources: ['jobs.submit("bash build.sh", name="build")', 'jobs.submit("bash build.sh", name="build2")', collect],
				kernelKill: { atCell: 1, atTurn: 1, atMs: 6000, killed: [{ pid: 1 }] },
				cellsAfterKernelKill: 2,
				failedCellsAfterKernelKill: 0,
				recoveredAfterKill: true,
				resubmittedAfterKill: true,
				restartNotices: [1],
				preludeStartPids: [1, 2],
				finalText: "BUILD-OK-abc123",
			}),
		});
		// Right answer, and the durability claim bought nothing.
		assert.equal(named(checks, "reported the real token").ok, true);
		assert.equal(named(checks, "did NOT redo the work").ok, false);
	});

	it("does not certify a kill the watchdog never performed", () => {
		const dir = world({ "build.trace": traceOnce, "build.out": "BUILD-OK-abc123\n" });
		const checks = TASKS["kernel-death"].check({
			runDir: dir,
			jobDir: join(dir, "jobs"),
			summary: summaryOf({ cellSources: [collect], finalText: "BUILD-OK-abc123" }),
		});
		assert.equal(named(checks, "the kernel was actually killed").ok, false);
	});
});

// --------------------------------------------------------------------------------
describe("long horizon: the poll loop must not degenerate", () => {
	const pipelineLog = ["build", "test", "package"]
		.map((s, i) => `${s} START ${1_700_000_000 + i * 60}\n${s} DONE ${1_700_000_060 + i * 60}`)
		.join("\n");
	const files = { "pipeline.log": `${pipelineLog}\n`, "release.txt": "RELEASE-deadbeef\n" };

	it("passes check-then-wait across three stages", () => {
		const dir = world(files);
		const checks = TASKS["long-horizon"].check({
			runDir: dir,
			jobDir: join(dir, "jobs"),
			summary: summaryOf({
				cellSources: Array(8).fill('j = jobs.get("stage")\nif j.done: pass\nelse: jobs.wait(wake_after=60)'),
				waits: [60, 60, 60],
				poll: { waitCells: 3, bareWaitCells: 0, trivialPollCells: 0, trivialPollSources: [] },
				finalText: "RELEASE-deadbeef",
			}),
		});
		assert.equal(named(checks, "polled across several waits").ok, true);
		assert.equal(named(checks, "check-then-wait, not turn-burning").ok, true);
		assert.equal(named(checks, "did not burn turns").ok, true);
	});

	it("fails the `print(N)` degeneracy that motivated the design", () => {
		const dir = world(files);
		// The shape observed on pm-schedule-meeting-2: the model using its own turn
		// boundary as a clock, 87 times.
		const cellSources = Array(40)
			.fill(0)
			.map((_, i) => `print(${i})`);
		const checks = TASKS["long-horizon"].check({
			runDir: dir,
			jobDir: join(dir, "jobs"),
			summary: summaryOf({
				cellSources,
				waits: [],
				poll: { waitCells: 0, bareWaitCells: 0, trivialPollCells: 40, trivialPollSources: ["print(0)"] },
				finalText: "RELEASE-deadbeef",
			}),
		});
		assert.equal(named(checks, "polled across several waits").ok, false);
		assert.equal(named(checks, "check-then-wait, not turn-burning").ok, false);
		assert.equal(named(checks, "did not burn turns").ok, false);
	});

	it("fails a run that reports a release token it did not produce", () => {
		const dir = world({ "pipeline.log": `${pipelineLog}\n` });
		const checks = TASKS["long-horizon"].check({
			runDir: dir,
			jobDir: join(dir, "jobs"),
			summary: summaryOf({
				cellSources: ['jobs.get("pipeline")'],
				waits: [60, 60, 60],
				finalText: "RELEASE-deadbeef",
			}),
		});
		assert.equal(named(checks, "release.txt written").ok, false);
		assert.equal(named(checks, "reported release.txt exactly").ok, false);
	});
});
