/**
 * The input layer's one object (#17). The terminal view holds an `InputRouter`
 * and asks it three questions:
 *
 *   frame bytes -> `observeFrame`  : which modes is the pane's application in?
 *   key event   -> `routeKey`      : do we encode this key, or the renderer?
 *   wheel event -> `routeWheel`    : mouse report to the pane, or a scroll?
 *
 * Everything it needs is injected or pure, so it is unit tested without a DOM,
 * a renderer or a herdr. `wheelToScroll` comes in through the constructor
 * instead of being imported: it lives in `terminalView.ts`, which imports
 * `obsidian`, and nothing under `src/views/input/` may.
 *
 * With the default options the router encodes nothing and every wheel event
 * takes the `terminal.scroll` path it took before, which is the acceptance
 * criterion of #17: no user-visible change. #18 turns on
 * `key.shiftEnterLineBreak`; #25 wires `routeMouseButton` to real clicks and
 * gives `routeWheel` a cell position; #33 replaces the `scroll` branch with a
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
	encodeWheelReport,
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

export const DEFAULT_INPUT_ROUTER_OPTIONS: InputRouterOptions = Object.freeze({
	key: DEFAULT_KEY_ENCODING_OPTIONS,
});

export interface WheelInput {
	deltaY: number;
	/** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
	deltaMode: number;
	/** Grid height, for turning a page delta into lines. */
	rows: number;
	/** Cell under the pointer. Absent until #25 measures it; then reports use it. */
	position?: CellPosition;
	shiftKey?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
}

/** Send these bytes to the pane through `terminal.input`. */
export interface WheelInputRoute {
	kind: 'input';
	data: string;
}

/** Send `terminal.scroll`; herdr moves the pane's viewport. */
export interface WheelScrollRoute {
	kind: 'scroll';
	direction: ScrollDirection;
	lines: number;
	source: 'wheel';
}

export type WheelRoute = WheelInputRoute | WheelScrollRoute | null;

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
	 * handle it. Null for everything with the default options.
	 */
	routeKey(event: KeyEventLike): string | null {
		return encodeKey(event, this.tracker.state, this.options.key);
	}

	/**
	 * The scroll/report fork. A pane whose application enabled mouse reporting
	 * gets an SGR wheel report as ordinary input; every other pane gets today's
	 * `terminal.scroll`.
	 *
	 * Note for #25/#33: herdr performs the same fork server-side when it receives
	 * `terminal.scroll` (`server/pane_input.rs::apply_scroll` encodes the wheel
	 * report itself, using the optional `column`/`row`/`modifiers` of the scroll
	 * command). Whichever side ends up owning it, exactly one of them may — two
	 * would report the notch twice.
	 */
	routeWheel(input: WheelInput): WheelRoute {
		const scroll = this.wheelToScroll(input.deltaY, input.deltaMode, input.rows);
		if (!scroll) return null;
		const position = input.position;
		if (position) {
			const report = encodeWheelReport(this.tracker.state, scroll.direction, position, {
				...(input.shiftKey === undefined ? {} : { shiftKey: input.shiftKey }),
				...(input.altKey === undefined ? {} : { altKey: input.altKey }),
				...(input.ctrlKey === undefined ? {} : { ctrlKey: input.ctrlKey }),
			});
			// One report per notch: a three-line scroll is still one wheel event.
			if (report !== null) return { kind: 'input', data: report };
		}
		return { kind: 'scroll', direction: scroll.direction, lines: scroll.lines, source: 'wheel' };
	}

	/**
	 * A click, for #25. Null means "leave it alone": the pane wants no reports,
	 * so the renderer's own selection handling keeps working.
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
