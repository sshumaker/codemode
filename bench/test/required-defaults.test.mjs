/**
 * The required-default transform — the slot a mutation's target cannot be left out of.
 *
 * The measured mechanism, in full in `docs/CC-EDGE-TRACES.md` §M1:
 * `api.gmail.reply_to_email` takes an OPTIONAL `email_addresses` whose documented
 * default is "the sender", which on an outbox thread is the user themselves. 35 of
 * 36 codemode runs omitted it and every one of those failed. Three interventions
 * did not move it: L4 residency (the schema was resident), the verified read-gate
 * (the read-ledger PROVES the model read that sentence and it omitted the argument
 * anyway), and vanilla with the whole JSON schema in front of it. Visible-and-optional
 * loses. The untested cell is REQUIRED.
 *
 * What is pinned here, per "a documented check is not an executed check":
 *
 *   - the classifier cannot see task data, by construction, not by instruction,
 *   - the KNOWN CASE is found from the real catalogue's schemas alone — both by the
 *     checker and in the shipped list, which is never hand-edited,
 *   - invented, paraphrased, literal-default and read-only proposals are rejected,
 *   - the promoted parameter renders with NO default, and one docstring line says why,
 *   - off is byte-identical to the tree every earlier run used,
 *   - EXECUTED: omitting it raises TypeError and nothing reaches the transport, while
 *     the identical call against the untransformed tree goes through,
 *   - the runner and the sweep label it, restrict it to codemode, and prove it bound.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { generate, requiredDefaultNote } from "../generate.mjs";
import { buildPrompt, checkRequiredDefault, isMutation, requiredDefaultsIndex } from "../required-defaults.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = readFileSync(join(ROOT, "bench/appworld/run-task.mjs"), "utf8");
const SWEEP = readFileSync(join(ROOT, "bench/appworld/sweep.mjs"), "utf8");
const CLASSIFIER = readFileSync(join(ROOT, "bench/required-defaults.mjs"), "utf8");
// The apparatus this pass shares with bench/enrich-catalogue.mjs. Pinned here as
// well, because the I/O the isolation guarantee is asserted on now lives in it.
const DRIVER = readFileSync(join(ROOT, "bench/enrich-driver.mjs"), "utf8");
const PROBE = join(ROOT, "bench/test/fixtures/required_defaults_probe.py");
const LIST = join(ROOT, "bench/data/appworld-required-defaults.json");
const CATALOGUE_PATH = join(ROOT, "bench/data/appworld-schemas.json");

/**
 * A local fixture rather than the shared one: the shared catalogue is asserted on
 * by four other suites (tool counts, span tables), and this one needs a mutating
 * API with a runtime-resolved default next to a read-only API that also mentions
 * defaults — which is the pair the rule has to separate.
 *
 * Modelled on `gmail.reply_to_email`, with the sentence copied verbatim from the
 * real schema, because that sentence is the thing the checker matches against.
 */
const REPLY_EVIDENCE =
	"If passed, it'll reply to all recipients in the list, otherwise, to the sender.";
const FIXTURE = [
	{
		server: "mail",
		tools: [
			{
				name: "reply_to_message",
				description: "Reply to an existing message in a thread.",
				inputSchema: {
					type: "object",
					properties: {
						body: { type: "string", description: "The body of the reply." },
						thread_id: { type: "integer", description: "The ID of the thread to reply to." },
						recipients: {
							type: "array",
							items: { type: "string" },
							description: `List of recipient email addresses. ${REPLY_EVIDENCE}`,
						},
						quiet: { type: "boolean", description: "Suppress notifications. Defaults to false." },
					},
					required: ["body", "thread_id"],
				},
			},
			{
				name: "show_threads",
				description: "List threads.",
				inputSchema: {
					type: "object",
					properties: {
						page_index: { type: "integer", description: "Page to fetch. If not passed, all of them are returned." },
					},
					required: [],
				},
			},
		],
	},
];
// Keyed the way requiredDefaultsIndex keys it: NUL, not a space, because real
// MCP server names contain spaces ("OpenAPI Explorer") and a space-joined key
// would be ambiguous for exactly those.
const LISTED = new Map([[`mail\u0000reply_to_message\u0000recipients`, REPLY_EVIDENCE]]);
const transformed = () => generate(FIXTURE, { apiLayout: "consolidated", requiredDefaults: LISTED });

/** The real `gmail.reply_to_email`, as the classifier sees it. */
function realTool(server, name) {
	const catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8")).catalogue;
	return catalogue.find((a) => a.server === server).tools.find((t) => t.name === name);
}

