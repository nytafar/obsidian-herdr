/**
 * herdr release versions, for gating features on a minimum build.
 *
 * The protocol number cannot tell releases apart: 0.9.0 through 0.9.5 all
 * report protocol 22 with different schemas (`docs/architecture.md`, "Versions
 * and protocol"). What does tell them apart is the `version` string `ping`
 * returns, `"0.9.5"` on a release build. A preview build reports the release it
 * precedes with a suffix (`"0.9.4-preview"`); only the numeric core is
 * compared, so a preview counts as that release. That errs towards trying a
 * method, which is safe: an unsupported one is an ordinary error.
 */

/** `[major, minor, patch]`; a missing part reads as 0. */
export type HerdrVersion = readonly [number, number, number];

/**
 * Reads the numeric core of a version string. Accepts `0.9.5`, `v0.9.5`,
 * `herdr 0.9.5` and `0.9.4-preview`. Null when there is no number to read.
 */
export function parseHerdrVersion(value: string | null | undefined): HerdrVersion | null {
	if (typeof value !== 'string') return null;
	const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value);
	if (!match) return null;
	return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
export function compareHerdrVersions(a: HerdrVersion, b: HerdrVersion): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * True when `version` is `minimum` or newer. An unreadable or unknown version
 * is false: a feature gated on a build is off until the build is known.
 */
export function herdrVersionAtLeast(
	version: string | null | undefined,
	minimum: string,
): boolean {
	const have = parseHerdrVersion(version);
	const need = parseHerdrVersion(minimum);
	if (!have || !need) return false;
	return compareHerdrVersions(have, need) >= 0;
}
