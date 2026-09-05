import { App, PluginSettingTab, Setting } from 'obsidian';
import type HerdrPlugin from './main';

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
	/** Open the terminal view after starting an agent. */
	openTerminalAfterStart: boolean;
	/** Directories appended to PATH when spawning herdr, colon separated. */
	extraPath: string;
	/** Attach mode used when opening a terminal view. */
	defaultAttachMode: AttachMode;
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
	openTerminalAfterStart: true,
	extraPath: '',
	defaultAttachMode: 'control',
};

/**
 * Renders connection status at the top of the settings tab. The plugin owns the
 * connection, so it supplies this; the tab only gives it a container.
 */
export type RenderStatus = (el: HTMLElement) => void;

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
