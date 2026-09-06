/**
 * The input layer's one object (#17). The terminal view holds an `InputRouter`
 * and asks it three questions:
 *
 *   frame bytes -> `observeFrame`  : which modes is the pane's application in?
 *   key event   -> `routeKey`      : do we encode this key, or the renderer?
 *   wheel event -> `routeWheel`    : what `terminal.scroll` should carry.
 *
 * Everything it needs is injected or pure, so it is unit tested without a DOM,
 * a renderer or a herdr. `wheelToScroll` comes in through the constructor
 * instead of being imported: the view owns the wheel accumulator's state (#65,
 * `./wheelAccumulator.ts`) and binds its `push` in here.
 *
 * The shipped options encode one key, shift+enter (#18); everything else is
 * left to the renderer. #25 gives `routeWheel` a cell position and modifiers;
 * `routeMouseButton` is still unwired, because without a mode signal a click
 * cannot be gated (see below). #33 would replace the `scroll` branch with a
 * local scrollback move.
 */

import {
	DEFAULT_KEY_ENCODING_OPTIONS,
	encodeKey,
	isComposingKey,
	type KeyEncodingOptions,
	type KeyEventLike,
} from './keyEncoder';
import {
	encodeMouseReport,
	herdrModifierBits,
	pickModifiers,
	type CellPosition,
	type MouseButton,
	type ModifierKeys,
} from './mouseEncoder';
import {
	mouseReportingEnabled,
	TerminalModeTracker,
	type TerminalModeState,
} from './modeTracker';

/** Matches `ScrollDirection` in `src/bridge/terminalSession.ts`. */
export type ScrollDirection = 'up' | 'down';

/**
 * Wheel delta -> whole lines. The view binds `WheelAccumulator.push` (#65), so
 * this is stateful behind the router's back: pixel deltas accumulate and a
 * sub-line delta answers null.
 */
export type WheelToScroll = (
	deltaY: number,
	deltaMode: number,
	rows: number,
) => { direction: ScrollDirection; lines: number } | null;

export interface InputRouterDeps {
	wheelToScroll: WheelToScroll;
}

export interface InputRouterOptions {
	key: KeyEncodingOptions;
}

/**
 * The policy the plugin ships. The encoder's own defaults stay off — it is the
 * pure layer and has no opinion — and the router is where a rule is switched on.
 *
 * `shiftEnterLineBreak` is on for #18: shift+enter must add a line to an agent's
 * composer instead of submitting. It sends `ESC CR`, the legacy alt+enter
 * sequence, because no live pane exposes its keyboard protocol (herdr does not
 * relay mode sequences, see `modeTracker.ts`) and that is the sequence Claude
 * Code's own `/terminal-setup` writes into iTerm2 and VS Code. `CSI 13;2u` is
 * still emitted instead when the tracker ever does see kitty flags.
 *
 * `shiftTabBacktab` is on for #18/#47: Claude Code cycles modes on shift+tab
 * and ghostty-web sends a plain tab for it, so the router claims the key and
 * sends `CSI Z`. Claiming it also makes the renderer call `preventDefault`,
 * which is what keeps the browser from moving focus out of the terminal.
 *
 * `kittyModifiedKeys` stays off: with no mode signal it would encode every
 * modified key on a guess, and guessing wrong breaks ordinary typing.
 */
export const DEFAULT_INPUT_ROUTER_OPTIONS: InputRouterOptions = Object.freeze({
	key: Object.freeze({
		...DEFAULT_KEY_ENCODING_OPTIONS,
		shiftEnterLineBreak: true,
		shiftTabBacktab: true,
	}),
});

/** A wheel notch, with the modifier flags the event carried (#25). */
export interface WheelInput extends Partial<ModifierKeys> {
	deltaY: number;
	/** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
	deltaMode: number;
	/** Grid height, for turning a page delta into lines. */
	rows: number;
	/** 0-based cell under the pointer, from the renderer's `cellAt` (#25). */
	position?: CellPosition;
}

/**
 * Send `terminal.scroll`. herdr decides what it means: with mouse reporting on
 * it becomes an SGR wheel report at `column`/`row` with `modifiers`, with
 * alternate scroll an `ESC[A`/`ESC[B`, otherwise a move of the pane's viewport
 * (`server/pane_input.rs::apply_scroll`). The client never encodes the wheel
 * itself — exactly one side may, and herdr is the side that knows the modes.
 */
export interface WheelScrollRoute {
	kind: 'scroll';
	direction: ScrollDirection;
	lines: number;
	source: 'wheel';
	/** 0-based cell under the pointer. Absent when nothing could be measured. */
	column?: number;
	row?: number;
	/** crossterm bitfield; see `herdrModifierBits`. */
	modifiers: number;
}

