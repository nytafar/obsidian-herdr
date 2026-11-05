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
	migrateRenderMode,
	normalizePinnedPanes,
	normalizeTerminalPlacement,
	normalizeTerminalTab,
	renderConnectionStatus,
	withoutRemovedSettings,
	type AttachMode,
	type ConnectionStatus,
	type HerdrSettings,
} from './settings';
import { HerdrClient, type ProtocolMismatch } from './herdr/client';
import {
	ConnectionCoordinator,
	EndpointSessions,
	endpointOf,
	isRemoteEndpoint,
	resolveEndpoint,
	type ConnectionClient,
	type ConnectionScope,
	type Endpoint,
	type EndpointSession,
} from './connection';
import { WorkspaceScope } from './herdr/scope';
import type { TabLabels } from './tabLabels';
import { SshTunnel } from './herdr/ssh';
import { isPanePinned, pinnedPaneIds, togglePanePin } from './settings';
import { resolveFolderPath, type ActionHost } from './actions';
import {
	activeRuntimeOf,
	migrateRuntimes,
	runtimeById,
	runtimeDisplayName,
	withLiveName,
	type RuntimeConfig,
	type RuntimeKind,
} from './runtimes';
import type { RuntimeActions, RuntimeCapabilities, RuntimeKindAdapter } from './runtime/kind';
import { createHerdrKind } from './runtime/herdrKind';
import { createHerdrCoreKind } from './runtime/herdrCoreKind';
import { RuntimeSuggestModal } from './views/modals';
import { TransitionNotifier, sendOsNotification, unsupportedMethodMessage } from './notify';
import { AGENT_LIST_VIEW_TYPE, AgentListView } from './views/agentListView';
import { TOC_VIEW_TYPE, TocView, revealTocView } from './native/tocView';
import { registerOutlineSwap } from './native/tocOutline';
import { HOVER_LINK_SOURCE } from './native/noteLinks';
import { countStatuses } from './views/rowModel';
import { registerKindIcons } from './views/kindIcons';
import {
	PaneViewEvents,
	TERMINAL_VIEW_TYPE,
	TerminalView,
	parseTerminalState,
	stateMatchesPane,
	switchRenderModeCommand,
} from './views/terminalView';
import { spawnEnv, type TerminalSetting } from './views/paneTerminal';
import {
	chooseNoteLeaf,
	decideOpenTarget,
	decidePlacement,
	type NoteLeafCandidate,
} from './terminalPlacement';
import { scopeWatcher, SessionModelRegistry } from './native/sessionModel';
import { LocalTranscriptSource } from './native/transcriptSource';
import { ExplorerFolderButtons } from './explorerButtons';
import { HcClient } from './hc/client';
import { hcHookMachine } from './sessionHook/installer';
import { SessionHookModal, sessionHookStatusLine, type SessionHookTarget } from './sessionHook/modal';

/** Delay after a connection setting changes before reconnecting (typing). */
const RECONNECT_DEBOUNCE_MS = 800;
/**
 * How often the scoped panes are re-read from herdr.
 *
 * herdr has no event for an agent status change that a whole workspace can
 * subscribe to (`docs/architecture.md`, measured against 0.8.2), so the status
 * behind the list, the notifications and the native view's "Working…" is only
 * as fresh as the last time the plugin asked. Two seconds is a `pane.list` for
 * one workspace (4.6 KB, about 11 ms on the machine this was measured on), and
 * the scope emits nothing when nothing moved.
 */
const PANE_REFRESH_MS = 2000;

