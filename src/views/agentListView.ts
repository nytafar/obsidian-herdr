/**
 * Agent list sidebar view (PRD M8, M9, M10, N1, N4; T4).
 *
 * One row per agent pane of the scoped workspace, grouped by herdr tab, by
 * working directory or not at all (issue #20): the harness mark, coloured by the
 * agent's status (issue #34), the agent name, the stripped terminal title, and
 * the cwd relative to the vault. A row carries two one-click actions — open the
 * pane as a terminal view in Obsidian (PRD M13) and focus it in herdr
 * (`pane.focus`, the one source of truth for "seen", PRD M9). The row body gets
 * the first and the icon button the second, and a setting swaps them (issue #21).
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
 * The toolbar under the rows holds three `clickable-icon` buttons (issues #41,
 * #44): the sort and group-by menu, "start agent in the vault", and a quick
 * settings menu. What the two menus contain is `listMenu.ts` and
 * `quickSettings.ts`, both pure and tested; choosing an entry writes the same
 * settings the settings tab writes and repaints every open list. A fourth
 * button, shown only when a remote host is configured, switches the list
 * between the local and the remote herdr (issue #54): it flips
 * `settings.remote.enabled` and reconnects. Terminals already open stay pinned
 * to the endpoint they started on.
 *
 * A right-click on a row opens its context menu (issue #35): pin the row to the
 * top of its group, rename the agent, close the pane. `rowMenu.ts` says what
 * the menu holds and what the two modals say; this file only draws the `Menu`,
 * shows the modal, and calls the plugin.
 *
 * Guidelines followed here: no `innerHTML` (everything via `createEl`), no inline
 * styles (see `styles.css`), one delegated `registerDomEvent` instead of a
 * listener per row, and no stored view reference anywhere else — `main.ts` finds
 * this view with `getLeavesOfType`.
 */

import { ItemView, Menu, setIcon, setTooltip, type WorkspaceLeaf } from 'obsidian';
import type HerdrPlugin from '../main';
import { pinnedPaneIds, togglePanePin, type HerdrSettings } from '../settings';
import { ConfirmModal, PromptModal } from './modals';
import { closeConfirmation, renamePrompt, rowMenuItems, type RowMenuItem, type RowMenuRow } from './rowMenu';
import { iconForKind, isKindIcon, kindStatusLabel } from './kindIcons';
import { SECTION_LABEL, listMenuItems, type ListMenuItem, type ListMenuSection } from './listMenu';
import { buildRows, isRowClickAction, rowActions, type RowGroup, type RowModel } from './rowModel';
import { quickSettingsItems, type QuickSettingsItem } from './quickSettings';
import { asElement } from './dom';

export const AGENT_LIST_VIEW_TYPE = 'herdr-agents';

/** What the local/remote toggle in the toolbar shows (issue #54). */
export interface EndpointToggle {
	/** Hidden entirely unless a remote host is configured. */
	shown: boolean;
	/** True while the remote profile is the connected one. */
	remote: boolean;
	icon: string;
	/** Tooltip and aria-label: what a click does, not what is on. */
	label: string;
}

/**
 * The toggle is a picture of where the list points (`laptop` for the local
 * herdr, `server` for the remote one) and a label naming the other side, so a
 * click reads as "switch to". Without a host there is nothing to switch to.
 */
export function endpointToggle(settings: Pick<HerdrSettings, 'remote'>): EndpointToggle {
	const host = settings.remote.host.trim();
	const remote = settings.remote.enabled;
	return {
		shown: host.length > 0,
		remote,
		icon: remote ? 'server' : 'laptop',
		label: remote ? 'Switch to local herdr' : `Switch to remote herdr (${host})`,
	};
}

export class AgentListView extends ItemView {
	private readonly plugin: HerdrPlugin;
	private listEl: HTMLElement | null = null;
	/** The local/remote toggle (issue #54); null until the toolbar is built. */
	private endpointToggleEl: HTMLElement | null = null;
	private pendingRender = 0;
	/** Unsubscribes from the scope and label cache bound; replaced by `bindScope`. */
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
		this.renderToolbar(container);

