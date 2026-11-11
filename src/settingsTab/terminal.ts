/**
 * The Terminal page: how a terminal tab attaches, where it opens, what it is
 * called and how it draws. Everything an open terminal can be told about has
 * the `terminal` effect (`effects.ts`), which names the setting to the
 * effect matrix (issue #84); attach mode, placement and tab are read at the
 * next open, so they only save.
 */

import type { SettingDefinitionPage } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	MAX_SCROLLBACK_MB,
	MIN_SCROLLBACK_MB,
	type HerdrSettings,
} from '../settings';
import {
	normalizeEngineName,
	TERMINAL_CURSOR_STYLES,
	TERMINAL_CURSOR_STYLE_LABELS,
	TERMINAL_ENGINES,
	TERMINAL_ENGINE_LABELS,
} from '../views/renderer/TerminalRenderer';
import { TERMINAL_THEMES, TERMINAL_THEME_LABELS } from '../views/renderer/themes';
import type { ControlKey } from './effects';
import { optionsOf } from './options';

export function terminalPage(settings: () => HerdrSettings): SettingDefinitionPage<ControlKey> {
	return {
		type: 'page',
		name: 'Terminal',
		desc: 'Attach mode, placement, theme, engine, cursor, font and scrollback of terminal tabs.',
		// The label without its parenthesis: "Ghostty web", "xterm.js".
		displayValue: () => TERMINAL_ENGINE_LABELS[normalizeEngineName(settings().terminalEngine)].replace(/ \(.*\)$/, ''),
		items: [
			{
				type: 'group',
				heading: 'Opening',
				items: [
					{
						name: 'Attach mode',
						desc: 'Control types into the agent and makes the herdr pane follow this window’s size while the view is open; closing it hands ownership back. Observe is read-only and leaves the pane alone.',
						control: {
							type: 'dropdown',
							key: 'defaultAttachMode',
							defaultValue: DEFAULT_SETTINGS.defaultAttachMode,
							options: { control: 'Control (type and resize)', observe: 'Observe (read-only)' },
						},
					},
					{
						name: 'Terminal placement',
						desc: 'Where a terminal opens when the note you are looking at lives inside the agent’s working directory. Otherwise, and when that terminal is already open, nothing splits: the existing tab is revealed.',
						control: {
							type: 'dropdown',
							key: 'terminalPlacement',
							options: {
								'split-right': 'Split to the right of the note',
								'split-left': 'Split to the left of the note',
								tab: 'Always a new tab',
							},
						},
					},
					{
						name: 'Terminal tab',
						desc: 'One terminal tab per agent, or a single tab that switches to whichever agent you open. Reusing one tab keeps a single terminal in memory instead of one per open agent — roughly five megabytes and a repaint loop each — at the cost of reconnecting the bridge on every switch.',
						control: {
							type: 'dropdown',
							key: 'terminalTab',
							options: { 'per-agent': 'One tab per agent', reuse: 'Reuse one tab' },
						},
					},
					{
						name: 'Terminal tab title',
						desc: 'What names a terminal tab. Agent name is the name the agent list shows. Herdr tab label is the label of the herdr tab the agent runs in, as in herdr’s own tab bar; while a tab is shared by two agents the agent name is appended. Open terminals retitle at once.',
						control: {
							type: 'dropdown',
							key: 'terminalTitleSource',
							options: { agent: 'Agent name', tab: 'Herdr tab label' },
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Look',
				items: [
					{
						name: 'Theme',
						desc: 'Colours for the terminal view. Follow Obsidian takes them from the vault’s theme and follows it when you switch; the others are fixed palettes. Open terminals repaint immediately.',
						aliases: ['terminal theme', 'colours', 'colors'],
						control: { type: 'dropdown', key: 'terminalTheme', options: optionsOf(TERMINAL_THEMES, TERMINAL_THEME_LABELS) },
					},
					{
						name: 'Terminal engine',
						desc: 'Which library draws a terminal. Ghostty web is the default and repaints a canvas continuously; xterm.js draws into the DOM and only repaints changed rows. Applies to every tab showing a terminal, whatever the default view is. Open terminals are rebuilt on change, so their scrollback is replayed as plain text and colours from before the switch are lost.',
						aliases: ['renderer', 'ghostty', 'xterm'],
						control: { type: 'dropdown', key: 'terminalEngine', options: optionsOf(TERMINAL_ENGINES, TERMINAL_ENGINE_LABELS) },
					},
					{
						name: 'Cursor style',
						desc: 'Shape of the terminal cursor. Applies to open terminals immediately.',
						control: {
							type: 'dropdown',
							key: 'terminalCursorStyle',
							options: optionsOf(TERMINAL_CURSOR_STYLES, TERMINAL_CURSOR_STYLE_LABELS),
						},
					},
					{
						name: 'Blinking cursor',
						desc: 'Blink the terminal cursor. Applies to open terminals immediately.',
						control: { type: 'toggle', key: 'terminalCursorBlink' },
					},
					{
						name: 'Font family',
						desc: 'Font for the terminal view. Leave empty to follow the Obsidian monospace font.',
						aliases: ['terminal font'],
						control: { type: 'text', key: 'terminalFontFamily', placeholder: 'Follow Obsidian' },
					},
					{
						name: 'Font size',
						desc: 'Terminal font size in pixels. Set to 0 to follow the Obsidian monospace size.',
						aliases: ['terminal font size'],
						control: { type: 'slider', key: 'terminalFontSize', min: 0, max: 32, step: 1, defaultValue: 0 },
					},
					{
						name: 'Scrollback memory budget',
						desc: 'Megabytes of scrollback each open terminal keeps. This is a memory budget, not a line count: roughly 600 lines per megabyte. The memory is shared by every open terminal and is only given back when Obsidian restarts.',
						aliases: ['scrollback'],
						control: {
							type: 'slider',
							key: 'terminalScrollbackMb',
							min: MIN_SCROLLBACK_MB,
							max: MAX_SCROLLBACK_MB,
							step: 1,
						},
					},
				],
			},
		],
	};
}
