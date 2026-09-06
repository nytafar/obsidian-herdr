/**
 * Terminal mode tracking (#17).
 *
 * The routing decisions of #18 (shift+enter), #25 (mouse) and #33 (scrollback)
 * all depend on modes the *application* inside the pane sets: mouse reporting,
 * SGR mouse encoding, bracketed paste, application cursor keys and the kitty
 * keyboard protocol. This file owns that state and nothing else. It is pure —
 * no DOM, no `obsidian`, no bridge — so it is unit tested directly.
 *
 * ## What herdr actually sends (verified 2026-09-06, read-only observe)
 *
 * herdr's server-side VT *consumes* these sequences: it holds
 * `mouse_protocol_mode`, `mouse_protocol_encoding` and `keyboard_protocol` per
 * pane (`src/pane/terminal.rs`) and renders the pane to an absolute-positioned
 * cell repaint. A captured 176 KB first frame of a live Claude pane contained
 * only `ESC[?2026h/l` (synchronised output) and `ESC[?25h/l` (cursor
 * visibility) — no `?1000/1002/1003/1006/2004/1`, no `CSI > … u`. The
 * modes *are* on the wire as `ServerMessage::MouseCapture` and
 * `ServerMessage::DirectTerminalKeyboardProtocol`, but only to control-mode
 * clients, and `herdr terminal session control` drops every message that is not
 * a frame (`Ok(_) => {}` in `client/terminal_sessions.rs`), so nothing reaches
 * our NDJSON.
 *
 * So today this tracker stays in its defaults for every pane, which is exactly
 * why wiring it changes no behaviour. It is still the right shape: it costs one
 * `indexOf` per frame, and the moment the bridge grows a mode line (or we feed
 * it a raw stream) the routing above it starts working. See
 * notes/herdr-terminal-bridge.md.
 */

/** DEC modes 1000 / 1002 / 1003, collapsed to the most permissive one enabled. */
export type MouseTrackingMode = 'off' | 'normal' | 'button' | 'any';

/** DEC mode 1006. `legacy` is the X10/UTF-8 byte encoding we do not emit. */
export type MouseEncoding = 'legacy' | 'sgr';

export interface TerminalModeState {
	/** `off` unless the application asked for mouse reports. */
	readonly mouseTracking: MouseTrackingMode;
	readonly mouseEncoding: MouseEncoding;
	/** DEC 2004. A paste must be wrapped in `ESC[200~` / `ESC[201~`. */
	readonly bracketedPaste: boolean;
	/** DEC 1: cursor keys send `ESC O A` rather than `ESC [ A`. */
	readonly applicationCursorKeys: boolean;
	/** Top of the kitty keyboard stack; 0 means the legacy protocol. */
	readonly kittyFlags: number;
}

/** What a terminal is in before any application says otherwise. */
export const DEFAULT_MODE_STATE: TerminalModeState = Object.freeze({
	mouseTracking: 'off',
	mouseEncoding: 'legacy',
	bracketedPaste: false,
	applicationCursorKeys: false,
	kittyFlags: 0,
});

/** Kitty keyboard protocol flags (`CSI > flags u`), from the kitty spec. */
export const KITTY_DISAMBIGUATE = 1;
export const KITTY_REPORT_EVENT_TYPES = 2;
export const KITTY_REPORT_ALTERNATE_KEYS = 4;
export const KITTY_REPORT_ALL_KEYS = 8;
export const KITTY_REPORT_ASSOCIATED_TEXT = 16;

/** True when the application asked for mouse reports of any kind. */
export function mouseReportingEnabled(state: TerminalModeState): boolean {
	return state.mouseTracking !== 'off';
}

const ESC = 0x1b;
const CSI_BRACKET = 0x5b; // '['

/**
 * A sequence longer than this is not one we track (the longest is
 * `ESC[?1000;1002;1003;1006h`), so an unterminated run that grows past it is
 * dropped instead of being carried between frames forever.
 */
