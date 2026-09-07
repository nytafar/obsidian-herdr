/**
 * Workspace scope and pane state (PRD M6, M7, N4).
 *
 * Everything the plugin shows is filtered client-side to one herdr workspace, so
 * herdr outside Obsidian is unaffected. This module owns:
 *
 *   - resolution of "which workspace is this vault": settings id, then label
 *     equal to the vault folder name, then the workspace whose panes' cwd sits
 *     under the vault path (the remote vault path when a remote profile is on);
 *   - a `Map<pane_id, PaneState>` of that workspace's *agent* panes only
 *     (`agent != null`, PRD M7);
 *   - `changed` / `added` / `removed` / `workspaceResolved` events that fire only
 *     when something a view would render actually differs. herdr emits about ten
 *     `pane_updated` per second at idle and most of them only move `revision`
 *     (PRD N4).
 *
 * No Obsidian imports and no socket: the vault is passed in as a path plus a
 * name, and the one call this module needs to make (`ScopeOptions.lookupPanes`)
 * arrives as a plain async callback, so the file stays unit-testable and
 * reusable from the remote profile.
 */

import { lastPathSegment, trimTrailingSlashes } from '../paths';
import { sameCacheBadge } from './cacheBadge';
import type { HerdrEvent } from './client';
import type { AgentInfo, AgentStatus, PaneInfo, WorkspaceInfo } from './types.gen';

/** Subscriptions the scope needs to stay current. */
export const SCOPE_SUBSCRIPTIONS = [
	{ type: 'pane.created' },
	{ type: 'pane.updated' },
	{ type: 'pane.closed' },
	{ type: 'pane.exited' },
	{ type: 'pane.moved' },
	{ type: 'pane.focused' },
	{ type: 'pane.agent_detected' },
	{ type: 'tab.created' },
	{ type: 'tab.closed' },
	{ type: 'tab.renamed' },
	{ type: 'workspace.created' },
	{ type: 'workspace.updated' },
	{ type: 'workspace.renamed' },
	{ type: 'workspace.closed' },
	{ type: 'workspace.focused' },
] as const;

/** How the scoped workspace was picked, for the settings tab and the log. */
export type ResolutionMethod = 'setting' | 'label' | 'cwd' | 'none';

/** The subset of `PaneInfo` the plugin renders and reacts to. */
export interface PaneState {
	paneId: string;
	workspaceId: string;
	tabId: string;
	/** Never null here: non-agent panes are not tracked (PRD M7). */
	agent: string;
	/**
	 * The agent's own name, e.g. `vault-maintenance`. Only `agent.list` and
	 * `session.snapshot` carry it — `PaneInfo.label` is null for a named agent
	 * and `PaneInfo.agent` is just the kind ("claude"). Empty until a name
	 * lookup has landed, or for an agent herdr never named.
	 */
	name: string;
	agentStatus: AgentStatus;
	/** `terminal_title_stripped`, falling back to `terminal_title`. */
	title: string;
	label: string;
	cwd: string;
	focused: boolean;
	/**
	 * herdr's per-pane token map, kept whole and read only for the cache badge
	 * (issue #23). A herdr plugin publishes the prompt-cache countdown into it as
	 * `cache_ok` / `cache_warn` / `cache_crit` plus `cache_sort`; unknown keys are
	 * kept, since anything may publish here. Empty for a pane with no tokens,
	 * which is any harness the plugin does not track. Always the freshest map
	 * herdr sent, whether or not the change was worth an event — see
	 * {@link relevantDiff}.
	 */
	tokens: Record<string, string>;
	/**
	 * Monotonic stamp of the last `agentStatus` change, higher meaning more
	 * recent (issue #20). herdr breaks its own priority ordering on
	 * `last_agent_state_change_seq`, which `pane.list` does not carry, so the
	 * scope counts transitions itself. Panes are stamped 0 until they move, which
	 * includes everything a `prime` first saw, so a fresh list falls back to the
	 * row model's name tie-break. Never a wall clock.
	 */
	statusChangedSeq: number;
}