export type WheelRoute = WheelScrollRoute | null;

export interface MouseButtonInput extends Partial<ModifierKeys> {
	button: MouseButton;
	position: CellPosition;
	release?: boolean;
}

export class InputRouter {
	private readonly tracker = new TerminalModeTracker();
	private readonly wheelToScroll: WheelToScroll;
	private readonly options: InputRouterOptions;

	/** Set by `setComposing`, from the element's composition events (#49). */
	private composing = false;

	constructor(deps: InputRouterDeps, options: Partial<InputRouterOptions> = {}) {
		this.wheelToScroll = deps.wheelToScroll;
		this.options = { ...DEFAULT_INPUT_ROUTER_OPTIONS, ...options };
	}

	/** The modes the tracker believes the pane's application is in. */
	get modes(): TerminalModeState {
		return this.tracker.state;
	}

	/** True when the pane's application asked for mouse reports. */
	get mouseReporting(): boolean {
		return mouseReportingEnabled(this.tracker.state);
	}

	/**
	 * Feeds a frame to the mode tracker. `seq` is the bridge's frame counter: a
	 * bridge process numbers its frames from 1, so seq 1 means a fresh attach and
	 * the previous pane's modes must not leak into it. A `full: true` frame is
	 * *not* a reset — herdr's full frames are repaints and say nothing about
	 * modes.
	 */
	observeFrame(bytes: Uint8Array, seq?: number): void {
		if (seq !== undefined && seq <= 1) this.tracker.reset();
		this.tracker.feed(bytes);
	}

	/** Drops all mode state. */
	reset(): void {
		this.tracker.reset();
	}

	/**
	 * The bytes to send for a key, or null to let the renderer's own encoder
	 * handle it. With the shipped options only shift+enter and alt+enter are
	 * ours (#18); plain enter is null, so it stays the bare `CR` that submits.
	 */
	routeKey(event: KeyEventLike): string | null {
		// #49: nothing is ours between `compositionstart` and `compositionend`.
		// The flag covers the keydowns a browser reports with neither
		// `isComposing` nor `keyCode` 229 — Safari's first composing keydown, and
		// the Enter that ends a composition on some input methods.
		if (this.composing || isComposingKey(event)) return null;
		return encodeKey(event, this.tracker.state, this.options.key);
	}

	/**
	 * The terminal element's `compositionstart` / `compositionend` (#49). The
	 * view registers both; a router nobody tells stays at false and relies on
	 * `isComposing` alone.
	 */
	setComposing(composing: boolean): void {
		this.composing = composing;
	}

	/** True between `compositionstart` and `compositionend`. */
	get isComposing(): boolean {
		return this.composing;
	}

	/**
	 * A wheel notch (#25). Always `terminal.scroll`, now carrying the cell under
	 * the pointer and the modifier bits herdr's `apply_scroll` wants, because
	 * herdr performs the report/scroll fork server-side and is the only side that
	 * can: no mode signal reaches this client, so the tracker cannot tell a
	 * mouse-reporting pane from a plain one (see `modeTracker.ts`). Without
	 * `column`/`row` every server-side report would land on cell (0, 0).
	 *
	 * Null for a delta the accumulator has not turned into a whole line yet;
	 * the view decides what that means for the renderer (#65).
	 */
	routeWheel(input: WheelInput): WheelRoute {
		const scroll = this.wheelToScroll(input.deltaY, input.deltaMode, input.rows);
		if (!scroll) return null;
		return {
			kind: 'scroll',
			direction: scroll.direction,
			lines: scroll.lines,
			source: 'wheel',
			// Still spread conditionally: `column`/`row` are optional on the wire and
			// herdr must not be told the pointer was at (0, 0) when nothing was
			// measured, whereas an absent modifier simply means "not held".
			...(input.position === undefined
				? {}
				: { column: input.position.column, row: input.position.row }),
			modifiers: herdrModifierBits(pickModifiers(input)),
		};
	}

	/**
	 * A click. **Not wired to the view, and #25 deliberately left it that way**:
	 * gating a click needs to know whether the pane's application asked for mouse
	 * reporting, that signal never reaches this client (herdr sends
	 * `ServerMessage::MouseCapture` only to control-mode clients and the CLI
	 * bridge drops it), and guessing would cost text selection in every plain
	 * pane — the regression #25's acceptance criteria forbid. So clicks stay with
	 * the renderer, and this waits for herdr to expose mouse capture over the
	 * session protocol.
	 *
	 * Null means "leave it alone", which is what the tracker's defaults always
	 * say today.
	 */
	routeMouseButton(input: MouseButtonInput): string | null {
		return encodeMouseReport(this.tracker.state, {
			button: input.button,
			position: input.position,
			release: input.release,
			modifiers: pickModifiers(input),
		});
	}
}
