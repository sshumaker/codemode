/**
 * Arm construction and residency accounting.
 *
 * An "arm" is a tool registry. `vanilla` exposes the seven conventional tools;
 * `codemode` exposes one persistent Python REPL. See docs/DESIGN.md.
 *
 * Everything here runs without an API key: tool definitions are built directly
 * from the harness registry, so composition, schema shape, and resident token
 * cost are all testable offline.
 */
import { getEncoding } from "js-tiktoken";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "vendor/prime-agent/packages/coding-agent/dist/core/tools/index.js");

export const ARMS = {
	vanilla: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	codemode: ["ipython"],
};

/**
 * Token counts use cl100k_base, not Anthropic's tokenizer. Absolute values are
 * therefore approximate; arm-to-arm *ratios* are what the experiment reads, and
 * both arms are measured with the same encoder.
 */
const encoding = getEncoding("cl100k_base");
export const countTokens = (text) => encoding.encode(text).length;

let registryPromise;
const loadRegistry = () => (registryPromise ??= import(REGISTRY));

/**
 * The wire form of a tool definition — what actually occupies context on every
 * request. Mirrors the Anthropic tools parameter: name, description, schema.
 */
export function toWireFormat(def) {
	return { name: def.name, description: def.description ?? "", input_schema: def.parameters ?? {} };
}

/** Build one arm's tool definitions. `cwd` only affects path-relative help text. */
export async function buildArm(arm, cwd = ROOT) {
	const names = ARMS[arm];
	if (!names) throw new Error(`unknown arm: ${arm} (have: ${Object.keys(ARMS).join(", ")})`);

	const registry = await loadRegistry();
	const all = registry.createAllToolDefinitions(cwd, {});

	const tools = names.map((name) => {
		const def = all[name];
		if (!def) throw new Error(`arm ${arm} wants "${name}", which the registry did not build`);
		return def;
	});

	const wire = tools.map(toWireFormat);
	const perTool = Object.fromEntries(wire.map((w) => [w.name, countTokens(JSON.stringify(w))]));

	return {
		arm,
		names,
		tools,
		wire,
		/** Tokens resident in every request for this arm's definitions. */
		residentTokens: countTokens(JSON.stringify(wire)),
		perTool,
	};
}

/**
 * Render an arm at a residency level. See docs/DESIGN.md — residency is a dial,
 * and `vanilla` is simply its L4 endpoint.
 *
 *   L0  nothing resident; the agent discovers via the api/ tree
 *   L1  names only; schemas fetched on demand (what Claude Code does)
 *   L2  one line per tool: signature + summary
 *   L4  full JSON schemas
 */
export function renderResidency(built, level) {
	const firstLine = (d) => (d ?? "").trim().split("\n")[0] ?? "";
	switch (level) {
		case "L0":
			return "";
		case "L1":
			return built.wire.map((w) => w.name).join("\n");
		case "L2":
			return built.wire
				.map((w) => `${w.name}(${Object.keys(w.input_schema?.properties ?? {}).join(", ")}) — ${firstLine(w.description)}`)
				.join("\n");
		case "L4":
			return JSON.stringify(built.wire);
		default:
			throw new Error(`unknown residency level: ${level}`);
	}
}

export const RESIDENCY_LEVELS = ["L0", "L1", "L2", "L4"];
