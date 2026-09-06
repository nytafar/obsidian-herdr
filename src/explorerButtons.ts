/**
 * Hover button on file-explorer folder rows (issue #30, PRD C21).
 *
 * The right-click menu from PRD M19 already carries the folder actions, but it
 * is invisible until you know it is there. This adds a small button that appears
 * when the pointer is over a folder row and opens a three-entry menu: attach to
 * an agent already running there, start one, or copy the folder's vault path.
 *
 * Everything here is undocumented DOM, which is why it sits behind a setting and
 * why it is written to give up cleanly. Obsidian exposes no file explorer API
 * (RESEARCH §4): the only handle is `.nav-folder-title[data-path]`, the selector
 * every plugin that touches the explorer uses. The explorer also recycles rows
 * as you scroll and collapse, so a one-shot injection would evaporate; a
 * `MutationObserver` per explorer view, debounced at 150 ms, rescans and claims
 * or releases each row by the `data-herdr-folder-button` marker.
 *
 * Lifetime is the awkward part. `Plugin.registerDomEvent` and
 * `Plugin.registerEvent` release at *plugin unload*, but this feature has to
 * release the moment the setting is switched off, which is what the ticket's
 * acceptance asks for. So the class owns its listeners, its observers and its
 * buttons, and {@link ExplorerFolderButtons.disable} — which `onunload` also
 * calls — hands every one of them back.
 *
 * The decisions are pure functions ({@link menuItemsFor}, {@link attachablePane},
 * {@link folderAbsPath}, {@link vaultRelativeLabel}) so they can be tested
 * without a DOM; only the wiring below needs a real explorer.
 */

import { Menu, Notice, setIcon, setTooltip, type EventRef } from 'obsidian';
import type HerdrPlugin from './main';
import { resolveFolderPath } from './actions';
import { isUnder, type PaneState } from './herdr/scope';

/** View type of the built-in file explorer. */
const FILE_EXPLORER_VIEW_TYPE = 'file-explorer';

/** The one handle Obsidian gives us on a folder row (RESEARCH §4). */
export const FOLDER_ROW_SELECTOR = '.nav-folder-title[data-path]';

/** Class of the injected button; also how a claimed row's button is found again. */
export const BUTTON_CLASS = 'herdr-folder-button';

/** Marker attribute on a claimed row. CSS keys the hover reveal off it too. */
export const CLAIM_ATTR = 'data-herdr-folder-button';

/** Sentence case, and it says whose button this is. */
const BUTTON_LABEL = 'Herdr actions';

/**
 * How long the observer waits before rescanning. The explorer emits a burst of
 * mutations per scroll or collapse, and our own button insertion is one more, so
 * one pass per burst is the point (RESEARCH §4: icor-interface uses 150 ms).
 */
const RESCAN_DEBOUNCE_MS = 150;

/** What a menu entry does once clicked. */
export type FolderMenuAction =
	| { readonly kind: 'attach'; readonly paneId: string }
	| { readonly kind: 'start' }
	| { readonly kind: 'copy' };

/** One entry of the folder menu, decided without touching a DOM. */
export interface FolderMenuItem {
	readonly title: string;
	readonly icon: string;
	readonly action: FolderMenuAction;
}

/** Trailing slashes removed, so two spellings of the same directory compare equal. */
function trimTrailingSlash(path: string): string {
	return path.replace(/\/+$/, '');
}

/**
 * The agent pane the "Attach" entry should open for a folder, or null when no
 * agent runs there.
 *
 * A pane counts when its cwd *is* the folder or sits under it, so attaching from
 * a project root reaches the agent working in `src/`. An exact match wins over a
 * descendant, because an agent in the folder itself is the better answer to
 * "attach here"; among equals the first pane in scope order wins, which is
 * herdr's own pane order.
 */
export function attachablePane(
	folderAbsPath: string,
	panes: readonly PaneState[],
): PaneState | null {
	if (!folderAbsPath) return null;
	const folder = trimTrailingSlash(folderAbsPath);
	let descendant: PaneState | null = null;
	for (const pane of panes) {
		if (!isUnder(pane.cwd, folder)) continue;
		if (trimTrailingSlash(pane.cwd) === folder) return pane;
		descendant ??= pane;
	}
	return descendant;
}

/**
 * The menu for a folder, in the ticket's order: attach first and only when an
 * agent is live there, then the create-and-start flow, then the path.
 */