describe("the classifier cannot see task data", () => {
	// The things it must never be shown: an instruction, a ground-truth answer, the
	// evaluator's code, and a path into a previous run's artefacts.
	const forbidden = [
		'Reply "A gentle reminder." to everyone who has not replied in more than 48 hours',
		"ground_truth_answer",
		"def test_complete_task(self)",
		"evaluation.json",
		".run/appworld",
	];

	it("buildPrompt is a pure function of (name, description, inputSchema)", () => {
		// Asserted by construction rather than by reading the prompt: the function is
		// called with an object carrying every forbidden string as EXTRA fields, and
		// none can reach the output because none are destructured.
		const prompt = buildPrompt({
			...realTool("gmail", "reply_to_email"),
			instruction: forbidden[0],
			groundTruth: forbidden[1],
			evaluator: forbidden[2],
			runDir: forbidden[4],
		});
		for (const secret of forbidden) {
			assert.equal(prompt.includes(secret), false, `task data reached the classifier's prompt: ${secret}`);
		}
		assert.ok(prompt.includes("reply_to_email"), "the tool name is missing");
		assert.ok(prompt.includes("Reply to an existing email in a thread."), "the description is missing");
		assert.ok(prompt.includes("otherwise, to the sender"), "the input schema is missing");
	});

	it("reads exactly one file, the catalogue, plus its own trace on replay", () => {
		// The isolation guarantee is a property of the I/O, so it is asserted on the
		// I/O. A future reader adding a second input has to change this test, which is
		// the point of listing them rather than describing them.
		//
		// The pass's own only read is `loadRequiredDefaults`, which reads THIS pass's
		// own output for codegen — not an input to the classification. Everything the
		// pass reads while classifying is in the shared driver, so the driver carries
		// the same pin: a second input added there would reach both passes at once.
		const reads = [...CLASSIFIER.matchAll(/readFileSync\(([^)]*)\)/g)].map((m) => m[1].trim());
		assert.deepEqual(reads, ["path, \"utf8\""], `unexpected reads: ${reads}`);
		const driverReads = [...DRIVER.matchAll(/readFileSync\(([^)]*)\)/g)].map((m) => m[1].trim());
		assert.deepEqual(driverReads, ["inPath", "resolve(ROOT, replayPath"], `unexpected driver reads: ${driverReads}`);
		for (const forbiddenApi of ["readdirSync", "loadTasks", "globSync", "Task.load"]) {
			assert.equal(CLASSIFIER.includes(forbiddenApi), false, `the classifier can enumerate files with ${forbiddenApi}`);
			assert.equal(DRIVER.includes(forbiddenApi), false, `the driver can enumerate files with ${forbiddenApi}`);
		}
		const imports = [...CLASSIFIER.matchAll(/^} from "(\.[^"]+)";$|^import .* from "(\.[^"]+)";$/gm)].map((m) => m[1] ?? m[2]);
		assert.deepEqual(imports.sort(), ["./enrich-driver.mjs"]);
	});

	it("re-running the classifier over the same catalogue is safe — no idempotence guard needed", () => {
		// The enricher REFUSES an already-enriched input, because its output is a
		// catalogue of the same shape and a second pass would narrow an
		// already-narrowed schema, compounding unverifiable edits. This pass has no
		// analogous hazard and deliberately no analogous guard: it writes no
		// property back into the catalogue it read, and its output is a LIST, not a
		// catalogue — so feeding it its own output is not "enriching twice", it is a
		// type error, and the driver says so instead of dying on `app.tools`.
		assert.equal(/source\.enrichment/.test(CLASSIFIER), false, "the classifier grew an enrichment guard it does not need");
		assert.equal(/\.properties\[[^\]]*\] *=/.test(CLASSIFIER), false, "the classifier mutates the catalogue it read");
		assert.match(DRIVER, /is not a catalogue \(no top-level "catalogue" array\)/);
	});
});

