/**
 * Row model for the agent list (PRD M8; issue #16).
 *
 * Everything the sidebar decides about *what* a row says lives here, and nothing
 * about *how* it is drawn: no DOM, no `obsidian` import, no plugin reference.
 * `AgentListView` calls {@link buildRows} once per repaint and then only creates
 * elements, which keeps grouping, ordering and the display-name fallbacks
 * testable without a document (see `tests/rowModel.test.ts`).
 *
 * Queued features — kind icons, sort options, home-relative paths and the cache
 * TTL badge — are changes to this file, not to the render path.
 */

import { isUnder, type PaneState } from '../herdr/scope';
import type { AgentStatus } from '../herdr/types.gen';

/** Order agents are shown in: the ones wanting attention float to the top. */
export const STATUS_ORDER: Record<AgentStatus, number> = {
	blocked: 0,
	done: 1,
	working: 2,
	idle: 3,
	unknown: 4,
};

/** A status the table above does not know sorts last, never in the middle. */
const STATUS_ORDER_FALLBACK = 9;

/** Screen-reader text per status; the glyph itself is CSS (`styles.css`). */
export const STATUS_LABEL: Record<AgentStatus, string> = {
	blocked: 'Blocked',
	done: 'Done',
	working: 'Working',
	idle: 'Idle',
	unknown: 'Unknown',
};

/** Everything one row displays. The view adds no facts of its own. */
export interface RowModel {
	paneId: string;
	/** `pane.agent`, the kind ("claude"). The same on every row today; not a name. */
	kind: string;
	displayName: string;
	/**
	 * The stripped terminal title, or empty when it merely repeats the display
	 * name — the view suppresses that duplicate, so the decision belongs here.
	 */
	title: string;
	/** The cwd as shown: vault-relative inside the vault, absolute outside it. */
	pathLabel: string;
	status: AgentStatus;
	/** Accessible text for the status glyph. */
	statusLabel: string;
	focused: boolean;
	/** Short trailing markers. Empty today; the cache TTL issue fills it. */
	badges: string[];
}

/** Rows under one heading. `key` is the herdr tab id while grouping is by tab. */
export interface RowGroup {
	key: string;
	label: string;
	rows: RowModel[];
}

/**
 * Presentation choices that are settings-shaped but not settings yet. Declared
 * here rather than in `src/settings.ts` so the sort and grouping issues can add
 * a real setting without this module having to change shape first.
 */
export interface RowModelOptions {
	/** Only `tab` today; PRD M8 groups by herdr tab. */
	groupBy?: 'tab';
	/** Only `status` today: blocked, done, then the rest. */
	sort?: 'status';
}

const DEFAULTS: Required<RowModelOptions> = { groupBy: 'tab', sort: 'status' };

type GroupBy = Required<RowModelOptions>['groupBy'];
type SortBy = Required<RowModelOptions>['sort'];

/**
 * What a row calls an agent (PRD M8): its herdr name, else the stripped terminal
 * title, else the pane id. Never `pane.agent`, which is only the kind.
 */
export function agentDisplayName(pane: PaneState): string {
	return pane.name.trim() || pane.title.trim() || pane.paneId;
}

/** Counts the statuses the status bar cares about (PRD S11). */
export function countStatuses(panes: readonly PaneState[]): { blocked: number; done: number } {
	let blocked = 0;
	let done = 0;
	for (const pane of panes) {
		if (pane.agentStatus === 'blocked') blocked++;
		else if (pane.agentStatus === 'done') done++;
	}
	return { blocked, done };
}

/**
 * The cwd as shown in a row: relative to the vault when it sits inside it, the
 * absolute path otherwise (a herdr pane may well run outside the vault). The
 * vault root itself renders as an empty string, since repeating the vault name
 * on every row says nothing.
 */
export function relativeCwd(cwd: string, vaultPath: string): string {
	if (!cwd) return '';
	const root = vaultPath.replace(/\/+$/, '');
	if (!root || !isUnder(cwd, root)) return cwd;
	return cwd.slice(root.length).replace(/^\/+/, '');
}

function statusRank(status: AgentStatus): number {
	return STATUS_ORDER[status] ?? STATUS_ORDER_FALLBACK;
}

/**
 * Which heading a pane falls under. One entry today; a "group by cwd" or
 * "no grouping" option becomes another entry here and nothing else.
 */
const GROUP_KEY: Record<GroupBy, (pane: PaneState) => string> = {
	tab: (pane) => pane.tabId,
};

/**
 * Row order inside a group. `status` is the only one today: blocked first, then
 * done, then the rest; ties break on title and finally on pane id, so the list
 * does not shuffle when two rows are otherwise equal.
 */
