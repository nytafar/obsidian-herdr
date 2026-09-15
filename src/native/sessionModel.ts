/**
 * The session model (issues #93 and #94, ADR-0003).
 *
 * The plugin-held, per-pane reduced state of a transcript (CONTEXT.md). One
 * model per pane, reference counted, so two native tabs on the same pane — and
 * later the table of contents — follow one file once and see the same turns.
 *
 * What it knows and nobody else does: which file is the pane's *current*
 * transcript, and when that stops being true. The path is the pane's cwd and
 * herdr's `agent_session`, which appears after the first prompt and rotates on
 * `/clear`. Rotation has no event of its own, so the model reads the
 * `agent_session` field of `pane.updated` for its own pane, deduplicated by
 * value: the one recorded exception to reacting only to status transitions
 * (CLAUDE.md, ADR-0003). **Following is strict**: on a rotation the old session
 * is dropped whole and the new file is read from its beginning.
 *
 * Content comes from the transcript source, meaning from the reducer, and
 * status from herdr's `agent_status` transitions; none of those three knows a
 * pane exists.
 *
 * No Obsidian here: the view layer subscribes, and `src/main.ts` holds the
 * registry and hands it a watcher over the connected herdr.
 */

import { emptyTranscript, reduce, type TranscriptState } from './reducer';
import {
	transcriptPath,
	type TranscriptSource,
	type TranscriptStream,
} from './transcriptSource';
import type { HerdrEvent } from '../herdr/client';
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

export type Unsubscribe = () => void;

/**
 * The herdr the models read from. `src/main.ts` builds one over the published
 * connection's scope and client; a test fakes it with a plain object.
 */
export interface SessionWatcher {
	/** The pane as herdr last reported it, or null when it is not in scope. */
	snapshot(paneId: string): PaneSnapshot | null;
	/** Raw `pane_updated` pushes. Only `agent_session` is ever read from them. */
	onEvent(handler: (event: HerdrEvent) => void): Unsubscribe;
	/** Agent status transitions, one call per actual change. */
	onStatus(handler: (paneId: string, status: AgentStatus) => void): Unsubscribe;
}

/** What a subscriber is told when a model's state moved. */
export interface SessionChange {
	/** Turns created or changed, in order. Empty when only the status moved. */
	changedTurnIds: string[];
	/** The whole view is stale: reloaded, or the session rotated. */
	reset: boolean;
}

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

/** The part of a `WorkspaceScope` a watcher reads. Structural, so a test fakes it. */
export interface WatchableScope {
	get(paneId: string): PaneState | undefined;
	paneInfo(paneId: string): PaneInfo | undefined;
	on(
		event: 'changed',
		handler: (paneId: string, prev: PaneState, next: PaneState) => void,
	): Unsubscribe;
}

/** The part of a `HerdrClient` a watcher reads: one event name. */
export interface WatchableClient {
	on(type: 'pane_updated', handler: (event: HerdrEvent) => void): Unsubscribe;
}

/** The scope and client of one endpoint session, which is what the plugin has. */
export interface WatchableSession {
	scope: WatchableScope;
	client: WatchableClient;
}

/**
 * The `agent_session` a `pane_updated` carries for `paneId`, or undefined when
 * the event is not about that pane at all.
 *
 * The exception in one function: nothing else reads a raw pane update, and what
 * it reads is one field. An event for this pane with no `agent_session` is an
 * empty string — a pane whose agent is gone, or one that has not prompted yet —
 * which is a different answer from "not this pane".
 */
export function agentSessionFromEvent(event: HerdrEvent, paneId: string): string | undefined {
	if (event.event !== 'pane_updated') return undefined;
	const pane = event.data.pane;
	if (typeof pane !== 'object' || pane === null) return undefined;
	const info = pane as { pane_id?: unknown; agent_session?: { value?: unknown } | null };
	if (info.pane_id !== paneId) return undefined;
	const value = info.agent_session?.value;
	return typeof value === 'string' ? value : '';
}

/**
 * A watcher over a connected herdr.
 *
 * Three sources, because herdr says these three things in three places: the
 * scope's `PaneState` for cwd and status, the raw `PaneInfo` it keeps for
 * `agent_session` (nothing renders that field, so `PaneState` never carried
 * it), and the client's event stream for the rotation exception.
 */
