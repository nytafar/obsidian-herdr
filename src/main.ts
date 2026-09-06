import { homedir } from 'node:os';
import {
	addIcon,
	FileSystemAdapter,
	Menu,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	TFolder,
	type WorkspaceLeaf,
} from 'obsidian';
import {
	DEFAULT_SETTINGS,
	HerdrSettingTab,
	renderConnectionStatus,
	type ConnectionStatus,
	type HerdrSettings,
} from './settings';
import { discoverHerdr, type DiscoveryResult } from './herdr/binary';
import { HerdrClient, type ProtocolMismatch } from './herdr/client';
import { SCOPE_SUBSCRIPTIONS, WorkspaceScope } from './herdr/scope';
import { SshTunnel } from './herdr/ssh';
import { HerdrActions, resolveFolderPath, type ActionHost } from './actions';
import { TransitionNotifier, sendOsNotification, unsupportedMethodMessage } from './notify';
import { AGENT_LIST_VIEW_TYPE, AgentListView, countStatuses } from './views/agentListView';
import { registerKindIcons } from './views/kindIcons';
import { TERMINAL_VIEW_TYPE, TerminalView, stateMatchesPane } from './views/terminalView';
import { decidePlacement } from './terminalPlacement';

/** Delay before a coalesced `agent.list` refresh; a burst of panes is one call. */
const AGENT_NAME_REFRESH_MS = 300;

export default class HerdrPlugin extends Plugin {
	settings!: HerdrSettings;
	/** Null until the herdr binary and socket have been discovered. */
	client: HerdrClient | null = null;
	scope: WorkspaceScope | null = null;
	/** Non-null only while a remote profile is enabled (PRD S5). */
	tunnel: SshTunnel | null = null;
	/** Folder actions (PRD M19, M20); safe to call before a connection exists. */
	actions!: HerdrActions;
	/**
	 * Views that outlive a connection (a restored sidebar opens before `connect`
	 * runs; a plugin reload rebuilds them before it) subscribe here and rebind to
	 * whatever `scope` is now. Called after every assignment of `scope`.
	 */
	private readonly scopeListeners = new Set<() => void>();

	private discovery: DiscoveryResult | null = null;
	/** One prime at a time; a reconnect can land while the first is in flight. */
	private priming = false;
	/** Pending coalesced `agent.list`, 0 when none. */
	private agentNameTimer = 0;
	private mismatch: ProtocolMismatch | null = null;
	private connectError: string | null = null;
	private notifier!: TransitionNotifier;
	private statusBarEl: HTMLElement | null = null;
	/** Cached `document.hasFocus()`, kept fresh by focus/blur (notes/electron-node.md). */
	private windowFocused = true;

	async onload() {
		await this.loadSettings();
		this.actions = new HerdrActions(this.actionHost());
		this.notifier = new TransitionNotifier({
			now: () => Date.now(),
			settings: () => this.settings.notifications,
			isTerminalOpen: (paneId) => this.isTerminalOpen(paneId),
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
			void this.connect();
		});
	}

	onunload() {
		// Leaves are never detached here: Obsidian restores them and the user
		// decides where the view lives (PRD M10, N1).
		this.client?.dispose();
		this.client = null;
		this.scope = null;
		this.scopeListeners.clear();
		// `stop()` is async (SIGTERM, then SIGKILL, then the socket file) but
		// `onunload` is not; the tunnel owns its own teardown from here.
		const tunnel = this.tunnel;
		this.tunnel = null;
		void tunnel?.stop();
		if (this.agentNameTimer) window.clearTimeout(this.agentNameTimer);
		this.agentNameTimer = 0;
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
		return this.discovery?.binary?.path ?? this.settings.herdrBinary.trim();
	}

	/**
	 * Opens the terminal view for a herdr pane (PRD M13, issue #28).
	 *
	 * One view per pane: an existing leaf for the same pane is revealed, so a
	 * second open neither spawns a second bridge process nor carves out another
	 * split. Only a genuinely new terminal is placed, beside the note when that
	 * note lives inside the agent's working directory and in a tab otherwise.
	 */
	async openTerminal(paneId: string): Promise<void> {
		const workspace = this.app.workspace;
		let leaf = this.terminalLeaf(paneId);
		if (!leaf) {
			leaf = this.leafForNewTerminal(paneId);
			await leaf.setViewState({
				type: TERMINAL_VIEW_TYPE,
				active: true,
				state: { paneId, mode: this.settings.defaultAttachMode },
			});
		}
		await workspace.revealLeaf(leaf);
	}

