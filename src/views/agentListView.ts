/**
 * Agent list sidebar view (PRD M8, M9, M10, N1, N4; T4).
 *
 * One row per agent pane of the scoped workspace, grouped by herdr tab:
 * status glyph, agent name, stripped terminal title, and the cwd relative to the
 * vault. Clicking a row focuses that pane in herdr (`pane.focus`), which is the
 * one source of truth for "seen" (PRD M9); the icon button opens the pane as a
 * terminal view in Obsidian.
 *
 * Rendering discipline (PRD N4): the view never listens to the raw event stream.
 * `WorkspaceScope` already swallows the ~10 `pane.updated` per second that only
 * bump `revision`, so this view re-renders only on its `added` / `changed` /
 * `removed` / `workspaceResolved` events, and even those are coalesced into one
 * repaint per frame.
 *
 * Guidelines followed here: no `innerHTML` (everything via `createEl`), no inline
 * styles (see `styles.css`), one delegated `registerDomEvent` instead of a
 * listener per row, and no stored view reference anywhere else — `main.ts` finds
 * this view with `getLeavesOfType`.
 */

import { ItemView, setIcon, setTooltip, type WorkspaceLeaf } from 'obsidian';
import type HerdrPlugin from '../main';
import { isUnder, stripTitleSpinner, type PaneState } from '../herdr/scope';
import type { AgentStatus, TabInfo } from '../herdr/types.gen';

export const AGENT_LIST_VIEW_TYPE = 'herdr-agents';

/** Order agents are shown in: the ones wanting attention float to the top. */
const STATUS_ORDER: Record<AgentStatus, number> = {
	blocked: 0,
	done: 1,
	working: 2,
	idle: 3,
	unknown: 4,
};

/** Screen-reader text per status; the glyph itself is CSS (`styles.css`). */
const STATUS_LABEL: Record<AgentStatus, string> = {
	blocked: 'Blocked',
	done: 'Done',
	working: 'Working',
	idle: 'Idle',
	unknown: 'Unknown',
};

/** Panes of one herdr tab, in display order. */
export interface TabGroup {
	tabId: string;
	label: string;
	panes: PaneState[];
}

/**
 * What a row calls an agent (PRD M8): its herdr name, else the stripped terminal
 * title, else the pane id. Never `pane.agent`, which is only the kind.
 */
export function agentDisplayName(pane: PaneState): string {
	return pane.name.trim() || pane.title.trim() || pane.paneId;
}

/** Counts the statuses the status bar cares about (PRD S11). */
export function countStatuses(panes: readonly PaneState[]): { blocked: number; done: number } {
	let blocked = 0;
	let done = 0;
	for (const pane of panes) {
		if (pane.agentStatus === 'blocked') blocked++;
		else if (pane.agentStatus === 'done') done++;
	}
	return { blocked, done };
}

/**
 * The cwd as shown in a row: relative to the vault when it sits inside it, the
 * absolute path otherwise (a herdr pane may well run outside the vault). The
 * vault root itself renders as an empty string, since repeating the vault name
 * on every row says nothing.
 */
export function relativeCwd(cwd: string, vaultPath: string): string {
	if (!cwd) return '';
	const root = vaultPath.replace(/\/+$/, '');
	if (!root || !isUnder(cwd, root)) return cwd;
	return cwd.slice(root.length).replace(/^\/+/, '');
}

/**
 * Groups panes by tab and sorts them: tabs by their most urgent pane, then by
 * label; panes by status, then title. Pure, so it is testable without a DOM.
 */
export function groupByTab(
	panes: readonly PaneState[],
	tabLabels: ReadonlyMap<string, string>,
): TabGroup[] {
	const groups = new Map<string, TabGroup>();
	for (const pane of panes) {
		let group = groups.get(pane.tabId);
		if (!group) {
			group = { tabId: pane.tabId, label: tabLabels.get(pane.tabId) ?? pane.tabId, panes: [] };
			groups.set(pane.tabId, group);
		}
		group.panes.push(pane);
	}
	const urgency = (group: TabGroup): number =>
		Math.min(...group.panes.map((pane) => STATUS_ORDER[pane.agentStatus] ?? 9));
	const list = [...groups.values()];
	for (const group of list) {
		group.panes.sort(
			(a, b) =>
				(STATUS_ORDER[a.agentStatus] ?? 9) - (STATUS_ORDER[b.agentStatus] ?? 9) ||
				a.title.localeCompare(b.title) ||
				a.paneId.localeCompare(b.paneId),
		);
	}
	list.sort((a, b) => urgency(a) - urgency(b) || a.label.localeCompare(b.label));
	return list;
}

export class AgentListView extends ItemView {
	private readonly plugin: HerdrPlugin;
	private listEl: HTMLElement | null = null;
	private tabLabels = new Map<string, string>();
	private pendingRender = 0;
	private tabLabelsInFlight = false;

	constructor(leaf: WorkspaceLeaf, plugin: HerdrPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return AGENT_LIST_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Herdr agents';
	}

	override getIcon(): string {
		return 'bot';
	}

	protected override async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass('herdr-agent-list');
		this.listEl = container.createDiv({ cls: 'herdr-agent-list-body' });

		// One delegated listener beats one per row: rows are rebuilt on every
		// scope event, and per-row registrations would pile up on the component.
		this.registerDomEvent(container, 'click', (event) => this.onClick(event));
		this.registerDomEvent(container, 'keydown', (event) => this.onKeyDown(event));

