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
				if (name) nonData.add(name);
			}
			continue;
		}

		// Loop targets and context managers: `for x in …`, `with … as f:`
		const loop = /^\s*(?:async\s+)?for\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\s/.exec(line);
		if (loop) {
			for (const n of loop[1].split(",")) nonData.add(n.trim());
			continue;
		}
		for (const m of line.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) nonData.add(m[1]);

		// Top-level bindings only: no leading indentation, single or tuple target.
		const m = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=(?!=)/.exec(line);
		if (!m) continue;
		const rhs = line.slice(line.indexOf("=") + 1).trim().slice(0, 72) || "…";
		for (const name of m[1].split(",").map((n) => n.trim())) {
			assignedAt.set(name, { rhs, turn: cellTurn, line: i + 1 });
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
