/**
 * Shared herdr tab-label cache (issue #43).
 *
 * herdr's tab labels ("vault-maintenance", "trauma") come only from `tab.list`;
 * the event stream carries the tab id on every pane and the new label on
 * `tab_renamed`, nothing else. The agent list groups rows under the label and,
 * since #43, a terminal view can be titled with it, so one cache per connection
 * owns retrieval *and* invalidation for every view on that connection. Nothing
 * else fetches labels.
 *
 * What it guarantees, in the order the review at 1440d7d asked for them:
 *
 * - **One fetch shared by all views.** Two list views and three terminals on
 *   the same connection cause one `tab.list`; a request that lands while one is
 *   in flight is queued and run once more afterwards, never in parallel.
 * - **Generation check.** A response is applied only if the owning connection
 *   is still the published one (`deps.alive()`) and the scope still resolves to
 *   the workspace that was asked for. An old connection's labels can therefore
 *   never contaminate a new one, and a workspace re-resolution mid-flight drops
 *   the answer for the previous workspace.
 * - **`tab_renamed` updates in place.** A rename with no pane creation used to
 *   stay stale (acknowledged in #16); now it is written into the entry and
 *   subscribers are told, with no round trip.
 * - **Empty results clear.** A `tab.list` that returns no tabs, or a herdr that
 *   does not support it, leaves an *empty* entry rather than the previous one,
 *   so a closed tab's label cannot outlive it.
 * - **Keyed by connection plus workspace.** The cache is built per connection
 *   (see `HerdrPlugin.tabLabelsFor`), and inside it entries are keyed by
 *   workspace id, so a workspace re-resolution starts from a blank map.
 * - **No I/O in render.** `labels()` and `get()` never fetch. Views ask for a
 *   fetch from their bind and `added` handlers through `ensure()`, which is
 *   bounded: a tab id already asked for is not asked again even when herdr's
 *   answer omitted it (`notes/memory.md`, suspect 8).
 *
 * Everything herdr-specific is injected, so the cache is unit tested with fakes
 * (`tests/tabLabels.test.ts`) and imports nothing from Obsidian.
 */

import { stripTitleSpinner } from './herdr/scope';
import type { TabInfo } from './herdr/types.gen';

export type Unsubscribe = () => void;

/** The slice of `HerdrClient` the cache drives. */
export interface TabLabelClient {
	requestOptional<T>(method: string, params: unknown): Promise<T | null>;
	isUnsupported(method: string): boolean;
	/** Registers for a server event name (`tab_renamed`); returns the unsubscribe. */
	on(type: string, handler: (event: { event: string; data: Record<string, unknown> }) => void): Unsubscribe;
}

/** The slice of `WorkspaceScope` the cache reads. */
export interface TabLabelScope {
	readonly workspaceId: string | null;
	/** Tab ids of the panes in scope now: what one `tab.list` answers for. */
	tabIds(): Iterable<string>;
	onWorkspaceResolved(handler: () => void): Unsubscribe;
}

export interface TabLabelCacheDeps {
	client: TabLabelClient;
	scope: TabLabelScope;
	/**
	 * True while the connection that owns this cache is still the published
	 * one. Read after every await: a response for a retired connection is
	 * dropped on the floor.
	 */
	alive(): boolean;
}

/** The `tab.list` result shape the cache reads; unknown fields are ignored. */
interface TabListResult {
	tabs?: TabInfo[];
}

/** Turns one `tab.list` tab into a label, or null when the entry is unusable. */
function labelOf(tab: unknown): [string, string] | null {
	if (typeof tab !== 'object' || tab === null) return null;
	const record = tab as Record<string, unknown>;
	if (typeof record.tab_id !== 'string') return null;
	// Live `tab.list` labels carry herdr's own status prefix ("! trauma",
	// "? vault-maintenance"); the rows' own status colours already say that.
	const label = typeof record.label === 'string' ? stripTitleSpinner(record.label) : '';
	return [record.tab_id, label || record.tab_id];
}

export class TabLabelCache {
	/** Labels by workspace id, then by tab id. */
	private readonly entries = new Map<string, Map<string, string>>();
	/**
	 * Tab ids a `tab.list` has already covered, per workspace, whether or not it
	 * returned a label for them. This is what keeps `ensure()` bounded.
	 */
	private readonly asked = new Map<string, Set<string>>();
	private readonly listeners = new Set<() => void>();
	private readonly unsubscribe: Unsubscribe[] = [];
	private inFlight: Promise<void> | null = null;
	/** Tab ids the request in flight answers for; a second ask for one is moot. */
	private inFlightAsked: Set<string> | null = null;
	/** A request arrived mid-flight: ask once more when the flight lands. */
	private queued = false;
	private disposed = false;

	constructor(private readonly deps: TabLabelCacheDeps) {
		this.unsubscribe.push(
			deps.client.on('tab_renamed', (event) => this.onRenamed(event.data)),
			deps.scope.onWorkspaceResolved(() => this.onWorkspaceResolved()),
		);
	}

	/** The label of a tab in the current workspace, or undefined until known. */
	get(tabId: string): string | undefined {
		return this.current()?.get(tabId);
	}