		const scope = this.plugin.scope;
		if (scope) {
			this.register(scope.on('added', () => this.scheduleRender()));
			this.register(scope.on('removed', () => this.scheduleRender()));
			this.register(scope.on('changed', () => this.scheduleRender()));
			this.register(
				scope.on('workspaceResolved', () => {
					this.tabLabels.clear();
					this.scheduleRender();
				}),
			);
		}
		this.register(() => {
			if (this.pendingRender) window.clearTimeout(this.pendingRender);
			this.pendingRender = 0;
		});

		this.render();
		void this.refreshTabLabels();
	}

	protected override async onClose(): Promise<void> {
		this.listEl = null;
		this.contentEl.empty();
	}

	/** Coalesces a burst of scope events into a single repaint. */
	private scheduleRender(): void {
		if (this.pendingRender) return;
		this.pendingRender = window.setTimeout(() => {
			this.pendingRender = 0;
			this.render();
		}, 0);
	}

	/** Rebuilds the rows. Cheap: a scoped workspace holds tens of panes, not thousands. */
	private render(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();

		const scope = this.plugin.scope;
		if (!scope || !scope.workspaceId) {
			list.createDiv({
				cls: 'herdr-empty',
				text: scope
					? 'No herdr workspace matches this vault yet.'
					: 'Not connected to herdr.',
			});
			return;
		}
		const panes = scope.list();
		if (panes.length === 0) {
			list.createDiv({ cls: 'herdr-empty', text: 'No agents in this workspace.' });
			return;
		}

		const groups = groupByTab(panes, this.tabLabels);
		if (groups.some((group) => !this.tabLabels.has(group.tabId))) void this.refreshTabLabels();

		const vaultPath = this.plugin.herdrVaultPath();
		for (const group of groups) {
			const groupEl = list.createDiv({ cls: 'herdr-tab-group' });
			groupEl.createDiv({ cls: 'herdr-tab-label', text: group.label });
			for (const pane of group.panes) this.renderRow(groupEl, pane, vaultPath);
		}
	}

	private renderRow(parent: HTMLElement, pane: PaneState, vaultPath: string): void {
		const row = parent.createDiv({
			cls: pane.focused ? 'herdr-agent-row is-focused' : 'herdr-agent-row',
		});
		row.dataset.paneId = pane.paneId;
		row.tabIndex = 0;
		row.setAttribute('role', 'button');

		const glyph = row.createSpan({
			cls: `herdr-status-glyph herdr-status-${pane.agentStatus}`,
		});
		glyph.setAttribute('aria-label', STATUS_LABEL[pane.agentStatus] ?? pane.agentStatus);

		const text = row.createDiv({ cls: 'herdr-agent-text' });
		const line = text.createDiv({ cls: 'herdr-agent-line' });
		// `pane.agent` is the kind ("claude") and is the same on every row, so it
		// is never the name: the agent's own name comes from `agent.list`
		// (scope.setAgentNames), then the stripped title, then the pane id.
		const name = agentDisplayName(pane);
		line.createSpan({ cls: 'herdr-agent-name', text: name });
		if (pane.title && pane.title !== name) {
			line.createSpan({ cls: 'herdr-agent-title', text: pane.title });
		}
		const cwd = relativeCwd(pane.cwd, vaultPath);
		if (cwd) text.createDiv({ cls: 'herdr-agent-cwd', text: cwd });

		const button = row.createEl('button', {
			cls: 'clickable-icon herdr-row-action',
			attr: { type: 'button' },
		});
		button.dataset.herdrAction = 'terminal';
		setIcon(button, 'square-terminal');
		setTooltip(button, 'Open terminal');
		button.setAttribute('aria-label', 'Open terminal');
	}

	private onClick(event: MouseEvent): void {
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		const row = target.closest<HTMLElement>('[data-pane-id]');
		const paneId = row?.dataset.paneId;
		if (!paneId) return;
		event.preventDefault();
		if (target.closest('[data-herdr-action="terminal"]')) {
			void this.plugin.openTerminal(paneId);
			return;
		}
		void this.plugin.actions.focusPane(paneId);
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		const row = target.closest<HTMLElement>('[data-pane-id]');
		const paneId = row?.dataset.paneId;
		if (!paneId) return;
		event.preventDefault();
		if (target.closest('[data-herdr-action="terminal"]')) void this.plugin.openTerminal(paneId);
		else void this.plugin.actions.focusPane(paneId);
	}

	/**
	 * Fills in tab labels with one read-only `tab.list`. Rows fall back to the
	 * tab id until this lands, so a failure here is cosmetic and stays silent.
	 * `tab.list` is optional (PRD M3): a herdr without it says so once through
	 * the client's `onUnsupportedMethod` notice, and `requestOptional` then
	 * returns null for good, so this stops asking.
	 */
	private async refreshTabLabels(): Promise<void> {
		const client = this.plugin.client;
		const workspaceId = this.plugin.scope?.workspaceId;
		if (!client || !workspaceId || this.tabLabelsInFlight) return;
		if (client.isUnsupported('tab.list')) return;
		this.tabLabelsInFlight = true;
		try {
			const result = await client.requestOptional<{ tabs?: TabInfo[] }>('tab.list', {
				workspace_id: workspaceId,
			});
			const labels = new Map<string, string>();
			for (const tab of result?.tabs ?? []) {
				if (typeof tab?.tab_id !== 'string') continue;
				// Live `tab.list` labels carry herdr's own status prefix ("! trauma",
				// "? vault-maintenance"); the row's status dot already says that.
				const label = tab.label ? stripTitleSpinner(tab.label) : '';
				labels.set(tab.tab_id, label || tab.tab_id);
			}
			if (labels.size > 0) {
				this.tabLabels = labels;
				this.render();
			}
		} catch {
			// Unknown method or a dead socket: keep showing tab ids.
		} finally {
			this.tabLabelsInFlight = false;
		}
	}
}
