/**
 * Provenance for top-level bindings, and the cell transcript they refer to.
 *
 * Injected into ipython.ts by scripts/neutralize-prime.mjs. Kept as real
 * TypeScript because embedding it as an escaped string mangled every backslash.
 *
 * Each executed cell is written to `.cells/turn-N.py` under the working
 * directory, and every binding records the right-hand side that produced it plus
 * a `turn-N.py:LINE` reference. The model can therefore see not just which names
 * exist but what they hold and where they came from — and can `cat` the cell if
 * it needs the surrounding code.
 *
 * The right-hand side is more useful than a type name: `await api.reddit.hot(...)`
 * says both what the value is and that it came from a call already made, which is
 * the thing that stops it being fetched twice.
 *
 * Imports and loop/with targets are tracked so they can be excluded: `json`, `f`
 * and `target` are noise, and the listing exists to remind the model what *data*
 * it is already holding.
 */
interface Provenance {
	rhs: string;
	turn: number;
	line: number;
}

const assignedAt = new Map<string, Provenance>();
/** Names bound by import, `for` or `with` — excluded from the listing. */
const nonData = new Set<string>();
/** What has already been shown to the model, for delta mode. */
const shownNames = new Map<string, string>();
let cellTurn = 0;
/** Each of the maps above keeps at most this many names, newest first to survive. */
const MAX_PROVENANCE_NAMES = 2000;
/** Listing rows shown after a cell; the rest are counted, not listed. */
const NAMESPACE_ROWS = 50;

function remember<T>(map: Map<string, T>, key: string, value: T): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > MAX_PROVENANCE_NAMES) map.delete(map.keys().next().value as string);
}

function markNonData(name: string): void {
	nonData.delete(name);
	nonData.add(name);
	while (nonData.size > MAX_PROVENANCE_NAMES) nonData.delete(nonData.values().next().value as string);
}

function capRows(rows: string[]): string[] {
	if (rows.length <= NAMESPACE_ROWS) return rows;
	return [...rows.slice(0, NAMESPACE_ROWS), `... and ${rows.length - NAMESPACE_ROWS} more (%whos lists everything)`];
}

function recordAssignments(code: string, cwd: string): void {
	cellTurn += 1;

	// Persist the cell so the `turn-N.py:LINE` references resolve to a real file.
	try {
		const dir = pathJoin(cwd, ".cells");
		mkdirSync(dir, { recursive: true });
		writeFileSync(pathJoin(dir, `turn-${cellTurn}.py`), code);
	} catch {
		// Transcript is a convenience; never fail a cell over it.
	}

	const lines = code.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// `import x`, `import x as y`, `from m import a, b as c`
		const imp = /^\s*(?:from\s+[\w.]+\s+)?import\s+(.+)$/.exec(line);
		if (imp) {
			for (const part of imp[1].split(",")) {
				const alias = /\s+as\s+([A-Za-z_]\w*)\s*$/.exec(part);
				const name = alias ? alias[1] : part.trim().split(".")[0].trim();
				if (name) markNonData(name);
			}
			continue;
		}

		// Loop targets and context managers: `for x in …`, `with … as f:`
		const loop = /^\s*(?:async\s+)?for\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\s/.exec(line);
		if (loop) {
			for (const n of loop[1].split(",")) markNonData(n.trim());
			continue;
		}
		for (const m of line.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) markNonData(m[1]);

		// Comprehension and lambda locals leak into the listing as bare names with
		// no provenance, and they are never data the model needs reminding of.
		for (const m of line.matchAll(/\bfor\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\b/g)) {
			for (const n of m[1].split(",")) markNonData(n.trim());
		}
		for (const m of line.matchAll(/\blambda\s+([^:]+):/g)) {
			for (const n of m[1].split(",")) {
				const bare = n.trim().split("=")[0].trim();
				if (/^[A-Za-z_]\w*$/.test(bare)) markNonData(bare);
			}
		}
		// Walrus targets are intermediates, not results: `if (m := re.search(…))`.
		for (const m of line.matchAll(/([A-Za-z_]\w*)\s*:=/g)) markNonData(m[1]);
		// Function and class definitions.
		const def = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(line);
		if (def) markNonData(def[1]);

		// Rebound where this cannot follow it — augmented assignment, or assignment
		// inside a block — the name no longer holds what its recorded line says.
		const aug = /^\s*([A-Za-z_]\w*)\s*(?:\*\*|\/\/|>>|<<|[-+*/%@&|^])=/.exec(line);
		if (aug) assignedAt.delete(aug[1]);
		const nested = /^\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=(?!=)/.exec(line);
		if (nested) for (const name of nested[1].split(",")) assignedAt.delete(name.trim());

		// Top-level bindings only: no leading indentation, single or tuple target.
		const m = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=(?!=)/.exec(line);
		if (!m) continue;
		const rhs = line.slice(line.indexOf("=") + 1).trim().slice(0, 72) || "…";
		for (const name of m[1].split(",").map((n) => n.trim())) {
			remember(assignedAt, name, { rhs, turn: cellTurn, line: i + 1 });
			nonData.delete(name);
		}
	}
}

/**
 * Render the listing, collapsing tuple unpacking.
 *
 * `a, b, c = await gather(...)` binds three names from one expression; repeating
 * that expression once per name was accurate and unreadable. Names sharing a
 * provenance are grouped onto a single line.
 */
function describeNamespace(names: string[]): string[] {
	const groups = new Map<string, { names: string[]; p: Provenance | undefined }>();
	for (const n of names) {
		if (nonData.has(n)) continue;
		const p = assignedAt.get(n);
		const key = p ? `${p.turn}:${p.line}:${p.rhs}` : `bare:${n}`;
		if (!groups.has(key)) groups.set(key, { names: [], p });
		groups.get(key)!.names.push(n);
	}
	return [...groups.values()].map(({ names: ns, p }) =>
		p ? `${ns.join(", ")}  # = ${p.rhs}, turn-${p.turn}.py:${p.line}` : ns.join(", "),
	);
}
