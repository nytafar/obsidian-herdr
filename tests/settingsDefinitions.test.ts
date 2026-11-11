/**
 * The settings tab on the declarative API (issue #156, ADR-0011).
 *
 * What is pinned: the layout of #120 (the root, its pages and what each
 * holds), the one write path (a key is stored, normalised, saved, and its
 * effect runs, in that order), the key→effect table being total over the
 * controls the definitions name, and `docs/settings.md` naming every
 * setting. The runtime list and the agent CLI catalog are still their 0.7.1
 * builders inside `render` definitions; `settingsSections.test.ts` covers
 * the builders, this file that the tab draws them.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type {
	SettingDefinition,
	SettingDefinitionItem,
	SettingDefinitionPage,
	SettingDefinitionRender,
} from 'obsidian';
import { builtSettings, Setting, settingNames } from './fixtures/obsidian';
import { DEFAULT_SETTINGS, MAX_PANES_PER_TAB, MAX_SCROLLBACK_MB, type HerdrSettings } from '../src/settings';
import {
	isControlKey,
	readSetting,
	SETTING_EFFECTS,
	writeSetting,
	type ControlKey,
	type SettingsHost,
} from '../src/settingsTab/effects';
import type { ListCallbacks } from '../src/settingsTab/lists';
import { HerdrSettingTab, settingDefinitions } from '../src/settingsTab/tab';
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
		},
	};
}

/** List callbacks that do nothing; the builders only need them to exist. */
function quietLists(): ListCallbacks {
	return {
		save: async () => undefined,
		saveAndReconnect: async () => undefined,
		redisplay: () => undefined,
		refreshAgentList: () => undefined,
		activateRuntime: async () => undefined,
		refreshRuntimes: () => undefined,
		kindUnavailable: () => null,
		editingRuntime: () => null,
		editRuntime: () => undefined,
		confirm: async () => true,
	};
}

function definitionsOf(settings: HerdrSettings, renderStatus: (el: HTMLElement) => void = () => undefined) {
	return settingDefinitions(() => settings, renderStatus, quietLists());
}

const isPage = (item: SettingDefinitionItem): item is SettingDefinitionPage =>
	'type' in item && item.type === 'page';

/** Every setting definition, groups and pages flattened, with its page. */
function flatten(items: readonly SettingDefinitionItem[], page = ''): { def: SettingDefinition; page: string }[] {
	const out: { def: SettingDefinition; page: string }[] = [];
	for (const item of items) {
		if ('type' in item && item.type === 'page') out.push(...flatten(item.items ?? [], item.name));
		else if ('type' in item && (item.type === 'group' || item.type === 'list')) out.push(...flatten(item.items ?? [], page));
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
	it('opens on the status block, then one entry per page', () => {
		const items = definitionsOf(settingsOf());
		expect(items[0]).toMatchObject({ name: 'Connection status' });
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
			'': ['Connection status'],
			Runtimes: ['Runtimes', 'Extra PATH entries'],
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

	it('shows the active runtime, the default view and the engine on the page entries', () => {
		const settings = settingsOf({ defaultView: 'terminal', terminalEngine: 'xterm.js' });
		const items = definitionsOf(settings);
		expect(valueOf(pageNamed(items, 'Runtimes').displayValue)).toBe('Local');
		expect(valueOf(pageNamed(items, 'Views').displayValue)).toBe('Terminal');
		expect(valueOf(pageNamed(items, 'Terminal').displayValue)).toBe('xterm.js');
		// Read at render time, so a change shows when the root is drawn again.
		settings.terminalEngine = 'ghostty-web';
		expect(valueOf(pageNamed(items, 'Terminal').displayValue)).toBe('Ghostty web');
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

	const controlKeys = (): string[] =>
		flatten(definitionsOf(settingsOf()))
			.map(({ def }) => keyOf(def))
			.filter((key): key is string => key !== null);

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

	it('draws the connection status block into its row', () => {
		const drawnInto: unknown[] = [];
		const items = definitionsOf(settingsOf(), (el) => drawnInto.push(el));
		const setting = rendered(definitionNamed(items, 'Connection status'));
		expect(drawnInto).toEqual([setting.settingEl]);
		expect(setting.settingEl.classes).toContain('herdr-settings-status');
	});

	it('draws the 0.7.1 runtime list inside the Runtimes page (until #178)', () => {
		const items = definitionsOf(settingsOf());
		const setting = rendered(definitionNamed(items, 'Runtimes'));
		expect(setting.settingEl.emptied).toBe(1);
		expect(settingNames(setting.settingEl)).toEqual(['Local', 'Add runtime']);
	});

	it('draws the 0.7.1 agent CLI catalog inside the Agents page (until #179)', () => {
		const items = definitionsOf(settingsOf());
		const setting = rendered(definitionNamed(items, 'Agent CLIs'));
		const names = settingNames(setting.settingEl);
		expect(names[0]).toBe('Agent CLIs');
		expect(names).toContain('Add agent CLI');
		expect(builtSettings(setting.settingEl).length).toBeGreaterThan(2);
	});
});

describe('the tab', () => {
	function tabOf(settings: HerdrSettings) {
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
		const tab = new HerdrSettingTab({} as never, plugin as unknown as HerdrPlugin, () => undefined);
		return { tab, calls };
	}

	it('reads and writes the plugin’s settings through the table', async () => {
		const settings = settingsOf();
		const { tab, calls } = tabOf(settings);
		expect(tab.getControlValue('terminalEngine')).toBe('ghostty-web');
		await tab.setControlValue('agentListSort', 'alphabetical');
		expect(settings.agentListSort).toBe('alphabetical');
		expect(calls).toEqual(['save', 'refreshAgentList']);
	});

	it('draws the open page again when a runtime’s form opens, keeping which one', () => {
		const settings = settingsOf();
		const { tab } = tabOf(settings);
		const list = definitionNamed(tab.getSettingDefinitions(), 'Runtimes') as SettingDefinitionRender;
		const first = new Setting({});
		list.render(first as never, {} as never);
		// The pencil on the local runtime's row.
		const pencil = builtSettings(first.settingEl)
			.find((row) => row.name === 'Local')
			?.components.find((component) => 'tooltip' in component && component.tooltip === 'Edit runtime');
		(pencil as { click(): unknown }).click();
		expect((tab as unknown as { updates: number }).updates).toBe(1);

		const again = new Setting({});
		list.render(again as never, {} as never);
		expect(settingNames(again.settingEl)).toContain('Edit Local');
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

	it('names every setting of the tab in a table', () => {
		const missing = flatten(definitionsOf(settingsOf()))
			.map(({ def }) => def.name)
			.filter((name) => !documented.has(name));
		expect(missing).toEqual([]);
	});

	it('has a section for every page and every group heading', () => {
		const items = definitionsOf(settingsOf());
		const missing = [...items.filter(isPage).map((page) => page.name), ...headings(items)].filter(
			(name) => !docHeadings.has(name),
		);
		expect(missing).toEqual([]);
	});
});
