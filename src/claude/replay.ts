/**
 * What a pty said, kept so a terminal tab that is closed and opened again in
 * the same Obsidian run shows the program's screen (ADR-0007's D2).
 *
 * The plugin keeps the program running when its tab closes, and a reopened
 * tab is a fresh renderer. It is brought up to date by replaying a bounded
 * buffer of the raw output:
 *
 * - **Bound.** At most {@link REPLAY_LIMIT_BYTES}. Older bytes are dropped
 *   from the front, at a line boundary (an escape sequence never spans one),
 *   so the replay never starts inside a sequence.
 * - **Modes.** Dropping bytes can drop the sequence that switched a mode on
 *   (the alternate screen, bracketed paste, mouse reports, the kitty
 *   keyboard flags). The modes in effect where the kept bytes begin are
 *   tracked and replayed first, so the renderer is in the state the kept
 *   bytes assume, and the input layer sees the modes the program set.
 * - **Full reset.** `ESC c` makes everything before it moot, so the buffer
 *   restarts there.
 * - **Repaint.** A replay is exact while nothing was dropped. Once something
 *   was ({@link trimmed}), the owner also asks the program to draw its screen
 *   again (a SIGWINCH): Claude's TUI repaints all of it on one (measured).
 *
 * No Obsidian, no process.
 */

/** How much output a pty keeps for a reopened tab. */
export const REPLAY_LIMIT_BYTES = 1 << 20;

const ESC = 0x1b;
const NEWLINE = 0x0a;

/** What a replay starts with: a full reset, then the scrollback cleared too. */
export const REPLAY_RESET = '\x1bc\x1b[3J';

/** The alternate-screen modes, which are replayed before any other. */
const ALT_SCREEN_MODES = [1049, 1047, 47];
/** Modes on by default, so a replay has to say when they are off. */
const DEFAULT_ON_MODES = new Set([7, 25]);
/** Never replayed: synchronized output left on would freeze the renderer. */
const NOT_REPLAYED_MODES = new Set([2026]);

