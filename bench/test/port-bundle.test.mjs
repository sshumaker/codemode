/**
 * The product port's bundle builder: build settings are part of the artifact.
 *
 * This exists because the port shipped, unnoticed, with runtime argument
 * validation switched off. `generate()`'s `validateArgs` is opt-in, the builder
 * lived under gitignored `.run/` and called `generate(catalogue)` bare, and the
 * resulting `_client.py` was 63 lines with no `_validate` and no `_schemas.json`.
 * Nothing failed; calls simply went to the product unchecked, and a wrong-shape
 * argument came back as a tool error — which for a media job is a `state=error`
 * row in the message trace the product graders read.
 *
 * That is this repo's recurring failure shape (CLAUDE.md: "a documented check is
 * not an executed check", and the L1-label episode where advertisement and
 * behaviour disagreed). A comment saying the bundle is validated is worth nothing;
 * what follows asserts on the emitted files.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ROOT, buildBundle } from "../port/build-bundle.mjs";
import { realistic, wide } from "./fixtures/catalogue.mjs";

const CATALOGUE = [...realistic, ...wide];

describe("the port bundle validates arguments by default", () => {
	it("emits the validator and its schema table with no options at all", () => {
		// The exact call the old builder made — the bug was that this produced an
		// unvalidated tree.
		const { files, validateArgs } = buildBundle(CATALOGUE);
		assert.equal(validateArgs, true, "the port bundle must default to validating");
		assert.ok(files["_schemas.json"], "_schemas.json is missing: nothing to validate against");
		assert.match(files["_client.py"], /def _validate\(/);
		assert.match(files["_client.py"], /class ArgumentError\(McpError, TypeError\):/);
		assert.match(files["_client.py"], /_validate\(server, tool, sent\)/);
	});

	it("the schema table covers every tool the tree exposes", () => {
		// A table with gaps silently un-validates individual tools, which is the
		// same class of defect one level down.
		const { files, toolDefs } = buildBundle(CATALOGUE);
		const table = JSON.parse(files["_schemas.json"]);
		const entries = Object.values(table.tools).reduce((n, tools) => n + Object.keys(tools).length, 0);
		assert.equal(entries, toolDefs.length, "the schema table and the tree disagree about the tool set");
	});

	it("--no-validate is a deliberate deviation, and it is recorded", () => {
		// The flag has to keep working for an A/B, but it must be visible: a bundle
		// that cannot say how it was built is how the original bug survived.
		const { files, validateArgs } = buildBundle(CATALOGUE, { validateArgs: false });
		assert.equal(validateArgs, false);
		assert.equal(files["_schemas.json"], undefined);
		assert.doesNotMatch(files["_client.py"], /def _validate\(/);
	});
});

describe("the builder, run as the CLI it actually is", () => {
	const dirs = [];
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	const build = (extraArgs = []) => {
		const dir = mkdtempSync(join(tmpdir(), "harness-port-bundle-"));
		dirs.push(dir);
		const dataPath = join(dir, "catalogue.json");
		writeFileSync(dataPath, JSON.stringify({ catalogue: CATALOGUE }));
		execFileSync(
			"node",
			[join(ROOT, "bench/port/build-bundle.mjs"), "--data", dataPath, "--out", join(dir, "bundle"), ...extraArgs],
			{ cwd: ROOT, stdio: "pipe", encoding: "utf8" },
		);
		return join(dir, "bundle");
	};

	it("writes a tree whose client validates, plus the preamble the arm reads", () => {
		// String assertions certify text is present; this one certifies the FILES on
		// disk, because the product side reads the directory, not this module.
		const out = build();
		assert.match(readFileSync(join(out, "api", "_client.py"), "utf8"), /def _validate\(/);
		assert.ok(JSON.parse(readFileSync(join(out, "api", "_schemas.json"), "utf8")).tools);
		assert.ok(readFileSync(join(out, "preamble.txt"), "utf8").length > 0);
	});

	it("provenance records the generator settings, not just the counts", () => {
		const provenance = JSON.parse(readFileSync(join(build(), "provenance.json"), "utf8"));
		assert.deepEqual(provenance.generate, { validateArgs: true });
		const off = JSON.parse(readFileSync(join(build(["--no-validate"]), "provenance.json"), "utf8"));
		assert.deepEqual(off.generate, { validateArgs: false });
	});

	it("every module it emits is importable Python", () => {
		// An api/ tree that does not parse removes tools from the arm while leaving
		// them listed — the silent-capability-loss shape this repo keeps hitting.
		const out = build();
		const api = join(out, "api");
		const script = "import ast,sys,pathlib\n[ast.parse(p.read_text()) for p in pathlib.Path(sys.argv[1]).rglob('*.py')]\nprint('OK')";
		assert.match(execFileSync("python3", ["-c", script, api], { encoding: "utf8", stdio: "pipe" }), /OK/);
	});
});

describe("the builder is tracked, which was the whole point", () => {
	it("does not live under a gitignored path", () => {
		// `.run/` is gitignored. The builder sat there, so the one-line setting that
		// controls whether the arm validates anything was not version-controlled and
		// could revert with no diff to review.
		//
		// `git check-ignore` exits 0 when the path IS ignored and 1 when it is not,
		// so the passing case is the throwing one.
		let ignored;
		try {
			execFileSync("git", ["check-ignore", "-q", "bench/port/build-bundle.mjs"], { cwd: ROOT, stdio: "pipe" });
			ignored = true;
		} catch {
			ignored = false;
		}
		assert.equal(ignored, false, "the port bundle builder is gitignored again — the bug this file fixes");
	});
});
