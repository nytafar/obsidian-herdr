/**
 * The part of the settings tab still drawn by its 0.7.1 builder: the runtime
 * list (until #178). The tab draws it inside a `render` definition
 * (`settingsTab/lists.ts`); the plain settings are definitions, covered by
 * `settingsDefinitions.test.ts`, and the agent CLI catalog's lists by
 * `agentCatalogSettings.test.ts`.
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
import { buildRuntimesSection } from '../src/settingsTab/runtimeList';
import type { ListCallbacks } from '../src/settingsTab/lists';
import { defaultLocalRuntime, newRuntime } from '../src/runtimes';

/** A fresh, mutable copy of the defaults plus whatever a case overrides. */
function settingsOf(overrides: Partial<HerdrSettings> = {}): HerdrSettings {
	return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

/** A callback bundle that records the calls, in order, as strings. */
function recorder(
	options: { editing?: string | null; confirm?: boolean; unavailable?: string } = {},
): { calls: string[]; callbacks: ListCallbacks } {
	const calls: string[] = [];
	let editing = options.editing ?? null;
	const callbacks: ListCallbacks = {
		activateRuntime: async (id) => {
			calls.push(`activateRuntime:${id}`);
		},
		refreshRuntimes: () => {
			calls.push('refreshRuntimes');
		},
		kindUnavailable: (kind) =>
			kind === 'herdr-core' ? (options.unavailable ?? 'herdr-core is not here yet') : null,
		editingRuntime: () => editing,
		editRuntime: (id) => {
			editing = id;
			calls.push(`editRuntime:${id}`);
		},
		confirm: async () => {
			calls.push('confirm');
			return options.confirm ?? true;
		},
		save: async () => {
			calls.push('save');
		},
		saveAndReconnect: async () => {
			calls.push('saveAndReconnect');
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

/** The remote a pre-registry profile migrated to, beside the local herdr. */
function twoRuntimes(): HerdrSettings {
	return settingsOf({
		runtimes: [
			defaultLocalRuntime(),
			{
				...newRuntime('herdr', 'ssh', [], () => 0.5),
				id: 'ssh:lasse@xl:~/.config/herdr/herdr.sock',
				name: 'xl',
				host: 'lasse@xl',
			},
		],
		activeRuntime: 'local',
		pinnedPanes: { 'ssh:lasse@xl:~/.config/herdr/herdr.sock': ['w4:p1'], local: ['w1:p1'] },
	});
}

/** The extra button with this tooltip on the row named `name`. */
function rowButton(container: unknown, name: string, tooltip: string): ButtonComponent {
	const hit = settingNamed(container, name).components.find(
		(component) => component instanceof ButtonComponent && component.tooltip === tooltip,
	);
	if (!(hit instanceof ButtonComponent)) throw new Error(`"${name}" has no "${tooltip}" button`);
	return hit;
}

describe('runtime list (ADR-0004, until #178)', () => {
	it('lists every runtime with what it is, and the add button', () => {
		const el = settingsContainer();
		buildRuntimesSection(el, twoRuntimes(), recorder().callbacks);

		expect(settingNames(el)).toEqual(['Local', 'xl', 'Add runtime']);
		expect(settingNamed(el, 'Local').desc).toBe('Herdr on this machine. Active.');
		expect(settingNamed(el, 'xl').desc).toBe('Herdr over SSH to lasse@xl.');
		expect(settingNamed(el, 'Local').classes).toContain('herdr-runtime-active');
	});

	it('says when a runtime’s kind is not available in this build', () => {
		const settings = twoRuntimes();
		settings.runtimes.push({ ...newRuntime('herdr-core', 'local', []), name: 'Core' });
		const el = settingsContainer();
		buildRuntimesSection(el, settings, recorder({ unavailable: 'not in this build yet' }).callbacks);

		expect(settingNamed(el, 'Core').desc).toBe(
			'Herdr-core (hc) on this machine. Not in this build yet.',
		);
	});

	it('switches to a runtime from its row', async () => {
		const el = settingsContainer();
		const { calls, callbacks } = recorder();
		buildRuntimesSection(el, twoRuntimes(), callbacks);

		await rowButton(el, 'xl', 'Use this runtime').click();
		expect(calls).toEqual(['activateRuntime:ssh:lasse@xl:~/.config/herdr/herdr.sock', 'redisplay']);
	});

	it('never removes the last runtime', () => {
		const el = settingsContainer();
		buildRuntimesSection(el, settingsOf(), recorder().callbacks);
		expect(rowButton(el, 'Local', 'The last runtime cannot be removed').disabled).toBe(true);
	});

	it('removes a runtime and its pins after asking, and reconnects when it was active', async () => {
		const settings = twoRuntimes();
		settings.activeRuntime = 'ssh:lasse@xl:~/.config/herdr/herdr.sock';
		const el = settingsContainer();
		const { calls, callbacks } = recorder();
		buildRuntimesSection(el, settings, callbacks);

		await rowButton(el, 'xl', 'Remove runtime').click();

		expect(settings.runtimes.map((runtime) => runtime.id)).toEqual(['local']);
		expect(settings.pinnedPanes).toEqual({ local: ['w1:p1'] });
		expect(calls).toEqual(['confirm', 'activateRuntime:local', 'refreshRuntimes', 'redisplay']);
	});

	it('keeps a runtime when the removal is not confirmed', async () => {
		const settings = twoRuntimes();
		const el = settingsContainer();
		const { calls, callbacks } = recorder({ confirm: false });
		buildRuntimesSection(el, settings, callbacks);

		await rowButton(el, 'xl', 'Remove runtime').click();
		expect(settings.runtimes).toHaveLength(2);
		expect(calls).toEqual(['confirm']);
	});

	it('adds an SSH herdr runtime with a fresh id and opens its form', async () => {
		const settings = settingsOf();
		const el = settingsContainer();
		const { calls, callbacks } = recorder();
		buildRuntimesSection(el, settings, callbacks);

		const add = settingNamed(el, 'Add runtime').control() as ButtonComponent;
		await add.click();

		const added = settings.runtimes[1];
		expect(added).toMatchObject({ kind: 'herdr', target: 'ssh', name: '' });
		expect(added?.id).toMatch(/^rt-/);
		expect(calls).toEqual(['save', 'refreshRuntimes', `editRuntime:${added?.id}`]);
	});

	it('shows the fields of an SSH herdr runtime under the list while it is edited', () => {
		const settings = twoRuntimes();
		const el = settingsContainer();
		buildRuntimesSection(
			el,
			settings,
			recorder({ editing: 'ssh:lasse@xl:~/.config/herdr/herdr.sock' }).callbacks,
		);

		expect(settingNames(el).slice(3)).toEqual([
			'Edit xl',
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
			'',
		]);
		// Carried over from the remote section: a missing vault path is named.
		expect(settingNamed(el, 'Problems').desc).toBe(
			'The runtime has no remote vault path, so folder paths cannot be resolved on the remote host.',
		);
		expect(settingNamed(el, 'Problems').descEl.classes.has('mod-warning')).toBe(true);
	});

	it('shows the local herdr’s socket, binary override and workspace', () => {
		const el = settingsContainer();
		buildRuntimesSection(el, settingsOf(), recorder({ editing: 'local' }).callbacks);

		expect(settingNames(el).slice(2)).toEqual([
			'Edit Local',
			'Name',
			'Kind',
			'Target',
			'Socket path',
			'Herdr binary',
			'Workspace ID',
			'Default agent',
			'Problems',
			'',
		]);
		expect(textOf(el, 'Herdr binary').placeholder).toBe('Auto-discover');
		expect(settingNamed(el, 'Problems').desc).toBe('None.');
	});

	it('asks a herdr-core runtime for neither socket nor herdr binary, and says it is unavailable', () => {
		const settings = settingsOf();
		const core = { ...newRuntime('herdr-core', 'ssh', []), name: 'Asher' };
		settings.runtimes.push(core);
		const el = settingsContainer();
		buildRuntimesSection(el, settings, recorder({ editing: core.id, unavailable: 'not yet' }).callbacks);

		expect(settingNames(el)).toContain('Remote hc binary');
		expect(settingNames(el)).toContain('Space');
		expect(settingNames(el)).not.toContain('Remote socket path');
		expect(settingNamed(el, 'Problems').desc).toBe(
			'Not yet. The runtime has no SSH host. The runtime has no remote vault path, so folder paths cannot be resolved on the remote host.',
		);
	});

	it('shows the Claude session hook on the active herdr-core runtime only, and opens its review', async () => {
		const settings = settingsOf();
		const core = { ...newRuntime('herdr-core', 'local', []), name: 'Core' };
		settings.runtimes.push(core);
		const { calls, callbacks } = recorder({ editing: core.id, unavailable: '' });
		callbacks.kindUnavailable = () => null;
		callbacks.sessionHook = {
			status: () => Promise.resolve({ text: 'Outdated: version 0 is installed.', warning: true }),
			review: (onDone) => {
				calls.push('review');
				onDone();
			},
		};

		// Not the active runtime: nothing to act over, so the button is off.
		const inactive = settingsContainer();
		buildRuntimesSection(inactive, settings, callbacks);
		const off = settingNamed(inactive, 'Claude session hook');
		expect(off.desc).toMatch(/Use this runtime to see or change it/);
		expect((off.control() as ButtonComponent).disabled).toBe(true);

		settings.activeRuntime = core.id;
		const el = settingsContainer();
		buildRuntimesSection(el, settings, callbacks);
		const row = settingNamed(el, 'Claude session hook');
		expect(row.desc).toMatch(/Checking/);
		await Promise.resolve();
		expect(row.desc).toBe('Lets the native view follow Claude in this runtime’s terminals. Outdated: version 0 is installed.');
		expect(row.descEl.classes.has('mod-warning')).toBe(true);
		const button = row.control() as ButtonComponent;
		expect(button.disabled).toBe(false);
		await button.clickHandler?.();
		expect(calls).toEqual(['review', 'redisplay']);

		// A herdr runtime has no such row.
		const herdr = settingsContainer();
		buildRuntimesSection(herdr, settingsOf(), recorder({ editing: 'local' }).callbacks);
		expect(settingNames(herdr)).not.toContain('Claude session hook');
	});

	it('reconnects for a field of the active runtime, and only saves for another', async () => {
		const settings = twoRuntimes();
		const xl = 'ssh:lasse@xl:~/.config/herdr/herdr.sock';
		const active = settingsContainer();
		const onActive = recorder({ editing: 'local' });
		buildRuntimesSection(active, settings, onActive.callbacks);
		await textOf(active, 'Workspace ID').change('w7');
		expect(settings.runtimes[0]?.workspace).toBe('w7');
		expect(onActive.calls).toEqual(['saveAndReconnect']);

		const other = settingsContainer();
		const onOther = recorder({ editing: xl });
		buildRuntimesSection(other, settings, onOther.callbacks);
		await textOf(other, 'Remote vault path').change('/home/lasse/hvelv');
		expect(settings.runtimes[1]?.remoteVaultPath).toBe('/home/lasse/hvelv');
		expect(onOther.calls).toEqual(['save']);
		// The problem the form named is gone as soon as the field holds a value.
		expect(settingNamed(other, 'Problems').desc).toBe('None.');
		expect(settingNamed(other, 'Problems').descEl.classes.has('mod-warning')).toBe(false);
		// The id never follows an edit: tabs and pins keep naming this runtime.
		await textOf(other, 'SSH host').change('lasse@xl2');
		expect(settings.runtimes[1]?.id).toBe(xl);
	});

	it('renames without reconnecting, and retitles the switcher', async () => {
		const settings = settingsOf();
		const el = settingsContainer();
		const { calls, callbacks } = recorder({ editing: 'local' });
		buildRuntimesSection(el, settings, callbacks);

		await textOf(el, 'Name').change('Laptop');
		expect(settings.runtimes[0]?.name).toBe('Laptop');
		expect(calls).toEqual(['save', 'refreshRuntimes']);
	});

	it('keeps the binary a search across a target change, and redisplays', async () => {
		const settings = settingsOf();
		const el = settingsContainer();
		const { calls, callbacks } = recorder({ editing: 'local' });
		buildRuntimesSection(el, settings, callbacks);

		await dropdownOf(el, 'Target').change('ssh');
		// Empty: an SSH herdr runtime searches the remote host for herdr.
		expect(settings.runtimes[0]).toMatchObject({ target: 'ssh', binary: '' });
		expect(calls).toEqual(['saveAndReconnect', 'refreshRuntimes', 'redisplay']);

		await dropdownOf(el, 'Kind').change('herdr-core');
		expect(settings.runtimes[0]).toMatchObject({ kind: 'herdr-core', binary: '', socketPath: '' });
	});
});

describe('a runtime’s default agent (until #178)', () => {
	it('sets a runtime’s default in its form, and clears it with first installed', async () => {
		const settings = settingsOf();
		const { callbacks } = recorder({ editing: 'local' });
		const el = settingsContainer();
		buildRuntimesSection(el, settings, callbacks);

		const dropdown = dropdownOf(el, 'Default agent');
		expect(dropdown.optionValues().slice(0, 3)).toEqual(['', 'claude', 'codex']);
		await dropdown.change('codex');
		expect(settings.defaultAgents).toEqual({ local: 'codex' });
		await dropdown.change('');
		expect(settings.defaultAgents).toEqual({});
	});

});
