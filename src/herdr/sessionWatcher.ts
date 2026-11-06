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
 * herdr reports no kind of block (`blocked` is all it says), so the waiting card
 * reads the block off the transcript's shape. Nor does it report a transcript
 * path: given a {@link PaneClaudeResolver} (a local herdr, issue #132), the
 * watcher works it out for a Claude pane from its Claude process — its
 * configuration folder and real cwd — and pushes it as soon as it is known;
 * without one, until then, or for any other agent, the model asks the pane's
 * agent's format for the path from cwd and session. The resolver never runs
 * for another agent's pane: the path it names is a Claude transcript's, and a
 * path the runtime reports wins over the format's (ADR-0010).
 *
 * Only a pane whose agent the native view can read has one (#155, #137): a
 * pane whose `agent` has no format, or a session herdr cannot vouch for, is
 * {@link SessionWatcher.unavailable} with the reason. And a session reported
 * by another agent than the pane's (`agent_session.agent`: Codex's shared
 * daemon writes its thread onto the pane that started it, which may run
 * Claude now) is no session for the pane, so a Codex thread id is never read
 * as a Claude session's (finding `agent-codex` §2, §7.1).
 */

import type { HerdrEvent } from './client';
import type { PaneState } from './scope';
import type { PaneInfo } from './types.gen';
import type { PaneSnapshot, SessionWatcher, Unsubscribe } from '../native/sessionWatcher';
import { claudeTranscriptFile } from '../agents/claude/paths';
import type { PaneClaudeResolver } from './paneClaude';
import { nativeAgentReason } from '../native/agentSupport';
import { DEFAULT_AGENT_KIND } from '../agents/catalog';

/** An agent id as herdr writes it, compared trimmed and in lower case. */
function agentId(agent: unknown): string {
	return typeof agent === 'string' ? agent.trim().toLowerCase() : '';
}

/**
 * Whether a session herdr reports belongs to the agent the pane runs. The
 * session names its agent (`agent_session.agent`), and Codex's shared daemon
 * reports its thread onto whichever pane started it, which may run Claude
 * now (finding `agent-codex` §2, §7.1): such a session is another agent's,
 * and following it would read a Claude path out of a Codex thread id. A
 * session that names no agent is taken as the pane's; a pane that names none
 * runs the catalog's default agent, as everywhere else.
 */
export function sessionBelongsTo(paneAgent: unknown, sessionAgent: unknown): boolean {
	const reported = agentId(sessionAgent);
	return !reported || reported === (agentId(paneAgent) || DEFAULT_AGENT_KIND);
}

/** Whether a pane runs Claude, the one agent herdr's pane-Claude reader is for. */
function runsClaude(paneAgent: unknown): boolean {
	return (agentId(paneAgent) || DEFAULT_AGENT_KIND) === 'claude';
}

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
	const info = pane as {
		pane_id?: unknown;
		agent?: unknown;
		agent_session?: { agent?: unknown; value?: unknown } | null;
	};
	if (typeof info.pane_id !== 'string') return null;
	const value = info.agent_session?.value;
	const own = sessionBelongsTo(info.agent, info.agent_session?.agent);
	return { paneId: info.pane_id, agentSession: own && typeof value === 'string' ? value : '' };
}

