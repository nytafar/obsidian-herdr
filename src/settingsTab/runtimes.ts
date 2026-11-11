/**
 * The Runtimes page (ADR-0004, issue #178): the runtime registry as a `list`
 * with one page per runtime, and what applies to every runtime on this
 * machine, the PATH additions herdr and ssh are spawned with. The entry on
 * the root shows the active runtime.
 *
 * A runtime's page holds Name, Kind and Target, then one group of fields per
 * kind and target, shown and hidden by `visible`; then its default agent,
 * the Claude session hook (herdr-core), Problems, and what acts on the
 * runtime: use it, its place in the list, remove it. Fields are keyed
 * `runtimes.<id>.<field>` (`runtimeKeys.ts`).
 *
 * The definitions are cached by Obsidian until `update()`, so whatever a
 * field changes about a runtime's row (its name, its summary, Active) is
 * read in a getter or a function when the row is drawn, and only the shape
 * of the list (adding, removing, reordering) asks for `update()`.
 */

import {
	Notice,
	type SettingDefinition,
	type SettingDefinitionAction,
	type SettingDefinitionControl,
	type SettingDefinitionGroup,
	type SettingDefinitionItem,
	type SettingDefinitionList,
	type SettingDefinitionPage,
	type SettingDefinitionRender,
} from 'obsidian';
import type { HerdrSettings } from '../settings';
import {
	activeRuntimeOf,
	CLAUDE_PERMISSION_MODE_LABELS,
	DEFAULT_HERDR_SOCKET,
	issueSentence,
	newRuntime,
	removeRuntime,
	runtimeById,
	runtimeDisplayName,
	runtimeIssues,
	runtimeSummary,
	RUNTIME_KIND_LABELS,
	RUNTIME_TARGET_LABELS,
	type RuntimeConfig,
	type RuntimeKind,
} from '../runtimes';
import type { TabKey } from './effects';
import { blockOf } from './lists';
import { runtimeKey, type RuntimeField } from './runtimeKeys';

/** The page's name, and the first step of every runtime page's path. */
export const RUNTIMES_PAGE = 'Runtimes';

/** What the Runtimes page may do besides write through its keys. The tab builds it. */
export interface RuntimesHost {
	/** Why runtimes of this kind cannot connect in this build, or null when they can. */
	kindUnavailable(kind: RuntimeKind): string | null;
	/** Makes the runtime the active one and reconnects at once, as the switcher does. */
	activate(id: string): Promise<void>;
	/** Persists the settings as they now are. */
	save(): Promise<void>;
	/** A runtime's name or the list changed: retitle the switcher and the status bar. */
	refreshRuntimes(): void;
	/** Asks before something destructive; resolves true to go ahead. */
	confirm(text: { title: string; body: string; confirm: string }): Promise<boolean>;
	/** Reads the definitions again and redraws the open page in place (`update()`). */
	update(): void;
	/**
	 * Opens a page of this tab by its path of page ids. Obsidian has no public
	 * call for it; where the build lacks the one the tab uses, nothing happens.
	 */
	openPage(path: string[]): void;
	/** Runs the listener after every per-runtime write; returns what stops it. */
	onRuntimeWrite(listener: (id: string, field: RuntimeField) => void): () => void;
	/**
	 * The active herdr-core runtime's Claude session hook (ADR-0006): its
	 * status line (null while not connected), and the review modal, which
	 * calls back after it wrote something.
	 */
	sessionHook?: {
		status(): Promise<{ text: string; warning: boolean } | null>;
		review(onDone: () => void): void;
	};
	/** Draws the runtime's default agent (issue #125, the catalog's setting) into the row. */
	drawDefaultAgent(el: HTMLElement, runtime: RuntimeConfig): void;
}

/**
 * Kind and target decide which rows a page shows, and several rows of the
 * page hold the same field under the name its kind gives it (the binary,
 * the workspace). A change of either draws the open page again in place, so
 * a row that comes into view shows the field as it is now. The dropdown
 * that changed keeps its focus: Obsidian leaves a focused control alone.
 */
export function redrawsPage(field: RuntimeField): boolean {
	return field === 'kind' || field === 'target';
}

