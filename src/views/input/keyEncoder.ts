/**
 * Keyboard encoding (#17). Pure: it takes a `KeyboardEvent`-shaped plain object
 * plus the tracked modes and returns the bytes to send, or `null` meaning "not
 * ours — let the renderer's own encoder handle this key".
 *
 * **This module has no policy of its own.** `DEFAULT_KEY_ENCODING_OPTIONS`
 * disables every rule, so `encodeKey` returns `null` for every key unless the
 * caller asks for one. `InputRouter` is where the plugin's policy lives, and it
 * switches `shiftEnterLineBreak` on (#18).
 *
 * Two encodings, because a pane negotiates one or the other:
 *
 * - **kitty keyboard protocol** — `CSI <unicode-key-code> ; <modifiers> u`,
 *   where the modifier field is a bitfield (shift 1, alt 2, ctrl 4, super 8)
 *   plus one. Available only when the application pushed non-zero kitty flags.
 * - **legacy** — no encoding exists for shift+enter, which is the whole problem
 *   in #18: a plain `\r` submits. The convention Claude Code's `/terminal-setup`
 *   writes into iTerm2 and VS Code is `ESC` followed by `CR`, i.e. what a
 *   terminal sends for alt+enter, so that is what we fall back to.
 *
 * `TerminalModeTracker` cannot see kitty flags today, because herdr does not
 * relay mode sequences in its frames (see `modeTracker.ts`). The kitty branch is
 * therefore reachable only once that signal exists; `ESC CR` is what a live pane
 * actually receives, and it is what the Ink-based harnesses (Claude Code,
 * Codex, Gemini CLI) read as "insert a line" in their composer. That choice is
 * #18's, recorded here so the kitty branch is not mistaken for dead code.
 */

import { KITTY_DISAMBIGUATE, type TerminalModeState } from './modeTracker';

/** The fields of a DOM `KeyboardEvent` this layer reads. */
export interface KeyEventLike {
	key: string;
	code?: string;
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	/**
	 * DOM `KeyboardEvent.isComposing` (#49): true for every keydown that belongs
	 * to an input-method composition, Enter included.
	 */
	isComposing?: boolean;
	/**
	 * Legacy `KeyboardEvent.keyCode`. 229 is the "processing key" every browser
	 * still reports during a composition, and it is the only signal on a keydown
	 * that a broken IME leaves `isComposing` false for.
	 */
	keyCode?: number;
}

/** The `keyCode` a browser reports for a keydown an IME is processing. */
export const IME_PROCESSING_KEY_CODE = 229;

/**
 * True while an input method owns the keystroke (#49).
 *
 * xterm.js calls our custom key handler *before* its composition helper, so a
 * composing Enter — the one that commits a CJK candidate — reaches `encodeKey`
 * and would be turned into a line break by #18's rule. ghostty-web returns early
 * on the same condition and never asks, so the check costs it nothing.
 */
export function isComposingKey(event: KeyEventLike): boolean {
	return event.isComposing === true || event.keyCode === IME_PROCESSING_KEY_CODE;
}

/** Modifier bits of the kitty `modifiers` field, before the mandatory `+ 1`. */
export const KITTY_MOD_SHIFT = 1;
export const KITTY_MOD_ALT = 2;
export const KITTY_MOD_CTRL = 4;
export const KITTY_MOD_SUPER = 8;

/** What alt+enter sends on a legacy terminal, and what Claude Code accepts. */
export const LEGACY_LINE_BREAK = '\x1b\r';

export interface KeyEncodingOptions {
	/**
	 * #18: shift+enter (and alt+enter) become a line break instead of a submit.
	 * Off here so this refactor is invisible.
	 */
	shiftEnterLineBreak: boolean;
	/**
	 * Encode every modified key with kitty `CSI u` when the pane negotiated the
	 * kitty protocol. Off until something can observe those flags.
	 */
	kittyModifiedKeys: boolean;
}

