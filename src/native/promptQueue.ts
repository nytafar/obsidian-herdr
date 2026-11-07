/**
 * Queued prompts held by the plugin (issue #159; the finding
 * `queued-prompts` §4, `docs/architecture.md`, "Queued prompts").
 *
 * A prompt typed while the pane's agent works is not handed to the runtime:
 * it waits here as a row, above the prompt box, with Send now, Edit and
 * Discard. herdr and herdr-core have no queue of their own, and the TUI's
 * (Up, Ctrl+Enter) addresses no single prompt, so the plugin's is the one
 * every kind shares. Edit and Discard are then local and exact everywhere;
 * Send now is the one act that reaches the runtime during a turn.
 *
 * **Delivery.** Rows go out oldest first, one per turn, when the agent's
 * status is `idle` or `done`: the first such status after the turn the rows
 * were queued in is the agent leaving `working`. A row handed over waits for
 * the turn it starts (`working`), and only after that turn ends does the next
 * go. A prompt that starts no turn (a local `/command`) would hold the rest
 * for ever, so a row that has seen no `working` for {@link
 * TURN_GRACE_MS} lets the next one go. `blocked` sends nothing (a dialog, or
 * one of Claude's pickers while the session bar drives it, #169), and nor
 * does `unknown` (no agent, or its runtime not connected). The session bar
 * {@link PaneQueue.suspend}s the queue while it drives a picker, whose
 * screens can pass through `idle`.
 *
 * A held row the sender says the agent is not ready for ({@link
 * PromptHeldBack}: herdr-core's `status_mismatch`, a `blocked` refusal) stays,
 * with nothing said, for the next transition. Any other failure stays on the
 * row with its error, out of the automatic order, until the user sends it
 * now, edits or discards it; the rows behind it go from the next transition
 * on, so a dead connection fails one row, not all of them.
 *
 * **Lifetime.** Rows are per runtime and pane, in memory, in the plugin's
 * {@link PromptQueues}: they outlive a view's detach and a reconnect, and a
 * rotation (`/clear`) keeps them, since they are what the user still means
 * to say. While a queue has rows it holds the pane's session model itself, so
 * status keeps arriving and rows keep going out with no view open. A plugin
 * reload drops them, like the draft in the prompt box: what has not been sent
 * is a draft.
 *
 * No `obsidian` import: the rows are drawn by `./queueRows.ts`.
 */

import type { AgentStatus } from '../herdr/types.gen';
import type { PromptImage } from './promptImages';
import {
	NO_CONNECTION_MESSAGE,
	PromptHeldBack,
	SEND_NOW,
	type PromptSender,
	type PromptSendOptions,
} from './promptSender';
import type { SessionHandleOf, SessionModels, SessionModelView, Unsubscribe } from './sessionModel';
import { clearTimer, setTimer } from '../timers';
import { onPaneGateChange } from './paneGate';

/** One prompt the plugin holds for a pane. */
export interface QueuedPrompt {
	readonly id: string;
	readonly text: string;
	readonly images: readonly PromptImage[];
	/** True while it is being handed to the runtime. */
	readonly sending: boolean;
	/** Why the last hand-over failed; such a row waits for the user. Null otherwise. */
	readonly error: string | null;
}

/** How long a handed-over row waits for its turn to start before the next may go. */
export const TURN_GRACE_MS = 10_000;

/** The timers the queue waits with; Node's own when left out. */
export interface QueueTimers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const defaultTimers: QueueTimers = {
	set: (callback, ms) => setTimer(callback, ms),
	clear: (handle) => clearTimer(handle as ReturnType<typeof setTimer>),
};

export interface PaneQueueOptions {
	/** Hands one prompt to the pane's agent; the pane is the queue's. */
	send(text: string, images: readonly PromptImage[], options: PromptSendOptions): Promise<void>;
	/** How a failure reaches the user when no view may be open. */
	notify?: (message: string) => void;
	/** Called when the queue goes from empty to holding rows (true) and back (false). */
	onHolding?: (holding: boolean) => void;
	timers?: QueueTimers;
	turnGraceMs?: number;
}

/** Whether the agent is at rest, which is when held rows go out. */
function atRest(status: AgentStatus): boolean {
	return status === 'idle' || status === 'done';
}

/** What a failed hand-over says, with the runtime's words in the tail. */
export function queueFailureMessage(error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return `Gjetr: could not send the queued prompt (${reason})`;
}

/** One pane's held prompts, and when they go. */
export class PaneQueue {
	private readonly options: PaneQueueOptions;
	private list: QueuedPrompt[] = [];
	private agentStatus: AgentStatus = 'unknown';
	/** A held row is being handed over; nothing else goes meanwhile. */
	private delivering = false;
	/** A row went out and its turn has not been seen to start. */
	private awaitingTurn = false;
	private graceTimer: unknown = null;
	private suspended = 0;
	/** {@link retry} was asked while a row was on its way. */
	private retryAfter = false;
	private nextId = 1;
	private readonly listeners = new Set<() => void>();

