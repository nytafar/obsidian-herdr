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
 * drawn. So the tab itself looks: while its pane has no session and is
 * `blocked` or reports nothing, it reads the screen once a tick, for a bounded
 * number of reads, and answers only when `ScreenAnswerer.inspect` has found
 * the trust prompt for exactly the pane's folder (the folder as the runtime
 * reports it; Claude names it absolute, never with `~`, symlinks resolved)
 * on reads at least {@link SETTLE_MS} apart.
 *
 * At most once per pane start, whichever tab sees it first (the claim is the
 * plugin's), and never again after a key went: a key that did not take is
 * said in a notice, not pressed twice (ADR-0009 §4). A refusal that sent
 * nothing lets the next tick look again.
 */

import type { AgentStatus } from '../herdr/types.gen';
import type { PaneSnapshot } from './sessionWatcher';
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
	/** The "Trust new folders automatically" setting, read on every tick. */
	enabled(): boolean;
	/** The tab's pane as its runtime reports it, or null. */
	pane(): PaneSnapshot | null;
	/** Reading and answering the pane's screen, or null for a kind or agent without. */
	answering(): ScreenAnswering | null;
	/** Claims this pane's trust prompt plugin-wide: true for the first caller only. */
	claim(): boolean;
	/** Gives the claim back: the session started, or nothing was sent. */
	release(): void;
	/** A key that went and did not do what it should. */
	notify(message: string): void;
	/** Reads per pane start; tests shorten it. */
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
export function trustReceipt(pane: () => PaneSnapshot | null, signal: AbortSignal, pollMs = STARTED_POLL_MS): Promise<AnswerReceipt> {
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

export class TrustWatch {
	/** Reads made for the pane start being watched. */
	private reads = 0;
	private running = false;
	/** When the prompt for the pane's folder was first read, while it has stayed up; null otherwise. */
	private seenSince: number | null = null;

	constructor(private readonly options: TrustWatchOptions) {}

	/** One look, on the tab's interval. Does nothing while a look or an answer is under way. */
	tick(): void {
		if (this.running) return;
		const pane = this.options.pane();
		if (!pane || !beforeSession(pane)) {
			// Past the prompt, or another program: the next start is a prompt of its own.
			this.reads = 0;
			this.seenSince = null;
			if (pane && sessionStarted(pane)) this.options.release();
			return;
		}
		if (!this.options.enabled() || !pane.cwd) return;
		if (this.reads >= (this.options.maxReads ?? MAX_READS)) return;
		const answering = this.options.answering();
		if (!answering) return;
		this.reads++;
		this.running = true;
		void this.look(pane, answering).finally(() => {
			this.running = false;
		});
	}

	private async look(pane: PaneSnapshot, answering: ScreenAnswering): Promise<void> {
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
		switch (outcome.kind) {
			case 'answered':
				return;
			case 'moved-on':
				if (outcome.final) return;
				break;
			case 'busy':
				this.options.release();
				return;
			case 'refused':
			case 'cancelled':
				if (outcome.pressed === 0) {
					// Nothing reached the terminal: the next tick may look again.
					this.options.release();
					return;
				}
				break;
			default:
				break;
		}
		this.options.notify(`Gjetr: trusting ${folder}: ${outcomeView(outcome).text}`);
	}
}
