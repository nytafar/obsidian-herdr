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
	buildRemoteSection,
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

/** A fresh, mutable copy of the defaults plus whatever a case overrides. */
function settingsOf(overrides: Partial<HerdrSettings> = {}): HerdrSettings {
	return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

/** A callback bundle that records the calls, in order, as strings. */
function recorder(): { calls: string[]; callbacks: SettingsCallbacks } {
	const calls: string[] = [];
	const callbacks: SettingsCallbacks = {
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
	it('renders the four fields the connection is rebuilt from', () => {
		const el = settingsContainer();
		buildConnectionSection(el, settingsOf(), recorder().callbacks);

		expect(settingNames(el)).toEqual([
			'Connection',
			'Socket path',
			'Herdr binary',
			'Extra PATH entries',
			'Workspace ID',
		]);
		expect(headings(el)).toEqual(['Connection']);
		expect(textOf(el, 'Socket path').value).toBe(DEFAULT_SETTINGS.socketPath);
		expect(textOf(el, 'Workspace ID').placeholder).toBe('Auto-detect');
	});

	it('saves and reconnects on every field, since each changes the endpoint', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildConnectionSection(el, settings, callbacks);

		await textOf(el, 'Socket path').change('/tmp/other.sock');
		await textOf(el, 'Herdr binary').change('/usr/bin/herdr');
		await textOf(el, 'Extra PATH entries').change('/opt/bin');
		await textOf(el, 'Workspace ID').change('w7');

		expect(settings.socketPath).toBe('/tmp/other.sock');
		expect(settings.herdrBinary).toBe('/usr/bin/herdr');
		expect(settings.extraPath).toBe('/opt/bin');
		expect(settings.workspaceId).toBe('w7');
		expect(calls).toEqual([
			'saveAndReconnect',
			'saveAndReconnect',
			'saveAndReconnect',
			'saveAndReconnect',
		]);
	});
});

describe('remote section', () => {
	it('shows the enable toggle and nothing else while the profile is off', () => {
		const el = settingsContainer();
		buildRemoteSection(el, settingsOf(), recorder().callbacks);

		expect(settingNames(el)).toEqual(['Remote host', 'Use a remote herdr']);
	});

	it('shows the profile fields once it is on', () => {
		const el = settingsContainer();
		const settings = settingsOf();
		settings.remote.enabled = true;
		buildRemoteSection(el, settings, recorder().callbacks);

		expect(settingNames(el)).toEqual([
			'Remote host',
			'Use a remote herdr',
			'SSH host',
			'Remote socket path',
			'Remote herdr binary',
			'Remote vault path',
		]);
		expect(toggleOf(el, 'Use a remote herdr').value).toBe(true);
	});

	it('reconnects and then redisplays when the profile is switched on', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildRemoteSection(el, settings, callbacks);

		await toggleOf(el, 'Use a remote herdr').change(true);

		expect(settings.remote.enabled).toBe(true);
		// The fields under the toggle only exist on the next render, so the
		// redisplay has to come after the save.
		expect(calls).toEqual(['saveAndReconnect', 'redisplay']);
	});

	it('saves and reconnects on a profile field', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		settings.remote.enabled = true;
		const { calls, callbacks } = recorder();
		buildRemoteSection(el, settings, callbacks);

		await textOf(el, 'SSH host').change('lasse@xl');
		await textOf(el, 'Remote vault path').change('/home/lasse/hvelv');

		expect(settings.remote.host).toBe('lasse@xl');
		expect(settings.remote.remoteVaultPath).toBe('/home/lasse/hvelv');
		expect(calls).toEqual(['saveAndReconnect', 'saveAndReconnect']);
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
			'Default render mode',
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

	it('offers all three render modes as the default for new tabs (#92)', () => {
		const el = settingsContainer();
		buildTerminalSection(el, settingsOf(), recorder().callbacks);

		expect(dropdownOf(el, 'Default render mode').optionValues()).toEqual([
			'ghostty-web',
			'xterm.js',
			'native',
		]);
		expect(dropdownOf(el, 'Default render mode').getValue()).toBe('ghostty-web');
	});

	it('stores the native render mode and tells open terminals (#92)', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildTerminalSection(el, settings, callbacks);

		await dropdownOf(el, 'Default render mode').change('native');

		expect(settings.terminalEngine).toBe('native');
		expect(calls).toEqual(['save', 'applyTerminalSetting:terminalEngine']);
	});

	it('names the setting that moved when an open terminal has to react', async () => {
		const el = settingsContainer();
		const settings = settingsOf();
		const { calls, callbacks } = recorder();
		buildTerminalSection(el, settings, callbacks);

		await dropdownOf(el, 'Theme').change('nord');
		await dropdownOf(el, 'Default render mode').change('xterm.js');
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
		await dropdownOf(el, 'Default render mode').change('nonsense');
		await sliderOf(el, 'Scrollback memory budget').change(9999);

		expect(settings.terminalPlacement).toBe(DEFAULT_SETTINGS.terminalPlacement);
		expect(settings.terminalTheme).toBe(DEFAULT_SETTINGS.terminalTheme);
		expect(settings.terminalEngine).toBe(DEFAULT_SETTINGS.terminalEngine);
		expect(settings.terminalScrollbackMb).toBe(MAX_SCROLLBACK_MB);
		expect(calls).toEqual([
			'save',
			'save',
			'applyTerminalSetting:terminalTheme',
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

		expect(settingNames(el)).toEqual(['Native view', 'Tool groups']);
		expect(headings(el)).toEqual(['Native view']);
		const dropdown = dropdownOf(el, 'Tool groups');
		expect(dropdown.optionValues()).toEqual(['highlight', 'collapse']);
		// Highlighting the notes a turn changed is the default (#95).
		expect(dropdown.value).toBe('highlight');
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
			'Connection',
			'Remote host',
			'Notifications',
			'Agents',
			'File explorer',
			'Agent list',
			'Terminal',
			'Native view',
		]);
		// Every non-heading row carries exactly one control, which is what the
		// per-section assertions above lean on.
		for (const setting of builtSettings(el)) {
			expect(setting.components).toHaveLength(setting.heading ? 0 : 1);
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
