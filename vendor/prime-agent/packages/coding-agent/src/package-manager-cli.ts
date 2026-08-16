/**
 * Slim build: the package-management / self-update CLI has been removed.
 * Installed by scripts/slim-prime.mjs; the original is 1,641 LOC of
 * `prime-agent package install|remove|update` plus a self-updater that
 * downloads a release archive and unzips it over the running install.
 *
 * Neither belongs in this repo's two uses of prime:
 *
 *   - As a benchmark harness, a self-update mid-sweep changes the thing under
 *     measurement between runs.
 *   - As the basis of a hosted runtime (docs/CLOUD-HARNESS-DESIGN.md), the
 *     harness is cattle: a process that rewrites its own install is the pet
 *     model the architecture drops.
 *
 * `core/package-manager.ts` — the resolver underneath — is deliberately KEPT:
 * ResourceLoader discovers skills, prompts, themes and `--extension` paths
 * through it, which is how both arms get their tool surface.
 */

export type PackageCommand = "install" | "remove" | "update" | "list";

/** The self-update aliases. Retained as a pure predicate; nothing acts on it now. */
export function isSelfUpdateSource(source: string): boolean {
	return source === "self" || source === "pi";
}

/**
 * `prime-agent config`. Always declines to handle, so main.ts falls through to
 * normal startup exactly as it does for any other argv.
 */
export async function handleConfigCommand(_args: string[]): Promise<boolean> {
	return false;
}

/** Every `package`/`update` subcommand. Fails loudly rather than silently no-op'ing. */
export async function handlePackageCommand(_args: string[]): Promise<boolean> {
	console.error("Error: package management and self-update were removed in this build.");
	process.exitCode = 1;
	return true;
}
