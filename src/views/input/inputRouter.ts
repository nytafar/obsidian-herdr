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
 * instead of being imported: it lives in `terminalView.ts`, which imports
 * `obsidian`, and nothing under `src/views/input/` may.
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
	type KeyEncodingOptions,
	type KeyEventLike,
} from './keyEncoder';
import {
	encodeMouseReport,
	herdrModifierBits,
	type CellPosition,
	type MouseButton,
	type MouseModifiers,
} from './mouseEncoder';
import {
	mouseReportingEnabled,
	TerminalModeTracker,
	type TerminalModeState,
} from './modeTracker';

/** Matches `ScrollDirection` in `src/bridge/terminalSession.ts`. */
export type ScrollDirection = 'up' | 'down';

/** The part of `wheelToScroll` (terminalView.ts) the router depends on. */
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
 * `kittyModifiedKeys` stays off: with no mode signal it would encode every
 * modified key on a guess, and guessing wrong breaks ordinary typing.
 */
export const DEFAULT_INPUT_ROUTER_OPTIONS: InputRouterOptions = Object.freeze({
	key: Object.freeze({ ...DEFAULT_KEY_ENCODING_OPTIONS, shiftEnterLineBreak: true }),
});

export interface WheelInput {
	deltaY: number;
	/** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
	deltaMode: number;
	/** Grid height, for turning a page delta into lines. */
	rows: number;
	/** 0-based cell under the pointer, from the renderer's `cellAt` (#25). */
	position?: CellPosition;
	shiftKey?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
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

export interface MouseButtonInput {
	button: MouseButton;
	position: CellPosition;
	release?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
}

export class InputRouter {
	private readonly tracker = new TerminalModeTracker();
	private readonly wheelToScroll: WheelToScroll;
	private readonly options: InputRouterOptions;

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
		return encodeKey(event, this.tracker.state, this.options.key);
	}

	/**
	 * A wheel notch (#25). Always `terminal.scroll`, now carrying the cell under
	 * the pointer and the modifier bits herdr's `apply_scroll` wants, because
	 * herdr performs the report/scroll fork server-side and is the only side that
	 * can: no mode signal reaches this client, so the tracker cannot tell a
	 * mouse-reporting pane from a plain one (see `modeTracker.ts`). Without
	 * `column`/`row` every server-side report would land on cell (0, 0).
	 *
	 * Null for a delta that rounds to nothing, which lets the renderer keep the
	 * notch — the only case where its own local scroll is still wanted.
	 */
	routeWheel(input: WheelInput): WheelRoute {
		const scroll = this.wheelToScroll(input.deltaY, input.deltaMode, input.rows);
		if (!scroll) return null;
		return {
			kind: 'scroll',
			direction: scroll.direction,
			lines: scroll.lines,
			source: 'wheel',
			...(input.position === undefined
				? {}
				: { column: input.position.column, row: input.position.row }),
			modifiers: herdrModifierBits({
				...(input.shiftKey === undefined ? {} : { shiftKey: input.shiftKey }),
				...(input.altKey === undefined ? {} : { altKey: input.altKey }),
				...(input.ctrlKey === undefined ? {} : { ctrlKey: input.ctrlKey }),
				...(input.metaKey === undefined ? {} : { metaKey: input.metaKey }),
			}),
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
		const modifiers: MouseModifiers = {
			...(input.shiftKey === undefined ? {} : { shiftKey: input.shiftKey }),
			...(input.altKey === undefined ? {} : { altKey: input.altKey }),
			...(input.ctrlKey === undefined ? {} : { ctrlKey: input.ctrlKey }),
		};
		return encodeMouseReport(this.tracker.state, {
			button: input.button,
			position: input.position,
			...(input.release === undefined ? {} : { release: input.release }),
			modifiers,
		});
	}
}
