/**
 * Row model for the agent list (PRD M8; issue #16).
 *
 * Everything the sidebar decides about *what* a row says lives here, and nothing
 * about *how* it is drawn: no DOM, no `obsidian` import, no plugin reference.
 * `AgentListView` calls {@link buildRows} once per repaint and then only creates
 * elements, which keeps grouping, ordering and the display-name fallbacks
 * testable without a document (see `tests/rowModel.test.ts`).
 *
 * Sort and grouping (issue #20), the home-relative path (#22) and the cache TTL
 * badge (#23) all landed here rather than in the render path, which is the point
 * of the split. The badge itself since moved one level down, to
 * `herdr/cacheBadge.ts`, because the scope needs the same answer.
 */

import { lastPathSegment, trimTrailingSlashes } from '../paths';
import { cacheBadge, type RowBadge } from '../herdr/cacheBadge';
import { isUnder, type PaneState } from '../herdr/scope';
import type { AgentStatus } from '../herdr/types.gen';

// A badge's shape is part of what a row says, so the types belong to this
// module's vocabulary; the code behind them sits under `herdr/` because the
// scope needs it too — it asks whether a token change moves the badge before it
// calls a pane changed (PRD N4), and `herdr/scope.ts` may not import a view.
export type { BadgeTone, RowBadge } from '../herdr/cacheBadge';

/**
 * Order agents are shown in: the ones wanting attention float to the top.
 *
 * This is herdr's own `tab_attention_priority` read the other way up — herdr
 * scores blocked 4, unseen-idle 3 (the API calls it `done`), working 2,
 * seen-idle 1 and unknown 0, highest first — so the sidebar and the herdr TUI
 * with `agent_panel_sort = "priority"` agree row for row.
 */
export const STATUS_ORDER: Record<AgentStatus, number> = {
	blocked: 0,
	done: 1,
	working: 2,
	idle: 3,
	unknown: 4,
};

/** A status the table above does not know sorts last, never in the middle. */
const STATUS_ORDER_FALLBACK = 9;

/** Screen-reader text per status; the colour it goes with is CSS (`styles.css`). */
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
	/**
	 * The cwd as shown: vault-relative inside the vault, `~/…` under the home
	 * directory, absolute otherwise (issue #22).
	 */
	pathLabel: string;
	status: AgentStatus;
	/** Accessible text for the status, said by the kind icon's label (issue #34). */
	statusLabel: string;
	focused: boolean;
	/** Short trailing markers, in display order. The cache countdown today. */
	badges: RowBadge[];
}

/**
 * Rows under one heading. `key` is the herdr tab id, the cwd or the empty string
 * depending on the grouping, and an empty `label` means the view draws no header
 * at all (grouping "none").
 */
export interface RowGroup {
	key: string;
	label: string;
	rows: RowModel[];
}

/**
 * Presentation choices, all of them settings (`agentListGroupBy`,
 * `agentListSort`) except the home path, which the plugin resolves. The view
 * reads them on every repaint, so changing one reorders the list without a
 * reconnect (issue #20).
 */
export interface RowModelOptions {
	/**
	 * Heading each row falls under: the herdr tab (PRD M8, the default), the
	 * pane's working directory, or nothing at all.
	 */
	groupBy?: 'tab' | 'folder' | 'none';
	/** Row order inside a group: herdr's attention priority, or by name. */
	sort?: 'priority' | 'alphabetical';
	/**
	 * Home directory on the machine herdr runs on, used to shorten a cwd that
	 * sits outside the vault (issue #22). Empty leaves such paths absolute.
	 */
	homePath?: string;
}

const DEFAULTS: Required<RowModelOptions> = {
	groupBy: 'tab',
	sort: 'priority',
	homePath: '',
};

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
	const root = trimTrailingSlashes(vaultPath);
	if (!root || !isUnder(cwd, root)) return cwd;
	return cwd.slice(root.length).replace(/^\/+/, '');
}

/**
 * The cwd as a row shows it (issue #22): vault-relative inside the vault, then
 * `~/…` when it sits under the user's home, and absolute when it is neither.
 * The home directory itself is `~`, and the vault root stays empty — repeating
 * the vault name on every row says nothing.
 *
 * The home is herdr's home, so under a remote profile it is the remote user's
 * (`main.ts` picks which one). The vault wins over the home, because a vault
 * inside the home would otherwise lose its short relative paths.
 */
export function pathLabel(cwd: string, vaultPath: string, homePath = ''): string {
	if (!cwd) return '';
	const root = trimTrailingSlashes(vaultPath);
	if (root && isUnder(cwd, root)) return relativeCwd(cwd, root);
	const home = trimTrailingSlashes(homePath);
	if (!home || !isUnder(cwd, home)) return cwd;
	const rest = cwd.slice(home.length).replace(/^\/+/, '');
	return rest ? `~/${rest}` : '~';
}

