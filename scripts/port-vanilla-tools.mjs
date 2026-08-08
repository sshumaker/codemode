#!/usr/bin/env node
/**
 * Port the five tools prime-agent dropped (read, write, grep, find, ls) from
 * pi-mono into prime-agent, so the `vanilla` arm resolves.
 *
 * prime-agent is pi-mono with the tool registry replaced by a single `ipython`
 * tool. `bash` and `edit` survive in prime's tree unregistered; these five were
 * removed outright. We take pi's implementations verbatim — the vanilla arm has
 * to be a credible tool-calling baseline, and pi's truncation, encoding, and
 * output-shaping behaviour is what makes it one. Rewriting them by hand would
 * risk a strawman.
 *
 * Wiring: agent-session.ts:_buildRuntime calls createAllToolDefinitions(), which
 * is the sole construction point for built-in tools. Extending that function and
 * the ToolName union is enough — the existing activeToolNames/allowedToolNames
 * filtering then selects the arm.
 *
 * Idempotent: safe to re-run after bumping either vendored upstream.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PI = join(ROOT, "vendor/pi-mono/packages/coding-agent/src");
const PRIME = join(ROOT, "vendor/prime-agent/packages/coding-agent/src");

/** The five prime removed. */
const PORTED = ["read", "write", "grep", "find", "ls"];
/** Everything the vanilla arm exposes. bash and edit already exist in prime. */
const VANILLA = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** Every built-in the registry must be able to construct. */
const ALL = [...VANILLA, "ipython"];

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const log = (...a) => console.log(...a);

/** pi uses .ts specifiers, prime emits .js. */
const rewriteSpecifiers = (src) => src.replace(/(from\s+")([^"]+)\.ts(")/g, "$1$2.js$3");

function copy(relPath) {
	const from = join(PI, relPath);
	if (!existsSync(from)) throw new Error(`missing in pi-mono: ${relPath}`);
	writeFileSync(join(PRIME, relPath), rewriteSpecifiers(readFileSync(from, "utf8")));
	log(`  copied  ${relPath}`);
}

/** Append `addition` unless `marker` is already present. */
function ensure(relPath, marker, addition) {
	const path = join(PRIME, relPath);
	const src = readFileSync(path, "utf8");
	if (src.includes(marker)) return log(`  present ${relPath} :: ${marker}`);
	writeFileSync(path, `${src.trimEnd()}\n${addition}`);
	log(`  patched ${relPath} :: ${marker}`);
}

/** Lift a top-level function (and its body) out of a pi source file. */
function extractFromPi(relPath, signature) {
	const src = readFileSync(join(PI, relPath), "utf8");
	const start = src.indexOf(signature);
	if (start < 0) throw new Error(`${relPath}: no such declaration: ${signature}`);
	// Scan to the matching close brace of the function body.
	let depth = 0;
	let i = src.indexOf("{", start);
	for (let j = i; j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}" && --depth === 0) return `\n${rewriteSpecifiers(src.slice(start, j + 1))}\n`;
	}
	throw new Error(`${relPath}: unbalanced braces after ${signature}`);
}

/** Replace `find` with `replace`, asserting the match is unique. */
function sub(relPath, find, replace, label) {
	const path = join(PRIME, relPath);
	const src = readFileSync(path, "utf8");
	if (src.includes(replace)) return log(`  present ${relPath} :: ${label}`);
	const count = src.split(find).length - 1;
	if (count !== 1) throw new Error(`${relPath}: expected 1 match for ${label}, found ${count}`);
	writeFileSync(path, src.replace(find, replace));
	log(`  patched ${relPath} :: ${label}`);
}

log("porting vanilla tools: pi-mono -> prime-agent\n");

// 1. read.ts pulls in image handling. prime kept image-convert and image-resize
//    but changed both signatures, and its versions are used by interactive-mode
//    and file-processor — so adapt the wrapper to prime's APIs rather than
//    overwriting shared utils.
log("dependencies:");
copy("utils/image-process.ts");

sub(
	"utils/image-process.ts",
	`import { convertImageBytesToPng } from "./image-convert.js";`,
	`import { convertToPng } from "./image-convert.js";

/** pi passes raw bytes; prime's convertToPng works in base64. */
async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const converted = await convertToPng(Buffer.from(bytes).toString("base64"), "application/octet-stream");
	if (!converted) return null;
	return new Uint8Array(Buffer.from(converted.data, "base64"));
}`,
	"convertToPng adapter",
);

sub(
	"utils/image-process.ts",
	`const resized = await resizeImage(normalized.bytes, normalized.mimeType, options?.resizeOptions);`,
	`const resized = await resizeImage(
			{ type: "image", data: Buffer.from(normalized.bytes).toString("base64"), mimeType: normalized.mimeType },
			options?.resizeOptions,
		);`,
	"resizeImage adapter",
);

