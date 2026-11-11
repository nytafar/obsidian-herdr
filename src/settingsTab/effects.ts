/**
 * The settings tab's one write path (issue #156, ADR-0011): every control
 * names a key, `setControlValue` writes it, saves, and runs the effect this
 * table gives that key. The table is the single place that says what a
 * change does, so a control whose key is missing here does not compile, and
 * a test walks the definitions to make sure of it at run time too.
 *
 * Keys are the stored `data.json` names, dotted where the value is nested
 * (`notifications.blocked.notice`). The runtime list still writes through
 * its own builder until #178. The agent CLI catalog's keys, which name an
 * entry by its id, are `agentCatalog.ts`'s (#179).
 */

import type { HerdrSettings } from '../settings';
import {
	clampPanesPerTab,
	clampScrollbackMb,
	normalizeTerminalPlacement,
	normalizeTerminalTab,
	normalizeTerminalTitleSource,
} from '../settings';
import type { TerminalSetting } from '../views/paneTerminal';
import { normalizeCursorStyle, normalizeEngineName } from '../views/renderer/TerminalRenderer';
import { normalizeThemeName } from '../views/renderer/themes';
import { normalizePaneView } from '../native/renderMode';
import { normalizeToolGroupPresentation } from '../native/toolCalls';
import { normalizeContextReadoutStyle, normalizePromptBoxStyle } from '../native/composerLook';

/** Every key a control of the tab reads and writes. */
export type ControlKey =
	| 'extraPath'
	| 'agentNamePattern'
	| 'openTerminalAfterStart'
	| 'splitIntoFolderTab'
	| 'panesPerTab'
	| 'defaultView'
	| 'nativeToolGroups'
	| 'nativePromptBoxStyle'
	| 'nativeContextReadout'
	| 'nativeAutoTrustFolders'
	| 'defaultAttachMode'
	| 'terminalPlacement'
	| 'terminalTab'
	| 'terminalTitleSource'
	| 'terminalTheme'
	| 'terminalEngine'
	| 'terminalCursorStyle'
	| 'terminalCursorBlink'
	| 'terminalFontFamily'
	| 'terminalFontSize'
	| 'terminalScrollbackMb'
	| 'agentListSort'
	| 'agentListGroupBy'
	| 'agentListRowClick'
	| 'folderHoverButton'
	| 'notifications.statusBar'
	| 'notifications.blocked.notice'
	| 'notifications.blocked.os'
	| 'notifications.done.notice'
	| 'notifications.done.os';

/**
 * What a change costs, after the save every change makes.
 *
 * - `save`: nothing else; the value is read where it is next used.
 * - `reconnect`: the connection is rebuilt from the settings.
 * - `agent-list`: every open agent list repaints (issue #20).
 * - `folder-hover-button`: the explorer's hover buttons come or go (#30).
 * - `native-views`: every open native view draws again (#95).
 * - `terminal`: the key goes to the open terminals' effect matrix (#84),
 *   which decides what it costs there. Only a {@link TerminalSetting} may
 *   have it, which the table's type checks.
 */
export type SettingEffect = 'save' | 'reconnect' | 'agent-list' | 'folder-hover-button' | 'native-views' | 'terminal';

/** One row: the effect, and what turns a stored or chosen value into a valid one. */
export interface SettingSpec<E extends SettingEffect = SettingEffect> {
	effect: E;
	/**
	 * Applied both to what `data.json` holds before a control shows it and to
	 * what a control hands back before it is stored, the same contract as the
	 * normalisers in `settings.ts`. Absent: the value is taken as it is.
	 */
	normalize?: (value: unknown) => unknown;
}

type SpecFor<K extends ControlKey> = K extends TerminalSetting
	? SettingSpec
	: SettingSpec<Exclude<SettingEffect, 'terminal'>>;