export interface ScopeEventMap {
	/** The scoped workspace changed (including the first resolution). */
	workspaceResolved: [workspaceId: string | null, method: ResolutionMethod];
	added: [pane: PaneState];
	/** Something renderable differs. `prev` and `next` are immutable snapshots. */
	changed: [paneId: string, prev: PaneState, next: PaneState];
	removed: [pane: PaneState];
}

export type Unsubscribe = () => void;

export interface ScopeOptions {
	/** Workspace id from settings. Empty means resolve by label, then by cwd. */
	workspaceId?: string;
	/** Absolute path of the vault on the machine herdr runs on. */
	vaultPath: string;
	/**
	 * Vault folder name, compared against workspace labels. Defaults to the last
	 * segment of `vaultPath`.
	 */
	vaultName?: string;
	/**
	 * Vault path on the remote host. When set it is preferred for the cwd match,
	 * because the panes' cwds are remote paths (PRD S5, M19).
	 */
	remoteVaultPath?: string;
	/**
	 * Panes of one workspace, normally `pane.list` with a `workspace_id`. The
	 * scope calls it only when `pane_agent_detected` announces an agent on a pane
	 * it does not already hold: that event names the pane and the agent but
	 * carries no cwd, tab or title, and herdr 0.8.0 has no per-pane get (issue
	 * #75). Injected rather than taken as a client so this file keeps its promise
	 * of no Obsidian and no socket. Left out, detections still remove released
	 * panes and simply admit nothing.
	 */
	lookupPanes?: (workspaceId: string) => Promise<PaneInfo[]>;
}

/** Fields whose change is worth re-rendering a row for (PRD N4). */
const RELEVANT: (keyof PaneState)[] = [
	'agentStatus',
	'name',
	'title',
	'label',
	'tabId',
	'cwd',
	'agent',
	'focused',
	'tokens',
];

/** True when `cwd` is the root itself or sits below it. Not a string prefix. */
export function isUnder(cwd: string, root: string): boolean {
	if (!cwd || !root) return false;
	const normalRoot = trimTrailingSlashes(root);
	if (cwd === normalRoot) return true;
	return cwd.startsWith(`${normalRoot}/`);
}

/**
 * herdr keeps a one-character spinner in front of the terminal title of a
 * working agent, and it is still there in `terminal_title_stripped` (that field
 * strips ANSI, not the glyph). Live capture: `◐ Obsidian-herdr …` alternating
 * with `◑ Obsidian-herdr …` about four times a second. Comparing the raw title
 * would re-render every row of a busy list several times a second, which is the
 * exact churn PRD N4 forbids, so the leading symbol run is dropped.
 */
export function stripTitleSpinner(title: string): string {
	const stripped = title.replace(/^[^\p{L}\p{N}]+/u, '').trim();
	return stripped.length > 0 ? stripped : title.trim();
}

/**
 * The pane's token map with the string values kept and everything else dropped.
 * herdr types the values as `string`, but this arrives over JSON from a plugin,
 * so a stray null or number is ignored rather than rendered (issue #23).
 */
function tokensOf(tokens: unknown): Record<string, string> {
	if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) return {};
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(tokens as Record<string, unknown>)) {
		if (typeof value === 'string') result[key] = value;
	}
	return result;
}

/** Reads a `PaneInfo` off an event payload, tolerating unknown shapes. */
function paneFromData(data: Record<string, unknown>): PaneInfo | null {
	const pane = data.pane;
	if (typeof pane !== 'object' || pane === null || Array.isArray(pane)) return null;
	const candidate = pane as Partial<PaneInfo>;
	return typeof candidate.pane_id === 'string' ? (candidate as PaneInfo) : null;
}

function stringField(data: Record<string, unknown>, key: string): string | null {
	const value = data[key];
	return typeof value === 'string' ? value : null;
}

/**
 * Projects a `PaneInfo` onto the fields the plugin uses. `name` comes from a
 * separate `agent.list` / `session.snapshot` lookup, so it is passed in.
 */