export default class HerdrPlugin extends Plugin {
	settings!: HerdrSettings;
	/**
	 * Owns every connection attempt: discovery, tunnel, client, scope and
	 * priming (issue #57). `client`, `scope` and `tunnel` below read from the
	 * published connection; a retired or superseded attempt never shows here.
	 */
	private readonly connection = new ConnectionCoordinator(
		{
			endpoint: () => endpointOf(activeRuntimeOf(this.settings)),
			driver: (endpoint) => {
				const kind = this.kindOf(endpoint.runtime.kind);
				const driver = kind.connection;
				if (kind.unavailable !== null || !driver) {
					return { unavailable: kind.unavailable ?? `${endpoint.runtime.kind} cannot connect` };
				}
				// The kind builds the scope; what hangs off its events is the plugin's.
				return {
					...driver,
					createScope: (attempt, client) =>
						this.wireScope(driver.createScope(attempt, client), attempt),
				};
			},
			notice: (message) => {
				new Notice(message);
			},
			setError: (message) => {
				this.connectError = message;
			},
			onReplaced: () => {
				// The caches belong to the connection that just went (#43, #81).
				this.sessions.sync();
				for (const listener of [...this.scopeListeners]) listener();
				this.updateStatusBar();
			},
			onPrimed: () => this.updateStatusBar(),
		},
	);
	/**
	 * One adapter per runtime kind (ADR-0004): everything that differs by kind
	 * is asked of the adapter of the runtime in question, never decided here.
	 * herdr-core runs over `hc connect` (ADR-0005).
	 */
	private readonly kinds: Record<RuntimeKind, RuntimeKindAdapter> = {
		herdr: createHerdrKind({
			extraPath: () => this.settings.extraPath,
			vaultPath: () => this.vaultPath(),
			onProtocolMismatch: (mismatch) => {
				this.mismatch = mismatch;
			},
			onUnsupportedMethod: (method) => {
				new Notice(unsupportedMethodMessage(method));
			},
			// The scope's one request (issue #75) is answered by its own
			// connection's client, and only while that connection is published.
			isPublished: (scope) => this.connection.current?.scope === scope,
		}),
		'herdr-core': createHerdrCoreKind({
			extraPath: () => this.settings.extraPath,
			spawnEnv: () => spawnEnv(process.env, this.settings.extraPath),
			vaultPath: () => this.vaultPath(),
			vaultName: () => this.app.vault.getName(),
			// Warn, never refuse (ADR-0005): once per connection, and in the
			// settings status for as long as it lasts.
			onMismatch: (mismatch, runtime) => {
				new Notice(
					`Herdr: ${runtimeDisplayName(runtime)} speaks herdr-core generation ${mismatch.server ?? 'unknown'}, this plugin speaks ${mismatch.expected}. Connecting anyway.`,
				);
			},
			currentScope: () => this.connection.current?.scope ?? null,
		}),
	};
	/** Actions per kind, built on first use over the one action host. */
	private readonly kindActions = new Map<RuntimeKind, RuntimeActions>();
	/** Null until the herdr binary and socket have been discovered. */
	get client(): ConnectionClient | null {
		return this.connection.current?.client ?? null;
	}
	get scope(): ConnectionScope | null {
		return this.connection.current?.scope ?? null;
	}
	/**
	 * The endpoint the list is connected to, or the one the settings would
	 * connect to while no connection is published (issue #54).
	 */
	get endpoint(): Endpoint {
		return this.connection.current?.endpoint ?? endpointOf(activeRuntimeOf(this.settings));
	}

	/** The adapter of a kind (ADR-0004). */
	kindOf(kind: RuntimeKind): RuntimeKindAdapter {
		return this.kinds[kind];
	}

	/** Why runtimes of this kind cannot connect in this build, or null. */
	kindUnavailable(kind: RuntimeKind): string | null {
		return this.kindOf(kind).unavailable;
	}

	/**
	 * The Claude session hook's machine (ADR-0006): the published herdr-core
	 * connection's, else null. Read per use, so a reconnect is never missed.
	 */
	private sessionHookTarget(): SessionHookTarget | null {
		const current = this.connection.current;
		const client = current?.client;
		if (!current || current.endpoint.runtime.kind !== 'herdr-core' || !(client instanceof HcClient)) return null;
		return {
			runtimeName: runtimeDisplayName(withLiveName(this.settings, current.endpoint.runtime)),
			machine: hcHookMachine((method, params) => client.request(method, params)),
		};
	}