/** The key→effect table. Total over {@link ControlKey} by its type. */
export const SETTING_EFFECTS: { readonly [K in ControlKey]: SpecFor<K> } = {
	// Spawns read it, so the connection is rebuilt with it.
	extraPath: { effect: 'reconnect' },
	// Read when the next agent starts.
	agentNamePattern: { effect: 'save' },
	openTerminalAfterStart: { effect: 'save' },
	splitIntoFolderTab: { effect: 'save' },
	panesPerTab: { effect: 'save', normalize: clampPanesPerTab },
	// Open tabs that never chose a view follow the default (#104).
	defaultView: { effect: 'terminal', normalize: normalizePaneView },
	nativeToolGroups: { effect: 'native-views', normalize: normalizeToolGroupPresentation },
	nativePromptBoxStyle: { effect: 'native-views', normalize: normalizePromptBoxStyle },
	nativeContextReadout: { effect: 'native-views', normalize: normalizeContextReadoutStyle },
	// The waiting card on screen was drawn from the setting as it was, and a
	// card is what a blocked pane shows until the block is over: without the
	// redraw the switch would only reach the block after this one.
	nativeAutoTrustFolders: { effect: 'native-views', normalize: (value) => value === true },
	// Read when the next terminal opens.
	defaultAttachMode: { effect: 'save' },
	terminalPlacement: { effect: 'save', normalize: normalizeTerminalPlacement },
	terminalTab: { effect: 'save', normalize: normalizeTerminalTab },
	terminalTitleSource: { effect: 'terminal', normalize: normalizeTerminalTitleSource },
	terminalTheme: { effect: 'terminal', normalize: normalizeThemeName },
	terminalEngine: { effect: 'terminal', normalize: normalizeEngineName },
	terminalCursorStyle: { effect: 'terminal', normalize: normalizeCursorStyle },
	terminalCursorBlink: { effect: 'terminal', normalize: (value) => value !== false },
	// A `next-mount` row in the matrix: open terminals keep the font they were
	// built with, and the next mount reads this.
	terminalFontFamily: { effect: 'terminal' },
	terminalFontSize: { effect: 'terminal' },
	terminalScrollbackMb: { effect: 'terminal', normalize: clampScrollbackMb },
	agentListSort: { effect: 'agent-list' },
	agentListGroupBy: { effect: 'agent-list' },
	agentListRowClick: { effect: 'agent-list' },
	folderHoverButton: { effect: 'folder-hover-button' },
	// The status bar and the notifier read these on the next transition.
	'notifications.statusBar': { effect: 'save' },
	'notifications.blocked.notice': { effect: 'save' },
	'notifications.blocked.os': { effect: 'save' },
	'notifications.done.notice': { effect: 'save' },
	'notifications.done.os': { effect: 'save' },
};

/** True when `key` is one the table knows. */
export function isControlKey(key: string): key is ControlKey {
	return Object.prototype.hasOwnProperty.call(SETTING_EFFECTS, key);
}

/** What the plugin does for an effect. The tab hands the plugin in; a test hands a recorder. */
export interface SettingsHost {
	saveSettings(): Promise<void>;
	scheduleReconnect(): void;
	refreshAgentList(): void;
	refreshFolderHoverButton(): void;
	applyTerminalSetting(setting: TerminalSetting): void;
	refreshNativeViews(): void;
}

/** The value at a dotted key, or undefined when a step is missing. */
function readPath(settings: HerdrSettings, key: string): unknown {
	let at: unknown = settings;
	for (const step of key.split('.')) {
		if (typeof at !== 'object' || at === null) return undefined;
		at = (at as Record<string, unknown>)[step];
	}
	return at;
}

/** Writes the value at a dotted key, creating missing objects on the way. */
function writePath(settings: HerdrSettings, key: string, value: unknown): void {
	const steps = key.split('.');
	const last = steps.pop() as string;
	let at = settings as unknown as Record<string, unknown>;
	for (const step of steps) {
		const next = at[step];
		if (typeof next !== 'object' || next === null) at[step] = {};
		at = at[step] as Record<string, unknown>;
	}
	at[last] = value;
}

/** What a control shows for `key`: the stored value, normalised. Undefined for an unknown key. */
export function readSetting(settings: HerdrSettings, key: string): unknown {
	if (!isControlKey(key)) return undefined;
	const { normalize } = SETTING_EFFECTS[key] as SettingSpec;
	const value = readPath(settings, key);
	return normalize ? normalize(value) : value;
}

/**
 * The write path: store the normalised value, save, then run the key's
 * effect. An unknown key changes nothing and is reported once to the
 * console, since only a definition of this tab can name one.
 */
export async function writeSetting(
	settings: HerdrSettings,
	key: string,
	value: unknown,
	host: SettingsHost,
): Promise<void> {
	if (!isControlKey(key)) {
		console.warn(`Gjetr: no setting has the key "${key}"`);
		return;
	}
	const spec = SETTING_EFFECTS[key] as SettingSpec;
	writePath(settings, key, spec.normalize ? spec.normalize(value) : value);
	await host.saveSettings();
	runEffect(key, spec.effect, host);
}

function runEffect(key: ControlKey, effect: SettingEffect, host: SettingsHost): void {
	switch (effect) {
		case 'save':
			return;
		case 'reconnect':
			host.scheduleReconnect();
			return;
		case 'agent-list':
			host.refreshAgentList();
			return;
		case 'folder-hover-button':
			host.refreshFolderHoverButton();
			return;
		case 'native-views':
			host.refreshNativeViews();
			return;
		case 'terminal':
			// Only a TerminalSetting key may carry this effect (`SpecFor`).
			host.applyTerminalSetting(key as TerminalSetting);
			return;
	}
}
