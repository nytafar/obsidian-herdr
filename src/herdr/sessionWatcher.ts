/**
 * herdr's session watcher (ADR-0003): what the native view's session models
 * read of a herdr pane, behind the kind-neutral contract in
 * `../native/sessionWatcher.ts`.
 *
 * Three sources, because herdr says these three things in three places: the
 * scope's `PaneState` for cwd and status, the raw `PaneInfo` it keeps for
 * `agent_session` (nothing renders that field, so `PaneState` never carried
 * it), and the client's event stream for rotation. Rotation (`/clear`) has no
 * event of its own, so this reads the `agent_session` field of `pane.updated`:
 * the one recorded exception to reacting only to status transitions
 * (CLAUDE.md), and the only place in the plugin that reads a raw pane update.
 *
 * herdr reports no kind of block (`blocked` is all it says) and no transcript
 * path, so neither is ever set here: the model derives the path from cwd and
 * session, and the waiting card reads the block off the transcript's shape.
 */

import type { HerdrEvent } from './client';
import type { PaneState } from './scope';
import type { PaneInfo } from './types.gen';
import type { PaneSnapshot, SessionWatcher, Unsubscribe } from '../native/sessionWatcher';

/** The part of a `WorkspaceScope` the watcher reads. Structural, so a test fakes it. */
export interface WatchableScope {
	get(paneId: string): PaneState | undefined;
	paneInfo(paneId: string): PaneInfo | undefined;
	on(
		event: 'changed',
		handler: (paneId: string, prev: PaneState, next: PaneState) => void,
	): Unsubscribe;
	on(event: 'added' | 'removed', handler: (pane: PaneState) => void): Unsubscribe;
}

/** The part of a `HerdrClient` the watcher reads: one event name. */
export interface WatchableClient {
	on(type: 'pane_updated', handler: (event: HerdrEvent) => void): Unsubscribe;
}

/** The scope and client of one herdr connection. */
export interface WatchableSession {
	scope: WatchableScope;
	client: WatchableClient;
}

/**
 * The pane a `pane_updated` is about and the `agent_session` it carries, or
 * null when the event is not a pane update at all.
 *
 * The exception in one function: nothing else reads a raw pane update, and what
 * it reads is one field. An update with no `agent_session` is an empty string —
 * a pane whose agent is gone, or one that has not prompted yet — which is a
 * different answer from "not a pane update".
 */
export function paneSessionFromEvent(
	event: HerdrEvent,
): { paneId: string; agentSession: string } | null {
	if (event.event !== 'pane_updated') return null;
	const pane = event.data.pane;
	if (typeof pane !== 'object' || pane === null) return null;
	const info = pane as { pane_id?: unknown; agent_session?: { value?: unknown } | null };
	if (typeof info.pane_id !== 'string') return null;
	const value = info.agent_session?.value;
	return { paneId: info.pane_id, agentSession: typeof value === 'string' ? value : '' };
}

/** A watcher over one connected herdr, or null when there is none. */
export function herdrSessionWatcher(session: WatchableSession | null): SessionWatcher | null {
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
		onSession(handler): Unsubscribe {
			// The client hands an event to its exact-name handlers before its `'*'`
			// ones, and the scope ingests on `'*'`: read synchronously, `snapshot`
			// would still hold the session this very event replaces. A microtask
			// runs once the whole dispatch is done.
			let live = true;
			const off = client.on('pane_updated', (event) =>
				queueMicrotask(() => {
					if (!live) return;
					const update = paneSessionFromEvent(event);
					if (update) handler(update.paneId, update.agentSession);
				}),
			);
			return () => {
				live = false;
				off();
			};
		},
		onStatus(handler): Unsubscribe {
			return scope.on('changed', (paneId, prev, next) => {
				// A transition, not every update: herdr emits about ten pane updates
				// a second and the scope passes on every renderable difference.
				if (prev.agentStatus !== next.agentStatus) handler(paneId, next.agentStatus);
			});
		},
		onMembership(handler): Unsubscribe {
			// `removed` is a pane that closed, left the scoped workspace or moved to
			// another; `added` is one that arrived, including every pane a fresh
			// connection's first prime finds after the models have already rebound
			// to its still empty scope. Either way the model re-reads the pane.
			const offAdded = scope.on('added', (pane) => handler(pane.paneId));
			const offRemoved = scope.on('removed', (pane) => handler(pane.paneId));
			return () => {
				offAdded();
				offRemoved();
			};
		},
	};
}