function statusRank(status: AgentStatus): number {
	return STATUS_ORDER[status] ?? STATUS_ORDER_FALLBACK;
}

/** One grouping option: how a pane is keyed into a group, and what it is called. */
interface Grouping {
	key: (pane: PaneState) => string;
	label: (pane: PaneState, ctx: GroupContext) => string;
}

/** What a grouping needs besides the pane to name its heading. */
interface GroupContext {
	tabLabels: ReadonlyMap<string, string>;
	vaultPath: string;
	homePath: string;
}

/**
 * Which heading a pane falls under, and what that heading says. Grouping by tab
 * is PRD M8 and the default; grouping by folder keeps one project's agents
 * together even after herdr has spread them over two tabs (issue #20), and
 * `none` is a single unlabelled group, which the view renders without a header.
 */
const GROUPS: Record<GroupBy, Grouping> = {
	tab: {
		key: (pane) => pane.tabId,
		label: (pane, ctx) => ctx.tabLabels.get(pane.tabId) ?? pane.tabId,
	},
	folder: {
		key: (pane) => pane.cwd,
		label: (pane, ctx) => {
			if (!pane.cwd) return 'No folder';
			// The same label a row's path shows, so the two never disagree. At the
			// vault root that is empty, where the vault's own name reads better.
			return (
				pathLabel(pane.cwd, ctx.vaultPath, ctx.homePath) ||
				lastPathSegment(ctx.vaultPath) ||
				pane.cwd
			);
		},
	},
	none: { key: () => '', label: () => '' },
};

/**
 * Row order inside a group.
 *
 * `priority` is herdr's: blocked, then done (its unseen-idle), then working,
 * then idle, then unknown, tie-broken by the most recent status change first —
 * `statusChangedSeq`, which the scope counts because `pane.list` does not carry
 * herdr's own sequence. `alphabetical` is by display name with a locale compare.
 * Both end on title and pane id so a tie never shuffles between repaints.
 */
const COMPARE: Record<SortBy, (a: PaneState, b: PaneState) => number> = {
	priority: (a, b) =>
		statusRank(a.agentStatus) - statusRank(b.agentStatus) ||
		b.statusChangedSeq - a.statusChangedSeq ||
		a.title.localeCompare(b.title) ||
		a.paneId.localeCompare(b.paneId),
	alphabetical: (a, b) =>
		agentDisplayName(a).localeCompare(agentDisplayName(b)) ||
		a.title.localeCompare(b.title) ||
		a.paneId.localeCompare(b.paneId),
};

/** Every badge a row shows, in display order. Only the cache countdown today. */
function badges(pane: PaneState): RowBadge[] {
	const cache = cacheBadge(pane.tokens);
	return cache ? [cache] : [];
}

/**
 * Projects one pane onto the row it becomes.
 *
 * @param showPath false leaves `pathLabel` empty (issue #39). Grouping by folder
 *   puts that very path in the group header, and a row that repeats its own
 *   heading says nothing; every other grouping keeps the line.
 */
export function toRow(
	pane: PaneState,
	vaultPath: string,
	homePath = '',
	showPath = true,
): RowModel {
	const displayName = agentDisplayName(pane);
	return {
		paneId: pane.paneId,
		kind: pane.agent,
		displayName,
		title: pane.title && pane.title !== displayName ? pane.title : '',
		pathLabel: showPath ? pathLabel(pane.cwd, vaultPath, homePath) : '',
		status: pane.agentStatus,
		statusLabel: STATUS_LABEL[pane.agentStatus] ?? pane.agentStatus,
		focused: pane.focused,
		badges: badges(pane),
	};
}

/**
 * Groups panes into the rows the sidebar draws, in display order: groups by
 * their most urgent row and then by label, rows by the chosen sort.
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
	const { groupBy, sort, homePath } = { ...DEFAULTS, ...options };
	const grouping = GROUPS[groupBy] ?? GROUPS.tab;
	// Grouping by folder already names the folder above the rows (issue #39).
	const showPath = groupBy !== 'folder';
	const context: GroupContext = { tabLabels, vaultPath, homePath };
	// One sort up front fixes the row order inside every group.
	const ordered = [...panes].sort(COMPARE[sort] ?? COMPARE.priority);

	const groups = new Map<string, { group: RowGroup; urgency: number }>();
	for (const pane of ordered) {
		const key = grouping.key(pane);
		const urgency = statusRank(pane.agentStatus);
		let entry = groups.get(key);
		if (!entry) {
			entry = {
				group: { key, label: grouping.label(pane, context), rows: [] },
				urgency,
			};
			groups.set(key, entry);
		} else if (urgency < entry.urgency) {
			// Not simply the first row: an alphabetical group's first row says
			// nothing about how urgent the group is.
			entry.urgency = urgency;
		}
		entry.group.rows.push(toRow(pane, vaultPath, homePath, showPath));
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