export function toPaneState(pane: PaneInfo, name = ''): PaneState | null {
	if (typeof pane.agent !== 'string' || pane.agent.length === 0) return null;
	return {
		paneId: pane.pane_id,
		name,
		workspaceId: pane.workspace_id,
		tabId: pane.tab_id,
		agent: pane.agent,
		agentStatus: pane.agent_status,
		title: stripTitleSpinner(pane.terminal_title_stripped ?? pane.terminal_title ?? ''),
		label: pane.label ?? '',
		cwd: pane.cwd ?? pane.foreground_cwd ?? '',
		focused: pane.focused === true,
		tokens: tokensOf(pane.tokens),
		statusChangedSeq: 0,
	};
}

/**
 * Fields of `next` that differ from `prev` and matter to a view.
 *
 * `tokens` is compared through the badge it produces, not key by key. The herdr
 * plugin that publishes the prompt-cache countdown also publishes `cache_sort`,
 * a seconds counter, so a map comparison would call every pane with a cache
 * "changed" once a second and rebuild the whole sidebar list at 1 Hz — the churn
 * PRD N4 exists to stop. The badge says minutes, so it moves at most once a
 * minute; the newer map is still stored on the pane either way.
 */
export function relevantDiff(prev: PaneState, next: PaneState): (keyof PaneState)[] {
	return RELEVANT.filter((field) =>
		field === 'tokens' ? !sameCacheBadge(prev.tokens, next.tokens) : prev[field] !== next[field],
	);
}

/**
 * Picks the workspace for a vault (PRD M6). Ids are opaque and never constructed.
 *
 * @param workspaces from `workspace.list`
 * @param panes from `pane.list`; only used for the cwd fallback
 */
export function resolveWorkspace(
	workspaces: WorkspaceInfo[],
	panes: PaneInfo[],
	options: ScopeOptions,
): { workspaceId: string | null; method: ResolutionMethod } {
	const override = options.workspaceId?.trim();
	if (override) return { workspaceId: override, method: 'setting' };

	const name = (options.vaultName ?? lastPathSegment(options.vaultPath)).trim();
	if (name) {
		const exact = workspaces.find((workspace) => workspace.label === name);
		if (exact) return { workspaceId: exact.workspace_id, method: 'label' };
		const lower = name.toLowerCase();
		const insensitive = workspaces.find(
			(workspace) => typeof workspace.label === 'string' && workspace.label.toLowerCase() === lower,
		);
		if (insensitive) return { workspaceId: insensitive.workspace_id, method: 'label' };
	}

	// Remote panes report remote paths, so the remote root wins when set.
	const root = options.remoteVaultPath?.trim() || options.vaultPath.trim();
	if (root) {
		const hits = new Map<string, number>();
		for (const pane of panes) {
			const cwd = pane.cwd ?? pane.foreground_cwd ?? '';
			if (!isUnder(cwd, root)) continue;
			hits.set(pane.workspace_id, (hits.get(pane.workspace_id) ?? 0) + 1);
		}
		let best: string | null = null;
		let bestCount = 0;
		for (const [workspaceId, count] of hits) {
			if (count > bestCount) {
				best = workspaceId;
				bestCount = count;
			}
		}
		if (best) return { workspaceId: best, method: 'cwd' };
	}

	return { workspaceId: null, method: 'none' };
}

/**
 * The scoped view of herdr: one workspace, its agent panes, and change events.
 *
 * Feed it once with `prime(workspaces, panes)` from `workspace.list` +
 * `pane.list`, then with every event line from the client's stream via
 * `ingest(event)`.
 */
