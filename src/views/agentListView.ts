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
 * #44): the sort and group-by menu, a quick settings menu, and, at the far
 * right, the + that starts the runtime's default agent at the vault root on a
 * left click and opens its agent catalog on a right click (issue #125,
 * `startMenu.ts`). What the two menus contain is `listMenu.ts` and
 * `quickSettings.ts`, both pure and tested; choosing an entry writes the same
 * settings the settings tab writes and repaints every open list. A fourth
 * button switches the runtime the list shows (issue #54, ADR-0004): hidden
 * with one runtime, a toggle to the other with two, a menu of all of them
 * with three or more; `runtimeSwitcher` in `runtimes.ts` decides which. Any
 * switch reconnects; terminals already open stay pinned to the runtime they
 * started on. "Start agent in the vault" is left out for a runtime whose kind
 * cannot start one.
 *
 * What an event on a row *does* is `rowDispatch.ts` (issue #82): click,
 * right-click and keyboard activation all go there, and it decides between
 * opening the terminal, focusing the pane and the row menu with pin, rename
 * and close (issue #35). This file binds the three delegated listeners and
 * implements the host the dispatcher acts through — the `Menu`, the two
 * modals from `modals.ts`, and the plugin calls — so no decision is taken
 * here and the dispatcher is testable without a view.
 *
 * Guidelines followed here: no `innerHTML` (everything via `createEl`), no inline
 * styles (see `styles.css`), one delegated `registerDomEvent` instead of a
 * listener per row, and no stored view reference anywhere else — `main.ts` finds
 * this view with `getLeavesOfType`.
 */

import { ItemView, Menu, Notice, setIcon, setTooltip, type WorkspaceLeaf } from 'obsidian';
import type HerdrPlugin from '../main';
import type { ConnectionClient, ConnectionScope, EndpointSession } from '../connection';
import type { TabLabels } from '../tabLabels';
import { activeRuntimeOf, issueSentence, runtimeSwitcher } from '../runtimes';
import { ConfirmModal, PromptModal } from './modals';
import type { RowMenuItem } from './rowMenu';
import { RowDispatcher, type PaneRef, type RowDispatchHost } from './rowDispatch';
import { iconForKind, isKindIcon, kindStatusLabel } from './kindIcons';
import { SECTION_LABEL, listMenuItems, type ListMenuItem, type ListMenuSection } from './listMenu';
import { buildRows, rowActions, type RowGroup, type RowModel } from './rowModel';
import { quickSettingsItems, type QuickSettingsItem } from './quickSettings';
import { startButtonLabel, startMenuItems } from './startMenu';
import { getStartedActionOf, renderGetStartedCard, runGetStartedAction } from '../getStarted/card';

export const AGENT_LIST_VIEW_TYPE = 'herdr-agents';

export class AgentListView extends ItemView {
	private readonly plugin: HerdrPlugin;
	private listEl: HTMLElement | null = null;
	/** The runtime switcher (issue #54, ADR-0004); null until the toolbar is built. */
	private endpointToggleEl: HTMLElement | null = null;
	/** "Start agent in the vault", hidden for a kind that cannot start one. */
	private startButtonEl: HTMLElement | null = null;
	private pendingRender = 0;
	/** Unsubscribes from the scope and label cache bound; replaced by `bindScope`. */
	private unbindScope: (() => void)[] = [];
	/** Turns an event on a row into an effect (issue #82). */
	private readonly rows: RowDispatcher<MouseEvent>;

	constructor(leaf: WorkspaceLeaf, plugin: HerdrPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.rows = new RowDispatcher<MouseEvent>(this.rowDispatchHost());
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
		this.renderToolbar(container);
		this.listEl = container.createDiv({ cls: 'herdr-agent-list-body' });

		// One delegated listener beats one per row: rows are rebuilt on every
		// scope event, and per-row registrations would pile up on the component.
		this.registerDomEvent(container, 'click', (event) => this.rows.click(event));
		this.registerDomEvent(container, 'keydown', (event) => this.rows.keyDown(event));
		this.registerDomEvent(container, 'contextmenu', (event) => this.rows.contextMenu(event));
		// The "Get started" card's buttons (ADR-0008), delegated like the rows.
		this.registerDomEvent(container, 'click', (event) => {
			const action = getStartedActionOf(event.target);
			if (action) void runGetStartedAction(this.plugin.getStarted, action);
		});

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
	 * The row of controls above the rows (issues #41, #44): sort and group, start
	 * an agent at the vault root, and the quick settings menu. Built once in
	 * `onOpen`, outside `listEl`, so a repaint never touches it.
	 *
	 * Above the list, in Obsidian's own `nav-header` like the file explorer's
	 * and bookmarks' buttons, so it stays put however many rows there are. It
	 * sat under the rows once and moved with every agent added or removed.
	 */
	private renderToolbar(container: HTMLElement): void {
		const header = container.createDiv({ cls: 'nav-header herdr-list-toolbar' });
		const bar = header.createDiv({ cls: 'nav-buttons-container' });
		// Leftmost, apart from the three menu buttons: it changes what the whole
		// list shows rather than how. Hidden while there is one runtime.
		this.endpointToggleEl = this.toolbarButton(bar, 'laptop', 'Switch runtime', (event) => {
			this.switchRuntime(event);
		});
		this.endpointToggleEl.addClass('herdr-endpoint-toggle');
		this.updateEndpointToggle();
		this.toolbarButton(bar, 'arrow-down-up', 'Sort and group', (event) =>
			this.openListMenu(event),
		);
		this.toolbarButton(bar, 'settings-2', 'Quick settings', (event) =>
			this.openQuickSettings(event),
		);
		// Far right (issue #125): a left click starts the runtime's default
		// agent at the vault root, through the same flow as the folder menu
		// (it honours the share-a-tab setting, issue #29, and reports its own
		// failures); a right click lists the runtime's agent catalog.
		const start = this.toolbarButton(bar, 'plus', 'Start agent in the vault', () => {
			void this.plugin.actions.startAgentHere(this.plugin.herdrVaultPath());
		});
		start.addClass('herdr-start-agent-button');
		this.registerDomEvent(start, 'contextmenu', (event) => {
			// Ours, not the row menu's delegated listener on the container.
			event.preventDefault();
			event.stopPropagation();
			void this.openStartMenu(event);
		});
		this.startButtonEl = start;
		this.updateEndpointToggle();
	}

	/**
	 * The + button's catalog menu (issue #125), once the runtime's probe has
	 * landed: every agent CLI the runtime can start, the default checked, the
	 * ones it cannot greyed with the reason.
	 */
	private async openStartMenu(event: MouseEvent): Promise<void> {
		const catalog = await this.plugin.agentCatalogs.catalog();
		const menu = new Menu();
		for (const item of startMenuItems(catalog)) {
			menu.addItem((entry) => {
				entry.setTitle(item.title).setIcon(item.icon).setChecked(item.checked).setDisabled(item.disabled);
				const launch = item.launch;
				if (launch) {
					entry.onClick(() => void this.plugin.actions.startAgentHere(this.plugin.herdrVaultPath(), launch));
				}
			});
		}
		// The context-menu key reports no pointer; open under the button then.
		const keyboard = event.clientX === 0 && event.clientY === 0;
		const rect = keyboard ? (event.currentTarget as HTMLElement | null)?.getBoundingClientRect() : null;
		menu.showAtPosition(rect ? { x: rect.left, y: rect.bottom } : { x: event.clientX, y: event.clientY });
		this.updateStartButtonLabel();
	}

	/** The + tooltip names the default once the catalog knows it. */
	private updateStartButtonLabel(): void {
		const el = this.startButtonEl;
		if (!el) return;
		setTooltip(el, startButtonLabel(this.plugin.agentCatalogs.cachedCatalog()));
	}

	/** One `clickable-icon` button in the toolbar, labelled for pointer and reader. */
	private toolbarButton(
		bar: HTMLElement,
		icon: string,
		label: string,
		onClick: (event: MouseEvent) => void,
	): HTMLElement {
		const button = bar.createEl('button', {
			cls: 'clickable-icon nav-action-button herdr-list-menu-button',
			attr: { type: 'button' },
		});
		setIcon(button, icon);
		setTooltip(button, label);
		button.setAttribute('aria-label', label);
		this.registerDomEvent(button, 'click', onClick);
		return button;
	}

	/**
	 * The runtime switch (issue #54, ADR-0004). With two runtimes a click goes
	 * to the other one, without the debounce a typed field needs; with three or
	 * more it opens a menu of all of them, the active one checked. Open
	 * terminals are left alone; each stays pinned to its runtime.
	 */
	private switchRuntime(event: MouseEvent): void {
		const switcher = runtimeSwitcher(this.plugin.settings);
		if (switcher.mode === 'toggle' && switcher.next) {
			void this.plugin.switchRuntime(switcher.next.id);
			return;
		}
		if (switcher.mode !== 'menu') return;
		const menu = new Menu();
		for (const entry of switcher.entries) {
			menu.addItem((item) =>
				item
					.setTitle(entry.name)
					.setChecked(entry.checked)
					.onClick(() => void this.plugin.switchRuntime(entry.id)),
			);
		}
		menu.showAtMouseEvent(event);
	}

	/**
	 * Icon, label, pressed state and visibility of the switcher, and whether
	 * the start button applies, from the registry and kind as they are now.
	 */
	private updateEndpointToggle(): void {
		const start = this.startButtonEl;
		if (start) {
			start.toggleClass('herdr-hidden', !this.plugin.capabilities().startAgent);
			this.updateStartButtonLabel();
			// Again once the runtime's probe has landed, to name its default.
			void this.plugin.agentCatalogs.catalog().then(() => this.updateStartButtonLabel());
		}
		const el = this.endpointToggleEl;
		if (!el) return;
		const switcher = runtimeSwitcher(this.plugin.settings);
		el.toggleClass('herdr-hidden', switcher.mode === 'hidden');
		el.toggleClass('is-active', switcher.remote);
		setIcon(el, switcher.icon);
		setTooltip(el, switcher.label);
		el.setAttribute('aria-label', switcher.label);
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
	 * The connection the list shows: the published one, whichever endpoint that
	 * is (issue #81). One lookup answers with the scope, the tab labels and the
	 * endpoint together; null means nothing is connected.
	 */
	private session(): EndpointSession<ConnectionClient, ConnectionScope, TabLabels> | null {
		return this.plugin.endpointSession(this.plugin.endpoint.id);
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
		const session = this.session();
		const scope = session?.scope;
		const labels = session?.tabLabels;
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
		// Runtimes may have been added, renamed or switched since the toolbar was
		// built, from the settings tab or the palette.
		this.updateEndpointToggle();

		const session = this.session();
		const scope = session?.scope;
		if (!scope && this.plugin.showGetStarted()) {
			// No runtime connects: a guided start instead of a dead end (ADR-0008).
			// The first card scans for the binaries once; only "Check again" rescans.
			renderGetStartedCard(list, this.plugin.getStarted.model(), this.plugin.getStartedReason());
			this.plugin.getStarted.ensureScanned();
			return;
		}
		if (!scope || !scope.workspaceId) {
			// A runtime whose kind this build cannot run says so, rather than
			// looking like a herdr that is down (ADR-0004).
			const unavailable = this.plugin.kindUnavailable(activeRuntimeOf(this.plugin.settings).kind);
			list.createDiv({
				cls: 'herdr-empty',
				text: scope
					? 'No herdr workspace matches this vault yet.'
					: unavailable
						? issueSentence(unavailable)
						: 'Not connected to herdr.',
			});
			return;
		}
		const panes = scope.list();
		if (panes.length === 0) {
			// A kind with no workspace of its own lists what the plugin started.
			const text = this.plugin.capabilities().resumable
				? 'No agents yet. Start one with the plus button below or from a folder menu.'
				: 'No agents in this workspace.';
			list.createDiv({ cls: 'herdr-empty', text });
			return;
		}

		// Settings are read here, once per repaint, so changing the sort or the
		// grouping reorders the list on the next render and never reconnects.
		const settings = this.plugin.settings;
		// Labels are read, never fetched, from here (issue #43).
		const tabLabels = session.tabLabels.labels();
		const groups = buildRows(panes, tabLabels, this.plugin.herdrVaultPath(), {
			groupBy: settings.agentListGroupBy,
			sort: settings.agentListSort,
			homePath: this.plugin.herdrHomePath(),
			// Pins are per endpoint (issue #35): a local pane id says nothing about
			// a remote pane that happens to share it. herdr-core keeps them on the
			// runtime (ADR-0005); the plugin asks the right store.
			pinnedPaneIds: this.plugin.pinnedPaneIds(this.plugin.endpoint.id),
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
		// A stored session with no process (ADR-0007): drawn quieter, opened alike.
		if (model.status === 'stopped') rowClasses.push('is-stopped');
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
		const canFocus = this.plugin.capabilities().focus;
		const actions = rowActions(this.plugin.settings.agentListRowClick, canFocus);
		// Without focus there is no other half of the pair to put on a button.
		if (!canFocus) return;
		const button = row.createEl('button', {
			cls: 'clickable-icon herdr-row-action',
			attr: { type: 'button' },
		});
		button.dataset.herdrAction = actions.button;
		setIcon(button, actions.buttonIcon);
		setTooltip(button, actions.buttonLabel);
		button.setAttribute('aria-label', actions.buttonLabel);
	}

	/**
	 * The seam the row dispatcher acts through (issue #82): the plugin, the
	 * `Menu` and the two modals, behind one flat interface. Everything read
	 * from the connection goes through the endpoint session lookup, so a row
	 * effect and the render it came from always mean the same herdr.
	 *
	 * `target()` is what makes a rename or a close confirmed after an endpoint
	 * switch or a reconnect droppable: the session object is per connection
	 * generation (issue #81), so comparing it by identity answers both
	 * questions at once.
	 */
	private rowDispatchHost(): RowDispatchHost<MouseEvent> {
		const plugin = this.plugin;
		const onCurrentEndpoint = (ref: PaneRef): boolean =>
			ref.endpointId === plugin.endpoint.id;
		return {
			target: () => ({ endpointId: plugin.endpoint.id, connection: this.session() }),
			pane: (paneId) => this.session()?.scope.get(paneId) ?? null,
			rowClick: () => plugin.settings.agentListRowClick,
			capabilities: () => {
				const can = plugin.capabilities();
				// Graduation targets only matter where rows are resumable sessions.
				return can.resumable ? { ...can, graduation: plugin.graduationTargets() } : can;
			},
			pinned: (ref) => plugin.isPanePinned(ref.endpointId, ref.paneId),
			setPinned: (ref, pinned) => plugin.setPanePinned(ref.endpointId, ref.paneId, pinned),
			// The plugin acts on the published connection, so a ref captured on
			// another endpoint must not be handed to it (issue #54). The dispatcher
			// already notices on a stale target; these just refuse to act.
			openTerminal: (ref) => {
				if (!onCurrentEndpoint(ref)) return;
				// A stopped row resumes when it is opened (ADR-0007), before its tab is.
				void plugin.actions.resumeAgent?.(ref.paneId);
				void plugin.openTerminal(ref.paneId);
			},
			focusPane: (ref) => {
				if (onCurrentEndpoint(ref)) void plugin.actions.focusPane(ref.paneId);
			},
			renameAgent: async (ref, name) => {
				if (!onCurrentEndpoint(ref)) return;
				await plugin.actions.renameAgent(ref.paneId, name);
			},
			closePane: async (ref) => {
				if (!onCurrentEndpoint(ref)) return false;
				// The ref's endpoint, not the plugin's: the toolbar can switch
				// herdrs while `pane.close` is in flight, and the terminal leaves
				// that go with the pane are the ones on this herdr (PR #89).
				return await plugin.actions.closePane(ref.paneId, ref.endpointId);
			},
			forgetAgent: async (ref) => {
				if (!onCurrentEndpoint(ref)) return false;
				return (await plugin.actions.forgetAgent?.(ref.paneId, ref.endpointId)) ?? false;
			},
			continueIn: async (ref, runtimeId) => {
				if (!onCurrentEndpoint(ref)) return;
				await plugin.continueIn(ref.paneId, ref.endpointId, runtimeId);
			},
			showRowMenu: (event, items, choose) => this.showRowMenu(event, items, choose),
			promptRename: (text) => new PromptModal(this.app, text).ask(),
			// The one confirmation in the list, and it destroys a pane.
			confirmClose: (text) => new ConfirmModal(this.app, { ...text, warning: true }).ask(),
			refreshList: () => plugin.refreshAgentList(),
			notice: (message) => {
				new Notice(message);
			},
		};
	}

	/** Draws the row menu at the pointer; what it holds is `rowMenu.ts`. */
	private showRowMenu(
		event: MouseEvent,
		items: RowMenuItem[],
		choose: (item: RowMenuItem) => void,
	): void {
		const menu = new Menu();
		for (const item of items) {
			if (item.separatorBefore) menu.addSeparator();
			menu.addItem((entry) => {
				entry
					.setTitle(item.label)
					.setIcon(item.icon)
					.onClick(() => choose(item));
				if (item.warning) entry.setWarning(true);
			});
		}
		menu.showAtMouseEvent(event);
	}
}