	constructor(options: PaneQueueOptions) {
		this.options = options;
	}

	/** The held rows, oldest first. */
	get rows(): readonly QueuedPrompt[] {
		return this.list;
	}

	/** The status the queue last heard; `unknown` while it holds nothing. */
	get status(): AgentStatus {
		return this.agentStatus;
	}

	/** Listens for any change to the rows. */
	on(listener: () => void): Unsubscribe {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Whether a prompt typed now, with the agent in `status`, is held rather
	 * than sent: while the agent works, and behind rows already waiting, so
	 * nothing typed later goes out before them.
	 */
	holds(status: AgentStatus): boolean {
		if (status === 'working') return true;
		return this.list.length > 0 && status !== 'unknown';
	}

	/** Whether Send now may go in `status`: never into a block, never with no agent. */
	canSendNow(status: AgentStatus): boolean {
		return status === 'working' || atRest(status);
	}

	/** Holds a prompt as the newest row. */
	add(text: string, images: readonly PromptImage[] = []): QueuedPrompt {
		const row: QueuedPrompt = { id: String(this.nextId++), text, images: [...images], sending: false, error: null };
		const wasEmpty = this.list.length === 0;
		this.list = [...this.list, row];
		if (wasEmpty) this.options.onHolding?.(true);
		this.changed();
		this.pump();
		return row;
	}

	/** Drops a row that is not being sent. True when it was dropped. */
	discard(id: string): boolean {
		return this.remove(id, false) !== null;
	}

	/** Takes a row back for editing: it leaves the queue, text and images. */
	take(id: string): QueuedPrompt | null {
		return this.remove(id, false);
	}

	/**
	 * Hands a row to the runtime now, whatever the turn is doing ({@link
	 * SEND_NOW}): the agent takes it in at its next tool boundary. Gone from
	 * the queue once the runtime has it; on a failure it stays with the error.
	 */
	async sendNow(id: string): Promise<void> {
		const row = this.list.find((candidate) => candidate.id === id);
		if (!row || row.sending || !this.canSendNow(this.agentStatus)) return;
		const startsTurn = atRest(this.agentStatus);
		this.update(row.id, { sending: true, error: null });
		try {
			await this.options.send(row.text, row.images, SEND_NOW);
		} catch (error) {
			this.fail(row.id, error);
			return;
		}
		this.remove(row.id, true);
		// At rest it starts a turn, which the next row waits out; mid-turn it
		// joins the running one.
		if (startsTurn) this.awaitTurn();
	}

	/**
	 * The agent's status, as its session model reports it. A transition to
	 * `working` is the turn a handed-over row started; a status at rest lets
	 * the next row go.
	 */
	setStatus(status: AgentStatus): void {
		if (status === this.agentStatus) return;
		this.agentStatus = status;
		if (status === 'working') this.turnStarted();
		this.changed();
		this.pump();
	}

	/**
	 * Holds every row where it is until the returned function is called:
	 * the session bar drives a picker meanwhile (#169).
	 */
	suspend(): () => void {
		this.suspended++;
		let live = true;
		return () => {
			if (!live) return;
			live = false;
			this.suspended--;
			this.pump();
		};
	}

	/**
	 * Tries the oldest row again where nothing else would: the pane gate
	 * opened (review of #169), after a held row was held back for it.
	 */
	retry(): void {
		// A row on its way may yet be held back for what just changed: try
		// again once it is.
		if (this.delivering) this.retryAfter = true;
		else this.pump();
	}

	/** Stops waiting; the rows go with the plugin. */
	dispose(): void {
		this.clearGrace();
		this.listeners.clear();
	}

	/** Sends the oldest row that has not failed, if the agent is at rest and nothing is under way. */
	private pump(): void {
		if (this.delivering || this.awaitingTurn || this.suspended > 0) return;
		if (!atRest(this.agentStatus)) return;
		const row = this.list.find((candidate) => !candidate.sending && candidate.error === null);
		if (!row) return;
		void this.deliver(row);
	}

	private async deliver(row: QueuedPrompt): Promise<void> {
		this.delivering = true;
		this.retryAfter = false;
		this.update(row.id, { sending: true });
		try {
			await this.options.send(row.text, row.images, { held: true });
		} catch (error) {
			this.delivering = false;
			if (error instanceof PromptHeldBack) {
				// Not now: the next transition out of `working` tries again,
				// or the pane gate opening meanwhile.
				this.update(row.id, { sending: false });
				if (this.retryAfter) {
					this.retryAfter = false;
					this.pump();
				}
			} else this.fail(row.id, error);
			return;
		}
		this.delivering = false;
		this.remove(row.id, true);
		this.awaitTurn();
	}

	private awaitTurn(): void {
		this.awaitingTurn = true;
		this.clearGrace();
		const timers = this.options.timers ?? defaultTimers;
		this.graceTimer = timers.set(() => {
			this.graceTimer = null;
			this.awaitingTurn = false;
			this.pump();
		}, this.options.turnGraceMs ?? TURN_GRACE_MS);
	}

	private turnStarted(): void {
		this.awaitingTurn = false;
		this.clearGrace();
	}

	private clearGrace(): void {
		if (this.graceTimer === null) return;
		(this.options.timers ?? defaultTimers).clear(this.graceTimer);
		this.graceTimer = null;
	}

	private fail(id: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.update(id, { sending: false, error: message });
		this.options.notify?.(queueFailureMessage(error));
	}

	private update(id: string, patch: Partial<Pick<QueuedPrompt, 'sending' | 'error'>>): void {
		this.list = this.list.map((row) => (row.id === id ? { ...row, ...patch } : row));
		this.changed();
	}

	/** Takes a row out; one being sent only when `sent` says it went. */
	private remove(id: string, sent: boolean): QueuedPrompt | null {
		const row = this.list.find((candidate) => candidate.id === id);
		if (!row || (row.sending && !sent)) return null;
		this.list = this.list.filter((candidate) => candidate.id !== id);
		if (this.list.length === 0) {
			this.awaitingTurn = this.awaitingTurn && sent;
			// Nothing is heard while nothing is held: the next hold reads afresh.
			this.agentStatus = 'unknown';
			this.options.onHolding?.(false);
		}
		this.changed();
		return row;
	}

	private changed(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

/** What a view asks of the plugin's queues: the one for its pane. */
export interface PromptQueueSource {
	queue(endpointId: string, paneId: string): PaneQueue;
}

export interface PromptQueuesOptions {
	/** The plugin's session models: a queue with rows holds its pane's. */
	models: SessionModels;
	/** The sender of a runtime as it is now, or null when it has none. */
	sender(endpointId: string): PromptSender | null;
	notify?: (message: string) => void;
	timers?: QueueTimers;
	turnGraceMs?: number;
	/** Listens for the pane gate opening or shutting; the plugin's gate by default. */
	gateChanges?: (listener: () => void) => () => void;
}

/** The registry key of a pane on a runtime; a newline is in neither id. */
function queueKey(endpointId: string, paneId: string): string {
	return `${endpointId}\n${paneId}`;
}

/**
 * The plugin's queues, one per runtime and pane (#159). A queue holding rows
 * holds its pane's session model, and hears the agent's status from it,
 * whether or not a view is open; an empty one holds nothing.
 */
export class PromptQueues implements PromptQueueSource {
	private readonly queues = new Map<string, { queue: PaneQueue; release: () => void }>();
	/** Stops listening to the pane gate. */
	private readonly gateOff: () => void;

	constructor(private readonly options: PromptQueuesOptions) {
		// A row held back while the session bar drove a picker (the pane gate,
		// review of #169) goes once the gate opens, with no status change to
		// wake it.
		this.gateOff = (options.gateChanges ?? onPaneGateChange)(() => {
			for (const entry of this.queues.values()) entry.queue.retry();
		});
	}

	queue(endpointId: string, paneId: string): PaneQueue {
		const key = queueKey(endpointId, paneId);
		const existing = this.queues.get(key);
		if (existing) return existing.queue;
		let hold: Hold | null = null;
		const release = (): void => {
			hold?.release();
			hold = null;
		};
		const queue: PaneQueue = new PaneQueue({
			send: async (text, images, options) => {
				const sender = this.options.sender(endpointId);
				if (!sender) throw new Error(NO_CONNECTION_MESSAGE);
				if (images.length) await sender.send(paneId, text, images, options);
				else await sender.send(paneId, text, undefined, options);
			},
			notify: this.options.notify,
			timers: this.options.timers,
			turnGraceMs: this.options.turnGraceMs,
			onHolding: (holding) => {
				if (!holding) release();
				else if (!hold) hold = new Hold(this.options.models.acquire(endpointId, paneId), queue);
			},
		});
		this.queues.set(key, { queue, release });
		return queue;
	}

	/** Drops every queue and lets every model go. `onunload` only. */
	dispose(): void {
		this.gateOff();
		for (const entry of this.queues.values()) {
			entry.release();
			entry.queue.dispose();
		}
		this.queues.clear();
	}
}

/** A queue's hold on its pane's model, feeding it the agent's status. */
class Hold {
	private readonly off: Unsubscribe;

	constructor(
		private readonly handle: SessionHandleOf<SessionModelView>,
		queue: PaneQueue,
	) {
		const model = handle.model;
		// Every change, deduplicated by value in `setStatus`: the status is
		// what moved, and a model says so on its own emit.
		this.off = model.on(() => queue.setStatus(model.agentStatus));
		queue.setStatus(model.agentStatus);
	}

	release(): void {
		this.off();
		this.handle.release();
	}
}