		// One delegated listener beats one per row: rows are rebuilt on every
		// scope event, and per-row registrations would pile up on the component.
		this.registerDomEvent(container, 'click', (event) => this.onClick(event));
		this.registerDomEvent(container, 'keydown', (event) => this.onKeyDown(event));
		this.registerDomEvent(container, 'contextmenu', (event) => this.onContextMenu(event));

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

	/**
	 * The row of controls under the rows (issues #41, #44): sort and group, start
	 * an agent at the vault root, and the quick settings menu. Built once in
	 * `onOpen`, outside `listEl`, so a repaint never touches it.
	 *
	 * Below the list rather than above it, and without a title: the view already
	 * carries "Herdr agents" in its tab, and a toolbar at the bottom keeps the
	 * first row of agents at the top of the pane where the eye starts.
	 */
	private renderToolbar(container: HTMLElement): void {
		const bar = container.createDiv({ cls: 'herdr-list-toolbar' });
		// Leftmost, apart from the three menu buttons: it changes what the whole
		// list shows rather than how. Hidden unless a remote host is configured.
		this.endpointToggleEl = this.toolbarButton(bar, 'laptop', 'Switch to remote herdr', () => {
			void this.toggleEndpoint();
		});
		this.endpointToggleEl.addClass('herdr-endpoint-toggle');
		this.updateEndpointToggle();
		this.toolbarButton(bar, 'arrow-down-up', 'Sort and group', (event) =>
			this.openListMenu(event),
		);
		this.toolbarButton(bar, 'plus', 'Start agent in the vault', () => {
			// The same flow as the folder menu, at the vault root: it honours the
			// share-a-tab setting (issue #29) and reports its own failures.
			void this.plugin.actions.startAgentHere(this.plugin.herdrVaultPath());
		});
		this.toolbarButton(bar, 'settings-2', 'Quick settings', (event) =>
			this.openQuickSettings(event),
		);
	}

	/** One `clickable-icon` button in the toolbar, labelled for pointer and reader. */
	private toolbarButton(
		bar: HTMLElement,
		icon: string,
		label: string,
		onClick: (event: MouseEvent) => void,
	): HTMLElement {
		const button = bar.createEl('button', {
			cls: 'clickable-icon herdr-list-menu-button',
			attr: { type: 'button' },
		});
		setIcon(button, icon);
		setTooltip(button, label);
		button.setAttribute('aria-label', label);
		this.registerDomEvent(button, 'click', onClick);
		return button;
	}

	/**
	 * The local/remote switch (issue #54): the same flip the settings toggle
	 * does, followed by the same reconnect, without the debounce a typed field
	 * needs. Open terminals are left alone; each stays pinned to its endpoint.
	 */
	private async toggleEndpoint(): Promise<void> {
		const settings = this.plugin.settings;
		if (settings.remote.host.trim().length === 0) return;
		settings.remote.enabled = !settings.remote.enabled;
		this.updateEndpointToggle();
		await this.plugin.saveSettings();
		await this.plugin.reconnect();
	}

	/** Icon, label, active state and visibility from the settings as they are. */
	private updateEndpointToggle(): void {
		const el = this.endpointToggleEl;
		if (!el) return;
		const toggle = endpointToggle(this.plugin.settings);
		el.toggleClass('herdr-hidden', !toggle.shown);
		el.toggleClass('is-active', toggle.remote);
		setIcon(el, toggle.icon);
		setTooltip(el, toggle.label);
		el.setAttribute('aria-label', toggle.label);
	}

	/**
	 * The quick settings menu (issue #44): the handful of choices that change how
	 * the list and its terminals behave, one click from the list instead of a
	 * window away. The settings tab still explains them and owns everything else.
	 */
	private openQuickSettings(event: MouseEvent): void {
		const menu = new Menu();
		let section = '';
		for (const item of quickSettingsItems(this.plugin.settings)) {
			if (item.section !== section) {
				if (section !== '') menu.addSeparator();
				section = item.section;
				menu.addItem((entry) => entry.setTitle(section).setIsLabel(true));
			}
			menu.addItem((entry) =>
				entry
					.setTitle(item.label)
					.setChecked(item.checked)
					.onClick(() => void this.applyQuickSetting(item)),
			);
		}
		menu.showAtMouseEvent(event);
	}

