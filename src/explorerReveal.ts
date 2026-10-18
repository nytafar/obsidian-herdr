/**
 * Revealing a vault folder in Obsidian's file explorer (issues #79, #116).
 *
 * Two callers want the same thing done in two tempers. The agent row's
 * "Reveal folder" entry (#79) is an explicit ask: it opens the sidebar the
 * explorer lives in when that is collapsed, and says so with a notice when the
 * folder or the explorer is not there. Following the focused herdr tab (#116)
 * is ambient: it fires on every tab switch, so it never opens a sidebar, never
 * says anything, and does nothing at all unless the explorer is already on
 * screen.
 *
 * Obsidian publishes no file explorer API. The explorer leaf is found the way
 * `explorerButtons.ts` finds it, by view type through `getLeavesOfType`, and
 * the one method used, `revealInFolder`, is undocumented. It expands the
 * folder's parents, selects the folder and scrolls to it; it is typed narrowly
 * here and checked with `typeof` before every call, so an Obsidian that drops
 * or renames it makes this a no-op rather than an exception. No view is kept:
 * every reveal looks the leaf up again.
 *
 * The cwd-to-folder mapping both callers start from is `vaultRelativeFolder`
 * in `paths.ts`, shared with the follow-active-note matching (#78).
 */

import type { App, TAbstractFile, WorkspaceLeaf } from 'obsidian';

/** View type of the built-in file explorer. */
export const FILE_EXPLORER_VIEW_TYPE = 'file-explorer';

/** The one undocumented explorer method this module calls. */
interface RevealingExplorer {
	revealInFolder(file: TAbstractFile): void;
}

/** The explorer view, when it still has the method; null otherwise. */
export function revealingExplorer(view: unknown): RevealingExplorer | null {
	if (typeof view !== 'object' || view === null) return null;
	const reveal = (view as { revealInFolder?: unknown }).revealInFolder;
	return typeof reveal === 'function' ? (view as RevealingExplorer) : null;
}

/** How a reveal ended. Only `revealed` touched the explorer. */
export type FolderRevealOutcome =
	| 'revealed'
	/** No such folder in the vault: not synced yet, deleted, or hidden. */
	| 'no-folder'
	/** No file explorer leaf at all; the core plugin may be off. */
	| 'no-explorer'
	/** The explorer exists but is not on screen, and the caller would not show it. */
	| 'explorer-hidden'
	/** The explorer has no `revealInFolder` in this Obsidian build. */
	| 'unsupported';

/** What the explicit "Reveal folder" says for an outcome; null for none. */
export function folderRevealNotice(outcome: FolderRevealOutcome, folderPath: string): string | null {
	switch (outcome) {
		case 'revealed':
		case 'explorer-hidden':
			return null;
		case 'no-folder':
			return `Herdr: the folder "${folderPath || '/'}" is not in this vault.`;
		case 'no-explorer':
			return 'Herdr: the file explorer is not open. Turn on the core files plugin to reveal folders.';
		case 'unsupported':
			return 'Herdr: this version of Obsidian cannot reveal folders in the file explorer.';
	}
}

/**
 * Whether a leaf is on screen: in the main area or an expanded sidebar, and
 * the front tab of its group. A collapsed sidebar or a background tab shows
 * nothing, and revealing into it would open a panel nobody asked for.
 * `isShown` is Obsidian's own `HTMLElement` extension; where it is missing the
 * sidebar check alone decides.
 */
function leafOnScreen(app: App, leaf: WorkspaceLeaf): boolean {
	const workspace = app.workspace;
	const root = leaf.getRoot();
	for (const sidebar of [workspace.leftSplit, workspace.rightSplit]) {
		if (root === sidebar && sidebar.collapsed) return false;
	}
	const el = leaf.view?.containerEl as (HTMLElement & { isShown?: () => boolean }) | undefined;
	return typeof el?.isShown === 'function' ? el.isShown() : true;
}

/**
 * Reveals one vault folder (`''` is the root) in the first file explorer.
 *
 * `showExplorer` is the difference between the two callers: on, a collapsed
 * sidebar is opened and a background explorer tab brought to the front
 * (`revealLeaf`, which also loads a deferred one); off, an explorer that is not
 * already on screen is left alone.
 */
export async function revealVaultFolder(
	app: App,
	folderPath: string,
	options: { showExplorer: boolean },
): Promise<FolderRevealOutcome> {
	const vault = app.vault;
	const folder = folderPath === '' ? vault.getRoot() : vault.getFolderByPath(folderPath);
	if (!folder) return 'no-folder';
	const leaf = app.workspace.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE).at(0);
	if (!leaf) return 'no-explorer';
	if (options.showExplorer) await app.workspace.revealLeaf(leaf);
	else if (leaf.isDeferred || !leafOnScreen(app, leaf)) return 'explorer-hidden';
	// Read after the reveal: a deferred leaf only has its real view once loaded.
	const explorer = revealingExplorer(leaf.view);
	if (!explorer) return 'unsupported';
	explorer.revealInFolder(folder);
	return 'revealed';
}

/** The row menu's "Reveal folder" (#79): shows the explorer, and says why not. */
export async function revealFolderFromMenu(app: App, folderPath: string): Promise<string | null> {
	return folderRevealNotice(await revealVaultFolder(app, folderPath, { showExplorer: true }), folderPath);
}
