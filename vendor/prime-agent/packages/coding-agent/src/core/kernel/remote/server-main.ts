/**
 * Entry point of the kernel-server bundle that runs inside the sandbox
 * (runtime/daytona/bundle.mjs builds it; provider.mjs launches it).
 *
 *   node kernel-server.mjs            serve (KERNEL_SERVER_* env, see server.ts)
 *   node kernel-server.mjs --prebake  build the kernel venv with the bundled Python
 *                                     skills at their content-addressed paths, boot
 *                                     one kernel to warm it, and exit. Run while the
 *                                     sandbox (or the image build) still has network.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "../../../config.js";
import { ensureTool } from "../../../utils/tools-manager.js";
import { ensureKernelPython, type KernelPythonSkill } from "../bootstrap.js";
import { KernelManager } from "../index.js";
import { CHILD_ENV_ALLOW, KernelServer, kernelServerConfigFromEnv } from "./server.js";
import { hashSkillPackage } from "./skills.js";

const config = kernelServerConfigFromEnv();
// The token authenticates the loop; nothing the kernel spawns may inherit it.
delete process.env.KERNEL_SERVER_TOKEN;
// The sandbox is the boundary. KernelManager's own fail-closed check is satisfied
// here because the server refuses every `start` while its egress probe can reach
// the internet (server.ts startKernel), which is the stronger condition.
process.env.HARNESS_KERNEL_SANDBOX = "off";
// Kernel environments are BUILT from this list plus what the start request carries.
process.env.HARNESS_KERNEL_ENV_ALLOW = CHILD_ENV_ALLOW.join(",");

/** The bundled Python skills, copied to where a loop's upload of the same files would land. */
function placeBundledSkills(): KernelPythonSkill[] {
	const root = join(getPackageDir(), "dist", "skills");
	if (!existsSync(root)) return [];
	const skills: KernelPythonSkill[] = [];
	for (const name of readdirSync(root).sort()) {
		const source = join(root, name);
		if (!existsSync(join(source, "pyproject.toml"))) continue;
		const hash = hashSkillPackage(source);
		const dir = join(config.skillsDir, hash);
		if (!existsSync(join(dir, ".complete"))) {
			mkdirSync(dir, { recursive: true });
			cpSync(source, join(dir, name), { recursive: true });
			writeFileSync(join(dir, ".complete"), "");
		}
		const packagePath = join(dir, name);
		skills.push({
			name,
			importName: name.replaceAll("-", "_"),
			packagePath,
			pyprojectPath: join(packagePath, "pyproject.toml"),
		});
	}
	return skills;
}

async function prebake(): Promise<void> {
	// The venv is current only for the exact skill set a kernel starts with. A loop run with
	// `--no-skills` starts kernels with none, and a read-only shared venv (one server per
	// conversation on a user's computer) cannot be re-bootstrapped to match, so the
	// installer says which set its loops use.
	const pythonSkills = process.env.KERNEL_SERVER_PREBAKE_SKILLS === "none" ? [] : placeBundledSkills();
	const log = (line: string) => process.stdout.write(`[prebake] ${line}\n`);
	log(`skills: ${pythonSkills.map((s) => s.name).join(", ") || "(none)"}`);
	const python = await ensureKernelPython({ pythonSkills, onProgress: log });
	// The file tools' helpers, fetched now: after the lock there is no network to fetch them.
	for (const tool of ["rg", "fd"] as const) log(`${tool}: ${(await ensureTool(tool, true)) ?? "UNAVAILABLE"}`);
	log(`kernel python ${python}`);
	// The analysis stack a product kernel carries (bench/container/kernel-requirements.txt,
	// the host venv's pins) plus matplotlib, as the gateway's local kernel has.
	const requirements = join(getPackageDir(), "kernel-requirements.txt");
	if (existsSync(requirements)) {
		const r = spawnSync("uv", ["pip", "install", "--python", python, "-r", requirements, "matplotlib"], {
			stdio: ["ignore", "inherit", "inherit"],
		});
		log(`analysis stack: ${r.status === 0 ? "installed" : `FAILED (exit ${r.status})`}`);
	}
	mkdirSync(config.defaultCwd, { recursive: true });
	const kernel = new KernelManager({ cwd: config.defaultCwd, pythonSkills });
	await kernel.start({ onBootstrapProgress: log });
	const warm = await kernel.execute("import pandas, numpy, PIL, dill, matplotlib.pyplot\nprint('warm')");
	log(`warm cell: ${warm.status} ${warm.stdout.trim()}`);
	await kernel.dispose();
}

if (process.argv.includes("--prebake")) {
	await prebake();
	process.exit(0);
}

const server = new KernelServer(config);
await server.listen();
process.stdout.write(`kernel-server listening on ${server.port}\n`);

const stop = () => {
	// Kernels get a bounded chance to flush their snapshots; the exit is not held past it.
	setTimeout(() => process.exit(0), 8000).unref();
	void server.close().finally(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
