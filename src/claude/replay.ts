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
 *   so the replay never starts inside a sequence. Dropping costs what came
 *   in, not the bound: whole chunks go, only the one the cut falls in is
 *   copied, and bytes already searched for a line end are not searched again.
 * - **Modes.** Dropping bytes can drop the sequence that switched a mode on
 *   (the alternate screen, bracketed paste, mouse reports, the kitty
 *   keyboard flags). The modes in effect where the kept bytes begin are
 *   tracked and replayed first, so the renderer is in the state the kept
 *   bytes assume, and the input layer sees the modes the program set.
 * - **Full reset.** `ESC c` makes everything before it moot, so the buffer
 *   restarts there.
 * - **No queries.** A replay leaves out every sequence a renderer answers by
 *   itself ({@link QUERY}: device attributes, status and cursor reports, mode
 *   and setting requests, colour and clipboard queries, window reports, ENQ).
 *   The program asked them long ago; a reopened tab that answered them again
 *   would type the answers into whatever reads its input now (the D2 review
 *   saw `1;2c0;276;0c1R` land on a shell's command line). They draw nothing,
 *   so the screen is the same without them. Live output is never touched:
 *   a query after the replay is answered as ever.
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

/**
 * The sequences a renderer (xterm.js, ghostty-web) answers by itself, on
 * the latin1 text of the output: DA1/DA2/DA3, DSR and cursor position
 * (DECXCPR too), DECRQM, XTVERSION, the kitty keyboard query, XTQMODKEYS,
 * XTWINOPS reports, DECREQTPARM, DECRQSS and XTGETTCAP, any OSC whose last
 * field is `?` (colours, palette, clipboard, Claude's 7501 probe), DECID and
 * ENQ. 7-bit forms only: output is UTF-8, where a C1 byte is never alone.
 */
const QUERY = new RegExp(
	[
		'\\x1b\\[[>=]?[0-9;]*c',
		'\\x1b\\[\\??[0-9;]*n',
		'\\x1b\\[\\??[0-9;]*\\$p',
		'\\x1b\\[>[0-9;]*q',
		'\\x1b\\[\\?u',
		'\\x1b\\[\\?[0-9;]*m',
		'\\x1b\\[(?:1[13-9]|2[01])(?:;[0-9;]*)?t',
		'\\x1b\\[[01]?x',
		'\\x1bP[$+]q[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
		'\\x1b\\][0-9]+(?:;[^\\x07\\x1b]*)?;\\?(?:\\x07|\\x1b\\\\)',
		'\\x1bZ',
		'\\x05',
	].join('|'),
	'g',
);

/** `bytes` without the queries a renderer would answer ({@link QUERY}). */
export function withoutQueries(bytes: Uint8Array): Uint8Array {
	const text = latin1(bytes);
	QUERY.lastIndex = 0;
	if (!QUERY.test(text)) return bytes;
	const kept = text.replace(QUERY, '');
	const out = new Uint8Array(kept.length);
	for (let at = 0; at < kept.length; at++) out[at] = kept.charCodeAt(at);
	return out;
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
	/** Where the kept bytes start, counted from the first byte ever pushed. */
	private start = 0;
	/** No line end, and no ESC, in the stream before these offsets (counted the same way): searched already. */
	private noLineEndBefore = 0;
	private noEscBefore = 0;
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
			this.start += this.bytes + reset;
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

	/**
	 * Everything a fresh terminal needs: a reset, the modes, then the kept
	 * bytes, without the queries in them ({@link withoutQueries}).
	 */
	replay(): Uint8Array {
		return withoutQueries(this.raw());
	}

	/** The reset, the modes and the kept bytes as they came. */
	private raw(): Uint8Array {
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
		this.start += this.bytes;
		this.chunks = [];
		this.bytes = 0;
		this.startModes = new TerminalModes();
		this.dropped = false;
	}

	private trim(): void {
		const must = this.bytes - this.limit;
		// Just after the first line end at or past the bytes that must go.
		const newline = this.find(NEWLINE, Math.max(0, must - 1), 'line');
		let cut = newline + 1;
		if (newline === -1) {
			// One line longer than the bound: cut at the next sequence instead.
			const esc = this.find(ESC, must, 'esc');
			cut = esc === -1 ? this.bytes : esc;
		}
		this.dropFront(cut);
		this.dropped = true;
	}

	/**
	 * The index of the first `byte` at or after `from` in the kept bytes, or
	 * -1. A search that finds none remembers it, so the next one starts past
	 * what it read.
	 */
	private find(byte: number, from: number, kind: 'line' | 'esc'): number {
		const known = (kind === 'line' ? this.noLineEndBefore : this.noEscBefore) - this.start;
		let base = 0;
		for (const chunk of this.chunks) {
			const begin = Math.max(from, known) - base;
			if (begin < chunk.length) {
				const at = chunk.indexOf(byte, Math.max(0, begin));
				if (at !== -1) return base + at;
			}
			base += chunk.length;
		}
		if (kind === 'line') this.noLineEndBefore = this.start + this.bytes;
		else this.noEscBefore = this.start + this.bytes;
		return -1;
	}

	/** Drops the first `count` kept bytes, reading the modes they set. */
	private dropFront(count: number): void {
		const gone: Uint8Array[] = [];
		let left = count;
		while (left > 0) {
			const first = this.chunks[0];
			if (!first) break;
			if (first.length <= left) {
				gone.push(first);
				this.chunks.shift();
				left -= first.length;
			} else {
				gone.push(first.subarray(0, left));
				this.chunks[0] = first.slice(left);
				left = 0;
			}
		}
		const dropped = count - left;
		// One piece for the scan, so a sequence split across chunks is still read.
		let head = gone[0] ?? new Uint8Array(0);
		if (gone.length > 1) {
			head = new Uint8Array(dropped);
			let at = 0;
			for (const piece of gone) {
				head.set(piece, at);
				at += piece.length;
			}
		}
		this.startModes.scan(head);
		this.start += dropped;
		this.bytes -= dropped;
	}
}
