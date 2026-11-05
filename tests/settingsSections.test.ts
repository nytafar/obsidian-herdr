/**
 * The settings tab, section by section (issue #85).
 *
 * Each section is a plain function over a container, the settings and a bundle
 * of callbacks, so the whole tab is testable without Obsidian: the `Setting`
 * fixture records what a section renders and hands back the change handler of
 * any control. What is asserted per section is the widgets it puts up, what a
 * change writes into the settings, and which callbacks it calls in which order
 * — the difference between save, save-and-reconnect, a redisplay and a refresh
 * is the thing a split like this can quietly get wrong.
 */

import { describe, expect, it } from 'vitest';
import {
	ButtonComponent,
	builtSettings,
	DropdownComponent,
	settingNamed,
	settingNames,
	settingsContainer,
	SliderComponent,
	TextComponent,
	ToggleComponent,
} from './fixtures/obsidian';
import {
	AGENT_KINDS,
	buildAgentListSection,
	buildAgentsSection,
	buildConnectionSection,
	buildFileExplorerSection,
	buildNativeViewSection,
	buildNotificationsSection,
	buildRuntimesSection,
	buildTerminalSection,
	DEFAULT_SETTINGS,
	MAX_PANES_PER_TAB,
	MAX_SCROLLBACK_MB,
	MIN_PANES_PER_TAB,
	MIN_SCROLLBACK_MB,
	SETTINGS_SECTIONS,
	type HerdrSettings,
	type SettingsCallbacks,
} from '../src/settings';
import { defaultLocalRuntime, newRuntime } from '../src/runtimes';

