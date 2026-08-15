/**
 * The one way to load an MCP catalogue from disk.
 *
 * The read+filter+generate sequence was copy-pasted into six files, and
 * bench/run-task.mjs re-ran it FIVE times per run (five parses of a 500KB
 * JSON file plus five full generate() renders of the same tree per task) —
 * review P3 #10. One loader, one memoized generate per (path, servers,
 * options) — bench/appworld/run-task.mjs already had the right shape (one
 * read, one generate, destructure everything); this gives the MCP-Bench
 * runner and the one-off tools the same shape.
 */
import { readFileSync } from "node:fs";
import { generate } from "./generate.mjs";

const parsed = new Map(); // path -> catalogue array
const generated = new Map(); // cache key -> generate() result

/** The catalogue array, optionally filtered to `servers`. Parsed once per path. */
export function loadCatalogue(path, { servers = null } = {}) {
	if (!parsed.has(path)) {
		parsed.set(path, JSON.parse(readFileSync(path, "utf8")).catalogue);
	}
	const all = parsed.get(path);
	if (!servers) return all;
	const wanted = new Set(servers);
	return all.filter((s) => wanted.has(s.server));
}

/**
 * loadCatalogue + generate, memoized. Options are part of the key: two
 * variants of one tree must never share a cache entry — that is the runId
 * collision class this repo keeps rediscovering, applied to memory.
 */
export function loadGenerated(path, { servers = null, ...options } = {}) {
	const key = JSON.stringify([path, servers ? [...servers].sort() : null, options]);
	if (!generated.has(key)) {
		generated.set(key, generate(loadCatalogue(path, { servers }), options));
	}
	return generated.get(key);
}