export class WorkspaceScope {
	private options: ScopeOptions;
	private panes = new Map<string, PaneState>();
	private workspaces: WorkspaceInfo[] = [];
	/**
	 * Every pane herdr currently has, agent or not, across all workspaces: the
	 * last `pane.list` kept current from pane events. Resolution reads it for the
	 * cwd rule, and a re-resolution rebuilds the scoped map from it, so it has
	 * to be live (issue #58): a snapshot would keep resolving against panes that
	 * are gone and never see the first in-vault pane after an unmatched prime.
	 */
	private inventory = new Map<string, PaneInfo>();
	/**
	 * pane id → agent name, for every agent herdr knows, not just the scoped
	 * workspace: `agent.start` rejects a duplicate name session-wide, so the
	 * collision check needs them all (PRD M20).
	 */
	private names = new Map<string, string>();
	/**
	 * pane id → the workspace its detection lookup was asked about (issue #75).
	 * Presence is what makes a late answer valid: `drop` deletes the entry, so an
	 * answer that lands after the pane closed, or after its agent was released,
	 * finds nothing to apply and cannot resurrect the row.
	 */
	private pendingLookups = new Map<string, string>();
	/** Counter behind `PaneState.statusChangedSeq`; only ever increases. */
	private statusSeq = 0;
	private resolvedId: string | null = null;
	private resolutionMethod: ResolutionMethod = 'none';
	/** Handler tuples differ per event, so the table is untyped and `on` re-narrows. */
	private readonly handlers = new Map<string, Set<(...args: never) => void>>();

	constructor(options: ScopeOptions) {
		this.options = { ...options };
	}

	get workspaceId(): string | null {
		return this.resolvedId;
	}

	get method(): ResolutionMethod {
		return this.resolutionMethod;
	}

	/** Label of the scoped workspace, when it is known. */
	get workspaceLabel(): string | null {
		const workspace = this.workspaces.find((entry) => entry.workspace_id === this.resolvedId);
		return workspace?.label ?? null;
	}

	/** Agent panes in scope, in insertion order. */
	list(): PaneState[] {
		return [...this.panes.values()];
	}

	get(paneId: string): PaneState | undefined {
		return this.panes.get(paneId);
	}

	get size(): number {
		return this.panes.size;
	}

	/**
	 * Feeds in `agent.list` (or `session.snapshot().agents`). Names live outside
	 * `PaneInfo`, so this is the only way a row can show one. Panes in scope
	 * whose name changed emit `changed`, which is what repaints the list.
	 */
	setAgentNames(agents: readonly AgentInfo[]): void {
		const names = new Map<string, string>();
		for (const agent of agents) {
			if (typeof agent?.pane_id !== 'string') continue;
			const name = typeof agent.name === 'string' ? agent.name.trim() : '';
			if (name) names.set(agent.pane_id, name);
		}
		this.names = names;
		for (const [paneId, state] of this.panes) {
			const name = names.get(paneId) ?? '';
			if (state.name === name) continue;
			const next = { ...state, name };
			this.panes.set(paneId, next);
			this.emit('changed', paneId, state, next);
		}
	}

	/** Every agent name herdr currently knows, for `agent.start` uniqueness. */
	agentNames(): Set<string> {
		return new Set(this.names.values());
	}

	on<K extends keyof ScopeEventMap>(
		type: K,
		handler: (...args: ScopeEventMap[K]) => void,
	): Unsubscribe {
		let set = this.handlers.get(type);
		if (!set) {
			set = new Set();
			this.handlers.set(type, set);
		}
		const stored = handler as unknown as (...args: never) => void;
		set.add(stored);
		let live = true;
		return () => {
			if (!live) return;
			live = false;
			const current = this.handlers.get(type);
			current?.delete(stored);
			if (current && current.size === 0) this.handlers.delete(type);
		};
	}

	/** Applies new settings (workspace override, vault paths) and re-resolves. */
	configure(options: Partial<ScopeOptions>): void {
		this.options = { ...this.options, ...options };
		this.reconcile(true);
	}

	/**
	 * Initial load: resolve the workspace and replace the pane map with the agent
	 * panes of that workspace. Emits `added` / `removed` / `changed` for the
	 * difference, so re-priming after a reconnect is not a visible reset.
	 */
	prime(workspaces: WorkspaceInfo[], panes: PaneInfo[]): void {
		this.workspaces = workspaces;
		this.inventory = new Map(panes.map((pane) => [pane.pane_id, pane]));
		this.reconcile(true);
	}

