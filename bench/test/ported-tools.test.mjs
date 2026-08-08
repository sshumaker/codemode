/**
 * Functional tests for the five tools ported from pi-mono (read, write, grep,
 * find, ls) plus the two prime shipped dark (bash, edit).
 *
 * These are the experiment's most load-bearing tests. The vanilla arm is the
 * baseline the whole result is measured against; if a ported tool is subtly
 * broken — wrong truncation, dropped line numbers, a silent empty result — the
 * comparison becomes a strawman and codemode "wins" for the wrong reason.
 *
 * No API key required: tools are executed directly against a temp fixture.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildArm } from "../arms.mjs";

let dir;
let tools;

const text = (result) =>
	(result?.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");

const run = (name, params) => tools[name].execute(`test-${name}`, params, undefined);

before(async () => {
	const built = await buildArm("vanilla");
	tools = Object.fromEntries(built.tools.map((t) => [t.name, t]));

	dir = mkdtempSync(join(tmpdir(), "harness-tools-"));
	mkdirSync(join(dir, "src"));
	mkdirSync(join(dir, "empty"));
	writeFileSync(join(dir, "src", "alpha.txt"), "first line\nsecond line\nNEEDLE here\nfourth line\n");
	writeFileSync(join(dir, "src", "beta.md"), "# heading\nno match in this one\n");
	writeFileSync(join(dir, "many.txt"), Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n"));
});

after(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("read", () => {
	it("returns file contents", async () => {
		const out = text(await run("read", { path: join(dir, "src", "alpha.txt") }));
		assert.match(out, /NEEDLE here/);
	});

	it("honours offset and limit rather than returning the whole file", async () => {
		const out = text(await run("read", { path: join(dir, "many.txt"), offset: 10, limit: 3 }));
		assert.match(out, /line 10|line 11|line 12/);
		assert.ok(!out.includes("line 400"), "limit was ignored");
	});

	// Contract: tools signal failure by throwing, and the agent loop converts the
	// thrown message into the tool-error result the model sees. The message is
	// therefore part of the arm's quality — an uninformative error costs the
	// model a turn, so it is worth pinning.
	it("throws a named error for a missing file rather than returning empty content", async () => {
		await assert.rejects(
			() => run("read", { path: join(dir, "does-not-exist.txt") }),
			(err) => {
				assert.match(err.message, /not found|no such|does not exist|ENOENT/i);
				return true;
			},
		);
	});
});

describe("write", () => {
	it("creates a file with the given content", async () => {
		const path = join(dir, "written.txt");
		await run("write", { path, content: "hello from write\n" });
		assert.equal(readFileSync(path, "utf8"), "hello from write\n");
	});

	it("creates missing parent directories", async () => {
		const path = join(dir, "nested", "deep", "file.txt");
		await run("write", { path, content: "nested\n" });
		assert.equal(readFileSync(path, "utf8"), "nested\n");
	});

	it("overwrites an existing file", async () => {
		const path = join(dir, "overwrite.txt");
		await run("write", { path, content: "first\n" });
		await run("write", { path, content: "second\n" });
		assert.equal(readFileSync(path, "utf8"), "second\n");
	});
});

describe("grep", () => {
	it("finds a match and names the file", async () => {
		const out = text(await run("grep", { pattern: "NEEDLE", path: dir }));
		assert.match(out, /alpha\.txt/);
	});

	it("does not report files without a match", async () => {
		const out = text(await run("grep", { pattern: "NEEDLE", path: dir }));
		assert.ok(!out.includes("beta.md"), "grep reported a non-matching file");
	});

	it("returns a no-match result rather than throwing", async () => {
		const out = text(await run("grep", { pattern: "ZZZ_NOT_PRESENT_ZZZ", path: dir }));
		assert.equal(typeof out, "string");
		assert.ok(!out.includes("alpha.txt"));
	});

	it("respects ignoreCase", async () => {
		const sensitive = text(await run("grep", { pattern: "needle", path: dir }));
		const insensitive = text(await run("grep", { pattern: "needle", path: dir, ignoreCase: true }));
		assert.ok(!sensitive.includes("alpha.txt"), "case-sensitive search matched anyway");
		assert.match(insensitive, /alpha\.txt/);
	});
});

describe("find", () => {
	it("locates files by glob", async () => {
		const out = text(await run("find", { pattern: "*.txt", path: dir }));
		assert.match(out, /alpha\.txt/);
	});

	it("excludes non-matching extensions", async () => {
		const out = text(await run("find", { pattern: "*.txt", path: dir }));
		assert.ok(!out.includes("beta.md"), "find returned a file the glob excludes");
	});
});

describe("ls", () => {
	it("lists directory entries", async () => {
		const out = text(await run("ls", { path: dir }));
		assert.match(out, /src/);
		assert.match(out, /many\.txt/);
	});

	it("handles an empty directory without erroring", async () => {
		const out = text(await run("ls", { path: join(dir, "empty") }));
		assert.equal(typeof out, "string");
	});
});

describe("bash", () => {
	it("runs a command and returns stdout", async () => {
		const out = text(await run("bash", { command: "echo harness-bash-ok" }));
		assert.match(out, /harness-bash-ok/);
	});

	it("throws on a non-zero exit rather than reporting success", async () => {
		await assert.rejects(
			() => run("bash", { command: "exit 3" }),
			(err) => {
				assert.match(err.message, /exited with code 3/);
				return true;
			},
		);
	});

	it("includes captured output alongside the exit code when a command fails", async () => {
		// A failing command whose stdout is discarded would leave the model
		// guessing; the message must carry both.
		await assert.rejects(
			() => run("bash", { command: "echo diagnostic-detail; exit 7" }),
			(err) => {
				assert.match(err.message, /diagnostic-detail/);
				assert.match(err.message, /exited with code 7/);
				return true;
			},
		);
	});

	it("captures stderr, not only stdout", async () => {
		const out = text(await run("bash", { command: "echo to-stderr 1>&2" }));
		assert.match(out, /to-stderr/);
	});
});

describe("edit", () => {
	it("applies a string replacement", async () => {
		const path = join(dir, "editable.txt");
		writeFileSync(path, "alpha\nbravo\ncharlie\n");
		await run("edit", { path, edits: [{ oldText: "bravo", newText: "DELTA" }] });
		assert.match(readFileSync(path, "utf8"), /DELTA/);
	});
});

describe("cross-tool consistency", () => {
	it("write then read round-trips exactly", async () => {
		const path = join(dir, "roundtrip.txt");
		const content = "line one\nline two\nline three\n";
		await run("write", { path, content });
		const out = text(await run("read", { path }));
		for (const line of ["line one", "line two", "line three"]) {
			assert.ok(out.includes(line), `read did not return ${line}`);
		}
	});

	it("write then grep finds the new content", async () => {
		const path = join(dir, "grepme.txt");
		await run("write", { path, content: "UNIQUE_TOKEN_FOR_GREP\n" });
		const out = text(await run("grep", { pattern: "UNIQUE_TOKEN_FOR_GREP", path: dir }));
		assert.match(out, /grepme\.txt/);
	});

	it("write then ls shows the new file", async () => {
		const path = join(dir, "listme.txt");
		await run("write", { path, content: "x\n" });
		const out = text(await run("ls", { path: dir }));
		assert.match(out, /listme\.txt/);
	});
});
