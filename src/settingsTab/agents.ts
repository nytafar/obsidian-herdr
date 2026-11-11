/**
 * The Agents page: the agent CLI catalog (still drawn by its 0.7.1 builder
 * until #179, see `lists.ts`), and what "Start agent here" does. The
 * panes-per-tab cap only means something while agents share a herdr tab, so
 * it is visible only then; the framework re-checks `visible` after each
 * change.
 */

import type { SettingDefinitionPage, SettingDefinitionRender } from 'obsidian';
import {
	clampPanesPerTab,
	DEFAULT_SETTINGS,
	MAX_PANES_PER_TAB,
	MIN_PANES_PER_TAB,
	type HerdrSettings,
} from '../settings';
import type { ControlKey } from './effects';

export function agentsPage(
	settings: () => HerdrSettings,
	catalog: SettingDefinitionRender,
): SettingDefinitionPage<ControlKey> {
	return {
		type: 'page',
		name: 'Agents',
		desc: 'The agent CLIs the + button offers, and how new agents are named and placed.',
		items: [
			{ type: 'group', items: [catalog] },
			{
				type: 'group',
				heading: 'Starting agents',
				items: [
					{
						name: 'Agent name pattern',
						desc: 'Name given to new agents. {folder} is the folder the agent starts in, {vault} the vault name, {n} a counter that avoids collisions.',
						control: { type: 'text', key: 'agentNamePattern', placeholder: DEFAULT_SETTINGS.agentNamePattern },
					},
					{
						name: 'Open terminal after starting an agent',
						desc: 'Open the new agent as a terminal tab as soon as it starts.',
						control: { type: 'toggle', key: 'openTerminalAfterStart' },
					},
					{
						name: 'Share a herdr tab between agents in the same folder',
						desc: 'On: a second agent started in a folder splits that folder’s herdr tab instead of opening another tab. Off: every agent gets its own tab, matching how herdr is navigated. Group the agent list by folder to keep a folder’s agents together either way.',
						aliases: ['split', 'folder tab'],
						control: { type: 'toggle', key: 'splitIntoFolderTab' },
					},
					{
						name: 'Panes per herdr tab',
						desc: 'How many agents share one herdr tab before the next one opens a new tab.',
						visible: () => settings().splitIntoFolderTab,
						control: {
							type: 'slider',
							key: 'panesPerTab',
							min: MIN_PANES_PER_TAB,
							max: MAX_PANES_PER_TAB,
							step: 1,
							defaultValue: clampPanesPerTab(undefined),
						},
					},
				],
			},
		],
	};
}
