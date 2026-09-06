import { App, PluginSettingTab, Setting } from 'obsidian';
import type HerdrPlugin from './main';
import type { DiscoveryResult } from './herdr/binary';
import type { ProtocolMismatch } from './herdr/client';
import type { RowClickAction } from './views/rowModel';

/** Agent kinds herdr can start. Source of truth is `agent.start --help`. */
export const AGENT_KINDS = [
	'claude',
	'codex',
	'gemini',
	'opencode',
	'pi',
	'cursor',
	'amp',
	'copilot',
	'kimi',
	'droid',
	'grok',
] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

/** How a terminal view attaches to a herdr pane. */
export type AttachMode = 'control' | 'observe';

/**
 * Where the terminal view opens when a note from the agent's directory is open
 * (issue #28). `tab` is the pre-#28 behaviour and is used everywhere else.
 */
export type TerminalPlacement = 'split-right' | 'split-left' | 'tab';

/**
 * Row order in the agent list (issue #20). `priority` is herdr's own attention
 * order, so the sidebar and a herdr TUI set to `agent_panel_sort = "priority"`
 * agree; `alphabetical` is by the name a row displays.
 */
export type AgentListSort = 'priority' | 'alphabetical';

/**
 * What the agent list groups rows under (issue #20). `tab` is the herdr tab and
 * the v1 behaviour; `folder` keeps one project's agents together even when herdr
 * has spread them over two tabs; `none` is a flat list.
 */
export type AgentListGroupBy = 'tab' | 'folder' | 'none';

/** Status transitions the plugin notifies about. Others are noise (PRD M12). */
export type NotifiedTransition = 'blocked' | 'done';

export interface TransitionNotificationSettings {
	/** Show an Obsidian `Notice` on the transition. */
	notice: boolean;
	/** Show an OS notification, only while the Obsidian window is unfocused. */
	os: boolean;
}

export interface NotificationSettings {
	/** Show the status bar item with blocked/done counts. */
	statusBar: boolean;
	blocked: TransitionNotificationSettings;
	done: TransitionNotificationSettings;
}

export interface RemoteSettings {
	/** Use a remote herdr over SSH instead of the local one. */
	enabled: boolean;
	/** SSH destination, e.g. `user@host` or a `~/.ssh/config` alias. */
	host: string;
	/** Socket path of the herdr server on the remote host. */
	remoteSocketPath: string;
	/** Absolute path to the herdr binary on the remote host. */
	remoteBinary: string;
	/** Absolute path of this vault on the remote host. */
	remoteVaultPath: string;
}

export interface HerdrSettings {
	/** Unix socket of the local herdr JSON API. */
	socketPath: string;
	/** Override for the local herdr binary. Empty means auto-discovery. */
	herdrBinary: string;
	/** Workspace id override. Empty means resolve by label, then by cwd. */
	workspaceId: string;
	remote: RemoteSettings;
	notifications: NotificationSettings;
	/** Agent kind used by "Herdr: start agent here". */
	defaultAgentKind: AgentKind;
	/** Name pattern for started agents. Supports `{folder}`, `{vault}`, `{n}`. */
	agentNamePattern: string;
	/** Terminal font family. Empty follows the Obsidian monospace font. */
	terminalFontFamily: string;
	/** Terminal font size in pixels. 0 follows the Obsidian monospace size. */
	terminalFontSize: number;
	/** Megabytes of scrollback each open terminal may keep. See {@link clampScrollbackMb}. */
	terminalScrollbackMb: number;
	/** Open the terminal view after starting an agent. */
	openTerminalAfterStart: boolean;
	/** Directories appended to PATH when spawning herdr, colon separated. */
	extraPath: string;
	/** Row order inside each group of the agent list. */
	agentListSort: AgentListSort;
	/** What the agent list groups its rows under. */
	agentListGroupBy: AgentListGroupBy;
	/** Attach mode used when opening a terminal view. */
	defaultAttachMode: AttachMode;
	/** Where a terminal opens when the active note is inside the agent's cwd. */
	terminalPlacement: TerminalPlacement;
	/**
	 * What clicking the body of an agent row does (issue #21). The row's icon
	 * button always does the other one, so this setting swaps the pair.
	 */
	agentListRowClick: RowClickAction;
}

