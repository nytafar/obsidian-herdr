import {
	App,
	FileSystemAdapter,
	Menu,
	Modal,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	TFolder,
} from 'obsidian';
import { DEFAULT_SETTINGS, HerdrSettings, HerdrSettingTab } from './settings';
import { discoverHerdr, type DiscoveryResult } from './herdr/binary';
import { HerdrClient, type ProtocolMismatch } from './herdr/client';
import { SCOPE_SUBSCRIPTIONS, WorkspaceScope } from './herdr/scope';
import { SshTunnel } from './herdr/ssh';
import { GhosttyWebRenderer } from './views/renderer/ghosttyWeb';
import { HerdrActions, resolveFolderPath, type ActionHost } from './actions';
import { TransitionNotifier, sendOsNotification } from './notify';
import { AGENT_LIST_VIEW_TYPE, AgentListView, countStatuses } from './views/agentListView';

/** Colour ramp, bold/underline and a box drawing line; enough to eyeball the renderer. */
const SAMPLE_ANSI =
	'\x1b[1mHerdr renderer smoke test\x1b[0m\r\n' +
	'\x1b[4munderline\x1b[0m \x1b[7mreverse\x1b[0m \x1b[2mdim\x1b[0m\r\n' +
	[0, 1, 2, 3, 4, 5, 6, 7]
		.map((i) => `\x1b[3${i}m${i}\x1b[0m\x1b[9${i}m${i}\x1b[0m`)
		.join(' ') +
	'\r\n\x1b[48;5;24m 256-colour \x1b[0m \x1b[38;2;255;128;0mtruecolour\x1b[0m\r\n' +
	'┌──────────┐\r\n│ box draw │\r\n└──────────┘\r\n' +
	'unicode: äöü 漢字 🐑\r\n$ ';

export default class HerdrPlugin extends Plugin {
	settings!: HerdrSettings;
	/** Null until the herdr binary and socket have been discovered. */
	client: HerdrClient | null = null;
	scope: WorkspaceScope | null = null;
	/** Non-null only while a remote profile is enabled (PRD S5). */
	tunnel: SshTunnel | null = null;
	/** Folder actions (PRD M19, M20); safe to call before a connection exists. */
	actions!: HerdrActions;