// eslint-disable-next-line no-control-regex -- escape sequences are the point
const DEC_MODE = /\x1b\[\?([0-9;]+)([hl])/g;
// eslint-disable-next-line no-control-regex -- escape sequences are the point
const KITTY_KEYBOARD = /\x1b\[([<>=])([0-9;]*)u/g;

function latin1(bytes: Uint8Array): string {
	let text = '';
	for (let at = 0; at < bytes.length; at += 8192) {
		text += String.fromCharCode(...bytes.subarray(at, at + 8192));
	}
	return text;
}

/** The DEC private modes and kitty keyboard flags a stream has set. */
export class TerminalModes {
	private readonly modes = new Map<number, boolean>();
	private kitty: number[] = [];

	/** Reads every mode change in `bytes`, in order. */
	scan(bytes: Uint8Array): void {
		const text = latin1(bytes);
		// Both kinds, in the order they appear.
		const events: { at: number; apply: () => void }[] = [];
		for (const match of text.matchAll(DEC_MODE)) {
			const on = match[2] === 'h';
			const numbers = (match[1] ?? '').split(';').filter(Boolean).map(Number);
			events.push({
				at: match.index,
				apply: () => {
					for (const mode of numbers) this.modes.set(mode, on);
				},
			});
		}
		for (const match of text.matchAll(KITTY_KEYBOARD)) {
			const op = match[1];
			const [first, second] = (match[2] ?? '').split(';').map((part) => (part ? Number(part) : NaN));
			events.push({
				at: match.index,
				apply: () => this.applyKitty(op, first, second),
			});
		}
		events.sort((a, b) => a.at - b.at);
		for (const event of events) event.apply();
	}

	private applyKitty(op: string | undefined, first: number | undefined, second: number | undefined): void {
		const flags = Number.isFinite(first) ? (first as number) : 0;
		if (op === '>') {
			this.kitty.push(flags);
		} else if (op === '<') {
			const count = Number.isFinite(first) ? (first as number) : 1;
			this.kitty = this.kitty.slice(0, Math.max(0, this.kitty.length - count));
		} else if (op === '=') {
			const mode = Number.isFinite(second) ? (second as number) : 1;
			const top = this.kitty.at(-1) ?? 0;
			const next = mode === 2 ? top | flags : mode === 3 ? top & ~flags : flags;
			if (this.kitty.length === 0) this.kitty.push(next);
			else this.kitty[this.kitty.length - 1] = next;
		}
	}

	/** The sequences that put a fresh terminal into these modes. */
	sequence(): string {
		let out = '';
		for (const mode of ALT_SCREEN_MODES) {
			if (this.modes.get(mode) === true) out += `\x1b[?${mode}h`;
		}
		for (const [mode, on] of this.modes) {
			if (ALT_SCREEN_MODES.includes(mode) || NOT_REPLAYED_MODES.has(mode)) continue;
			if (on) out += `\x1b[?${mode}h`;
			else if (DEFAULT_ON_MODES.has(mode)) out += `\x1b[?${mode}l`;
		}
		for (const flags of this.kitty) out += `\x1b[>${flags}u`;
		return out;
	}
}

/** Index of the last `ESC c` (a full reset) in `bytes`, or -1. */
function lastFullReset(bytes: Uint8Array): number {
	for (let at = bytes.length - 2; at >= 0; at--) {
		if (bytes[at] === ESC && bytes[at + 1] === 0x63) return at;
	}
	return -1;
}

export class ReplayBuffer {
	private chunks: Uint8Array[] = [];
	private bytes = 0;
	/** The modes in effect where the kept bytes begin. */
	private startModes = new TerminalModes();
	private dropped = false;

	constructor(readonly limit: number = REPLAY_LIMIT_BYTES) {}

	/** Bytes kept. Never more than {@link limit}. */
	get size(): number {
		return this.bytes;
	}

	/** Whether output was dropped, so a replay alone may not show the whole screen. */
	get trimmed(): boolean {
		return this.dropped;
	}

	push(chunk: Uint8Array): void {
		if (chunk.length === 0) return;
		let kept = chunk;
		const reset = lastFullReset(chunk);
		if (reset >= 0) {
			// Exact: nothing before a full reset shows.
			this.chunks = [];
			this.bytes = 0;
			this.startModes = new TerminalModes();
			kept = chunk.subarray(reset);
		}
		// A copy: the caller's buffer may be reused.
		this.chunks.push(kept.slice());
		this.bytes += kept.length;
		if (this.bytes > this.limit) this.trim();
	}

	/** Everything a fresh terminal needs: a reset, the modes, then the kept bytes. */
	replay(): Uint8Array {
		const prefix = new TextEncoder().encode(REPLAY_RESET + this.startModes.sequence());
		const out = new Uint8Array(prefix.length + this.bytes);
		out.set(prefix, 0);
		let at = prefix.length;
		for (const chunk of this.chunks) {
			out.set(chunk, at);
			at += chunk.length;
		}
		return out;
	}

	clear(): void {
		this.chunks = [];
		this.bytes = 0;
		this.startModes = new TerminalModes();
		this.dropped = false;
	}

	private trim(): void {
		const all = new Uint8Array(this.bytes);
		let at = 0;
		for (const chunk of this.chunks) {
			all.set(chunk, at);
			at += chunk.length;
		}
		const must = all.length - this.limit;
		// Just after the first line end at or past the bytes that must go.
		const newline = all.indexOf(NEWLINE, Math.max(0, must - 1));
		let cut = newline === -1 ? -1 : newline + 1;
		if (cut === -1 || all.length - cut > this.limit) {
			// One line longer than the bound: cut at the next sequence instead.
			const esc = all.indexOf(ESC, must);
			cut = esc === -1 ? all.length : esc;
		}
		this.startModes.scan(all.subarray(0, cut));
		const rest = all.slice(cut);
		this.chunks = rest.length > 0 ? [rest] : [];
		this.bytes = rest.length;
		this.dropped = true;
	}
}
