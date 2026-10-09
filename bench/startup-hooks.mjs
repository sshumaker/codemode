/**
 * The kernel's IPython startup hooks, in load order, and the environment that turns
 * them all on. `runtime/startup_hooks.json` is the one list: the hook-chain test
 * (runtime/test_startup_hooks_chain.py) loads it, and a port installs from it rather
 * than copying the order by hand.
 *
 * The order matters: each hook chains onto the custom-exception handler the one
 * before it installed, and IPython runs startup files in name order, so a port
 * names them with `startupFiles()`'s numeric prefixes.
 */
import { readFileSync } from "node:fs";

const RUNTIME = new URL("../runtime/", import.meta.url);
const MANIFEST = JSON.parse(readFileSync(new URL("startup_hooks.json", RUNTIME), "utf8"));

/** Hook file names under `runtime/`, in the order they must load. */
export const STARTUP_HOOKS = Object.freeze([...MANIFEST.order]);

/** The kernel environment every hook reads to be on. */
export const HOOK_ENV = Object.freeze({ ...MANIFEST.env });

/** `{"00-eperm_correction.py": source, "10-...": ...}`: the hooks as IPython startup files. */
export function startupFiles() {
	return Object.fromEntries(
		STARTUP_HOOKS.map((name, i) => [`${String(i * 10).padStart(2, "0")}-${name}`, readFileSync(new URL(name, RUNTIME), "utf8")]),
	);
}