	/** Writes one quick setting, saves it, and lets its owner react. */
	private async applyQuickSetting(item: QuickSettingsItem): Promise<void> {
		item.apply(this.plugin.settings);
		await this.plugin.saveSettings();
		// The explorer buttons are attached, not rendered, so they need telling.
		if (item.effect === 'folder-button') this.plugin.refreshFolderHoverButton();
		this.plugin.refreshAgentList();
	}

	/**
	 * Opens the sort and group-by menu at the pointer. Enter on the button counts:
	 * the browser turns it into a click, and the menu then takes the keyboard.
	 */
	private openListMenu(event: MouseEvent): void {
		const menu = new Menu();
		let section: ListMenuSection | null = null;
		for (const item of listMenuItems(this.plugin.settings)) {
			if (item.section !== section) {
				if (section !== null) menu.addSeparator();
				section = item.section;
				const heading = SECTION_LABEL[section];
				menu.addItem((entry) => entry.setTitle(heading).setIsLabel(true));
			}
			menu.addItem((entry) =>
				entry
					.setTitle(item.label)
					.setChecked(item.checked)
					.onClick(() => void this.applyMenuChoice(item)),
			);
		}
		menu.showAtMouseEvent(event);
	}

	/**
	 * Writes one menu choice: the same settings the settings tab writes, saved the
	 * same way, and then every open list repaints — this one included, which is
	 * why it goes through the plugin rather than calling `refresh()` here.
	 */
	private async applyMenuChoice(item: ListMenuItem): Promise<void> {
		item.apply(this.plugin.settings);
		await this.plugin.saveSettings();
		this.plugin.refreshAgentList();
	}

	protected override async onClose(): Promise<void> {
		for (const off of this.unbindScope.splice(0)) off();
		this.listEl = null;
		this.contentEl.empty();
	}

	/**
	 * Subscribes to the plugin's current scope and its tab-label cache, dropping
	 * the previous pair. Tab labels are the cache's business (issue #43): it
	 * fetches once per workspace for every view on the connection, applies
	 * `tab_renamed` in place, and drops answers from a connection or workspace
	 * that has moved on. This view only tells it when a pane brings a tab it may
	 * not have covered, and repaints when it says something changed.
	 */
	private bindScope(): void {
		for (const off of this.unbindScope.splice(0)) off();
		const scope = this.plugin.scope;
		const labels = this.plugin.tabLabelsFor(this.plugin.endpoint.id);
		if (scope) {
			this.unbindScope.push(
				scope.on('added', (pane) => {
					// Bounded: the cache asks once per genuinely new tab, never per repaint.
					labels?.ensure(pane.tabId);
					this.scheduleRender();
				}),
				scope.on('removed', () => this.scheduleRender()),
				scope.on('changed', () => this.scheduleRender()),
				scope.on('workspaceResolved', () => this.scheduleRender()),
			);
		}
		if (labels) {
			this.unbindScope.push(labels.subscribe(() => this.scheduleRender()));
			labels.ensure();
		}
		this.render();
	}

	/**
	 * Repaints on the next frame. Called by the plugin when a setting the row
	 * model reads has changed (issue #20); the render path re-reads the settings
	 * itself, so nothing has to be passed in.
	 */
	refresh(): void {
		this.scheduleRender();
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
		// The host may have been typed into settings since the toolbar was built,
		// and the settings tab's own toggle flips the same flag.
		this.updateEndpointToggle();

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

		// Settings are read here, once per repaint, so changing the sort or the
		// grouping reorders the list on the next render and never reconnects.
		const settings = this.plugin.settings;
		// Labels are read, never fetched, from here (issue #43).
		const tabLabels = this.plugin.tabLabelsFor(this.plugin.endpoint.id)?.labels() ?? new Map<string, string>();
		const groups = buildRows(panes, tabLabels, this.plugin.herdrVaultPath(), {
			groupBy: settings.agentListGroupBy,
			sort: settings.agentListSort,
			homePath: this.plugin.herdrHomePath(),
			// Pins are per endpoint (issue #35): a local pane id says nothing about
			// a remote pane that happens to share it.
			pinnedPaneIds: pinnedPaneIds(settings, this.plugin.endpoint.id),
		});
		for (const group of groups) this.renderGroup(list, group);
	}

