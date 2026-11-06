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
import type { SessionInfo } from './conversation';

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
	/**
	 * The agent the pane runs, by the agent catalog's ids (`claude`), which
	 * picks the format its session is read with (`../agents/format.ts`).
	 * Absent where the runtime does not say, which is read as the catalog's
	 * default agent, as before agents had formats.
	 */
	agent?: string;
	/** The agent session the runtime reports for the pane, empty until it has one. */
	agentSession: string;
	/**
	 * The transcript's path on the transcript's own host, when the runtime
	 * reports it (herdr-core's session label holds the hook's
	 * `transcript_path`). Absent, the model asks the agent's format for it,
	 * from cwd and session (`AgentFormat.transcriptPath`).
	 */
	transcriptPath?: string;
	agentStatus: AgentStatus;
	/**
	 * The agent's process has ended while the runtime keeps its session on
	 * show (the `claude` kind keeps a stopped agent's): whatever it had running
	 * in the background is lost (#135). Absent where the runtime drops the
	 * session with the process, as herdr and herdr-core do.
	 */
	stopped?: boolean;
	/** The kind of block, while `blocked` and only when the runtime knows it. */
	blockKind?: BlockKind;
	/**
	 * What the agent says it waits for, in its own words, while `blocked`, for
	 * a runtime that passes them on (herdr-core's status `msg`). The screen
	 * answer driver checks it against the request before every key
	 * (ADR-0009 §1). Absent where the runtime says none.
	 */
	blockMessage?: string;
	/**
	 * The dialog the runtime itself is waiting on, while `blocked`, for a kind
	 * that owns its agents' dialogs (the `claude` kind, ADR-0007): the waiting
	 * card shows it and answers it. Absent everywhere else.
	 */
	request?: PendingRequest;
	/**
	 * What the runtime itself knows of the session, sooner than the transcript
	 * says it (#110, #111): the `claude` kind hears model, mode, effort and the
	 * context window from its process. Put over the format's reading per field
	 * by the session model; absent where the runtime knows nothing of its own.
	 */
	sessionInfo?: SessionInfo;
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
	 * Fires with a pane whose {@link PaneSnapshot.sessionInfo} changed while
	 * nothing {@link onStatus} reports did (#160), for a kind that hears the
	 * session's settings from its process (the `claude` kind's `system:init`).
	 * The model reads the snapshot back. Absent where the runtime knows none.
	 */
	onSessionInfo?(handler: (paneId: string) => void): Unsubscribe;
	/**
	 * Why this pane cannot be shown in the native view although its runtime
	 * can, or null when it can or the runtime does not know the pane. A pane
	 * running an agent with no format, or one whose session the runtime
	 * cannot vouch for, says so on herdr and herdr-core (`./agentSupport.ts`,
	 * #155, #137); the `claude` kind runs only Claude and leaves this out. herdr-core says more, since its session is the Claude
	 * hook's label (ADR-0006): a terminal without one stays a terminal and
	 * names the install command.
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