export const MAX_CARRY_BYTES = 64;

/** Kitty caps its stack; a runaway pusher must not grow our memory. */
export const MAX_KITTY_STACK = 16;

const EMPTY = new Uint8Array(0);

/** Result of `parseSequence`: how many bytes to skip, or that we need more. */
const INCOMPLETE = -1;

interface MutableModes {
	mouse1000: boolean;
	mouse1002: boolean;
	mouse1003: boolean;
	sgrMouse: boolean;
	bracketedPaste: boolean;
	applicationCursorKeys: boolean;
}

/**
 * Feeds on the raw frame bytes and keeps the modes the input layer needs.
 *
 * Cheap by construction: it looks for `ESC` and parses only what follows one, so
 * a 176 KB frame of positioned cells costs a handful of `indexOf` calls. Handles
 * sequences split across frames with a bounded carry-over.
 */
export class TerminalModeTracker {
	private modes: MutableModes = freshModes();
	private kittyStack: number[] = [];
	private carry: Uint8Array = EMPTY;

	/** Current modes. A new object per call; treat it as a snapshot. */
	get state(): TerminalModeState {
		return {
			mouseTracking: this.modes.mouse1003
				? 'any'
				: this.modes.mouse1002
					? 'button'
					: this.modes.mouse1000
						? 'normal'
						: 'off',
			mouseEncoding: this.modes.sgrMouse ? 'sgr' : 'legacy',
			bracketedPaste: this.modes.bracketedPaste,
			applicationCursorKeys: this.modes.applicationCursorKeys,
			kittyFlags: this.kittyStack.at(-1) ?? 0,
		};
	}

	/** Back to `DEFAULT_MODE_STATE`. Called when a new bridge process attaches. */
	reset(): void {
		this.modes = freshModes();
		this.kittyStack = [];
		this.carry = EMPTY;
	}

	/**
	 * Scans one frame. A `full: true` frame is *not* special: herdr's full frames
	 * are a repaint (`ESC[2J` plus positioned cells), they say nothing about
	 * modes, so only the bytes may change state.
	 */
	feed(bytes: Uint8Array): void {
		if (bytes.length === 0 && this.carry.length === 0) return;
		let data = bytes;
		if (this.carry.length > 0) {
			data = new Uint8Array(this.carry.length + bytes.length);
			data.set(this.carry, 0);
			data.set(bytes, this.carry.length);
			this.carry = EMPTY;
		}
		let at = 0;
		while (at < data.length) {
			const esc = data.indexOf(ESC, at);
			if (esc < 0) return;
			const next = this.parseSequence(data, esc);
			if (next === INCOMPLETE) {
				const tail = data.subarray(esc);
				// Copy: the caller owns `bytes` and may reuse the buffer.
				this.carry = tail.length <= MAX_CARRY_BYTES ? new Uint8Array(tail) : EMPTY;
				return;
			}
			at = next;
		}
	}

	/**
	 * Parses the sequence starting at `esc`. Returns the index just past it, or
	 * `INCOMPLETE` when the frame ended mid-sequence. Anything that is not a CSI
	 * costs one byte: the next `ESC` is found by the caller's `indexOf`.
	 */
	private parseSequence(data: Uint8Array, esc: number): number {
		const afterEsc = esc + 1;
		if (afterEsc >= data.length) return INCOMPLETE;
		if (data[afterEsc] !== CSI_BRACKET) return afterEsc;

		let at = afterEsc + 1;
		// ECMA-48 parameter bytes, 0x30-0x3f: digits, ';', ':' and the private
		// markers '<', '=', '>', '?'.
		const paramsFrom = at;
		while (at < data.length) {
			const byte = data[at];
			if (byte === undefined || byte < 0x30 || byte > 0x3f) break;
			at++;
		}
		const paramsTo = at;
		// Intermediate bytes, 0x20-0x2f.
		while (at < data.length) {
			const byte = data[at];
			if (byte === undefined || byte < 0x20 || byte > 0x2f) break;
			at++;
		}
		if (at >= data.length) {
			// Only worth waiting for if it could still be one of ours.
			return at - esc <= MAX_CARRY_BYTES ? INCOMPLETE : afterEsc;
		}
		const final = data[at];
		if (final === undefined || final < 0x40 || final > 0x7e) {
			// Not a CSI after all (a stray ESC in binary payload, say).
			return afterEsc;
		}
		const end = at + 1;

		const marker = paramsTo > paramsFrom ? data[paramsFrom] : undefined;
		const isPrivate = marker !== undefined && marker >= 0x3c && marker <= 0x3f;
		const digitsFrom = isPrivate ? paramsFrom + 1 : paramsFrom;
		const params = parseParams(data, digitsFrom, paramsTo);

		if (isPrivate && marker === 0x3f && (final === 0x68 || final === 0x6c)) {
			this.applyDecPrivateMode(params, final === 0x68);
		} else if (final === 0x75 && isPrivate) {
			this.applyKitty(marker, params);
		}
		return end;
	}

