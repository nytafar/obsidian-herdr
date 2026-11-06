/**
 * What a reopened `claude` terminal tab is repainted from (ADR-0007's D2):
 * the bounded replay buffer (`src/claude/replay.ts`) and Claude's OSC 7501
 * status reports (`src/claude/programStatus.ts`).
 */

import { Terminal } from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import {
	parseProgramStatus,
	PROGRAM_STATUS_REPLY,
	ProgramStatusScanner,
} from '../src/claude/programStatus';
import { REPLAY_LIMIT_BYTES, REPLAY_RESET, ReplayBuffer, TerminalModes } from '../src/claude/replay';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

describe('the replay buffer', () => {
	it('replays everything after a reset while it is under the bound', () => {
		const buffer = new ReplayBuffer(100);
		buffer.push(bytes('\x1b[?1049h\x1b[2Jhello\r\n'));
		buffer.push(bytes('world'));
		expect(text(buffer.replay())).toBe(`${REPLAY_RESET}\x1b[?1049h\x1b[2Jhello\r\nworld`);
		expect(buffer.trimmed).toBe(false);
	});

	it('never keeps more than its bound, cut after a line end', () => {
		const buffer = new ReplayBuffer(32);
		for (let line = 0; line < 20; line++) buffer.push(bytes(`line ${String(line).padStart(2, '0')}\r\n`));
		expect(buffer.size).toBeLessThanOrEqual(32);
		expect(buffer.trimmed).toBe(true);
		const replayed = text(buffer.replay()).slice(REPLAY_RESET.length);
		// Whole lines only, the newest last.
		expect(replayed).toBe('line 17\r\nline 18\r\nline 19\r\n');
	});

	it('is a mebibyte by default', () => {
		const buffer = new ReplayBuffer();
		expect(buffer.limit).toBe(REPLAY_LIMIT_BYTES);
		const line = bytes(`${'x'.repeat(1023)}\n`);
		for (let i = 0; i < 1500; i++) buffer.push(line);
		expect(buffer.size).toBeLessThanOrEqual(REPLAY_LIMIT_BYTES);
		expect(buffer.size).toBeGreaterThan(REPLAY_LIMIT_BYTES - 1024);
	});

	it('trims a full buffer in time proportional to what comes in, not to the bound', () => {
		const limit = 64 * 1024;
		const streams = {
			// A shell, a log: plenty of line ends.
			lines: (i: number) => `${String(i).padStart(6, '0')} ${'x'.repeat(1000)}\r\n`,
			// A full-screen program: cursor addressing, no line end at all.
			screen: (i: number) => `\x1b[${(i % 40) + 1};1H\x1b[2K${'y'.repeat(1000)}`,
			// Plain text with neither.
			text: () => 'z'.repeat(1000),
		};
		for (const [name, chunk] of Object.entries(streams)) {
			const buffer = new ReplayBuffer(limit);
			for (let i = 0; i < 100; i++) buffer.push(bytes(chunk(i)));
			// The spy shadows `set` on Uint8Array's prototype; the real one stays on %TypedArray%'s.
			const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
			let copied = 0;
			const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
				this: Uint8Array,
				source: ArrayLike<number>,
				offset?: number,
			) {
				copied += source.length;
				Reflect.apply(Reflect.get(typedArray, 'set') as (...args: unknown[]) => void, this, [source, offset]);
			});
			let pushed = 0;
			try {
				for (let i = 100; i < 1100; i++) {
					const data = bytes(chunk(i));
					pushed += data.length;
					buffer.push(data);
				}
			} finally {
				set.mockRestore();
			}
			expect(buffer.size, name).toBeLessThanOrEqual(limit);
			// Before, every chunk past the bound copied the whole buffer: 64x here.
			expect(copied / pushed, name).toBeLessThan(3);
		}
	});

	it('cuts a line longer than the bound at an escape sequence, never inside one', () => {
		const buffer = new ReplayBuffer(16);
		buffer.push(bytes(`${'a'.repeat(30)}\x1b[31mred`));
		expect(text(buffer.replay()).slice(REPLAY_RESET.length)).toBe('\x1b[31mred');
	});

	it('puts back the modes the dropped bytes set, alternate screen first', () => {
		const buffer = new ReplayBuffer(24);
		buffer.push(bytes('\x1b[?2004h\x1b[?25l\x1b[?1049h\x1b[>1u\x1b[?2026h\r\n'));
		buffer.push(bytes('\x1b[?2026lpadding padding\r\nscreen\r\n'));
		expect(buffer.trimmed).toBe(true);
		const replayed = text(buffer.replay());
		expect(replayed.startsWith(`${REPLAY_RESET}\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[>1u`)).toBe(true);
		expect(replayed.endsWith('screen\r\n')).toBe(true);
		// Synchronized output is never replayed on.
		expect(replayed).not.toContain('\x1b[?2026h');
	});

	it('forgets a mode switched off again, and a popped keyboard mode', () => {
		const modes = new TerminalModes();
		modes.scan(bytes('\x1b[?1000;1006h\x1b[>3u\x1b[?1000l\x1b[<u'));
		expect(modes.sequence()).toBe('\x1b[?1006h');
	});

	it('starts again at a full reset', () => {
		const buffer = new ReplayBuffer(1000);
		buffer.push(bytes('\x1b[?1049hold screen'));
		buffer.push(bytes('more\x1bcnew'));
		expect(text(buffer.replay())).toBe(`${REPLAY_RESET}\x1bcnew`);
	});
});

