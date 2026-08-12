/**
 * Which tagged runs represent one (task, cell), and whether they average.
 *
 * Two tag semantics that look identical at the call site and must not be confused:
 *
 * - **replicate** (`--tag a,b`): b is another run of the same configuration, so a
 *   and b are averaged before pairing. This is what buys a measured noise floor.
 * - **override** (`--override-tag c`): c re-runs a task under a *changed* setting
 *   because the original measurement was invalid — in practice, a higher cost cap
 *   after the original was truncated. c replaces a; averaging them would blend a
 *   censored value with its uncensored replacement and produce a number that is
 *   neither, while looking entirely plausible.
 *
 * Kept as a pure function so the rule can be tested without executing the analysis,
 * and so there is exactly one copy of it.
 */

/**
 * @param {string[]} baseTags      tags from --tag (replicates, averaged)
 * @param {string[]} overrideTags  tags from --override-tag (replacements)
 * @param {(tag: string) => boolean} hasRun  does this (task, cell) have a run under `tag`?
 * @returns {{tags: string[], overridden: boolean}}
 */
export function selectTags(baseTags, overrideTags, hasRun) {
	const present = overrideTags.filter(hasRun);
	// An override only applies where it actually produced a run. A repair that
	// covers 11 of 24 tasks must leave the other 13 on their base runs rather than
	// dropping them, so "no override run here" has to fall through, not exclude.
	if (present.length > 0) return { tags: present, overridden: true };
	return { tags: baseTags, overridden: false };
}