export function scopeWatcher(session: WatchableSession | null): SessionWatcher | null {
	if (!session) return null;
	const { scope, client } = session;
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
		onEvent(handler): Unsubscribe {
			return client.on('pane_updated', handler);
		},
		onStatus(handler): Unsubscribe {
			return scope.on('changed', (paneId, prev, next) => {
				// A transition, not every update: herdr emits about ten pane updates
				// a second and the scope passes on every renderable difference.
				if (prev.agentStatus !== next.agentStatus) handler(paneId, next.agentStatus);
			});
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

/** One pane's transcript, reduced, kept current. */
export class SessionModel implements SessionModelView {
	readonly paneId: string;
	private readonly options: SessionModelOptions;
	private transcript: TranscriptState = emptyTranscript();
	private readonly listeners = new Set<(change: SessionChange) => void>();
	private currentPath: string | null = null;
	private session = '';
	private status: AgentStatus = 'unknown';
	/** The tail of the file being shown, closed on rotation and on release. */
	private stream: TranscriptStream | null = null;
	/** Unsubscribes from the herdr currently bound; replaced by `rebind`. */
	private bound: Unsubscribe[] = [];

	constructor(options: SessionModelOptions) {
		this.options = options;
		this.paneId = options.paneId;
	}

	/**
	 * Subscribes to herdr and starts following the pane's session. The registry
	 * calls it once, when the first subscriber arrives.
	 */
	start(): void {
		this.bind();
		this.follow();
	}

	/**
	 * Takes the herdr that is connected *now*. Endpoint sessions are replaced on
	 * every reconnect and on an endpoint switch, so a model that kept the old
	 * subscription would quietly stop following (#94).
	 */
	rebind(): void {
		this.bind();
		this.follow();
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

	/** Closes the tail and drops every subscriber, here and in herdr. */
	dispose(): void {
		this.unbind();
		this.stream?.close();
		this.stream = null;
		this.listeners.clear();
	}

	/** Subscribes to the herdr that is connected now, dropping any older one. */
	private bind(): void {
		this.unbind();
		const watcher = this.options.watcher();
		if (!watcher) return;
		this.bound.push(
			watcher.onEvent((event) => this.onPaneEvent(event)),
			watcher.onStatus((paneId, status) => this.onStatusChanged(paneId, status)),
		);
	}

	private unbind(): void {
		for (const off of this.bound.splice(0)) off();
	}

	/**
	 * The rotation exception. The event's `agent_session` is compared with the
	 * one being shown and nothing else happens when they match, which is most of
	 * the time: herdr emits a pane update about ten times a second.
	 */
	private onPaneEvent(event: HerdrEvent): void {
		const session = agentSessionFromEvent(event, this.paneId);
		if (session === undefined || session === this.session) return;
		this.follow();
	}

	private onStatusChanged(paneId: string, status: AgentStatus): void {
		if (paneId !== this.paneId || status === this.status) return;
		this.status = status;
		// No turn changed; the view redraws what it shows between blocks.
		this.emit({ changedTurnIds: [], reset: false });
	}

	/**
	 * Re-reads the pane's identity and follows whatever transcript it names now.
	 * A path that has not changed is left alone, tail and state and all; a new
	 * one starts from empty, because the session before it is simply gone.
	 */
	private follow(): void {
		const pane = this.options.watcher()?.snapshot(this.paneId) ?? null;
		this.session = pane?.agentSession ?? '';
		this.status = pane?.agentStatus ?? 'unknown';
		const path = pane
			? transcriptPath({ cwd: pane.cwd, agentSession: pane.agentSession, home: this.options.home })
			: null;
		if (path === this.currentPath && this.stream) return;
		this.stream?.close();
		this.stream = null;
		this.currentPath = path;
		this.transcript = emptyTranscript();
		// Said now, not when the new file's first lines land: a tail delivers
		// those asynchronously, and the session that is gone must not still be on
		// screen in between.
		this.emit({ changedTurnIds: [], reset: true });
		if (!path) return;
		// The tail delivers the file as it stands before anything is appended, so
		// there is no gap between reading the history and following it.
		this.stream = this.options.source.open(path, (lines) => this.onLines(lines));
	}

	/** A batch of whole lines from the tail. */
	private onLines(lines: string[]): void {
		const { state, changedTurnIds } = reduce(this.transcript, lines);
		this.transcript = state;
		this.emit({ changedTurnIds, reset: false });
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
 * being tailed and a subscription nobody reads, and this is also what makes
 * "two tabs on one pane" a single tail (ADR-0003). A hidden tab keeps its hold,
 * so it catches up the moment it is revealed.
 */
export class SessionModelRegistry {
	private readonly models = new Map<string, { model: SessionModel; holders: number }>();

	constructor(private readonly options: SessionModelRegistryOptions) {}

	/** Whether a model for `paneId` is currently held. */
	has(paneId: string): boolean {
		return this.models.has(paneId);
	}

	/**
	 * The model for a pane, built and started on the first hold. The caller must
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
			// The first hold pays for the tail; the second one just subscribes.
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

	/** Every model takes the herdr that is connected now (`onScopeReplaced`). */
	rebind(): void {
		for (const entry of this.models.values()) entry.model.rebind();
	}

	/** Drops every model and closes every tail. `onunload` only. */
	dispose(): void {
		for (const entry of this.models.values()) entry.model.dispose();
		this.models.clear();
	}
}
