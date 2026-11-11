/**
 * The Runtimes page as a declarative `list` with one page per runtime
 * (issue #178, ADR-0004, ADR-0011).
 *
 * What is pinned: the list and its pages, which rows a page shows for each
 * kind and target, the per-runtime keys (`runtimes.<id>.<field>`) and what a
 * write to each costs, adding, removing, reordering and switching with the
 * same stored `runtimes` data as before, and that settings search, which
 * skips what is hidden, finds a runtime page by "socket path" and "SSH host".
 */

import { describe, expect, it, vi } from 'vitest';
import type {
	SettingDefinition,
	SettingDefinitionAction,
	SettingDefinitionItem,
	SettingDefinitionList,
	SettingDefinitionPage,
	SettingDefinitionRender,
} from 'obsidian';
import { ButtonComponent, ExtraButtonComponent, Setting } from './fixtures/obsidian';
import { fakeConnection, recordRuntimesHost } from './fixtures/runtimesHost';
import { DEFAULT_SETTINGS, type HerdrSettings } from '../src/settings';
import { defaultLocalRuntime, newRuntime, type RuntimeConfig } from '../src/runtimes';
import { readSetting, writeSetting, type SettingsHost } from '../src/settingsTab/effects';
import { parseRuntimeKey, runtimeKey } from '../src/settingsTab/runtimeKeys';
import { activeRuntimeLine, runtimesPage, type RuntimesHost } from '../src/settingsTab/runtimes';

