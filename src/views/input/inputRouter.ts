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
 * The shipped options encode shift+enter (#18) and shift+tab (#18, #47);
 * everything else is left to the renderer. `routeHostKey` is the fourth
 * question (#47): which of Obsidian and the terminal gets a keydown. #25 gives `routeWheel` a cell position and modifiers;
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
	hostKeys: HostKeyPolicy;
}

/**
 * Obsidian's own modifier vocabulary (`Modifier` in obsidian.d.ts): `Mod` is
 * cmd on macOS and ctrl elsewhere.
 */
export type ChordModifier = 'Mod' | 'Ctrl' | 'Meta' | 'Alt' | 'Shift';

/** One key combination, in the form Obsidian's hotkey settings use. */
export interface KeyChord {
	modifiers: readonly ChordModifier[];
	/** `KeyboardEvent.key`, compared case-insensitively. */
	key: string;
}

/**
 * What a focused terminal does with a keydown Obsidian's keymap saw first (#47).
 *
 * Obsidian dispatches hotkeys from a `keydown` listener on `window` in the
 * *capture* phase, and it never reads `defaultPrevented` — measured in the
 * snapshot vault: Cmd+P opened the palette with `defaultPrevented: true`. No
 * listener on the terminal host, capture or bubble, runs before that one, so
 * a DOM listener cannot intercept anything. What can is the keymap's own
 * scope stack: the workspace scope defers to `activeLeaf.view.scope`, and a
 * scope handler's return value is the whole protocol —
 *
 *   `undefined` -> keep looking: the parent scope (the app's hotkeys) runs.
 *   `true`      -> stop looking, touch nothing: no hotkey fires, and the DOM
 *                  event still reaches the terminal's input element.
 *   `false`     -> consumed: Obsidian calls `preventDefault` and
 *                  `stopPropagation` at the window, nothing downstream sees it.
 *
 * The three decisions map onto those three returns, and the view holds the
 * mapping. This module only decides.
 */
export type HostKeyDecision = 'host' | 'terminal' | 'drop';

/**
 * The focused-terminal policy (#47), data only so it can grow a settings page.
 *
 * - `escapeHatches` are Obsidian's, always, so focus in a terminal can never
 *   trap the user: command palette, settings, quit, and a configurable list
 *   later. They pass through untouched and are not sent to the pane.
 * - `nativeChords` are handled by the browser or the renderer itself rather
 *   than encoded: ghostty-web lets cmd+v and cmd+c through for the clipboard.
 *   They belong to the terminal and Obsidian must not see them.
 * - Everything a terminal encodes is the terminal's: plain keys, Escape, Tab,
 *   ctrl+letter, alt/meta sequences, and whatever `routeKey` claims.
 * - A `Mod` (cmd on macOS) combination the terminal does not encode is
 *   dropped: not forwarded to Obsidian, not sent to the pane.
 *
 * `platform` decides what `Mod` means. On Linux and Windows `Mod` is ctrl, and
 * ctrl is the terminal's, so nothing is dropped there and only the escape
 * hatches are taken from the shell — the price of never trapping focus, and
 * the list is the place to make that cheaper.
 */
export interface HostKeyPolicy {
	escapeHatches: readonly KeyChord[];
	nativeChords: readonly KeyChord[];
	platform: 'macOS' | 'other';
}

/** Command palette, settings and quit. The minimum #47 requires. */
export const DEFAULT_ESCAPE_HATCHES: readonly KeyChord[] = Object.freeze([
	{ modifiers: ['Mod'], key: 'p' },
	{ modifiers: ['Mod'], key: ',' },
	{ modifiers: ['Mod'], key: 'q' },
]);

/** What ghostty-web's `handleKeyDown` leaves to the browser. */
export const DEFAULT_NATIVE_CHORDS: readonly KeyChord[] = Object.freeze([
	{ modifiers: ['Mod'], key: 'c' },
	{ modifiers: ['Mod'], key: 'v' },
]);

export const DEFAULT_HOST_KEY_POLICY: HostKeyPolicy = Object.freeze({
	escapeHatches: DEFAULT_ESCAPE_HATCHES,
	nativeChords: DEFAULT_NATIVE_CHORDS,
	platform: 'macOS',
});

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS']);

/** The event's held modifiers as Obsidian would compile them, sorted. */
function heldModifiers(event: KeyEventLike): string {
	const held: string[] = [];
	if (event.ctrlKey) held.push('Ctrl');
	if (event.metaKey) held.push('Meta');
	if (event.altKey) held.push('Alt');
	if (event.shiftKey) held.push('Shift');
	return held.sort().join(',');
}

/** A chord's modifiers with `Mod` resolved for the platform, sorted. */
function chordModifiers(chord: KeyChord, platform: HostKeyPolicy['platform']): string {
	const mod = platform === 'macOS' ? 'Meta' : 'Ctrl';
	return [...new Set(chord.modifiers.map((m) => (m === 'Mod' ? mod : m)))].sort().join(',');
}

/** True when the event is exactly this chord: same key, same modifier set. */
export function matchesChord(
	event: KeyEventLike,
	chord: KeyChord,
	platform: HostKeyPolicy['platform'],
): boolean {
	if (event.key.toLowerCase() !== chord.key.toLowerCase()) return false;
	return heldModifiers(event) === chordModifiers(chord, platform);
}

/**
 * The decision for one keydown, pure. `encoded` is whether the input layer
 * claims the key itself (`routeKey` non-null) and `composing` is the element's
 * composition flag (#49); the router passes both in.
 */
export function decideHostKey(
	event: KeyEventLike,
	encoded: boolean,
	policy: HostKeyPolicy = DEFAULT_HOST_KEY_POLICY,
	composing = false,
): HostKeyDecision {
	// Obsidian skips bare modifier presses before it consults any scope; they
	// are listed as the terminal's so a caller never drops them by accident.
	if (MODIFIER_KEYS.has(event.key)) return 'terminal';
	if (policy.escapeHatches.some((chord) => matchesChord(event, chord, policy.platform))) {
		return 'host';
	}
	// An input method owns a composing key. Obsidian must not fire on it, and
	// dropping it would eat the candidate.
	if (composing || isComposingKey(event)) return 'terminal';
	if (encoded) return 'terminal';
	if (policy.nativeChords.some((chord) => matchesChord(event, chord, policy.platform))) {
		return 'terminal';
	}
	// Cmd is the one modifier no terminal encodes. On macOS ctrl+letter is the
	// shell's (Obsidian binds nothing to bare ctrl there) and alt is meta, so
	// both stay the terminal's. Elsewhere `Mod` is ctrl, and ctrl belongs to
	// the shell, so nothing is dropped.
	if (event.metaKey && policy.platform === 'macOS') return 'drop';
	return 'terminal';
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
	hostKeys: DEFAULT_HOST_KEY_POLICY,
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
	 * The focused-terminal policy for a keydown Obsidian's keymap is about to
	 * dispatch (#47): see `decideHostKey`. Asked from the view's `Scope`
	 * handler, before the renderer sees the event.
	 */
	routeHostKey(event: KeyEventLike): HostKeyDecision {
		return decideHostKey(
			event,
			this.routeKey(event) !== null,
			this.options.hostKeys,
			this.composing,
		);
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