/** Queries a renderer answers by itself, as Claude's TUI, a shell and vim send them. */
const QUERIES = [
	'\x1b[c',
	'\x1b[0c',
	'\x1b[>c',
	'\x1b[>0c',
	'\x1b[=c',
	'\x1b[5n',
	'\x1b[6n',
	'\x1b[?6n',
	'\x1b[?2026$p',
	'\x1b[4$p',
	'\x1b[>q',
	'\x1b[>0q',
	'\x1b[?u',
	'\x1b[?4m',
	'\x1b[14t',
	'\x1b[18t',
	'\x1b]10;?\x1b\\',
	'\x1b]11;?\x07',
	'\x1b]4;1;?\x1b\\',
	'\x1b]52;c;?\x07',
	'\x1b]7501;?\x1b\\',
	'\x1bP$qm\x1b\\',
	'\x1bP+q544e\x1b\\',
	'\x1bZ',
	'\x05',
];

describe('a replay asks nothing', () => {
	it('drops every query a renderer would answer, and keeps everything that draws', () => {
		const buffer = new ReplayBuffer(1 << 16);
		const drawn = '\x1b[?1049h\x1b[2J\x1b[H\x1b[1;31mred\x1b[0m\x1b[>1u\x1b[>4;1m\x1b[2 q\x1b]0;title\x07\x1b[22;0t\r\n';
		buffer.push(bytes(`${drawn}${QUERIES.join('x')}end\r\n`));
		const replayed = text(buffer.replay());
		for (const query of QUERIES) expect(replayed).not.toContain(query);
		expect(replayed).toBe(`${REPLAY_RESET}${drawn}${'x'.repeat(QUERIES.length - 1)}end\r\n`);
	});

	it('gives a real renderer nothing to answer while it replays', async () => {
		const buffer = new ReplayBuffer(1 << 16);
		buffer.push(bytes(`\x1b[?1049hshell$ ${QUERIES.join('')}\r\n`));
		const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
		const replies: string[] = [];
		term.onData((data) => replies.push(data));
		await new Promise<void>((done) => term.write(buffer.replay(), done));
		expect(replies).toEqual([]);
		// The same renderer still answers a live query.
		await new Promise<void>((done) => term.write('\x1b[c', done));
		expect(replies).toHaveLength(1);
		term.dispose();
	});
});

describe('OSC 7501 from the TUI', () => {
	it('sees the probe and the root reports, skipping records with an id', () => {
		const scanner = new ProgramStatusScanner();
		const scan = scanner.push(
			bytes(
				'paint\x1b]7501;?\x1b\\\x1b]7501;state=idle:app=claude-code\x1b\\x\x1b]7501;state=working:id=t1\x07\x1b]7501;state=blocked:kind=question\x07',
			),
		);
		expect(scan.probe).toBe(true);
		expect(scan.reports).toEqual([
			{ state: 'idle', kind: null },
			{ state: 'blocked', kind: 'question' },
		]);
	});

	it('holds a sequence split across chunks, terminator included', () => {
		const scanner = new ProgramStatusScanner();
		expect(scanner.push(bytes('abc\x1b]75')).reports).toEqual([]);
		expect(scanner.push(bytes('01;state=work')).reports).toEqual([]);
		expect(scanner.push(bytes('ing:app=claude-code\x1b')).reports).toEqual([]);
		expect(scanner.push(bytes('\\done')).reports).toEqual([{ state: 'working', kind: null }]);
		expect(scanner.push(bytes('\x1b]7501;state=done\x07')).reports).toEqual([{ state: 'done', kind: null }]);
	});

	it('answers with the states and kinds it reads, as herdr-core does', () => {
		expect(PROGRAM_STATUS_REPLY).toBe('\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\');
		expect(parseProgramStatus('state=bogus')).toBeNull();
		expect(parseProgramStatus('state=clear:app=claude-code')).toEqual({ state: 'clear', kind: null });
	});
});
