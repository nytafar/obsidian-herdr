/**
 * The session model (issue #93, ADR-0003).
 *
 * The plugin-held, per-pane reduced state of a transcript (CONTEXT.md). One
 * model per pane, reference counted, so two native tabs on the same pane — and
 * later the table of contents — read one file once and see the same turns.
 *
 * What it knows and nobody else does: which file is the pane's *current*
 * transcript. That is the pane's cwd and herdr's `agent_session`, which appears
 * after the first prompt and rotates on `/clear`; following that rotation is
 * issue #94's half. Content comes from the transcript source, meaning comes
 * from the reducer, and neither of those knows a pane exists.
 *
 * No Obsidian here: the view layer subscribes, and `src/main.ts` holds the
 * registry and hands it a watcher over the connected herdr.
 */

import { emptyTranscript, reduce, type TranscriptState } from './reducer';
import { transcriptPath, type TranscriptSource } from './transcriptSource';
import type { PaneState } from '../herdr/scope';
import type { AgentStatus, PaneInfo } from '../herdr/types.gen';

/** What the model needs to know about a pane, and no more. */
export interface PaneSnapshot {
	paneId: string;
	/** The pane's working directory: half of the transcript's path. */
	cwd: string;
	/** herdr's `agent_session` value, empty until the session exists. */
	agentSession: string;
	agentStatus: AgentStatus;
}

/**
 * The herdr the models read from. `src/main.ts` builds one over the published
 * connection's scope; a test fakes it with a plain object.
 */
export interface SessionWatcher {
	/** The pane as herdr last reported it, or null when it is not in scope. */
	snapshot(paneId: string): PaneSnapshot | null;
}

/** What a subscriber is told when a model's state moved. */
export interface SessionChange {
	/** Turns created or changed, in order. Empty when only the status moved. */
	changedTurnIds: string[];
	/** The whole view is stale: reloaded, or the session rotated (#94). */
	reset: boolean;
}

export type Unsubscribe = () => void;

/**
 * What a view may read from a model. The narrow half of {@link SessionModel},
 * so a surface test can drive a fake through the same interface the real one
 * satisfies.
 */
export interface SessionModelView {
	readonly state: TranscriptState;
	/** The transcript being shown, or null while the pane has no session yet. */
	readonly path: string | null;
	readonly agentSession: string;
	readonly agentStatus: AgentStatus;
	/** Settles when the first load has finished; never rejects. */
	readonly ready: Promise<void>;
	on(listener: (change: SessionChange) => void): Unsubscribe;
}

/** One subscriber's hold on a model of type `T`. */
export interface SessionHandleOf<T> {
	model: T;
	release(): void;
}

/** What a view asks for a model: the registry, narrowed to what it uses. */
export interface SessionModels {
	acquire(paneId: string): SessionHandleOf<SessionModelView>;
}

/** The part of a {@link WorkspaceScope} a watcher reads. Structural, so a test fakes it. */
export interface WatchableScope {
	get(paneId: string): PaneState | undefined;
	paneInfo(paneId: string): PaneInfo | undefined;
}

/**
 * A watcher over a connected herdr's scope.
 *
 * Two sources, because the scope keeps two things: `PaneState`, the fields the
 * plugin renders, which is where cwd and status come from; and the raw
 * `PaneInfo` herdr last sent, which is the only place `agent_session` lives —
 * nothing renders it, so `PaneState` never carried it.
 */
export function scopeWatcher(scope: WatchableScope | null): SessionWatcher | null {
	if (!scope) return null;
	return {
		snapshot(paneId: string): PaneSnapshot | null {
			const pane = scope.get(paneId);
			if (!pane) return null;
			return {
				paneId,
				cwd: pane.cwd,
				agentSession: scope.paneInfo(paneId)?.agent_session?.value ?? '',
				agentStatus: pane.agentStatus,
			};
		},
	};
}

export interface SessionModelOptions {
	paneId: string;
	source: TranscriptSource;
	/** The connected herdr, re-read on every use: it is replaced on reconnect. */
	watcher: () => SessionWatcher | null;
	/** Home directory of the transcript's host. Defaults to this machine's. */
	home?: string;
}

