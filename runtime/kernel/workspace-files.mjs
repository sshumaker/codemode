/**
 * A conversation's workspace files (`inputs/`, `outputs/`), wherever the kernel sees
 * them: on this machine's disk (the local backend, and the host's own copy), or inside a
 * sandbox through its provider's file API (Daytona, a device).
 *
 * Not responsible for: deciding which files a tool call may name or carry (a host's
 * tool proxy does that, and calls these to read and write).
 */
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, sep } from "node:path";

export class WorkspaceFileError extends Error {}

const mb = (n) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${Math.ceil(n / (1024 * 1024))} MB`);

function isInside(root, p) {
	return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Workspace files on this machine's disk: the resolved path, symlinks followed, must
 * stay inside `workDir/<inputs|outputs>`.
 */
export class HostWorkspaceFiles {
	constructor(workDir) {
		this.workDir = workDir;
	}

	resolveInside(rel) {
		const top = rel.split("/")[0] ?? "";
		const rootDir = join(this.workDir, top);
		mkdirSync(rootDir, { recursive: true });
		return { full: join(this.workDir, rel), root: realpathSync(rootDir) };
	}

	async readFile(rel, maxBytes) {
		const { full, root } = this.resolveInside(rel);
		let real;
		try {
			real = realpathSync(full);
		} catch {
			throw new WorkspaceFileError(`no file at ${rel}`);
		}
		if (!isInside(root, real)) throw new WorkspaceFileError(`${rel} points outside the workspace`);
		const st = statSync(real);
		if (!st.isFile()) throw new WorkspaceFileError(`${rel} is not a file`);
		if (st.size > maxBytes) throw new WorkspaceFileError(`${rel} is ${mb(st.size)}; the cap is ${mb(maxBytes)}`);
		return readFile(real);
	}

	async writeFile(rel, data) {
		const { full, root } = this.resolveInside(rel);
		mkdirSync(dirname(full), { recursive: true });
		if (!isInside(root, realpathSync(dirname(full)))) throw new WorkspaceFileError(`${rel} points outside the workspace`);
		try {
			if (lstatSync(full).isSymbolicLink()) throw new WorkspaceFileError(`${rel} is a symbolic link; not overwriting it`);
		} catch (err) {
			if (err instanceof WorkspaceFileError) throw err;
		}
		await writeFile(full, data);
	}
}

/**
 * Workspace files inside a sandbox. The size comes from a listing first, so an
 * oversized file is refused without downloading it; the listing (`find -type f`) also
 * leaves out symlinks, so a link cannot stand in for a file outside the workspace.
 */
export class SandboxWorkspaceFiles {
	constructor(provider, conversationId, ready = Promise.resolve()) {
		this.provider = provider;
		this.conversationId = conversationId;
		this.ready = ready;
	}

	async readFile(rel, maxBytes) {
		await this.ready;
		const listing = await this.provider.listTree(this.conversationId, posix.dirname(rel));
		const entry = listing.find((f) => f.path === rel);
		if (!entry) throw new WorkspaceFileError(`no file at ${rel}`);
		if (entry.size > maxBytes) throw new WorkspaceFileError(`${rel} is ${mb(entry.size)}; the cap is ${mb(maxBytes)}`);
		const data = await this.provider.readFile(this.conversationId, rel);
		if (data.length > maxBytes) throw new WorkspaceFileError(`${rel} is ${mb(data.length)}; the cap is ${mb(maxBytes)}`);
		return data;
	}

	async writeFile(rel, data) {
		await this.ready;
		await this.provider.uploadFile(this.conversationId, rel, data);
	}
}
