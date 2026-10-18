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
 *
 * Where an agent is live (issue #76) is decided here too: the view hands over
 * the open terminal tabs and the active one as plain data, so the emphasis
 * tiers are tested without a workspace.
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
	 * The cwd as shown: vault-relative inside the vault, and outside it the last
	 * two segments of the `~/…` or absolute form (issues #22, #46).
	 */
	pathLabel: string;
	/**
	 * The full path behind an abridged `pathLabel`, empty when nothing was cut.
	 * The view hangs it off the path element as `title` and `aria-label`.
	 */
	pathTooltip: string;
	status: AgentStatus;
	/** Accessible text for the status, said by the kind icon's label (issue #34). */
	statusLabel: string;
	focused: boolean;
	/** True when the row is pinned to the top of its group (issue #35). */
	pinned: boolean;
	/** Short markers drawn before the name, in display order. The cache countdown today. */
	badges: RowBadge[];
	/** Whether a terminal tab shows this agent, and whether it is the active tab (issue #76). */
	terminal: TerminalTier;
	/**
	 * How strongly the icon button stays visible without hover: it carries the
	 * button's own surface, so the icon never means anything but its click.
	 */
	iconTier: LiveTier;
	/** How strongly the row background is painted: it carries the body's surface. */
	backgroundTier: LiveTier;
	/** This agent's terminal is the active tab; the view sets `aria-current`. */
	current: boolean;
}

/**
 * Rows under one heading. `key` is the herdr tab id, the cwd or the empty string
 * depending on the grouping, and an empty `label` means the view draws no header
 * at all (grouping "none").
 */
export interface RowGroup {
	key: string;
	label: string;
	/** Full path behind an abridged folder label; empty for every other grouping. */
	tooltip: string;
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
	/**
	 * Pane ids pinned on the connected endpoint (issue #35). A pinned row sorts
	 * above every unpinned row of its group whatever the sort; among themselves
	 * the pinned rows follow that same sort. Empty pins nothing.
	 */
	pinnedPaneIds?: readonly string[];
	/**
	 * The row-click setting (issue #21). It decides which surface the icon and
	 * which the background carry (issue #76), since each follows its own click.
	 */
	rowClick?: RowClickAction;
	/** The endpoint the panes belong to; a terminal elsewhere is another agent. */
	endpointId?: string;
	/** Every terminal tab open in the workspace, on whichever endpoint (issue #76). */
	openTerminals?: readonly TerminalRef[];
	/** The terminal in the active tab, or null when the active tab is not one. */
	activeTerminal?: TerminalRef | null;
}

const DEFAULTS: Required<RowModelOptions> = {
	groupBy: 'tab',
	sort: 'priority',
	homePath: '',
	pinnedPaneIds: [],
	rowClick: 'terminal',
	endpointId: '',
	openTerminals: [],
	activeTerminal: null,
};

type GroupBy = Required<RowModelOptions>['groupBy'];
type SortBy = Required<RowModelOptions>['sort'];

/**
 * What a row calls an agent (PRD M8): its herdr name, else the stripped terminal
 * title, else the pane id. Never `pane.agent`, which is only the kind.
 */
export function agentDisplayName(pane: Pick<PaneState, 'paneId' | 'name' | 'title'>): string {
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
 * The unabridged cwd label (issue #22): vault-relative inside the vault, then
 * `~/…` when it sits under the user's home, and absolute when it is neither.
 * The home directory itself is `~`, and the vault root stays empty — repeating
 * the vault name on every row says nothing.
 *
 * The home is herdr's home, so under a remote profile it is the remote user's
 * (`main.ts` picks which one). The vault wins over the home, because a vault
 * inside the home would otherwise lose its short relative paths.
 */
export function fullPathLabel(cwd: string, vaultPath: string, homePath = ''): string {
	if (!cwd) return '';
	const root = trimTrailingSlashes(vaultPath);
	if (root && isUnder(cwd, root)) return relativeCwd(cwd, root);
	const home = trimTrailingSlashes(homePath);
	if (!home || !isUnder(cwd, home)) return cwd;
	const rest = cwd.slice(home.length).replace(/^\/+/, '');
	return rest ? `~/${rest}` : '~';
}

/**
 * How many trailing segments a shortened outside-the-vault label keeps. Two is
 * enough to tell `Vaults/hvelv` from `Vaults/notes` and still fits the sidebar.
 */
const OUTSIDE_SEGMENTS = 2;

/**
 * The cwd as a row shows it (issues #22, #46): vault-relative inside the vault —
 * the vault root itself stays empty — and, outside it, only the last two
 * segments of the {@link fullPathLabel}, with the full label offered as the
 * tooltip by {@link pathTooltip}.
 *
 * Every agent in a snapshot vault runs against the same foreign root, so the
 * long form repeated `~/Vaults/hvelv` on every row and said nothing. A label
 * already at two segments or fewer is left exactly as it was, keeping `/opt/x`,
 * `~/code` and `~` whole rather than trading a leading slash for nothing.
 */
export function pathLabel(cwd: string, vaultPath: string, homePath = ''): string {
	const label = fullPathLabel(cwd, vaultPath, homePath);
	const root = trimTrailingSlashes(vaultPath);
	// Inside the vault the label is already relative to something the reader
	// knows; only foreign roots are worth cutting.
	if (root && cwd && isUnder(cwd, root)) return label;
	const segments = label.split('/').filter((segment) => segment !== '');
	if (segments.length <= OUTSIDE_SEGMENTS) return label;
	return segments.slice(-OUTSIDE_SEGMENTS).join('/');
}

/**
 * The full path behind a shortened {@link pathLabel}, or the empty string when
 * nothing was cut. The view puts it on `title` and `aria-label`, so a row never
 * hides which of two similarly named roots it is in.
 */
export function pathTooltip(cwd: string, vaultPath: string, homePath = ''): string {
	const full = fullPathLabel(cwd, vaultPath, homePath);
	return full === pathLabel(cwd, vaultPath, homePath) ? '' : full;
}

function statusRank(status: AgentStatus): number {
	return STATUS_ORDER[status] ?? STATUS_ORDER_FALLBACK;
}

/** One grouping option: how a pane is keyed into a group, and what it is called. */
interface Grouping {
	key: (pane: PaneState) => string;
	label: (pane: PaneState, ctx: GroupContext) => string;
	/** Full path behind an abridged label, empty when there is nothing to add. */
	tooltip?: (pane: PaneState, ctx: GroupContext) => string;
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
		// Abridged the same way a row is (issue #46), so it needs the same tooltip.
		tooltip: (pane, ctx) =>
			pane.cwd ? pathTooltip(pane.cwd, ctx.vaultPath, ctx.homePath) : '',
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

/**
 * The comparator with the pin tier on top (issue #35): pinned before unpinned,
 * then the chosen sort. Group-local by construction, because `buildRows` sorts
 * once and then deals the rows into their groups in that order.
 */
function withPinTier(
	compare: (a: PaneState, b: PaneState) => number,
	pinned: ReadonlySet<string>,
): (a: PaneState, b: PaneState) => number {
	if (pinned.size === 0) return compare;
	return (a, b) =>
		Number(pinned.has(b.paneId)) - Number(pinned.has(a.paneId)) || compare(a, b);
}

/** Every badge a row shows, in display order. Only the cache countdown today. */
function badges(pane: PaneState): RowBadge[] {
	const cache = cacheBadge(pane.tokens);
	return cache ? [cache] : [];
}

/**
 * A terminal tab as the workspace reports it: which pane, on which herdr. Both
 * halves are the key, because `w4:p1` on the local herdr and `w4:p1` on a
 * remote one are different agents (issue #54).
 */
export interface TerminalRef {
	endpointId: string;
	paneId: string;
}

/** Where a row's terminal stands: no tab, a tab somewhere, or the active tab. */
export type TerminalTier = 'closed' | 'open' | 'active';

/**
 * One channel's emphasis (issue #76). `faint` exists for the terminal surface
 * only, which has two strengths; herdr focus is either `full` or `none`.
 */
export type LiveTier = 'none' | 'faint' | 'full';

function sameTerminal(a: TerminalRef, b: TerminalRef): boolean {
	return a.paneId === b.paneId && a.endpointId === b.endpointId;
}

/**
 * Whether `pane` has a terminal tab, matched on pane id *and* endpoint. The
 * active tab counts as open even when it is missing from `open`, since a tab
 * cannot be active without being there.
 */
export function terminalTier(
	pane: TerminalRef,
	open: readonly TerminalRef[],
	active: TerminalRef | null,
): TerminalTier {
	if (active && sameTerminal(active, pane)) return 'active';
	return open.some((ref) => sameTerminal(ref, pane)) ? 'open' : 'closed';
}

/** What a row's emphasis channels say. Rows built by {@link toRow} carry these. */
export interface RowEmphasis {
	iconTier: LiveTier;
	backgroundTier: LiveTier;
	current: boolean;
}

/** How live one surface is for a row, on the shared tier scale. */
function surfaceTier(surface: RowClickAction, focused: boolean, terminal: TerminalTier): LiveTier {
	if (surface === 'focus') return focused ? 'full' : 'none';
	if (terminal === 'active') return 'full';
	return terminal === 'open' ? 'faint' : 'none';
}

/**
 * Splits the two live surfaces over the row's two channels (issue #76),
 * following the split {@link rowActions} makes of the two clicks: the icon
 * carries whatever the button does, the background whatever the body does.
 *
 * With the default setting the button focuses in herdr, so a persistent icon
 * marks herdr's focused pane, and the background goes faint for an open
 * terminal and full for the active one. Swapped, the icon carries the terminal
 * — faint for open, full for active, so neither channel loses a distinction —
 * and the background carries herdr focus, which has one strength.
 *
 * `current` is the active terminal whatever the setting: it is what
 * `aria-current` says, so colour is never the only carrier.
 */
export function rowEmphasis(
	focused: boolean,
	terminal: TerminalTier,
	rowClick: RowClickAction,
): RowEmphasis {
	const actions = rowActions(rowClick);
	return {
		iconTier: surfaceTier(actions.button, focused, terminal),
		backgroundTier: surfaceTier(actions.body, focused, terminal),
		current: terminal === 'active',
	};
}

/** Where a row's agent is live, as {@link toRow} takes it. */
export interface RowLive {
	terminal: TerminalTier;
	rowClick: RowClickAction;
}

const NOT_LIVE: RowLive = { terminal: 'closed', rowClick: 'terminal' };

/**
 * Projects one pane onto the row it becomes.
 *
 * @param showPath false leaves `pathLabel` empty (issue #39). Grouping by folder
 *   puts that very path in the group header, and a row that repeats its own
 *   heading says nothing; every other grouping keeps the line.
 * @param pinned whether the row is pinned (issue #35); `buildRows` decides.
 * @param live the row's terminal tier and the row-click setting (issue #76),
 *   from which the emphasis channels follow.
 */
export function toRow(
	pane: PaneState,
	vaultPath: string,
	homePath = '',
	showPath = true,
	pinned = false,
	live: RowLive = NOT_LIVE,
): RowModel {
	const displayName = agentDisplayName(pane);
	return {
		paneId: pane.paneId,
		kind: pane.agent,
		displayName,
		title: pane.title && pane.title !== displayName ? pane.title : '',
		pathLabel: showPath ? pathLabel(pane.cwd, vaultPath, homePath) : '',
		pathTooltip: showPath ? pathTooltip(pane.cwd, vaultPath, homePath) : '',
		status: pane.agentStatus,
		statusLabel: STATUS_LABEL[pane.agentStatus] ?? pane.agentStatus,
		focused: pane.focused,
		pinned,
		badges: badges(pane),
		terminal: live.terminal,
		...rowEmphasis(pane.focused, live.terminal, live.rowClick),
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
	const {
		groupBy,
		sort,
		homePath,
		pinnedPaneIds,
		rowClick,
		endpointId,
		openTerminals,
		activeTerminal,
	} = { ...DEFAULTS, ...options };
	const pinned = new Set(pinnedPaneIds);
	const grouping = GROUPS[groupBy] ?? GROUPS.tab;
	// Grouping by folder already names the folder above the rows (issue #39).
	const showPath = groupBy !== 'folder';
	const context: GroupContext = { tabLabels, vaultPath, homePath };
	// One sort up front fixes the row order inside every group.
	const ordered = [...panes].sort(withPinTier(COMPARE[sort] ?? COMPARE.priority, pinned));

	const groups = new Map<string, { group: RowGroup; urgency: number }>();
	for (const pane of ordered) {
		const key = grouping.key(pane);
		const urgency = statusRank(pane.agentStatus);
		let entry = groups.get(key);
		if (!entry) {
			entry = {
				group: {
					key,
					label: grouping.label(pane, context),
					tooltip: grouping.tooltip?.(pane, context) ?? '',
					rows: [],
				},
				urgency,
			};
			groups.set(key, entry);
		} else if (urgency < entry.urgency) {
			// Not simply the first row: an alphabetical group's first row says
			// nothing about how urgent the group is.
			entry.urgency = urgency;
		}
		const terminal = terminalTier(
			{ endpointId, paneId: pane.paneId },
			openTerminals,
			activeTerminal,
		);
		entry.group.rows.push(
			toRow(pane, vaultPath, homePath, showPath, pinned.has(pane.paneId), {
				terminal,
				rowClick,
			}),
		);
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
