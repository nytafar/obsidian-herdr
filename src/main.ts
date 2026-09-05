import { App, FileSystemAdapter, Modal, Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, HerdrSettings, HerdrSettingTab } from './settings';
import { discoverHerdr, type DiscoveryResult } from './herdr/binary';
import { HerdrClient, type ProtocolMismatch } from './herdr/client';
import { SCOPE_SUBSCRIPTIONS, WorkspaceScope } from './herdr/scope';
import { GhosttyWebRenderer } from './views/renderer/ghosttyWeb';

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

	private discovery: DiscoveryResult | null = null;
	private mismatch: ProtocolMismatch | null = null;
	private connectError: string | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(
			new HerdrSettingTab(this.app, this, (el) => this.renderStatus(el)),
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
		// Vault-facing work waits for the layout, per the Obsidian guidelines.
		this.app.workspace.onLayoutReady(() => {
			void this.connect();
		});
	}

	onunload() {
		this.client?.dispose();
		this.client = null;
		this.scope = null;
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
		if (!discovery.binary) {
			new Notice(`Herdr: ${discovery.error ?? 'herdr binary not found'}`);
			return;
		}

		const client = new HerdrClient({
			socketPath: discovery.socketPath,
			onProtocolMismatch: (mismatch) => {
				this.mismatch = mismatch;
			},
		});
		this.client = client;

		const remote = this.settings.remote;
		const scope = new WorkspaceScope({
			workspaceId: this.settings.workspaceId,
			vaultPath: this.vaultPath(),
			remoteVaultPath: remote.enabled ? remote.remoteVaultPath : undefined,
		});
		this.scope = scope;

		try {
			await client.ping();
			// Subscribe before the first listing so nothing is missed in between.
			client.on('*', (event) => scope.ingest(event));
			client.subscribe([...SCOPE_SUBSCRIPTIONS]);
			scope.prime(await client.listWorkspaces(), await client.listPanes());
		} catch (error) {
			this.connectError = (error as Error).message;
			new Notice(`Herdr: ${this.connectError}`);
		}
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
		if (!discovery.binary) {
			line(discovery.error ?? 'Herdr binary not found.', true);
			return;
		}
		line(`Binary: ${discovery.binary.path} (${discovery.binary.source})`);
		line(`Socket: ${this.client?.socket ?? discovery.socketPath}`);
		const status = discovery.status;
		line(
			status
				? `Server: ${status.status}, version ${status.version ?? 'unknown'}, protocol ${status.protocol ?? 'unknown'}`
				: `Server: not reachable (${discovery.error ?? 'unknown error'})`,
			!status,
		);
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
