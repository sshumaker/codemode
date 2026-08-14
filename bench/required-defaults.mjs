#!/usr/bin/env node
/**
 * Find the optional parameters whose *default* silently picks the target of a
 * mutation, so codegen can refuse to let one be left out.
 *
 *   node bench/required-defaults.mjs <env-file> [--in <catalogue>] [--out <json>]
 *                                    [--model claude-opus-5] [--concurrency 6] [--limit N]
 *   node bench/required-defaults.mjs --replay <trace.jsonl> [--out <json>]
 *
 * ## The measured thing this exists for
 *
 * `docs/CC-EDGE-TRACES.md` §M1. `api.gmail.reply_to_email` takes an OPTIONAL
 * `email_addresses`, and its documentation says: "If passed, it'll reply to all
 * recipients in the list, otherwise, to the sender." Every thread in the
 * `ce73d68` family is an OUTBOX thread, so "the sender" is the supervisor — the
 * reply goes to the user themselves and the grader fires. 35 of 36 codemode runs
 * omitted the argument and every one of those failed, invariant to residency,
 * prompt, layout, docs gating, catalogue enrichment and argument validation.
 * A *verified* read-gate then proved the model had read that exact sentence and
 * omitted the argument anyway, and vanilla with the whole JSON schema resident
 * omitted it too.
 *
 * So the untested cell is not "can the model see it" — it is **what happens when
 * the slot cannot be left empty**. Rendering the parameter as REQUIRED turns the
 * omission into a Python `TypeError` at the call site, in the error channel this
 * project has repeatedly measured to work ("put the correction in the error, not
 * in the prompt"), and forces the value to be *named* — the shape shared by every
 * passing run in that family.
 *
 * ## Why a classifier rather than a hardcoded pair
 *
 * `(gmail, reply_to_email, email_addresses)` is one entry and there are 469 APIs.
 * Fitting the transform to the task that motivated it is reference-fitting, and
 * `docs/CC-EDGE-TRACES.md` says so in the fix ranking. The rule has to be stated
 * over the *schema surface* — "an optional parameter of a mutating API whose
 * documented default resolves against runtime state" — and applied by something
 * that never sees a task. If this pass does not rediscover the gmail case from
 * schemas alone, the prompt is wrong; the output is never edited to add it.
 *
 * ## The guardrails, and why each is code rather than prompt text
 *
 * Same four as `bench/enrich-catalogue.mjs`, which this deliberately mirrors:
 *
 * 1. **The classifier never sees task data.** Its entire input is (name,
 *    description, inputSchema) read from the catalogue file. `buildPrompt` is a
 *    pure function of those three fields and takes nothing else — there is no
 *    parameter through which a task, a ground truth or a run artefact could
 *    arrive. A prompt that merely *said* "do not look at the tasks" would be the
 *    documented-but-unexecuted check this project keeps rediscovering.
 * 2. **Acceptance is decided in code, from the documentation the model was shown.**
 *    `checkRequiredDefault` re-derives all three conditions itself: the parameter
 *    exists and is optional, the evidence appears VERBATIM in that API's own
 *    documentation, and it states a runtime-resolved default rather than a fixed
 *    literal. The mutation half is decided from the tool NAME's verb (and any MCP
 *    `destructiveHint`), never from the model's own say-so.
 * 3. **Every proposal is logged with its inputs and its verdict** to a JSONL, the
 *    judge-trace pattern, so a rejection is re-derivable tomorrow.
 * 4. **Anything unverifiable is dropped**, and dropping is silent in effect — the
 *    parameter keeps its source optionality exactly.
 *
 * The output is a small, human-auditable JSON list of
 * `{app, tool, param, evidence_quote}`. Read it before trusting a run.
 *
 * ## This is not a codemode-only affordance, and must not become one
 *
 * The list is derived from the shared catalogue and lands in `schema.required`,
 * which is the same field the vanilla arm's JSON tool definitions carry —
 * **nothing stops a tool-calling harness applying this pass to its own schemas**,
 * and the provider would then reject the call the same way Python does. It is
 * currently wired to the codemode arm only because that is where the measured
 * failure is; if it works, it is a catalogue-level improvement both arms are
 * entitled to. Level up, not down.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callModel } from "./enrich-catalogue.mjs";
import { pool } from "./pool.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The instruction, and the model's entire view of the world.
 *
 * A pure function of one tool's three public fields, exported so a test can
 * assert that property directly rather than trusting this sentence: pass a
 * catalogue and a task corpus, and check the corpus appears nowhere in what the
 * function returns for any tool.
 *
 * The two questions are asked together on purpose. Both halves are re-decided in
 * code afterwards, so this is only ever a *proposer*; what it must do well is
 * notice the sentence, which is why the second question spends its words
 * separating a runtime-resolved default ("to the sender") from a literal one
 * ("false", "10") rather than explaining the consequence.
 */
