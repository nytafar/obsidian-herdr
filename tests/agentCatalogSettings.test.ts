/**
 * The agent CLI catalog on the Agents page as definitions (issue #179): the
 * built-ins as a `list` of rows with the eye, the user's entries as a `list`
 * of pages, the catalog's keys and their write path, and the machine probes
 * of one opening of the settings, which draw the open page again through
 * `update()` as they land.
 */

import { describe, expect, it } from 'vitest';
import type {
	SettingDefinition,
	SettingDefinitionItem,
	SettingDefinitionList,
	SettingDefinitionPage,
	SettingDefinitionRender,
} from 'obsidian';
import { ButtonComponent, Setting } from './fixtures/obsidian';
import { DEFAULT_SETTINGS, type HerdrSettings } from '../src/settings';
import { newRuntime } from '../src/runtimes';
import type { AgentProbe } from '../src/agents/catalog';
import { MachineProbes } from '../src/agents/machines';
import {
	AgentCatalogSession,
	isCatalogKey,
	readCatalogSetting,
	writeCatalogSetting,
	type AgentCatalogHost,
	type CatalogKey,
} from '../src/settingsTab/agentCatalog';
import { HerdrSettingTab } from '../src/settingsTab/tab';
import type HerdrPlugin from '../src/main';

function settingsOf(overrides: Partial<HerdrSettings> = {}): HerdrSettings {
	return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

const WORK_CODEX = { id: 'user-a', name: 'Work codex', agent: 'codex', command: '', args: ['--profile', 'work'] };

/** A host over `settings` that records what the catalog asks for, in order. */
function hostOf(
	settings: HerdrSettings,
	options: {
		probe?: AgentProbe | null;
		refresh?: (runtimeId: string, again?: boolean) => Promise<boolean>;
		machines?: () => MachineProbes;
		confirm?: boolean;
	} = {},
): { host: AgentCatalogHost; calls: string[] } {
	const calls: string[] = [];
	const host: AgentCatalogHost = {
		settings: () => settings,
		probe: () => options.probe ?? null,
		refresh: options.refresh ?? (async () => false),
		nativeReachable: () => true,
		newMachineProbes:
			options.machines ??
			(() =>
				new MachineProbes({
					live: () => null,
					local: () => new Promise(() => undefined),
					ssh: () => new Promise(() => undefined),
				})),
		write: async (key, value) => {
			calls.push(`write:${key}=${String(value)}`);
			await writeCatalogSetting(settings, key, value, {
				saveSettings: async () => undefined,
				refreshAgentList: () => undefined,
			});
		},
		saved: async () => {
			calls.push('saved');
		},
		confirm: async (text) => {
			calls.push(`confirm:${text.title}`);
			return options.confirm ?? true;
		},
		update: () => calls.push('update'),
	};
	return { host, calls };
}

function listNamed(items: readonly SettingDefinitionItem[], heading: string): SettingDefinitionList {
	const list = items.find((item) => 'type' in item && item.type === 'list' && item.heading === heading);
	if (!list) throw new Error(`no list "${heading}"`);
	return list as SettingDefinitionList;
}

const rowsOf = (items: readonly SettingDefinitionItem[]): SettingDefinition[] =>
	listNamed(items, 'Built-in agent CLIs').items ?? [];

function rowNamed(items: readonly SettingDefinitionItem[], name: string): SettingDefinitionRender {
	const row = rowsOf(items).find((def) => def.name === name);
	if (!row) throw new Error(`no row "${name}"`);
	return row as SettingDefinitionRender;
}

type Page = SettingDefinitionPage<CatalogKey> & { id?: string };
const pagesOf = (items: readonly SettingDefinitionItem[]): Page[] =>
	(listNamed(items, 'Your agent CLIs').items ?? []) as Page[];

/** The rows of a user entry's page. */
function fieldsOf(page: Page): SettingDefinition<CatalogKey>[] {
	const group = page.items?.[0];
	if (!group || !('type' in group) || group.type !== 'group') throw new Error('no fields');
	return group.items ?? [];
}

function fieldNamed(page: Page, name: string): SettingDefinition<CatalogKey> {
	const field = fieldsOf(page).find((def) => def.name === name);
	if (!field) throw new Error(`no field "${name}"`);
	return field;
}

const keyOf = (def: SettingDefinition<CatalogKey>): string | null =>
	'control' in def && def.control ? def.control.key : null;

/** Draws a `render` definition the way the framework does: name and description first. */
function drawn(def: SettingDefinition): Setting {
	const setting = new Setting({});
	setting.setName(def.name);
	if (typeof def.desc === 'string') setting.setDesc(def.desc);
	(def as SettingDefinitionRender).render(setting as never, {} as never);
	return setting;
}

function buttonOf(setting: Setting, match: (button: ButtonComponent) => boolean): ButtonComponent {
	const hit = setting.components.find((component) => component instanceof ButtonComponent && match(component));
	if (!(hit instanceof ButtonComponent)) throw new Error(`"${setting.name}" has no such button`);
	return hit;
}

const header = (items: readonly SettingDefinitionItem[]): SettingDefinition => {
	const group = items[0];
	if (!group || !('type' in group) || group.type !== 'group') throw new Error('no header group');
	return (group.items ?? [])[0] as SettingDefinition;
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the agent CLI catalog’s lists', () => {
	it('lists the built-ins unverified before a probe, each with the eye', async () => {
		const settings = settingsOf();
		const { host, calls } = hostOf(settings);
		const items = new AgentCatalogSession(host).definitions();

		expect(header(items).name).toBe('Agent CLIs');
		expect(rowsOf(items).map((row) => row.name).slice(0, 2)).toEqual(['Claude Code', 'Codex']);
		expect(rowNamed(items, 'Claude Code').desc).toBe('Runs claude. Not checked yet. Default. Has the native view.');
		expect(pagesOf(items)).toEqual([]);

		const codex = drawn(rowNamed(items, 'Codex'));
		const eye = buttonOf(codex, (button) => button.tooltip === 'Hide from the menu');
		expect(eye.icon).toBe('eye');
		expect(codex.settingEl.classes.has('herdr-agent-unavailable')).toBe(false);
		await eye.click();
		expect(calls).toEqual(['write:hiddenAgents.codex=true']);
		expect(settings.hiddenAgents).toEqual(['codex']);

		// Read again, the row shows it hidden, and the eye shows it again.
		const again = new AgentCatalogSession(host).definitions();
		expect(rowNamed(again, 'Codex').desc).toContain('Hidden from the menu.');
		const shown = buttonOf(drawn(rowNamed(again, 'Codex')), (button) => button.tooltip === 'Show in the menu');
		expect(shown.icon).toBe('eye-off');
		await shown.click();
		expect(settings.hiddenAgents).toEqual([]);
	});

	it('shows only what the probe found, and a user entry as a page with its line', () => {
		const settings = settingsOf({ agentProfiles: [structuredClone(WORK_CODEX)] });
		const { host } = hostOf(settings, { probe: { found: new Set(['claude']), herdrVersion: '0.9.5' } });
		const items = new AgentCatalogSession(host).definitions();

		const names = rowsOf(items).map((row) => row.name);
		expect(names).toContain('Claude Code');
		expect(names).not.toContain('Codex');
		const [page] = pagesOf(items);
		expect(page).toMatchObject({
			type: 'page',
			id: 'user-a',
			name: 'Work codex',
			desc: 'Runs codex --profile work. Codex was not found on this machine; it may still start.',
			status: null,
		});
		expect(fieldsOf(page as Page).map((def) => def.name)).toEqual([
			'Name',
			'Agent',
			'Command',
			'Arguments',
			'Hide from the menu',
			'Where it starts',
			'Remove agent CLI',
		]);
		expect(fieldsOf(page as Page).map(keyOf)).toEqual([
			'agentProfiles.user-a.name',
			'agentProfiles.user-a.agent',
			'agentProfiles.user-a.command',
			'agentProfiles.user-a.args',
			'hiddenAgents.user-a',
			null,
			null,
		]);
	});

	it('marks a user entry the active runtime cannot start', () => {
		const settings = settingsOf({ agentProfiles: [{ ...WORK_CODEX, command: '~/bin/my-codex' }] });
		const { host } = hostOf(settings);
		const [page] = pagesOf(new AgentCatalogSession(host).definitions());
		// A command of the user's own starts on herdr-core, not on the local herdr.
		expect(page?.status).toBe('warning');
	});

	it('edits a user entry through its keys, and its page follows', async () => {
		const settings = settingsOf({ agentProfiles: [structuredClone(WORK_CODEX)] });
		const { host } = hostOf(settings);
		const session = new AgentCatalogSession(host);
		const plugin = { saveSettings: async () => undefined, refreshAgentList: () => undefined };

		expect(readCatalogSetting(settings, 'agentProfiles.user-a.args')).toBe('--profile work');
		await writeCatalogSetting(settings, 'agentProfiles.user-a.args', '--model  sonnet', plugin);
		await writeCatalogSetting(settings, 'agentProfiles.user-a.command', ' ~/bin/my-claude ', plugin);
		await writeCatalogSetting(settings, 'agentProfiles.user-a.agent', 'claude', plugin);
		await writeCatalogSetting(settings, 'agentProfiles.user-a.name', '', plugin);
		expect(settings.agentProfiles[0]).toEqual({
			id: 'user-a',
			name: '',
			agent: 'claude',
			command: '~/bin/my-claude',
			args: ['--model', 'sonnet'],
		});

		const [page] = pagesOf(session.definitions());
		expect(page?.name).toBe('~/bin/my-claude --model sonnet');
		expect(page?.id).toBe('user-a');
		expect(fieldNamed(page as Page, 'Where it starts').desc).toContain('Starts on herdr-core (hc).');
		const name = fieldNamed(page as Page, 'Name');
		expect('control' in name && name.control?.type === 'text' ? name.control.placeholder : null).toBe(
			'~/bin/my-claude --model sonnet',
		);
	});

	it('offers every agent kind, and an unknown stored one, in a user entry’s Agent', () => {
		const settings = settingsOf({ agentProfiles: [{ ...WORK_CODEX, agent: 'mystery' }] });
		const [page] = pagesOf(new AgentCatalogSession(hostOf(settings).host).definitions());
		const agent = fieldNamed(page as Page, 'Agent');
		const options = 'control' in agent && agent.control?.type === 'dropdown' ? agent.control.options : {};
		expect(options).toMatchObject({ claude: 'Claude Code', codex: 'Codex', mystery: 'mystery' });
	});

	it('adds an entry at the end with the list’s +, and saves', async () => {
		const settings = settingsOf({ agentProfiles: [structuredClone(WORK_CODEX)] });
		const { host, calls } = hostOf(settings);
		const items = new AgentCatalogSession(host).definitions();
		const list = listNamed(items, 'Your agent CLIs');
		expect(list.addItem?.name).toBe('Add agent CLI');

		list.addItem?.action({} as HTMLElement);
		await settle();
		expect(settings.agentProfiles).toHaveLength(2);
		expect(settings.agentProfiles[1]).toMatchObject({ name: '', agent: 'claude', command: '', args: [] });
		expect(settings.agentProfiles[1]?.id).toMatch(/^user-/);
		expect(calls).toEqual(['saved', 'update']);
	});

	it('removes a user entry only after asking, with its default and hidden mark', async () => {
		const settings = settingsOf({
			agentProfiles: [structuredClone(WORK_CODEX)],
			hiddenAgents: ['user-a', 'codex'],
			defaultAgents: { local: 'user-a', other: 'claude' },
		});
		let answer = false;
		const { host, calls } = hostOf(settings);
		host.confirm = async (text) => {
			calls.push(`confirm:${text.title}`);
			return answer;
		};
		const session = new AgentCatalogSession(host);
		const [page] = pagesOf(session.definitions());
		const remove = buttonOf(drawn(fieldNamed(page as Page, 'Remove agent CLI')), (button) => button.text === 'Remove');

		await remove.click();
		await settle();
		expect(settings.agentProfiles).toHaveLength(1);
		expect(calls).toEqual(['confirm:Remove "Work codex"?']);

		answer = true;
		await remove.click();
		await settle();
		expect(settings.agentProfiles).toEqual([]);
		expect(settings.hiddenAgents).toEqual(['codex']);
		expect(settings.defaultAgents).toEqual({ other: 'claude' });
		expect(calls.slice(1)).toEqual(['confirm:Remove "Work codex"?', 'saved', 'update']);

		// The open page is still found, by its id, and says what happened;
		// the list no longer shows it. Closing the settings forgets it.
		const [gone] = pagesOf(session.definitions());
		expect(gone).toMatchObject({ id: 'user-a', name: 'Work codex', visible: false });
		expect(fieldsOf(gone as Page).map((def) => def.name)).toEqual(['Removed']);
		session.end();
		expect(pagesOf(session.definitions())).toEqual([]);
	});

	it('removes a focused entry with Delete through the list, after asking', async () => {
		const settings = settingsOf({ agentProfiles: [structuredClone(WORK_CODEX)] });
		const { host, calls } = hostOf(settings);
		const list = listNamed(new AgentCatalogSession(host).definitions(), 'Your agent CLIs');
		list.onDelete?.(0);
		await settle();
		expect(settings.agentProfiles).toEqual([]);
		expect(calls[0]).toBe('confirm:Remove "Work codex"?');
	});
});

