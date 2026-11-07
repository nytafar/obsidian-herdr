/**
 * One answer driver per runtime and agent format, for the whole plugin
 * (ADR-0009 §5): the driver's one-answer-per-pane guard is per instance, and
 * two tabs on one pane, or a tab and the trust watch, must share it. Also the
 * claim that makes the trust prompt pressed at most once per prompt, by the
 * trust watch or a waiting card's button, whichever comes first (#167).
 */

import type { ScreenDialog } from '../agents/screenDialog';
import type { ScreenAccess } from './screenAccess';
import { ScreenAnswerer } from './screenAnswer';

/** What the waiting card and the trust watch need to read a pane's screen and answer on it. */
export interface ScreenAnswering {
	/** The shared driver for the pane's runtime and agent. */
	answerer: ScreenAnswerer;
	/** The runtime's screen, for the read that says which dialog is up. */
	screen: ScreenAccess;
	/** The agent format's reader (`AgentFormat.screenDialog`). */
	parse: (screen: string) => ScreenDialog;
	/** The runtime's own word on the request (hc's status `msg`), or null. */
	statusMessage: () => string | null;
	/** The pane's working directory, as its runtime reports it. */
	cwd: () => string;
	/**
	 * Claims the pane's trust prompt before a press on it, plugin-wide
	 * ({@link ScreenAnswerers.claimTrust}): true for the first caller only, so
	 * the card's button and the trust watch press once per prompt between them.
	 */
	claimTrust: () => boolean;
	/** Gives the claim back after a press that sent nothing. */
	releaseTrust: () => void;
	/** Between reads of a screen that shows no dialog yet; tests shorten it. */
	retryMs?: number;
	/** After an answer went, before the card reads what is up next; tests shorten it. */
	nextReadMs?: number;
}

export class ScreenAnswerers {
	private readonly answerers = new Map<string, ScreenAnswerer>();
	private readonly trustClaims = new Set<string>();

	/**
	 * The driver for `key` (runtime, kind and agent), made by `make` the first
	 * time. The screen access it is made with must read its runtime's client
	 * per call, since a reconnect replaces it.
	 */
	answerer(key: string, make: () => ScreenAnswerer): ScreenAnswerer {
		let answerer = this.answerers.get(key);
		if (!answerer) {
			answerer = make();
			this.answerers.set(key, answerer);
		}
		return answerer;
	}

	/** Claims a pane's trust prompt for a press: true for the first caller only. */
	claimTrust(paneKey: string): boolean {
		if (this.trustClaims.has(paneKey)) return false;
		this.trustClaims.add(paneKey);
		return true;
	}

	/** Whether a press on the pane's trust prompt holds the claim. */
	trustClaimed(paneKey: string): boolean {
		return this.trustClaims.has(paneKey);
	}

	/** Lets the pane's next trust prompt be claimed: its session started, its agent is gone, or nothing was sent. */
	releaseTrust(paneKey: string): void {
		this.trustClaims.delete(paneKey);
	}
}
