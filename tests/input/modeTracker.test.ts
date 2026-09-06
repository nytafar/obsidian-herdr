import { describe, expect, it } from 'vitest';

import {
	DEFAULT_MODE_STATE,
	KITTY_DISAMBIGUATE,
	KITTY_REPORT_ALL_KEYS,
	KITTY_REPORT_EVENT_TYPES,
	MAX_KITTY_STACK,
	TerminalModeTracker,
	mouseReportingEnabled,
} from '../../src/views/input/modeTracker';

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
	return encoder.encode(text);
}

function tracker(...chunks: string[]): TerminalModeTracker {
	const instance = new TerminalModeTracker();
	for (const chunk of chunks) instance.feed(bytes(chunk));
	return instance;
}

describe('TerminalModeTracker defaults', () => {
	it('starts in the default modes', () => {
		expect(new TerminalModeTracker().state).toEqual(DEFAULT_MODE_STATE);
	});

	it('ignores a frame with no escape sequences', () => {
		expect(tracker('plain output with ? 1000 h in it').state).toEqual(DEFAULT_MODE_STATE);
	});

	it('ignores the modes a herdr frame actually carries', () => {
		// The real first frame of a live pane: synchronised output, cursor
		// visibility, erase-display, then positioned cells.
		const frame = '\x1b[?2026h\x1b[?25l\x1b[2J\x1b[1;1H\x1b[0;38;2;255;255;255;49mx\x1b[?2026l';
		expect(tracker(frame).state).toEqual(DEFAULT_MODE_STATE);
	});
});

describe('mouse modes', () => {
	it('tracks 1000, 1002 and 1003 as increasing levels', () => {
		expect(tracker('\x1b[?1000h').state.mouseTracking).toBe('normal');
		expect(tracker('\x1b[?1002h').state.mouseTracking).toBe('button');
		expect(tracker('\x1b[?1003h').state.mouseTracking).toBe('any');
	});

	it('keeps the most permissive mode still enabled', () => {
		const t = tracker('\x1b[?1000h\x1b[?1002h');
		expect(t.state.mouseTracking).toBe('button');
		t.feed(bytes('\x1b[?1002l'));
		expect(t.state.mouseTracking).toBe('normal');
		t.feed(bytes('\x1b[?1000l'));
		expect(t.state.mouseTracking).toBe('off');
	});

	it('reads a multi-parameter set', () => {
		const t = tracker('\x1b[?1000;1006;2004h');
		expect(t.state.mouseTracking).toBe('normal');
		expect(t.state.mouseEncoding).toBe('sgr');
		expect(t.state.bracketedPaste).toBe(true);
	});

	it('reports mouse reporting only when a tracking mode is on', () => {
		expect(mouseReportingEnabled(tracker('\x1b[?1006h').state)).toBe(false);
		expect(mouseReportingEnabled(tracker('\x1b[?1002h').state)).toBe(true);
	});

	it('tracks SGR encoding on and off', () => {
		const t = tracker('\x1b[?1006h');
		expect(t.state.mouseEncoding).toBe('sgr');
		t.feed(bytes('\x1b[?1006l'));
		expect(t.state.mouseEncoding).toBe('legacy');
	});
});

describe('other DEC private modes', () => {
	it('tracks bracketed paste', () => {
		const t = tracker('\x1b[?2004h');
		expect(t.state.bracketedPaste).toBe(true);
		t.feed(bytes('\x1b[?2004l'));
		expect(t.state.bracketedPaste).toBe(false);
	});

	it('tracks application cursor keys without confusing 1 and 1000', () => {
		expect(tracker('\x1b[?1h').state.applicationCursorKeys).toBe(true);
		expect(tracker('\x1b[?1000h').state.applicationCursorKeys).toBe(false);
		expect(tracker('\x1b[?1h\x1b[?1l').state.applicationCursorKeys).toBe(false);
	});

	it('leaves modes it does not track alone', () => {
		expect(tracker('\x1b[?1049h\x1b[?12h\x1b[?25l').state).toEqual(DEFAULT_MODE_STATE);
	});

	it('ignores a non-private mode with the same number', () => {
		expect(tracker('\x1b[4h\x1b[1h').state).toEqual(DEFAULT_MODE_STATE);
	});
});

