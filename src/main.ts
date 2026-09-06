import { homedir } from 'node:os';
import {
	addIcon,
	FileSystemAdapter,
	Menu,
	Notice,
	Plugin,
	setTooltip,
	TAbstractFile,
	TFile,
	TFolder,
	type WorkspaceLeaf,
} from 'obsidian';
import {
	DEFAULT_SETTINGS,
	HerdrSettingTab,
	normalizePinnedPanes,
	normalizeTerminalPlacement,
	normalizeTerminalTab,
	renderConnectionStatus,
	type AttachMode,
	type ConnectionStatus,
	type HerdrSettings,
} from './settings';
import { discoverHerdr } from './herdr/binary';
import { HerdrClient, type ProtocolMismatch } from './herdr/client';
import {
	ConnectionCoordinator,
	endpointLabel,
	endpointOf,
	resolveEndpoint,
	type Endpoint,
} from './connection';
import { SCOPE_SUBSCRIPTIONS, WorkspaceScope } from './herdr/scope';
import { TabLabelCache } from './tabLabels';
import { SshTunnel } from './herdr/ssh';
import { HerdrActions, resolveFolderPath, type ActionHost } from './actions';
import { TransitionNotifier, sendOsNotification, unsupportedMethodMessage } from './notify';
import { AGENT_LIST_VIEW_TYPE, AgentListView } from './views/agentListView';
import { countStatuses } from './views/rowModel';
import { registerKindIcons } from './views/kindIcons';
import {
	TERMINAL_VIEW_TYPE,
	TerminalView,
	parseTerminalState,
	stateMatchesPane,
} from './views/terminalView';
import { decideOpenTarget, decidePlacement } from './terminalPlacement';
import { ExplorerFolderButtons } from './explorerButtons';

/** Delay before a coalesced `agent.list` refresh; a burst of panes is one call. */
const AGENT_NAME_REFRESH_MS = 300;
/** Delay after a connection setting changes before reconnecting (typing). */
const RECONNECT_DEBOUNCE_MS = 800;