export function runtimesPage(settings: () => HerdrSettings, host: RuntimesHost): SettingDefinitionPage<TabKey> {
	return {
		type: 'page',
		name: RUNTIMES_PAGE,
		desc: 'Which herdr, herdr-core or Claude to connect to, on this machine or over SSH.',
		displayValue: () => runtimeDisplayName(activeRuntimeOf(settings())),
		items: [
			runtimeList(settings, host),
			{
				type: 'group',
				heading: 'Connection',
				items: [
					{
						name: 'Extra PATH entries',
						desc: 'Colon-separated directories appended to PATH when the plugin spawns herdr, for tools your agents need.',
						control: { type: 'text', key: 'extraPath', placeholder: '/opt/homebrew/bin:/usr/local/bin' },
					},
				],
			},
		],
	};
}

/**
 * One page per runtime, in the switcher's order. The ids are taken when the
 * definitions are, which is also when the list is drawn from them, so an
 * index the list hands back names the runtime that row was drawn for.
 */
function runtimeList(settings: () => HerdrSettings, host: RuntimesHost): SettingDefinitionList<TabKey> {
	const ids = settings().runtimes.map((runtime) => runtime.id);
	return {
		type: 'list',
		heading: 'Runtimes',
		addItem: { name: 'Add runtime', action: () => void addRuntime(settings(), host) },
		onDelete: (index) => {
			const id = ids[index];
			if (id !== undefined) void removeRuntimeAfterAsking(settings(), id, host, false);
		},
		onReorder: (from, to) => void moveRuntime(settings(), ids, from, to, host),
		items: ids.map((id) => runtimePage(settings, id, host)),
	};
}

/** What keeps a runtime from working: its kind missing from this build, then its own gaps. */
function problemsOf(runtime: RuntimeConfig, host: RuntimesHost): string[] {
	const unavailable = host.kindUnavailable(runtime.kind);
	return [...(unavailable ? [unavailable] : []), ...runtimeIssues(runtime)];
}

/**
 * A runtime's page. Its `id` is the runtime's: Obsidian finds a page by
 * `id`, else by name (`docs/architecture.md`, "The settings tab"), so a
 * rename leaves the open page where it is and two runtimes may share a name.
 * `id` is not in Obsidian's typings, hence the wider type.
 */
