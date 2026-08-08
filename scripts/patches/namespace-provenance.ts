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
 */
interface Provenance {
	rhs: string;
	turn: number;
	line: number;
}

const assignedAt = new Map<string, Provenance>();
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
		// Top-level bindings only: no leading indentation, single or tuple target.
		const m = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=(?!=)/.exec(lines[i]);
		if (!m) continue;
		const rhs = lines[i].slice(lines[i].indexOf("=") + 1).trim().slice(0, 72) || "…";
		for (const name of m[1].split(",").map((n) => n.trim())) {
			assignedAt.set(name, { rhs, turn: cellTurn, line: i + 1 });
		}
	}
}