export const DEFAULT_KEY_ENCODING_OPTIONS: KeyEncodingOptions = Object.freeze({
	shiftEnterLineBreak: false,
	kittyModifiedKeys: false,
});

/**
 * Kitty's modifier field: the bitfield plus one, so an unmodified key is 1.
 * Caps lock and num lock are deliberately not reported: they are lock states,
 * not modifiers a terminal application wants in the key report.
 */
export function kittyModifiers(event: KeyEventLike): number {
	let bits = 0;
	if (event.shiftKey) bits |= KITTY_MOD_SHIFT;
	if (event.altKey) bits |= KITTY_MOD_ALT;
	if (event.ctrlKey) bits |= KITTY_MOD_CTRL;
	if (event.metaKey) bits |= KITTY_MOD_SUPER;
	return bits + 1;
}

/**
 * The kitty "unicode-key-code" for keys that have one: the functional keys that
 * keep their legacy codepoint, plus any single-character key (reported
 * unshifted, so shift+A is the codepoint of `a`). Keys with a dedicated CSI form
 * — arrows, Home/End, F-keys — return null: they are the renderer's business,
 * not ours, and encoding them badly is worse than not encoding them.
 */
export function kittyKeyCode(key: string): number | null {
	switch (key) {
		case 'Enter':
			return 13;
		case 'Tab':
			return 9;
		case 'Backspace':
			return 127;
		case 'Escape':
			return 27;
		case ' ':
		case 'Spacebar':
			return 32;
		default:
			break;
	}
	// `[...key]` counts code points, so an astral character is still length 1.
	if ([...key].length !== 1) return null;
	return key.toLowerCase().codePointAt(0) ?? null;
}

/**
 * `CSI <code> ; <modifiers> u`. Null when the key has no unicode-key-code, or
 * when no modifier is held — an unmodified key is typed, not reported, unless
 * the application asked for all keys, which we do not implement here.
 */
export function encodeKittyKey(event: KeyEventLike): string | null {
	const code = kittyKeyCode(event.key);
	if (code === null) return null;
	const modifiers = kittyModifiers(event);
	if (modifiers === 1) return null;
	return `\x1b[${code};${modifiers}u`;
}

/** True when the pane pushed kitty flags that make `CSI u` reports meaningful. */
export function kittyActive(state: TerminalModeState): boolean {
	return (state.kittyFlags & KITTY_DISAMBIGUATE) !== 0;
}

/**
 * The one entry point. Returns the string to hand `terminal.input`, or null to
 * let the renderer encode the key as it always has.
 *
 * With the default options this is `null` for every key, which is the whole
 * point of #17: the seam exists, the behaviour does not change.
 */
export function encodeKey(
	event: KeyEventLike,
	state: TerminalModeState,
	options: KeyEncodingOptions = DEFAULT_KEY_ENCODING_OPTIONS,
): string | null {
	// #49: during an IME composition every key belongs to the input method.
	// Enter commits the candidate; encoding it as a line break would eat the
	// commit, and any other encoding here would double the composed text.
	if (isComposingKey(event)) return null;
	if (options.shiftEnterLineBreak && isLineBreakEnter(event)) {
		return kittyActive(state) ? (encodeKittyKey(event) ?? LEGACY_LINE_BREAK) : LEGACY_LINE_BREAK;
	}
	if (options.kittyModifiedKeys && kittyActive(state)) {
		return encodeKittyKey(event);
	}
	return null;
}

/**
 * Shift+enter or alt+enter, and nothing else: ctrl+enter and cmd+enter mean
 * other things to agent harnesses, and plain enter must keep submitting.
 */
function isLineBreakEnter(event: KeyEventLike): boolean {
	if (event.key !== 'Enter') return false;
	if (event.ctrlKey || event.metaKey) return false;
	return event.shiftKey || event.altKey;
}
