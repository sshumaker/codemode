/**
 * Trim an IPython traceback to the exception and the lines that raised it.
 *
 * Measured on a real bridge error (the fixture in bench/test/fixtures/, captured
 * from the same IPython the kernel runs): **2,961 characters across 8 frames, with
 * the message last.** The bulk is not asyncio plumbing. IPython prints source
 * CONTEXT around each frame's failing line, and in the compiled API bridge the
 * lines above `return await _call(...)` are the function's entire docstring — so a
 * two-call chain re-printed two docstrings the model had already been given, then
 * `_client.py`'s docstring, then the payload literal, and only then said what was
 * wrong. On the product port GLM 5.2 hit this 12 times in 83 cells.
 *
 * ipykernel sends one array element per frame, so the trim is structural rather
 * than a regex over the whole blob:
 *
 *   - interpreter plumbing (asyncio, nest_asyncio, ipykernel, IPython) is dropped;
 *     the mistake is never there,
 *   - a frame that is only a call INTO the generated bridge is dropped. Detected
 *     from the marked line, not from a path: `await _call(...)`, `_validate(...)`
 *     and the bridge's own `raise` are the three, and the exception message names
 *     the API, the argument and the constraint already,
 *   - in every surviving frame the lines BEFORE the `--->` marker go and the
 *     marker line and everything after it stay. That keeps the location line, the
 *     offending line and the continuation lines carrying the arguments the model
 *     passed, and drops the echoed docstring,
 *   - the leading separator, the `ExcType Traceback (most recent call last)`
 *     header and the final `ExcType: message` are kept verbatim.
 *
 * On the fixture: 2,961 -> 931 characters, and what remains is the header, the
 * model's own two frames, and the message. Nothing that names code the model
 * wrote is dropped, so an ordinary Python bug in a cell is still diagnosable —
 * a plain `KeyError` matches none of these rules and only loses the source lines
 * above the one that raised.
 *
 * OFF unless HARNESS_TRACEBACK_TRIM=1, and off is byte-faithful to upstream — an
 * unflagged build renders exactly what every pre-trim run saw.
 *
 * The default is not timidity about the trim; it is about how a condition gets
 * selected. Before this gate the trim was chosen by REBUILDING dist, and a
 * rebuild in a checkout that a live eval was reading put the trim into two jobs
 * that had not asked for it (one kept — no error cells, so the trim could not
 * have mattered — one excluded). An env var lets ONE dist serve both arms of an
 * A/B, makes the condition explicit in the run recipe rather than implicit in a
 * build timestamp, and cannot leak into a run that did not name it.
 * See scripts/neutralize-prime.mjs.
 */
const TRACEBACK_PLUMBING =
	/(?:^|[/\\])(?:nest_asyncio\d*\.py|asyncio[/\\][^/\\]+\.py|ipykernel(?:_launcher)?[/\\]|IPython[/\\]core[/\\])/;

/** The marked line of a frame that is only a hop through the generated bridge. */
const BRIDGE_HOP = /^\s*-+>\s*\d*\s*(?:return )?(?:await _call\(|_validate\(server, tool|raise (?:ArgumentError|McpError|DocsFirst|ReadFirst)\()/;

export function trimCellTraceback(traceback: readonly string[]): string {
	const frames = traceback ?? [];
	// Read per call, not captured at module load: the kernel and the agent share a
	// process, and a value frozen at import would make the flag depend on when the
	// module was first required rather than on the run's own environment.
	if (process.env.HARNESS_TRACEBACK_TRIM !== "1" || frames.length < 3) return frames.join("\n");

	const kept: string[] = [];
	frames.forEach((frame, index) => {
		// The first two elements are the separator and the `ExcType Traceback ...`
		// header; the last is the message. All three are what the trim is FOR.
		if (index < 2 || index === frames.length - 1) {
			kept.push(frame);
			return;
		}
		if (TRACEBACK_PLUMBING.test(frame)) return;
		const lines = frame.split("\n");
		const marker = lines.findIndex((line) => /^\s*-+>\s/.test(line));
		if (marker < 0) {
			kept.push(frame);
			return;
		}
		if (BRIDGE_HOP.test(lines[marker])) return;
		// Line 0 is `File <path>:<n>, in <fn>(...)` or `Cell In[n], line n` — the
		// only context that says WHERE. Everything between it and the marker is
		// source the model either wrote itself one cell ago or cannot edit.
		kept.push(marker === 0 ? frame : [lines[0], ...lines.slice(marker)].join("\n"));
	});
	// A traceback trimmed to nothing but its own punctuation is worse than a long
	// one: if EVERY middle frame matched, the raise happened somewhere this
	// function does not model, so show what the kernel actually sent.
	return kept.length >= 4 ? kept.join("\n") : frames.join("\n");
}
