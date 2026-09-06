/**
 * Trackpad-aware wheel maths (#65).
 *
 * The wheel half of #25 converted every event on its own and clamped to at
 * least one line, so a MacBook trackpad — which delivers a stream of deltas of
 * one to ten pixels — asked herdr for a whole line per event and scrolled far
 * too fast to stop on a point. ghostty, the terminal Lasse compares against,
 * keeps a fractional accumulator instead: pixels divide by the measured cell
 * height, only whole lines are emitted and the remainder is carried.
 *
 * This module is that accumulator, pure and DOM-free like the rest of
 * `src/views/input/`. It is stateful (that is the point) but every input is
 * injected: the clock comes in through options, so the quiet-gap reset is
 * deterministic in tests, and `setPixelsPerLine` is fed from the renderer's
 * measured cell height by the view.
 *
 * Frame coalescing lives in the view, which owns `requestAnimationFrame`; this
 * module only offers `pending`/`take` so the view can hold an emission back and
 * merge the notches that arrive before the next frame.
 */

/** Matches `ScrollDirection` in `src/bridge/terminalSession.ts`. */
export type ScrollDirection = 'up' | 'down';

/** A whole-line scroll ready to go to herdr. */
export interface WheelScroll {
	direction: ScrollDirection;
	lines: number;
}

/**
 * Pixels per line when the renderer has not measured a cell yet. Kept at the
 * value the pre-#65 code used so nothing regresses before the first fit.
 */
export const WHEEL_PIXELS_PER_LINE = 24;

/** Upper bound so a trackpad fling cannot ask herdr for thousands of lines. */
export const MAX_SCROLL_LINES = 200;

/** Rows a page delta means when the grid height is not known yet. */
export const FALLBACK_PAGE_ROWS = 24;

/**
 * Lines a mouse wheel notch moves, matching herdr's `mouse_scroll_lines`
 * default (PRD section 7).
 */
export const MOUSE_SCROLL_LINES = 3;

/**
 * Chromium reports one mouse wheel notch as a pixel delta of exactly 120 (or a
 * multiple of it when notches coalesce), while a trackpad's precise deltas are
 * small and usually fractional. The DOM gives us no `hasPreciseScrollingDeltas`
 * flag, so that multiple is the only signal available for telling the two
 * devices apart; a notch bypasses the accumulator and moves whole lines.
 */
export const MOUSE_NOTCH_PIXELS = 120;

/**
 * A drag that has paused for this long is a new gesture, so its leftover
 * fraction is stale and would otherwise be spent on the first event of the next
 * one. Roughly the value ghostty uses.
 */
export const WHEEL_QUIET_GAP_MS = 200;

export interface WheelAccumulatorOptions {
	/** Injected clock, so the quiet-gap reset is testable without timers. */
	now: () => number;
	pixelsPerLine: number;
	quietGapMs: number;
	maxLines: number;
	/** Multiplies pixel-mode deltas; 1 is ghostty-like. */
	speed: number;
}

export const DEFAULT_WHEEL_ACCUMULATOR_OPTIONS: Readonly<WheelAccumulatorOptions> = Object.freeze({
	now: () => Date.now(),
	pixelsPerLine: WHEEL_PIXELS_PER_LINE,
	quietGapMs: WHEEL_QUIET_GAP_MS,
	maxLines: MAX_SCROLL_LINES,
	speed: 1,
});

export class WheelAccumulator {
	private readonly options: WheelAccumulatorOptions;
	/** Fraction of a line carried from earlier events of this gesture. */
	private carry = 0;
	private lastDirection: ScrollDirection | null = null;
	private lastAt = Number.NEGATIVE_INFINITY;
	/** Whole lines held back by the view's frame coalescing. */
	private held: WheelScroll | null = null;

	constructor(options: Partial<WheelAccumulatorOptions> = {}) {
		this.options = { ...DEFAULT_WHEEL_ACCUMULATOR_OPTIONS, ...options };
	}

	/**
	 * The renderer's measured cell height, which is what ghostty divides by.
	 * Ignored when it is not a positive finite number, so a renderer that has
	 * not laid out yet leaves the fallback in place.
	 */
	setPixelsPerLine(pixels: number): void {
		if (!Number.isFinite(pixels) || pixels <= 0) return;
		this.options.pixelsPerLine = pixels;
	}

	get pixelsPerLine(): number {
		return this.options.pixelsPerLine;
	}

	/** Forgets the gesture: no carry, no direction, no held lines. */
	reset(): void {
		this.carry = 0;
		this.lastDirection = null;
		this.lastAt = Number.NEGATIVE_INFINITY;
		this.held = null;
	}

	/**
	 * One wheel event. Returns the whole lines it makes available, or null when
	 * the delta only moved the fraction along. `deltaMode` is 0 pixels, 1 lines,
	 * 2 pages (DOM_DELTA_*); only pixel mode accumulates, the other two are
	 * already whole units and pass through as before.
	 */
	push(deltaY: number, deltaMode: number, rows: number): WheelScroll | null {
		if (!Number.isFinite(deltaY) || deltaY === 0) return null;
		const direction: ScrollDirection = deltaY < 0 ? 'up' : 'down';
		const at = this.options.now();
		// A reversed drag or a resumed one must not spend the old remainder.
		if (direction !== this.lastDirection || at - this.lastAt >= this.options.quietGapMs) {
			this.carry = 0;
			this.held = null;
		}
		this.lastDirection = direction;
		this.lastAt = at;

		const magnitude = Math.abs(deltaY);
		const lines = this.linesFor(magnitude, deltaMode, rows);
		if (lines <= 0) return null;
		return this.hold({ direction, lines });
	}

	/** Whole lines waiting for the view's next animation frame, if any. */
	get pending(): WheelScroll | null {
		return this.held;
	}

	/** Takes the pending emission, leaving the fractional carry alone. */
	take(): WheelScroll | null {
		const held = this.held;
		this.held = null;
		return held;
	}

	/**
	 * Merges into what is already pending so a frame emits one `terminal.scroll`
	 * instead of one per momentum event. A direction flip has already cleared the
	 * held lines in `push`, so the merge is always same-direction.
	 */
	private hold(scroll: WheelScroll): WheelScroll {
		const previous = this.held;
		const lines =
			previous && previous.direction === scroll.direction
				? Math.min(this.options.maxLines, previous.lines + scroll.lines)
				: scroll.lines;
		this.held = { direction: scroll.direction, lines };
		return this.held;
	}

	private linesFor(magnitude: number, deltaMode: number, rows: number): number {
		if (deltaMode === 2) {
			const page = Math.max(1, Math.trunc(rows) || FALLBACK_PAGE_ROWS);
			return this.clamp(Math.max(1, Math.round(magnitude * page)));
		}
		if (deltaMode === 1) return this.clamp(Math.max(1, Math.round(magnitude)));
		// A mouse notch: whole lines, no accumulation, and the carry of any
		// trackpad gesture before it is dropped.
		if (magnitude >= MOUSE_NOTCH_PIXELS && magnitude % MOUSE_NOTCH_PIXELS === 0) {
			this.carry = 0;
			return this.clamp((magnitude / MOUSE_NOTCH_PIXELS) * MOUSE_SCROLL_LINES);
		}
		this.carry += (magnitude * this.options.speed) / this.options.pixelsPerLine;
		const whole = Math.floor(this.carry);
		if (whole <= 0) return 0;
		this.carry -= whole;
		if (whole >= this.options.maxLines) this.carry = 0;
		return this.clamp(whole);
	}

	private clamp(lines: number): number {
		return Math.min(this.options.maxLines, lines);
	}
}