describe('the catalog’s keys', () => {
	it('knows its keys, and no others', () => {
		expect(isCatalogKey('hiddenAgents.codex')).toBe(true);
		expect(isCatalogKey('hiddenAgents.template:a.b')).toBe(true);
		expect(isCatalogKey('agentProfiles.user-a.args')).toBe(true);
		expect(isCatalogKey('agentProfiles.user-a.icon')).toBe(false);
		expect(isCatalogKey('agentProfiles')).toBe(false);
		expect(isCatalogKey('hiddenAgents.')).toBe(false);
		expect(isCatalogKey('agentListSort')).toBe(false);
	});

	it('reads a template’s hidden mark by its whole id', () => {
		const settings = settingsOf({ hiddenAgents: ['template:a.b'] });
		expect(readCatalogSetting(settings, 'hiddenAgents.template:a.b')).toBe(true);
		expect(readCatalogSetting(settings, 'hiddenAgents.template:a')).toBe(false);
	});

	it('saves, then repaints the agent lists; a gone entry writes nothing', async () => {
		const settings = settingsOf();
		const calls: string[] = [];
		const host = {
			saveSettings: async () => {
				calls.push('save');
			},
			refreshAgentList: () => calls.push('refreshAgentList'),
		};
		expect(await writeCatalogSetting(settings, 'hiddenAgents.gemini', true, host)).toBe(true);
		expect(calls).toEqual(['save', 'refreshAgentList']);
		expect(await writeCatalogSetting(settings, 'agentProfiles.user-gone.name', 'x', host)).toBe(false);
		expect(readCatalogSetting(settings, 'agentProfiles.user-gone.name')).toBeUndefined();
		expect(calls).toHaveLength(2);
	});
});

