/**
 * Follow active note (issue #78): focusing a markdown note brings the agent
 * working in that note's folder into view, exactly where a click on its row
 * would send it (`agentListRowClick`): its terminal in Obsidian, or its pane in
 * herdr. Off by default.
 *
 * Which agent is {@link chooseFollowPane}'s pure decision, next to
 * `decidePlacement`; where its terminal opens is `openTerminal`'s, so the
 * placement and tab-reuse settings apply as they do to a row click. What this
 * module adds is when to ask and what not to disturb:
 *
 * - Only a markdown note becoming active asks — `active-leaf-change` on a
 *   markdown leaf, or `file-open` in the active one. A terminal, the agent
 *   list or any other view coming to the front says nothing about notes.
 * - A note owned by the agent followed last asks for nothing, so moving
 *   between notes of one folder never makes the layout flicker. A note no
 *   agent owns asks for nothing either, and closes nothing: the terminal that
 *   is open stays open.
 * - A terminal that is already on screen is left where it is.
 * - The keyboard stays in the note. The terminal opens inactive and under a
 *   {@link FocusHold}, so its renderer does not take the focus when its bridge
 *   starts, and the note gets the active leaf back if the open moved it.
 */

import { View, type TFile, type WorkspaceLeaf } from 'obsidian';
import type HerdrPlugin from './main';
import type { Unsubscribe } from './herdr/scope';
import { clampFollowDepth, isPanePinned } from './settings';
import { chooseFollowPane, FocusRecency } from './terminalPlacement';
import { stateMatchesPane, TERMINAL_VIEW_TYPE } from './views/terminalView';
import type { RowClickAction } from './views/rowModel';

/** What the follower reads of a pane. `PaneState` satisfies it. */
export interface FollowPane {
	paneId: string;
	cwd: string;
	focused: boolean;
}

/** Whether a pane's terminal is open, and if so whether it is on screen. */
export type TerminalPresence = 'shown' | 'hidden' | 'none';

/** Everything the follower needs of the plugin and the workspace. */
export interface NoteFollowerOptions<L> {
	/** The `followActiveNote` setting. */
	enabled(): boolean;
	/** The `followActiveNoteMinDepth` setting, clamped. */
	minDepth(): number;
	/** The `agentListRowClick` setting: where a row click sends an agent. */
	rowClick(): RowClickAction;
	/** `herdrVaultPath()`. */
	vaultPath(): string;
	/** The id of the endpoint the panes below come from. */
	endpointId(): string;
	/** The scoped workspace's agent panes, or null while there is no connection. */
	panes(): readonly FollowPane[] | null;
	/** Whether a pane is pinned to the top of its group on that endpoint. */
	pinned(paneId: string): boolean;
	/** {@link FocusRecency.rank} for the pane. */
	focusRank(pane: FollowPane): number;
	terminalPresence(paneId: string): TerminalPresence;
	/** Opens or reveals the pane's terminal, keeping the note focused. */
	openTerminalQuietly(paneId: string, noteLeaf: L): Promise<void>;
	/** `pane.focus` in herdr. */
	focusPane(paneId: string): void;
}

/** The decision and its one piece of state: which agent was followed last. */
export class NoteFollower<L> {
	private readonly options: NoteFollowerOptions<L>;
	/** `endpoint|pane` of the agent followed last, null after a note nobody owns. */
	private last: string | null = null;

	constructor(options: NoteFollowerOptions<L>) {
		this.options = options;
	}

	/** A note became the active file. Awaited by tests; fired and forgotten in the app. */
	async noteFocused(notePath: string, noteLeaf: L): Promise<void> {
		const o = this.options;
		if (!o.enabled()) {
			this.last = null;
			return;
		}
		if (!notePath.toLowerCase().endsWith('.md')) return;
		const panes = o.panes();
		if (!panes) return;
		const paneId = chooseFollowPane({
			notePath,
			vaultPath: o.vaultPath(),
			minDepth: o.minDepth(),
			panes: panes.map((pane) => ({
				paneId: pane.paneId,
				cwd: pane.cwd,
				pinned: o.pinned(pane.paneId),
				focusRank: o.focusRank(pane),
			})),
		});
		if (!paneId) {
			this.last = null;
			return;
		}
		const key = `${o.endpointId()}|${paneId}`;
		if (key === this.last) return;
		this.last = key;
		if (o.rowClick() === 'focus') {
			if (!panes.find((pane) => pane.paneId === paneId)?.focused) o.focusPane(paneId);
			return;
		}
		if (o.terminalPresence(paneId) === 'shown') return;
		await o.openTerminalQuietly(paneId, noteLeaf);
	}
}

