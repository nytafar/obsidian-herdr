/**
 * herdr's session watcher (ADR-0003): the pane as herdr reports it, behind
 * the kind-neutral contract the session models read.
 *
 * The `pane_updated` events are raw, the shape herdr really sends, because
 * reading `agent_session` off them is the one recorded exception to "react to
 * status transitions, never to raw pane updates" (CLAUDE.md, ADR-0003) and the
 * exception is only sound if the parsing is.
 */

import { describe, expect, it } from 'vitest';
import {
	herdrSessionWatcher,
	paneSessionFromEvent,
	type WatchableScope,
} from '../src/herdr/sessionWatcher';
import type { Unsubscribe } from '../src/native/sessionWatcher';
import type { HerdrEvent } from '../src/herdr/client';
import type { PaneState } from '../src/herdr/scope';
import type { AgentStatus, PaneInfo } from '../src/herdr/types.gen';

/** A `pane_updated` push, in the shape herdr really sends it. */
function paneUpdated(paneId: string, agentSession: string | null): HerdrEvent {
	return {
		event: 'pane_updated',
		data: {
			type: 'pane_updated',
			pane: {
				pane_id: paneId,
				workspace_id: 'w4',
				tab_id: 'w4:t1',
				terminal_id: 'term_1',
				agent: 'claude',
				agent_status: 'idle',
				focused: false,
				revision: 7,
				...(agentSession
					? {
							agent_session: {
								agent: 'claude',
								kind: 'id',
								source: 'herdr:claude',
								value: agentSession,
							},
						}
					: {}),
			},
		},
	};
}

/** A client that records its one handler, so a test can push through it. */
function recordingClient(): {
	client: { on: (type: 'pane_updated', handler: (event: HerdrEvent) => void) => Unsubscribe };
	push: (event: HerdrEvent) => void;
} {
	let handler: ((event: HerdrEvent) => void) | null = null;
	return {
		client: {
			on: (type, next) => {
				expect(type).toBe('pane_updated');
				handler = next;
				return () => {
					handler = null;
				};
			},
		},
		push: (event) => handler?.(event),
	};
}

/** A scope that records the handlers it was given, one list per event. */
function recordingScope(): {
	scope: WatchableScope;
	changed: ((paneId: string, prev: PaneState, next: PaneState) => void)[];
	added: ((pane: PaneState) => void)[];
	removed: ((pane: PaneState) => void)[];
} {
	const changed: ((paneId: string, prev: PaneState, next: PaneState) => void)[] = [];
	const added: ((pane: PaneState) => void)[] = [];
	const removed: ((pane: PaneState) => void)[] = [];
	const scope = {
		get: () => undefined,
		paneInfo: () => undefined,
		on: (event: string, handler: unknown) => {
			if (event === 'changed') {
				changed.push(handler as (paneId: string, prev: PaneState, next: PaneState) => void);
			} else if (event === 'added') {
				added.push(handler as (pane: PaneState) => void);
			} else if (event === 'removed') {
				removed.push(handler as (pane: PaneState) => void);
			}
			return () => {};
		},
	} as unknown as WatchableScope;
	return { scope, changed, added, removed };
}

describe('paneSessionFromEvent: the one raw read', () => {
	it('reads the pane and its agent session off a pane update', () => {
		expect(paneSessionFromEvent(paneUpdated('w4:p1', 'session-1'))).toEqual({
			paneId: 'w4:p1',
			agentSession: 'session-1',
		});
	});

	it('reads a pane update with no agent session as an empty one, not as nothing', () => {
		expect(paneSessionFromEvent(paneUpdated('w4:p1', null))).toEqual({
			paneId: 'w4:p1',
			agentSession: '',
		});
	});

	it('ignores every other event and a malformed pane', () => {
		expect(paneSessionFromEvent({ event: 'pane_closed', data: {} })).toBeNull();
		expect(paneSessionFromEvent({ event: 'pane_updated', data: {} })).toBeNull();
		expect(
			paneSessionFromEvent({ event: 'pane_updated', data: { pane: { pane_id: 7 } } }),
		).toBeNull();
	});
});

