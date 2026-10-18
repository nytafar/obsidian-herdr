/**
 * Two small facts about the workspace that several modules ask: what the file
 * explorer's view type is, and whether a leaf is on screen.
 *
 * A module of its own, importing nothing but types, so `explorerButtons.ts`,
 * `explorerReveal.ts`, `followNote.ts`, `openBeside.ts` and `main.ts` can share
 * them without dragging one another (and the terminal view behind them) into
 * their module graphs.
 */

import type { Workspace, WorkspaceLeaf } from 'obsidian';

/** View type of the built-in file explorer. */
export const FILE_EXPLORER_VIEW_TYPE = 'file-explorer';

/**
 * Whether a leaf is on screen: loaded, in the main area, a pop-out or an
 * expanded sidebar, and the front tab of its group. A deferred leaf, a
 * collapsed sidebar or a background tab shows nothing.
 *
 * `isShown` is Obsidian's own `HTMLElement` extension, and it already says no
 * for a background tab; it is not documented to say no for a collapsed
 * sidebar, so that is checked by the sidebar's own flag. Where `isShown` is
 * missing, the other checks alone decide.
 */
export function leafOnScreen(
	workspace: Pick<Workspace, 'leftSplit' | 'rightSplit'>,
	leaf: WorkspaceLeaf,
): boolean {
	if (leaf.isDeferred) return false;
	const root = leaf.getRoot();
	for (const sidebar of [workspace.leftSplit, workspace.rightSplit]) {
		if (root === sidebar && sidebar.collapsed) return false;
	}
	const el = leaf.view?.containerEl as (HTMLElement & { isShown?: () => boolean }) | undefined;
	return typeof el?.isShown === 'function' ? el.isShown() : true;
}
