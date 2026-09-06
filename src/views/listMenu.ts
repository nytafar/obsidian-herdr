/**
 * The agent list's own sort and group-by menu (issue #41).
 *
 * Sort and grouping (issue #20) were settings-only, which is two clicks and a
 * different window away from the list they reorder. Obsidian's file explorer
 * puts the same pair behind one header icon and a `Menu`, and this is that menu's
 * content: which entries there are, what they are called, which one is ticked and
 * what choosing one writes.
 *
 * Pure on purpose, like `rowModel.ts`: no `obsidian` import, no plugin, no DOM,
 * so the entries are unit tested (`tests/listMenu.test.ts`) and the view is left
 * with nothing but `Menu.addItem`. The settings types come in as types only, so
 * nothing here pulls `settings.ts` (and through it `obsidian`) into the bundle
 * twice or into a test.
 */

import type { AgentListGroupBy, AgentListSort } from '../settings';

/**
 * The slice of the settings this menu reads and writes. Structural rather than
 * the whole `HerdrSettings`, so a test can hand it two fields and no plugin.
 */
export interface ListMenuSettings {
	agentListSort: AgentListSort;
	agentListGroupBy: AgentListGroupBy;
}

/** Which half of the menu an entry belongs to. The view draws them in order. */
export type ListMenuSection = 'sort' | 'group';

/** Heading above each half, shown as a non-clickable label. Sentence case. */
export const SECTION_LABEL: Record<ListMenuSection, string> = {
	sort: 'Sort',
	group: 'Group by',
};

/** One menu entry: what it says, whether it is the current choice, what it does. */
export interface ListMenuItem {
	section: ListMenuSection;
	/** Entry text, sentence case like all UI. */
	label: string;
	/** True for the value in effect; the view renders it with `setChecked`. */
	checked: boolean;
	/** Writes the choice. The caller saves the settings and repaints. */
	apply: (settings: ListMenuSettings) => void;
}

/**
 * Sort options in menu order, and what each is called. Shorter than the settings
 * tab's wording, which has a description line to lean on; the meaning is the
 * same, and `settings.ts` stays the place that explains them.
 */
const SORT_OPTIONS: readonly (readonly [AgentListSort, string])[] = [
	['priority', 'Priority'],
	['alphabetical', 'Alphabetical'],
];

/** Grouping options in menu order. */
const GROUP_OPTIONS: readonly (readonly [AgentListGroupBy, string])[] = [
	['tab', 'Herdr tab'],
	['folder', 'Working directory'],
	['none', 'Nothing'],
];

/**
 * Every entry the list's header menu shows, sort entries first, each carrying
 * the writer for its own value. Reading the current settings here is what makes
 * `checked` right without the view comparing anything.
 */
export function listMenuItems(settings: ListMenuSettings): ListMenuItem[] {
	const sort: ListMenuItem[] = SORT_OPTIONS.map(([value, label]) => ({
		section: 'sort',
		label,
		checked: settings.agentListSort === value,
		apply: (target) => {
			target.agentListSort = value;
		},
	}));
	const group: ListMenuItem[] = GROUP_OPTIONS.map(([value, label]) => ({
		section: 'group',
		label,
		checked: settings.agentListGroupBy === value,
		apply: (target) => {
			target.agentListGroupBy = value;
		},
	}));
	return [...sort, ...group];
}
