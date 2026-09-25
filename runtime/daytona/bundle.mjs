/**
 * Build the kernel-server package that runs inside the sandbox, from the COMPILED
 * vendored prime (vendor/prime-agent/packages/coding-agent/dist):
 *
 *   <out>/package.json              prime's own (getPackageDir() walks up to it)
 *   <out>/dist/kernel-server.mjs    server-main.js bundled; zeromq stays external
 *   <out>/dist/skills/              the bundled Python skills
 *   <out>/dist/prime-agent-runtime/ the rlm runtime the kernel venv installs
 *   <out>/kernel-requirements.txt   the pinned analysis stack (bench/container), less appnope
 *   <out>/VERSION                   content hash of all of the above
 *
 * The version names the snapshot (harness-assistant-kernel-<version>), so a change
 * to anything that runs in the sandbox is a new snapshot, never a silently stale one.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const CODING_AGENT = join(ROOT, "vendor/prime-agent/packages/coding-agent");
const DIST = join(CODING_AGENT, "dist");
/** Pinned: the version the spike measured, with prebuilt linux-x64 binaries. */
export const ZEROMQ_VERSION = "6.5.0";

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "__pycache__" || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.isFile()) out.push(full);
	}
	return out.sort();
}

export function hashTree(dir) {
	const hash = createHash("sha256");
	for (const file of walk(dir)) {
		const rel = relative(dir, file);
		if (rel === "VERSION") continue;
		hash.update(rel);
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 12);
}

/** Build into `out` (default: a fresh temp dir); returns {dir, version}. */
export async function buildKernelServerBundle(out = join(tmpdir(), `harness-kernel-server-${process.pid}`)) {
	const entry = join(DIST, "core/kernel/remote/server-main.js");
	if (!existsSync(entry)) throw new Error(`${entry} missing — run: cd vendor/prime-agent/packages/coding-agent && npm run build`);
	const src = join(CODING_AGENT, "src/core/kernel/remote/server.ts");
	if (statSync(src).mtimeMs > statSync(join(DIST, "core/kernel/remote/server.js")).mtimeMs) {
		throw new Error("dist is older than src/core/kernel/remote — rebuild before bundling");
	}
	const { build } = await import(join(ROOT, "vendor/prime-agent/node_modules/esbuild/lib/main.js"));
	rmSync(out, { recursive: true, force: true });
	mkdirSync(join(out, "dist"), { recursive: true });
	await build({
		entryPoints: [entry],
		outfile: join(out, "dist/kernel-server.mjs"),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
		external: ["zeromq", "koffi", "bufferutil", "utf-8-validate"],
		banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
		define: { __PI_BUNDLED__: "true", __PI_BUILD_ID__: '"harness-kernel-server"' },
		logLevel: "warning",
	});
	const pkg = JSON.parse(readFileSync(join(CODING_AGENT, "package.json"), "utf8"));
	writeFileSync(
		join(out, "package.json"),
		`${JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", piConfig: pkg.piConfig, dependencies: { zeromq: ZEROMQ_VERSION } }, null, "\t")}\n`,
	);
	cpSync(join(DIST, "skills"), join(out, "dist/skills"), { recursive: true });
	cpSync(join(DIST, "prime-agent-runtime"), join(out, "dist/prime-agent-runtime"), { recursive: true });
	// Pinned analysis stack for the sandbox kernel; appnope is darwin-only.
	const reqs = readFileSync(join(ROOT, "bench/container/kernel-requirements.txt"), "utf8")
		.split("\n")
		.filter((l) => !/^appnope\b/.test(l))
		.join("\n");
	writeFileSync(join(out, "kernel-requirements.txt"), reqs);
	const version = hashTree(out);
	writeFileSync(join(out, "VERSION"), `${version}\n`);
	return { dir: out, version };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const { dir, version } = await buildKernelServerBundle(process.argv[2]);
	console.log(JSON.stringify({ dir, version }));
}