describe('kitty keyboard protocol', () => {
	it('pushes and pops flags', () => {
		const t = tracker('\x1b[>1u');
		expect(t.state.kittyFlags).toBe(KITTY_DISAMBIGUATE);
		t.feed(bytes('\x1b[>3u'));
		expect(t.state.kittyFlags).toBe(3);
		t.feed(bytes('\x1b[<u'));
		expect(t.state.kittyFlags).toBe(KITTY_DISAMBIGUATE);
		t.feed(bytes('\x1b[<u'));
		expect(t.state.kittyFlags).toBe(0);
	});

	it('pops several entries at once and never below empty', () => {
		const t = tracker('\x1b[>1u\x1b[>2u\x1b[>4u');
		t.feed(bytes('\x1b[<9u'));
		expect(t.state.kittyFlags).toBe(0);
	});

	it('sets, ors and clears flags with CSI = flags ; mode u', () => {
		const t = tracker('\x1b[>1u');
		t.feed(bytes(`\x1b[=${KITTY_REPORT_EVENT_TYPES};2u`));
		expect(t.state.kittyFlags).toBe(KITTY_DISAMBIGUATE | KITTY_REPORT_EVENT_TYPES);
		t.feed(bytes(`\x1b[=${KITTY_REPORT_EVENT_TYPES};3u`));
		expect(t.state.kittyFlags).toBe(KITTY_DISAMBIGUATE);
		t.feed(bytes(`\x1b[=${KITTY_REPORT_ALL_KEYS};1u`));
		expect(t.state.kittyFlags).toBe(KITTY_REPORT_ALL_KEYS);
	});

	it('bounds the stack', () => {
		const t = new TerminalModeTracker();
		for (let i = 0; i < MAX_KITTY_STACK + 4; i++) t.feed(bytes('\x1b[>1u'));
		for (let i = 0; i < MAX_KITTY_STACK; i++) t.feed(bytes('\x1b[<u'));
		expect(t.state.kittyFlags).toBe(0);
	});

	it('ignores the query form', () => {
		expect(tracker('\x1b[?u').state.kittyFlags).toBe(0);
	});
});

describe('split sequences', () => {
	it('carries a sequence split anywhere across frames', () => {
		const whole = '\x1b[?1002h';
		for (let cut = 1; cut < whole.length; cut++) {
			const t = tracker(whole.slice(0, cut), whole.slice(cut));
			expect(t.state.mouseTracking, `cut at ${cut}`).toBe('button');
		}
	});

	it('carries a sequence split across three frames', () => {
		const t = tracker('\x1b', '[?10', '06h');
		expect(t.state.mouseEncoding).toBe('sgr');
	});

	it('drops a carry that cannot be a sequence we track', () => {
		const long = `\x1b[${'1'.repeat(200)}`;
		const t = tracker(long, 'h\x1b[?1006h');
		expect(t.state.mouseEncoding).toBe('sgr');
	});

	it('keeps scanning after a stray escape', () => {
		expect(tracker('\x1b\x1b[?2004h').state.bracketedPaste).toBe(true);
		expect(tracker('\x1bM\x1b[?2004h').state.bracketedPaste).toBe(true);
		expect(tracker('\x1b]8;;https://example.com\x1b\\\x1b[?2004h').state.bracketedPaste).toBe(
			true,
		);
	});
});

describe('reset', () => {
	it('returns to the defaults and clears any carry', () => {
		const t = tracker('\x1b[?1003h\x1b[?1006h\x1b[>5u', '\x1b[?100');
		t.reset();
		expect(t.state).toEqual(DEFAULT_MODE_STATE);
		t.feed(bytes('2h'));
		expect(t.state).toEqual(DEFAULT_MODE_STATE);
	});

	it('is not implied by a repaint', () => {
		const t = tracker('\x1b[?1006h');
		t.feed(bytes('\x1b[2J\x1b[1;1Hredrawn'));
		expect(t.state.mouseEncoding).toBe('sgr');
	});
});