export default class HerdrPlugin extends Plugin {
	settings!: HerdrSettings;
	/**
	 * Owns every connection attempt: discovery, tunnel, client, scope and
	 * priming (issue #57). `client`, `scope` and `tunnel` below read from the
	 * published connection; a retired or superseded attempt never shows here.
	 */
	private readonly connection = new ConnectionCoordinator<HerdrClient, WorkspaceScope, SshTunnel>(
		{
			discover: () =>
				discoverHerdr({
					override: this.settings.herdrBinary,
					extraPath: this.settings.extraPath,
					socketOverride: this.settings.socketPath,
				}),
			endpoint: () => endpointOf(this.settings.remote),
			createTunnel: (onSocket) => this.createTunnel(onSocket),
			createClient: (socketPath) => this.createClient(socketPath),
			createScope: (endpoint) => this.createScope(endpoint),
			subscriptions: SCOPE_SUBSCRIPTIONS,
			notice: (message) => {
				new Notice(message);
			},
			setError: (message) => {
				this.connectError = message;
			},
			onReplaced: () => {
				// The label cache belongs to the connection that just went (#43).
				if (this.tabLabelCache && this.tabLabelCache.scope !== this.connection.current?.scope) {
					this.tabLabelCache.cache.dispose();
					this.tabLabelCache = null;
				}
				for (const listener of [...this.scopeListeners]) listener();
				this.updateStatusBar();
			},
			onPrimed: () => this.updateStatusBar(),
		},
	);
	/** Null until the herdr binary and socket have been discovered. */
	get client(): HerdrClient | null {
		return this.connection.current?.client ?? null;
	}
	get scope(): WorkspaceScope | null {
		return this.connection.current?.scope ?? null;
	}
	/**
	 * The endpoint the list is connected to, or the one the settings would
	 * connect to while no connection is published (issue #54).
	 */
	get endpoint(): Endpoint {
		return this.connection.current?.endpoint ?? endpointOf(this.settings.remote);
	}
	/**
	 * The current scope only when it belongs to `endpointId`; a terminal pinned
	 * to the other herdr must not read titles from this one (issue #54).
	 */
	scopeFor(endpointId: string): WorkspaceScope | null {
		const current = this.connection.current;
		return current && current.endpoint.id === endpointId ? current.scope : null;
	}
	/**
	 * The tab-label cache of the published connection, when it is the one
	 * `endpointId` names (issue #43). Built on first use, because the cache
	 * needs both the client and the scope and the coordinator creates them
	 * apart; one per connection, keyed by its scope, and retired with it in
	 * `onReplaced`. Views never fetch labels themselves.
	 */
	tabLabelsFor(endpointId: string): TabLabelCache | null {
		const current = this.connection.current;
		if (!current || current.endpoint.id !== endpointId) return null;
		if (this.tabLabelCache?.scope !== current.scope) {
			this.tabLabelCache?.cache.dispose();
			const { client, scope } = current;
			this.tabLabelCache = {
				scope,
				cache: new TabLabelCache({
					client,
					scope: {
						get workspaceId() {
							return scope.workspaceId;
						},
						tabIds: () => scope.list().map((pane) => pane.tabId),
						onWorkspaceResolved: (handler) => scope.on('workspaceResolved', handler),
					},
					alive: () => this.connection.current === current,
				}),
			};
		}
		return this.tabLabelCache.cache;
	}
	/** The one live cache and the scope it belongs to; see `tabLabelsFor`. */
	private tabLabelCache: { scope: WorkspaceScope; cache: TabLabelCache } | null = null;
	/**
	 * The endpoint an id names: the published connection's own snapshot when it
	 * matches, else one rebuilt from the settings as they are now, else null
	 * when the settings no longer describe it.
	 */
	endpointFor(endpointId: string): Endpoint | null {
		const current = this.connection.current;
		if (current && current.endpoint.id === endpointId) return current.endpoint;
		return resolveEndpoint(endpointId, this.settings.remote);
	}
	/** Non-null only while a remote profile is enabled (PRD S5). */
	get tunnel(): SshTunnel | null {
		return this.connection.current?.tunnel ?? null;
	}
	/** Folder actions (PRD M19, M20); safe to call before a connection exists. */
	actions!: HerdrActions;
	/** Hover buttons on file explorer folder rows (issue #30); off unless enabled. */
	private explorerButtons!: ExplorerFolderButtons;
	/**
	 * Views that outlive a connection (a restored sidebar opens before `connect`
	 * runs; a plugin reload rebuilds them before it) subscribe here and rebind to
	 * whatever `scope` is now. Called after every assignment of `scope`.
	 */
	private readonly scopeListeners = new Set<() => void>();

	/** Pending coalesced `agent.list`, 0 when none. */
	private agentNameTimer = 0;
	/** Pending reconnect after a connection setting changed, 0 when none. */
	private reconnectTimer = 0;
	private mismatch: ProtocolMismatch | null = null;
	private connectError: string | null = null;
	private notifier!: TransitionNotifier;
	private statusBarEl: HTMLElement | null = null;
	/** Cached `document.hasFocus()`, kept fresh by focus/blur (notes/electron-node.md). */
	private windowFocused = true;

	async onload() {
		await this.loadSettings();
		this.actions = new HerdrActions(this.actionHost());
		this.explorerButtons = new ExplorerFolderButtons(this);
		this.notifier = new TransitionNotifier({
			now: () => Date.now(),
			settings: () => this.settings.notifications,
			isTerminalOpen: (paneId, endpointId) => this.isTerminalOpen(paneId, endpointId),
			windowFocused: () => this.windowFocused,
			showNotice: (message) => {
				new Notice(message);
			},
			showOsNotification: (title, body) => {
				// Clicking the OS notification brings the agent list back up.
				sendOsNotification(title, body, () => void this.activateAgentList());
			},
		});
		this.addSettingTab(
			new HerdrSettingTab(this.app, this, (el) =>
				renderConnectionStatus(el, this.settings, this.connectionStatus()),
			),
		);

		// Agent kind marks must exist before the first row is drawn (issue #19);
		// `addIcon` is global and idempotent, so once at load is enough.
		registerKindIcons(addIcon);
		this.registerView(AGENT_LIST_VIEW_TYPE, (leaf) => new AgentListView(leaf, this));
		this.registerView(TERMINAL_VIEW_TYPE, (leaf) => new TerminalView(leaf, this));
		this.registerCommands();
		this.registerStatusBar();

		// OS notifications only fire while the window is unfocused (PRD M12), so
		// track the edges instead of asking the DOM inside an event handler.
		this.windowFocused = document.hasFocus();
		this.registerDomEvent(window, 'focus', () => {
			this.windowFocused = true;
		});
		this.registerDomEvent(window, 'blur', () => {
			this.windowFocused = false;
		});

		// Vault-facing work waits for the layout, per the Obsidian guidelines.
		this.app.workspace.onLayoutReady(() => {
			this.registerFileMenus();
			this.refreshFolderHoverButton();
			void this.connect();
		});
	}

