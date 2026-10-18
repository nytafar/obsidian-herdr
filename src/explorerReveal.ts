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

import { View, type App, type TAbstractFile, type WorkspaceLeaf } from 'obsidian';
import type HerdrPlugin from './main';
import { vaultRelativeFolder } from './paths';
import { parseTerminalState, TERMINAL_VIEW_TYPE } from './views/terminalView';

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

/**
 * The folder a herdr tab's pane works in, as the explorer should reveal it
 * (#116), or null for anything that is not to be revealed: the feature off, a
 * leaf that is not a herdr tab, a pane the published connection does not hold,
 * or a cwd outside the vault.
 *
 * `cwd` is `PaneState.cwd`: herdr's `cwd`, with `foreground_cwd` used when
 * herdr reports no `cwd` at all.
 */
export function cwdRevealTarget(input: {
	enabled: boolean;
	/** The pane the newly active leaf shows, or null when it is no herdr tab. */
	paneId: string | null;
	/** The pane's cwd as herdr reports it, or null when the scope lacks it. */
	cwd: string | null;
	/** `herdrVaultPath()`. */
	vaultPath: string;
}): string | null {
	if (!input.enabled || !input.paneId || input.cwd === null) return null;
	return vaultRelativeFolder(input.cwd, input.vaultPath);
}

/** True when the keyboard focus sits inside a file explorer leaf. */
function explorerHasFocus(app: App, doc: Document): boolean {
	const active = doc.activeElement;
	if (!active) return false;
	return app.workspace
		.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE)
		.some((leaf) => leaf.view?.containerEl.contains(active) === true);
}

/**
 * Follows the focused herdr tab in the file explorer (#116): on
 * `active-leaf-change` only, never on `pane.updated`, and silently.
 *
 * The explorer may take the active leaf or the keyboard focus while it
 * reveals; Obsidian does not document whether `revealInFolder` does either, so
 * if the active leaf moved off the herdr tab, or the focus into the explorer,
 * the tab gets it back. The restore activates the herdr leaf again, which would
 * re-enter here, so that one event is skipped.
 */
export function registerCwdReveal(plugin: HerdrPlugin): void {
	const app = plugin.app;
	const workspace = app.workspace;
	let restoring = false;
	plugin.registerEvent(
		workspace.on('active-leaf-change', (leaf) => {
			if (restoring || !leaf) return;
			// The persisted state, not `leaf.view`: a restored tab may still be
			// deferred, and no view is held (PRD N1).
			const viewState = leaf.getViewState();
			const state = viewState.type === TERMINAL_VIEW_TYPE ? parseTerminalState(viewState.state) : null;
			const session = state ? plugin.endpointSession(state.endpointId) : null;
			const folder = cwdRevealTarget({
				enabled: plugin.settings.revealCwdInExplorer,
				paneId: state?.paneId ?? null,
				cwd: state ? (session?.scope.get(state.paneId)?.cwd ?? null) : null,
				vaultPath: plugin.herdrVaultPath(),
			});
			if (folder === null) return;
			void revealVaultFolder(app, folder, { showExplorer: false }).then((outcome) => {
				if (outcome !== 'revealed') return;
				const activeNow = workspace.getActiveViewOfType(View)?.leaf ?? null;
				const doc = leaf.view.containerEl.ownerDocument;
				if (activeNow === leaf && !explorerHasFocus(app, doc)) return;
				restoring = true;
				try {
					workspace.setActiveLeaf(leaf, { focus: true });
				} finally {
					restoring = false;
				}
			});
		}),
	);
}
