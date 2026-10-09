// See scripts/neutralize-prime.mjs — opt-in kernel state visibility.
//
// The largest score gap is redundancy: 29% of MCP calls are byte-identical
// repeats, because the model cannot see what it already fetched. Telling it to
// run `%whos` costs a turn and relies on it remembering to look; appending the
// namespace to every cell result costs a few tokens and no turn.
//
//   HARNESS_SHOW_NAMESPACE=1      full namespace after every cell
//   HARNESS_SHOW_NAMESPACE=delta  only bindings that are new or changed
//
// Measured: full beats delta (0.702 vs 0.679) *and* uses fewer total tokens,
// because the repetition is what keeps the model from re-fetching, and each
// avoided call saves more context than the listing costs. Delta remains useful
// if a namespace ever grows large enough for the listing itself to dominate.
const nsMode = process.env.HARNESS_SHOW_NAMESPACE;
if (nsMode === "1" || nsMode === "delta") {
	try {
		recordAssignments(code, cwd);
		const names = await provisioner.listNamespaceNames(signal);
		if (names && names.length > 0) {
			const lines = describeNamespace(names);
			if (nsMode === "delta") {
				const fresh = lines.filter((l) => !shownNames.has(l));
				for (const l of lines) remember(shownNames, l, l);
				if (fresh.length > 0) {
					text += `${text ? "\n\n" : ""}[now available in the kernel:\n  ${capRows(fresh).join("\n  ")}\n]`;
				}
			} else if (lines.length > 0) {
				text += `${text ? "\n\n" : ""}[kernel — already available, do not re-fetch (cells in .cells/):\n  ${capRows(lines).join("\n  ")}\n]`;
			}
		}
	} catch {
		// Namespace listing is a convenience; never fail a cell over it.
	}
}