describe('the machine probes of one opening', () => {
	function machinesHarness() {
		const settings = settingsOf();
		const mac = { ...newRuntime('herdr', 'ssh', ['local']), id: 'mac', host: 'lasse@mac' };
		const xl = { ...newRuntime('herdr', 'ssh', ['local', 'mac']), id: 'xl', host: 'xl' };
		settings.runtimes = [...settings.runtimes, mac, xl];
		settings.activeRuntime = 'mac';
		const asked: string[] = [];
		const answers = new Map<string, (probe: AgentProbe) => void>();
		const machines = (): MachineProbes =>
			new MachineProbes({
				live: () => null,
				local: () => {
					asked.push('local');
					return new Promise((resolve) => answers.set('local', resolve));
				},
				ssh: (machine) => {
					asked.push(machine.host);
					return new Promise((resolve) => answers.set(machine.host, resolve));
				},
			});
		const { host, calls } = hostOf(settings, {
			probe: { found: new Set(['claude', 'codex']), herdrVersion: '0.9.5' },
			machines,
		});
		return { settings, host, calls, asked, answers, session: new AgentCatalogSession(host) };
	}

	const updates = (calls: string[]): number => calls.filter((call) => call === 'update').length;

	it('asks each machine once per opening, and draws the open page again as each answers', async () => {
		const { calls, asked, answers, session } = machinesHarness();
		// Before the page is first drawn nothing is asked, and the rows say nothing of machines.
		expect(rowNamed(session.definitions(), 'Codex').desc).toBe('Runs codex. Found on lasse@mac.');
		expect(asked).toEqual([]);

		drawn(header(session.definitions()));
		expect(asked).toEqual(['local', 'lasse@mac', 'xl']);
		await settle();
		expect(updates(calls)).toBe(1);
		expect(rowNamed(session.definitions(), 'Codex').desc).toBe('Runs codex. Checking this machine, lasse@mac and xl…');

		// Drawing again (the update) asks nothing new and draws nothing more.
		drawn(header(session.definitions()));
		await settle();
		expect(asked).toHaveLength(3);
		expect(updates(calls)).toBe(1);

		answers.get('lasse@mac')?.({ found: new Set(['claude', 'codex']) });
		answers.get('local')?.({ found: new Set(['claude']) });
		answers.get('xl')?.({ found: null, error: 'ssh xl did not answer' });
		await settle();
		expect(updates(calls)).toBe(4);
		const items = session.definitions();
		expect(rowNamed(items, 'Codex').desc).toBe('Runs codex. Found on lasse@mac. Not found on this machine.');
		expect(rowNamed(items, 'Claude Code').desc).toBe(
			'Runs claude. Found on this machine and lasse@mac. Default. Has the native view.',
		);
		expect(header(items).desc).toContain('Could not check xl: ssh xl did not answer.');

		// Check again asks every machine once more, and shows them checking at once.
		const before = updates(calls);
		await buttonOf(drawn(header(items)), (button) => button.text === 'Check again').click();
		expect(asked).toEqual(['local', 'lasse@mac', 'xl', 'local', 'lasse@mac', 'xl']);
		expect(updates(calls)).toBe(before + 1);
	});

	it('stops drawing when the settings close, and asks again on the next opening', async () => {
		const { calls, asked, answers, session } = machinesHarness();
		drawn(header(session.definitions()));
		await settle();
		const before = updates(calls);
		session.end();
		answers.get('local')?.({ found: new Set(['claude']) });
		await settle();
		expect(updates(calls)).toBe(before);

		drawn(header(session.definitions()));
		expect(asked).toEqual(['local', 'lasse@mac', 'xl', 'local', 'lasse@mac', 'xl']);
	});

	it('lists a built-in only another machine has, greyed', async () => {
		const { answers, session } = machinesHarness();
		drawn(header(session.definitions()));
		answers.get('local')?.({ found: new Set(['claude', 'gemini']) });
		answers.get('lasse@mac')?.({ found: new Set(['claude']) });
		answers.get('xl')?.({ found: new Set([]) });
		await settle();
		const gemini = rowNamed(session.definitions(), 'Gemini');
		expect(gemini.desc).toBe(
			'Runs gemini. Found on this machine. Not found on lasse@mac and xl. Not in the menu on herdr on lasse@mac.',
		);
		expect(drawn(gemini).settingEl.classes.has('herdr-agent-unavailable')).toBe(true);
	});

	it('asks for the active runtime’s probe on each drawing, and draws again once it landed', async () => {
		const settings = settingsOf();
		const asked: string[] = [];
		let landed = true;
		const { host, calls } = hostOf(settings, {
			refresh: (runtimeId) => {
				asked.push(runtimeId);
				return Promise.resolve(landed);
			},
		});
		// No machines but this one, which never answers here.
		const session = new AgentCatalogSession(host);
		drawn(header(session.definitions()));
		await settle();
		expect(asked).toEqual([settings.activeRuntime]);
		const after = updates(calls);
		expect(after).toBe(2);

		landed = false;
		drawn(header(session.definitions()));
		await settle();
		expect(asked).toHaveLength(2);
		expect(updates(calls)).toBe(after);
	});
});

