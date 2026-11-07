/**
 * "Trust new folders automatically" (#99, #167, ADR-0009 §3): answers Claude's
 * workspace trust prompt for a pane open in a tab, through the answer driver,
 * once the screen shows that prompt naming the pane's own folder.
 *
 * It starts from the screen because nothing else says a trust prompt is up:
 * herdr reports a plain `blocked`, and herdr-core no status at all, since
 * Claude reports none before trust (`docs/architecture.md`, "Answering
 * Claude's dialogs from the screen"). And on herdr-core the pane has
 * no session label yet, so its tab shows the terminal and no waiting card is
 * drawn. So the tab itself looks: while its pane runs an agent whose
 * screen can be read, with no session yet, `blocked` or reporting nothing, it
 * reads the screen once a tick, for a bounded number of reads per start of
 * that agent, and answers only when `ScreenAnswerer.inspect` has found the
 * trust prompt for exactly the pane's folder (the folder as the runtime
 * reports it; Claude names it absolute, never with `~`, symlinks resolved)
 * on reads at least {@link SETTLE_MS} apart.
 *
 * **What it reads.** The pane through the watcher's `glance`, which reads
 * nothing beyond what the runtime already reported: herdr's `snapshot` reads
 * the Claude process of a pane with a session to find its transcript, and
 * nothing may read the process of a pane no native view follows. With the
 * setting off, nothing at all, unless this pane's prompt is claimed (below).
 * A pane running no agent (a shell, on herdr-core) is never read, and is
 * where the budget of reads starts again: the next agent there is a new
 * start.
 *
 * **One press per prompt.** The claim is the plugin's, shared by every tab's
 * watch and every waiting card's "Yes, I trust this folder"
 * (`ScreenAnswering.claimTrust`): whoever presses first holds it, and it is
 * let go only when nothing reached the terminal, when the session starts, or
 * when the pane runs no agent any more. So a key that did not take (or may
 * still land) is said in a notice and never followed by a second press
 * (ADR-0009 §4); a refusal that sent nothing lets the next tick look again.
 */

import type { AgentStatus } from '../herdr/types.gen';
import type { PaneGlance, PaneSnapshot } from './sessionWatcher';
import type { ScreenAnswering } from './screenAnswerers';
import { outcomeView } from './screenCard';
import type { AnswerOutcome, AnswerReceipt, ScreenExpectation } from './screenAnswer';
import { setTimer } from '../timers';

/** How many reads one pane start gets before the watch gives up on it: a minute at one a second. */
const MAX_READS = 60;
/**
 * How long the prompt must have been on screen before a key goes. Measured
 * 2026-11-06 on hc 0.1.18 with Claude Code 2.1.318: Claude draws the trust
 * prompt, then within half a second draws it again with the cursor back on
 * "No, exit", so a `down` that showed can be undone before its `enter`, and
 * `enter` there exits Claude. A `down` sent a second after the prompt showed
 * stayed.
 */
const SETTLE_MS = 1500;
/** Between looks at the pane while the answer waits for the session to start. */
const STARTED_POLL_MS = 250;

export interface TrustWatchOptions {
	/** The "Trust new folders automatically" setting, read first on every tick. */
	enabled(): boolean;
	/** Whether this pane's trust prompt is claimed plugin-wide: a press on it went, or is going, from some tab. */
	claimed(): boolean;
	/**
	 * The tab's pane as its runtime last reported it, read with no side
	 * effects (`SessionWatcher.glance`), or null.
	 */
	pane(): PaneGlance | null;
	/** Reading and answering the screen of a pane running `agent`, or null for a kind or agent without. */
	answering(agent: string): ScreenAnswering | null;
	/** Claims this pane's trust prompt plugin-wide: true for the first caller only. */
	claim(): boolean;
	/** Gives the claim back: the session started, the agent is gone, or nothing was sent. */
	release(): void;
	/** A key that went and did not do what it should. */
	notify(message: string): void;
	/** Reads per agent start; tests shorten it. */
	maxReads?: number;
	/** How long the prompt must have shown before a key goes; tests shorten it. */
	settleMs?: number;
	/** The clock; tests drive it. */
	now?: () => number;
}

/** Whether the agent is still before its session: no session, and blocked or saying nothing. */
export function beforeSession(pane: Pick<PaneSnapshot, 'agentSession' | 'agentStatus'>): boolean {
	return pane.agentSession === '' && (pane.agentStatus === 'blocked' || pane.agentStatus === 'unknown');
}

