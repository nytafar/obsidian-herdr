/**
 * The settings tab on the declarative API (issue #156, ADR-0011).
 *
 * What is pinned: the layout of #120 (the root, its pages and what each
 * holds), the one write path (a key is stored, normalised, saved, and its
 * effect runs, in that order), the key→effect table being total over the
 * controls the definitions name, and `docs/settings.md` naming every
 * setting. The rows of a `list` are data, not settings, so the layout and
 * the docs check skip them, but a page a list holds is settings and is
 * walked. `settingsRuntimes.test.ts` covers the runtime list and its pages
 * (#178), `agentCatalogSettings.test.ts` the agent CLI catalog's lists
 * (#179), and `settingsSections.test.ts` a runtime's default agent.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type {
	SettingDefinition,
	SettingDefinitionItem,
	SettingDefinitionList,
	SettingDefinitionPage,
	SettingDefinitionRender,
} from 'obsidian';
import { Setting } from './fixtures/obsidian';
import { DEFAULT_SETTINGS, MAX_PANES_PER_TAB, MAX_SCROLLBACK_MB, type HerdrSettings } from '../src/settings';
import {
	isControlKey,
	readSetting,
	SETTING_EFFECTS,
	writeSetting,
	type ControlKey,
	type SettingsHost,
} from '../src/settingsTab/effects';
import { parseRuntimeKey } from '../src/settingsTab/runtimeKeys';
import type { RuntimesHost } from '../src/settingsTab/runtimes';
import { fakeConnection, quietRuntimes } from './fixtures/runtimesHost';
import { HerdrSettingTab, settingDefinitions } from '../src/settingsTab/tab';
import { AgentCatalogSession } from '../src/settingsTab/agentCatalog';
import type HerdrPlugin from '../src/main';

function settingsOf(overrides: Partial<HerdrSettings> = {}): HerdrSettings {
	return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

/** A host that records what each change costs, in order. */
function hostRecorder(): { calls: string[]; host: SettingsHost } {
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

/** An agent catalog with nothing probed and nothing to probe with. */
function quietCatalog(settings: HerdrSettings): AgentCatalogSession {
	return new AgentCatalogSession({
		settings: () => settings,
		probe: () => null,
		refresh: async () => false,
		nativeReachable: () => true,
		newMachineProbes: () => {
			throw new Error('not drawn here');
		},
		write: async () => undefined,
		saved: async () => undefined,
		confirm: async () => true,
		update: () => undefined,
		openPage: () => undefined,
		canOpenPages: () => false,
	});
}

function definitionsOf(settings: HerdrSettings, runtimes: RuntimesHost = quietRuntimes()) {
	return settingDefinitions(() => settings, runtimes, quietCatalog(settings));
}

const isPage = (item: SettingDefinitionItem): item is SettingDefinitionPage =>
	'type' in item && item.type === 'page';

/**
 * Every setting definition, groups and pages flattened, with its page. The
 * rows of a list are data and are left out, but the settings on a page a
 * list holds (a runtime's, #178) are walked.
 */
function flatten(items: readonly SettingDefinitionItem[], page = ''): { def: SettingDefinition; page: string }[] {
	const out: { def: SettingDefinition; page: string }[] = [];
	for (const item of items) {
		if ('type' in item && item.type === 'page') out.push(...flatten(item.items ?? [], item.name));
		else if ('type' in item && item.type === 'group') out.push(...flatten(item.items ?? [], page));
		else if ('type' in item && item.type === 'list') out.push(...flatten((item.items ?? []).filter(isPage), page));
		else out.push({ def: item as SettingDefinition, page });
	}
	return out;
}

/** Group headings anywhere in the definitions. */
function headings(items: readonly SettingDefinitionItem[]): string[] {
	const out: string[] = [];
	for (const item of items) {
		if (!('type' in item)) continue;
		if (item.type === 'group' || item.type === 'list') {
			if (item.heading) out.push(item.heading);
			out.push(...headings(item.items ?? []));
		} else if (item.type === 'page') out.push(...headings(item.items ?? []));
	}
	return out;
}

const keyOf = (def: SettingDefinition): string | null => ('control' in def && def.control ? def.control.key : null);

function pageNamed(items: readonly SettingDefinitionItem[], name: string): SettingDefinitionPage {
	const page = items.filter(isPage).find((item) => item.name === name);
	if (!page) throw new Error(`no page "${name}"`);
	return page;
}

function definitionNamed(items: readonly SettingDefinitionItem[], name: string): SettingDefinition {
	const hit = flatten(items).find(({ def }) => def.name === name);
	if (!hit) throw new Error(`no setting "${name}"`);
	return hit.def;
}

const valueOf = <T>(value: T | (() => T) | undefined): T | undefined =>
	typeof value === 'function' ? (value as () => T)() : value;

describe('the layout (#120)', () => {
	it('opens on the active runtime’s line, then one entry per page', () => {
		const items = definitionsOf(settingsOf());
		expect(items[0]).toMatchObject({ name: 'Active runtime' });
		expect(items.slice(1).map((item) => (isPage(item) ? item.name : null))).toEqual([
			'Runtimes',
			'Agents',
			'Views',
			'Terminal',
			'Agent list and notifications',
		]);
	});

	it('puts every setting on the page the layout table gives it', () => {
		const byPage = new Map<string, string[]>();
		for (const { def, page } of flatten(definitionsOf(settingsOf()))) {
			byPage.set(page, [...(byPage.get(page) ?? []), def.name]);
		}
		expect(Object.fromEntries(byPage)).toEqual({
			'': ['Active runtime'],
			Runtimes: ['Extra PATH entries'],
			// The one runtime's page, inside the runtime list (#178).
			Local: [
				'Connection',
				'Name',
				'Kind',
				'Target',
				'Socket path',
				'Herdr binary',
				'Workspace ID',
				'SSH host',
				'Remote socket path',
				'Remote herdr binary',
				'Remote vault path',
				'Workspace ID',
				'Hc binary',
				'Space',
				'SSH host',
				'Remote hc binary',
				'Remote vault path',
				'Space',
				'Claude binary',
				'Permission mode',
				'Terminal view',
				'Claude session hook',
				'Default agent',
				'Problems',
				'Reconnect',
				'Order',
				'Remove runtime',
			],
			Agents: [
				'Agent CLIs',
				'Agent name pattern',
				'Open terminal after starting an agent',
				'Share a herdr tab between agents in the same folder',
				'Panes per herdr tab',
			],
			Views: ['Default view', 'Tool groups', 'Prompt box style', 'Context readout', 'Trust new folders automatically'],
			Terminal: [
				'Attach mode',
				'Terminal placement',
				'Terminal tab',
				'Terminal tab title',
				'Theme',
				'Terminal engine',
				'Cursor style',
				'Blinking cursor',
				'Font family',
				'Font size',
				'Scrollback memory budget',
			],
			'Agent list and notifications': [
				'Sort',
				'Group by',
				'Clicking an agent row',
				'Folder hover button',
				'Status bar counts',
				'Blocked: notice',
				'Blocked: system notification',
				'Done: notice',
				'Done: system notification',
			],
		});
	});

	it('shows the default view and the engine on the page entries, and Runtimes only a problem', () => {
		const settings = settingsOf({ defaultView: 'terminal', terminalEngine: 'xterm.js' });
		const items = definitionsOf(settings);
		// The root's line names the active runtime; the entry does not repeat it.
		expect(pageNamed(items, 'Runtimes').displayValue).toBeUndefined();
		expect(valueOf(pageNamed(items, 'Runtimes').status)).toBeNull();
		settings.runtimes[0]!.target = 'ssh';
		expect(valueOf(pageNamed(items, 'Runtimes').status)).toBe('warning');
		expect(valueOf(pageNamed(items, 'Views').displayValue)).toBe('Terminal');
		expect(valueOf(pageNamed(items, 'Terminal').displayValue)).toBe('xterm.js');
		// Read at render time, so a change shows when the root is drawn again.
		settings.terminalEngine = 'ghostty-web';
		expect(valueOf(pageNamed(items, 'Terminal').displayValue)).toBe('Ghostty web');
	});

	it('marks the Agents entry while one of the user’s agent CLIs needs attention', () => {
		const settings = settingsOf();
		const items = definitionsOf(settings);
		expect(valueOf(pageNamed(items, 'Agents').status)).toBeNull();
		// A command of the user's own cannot start on the local herdr.
		settings.agentProfiles = [{ id: 'user-a', name: 'Mine', agent: 'codex', command: '~/bin/mine', args: [] }];
		expect(valueOf(pageNamed(items, 'Agents').status)).toBe('warning');
	});

	it('finds the panes-per-tab cap, hidden while sharing is off, through the sharing row', () => {
		const share = definitionNamed(definitionsOf(settingsOf()), 'Share a herdr tab between agents in the same folder');
		expect(share.aliases).toContain('panes per herdr tab');
	});

	it('shows the panes-per-tab cap only while agents share a tab', () => {
		const settings = settingsOf({ splitIntoFolderTab: true });
		const cap = definitionNamed(definitionsOf(settings), 'Panes per herdr tab');
		expect(valueOf(cap.visible)).toBe(true);
		settings.splitIntoFolderTab = false;
		expect(valueOf(cap.visible)).toBe(false);
	});

	it('offers every stored default among its dropdown’s options', () => {
		const settings = settingsOf();
		for (const { def } of flatten(definitionsOf(settings))) {
			if (!('control' in def) || def.control?.type !== 'dropdown') continue;
			expect(Object.keys(def.control.options), def.name).toContain(readSetting(settings, def.control.key));
		}
	});

	it('offers both views as the default, and the two engines apart from it (#104)', () => {
		const items = definitionsOf(settingsOf());
		const options = (name: string): string[] => {
			const def = definitionNamed(items, name);
			return 'control' in def && def.control?.type === 'dropdown' ? Object.keys(def.control.options) : [];
		};
		expect(options('Default view')).toEqual(['terminal', 'native']);
		expect(options('Terminal engine')).toEqual(['ghostty-web', 'xterm.js']);
	});

	it('names every setting, page and heading in sentence case', () => {
		const items = definitionsOf(settingsOf());
		const names = [
			...flatten(items).map(({ def }) => def.name),
			...items.filter(isPage).map((page) => page.name),
			...headings(items),
		];
		// Allowed second-and-later words: lower case, or an acronym (ID, PATH).
		const exceptions = new Set(['ID', 'PATH', 'CLI', 'CLIs']);
		for (const name of names) {
			for (const word of name.split(' ').slice(1)) {
				const bare = word.replace(/[^A-Za-z]/g, '');
				if (!bare || exceptions.has(bare)) continue;
				expect(bare[0], `"${name}" is not sentence case`).toBe(bare[0]?.toLowerCase());
			}
		}
	});
});

describe('the key→effect table', () => {
	/**
	 * What each key's change costs after the save, as the settings tab did it
	 * in 0.7.1. Kept apart from `SETTING_EFFECTS` on purpose: a key added to
	 * the definitions without a line here fails below.
	 */
	const EXPECTED: Record<ControlKey, string[]> = {
		extraPath: ['reconnect'],
		agentNamePattern: [],
		openTerminalAfterStart: [],
		splitIntoFolderTab: [],
		panesPerTab: [],
		defaultView: ['applyTerminalSetting:defaultView'],
		nativeToolGroups: ['refreshNativeViews'],
		nativePromptBoxStyle: ['refreshNativeViews'],
		nativeContextReadout: ['refreshNativeViews'],
		nativeAutoTrustFolders: ['refreshNativeViews'],
		defaultAttachMode: [],
		terminalPlacement: [],
		terminalTab: [],
		terminalTitleSource: ['applyTerminalSetting:terminalTitleSource'],
		terminalTheme: ['applyTerminalSetting:terminalTheme'],
		terminalEngine: ['applyTerminalSetting:terminalEngine'],
		terminalCursorStyle: ['applyTerminalSetting:terminalCursorStyle'],
		terminalCursorBlink: ['applyTerminalSetting:terminalCursorBlink'],
		terminalFontFamily: ['applyTerminalSetting:terminalFontFamily'],
		terminalFontSize: ['applyTerminalSetting:terminalFontSize'],
		terminalScrollbackMb: ['applyTerminalSetting:terminalScrollbackMb'],
		agentListSort: ['refreshAgentList'],
		agentListGroupBy: ['refreshAgentList'],
		agentListRowClick: ['refreshAgentList'],
		folderHoverButton: ['refreshFolderHoverButton'],
		'notifications.statusBar': [],
		'notifications.blocked.notice': [],
		'notifications.blocked.os': [],
		'notifications.done.notice': [],
		'notifications.done.os': [],
	};

	/** The table's keys; a runtime page's `runtimes.<id>.<field>` keys have their own tests. */
	const controlKeys = (): string[] =>
		flatten(definitionsOf(settingsOf()))
			.map(({ def }) => keyOf(def))
			.filter((key): key is string => key !== null && parseRuntimeKey(key) === null);

	it('has an effect for every control the definitions name, and nothing else', () => {
		const keys = controlKeys();
		expect(new Set(keys).size, 'a key is used by two controls').toBe(keys.length);
		expect([...keys].sort()).toEqual(Object.keys(SETTING_EFFECTS).sort());
		expect([...keys].sort()).toEqual(Object.keys(EXPECTED).sort());
	});

	it('keeps every key a stored data.json field', () => {
		for (const key of controlKeys()) {
			const [top, ...rest] = key.split('.');
			expect(Object.keys(DEFAULT_SETTINGS), key).toContain(top);
			if (rest.length > 0) expect(readSetting(DEFAULT_SETTINGS, key), key).not.toBeUndefined();
		}
	});

	for (const [key, effects] of Object.entries(EXPECTED)) {
		it(`saves ${key}, then ${effects.length > 0 ? effects.join(', ') : 'nothing else'}`, async () => {
			const settings = settingsOf();
			const { calls, host } = hostRecorder();
			await writeSetting(settings, key, readSetting(settings, key), host);
			// The effect reads the saved value, so the save comes first.
			expect(calls).toEqual(['save', ...effects]);
		});
	}

	it('writes a dotted key into its transition and leaves the other alone', async () => {
		const settings = settingsOf();
		const { host } = hostRecorder();
		await writeSetting(settings, 'notifications.blocked.notice', false, host);
		await writeSetting(settings, 'notifications.done.os', true, host);
		await writeSetting(settings, 'notifications.statusBar', false, host);
		expect(settings.notifications).toEqual({
			statusBar: false,
			blocked: { notice: false, os: true },
			done: { notice: true, os: true },
		});
	});

	it('normalises what a control hands back before storing it', async () => {
		const settings = settingsOf();
		const { host } = hostRecorder();
		await writeSetting(settings, 'terminalScrollbackMb', 999, host);
		await writeSetting(settings, 'panesPerTab', 99, host);
		await writeSetting(settings, 'terminalPlacement', 'sideways', host);
		await writeSetting(settings, 'terminalTheme', 'not-a-theme', host);
		await writeSetting(settings, 'terminalEngine', 'native', host);
		expect(settings.terminalScrollbackMb).toBe(MAX_SCROLLBACK_MB);
		expect(settings.panesPerTab).toBe(MAX_PANES_PER_TAB);
		expect(settings.terminalPlacement).toBe('split-right');
		expect(settings.terminalTheme).toBe('obsidian');
		expect(settings.terminalEngine).toBe('ghostty-web');
	});

	it('reads a stored value it does not know as the default', () => {
		const settings = settingsOf();
		const loose = settings as unknown as Record<string, unknown>;
		loose.terminalTab = 'sideways';
		loose.nativePromptBoxStyle = 'bubbly';
		loose.nativeAutoTrustFolders = 'yes';
		delete loose.terminalCursorBlink;
		expect(readSetting(settings, 'terminalTab')).toBe('per-agent');
		expect(readSetting(settings, 'nativePromptBoxStyle')).toBe('divided');
		expect(readSetting(settings, 'nativeAutoTrustFolders')).toBe(false);
		expect(readSetting(settings, 'terminalCursorBlink')).toBe(true);
	});

	it('changes nothing and saves nothing for a key it does not know', async () => {
		const settings = settingsOf();
		const before = structuredClone(settings);
		const { calls, host } = hostRecorder();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await writeSetting(settings, 'runtimes', [], host);
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
		expect(isControlKey('runtimes')).toBe(false);
		expect(settings).toEqual(before);
		expect(calls).toEqual([]);
	});
});

describe('the parts still drawn imperatively', () => {
	const rendered = (def: SettingDefinition): Setting => {
		const setting = new Setting({});
		(def as SettingDefinitionRender).render(setting as never, {} as never);
		return setting;
	};

	it('draws the active runtime’s line on the root, and nothing more of the connection', () => {
		const setting = rendered(definitionNamed(definitionsOf(settingsOf()), 'Active runtime'));
		expect(setting.name).toBe('Active runtime: Local · connected');
	});

	it('puts the agent CLI catalog’s two lists on the Agents page (#179)', () => {
		const agents = pageNamed(definitionsOf(settingsOf()), 'Agents');
		const lists = (agents.items ?? []).filter((item) => 'type' in item && item.type === 'list');
		expect(lists.map((list) => ('heading' in list ? list.heading : null))).toEqual([
			'Built-in agent CLIs',
			'Your agent CLIs',
		]);
	});
});

describe('the tab', () => {
	function tabOf(settings: HerdrSettings, app: unknown = {}) {
		const { calls, host } = hostRecorder();
		const plugin = {
			...host,
			settings,
			switchRuntime: async () => undefined,
			refreshRuntimes: () => undefined,
			kindUnavailable: () => null,
			nativeReachable: () => true,
			agentCatalogs: { cachedProbeFor: () => null, refresh: async () => false },
		};
		const tab = new HerdrSettingTab(app as never, plugin as unknown as HerdrPlugin, fakeConnection());
		return { tab, calls };
	}

	/** The parts of one opening of the settings a hide may end. */
	const openingOf = (tab: HerdrSettingTab) => {
		const inner = tab as unknown as { catalog: AgentCatalogSession; removedRuntimes: Map<string, string> };
		const ended = vi.spyOn(inner.catalog, 'end');
		inner.removedRuntimes.set('gone', 'Gone');
		return { ended, removed: inner.removedRuntimes };
	};
	const microtask = (): Promise<void> => Promise.resolve().then(() => undefined);

	it('keeps the opening when Obsidian re-opens the tab to show one of its pages', async () => {
		// `openPagePath` re-opens the tab: `hide()`, then it is the active tab again at once.
		const modal: { activeTab: unknown } = { activeTab: null };
		const { tab } = tabOf(settingsOf(), { setting: modal });
		modal.activeTab = tab;
		const { ended, removed } = openingOf(tab);
		tab.hide();
		await microtask();
		expect(ended).not.toHaveBeenCalled();
		expect(removed.size).toBe(1);
	});

	it('ends the opening when the settings close or another tab opens', async () => {
		const modal: { activeTab: unknown } = { activeTab: null };
		const { tab } = tabOf(settingsOf(), { setting: modal });
		const { ended, removed } = openingOf(tab);
		modal.activeTab = tab;
		tab.hide();
		modal.activeTab = null;
		await microtask();
		expect(ended).toHaveBeenCalledOnce();
		expect(removed.size).toBe(0);
	});

	it('ends the opening where it cannot tell whether the tab is still shown', async () => {
		const { tab } = tabOf(settingsOf(), {});
		const { ended } = openingOf(tab);
		tab.hide();
		await microtask();
		expect(ended).toHaveBeenCalledOnce();
	});

	it('draws a runtime page again once a host is typed into a runtime with no name, for its Name placeholder', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('window', globalThis);
		try {
			const settings = settingsOf();
			settings.runtimes.push({ ...settings.runtimes[0]!, id: 'rt-x', name: '', target: 'ssh', host: '' });
			const { tab } = tabOf(settings);
			const updates = (): number => (tab as unknown as { updates: number }).updates;
			await tab.setControlValue('runtimes.rt-x.host', 'l');
			await tab.setControlValue('runtimes.rt-x.host', 'lasse@xl');
			expect(updates()).toBe(0);
			vi.advanceTimersByTime(1000);
			expect(updates()).toBe(1);

			// A named runtime's Name shows its name, not the derived one: nothing to redraw.
			settings.runtimes[1]!.name = 'XL';
			await tab.setControlValue('runtimes.rt-x.host', 'lasse@xl2');
			vi.advanceTimersByTime(1000);
			expect(updates()).toBe(1);
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it('reads and writes the plugin’s settings through the table', async () => {
		const settings = settingsOf();
		const { tab, calls } = tabOf(settings);
		expect(tab.getControlValue('terminalEngine')).toBe('ghostty-web');
		await tab.setControlValue('agentListSort', 'alphabetical');
		expect(settings.agentListSort).toBe('alphabetical');
		expect(calls).toEqual(['save', 'refreshAgentList']);
	});

	it('tells a runtime page’s rows about a write to its runtime, and redraws the page for a kind', async () => {
		const settings = settingsOf();
		const { tab, calls } = tabOf(settings);
		const heard: string[] = [];
		const runtimes = (tab as unknown as { runtimesHost(lists: unknown): RuntimesHost })
			.runtimesHost({});
		const stop = runtimes.onRuntimeWrite((id, field) => heard.push(`${id}.${field}`));

		await tab.setControlValue('runtimes.local.workspace', 'w7');
		expect(settings.runtimes[0]?.workspace).toBe('w7');
		// The active runtime: a connection field reconnects.
		expect(calls).toEqual(['save', 'reconnect']);
		expect(heard).toEqual(['local.workspace']);
		// Typing redraws nothing: the field keeps its focus.
		expect((tab as unknown as { updates: number }).updates).toBe(0);

		await tab.setControlValue('runtimes.local.kind', 'herdr-core');
		expect((tab as unknown as { updates: number }).updates).toBe(1);
		stop();
		await tab.setControlValue('runtimes.local.name', 'Laptop');
		expect(heard).toEqual(['local.workspace', 'local.kind']);
		expect(tab.getControlValue('runtimes.local.name')).toBe('Laptop');
	});
});

describe('docs/settings.md', () => {
	const docs = readFileSync(new URL('../docs/settings.md', import.meta.url), 'utf8');
	/** Every name in the first cell of a table row, split on ", " and " / ". */
	const documented = new Set(
		docs
			.split('\n')
			.filter((line) => line.startsWith('| ') && !line.startsWith('| Setting |'))
			.flatMap((line) => (line.split('|')[1] ?? '').split(/, | \/ /).map((name) => name.trim())),
	);
	const docHeadings = new Set(
		docs
			.split('\n')
			.filter((line) => line.startsWith('#'))
			.map((line) => line.replace(/^#+\s*/, '').trim()),
	);

	/**
	 * Settings that show every page's rows: a user agent CLI (its page's
	 * fields), and a second runtime that is not active (its "Use this
	 * runtime"), beside the active one ("Reconnect", Status).
	 */
	const everyRow = (): HerdrSettings =>
		settingsOf({
			runtimes: [
				structuredClone(DEFAULT_SETTINGS.runtimes[0]!),
				{ ...structuredClone(DEFAULT_SETTINGS.runtimes[0]!), id: 'rt-xl', name: 'xl', target: 'ssh', host: 'lasse@xl' },
			],
			agentProfiles: [{ id: 'user-a', name: 'Work codex', agent: 'codex', command: '', args: ['--profile', 'work'] }],
		});

	/** What the tab calls its settings: every row, and what the lists add. */
	const tabNames = (items: readonly SettingDefinitionItem[]): Set<string> => {
		const names = new Set(flatten(items).map(({ def }) => def.name));
		const lists = (inner: readonly SettingDefinitionItem[]): void => {
			for (const item of inner) {
				if (!('type' in item)) continue;
				if (item.type === 'list') {
					const add = (item as SettingDefinitionList).addItem;
					if (add) names.add(add.name);
				}
				if (item.type === 'page' || item.type === 'group' || item.type === 'list') lists(item.items ?? []);
			}
		};
		lists(items);
		return names;
	};

	/** Rows of the docs' tables that describe something other than a setting of the tab. */
	const NOT_SETTINGS = new Set(['Pinned panes', 'Built-in agent CLI row', 'Your agent CLI row']);

	it('walks a fixture with every kind of row', () => {
		const names = tabNames(definitionsOf(everyRow()));
		for (const name of ['Agent', 'Command', 'Arguments', 'Hide from the menu', 'Where it starts', 'Remove agent CLI']) {
			expect(names.has(name), name).toBe(true);
		}
		expect(names.has('Use this runtime')).toBe(true);
		expect(names.has('Reconnect')).toBe(true);
	});

	it('names every setting of the tab in a table', () => {
		const missing = [...tabNames(definitionsOf(everyRow()))].filter((name) => !documented.has(name));
		expect(missing).toEqual([]);
	});

	it('has no table row for a setting the tab no longer has', () => {
		const names = tabNames(definitionsOf(everyRow()));
		const stale = [...documented].filter((name) => name && !names.has(name) && !NOT_SETTINGS.has(name));
		expect(stale).toEqual([]);
	});

	it('has a section for every page and every group heading', () => {
		const items = definitionsOf(everyRow());
		const missing = [...items.filter(isPage).map((page) => page.name), ...headings(items)].filter(
			(name) => !docHeadings.has(name),
		);
		expect(missing).toEqual([]);
	});
});