	/** Every known label of the current workspace. Never fetches. */
	labels(): ReadonlyMap<string, string> {
		return this.current() ?? new Map<string, string>();
	}

	/**
	 * Asks for a fetch when this workspace has never been listed, or when
	 * `tabId` is one no `tab.list` has covered yet. Bounded: a tab herdr keeps
	 * omitting is asked about once, then falls back to its id for good. Safe to
	 * call from a view's bind and `added` handlers; never from a render.
	 */
	ensure(tabId?: string): void {
		const workspaceId = this.deps.scope.workspaceId;
		if (!workspaceId) return;
		if (this.inFlight && (tabId === undefined || this.inFlightAsked?.has(tabId))) return;
		const asked = this.asked.get(workspaceId);
		if (!asked) {
			this.fetch();
			return;
		}
		if (tabId !== undefined && !asked.has(tabId) && !this.entries.get(workspaceId)?.has(tabId)) {
			this.fetch();
		}
	}

	/** Forces one more `tab.list` for the current workspace, coalesced. */
	refresh(): void {
		this.fetch();
	}

	/** Runs `listener` after every change of what `labels()` would answer. */
	subscribe(listener: () => void): Unsubscribe {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Drops subscriptions and makes every pending answer a no-op. */
	dispose(): void {
		this.disposed = true;
		for (const off of this.unsubscribe.splice(0)) off();
		this.listeners.clear();
		this.entries.clear();
		this.asked.clear();
	}

	private current(): Map<string, string> | undefined {
		const workspaceId = this.deps.scope.workspaceId;
		return workspaceId ? this.entries.get(workspaceId) : undefined;
	}

	/**
	 * A rename for the current workspace is applied in place; another
	 * workspace's rename says nothing about this one and is ignored. A rename
	 * for a tab this cache has not listed yet is still recorded: the next
	 * `tab.list` overwrites it with the same value.
	 */
	private onRenamed(data: Record<string, unknown>): void {
		if (this.disposed) return;
		const workspaceId = this.deps.scope.workspaceId;
		if (!workspaceId || data.workspace_id !== workspaceId) return;
		if (typeof data.tab_id !== 'string' || typeof data.label !== 'string') return;
		const label = stripTitleSpinner(data.label) || data.tab_id;
		let labels = this.entries.get(workspaceId);
		if (!labels) {
			labels = new Map();
			this.entries.set(workspaceId, labels);
		}
		if (labels.get(data.tab_id) === label) return;
		labels.set(data.tab_id, label);
		this.notify();
	}

	/**
	 * Tab ids belong to a workspace: whatever was known, or asked, about the
	 * previous one says nothing about the next. Everything is dropped and, if
	 * there is a workspace now, listed again; a `tab.list` still in flight for
	 * the previous workspace fails its check when it lands.
	 */
	private onWorkspaceResolved(): void {
		if (this.disposed) return;
		this.entries.clear();
		this.asked.clear();
		this.notify();
		if (this.deps.scope.workspaceId) this.fetch();
	}

	private fetch(): void {
		if (this.disposed) return;
		const { client, scope } = this.deps;
		const workspaceId = scope.workspaceId;
		if (!workspaceId) return;
		// A herdr without `tab.list` said so once already (PRD M3): the entry is
		// explicitly empty rather than absent, so nothing keeps asking.
		if (client.isUnsupported('tab.list')) {
			this.settle(workspaceId, new Map(), new Set());
			return;
		}
		if (this.inFlight) {
			this.queued = true;
			return;
		}
		// Snapshot before awaiting: these are the ids this request answers for,
		// and they count as asked even when the answer omits them.
		const asked = new Set(scope.tabIds());
		this.inFlightAsked = asked;
		this.inFlight = client
			.requestOptional<TabListResult>('tab.list', { workspace_id: workspaceId })
			.then(
				(result) => {
					// The generation check: a retired connection, a disposed cache or
					// a workspace that moved on while the request was out all mean the
					// answer is about something no view shows any more.
					if (this.disposed || !this.deps.alive()) return;
					if (scope.workspaceId !== workspaceId) return;
					const labels = new Map<string, string>();
					for (const tab of result?.tabs ?? []) {
						const entry = labelOf(tab);
						if (entry) labels.set(entry[0], entry[1]);
					}
					this.settle(workspaceId, labels, asked);
				},
				() => {
					// A dead socket or a refused call: keep whatever was known and
					// mark nothing asked, so the next new pane may try again.
				},
			)
			.finally(() => {
				this.inFlight = null;
				this.inFlightAsked = null;
				if (this.queued) {
					this.queued = false;
					this.fetch();
				}
			});
	}

	/** Writes one answer, empty or not, and tells the views. */
	private settle(workspaceId: string, labels: Map<string, string>, asked: Set<string>): void {
		const covered = this.asked.get(workspaceId) ?? new Set<string>();
		for (const tabId of asked) covered.add(tabId);
		for (const tabId of labels.keys()) covered.add(tabId);
		this.asked.set(workspaceId, covered);
		this.entries.set(workspaceId, labels);
		this.notify();
	}

	private notify(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// One view's repaint failing must not stop the others hearing.
			}
		}
	}
}