	/**
	 * Resolves the workspace against the current inventory and, when the
	 * identity moved (or `rebuild` is set, as after a prime), replaces the pane
	 * map with that workspace's agent panes in the same step. Identity and
	 * membership never disagree in between (issue #58): a rename away leaves an
	 * empty collection, a rename into scope shows the new workspace's panes.
	 * Emits `added` / `removed` / `changed` for the difference, then
	 * `workspaceResolved` once when the identity changed.
	 */
	private reconcile(rebuild = false): void {
		const { workspaceId, method } = resolveWorkspace(
			this.workspaces,
			[...this.inventory.values()],
			this.options,
		);
		const changedWorkspace = workspaceId !== this.resolvedId || method !== this.resolutionMethod;
		if (!changedWorkspace && !rebuild) return;
		this.resolvedId = workspaceId;
		this.resolutionMethod = method;

		const next = new Map<string, PaneState>();
		if (workspaceId !== null) {
			for (const pane of this.inventory.values()) {
				if (pane.workspace_id !== workspaceId) continue;
				const state = toPaneState(pane, this.names.get(pane.pane_id) ?? '');
				if (state) next.set(state.paneId, state);
			}
		}

		for (const [paneId, previous] of this.panes) {
			const current = next.get(paneId);
			if (!current) {
				this.panes.delete(paneId);
				this.emit('removed', previous);
			}
		}
		for (const [paneId, fresh] of next) {
			const previous = this.panes.get(paneId);
			if (!previous) {
				this.panes.set(paneId, fresh);
				this.emit('added', fresh);
				continue;
			}
			// A pane the first prime saw keeps seq 0; a re-prime after a reconnect
			// still stamps a status that moved while the connection was down.
			const state = this.stamp(fresh, previous);
			if (relevantDiff(previous, state).length > 0) {
				this.panes.set(paneId, state);
				this.emit('changed', paneId, previous, state);
			} else {
				// Keep the newer snapshot without telling anyone: only `revision` and
				// friends moved.
				this.panes.set(paneId, state);
			}
		}

		if (changedWorkspace) this.emit('workspaceResolved', workspaceId, method);
	}