const COMPARE: Record<SortBy, (a: PaneState, b: PaneState) => number> = {
	status: (a, b) =>
		statusRank(a.agentStatus) - statusRank(b.agentStatus) ||
		a.title.localeCompare(b.title) ||
		a.paneId.localeCompare(b.paneId),
};

/** Projects one pane onto the row it becomes. */
export function toRow(pane: PaneState, vaultPath: string): RowModel {
	const displayName = agentDisplayName(pane);
	return {
		paneId: pane.paneId,
		kind: pane.agent,
		displayName,
		title: pane.title && pane.title !== displayName ? pane.title : '',
		pathLabel: relativeCwd(pane.cwd, vaultPath),
		status: pane.agentStatus,
		statusLabel: STATUS_LABEL[pane.agentStatus] ?? pane.agentStatus,
		focused: pane.focused,
		badges: [],
	};
}

/**
 * Groups panes into the rows the sidebar draws, in display order: tabs by their
 * most urgent pane then by label, panes by status then title then pane id (the
 * pane id last so the order is stable when two rows tie).
 *
 * @param tabLabels tab id → label from `tab.list`; missing ids fall back to the
 *   id itself, which is what a row shows until the labels land.
 */
export function buildRows(
	panes: readonly PaneState[],
	tabLabels: ReadonlyMap<string, string>,
	vaultPath: string,
	options: RowModelOptions = {},
): RowGroup[] {
	const { groupBy, sort } = { ...DEFAULTS, ...options };
	const keyOf = GROUP_KEY[groupBy] ?? GROUP_KEY.tab;
	// One sort up front: it fixes the row order inside every group and, because
	// the most urgent pane of a tab is then its first, the group order too.
	const ordered = [...panes].sort(COMPARE[sort] ?? COMPARE.status);

	const groups = new Map<string, { group: RowGroup; urgency: number }>();
	for (const pane of ordered) {
		const key = keyOf(pane);
		let entry = groups.get(key);
		if (!entry) {
			entry = {
				group: {
					key,
					label: tabLabels.get(key) ?? key,
					rows: [],
				},
				// `ordered` is sorted, so the first pane of a tab is its most urgent.
				urgency: statusRank(pane.agentStatus),
			};
			groups.set(key, entry);
		}
		entry.group.rows.push(toRow(pane, vaultPath));
	}

	return [...groups.values()]
		.sort((a, b) => a.urgency - b.urgency || a.group.label.localeCompare(b.group.label))
		.map((entry) => entry.group);
}

/**
 * The two things a row can do (PRD M9, M13; issue #21): open the pane as a
 * terminal view in Obsidian, or focus it in the herdr TUI. One sits on the row
 * body and the other on the icon button, and a setting decides which is which.
 */
export type RowClickAction = 'terminal' | 'focus';

/** Narrows a value from the DOM or from `data.json`, neither of them trusted. */
export function isRowClickAction(value: unknown): value is RowClickAction {
	return value === 'terminal' || value === 'focus';
}

/** How the pair is split across a row, and what the icon button then says. */
export interface RowActions {
	/** What clicking (or pressing Enter on) the row body does. */
	body: RowClickAction;
	/** What the icon button does: always the other half of the pair. */
	button: RowClickAction;
	/** Lucide icon for the button, following its action. */
	buttonIcon: string;
	/** Tooltip and `aria-label` for the button; sentence case, like all UI. */
	buttonLabel: string;
}

const ACTION_ICON: Record<RowClickAction, string> = {
	terminal: 'square-terminal',
	// An arrow leaving the corner: this jumps out of Obsidian and into herdr.
	focus: 'arrow-up-right',
};

const ACTION_LABEL: Record<RowClickAction, string> = {
	terminal: 'Open terminal',
	focus: 'Focus in herdr',
};

/**
 * Splits the pair according to the setting. The default is `terminal` on the
 * body: opening the terminal is the common move, and before issue #21 it was the
 * one hidden behind the small icon.
 *
 * An unrecognised value falls back to that default rather than throwing — this
 * reads a stored setting, and a hand-edited `data.json` should not break a row.
 */
export function rowActions(rowClick: RowClickAction): RowActions {
	const body: RowClickAction = rowClick === 'focus' ? 'focus' : 'terminal';
	const button: RowClickAction = body === 'terminal' ? 'focus' : 'terminal';
	return {
		body,
		button,
		buttonIcon: ACTION_ICON[button],
		buttonLabel: ACTION_LABEL[button],
	};
}
