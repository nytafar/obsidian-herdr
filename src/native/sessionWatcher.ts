/**
 * The session watcher contract (ADR-0003, ADR-0006).
 *
 * What a session model needs to know about one pane, from whichever runtime
 * kind runs it, and nothing else: the agent session, where its transcript is,
 * the pane's cwd, and the agent's status with the kind of block when the
 * runtime knows it. A kind supplies one watcher per live connection
 * (`RuntimeKindAdapter.native`); the model never sees a raw event, a scope or a
 * client.
 *
 * herdr's watcher is `../herdr/sessionWatcher.ts`: the scope for cwd and
 * status, and `agent_session` off `pane.updated`, the one recorded exception
 * to reacting only to status transitions (CLAUDE.md). herdr-core's is
 * `../hc/sessionWatcher.ts`: the session label its Claude hook writes, taken
 * only while its pid is the terminal's foreground pid (ADR-0006), and the
 * blocked kinds its program status carries.
 */

import type { AgentStatus } from '../herdr/types.gen';
import type { PendingRequest } from './pendingRequest';

export type Unsubscribe = () => void;

/**
 * Which dialog a blocked agent is sitting in, as the runtime reports it. Only a
 * runtime that knows says so: herdr reports `blocked` and nothing more, and the
 * native view falls back to reading the transcript's shape
 * (`./waitingCard.ts`). herdr-core's program status carries `permission`,
 * `question` and `auth` (finding `herdr-core-api`). `trust` is the workspace
 * trust prompt, and it is the one kind the view may answer by itself, so it
 * must only ever come from a runtime that positively identified it.
 */
export type BlockKind = 'trust' | 'permission' | 'question' | 'auth';

/** Every block kind a runtime may report, for parsing one off the wire. */
export const BLOCK_KINDS: readonly BlockKind[] = ['trust', 'permission', 'question', 'auth'];

/** Whether a value a runtime sent is a block kind this build knows. */
export function isBlockKind(value: unknown): value is BlockKind {
	return typeof value === 'string' && (BLOCK_KINDS as readonly string[]).includes(value);
}

/** What the model needs to know about a pane, and no more. */
export interface PaneSnapshot {
	paneId: string;
	/**
	 * The pane's working directory. The transcript's location is derived from
	 * it when the runtime names no {@link transcriptPath}, and the prompt box's
	 * `/` and `@` are relative to it.
	 */
	cwd: string;
	/** The agent session the runtime reports for the pane, empty until it has one. */
	agentSession: string;
	/**
	 * The transcript's path on the transcript's own host, when the runtime
	 * reports it (herdr-core's session label holds the hook's
	 * `transcript_path`). Absent, the model derives it from cwd and session
	 * with Claude Code's own layout (`./transcriptSource.ts`).
	 */
	transcriptPath?: string;
	agentStatus: AgentStatus;
	/** The kind of block, while `blocked` and only when the runtime knows it. */
	blockKind?: BlockKind;
	/**
	 * The dialog the runtime itself is waiting on, while `blocked`, for a kind
	 * that owns its agents' dialogs (the `claude` kind, ADR-0007): the waiting
	 * card shows it and answers it. Absent everywhere else.
	 */
	request?: PendingRequest;
}

/**
 * One runtime's view of its panes, for the session models. Built by the kind
 * over one live connection; a model re-asks for its runtime's watcher whenever
 * the published connection changes, and holds none while its runtime is not
 * the connected one.
 */
export interface SessionWatcher {
	/** The pane as the runtime last reported it, or null when it is not in scope. */
	snapshot(paneId: string): PaneSnapshot | null;
	/**
	 * The session a pane reports, pushed whenever the runtime says anything
	 * about it: rotation (`/clear`, `--resume`) has no event of its own on
	 * herdr, so this may fire many times a second with an unchanged value. The
	 * model deduplicates by value, and re-reads {@link snapshot} only when the
	 * session or its path moved, so a watcher must have ingested the update by
	 * the time it calls this.
	 */
	onSession(
		handler: (paneId: string, agentSession: string, transcriptPath?: string) => void,
	): Unsubscribe;
	/**
	 * Agent status transitions, one call per actual change of status or block
	 * kind — or of the pending {@link PaneSnapshot.request}, for a kind that
	 * reports one, which the model reads back from the snapshot.
	 */
	onStatus(
		handler: (paneId: string, status: AgentStatus, blockKind?: BlockKind) => void,
	): Unsubscribe;
	/**
	 * A pane joining or leaving the runtime's scope. Everything is scoped
	 * (CLAUDE.md), so a pane that leaves stops being this vault's and the model
	 * following it drops what it holds; one that joins it, as every pane does
	 * when a fresh connection primes its scope, is followed from then on.
	 */
	onMembership(handler: (paneId: string) => void): Unsubscribe;
	/**
	 * Why this pane cannot be shown in the native view although its runtime
	 * can, or null when it can or the runtime does not know the pane. Only a
	 * kind whose session needs something on the pane's side says anything
	 * here: herdr-core, whose session is the Claude hook's label (ADR-0006),
	 * so a terminal without one stays a terminal and names the install
	 * command. herdr's watcher leaves it out.
	 */
	unavailable?(paneId: string): string | null;
	/**
	 * Fires with a pane whose {@link unavailable} answer may have changed, so a
	 * tab can mount the surface it can show now. Present wherever
	 * `unavailable` is.
	 */
	onAvailability?(handler: (paneId: string) => void): Unsubscribe;
	/**
	 * Whether a person is in front of `viewer`, a native view of this pane: its
	 * window has the focus and is not hidden, and the view has a box. Only a
	 * kind that shares "a person looked at this agent" with other clients
	 * implements it: herdr-core, as `herdr.seen` under herdr-app's rules,
	 * which is what clears its "done until seen". Per viewer, so a second view
	 * of the same pane looking away does not end the first one's look; a view
	 * says false before it goes. herdr's watcher leaves it out: herdr keeps
	 * its own seen state, and a herdr tab is unaffected.
	 */
	looking?(paneId: string, viewer: object, looking: boolean): void;
}