export function runtimePage(
	settings: () => HerdrSettings,
	id: string,
	host: RuntimesHost,
): SettingDefinitionPage<TabKey> & { id: string } {
	const runtime = (): RuntimeConfig | undefined => runtimeById(settings(), id);
	const isActive = (): boolean => activeRuntimeOf(settings()).id === id;
	const when =
		(test: (runtime: RuntimeConfig) => boolean) =>
		(): boolean => {
			const current = runtime();
			return current ? test(current) : false;
		};
	const text = (
		name: string,
		desc: string,
		placeholder: string,
		field: RuntimeField,
	): SettingDefinitionControl<TabKey> => ({
		name,
		desc,
		control: { type: 'text', key: runtimeKey(id, field), placeholder },
	});
	const variant = (
		test: (runtime: RuntimeConfig) => boolean,
		items: SettingDefinitionControl<TabKey>[],
	): SettingDefinitionGroup<TabKey> => ({ type: 'group', visible: when(test), items });
	const herdrOn = (target: string) => (r: RuntimeConfig) => r.kind === 'herdr' && r.target === target;
	const coreOn = (target: string) => (r: RuntimeConfig) => r.kind === 'herdr-core' && r.target === target;

	const sections: SettingDefinitionItem<TabKey>[] = [
		{
			type: 'group',
			items: [
				{
					name: 'Name',
					desc: 'What the switcher, the status bar and the runtime list call it. Left empty, it is named after its kind and host.',
					control: { type: 'text', key: runtimeKey(id, 'name') },
				},
				{
					name: 'Kind',
					desc: 'Herdr is the terminal multiplexer with tabs and splits. Herdr-core is the headless hc runtime, which has neither. Claude run by Obsidian starts Claude itself, on this machine, with no multiplexer: its agents stop when Obsidian closes and resume when opened.',
					// The fields each kind shows, so search finds the page whatever it is now.
					aliases: ['runtime', 'socket path', 'SSH host', 'binary', 'remote vault path', 'workspace', 'space'],
					control: { type: 'dropdown', key: runtimeKey(id, 'kind'), options: { ...RUNTIME_KIND_LABELS } },
				},
				{
					name: 'Target',
					desc: 'Where it runs: this machine, or a host reached over SSH.',
					aliases: ['SSH', 'remote host'],
					// Claude run by Obsidian runs here only (ADR-0007).
					visible: when((r) => r.kind !== 'claude'),
					control: { type: 'dropdown', key: runtimeKey(id, 'target'), options: { ...RUNTIME_TARGET_LABELS } },
				},
			],
		},
		variant(herdrOn('local'), [
			text(
				'Socket path',
				'Unix socket of the running herdr server. Leave the default unless you start herdr with a custom socket.',
				DEFAULT_HERDR_SOCKET,
				'socketPath',
			),
			text(
				'Herdr binary',
				'Absolute path to the herdr executable. Leave empty to search Homebrew, /usr/local/bin, ~/.local/bin and a login-shell PATH. Set it if Obsidian was launched from the Dock and cannot find herdr.',
				'Auto-discover',
				'binary',
			),
			text('Workspace ID', WORKSPACE_DESC, 'Auto-detect', 'workspace'),
		]),
		variant(herdrOn('ssh'), [
			text('SSH host', SSH_HOST_DESC, 'user@host', 'host'),
			text(
				'Remote socket path',
				'Socket of the herdr server on the remote host. It is forwarded to this machine over SSH.',
				DEFAULT_HERDR_SOCKET,
				'socketPath',
			),
			text(
				'Remote herdr binary',
				'Path to herdr on the remote host; a leading ~/ is the remote home. Leave empty to search the non-interactive SSH PATH, then Homebrew, /usr/local/bin and ~/.local/bin on the remote host.',
				'Search the remote host',
				'binary',
			),
			text('Remote vault path', REMOTE_VAULT_DESC, '/home/user/vault', 'remoteVaultPath'),
			text('Workspace ID', WORKSPACE_DESC, 'Auto-detect', 'workspace'),
		]),
		variant(coreOn('local'), [
			text(
				'Hc binary',
				'Absolute path to the hc executable. Leave empty to search Homebrew, /usr/local/bin, ~/.local/bin and a login-shell PATH.',
				'hc',
				'binary',
			),
			text('Space', SPACE_DESC, 'Auto-detect', 'workspace'),
		]),
		variant(coreOn('ssh'), [
			text('SSH host', SSH_HOST_DESC, 'user@host', 'host'),
			text(
				'Remote hc binary',
				'Path to hc on the remote host. Leave empty to use hc or herdr-core from the non-interactive SSH PATH, then ~/.local/bin.',
				'hc',
				'binary',
			),
			text('Remote vault path', REMOTE_VAULT_DESC, '/home/user/vault', 'remoteVaultPath'),
			text('Space', SPACE_DESC, 'Auto-detect', 'workspace'),
		]),
		// The fields of a `claude` runtime (ADR-0007): no socket, no workspace, no host.
		{
			type: 'group',
			visible: when((r) => r.kind === 'claude'),
			items: [
				text(
					'Claude binary',
					'Absolute path to the claude executable. Leave empty to search Homebrew, /usr/local/bin, ~/.local/bin and a login-shell PATH.',
					'Auto-discover',
					'binary',
				),
				{
					name: 'Permission mode',
					desc: 'What new and resumed agents may do without asking. In the default mode every tool that needs permission waits for you in the native view.',
					control: {
						type: 'dropdown',
						key: runtimeKey(id, 'permissionMode'),
						options: { ...CLAUDE_PERMISSION_MODE_LABELS },
					},
				},
				{ name: 'Terminal view', desc: 'Not available yet: agents of this runtime open in the native view.' },
			],
		},
		{
			type: 'group',
			items: [
				sessionHookDefinition(id, runtime, isActive, host),
				{
					name: 'Default agent',
					desc: 'What the + button in the agent list and the folder menus start on this runtime.',
					// Claude run by Obsidian has Claude only, so it has no choice to make.
					visible: when((r) => r.kind !== 'claude'),
					render: (setting) => {
						const current = runtime();
						if (current) host.drawDefaultAgent(blockOf(setting), current);
					},
				},
				problemsDefinition(id, runtime, host),
			],
		},
		{ type: 'group', items: actionDefinitions(settings, id, isActive, host) },
	];

	return {
		type: 'page',
		id,
		get name(): string {
			const current = runtime();
			return current ? runtimeDisplayName(current) : id;
		},
		get desc(): string {
			const current = runtime();
			if (!current) return '';
			const unavailable = host.kindUnavailable(current.kind);
			return [issueSentence(runtimeSummary(current)), ...(unavailable ? [issueSentence(unavailable)] : [])].join(' ');
		},
		displayValue: () => (isActive() ? 'Active' : ''),
		status: () => {
			const current = runtime();
			return current && problemsOf(current, host).length > 0 ? 'warning' : null;
		},
		items: sections,
	};
}