	/**
	 * Applies one event line from the client. Unknown events are ignored, and so
	 * are events for other workspaces and non-agent panes.
	 */
	ingest(event: HerdrEvent): void {
		switch (event.event) {
			case 'pane_created':
			case 'pane_updated':
			case 'pane_moved': {
				const pane = paneFromData(event.data);
				if (!pane) return;
				// A move across workspaces can give the pane a new id; the old one
				// must not linger in the inventory and resolve from the grave.
				const previousId = stringField(event.data, 'previous_pane_id');
				if (previousId && previousId !== pane.pane_id) this.forget(previousId);
				this.inventory.set(pane.pane_id, pane);
				// Only the cwd rule reads panes: a label or setting match cannot move.
				if (this.resolvedByPanes()) this.reconcile();
				this.upsert(pane);
				return;
			}
			case 'pane_closed':
			case 'pane_exited': {
				const paneId = stringField(event.data, 'pane_id');
				if (!paneId) return;
				this.forget(paneId);
				if (this.resolvedByPanes()) this.reconcile();
				return;
			}
			case 'pane_focused': {
				const paneId = stringField(event.data, 'pane_id');
				if (!paneId) return;
				// `pane.focused` carries no PaneInfo, so update the flag by hand.
				for (const [id, state] of this.panes) {
					const focused = id === paneId;
					if (state.focused === focused) continue;
					const next = { ...state, focused };
					this.panes.set(id, next);
					this.emit('changed', id, state, next);
				}
				return;
			}
			case 'pane_agent_detected': {
				// Both halves act now. A release drops the pane at once, as it always
				// did. A gain used to wait for the next pane_updated to carry the
				// detail, which measured as seconds of nothing (issue #75):
				// pane.updated is a round-robin across every pane herdr has, not a
				// per-pane heartbeat, so a pane that just started an agent waits its
				// turn among a hundred others. This event lands ~138 ms after
				// agent.start and already names the agent, so it is the trigger.
				const paneId = stringField(event.data, 'pane_id');
				const agent = stringField(event.data, 'agent');
				if (!paneId) return;
				if (agent === null || event.data.released === true) {
					this.drop(paneId);
					return;
				}
				this.admit(paneId, stringField(event.data, 'workspace_id'));
				return;
			}
			case 'workspace_created':
			case 'workspace_updated':
			case 'workspace_metadata_updated': {
				const workspace = event.data.workspace;
				// A label can change through an update too, not only through a rename.
				if (this.mergeWorkspace(workspace) && this.resolutionMethod !== 'setting') this.reconcile();
				return;
			}
			case 'workspace_renamed': {
				const workspaceId = stringField(event.data, 'workspace_id');
				const label = stringField(event.data, 'label');
				if (!workspaceId || label === null) return;
				const existing = this.workspaces.find((entry) => entry.workspace_id === workspaceId);
				if (existing) existing.label = label;
				// A rename can make a workspace match the vault name, or stop matching.
				if (this.resolutionMethod !== 'setting') this.reconcile();
				return;
			}
			case 'workspace_closed': {
				const workspaceId = stringField(event.data, 'workspace_id');
				if (!workspaceId) return;
				this.workspaces = this.workspaces.filter((entry) => entry.workspace_id !== workspaceId);
				// Its panes went with it; herdr does not send a pane_closed for each.
				for (const pane of [...this.inventory.values()]) {
					if (pane.workspace_id === workspaceId) this.forget(pane.pane_id);
				}
				if (workspaceId === this.resolvedId) {
					// The purge above already emptied the scoped map, so identity is
					// all that is left to move. A fallback rule may pick another
					// workspace right away; a setting override stays unresolved until
					// the settings change.
					const wasSetting = this.resolutionMethod === 'setting';
					this.resolvedId = null;
					this.resolutionMethod = 'none';
					if (!wasSetting) this.reconcile();
					if (this.resolvedId === null) this.emit('workspaceResolved', null, 'none');
				} else if (this.resolvedByPanes()) {
					this.reconcile();
				}
				return;
			}
			default:
				return;
		}
	}

	/**
	 * Fills in a pane that just gained an agent (issue #75). One lookup per
	 * detection, and none at all for a pane already in the map, so a burst of
	 * starts is not a burst of `pane.list`. The workspace on the event decides
	 * whether the detection is ours; a detection elsewhere is not chased.
	 */
	private admit(paneId: string, eventWorkspaceId: string | null): void {
		const workspaceId = this.resolvedId;
		if (workspaceId === null) return;
		if (eventWorkspaceId !== null && eventWorkspaceId !== workspaceId) return;
		if (this.panes.has(paneId)) return;
		// A second detection for a pane whose first lookup is still out asks again
		// for nothing; the answer in flight already covers it.
		if (this.pendingLookups.has(paneId)) return;
		const lookup = this.options.lookupPanes;
		if (!lookup) return;
		this.pendingLookups.set(paneId, workspaceId);
		void lookup(workspaceId).then(
			(panes) => {
				this.settleLookup(paneId, workspaceId, panes);
			},
			() => {
				// No answer is no change: the next pane_updated for the pane still
				// admits it the slow way, and nothing here is worth a notice.
				if (this.pendingLookups.get(paneId) === workspaceId) this.pendingLookups.delete(paneId);
			},
		);
	}

