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

import { setIcon, type Component } from 'obsidian';

/** What the jump button says while the reader is away from the end (#149). */
export const JUMP_TO_LATEST = 'Jump to latest';
/** What it says once something was written there since they left. */
export const NEW_MESSAGES = 'New messages';

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
 * How far a turn's top may sit from the view's top and still be the turn the
 * reader is on: a jump lands within a pixel or two of it, not on it.
 */
const TURN_SLACK_PX = 4;

/**
 * Which turn "next" or "previous" goes to (#145), from each turn's top minus
 * the view's top, in session order: the first turn starting below the top of
 * the view, or the last one starting above it. Inside a long turn "previous"
 * is therefore that turn's own start, the way a reader paging back expects.
 * Null when there is none that way.
 */
export function turnStep(offsets: readonly number[], direction: 1 | -1): number | null {
	if (direction === 1) {
		const next = offsets.findIndex((offset) => offset > TURN_SLACK_PX);
		return next === -1 ? null : next;
	}
	for (let index = offsets.length - 1; index >= 0; index--) {
		if ((offsets[index] ?? 0) < -TURN_SLACK_PX) return index;
	}
	return null;
}

/**
 * Whether the view follows the end of the session, and the pins that keep it
 * there. True on open and after a rotation, off the moment the reader scrolls
 * up, on again when they come back to the bottom (#106).
 */
export class ScrollFollower {
	private following = true;
	/** Something was written at the end while the reader was away from it (#149). */
	private unseen = false;
	/**
	 * The button that takes the reader back to the end (#149): hidden while
	 * following, "Jump to latest" while away, "New messages" once something
	 * arrived there. Null until attached, and where no host was given.
	 */
	private jumpEl: HTMLElement | null = null;
	/** What the button shows, so the DOM is touched only when that changes. */
	private jumpShown: 'hidden' | 'away' | 'new' = 'hidden';
	/** Watches the scroll container and the turn being written; null where there is none. */
	private resizeObserver: ResizeObserver | null = null;
	/** The turn the observer is watching, so only one ever is. */
	private observedTurnEl: HTMLElement | null = null;
	/** The Markdown renders of the current draw, which finish after it does. */
	private renders: Promise<void>[] = [];
	/** Set on dispose: a render or a resize that lands later pins nothing. */
	private disposed = false;

	/**
	 * @param jumpHost where the jump button goes (#149): the view's root, so the
	 * button sits over the bottom of the transcript without being part of what
	 * scrolls. Left out, there is no button.
	 */
	constructor(
		private readonly scrollEl: HTMLElement,
		private readonly jumpHost?: HTMLElement,
	) {}

	/**
	 * Starts listening. The only thing a scroll does is say whether the view is
	 * still following: nothing is drawn, measured or unmounted here, because
	 * this runs on every frame of a flick through a long session (#101). The
	 * jump button is touched only on the scroll that changes the answer.
	 */
	attach(component: Component): void {
		const scrollEl = this.scrollEl;
		this.mountJump(component);
		component.registerDomEvent(scrollEl, 'scroll', () => {
			const following = isAtBottom(scrollEl);
			if (following === this.following) return;
			this.following = following;
			if (following) this.unseen = false;
			this.showJump();
		});
		this.watchForGrowth(scrollEl);
	}

	/** Whether the view is following the end of the session. */
	get isFollowing(): boolean {
		return this.following;
	}

	/**
	 * Something new was drawn at the end (#149). Following, the pins take the
	 * reader to it; away, the jump button says there is something to come back to.
	 */
	arrived(): void {
		if (this.following || this.unseen) return;
		this.unseen = true;
		this.showJump();
	}

	/** Back to the end and following it, which is what the jump button does. */
	jumpToEnd(): void {
		this.follow();
		this.pin();
	}

	/** The jump button, in an overlay row under the transcript that takes no room. */
	private mountJump(component: Component): void {
		if (!this.jumpHost) return;
		const row = this.jumpHost.createDiv({ cls: 'herdr-native-jump-row' });
		const button = row.createEl('button', {
			cls: ['herdr-native-jump', 'herdr-is-hidden'],
			attr: { type: 'button' },
		});
		component.registerDomEvent(button, 'click', () => this.jumpToEnd());
		this.jumpEl = button;
		this.jumpShown = 'hidden';
		this.showJump();
	}

	/** Brings the button in line with the state, writing only what changed. */
	private showJump(): void {
		const el = this.jumpEl;
		if (!el) return;
		const shown = this.following ? 'hidden' : this.unseen ? 'new' : 'away';
		if (shown === this.jumpShown) return;
		this.jumpShown = shown;
		el.toggleClass('herdr-is-hidden', shown === 'hidden');
		el.toggleClass('is-new', shown === 'new');
		if (shown === 'hidden') return;
		el.empty();
		el.setAttr('aria-label', shown === 'new' ? NEW_MESSAGES : JUMP_TO_LATEST);
		if (shown === 'new') el.createSpan({ cls: 'herdr-native-jump-text', text: NEW_MESSAGES });
		setIcon(el.createSpan({ cls: 'herdr-native-jump-icon' }), 'arrow-down');
	}

	/** Lets go of the observer and of every render still in flight. */
	dispose(): void {
		this.disposed = true;
		this.jumpEl = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.observedTurnEl = null;
		this.renders = [];
	}

	/** Follows the end again: on open, on another pane, after a rotation. */
	follow(): void {
		this.following = true;
		this.unseen = false;
		this.showJump();
	}

	/**
	 * Brings an element into view and stops following, which is what a click in
	 * the table of contents does (#100, #118).
	 */
	scrollTo(el: HTMLElement, block: ScrollLogicalPosition = 'start'): void {
		this.following = false;
		this.showJump();
		el.scrollIntoView({ block });
	}

	/** How far below the top of the view `el` sits now, for {@link keepAt} (#152). */
	offsetOf(el: HTMLElement): number {
		return el.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top;
	}

	/**
	 * Scrolls so `el` sits `offset` below the top of the view again, where the
	 * reader last saw what it shows, unless the view follows the end (#152):
	 * earlier turns drawn above it must not move what they were reading.
	 */
	keepAt(el: HTMLElement, offset: number): void {
		if (this.disposed || this.following) return;
		this.scrollEl.scrollTop += this.offsetOf(el) - offset;
	}

	/**
	 * The next or the previous turn, for the commands (#145). Measured now, on
	 * the reader's command, never on a scroll: the turns' tops against the
	 * scroll container's. Past the last turn, or already at the end, "next" is
	 * the end itself, following again.
	 */
	stepTurn(turnEls: readonly HTMLElement[], direction: 1 | -1): void {
		if (direction === 1 && isAtBottom(this.scrollEl)) {
			this.jumpToEnd();
			return;
		}
		const top = this.scrollEl.getBoundingClientRect().top;
		const offsets = turnEls.map((el) => el.getBoundingClientRect().top - top);
		const index = turnStep(offsets, direction);
		const target = index === null ? undefined : turnEls[index];
		if (target) this.scrollTo(target);
		else if (direction === 1) this.jumpToEnd();
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
