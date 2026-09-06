/**
 * The agent list's quick settings menu (issue #44).
 *
 * The five choices that change what the list and its terminals *do* rather than
 * how they are ordered: what clicking a row does, where a terminal opens, how
 * many terminal tabs there are, whether a second agent in a folder shares that
 * folder's herdr tab, and whether the file explorer shows its hover button. All
 * of them live in the settings tab too, which is a window away from the list
 * they act on; this is the same pair of clicks the file explorer spends on its
 * sort order.
 *
 * Pure on purpose, like `listMenu.ts` and `rowModel.ts`: no `obsidian` import,
 * no plugin, no DOM, so the entries are unit tested and the view is left with
 * nothing but `Menu.addItem`. The settings types come in as types only, so
 * nothing here pulls `settings.ts` (and through it `obsidian`) into a test.
 */

import type { RowClickAction } from './rowModel';
import type { TerminalPlacement, TerminalTabMode } from '../settings';

/**
 * The slice of the settings this menu reads and writes. Structural rather than
 * the whole `HerdrSettings`, so a test can hand it five fields and no plugin.
 */
export interface QuickSettings {
	agentListRowClick: RowClickAction;
	terminalPlacement: TerminalPlacement;
	terminalTab: TerminalTabMode;
	splitIntoFolderTab: boolean;
	folderHoverButton: boolean;
}

/**
 * Side effect the view must run after writing an entry. Most settings are read
 * on the next repaint or the next terminal, but the explorer buttons are
 * attached to another plugin's DOM and have to be told (`refreshFolderHoverButton`).
 */
export type QuickSettingsEffect = 'folder-button';

/** One menu entry: what it says, whether it is the current choice, what it does. */
export interface QuickSettingsItem {
	/** Heading this entry sits under, shown as a non-clickable label. */
	section: string;
	/** Entry text, sentence case like all UI. */
	label: string;
	/** True for the value in effect; the view renders it with `setChecked`. */
	checked: boolean;
	/** Writes the choice. The caller saves the settings and repaints. */
	apply: (settings: QuickSettings) => void;
	/** What the view must poke afterwards, if anything. */
	effect?: QuickSettingsEffect;
}

const ROW_CLICK_OPTIONS: readonly (readonly [RowClickAction, string])[] = [
	['terminal', 'Opens the terminal'],
	['focus', 'Focuses it in herdr'],
];

const PLACEMENT_OPTIONS: readonly (readonly [TerminalPlacement, string])[] = [
	['split-right', 'Split right'],
	['split-left', 'Split left'],
	['tab', 'New tab'],
];

const TAB_OPTIONS: readonly (readonly [TerminalTabMode, string])[] = [
	['per-agent', 'One per agent'],
	['reuse', 'Reuse one tab'],
];

/** A radio group: one entry per value, the current one ticked. */
function choices<T>(
	section: string,
	options: readonly (readonly [T, string])[],
	current: T,
	write: (settings: QuickSettings, value: T) => void,
): QuickSettingsItem[] {
	return options.map(([value, label]) => ({
		section,
		label,
		checked: current === value,
		apply: (settings) => write(settings, value),
	}));
}

/**
 * Every entry the quick settings menu shows, in display order, each carrying the
 * writer for its own value. Reading the current settings here is what makes
 * `checked` right without the view comparing anything.
 *
 * The two booleans are ticked when on and toggle rather than set, so the menu
 * reads as a checklist; the three multi-value settings are radio groups.
 */
export function quickSettingsItems(settings: QuickSettings): QuickSettingsItem[] {
	return [
		...choices(
			'Clicking an agent row',
			ROW_CLICK_OPTIONS,
			settings.agentListRowClick,
			(target, value) => {
				target.agentListRowClick = value;
			},
		),
		...choices(
			'Terminal opens in',
			PLACEMENT_OPTIONS,
			settings.terminalPlacement,
			(target, value) => {
				target.terminalPlacement = value;
			},
		),
		...choices('Terminal tabs', TAB_OPTIONS, settings.terminalTab, (target, value) => {
			target.terminalTab = value;
		}),
		{
			section: 'Also',
			label: 'Share a herdr tab per folder',
			checked: settings.splitIntoFolderTab,
			apply: (target) => {
				target.splitIntoFolderTab = !target.splitIntoFolderTab;
			},
		},
		{
			section: 'Also',
			label: 'Folder hover button',
			checked: settings.folderHoverButton,
			apply: (target) => {
				target.folderHoverButton = !target.folderHoverButton;
			},
			effect: 'folder-button',
		},
	];
}