	/**
	 * Applies a detection lookup, or discards it. Everything that can happen
	 * between the question and the answer has to leave the map exactly as it is:
	 * the pane closed or lost its agent (`drop` cancelled the entry, so a late
	 * answer never resurrects it), the scoped workspace moved (the answer
	 * describes a workspace we no longer show, and feeding it in would leak
	 * foreign panes), or herdr no longer lists the pane at all.
	 */
	private settleLookup(paneId: string, workspaceId: string, panes: PaneInfo[]): void {
		if (this.pendingLookups.get(paneId) !== workspaceId) return;
		this.pendingLookups.delete(paneId);
		if (this.resolvedId !== workspaceId) return;
		const pane = panes.find((entry) => entry.pane_id === paneId);
		if (!pane || pane.workspace_id !== workspaceId) return;
		// Only the detected pane is taken from the answer. The rest of the list is
		// what the event stream already maintains, and a whole-workspace overwrite
		// would put back panes that closed while the request was out.
		this.inventory.set(pane.pane_id, pane);
		this.upsert(pane);
	}

	/** True when the pane inventory decides the resolution (cwd rule or nothing). */
	private resolvedByPanes(): boolean {
		return this.resolutionMethod === 'cwd' || this.resolutionMethod === 'none';
	}

	private mergeWorkspace(value: unknown): boolean {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
		const workspace = value as Partial<WorkspaceInfo>;
		if (typeof workspace.workspace_id !== 'string') return false;
		const index = this.workspaces.findIndex(
			(entry) => entry.workspace_id === workspace.workspace_id,
		);
		if (index === -1) this.workspaces.push(workspace as WorkspaceInfo);
		else this.workspaces[index] = workspace as WorkspaceInfo;
		return true;
	}

	private upsert(pane: PaneInfo): void {
		const previous = this.panes.get(pane.pane_id);
		const inScope = this.resolvedId !== null && pane.workspace_id === this.resolvedId;
		const fresh = inScope ? toPaneState(pane, this.names.get(pane.pane_id) ?? '') : null;

		if (!fresh) {
			// Moved out of scope, or the agent was released: it leaves the list.
			if (previous) this.drop(pane.pane_id);
			return;
		}
		if (!previous) {
			// An agent that appears while we are watching is newer than anything the
			// prime found, so it takes the freshest stamp rather than 0.
			const added = { ...fresh, statusChangedSeq: ++this.statusSeq };
			this.panes.set(pane.pane_id, added);
			this.emit('added', added);
			return;
		}
		const state = this.stamp(fresh, previous);
		const diff = relevantDiff(previous, state);
		this.panes.set(pane.pane_id, state);
		// The storm of pane_updated that only bumps `revision` stops here (N4).
		if (diff.length > 0) this.emit('changed', pane.pane_id, previous, state);
	}

	/**
	 * Carries `statusChangedSeq` from the pane's last state, bumping it when the
	 * status actually moved. `toPaneState` cannot do this: the counter belongs to
	 * the scope, not to a single `PaneInfo`.
	 */
	private stamp(next: PaneState, previous: PaneState): PaneState {
		return {
			...next,
			statusChangedSeq:
				previous.agentStatus === next.agentStatus
					? previous.statusChangedSeq
					: ++this.statusSeq,
		};
	}

	/** Takes a pane out of the scoped map, emitting `removed` if it was there. */
	private drop(paneId: string): void {
		// Before the early return below, because the pane a detection lookup is out
		// for is by definition not in the map yet (issue #75).
		this.pendingLookups.delete(paneId);
		const previous = this.panes.get(paneId);
		if (!previous) return;
		this.panes.delete(paneId);
		this.emit('removed', previous);
	}

	/** Takes a pane out of the inventory as well as the scoped map: it is gone. */
	private forget(paneId: string): void {
		this.inventory.delete(paneId);
		this.drop(paneId);
	}

	private emit<K extends keyof ScopeEventMap>(type: K, ...args: ScopeEventMap[K]): void {
		const set = this.handlers.get(type);
		if (!set) return;
		for (const handler of [...set]) {
			try {
				(handler as unknown as (...rest: ScopeEventMap[K]) => void)(...args);
			} catch {
				// One bad subscriber must not stop the others or the event stream.
			}
		}
	}
}
