/**
 * Translation between the loop's paths and the sandbox's.
 *
 * The file tools resolve model-chosen paths against the loop's cwd, so what they
 * hold is a loop-side absolute path; the bytes are in the sandbox. Each mapping is a
 * prefix pair; the longest matching prefix wins, and a path outside every mapping
 * passes through unchanged (it names something in the sandbox's own world: /tmp,
 * the venv). The reverse direction rewrites what rg/fd print back into loop paths,
 * so the tools' own relativising against their (loop-side) search root still works.
 */
import type { PathMapping } from "./protocol.js";

function under(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function normalize(p: string): string {
	return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

export class RemotePathMap {
	private readonly mappings: PathMapping[];

	constructor(mappings: readonly PathMapping[]) {
		this.mappings = mappings
			.filter((m) => m.local && m.remote)
			.map((m) => ({ local: normalize(m.local), remote: normalize(m.remote) }));
	}

	get entries(): readonly PathMapping[] {
		return this.mappings;
	}

	private translate(path: string, from: "local" | "remote", to: "local" | "remote"): string {
		let best: PathMapping | undefined;
		for (const m of this.mappings) {
			if (under(path, m[from]) && (!best || m[from].length > best[from].length)) best = m;
		}
		return best ? best[to] + path.slice(best[from].length) : path;
	}

	toRemote(path: string): string {
		return this.translate(path, "local", "remote");
	}

	toLocal(path: string): string {
		return this.translate(path, "remote", "local");
	}

	/** An argv with every absolute loop path rewritten; flags and patterns are left alone. */
	argsToRemote(args: readonly string[]): string[] {
		return args.map((a) => (a.startsWith("/") ? this.toRemote(a) : a));
	}

	/** One line of rg/fd output with sandbox paths rewritten to loop paths. */
	lineToLocal(line: string): string {
		let out = line;
		const byLength = [...this.mappings].sort((a, b) => b.remote.length - a.remote.length);
		for (const m of byLength) {
			if (m.remote === m.local) continue;
			out = out.split(`${m.remote}/`).join(`${m.local}/`);
			if (out.endsWith(m.remote)) out = out.slice(0, -m.remote.length) + m.local;
		}
		return out;
	}
}
