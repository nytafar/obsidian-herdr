/**
 * The herdr-core scope (ADR-0005): the vault's agent terminals on one core,
 * as the same rows and the same `added` / `changed` / `removed` /
 * `workspaceResolved` events the herdr workspace scope gives, so the list,
 * the notifier and the status bar read either the same way.
 *
 * Fed by the client's subscription in wire order: {@link reset} with the
 * subscribe snapshot (and every `missed`), {@link ingest} with each event,
 * and {@link setSpaces} with the `herdr-app` document's spaces. Until the
 * spaces have been read once the scope is unresolved, so a vault matched by
 * space name never flashes its cwd fallback first.
 *
 * Rows are recomputed from the store on every change and diffed, so only a
 * renderable difference emits (PRD N4): `foreground` polls arrive about twice
 * a second and almost never move a row.
 *
 * No I/O, no Obsidian.
 */

import {
	relevantDiff,
	type PaneState,
	type ResolutionMethod,
	type ScopeEventMap,
	type Unsubscribe,
} from '../herdr/scope';
import type { ConnectionScope } from '../connection';
import {
	cwdOf,
	inHcScope,
	resolveHcScope,
	spaceTabLabels,
	TerminalStore,
	toHcPaneState,
	type HcScopeResolution,
	type HcSpace,
	type HcTerminal,
} from './model';
import type { HcEvent } from './streams';

/** See {@link HcScope.onIngested}. */
export type IngestListener = (address: string | null, type: string) => void;

export interface HcScopeOptions {
	/** The runtime's space override (id or name); empty resolves. */
	space: string;
	/** This vault's path on this machine. */
	vaultPath: string;
	/** Compared against space names. */
	vaultName: string;
	/** The vault's path on the remote host, preferred for the cwd rule on `ssh`. */
	remoteVaultPath?: string;
}

export class HcScope implements ConnectionScope {
	private readonly store = new TerminalStore();
	private rows = new Map<string, PaneState>();
	private spaces: HcSpace[] | null = null;
	private resolution: HcScopeResolution = { kind: 'none', method: 'none' };
	private statusSeq = 0;
	private readonly handlers = new Map<string, Set<(...args: never) => void>>();
	private readonly docListeners = new Set<() => void>();
	private readonly tabListeners = new Set<() => void>();
	private readonly ingestListeners = new Set<IngestListener>();

	constructor(private readonly options: HcScopeOptions) {}

	/** The space id, or the vault root in cwd mode; null while unresolved. */
	get workspaceId(): string | null {
		if (this.resolution.kind === 'space') return this.resolution.id;
		if (this.resolution.kind === 'cwd') return this.resolution.root;
		return null;
	}

	get workspaceLabel(): string | null {
		if (this.resolution.kind === 'space') return this.resolution.name;
		if (this.resolution.kind === 'cwd') return `terminals under ${this.resolution.root}`;
		return null;
	}

	get method(): ResolutionMethod {
		return this.resolution.method;
	}

	/** The resolved space, for labelling terminals the plugin starts; null in cwd mode. */
	get space(): { id: string; name: string | null } | null {
		return this.resolution.kind === 'space'
			? { id: this.resolution.id, name: this.resolution.name }
			: null;
	}

	/** Whether the `herdr-app` document has been read (or found missing) once. */
	get spacesLoaded(): boolean {
		return this.spaces !== null;
	}

	get size(): number {
		return this.rows.size;
	}

	list(): PaneState[] {
		return [...this.rows.values()];
	}

	get(paneId: string): PaneState | undefined {
		return this.rows.get(paneId);
	}

	/** The raw record behind a row, or any terminal on the core. */
	terminal(address: string): HcTerminal | undefined {
		return this.store.get(address);
	}

	/** Every terminal on the core, in scope or not, as last reported. */
	terminals(): HcTerminal[] {
		return this.store.all();
	}

	/** Names of every live terminal on the core: a new one must not reuse any. */
	agentNames(): Set<string> {
		const names = new Set<string>();
		for (const terminal of this.store.all()) {
			if (terminal.name && terminal.state !== 'finished') names.add(terminal.name);
		}
		return names;
	}

	/** Pinned rows, via the shared `herdr.pinned` label, in list order. */
	pinnedPaneIds(): string[] {
		return this.list()
			.filter((row) => row.pinned === true)
			.map((row) => row.paneId);
	}

	/** Tab id to label for the resolved space (herdr-app tabs). */
	tabLabels(): Map<string, string> {
		if (this.resolution.kind !== 'space' || !this.spaces) return new Map();
		const id = this.resolution.id;
		return spaceTabLabels(this.spaces.find((space) => space.id === id) ?? null);
	}

	/** Snapshot (subscribe reply or `missed`): replaces every terminal. */
	reset(seq: number, terminals: readonly unknown[]): void {
		this.store.reset(seq, terminals);
		this.reconcile();
		this.emitIngested(null, 'snapshot');
	}

