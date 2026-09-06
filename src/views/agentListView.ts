/**
 * Agent list sidebar view (PRD M8, M9, M10, N1, N4; T4).
 *
 * One row per agent pane of the scoped workspace, grouped by herdr tab:
 * status glyph, agent name, stripped terminal title, and the cwd relative to the
 * vault. Clicking a row focuses that pane in herdr (`pane.focus`), which is the
 * one source of truth for "seen" (PRD M9); the icon button opens the pane as a
 * terminal view in Obsidian.
 *
 * This file owns DOM and events only. What a row *says* — grouping, ordering,
 * display-name fallbacks, path and status labels — lives in `rowModel.ts`, which
 * is pure and unit tested (issue #16). `render()` asks for `RowGroup[]` and
 * creates elements; it decides nothing and fetches nothing.
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
import { stripTitleSpinner } from '../herdr/scope';
import type { TabInfo } from '../herdr/types.gen';
import { buildRows, type RowGroup, type RowModel } from './rowModel';

// Re-exported so `main.ts` and the existing tests keep importing the list view's
// helpers from the list view, while the code itself lives in the pure module.
export {
	agentDisplayName,
	buildRows,
	cacheBadge,
	countStatuses,
	pathLabel,
	relativeCwd,
	STATUS_LABEL,
	STATUS_ORDER,
} from './rowModel';
export type { RowBadge, RowGroup, RowModel, RowModelOptions } from './rowModel';

export const AGENT_LIST_VIEW_TYPE = 'herdr-agents';

export class AgentListView extends ItemView {
	private readonly plugin: HerdrPlugin;
	private listEl: HTMLElement | null = null;
	private tabLabels = new Map<string, string>();
	/**
	 * Tab ids a `tab.list` has already covered, whether or not it returned a
	 * label for them. This is what keeps the render path free of round trips: a
	 * pane whose tab herdr never lists would otherwise make every repaint ask
	 * again, and each answer would repaint (see `notes/memory.md`, suspect 8).
	 */
	private askedTabIds = new Set<string>();
	private pendingRender = 0;
	private tabLabelsInFlight = false;
	/** An `added` arrived mid-flight: ask once more when the flight lands. */
	private tabLabelsQueued = false;
	/** Unsubscribes from the scope currently bound; replaced by `bindScope`. */
	private unbindScope: (() => void)[] = [];

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

		this.bindScope();
		// The sidebar is usually restored before `connect()` has built a scope, and
		// a plugin reload rebuilds this view before it too; rebinding on replace is
		// what turns "Not connected to herdr." into rows without a manual reopen.
		this.register(this.plugin.onScopeReplaced(() => this.bindScope()));
		this.register(() => {
			if (this.pendingRender) this.containerEl.win.cancelAnimationFrame(this.pendingRender);
			this.pendingRender = 0;
		});
	}

	protected override async onClose(): Promise<void> {
		for (const off of this.unbindScope.splice(0)) off();
		this.listEl = null;
		this.contentEl.empty();
	}

	/** Subscribes to the plugin's current scope, dropping the previous one. */
	private bindScope(): void {
		for (const off of this.unbindScope.splice(0)) off();
		this.tabLabels.clear();
		this.askedTabIds.clear();
		const scope = this.plugin.scope;
		if (scope) {
			this.unbindScope.push(
				// A new pane can bring a tab this view has never seen a label for, so
				// `added` is where a label fetch belongs — a bounded number of them,
				// one per genuinely new tab, instead of one per repaint.
				scope.on('added', (pane) => {
					if (!this.tabLabels.has(pane.tabId) && !this.askedTabIds.has(pane.tabId)) {
						void this.refreshTabLabels();
					}
					this.scheduleRender();
				}),
				scope.on('removed', () => this.scheduleRender()),
				scope.on('changed', () => this.scheduleRender()),
				scope.on('workspaceResolved', () => {
					// Tab ids belong to a workspace; another workspace's answers say
					// nothing, including about what has already been asked.
					this.tabLabels.clear();
					this.askedTabIds.clear();
					void this.refreshTabLabels();
					this.scheduleRender();
				}),
			);
		}
		this.render();
		void this.refreshTabLabels();
	}

	/**
	 * Coalesces a burst of scope events into one repaint per animation frame, on
	 * the window this view lives in so a popout sidebar still gets frames.
	 */
	private scheduleRender(): void {
		if (this.pendingRender) return;
		this.pendingRender = this.containerEl.win.requestAnimationFrame(() => {
			this.pendingRender = 0;
			this.render();
		});
	}

	/**
	 * Rebuilds the rows. Cheap: a scoped workspace holds tens of panes, not
	 * thousands, and this does no I/O — no request may be started from here, or a
	 * missing answer becomes a repaint loop.
	 */
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

		const groups = buildRows(panes, this.tabLabels, this.plugin.herdrVaultPath(), {
			homePath: this.plugin.herdrHomePath(),
		});
		for (const group of groups) this.renderGroup(list, group);
	}

	private renderGroup(parent: HTMLElement, group: RowGroup): void {
		const groupEl = parent.createDiv({ cls: 'herdr-tab-group' });
		groupEl.createDiv({ cls: 'herdr-tab-label', text: group.label });
		for (const row of group.rows) this.renderRow(groupEl, row);
	}

	private renderRow(parent: HTMLElement, model: RowModel): void {
		const row = parent.createDiv({
			cls: model.focused ? 'herdr-agent-row is-focused' : 'herdr-agent-row',
		});
		row.dataset.paneId = model.paneId;
		row.tabIndex = 0;
		row.setAttribute('role', 'button');

		const glyph = row.createSpan({
			cls: `herdr-status-glyph herdr-status-${model.status}`,
		});
		glyph.setAttribute('aria-label', model.statusLabel);

		const text = row.createDiv({ cls: 'herdr-agent-text' });
		const line = text.createDiv({ cls: 'herdr-agent-line' });
		line.createSpan({ cls: 'herdr-agent-name', text: model.displayName });
		if (model.title) line.createSpan({ cls: 'herdr-agent-title', text: model.title });
		for (const badge of model.badges) {
			line.createSpan({ cls: `herdr-agent-badge mod-${badge.tone}`, text: badge.text });
		}
		if (model.pathLabel) text.createDiv({ cls: 'herdr-agent-cwd', text: model.pathLabel });

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
	 *
	 * Called on `workspaceResolved`, on an `added` pane whose tab is still
	 * unknown, and once from `onOpen` — never from `render()`. The old code asked
	 * from the render path and repainted on the answer, which converges on this
	 * herdr only because `tab.list` happens to return every tab `pane.list`
	 * mentions; a tab it did not mention would spin forever, at one request and one
	 * full DOM rebuild per iteration (`notes/memory.md`, suspect 8). Marking the tab
	 * ids asked makes that impossible regardless of what herdr answers.
	 */
	private async refreshTabLabels(): Promise<void> {
		const client = this.plugin.client;
		const workspaceId = this.plugin.scope?.workspaceId;
		if (!client || !workspaceId) return;
		if (client.isUnsupported('tab.list')) return;
		if (this.tabLabelsInFlight) {
			this.tabLabelsQueued = true;
			return;
		}
		// Snapshot before awaiting: these are the ids this request answers for,
		// and they count as asked even when the answer omits them.
		const asked = new Set(this.plugin.scope?.list().map((pane) => pane.tabId) ?? []);
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
			for (const tabId of asked) this.askedTabIds.add(tabId);
			for (const tabId of labels.keys()) this.askedTabIds.add(tabId);
			if (labels.size > 0) {
				this.tabLabels = labels;
				this.scheduleRender();
			}
		} catch {
			// Unknown method or a dead socket: keep showing tab ids. Nothing is
			// marked asked, so the next new pane may try again.
		} finally {
			this.tabLabelsInFlight = false;
			if (this.tabLabelsQueued) {
				this.tabLabelsQueued = false;
				void this.refreshTabLabels();
			}
		}
	}
}