	/** The leaf a new terminal view takes (issue #28). */
	private leafForNewTerminal(paneId: string): WorkspaceLeaf {
		const workspace = this.app.workspace;
		const decision = decidePlacement({
			placement: this.settings.terminalPlacement,
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
	 * True when a terminal view for this pane is open, which mutes notifications
	 * for it (PRD M12).
	 */
	isTerminalOpen(paneId: string): boolean {
		return this.terminalLeaf(paneId) !== null;
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

	/** Runs `listener` whenever `scope` is replaced. Returns the unsubscribe. */
	onScopeReplaced(listener: () => void): () => void {
		this.scopeListeners.add(listener);
		return () => this.scopeListeners.delete(listener);
	}

	/**
	 * The leaf showing this pane's terminal, if any. The persisted view state is
	 * the lookup, not `leaf.view`: a background leaf may still be deferred, and
	 * the guidelines forbid holding view references (PRD N1).
	 */
	private terminalLeaf(paneId: string): WorkspaceLeaf | null {
		for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
			if (stateMatchesPane(leaf.getViewState().state, paneId)) return leaf;
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
	 * Finds herdr, opens the JSON API connection and primes the workspace scope.
	 * Read-only: `ping`, `workspace.list`, `pane.list` and `events.subscribe`.
	 * Never throws; failures land in the settings status.
	 */
	private async connect(): Promise<void> {
		this.connectError = null;
		const discovery = await discoverHerdr({
			override: this.settings.herdrBinary,
			extraPath: this.settings.extraPath,
			socketOverride: this.settings.socketPath,
		});
		this.discovery = discovery;
		const remoteProfile = this.settings.remote;
		// A remote profile needs `ssh`, not a local herdr, so a missing local
		// binary only stops the local path.
		if (!discovery.binary && !remoteProfile.enabled) {
			new Notice(`Herdr: ${discovery.error ?? 'herdr binary not found'}`);
			return;
		}

		// Remote: the API socket is the local end of an SSH forward (PRD S5).
		// Terminals do not use it; they run the CLI over `ssh -T` (PRD S17).
		let socketPath = discovery.socketPath;
		if (remoteProfile.enabled) {
			try {
				socketPath = await this.startTunnel();
			} catch (error) {
				this.connectError = (error as Error).message;
				new Notice(`Herdr: ${this.connectError}`);
				return;
			}
		}

		const client = new HerdrClient({
			socketPath,
			onProtocolMismatch: (mismatch) => {
				this.mismatch = mismatch;
			},
			// PRD M3: an unsupported method is reported once, then never retried.
			onUnsupportedMethod: (method) => {
				new Notice(unsupportedMethodMessage(method));
			},
		});
		this.client = client;

		const scope = new WorkspaceScope({
			workspaceId: this.settings.workspaceId,
			vaultPath: this.vaultPath(),
			remoteVaultPath: remoteProfile.enabled ? remoteProfile.remoteVaultPath : undefined,
		});
		this.scope = scope;
		for (const listener of [...this.scopeListeners]) listener();

		// Everything downstream hangs off scope events, never off the raw stream:
		// the scope has already collapsed the ~10 pane.updated per second (N4).
		scope.on('changed', (_paneId, prev, next) => {
			this.notifier.onChanged(prev, next);
			this.updateStatusBar();
		});
		scope.on('added', () => {
			this.updateStatusBar();
			// A pane that just gained an agent has no name yet: names are not on
			// the event stream, only in `agent.list` (PRD M8).
			this.refreshAgentNames();
		});
		scope.on('removed', (pane) => {
			this.notifier.forget(pane.paneId);
			this.updateStatusBar();
		});
		scope.on('workspaceResolved', () => {
			this.notifier.reset();
			this.updateStatusBar();
			this.refreshAgentNames();
		});

		// The one place the scope is loaded: the event stream's `connected` edge,
		// which fires on the first subscribe ack and again after every reconnect.
		// Listing only there means nothing is missed between the two (PRD M4) and
		// that panes closed during an outage do not stay listed forever.
		client.on('connected', () => {
			this.connectError = null;
			void this.primeScope();
		});
		client.on('disconnected', (error) => {
			if (error) this.connectError = error.message;
		});

		try {
			await client.ping();
			client.on('*', (event) => scope.ingest(event));
			client.subscribe([...SCOPE_SUBSCRIPTIONS]);
		} catch (error) {
			this.connectError = (error as Error).message;
			new Notice(`Herdr: ${this.connectError}`);
		}
	}

	/**
	 * Loads workspaces, panes and agent names into the scope.
	 *
	 * `session.snapshot` carries all three in one round trip (PRD section 7); a
	 * server that does not know the method falls back to the three list calls
	 * (PRD M3). Runs from the event stream's `connected` edge — the first ack and
	 * every reconnect — and `prime` diffs rather than resets, so a re-prime is
	 * invisible unless something actually changed while the stream was down.
	 */
	private async primeScope(): Promise<void> {
		const client = this.client;
		const scope = this.scope;
		if (!client || !scope || this.priming) return;
		this.priming = true;
		try {
			const snapshot = await client.snapshot();
			// Names first: `prime` reads them when it builds the pane states.
			if (snapshot) {
				scope.setAgentNames(snapshot.agents ?? []);
				scope.prime(snapshot.workspaces ?? [], snapshot.panes ?? []);
			} else {
				scope.setAgentNames(await client.listAgents());
				scope.prime(await client.listWorkspaces(), await client.listPanes());
			}
			this.connectError = null;
		} catch (error) {
			this.connectError = (error as Error).message;
		} finally {
			this.priming = false;
		}
		this.updateStatusBar();
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
	 * Opens the SSH forward for the remote profile and returns its local socket.
	 * The client is pointed at that socket instead of the discovered one; the
	 * tunnel keeps itself alive with backoff after a drop.
	 */
	private async startTunnel(): Promise<string> {
		const remote = this.settings.remote;
		const host = remote.host.trim();
		if (host.length === 0) {
			throw new Error('the remote profile has no SSH host');
		}
		const tunnel = new SshTunnel({
			host,
			remoteSocketPath: remote.remoteSocketPath.trim(),
			onStatus: (status) => {
				// The local path never changes, so this only matters after a
				// reconnect: the client picks the fresh socket up on the next call.
				if (status.state === 'connected') this.client?.setSocketPath(status.localSocketPath);
			},
		});
		this.tunnel = tunnel;
		return await tunnel.start();
	}

	/** State the settings tab's status block describes (rendered in settings.ts). */
	private connectionStatus(): ConnectionStatus {
		const scope = this.scope;
		const tunnel = this.tunnel;
		return {
			discovery: this.discovery,
			socketPath: this.client?.socket ?? this.discovery?.socketPath ?? '',
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