export function buildPrompt({ name, description, inputSchema }) {
	return [
		"You are auditing ONE API's contract, offline, before any agent runs.",
		"",
		"You are given ONLY that API's name, its documentation, and its input schema.",
		"There is no task, no user and no context beyond this. Do not imagine one.",
		"",
		"Answer two questions from the documentation alone.",
		"",
		"1. Is this API a MUTATION — does calling it change the world (send, reply, order,",
		"   pay, transfer, post, create, delete, update, mark), as opposed to reading,",
		"   searching or listing something?",
		"",
		"2. Does any OPTIONAL parameter have a default that the SERVER RESOLVES AGAINST",
		"   RUNTIME STATE rather than a fixed literal? These are the parameters that",
		"   decide WHO OR WHAT the call affects when the caller never names it. The",
		"   documentation states them in phrases like:",
		'     - "otherwise, to the sender"',
		'     - "defaults to the currently logged-in user"',
		'     - "if not passed, all of them"',
		'     - "defaults to the active item" / "to today"',
		"   A default of `false`, `0`, `10`, or any fixed string is NOT one of these.",
		"   A parameter whose omission means *the server picks the target for you* IS.",
		"",
		"Hard rules:",
		"  - Quote the evidence VERBATIM from the documentation above. A paraphrase, a",
		"    reworded summary, or an elided quote is rejected. If no sentence states what",
		"    happens when the parameter is omitted, propose nothing for it.",
		"  - Only parameters that are currently OPTIONAL (absent from the schema's",
		"    `required` list). A parameter that is already required needs no proposal.",
		"  - Proposing nothing is the correct answer for most APIs. Say so.",
		"",
		`API name: ${name}`,
		"",
		"Documentation:",
		description || "(none)",
		"",
		"Current input schema:",
		JSON.stringify(inputSchema, null, 1),
		"",
		"Reply with JSON and nothing else:",
		"{",
		'  "mutating": true,',
		'  "mutation_evidence": "<the phrase that makes it a mutation, or null>",',
		'  "proposals": [',
		'    {"parameter": "<name>",',
		'     "resolves_to": "<what the server picks when this is omitted>",',
		'     "evidence": "<the exact sentence in the documentation that states it>"}',
		"  ]",
		"}",
		'An empty "proposals" list is a valid and common answer.',
	].join("\n");
}

// --- the checker: everything the model says is re-decided here -----------------

/**
 * Tool-name verbs that mean "this call changed the world".
 *
 * Decided from the NAME rather than from the model's `mutating` field for the
 * same reason enrichment's narrowing check is code: a model asked to classify
 * its own proposal will agree with it. The list is deliberately generous — a
 * false accept needs BOTH a mutation verb and a runtime-resolved default, and
 * the second is the rare one — but it errs conservative where it is wrong,
 * because a missed mutation only leaves a parameter exactly as the source
 * schema had it.
 */
export const MUTATION_VERBS = new Set([
	"add", "apply", "archive", "block", "book", "buy", "cancel", "clear", "create", "delete",
	"edit", "follow", "forward", "install", "invite", "like", "mark", "move", "order", "pay",
	"post", "purchase", "put", "rate", "register", "remove", "rename", "reply", "request",
	"reset", "schedule", "send", "set", "share", "submit", "subscribe", "transfer", "unblock",
	"unfollow", "unsubscribe", "update", "upload", "write",
]);

/** Does this API's own name (or its MCP annotation) say it mutates? */
export function isMutation({ name, annotations }) {
	if (annotations?.destructiveHint === true) return true;
	if (annotations?.readOnlyHint === true) return false;
	return String(name ?? "")
		.split(/[^a-z0-9]+/i)
		.some((token) => MUTATION_VERBS.has(token.toLowerCase()));
}

/**
 * The two halves of "this default is resolved against runtime state".
 *
 * A TRIGGER establishes that the sentence is about what happens when the
 * parameter is absent, and a REFERENT establishes that what fills it is a piece
 * of the world rather than a literal. Both are required, which is what keeps
 * "Defaults to false." and "The maximum is 10 by default." out: they trigger and
 * refer to nothing.
 */
