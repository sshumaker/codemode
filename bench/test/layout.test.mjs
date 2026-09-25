/**
 * `--api-layout`: one module per APP instead of one file per METHOD.
 *
 * Why the shape is a hypothesis and not a preference. No API documentation and no
 * SDK on earth is one file per method — `stripe.py`, a boto3 service module, a
 * REST reference page — they are all one page/module per resource or per service.
 * The per-method tree asks the agent to do something it has never seen: open 469
 * files one at a time. Measured consequence at L0: the agent reads `INDEX.md`
 * one-liners and stops, and both dissected AppWorld failures came from a contract
 * that lives in a docstring the agent never opened — `show_drafts`'s YYYY-MM-DD
 * `min_created_at`, and `complete_task`'s pass-an-answer-only-if-asked rule.
 * `cat api/gmail.py` is one natural read that delivers the whole app surface.
 *
 * What is pinned here:
 *
 *   - per-method is the default and its tree is byte-identical to today's, so no
 *     already-reported run is re-labelled by this flag existing,
 *   - the two layouts are the SAME API to Python — same functions, same
 *     signatures, same docstrings — verified by importing both, not by diffing
 *     the text, which is different by construction,
 *   - every call site is unchanged: `import api.gmail; await api.gmail.show_drafts(...)`,
 *   - the docs gate and the argument validator both still work, and the gate
 *     points at a file that exists in the layout it is rendered for,
 *   - the preamble differs ONLY in the lines that describe where files are.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { API_LAYOUTS, apiLayout, generate, renderClient, renderRootIndex } from "../generate.mjs";
import { buildPreamble } from "../appworld/prompts.mjs";
import { adversarial, constrained, realistic, wide } from "./fixtures/catalogue.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = readFileSync(join(ROOT, "bench/appworld/run-task.mjs"), "utf8");
const SWEEP = readFileSync(join(ROOT, "bench/appworld/sweep.mjs"), "utf8");
const PROBE = join(ROOT, "bench/test/fixtures/layout_probe.py");
const CATALOGUE = [...realistic, ...wide];

const dirs = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Materialize a tree and report the callable surface Python actually sees. */
function surfaceOf(options) {
	const dir = mkdtempSync(join(tmpdir(), "harness-layout-"));
	dirs.push(dir);
	for (const [rel, content] of Object.entries(generate(CATALOGUE, options).files)) {
		const path = join(dir, "api", rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return JSON.parse(execFileSync("python3", [PROBE, dir], { encoding: "utf8", stdio: "pipe" }));
}

describe("the layouts are a closed set, and per-method is the default", () => {
	it("has exactly per-method and consolidated", () => {
		assert.deepEqual(API_LAYOUTS, ["per-method", "consolidated"]);
	});

	it("rejects an unknown layout instead of degrading to the default", () => {
		// A run labelled with a layout it is not in is the failure this project keeps
		// finding — a silent fallback would reproduce it on the flag.
		assert.throws(() => apiLayout("consolidted"), /unknown api layout/);
		assert.throws(() => generate(realistic, { apiLayout: "flat" }), /unknown api layout/);
	});

	it("generate() without the option renders the tree it always rendered", () => {
		// Running sweeps regenerate their tree per run from this file, so the default
		// has to be byte-identical or a flag that nobody passed would still change
		// every arm mid-flight.
		assert.deepEqual(generate(CATALOGUE), generate(CATALOGUE, { apiLayout: "per-method" }));
	});

	it("the runner's flag defaults to per-method and lands in the runId", () => {
		assert.match(RUNNER, /const layout = \(\(\) => \{/);
		assert.match(RUNNER, /return apiLayout\(next && !next\.startsWith\("--"\) \? next : "consolidated"\)/);
		assert.match(RUNNER, /layout === "per-method" \? "" : `__layout-\$\{layout\}`/);
		assert.match(SWEEP, /--codemode-api-layout/);
		assert.match(RUNNER, /variants: \{[^}]*\bapiLayout\b[^}]*\}/);
	});
});

describe("consolidated is one module per app", () => {
	const { files } = generate(CATALOGUE, { apiLayout: "consolidated" });

	it("emits api/<app>.py and no per-method files at all", () => {
		assert.ok(files["linear.py"], "api/linear.py was not generated");
		assert.ok(files["wide.py"], "api/wide.py was not generated");
		const perMethod = Object.keys(files).filter((f) => /^[a-z_0-9]+\/.+\.py$/.test(f));
		assert.deepEqual(perMethod, [], `consolidated still emits per-method files: ${perMethod}`);
	});

	it("collapses 27 files into 5", () => {
		// The number is the point: the per-method tree makes "read the docs" an
		// N-file operation, and N is why it does not happen.
		const per = Object.keys(generate(CATALOGUE).files).length;
		const con = Object.keys(files).length;
		assert.ok(con < per / 3, `consolidated is ${con} files against per-method's ${per}`);
	});

	it("carries every function with its full docstring, in one file", () => {
		const linear = files["linear.py"];
		for (const tool of realistic[0].tools) assert.match(linear, new RegExp(`async def ${tool.name}\\(`));
		// The docstring the per-method file carried, not the INDEX one-liner: this is
		// the whole mechanism — the contract lives in the Args section.
		assert.match(linear, /Team key, e\.g\. ENG\./);
		assert.match(linear, /capped at 50/);
		assert.match(linear, /Args:/);
	});

	it("imports the transport as a sibling, since it is now one", () => {
		// `call as _call` first, then whatever coercion helpers this app's parameters
		// need — the claim here is the SIBLING path, not the import list.
		assert.match(files["linear.py"], /^from \._client import call as _call(, \w+ as _\w+)*$/m);
		assert.equal(/from \.\._client/.test(files["linear.py"]), false);
	});

	it("leads with the app's conventions, which no single docstring states", () => {
		// Derived from the schemas rather than asserted, exactly as DOCS.md does — an
		// app that does not paginate must not be told that it does.
		assert.match(files["wide.py"], /Pagination: \d+ APIs take `page_index`/);
		assert.equal(/## Conventions|Pagination/.test(files["linear.py"]), false, "invented a convention for an app that has none");
	});

	it("needs no per-app INDEX.md, because the module is the index", () => {
		assert.equal(Object.keys(files).some((f) => f.endsWith("/INDEX.md")), false);
		assert.ok(files["INDEX.md"], "the root map is still there");
	});

	it("the root INDEX points at the files that exist in this layout", () => {
		assert.match(files["INDEX.md"], /cat api\/<package>\.py/);
		assert.equal(/api\/<package>\/INDEX\.md/.test(files["INDEX.md"]), false, "points at a file this layout does not have");
		// ...and the per-method INDEX still points at its own.
		assert.match(generate(CATALOGUE).files["INDEX.md"], /cat api\/<package>\/INDEX\.md/);
		assert.equal(/cat api\/<package>\.py/.test(generate(CATALOGUE).files["INDEX.md"]), false);
	});
});

describe("the two layouts are the same API to Python", () => {
	// String assertions certify the text is present. They cannot certify that
	// `import api.gmail` resolves, that the signature survived, or that the
	// docstring is attached to the function rather than sitting above it — so both
	// trees are imported and their surfaces compared.
	const perMethod = surfaceOf({});
	const consolidated = surfaceOf({ apiLayout: "consolidated" });

	it("exposes the same modules", () => {
		assert.deepEqual(Object.keys(consolidated).sort(), Object.keys(perMethod).sort());
	});

	it("exposes the same functions, with the same signatures and the same docstrings", () => {
		// One assertion over the whole surface: a per-key loop reports the first
		// difference, this reports all of them, and the diff is the useful artefact.
		assert.deepEqual(consolidated, perMethod);
	});

	it("actually loaded something, so an empty surface cannot pass", () => {
		// The mirror bug: two empty dicts are deepEqual. A probe that imported
		// nothing would certify perfect equivalence.
		const total = Object.values(perMethod).reduce((n, fns) => n + Object.keys(fns).length, 0);
		assert.equal(total, CATALOGUE.reduce((n, s) => n + s.tools.length, 0));
		assert.ok(perMethod.linear.list_issues.signature.includes("team"), "signatures were not captured");
		assert.ok(perMethod.linear.list_issues.doc.includes("Team key"), "docstrings were not captured");
	});
});

describe("the layout composes with the gate and the validator", () => {
	it("the redirect gate points at the file the layout actually has", () => {
		assert.match(renderClient({ docsGate: "redirect" }), /read api\/\{pkg\}\/DOCS\.md/);
		assert.match(renderClient({ docsGate: "redirect", apiLayout: "consolidated" }), /read api\/\{pkg\}\.py/);
		const { files } = generate(CATALOGUE, { docsGate: "redirect", apiLayout: "consolidated" });
		assert.equal(Object.keys(files).some((f) => f.endsWith("DOCS.md")), false, "consolidated ships a DOCS.md nothing points at");
	});

	it("arms the gate with a path that still names the API", () => {
		// In per-method `__name__` IS `api.<pkg>.<tool>`. A consolidated module's
		// `__name__` is only `api.<pkg>`, so the tool half would be lost and the gate
		// would fire once per APP instead of once per API — a different experiment
		// wearing the same flag.
		const consolidated = generate(CATALOGUE, { docsGate: "redirect", apiLayout: "consolidated" }).files["linear.py"];
		assert.match(consolidated, /_path="api\.linear\.list_issues"/);
		assert.match(generate(CATALOGUE, { docsGate: "redirect" }).files["linear/list_issues.py"], /_path=__name__/);
	});

	it("validates arguments in either layout, off the same table", () => {
		const { files } = generate(CATALOGUE, { validateArgs: true, apiLayout: "consolidated" });
		assert.ok(files["_schemas.json"], "consolidated dropped the schema table");
		assert.deepEqual(
			JSON.parse(files["_schemas.json"]),
			JSON.parse(generate(CATALOGUE, { validateArgs: true }).files["_schemas.json"]),
			"the schema table depends on the layout, which it must not",
		);
		assert.match(files["_client.py"], /class ArgumentError/);
	});

	it("every generated module compiles, in both layouts, on adversarial input", () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-layout-ast-"));
		dirs.push(dir);
		const catalogue = [...CATALOGUE, ...adversarial, ...constrained];
		for (const layout of API_LAYOUTS) {
			for (const [rel, content] of Object.entries(generate(catalogue, { apiLayout: layout, docsGate: "inline", validateArgs: true }).files)) {
				if (!rel.endsWith(".py")) continue;
				const path = join(dir, layout, rel);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, content);
				assert.doesNotThrow(
					() => execFileSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", path], { stdio: "pipe" }),
					`${layout}: generated module does not parse: ${rel}`,
				);
			}
		}
	});
});

describe("the preamble describes the layout, and nothing else", () => {
	const ctx = { toolCount: 469, serverCount: 10 };
	const perMethod = buildPreamble("a1", ctx);
	const consolidated = buildPreamble("a1", { ...ctx, apiLayout: "consolidated" });

	it("defaults to the per-method wording, so no existing run is re-labelled", () => {
		assert.equal(buildPreamble("a1", { ...ctx, apiLayout: "per-method" }), perMethod);
		assert.match(perMethod, /cat api\/<app>\/<api>\.py/);
	});

	it("tells the consolidated agent to read the file that exists", () => {
		assert.match(consolidated, /cat api\/<app>\.py/);
		assert.equal(/api\/<app>\/INDEX\.md|api\/<app>\/<api>\.py/.test(consolidated), false);
	});

	it("differs ONLY in the lines that say where files are", () => {
		// The measurement is about the shape of the tree. If the two preambles also
		// differed in what they said about async, the kernel, or economy, the result
		// would be a prompt A/B wearing a layout label.
		const diff = (a, b) => a.split("\n").filter((line) => !b.includes(line));
		const added = diff(consolidated, perMethod);
		const removed = diff(perMethod, consolidated);
		for (const line of [...added, ...removed]) {
			assert.match(line, /api\//, `the preambles differ on a line that is not about file layout: ${JSON.stringify(line)}`);
		}
		assert.ok(added.length <= 3 && removed.length <= 3, `the layout difference is ${added.length}+/${removed.length}- lines, which is not minimal`);
	});

	it("the call-site example is byte-identical, because call sites do not change", () => {
		for (const text of [perMethod, consolidated]) {
			assert.match(text, /import api\.supervisor, api\.spotify/);
			assert.match(text, /profile = json\.loads\(await api\.supervisor\.show_profile\(\)\)/);
		}
	});
});
