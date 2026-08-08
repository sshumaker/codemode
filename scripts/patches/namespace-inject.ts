// See scripts/neutralize-prime.mjs — opt-in kernel state visibility.
//
// The largest score gap is redundancy: 29% of MCP calls are byte-identical
// repeats, because the model cannot see what it already fetched. Telling it to
// run `%whos` costs a turn and relies on it remembering to look; appending the
// live namespace to every cell result costs a few tokens and no turn.
//
// Each name carries the expression that produced it and a reference into the
// cell transcript, so the listing reads as an index of work already done.
if (process.env.HARNESS_SHOW_NAMESPACE === "1") {
	try {
		recordAssignments(code, cwd);
		const names = await provisioner.listNamespaceNames(signal);
		if (names && names.length > 0) {
			const shown = names.map((n) => {
				const p = assignedAt.get(n);
				return p ? `${n}  # = ${p.rhs}, turn-${p.turn}.py:${p.line}` : n;
			});
			text += `${text ? "\n\n" : ""}[kernel — already available, do not re-fetch (cells in .cells/):\n  ${shown.join("\n  ")}\n]`;
		}
	} catch {
		// Namespace listing is a convenience; never fail a cell over it.
	}
}
