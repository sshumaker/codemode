#!/usr/bin/env node
/**
 * Project resident context cost for each arm at a given catalogue size.
 *
 * Built-in tool costs are measured from the real registry; MCP costs from a
 * synthetic catalogue of the requested size. Both arms carry their built-ins
 * plus whatever share of the catalogue their residency level makes resident.
 *
 *   node bench/residency-report.mjs [toolCount]   # default 250 (MCP-Bench scale)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArm, countTokens, renderResidency } from "./arms.mjs";
import { generate } from "./generate.mjs";
import { synthetic } from "./test/fixtures/catalogue.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REAL = join(ROOT, "bench/data/mcp-schemas.json");

/**
 * Prefer the real MCP-Bench catalogue when it has been dumped; fall back to a
 * synthetic one of the requested size. Real descriptions are far longer and
 * more varied than synthetic ones, so the two are not interchangeable — the
 * synthetic path exists only so the report runs before setup.
 */
let catalogue;
let source;
let toolCount;
if (existsSync(REAL) && !process.argv.includes("--synthetic")) {
	catalogue = JSON.parse(readFileSync(REAL, "utf8")).catalogue;
	toolCount = catalogue.reduce((n, s) => n + s.tools.length, 0);
	source = `real MCP-Bench catalogue — ${catalogue.length} servers`;
} else {
	toolCount = Number(process.argv[2] ?? 250);
	catalogue = synthetic(toolCount);
	source = "synthetic catalogue";
}

const { toolDefs, tocLines, names } = generate(catalogue);
const mcp = {
	L0: 0,
	L1: countTokens(names.join("\n")),
	L2: countTokens(tocLines.join("\n")),
	L4: countTokens(JSON.stringify(toolDefs)),
};

const vanilla = await buildArm("vanilla");
const codemode = await buildArm("codemode");

/** Built-in tools are always resident at the arm's own level. */
const builtin = (built, level) => countTokens(renderResidency(built, level));

const configs = [
	{ config: "vanilla L4 (naive baseline)", arm: vanilla, builtinLevel: "L4", mcpLevel: "L4" },
	{ config: "vanilla L1 (deferred — Claude Code)", arm: vanilla, builtinLevel: "L1", mcpLevel: "L1" },
	{ config: "codemode L0 (pure discovery)", arm: codemode, builtinLevel: "L4", mcpLevel: "L0" },
	{ config: "codemode L1 (names resident)", arm: codemode, builtinLevel: "L4", mcpLevel: "L1" },
	{ config: "codemode L2 (TOC resident)", arm: codemode, builtinLevel: "L4", mcpLevel: "L2" },
];

const rows = configs.map(({ config, arm, builtinLevel, mcpLevel }) => {
	const b = builtin(arm, builtinLevel);
	const m = mcp[mcpLevel];
	return { config, builtin: b, mcp: m, resident: b + m };
});

const naive = rows[0].resident;
for (const r of rows) r["vs naive"] = `${(naive / r.resident).toFixed(1)}x`;

console.log(`\nResident tokens per request — ${toolCount} MCP tools\n(${source})\n`);
console.table(rows);

const deferred = rows[1].resident;
console.log(`Naive vanilla L4:        ${naive.toLocaleString()} tok`);
console.log(`Deferred vanilla L1:     ${deferred.toLocaleString()} tok  <- the honest baseline`);
console.log(`Codemode L2:             ${rows[4].resident.toLocaleString()} tok`);
console.log(
	`\nCodemode L2 vs deferred vanilla L1: ${(rows[4].resident / deferred).toFixed(2)}x ` +
		`${rows[4].resident > deferred ? "MORE" : "less"} expensive.\n`,
);
