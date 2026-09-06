/**
 * The two path questions this plugin keeps asking: what is the last segment,
 * and what does this path look like without its trailing slashes.
 *
 * They were written four times over — `folderName` in `actions.ts`, `basename`
 * in `herdr/scope.ts`, `lastSegment` in `views/rowModel.ts`, `trimTrailingSlash`
 * in `explorerButtons.ts` — each identical and each one more place for the two
 * spellings of a directory to stop comparing equal.
 *
 * A module of its own rather than a corner of `actions.ts`, because
 * `herdr/scope.ts` is one of the callers and must stay free of Obsidian:
 * `actions.ts` imports `settings.ts`, which imports `obsidian`. This file
 * imports nothing.
 *
 * Everything here is POSIX: herdr reports POSIX paths, and under a remote
 * profile they belong to another machine's filesystem anyway (PRD S5), so
 * `node:path` would be the wrong tool even where it would work.
 */

/**
 * The path without its trailing slashes, so `/a/b/` and `/a/b` compare equal.
 * `/` becomes the empty string, which is what every caller wants: it is used to
 * build `${root}/${rest}` or to compare against another trimmed path.
 */
export function trimTrailingSlashes(path: string): string {
	return path.replace(/\/+$/, '');
}

/**
 * The last segment of a path: `/Users/lasse/hvelv` → `hvelv`, with trailing
 * slashes ignored. A path with no slash is its own last segment, and the root
 * (or an empty path) has none, so the answer is empty — callers that need a
 * label decide what to show instead.
 */
export function lastPathSegment(path: string): string {
	const trimmed = trimTrailingSlashes(path);
	const slash = trimmed.lastIndexOf('/');
	return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}