const SSH_HOST_DESC =
	'SSH destination, for example user@host or an alias from your SSH config. Key-based login without a passphrase prompt is required.';
const REMOTE_VAULT_DESC =
	'Absolute path of this vault on the remote host. Folder actions resolve note paths against it.';
const WORKSPACE_DESC =
	'Pin this runtime to one herdr workspace. Leave empty to match the workspace labelled like the vault folder, then the one whose panes run inside the vault. Ids are opaque and change between servers.';
const SPACE_DESC =
	'Pin this runtime to one herdr-app space, by name or id. Leave empty to match the space named like the vault folder, then the terminals running inside the vault.';

/**
 * The Claude session hook on a herdr-core runtime's machine (ADR-0006): a
 * status line and the button to the review modal, for the active runtime
 * only, since it acts over the runtime's connection.
 */
function sessionHookDefinition(
	id: string,
	runtime: () => RuntimeConfig | undefined,
	isActive: () => boolean,
	host: RuntimesHost,
): SettingDefinitionRender {
	const purpose = 'Lets the native view follow Claude in this runtime’s terminals.';
	return {
		name: 'Claude session hook',
		desc: purpose,
		visible: () => runtime()?.kind === 'herdr-core',
		render: (setting) => {
			const hook = runtime()?.kind === 'herdr-core' && isActive() ? host.sessionHook : undefined;
			setting.setDesc(`${purpose} ${hook ? 'Checking…' : 'Use this runtime to see or change it on its machine.'}`);
			setting.addButton((button) =>
				button
					.setButtonText('Review')
					.setDisabled(!hook)
					.onClick(() => hook?.review(() => host.update())),
			);
			if (!hook) return;
			let drawn = true;
			void hook.status().then((line) => {
				if (!drawn) return;
				setting.setDesc(`${purpose} ${line ? line.text : 'Not connected to it yet.'}`);
				setting.descEl.toggleClass('mod-warning', line?.warning === true);
			});
			return () => {
				drawn = false;
			};
		},
	};
}

/** Every problem the page can see, drawn again after each write to this runtime. */
function problemsDefinition(
	id: string,
	runtime: () => RuntimeConfig | undefined,
	host: RuntimesHost,
): SettingDefinitionRender {
	return {
		name: 'Problems',
		desc: 'What the runtime still lacks.',
		render: (setting) => {
			setting.setClass('herdr-runtime-problems');
			const draw = (): void => {
				const current = runtime();
				if (!current) return;
				const issues = problemsOf(current, host);
				setting.setDesc(issues.length > 0 ? issues.map(issueSentence).join(' ') : 'None.');
				setting.descEl.toggleClass('mod-warning', issues.length > 0);
			};
			draw();
			return host.onRuntimeWrite((changed) => {
				if (changed === id) draw();
			});
		},
	};
}

/**
 * What acts on the runtime. Obsidian draws a page in a list as a plain link,
 * with neither the list's delete button nor its drag handle (only the
 * keyboard's Delete and Alt+arrow reach it), and with no room for a button
 * of the plugin's: so the plug, the order and the bin are rows of the page.
 */
