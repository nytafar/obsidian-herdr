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
 * of the split.
 */

import { isUnder, type PaneState } from '../herdr/scope';
import type { AgentStatus } from '../herdr/types.gen';

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
	/**
	 * The cwd as shown: vault-relative inside the vault, `~/…` under the home
	 * directory, absolute otherwise (issue #22).
	 */
	pathLabel: string;
	status: AgentStatus;
	/** Accessible text for the status glyph. */
	statusLabel: string;
	focused: boolean;
	/** Short trailing markers, in display order. The cache countdown today. */
	badges: RowBadge[];
}

/** How a badge is coloured: green while there is time, amber, then red. */
export type BadgeTone = 'ok' | 'warn' | 'crit';

/** One short marker at the end of a row's first line. */
export interface RowBadge {
	text: string;
	tone: BadgeTone;
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
	const root = vaultPath.replace(/\/+$/, '');
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
	const root = vaultPath.replace(/\/+$/, '');
	if (root && isUnder(cwd, root)) return relativeCwd(cwd, root);
	const home = homePath.replace(/\/+$/, '');
	if (!home || !isUnder(cwd, home)) return cwd;
	const rest = cwd.slice(home.length).replace(/^\/+/, '');
	return rest ? `~/${rest}` : '~';
}

/** Token key → badge tone, in the order a row prefers them (issue #23). */
const CACHE_TOKENS: readonly (readonly [key: string, tone: BadgeTone])[] = [
	['cache_crit', 'crit'],
	['cache_warn', 'warn'],
	['cache_ok', 'ok'],
];

/**
 * The prompt-cache countdown as a badge, or null (issue #23). A herdr plugin
 * publishes exactly one of `cache_ok` / `cache_warn` / `cache_crit` into the
 * pane's token map with a label such as `8m`; the key carries the tone.
 *
 * An expired cache reports `cache_crit: "0m"`, and nearly every idle pane sits
 * expired, so a wall of red zeros would be pure noise: only a counting cache
 * gets a badge. Panes with no cache tokens — any harness the plugin does not
 * track — get none either, and the plugin's other keys (`cache_sort`) are not
 * for display.
 */
export function cacheBadge(tokens: Readonly<Record<string, string>>): RowBadge | null {
	for (const [key, tone] of CACHE_TOKENS) {
		const text = tokens[key]?.trim();
		if (!text) continue;
		// "0m" is expired, not "zero minutes left to show". Any all-zero label
		// counts, so a plugin that says "0s" or "0h 0m" is silent too.
		const digits = text.replace(/\D/g, '');
		if (digits.length > 0 && !/[1-9]/.test(digits)) return null;
		return { text, tone };
	}
	return null;
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

/** Last path segment, used to name a folder group sitting at the vault root. */
function lastSegment(path: string): string {
	const trimmed = path.replace(/\/+$/, '');
	const slash = trimmed.lastIndexOf('/');
	return slash === -1 ? trimmed : trimmed.slice(slash + 1);
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
				pathLabel(pane.cwd, ctx.vaultPath, ctx.homePath) || lastSegment(ctx.vaultPath) || pane.cwd
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

/** Projects one pane onto the row it becomes. */
export function toRow(pane: PaneState, vaultPath: string, homePath = ''): RowModel {
	const displayName = agentDisplayName(pane);
	return {
		paneId: pane.paneId,
		kind: pane.agent,
		displayName,
		title: pane.title && pane.title !== displayName ? pane.title : '',
		pathLabel: pathLabel(pane.cwd, vaultPath, homePath),
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
		entry.group.rows.push(toRow(pane, vaultPath, homePath));
	}

	return [...groups.values()]
		.sort((a, b) => a.urgency - b.urgency || a.group.label.localeCompare(b.group.label))
		.map((entry) => entry.group);
}
