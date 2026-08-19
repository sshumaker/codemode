#!/usr/bin/env node
/**
 * Build the product port's external-arm BUNDLE: the api/ tree plus the mechanism
 * guidance the product side hands to a codemode session.
 *
 *   node bench/port/build-bundle.mjs [--data .run/port-w1/catalogue.json] \
 *        [--out .run/port-w3/bundle] [--prompt q8] [--no-validate]
 *
 * `PRODUCT_EXTERNAL_ARM_BUNDLE_DIR` on the product side points at `--out`. Two
 * files matter over there and neither is invented here:
 *
 *   api/            exactly `bench/generate.mjs`'s tree, from W1's catalogue —
 *                   the same compiler every benchmark in this repo measures.
 *   preamble.txt    exactly `bench/prompts.mjs`'s codemode preamble for the named
 *                   variant, with this catalogue's real tool/server counts.
 *
 * The point of writing the preamble to a file rather than having the Python side
 * compose one: codemode's surface guidance is a MEASURED artifact of this repo
 * (q8 exists because q7 drove 99 calls per task), and a hand-written paraphrase
 * on the product side would silently make the ported arm a different arm from the
 * one the numbers describe.
 *
 * ## Why this file is tracked, and why validation defaults ON
 *
 * It lived in `.run/port-w3/` — which `.gitignore` covers — and called
 * `generate(catalogue)` bare. `validateArgs` is opt-in there, so the port shipped
 * an api/ tree whose `_client.py` was 63 lines with no `_validate` and no
 * `_schemas.json`: the runtime argument checking this repo built (task #36) was
 * simply absent from the arm, and nothing said so. The cost is not tidiness. A
 * wrong-shape argument took a round trip to the product and came back as a tool
 * error, and a media-job tool error is a `state=error` row in the very message
 * trace the product graders read — measured on `complete_job(final_outputs=[...])`,
 * which failed that way in three of four jobs before the default changed.
 *
 * So the default here is ON and the deviation is the flag. `--no-validate` exists
 * for a deliberate A/B and lands in `provenance.json` so a bundle can always say
 * what it was built with, per "log the inputs, not just the verdicts".
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../generate.mjs";
import { buildPreamble } from "../prompts.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Compile a catalogue into the bundle's files. Pure: no disk, no clock.
 *
 * @param catalogue the `catalogue` array of a W1 dump
 * @param options.variant  prompt variant for the preamble (default q8, measured)
 * @param options.validateArgs render the runtime validator + `_schemas.json`
 *   into the tree. Defaults TRUE here, unlike `generate()`, for the reason in
 *   this module's header.
 */
export function buildBundle(catalogue, { variant = "q8", validateArgs = true } = {}) {
	const { files, toolDefs } = generate(catalogue, { validateArgs });
	const preamble = buildPreamble(variant, { toolCount: toolDefs.length, serverCount: catalogue.length });
	return { files, toolDefs, preamble, validateArgs, variant };
}

function main(argv) {
	const flag = (name, fallback) => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : fallback;
	};
	// `resolve` against ROOT rather than `join`: a relative path still lands in the
	// repo, and an absolute one is taken as given instead of being appended to ROOT
	// (which is what the original did, silently producing `<repo>/var/folders/...`).
	const dataPath = resolve(ROOT, flag("data", ".run/port-w1/catalogue.json"));
	const out = resolve(ROOT, flag("out", ".run/port-w3/bundle"));
	const variant = flag("prompt", "q8");
	const validateArgs = !argv.includes("--no-validate");

	const { catalogue } = JSON.parse(readFileSync(dataPath, "utf8"));
	const { files, toolDefs, preamble } = buildBundle(catalogue, { variant, validateArgs });

	rmSync(join(out, "api"), { recursive: true, force: true });
	for (const [rel, content] of Object.entries(files)) {
		const path = join(out, "api", rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}

	writeFileSync(join(out, "preamble.txt"), `${preamble}\n`);
	writeFileSync(
		join(out, "provenance.json"),
		`${JSON.stringify(
			{
				builtAt: new Date().toISOString(),
				catalogue: dataPath,
				promptVariant: variant,
				// The generator settings are part of what a bundle IS: two trees built
				// from the same catalogue behave differently if one of them validates.
				generate: { validateArgs },
				servers: catalogue.map((s) => s.server),
				tools: toolDefs.length,
				files: Object.keys(files).length,
				preambleChars: preamble.length,
			},
			null,
			2,
		)}\n`,
	);

	console.log(
		`${catalogue.length} servers, ${toolDefs.length} tools -> ${Object.keys(files).length} files; ` +
			`preamble ${variant} (${preamble.length} chars); validateArgs=${validateArgs} -> ${out}`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2));
}
