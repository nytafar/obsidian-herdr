/**
 * One gate per pane for everything the native view types into a herdr or
 * herdr-core pane (review of #169, #170): the prompt box, the context
 * readout's `/context`, the queue's rows and their Send now (#159), and the
 * session settings driver (`./screenSettings.ts`).
 *
 * Why: Claude's model and effort pickers take whatever is typed while they
 * are up, and their Enter saves the user's default for new sessions
 * (`docs/architecture.md`, "A command sent while a picker is open…"). The
 * driver opens a picker with a command sent through the prompt path, and on
 * hc that send is pending for about 5 s while hc still reports the agent
 * `done`; herdr says `blocked` only once the picker is drawn. So no status
 * keeps a prompt out of a picker the driver opened: this gate does.
 *
 * - A settings change **claims** the pane: no prompt may be sent until it
 *   ends, and it cannot start while a prompt is on its way.
 * - A change that ended with the picker possibly still open **sticks**: the
 *   pane stays shut to prompts until a read shows the plain prompt again
 *   (the driver watches for it), whatever the change said.
 * - While a change runs, and for a moment after it ends (herdr calls a
 *   picker `blocked` and lags its closing by about a second), the waiting
 *   card does not read the screen ({@link PaneGate.screenHeld}). A stuck
 *   pane is not held: the card then sends the user to the terminal.
 *
 * Panes are keyed by the runtime connection's client, the same object the
 * prompt sender and the driver are built over, so every tab on a pane and the
 * plugin's queue share one gate; a reconnect is a new client and a new gate.
 *
 * No Obsidian here.
 */

import { PromptHeldBack, type PromptSender } from './promptSender';
import { setTimer } from '../timers';

/** Why a settings change cannot start: another one on the same pane. */
export const BUSY_REASON = 'Another change is on its way to this pane.';
/** Why a prompt cannot go while a settings change drives Claude's pickers. */
export const CHANGING_REASON = "Gjetr is changing a setting in this pane's terminal; send when it is done.";
/** Why nothing goes into a pane whose picker may still be open. */
export const PICKER_OPEN_REASON =
	"Claude's picker may still be open in the terminal; Gjetr sends nothing to this pane until it is closed there.";
/** Why a settings change cannot start while a prompt is on its way. */
export const PROMPT_REASON = 'A prompt is on its way to this pane.';

/** How long the screen counts as the driver's after a change ends. */
export const SETTLE_MS = 2000;

interface PaneState {
	settings: 'running' | 'stuck' | null;
	prompts: number;
	/** Until when the screen is still the driver's, after a change ended. */
	settledAt: number;
}

/** The claim a settings change holds on its pane. */
export interface PaneClaim {
	/**
	 * The change ended and the prompt is back: prompts may go again. With
	 * `settle`, the screen stays the driver's for a moment more: it touched
	 * the terminal, and herdr still says `blocked` for a picker just closed.
	 */
	release(settle?: boolean): void;
	/** The change ended with a picker possibly open: prompts wait until {@link release}. */
	stick(): void;
}

export interface PaneGateTimers {
	now(): number;
	/** Calls `run` once, `ms` from now. */
	later(run: () => void, ms: number): void;
}

const SYSTEM_TIMERS: PaneGateTimers = {
	now: () => Date.now(),
	later: (run, ms) => {
		const timer = setTimer(run, ms);
		// Never keeps a process alive on its own (tests, a closing app).
		(timer as { unref?: () => void }).unref?.();
	},
};

