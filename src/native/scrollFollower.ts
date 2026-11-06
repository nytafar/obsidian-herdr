/**
 * Following the end of the session (#106): the native view's one scroll
 * container, whether the reader is at its bottom, and the pins that keep them
 * there while turns are drawn and their Markdown lands.
 *
 * One {@link ScrollFollower} per attached view, on `.herdr-native-turns`, the
 * view's one scroll container (#103). Everything that moves the scroll —
 * following, the TOC's jumps (#100, #118) — goes through it, so a reader-intent
 * rule or a "new messages" control (#149) has one place to live.
 */

import type { Component } from 'obsidian';

/**
 * How far from the bottom still counts as the bottom (#106).
 *
 * A couple of lines' worth. Sub-pixel rounding, a fractional device pixel ratio
 * and a wheel notch that overshoots by a hair all leave a reader who never
 * meant to move a few pixels short of the end, and none of them should stop the
 * view from following.
 */
export const BOTTOM_SLACK_PX = 24;

/** Whether a scroll container is showing its end, within {@link BOTTOM_SLACK_PX}. */
export function isAtBottom(geometry: {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}): boolean {
	const furthest = geometry.scrollHeight - geometry.clientHeight;
	return furthest - geometry.scrollTop <= BOTTOM_SLACK_PX;
}

/**
 * Whether the view follows the end of the session, and the pins that keep it
 * there. True on open and after a rotation, off the moment the reader scrolls
 * up, on again when they come back to the bottom (#106).
 */
export class ScrollFollower {
	private following = true;
	/** Watches the scroll container and the turn being written; null where there is none. */
	private resizeObserver: ResizeObserver | null = null;
	/** The turn the observer is watching, so only one ever is. */
	private observedTurnEl: HTMLElement | null = null;
	/** The Markdown renders of the current draw, which finish after it does. */
	private renders: Promise<void>[] = [];
	/** Set on dispose: a render or a resize that lands later pins nothing. */
	private disposed = false;

	constructor(private readonly scrollEl: HTMLElement) {}

	/**
	 * Starts listening. The only thing a scroll does is say whether the view is
	 * still following: nothing is drawn, measured or unmounted here, because
	 * this runs on every frame of a flick through a long session (#101).
	 */
	attach(component: Component): void {
		const scrollEl = this.scrollEl;
		component.registerDomEvent(scrollEl, 'scroll', () => {
			this.following = isAtBottom(scrollEl);
		});
		this.watchForGrowth(scrollEl);
	}

	/** Lets go of the observer and of every render still in flight. */
	dispose(): void {
		this.disposed = true;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.observedTurnEl = null;
		this.renders = [];
	}

	/** Follows the end again: on open, on another pane, after a rotation. */
	follow(): void {
		this.following = true;
	}

	/**
	 * Brings an element into view and stops following, which is what a click in
	 * the table of contents does (#100, #118).
	 */
	scrollTo(el: HTMLElement): void {
		this.following = false;
		el.scrollIntoView({ block: 'start' });
	}

	/** A Markdown render of the current draw, which {@link settle} waits for. */
	track(render: Promise<void>): void {
		this.renders.push(render);
	}

	/**
	 * Puts the view back on the end of the session, twice: now, and once the
	 * Markdown of this draw has rendered.
	 *
	 * A single `scrollTop = scrollHeight` after a draw lands short — the
	 * renderer has not run yet, and `content-visibility` makes the height an
	 * estimate besides (#101) — so the pin that counts is the later one. What
	 * lands later still, an image or an embed, is the resize observer's.
	 */
	settle(): void {
		this.pin();
		const renders = this.renders;
		if (renders.length === 0) return;
		this.renders = [];
		void Promise.allSettled(renders).then(() => this.pin());
	}

	/** The end of the session, while the view is following it and still mounted. */
	pin(): void {
		if (this.disposed || !this.following) return;
		this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
	}

	/** A turn was created: it is the one being written, so it is the one watched. */
	watchTurn(turnEl: HTMLElement): void {
		this.watchForGrowth(turnEl, this.observedTurnEl);
	}

	/** The turns were dropped: stop watching the one that was being written. */
	forgetTurn(): void {
		if (this.observedTurnEl) {
			this.resizeObserver?.unobserve(this.observedTurnEl);
			this.observedTurnEl = null;
		}
	}

	/**
	 * Watches an element for the height it gains after it was drawn, and gives
	 * up the one it was watching before.
	 *
	 * Two elements at a time and no more: the scroll container, which changes
	 * when the leaf or the prompt box does, and the turn being written, which is
	 * the one growing under a reader who is at the bottom. Watching every turn
	 * would fire on every `content-visibility` change as the reader scrolls,
	 * which is exactly the per-turn work a long session cannot afford (#101).
	 *
	 * Guarded for an environment with no `ResizeObserver` at all: the tests run
	 * under node, where there is none, and the view must still mount.
	 */
	private watchForGrowth(el: HTMLElement, instead?: HTMLElement | null): void {
		if (typeof ResizeObserver === 'undefined') return;
		if (!this.resizeObserver) {
			this.resizeObserver = new ResizeObserver(() => this.pin());
		}
		if (instead) this.resizeObserver.unobserve(instead);
		if (el !== this.scrollEl) this.observedTurnEl = el;
		this.resizeObserver.observe(el);
	}
}
