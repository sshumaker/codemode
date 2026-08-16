/**
 * Slim build: the startup version check has been removed.
 * Installed by scripts/slim-prime.mjs.
 *
 * The original fetched a release manifest from the vendor's download endpoint
 * on startup so the TUI could print "a new version is available". A benchmark
 * harness must not make an unbudgeted network call on the path it is timing,
 * and a hosted runtime must not phone home at all
 * (docs/CLOUD-HARNESS-DESIGN.md §3.3).
 *
 * Signatures are unchanged so the two remaining callers — startup-notices and
 * interactive-mode — compile and simply never see an update.
 */

export interface LatestPiRelease {
	version: string;
	downloadUrl?: string;
	checksum?: string;
}

/** Pure semver-ish compare; kept because it has no side effects and reads clearly. */
export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const parse = (value: string): number[] | undefined => {
		const core = value.trim().replace(/^v/, "").split("-")[0];
		const parts = core.split(".").map((part) => Number.parseInt(part, 10));
		return parts.length === 3 && parts.every((part) => Number.isInteger(part)) ? parts : undefined;
	};
	const left = parse(leftVersion);
	const right = parse(rightVersion);
	if (!left || !right) return undefined;
	for (let index = 0; index < 3; index++) {
		if (left[index]! !== right[index]!) return left[index]! > right[index]! ? 1 : -1;
	}
	return 0;
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	return comparison !== undefined && comparison > 0;
}

export async function getLatestPiRelease(
	_currentVersion: string,
	_options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	return undefined;
}

export async function getLatestPiVersion(
	_currentVersion: string,
	_options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return undefined;
}

export async function checkForNewPiVersion(_currentVersion: string): Promise<string | undefined> {
	return undefined;
}
