/**
 * The agent row's context menu (issue #35): what it contains and what each
 * entry asks for.
 *
 * Three entries, in the order the hand reaches for them: pin or unpin the row
 * at the top of its group, rename the agent, close the pane. Pin is client-side
 * and lands in the settings (`pinnedPanes`, keyed by endpoint); rename is
 * `agent.rename` with a `pane.rename` fallback and close is `pane.close`, both
 * in `actions.ts`. Close kills whatever runs in the pane, so it is the one
 * entry that asks first, and it is drawn as a warning; rename needs a name, so
 * it asks too. The two modals live in `modals.ts`.
 *
 * Pure like `listMenu.ts`: no `obsidian` import, no plugin, no DOM. This module
 * says what to draw and which `RowMenuAction` a choice means; the view maps the
 * action onto the modal and the plugin call, and `tests/rowMenu.test.ts` checks
 * the entries without a document.
 */

/** What choosing an entry means. The view dispatches on this, nothing else. */
export type RowMenuAction = 'pin' | 'unpin' | 'rename' | 'close';

/** The slice of a row this menu reads. `RowModel` satisfies it. */
export interface RowMenuRow {
	paneId: string;
	displayName: string;
	pinned: boolean;
	/**
	 * The agent's herdr name, when the caller knows it. `displayName` falls back
	 * to the terminal title or the pane id for an unnamed agent, and neither
	 * makes a sensible starting value for a rename.
	 */
	name?: string;
}

/** One entry of the context menu. */
export interface RowMenuItem {
	action: RowMenuAction;
	/** Entry text, sentence case like all UI. */
	label: string;
	/** Lucide icon name. */
	icon: string;
	/** Drawn as a warning (`setWarning`) because it destroys something. */
	warning: boolean;
	/** A separator is drawn above this entry. */
	separatorBefore: boolean;
}

/** The entries for one row, in menu order. */
export function rowMenuItems(row: RowMenuRow): RowMenuItem[] {
	return [
		{
			action: row.pinned ? 'unpin' : 'pin',
			label: row.pinned ? 'Unpin from top of group' : 'Pin to top of group',
			icon: row.pinned ? 'pin-off' : 'pin',
			warning: false,
			separatorBefore: false,
		},
		{
			action: 'rename',
			label: 'Rename agent',
			icon: 'pencil',
			warning: false,
			separatorBefore: false,
		},
		{
			action: 'close',
			label: 'Terminate agent',
			icon: 'x',
			warning: true,
			separatorBefore: true,
		},
	];
}

/**
 * What the close confirmation says. The name is quoted so a row called `notes`
 * and one called `notes-2` cannot be confused at the moment it matters.
 */
export function closeConfirmation(row: RowMenuRow): { title: string; body: string; confirm: string } {
	return {
		title: `Terminate "${row.displayName}"?`,
		body: `Terminate ${row.displayName}? This closes its herdr pane.`,
		confirm: 'Terminate agent',
	};
}

/**
 * What the rename prompt says. The agent's own name is the starting value; an
 * agent herdr never named starts blank rather than with its title or pane id.
 */
export function renamePrompt(row: RowMenuRow): {
	title: string;
	label: string;
	initial: string;
	confirm: string;
} {
	return {
		title: 'Rename agent',
		label: 'Lowercase letters, digits, hyphen and underscore; herdr refuses anything else.',
		initial: row.name ?? '',
		confirm: 'Rename',
	};
}
