/**
 * herdr-core's session watcher (ADR-0006): what the native view's session
 * models read of an hc terminal, behind the kind-neutral contract in
 * `../native/sessionWatcher.ts`.
 *
 * hc knows nothing of agent sessions. The Claude Code `SessionStart` hook the
 * plugin installs (`../sessionHook/`) writes the session onto the terminal as
 * the `obsidian-herdr.session` label, and this reads it back:
 *
 * - **Only the terminal's own agent.** The label is accepted only while its
 *   pid equals the terminal's `foreground.pid` (the foreground process
 *   group's leader). A label written before the foreground poll caught up
 *   is taken once `foreground` arrives; a Claude that exited, was suspended
 *   or handed the terminal to an editor leaves a label whose pid is not the
 *   foreground's, and the session clears. A finished terminal has none.
 * - **Rotation** (`/clear`, `--resume`, compact, fork) is the hook writing
 *   the label again, which arrives as a `labels` event; the transcript path
 *   comes with it, so the model never derives one from the cwd.
 * - **Status** is the row's (herdr-app's "done until seen" over `turn`),
 *   except that hc's `error` reads as the end of a turn rather than as a
 *   block: Claude reports it when a turn failed, and it is back at its
 *   prompt, with no dialog the waiting card could name.
 * - **Block kinds** are the program's own (`permission`, `question`, `auth`).
 *   `trust` is never reported: hc has no such kind, and only a positively
 *   identified trust prompt may be answered unasked (`../native/waitingCard.ts`).
 *
 * - **Seen.** A native view a person is in front of shares `herdr.seen` the
 *   way a terminal tab does, under herdr-app's rules ({@link SeenTracker}),
 *   written over this watcher's own connection: a native view has no
 *   attach connection of its own, and the terminal surface is not mounted.
 *
 * Everything is read from the scope after it ingested the event
 * (`HcScope.onIngested`), so a handler that re-reads {@link
 * SessionWatcher.snapshot} sees the record the event left.
 */

import { sessionLabelOf, type SessionLabel } from '../sessionHook/label';
import type { PaneState } from '../herdr/scope';
import type { AgentStatus } from '../herdr/types.gen';
import type {
	BlockKind,
	PaneSnapshot,
	SessionWatcher,
	Unsubscribe,
} from '../native/sessionWatcher';
import { nativeAgentReason } from '../native/agentSupport';
import { agentKindOf, hcAgentStatus, type HcTerminal } from './model';
import type { IngestListener } from './scope';
import { SeenTracker } from './seen';

/** The agent whose hook writes the session label (ADR-0006). */
const SESSION_LABEL_AGENT = 'claude';

/** The palette command that installs the hook (`main.ts`). */
export const SESSION_HOOK_COMMAND_NAME = 'Install or remove the Claude session hook';

/**
 * Why a Claude in an hc terminal cannot be shown natively: it has not
 * labelled the terminal with its session, which is the hook missing (or
 * failing). Names the command that installs it.
 */
export const NATIVE_NO_LABEL_REASON = `no Claude session label; run "${SESSION_HOOK_COMMAND_NAME}"`;

/**
 * Why a Claude in an hc terminal cannot be shown natively although a session
 * label is there: the label names another process than the terminal's
 * foreground one, and only the foreground's own label is taken as the
 * terminal's session (ADR-0006). A wrapper that forks Claude rather than
 * exec'ing it does this, and so does a label an earlier Claude left behind.
 * Never names the install command: the hook did run.
 */
export function nativeForeignLabelReason(labelPid: number, foregroundPid: number | null): string {
	const foreground = foregroundPid === null ? 'foreground process' : `foreground process ${foregroundPid}`;
	return (
		`the Claude session label belongs to process ${labelPid}, not this terminal's ${foreground}, ` +
		'so it is not taken as this terminal’s session (a wrapper that forks Claude instead of exec’ing it, ' +
		'or a label left by an earlier Claude)'
	);
}

/** Why an hc terminal with no Claude in its foreground cannot be shown natively. */
export const NATIVE_NO_CLAUDE_REASON = 'no Claude session in this terminal';