describe('herdrSessionWatcher: the pane as herdr reports it', () => {
	const { client } = recordingClient();

	it('takes cwd and status from the scope and the agent session from the raw pane', () => {
		// `PaneState` has no `agent_session` — nothing renders it — so the one
		// field the session model needs comes from the pane herdr last sent.
		const scope = {
			get: (paneId: string) =>
				paneId === 'w4:p1'
					? ({ paneId, cwd: '/home/lasse/hvelv', agentStatus: 'working' } as PaneState)
					: undefined,
			paneInfo: (paneId: string) =>
				paneId === 'w4:p1'
					? ({
							pane_id: paneId,
							agent_session: { agent: 'claude', kind: 'id', source: 'screen', value: 'session-1' },
						} as PaneInfo)
					: undefined,
			on: () => () => {},
		};

		// herdr names no transcript path and no block kind: neither is set.
		expect(herdrSessionWatcher({ scope, client })?.snapshot('w4:p1')).toEqual({
			paneId: 'w4:p1',
			cwd: '/home/lasse/hvelv',
			agentSession: 'session-1',
			agentStatus: 'working',
		});
		expect(herdrSessionWatcher({ scope, client })?.snapshot('w4:p9')).toBeNull();
		// Nothing connected: no pane to read, which is not an error.
		expect(herdrSessionWatcher(null)).toBeNull();
	});

	it('reports no agent session for a pane that has not taken a prompt yet', () => {
		const scope = {
			get: () => ({ paneId: 'w4:p1', cwd: '/home/lasse', agentStatus: 'idle' }) as PaneState,
			paneInfo: () => ({ pane_id: 'w4:p1' }) as PaneInfo,
			on: () => () => {},
		};

		expect(herdrSessionWatcher({ scope, client })?.snapshot('w4:p1')?.agentSession).toBe('');
	});

	it('reports a pane joining the scoped workspace and one leaving it', () => {
		// Scope removal is how a pane stops being this vault's (CLAUDE.md); an
		// addition is how a freshly primed scope first shows it.
		const { scope, added, removed } = recordingScope();
		const seen: string[] = [];
		herdrSessionWatcher({ scope, client })?.onMembership((paneId) => seen.push(paneId));

		added[0]?.({ paneId: 'w4:p1' } as PaneState);
		removed[0]?.({ paneId: 'w4:p2' } as PaneState);

		expect(seen).toEqual(['w4:p1', 'w4:p2']);
	});

	it('passes a pane’s session on only once the client’s whole dispatch is done', async () => {
		// The client runs exact-name handlers before `'*'`, where the scope
		// ingests the update; a snapshot read inside the dispatch is stale.
		const recording = recordingClient();
		const { scope } = recordingScope();
		const seen: [string, string][] = [];
		const off = herdrSessionWatcher({ scope, client: recording.client })?.onSession(
			(paneId, session) => seen.push([paneId, session]),
		);

		recording.push(paneUpdated('w4:p1', 'session-2'));
		expect(seen).toEqual([]);
		await Promise.resolve();
		expect(seen).toEqual([['w4:p1', 'session-2']]);

		// An update still queued when the model lets go is dropped.
		recording.push(paneUpdated('w4:p1', 'session-3'));
		off?.();
		await Promise.resolve();
		expect(seen).toHaveLength(1);
	});

	it('passes on nothing for an event that is not a pane update', async () => {
		const recording = recordingClient();
		const { scope } = recordingScope();
		const seen: string[] = [];
		herdrSessionWatcher({ scope, client: recording.client })?.onSession((paneId) =>
			seen.push(paneId),
		);

		recording.push({ event: 'pane_updated', data: {} });
		await Promise.resolve();

		expect(seen).toEqual([]);
	});

	it('reports a status transition, and only a transition, with no block kind', () => {
		const { scope, changed } = recordingScope();
		const seen: [string, AgentStatus, unknown][] = [];
		herdrSessionWatcher({ scope, client })?.onStatus((paneId, status, kind) =>
			seen.push([paneId, status, kind]),
		);

		const idle = { agentStatus: 'idle' } as PaneState;
		const blocked = { agentStatus: 'blocked' } as PaneState;
		changed[0]?.('w4:p1', idle, blocked);
		// A title or token change is not a transition, and moves nothing here.
		changed[0]?.('w4:p1', blocked, blocked);

		expect(seen).toEqual([['w4:p1', 'blocked', undefined]]);
	});
});