// 2. read.ts needs resolveReadPathAsync (fuzzy path resolution), which prime
//    dropped along with the read tool.
ensure(
	"core/tools/path-utils.ts",
	"export async function resolveReadPathAsync",
	extractFromPi("core/tools/path-utils.ts", "export async function resolveReadPathAsync"),
);

// 2. find.ts and ls.ts need pathExists, which prime's path-utils dropped.
//    prime imports accessSync (sync) rather than pi's fs/promises access.
ensure(
	"core/tools/path-utils.ts",
	"export async function pathExists",
	`
export async function pathExists(filePath: string): Promise<boolean> {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}
`,
);

// 3. write.ts and ls.ts need renderToolPath. pi's version wraps the path in an
//    OSC-8 hyperlink via pi-tui's `hyperlink`, which prime's fork no longer
//    exports. Rendering is TUI-only and unused under --print, so drop the
//    hyperlink and keep the styling.
ensure(
	"core/tools/render-utils.ts",
	"export function renderToolPath",
	`
export function renderToolPath(
	rawPath: string | null,
	theme: { fg: (name: any, text: string) => string },
	_cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return theme.fg("accent", shortenPath(value));
}
`,
);

// 4. The tools themselves.
log("\ntools:");
for (const t of PORTED) copy(`core/tools/${t}.ts`);

// 5. Registry: widen ToolName, ToolsOptions, and the three factories.
log("\nregistry:");

const importLines = [
	...PORTED.map((t) => `import { create${cap(t)}Tool, create${cap(t)}ToolDefinition, type ${cap(t)}ToolOptions } from "./${t}.js";`),
	`import { createBashTool, createBashToolDefinition, type BashToolOptions } from "./bash.js";`,
	`import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.js";`,
].join("\n");

sub(
	"core/tools/index.ts",
	`import { createIpythonTool, createIpythonToolDefinition, type IpythonToolOptions } from "./ipython.js";`,
	`import { createIpythonTool, createIpythonToolDefinition, type IpythonToolOptions } from "./ipython.js";\n${importLines}`,
	"tool imports",
);

sub(
	"core/tools/index.ts",
	`export type ToolName = "ipython";\nexport const allToolNames: Set<ToolName> = new Set(["ipython"]);`,
	`export type ToolName = ${ALL.map((t) => `"${t}"`).join(" | ")};\n` +
		`export const allToolNames: Set<ToolName> = new Set([${ALL.map((t) => `"${t}"`).join(", ")}]);\n` +
		`/** Tools exposed by the \`vanilla\` arm. See docs/DESIGN.md. */\n` +
		`export const vanillaToolNames: readonly ToolName[] = [${VANILLA.map((t) => `"${t}"`).join(", ")}];`,
	"ToolName union",
);

sub(
	"core/tools/index.ts",
	`export interface ToolsOptions {\n\tipython?: IpythonToolOptions;\n}`,
	`export interface ToolsOptions {\n${ALL.map((t) => `\t${t}?: ${cap(t)}ToolOptions;`).join("\n")}\n}`,
	"ToolsOptions",
);

const casesFor = (suffix) =>
	ALL.map((t) => `\t\tcase "${t}":\n\t\t\treturn create${cap(t)}${suffix}(cwd, options?.${t});`).join("\n");

sub(
	"core/tools/index.ts",
	`\t\tcase "ipython":\n\t\t\treturn createIpythonToolDefinition(cwd, options?.ipython);`,
	casesFor("ToolDefinition"),
	"createToolDefinition cases",
);

sub(
	"core/tools/index.ts",
	`\t\tcase "ipython":\n\t\t\treturn createIpythonTool(cwd, options?.ipython);`,
	casesFor("Tool"),
	"createTool cases",
);

sub(
	"core/tools/index.ts",
	`\t\tipython: createIpythonToolDefinition(cwd, options?.ipython),`,
	ALL.map((t) => `\t\t${t}: create${cap(t)}ToolDefinition(cwd, options?.${t}),`).join("\n"),
	"createAllToolDefinitions",
);

sub(
	"core/tools/index.ts",
	`\t\tipython: createIpythonTool(cwd, options?.ipython),`,
	ALL.map((t) => `\t\t${t}: create${cap(t)}Tool(cwd, options?.${t}),`).join("\n"),
	"createAllTools",
);

// 6. CLI validation: prime hardcodes a rejection list for the five it removed.
log("\ncli:");
sub(
	"cli/args.ts",
	`const REMOVED_BUILTIN_TOOL_NAMES = new Set(["read", "write", "grep", "find", "ls"]);\nconst BUILTIN_TOOL_NAMES = ["ipython"];`,
	`const REMOVED_BUILTIN_TOOL_NAMES = new Set<string>([]);\nconst BUILTIN_TOOL_NAMES = [${ALL.map((t) => `"${t}"`).join(", ")}];`,
	"built-in tool allowlist",
);

log("\ndone.");