const DEFAULT_TRIGGER =
	/\b(otherwise|if (?:it is )?(?:not|no|none|omitted|absent|empty|unset|left)\b|if you (?:do not|don't)\b|when omitted|when not (?:passed|provided|given|specified)|unless (?:passed|provided|given|specified)|by default|defaults? to|default is|default:)/i;
const DEFAULT_REFERENT =
	/\b(sender|recipients?|current|currently|active|logged[- ]?in|signed[- ]?in|yourself|your own|the user|the caller|the owner|the account|the supervisor|self|all\b|every\b|today|now|latest|most recent|first|last|whole|entire)\b/i;

const norm = (text) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
// Quotation marks and ellipses are formatting the model wraps a quote in, not part
// of the quote. Everything inside them must match the documentation exactly.
const trimQuote = (text) => String(text ?? "").replace(/^[\s"'`‘’“”…]+|[\s"'`‘’“”…]+$/g, "");
// ...and a trailing full stop is dropped for MATCHING only, since a model quoting
// mid-sentence may or may not include it. The stored quote keeps whatever the
// documentation has, because that string is rendered back into the docstring.
const matchable = (text) => norm(text).replace(/[.,;:]+$/, "");

/**
 * Judge one proposal against the API's own documentation. Pure; no model, no I/O.
 *
 * Returns `{ ok, reason, quote }`. `quote` is the *source* text, whitespace-
 * normalized — never the model's string written through, for the same reason
 * enrichment applies the checker's merged schema rather than the model's object.
 */
export function checkRequiredDefault({ parameter, evidence }, { name, description, inputSchema, annotations }) {
	const properties = inputSchema?.properties ?? {};
	const spec = properties[parameter];
	if (!spec) return { ok: false, reason: `no such parameter: ${parameter}` };
	if ((inputSchema?.required ?? []).includes(parameter)) return { ok: false, reason: `already required: ${parameter}` };

	const quote = trimQuote(evidence);
	if (!quote) return { ok: false, reason: "no evidence quote" };

	// The documentation the model was shown, and nothing else. A quote that is not
	// in it is invented, and an invented justification for making an argument
	// mandatory is the one failure mode that could make a task unsolvable.
	const documentation = norm(`${description ?? ""} ${spec.description ?? ""}`);
	if (!documentation.includes(matchable(quote))) return { ok: false, reason: "evidence not found in the documentation" };

	if (!DEFAULT_TRIGGER.test(quote)) return { ok: false, reason: "evidence does not state what happens when it is omitted" };
	if (!DEFAULT_REFERENT.test(quote)) return { ok: false, reason: "evidence states a literal default, not a runtime-resolved one" };

	if (!isMutation({ name, annotations })) return { ok: false, reason: `not a mutation: ${name}` };

	return { ok: true, reason: "ok", quote: String(quote).replace(/\s+/g, " ").trim() };
}

/**
 * `"<app>\0<tool>\0<param>" -> evidence quote`, the shape codegen consumes.
 *
 * Exported here rather than written in generate.mjs so there is one reader of
 * this file's format, and a test can build the index from a literal.
 */
export function requiredDefaultsIndex(doc) {
	const index = new Map();
	for (const entry of doc?.entries ?? []) {
		index.set(`${entry.app}\u0000${entry.tool}\u0000${entry.param}`, entry.evidence_quote);
	}
	return index;
}

/** Read the classifier's output and index it. Throws if the file is not there. */
export function loadRequiredDefaults(path) {
	return requiredDefaultsIndex(JSON.parse(readFileSync(path, "utf8")));
}

// --- everything below is I/O; the model's view is fixed above ------------------

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};

async function main() {
	const replayPath = flag("replay", null);
	const envFile = argv.find((a) => !a.startsWith("--") && (a.includes("/") || a.includes(".env")));
	if (!envFile && !replayPath) {
		console.error("usage: bench/required-defaults.mjs <env-file> [--in <catalogue>] [--out <json>]");
		console.error("       bench/required-defaults.mjs --replay <trace.jsonl> [--out <json>]");
		process.exit(2);
	}
	const inPath = resolve(ROOT, flag("in", "bench/data/appworld-schemas.json"));
	const outPath = resolve(ROOT, flag("out", "bench/data/appworld-required-defaults.json"));
	const model = flag("model", "claude-opus-5");
	const concurrency = Number(flag("concurrency", 6));
	const limit = Number(flag("limit", 0));

	// The single input. Nothing else is read: no task file, no run directory, no
	// evaluator. This line IS guardrail 1.
	const source = JSON.parse(readFileSync(inPath, "utf8"));

	const stats = { tools: 0, mutating: 0, proposals: 0, accepted: 0, rejected: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
	const rejections = {};
	const tracePath = replayPath
		? resolve(ROOT, flag("trace", `${replayPath}.replay`))
		: resolve(ROOT, flag("trace", "bench/data/required-defaults-trace.jsonl"));
	mkdirSync(dirname(tracePath), { recursive: true });
	writeFileSync(tracePath, "");
	const onTrace = (row) => appendFileSync(tracePath, `${JSON.stringify(row)}\n`);

	const entries = [];
	const toolIndex = new Map();
	for (const app of source.catalogue) {
		for (const tool of app.tools) toolIndex.set(`${app.server}\u0000${tool.name}`, tool);
	}

	/** Judge one proposal and record it, whatever the verdict. Shared with --replay. */
	const judge = (record) => {
		stats.proposals++;
		const tool = toolIndex.get(`${record.app}\u0000${record.tool}`);
		const verdict = tool
			? checkRequiredDefault(record, tool)
			: { ok: false, reason: `no such tool: ${record.app}.${record.tool}` };
		// content, predicate, verdict, model — the judge-trace pattern. The parameter's
		// own schema goes in the record rather than a pointer to it, because the
		// catalogue it points at is the thing that moves.
		onTrace({
			ts: new Date().toISOString(),
			model: record.model,
			app: record.app,
			tool: record.tool,
			parameter: record.parameter,
			source: tool?.inputSchema?.properties?.[record.parameter] ?? null,
			mutatingClaimed: record.mutatingClaimed ?? null,
			mutatingDerived: tool ? isMutation(tool) : null,
			resolves_to: record.resolves_to ?? null,
			evidence: record.evidence ?? null,
			accepted: verdict.ok,
			reason: verdict.reason,
		});
		if (!verdict.ok) {
			stats.rejected++;
			const key = verdict.reason.split(":")[0].slice(0, 60);
			rejections[key] = (rejections[key] ?? 0) + 1;
			return;
		}
		stats.accepted++;
		// The SOURCE text, normalized — never the model's string written through.
		entries.push({ app: record.app, tool: record.tool, param: record.parameter, evidence_quote: verdict.quote });
	};

	if (replayPath) {
		// Zero model calls: every proposal, and the API it was made against, is in the
		// trace. Re-deciding an old trace under today's checker must reproduce the same
		// verdicts for the same inputs — CLAUDE.md's test for sufficient logging, in
		// executable form.
		const rows = readFileSync(resolve(ROOT, replayPath), "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
		for (const row of rows) {
			if (row.error) {
				stats.failed++;
				continue;
			}
			judge({ ...row, mutatingClaimed: row.mutatingClaimed });
		}
		console.log(`replayed ${rows.length} trace records from ${replayPath}`);
	} else {
		const jobs = [];
		for (const app of source.catalogue) {
			for (const tool of app.tools) jobs.push({ app, tool });
		}
		const selected = limit > 0 ? jobs.slice(0, limit) : jobs;
		console.log(`${selected.length} tools -> ${model}, concurrency ${concurrency}`);

		await pool(
			selected,
			async ({ app, tool }) => {
				let reply;
				try {
					reply = await callModel(envFile, model, buildPrompt(tool));
				} catch (error) {
					stats.failed++;
					onTrace({ ts: new Date().toISOString(), model, app: app.server, tool: tool.name, error: String(error) });
					return;
				}
				stats.tools++;
				stats.inputTokens += reply.usage.input_tokens ?? 0;
				stats.outputTokens += reply.usage.output_tokens ?? 0;
				if (reply.parsed.mutating) stats.mutating++;
				for (const proposal of reply.parsed.proposals ?? []) {
					judge({
						model,
						app: app.server,
						tool: tool.name,
						parameter: proposal.parameter,
						resolves_to: proposal.resolves_to,
						evidence: proposal.evidence,
						mutatingClaimed: reply.parsed.mutating === true,
					});
				}
			},
			concurrency,
		);
	}

	entries.sort((a, b) => `${a.app}.${a.tool}.${a.param}`.localeCompare(`${b.app}.${b.tool}.${b.param}`));
	const doc = {
		model,
		source: flag("in", "bench/data/appworld-schemas.json"),
		sourceDigest: createHash("sha256").update(readFileSync(inPath)).digest("hex").slice(0, 16),
		replayedFrom: replayPath ?? undefined,
		trace: tracePath.slice(ROOT.length + 1),
		builtAt: new Date().toISOString(),
		stats,
		rejections,
		entries,
	};
	writeFileSync(outPath, `${JSON.stringify(doc, null, 1)}\n`);

	console.log(
		`tools ${stats.tools} (${stats.failed} failed, ${stats.mutating} called mutating)  ` +
			`proposals ${stats.proposals}  accepted ${stats.accepted}  rejected ${stats.rejected}`,
	);
	for (const [reason, n] of Object.entries(rejections).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${reason}`);
	for (const entry of entries) console.log(`  + ${entry.app}.${entry.tool}.${entry.param}  "${entry.evidence_quote}"`);
	console.log(`-> ${outPath}\n-> ${tracePath}`);
}

// Importable for tests (buildPrompt, checkRequiredDefault) without running the
// pass — the isolation guarantee is only testable if they can be called without
// a network.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