/**
 * Scrollback budget bounds, in megabytes per open terminal.
 *
 * ghostty-web's `scrollback` option is a **byte** budget for libghostty-vt's page
 * list, not a line count: measured headlessly, 10 MB holds ~5 961 lines, so
 * roughly 600 lines per megabyte, and the memory is taken from the one WebAssembly
 * memory every terminal in the window shares — which grows but never shrinks
 * (notes/memory.md). Hence a small default and a hard ceiling: 64 MB across a few
 * open terminals is already a quarter of a gigabyte that Obsidian keeps until it
 * restarts. `0` is never allowed through; it means "unlimited" and grew past 1 GB
 * in the measurement.
 */
export const MIN_SCROLLBACK_MB = 1;
export const MAX_SCROLLBACK_MB = 64;
export const DEFAULT_SCROLLBACK_MB = 10;
/** Bytes per megabyte for the budget. Decimal, because the setting is user-facing. */
export const SCROLLBACK_BYTES_PER_MB = 1_000_000;

/**
 * Whatever `data.json` holds (hand-edited, from an older version, or missing)
 * turned into an integer number of megabytes inside the supported range.
 */
export function clampScrollbackMb(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SCROLLBACK_MB;
	const whole = Math.round(value);
	return Math.min(MAX_SCROLLBACK_MB, Math.max(MIN_SCROLLBACK_MB, whole));
}

/** The byte budget handed to the renderer for one terminal. */
export function scrollbackBytes(settings: HerdrSettings): number {
	return clampScrollbackMb(settings.terminalScrollbackMb) * SCROLLBACK_BYTES_PER_MB;
}

export const DEFAULT_SETTINGS: HerdrSettings = {
	socketPath: '~/.config/herdr/herdr.sock',
	herdrBinary: '',
	workspaceId: '',
	remote: {
		enabled: false,
		host: '',
		remoteSocketPath: '~/.config/herdr/herdr.sock',
		remoteBinary: '~/.local/bin/herdr',
		remoteVaultPath: '',
	},
	notifications: {
		statusBar: true,
		blocked: { notice: true, os: true },
		done: { notice: true, os: false },
	},
	defaultAgentKind: 'claude',
	agentNamePattern: '{folder}',
	terminalFontFamily: '',
	terminalFontSize: 0,
	terminalScrollbackMb: DEFAULT_SCROLLBACK_MB,
	openTerminalAfterStart: true,
	extraPath: '',
	agentListSort: 'priority',
	agentListGroupBy: 'tab',
	defaultAttachMode: 'control',
	terminalPlacement: 'split-right',
	agentListRowClick: 'terminal',
};

/**
 * Why the remote profile cannot turn a vault folder into a remote cwd, or null
 * when it can (PRD S5, M19).
 *
 * With the remote profile on and `remoteVaultPath` empty, path resolution falls
 * back to the local base path, which would hand a macOS path to a Linux host.
 * Refusing beats silently running an agent in the wrong (or a non-existent)
 * directory, so both the folder actions and the settings status ask this.
 */
export function remoteVaultPathIssue(settings: HerdrSettings): string | null {
	const remote = settings.remote;
	if (!remote.enabled) return null;
	if (remote.remoteVaultPath.trim()) return null;
	return 'the remote profile has no remote vault path, so folder paths cannot be resolved on the remote host';
}

/**
 * Renders connection status at the top of the settings tab. The plugin owns the
 * connection, so it supplies this; the tab only gives it a container.
 */
export type RenderStatus = (el: HTMLElement) => void;

/** The live connection state {@link renderConnectionStatus} describes. */
export interface ConnectionStatus {
	/** Binary and socket discovery, or null before the first connect attempt. */
	discovery: DiscoveryResult | null;
	/** Socket the client actually uses; the tunnel's local end when remote. */
	socketPath: string;
	/** SSH forward state, or null when no tunnel was started. */
	tunnel: { text: string; connected: boolean } | null;
	mismatch: ProtocolMismatch | null;
	/** Scoped workspace, or null when none matches this vault. */
	workspace: { id: string; label: string | null; method: string; agentCount: number } | null;
	/** Last connect or prime failure. */
	error: string | null;
}