	/** The hook's review-and-confirm modal; `onDone` runs after a write. */
	openSessionHook(onDone?: () => void): void {
		const target = this.sessionHookTarget();
		if (!target) {
			new Notice('Herdr: connect to a herdr-core runtime first.');
			return;
		}
		new SessionHookModal(this.app, target, onDone).open();
	}

	/** The hook's status line for the runtime form, or null while not connected. */
	async sessionHookStatus(): Promise<{ text: string; warning: boolean } | null> {
		const target = this.sessionHookTarget();
		return target ? sessionHookStatusLine(target) : null;
	}

	/**
	 * What the runtime the list points at can do (ADR-0004): the published
	 * connection's, else the active runtime's. The UI leaves out what is false.
	 */
	capabilities(): Readonly<RuntimeCapabilities> {
		return this.kindOf(this.endpoint.runtime.kind).capabilities;
	}
	/**
	 * The endpoint-match rule, in one place (issue #81): everything a view
	 * pinned to an endpoint may read from the published connection — its
	 * endpoint snapshot, client, scope and tab-label cache — or null when the
	 * connection is elsewhere. The tab-label cache is built here, on first read,
	 * because it needs both the client and the scope and the coordinator creates
	 * them apart; it is retired with its connection (issue #43), and views never
	 * fetch labels themselves.
	 */
	private readonly sessions = new EndpointSessions<ConnectionClient, ConnectionScope, TabLabels>({
		current: () => this.connection.current,
		// The kind's own source: herdr's `tab.list` cache, herdr-core's
		// `herdr-app` tabs.
		createTabLabels: (connection) =>
			this.kindOf(connection.endpoint.runtime.kind).createTabLabels(
				connection,
				() => this.connection.current === connection,
			),
	});
	/**
	 * What `endpointId` names on the published connection, or null when that
	 * connection is another herdr's: a terminal pinned to one must not read
	 * titles or labels from the other (issue #54).
	 */
	endpointSession(
		endpointId: string,
	): EndpointSession<ConnectionClient, ConnectionScope, TabLabels> | null {
		return this.sessions.for(endpointId);
	}
	/**
	 * The endpoint an id names: the published connection's own snapshot when it
	 * matches, else one rebuilt from the settings as they are now, else null
	 * when the settings no longer describe it. The settings half is the plugin's
	 * because a restored or pinned terminal starts without any connection.
	 */
	endpointFor(endpointId: string): Endpoint | null {
		const session = this.endpointSession(endpointId);
		return session?.endpoint ?? resolveEndpoint(endpointId, this.settings);
	}

	/**
	 * The session a native view on this endpoint reads, or null when the
	 * endpoint is not the published one or cannot show a native view: its kind
	 * reports no agent session, or its transcripts live on another host
	 * (ADR-0002, ADR-0005).
	 */
	nativeSession(
		endpointId: string,
	): EndpointSession<HerdrClient, WorkspaceScope, TabLabels> | null {
		const session = this.endpointSession(endpointId);
		if (!session || !this.nativeCapable(session.endpoint)) return null;
		// Only herdr reports agent sessions; the capability says so, and this
		// narrows the session to the herdr client and scope the view reads.
		const { client, scope } = session;
		if (!(client instanceof HerdrClient) || !(scope instanceof WorkspaceScope)) return null;
		return { endpoint: session.endpoint, client, scope, tabLabels: session.tabLabels };
	}

	/** Whether panes on this endpoint can be shown in the native view at all. */
	nativeCapable(endpoint: Endpoint): boolean {
		return (
			!isRemoteEndpoint(endpoint) && this.kindOf(endpoint.runtime.kind).capabilities.nativeView
		);
	}
	/** Non-null only while an `ssh` herdr runtime is connected (PRD S5). */
	get tunnel(): SshTunnel | null {
		const tunnel = this.connection.current?.tunnel ?? null;
		return tunnel instanceof SshTunnel ? tunnel : null;
	}