/** The block kinds hc reports (OSC 7501 `kind=`). Never `trust`. */
const HC_BLOCK_KINDS: readonly BlockKind[] = ['permission', 'question', 'auth'];

/** The part of an `HcScope` the watcher reads. Structural, so a test fakes it. */
export interface HcWatchScope {
	get(paneId: string): PaneState | undefined;
	list(): PaneState[];
	terminal(address: string): HcTerminal | undefined;
	terminals(): HcTerminal[];
	on(event: 'added' | 'removed', handler: (pane: PaneState) => void): Unsubscribe;
	onIngested(listener: IngestListener): Unsubscribe;
}

/**
 * The session a terminal's label names, while the label's pid is the
 * terminal's foreground pid; null otherwise (ADR-0006).
 */
export function acceptedSession(terminal: HcTerminal | undefined): SessionLabel | null {
	if (!terminal || terminal.state === 'finished') return null;
	const label = sessionLabelOf(terminal.labels);
	const pid = terminal.foreground?.pid;
	if (!label || typeof pid !== 'number' || pid !== label.pid) return null;
	return label;
}

/** The status the native view shows for a terminal, and the block kind with it. */
export function nativeStatus(terminal: HcTerminal): { status: AgentStatus; blockKind?: BlockKind } {
	const raw = terminal.status;
	const status =
		raw?.state === 'error'
			? hcAgentStatus({ ...terminal, status: { ...raw, state: 'done' } })
			: hcAgentStatus(terminal);
	if (status !== 'blocked') return { status };
	const kind = HC_BLOCK_KINDS.find((known) => known === raw?.kind);
	return kind ? { status, blockKind: kind } : { status };
}

/**
 * Why a terminal cannot be shown natively, or null when it can or is not
 * known (not connected yet, or gone): only a terminal the core reported says
 * anything, so a tab never leaves the native view for want of a snapshot. A
 * terminal running another agent names it (#155); one running none says it
 * has no Claude session, as before.
 */
export function nativeUnavailable(terminal: HcTerminal | undefined): string | null {
	if (!terminal || acceptedSession(terminal)) return null;
	const agent = agentKindOf(terminal);
	const otherAgent = nativeAgentReason('herdr-core', agent);
	if (otherAgent) return otherAgent;
	if (agent !== 'claude') return NATIVE_NO_CLAUDE_REASON;
	const label = sessionLabelOf(terminal.labels);
	if (!label) return NATIVE_NO_LABEL_REASON;
	const pid = terminal.foreground?.pid;
	return nativeForeignLabelReason(label.pid, typeof pid === 'number' ? pid : null);
}

function sessionKey(terminal: HcTerminal | undefined): string {
	const session = acceptedSession(terminal);
	return session ? `${session.sessionId}\n${session.transcriptPath}` : '';
}

function statusKey(terminal: HcTerminal | undefined): string {
	if (!terminal) return '';
	const { status, blockKind } = nativeStatus(terminal);
	return `${status}\n${blockKind ?? ''}`;
}

function availabilityKey(terminal: HcTerminal | undefined): string {
	return nativeUnavailable(terminal) ?? '';
}

/**
 * Calls `handler` with every terminal whose `key` moved, after each ingested
 * event: the event's terminal, or every terminal after a snapshot. Starts
 * from the values as they stand, so subscribing says nothing by itself.
 */
function onKeyChange(
	scope: HcWatchScope,
	key: (terminal: HcTerminal | undefined) => string,
	handler: (address: string) => void,
): Unsubscribe {
	const last = new Map<string, string>();
	for (const terminal of scope.terminals()) last.set(terminal.address, key(terminal));
	const check = (address: string): void => {
		const next = key(scope.terminal(address));
		if ((last.get(address) ?? '') === next) return;
		if (next) last.set(address, next);
		else last.delete(address);
		handler(address);
	};
	return scope.onIngested((address) => {
		if (address !== null) {
			check(address);
			return;
		}
		const addresses = new Set(last.keys());
		for (const terminal of scope.terminals()) addresses.add(terminal.address);
		for (const each of addresses) check(each);
	});
}