/**
 * The status block at the top of the settings tab (PRD M1-M3, M6, S5). Pure
 * rendering: `main.ts` gathers the state and this decides what to say about it.
 */
export function renderConnectionStatus(
	el: HTMLElement,
	settings: HerdrSettings,
	status: ConnectionStatus,
): void {
	const line = (text: string, warning = false): void => {
		el.createEl('p', {
			cls: warning ? 'herdr-status-text mod-warning' : 'herdr-status-text',
			text,
		});
	};
	const { discovery } = status;
	if (!discovery) {
		line('Not connected yet.');
		return;
	}
	const remote = settings.remote;
	if (status.tunnel) {
		line(status.tunnel.text, !status.tunnel.connected);
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
		// Without it the folder actions refuse rather than send a local path to
		// the remote host (see `remoteVaultPathIssue`).
		const issue = remoteVaultPathIssue(settings);
		if (issue) line(`Folder actions are off: ${issue}.`, true);
	}
	line(`Socket: ${status.socketPath}`);
	// `discovery.status` describes the *local* server. With a remote profile
	// that is the wrong machine, so the tunnel line above stands in for it.
	if (!remote.enabled) {
		const server = discovery.status;
		line(
			server
				? `Server: ${server.status}, version ${server.version ?? 'unknown'}, protocol ${server.protocol ?? 'unknown'}`
				: `Server: not reachable (${discovery.error ?? 'unknown error'})`,
			!server,
		);
	}
	if (status.mismatch) {
		line(
			`Protocol mismatch: herdr speaks ${status.mismatch.server}, this plugin was built against ${status.mismatch.expected}. Everything still works unless a method is missing.`,
			true,
		);
	}
	if (status.workspace) {
		const { id, label, method, agentCount } = status.workspace;
		line(`Workspace: ${label ?? id} (${id}, matched by ${method}), ${agentCount} agent panes`);
	} else {
		line('Workspace: no herdr workspace matches this vault yet.', true);
	}
	if (status.error) line(status.error, true);
}

export class HerdrSettingTab extends PluginSettingTab {
	private readonly plugin: HerdrPlugin;
	private readonly renderStatus: RenderStatus;

	constructor(app: App, plugin: HerdrPlugin, renderStatus: RenderStatus) {
		super(app, plugin);
		this.plugin = plugin;
		this.renderStatus = renderStatus;
	}