	/**
	 * Pane ids pinned on an endpoint (issue #35): from the plugin's settings,
	 * or, for a kind that keeps pins on the runtime (herdr-core's shared
	 * `herdr.pinned`, ADR-0005), from the rows of that endpoint's connection.
	 */
	pinnedPaneIds(endpointId: string): string[] {
		if (!this.sharedPins(endpointId)) return pinnedPaneIds(this.settings, endpointId);
		return (this.endpointSession(endpointId)?.scope.list() ?? [])
			.filter((pane) => pane.pinned === true)
			.map((pane) => pane.paneId);
	}

	isPanePinned(endpointId: string, paneId: string): boolean {
		if (!this.sharedPins(endpointId)) return isPanePinned(this.settings, endpointId, paneId);
		return this.endpointSession(endpointId)?.scope.get(paneId)?.pinned === true;
	}

	/** Pins or unpins where that endpoint's kind keeps pins. */
	async setPanePinned(endpointId: string, paneId: string, pinned: boolean): Promise<void> {
		if (this.sharedPins(endpointId)) {
			// Only the published connection can write the label; the row repaints
			// when the core's `labels` event comes back.
			if (this.endpoint.id !== endpointId) return;
			await this.actions.setPinned?.(paneId, pinned);
			return;
		}
		if (isPanePinned(this.settings, endpointId, paneId) !== pinned) {
			togglePanePin(this.settings, endpointId, paneId);
		}
		await this.saveSettings();
	}

