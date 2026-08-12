#!/usr/bin/env node
/**
 * AppWorld's API catalogue -> the shape `bench/generate.mjs` already consumes.
 *
 *   bench/appworld/build-catalogue.mjs [--out bench/data/appworld-schemas.json]
 *                                      [--with-response-schemas]
 *
 * Writes `{ catalogue: [{ server, tools: [{ name, description, inputSchema }] }] }`,
 * one "server" per AppWorld app. Everything downstream — the generated `api/`
 * tree, the L2 TOC, the L1 name list, the vanilla arm's JSON tool definitions —
 * then falls out of the existing renderers with no new code and no second
 * authoring path. That is the fairness mechanism in docs/DESIGN.md: one authored
 * description, N containers, no paraphrase.
 *
 * The source is AppWorld's own `data/api_docs/function_calling/*.json`, not the
 * `standard` rendering, and not a conversion written here. Reasons, in order:
 *
 *   1. It is already JSON Schema, converted by the benchmark. `standard` states
 *      constraints as prose ("value in ['charcoal', 'red', ...]", "length >= 10,
 *      <= 10") and parsing those into `enum`/`minLength` here would put a
 *      hand-written converter between the benchmark and the arm under test — a
 *      bug in it would silently deform one arm's view of a tool.
 *   2. It is exactly what upstream's own function-calling baseline passes as
 *      `tools=` (experiments/code/simplified/function_calling_agent.py:119), so
 *      our vanilla arm sees the schemas the published numbers were measured on.
 *
 * `--with-response-schemas` appends AppWorld's documented success/failure
 * response shapes (present only in the `standard` rendering) to each
 * description. Off by default so vanilla matches upstream's baseline byte for
 * byte; when on, the text is appended to the *single* `description` field, so
 * every container picks it up and the arms stay matched.
 *
 * The `canary_string` on every entry is dropped. It exists so labs can filter
 * training data; shipping 473 copies of it into a prompt costs tokens and buys
 * nothing.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const APPWORLD = join(ROOT, "vendor/appworld");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};

const outPath = join(ROOT, flag("out", "bench/data/appworld-schemas.json"));
const withResponses = argv.includes("--with-response-schemas");

/**
 * Apps the agent is not competing on.
 *
 * `api_docs` is AppWorld's own schema-lookup surface. Exposing it to the vanilla
 * arm would hand it a second, benchmark-authored deferred-residency mechanism on
 * top of the one under test, and exposing it to codemode duplicates `grep`. Both
 * arms get their own discovery path from the harness; this one is excluded from
 * the catalogue so neither arm has two.
 *
 * `supervisor` is NOT excluded — `supervisor.complete_task` is how an answer is
 * submitted and `show_account_passwords` is how the agent logs in. Removing it
 * would make every task unsolvable.
 *
 * `admin` never appears in the docs and is filtered by AppWorld's own request
 * tracker as not user-facing.
 */
const EXCLUDED_APPS = new Set(["api_docs", "admin"]);

/** Render AppWorld's documented response shapes as description text. */
function renderResponses(standardEntry) {
	const schemas = standardEntry?.response_schemas;
	if (!schemas) return "";
	const lines = ["", "Response:"];
	for (const [outcome, shape] of Object.entries(schemas)) {
		lines.push(`  ${outcome}: ${JSON.stringify(shape)}`);
	}
	return lines.join("\n");
}

function build() {
	const fcDir = join(APPWORLD, "data/api_docs/function_calling");
	const stdDir = join(APPWORLD, "data/api_docs/standard");
	let files;
	try {
		files = readdirSync(fcDir).filter((f) => f.endsWith(".json")).sort();
	} catch (error) {
		throw new Error(
			`cannot read ${fcDir} — run 'appworld download data' in vendor/appworld first (${error.message})`,
		);
	}

	const catalogue = [];
	let total = 0;
	for (const file of files) {
		const app = file.replace(/\.json$/, "");
		if (EXCLUDED_APPS.has(app)) continue;

		const entries = JSON.parse(readFileSync(join(fcDir, file), "utf8"));
		// `standard` is keyed by api_name; only read it when we need responses.
		const standard = withResponses ? JSON.parse(readFileSync(join(stdDir, file), "utf8")) : {};

		const tools = entries.map((entry) => {
			const fn = entry.function ?? entry;
			// Upstream qualifies names as `<app>__<api>`; strip the prefix so the
			// catalogue stores the bare api name and wireName()/pyIdent() in
			// bench/generate.mjs re-qualify it per container, exactly as they do for
			// MCP servers. Keeping the prefix here would produce `spotify__spotify__login`.
			const bare = fn.name.startsWith(`${app}__`) ? fn.name.slice(app.length + 2) : fn.name;
			const schema = structuredClone(fn.parameters ?? { type: "object", properties: {} });
			// `"default": null` on an optional parameter is noise in every container
			// and is not what AppWorld's API does with an explicit null (see the
			// None-dropping note in renderClient()).
			for (const spec of Object.values(schema.properties ?? {})) {
				if (spec && typeof spec === "object" && spec.default === null) delete spec.default;
			}
			const description = (fn.description ?? "").trim() + (withResponses ? renderResponses(standard[bare]) : "");
			return { name: bare, description, inputSchema: schema };
		});

		total += tools.length;
		catalogue.push({ server: app, tools });
	}

	if (total === 0) throw new Error("built an empty catalogue — refusing to write it");
	return { catalogue, total };
}

const { catalogue, total } = build();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
	outPath,
	`${JSON.stringify(
		{
			source: "appworld:data/api_docs/function_calling",
			appworldDataVersion: readFileSync(join(APPWORLD, "data/version.txt"), "utf8").trim(),
			withResponseSchemas: withResponses,
			excludedApps: [...EXCLUDED_APPS],
			builtAt: new Date().toISOString(),
			catalogue,
		},
		null,
		1,
	)}\n`,
);

console.log(`${catalogue.length} apps, ${total} tools -> ${outPath}`);
for (const { server, tools } of catalogue) console.log(`  ${server.padEnd(14)} ${tools.length}`);
