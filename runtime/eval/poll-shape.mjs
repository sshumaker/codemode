/**
 * Did the agent check before it waited, or just burn a turn?
 *
 * The degeneracy this exists to detect is the one the broken kernel produced on
 * `pm-schedule-meeting-2`: 87 consecutive turns whose cells were literally `print(38)`.
 * The agent had no way to say "wake me later", so it used the model's own turn boundary
 * as a clock. The correct shape is one cell that checks a job and, only if it is
 * unfinished, ends with `jobs.wait` — so a wait cell with no check is a bare pause, and
 * a cell that computes nothing at all is the old degeneracy.
 *
 * Its own module because it is a detector, and detectors here have a bad record. Three
 * versions of this file's checks were wrong in the same direction — grading the shape
 * of the agent's Python instead of what it did — and each produced a confident verdict
 * rather than an error:
 *
 *   - counting `jobs.submit(` in the source failed a run that submitted four jobs from
 *     a `for` loop, which is one occurrence and the better code;
 *   - counting cells the agent *attempted* passed a run whose eleven cells all threw;
 *   - a "short cell starting with print(" rule flagged
 *     `print(repr(open('release.txt').read()))`, which reads the answer.
 *
 * So the trivial-cell rule below is deliberately narrow: the body must consist of
 * literals and operators and nothing else. A false positive here condemns a run that
 * did nothing wrong, which is worse than missing one, because the missed one shows up
 * as an obviously silly transcript and the false one shows up as a number.
 */

/**
 * Cells that compute nothing: `print(38)`, `print("ping")`, `1+1`, `pass`.
 *
 * Anything naming a function, attribute or variable is excluded — `print(f(x))` is
 * doing work even when it is short.
 */
const TRIVIAL = [
	/^pass$/,
	// A bare expression over numeric literals only.
	/^[\d\s+\-*/%().]+$/,
	// print() of a single string or numeric literal.
	/^print\s*\(\s*(?:'[^']*'|"[^"]*"|[\d\s+\-*/%().]+)\s*,?\s*\)$/,
];

export function isTrivialCell(source) {
	const body = source.trim();
	if (!body || body.includes("\n")) return false;
	if (/jobs\./.test(body)) return false;
	return TRIVIAL.some((re) => re.test(body));
}

const hasCheck = (c) => /jobs\.(get|list|manifest)\(/.test(c);

/**
 * @param {string[]} sources every cell the agent ran, in order
 * @returns counts plus the offending sources — a ratio alone cannot be audited, and
 *   every check in this project that recorded a verdict without its evidence eventually
 *   produced a confident wrong answer.
 */
export function pollShape(sources) {
	const waitCells = sources.filter((c) => /jobs\.wait\(/.test(c));
	const bare = waitCells.filter((c) => !hasCheck(c) && !/jobs\.submit\(/.test(c));
	const trivial = sources.filter(isTrivialCell);
	return {
		waitCells: waitCells.length,
		bareWaitCells: bare.length,
		trivialPollCells: trivial.length,
		trivialPollSources: trivial.slice(0, 8),
	};
}