	private renderGroup(parent: HTMLElement, group: RowGroup): void {
		const groupEl = parent.createDiv({ cls: 'herdr-tab-group' });
		// An empty label is grouping "none": one group, no header at all.
		if (group.label) {
			const label = groupEl.createDiv({ cls: 'herdr-tab-label', text: group.label });
			// An abridged folder heading (issue #46) keeps the full path within reach.
			if (group.tooltip) {
				setTooltip(label, group.tooltip);
				label.setAttribute('aria-label', group.tooltip);
			}
		}
		for (const row of group.rows) this.renderRow(groupEl, row);
	}

	private renderRow(parent: HTMLElement, model: RowModel): void {
		const rowClasses = ['herdr-agent-row'];
		if (model.focused) rowClasses.push('is-focused');
		if (model.pinned) rowClasses.push('is-pinned');
		const row = parent.createDiv({ cls: rowClasses });
		row.dataset.paneId = model.paneId;
		row.tabIndex = 0;
		row.setAttribute('role', 'button');

		// The harness mark (issue #19), which since issue #34 also carries the
		// status: the `herdr-status-*` class colours the mark itself, so the row
		// needs no separate dot. Registered marks are fill-based and need the
		// modifier class; the Lucide fallback keeps its stroke, so it must not get
		// it (see `styles.css`). Colour is not a label, so the accessible name says
		// both halves — "Claude, blocked".
		const icon = iconForKind(model.kind);
		const iconLabel = kindStatusLabel(model.kind, model.statusLabel);
		const kindClasses = ['herdr-agent-kind', `herdr-status-${model.status}`];
		if (isKindIcon(icon)) kindClasses.push('mod-brand');
		const kindEl = row.createSpan({ cls: kindClasses });
		setIcon(kindEl, icon);
		setTooltip(kindEl, iconLabel);
		kindEl.setAttribute('aria-label', iconLabel);

		const text = row.createDiv({ cls: 'herdr-agent-text' });
		const line = text.createDiv({ cls: 'herdr-agent-line' });
		// The row reads mark, countdown, name (issue #40). The badge comes first
		// because it is fixed width and the name is not: after the name it was the
		// part a long title pushed out of the row, under the action button.
		for (const badge of model.badges) {
			line.createSpan({ cls: `herdr-agent-badge mod-${badge.tone}`, text: badge.text });
		}
		line.createSpan({ cls: 'herdr-agent-name', text: model.displayName });
		if (model.title) line.createSpan({ cls: 'herdr-agent-title', text: model.title });
		// The pin marker (issue #35) sits after the name, where it reads as a
		// property of the row and not as one more badge in the countdown slot.
		if (model.pinned) {
			const pin = line.createSpan({ cls: 'herdr-agent-pin' });
			setIcon(pin, 'pin');
			setTooltip(pin, 'Pinned');
			pin.setAttribute('aria-label', 'Pinned');
		}
		if (model.pathLabel) {
			const cwd = text.createDiv({ cls: 'herdr-agent-cwd', text: model.pathLabel });
			// Only set when the label was cut short (issue #46); otherwise the
			// tooltip would repeat what the row already says.
			if (model.pathTooltip) {
				setTooltip(cwd, model.pathTooltip);
				cwd.setAttribute('aria-label', model.pathTooltip);
			}
		}

		// The row body and the button hold one action each, and which is which is
		// a setting (issue #21). The button is drawn on every row but only shown on
		// hover or focus (issue #42), which is `styles.css` alone: it stays in the
		// tab order and in the layout, so nothing here changes with the pointer.
		// The button records its own action in the dataset,
		// so a click is dispatched by what was drawn — and promised in the tooltip
		// — rather than by a setting that may have changed since the last repaint.
		const actions = rowActions(this.plugin.settings.agentListRowClick);
		const button = row.createEl('button', {
			cls: 'clickable-icon herdr-row-action',
			attr: { type: 'button' },
		});
		button.dataset.herdrAction = actions.button;
		setIcon(button, actions.buttonIcon);
		setTooltip(button, actions.buttonLabel);
		button.setAttribute('aria-label', actions.buttonLabel);
	}

