/**
 * The Runtimes page: the runtime registry (ADR-0004; still drawn by its 0.7.1
 * builder until #178, see `lists.ts`), and what applies to every runtime on
 * this machine, the PATH additions herdr and ssh are spawned with. The
 * entry on the root shows the active runtime.
 */

import type { SettingDefinitionPage, SettingDefinitionRender } from 'obsidian';
import type { HerdrSettings } from '../settings';
import { activeRuntimeOf, runtimeDisplayName } from '../runtimes';
import type { ControlKey } from './effects';

export function runtimesPage(
	settings: () => HerdrSettings,
	list: SettingDefinitionRender,
): SettingDefinitionPage<ControlKey> {
	return {
		type: 'page',
		name: 'Runtimes',
		desc: 'Which herdr, herdr-core or Claude to connect to, on this machine or over SSH.',
		displayValue: () => runtimeDisplayName(activeRuntimeOf(settings())),
		items: [
			{ type: 'group', items: [list] },
			{
				type: 'group',
				heading: 'Connection',
				items: [
					{
						name: 'Extra PATH entries',
						desc: 'Colon-separated directories appended to PATH when the plugin spawns herdr, for tools your agents need.',
						control: { type: 'text', key: 'extraPath', placeholder: '/opt/homebrew/bin:/usr/local/bin' },
					},
				],
			},
		],
	};
}
