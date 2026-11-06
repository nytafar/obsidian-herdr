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
 * On a runtime whose agents are the plugin's own processes (the `claude`
 * kind, ADR-0007) close is "Stop agent", since the row stays as a stopped,
 * resumable session; a stopped row gets "Forget agent" instead, which removes
 * it; and "Continue in herdr" or "Continue in herdr-core" moves the
 * conversation to such a runtime when one is configured.
 *
 * Pure like `listMenu.ts`: no `obsidian` import, no plugin, no DOM. This module
 * says what to draw and which `RowMenuAction` a choice means; the view maps the
 * action onto the modal and the plugin call, and `tests/rowMenu.test.ts` checks
 * the entries without a document.
 */

/** What choosing an entry means. The view dispatches on this, nothing else. */
export type RowMenuAction = 'pin' | 'unpin' | 'rename' | 'close' | 'forget' | 'continue';

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
	/** The row is a stored session with no process (ADR-0007). */
	stopped?: boolean;
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
	/** The runtime a `continue` entry moves the agent to. */
	runtimeId?: string;
}

/** A runtime a row can graduate to (ADR-0007), as its menu entry names it. */
export interface GraduationTarget {
	id: string;
	/** "herdr", or "herdr-core (hc)", with the runtime's name when the kind has several. */
	label: string;
}

/**
 * Which entries the row's runtime can back (ADR-0004). herdr has both;
 * herdr-core has no rename (ADR-0005). Pin is client-side and always there.
 */
export interface RowMenuCapabilities {
	rename: boolean;
	close: boolean;
	/** Rows are the plugin's own, resumable sessions (ADR-0007). */
	resumable?: boolean;
	/** Where a resumable row can continue; empty or absent for none. */
	graduation?: readonly GraduationTarget[];
}

const EVERY_ENTRY: RowMenuCapabilities = { rename: true, close: true };

/**
 * The entries for one row, in menu order, minus what the runtime cannot do:
 * an entry that is left out reads better than one that is offered and refused.
 */
export function rowMenuItems(
	row: RowMenuRow,
	can: RowMenuCapabilities = EVERY_ENTRY,
): RowMenuItem[] {
	const items: RowMenuItem[] = [
		{
			action: row.pinned ? 'unpin' : 'pin',
			label: row.pinned ? 'Unpin from top of group' : 'Pin to top of group',
			icon: row.pinned ? 'pin-off' : 'pin',
			warning: false,
			separatorBefore: false,
		},
	];
	if (can.rename) {
		items.push({
			action: 'rename',
			label: 'Rename agent',
			icon: 'pencil',
			warning: false,
			separatorBefore: false,
		});
	}
	if (can.resumable) {
		for (const target of can.graduation ?? []) {
			items.push({
				action: 'continue',
				label: `Continue in ${target.label}`,
				icon: 'arrow-right-left',
				warning: false,
				separatorBefore: false,
				runtimeId: target.id,
			});
		}
		if (row.stopped) {
			items.push({
				action: 'forget',
				label: 'Forget agent',
				icon: 'trash-2',
				warning: true,
				separatorBefore: true,
			});
		} else if (can.close) {
			items.push({
				action: 'close',
				label: 'Stop agent',
				icon: 'square',
				warning: true,
				separatorBefore: true,
			});
		}
		return items;
	}
	if (can.close) {
		items.push({
			action: 'close',
			label: 'Terminate agent',
			icon: 'x',
			warning: true,
			separatorBefore: true,
		});
	}
	return items;
}

/** What the terminate confirmation says. The view draws it as a warning. */
export interface CloseConfirmText {
	title: string;
	body: string;
	/** Text on the confirming button. Sentence case. */
	confirm: string;
}

/** What the rename prompt says, and what it starts from. */
export interface RenamePromptText {
	title: string;
	/** Line under the input explaining what herdr accepts. */
	label: string;
	initial: string;
	/** Text on the confirming button. Sentence case. */
	confirm: string;
}

/**
 * What the close confirmation says. The name is quoted so a row called `notes`
 * and one called `notes-2` cannot be confused at the moment it matters.
 */
export function closeConfirmation(row: RowMenuRow, resumable = false): CloseConfirmText {
	if (resumable) {
		return {
			title: `Stop "${row.displayName}"?`,
			body: `Stop ${row.displayName}? A running turn is interrupted. The conversation is kept, and opening or prompting the agent resumes it.`,
			confirm: 'Stop agent',
		};
	}
	return {
		title: `Terminate "${row.displayName}"?`,
		body: `Terminate ${row.displayName}? This closes its herdr pane.`,
		confirm: 'Terminate agent',
	};
}

/** What the forget confirmation says (ADR-0007). */
export function forgetConfirmation(row: RowMenuRow): CloseConfirmText {
	return {
		title: `Forget "${row.displayName}"?`,
		body: `Remove ${row.displayName} from the list? The plugin can no longer resume it. Claude keeps the transcript in its projects folder.`,
		confirm: 'Forget agent',
	};
}

/** What the graduation confirmation says (ADR-0007). */
export function continueConfirmation(row: RowMenuRow, target: GraduationTarget): CloseConfirmText {
	return {
		title: `Continue "${row.displayName}" in ${target.label}?`,
		body: `This stops ${row.displayName} here, starts claude --resume in the same folder on ${target.label}, and switches the agent list there.`,
		confirm: 'Continue',
	};
}

/**
 * What the rename prompt says. The agent's own name is the starting value; an
 * agent herdr never named starts blank rather than with its title or pane id.
 */
export function renamePrompt(row: RowMenuRow): RenamePromptText {
	return {
		title: 'Rename agent',
		label: 'Lowercase letters, digits, hyphen and underscore; herdr refuses anything else.',
		initial: row.name ?? '',
		confirm: 'Rename',
	};
}