function settingsOf(overrides: Partial<HerdrSettings> = {}): HerdrSettings {
	return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

const XL = 'ssh:lasse@xl:~/.config/herdr/herdr.sock';

/** The remote a pre-registry profile migrated to, beside the local herdr. Its id holds dots. */
function twoRuntimes(): HerdrSettings {
	return settingsOf({
		runtimes: [
			defaultLocalRuntime(),
			{ ...newRuntime('herdr', 'ssh', [], () => 0.5), id: XL, name: 'xl', host: 'lasse@xl' },
		],
		activeRuntime: 'local',
		pinnedPanes: { [XL]: ['w4:p1'], local: ['w1:p1'] },
	});
}

const valueOf = <T>(value: T | (() => T) | undefined, fallback: T): T =>
	value === undefined ? fallback : typeof value === 'function' ? (value as () => T)() : value;

function listOf(settings: HerdrSettings, host: RuntimesHost): SettingDefinitionList {
	const page = runtimesPage(() => settings, host);
	const list = page.items?.[0];
	if (!list || !('type' in list) || list.type !== 'list') throw new Error('the page does not open on a list');
	return list as SettingDefinitionList;
}

type RuntimePage = SettingDefinitionPage & { id: string };

function pageOf(settings: HerdrSettings, host: RuntimesHost, id: string): RuntimePage {
	const page = (listOf(settings, host).items ?? []).find((item) => 'id' in item && item.id === id);
	if (!page) throw new Error(`no page for runtime "${id}"`);
	return page as RuntimePage;
}

/**
 * The settings a page shows now: groups and rows whose `visible` holds, as
 * Obsidian's renderer and its search index both decide.
 */
function shown(items: readonly SettingDefinitionItem[]): SettingDefinition[] {
	const out: SettingDefinition[] = [];
	for (const item of items) {
		if ('type' in item && (item.type === 'group' || item.type === 'list')) {
			if (valueOf(item.visible, true)) out.push(...shown(item.items ?? []));
		} else if (!('type' in item) && valueOf(item.visible, true)) {
			out.push(item);
		}
	}
	return out;
}

function shownNames(settings: HerdrSettings, id: string): string[] {
	return shown(pageOf(settings, recordRuntimesHost().host, id).items ?? []).map((def) => def.name);
}

function named(page: RuntimePage, name: string): SettingDefinition {
	const hit = shown(page.items ?? []).find((def) => def.name === name);
	if (!hit) throw new Error(`"${name}" is not shown`);
	return hit;
}

function rendered(def: SettingDefinition): { setting: Setting; cleanup: void | (() => void) } {
	const setting = new Setting({});
	const cleanup = (def as SettingDefinitionRender).render(setting as never, {} as never);
	return { setting, cleanup };
}

/** A settings host that records each effect, as `settingsDefinitions.test.ts` does. */
function effectsRecorder(): { calls: string[]; host: SettingsHost } {
	const calls: string[] = [];
	return {
		calls,
		host: {
			saveSettings: async () => {
				calls.push('save');
			},
			scheduleReconnect: () => calls.push('reconnect'),
			refreshAgentList: () => calls.push('refreshAgentList'),
			refreshFolderHoverButton: () => calls.push('refreshFolderHoverButton'),
			applyTerminalSetting: (setting) => calls.push(`applyTerminalSetting:${setting}`),
			refreshNativeViews: () => calls.push('refreshNativeViews'),
			refreshRuntimes: () => calls.push('refreshRuntimes'),
		},
	};
}

describe('the runtime list', () => {
	it('has one page per runtime, in the stored order, keyed by the runtime’s id', () => {
		const list = listOf(twoRuntimes(), recordRuntimesHost().host);
		expect(list.heading).toBe('Runtimes');
		expect(list.addItem?.name).toBe('Add runtime');
		expect(list.items?.map((item) => ('id' in item ? item.id : null))).toEqual(['local', XL]);
		expect(list.items?.map((item) => item.name)).toEqual(['Local', 'xl']);
	});

	it('reads a row’s name, summary, Active and warning when it is drawn, not when it was defined', () => {
		const settings = twoRuntimes();
		const host = recordRuntimesHost({ unavailable: { 'herdr-core': 'not in this build yet' } }).host;
		const local = pageOf(settings, host, 'local');
		const xl = pageOf(settings, host, XL);
		expect(local.desc).toBe('Herdr on this machine.');
		expect(valueOf(local.displayValue, '')).toBe('Active');
		expect(valueOf(xl.displayValue, '')).toBe('');
		// No remote vault path yet.
		expect(valueOf(xl.status, null)).toBe('warning');
		expect(valueOf(local.status, null)).toBeNull();

		settings.runtimes[0]!.name = 'Laptop';
		settings.runtimes[0]!.kind = 'herdr-core';
		settings.activeRuntime = XL;
		expect(local.name).toBe('Laptop');
		expect(local.desc).toBe('Herdr-core (hc) on this machine. Not in this build yet.');
		expect(valueOf(local.status, null)).toBe('warning');
		expect(valueOf(local.displayValue, '')).toBe('');
		expect(valueOf(xl.displayValue, '')).toBe('Active');
		// The page keeps its id through a rename: Obsidian finds it by that.
		expect(local.id).toBe('local');
	});

	it('adds an SSH herdr runtime with a fresh id, and opens its page', async () => {
		const settings = settingsOf();
		const { calls, host } = recordRuntimesHost();
		listOf(settings, host).addItem?.action({} as HTMLElement);
		await vi.waitFor(() => expect(calls).toContain('update'));

		const added = settings.runtimes[1];
		expect(added).toMatchObject({ kind: 'herdr', target: 'ssh', name: '' });
		expect(added?.id).toMatch(/^rt-/);
		expect(calls).toEqual(['save', 'refreshRuntimes', 'update', `openPage:Runtimes/${added?.id}`]);
	});

	it('removes a runtime and its pins after asking, and reconnects when it was active', async () => {
		const settings = twoRuntimes();
		settings.activeRuntime = XL;
		const { calls, host } = recordRuntimesHost();
		listOf(settings, host).onDelete?.(1);
		await vi.waitFor(() => expect(calls).toContain('update'));

		expect(settings.runtimes.map((runtime) => runtime.id)).toEqual(['local']);
		expect(settings.pinnedPanes).toEqual({ local: ['w1:p1'] });
		// From the list: the page open is the list, so nothing navigates.
		expect(calls).toEqual(['confirm', 'activate:local', 'refreshRuntimes', 'update']);
	});

	it('only saves when the removed runtime was not the active one', async () => {
		const settings = twoRuntimes();
		const { calls, host } = recordRuntimesHost();
		listOf(settings, host).onDelete?.(1);
		await vi.waitFor(() => expect(calls).toContain('update'));
		expect(calls).toEqual(['confirm', 'save', 'refreshRuntimes', 'update']);
	});

	it('keeps a runtime when the removal is not confirmed', async () => {
		const settings = twoRuntimes();
		const { calls, host } = recordRuntimesHost({ confirm: false });
		listOf(settings, host).onDelete?.(1);
		await vi.waitFor(() => expect(calls).toEqual(['confirm']));
		await Promise.resolve();
		expect(settings.runtimes).toHaveLength(2);
		expect(calls).toEqual(['confirm']);
	});

	it('never removes the last runtime, and does not ask', async () => {
		const settings = settingsOf();
		const { calls, host } = recordRuntimesHost();
		listOf(settings, host).onDelete?.(0);
		await Promise.resolve();
		expect(settings.runtimes).toHaveLength(1);
		expect(calls).toEqual([]);
	});

	it('reorders the runtimes, which is the switcher’s order', async () => {
		const settings = twoRuntimes();
		const { calls, host } = recordRuntimesHost();
		listOf(settings, host).onReorder?.(0, 1);
		await vi.waitFor(() => expect(calls).toContain('update'));
		expect(settings.runtimes.map((runtime) => runtime.id)).toEqual([XL, 'local']);
		// The active one is still the active one.
		expect(settings.activeRuntime).toBe('local');
		expect(calls).toEqual(['save', 'refreshRuntimes', 'update']);
	});
});

describe('a runtime’s page', () => {
	const COMMON_TAIL = ['Problems', 'Reconnect', 'Order', 'Remove runtime'];

	it('shows the local herdr’s socket, binary override and workspace', () => {
		expect(shownNames(settingsOf(), 'local')).toEqual([
			// The active runtime's page opens on its Status group.
			'Connection',
			'Name',
			'Kind',
			'Target',
			'Socket path',
			'Herdr binary',
			'Workspace ID',
			'Default agent',
			...COMMON_TAIL,
		]);
	});

	it('shows an SSH herdr runtime’s host, remote socket, binary and vault path', () => {
		expect(shownNames(twoRuntimes(), XL)).toEqual([
			'Name',
			'Kind',
			'Target',
			'SSH host',
			'Remote socket path',
			'Remote herdr binary',
			'Remote vault path',
			'Workspace ID',
			'Default agent',
			'Problems',
			'Use this runtime',
			'Order',
			'Remove runtime',
		]);
	});

	it('asks a herdr-core runtime for neither socket nor herdr binary, and offers the session hook', () => {
		const settings = settingsOf();
		const core = { ...newRuntime('herdr-core', 'ssh', []), name: 'Asher' };
		settings.runtimes.push(core);
		expect(shownNames(settings, core.id)).toEqual([
			'Name',
			'Kind',
			'Target',
			'SSH host',
			'Remote hc binary',
			'Remote vault path',
			'Space',
			'Claude session hook',
			'Default agent',
			'Problems',
			'Use this runtime',
			'Order',
			'Remove runtime',
		]);
		core.target = 'local';
		expect(shownNames(settings, core.id).slice(3, 6)).toEqual(['Hc binary', 'Space', 'Claude session hook']);
	});

	it('gives Claude run by Obsidian its binary and permission mode, and no target', () => {
		const settings = settingsOf();
		const claude = newRuntime('claude', 'local', []);
		settings.runtimes.push(claude);
		expect(shownNames(settings, claude.id)).toEqual([
			'Name',
			'Kind',
			'Claude binary',
			'Permission mode',
			'Terminal view',
			'Problems',
			'Use this runtime',
			'Order',
			'Remove runtime',
		]);
	});

	it('shows and hides rows as kind and target change, from the same definitions', () => {
		const settings = settingsOf();
		const page = pageOf(settings, recordRuntimesHost().host, 'local');
		const names = (): string[] => shown(page.items ?? []).map((def) => def.name);
		expect(names()).toContain('Socket path');
		settings.runtimes[0]!.target = 'ssh';
		expect(names()).toContain('Remote socket path');
		expect(names()).not.toContain('Socket path');
		settings.runtimes[0]!.kind = 'claude';
		expect(names()).toContain('Permission mode');
		expect(names()).not.toContain('Target');
	});

	it('keys every field `runtimes.<id>.<field>`, ids with dots included', () => {
		const settings = twoRuntimes();
		const page = pageOf(settings, recordRuntimesHost().host, XL);
		const keys = shown(page.items ?? []).flatMap((def) => ('control' in def && def.control ? [def.control.key] : []));
		expect(keys).toEqual([
			runtimeKey(XL, 'name'),
			runtimeKey(XL, 'kind'),
			runtimeKey(XL, 'target'),
			runtimeKey(XL, 'host'),
			runtimeKey(XL, 'socketPath'),
			runtimeKey(XL, 'binary'),
			runtimeKey(XL, 'remoteVaultPath'),
			runtimeKey(XL, 'workspace'),
		]);
		expect(parseRuntimeKey(runtimeKey(XL, 'host'))).toEqual({ id: XL, field: 'host' });
		expect(readSetting(settings, runtimeKey(XL, 'host'))).toBe('lasse@xl');
		expect(readSetting(settings, runtimeKey(XL, 'name'))).toBe('xl');
	});

	it('offers every stored kind, target and permission mode among its dropdown’s options', () => {
		const settings = settingsOf();
		const claude = newRuntime('claude', 'local', []);
		settings.runtimes.push(claude);
		for (const id of ['local', claude.id]) {
			for (const def of shown(pageOf(settings, recordRuntimesHost().host, id).items ?? [])) {
				if (!('control' in def) || def.control?.type !== 'dropdown') continue;
				expect(Object.keys(def.control.options), def.name).toContain(readSetting(settings, def.control.key));
			}
		}
	});

	it('names what is missing in Problems, and draws it again after each write to the runtime', () => {
		const settings = twoRuntimes();
		const recorded = recordRuntimesHost();
		const { setting, cleanup } = rendered(named(pageOf(settings, recorded.host, XL), 'Problems'));
		expect(setting.desc).toBe(
			'The runtime has no remote vault path, so folder paths cannot be resolved on the remote host.',
		);
		expect(setting.descEl.classes.has('mod-warning')).toBe(true);

		settings.runtimes[1]!.remoteVaultPath = '/home/lasse/hvelv';
		recorded.written('local', 'remoteVaultPath');
		expect(setting.desc).toMatch(/no remote vault path/);
		recorded.written(XL, 'remoteVaultPath');
		expect(setting.desc).toBe('None.');
		expect(setting.descEl.classes.has('mod-warning')).toBe(false);
		// Drawn again or closed: it stops listening.
		(cleanup as () => void)();
		expect(recorded.listeners.size).toBe(0);
	});

	it('shows the Claude session hook on the active herdr-core runtime only, and opens its review', async () => {
		const settings = settingsOf();
		const core = { ...newRuntime('herdr-core', 'local', []), name: 'Core' };
		settings.runtimes.push(core);
		const recorded = recordRuntimesHost();
		recorded.host.sessionHook = {
			status: () => Promise.resolve({ text: 'Outdated: version 0 is installed.', warning: true }),
			review: (onDone) => {
				recorded.calls.push('review');
				onDone();
			},
		};

		// Not the active runtime: nothing to act over, so the button is off.
		const off = rendered(named(pageOf(settings, recorded.host, core.id), 'Claude session hook')).setting;
		expect(off.desc).toMatch(/Use this runtime to see or change it/);
		expect((off.control() as ButtonComponent).disabled).toBe(true);

		settings.activeRuntime = core.id;
		const row = rendered(named(pageOf(settings, recorded.host, core.id), 'Claude session hook')).setting;
		expect(row.desc).toMatch(/Checking/);
		await Promise.resolve();
		expect(row.desc).toBe('Lets the native view follow Claude in this runtime’s terminals. Outdated: version 0 is installed.');
		expect(row.descEl.classes.has('mod-warning')).toBe(true);
		await (row.control() as ButtonComponent).clickHandler?.();
		expect(recorded.calls).toEqual(['review', 'update']);
	});

	it('draws the catalog’s default agent into its row', () => {
		const recorded = recordRuntimesHost();
		const { setting } = rendered(named(pageOf(settingsOf(), recorded.host, 'local'), 'Default agent'));
		expect(setting.settingEl.emptied).toBe(1);
		expect(recorded.calls).toEqual(['drawDefaultAgent']);
	});

	it('switches to the runtime from its page, and reconnects the active one', async () => {
		const settings = twoRuntimes();
		const { calls, host } = recordRuntimesHost();
		const use = named(pageOf(settings, host, XL), 'Use this runtime') as SettingDefinitionAction;
		use.action({} as HTMLElement, 0);
		await vi.waitFor(() => expect(calls).toEqual([`activate:${XL}`, 'update']));
		expect(named(pageOf(settings, host, 'local'), 'Reconnect')).toBeTruthy();
	});

	it('moves the runtime from its page, and keeps the ends', async () => {
		const settings = twoRuntimes();
		const { calls, host } = recordRuntimesHost();
		const { setting } = rendered(named(pageOf(settings, host, 'local'), 'Order'));
		expect(setting.desc).toMatch(/1 of 2/);
		const [up, down] = setting.components as ExtraButtonComponent[];
		expect(up?.disabled).toBe(true);
		expect(down?.disabled).toBe(false);
		await down?.click();
		expect(settings.runtimes.map((runtime) => runtime.id)).toEqual([XL, 'local']);
		expect(calls).toEqual(['save', 'refreshRuntimes', 'update']);
	});

	it('removes the runtime from its page, then goes back to the list', async () => {
		const settings = twoRuntimes();
		const { calls, host } = recordRuntimesHost();
		const remove = named(pageOf(settings, host, XL), 'Remove runtime') as SettingDefinitionAction;
		expect(valueOf(remove.disabled, false)).toBe(false);
		remove.action({} as HTMLElement, 0);
		await vi.waitFor(() => expect(calls).toContain('openPage:Runtimes'));
		expect(settings.runtimes.map((runtime) => runtime.id)).toEqual(['local']);
		expect(calls).toEqual(['confirm', 'save', 'refreshRuntimes', 'update', 'openPage:Runtimes']);

		const last = named(pageOf(settings, host, 'local'), 'Remove runtime') as SettingDefinitionAction;
		expect(valueOf(last.disabled, false)).toBe(true);
	});
});

describe('the per-runtime keys', () => {
	it('reconnects for a field of the active runtime, and only saves for another', async () => {
		const settings = twoRuntimes();
		const active = effectsRecorder();
		await writeSetting(settings, runtimeKey('local', 'workspace'), 'w7', active.host);
		expect(settings.runtimes[0]?.workspace).toBe('w7');
		expect(active.calls).toEqual(['save', 'reconnect']);

		const other = effectsRecorder();
		await writeSetting(settings, runtimeKey(XL, 'remoteVaultPath'), '/home/lasse/hvelv', other.host);
		expect(settings.runtimes[1]?.remoteVaultPath).toBe('/home/lasse/hvelv');
		expect(other.calls).toEqual(['save']);
		// The id never follows an edit: tabs and pins keep naming this runtime.
		await writeSetting(settings, runtimeKey(XL, 'host'), 'lasse@xl2', other.host);
		expect(settings.runtimes[1]).toMatchObject({ id: XL, host: 'lasse@xl2' });
	});

	it('renames without reconnecting, and retitles the switcher', async () => {
		const settings = settingsOf();
		const { calls, host } = effectsRecorder();
		await writeSetting(settings, runtimeKey('local', 'name'), 'Laptop', host);
		expect(settings.runtimes[0]?.name).toBe('Laptop');
		expect(calls).toEqual(['save', 'refreshRuntimes']);
	});

	it('keeps the binary a search across a target change, and the socket follows the kind', async () => {
		const settings = settingsOf();
		const { calls, host } = effectsRecorder();
		await writeSetting(settings, runtimeKey('local', 'target'), 'ssh', host);
		// Empty: an SSH herdr runtime searches the remote host for herdr.
		expect(settings.runtimes[0]).toMatchObject({ target: 'ssh', binary: '' });
		expect(calls).toEqual(['save', 'reconnect', 'refreshRuntimes']);

		await writeSetting(settings, runtimeKey('local', 'kind'), 'herdr-core', host);
		expect(settings.runtimes[0]).toMatchObject({ kind: 'herdr-core', binary: '', socketPath: '' });
		await writeSetting(settings, runtimeKey('local', 'kind'), 'claude', host);
		// Claude run by Obsidian runs here only, and has a permission mode.
		expect(settings.runtimes[0]).toMatchObject({ kind: 'claude', target: 'local', permissionMode: 'manual' });
		expect(readSetting(settings, runtimeKey('local', 'permissionMode'))).toBe('manual');
		await writeSetting(settings, runtimeKey('local', 'permissionMode'), 'plan', host);
		expect(settings.runtimes[0]?.permissionMode).toBe('plan');
		await writeSetting(settings, runtimeKey('local', 'kind'), 'herdr', host);
		expect(settings.runtimes[0]).toMatchObject({ kind: 'herdr', socketPath: '~/.config/herdr/herdr.sock' });
		expect((settings.runtimes[0] as RuntimeConfig).permissionMode).toBeUndefined();
	});

	it('ignores a kind or target it does not know, and a runtime that is gone', async () => {
		const settings = settingsOf();
		const before = structuredClone(settings);
		const { calls, host } = effectsRecorder();
		await writeSetting(settings, runtimeKey('local', 'kind'), 'tmux', host);
		await writeSetting(settings, runtimeKey('local', 'target'), 'moon', host);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await writeSetting(settings, runtimeKey('gone', 'host'), 'x', host);
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
		expect(settings).toEqual(before);
		expect(calls).toEqual([]);
		expect(parseRuntimeKey('runtimes.local.id')).toBeNull();
		expect(parseRuntimeKey('runtimes')).toBeNull();
	});
});

describe('settings search', () => {
	/**
	 * Obsidian's search, as far as what it can find: name, description and
	 * aliases of every row shown now, and the page each sits on. Hidden
	 * groups and rows are skipped, as its index skips them.
	 */
	function search(settings: HerdrSettings, query: string): string[] {
		const pages = listOf(settings, recordRuntimesHost().host).items ?? [];
		const needle = query.toLowerCase();
		return pages
			.filter((page) =>
				shown((page as RuntimePage).items ?? []).some((def) =>
					[def.name, typeof def.desc === 'string' ? def.desc : '', ...(def.aliases ?? [])].some((text) =>
						text.toLowerCase().includes(needle),
					),
				),
			)
			.map((page) => page.name);
	}

	it('finds every runtime page by "socket path" and "SSH host", whatever its kind', () => {
		const settings = twoRuntimes();
		const claude = { ...newRuntime('claude', 'local', []), name: 'Claude here' };
		settings.runtimes.push(claude);
		expect(search(settings, 'socket path')).toEqual(['Local', 'xl', 'Claude here']);
		expect(search(settings, 'ssh host')).toEqual(['Local', 'xl', 'Claude here']);
	});
});

describe('where the connection is shown', () => {
	it('names the active runtime on the root, and draws the line again when the connection changes', () => {
		const recorded = recordRuntimesHost();
		const { setting, cleanup } = rendered(activeRuntimeLine(recorded.host));
		expect(setting.name).toBe('Active runtime: Local · connected');
		expect(setting.settingEl.classes.has('mod-warning')).toBe(false);

		recorded.connection.current = { ...recorded.connection.current, state: 'not connected', error: 'refused' };
		recorded.connection.changed();
		expect(setting.name).toBe('Active runtime: Local · not connected');
		expect(setting.settingEl.classes.has('mod-warning')).toBe(true);
		(cleanup as () => void)();
		expect(recorded.connection.listeners.size).toBe(0);
	});

	it('opens the active runtime’s page from the root line where the build can, and is plain text otherwise', () => {
		const plain = rendered(activeRuntimeLine(recordRuntimesHost().host)).setting;
		expect(plain.settingEl.listeners).toEqual([]);

		const recorded = recordRuntimesHost({ canOpenPages: true, connection: fakeConnection({ runtime: twoRuntimes().runtimes[1]! }) });
		const { setting, cleanup } = rendered(activeRuntimeLine(recorded.host));
		expect(setting.settingEl.classes.has('mod-clickable')).toBe(true);
		setting.settingEl.dispatch('click');
		setting.settingEl.dispatch('keydown', { key: 'Enter', preventDefault: () => undefined });
		setting.settingEl.dispatch('keydown', { key: 'a', preventDefault: () => undefined });
		expect(recorded.calls).toEqual([`openPage:Runtimes/${XL}`, `openPage:Runtimes/${XL}`]);
		expect(typeof cleanup).toBe('function');
	});

	it('gives the active runtime’s page the connection’s lines, without naming the runtime, kept current', () => {
		const settings = twoRuntimes();
		const recorded = recordRuntimesHost();
		const { setting, cleanup } = rendered(named(pageOf(settings, recorded.host, 'local'), 'Connection'));
		const lines = (): string[] => setting.settingEl.created.map((line) => line.text ?? '');
		expect(setting.settingEl.classes.has('herdr-settings-status')).toBe(true);
		expect(lines()).toContain('Socket: /tmp/herdr.sock');
		expect(lines().some((line) => line.startsWith('Runtime: '))).toBe(false);

		recorded.connection.current = { ...recorded.connection.current, workspace: null };
		recorded.connection.changed();
		expect(lines()).toContain('Workspace: no herdr workspace matches this vault yet.');
		(cleanup as () => void)();
		expect(recorded.connection.listeners.size).toBe(0);
	});

	it('shows no live lines on another runtime’s page, and says it is not active by Use this runtime', () => {
		const settings = twoRuntimes();
		const page = pageOf(settings, recordRuntimesHost().host, XL);
		expect(shown(page.items ?? []).map((def) => def.name)).not.toContain('Connection');
		expect(named(page, 'Use this runtime').desc).toMatch(/^Not active\./);
	});
});