	private discovery: DiscoveryResult | null = null;
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
			new HerdrSettingTab(this.app, this, (el) => this.renderStatus(el)),
		);

		this.registerView(AGENT_LIST_VIEW_TYPE, (leaf) => new AgentListView(leaf, this));
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
		// `stop()` is async (SIGTERM, then SIGKILL, then the socket file) but
		// `onunload` is not; the tunnel owns its own teardown from here.
		const tunnel = this.tunnel;
		this.tunnel = null;
		void tunnel?.stop();
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
	 * Opens the terminal view for a herdr pane.
	 *
	 * Stub until T9 (PRD M13) replaces the body; the list view and the "start
	 * agent here" action already call it, so only this method changes then.
	 */
	async openTerminal(paneId: string): Promise<void> {
		new Notice(`Herdr: terminal view arrives in T9 (pane ${paneId}).`);
	}

	/**
	 * True when a terminal view for this pane is open, which mutes notifications
	 * for it (PRD M12). Stub until T9; it will become a `getLeavesOfType` lookup.
	 */
	isTerminalOpen(paneId: string): boolean {
		void paneId;
		return false;
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
			takenAgentNames: () => {
				const names = new Set<string>();
				for (const pane of this.scope?.list() ?? []) {
					if (pane.label) names.add(pane.label);
				}
				return names;
			},
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
		// Renderer smoke test (PRD M14): no herdr connection involved, it only
		// writes a canned ANSI sample so the ghostty-web bundle can be eyeballed.
		this.addCommand({
			id: 'renderer-smoke-test',
			name: 'Show renderer smoke test',
			callback: () => {
				new RendererSmokeModal(this.app).open();
			},
		});
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
		});
		this.client = client;

		const scope = new WorkspaceScope({
			workspaceId: this.settings.workspaceId,
			vaultPath: this.vaultPath(),
			remoteVaultPath: remoteProfile.enabled ? remoteProfile.remoteVaultPath : undefined,
		});
		this.scope = scope;

		// Everything downstream hangs off scope events, never off the raw stream:
		// the scope has already collapsed the ~10 pane.updated per second (N4).
		scope.on('changed', (_paneId, prev, next) => {
			this.notifier.onChanged(prev, next);
			this.updateStatusBar();
		});
		scope.on('added', () => this.updateStatusBar());
		scope.on('removed', (pane) => {
			this.notifier.forget(pane.paneId);
			this.updateStatusBar();
		});
		scope.on('workspaceResolved', () => {
			this.notifier.reset();
			this.updateStatusBar();
		});

		try {
			await client.ping();
			// Subscribe before the first listing so nothing is missed in between.
			client.on('*', (event) => scope.ingest(event));
			client.subscribe([...SCOPE_SUBSCRIPTIONS]);
			scope.prime(await client.listWorkspaces(), await client.listPanes());
			this.updateStatusBar();
		} catch (error) {
			this.connectError = (error as Error).message;
			new Notice(`Herdr: ${this.connectError}`);
		}
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

	/** Connection status shown at the top of the settings tab (PRD M1-M3, M6). */
	private renderStatus(el: HTMLElement): void {
		const line = (text: string, warning = false): void => {
			el.createEl('p', { cls: warning ? 'herdr-status-text mod-warning' : 'herdr-status-text', text });
		};
		const discovery = this.discovery;
		if (!discovery) {
			line('Not connected yet.');
			return;
		}
		const remote = this.settings.remote;
		const tunnel = this.tunnel;
		if (tunnel) {
			line(tunnel.statusText, tunnel.status.state !== 'connected');
		} else if (remote.enabled) {
			line('SSH tunnel: not started.', true);
		}
		if (discovery.binary) {
			line(`Binary: ${discovery.binary.path} (${discovery.binary.source})`);
		} else {
			// A remote profile only needs `ssh` locally, so this is not fatal there.
			line(discovery.error ?? 'Herdr binary not found.', !remote.enabled);
			if (!remote.enabled) return;
		}
		if (remote.enabled) {
			line(`Remote terminals: ssh -T ${remote.host} ${remote.remoteBinary}`);
		}
		line(`Socket: ${this.client?.socket ?? discovery.socketPath}`);
		// `discovery.status` describes the *local* server. With a remote profile
		// that is the wrong machine, so the tunnel line above stands in for it.
		const status = discovery.status;
		if (!remote.enabled) {
			line(
				status
					? `Server: ${status.status}, version ${status.version ?? 'unknown'}, protocol ${status.protocol ?? 'unknown'}`
					: `Server: not reachable (${discovery.error ?? 'unknown error'})`,
				!status,
			);
		}
		const mismatch = this.mismatch ?? this.client?.lastMismatch ?? null;
		if (mismatch) {
			line(
				`Protocol mismatch: herdr speaks ${mismatch.server}, this plugin was built against ${mismatch.expected}. Everything still works unless a method is missing.`,
				true,
			);
		}
		const scope = this.scope;
		if (scope?.workspaceId) {
			line(
				`Workspace: ${scope.workspaceLabel ?? scope.workspaceId} (${scope.workspaceId}, matched by ${scope.method}), ${scope.size} agent panes`,
			);
		} else {
			line('Workspace: no herdr workspace matches this vault yet.', true);
		}
		if (this.connectError) line(this.connectError, true);
	}
}

/**
 * Dev-only harness for PRD M14: mounts `GhosttyWebRenderer` in a modal and writes
 * a canned ANSI sample. Nothing here touches herdr.
 */
class RendererSmokeModal extends Modal {
	private renderer: GhosttyWebRenderer | undefined;

	constructor(app: App) {
		super(app);
	}

	override onOpen(): void {
		this.setTitle('Herdr renderer smoke test');
		const host = this.contentEl.createDiv({ cls: 'herdr-terminal-host' });
		const renderer = new GhosttyWebRenderer({ scrollback: 200 });
		this.renderer = renderer;
		void renderer
			.mount(host)
			.then(() => {
				renderer.write(new TextEncoder().encode(SAMPLE_ANSI));
				renderer.focus();
			})
			.catch((err: unknown) => {
				new Notice(`Herdr: renderer failed to start (${String(err)})`);
			});
	}

	override onClose(): void {
		this.renderer?.dispose();
		this.renderer = undefined;
		this.contentEl.empty();
	}
}