	/** `CSI ? p… h` (set) / `CSI ? p… l` (reset). */
	private applyDecPrivateMode(params: number[], set: boolean): void {
		for (const param of params) {
			switch (param) {
				case 1:
					this.modes.applicationCursorKeys = set;
					break;
				case 1000:
					this.modes.mouse1000 = set;
					break;
				case 1002:
					this.modes.mouse1002 = set;
					break;
				case 1003:
					this.modes.mouse1003 = set;
					break;
				case 1006:
					this.modes.sgrMouse = set;
					break;
				case 2004:
					this.modes.bracketedPaste = set;
					break;
				default:
					break;
			}
		}
	}

	/**
	 * The kitty keyboard protocol's three stack operations:
	 * `CSI > flags u` push, `CSI < n u` pop n (default 1),
	 * `CSI = flags ; mode u` where mode 1 sets, 2 sets bits, 3 clears bits.
	 */
	private applyKitty(marker: number, params: number[]): void {
		if (marker === 0x3e) {
			// '>'
			this.kittyStack.push(params[0] ?? 0);
			if (this.kittyStack.length > MAX_KITTY_STACK) this.kittyStack.shift();
			return;
		}
		if (marker === 0x3c) {
			// '<'
			const count = Math.max(1, params[0] ?? 1);
			this.kittyStack.length = Math.max(0, this.kittyStack.length - count);
			return;
		}
		if (marker !== 0x3d) return; // '='
		const flags = params[0] ?? 0;
		const mode = params[1] ?? 1;
		const current = this.kittyStack.at(-1) ?? 0;
		const next = mode === 2 ? current | flags : mode === 3 ? current & ~flags : flags;
		if (this.kittyStack.length === 0) this.kittyStack.push(next);
		else this.kittyStack[this.kittyStack.length - 1] = next;
	}
}

function freshModes(): MutableModes {
	return {
		mouse1000: false,
		mouse1002: false,
		mouse1003: false,
		sgrMouse: false,
		bracketedPaste: false,
		applicationCursorKeys: false,
	};
}

/** Digits between `from` and `to`, split on `;`. An empty parameter is 0. */
function parseParams(data: Uint8Array, from: number, to: number): number[] {
	const params: number[] = [];
	let value = 0;
	let seen = false;
	for (let at = from; at < to; at++) {
		const byte = data[at];
		if (byte === undefined) break;
		if (byte >= 0x30 && byte <= 0x39) {
			value = value * 10 + (byte - 0x30);
			// A pane cannot mean a parameter this large; clamp rather than overflow.
			if (value > 0xffff) value = 0xffff;
			seen = true;
			continue;
		}
		if (byte === 0x3b) {
			params.push(seen ? value : 0);
			value = 0;
			seen = false;
			continue;
		}
		// A sub-parameter (`:`); the values after it are not ones we read.
		if (byte === 0x3a) break;
	}
	params.push(seen ? value : 0);
	return params;
}