describe('the tab', () => {
	it('reads and writes catalog keys, and reads the definitions again', async () => {
		const settings = settingsOf({ agentProfiles: [structuredClone(WORK_CODEX)] });
		const calls: string[] = [];
		const plugin = {
			settings,
			saveSettings: async () => {
				calls.push('save');
			},
			refreshAgentList: () => calls.push('refreshAgentList'),
			agentCatalogs: { cachedProbeFor: () => null, refresh: async () => false },
			nativeReachable: () => true,
		};
		const tab = new HerdrSettingTab({} as never, plugin as unknown as HerdrPlugin, () => undefined);
		const updatesOf = (): number => (tab as unknown as { updates: number }).updates;

		expect(tab.getControlValue('agentProfiles.user-a.args')).toBe('--profile work');
		expect(tab.getControlValue('hiddenAgents.user-a')).toBe(false);
		await tab.setControlValue('hiddenAgents.user-a', true);
		await tab.setControlValue('agentProfiles.user-a.command', 'codex-wrapper');
		expect(settings.hiddenAgents).toEqual(['user-a']);
		expect(settings.agentProfiles[0]?.command).toBe('codex-wrapper');
		expect(calls).toEqual(['save', 'refreshAgentList', 'save', 'refreshAgentList']);
		expect(updatesOf()).toBe(2);

		// A key of an entry that is gone changes and draws nothing.
		await tab.setControlValue('agentProfiles.user-gone.name', 'x');
		expect(updatesOf()).toBe(2);
	});
});