export function menuItemsFor(
	folderAbsPath: string,
	panes: readonly PaneState[],
): FolderMenuItem[] {
	const items: FolderMenuItem[] = [];
	const pane = attachablePane(folderAbsPath, panes);
	if (pane) {
		items.push({
			title: 'Attach',
			icon: 'square-terminal',
			action: { kind: 'attach', paneId: pane.paneId },
		});
	}
	items.push({ title: 'Start agent here', icon: 'bot', action: { kind: 'start' } });
	items.push({ title: 'Copy path from vault root', icon: 'copy', action: { kind: 'copy' } });
	return items;
}

/**
 * A row's `data-path` as a path from the vault root. The explorer writes `/`
 * for the vault root itself and a plain relative path for everything else.
 */
export function vaultRelativeLabel(dataPath: string): string {
	const trimmed = trimTrailingSlash(dataPath.trim().replace(/^\.\//, ''));
	return trimmed === '' || trimmed === '.' ? '/' : trimmed;
}

/**
 * Absolute path herdr should use for a row's `data-path`. `herdrVaultPath` is
 * the vault as the machine herdr runs on sees it, so a remote profile lands on
 * the remote root (PRD S5, M19). The root row's `/` is mapped to the empty
 * relative path first: {@link resolveFolderPath} would otherwise take it for an
 * absolute path and hand back the filesystem root.
 */
export function folderAbsPath(dataPath: string, herdrVaultPath: string): string {
	const relative = vaultRelativeLabel(dataPath);
	return resolveFolderPath(relative === '/' ? '' : relative, { basePath: herdrVaultPath });
}

/**
 * An event target as an `Element`, without `instanceof`: a popout window has its
 * own `Element` constructor, so `target instanceof Element` is false for
 * anything clicked in a detached explorer.
 */
export function asElement(target: EventTarget | null): Element | null {
	if (target === null || typeof target !== 'object') return null;
	const candidate = target as Element;
	return typeof candidate.closest === 'function' ? candidate : null;
}

/** A pending rescan. Trailing edge, cancellable, because `disable()` must. */
interface Rescan {
	schedule(): void;
	cancel(): void;
}

function rescanner(run: () => void, ms: number): Rescan {
	let handle = 0;
	return {
		schedule(): void {
			if (handle) window.clearTimeout(handle);
			handle = window.setTimeout(() => {
				handle = 0;
				run();
			}, ms);
		},
		cancel(): void {
			if (handle) window.clearTimeout(handle);
			handle = 0;
		},
	};
}

/** Everything held for one file explorer view. */
interface Watched {
	release(): void;
}

/** Injects, maintains and releases the folder hover buttons. */
export class ExplorerFolderButtons {
	private readonly plugin: HerdrPlugin;
	/** One entry per file explorer view: its observer, listener and timer. */
	private readonly watched = new Map<HTMLElement, Watched>();
	/** Rows currently carrying a button, so `disable()` can strip them again. */
	private readonly claimed = new Set<HTMLElement>();
	private layoutRef: EventRef | null = null;
	private enabled = false;

	constructor(plugin: HerdrPlugin) {
		this.plugin = plugin;
	}

	/** Idempotent: the settings toggle and layout ready may both ask for this. */
	enable(): void {
		if (this.enabled) return;
		this.enabled = true;
		// A second explorer, or one dragged into a popout, is a new container to
		// observe; `layout-change` is the only event that says so.
		this.layoutRef = this.plugin.app.workspace.on('layout-change', () => this.sync());
		this.sync();
	}

	/** Gives back every observer, listener, timer and button. Idempotent. */
	disable(): void {
		if (!this.enabled) return;
		this.enabled = false;
		if (this.layoutRef) {
			this.plugin.app.workspace.offref(this.layoutRef);
			this.layoutRef = null;
		}
		for (const watched of this.watched.values()) watched.release();
		this.watched.clear();
		for (const row of [...this.claimed]) this.releaseRow(row);
		this.claimed.clear();
	}

	/** Follows the open file explorer views: observe the new, drop the gone. */
	private sync(): void {
		if (!this.enabled) return;
		const containers = new Set<HTMLElement>();
		for (const leaf of this.plugin.app.workspace.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE)) {
			containers.add(leaf.view.containerEl);
		}
		for (const [container, watched] of [...this.watched]) {
			if (containers.has(container)) continue;
			watched.release();
			this.watched.delete(container);
		}
		for (const container of containers) {
			if (!this.watched.has(container)) this.watch(container);
			this.scan(container);
		}
	}

	/** Starts observing one explorer container and listening for its clicks. */
	private watch(container: HTMLElement): void {
		const rescan = rescanner(() => this.scan(container), RESCAN_DEBOUNCE_MS);
		const observer = new MutationObserver(() => rescan.schedule());
		observer.observe(container, { childList: true, subtree: true });
		// Capture phase, one listener per explorer instead of one per row: the
		// rows come and go, the container does not. Capture also means the click
		// is stopped before the row's own handler folds the folder.
		const onClick = (event: MouseEvent): void => this.onClick(event);
		container.addEventListener('click', onClick, true);
		this.watched.set(container, {
			release: () => {
				rescan.cancel();
				observer.disconnect();
				container.removeEventListener('click', onClick, true);
			},
		});
	}

	/**
	 * Claims every folder row of one explorer and releases the rows that are no
	 * longer folder rows. Idempotent, which is what keeps the observer from
	 * looping on its own insertions: the second pass finds nothing to change.
	 */
	private scan(container: HTMLElement): void {
		if (!this.enabled) return;
		// Rows the explorer recycled away: forget them, the nodes are detached.
		for (const row of [...this.claimed]) {
			if (!row.isConnected) this.claimed.delete(row);
		}
		// `Array.from` rather than iterating the NodeList: this project's `lib` is
		// DOM without DOM.Iterable, and a live list would shift under us anyway.
		for (const marked of Array.from(container.querySelectorAll<HTMLElement>(`[${CLAIM_ATTR}]`))) {
			if (!marked.matches(FOLDER_ROW_SELECTOR)) this.releaseRow(marked);
		}
		for (const row of Array.from(container.querySelectorAll<HTMLElement>(FOLDER_ROW_SELECTOR))) {
			this.claimRow(row);
		}
	}

	private claimRow(row: HTMLElement): void {
		// Re-entry guard: the marker for the common case, the query for a row
		// Obsidian cloned along with our button.
		if (row.hasAttribute(CLAIM_ATTR)) return;
		if (row.querySelector(`.${BUTTON_CLASS}`)) return;
		const button = row.createDiv({
			cls: `${BUTTON_CLASS} clickable-icon`,
			attr: { role: 'button', 'aria-label': BUTTON_LABEL },
		});
		setIcon(button, 'bot');
		setTooltip(button, BUTTON_LABEL);
		row.setAttribute(CLAIM_ATTR, '');
		this.claimed.add(row);
	}

	private releaseRow(row: HTMLElement): void {
		row.removeAttribute(CLAIM_ATTR);
		for (const button of Array.from(row.querySelectorAll(`.${BUTTON_CLASS}`))) button.remove();
		this.claimed.delete(row);
	}

	private onClick(event: MouseEvent): void {
		const target = asElement(event.target);
		const button = target?.closest(`.${BUTTON_CLASS}`);
		if (!button) return;
		// Stopped in the capture phase, so the row below never sees it and the
		// folder neither folds nor becomes the explorer's selection.
		event.preventDefault();
		event.stopPropagation();
		const row = button.closest<HTMLElement>(FOLDER_ROW_SELECTOR);
		const dataPath = row?.getAttribute('data-path');
		if (typeof dataPath !== 'string') return;
		this.openMenu(event, dataPath);
	}

	private openMenu(event: MouseEvent, dataPath: string): void {
		const absolute = folderAbsPath(dataPath, this.plugin.herdrVaultPath());
		const panes = this.plugin.scope?.list() ?? [];
		const menu = new Menu();
		for (const item of menuItemsFor(absolute, panes)) {
			menu.addItem((entry) =>
				entry
					.setTitle(item.title)
					.setIcon(item.icon)
					.onClick(() => this.run(item.action, absolute, dataPath)),
			);
		}
		menu.showAtMouseEvent(event);
	}

	/** Runs a chosen entry. The start flow is `plugin.actions`, never a copy of it. */
	private run(action: FolderMenuAction, absolute: string, dataPath: string): void {
		switch (action.kind) {
			case 'attach':
				void this.plugin.openTerminal(action.paneId);
				return;
			case 'start':
				void this.plugin.actions.startAgentHere(absolute);
				return;
			case 'copy':
				void this.copyPath(vaultRelativeLabel(dataPath));
				return;
		}
	}

	private async copyPath(path: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(path);
			new Notice(`Herdr: copied ${path}`);
		} catch (error) {
			new Notice(`Herdr: could not copy the path. ${(error as Error).message}`);
		}
	}
}