	onunload() {
		// Leaves are never detached here: Obsidian restores them and the user
		// decides where the view lives (PRD M10, N1).

		// The explorer buttons are not registered on the plugin, because the
		// setting has to release them too; `disable()` is the one teardown.
		this.explorerButtons.disable();
		// Invalidates every attempt before any teardown is awaited: a connect
		// still waiting on discovery or a ping finds itself stale afterwards.
		// The tunnel's async stop (SIGTERM, SIGKILL, socket file) runs on from
		// here on its own; `onunload` is synchronous.
		this.connection.dispose();
		this.tabLabelCache?.cache.dispose();
		this.tabLabelCache = null;
		this.scopeListeners.clear();
		if (this.agentNameTimer) window.clearTimeout(this.agentNameTimer);
		this.agentNameTimer = 0;
		if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
		this.reconnectTimer = 0;
		this.statusBarEl = null;
	}

	async loadSettings() {
		const stored = (await this.loadData()) as Partial<HerdrSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...stored,
			remote: { ...DEFAULT_SETTINGS.remote, ...stored?.remote },
			notifications: {
				...DEFAULT_SETTINGS.notifications,
				...stored?.notifications,
				blocked: {
					...DEFAULT_SETTINGS.notifications.blocked,
					...stored?.notifications?.blocked,
				},
				done: {
					...DEFAULT_SETTINGS.notifications.done,
					...stored?.notifications?.done,
				},
			},
			// A hand-edited or older `data.json` must not put a non-list in a row's
			// sort (issue #35).
			pinnedPanes: normalizePinnedPanes(stored?.pinnedPanes),
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Absolute path of the vault, or empty for a non-filesystem adapter. */
	private vaultPath(): string {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
	}

	/**
	 * Vault path as seen by the machine herdr runs on: the remote vault path with
	 * a remote profile, the local one otherwise (PRD S5, M19).
	 */
	herdrVaultPath(): string {
		const remote = this.settings.remote;
		if (remote.enabled && remote.remoteVaultPath.trim()) return remote.remoteVaultPath.trim();
		return this.vaultPath();
	}

	/**
	 * Home directory as seen by the machine herdr runs on (issue #22): the remote
	 * user's home with a remote profile, this user's home otherwise. Empty when a
	 * remote tunnel never had to expand a `~`, in which case rows outside the
	 * vault keep their absolute paths.
	 */
	herdrHomePath(): string {
		if (this.settings.remote.enabled) return this.tunnel?.remoteHome ?? '';
		return homedir();
	}

	/**
	 * Path of the local herdr binary, empty until discovery ran or when it failed.
	 * The terminal view turns this into a spawn argv (`terminalArgvPrefix`).
	 */
	herdrBinaryPath(): string {
		return this.connection.discovery?.binary?.path ?? this.settings.herdrBinary.trim();
	}

	/**
	 * Opens the terminal view for a herdr pane (PRD M13, issues #28 and #38).
	 *
	 * One view per pane: an existing leaf for the same pane is revealed, so a
	 * second open neither spawns a second bridge process nor carves out another
	 * split. Under the `reuse` tab mode an open terminal for *another* pane is
	 * switched to this one instead — its `setState` restarts the bridge, and the
	 * pane it was showing has its session released by that restart. Only a
	 * genuinely new terminal is placed, beside the note when that note lives
	 * inside the agent's working directory and in a tab otherwise.
	 *
	 * "Same pane" means same pane id on the connected endpoint (issue #54): a
	 * terminal pinned to the other herdr is neither revealed nor switched by a
	 * plain open, only by the reuse mode, which is an explicit choice to point
	 * the one terminal tab at whatever row was clicked.
	 */
	async openTerminal(paneId: string): Promise<void> {
		const workspace = this.app.workspace;
		// Rows come from the connected endpoint, so that is the one the terminal
		// is opened on and pinned to (issue #54).
		const endpointId = this.endpoint.id;
		const existing = this.terminalLeaf(paneId, endpointId);
		const open = workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);
		const target = decideOpenTarget({
			mode: normalizeTerminalTab(this.settings.terminalTab),
			hasPaneLeaf: existing !== null,
			hasAnyLeaf: open.length > 0,
		});

		let leaf = existing;
		if (target === 'switch') {
			// The terminal the user is looking at, else the first loaded one.
			// A deferred leaf is never switched: Obsidian would have to load its
			// view first, and the tab the user last used is the one they expect
			// to change (seen live: the first leaf in layout order was a
			// deferred, restored tab, and the switch landed nowhere useful).
			const active = workspace.activeLeaf;
			const reused =
				(active && open.includes(active) && !active.isDeferred ? active : undefined) ??
				open.find((candidate) => !candidate.isDeferred) ??
				open.at(0);
			if (reused) {
				await reused.setViewState({
					type: TERMINAL_VIEW_TYPE,
					active: true,
					// The mode this view is in, off its persisted state rather than
					// `leaf.view` (PRD N1), so a manual switch to observe survives.
					state: { paneId, mode: this.attachModeOf(reused), endpointId },
				});
				leaf = reused;
			}
		}
		if (!leaf) {
			leaf = this.leafForNewTerminal(paneId);
			await leaf.setViewState({
				type: TERMINAL_VIEW_TYPE,
				active: true,
				state: { paneId, mode: this.settings.defaultAttachMode, endpointId },
			});
		}
		await workspace.revealLeaf(leaf);
	}