function actionDefinitions(
	settings: () => HerdrSettings,
	id: string,
	isActive: () => boolean,
	host: RuntimesHost,
): SettingDefinition<TabKey>[] {
	const use: SettingDefinitionAction = {
		get name(): string {
			return isActive() ? 'Reconnect' : 'Use this runtime';
		},
		get desc(): string {
			return isActive()
				? 'This is the active runtime. Connect to it again.'
				: 'Make this the active runtime and connect to it, as the agent list’s switcher does.';
		},
		action: () => {
			void host.activate(id).then(() => host.update());
		},
	};
	const order: SettingDefinitionRender = {
		name: 'Order',
		desc: 'Its place in the switcher and in the runtime list.',
		render: (setting) => {
			const ids = settings().runtimes.map((runtime) => runtime.id);
			const at = ids.indexOf(id);
			setting.setDesc(`Its place in the switcher and in the runtime list: ${at + 1} of ${ids.length}.`);
			setting.addExtraButton((button) =>
				button
					.setIcon('arrow-up')
					.setTooltip('Move up')
					.setDisabled(at <= 0)
					.onClick(() => void moveRuntime(settings(), ids, at, at - 1, host)),
			);
			setting.addExtraButton((button) =>
				button
					.setIcon('arrow-down')
					.setTooltip('Move down')
					.setDisabled(at < 0 || at >= ids.length - 1)
					.onClick(() => void moveRuntime(settings(), ids, at, at + 1, host)),
			);
		},
	};
	const remove: SettingDefinitionAction = {
		name: 'Remove runtime',
		get desc(): string {
			return settings().runtimes.length <= 1
				? 'The last runtime cannot be removed: the plugin always needs one to connect to.'
				: 'Asks first. Terminal tabs opened on it stop reconnecting, and its pinned agents are forgotten.';
		},
		disabled: () => settings().runtimes.length <= 1,
		action: () => void removeRuntimeAfterAsking(settings(), id, host, true),
	};
	return [use, order, remove];
}

/** **Add runtime**: a herdr runtime over SSH with a fresh id, its page opened. */
export async function addRuntime(settings: HerdrSettings, host: RuntimesHost): Promise<void> {
	const runtime = newRuntime(
		'herdr',
		'ssh',
		settings.runtimes.map((entry) => entry.id),
	);
	settings.runtimes = [...settings.runtimes, runtime];
	await host.save();
	host.refreshRuntimes();
	host.update();
	host.openPage([RUNTIMES_PAGE, runtime.id]);
}

/**
 * Removes a runtime after asking, with its pins, and reconnects when it was
 * the active one. The last runtime stays: the plugin always needs one. From
 * the runtime's own page, goes back to the list, since the page is gone.
 */
export async function removeRuntimeAfterAsking(
	settings: HerdrSettings,
	id: string,
	host: RuntimesHost,
	fromItsPage: boolean,
): Promise<void> {
	const runtime = runtimeById(settings, id);
	if (!runtime) return;
	if (settings.runtimes.length <= 1) {
		new Notice('Gjetr: the last runtime cannot be removed.');
		return;
	}
	const confirmed = await host.confirm({
		title: `Remove "${runtimeDisplayName(runtime)}"?`,
		body: 'Terminal tabs opened on it stop reconnecting, and its pinned agents are forgotten.',
		confirm: 'Remove runtime',
	});
	if (!confirmed) return;
	const { removed, activeChanged } = removeRuntime(settings, id);
	if (!removed) return;
	if (activeChanged) await host.activate(settings.activeRuntime);
	else await host.save();
	host.refreshRuntimes();
	host.update();
	if (fromItsPage) host.openPage([RUNTIMES_PAGE]);
}

/**
 * Moves the runtime drawn at `from` to `to`, in the order the list was drawn
 * in (`ids`). The switcher shows the new order. Runtimes the drawing did not
 * know keep their place after the others.
 */
export async function moveRuntime(
	settings: HerdrSettings,
	ids: readonly string[],
	from: number,
	to: number,
	host: RuntimesHost,
): Promise<void> {
	if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return;
	const order = [...ids];
	const [moved] = order.splice(from, 1);
	if (moved === undefined) return;
	order.splice(to, 0, moved);
	const byId = new Map(settings.runtimes.map((runtime) => [runtime.id, runtime]));
	const placed = order.flatMap((runtimeId) => byId.get(runtimeId) ?? []);
	const rest = settings.runtimes.filter((runtime) => !order.includes(runtime.id));
	settings.runtimes = [...placed, ...rest];
	await host.save();
	host.refreshRuntimes();
	host.update();
}