/** Obsidian's `isShown`, where it exists; a leaf without it counts as shown. */
function leafShown(leaf: WorkspaceLeaf): boolean {
	const el = leaf.view?.containerEl as (HTMLElement & { isShown?: () => boolean }) | undefined;
	return typeof el?.isShown === 'function' ? el.isShown() : true;
}

/** The note a leaf's persisted state says it shows, when it is a markdown view. */
function markdownFileOf(leaf: WorkspaceLeaf | null): string | null {
	if (!leaf) return null;
	const viewState = leaf.getViewState();
	if (viewState.type !== 'markdown') return null;
	const file = viewState.state?.file;
	return typeof file === 'string' ? file : null;
}

/**
 * Hangs the follower on the workspace for the life of the plugin, and keeps
 * the herdr focus order it breaks ties with from the scope's transitions.
 * Called from `onLayoutReady`.
 */
export function registerNoteFollow(plugin: HerdrPlugin): void {
	const app = plugin.app;
	const workspace = app.workspace;
	const recency = new FocusRecency();

	// The focus order lives on the connection's scope: a new scope is new pane
	// ids, so the order starts over with it.
	let unsubscribe: Unsubscribe[] = [];
	const bind = (): void => {
		for (const off of unsubscribe) off();
		unsubscribe = [];
		recency.reset();
		const scope = plugin.scope;
		if (!scope) return;
		unsubscribe = [
			scope.on('added', (pane) => recency.observe(pane, false)),
			scope.on('changed', (_paneId, prev, next) => recency.observe(next, prev.focused)),
			scope.on('removed', (pane) => recency.forget(pane.paneId)),
		];
	};
	bind();
	plugin.register(plugin.onScopeReplaced(bind));
	plugin.register(() => {
		for (const off of unsubscribe) off();
		unsubscribe = [];
	});

	const terminalLeaf = (paneId: string): WorkspaceLeaf | null => {
		const endpointId = plugin.endpoint.id;
		for (const leaf of workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
			if (stateMatchesPane(leaf.getViewState().state, paneId, endpointId)) return leaf;
		}
		return null;
	};

	const follower = new NoteFollower<WorkspaceLeaf>({
		enabled: () => plugin.settings.followActiveNote === true,
		minDepth: () => clampFollowDepth(plugin.settings.followActiveNoteMinDepth),
		rowClick: () => plugin.settings.agentListRowClick,
		vaultPath: () => plugin.herdrVaultPath(),
		endpointId: () => plugin.endpoint.id,
		panes: () => plugin.scope?.list() ?? null,
		pinned: (paneId) => isPanePinned(plugin.settings, plugin.endpoint.id, paneId),
		focusRank: (pane) => recency.rank(pane),
		terminalPresence: (paneId) => {
			const leaf = terminalLeaf(paneId);
			if (!leaf) return 'none';
			return !leaf.isDeferred && leafShown(leaf) ? 'shown' : 'hidden';
		},
		openTerminalQuietly: async (paneId, noteLeaf) => {
			await plugin.openTerminal(paneId, undefined, { focus: false });
			// A note the new terminal tab now covers is not handed the leaf back:
			// that would bring it to the front and hide the terminal again.
			const active = workspace.getActiveViewOfType(View)?.leaf ?? null;
			if (active !== noteLeaf && leafShown(noteLeaf)) {
				workspace.setActiveLeaf(noteLeaf, { focus: true });
			}
		},
		focusPane: (paneId) => {
			void plugin.actions.focusPane(paneId);
		},
	});

	plugin.registerEvent(
		workspace.on('active-leaf-change', (leaf) => {
			const file = markdownFileOf(leaf);
			if (leaf && file) void follower.noteFocused(file, leaf);
		}),
	);
	// Opening another note in the same leaf activates no leaf.
	plugin.registerEvent(
		workspace.on('file-open', (file: TFile | null) => {
			if (!file || file.extension !== 'md') return;
			const leaf = workspace.getActiveViewOfType(View)?.leaf ?? null;
			if (leaf && markdownFileOf(leaf) === file.path) void follower.noteFocused(file.path, leaf);
		}),
	);
}