	/** The attach mode a terminal leaf persists, or the configured default. */
	private attachModeOf(leaf: WorkspaceLeaf): AttachMode {
		return parseTerminalState(leaf.getViewState().state)?.mode ?? this.settings.defaultAttachMode;
	}

	/** The leaf a new terminal view takes (issue #28). */
	private leafForNewTerminal(paneId: string): WorkspaceLeaf {
		const workspace = this.app.workspace;
		const decision = decidePlacement({
			placement: normalizeTerminalPlacement(this.settings.terminalPlacement),
			paneCwd: this.scope?.get(paneId)?.cwd ?? '',
			activeFilePath: workspace.getActiveFile()?.path ?? null,
			// herdr's view of the vault, because the cwd is herdr's (PRD S5, M19).
			vaultPath: this.herdrVaultPath(),
		});
		if (decision.kind === 'tab') return workspace.getLeaf('tab');
		const source = this.activeNoteLeaf();
		if (!source) return workspace.getLeaf('tab');
		return workspace.createLeafBySplit(source, 'vertical', decision.before);
	}

	/**
	 * The main-area leaf showing the active file, or null. `getMostRecentLeaf`
	 * rather than the active leaf: the terminal is usually opened from the agent
	 * list, which sits in a sidebar. The file is read off the persisted view
	 * state, not `leaf.view`, like `terminalLeaf` does (PRD N1).
	 */
	private activeNoteLeaf(): WorkspaceLeaf | null {
		const file = this.app.workspace.getActiveFile();
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!file || !leaf) return null;
		const state = leaf.getViewState().state;
		return state?.file === file.path ? leaf : null;
	}

	/**
	 * True when a terminal view for this pane on this endpoint is open, which
	 * mutes notifications for it (PRD M12, issue #54).
	 */
	isTerminalOpen(paneId: string, endpointId: string): boolean {
		return this.terminalLeaf(paneId, endpointId) !== null;
	}

	/**
	 * Repaints every open agent list (issue #20). The settings tab calls this
	 * after a sort or grouping change, which the list reads on each render, so the
	 * new order appears without a reconnect. No view is stored: the leaves are
	 * looked up and a deferred one is skipped, since it rebuilds on load anyway.
	 */
	refreshAgentList(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(AGENT_LIST_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof AgentListView) view.refresh();
		}
	}

	/**
	 * Repaints every open terminal with the current colour theme (issue #26). The
	 * settings tab calls this after the theme dropdown changes, so open terminals
	 * switch palette without being reopened. Deferred leaves are skipped: they read
	 * the setting when they mount.
	 */
	refreshTerminals(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof TerminalView) view.applyTheme(this.settings.terminalTheme);
		}
	}

	/** Retitles every open terminal after the title setting changed (issue #43). */
	refreshTerminalTitles(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof TerminalView) view.refreshTitle();
		}
	}

	/**
	 * Rebuilds every open terminal on the engine the settings now name (issue
	 * #27). Unlike a theme change, this cannot be applied in place: the renderer
	 * is a different library, so each view snapshots its scrollback, disposes and
	 * starts again. Deferred leaves are skipped; they read the setting when they
	 * mount.
	 */
	rebuildTerminals(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof TerminalView) void view.rebuildRenderer();
		}
	}

	/**
	 * Applies the cursor style and blink settings to every open terminal (issue
	 * #52). Both engines take these in place, so nothing is rebuilt or restarted.
	 */
	refreshTerminalCursors(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof TerminalView) view.applyCursor();
		}
	}

	/** Applies the folder hover button setting, both ways (issue #30). */
	refreshFolderHoverButton(): void {
		if (this.settings.folderHoverButton) this.explorerButtons.enable();
		else this.explorerButtons.disable();
	}

	/** Runs `listener` whenever `scope` is replaced. Returns the unsubscribe. */
	onScopeReplaced(listener: () => void): () => void {
		this.scopeListeners.add(listener);
		return () => this.scopeListeners.delete(listener);
	}

	/**
	 * The leaf showing this pane's terminal on this endpoint, if any. The
	 * persisted view state is the lookup, not `leaf.view`: a background leaf may
	 * still be deferred, and the guidelines forbid holding view references (PRD
	 * N1). The endpoint is part of the key (issue #54): after the list switches
	 * herdr, a row's `w4:p1` must not reveal the other server's `w4:p1`.
	 */
	private terminalLeaf(paneId: string, endpointId: string): WorkspaceLeaf | null {
		for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
			if (stateMatchesPane(leaf.getViewState().state, paneId, endpointId)) return leaf;
		}
		return null;
	}

	/** Everything `HerdrActions` needs from the plugin (PRD M19, M20). */
	private actionHost(): ActionHost {
		return {
			// Read lazily: `loadSettings` replaces the object and the settings tab
			// mutates it while the plugin runs.
			settings: () => this.settings,
			workspaceId: () => this.scope?.workspaceId ?? null,
			request: <T,>(method: string, params: unknown): Promise<T> => {
				const client = this.client;
				if (!client) return Promise.reject(new Error('not connected to herdr'));
				return client.request<T>(method, params);
			},
			// Real agent names from `agent.list`, session-wide: herdr rejects a
			// duplicate name anywhere, not just in this workspace (PRD M20).
			takenAgentNames: () => this.scope?.agentNames() ?? new Set<string>(),
			// Agent panes in scope, so "Start agent here" can split the folder's
			// existing tab instead of opening another one (issue #29).
			agentPanes: () => this.scope?.list() ?? [],
			vaultName: () => this.app.vault.getName(),
			notice: (message: string) => {
				new Notice(message);
			},
			openTerminal: (paneId: string) => this.openTerminal(paneId),
			sleep: (ms: number) =>
				new Promise<void>((resolve) => {
					window.setTimeout(resolve, ms);
				}),
			now: () => Date.now(),
		};
	}

	/** Absolute path herdr should use for a vault file or folder (PRD M19). */
	private folderPathOf(file: TAbstractFile): string {
		const folder = file instanceof TFolder ? file : (file.parent ?? null);
		const remote = this.settings.remote;
		return resolveFolderPath(folder?.path ?? '', {
			basePath: this.vaultPath(),
			remoteVaultPath: remote.enabled ? remote.remoteVaultPath : undefined,
		});
	}

	/** Folder of the active file, or null when nothing is open. */
	private activeFolderPath(): string | null {
		const file = this.app.workspace.getActiveFile();
		return file ? this.folderPathOf(file) : null;
	}

	/** Command palette entries. No default hotkeys (PRD N1). */
	private registerCommands(): void {
		this.addCommand({
			id: 'show-agents',
			name: 'Show herdr agents',
			callback: () => {
				void this.activateAgentList();
			},
		});
		this.addFolderCommand('new-tab-here', 'New tab here', (path) =>
			this.actions.newTabHere(path),
		);
		this.addFolderCommand('split-here', 'Split here', (path) => this.actions.splitHere(path));
		this.addFolderCommand('start-agent-here', 'Start agent here', (path) =>
			this.actions.startAgentHere(path),
		);
	}

	/** A command acting on the active file's folder; hidden when there is none. */
	private addFolderCommand(
		id: string,
		name: string,
		run: (folderAbsPath: string) => Promise<unknown>,
	): void {
		this.addCommand({
			id,
			name,
			checkCallback: (checking) => {
				const path = this.activeFolderPath();
				if (!path) return false;
				if (!checking) void run(path);
				return true;
			},
		});
	}

	/**
	 * File explorer context menus for folders and files (PRD M19). A file means
	 * its parent folder; the source filter keeps the items out of link, graph and
	 * tab menus (notes/obsidian-api.md).
	 */
	private registerFileMenus(): void {
		const build = (menu: Menu, file: TAbstractFile): void => {
			if (!(file instanceof TFolder) && !(file instanceof TFile)) return;
			const path = this.folderPathOf(file);
			const item = (title: string, icon: string, run: () => void): void => {
				menu.addItem((entry) =>
					entry
						.setTitle(title)
						.setIcon(icon)
						.setSection('herdr')
						.onClick(() => run()),
				);
			};
			item('Herdr: new tab here', 'plus', () => void this.actions.newTabHere(path));
			item('Herdr: split here', 'separator-vertical', () => void this.actions.splitHere(path));
			item('Herdr: start agent here', 'bot', () => void this.actions.startAgentHere(path));
		};

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file, source) => {
				if (source !== 'file-explorer-context-menu') return;
				build(menu, file);
			}),
		);
		this.registerEvent(
			this.app.workspace.on('files-menu', (menu, files, source) => {
				if (source !== 'file-explorer-context-menu') return;
				// A multi-selection has one folder in common at best; the first item's
				// folder is the only honest answer, so act on that.
				const first = files.at(0);
				if (first) build(menu, first);
			}),
		);
	}

	/** Status bar counts of blocked and done agents; click reveals the list (PRD S11). */
	private registerStatusBar(): void {
		const el = this.addStatusBarItem();
		el.addClass('herdr-status-bar');
		el.setAttribute('aria-label', 'Herdr agents');
		this.registerDomEvent(el, 'click', () => {
			void this.activateAgentList();
		});
		this.statusBarEl = el;
		this.updateStatusBar();
	}

	/** Re-renders the status bar counts. Called only from scope events (PRD N4). */
	private updateStatusBar(): void {
		const el = this.statusBarEl;
		if (!el) return;
		el.empty();
		if (!this.settings.notifications.statusBar) return;
		const panes = this.scope?.list() ?? [];
		if (panes.length === 0) return;
		// Which herdr the counts are for (issue #54); the bar itself stays terse.
		const where = `Herdr agents on ${endpointLabel(this.endpoint)}`;
		setTooltip(el, where);
		el.setAttribute('aria-label', where);
		const { blocked, done } = countStatuses(panes);
		el.createSpan({ cls: 'herdr-status-bar-blocked', text: `${blocked} blocked` });
		el.createSpan({ text: ' · ' });
		el.createSpan({ cls: 'herdr-status-bar-done', text: `${done} done` });
	}

	/**
	 * Reveals the agent list, creating it in the left sidebar the first time
	 * (PRD M10). `getLeftLeaf(true)` can return null, and the view is never held
	 * in a field — `getLeavesOfType` is the lookup (PRD N1).
	 */
	async activateAgentList(): Promise<void> {
		const workspace = this.app.workspace;
		let leaf = workspace.getLeavesOfType(AGENT_LIST_VIEW_TYPE).at(0) ?? null;
		if (!leaf) {
			leaf = workspace.getLeftLeaf(true);
			if (!leaf) {
				new Notice('Herdr: could not open the sidebar for the agent list.');
				return;
			}
			await leaf.setViewState({ type: AGENT_LIST_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	/**
	 * A connection setting changed (socket, binary, PATH, workspace, or any
	 * remote field). Typing in a text field fires per keystroke, so the
	 * reconnect is coalesced; the toggle benefits from the same delay.
	 */
	scheduleReconnect(): void {
		if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = 0;
			void this.reconnect();
		}, RECONNECT_DEBOUNCE_MS);
	}

	/**
	 * Tears the current connection down, tunnel included, and connects again
	 * from the settings as they are now. Before this existed, switching the
	 * remote profile off left the old tunnel and client alive until Obsidian
	 * restarted, so the list kept showing the remote workspace while new
	 * terminals already spawned locally.
	 */
	async reconnect(): Promise<void> {
		this.mismatch = null;
		await this.connection.connect();
	}

	/**
	 * Finds herdr, opens the JSON API connection and primes the workspace scope.
	 * Read-only: `ping`, `session.snapshot`, `pane.list` and `events.subscribe`.
	 * Never throws; failures land in the settings status. Overlapping calls are
	 * serialised by the coordinator: only the newest attempt publishes.
	 */
	private async connect(): Promise<void> {
		await this.connection.connect();
	}

	private createClient(socketPath: string): HerdrClient {
		return new HerdrClient({
			socketPath,
			onProtocolMismatch: (mismatch) => {
				this.mismatch = mismatch;
			},
			// PRD M3: an unsupported method is reported once, then never retried.
			onUnsupportedMethod: (method) => {
				new Notice(unsupportedMethodMessage(method));
			},
		});
	}

	/**
	 * The scope for one connection, with everything downstream hung off its
	 * events, never off the raw stream: the scope has already collapsed the
	 * ~10 pane.updated per second (N4).
	 */
	private createScope(endpoint: Endpoint): WorkspaceScope {
		const remoteProfile = endpoint.remote;
		const scope = new WorkspaceScope({
			workspaceId: this.settings.workspaceId,
			vaultPath: this.vaultPath(),
			remoteVaultPath: remoteProfile.enabled ? remoteProfile.remoteVaultPath : undefined,
		});
		scope.on('changed', (_paneId, prev, next) => {
			this.notifier.onChanged(prev, next, endpoint.id);
			this.updateStatusBar();
		});
		scope.on('added', () => {
			this.updateStatusBar();
			// A pane that just gained an agent has no name yet: names are not on
			// the event stream, only in `agent.list` (PRD M8).
			this.refreshAgentNames();
		});
		scope.on('removed', (pane) => {
			this.notifier.forget(pane.paneId, endpoint.id);
			this.updateStatusBar();
		});
		scope.on('workspaceResolved', () => {
			this.notifier.reset();
			this.updateStatusBar();
			this.refreshAgentNames();
		});
		return scope;
	}

	/**
	 * Coalesced `agent.list`. Agent names are the one thing the event stream
	 * never carries, so they are re-read after the scope changes shape rather
	 * than on a timer. A failure is cosmetic: rows fall back to the title.
	 */
	private refreshAgentNames(): void {
		if (this.agentNameTimer) return;
		// A herdr without `agent.list` said so once already: stay off it.
		if (this.client?.isUnsupported('agent.list')) return;
		this.agentNameTimer = window.setTimeout(() => {
			this.agentNameTimer = 0;
			const client = this.client;
			const scope = this.scope;
			if (!client || !scope) return;
			void client.listAgents().then(
				(agents) => scope.setAgentNames(agents),
				() => undefined,
			);
		}, AGENT_NAME_REFRESH_MS);
	}

	/**
	 * The SSH forward for the remote profile (PRD S5). The connection points its
	 * client at the forward's local socket instead of the discovered one; the
	 * tunnel keeps itself alive with backoff after a drop and reports the socket
	 * through `onSocket` after every reconnect.
	 */
	private createTunnel(onSocket: (localSocketPath: string) => void): SshTunnel {
		const remote = this.settings.remote;
		const host = remote.host.trim();
		if (host.length === 0) {
			throw new Error('the remote profile has no SSH host');
		}
		return new SshTunnel({
			host,
			remoteSocketPath: remote.remoteSocketPath.trim(),
			onStatus: (status) => {
				if (status.state === 'connected') onSocket(status.localSocketPath);
			},
		});
	}

	/** State the settings tab's status block describes (rendered in settings.ts). */
	private connectionStatus(): ConnectionStatus {
		const scope = this.scope;
		const tunnel = this.tunnel;
		const discovery = this.connection.discovery;
		return {
			discovery,
			socketPath: this.client?.socket ?? discovery?.socketPath ?? '',
			tunnel: tunnel
				? { text: tunnel.statusText, connected: tunnel.status.state === 'connected' }
				: null,
			mismatch: this.mismatch ?? this.client?.lastMismatch ?? null,
			workspace: scope?.workspaceId
				? {
						id: scope.workspaceId,
						label: scope.workspaceLabel,
						method: scope.method,
						agentCount: scope.size,
					}
				: null,
			error: this.connectError,
		};
	}
}