/** A watcher over one connected herdr, or null when there is none. */
export function herdrSessionWatcher(
	session: WatchableSession | null,
	resolver?: PaneClaudeResolver | null,
): SessionWatcher | null {
	if (!session) return null;
	const { scope, client } = session;
	type SessionHandler = (paneId: string, agentSession: string, transcriptPath?: string) => void;
	const sessionHandlers = new Set<SessionHandler>();
	/** The session herdr reports for the pane, when it is the pane's own agent's. */
	const sessionOf = (paneId: string): string => {
		const session = scope.paneInfo(paneId)?.agent_session;
		const own = sessionBelongsTo(scope.get(paneId)?.agent, session?.agent);
		return own ? (session?.value ?? '') : '';
	};
	/** Whether the pane runs Claude: only then is its process read for a path. */
	const claudePane = (paneId: string): boolean => runsClaude(scope.get(paneId)?.agent);

	/**
	 * The transcript path the resolver knows for this pane's session, if any.
	 * Only a Claude pane's: the path is a Claude transcript's, and a path the
	 * runtime names wins over the pane's own format (ADR-0010).
	 */
	const knownPath = (paneId: string, agentSession: string, cwd: string): string | undefined => {
		if (!claudePane(paneId)) return undefined;
		const claude = agentSession && cwd ? resolver?.known(paneId, agentSession, cwd) : null;
		return claude ? claudeTranscriptFile(claude.configDir, claude.realCwd, agentSession) : undefined;
	};

	/**
	 * Reads the pane's Claude again when its answer is missing or stale, and
	 * tells the models when the path it gives moved. Only for a pane a model
	 * has asked about, so nothing reads the process of a pane nobody follows.
	 */
	const refresh = (paneId: string, agentSession: string, cwd: string): void => {
		if (!resolver || !agentSession || !cwd || !claudePane(paneId)) return;
		if (!resolver.stale(paneId, agentSession, cwd)) return;
		const before = knownPath(paneId, agentSession, cwd);
		void resolver.resolve(paneId, agentSession, cwd).then(() => {
			const pane = scope.get(paneId);
			// The pane moved on while this was read: the next update asks again.
			if (!pane || pane.cwd !== cwd || sessionOf(paneId) !== agentSession) return;
			const after = knownPath(paneId, agentSession, cwd);
			if (after === before) return;
			for (const handler of [...sessionHandlers]) handler(paneId, agentSession, after);
		});
	};

	return {
		snapshot(paneId: string): PaneSnapshot | null {
			const pane = scope.get(paneId);
			if (!pane) return null;
			const agentSession = sessionOf(paneId);
			refresh(paneId, agentSession, pane.cwd);
			const path = knownPath(paneId, agentSession, pane.cwd);
			return {
				paneId,
				cwd: pane.cwd,
				agent: pane.agent,
				agentSession,
				...(path ? { transcriptPath: path } : {}),
				agentStatus: pane.agentStatus,
			};
		},
		onSession(handler): Unsubscribe {
			// The client hands an event to its exact-name handlers before its `'*'`
			// ones, and the scope ingests on `'*'`: read synchronously, `snapshot`
			// would still hold the session this very event replaces. A microtask
			// runs once the whole dispatch is done.
			let live = true;
			sessionHandlers.add(handler);
			const off = client.on('pane_updated', (event) =>
				queueMicrotask(() => {
					if (!live) return;
					const update = paneSessionFromEvent(event);
					if (!update) return;
					const cwd = scope.get(update.paneId)?.cwd ?? '';
					// A followed pane's answer is kept fresh on its own updates.
					if (resolver?.tracked(update.paneId)) refresh(update.paneId, update.agentSession, cwd);
					handler(update.paneId, update.agentSession, knownPath(update.paneId, update.agentSession, cwd));
				}),
			);
			return () => {
				live = false;
				sessionHandlers.delete(handler);
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
			const offRemoved = scope.on('removed', (pane) => {
				resolver?.forget(pane.paneId);
				handler(pane.paneId);
			});
			return () => {
				offAdded();
				offRemoved();
			};
		},
		unavailable(paneId: string): string | null {
			// The scope holds agent panes only: a pane with no agent yet is not in
			// it, and is not refused.
			return nativeAgentReason('herdr', scope.get(paneId)?.agent);
		},
		onAvailability(handler): Unsubscribe {
			// A pane's agent is set when it joins the scope, and changes in place
			// when one agent exits and another starts in the same pane.
			const reasonOf = (pane: PaneState): string => nativeAgentReason('herdr', pane.agent) ?? '';
			const offAdded = scope.on('added', (pane) => {
				if (reasonOf(pane)) handler(pane.paneId);
			});
			const offChanged = scope.on('changed', (paneId, prev, next) => {
				if (reasonOf(prev) !== reasonOf(next)) handler(paneId);
			});
			return () => {
				offAdded();
				offChanged();
			};
		},
	};
}