	private async save(): Promise<void> {
		await this.plugin.saveSettings();
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;

		containerEl.empty();

		this.renderStatus(containerEl.createDiv({ cls: 'herdr-settings-status' }));

		new Setting(containerEl).setName('Connection').setHeading();

		new Setting(containerEl)
			.setName('Socket path')
			.setDesc(
				'Unix socket of the running herdr server. Leave the default unless you start herdr with a custom socket.',
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.socketPath)
					.setValue(settings.socketPath)
					.onChange(async (value) => {
						settings.socketPath = value;
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Herdr binary')
			.setDesc(
				'Absolute path to the herdr executable. Leave empty to search Homebrew, /usr/local/bin, ~/.local/bin and a login-shell PATH. Set it if Obsidian was launched from the Dock and cannot find herdr.',
			)
			.addText((text) =>
				text
					.setPlaceholder('Auto-discover')
					.setValue(settings.herdrBinary)
					.onChange(async (value) => {
						settings.herdrBinary = value;
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Extra PATH entries')
			.setDesc(
				'Colon-separated directories appended to PATH when the plugin spawns herdr, for tools your agents need.',
			)
			.addText((text) =>
				text
					.setPlaceholder('/opt/homebrew/bin:/usr/local/bin')
					.setValue(settings.extraPath)
					.onChange(async (value) => {
						settings.extraPath = value;
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Workspace ID')
			.setDesc(
				'Pin the plugin to one herdr workspace. Leave empty to match the workspace labelled like the vault folder, then the one whose panes run inside the vault. Ids are opaque and change between servers.',
			)
			.addText((text) =>
				text
					.setPlaceholder('Auto-detect')
					.setValue(settings.workspaceId)
					.onChange(async (value) => {
						settings.workspaceId = value;
						await this.save();
					}),
			);

		new Setting(containerEl).setName('Remote host').setHeading();

		new Setting(containerEl)
			.setName('Use a remote herdr')
			.setDesc(
				'Talk to herdr on another machine over SSH. The socket is forwarded locally and terminals are spawned through ssh.',
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.remote.enabled).onChange(async (value) => {
					settings.remote.enabled = value;
					await this.save();
					this.display();
				}),
			);

		if (settings.remote.enabled) {
			new Setting(containerEl)
				.setName('SSH host')
				.setDesc(
					'SSH destination, for example user@host or an alias from your SSH config. Key-based login without a passphrase prompt is required.',
				)
				.addText((text) =>
					text
						.setPlaceholder('user@host')
						.setValue(settings.remote.host)
						.onChange(async (value) => {
							settings.remote.host = value;
							await this.save();
						}),
				);

			new Setting(containerEl)
				.setName('Remote socket path')
				.setDesc('Socket of the herdr server on the remote host.')
				.addText((text) =>
					text
						.setPlaceholder(DEFAULT_SETTINGS.remote.remoteSocketPath)
						.setValue(settings.remote.remoteSocketPath)
						.onChange(async (value) => {
							settings.remote.remoteSocketPath = value;
							await this.save();
						}),
				);

			new Setting(containerEl)
				.setName('Remote herdr binary')
				.setDesc(
					'Absolute path to herdr on the remote host. Non-interactive SSH usually has a minimal PATH, so a full path is safest.',
				)
				.addText((text) =>
					text
						.setPlaceholder(DEFAULT_SETTINGS.remote.remoteBinary)
						.setValue(settings.remote.remoteBinary)
						.onChange(async (value) => {
							settings.remote.remoteBinary = value;
							await this.save();
						}),
				);

			new Setting(containerEl)
				.setName('Remote vault path')
				.setDesc(
					'Absolute path of this vault on the remote host. Folder actions resolve note paths against it.',
				)
				.addText((text) =>
					text
						.setPlaceholder('/home/user/vault')
						.setValue(settings.remote.remoteVaultPath)
						.onChange(async (value) => {
							settings.remote.remoteVaultPath = value;
							await this.save();
						}),
				);
		}

		new Setting(containerEl).setName('Notifications').setHeading();

		new Setting(containerEl)
			.setName('Status bar counts')
			.setDesc(
				'Show how many agents in this vault are blocked or done, in the status bar.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(settings.notifications.statusBar)
					.onChange(async (value) => {
						settings.notifications.statusBar = value;
						await this.save();
					}),
			);

		this.addTransitionSettings(
			containerEl,
			'blocked',
			'Blocked',
			'an agent stops and waits for you',
		);
		this.addTransitionSettings(
			containerEl,
			'done',
			'Done',
			'an agent finishes its turn',
		);

		new Setting(containerEl).setName('Agents').setHeading();

		new Setting(containerEl)
			.setName('Default agent kind')
			.setDesc('Agent started by "Start agent here".')
			.addDropdown((dropdown) => {
				for (const kind of AGENT_KINDS) {
					dropdown.addOption(kind, kind);
				}
				dropdown
					.setValue(settings.defaultAgentKind)
					.onChange(async (value) => {
						settings.defaultAgentKind = value as AgentKind;
						await this.save();
					});
			});

		new Setting(containerEl)
			.setName('Agent name pattern')
			.setDesc(
				'Name given to new agents. {folder} is the folder the agent starts in, {vault} the vault name, {n} a counter that avoids collisions.',
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.agentNamePattern)
					.setValue(settings.agentNamePattern)
					.onChange(async (value) => {
						settings.agentNamePattern = value;
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Open terminal after starting an agent')
			.setDesc('Open the new agent as a terminal tab as soon as it starts.')
			.addToggle((toggle) =>
				toggle
					.setValue(settings.openTerminalAfterStart)
					.onChange(async (value) => {
						settings.openTerminalAfterStart = value;
						await this.save();
					}),
			);

		new Setting(containerEl).setName('Agent list').setHeading();

		new Setting(containerEl)
			.setName('Sort')
			.setDesc(
				'Row order inside each group. Priority is herdr’s own: blocked first, then finished but unseen, then working, then idle, with the most recent change first among equals.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('priority', 'Priority (same as herdr)')
					.addOption('alphabetical', 'Alphabetical by name')
					.setValue(settings.agentListSort)
					.onChange(async (value) => {
						settings.agentListSort = value as AgentListSort;
						await this.save();
						this.plugin.refreshAgentList();
					}),
			);

		new Setting(containerEl)
			.setName('Group by')
			.setDesc(
				'What rows are grouped under. Folder keeps a project’s agents together when herdr has spread them over several tabs.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('tab', 'Herdr tab')
					.addOption('folder', 'Working directory')
					.addOption('none', 'Nothing, one flat list')
					.setValue(settings.agentListGroupBy)
					.onChange(async (value) => {
						settings.agentListGroupBy = value as AgentListGroupBy;
						await this.save();
						this.plugin.refreshAgentList();
					}),
			);

		new Setting(containerEl)
			.setName('Clicking an agent row')
			.setDesc(
				'What a click on the row itself does. The icon button on the row always does the other one, and its tooltip says which.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('terminal', 'Opens the terminal in Obsidian')
					.addOption('focus', 'Focuses the pane in herdr')
					.setValue(settings.agentListRowClick)
					.onChange(async (value) => {
						settings.agentListRowClick = value as RowClickAction;
						await this.save();
						this.plugin.refreshAgentList();
					}),
			);

		new Setting(containerEl).setName('Terminal').setHeading();

		new Setting(containerEl)
			.setName('Attach mode')
			.setDesc(
				'Control types into the agent and makes the herdr pane follow this window’s size while the view is open; closing it hands ownership back. Observe is read-only and leaves the pane alone.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('control', 'Control (type and resize)')
					.addOption('observe', 'Observe (read-only)')
					.setValue(settings.defaultAttachMode)
					.onChange(async (value) => {
						settings.defaultAttachMode = value as AttachMode;
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Terminal placement')
			.setDesc(
				'Where a terminal opens when the note you are looking at lives inside the agent’s working directory. Otherwise, and when that terminal is already open, nothing splits: the existing tab is revealed.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('split-right', 'Split to the right of the note')
					.addOption('split-left', 'Split to the left of the note')
					.addOption('tab', 'Always a new tab')
					.setValue(settings.terminalPlacement)
					.onChange(async (value) => {
						settings.terminalPlacement = value as TerminalPlacement;
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Font family')
			.setDesc(
				'Font for the terminal view. Leave empty to follow the Obsidian monospace font.',
			)
			.addText((text) =>
				text
					.setPlaceholder('Follow Obsidian')
					.setValue(settings.terminalFontFamily)
					.onChange(async (value) => {
						settings.terminalFontFamily = value;
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Scrollback memory budget')
			.setDesc(
				'Megabytes of scrollback each open terminal keeps. This is a memory budget, not a line count: roughly 600 lines per megabyte. The memory is shared by every open terminal and is only given back when Obsidian restarts.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(MIN_SCROLLBACK_MB, MAX_SCROLLBACK_MB, 1)
					.setValue(clampScrollbackMb(settings.terminalScrollbackMb))
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.terminalScrollbackMb = clampScrollbackMb(value);
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('Font size')
			.setDesc(
				'Terminal font size in pixels. Set to 0 to follow the Obsidian monospace size.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 32, 1)
					.setValue(settings.terminalFontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.terminalFontSize = value;
						await this.save();
					}),
			);
	}

	private addTransitionSettings(
		containerEl: HTMLElement,
		transition: NotifiedTransition,
		label: string,
		when: string,
	): void {
		const state = this.plugin.settings.notifications[transition];

		new Setting(containerEl)
			.setName(`${label}: notice`)
			.setDesc(`Show a notice in Obsidian when ${when}.`)
			.addToggle((toggle) =>
				toggle.setValue(state.notice).onChange(async (value) => {
					state.notice = value;
					await this.save();
				}),
			);

		new Setting(containerEl)
			.setName(`${label}: system notification`)
			.setDesc(
				`Send a system notification when ${when} and the Obsidian window is not focused.`,
			)
			.addToggle((toggle) =>
				toggle.setValue(state.os).onChange(async (value) => {
					state.os = value;
					await this.save();
				}),
			);
	}
}
