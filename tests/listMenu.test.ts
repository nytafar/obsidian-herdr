/**
 * The agent list's header menu (issue #41). The `Menu` itself is Obsidian's, so
 * what is worth testing is the content: the two sections, in order, the tick on
 * the value in effect, and that choosing an entry writes that value and nothing
 * else. `AgentListView` does no more than turn these into `Menu.addItem` calls.
 */

import { describe, expect, it } from 'vitest';
import { SECTION_LABEL, listMenuItems, type ListMenuSettings } from '../src/views/listMenu';

function settings(overrides: Partial<ListMenuSettings> = {}): ListMenuSettings {
	return { agentListSort: 'priority', agentListGroupBy: 'tab', ...overrides };
}

describe('listMenuItems', () => {
	it('offers both sorts and all three groupings, sorts first', () => {
		const items = listMenuItems(settings());
		expect(items.map((item) => item.section)).toEqual([
			'sort',
			'sort',
			'group',
			'group',
			'group',
		]);
		expect(items.map((item) => item.label)).toEqual([
			'Priority',
			'Alphabetical',
			'Herdr tab',
			'Working directory',
			'Nothing',
		]);
	});

	it('ticks exactly the value in effect, one per section', () => {
		const items = listMenuItems(
			settings({ agentListSort: 'alphabetical', agentListGroupBy: 'folder' }),
		);
		const checked = items.filter((item) => item.checked);
		expect(checked.map((item) => item.label)).toEqual(['Alphabetical', 'Working directory']);
	});

	it('writes only its own setting when applied', () => {
		const current = settings();
		const folder = listMenuItems(current).find((item) => item.label === 'Working directory');
		folder?.apply(current);
		expect(current).toEqual({ agentListSort: 'priority', agentListGroupBy: 'folder' });

		const alphabetical = listMenuItems(current).find((item) => item.label === 'Alphabetical');
		alphabetical?.apply(current);
		expect(current).toEqual({ agentListSort: 'alphabetical', agentListGroupBy: 'folder' });
	});

	it('names both sections in sentence case', () => {
		expect(SECTION_LABEL).toEqual({ sort: 'Sort', group: 'Group by' });
	});
});
