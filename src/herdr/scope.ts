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
 * No Obsidian imports: the vault is passed in as a path plus a name so this file
 * stays unit-testable and reusable from the remote profile.
 */

import type { HerdrEvent } from './client';
import type { AgentStatus, PaneInfo, WorkspaceInfo } from './types.gen';

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
	agentStatus: AgentStatus;
	/** `terminal_title_stripped`, falling back to `terminal_title`. */
	title: string;
	label: string;
	cwd: string;
	focused: boolean;
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
}

/** Fields whose change is worth re-rendering a row for (PRD N4). */
const RELEVANT: (keyof PaneState)[] = [
	'agentStatus',
	'title',
	'label',
	'tabId',
	'cwd',
	'agent',
	'focused',
];

function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, '');
	const slash = trimmed.lastIndexOf('/');
	return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** True when `cwd` is the root itself or sits below it. Not a string prefix. */
export function isUnder(cwd: string, root: string): boolean {
	if (!cwd || !root) return false;
	const normalRoot = root.replace(/\/+$/, '');
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

/** Projects a `PaneInfo` onto the fields the plugin uses. */
export function toPaneState(pane: PaneInfo): PaneState | null {
	if (typeof pane.agent !== 'string' || pane.agent.length === 0) return null;
	return {
		paneId: pane.pane_id,
		workspaceId: pane.workspace_id,
		tabId: pane.tab_id,
		agent: pane.agent,
		agentStatus: pane.agent_status,
		title: stripTitleSpinner(pane.terminal_title_stripped ?? pane.terminal_title ?? ''),
		label: pane.label ?? '',
		cwd: pane.cwd ?? pane.foreground_cwd ?? '',
		focused: pane.focused === true,
	};
}

/** Fields of `next` that differ from `prev` and matter to a view. */
export function relevantDiff(prev: PaneState, next: PaneState): (keyof PaneState)[] {
	return RELEVANT.filter((field) => prev[field] !== next[field]);
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

	const name = (options.vaultName ?? basename(options.vaultPath)).trim();
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
	/** Last `pane.list`, kept so a later re-resolve can still use the cwd rule. */
	private lastPaneList: PaneInfo[] = [];
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
		this.prime(this.workspaces, this.lastPaneList);
	}

	/**
	 * Initial load: resolve the workspace and replace the pane map with the agent
	 * panes of that workspace. Emits `added` / `removed` / `changed` for the
	 * difference, so re-priming after a reconnect is not a visible reset.
	 */
	prime(workspaces: WorkspaceInfo[], panes: PaneInfo[]): void {
		this.workspaces = workspaces;
		this.lastPaneList = panes;
		const { workspaceId, method } = resolveWorkspace(workspaces, panes, this.options);
		const changedWorkspace = workspaceId !== this.resolvedId || method !== this.resolutionMethod;
		this.resolvedId = workspaceId;
		this.resolutionMethod = method;

		const next = new Map<string, PaneState>();
		if (workspaceId !== null) {
			for (const pane of panes) {
				if (pane.workspace_id !== workspaceId) continue;
				const state = toPaneState(pane);
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
		for (const [paneId, state] of next) {
			const previous = this.panes.get(paneId);
			if (!previous) {
				this.panes.set(paneId, state);
				this.emit('added', state);
			} else if (relevantDiff(previous, state).length > 0) {
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
				if (pane) this.upsert(pane);
				return;
			}
			case 'pane_closed':
			case 'pane_exited': {
				const paneId = stringField(event.data, 'pane_id');
				if (paneId) this.drop(paneId);
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
				// The pane either gained or lost an agent; the following pane_updated
				// carries the detail, but act now so a released pane leaves the list.
				const paneId = stringField(event.data, 'pane_id');
				const agent = stringField(event.data, 'agent');
				if (!paneId) return;
				if (agent === null || event.data.released === true) this.drop(paneId);
				return;
			}
			case 'workspace_created':
			case 'workspace_updated':
			case 'workspace_metadata_updated': {
				const workspace = event.data.workspace;
				if (this.mergeWorkspace(workspace) && this.resolvedId === null) this.reresolve();
				return;
			}
			case 'workspace_renamed': {
				const workspaceId = stringField(event.data, 'workspace_id');
				const label = stringField(event.data, 'label');
				if (!workspaceId || label === null) return;
				const existing = this.workspaces.find((entry) => entry.workspace_id === workspaceId);
				if (existing) existing.label = label;
				// A rename can make a workspace match the vault name, or stop matching.
				if (this.resolutionMethod !== 'setting') this.reresolve();
				return;
			}
			case 'workspace_closed': {
				const workspaceId = stringField(event.data, 'workspace_id');
				if (!workspaceId) return;
				this.workspaces = this.workspaces.filter((entry) => entry.workspace_id !== workspaceId);
				if (workspaceId === this.resolvedId) {
					for (const [paneId, state] of [...this.panes]) {
						this.panes.delete(paneId);
						this.emit('removed', state);
					}
					this.resolvedId = null;
					this.resolutionMethod = 'none';
					this.emit('workspaceResolved', null, 'none');
				}
				return;
			}
			default:
				return;
		}
	}

	private reresolve(): void {
		const { workspaceId, method } = resolveWorkspace(
			this.workspaces,
			this.lastPaneList,
			this.options,
		);
		if (workspaceId === this.resolvedId && method === this.resolutionMethod) return;
		this.resolvedId = workspaceId;
		this.resolutionMethod = method;
		this.emit('workspaceResolved', workspaceId, method);
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
		const state = inScope ? toPaneState(pane) : null;

		if (!state) {
			// Moved out of scope, or the agent was released: it leaves the list.
			if (previous) this.drop(pane.pane_id);
			return;
		}
		if (!previous) {
			this.panes.set(pane.pane_id, state);
			this.emit('added', state);
			return;
		}
		const diff = relevantDiff(previous, state);
		this.panes.set(pane.pane_id, state);
		// The storm of pane_updated that only bumps `revision` stops here (N4).
		if (diff.length > 0) this.emit('changed', pane.pane_id, previous, state);
	}

	private drop(paneId: string): void {
		const previous = this.panes.get(paneId);
		if (!previous) return;
		this.panes.delete(paneId);
		this.emit('removed', previous);
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
