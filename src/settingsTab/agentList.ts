/**
 * The Agent list and notifications page: row order, grouping and what a
 * click does (issue #20), the explorer's folder hover button (#30), and the
 * status bar counts and transition notifications (PRD M7-M9).
 */

import type { SettingDefinition, SettingDefinitionPage } from 'obsidian';
import type { NotifiedTransition } from '../settings';
import type { ControlKey } from './effects';

/** The notice and system-notification pair for one transition. */
function transitionItems(transition: NotifiedTransition, label: string, when: string): SettingDefinition<ControlKey>[] {
	return [
		{
			name: `${label}: notice`,
			desc: `Show a notice in Obsidian when ${when}.`,
			control: { type: 'toggle', key: `notifications.${transition}.notice` },
		},
		{
			name: `${label}: system notification`,
			desc: `Send a system notification when ${when} and the Obsidian window is not focused.`,
			control: { type: 'toggle', key: `notifications.${transition}.os` },
		},
	];
}

export function agentListPage(): SettingDefinitionPage<ControlKey> {
	return {
		type: 'page',
		name: 'Agent list and notifications',
		desc: 'Sort, grouping and clicks in the agent list, the folder hover button, the status bar and notifications.',
		items: [
			{
				type: 'group',
				heading: 'Agent list',
				items: [
					{
						name: 'Sort',
						desc: 'Row order inside each group. Priority is herdr’s own: blocked first, then finished but unseen, then working, then idle, with the most recent change first among equals.',
						aliases: ['agent list sort'],
						control: {
							type: 'dropdown',
							key: 'agentListSort',
							options: { priority: 'Priority (same as herdr)', alphabetical: 'Alphabetical by name' },
						},
					},
					{
						name: 'Group by',
						desc: 'What rows are grouped under. Folder keeps a project’s agents together when herdr has spread them over several tabs.',
						aliases: ['agent list grouping'],
						control: {
							type: 'dropdown',
							key: 'agentListGroupBy',
							options: { tab: 'Herdr tab', folder: 'Working directory', none: 'Nothing, one flat list' },
						},
					},
					{
						name: 'Clicking an agent row',
						desc: 'What a click on the row itself does. The icon button on the row always does the other one, and its tooltip says which.',
						aliases: ['row click'],
						control: {
							type: 'dropdown',
							key: 'agentListRowClick',
							options: { terminal: 'Opens the terminal in Obsidian', focus: 'Focuses the pane in herdr' },
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'File explorer',
				items: [
					{
						name: 'Folder hover button',
						desc: 'Show a button on folder rows in the file explorer, on hover, that opens the herdr actions for that folder. The right-click menu has the same actions and is unaffected. Turn this off if an Obsidian update makes the button misbehave.',
						control: { type: 'toggle', key: 'folderHoverButton' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Notifications',
				items: [
					{
						name: 'Status bar counts',
						desc: 'Show how many agents in this vault are blocked or done, in the status bar.',
						control: { type: 'toggle', key: 'notifications.statusBar' },
					},
					...transitionItems('blocked', 'Blocked', 'an agent stops and waits for you'),
					...transitionItems('done', 'Done', 'an agent finishes its turn'),
				],
			},
		],
	};
}
