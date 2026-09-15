/**
 * @-mentions in the prompt box (issue #98).
 *
 * A mention is read by the agent in the pane, not by Obsidian, so it carries a
 * path that process can open: **relative to the pane's cwd when the file is
 * under it** — the main case, panes opened on a folder of this vault — and
 * absolute otherwise (`findings/native-view-design.md`). A path with a space in
 * it is quoted, because the agent reads the prompt as words.
 *
 * Obsidian's side of this is one call: a `TFile` knows its vault-relative path
 * and the vault knows its base path, which is what
 * {@link vaultFileAbsolutePath} joins. No `obsidian` import, so the form can be
 * tested as a table.
 */

/** The file being mentioned and the pane it is being mentioned to. */
export interface MentionInput {
	/** Absolute path of the file on the pane's host. */
	path: string;
	/** The pane's working directory; empty when it is not known. */
	cwd: string;
}

/**
 * The path an agent is given: relative when the file is under the cwd,
 * absolute when it is not.
 *
 * "Under" means under the directory, not "starts with the string":
 * `/home/lasse/hvelv-old` is not inside `/home/lasse/hvelv`, so the separator
 * is part of the test.
 */
export function mentionPath(input: MentionInput): string {
	const cwd = input.cwd.replace(/\/+$/, '');
	if (cwd === '') return input.path;
	const prefix = `${cwd}/`;
	if (!input.path.startsWith(prefix)) return input.path;
	const relative = input.path.slice(prefix.length);
	return relative === '' ? input.path : relative;
}

/**
 * The text that goes into the prompt: `@` and the path, in quotes when the
 * path has a space in it so the agent reads it as one word.
 */
export function mentionFor(input: MentionInput): string {
	const path = mentionPath(input);
	return path.includes(' ') ? `@"${path}"` : `@${path}`;
}

/**
 * A vault file's absolute path: the vault's base path and the vault-relative
 * path Obsidian gives for a `TFile`. Null when the vault has no base path,
 * which is a vault that is not on this filesystem and has nothing to mention.
 */
export function vaultFileAbsolutePath(input: {
	vaultPath: string;
	filePath: string;
}): string | null {
	if (input.vaultPath === '') return null;
	const base = input.vaultPath.replace(/\/+$/, '');
	return `${base}/${input.filePath}`;
}
