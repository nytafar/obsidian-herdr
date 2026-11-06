/**
 * Sharing "a person looked at this agent" as the `herdr.seen=<turn>` label
 * (herdr-app `docs/labels.md`), from one terminal tab (`./terminalSession.ts`)
 * or from the native views of one terminal (`./sessionWatcher.ts`).
 *
 * The rules, as herdr-app's `share_seen` applies them:
 *
 * - Only while someone is really in front of it: the tab's window is in the
 *   foreground and the terminal (or its native view) is drawn on screen. The view decides that and
 *   says so through {@link SeenTracker.setLooking}.
 * - Once per turn while it stays on screen: the turn a write was decided at is
 *   remembered, so a "mark unread" from another client is not overruled by a
 *   screen nobody watches. Looking away forgets it; looking again raises it
 *   again.
 * - Only to raise it, and also when it is missing, so terminals started
 *   elsewhere join. Never for a terminal that has not reported a status (it
 *   is not an agent) or is no longer live.
 * - A turn ends with a `status` event, then a `turn` event. Evaluating on
 *   every change is the same as deciding on the `turn` event: the status
 *   event leaves the turn where the last decision was taken.
 *
 * No I/O: the write is injected, so the rules are tested on their own.
 */

import { seenTurn, type HcTerminal } from './model';

export type SeenTerminal = Pick<HcTerminal, 'state' | 'status' | 'turn' | 'labels'>;

export class SeenTracker {
	private looking = false;
	/** The turn the last decision was taken at while looking; null when not looking. */
	private looked: number | null = null;
	private terminal: SeenTerminal | null = null;

	constructor(private readonly write: (turn: number) => Promise<unknown>) {}

	/** Whether a person is in front of the terminal right now. */
	setLooking(looking: boolean): void {
		this.looking = looking;
		this.evaluate();
	}

	/** The terminal's record changed (snapshot, `status`, `turn`, `labels`, …), or is gone. */
	update(terminal: SeenTerminal | null): void {
		this.terminal = terminal;
		this.evaluate();
	}

	private evaluate(): void {
		if (!this.looking) {
			this.looked = null;
			return;
		}
		const terminal = this.terminal;
		if (!terminal || terminal.state !== 'live' || terminal.status === null) return;
		const turn = terminal.turn;
		if (this.looked === turn) return;
		this.looked = turn;
		const seen = seenTurn(terminal.labels);
		if (seen !== null && seen >= turn) return;
		this.write(turn).catch(() => {
			// Not written: the next change while still looking tries again.
			if (this.looked === turn) this.looked = null;
		});
	}
}
