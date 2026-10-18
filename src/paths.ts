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

/**
 * The segments of an absolute POSIX path, with `.` and empty segments dropped
 * and `..` resolved, or null for a path that is not absolute. A `..` above the
 * root stays at the root, as the filesystem does.
 */
function absoluteSegments(path: string): string[] | null {
	const trimmed = path.trim();
	if (!trimmed.startsWith('/')) return null;
	const segments: string[] = [];
	for (const segment of trimmed.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') segments.pop();
		else segments.push(segment);
	}
	return segments;
}

/** The segments of a vault-relative path, empty and `.` segments dropped. */
function relativeSegments(path: string): string[] {
	return path.split('/').filter((segment) => segment !== '' && segment !== '.');
}

/**
 * Where a pane's working directory sits in the vault, as a vault-relative
 * folder path: `''` for the vault root itself, `inputs/corpora` for a folder
 * below it, and null when the cwd is outside the vault or either path is not
 * known (issues #79, #116, #78).
 *
 * Both paths are herdr's side of the world: `cwd` is what herdr reports for the
 * pane and `vaultPath` is `herdrVaultPath()`, the remote vault path under a
 * remote profile, so a remote pane maps onto the same folders a local one
 * would. The comparison is by whole segments, which is what keeps
 * `/vault-old/notes` out of `/vault`; trailing and doubled slashes do not
 * matter on either side.
 *
 * The answer is in the form `Vault.getFolderByPath` takes, except for the root,
 * which callers fetch with `Vault.getRoot()`.
 */
export function vaultRelativeFolder(cwd: string, vaultPath: string): string | null {
	const vault = absoluteSegments(vaultPath);
	const folder = absoluteSegments(cwd);
	// A vault at `/` would claim every path on the machine; no real vault is.
	if (!vault || !folder || vault.length === 0) return null;
	if (folder.length < vault.length) return null;
	for (let index = 0; index < vault.length; index++) {
		if (folder[index] !== vault[index]) return null;
	}
	return folder.slice(vault.length).join('/');
}

/**
 * How many folders deep a vault-relative path is: 0 for the root (`''`), 1 for
 * `efforts`, 3 for `inputs/corpora/silva-cacao`. Slashes at either end and
 * doubled slashes do not count.
 */
export function vaultFolderDepth(relative: string): number {
	return relativeSegments(relative).length;
}

/**
 * True when the vault-relative `path` (a note or a folder) lies inside the
 * vault-relative `folder`. The root (`''`) contains everything; any other
 * folder contains itself and what is below it, by whole segments, so
 * `efforts-old/a.md` is not inside `efforts`.
 */
export function vaultPathIsInside(path: string, folder: string): boolean {
	const inner = relativeSegments(path);
	const outer = relativeSegments(folder);
	if (inner.length < outer.length) return false;
	return outer.every((segment, index) => inner[index] === segment);
}