export interface HcSessionWatcherOptions {
	/**
	 * Writes `herdr.seen=<turn>` on a terminal, over the connection the scope
	 * belongs to. Absent, {@link SessionWatcher.looking} does nothing.
	 */
	writeSeen?: (address: string, turn: number) => Promise<unknown>;
}

/**
 * Who is looking at which terminal through a native view, and one
 * {@link SeenTracker} per terminal anyone is: looking is per pane, so two
 * views of one pane count once, and the pane stops being looked at when the
 * last of them looks away.
 */
function seenSharing(
	scope: HcWatchScope,
	write: (address: string, turn: number) => Promise<unknown>,
): (paneId: string, viewer: object, looking: boolean) => void {
	const lookers = new Map<string, { viewers: Set<object>; tracker: SeenTracker }>();
	let off: Unsubscribe | null = null;
	const feed = (address: string): void => {
		lookers.get(address)?.tracker.update(scope.terminal(address) ?? null);
	};
	return (paneId, viewer, looking) => {
		let entry = lookers.get(paneId);
		if (looking) {
			if (!entry) {
				const tracker = new SeenTracker((turn) => write(paneId, turn));
				entry = { viewers: new Set(), tracker };
				lookers.set(paneId, entry);
				tracker.update(scope.terminal(paneId) ?? null);
			}
			entry.viewers.add(viewer);
			off ??= scope.onIngested((address) => {
				if (address !== null) feed(address);
				else for (const each of [...lookers.keys()]) feed(each);
			});
			entry.tracker.setLooking(true);
			return;
		}
		if (!entry || !entry.viewers.delete(viewer) || entry.viewers.size > 0) return;
		entry.tracker.setLooking(false);
		lookers.delete(paneId);
		if (lookers.size === 0) {
			off?.();
			off = null;
		}
	};
}

/** A watcher over one herdr-core connection's scope. */
export function hcSessionWatcher(scope: HcWatchScope, options: HcSessionWatcherOptions = {}): SessionWatcher {
	const write = options.writeSeen;
	const looking = write ? seenSharing(scope, write) : null;
	return {
		snapshot(paneId: string): PaneSnapshot | null {
			const row = scope.get(paneId);
			if (!row) return null;
			const terminal = scope.terminal(paneId);
			const session = acceptedSession(terminal);
			const { status, blockKind } = terminal ? nativeStatus(terminal) : { status: row.agentStatus };
			return {
				paneId,
				cwd: row.cwd,
				agentSession: session?.sessionId ?? '',
				// The label is the Claude hook's (ADR-0006), so the session it names
				// is Claude's, whatever the foreground program is called.
				...(session ? { agent: SESSION_LABEL_AGENT, transcriptPath: session.transcriptPath } : {}),
				agentStatus: status,
				...(blockKind ? { blockKind } : {}),
			};
		},
		onSession(handler): Unsubscribe {
			return onKeyChange(scope, sessionKey, (address) => {
				const session = acceptedSession(scope.terminal(address));
				handler(address, session?.sessionId ?? '', session?.transcriptPath);
			});
		},
		onStatus(handler): Unsubscribe {
			return onKeyChange(scope, statusKey, (address) => {
				const terminal = scope.terminal(address);
				if (!terminal) return;
				const { status, blockKind } = nativeStatus(terminal);
				handler(address, status, blockKind);
			});
		},
		onMembership(handler): Unsubscribe {
			const offAdded = scope.on('added', (pane) => handler(pane.paneId));
			const offRemoved = scope.on('removed', (pane) => handler(pane.paneId));
			return () => {
				offAdded();
				offRemoved();
			};
		},
		unavailable(paneId: string): string | null {
			return nativeUnavailable(scope.terminal(paneId));
		},
		onAvailability(handler): Unsubscribe {
			return onKeyChange(scope, availabilityKey, handler);
		},
		...(looking ? { looking } : {}),
	};
}
