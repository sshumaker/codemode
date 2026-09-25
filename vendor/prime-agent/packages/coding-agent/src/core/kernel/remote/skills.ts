/**
 * Python skill packages, carried to the sandbox by content.
 *
 * The loop resolves each skill to a package directory on its own disk; the kernel
 * installs it (editable) into the sandbox's venv. A skill is identified by a hash of
 * its files, uploaded once as a tarball to `<stateDir>/skills/<hash>/<name>`, and the
 * paths in the start request are rewritten to that copy. Content addressing makes the
 * path deterministic, which is what lets a prebuilt snapshot bake the venv install for
 * the bundled skills: the same files hash to the same directory there and here, so
 * the bootstrap sees an install that is already current and touches nothing (and so
 * needs no network).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { KernelPythonSkill } from "../bootstrap.js";

const SKIP = new Set(["__pycache__", ".venv", "node_modules", ".git", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);

function listFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (SKIP.has(entry.name) || entry.name.endsWith(".egg-info")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) out.push(full);
		}
	};
	walk(root);
	return out.sort();
}

/** Content hash of a skill package directory: relative paths and bytes, junk excluded. */
export function hashSkillPackage(packagePath: string): string {
	const hash = createHash("sha256");
	for (const file of listFiles(packagePath)) {
		hash.update(relative(packagePath, file));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 32);
}

/** A gzipped tar of the package directory, with the directory itself as the single top entry. */
export function tarSkillPackage(packagePath: string): Buffer {
	const files = listFiles(packagePath).map((f) => join(basename(packagePath), relative(packagePath, f)));
	const r = spawnSync("tar", ["-czf", "-", "-C", dirname(packagePath), ...files], {
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, COPYFILE_DISABLE: "1" },
	});
	if (r.status !== 0) throw new Error(`tar of ${packagePath} failed: ${r.stderr.toString().trim()}`);
	return r.stdout;
}

export interface SkillPlacement {
	skill: KernelPythonSkill;
	hash: string;
	name: string;
}

export function placeSkills(skills: readonly KernelPythonSkill[] | undefined): SkillPlacement[] {
	return (skills ?? []).map((skill) => ({
		skill,
		hash: hashSkillPackage(skill.packagePath),
		name: basename(skill.packagePath),
	}));
}

/** The skill as the sandbox sees it, once its package is under `skillsDir`. */
export function remoteSkill(placement: SkillPlacement, skillsDir: string): KernelPythonSkill {
	const root = join(skillsDir, placement.hash, placement.name);
	const pyprojectRel = relative(placement.skill.packagePath, placement.skill.pyprojectPath);
	return { ...placement.skill, packagePath: root, pyprojectPath: join(root, pyprojectRel) };
}

export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