describe("the checker finds the known case from schemas alone", () => {
	const gmail = realTool("gmail", "reply_to_email");

	it("accepts the ce73d68 proposal, quoting the real schema's own sentence", () => {
		const verdict = checkRequiredDefault({ parameter: "email_addresses", evidence: REPLY_EVIDENCE }, gmail);
		assert.equal(verdict.ok, true, verdict.reason);
		assert.equal(verdict.quote, REPLY_EVIDENCE);
	});

	it("the shipped list contains it, and every entry carries verbatim evidence", () => {
		// The requirement is that the CLASSIFIER found it. This asserts the artefact a
		// run actually loads, so a re-classification that loses the case fails here —
		// and the fix is the prompt, never the output.
		assert.ok(existsSync(LIST), `no classifier output at ${LIST} — run: node bench/required-defaults.mjs <env-file>`);
		const doc = JSON.parse(readFileSync(LIST, "utf8"));
		const known = doc.entries.find(
			(e) => e.app === "gmail" && e.tool === "reply_to_email" && e.param === "email_addresses",
		);
		assert.ok(known, `the classifier did not find gmail.reply_to_email.email_addresses: ${JSON.stringify(doc.entries)}`);
		assert.match(known.evidence_quote, /otherwise, to the sender/);

		// Every other entry has to survive the same checker, against the same source
		// catalogue — the list is data, and data that nobody re-derives is a hand-edit
		// waiting to happen.
		const catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8")).catalogue;
		for (const entry of doc.entries) {
			const tool = catalogue.find((a) => a.server === entry.app)?.tools.find((t) => t.name === entry.tool);
			assert.ok(tool, `${entry.app}.${entry.tool} is not in the catalogue`);
			const verdict = checkRequiredDefault({ parameter: entry.param, evidence: entry.evidence_quote }, tool);
			assert.equal(verdict.ok, true, `${entry.app}.${entry.tool}.${entry.param}: ${verdict.reason}`);
		}
	});
});

describe("the checker re-decides everything the model claimed", () => {
	const tool = FIXTURE[0].tools[0];
	const reject = (proposal, target = tool) => {
		const verdict = checkRequiredDefault(proposal, target);
		assert.equal(verdict.ok, false, `accepted: ${JSON.stringify(proposal)}`);
		return verdict.reason;
	};

	it("rejects invented evidence, however plausible", () => {
		// The one failure mode that could make a task unsolvable is a parameter made
		// mandatory on a justification nobody can find in the documentation.
		assert.match(
			reject({ parameter: "recipients", evidence: "Defaults to the original sender of the thread." }),
			/evidence not found in the documentation/,
		);
	});

	it("rejects a paraphrase of a sentence that IS there", () => {
		assert.match(
			reject({ parameter: "recipients", evidence: "if omitted it replies to the sender" }),
			/evidence not found in the documentation/,
		);
	});

	it("rejects a literal default, which is the common case", () => {
		assert.match(reject({ parameter: "quiet", evidence: "Defaults to false." }), /literal default/);
	});

	it("rejects a runtime-resolved default on a READ-ONLY API", () => {
		// `show_threads.page_index` documents "if not passed, all of them" — a genuine
		// runtime-resolved default, on a call that changes nothing. Making it mandatory
		// would tax a lookup to fix a mutation problem.
		assert.match(
			reject({ parameter: "page_index", evidence: "If not passed, all of them are returned." }, FIXTURE[0].tools[1]),
			/not a mutation/,
		);
	});

	it("rejects a parameter that is already required, or absent", () => {
		assert.match(reject({ parameter: "body", evidence: REPLY_EVIDENCE }), /already required/);
		assert.match(reject({ parameter: "cc", evidence: REPLY_EVIDENCE }), /no such parameter/);
		assert.match(reject({ parameter: "recipients", evidence: "" }), /no evidence quote/);
	});

	it("decides the mutation half from the NAME, not from the model's say-so", () => {
		// A model asked to classify its own proposal will agree with it.
		assert.equal(isMutation({ name: "reply_to_email" }), true);
		assert.equal(isMutation({ name: "create_payment_request" }), true);
		assert.equal(isMutation({ name: "mark_thread_read" }), true);
		assert.equal(isMutation({ name: "show_inbox_threads" }), false);
		assert.equal(isMutation({ name: "search_products" }), false);
		// MCP annotations win where a server ships them.
		assert.equal(isMutation({ name: "search_products", annotations: { destructiveHint: true } }), true);
		assert.equal(isMutation({ name: "delete_everything", annotations: { readOnlyHint: true } }), false);
	});
});

