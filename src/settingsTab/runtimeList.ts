/**
 * The runtime list as 0.7.1 drew it (ADR-0004): rows with use, edit and
 * remove, an add button, and the form of the runtime being edited under the
 * list. Kept as it was, drawn by a `render` callback (`lists.ts`), until
 * #178 makes runtimes a declarative `list` with a page per runtime and
 * deletes this file.
 */

import { Setting } from 'obsidian';
import { buildDefaultAgentSetting } from '../agents/settingsSection';
import type { HerdrSettings } from '../settings';
import {
	activeRuntimeOf,
	CLAUDE_PERMISSION_MODES,
	CLAUDE_PERMISSION_MODE_LABELS,
	DEFAULT_CLAUDE_PERMISSION_MODE,
	DEFAULT_HERDR_SOCKET,
	issueSentence,
	kindTargets,
	newRuntime,
	normalizePermissionMode,
	removeRuntime,
	runtimeDisplayName,
	runtimeIssues,
	runtimeSummary,
	RUNTIME_KINDS,
	RUNTIME_KIND_LABELS,
	RUNTIME_TARGET_LABELS,
	type RuntimeConfig,
	type RuntimeKind,
	type RuntimeTarget,
} from '../runtimes';
import type { ListCallbacks } from './lists';

/**
 * The runtime registry (ADR-0004): one row per runtime with use, edit and
 * remove, an add button, and the form of the runtime being edited under the
 * list. Which runtime's form is open is the tab's state, handed in through
 * the callbacks, so the section stays buildable on a bare container.
 *
 * A field of the active runtime saves and reconnects, like the connection
 * fields always did; a field of another runtime only saves, since nothing is
 * connected to it. Kind and target redisplay, because they decide which
 * fields the form has.
 */
export function buildRuntimesSection(
	containerEl: HTMLElement,
	settings: HerdrSettings,
	callbacks: ListCallbacks,
): void {
	const active = activeRuntimeOf(settings);
	const only = settings.runtimes.length <= 1;
	for (const runtime of settings.runtimes) {
		const isActive = runtime.id === active.id;
		const notes = [issueSentence(runtimeSummary(runtime))];
		if (isActive) notes.push('Active.');
		const unavailable = callbacks.kindUnavailable(runtime.kind);
		if (unavailable) notes.push(issueSentence(unavailable));
		const row = new Setting(containerEl)
			.setName(runtimeDisplayName(runtime))
			.setDesc(notes.join(' '));
		if (isActive) row.setClass('herdr-runtime-active');
		row.addExtraButton((button) =>
			button
				.setIcon('plug-zap')
				.setTooltip(isActive ? 'Reconnect' : 'Use this runtime')
				.onClick(async () => {
					await callbacks.activateRuntime(runtime.id);
					callbacks.redisplay();
				}),
		);
		row.addExtraButton((button) =>
			button
				.setIcon('pencil')
				.setTooltip('Edit runtime')
				.onClick(() => {
					callbacks.editRuntime(callbacks.editingRuntime() === runtime.id ? null : runtime.id);
				}),
		);
		row.addExtraButton((button) =>
			button
				.setIcon('trash-2')
				// The plugin always needs one runtime to connect to.
				.setTooltip(only ? 'The last runtime cannot be removed' : 'Remove runtime')
				.setDisabled(only)
				.onClick(async () => {
					if (only) return;
					const confirmed = await callbacks.confirm({
						title: `Remove "${runtimeDisplayName(runtime)}"?`,
						body: 'Terminal tabs opened on it stop reconnecting, and its pinned agents are forgotten.',
						confirm: 'Remove runtime',
					});
					if (!confirmed) return;
					const { removed, activeChanged } = removeRuntime(settings, runtime.id);
					if (!removed) return;
					if (callbacks.editingRuntime() === runtime.id) callbacks.editRuntime(null);
					if (activeChanged) await callbacks.activateRuntime(settings.activeRuntime);
					else await callbacks.save();
					callbacks.refreshRuntimes();
					callbacks.redisplay();
				}),
		);
	}

	new Setting(containerEl)
		.setName('Add runtime')
		.setDesc(
			'Another herdr or herdr-core to switch to, on this machine or over SSH, or Claude run by Obsidian, which needs no multiplexer. One runtime is connected at a time.',
		)
		.addButton((button) =>
			button.setButtonText('Add runtime').onClick(async () => {
				const runtime = newRuntime(
					'herdr',
					'ssh',
					settings.runtimes.map((entry) => entry.id),
				);
				settings.runtimes = [...settings.runtimes, runtime];
				await callbacks.save();
				callbacks.refreshRuntimes();
				callbacks.editRuntime(runtime.id);
			}),
		);

	const editing = settings.runtimes.find((runtime) => runtime.id === callbacks.editingRuntime());
	if (editing) buildRuntimeForm(containerEl, editing, editing.id === active.id, callbacks, settings);
}

