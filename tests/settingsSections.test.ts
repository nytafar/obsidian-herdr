/**
 * The part of the settings tab still drawn by its 0.7.1 builder: the agent
 * CLI catalog (until #179). The tab draws it inside a `render` definition
 * (`settingsTab/lists.ts`); the plain settings and the runtime list (#178)
 * are definitions, covered by `settingsDefinitions.test.ts`.
 *
 * A builder is a plain function over a container, the settings and a bundle
 * of callbacks: the `Setting` fixture records what it renders and hands back
 * the change handler of any control, and the bundle records which callbacks
 * run in which order.
 */

import { describe, expect, it } from 'vitest';
import {
	ButtonComponent,
	DropdownComponent,
	settingNamed,
	settingNames,
	settingsContainer,
	TextComponent,
} from './fixtures/obsidian';
import { DEFAULT_SETTINGS, type HerdrSettings } from '../src/settings';
import type { ListCallbacks } from '../src/settingsTab/lists';
import { buildAgentCatalogSettings, buildDefaultAgentSetting } from '../src/agents/settingsSection';
import { newRuntime } from '../src/runtimes';
import type { AgentProbe } from '../src/agents/catalog';
import { MachineProbes } from '../src/agents/machines';

/** A fresh, mutable copy of the defaults plus whatever a case overrides. */
function settingsOf(overrides: Partial<HerdrSettings> = {}): HerdrSettings {
	return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

/** A callback bundle that records the calls, in order, as strings. */
function recorder(
	options: { confirm?: boolean } = {},
): { calls: string[]; callbacks: ListCallbacks } {
	const calls: string[] = [];
	const callbacks: ListCallbacks = {
		confirm: async () => {
			calls.push('confirm');
			return options.confirm ?? true;
		},
		save: async () => {
			calls.push('save');
		},
		redisplay: () => {
			calls.push('redisplay');
		},
		refreshAgentList: () => {
			calls.push('refreshAgentList');
		},
	};
	return { calls, callbacks };
}

function control<T>(
	container: unknown,
	name: string,
	kind: new (...args: never[]) => T,
	label: string,
): T {
	const component = settingNamed(container, name).control();
	if (!(component instanceof kind)) throw new Error(`"${name}" is not a ${label}`);
	return component;
}

const textOf = (container: unknown, name: string): TextComponent =>
	control(container, name, TextComponent, 'text field');
const dropdownOf = (container: unknown, name: string): DropdownComponent =>
	control(container, name, DropdownComponent, 'dropdown');

/** The extra button with this tooltip on the row named `name`. */
function rowButton(container: unknown, name: string, tooltip: string): ButtonComponent {
	const hit = settingNamed(container, name).components.find(
		(component) => component instanceof ButtonComponent && component.tooltip === tooltip,
	);
	if (!(hit instanceof ButtonComponent)) throw new Error(`"${name}" has no "${tooltip}" button`);
	return hit;
}

describe('agent CLI catalog (until #179)', () => {
	it('lists the active runtime’s agent CLIs, unverified before a probe, and the add button', () => {
		const el = settingsContainer();
		buildAgentCatalogSettings(el, settingsOf(), recorder().callbacks);

		const names = settingNames(el);
		expect(names.slice(0, 3)).toEqual(['Agent CLIs', 'Claude Code', 'Codex']);
		expect(names).toContain('Add agent CLI');
		expect(settingNamed(el, 'Claude Code').desc).toBe('Runs claude. Not checked yet. Default. Has the native view.');
		expect(rowButton(el, 'Codex', 'Hide from the menu').icon).toBe('eye');
	});

	it('shows only what the probe found, and a user entry it did not find with the reason', () => {
		const settings = settingsOf({
			agentProfiles: [{ id: 'user-a', name: 'Work codex', agent: 'codex', command: '', args: ['--profile', 'work'] }],
		});
		const { callbacks } = recorder();
		callbacks.agents = {
			probe: () => ({ found: new Set(['claude']), herdrVersion: '0.9.5' }),
			refresh: async () => false,
			editing: () => null,
			edit: () => undefined,
		};
		const el = settingsContainer();
		buildAgentCatalogSettings(el, settings, callbacks);

		const names = settingNames(el);
		expect(names).toContain('Claude Code');
		expect(names).not.toContain('Codex');
		expect(settingNamed(el, 'Work codex').desc).toBe(
			'Runs codex --profile work. Codex was not found on this machine; it may still start.',
		);
	});

	it('asks for a probe of the active runtime once per drawing, and draws again only when one landed', async () => {
		const asked: string[] = [];
		let landed = true;
		const { calls, callbacks } = recorder();
		callbacks.agents = {
			probe: () => null,
			refresh: (runtimeId) => {
				asked.push(runtimeId);
				return Promise.resolve(landed);
			},
			editing: () => null,
			edit: () => undefined,
		};
		const settings = settingsOf();
		buildAgentCatalogSettings(settingsContainer(), settings, callbacks);
		await Promise.resolve();
		await Promise.resolve();
		expect(asked).toEqual([settings.activeRuntime]);
		expect(calls.filter((call) => call === 'redisplay')).toHaveLength(1);

		// Nothing new (up to date, or another runtime's connection): no redraw, no loop.
		landed = false;
		buildAgentCatalogSettings(settingsContainer(), settings, callbacks);
		await Promise.resolve();
		await Promise.resolve();
		expect(asked).toHaveLength(2);
		expect(calls.filter((call) => call === 'redisplay')).toHaveLength(1);
	});

	it('probes each machine of every runtime once per opening, and updates rows in place as each lands', async () => {
		const settings = settingsOf();
		const mac = { ...newRuntime('herdr', 'ssh', ['local']), id: 'mac', host: 'lasse@mac' };
		const macHc = { ...newRuntime('herdr-core', 'ssh', ['local', 'mac']), id: 'mac-hc', host: 'lasse@mac' };
		const xl = { ...newRuntime('herdr', 'ssh', ['local', 'mac', 'mac-hc']), id: 'xl', host: 'xl' };
		settings.runtimes = [...settings.runtimes, mac, macHc, xl];
		settings.activeRuntime = 'mac';

		const asked: string[] = [];
		const answers = new Map<string, (probe: AgentProbe) => void>();
		const probes = new MachineProbes({
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
		const { calls, callbacks } = recorder();
		callbacks.agents = {
			probe: () => ({ found: new Set(['claude', 'codex']), herdrVersion: '0.9.5' }),
			refresh: async () => false,
			editing: () => null,
			edit: () => undefined,
			machines: () => probes,
		};
		const el = settingsContainer();
		buildAgentCatalogSettings(el, settings, callbacks);
		buildAgentCatalogSettings(settingsContainer(), settings, callbacks);
		expect(asked).toEqual(['local', 'lasse@mac', 'xl']);
		expect(settingNamed(el, 'Codex').desc).toBe('Runs codex. Checking this machine, lasse@mac and xl…');

		// A drawing after the first is the current one: draw it again to follow it.
		const current = settingsContainer();
		buildAgentCatalogSettings(current, settings, callbacks);
		answers.get('lasse@mac')?.({ found: new Set(['claude', 'codex']) });
		answers.get('local')?.({ found: new Set(['claude']) });
		answers.get('xl')?.({ found: null, error: 'ssh xl did not answer' });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(asked).toHaveLength(3);
		expect(calls).not.toContain('redisplay');
		expect(settingNamed(current, 'Codex').desc).toBe('Runs codex. Found on lasse@mac. Not found on this machine.');
		expect(settingNamed(current, 'Claude Code').desc).toBe(
			'Runs claude. Found on this machine and lasse@mac. Default. Has the native view.',
		);
		expect(settingNamed(current, 'Agent CLIs').desc).toContain('Could not check xl: ssh xl did not answer.');
		expect(settingNamed(el, 'Codex').desc).toBe('Runs codex. Checking this machine, lasse@mac and xl…');

		// Check again asks every machine once more.
		await control(current, 'Agent CLIs', ButtonComponent, 'button').click();
		expect(asked).toEqual(['local', 'lasse@mac', 'xl', 'local', 'lasse@mac', 'xl']);
	});

	it('lists a built-in only another machine has, greyed, drawing the tab again once it is known', async () => {
		const settings = settingsOf();
		settings.runtimes = [...settings.runtimes, { ...newRuntime('herdr', 'ssh', ['local']), id: 'mac', host: 'lasse@mac' }];
		settings.activeRuntime = 'mac';
		const probes = new MachineProbes({
			live: () => null,
			local: async () => ({ found: new Set(['claude', 'gemini']) }),
			ssh: async () => ({ found: new Set(['claude']) }),
		});
		const { calls, callbacks } = recorder();
		callbacks.agents = {
			probe: () => ({ found: new Set(['claude']), herdrVersion: '0.9.5' }),
			refresh: async () => false,
			editing: () => null,
			edit: () => undefined,
			machines: () => probes,
		};
		buildAgentCatalogSettings(settingsContainer(), settings, callbacks);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls.filter((call) => call === 'redisplay')).toHaveLength(1);

		const el = settingsContainer();
		buildAgentCatalogSettings(el, settings, callbacks);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls.filter((call) => call === 'redisplay')).toHaveLength(1);
		const gemini = settingNamed(el, 'Gemini');
		expect(gemini.desc).toBe('Runs gemini. Found on this machine. Not found on lasse@mac. Not in the menu on herdr on lasse@mac.');
		expect(gemini.classes).toContain('herdr-agent-unavailable');
	});

	it('hides an entry from the menu, and adds a user entry with its form open', async () => {
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		let editing: string | null = null;
		callbacks.agents = {
			probe: () => ({ found: new Set(['claude', 'codex']), herdrVersion: '0.9.5' }),
			refresh: async () => false,
			editing: () => editing,
			edit: (id) => {
				editing = id;
				calls.push(`editAgent:${id}`);
			},
		};
		const el = settingsContainer();
		buildAgentCatalogSettings(el, settings, callbacks);

		await rowButton(el, 'Codex', 'Hide from the menu').click();
		expect(settings.hiddenAgents).toEqual(['codex']);
		await control(el, 'Add agent CLI', ButtonComponent, 'button').click();
		expect(settings.agentProfiles).toHaveLength(1);
		expect(calls).toEqual(['save', 'refreshAgentList', 'redisplay', 'save', 'refreshAgentList', `editAgent:${editing}`]);

		const form = settingsContainer();
		buildAgentCatalogSettings(form, settings, callbacks);
		await textOf(form, 'Arguments').change('--model  sonnet');
		await textOf(form, 'Command').change('~/bin/my-claude');
		expect(settings.agentProfiles[0]).toMatchObject({ command: '~/bin/my-claude', args: ['--model', 'sonnet'] });
		expect(settingNamed(form, 'Where it starts').desc).toContain('Starts on herdr-core (hc).');
	});

	it('sets a runtime’s default in its form, and clears it with first installed', async () => {
		const settings = settingsOf();
		const { callbacks } = recorder();
		const el = settingsContainer();
		buildDefaultAgentSetting(el, settings.runtimes[0]!, settings, callbacks);

		const dropdown = dropdownOf(el, 'Default agent');
		expect(dropdown.optionValues().slice(0, 3)).toEqual(['', 'claude', 'codex']);
		await dropdown.change('codex');
		expect(settings.defaultAgents).toEqual({ local: 'codex' });
		await dropdown.change('');
		expect(settings.defaultAgents).toEqual({});
	});

});
