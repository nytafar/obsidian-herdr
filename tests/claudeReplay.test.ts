/**
 * What a reopened `claude` terminal tab is repainted from (ADR-0007's D2):
 * the bounded replay buffer (`src/claude/replay.ts`) and Claude's OSC 7501
 * status reports (`src/claude/programStatus.ts`).
 */

import { describe, expect, it } from 'vitest';
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