const STARTED: readonly AgentStatus[] = ['idle', 'working', 'done'];

/** Whether the agent is past the trust prompt: a session, or a status Claude only reports once trusted. */
export function sessionStarted(pane: Pick<PaneSnapshot, 'agentSession' | 'agentStatus'>): boolean {
	return pane.agentSession !== '' || STARTED.includes(pane.agentStatus);
}

/**
 * The trust prompt's receipt (ADR-0009 §4): `started` once the pane is past
 * it, `exited` once the pane is gone. Polls `pane` until then, or until the
 * driver stops waiting.
 */
export function trustReceipt(
	pane: () => Pick<PaneSnapshot, 'agentSession' | 'agentStatus'> | null,
	signal: AbortSignal,
	pollMs = STARTED_POLL_MS,
): Promise<AnswerReceipt> {
	return new Promise((resolve) => {
		const look = (): void => {
			if (signal.aborted) return;
			const now = pane();
			if (!now) return resolve({ kind: 'exited' });
			if (sessionStarted(now)) return resolve({ kind: 'started' });
			setTimer(look, pollMs);
		};
		look();
	});
}

/**
 * Whether an answer's outcome says nothing reached the terminal, so the trust
 * claim may go back for another press: another answer was in flight, or it
 * was refused or cancelled before any key. Anything else keeps the claim.
 */
export function sentNothing(outcome: AnswerOutcome): boolean {
	switch (outcome.kind) {
		case 'busy':
			return true;
		case 'refused':
		case 'cancelled':
			return outcome.pressed === 0;
		default:
			return false;
	}
}

export class TrustWatch {
	/** Reads made for the agent start being watched. */
	private reads = 0;
	private running = false;
	/** When the prompt for the pane's folder was first read, while it has stayed up; null otherwise. */
	private seenSince: number | null = null;

	constructor(private readonly options: TrustWatchOptions) {}

	/** One look, on the tab's interval. Does nothing while a look or an answer is under way. */
	tick(): void {
		if (this.running) return;
		// The setting first: off, nothing is read, unless a press on this
		// pane's prompt is held and waits to be let go of.
		const enabled = this.options.enabled();
		if (!enabled && !this.options.claimed()) {
			this.forget();
			return;
		}
		const pane = this.options.pane();
		if (!pane) {
			// Not reported: gone, or a reconnect under way. The claim stays, since
			// nothing says the prompt went.
			this.forget();
			return;
		}
		if (sessionStarted(pane) || pane.agent === null) {
			// Past the prompt, or no agent any more: the next start is a prompt of its own.
			this.forget();
			this.options.release();
			return;
		}
		if (!enabled || !beforeSession(pane) || !pane.cwd) return;
		if (this.reads >= (this.options.maxReads ?? MAX_READS)) return;
		const answering = this.options.answering(pane.agent);
		if (!answering) return;
		this.reads++;
		this.running = true;
		void this.look(pane, answering).finally(() => {
			this.running = false;
		});
	}

	/** Starts the count of reads and the prompt's wait again, for the next start. */
	private forget(): void {
		this.reads = 0;
		this.seenSince = null;
	}

	private async look(pane: PaneGlance, answering: ScreenAnswering): Promise<void> {
		const expectation: ScreenExpectation = { kind: 'trust', cwd: pane.cwd };
		const inspection = await answering.answerer.inspect(pane.paneId, expectation, answering.statusMessage);
		if (!inspection.ok) {
			this.seenSince = null;
			return;
		}
		// Only a prompt that has stayed up: Claude draws it twice at startup.
		const now = (this.options.now ?? Date.now)();
		this.seenSince ??= now;
		if (now - this.seenSince < (this.options.settleMs ?? SETTLE_MS)) return;
		if (!this.options.claim()) return;
		const run = answering.answerer.answer({
			paneId: pane.paneId,
			expectation,
			answer: { kind: 'trust' },
			statusMessage: answering.statusMessage,
			receipt: (signal) => trustReceipt(() => this.options.pane(), signal),
		});
		this.settle(await run.done, pane.cwd);
	}

	/** What a run's end means for the claim, and what the user is told. */
	private settle(outcome: AnswerOutcome, folder: string): void {
		if (sentNothing(outcome)) {
			// Nothing reached the terminal: the next tick may look again.
			this.options.release();
			return;
		}
		if (outcome.kind === 'answered' || (outcome.kind === 'moved-on' && outcome.final)) return;
		this.options.notify(`Gjetr: trusting ${folder}: ${outcomeView(outcome).text}`);
	}
}