/** A fresh, mutable copy of the defaults plus whatever a case overrides. */
function settingsOf(overrides: Partial<HerdrSettings> = {}): HerdrSettings {
	return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

/** A callback bundle that records the calls, in order, as strings. */
function recorder(
	options: { editing?: string | null; confirm?: boolean; unavailable?: string } = {},
): { calls: string[]; callbacks: SettingsCallbacks } {
	const calls: string[] = [];
	let editing = options.editing ?? null;
	const callbacks: SettingsCallbacks = {
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
		refreshFolderHoverButton: () => {
			calls.push('refreshFolderHoverButton');
		},
		applyTerminalSetting: (setting) => {
			calls.push(`applyTerminalSetting:${setting}`);
		},
		refreshNativeViews: () => {
			calls.push('refreshNativeViews');
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

const toggleOf = (container: unknown, name: string): ToggleComponent =>
	control(container, name, ToggleComponent, 'toggle');
const textOf = (container: unknown, name: string): TextComponent =>
	control(container, name, TextComponent, 'text field');
const dropdownOf = (container: unknown, name: string): DropdownComponent =>
	control(container, name, DropdownComponent, 'dropdown');
const sliderOf = (container: unknown, name: string): SliderComponent =>
	control(container, name, SliderComponent, 'slider');

/** The name of every heading row, in order. */
function headings(container: unknown): string[] {
	return builtSettings(container)
		.filter((setting) => setting.heading)
		.map((setting) => setting.name);
}

describe('connection section', () => {
	it('keeps the one field every runtime on this machine shares', () => {
		const el = settingsContainer();
		buildConnectionSection(el, settingsOf(), recorder().callbacks);

		expect(settingNames(el)).toEqual(['Connection', 'Extra PATH entries']);
		expect(headings(el)).toEqual(['Connection']);
	});

	it('saves and reconnects, since spawns read it', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildConnectionSection(el, settings, callbacks);

		await textOf(el, 'Extra PATH entries').change('/opt/bin');

		expect(settings.extraPath).toBe('/opt/bin');
		expect(calls).toEqual(['saveAndReconnect']);
	});
});

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

describe('runtimes section (ADR-0004)', () => {
	it('lists every runtime with what it is, and the add button', () => {
		const el = settingsContainer();
		buildRuntimesSection(el, twoRuntimes(), recorder().callbacks);

		expect(settingNames(el)).toEqual(['Runtimes', 'Local', 'xl', 'Add runtime']);
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

		expect(settingNames(el).slice(4)).toEqual([
			'Edit xl',
			'Name',
			'Kind',
			'Target',
			'SSH host',
			'Remote socket path',
			'Remote herdr binary',
			'Remote vault path',
			'Workspace ID',
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

		expect(settingNames(el).slice(3)).toEqual([
			'Edit Local',
			'Name',
			'Kind',
			'Target',
			'Socket path',
			'Herdr binary',
			'Workspace ID',
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

	it('moves the binary default along with the target, and redisplays', async () => {
		const settings = settingsOf();
		const el = settingsContainer();
		const { calls, callbacks } = recorder({ editing: 'local' });
		buildRuntimesSection(el, settings, callbacks);

		await dropdownOf(el, 'Target').change('ssh');
		expect(settings.runtimes[0]).toMatchObject({ target: 'ssh', binary: '~/.local/bin/herdr' });
		expect(calls).toEqual(['saveAndReconnect', 'refreshRuntimes', 'redisplay']);

		await dropdownOf(el, 'Kind').change('herdr-core');
		expect(settings.runtimes[0]).toMatchObject({ kind: 'herdr-core', binary: '', socketPath: '' });
	});
});

describe('notifications section', () => {
	it('renders the status bar toggle and both transitions', () => {
		const el = settingsContainer();
		buildNotificationsSection(el, settingsOf(), recorder().callbacks);

		expect(settingNames(el)).toEqual([
			'Notifications',
			'Status bar counts',
			'Blocked: notice',
			'Blocked: system notification',
			'Done: notice',
			'Done: system notification',
		]);
		// The defaults the toggles were built from, per transition.
		expect(toggleOf(el, 'Done: notice').value).toBe(true);
		expect(toggleOf(el, 'Done: system notification').value).toBe(false);
	});

	it('writes into the transition it belongs to and only saves', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildNotificationsSection(el, settings, callbacks);

		await toggleOf(el, 'Blocked: notice').change(false);
		await toggleOf(el, 'Done: system notification').change(true);
		await toggleOf(el, 'Status bar counts').change(false);

		expect(settings.notifications.blocked).toEqual({ notice: false, os: true });
		expect(settings.notifications.done).toEqual({ notice: true, os: true });
		expect(settings.notifications.statusBar).toBe(false);
		expect(calls).toEqual(['save', 'save', 'save']);
	});
});

describe('agents section', () => {
	it('offers every agent kind herdr can start', () => {
		const el = settingsContainer();
		buildAgentsSection(el, settingsOf(), recorder().callbacks);

		expect(dropdownOf(el, 'Default agent kind').optionValues()).toEqual([...AGENT_KINDS]);
		expect(dropdownOf(el, 'Default agent kind').value).toBe('claude');
	});

	it('hides the panes-per-tab cap unless agents share a tab', () => {
		const off = settingsContainer();
		buildAgentsSection(off, settingsOf({ splitIntoFolderTab: false }), recorder().callbacks);
		expect(settingNames(off)).not.toContain('Panes per herdr tab');

		const on = settingsContainer();
		buildAgentsSection(on, settingsOf({ splitIntoFolderTab: true }), recorder().callbacks);
		expect(settingNames(on)).toContain('Panes per herdr tab');
		expect(sliderOf(on, 'Panes per herdr tab').limits).toEqual({
			min: MIN_PANES_PER_TAB,
			max: MAX_PANES_PER_TAB,
			step: 1,
		});
	});

	it('redisplays after saving when tab sharing is turned off, since the cap goes', async () => {
		const el = settingsContainer();
		const settings = settingsOf({ splitIntoFolderTab: true });
		const { calls, callbacks } = recorder();
		buildAgentsSection(el, settings, callbacks);

		await toggleOf(el, 'Share a herdr tab between agents in the same folder').change(false);

		expect(settings.splitIntoFolderTab).toBe(false);
		expect(calls).toEqual(['save', 'redisplay']);
	});

	it('clamps the pane cap and only saves for the plain fields', async () => {
		const el = settingsContainer();
		const settings = settingsOf({ splitIntoFolderTab: true });
		const { calls, callbacks } = recorder();
		buildAgentsSection(el, settings, callbacks);

		await sliderOf(el, 'Panes per herdr tab').change(99);
		await textOf(el, 'Agent name pattern').change('{vault}-{n}');
		await toggleOf(el, 'Open terminal after starting an agent').change(false);
		await dropdownOf(el, 'Default agent kind').change('codex');

		expect(settings.panesPerTab).toBe(MAX_PANES_PER_TAB);
		expect(settings.agentNamePattern).toBe('{vault}-{n}');
		expect(settings.openTerminalAfterStart).toBe(false);
		expect(settings.defaultAgentKind).toBe('codex');
		expect(calls).toEqual(['save', 'save', 'save', 'save']);
	});
});

describe('file explorer section', () => {
	it('saves, then re-injects or removes the hover buttons', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildFileExplorerSection(el, settings, callbacks);

		expect(settingNames(el)).toEqual(['File explorer', 'Folder hover button']);
		await toggleOf(el, 'Folder hover button').change(false);

		expect(settings.folderHoverButton).toBe(false);
		// The refresh reads the saved value, so it must run after the save.
		expect(calls).toEqual(['save', 'refreshFolderHoverButton']);
	});
});

describe('agent list section', () => {
	it('renders the three row settings with herdr’s own option values', () => {
		const el = settingsContainer();
		buildAgentListSection(el, settingsOf(), recorder().callbacks);

		expect(settingNames(el)).toEqual(['Agent list', 'Sort', 'Group by', 'Clicking an agent row']);
		expect(dropdownOf(el, 'Sort').optionValues()).toEqual(['priority', 'alphabetical']);
		expect(dropdownOf(el, 'Group by').optionValues()).toEqual(['tab', 'folder', 'none']);
		expect(dropdownOf(el, 'Clicking an agent row').optionValues()).toEqual([
			'terminal',
			'focus',
		]);
	});

	it('repaints the open lists after saving each of them', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildAgentListSection(el, settings, callbacks);

		await dropdownOf(el, 'Sort').change('alphabetical');
		await dropdownOf(el, 'Group by').change('folder');
		await dropdownOf(el, 'Clicking an agent row').change('focus');

		expect(settings.agentListSort).toBe('alphabetical');
		expect(settings.agentListGroupBy).toBe('folder');
		expect(settings.agentListRowClick).toBe('focus');
		expect(calls).toEqual([
			'save',
			'refreshAgentList',
			'save',
			'refreshAgentList',
			'save',
			'refreshAgentList',
		]);
	});
});

describe('terminal section', () => {
	it('renders every terminal setting', () => {
		const el = settingsContainer();
		buildTerminalSection(el, settingsOf(), recorder().callbacks);

		expect(settingNames(el)).toEqual([
			'Terminal',
			'Attach mode',
			'Terminal placement',
			'Terminal tab',
			'Terminal tab title',
			'Theme',
			'Default view',
			'Terminal engine',
			'Cursor style',
			'Blinking cursor',
			'Font family',
			'Scrollback memory budget',
			'Font size',
		]);
		expect(sliderOf(el, 'Scrollback memory budget').limits).toEqual({
			min: MIN_SCROLLBACK_MB,
			max: MAX_SCROLLBACK_MB,
			step: 1,
		});
	});

	it('only saves the settings an open terminal cannot be told about', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildTerminalSection(el, settings, callbacks);

		await dropdownOf(el, 'Attach mode').change('observe');
		await dropdownOf(el, 'Terminal placement').change('tab');
		await dropdownOf(el, 'Terminal tab').change('reuse');

		expect(settings.defaultAttachMode).toBe('observe');
		expect(settings.terminalPlacement).toBe('tab');
		expect(settings.terminalTab).toBe('reuse');
		expect(calls).toEqual(['save', 'save', 'save']);
	});

	it('offers both views as the default for new tabs (#92, #104)', () => {
		const el = settingsContainer();
		buildTerminalSection(el, settingsOf(), recorder().callbacks);

		expect(dropdownOf(el, 'Default view').optionValues()).toEqual(['terminal', 'native']);
		expect(dropdownOf(el, 'Default view').getValue()).toBe('native');
	});

	it('offers the two terminal engines separately from the view (#104)', () => {
		const el = settingsContainer();
		buildTerminalSection(el, settingsOf({ defaultView: 'native' }), recorder().callbacks);

		expect(dropdownOf(el, 'Terminal engine').optionValues()).toEqual(['ghostty-web', 'xterm.js']);
		// The engine setting reads the same whichever view is the default: it is
		// what a tab comes back to, not a property of the terminal view.
		expect(dropdownOf(el, 'Terminal engine').getValue()).toBe('ghostty-web');
	});

	it('stores the native view and tells open terminals (#92, #104)', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildTerminalSection(el, settings, callbacks);

		await dropdownOf(el, 'Default view').change('native');

		expect(settings.defaultView).toBe('native');
		expect(settings.terminalEngine).toBe(DEFAULT_SETTINGS.terminalEngine);
		expect(calls).toEqual(['save', 'applyTerminalSetting:defaultView']);
	});

	it('leaves the default view alone when the engine changes (#104)', async () => {
		const el = settingsContainer();
		const settings = settingsOf({ defaultView: 'native' });
		const { calls, callbacks } = recorder();
		buildTerminalSection(el, settings, callbacks);

		await dropdownOf(el, 'Terminal engine').change('xterm.js');

		expect(settings.defaultView).toBe('native');
		expect(settings.terminalEngine).toBe('xterm.js');
		expect(calls).toEqual(['save', 'applyTerminalSetting:terminalEngine']);
	});

	it('names the setting that moved when an open terminal has to react', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildTerminalSection(el, settings, callbacks);

		await dropdownOf(el, 'Theme').change('nord');
		await dropdownOf(el, 'Terminal engine').change('xterm.js');
		await toggleOf(el, 'Blinking cursor').change(false);
		await textOf(el, 'Font family').change('Iosevka');
		await sliderOf(el, 'Font size').change(14);

		expect(settings.terminalTheme).toBe('nord');
		expect(settings.terminalEngine).toBe('xterm.js');
		expect(settings.terminalCursorBlink).toBe(false);
		expect(settings.terminalFontFamily).toBe('Iosevka');
		expect(settings.terminalFontSize).toBe(14);
		// Always the save first: the effect matrix may rebuild a terminal, which
		// reads the settings back.
		expect(calls).toEqual([
			'save',
			'applyTerminalSetting:terminalTheme',
			'save',
			'applyTerminalSetting:terminalEngine',
			'save',
			'applyTerminalSetting:terminalCursorBlink',
			'save',
			'applyTerminalSetting:terminalFontFamily',
			'save',
			'applyTerminalSetting:terminalFontSize',
		]);
	});

	it('normalises what a control hands back before storing it', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildTerminalSection(el, settings, callbacks);

		await dropdownOf(el, 'Terminal placement').change('nonsense');
		await dropdownOf(el, 'Theme').change('nonsense');
		await dropdownOf(el, 'Default view').change('nonsense');
		await dropdownOf(el, 'Terminal engine').change('nonsense');
		await sliderOf(el, 'Scrollback memory budget').change(9999);

		expect(settings.terminalPlacement).toBe(DEFAULT_SETTINGS.terminalPlacement);
		expect(settings.terminalTheme).toBe(DEFAULT_SETTINGS.terminalTheme);
		expect(settings.defaultView).toBe(DEFAULT_SETTINGS.defaultView);
		expect(settings.terminalEngine).toBe(DEFAULT_SETTINGS.terminalEngine);
		expect(settings.terminalScrollbackMb).toBe(MAX_SCROLLBACK_MB);
		expect(calls).toEqual([
			'save',
			'save',
			'applyTerminalSetting:terminalTheme',
			'save',
			'applyTerminalSetting:defaultView',
			'save',
			'applyTerminalSetting:terminalEngine',
			'save',
			'applyTerminalSetting:terminalScrollbackMb',
		]);
	});
});

describe('native view section', () => {
	it('offers the two ways of showing a turn\u2019s tool calls', () => {
		const el = settingsContainer();
		buildNativeViewSection(el, settingsOf(), recorder().callbacks);

		expect(settingNames(el)).toEqual([
			'Native view',
			'Tool groups',
			'Trust new folders automatically',
		]);
		expect(headings(el)).toEqual(['Native view']);
		const dropdown = dropdownOf(el, 'Tool groups');
		expect(dropdown.optionValues()).toEqual(['highlight', 'collapse']);
		// Highlighting the notes a turn changed is the default (#95).
		expect(dropdown.value).toBe('highlight');
		// Answering the trust prompt by itself is off until it is asked for (#99).
		expect(toggleOf(el, 'Trust new folders automatically').value).toBe(false);
	});

	it('says auto-trust does nothing today, on any runtime, and names the button', () => {
		// Only a reported trust kind is answered unasked, and no runtime reports
		// one: herdr says only "blocked", and on herdr-core Claude asks before
		// its hook has labelled the terminal, so the tab shows the terminal.
		const el = settingsContainer();
		buildNativeViewSection(el, settingsOf(), recorder().callbacks);
		const desc = settingNamed(el, 'Trust new folders automatically').desc;
		expect(desc).toContain('No runtime reports it today, herdr and herdr-core included');
		expect(desc).toContain('this does nothing');
		expect(desc).toContain('the trust button on the waiting card');
	});

	it('saves the presentation and redraws the open native views', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildNativeViewSection(el, settings, callbacks);

		await dropdownOf(el, 'Tool groups').change('collapse');

		expect(settings.nativeToolGroups).toBe('collapse');
		expect(calls).toEqual(['save', 'refreshNativeViews']);
	});

	it('saves auto-trust and redraws the open native views', async () => {
		// The card on screen is drawn from the setting as it was: without the
		// redraw the switch only reaches the next card (#99).
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildNativeViewSection(el, settings, callbacks);

		await toggleOf(el, 'Trust new folders automatically').change(true);

		expect(settings.nativeAutoTrustFolders).toBe(true);
		expect(calls).toEqual(['save', 'refreshNativeViews']);
	});

	it('reads a stored value it does not know as the default', () => {
		const el = settingsContainer();
		buildNativeViewSection(
			el,
			settingsOf({ nativeToolGroups: 'everything' as never }),
			recorder().callbacks,
		);

		expect(dropdownOf(el, 'Tool groups').value).toBe('highlight');
	});
});

describe('the tab as a whole', () => {
	it('renders every section in order on one container', () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { callbacks } = recorder();

		for (const section of SETTINGS_SECTIONS) section(el, settings, callbacks);

		expect(headings(el)).toEqual([
			'Runtimes',
			'Connection',
			'Notifications',
			'Agents',
			'File explorer',
			'Agent list',
			'Terminal',
			'Native view',
		]);
		// Every non-heading row carries exactly one control, which is what the
		// per-section assertions above lean on; a runtime's row is the one
		// exception, with its use, edit and remove buttons.
		const runtimeRows = new Set(settings.runtimes.map((runtime) => runtime.name));
		for (const setting of builtSettings(el)) {
			const expected = setting.heading ? 0 : runtimeRows.has(setting.name) ? 3 : 1;
			expect(setting.components).toHaveLength(expected);
		}
	});

	it('names every row in sentence case', () => {
		const el = settingsContainer();
		for (const section of SETTINGS_SECTIONS) section(el, settingsOf(), recorder().callbacks);

		// Allowed second-and-later words: lower case, or an acronym (ID, PATH).
		const exceptions = new Set(['ID', 'PATH']);
		for (const { name } of builtSettings(el)) {
			for (const word of name.split(' ').slice(1)) {
				const bare = word.replace(/[^A-Za-z]/g, '');
				if (!bare || exceptions.has(bare)) continue;
				expect(bare[0], `"${name}" is not sentence case`).toBe(bare[0]?.toLowerCase());
			}
		}
	});
});