/** The fields of one runtime, for its kind and target. */
function buildRuntimeForm(
	containerEl: HTMLElement,
	runtime: RuntimeConfig,
	isActive: boolean,
	callbacks: ListCallbacks,
	settings: HerdrSettings,
): void {
	new Setting(containerEl).setName(`Edit ${runtimeDisplayName(runtime)}`).setHeading();

	// Every problem the form can see, refreshed as fields change. Built last,
	// filled by `check`, so typing never redraws the field being typed in.
	let problems: Setting | null = null;
	const check = (): void => {
		const unavailable = callbacks.kindUnavailable(runtime.kind);
		const issues = [...(unavailable ? [unavailable] : []), ...runtimeIssues(runtime)];
		problems?.setDesc(issues.length > 0 ? issues.map(issueSentence).join(' ') : 'None.');
		problems?.descEl.toggleClass('mod-warning', issues.length > 0);
	};
	const changed = async (): Promise<void> => {
		check();
		if (isActive) await callbacks.saveAndReconnect();
		else await callbacks.save();
	};
	const text = (
		name: string,
		desc: string,
		placeholder: string,
		read: () => string,
		write: (value: string) => void,
	): void => {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((field) =>
				field
					.setPlaceholder(placeholder)
					.setValue(read())
					.onChange(async (value) => {
						write(value);
						await changed();
					}),
			);
	};

	new Setting(containerEl)
		.setName('Name')
		.setDesc('What the switcher, the status bar and this list call it.')
		.addText((field) =>
			field
				.setPlaceholder(runtimeDisplayName({ ...runtime, name: '' }))
				.setValue(runtime.name)
				.onChange(async (value) => {
					runtime.name = value;
					await callbacks.save();
					callbacks.refreshRuntimes();
				}),
		);

	new Setting(containerEl)
		.setName('Kind')
		.setDesc(
			'Herdr is the terminal multiplexer with tabs and splits. Herdr-core is the headless hc runtime, which has neither. Claude run by Obsidian starts Claude itself, on this machine, with no multiplexer: its agents stop when Obsidian closes and resume when opened.',
		)
		.addDropdown((dropdown) => {
			for (const kind of RUNTIME_KINDS) dropdown.addOption(kind, RUNTIME_KIND_LABELS[kind]);
			dropdown.setValue(runtime.kind).onChange(async (value) => {
				retarget(runtime, value as RuntimeKind, runtime.target);
				await changed();
				callbacks.refreshRuntimes();
				callbacks.redisplay();
			});
		});

	new Setting(containerEl)
		.setName('Target')
		.setDesc('Where it runs: this machine, or a host reached over SSH.')
		.addDropdown((dropdown) => {
			// Claude run by Obsidian runs here only (ADR-0007).
			for (const target of kindTargets(runtime.kind)) {
				dropdown.addOption(target, RUNTIME_TARGET_LABELS[target]);
			}
			dropdown.setValue(runtime.target).onChange(async (value) => {
				retarget(runtime, runtime.kind, value as RuntimeTarget);
				await changed();
				callbacks.refreshRuntimes();
				callbacks.redisplay();
			});
		});

	if (runtime.kind === 'claude') {
		buildClaudeFields(containerEl, runtime, text, changed);
		problems = new Setting(containerEl).setName('Problems').setClass('herdr-runtime-problems');
		check();
		new Setting(containerEl).addButton((button) =>
			button
				.setButtonText('Done')
				.setCta()
				.onClick(() => callbacks.editRuntime(null)),
		);
		return;
	}
	const herdr = runtime.kind === 'herdr';
	if (runtime.target === 'ssh') {
		text(
			'SSH host',
			'SSH destination, for example user@host or an alias from your SSH config. Key-based login without a passphrase prompt is required.',
			'user@host',
			() => runtime.host,
			(value) => {
				runtime.host = value;
			},
		);
		if (herdr) {
			text(
				'Remote socket path',
				'Socket of the herdr server on the remote host. It is forwarded to this machine over SSH.',
				DEFAULT_HERDR_SOCKET,
				() => runtime.socketPath,
				(value) => {
					runtime.socketPath = value;
				},
			);
		}
		text(
			herdr ? 'Remote herdr binary' : 'Remote hc binary',
			herdr
				? 'Path to herdr on the remote host; a leading ~/ is the remote home. Leave empty to search the non-interactive SSH PATH, then Homebrew, /usr/local/bin and ~/.local/bin on the remote host.'
				: 'Path to hc on the remote host. Leave empty to use hc or herdr-core from the non-interactive SSH PATH, then ~/.local/bin.',
			herdr ? 'Search the remote host' : 'hc',
			() => runtime.binary,
			(value) => {
				runtime.binary = value;
			},
		);
		text(
			'Remote vault path',
			'Absolute path of this vault on the remote host. Folder actions resolve note paths against it.',
			'/home/user/vault',
			() => runtime.remoteVaultPath,
			(value) => {
				runtime.remoteVaultPath = value;
			},
		);
	} else {
		if (herdr) {
			text(
				'Socket path',
				'Unix socket of the running herdr server. Leave the default unless you start herdr with a custom socket.',
				DEFAULT_HERDR_SOCKET,
				() => runtime.socketPath,
				(value) => {
					runtime.socketPath = value;
				},
			);
		}
		text(
			herdr ? 'Herdr binary' : 'Hc binary',
			herdr
				? 'Absolute path to the herdr executable. Leave empty to search Homebrew, /usr/local/bin, ~/.local/bin and a login-shell PATH. Set it if Obsidian was launched from the Dock and cannot find herdr.'
				: 'Absolute path to the hc executable. Leave empty to search Homebrew, /usr/local/bin, ~/.local/bin and a login-shell PATH.',
			herdr ? 'Auto-discover' : 'hc',
			() => runtime.binary,
			(value) => {
				runtime.binary = value;
			},
		);
	}
	text(
		herdr ? 'Workspace ID' : 'Space',
		herdr
			? 'Pin this runtime to one herdr workspace. Leave empty to match the workspace labelled like the vault folder, then the one whose panes run inside the vault. Ids are opaque and change between servers.'
			: 'Pin this runtime to one herdr-app space, by name or id. Leave empty to match the space named like the vault folder, then the terminals running inside the vault.',
		'Auto-detect',
		() => runtime.workspace,
		(value) => {
			runtime.workspace = value;
		},
	);

	if (!herdr) buildSessionHookSetting(containerEl, isActive, callbacks);
	// The catalog's default for this runtime (issue #125); Claude run by
	// Obsidian has Claude only, so it has no choice to make.
	buildDefaultAgentSetting(containerEl, runtime, settings, callbacks);

	problems = new Setting(containerEl).setName('Problems').setClass('herdr-runtime-problems');
	check();

	new Setting(containerEl).addButton((button) =>
		button
			.setButtonText('Done')
			.setCta()
			.onClick(() => callbacks.editRuntime(null)),
	);
}