describe("the transform is off by default and byte-identical when off", () => {
	it("generate() without the option renders the tree it always rendered", () => {
		// The A/B compares two trees; a dormant branch is not "the same file".
		const base = generate(FIXTURE, { apiLayout: "consolidated" });
		assert.deepEqual(base, generate(FIXTURE, { apiLayout: "consolidated", requiredDefaults: null }));
		assert.deepEqual(base, generate(FIXTURE, { apiLayout: "consolidated", requiredDefaults: new Map() }));
		// A list naming something this catalogue does not have changes nothing either.
		assert.deepEqual(base, generate(FIXTURE, { apiLayout: "consolidated", requiredDefaults: new Map([["mail\u0000reply_to_message\u0000nope", "x"]]) }));
	});

	it("the untransformed signature still carries the default", () => {
		const module = generate(FIXTURE, { apiLayout: "consolidated" }).files["mail.py"];
		assert.match(module, /async def reply_to_message\(body: str, thread_id: int, recipients: list\[str\] \| None = None/);
		assert.equal(/Required here/.test(module), false);
	});

	it("does not mutate the catalogue it was given", () => {
		// normalizeTool hands back the catalogue's own inputSchema object, so a
		// transform that wrote `required` through would silently make the SECOND
		// generate() in a process differ from the first.
		const before = JSON.stringify(FIXTURE);
		transformed();
		assert.equal(JSON.stringify(FIXTURE), before, "the transform edited the shared catalogue in memory");
		assert.deepEqual(
			generate(FIXTURE, { apiLayout: "consolidated" }),
			generate(FIXTURE, { apiLayout: "consolidated" }),
			"a previous transformed generate() leaked into an untransformed one",
		);
	});
});

describe("a promoted parameter renders as required, with the reason beside it", () => {
	const files = transformed().files;

	it("appears in the signature with no default, after the original required ones", () => {
		assert.match(
			files["mail.py"],
			/async def reply_to_message\(body: str, thread_id: int, recipients: list\[str\], quiet: bool \| None = None\) -> Any:/,
		);
	});

	it("carries exactly one added docstring line, quoting the evidence", () => {
		// Without it the signature says "required" while the description beside it
		// still says the server has a default, and the agent is left reconciling two
		// contradictory statements about one slot.
		const module = files["mail.py"];
		assert.match(module, /Required here: the server-side default \('If passed, it'll reply to all recipients in the list, otherwise, to the sender\.'\) resolves against runtime state, so you must choose explicitly\./);
		assert.equal(module.match(/Required here:/g).length, 1, "the note is rendered more than once");
		// And it does NOT claim the parameter is optional any more.
		const args = module.slice(module.indexOf("Args:"), module.indexOf("Returns:"));
		assert.equal(/recipients:.*Optional\./.test(args), false, "a promoted parameter is still labelled Optional");
		assert.match(args, /quiet:.*Optional\./, "an unlisted optional parameter lost its label");
	});

	it("never emits a quote that could terminate the docstring it sits in", () => {
		// This text is written into a Python source file. CLAUDE.md already records a
		// snippet whose backslashes were mangled into a file that would not compile.
		const note = requiredDefaultNote({ requiredDefault: 'a "quoted" \\ phrase """ here\n   spanning lines' });
		assert.equal(/["\\\n]/.test(note), false, `the note carries a docstring hazard: ${note}`);
	});

	it("moves the schema with the signature, so validation cannot disagree", () => {
		const { toolDefs, files: validated } = generate(FIXTURE, {
			apiLayout: "consolidated",
			validateArgs: true,
			requiredDefaults: LISTED,
		});
		assert.deepEqual(toolDefs[0].input_schema.required.sort(), ["body", "recipients", "thread_id"]);
		assert.deepEqual(JSON.parse(validated["_schemas.json"]).tools.mail.reply_to_message.required.sort(), [
			"body",
			"recipients",
			"thread_id",
		]);
	});

	it("shows the same sentence in the L4 resident docs, from the same helper", () => {
		// The resident text and the on-disk text must not be able to drift; that is
		// why both call requiredDefaultNote rather than each spelling it out.
		const { normalized } = transformed();
		const param = normalized[0].tools[0].params.find((p) => p.name === "recipients");
		assert.equal(param.required, true);
		assert.equal(param.requiredDefault, REPLY_EVIDENCE);
	});

	it("leaves the line map exact — the read gate still cites the right span", () => {
		const gatedFiles = generate(FIXTURE, { apiLayout: "consolidated", readGate: true, requiredDefaults: LISTED }).files;
		const map = JSON.parse(gatedFiles["_linemap.json"]);
		const lines = gatedFiles["mail.py"].split("\n");
		for (const [name, [start, end]] of Object.entries(map.mail)) {
			assert.ok(lines[start - 1].startsWith(`async def ${name}(`), `${name}: span starts at ${JSON.stringify(lines[start - 1])}`);
			assert.equal(lines[end - 1].trim(), ")", `${name}: span ends at ${JSON.stringify(lines[end - 1])}`);
		}
		const [start, end] = map.mail.reply_to_message;
		assert.match(gatedFiles["mail.py"].split("\n").slice(start - 1, end).join("\n"), /Required here:/);
	});

	it("indexes the shipped file's format in one place", () => {
		assert.deepEqual(
			[...requiredDefaultsIndex({ entries: [{ app: "gmail", tool: "reply_to_email", param: "email_addresses", evidence_quote: "q" }] })],
			[["gmail\u0000reply_to_email\u0000email_addresses", "q"]],
		);
	});
});

describe("executed against a stub transport, both ways", () => {
	const dirs = [];
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	const write = (label, files) => {
		const dir = mkdtempSync(join(tmpdir(), `harness-reqd-${label}-`));
		dirs.push(dir);
		for (const [rel, content] of Object.entries(files)) {
			const path = join(dir, "api", rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		return dir;
	};

	it("omitting the promoted argument raises TypeError and sends nothing", () => {
		const dir = write("on", transformed().files);
		assert.match(execFileSync("python3", [PROBE, dir, "required"], { encoding: "utf8", stdio: "pipe" }), /OK/);
	});

	it("the identical omission goes through on the untransformed tree", () => {
		// Which is what makes the result above a property of the transform rather
		// than of the fixture.
		const dir = write("off", generate(FIXTURE, { apiLayout: "consolidated" }).files);
		assert.match(execFileSync("python3", [PROBE, dir, "optional"], { encoding: "utf8", stdio: "pipe" }), /OK/);
	});

	it("every module of the real catalogue still parses with the shipped list applied", () => {
		// The list is applied to 469 real APIs, not to a fixture. A promoted parameter
		// ordered after a defaulted one is a SyntaxError, and it would take out the
		// whole arm.
		if (!existsSync(LIST)) return;
		const catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8")).catalogue;
		const index = requiredDefaultsIndex(JSON.parse(readFileSync(LIST, "utf8")));
		const dir = write("real", generate(catalogue, { apiLayout: "consolidated", requiredDefaults: index }).files);
		for (const rel of Object.keys(generate(catalogue, { apiLayout: "consolidated", requiredDefaults: index }).files)) {
			if (!rel.endsWith(".py")) continue;
			assert.doesNotThrow(
				() => execFileSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", join(dir, "api", rel)], { stdio: "pipe" }),
				`generated module does not parse: ${rel}`,
			);
		}
	});
});

describe("the runner and the sweep label it and prove it bound", () => {
	it("is codemode-only and lands in the runId, in both", () => {
		// A variant run that overwrote the run it is compared against destroys the
		// comparison — the runId-collision failure this project has already had.
		assert.match(RUNNER, /const requiredDefaultsOn = argv\.includes\("--required-defaults"\)/);
		assert.match(RUNNER, /\|\| readGate \|\| requiredDefaultsOn \|\|[^)]*\) && arm !== "codemode"/);
		assert.match(RUNNER, /\$\{requiredDefaultsOn \? "__reqd" : ""\}/);
		assert.match(SWEEP, /const codemodeRequiredDefaults = has\("codemode-required-defaults"\)/);
		assert.match(SWEEP, /\$\{codemodeRequiredDefaults \? "__reqd" : ""\}/);
		assert.match(SWEEP, /if \(codemodeRequiredDefaults\) args\.push\("--required-defaults"\)/);
	});

	it("refuses a run whose label would over-claim", () => {
		// A missing or empty list, or a list that promotes nothing in this catalogue,
		// would produce an ordinary run wearing a `__reqd` label — which is exactly
		// how "deferred registration never worked" survived for months.
		assert.match(RUNNER, /missing required-defaults list/);
		assert.match(RUNNER, /lists no parameters — a --required-defaults run would transform nothing/);
		assert.match(RUNNER, /promoted no parameter in this catalogue — the transform did not bind/);
	});

	it("checks the transport, not the flag, and records the VALUE", () => {
		// The silent failure is a stale api/ tree. The falsifier needs the value, not
		// the presence: forced to fill the slot, an agent could fill it with its own
		// address, in which case the mechanism was never representational.
		assert.match(RUNNER, /summary\.requiredDefaultsViolation =/);
		assert.match(RUNNER, /the signature has no default for it, so the value was passed/);
		assert.match(RUNNER, /supplied: param in \(call\.args \?\? \{\}\), value: call\.args\?\.\[param\] \?\? null/);
	});

	it("names the one escape Python still allows, rather than claiming none", () => {
		// `f(x=None)` is a legal call against a no-default parameter and `_client` drops
		// Nones before sending, so the wire looks identical to an omission. That is a
		// deliberate choice of "no recipients" rather than a forgotten argument — but it
		// reproduces the same bug, and a guard that mis-attributed it to a stale tree
		// would send the next reader hunting the wrong thing.
		assert.match(RUNNER, /passed\n?\s*\* explicitly as None|explicitly as None/);
		assert.match(RUNNER, /--validate-args would refuse this; it was not on/);
	});
});
