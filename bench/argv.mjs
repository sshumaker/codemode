/**
 * The one argv parser for bench CLIs.
 *
 * `const flag = (name, fallback) => ...` was defined verbatim in 20 files
 * (review P3), which is 20 chances for one of them to drift — the same class
 * as the pyIdent copy in schema-score.mjs that mis-scored an arm. Every
 * helper here is a closure over an argv array so callers keep their own
 * `process.argv.slice(2)` snapshot semantics.
 */
export function makeArgv(argv = process.argv.slice(2)) {
	return {
		argv,
		/** Value of `--name <value>`, or the fallback. */
		flag: (name, fallback) => {
			const i = argv.indexOf(`--${name}`);
			return i >= 0 ? argv[i + 1] : fallback;
		},
		/** Bare `--name` presence. */
		has: (name) => argv.includes(`--${name}`),
		/** Positionals: not a flag, not the value slot right after one. */
		positional: () =>
			argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--"))),
	};
}