	private sharedPins(endpointId: string): boolean {
		const endpoint = this.endpointFor(endpointId);
		return endpoint ? this.kindOf(endpoint.runtime.kind).capabilities.sharedPins : false;
	}
	/**
	 * The native view's session models (#93, ADR-0003), one per pane while a
	 * view watches it. Over the published connection only while that runtime
	 * can show a native view: a local herdr. A remote pane keeps a terminal
	 * surface until an SSH transcript adapter exists (ADR-0002), and herdr-core
	 * reports no agent session (ADR-0005).
	 */
	readonly sessionModels = new SessionModelRegistry({
		source: new LocalTranscriptSource(),
		watcher: () => {
			const current = this.connection.current;
			return scopeWatcher(current ? this.nativeSession(current.endpoint.id) : null);
		},
	});
	/**
	 * Tabs that swapped their surface where they stand (#100, #105). The table
	 * of contents follows the active native view, and a swap inside one leaf
	 * activates no leaf.
	 */
	readonly paneViews = new PaneViewEvents();
	/**
	 * Folder and row actions (PRD M19, M20) of the runtime the list points at;
	 * safe to call before a connection exists.
	 */
	get actions(): RuntimeActions {
		const kind = this.endpoint.runtime.kind;
		let actions = this.kindActions.get(kind);
		if (!actions) {
			actions = this.kindOf(kind).createActions(this.actionHost());
			this.kindActions.set(kind, actions);
		}
		return actions;
	}
	/** Hover buttons on file explorer folder rows (issue #30); off unless enabled. */
	private explorerButtons!: ExplorerFolderButtons;
	/**
	 * Views that outlive a connection (a restored sidebar opens before `connect`
	 * runs; a plugin reload rebuilds them before it) subscribe here and rebind to
	 * whatever `scope` is now. Called after every assignment of `scope`.
	 */
	private readonly scopeListeners = new Set<() => void>();

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
				renderConnectionStatus(el, this.connectionStatus()),
			),
		);

		// Agent kind marks must exist before the first row is drawn (issue #19);
		// `addIcon` is global and idempotent, so once at load is enough.
		registerKindIcons(addIcon);
		this.registerView(AGENT_LIST_VIEW_TYPE, (leaf) => new AgentListView(leaf, this));
		this.registerView(TERMINAL_VIEW_TYPE, (leaf) => new TerminalView(leaf, this));
		this.registerView(TOC_VIEW_TYPE, (leaf) => new TocView(leaf, this));
		// Page preview for links in the native view (#114), behind the mod key.
		this.registerHoverLinkSource(HOVER_LINK_SOURCE, { display: 'Herdr', defaultMod: true });
		this.registerCommands();
		this.registerStatusBar();
		// A reconnect or an endpoint switch replaces the scope and the client the
		// session models subscribe to (#94); they take the new ones.
		this.register(this.onScopeReplaced(() => this.sessionModels.rebind()));
		// The one poll in the plugin: herdr announces no agent status change on
		// the stream, so a status that moved is only found by asking. No
		// connection is no question, and an answer that holds nothing new emits
		// nothing (see `PANE_REFRESH_MS`).
		this.registerInterval(
			window.setInterval(() => {
				void this.scope?.refresh();
			}, PANE_REFRESH_MS),
		);

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
			// The table of contents takes the outline's place while a native tab is
			// in front (#119); nothing happens while the outline is not open.
			registerOutlineSwap(this);
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
		this.sessions.dispose();
		this.sessionModels.dispose();
		this.scopeListeners.clear();
		if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
		this.reconnectTimer = 0;
		this.statusBarEl = null;
	}

	/**
	 * Stored runtimes this build cannot read (a newer build's kind or target):
	 * never shown or connected, written back by every save (ADR-0004).
	 */
	private foreignRuntimes: unknown[] = [];

	async loadSettings() {
		const stored = (await this.loadData()) as Partial<HerdrSettings> | null;
		// The v1 render mode setting split into a view and an engine (#104); a
		// file that still holds the old `native` is written back once, below.
		const renderMode = migrateRenderMode(stored);
		// "Local, or the one remote" became a runtime registry (ADR-0004); a file
		// in the old shape is migrated, ids and all, and written back once.
		const runtimes = migrateRuntimes(stored);
		this.foreignRuntimes = runtimes.foreign;
		this.settings = {
			...DEFAULT_SETTINGS,
			// Minus the keys this build has no setting for, so nothing a past
			// version wrote survives in the object or in the next save (#99).
			...withoutRemovedSettings(stored),
			defaultView: renderMode.defaultView,
			terminalEngine: renderMode.terminalEngine,
			runtimes: runtimes.runtimes,
			activeRuntime: runtimes.activeRuntime,
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
		if (renderMode.migrated || runtimes.migrated) await this.saveSettings();
	}

	async saveSettings() {
		// Runtimes of a kind or target this build does not know go back where
		// they were read from, after the known ones, so nothing is erased.
		const foreign = this.foreignRuntimes;
		await this.saveData(
			foreign.length > 0
				? { ...this.settings, runtimes: [...this.settings.runtimes, ...foreign] }
				: this.settings,
		);
	}

	/** Absolute path of the vault, or empty for a non-filesystem adapter. */
	vaultPath(): string {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
	}

	/**
	 * Vault path as seen by the machine the runtime runs on: the remote vault
	 * path on an `ssh` runtime, the local one otherwise (PRD S5, M19). Read from
	 * the connection's own runtime snapshot, so it always matches the rows.
	 */
	herdrVaultPath(): string {
		const runtime = this.endpoint.runtime;
		if (runtime.target === 'ssh' && runtime.remoteVaultPath) return runtime.remoteVaultPath;
		return this.vaultPath();
	}

	/**
	 * Home directory as seen by the machine the runtime runs on (issue #22): the
	 * remote user's home on an `ssh` runtime, this user's home otherwise. Empty
	 * when a remote tunnel never had to expand a `~`, in which case rows outside
	 * the vault keep their absolute paths.
	 */
	herdrHomePath(): string {
		if (isRemoteEndpoint(this.endpoint)) return this.tunnel?.remoteHome ?? '';
		return homedir();
	}

	/**
	 * Makes a runtime the active one and reconnects at once (ADR-0004): the
	 * toolbar switcher, the palette command and the settings list all land
	 * here. Terminals already open stay pinned to the runtime they started on.
	 * Choosing the active one reconnects it, which is what a user picking it
	 * again after an outage wants.
	 */
	async switchRuntime(id: string): Promise<void> {
		if (!runtimeById(this.settings, id)) return;
		this.settings.activeRuntime = id;
		await this.saveSettings();
		this.refreshRuntimes();
		await this.reconnect();
	}

	/** The registry changed (a name, the list, the active one): redraw what names it. */
	refreshRuntimes(): void {
		this.refreshAgentList();
		this.updateStatusBar();
	}

	/** Opens the runtime picker over every runtime, the active one marked. */
	openRuntimeSwitcher(): void {
		new RuntimeSuggestModal(this.app, {
			runtimes: () => this.settings.runtimes,
			activeId: () => activeRuntimeOf(this.settings).id,
			unavailable: (runtime) => this.kindUnavailable(runtime.kind),
			choose: (runtime) => void this.switchRuntime(runtime.id),
		}).open();
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
	 *
	 * `cwd` is for a caller that knows the pane's working directory before the
	 * scope does: "Start agent here" creates the pane and opens its terminal in
	 * one go, and the scope only admits a pane once `pane.agent_detected` and the
	 * `pane.list` behind it have landed, which is after `agent.start` answers.
	 * Without it every new agent was placed as if its cwd were unknown — a tab
	 * filling the main area — while attaching to the same folder split beside the
	 * note (issue #28).
	 */
	async openTerminal(paneId: string, cwd?: string): Promise<void> {
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
			const active = workspace.getActiveViewOfType(TerminalView)?.leaf;
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
			leaf = this.leafForNewTerminal(paneId, cwd);
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

	/**
	 * The leaf a new terminal view takes (issue #28).
	 *
	 * The cwd comes from the scope when it has the pane, from the caller when it
	 * does not: a pane an agent was just started in is not in the scope yet, and
	 * an empty cwd contains no note and so always ended in a tab.
	 */
	private leafForNewTerminal(paneId: string, cwd?: string): WorkspaceLeaf {
		const workspace = this.app.workspace;
		const decision = decidePlacement({
			placement: normalizeTerminalPlacement(this.settings.terminalPlacement),
			paneCwd: this.scope?.get(paneId)?.cwd || (cwd ?? ''),
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
	 * list, which sits in a sidebar. That leaf is a terminal as often as a note —
	 * attaching in control mode focuses the renderer, which activates its leaf —
	 * so the main area is searched when it is not the note itself; the choice is
	 * {@link chooseNoteLeaf}. The file is read off the persisted view state, not
	 * `leaf.view`, like `terminalLeaf` does (PRD N1).
	 */
	private activeNoteLeaf(): WorkspaceLeaf | null {
		const workspace = this.app.workspace;
		const file = workspace.getActiveFile();
		if (!file) return null;
		const rootLeaves: NoteLeafCandidate<WorkspaceLeaf>[] = [];
		workspace.iterateRootLeaves((leaf) => rootLeaves.push(this.noteLeafCandidate(leaf)));
		const recent = workspace.getMostRecentLeaf();
		return chooseNoteLeaf({
			activeFilePath: file.path,
			mostRecent: recent ? this.noteLeafCandidate(recent) : null,
			rootLeaves,
		});
	}

	/** What a leaf's persisted state says it is showing, for {@link chooseNoteLeaf}. */
	private noteLeafCandidate(leaf: WorkspaceLeaf): NoteLeafCandidate<WorkspaceLeaf> {
		const file = leaf.getViewState().state?.file;
		return { leaf, file: typeof file === 'string' ? file : null };
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
	 * A terminal setting changed: tell every open terminal which one (issue #84).
	 *
	 * The only terminal fan-out there is. What a setting costs — a repaint, a
	 * cursor, a rebuild on the other engine, a retitle, or nothing until the next
	 * mount — is the matrix's decision (`TERMINAL_SETTING_EFFECTS`), not this
	 * method's and not the settings tab's; `cssVariables` comes from the view's
	 * own `css-change` handler rather than from here. Deferred leaves are skipped:
	 * they read every setting when they mount.
	 */
	applyTerminalSetting(setting: TerminalSetting): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof TerminalView) view.applySetting(setting);
		}
	}

	/** The native view's presentation setting changed: redraw them (issue #95). */
	refreshNativeViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof TerminalView) view.refreshNativeSurface();
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

	/**
	 * Detaches every terminal leaf open for `paneId` on `endpointId` (issue #66).
	 * Same endpoint-aware match as {@link terminalLeaf}, but over every matching
	 * leaf instead of the first: a leaf pinned to another endpoint with the same
	 * pane id is left alone. The endpoint is the caller's, captured before the
	 * close it follows, not `this.endpoint` as it is now (PR #89).
	 */
	private detachTerminalLeaves(paneId: string, endpointId: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
			if (stateMatchesPane(leaf.getViewState().state, paneId, endpointId)) leaf.detach();
		}
	}

	/** Everything `HerdrActions` needs from the plugin (PRD M19, M20). */
	private actionHost(): ActionHost {
		return {
			// Read lazily: `loadSettings` replaces the object and the settings tab
			// mutates it while the plugin runs.
			settings: () => this.settings,
			runtime: () => this.endpoint.runtime,
			workspaceId: () => this.scope?.workspaceId ?? null,
			request: <T,>(method: string, params: unknown): Promise<T> => {
				const client = this.client;
				if (!client) return Promise.reject(new Error('not connected to herdr'));
				return client.request<T>(method, params);
			},
			// The client itself, so a two-request action keeps the connection it
			// started on even if a reconnect replaces ours in between (PR #89).
			connection: () => {
				const client = this.client;
				if (!client) return null;
				return <T,>(method: string, params: unknown) => client.request<T>(method, params);
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
			openTerminal: (paneId: string, cwd?: string) => this.openTerminal(paneId, cwd),
			detachTerminalLeaves: (paneId: string, endpointId: string) =>
				this.detachTerminalLeaves(paneId, endpointId),
			// The scope of the endpoint the action was aimed at, not `this.scope`:
			// the toolbar can switch herdrs while the close is in flight, and a
			// same-id pane on the other one must keep its row (issue #54, PR #89).
			forgetPane: (paneId: string, endpointId: string) => {
				this.endpointSession(endpointId)?.scope.forget(paneId);
			},
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
		const runtime = this.endpoint.runtime;
		return resolveFolderPath(folder?.path ?? '', {
			basePath: this.vaultPath(),
			remoteVaultPath: runtime.target === 'ssh' ? runtime.remoteVaultPath : undefined,
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
			name: 'Show agents',
			callback: () => {
				void this.activateAgentList();
			},
		});
		// Where the list comes up, and what it follows, belong to the view (#100).
		this.addCommand({
			id: 'show-toc',
			name: 'Show table of contents',
			callback: () => {
				void revealTocView(this);
			},
		});
		// The menu it opens, and who may open it, belong to the view (#92).
		this.addCommand({
			id: 'switch-render-mode',
			name: 'Switch render mode',
			checkCallback: (checking) => switchRenderModeCommand(this.app, checking),
		});
		// Any count, one included: picking the active runtime reconnects it.
		this.addCommand({
			id: 'switch-runtime',
			name: 'Switch runtime',
			callback: () => this.openRuntimeSwitcher(),
		});
		// ADR-0006: offered while the active runtime is herdr-core.
		this.addCommand({
			id: 'claude-session-hook',
			name: 'Install or remove the Claude session hook',
			checkCallback: (checking) => {
				if (activeRuntimeOf(this.settings).kind !== 'herdr-core') return false;
				if (!checking) this.openSessionHook();
				return true;
			},
		});
		this.addFolderCommand('new-tab-here', 'New tab here', 'tabs', (path) =>
			this.actions.newTabHere(path),
		);
		this.addFolderCommand('split-here', 'Split here', 'splits', (path) =>
			this.actions.splitHere(path),
		);
		this.addFolderCommand('start-agent-here', 'Start agent here', 'startAgent', (path) =>
			this.actions.startAgentHere(path),
		);
	}

	/**
	 * A command acting on the active file's folder; hidden when there is none,
	 * and while the runtime's kind cannot do it (ADR-0004).
	 */
	private addFolderCommand(
		id: string,
		name: string,
		capability: keyof RuntimeCapabilities,
		run: (folderAbsPath: string) => Promise<unknown>,
	): void {
		this.addCommand({
			id,
			name,
			checkCallback: (checking) => {
				if (!this.capabilities()[capability]) return false;
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
			const can = this.capabilities();
			const item = (title: string, icon: string, run: () => void): void => {
				menu.addItem((entry) =>
					entry
						.setTitle(title)
						.setIcon(icon)
						.setSection('herdr')
						.onClick(() => run()),
				);
			};
			// What the runtime's kind cannot do is left out, not offered and refused.
			if (can.tabs) item('Herdr: new tab here', 'plus', () => void this.actions.newTabHere(path));
			if (can.splits) {
				item('Herdr: split here', 'separator-vertical', () => void this.actions.splitHere(path));
			}
			if (can.startAgent) {
				item('Herdr: start agent here', 'bot', () => void this.actions.startAgentHere(path));
			}
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

	/**
	 * Re-renders the status bar: the counts, and the active runtime's name once
	 * there is more than one to tell apart (ADR-0004). Called from scope events
	 * and registry changes only (PRD N4).
	 */
	private updateStatusBar(): void {
		const el = this.statusBarEl;
		if (!el) return;
		el.empty();
		if (!this.settings.notifications.statusBar) return;
		// The live name: a rename shows without waiting for a reconnect.
		const name = runtimeDisplayName(withLiveName(this.settings, this.endpoint.runtime));
		// Which runtime the counts are for (issue #54), always in the tooltip.
		const where = `Herdr agents on ${name}`;
		setTooltip(el, where);
		el.setAttribute('aria-label', where);
		// With one runtime there is nothing to tell apart, and the bar stays
		// terse; with more, the name shows even before any agent does.
		const named = this.settings.runtimes.length > 1;
		if (named) el.createSpan({ cls: 'herdr-status-bar-runtime', text: name });
		const panes = this.scope?.list() ?? [];
		if (panes.length === 0) return;
		if (named) el.createSpan({ text: ' · ' });
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

	/**
	 * Hangs everything downstream off a new scope's events, never off the raw
	 * stream: the scope has already collapsed the ~10 pane.updated per second
	 * (N4). The kind builds the scope; this is the plugin's half.
	 */
	private wireScope<S extends ConnectionScope>(scope: S, endpoint: Endpoint): S {
		scope.on('changed', (_paneId, prev, next) => {
			this.notifier.onChanged(prev, next, endpoint.id);
			this.updateStatusBar();
		});
		// Agent names, which herdr's stream never carries, are the herdr
		// kind's own business since ADR-0005 (`herdr/connect.ts`).
		scope.on('added', () => this.updateStatusBar());
		scope.on('removed', (pane) => {
			this.notifier.forget(pane.paneId, endpoint.id);
			this.updateStatusBar();
		});
		scope.on('workspaceResolved', () => {
			this.notifier.reset();
			this.updateStatusBar();
		});
		return scope;
	}

	/** State the settings tab's status block describes (rendered in settings.ts). */
	private connectionStatus(): ConnectionStatus {
		const scope = this.scope;
		const tunnel = this.tunnel;
		const discovery = this.connection.discovery;
		const runtime: RuntimeConfig = withLiveName(this.settings, this.endpoint.runtime);
		const herdr = this.client instanceof HerdrClient ? this.client : null;
		return {
			runtime,
			unavailable: this.kindUnavailable(runtime.kind),
			details: this.kindOf(runtime.kind).statusLines(this.connection.current),
			discovery,
			socketPath: herdr?.socket ?? discovery?.socketPath ?? '',
			tunnel: tunnel
				? { text: tunnel.statusText, connected: tunnel.status.state === 'connected' }
				: null,
			mismatch: this.mismatch ?? herdr?.lastMismatch ?? null,
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
