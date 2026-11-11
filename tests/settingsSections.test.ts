/**
 * The one 0.7.1 builder left in the settings tab: a runtime's default agent
 * (issue #125), which the runtime page (#178) draws into a `render` row. The
 * plain settings are covered by `settingsDefinitions.test.ts`, the runtime
 * list and its pages by `settingsRuntimes.test.ts`, and the agent CLI
 * catalog's lists by `agentCatalogSettings.test.ts`.
 *
 * The builder is a plain function over a container, the settings and a
 * bundle of callbacks: the `Setting` fixture records what it renders and
 * hands back the change handler of any control, and the bundle records which
 * callbacks run in which order.
 */

import { describe, expect, it } from 'vitest';
import { DropdownComponent, settingNamed, settingsContainer } from './fixtures/obsidian';
import { DEFAULT_SETTINGS, type HerdrSettings } from '../src/settings';
import type { ListCallbacks } from '../src/settingsTab/lists';
import { buildDefaultAgentSetting } from '../src/agents/settingsSection';

/** A fresh, mutable copy of the defaults plus whatever a case overrides. */
function settingsOf(overrides: Partial<HerdrSettings> = {}): HerdrSettings {
	return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

/** A callback bundle that records the calls, in order, as strings. */
function recorder(): { calls: string[]; callbacks: ListCallbacks } {
	const calls: string[] = [];
	const callbacks: ListCallbacks = {
		save: async () => {
			calls.push('save');
		},
		refreshAgentList: () => {
			calls.push('refreshAgentList');
		},
	};
	return { calls, callbacks };
}

function dropdownOf(container: unknown, name: string): DropdownComponent {
	const component = settingNamed(container, name).control();
	if (!(component instanceof DropdownComponent)) throw new Error(`"${name}" is not a dropdown`);
	return component;
}

describe('a runtime’s default agent', () => {
	it('sets a runtime’s default on its page, and clears it with first installed', async () => {
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		const el = settingsContainer();
		buildDefaultAgentSetting(el, settings.runtimes[0]!, settings, callbacks);

		const dropdown = dropdownOf(el, 'Default agent');
		expect(dropdown.optionValues().slice(0, 3)).toEqual(['', 'claude', 'codex']);
		await dropdown.change('codex');
		expect(settings.defaultAgents).toEqual({ local: 'codex' });
		await dropdown.change('');
		expect(settings.defaultAgents).toEqual({});
		expect(calls).toEqual(['save', 'refreshAgentList', 'save', 'refreshAgentList']);
	});
});
