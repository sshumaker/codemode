// See scripts/neutralize-prime.mjs — opt-in kernel state visibility.
//
// The largest score gap is redundancy: 29% of MCP calls are byte-identical
// repeats, because the model cannot see what it already fetched. Telling it to
// run `%whos` costs a turn and relies on it remembering to look; appending the
// namespace to every cell result costs a few tokens and no turn.
//
// Two modes, because the full listing repeats near-identically every turn and
// that repetition is where its context cost lives:
//
//   HARNESS_SHOW_NAMESPACE=1      full namespace after every cell
//   HARNESS_SHOW_NAMESPACE=delta  only bindings that are new or changed
//
// Delta is the cheaper form: the model accumulates its own picture across turns
// rather than re-reading the same list. Full is more robust if the model has
// forgotten an early binding by the time it matters.
const nsMode = process.env.HARNESS_SHOW_NAMESPACE;
if (nsMode === "1" || nsMode === "delta") {
	try {
		recordAssignments(code, cwd);
		const names = await provisioner.listNamespaceNames(signal);
		if (names && names.length > 0) {
			const describe = (n: string) => {
				const p = assignedAt.get(n);
				return p ? `${n}  # = ${p.rhs}, turn-${p.turn}.py:${p.line}` : n;
			};

			if (nsMode === "delta") {
				const fresh = names.filter((n) => shownNames.get(n) !== describe(n));
				for (const n of names) shownNames.set(n, describe(n));
				if (fresh.length > 0) {
					text += `${text ? "\n\n" : ""}[now available in the kernel:\n  ${fresh.map(describe).join("\n  ")}\n]`;
				}
			} else {
				text += `${text ? "\n\n" : ""}[kernel — already available, do not re-fetch (cells in .cells/):\n  ${names.map(describe).join("\n  ")}\n]`;
			}
		}
	} catch {
		// Namespace listing is a convenience; never fail a cell over it.
	}
}