	private onClick(event: MouseEvent): void {
		const target = asElement(event.target);
		if (!target) return;
		const row = target.closest<HTMLElement>('[data-pane-id]');
		const paneId = row?.dataset.paneId;
		if (!paneId) return;
		event.preventDefault();
		this.runRowAction(target, paneId);
	}

	/**
	 * Right-click on a row: the row menu (issue #35). Anywhere else in the view
	 * is left to the browser, so the toolbar keeps its default menu.
	 */
	private onContextMenu(event: MouseEvent): void {
		const target = asElement(event.target);
		const rowEl = target?.closest<HTMLElement>('[data-pane-id]');
		const paneId = rowEl?.dataset.paneId;
		if (!paneId) return;
		const pane = this.plugin.scope?.get(paneId);
		if (!pane) return;
		event.preventDefault();
		const row: RowMenuRow = {
			paneId,
			displayName: rowEl.querySelector('.herdr-agent-name')?.textContent ?? paneId,
			pinned: rowEl.hasClass('is-pinned'),
			name: pane.name,
		};
		const menu = new Menu();
		for (const item of rowMenuItems(row)) {
			if (item.separatorBefore) menu.addSeparator();
			menu.addItem((entry) => {
				entry
					.setTitle(item.label)
					.setIcon(item.icon)
					.onClick(() => void this.runRowMenuAction(item, row));
				if (item.warning) entry.setWarning(true);
			});
		}
		menu.showAtMouseEvent(event);
	}

	/** Runs one row menu entry: asks where the entry asks, then calls the plugin. */
	private async runRowMenuAction(item: RowMenuItem, row: RowMenuRow): Promise<void> {
		const plugin = this.plugin;
		switch (item.action) {
			case 'pin':
			case 'unpin':
				togglePanePin(plugin.settings, plugin.endpoint.id, row.paneId);
				await plugin.saveSettings();
				plugin.refreshAgentList();
				return;
			case 'rename': {
				const name = await new PromptModal(this.app, renamePrompt(row)).ask();
				if (name === null) return;
				await plugin.actions.renameAgent(row.paneId, name);
				return;
			}
			case 'close': {
				const text = closeConfirmation(row);
				const yes = await new ConfirmModal(this.app, { ...text, warning: true }).ask();
				if (!yes) return;
				if (await plugin.actions.closePane(row.paneId)) {
					// A closed pane's id is gone for good; keep the pin list honest.
					if (row.pinned) {
						togglePanePin(plugin.settings, plugin.endpoint.id, row.paneId);
						await plugin.saveSettings();
					}
				}
				return;
			}
		}
	}

	/** Keyboard mirrors the pointer, including which half of the pair fires. */
	private onKeyDown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		const target = asElement(event.target);
		if (!target) return;
		const row = target.closest<HTMLElement>('[data-pane-id]');
		const paneId = row?.dataset.paneId;
		if (!paneId) return;
		// Also stops the browser turning Enter on the button into a second click.
		event.preventDefault();
		this.runRowAction(target, paneId);
	}

	/**
	 * Runs the action the clicked element carries: the icon button's own, when
	 * the event came from it, and the row body's otherwise (issue #21).
	 *
	 * `Element`, not `HTMLElement`: a click that lands on the button's Lucide
	 * glyph has an `SVGPathElement` as its target, and an `HTMLElement` guard
	 * would drop exactly the clicks this issue is about.
	 */
	private runRowAction(target: Element, paneId: string): void {
		const drawn = target.closest<HTMLElement>('[data-herdr-action]')?.dataset.herdrAction;
		const action = isRowClickAction(drawn)
			? drawn
			: rowActions(this.plugin.settings.agentListRowClick).body;
		if (action === 'terminal') void this.plugin.openTerminal(paneId);
		else void this.plugin.actions.focusPane(paneId);
	}
}