/** One pane's transcript, reduced. */
export class SessionModel implements SessionModelView {
	readonly paneId: string;
	private readonly options: SessionModelOptions;
	private transcript: TranscriptState = emptyTranscript();
	private readonly listeners = new Set<(change: SessionChange) => void>();
	private currentPath: string | null = null;
	private session = '';
	private status: AgentStatus = 'unknown';
	private loaded: Promise<void> = Promise.resolve();

	constructor(options: SessionModelOptions) {
		this.options = options;
		this.paneId = options.paneId;
	}

	/**
	 * Reads the pane and its transcript for the first time. The registry calls
	 * it once, when the first subscriber arrives; {@link ready} settles with it.
	 */
	start(): void {
		this.loaded = this.refresh();
	}

	/** Settles when the first load has finished. Never rejects. */
	get ready(): Promise<void> {
		return this.loaded;
	}

	/** The reduced transcript as it stands. Never mutated in place. */
	get state(): TranscriptState {
		return this.transcript;
	}

	/** The file being shown, or null while the pane has no session yet. */
	get path(): string | null {
		return this.currentPath;
	}

	/** herdr's `agent_session` for the pane, empty when there is none yet. */
	get agentSession(): string {
		return this.session;
	}

	/** herdr's view of the agent: what the view shows between blocks. */
	get agentStatus(): AgentStatus {
		return this.status;
	}

	/** Subscribes to state changes. Safe to call twice; unsubscribe is idempotent. */
	on(listener: (change: SessionChange) => void): Unsubscribe {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Re-reads the pane's identity and its whole transcript, replacing the state.
	 * This is what an open does, and what a rotation does (#94): the session
	 * model keeps nothing of the session it was showing before.
	 */
	async refresh(): Promise<void> {
		const pane = this.options.watcher()?.snapshot(this.paneId) ?? null;
		this.session = pane?.agentSession ?? '';
		this.status = pane?.agentStatus ?? 'unknown';
		this.currentPath = pane
			? transcriptPath({ cwd: pane.cwd, agentSession: pane.agentSession, home: this.options.home })
			: null;
		const text = this.currentPath ? await this.options.source.read(this.currentPath) : null;
		const lines = (text ?? '').split('\n').filter((line) => line !== '');
		const { state, changedTurnIds } = reduce(emptyTranscript(), lines);
		this.transcript = state;
		this.emit({ changedTurnIds, reset: true });
	}

	/** Drops every subscriber. The registry calls this when the last leaf lets go. */
	dispose(): void {
		this.listeners.clear();
	}

	private emit(change: SessionChange): void {
		for (const listener of [...this.listeners]) listener(change);
	}
}

/** One subscriber's hold on a model. Releasing twice is the same as once. */
export type SessionHandle = SessionHandleOf<SessionModel>;

export interface SessionModelRegistryOptions {
	source: TranscriptSource;
	watcher: () => SessionWatcher | null;
	home?: string;
}

/**
 * The plugin's session models, one per pane while anything is watching it.
 *
 * Reference counted rather than cached: a model that nobody watches is a file
 * handle and a subscription nobody reads, and this is also what makes "two
 * tabs on one pane" a single read (ADR-0003).
 */
export class SessionModelRegistry {
	private readonly models = new Map<string, { model: SessionModel; holders: number }>();

	constructor(private readonly options: SessionModelRegistryOptions) {}

	/** Whether a model for `paneId` is currently held. Used by the tests. */
	has(paneId: string): boolean {
		return this.models.has(paneId);
	}

	/**
	 * The model for a pane, built and loaded on the first hold. The caller must
	 * release exactly once; a released handle can be released again harmlessly.
	 */
	acquire(paneId: string): SessionHandle {
		let entry = this.models.get(paneId);
		if (!entry) {
			entry = {
				model: new SessionModel({
					paneId,
					source: this.options.source,
					watcher: this.options.watcher,
					home: this.options.home,
				}),
				holders: 0,
			};
			this.models.set(paneId, entry);
			// The first hold pays for the read; the second one just subscribes.
			entry.model.start();
		}
		entry.holders++;
		const held = entry;
		let live = true;
		return {
			model: held.model,
			release: () => {
				if (!live) return;
				live = false;
				held.holders--;
				if (held.holders > 0) return;
				this.models.delete(paneId);
				held.model.dispose();
			},
		};
	}

	/** Drops every model. `onunload` only. */
	dispose(): void {
		for (const entry of this.models.values()) entry.model.dispose();
		this.models.clear();
	}
}