/**
 * The fields of a `claude` runtime (ADR-0007): the binary, and the
 * permission mode its agents start in. Nothing else applies: no socket, no
 * workspace, no host.
 */
function buildClaudeFields(
	containerEl: HTMLElement,
	runtime: RuntimeConfig,
	text: (name: string, desc: string, placeholder: string, read: () => string, write: (value: string) => void) => void,
	changed: () => Promise<void>,
): void {
	text(
		'Claude binary',
		'Absolute path to the claude executable. Leave empty to search Homebrew, /usr/local/bin, ~/.local/bin and a login-shell PATH.',
		'Auto-discover',
		() => runtime.binary,
		(value) => {
			runtime.binary = value;
		},
	);
	new Setting(containerEl)
		.setName('Permission mode')
		.setDesc(
			'What new and resumed agents may do without asking. In the default mode every tool that needs permission waits for you in the native view.',
		)
		.addDropdown((dropdown) => {
			for (const mode of CLAUDE_PERMISSION_MODES) dropdown.addOption(mode, CLAUDE_PERMISSION_MODE_LABELS[mode]);
			dropdown.setValue(normalizePermissionMode(runtime.permissionMode)).onChange(async (value) => {
				runtime.permissionMode = normalizePermissionMode(value);
				await changed();
			});
		});
	new Setting(containerEl)
		.setName('Terminal view')
		.setDesc('Not available yet: agents of this runtime open in the native view.');
}

/**
 * The Claude session hook on a herdr-core runtime's machine (ADR-0006): a
 * status line and the button to the review modal, for the active runtime
 * only, since it acts over the runtime's connection.
 */
function buildSessionHookSetting(containerEl: HTMLElement, isActive: boolean, callbacks: ListCallbacks): void {
	const hook = isActive ? callbacks.sessionHook : undefined;
	const purpose = 'Lets the native view follow Claude in this runtime’s terminals.';
	const row = new Setting(containerEl)
		.setName('Claude session hook')
		.setDesc(`${purpose} ${hook ? 'Checking…' : 'Use this runtime to see or change it on its machine.'}`);
	row.addButton((button) =>
		button
			.setButtonText('Review')
			.setDisabled(!hook)
			.onClick(() => hook?.review(() => callbacks.redisplay())),
	);
	if (!hook) return;
	void hook.status().then((line) => {
		row.setDesc(`${purpose} ${line ? line.text : 'Not connected to it yet.'}`);
		row.descEl.toggleClass('mod-warning', line?.warning === true);
	});
}

/**
 * A kind or target change: the socket field follows when it still holds the
 * old combination's default, and keeps what the user typed otherwise. The
 * binary keeps what was typed: its default is empty (a search) everywhere.
 */
function retarget(runtime: RuntimeConfig, kind: RuntimeKind, target: RuntimeTarget): void {
	if (kind !== 'herdr') runtime.socketPath = '';
	else if (runtime.socketPath.trim() === '') runtime.socketPath = DEFAULT_HERDR_SOCKET;
	// Claude run by Obsidian runs here only, and has a permission mode (ADR-0007).
	const placed = kindTargets(kind).includes(target) ? target : 'local';
	if (kind === 'claude') runtime.permissionMode = normalizePermissionMode(runtime.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE);
	else delete runtime.permissionMode;
	runtime.kind = kind;
	runtime.target = placed;
}
