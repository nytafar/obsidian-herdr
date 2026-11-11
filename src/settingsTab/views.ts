/**
 * The Views page (issues #95, #99, #104, #173): what a new tab shows, and how
 * the native view reads. The default view goes to the open terminals' effect
 * matrix, since a tab that never chose follows it; the native view's own
 * settings redraw the open native views.
 */

import type { SettingDefinitionPage } from 'obsidian';
import type { HerdrSettings } from '../settings';
import { normalizePaneView, PANE_VIEWS, PANE_VIEW_LABELS } from '../native/renderMode';
import {
	CONTEXT_READOUT_STYLES,
	CONTEXT_READOUT_STYLE_LABELS,
	PROMPT_BOX_STYLES,
	PROMPT_BOX_STYLE_LABELS,
} from '../native/composerLook';
import type { ControlKey } from './effects';
import { optionsOf } from './options';

export function viewsPage(settings: () => HerdrSettings): SettingDefinitionPage<ControlKey> {
	return {
		type: 'page',
		name: 'Views',
		desc: 'What a new tab shows, and how the native view reads.',
		displayValue: () => PANE_VIEW_LABELS[normalizePaneView(settings().defaultView)],
		items: [
			{
				name: 'Default view',
				desc: 'What a tab shows until it chooses for itself. A terminal, or the native view, which shows the pane’s agent session as Markdown with a prompt box. It is offered for herdr on this machine and for herdr-core on this machine or over SSH, where each terminal needs the Claude session hook; other panes show a terminal. Each tab keeps its own choice, switched from its header button or its tab menu; open tabs that never chose follow this one and are rebuilt on change.',
				aliases: ['native view', 'render mode'],
				control: { type: 'dropdown', key: 'defaultView', options: optionsOf(PANE_VIEWS, PANE_VIEW_LABELS) },
			},
			{
				type: 'group',
				heading: 'Native view',
				items: [
					{
						name: 'Tool groups',
						desc: 'What a turn’s tool calls look like. Highlighting keeps the notes the agent changed and the sources it read in the text, at the point it used them, and leaves the rest inside the collapsed group. Collapsing puts every call inside it.',
						control: {
							type: 'dropdown',
							key: 'nativeToolGroups',
							options: { highlight: 'Highlight vault changes and sources', collapse: 'Collapse everything' },
						},
					},
					{
						name: 'Prompt box style',
						desc: 'How the box you type in looks. Divided gives the strip with the pickers and buttons its own background; joined keeps it on one surface with the text; floating raises the box over the conversation, with icon buttons.',
						control: {
							type: 'dropdown',
							key: 'nativePromptBoxStyle',
							options: optionsOf(PROMPT_BOX_STYLES, PROMPT_BOX_STYLE_LABELS),
						},
					},
					{
						name: 'Context readout',
						desc: 'How the prompt box shows how full the context window is. Detail shows the tokens, the window and the share; gauge shows a small ring with the share, and the tokens when you hover it. Either opens the context breakdown when clicked.',
						control: {
							type: 'dropdown',
							key: 'nativeContextReadout',
							options: optionsOf(CONTEXT_READOUT_STYLES, CONTEXT_READOUT_STYLE_LABELS),
						},
					},
					{
						name: 'Trust new folders automatically',
						desc: 'Answer Claude’s workspace trust prompt for an agent open in a tab, on herdr and herdr-core, once the prompt is read on the screen and names the agent’s own folder. Nothing else is answered for you: tool permissions, questions and plan approval are yours to answer, on the waiting card or in the terminal. Off by default.',
						aliases: ['auto trust', 'workspace trust'],
						control: { type: 'toggle', key: 'nativeAutoTrustFolders' },
					},
				],
			},
		],
	};
}