	/** One event from the stream, in order. */
	ingest(event: HcEvent): void {
		if (event.type === 'doc') {
			const name = (event.data as { name?: unknown } | null)?.name;
			if (name === 'herdr-app') for (const listener of [...this.docListeners]) listener();
			return;
		}
		if (!this.store.apply(event)) return;
		this.reconcile();
		if (event.terminal) this.emitIngested(event.terminal, event.type);
	}

	/**
	 * Every change to a terminal's record, once the store holds it and the
	 * rows have been reconciled: the event's terminal and type, or a null
	 * address and `snapshot` when every terminal was replaced at once. For
	 * readers of what the rows leave out — the session label and the
	 * foreground pid (`./sessionWatcher.ts`), and what kicks a transcript read
	 * (`./transcriptSource.ts`) — which must see the record as the event left
	 * it.
	 */
	onIngested(listener: IngestListener): Unsubscribe {
		this.ingestListeners.add(listener);
		return () => this.ingestListeners.delete(listener);
	}

	private emitIngested(address: string | null, type: string): void {
		for (const listener of [...this.ingestListeners]) {
			try {
				listener(address, type);
			} catch {
				// One bad subscriber must not stop the others or the event stream.
			}
		}
	}

	/** Called when the `herdr-app` document changed and should be read again. */
	onDocChanged(listener: () => void): Unsubscribe {
		this.docListeners.add(listener);
		return () => this.docListeners.delete(listener);
	}

	/** The `herdr-app` spaces, or an empty list when the core has none. */
	setSpaces(spaces: readonly HcSpace[]): void {
		this.spaces = [...spaces];
		this.reconcile();
		// Tab names may have moved without the resolution moving.
		this.emitTabLabelsChanged();
	}

	/** Takes a terminal out at once, for an answer that says it is gone. */
	forget(paneId: string): void {
		this.store.delete(paneId);
		this.reconcile();
		this.emitIngested(paneId, 'removed');
	}

	/** herdr-core announces every change, so there is nothing to poll. */
	refresh(): Promise<void> {
		return Promise.resolve();
	}

	on<K extends keyof ScopeEventMap>(type: K, handler: (...args: ScopeEventMap[K]) => void): Unsubscribe {
		let set = this.handlers.get(type);
		if (!set) {
			set = new Set();
			this.handlers.set(type, set);
		}
		const stored = handler as unknown as (...args: never) => void;
		set.add(stored);
		return () => {
			this.handlers.get(type)?.delete(stored);
		};
	}

	/** Tab names may have moved: `HcTabLabels` subscribes here. */
	onTabLabelsChanged(listener: () => void): Unsubscribe {
		this.tabListeners.add(listener);
		return () => this.tabListeners.delete(listener);
	}

	private emitTabLabelsChanged(): void {
		for (const listener of [...this.tabListeners]) {
			try {
				listener();
			} catch {
				// One bad subscriber must not stop the others.
			}
		}
	}

	private reconcile(): void {
		const previous = this.resolution;
		this.resolution = this.spaces
			? resolveHcScope(this.spaces, {
					space: this.options.space,
					vaultName: this.options.vaultName,
					root: this.options.remoteVaultPath?.trim() || this.options.vaultPath,
					terminalCwd: (address) => {
						const terminal = this.store.get(address);
						return terminal ? cwdOf(terminal) : undefined;
					},
				})
			: { kind: 'none', method: 'none' };
		const resolved = !sameResolution(previous, this.resolution);
		const scopeId = this.workspaceId ?? '';

		const next = new Map<string, PaneState>();
		for (const terminal of this.store.all()) {
			if (!inHcScope(terminal, this.resolution)) continue;
			const old = this.rows.get(terminal.address);
			const row = toHcPaneState(terminal, scopeId, old?.statusChangedSeq ?? 0);
			if (!row) continue;
			if (old && old.agentStatus !== row.agentStatus) row.statusChangedSeq = ++this.statusSeq;
			next.set(row.paneId, row);
		}
		const before = this.rows;
		this.rows = next;
		if (resolved) this.emit('workspaceResolved', this.workspaceId, this.method);
		for (const [paneId, row] of before) {
			if (!next.has(paneId)) this.emit('removed', row);
		}
		for (const [paneId, row] of next) {
			const old = before.get(paneId);
			if (!old) this.emit('added', row);
			else if (relevantDiff(old, row).length > 0 || old.pinned !== row.pinned) {
				this.emit('changed', paneId, old, row);
			}
		}
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

function sameResolution(a: HcScopeResolution, b: HcScopeResolution): boolean {
	if (a.kind !== b.kind || a.method !== b.method) return false;
	if (a.kind === 'space' && b.kind === 'space') return a.id === b.id && a.name === b.name;
	if (a.kind === 'cwd' && b.kind === 'cwd') return a.root === b.root;
	return true;
}