export class PaneGate {
	private readonly panes = new WeakMap<object, Map<string, PaneState>>();
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly timers: PaneGateTimers = SYSTEM_TIMERS,
		private readonly settleMs = SETTLE_MS,
	) {}

	/** Why nothing may be typed into the pane now, or null. */
	sendBlock(owner: object | null, paneId: string): string | null {
		const settings = this.peek(owner, paneId)?.settings ?? null;
		if (settings === 'running') return CHANGING_REASON;
		if (settings === 'stuck') return PICKER_OPEN_REASON;
		return null;
	}

	/** Why a settings change cannot start on the pane now, or null. */
	settingsBlock(owner: object | null, paneId: string): string | null {
		const state = this.peek(owner, paneId);
		if (state?.settings === 'running') return BUSY_REASON;
		if (state?.settings === 'stuck') return PICKER_OPEN_REASON;
		if ((state?.prompts ?? 0) > 0) return PROMPT_REASON;
		return null;
	}

	/**
	 * Whether the pane's screen is the settings driver's now, or was a moment
	 * ago. Not while stuck: whatever is up then is for the user to finish, and
	 * the waiting card sends them to the terminal for it.
	 */
	screenHeld(owner: object | null, paneId: string): boolean {
		const state = this.peek(owner, paneId);
		if (!state) return false;
		return state.settings === 'running' || this.timers.now() < state.settledAt;
	}

	/** Runs one send into the pane; refuses with {@link sendBlock}'s reason before anything is typed. */
	async send<T>(owner: object | null, paneId: string, work: () => Promise<T>): Promise<T> {
		const reason = this.sendBlock(owner, paneId);
		if (reason) throw new Error(reason);
		if (!owner) return work();
		const state = this.state(owner, paneId);
		state.prompts++;
		this.changed();
		try {
			return await work();
		} finally {
			state.prompts--;
			this.changed();
		}
	}

	/** Claims the pane for a settings change; throws {@link settingsBlock}'s reason when it cannot. */
	claim(owner: object, paneId: string): PaneClaim {
		const reason = this.settingsBlock(owner, paneId);
		if (reason) throw new Error(reason);
		const state = this.state(owner, paneId);
		state.settings = 'running';
		this.changed();
		let live = true;
		return {
			release: (settle = true) => {
				if (!live) return;
				live = false;
				state.settings = null;
				if (settle) state.settledAt = this.timers.now() + this.settleMs;
				this.changed();
				// The waiting card may read again once the screen has settled.
				if (settle) this.timers.later(() => this.changed(), this.settleMs);
			},
			stick: () => {
				if (!live || state.settings === 'stuck') return;
				state.settings = 'stuck';
				this.changed();
			},
		};
	}

	/** Listens for any change on any pane. */
	on(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private peek(owner: object | null, paneId: string): PaneState | undefined {
		return owner ? this.panes.get(owner)?.get(paneId) : undefined;
	}

	private state(owner: object, paneId: string): PaneState {
		let panes = this.panes.get(owner);
		if (!panes) {
			panes = new Map();
			this.panes.set(owner, panes);
		}
		let state = panes.get(paneId);
		if (!state) {
			state = { settings: null, prompts: 0, settledAt: 0 };
			panes.set(paneId, state);
		}
		return state;
	}

	private changed(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// One view's failure is not the gate's.
			}
		}
	}
}

/** The plugin's one gate. */
export const PANE_GATE = new PaneGate();

/** Listens for any change on the plugin's gate: a view redraws what it may send. */
export function onPaneGateChange(listener: () => void): () => void {
	return PANE_GATE.on(listener);
}

/**
 * A runtime's prompt sender behind the pane gate: every send waits on it,
 * and says why when it may not go. A row the plugin's queue holds (#159) is
 * held back silently instead ({@link PromptHeldBack}), and goes when the gate
 * opens. The settings driver sends through the unwrapped sender: it holds
 * the gate itself.
 */
export function gatePromptSender(
	inner: PromptSender,
	owner: () => object | null,
	gate: PaneGate = PANE_GATE,
): PromptSender {
	const gated: PromptSender = {
		async send(paneId, text, images, options) {
			const reason = gate.sendBlock(owner(), paneId);
			if (reason && options?.held) throw new PromptHeldBack(reason);
			await gate.send(owner(), paneId, () => inner.send(paneId, text, images, options));
		},
		blocked: (paneId) => gate.sendBlock(owner(), paneId),
	};
	if (inner.imagesUnavailable) gated.imagesUnavailable = (paneId) => inner.imagesUnavailable?.(paneId) ?? null;
	if (inner.interrupt) gated.interrupt = (paneId) => inner.interrupt?.(paneId) ?? Promise.resolve();
	return gated;
}
