#!/usr/bin/env node
/**
 * Materialize the codemode arm's api/ tree from the MCP catalogue.
 *
 *   node bench/build-api.mjs [--out .run/api] [--servers "Math MCP,Wikipedia"]
 *
 * With --servers, only those servers are written — that is how a task gets the
 * catalogue it is entitled to see (its own servers plus MCP-Bench's declared
 * distractors) rather than all 27.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./generate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};

const out = join(ROOT, flag("out", ".run/api"));
const only = (flag("servers", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const dataPath = join(ROOT, flag("data", "bench/data/mcp-schemas.json"));

const { catalogue } = JSON.parse(readFileSync(dataPath, "utf8"));
const selected = only.length > 0 ? catalogue.filter((s) => only.includes(s.server)) : catalogue;

if (only.length > 0 && selected.length !== only.length) {
	const missing = only.filter((n) => !selected.some((s) => s.server === n));
	console.error(`warning: no schemas for ${missing.join(", ")} — excluded from the api/ tree`);
}

const { files, toolDefs } = generate(selected);

rmSync(out, { recursive: true, force: true });
for (const [rel, content] of Object.entries(files)) {
	const path = join(out, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

console.log(`${selected.length} servers, ${toolDefs.length} tools -> ${Object.keys(files).length} files in ${out}`);
