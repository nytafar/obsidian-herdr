import { describe, expect, it, vi } from 'vitest';
import {
	attachFor,
	debounce,
	FALLBACK_ROWS,
	isRecoverable,
	MAX_SCROLL_LINES,
	parseTerminalState,
	spawnEnv,
	stateMatchesPane,
	statusLine,
	summariseStderr,
	TERMINAL_VIEW_TYPE,
	wheelToScroll,
	WHEEL_PIXELS_PER_LINE,
	type DebounceTimers,
} from '../src/views/terminalView';
import { buildArgv } from '../src/bridge/terminalSession';

// Only the DOM-free decisions are unit tested: the view itself needs a canvas,
// the ghostty WASM and a live herdr. See tests/README.md for the smoke recipe.

describe('parseTerminalState', () => {
	it('reads a well-formed state', () => {
		expect(parseTerminalState({ paneId: 'w4:p1', mode: 'observe' })).toEqual({
			paneId: 'w4:p1',
			mode: 'observe',
		});
	});

	it('defaults an unknown or missing mode to control', () => {
		expect(parseTerminalState({ paneId: 'w4:p1' })?.mode).toBe('control');
		expect(parseTerminalState({ paneId: 'w4:p1', mode: 'wat' })?.mode).toBe('control');
		expect(parseTerminalState({ paneId: 'w4:p1', mode: 7 })?.mode).toBe('control');
	});

	it('rejects anything without a usable pane id', () => {
		expect(parseTerminalState(null)).toBeNull();
		expect(parseTerminalState(undefined)).toBeNull();
		expect(parseTerminalState('w4:p1')).toBeNull();
		expect(parseTerminalState({})).toBeNull();
		expect(parseTerminalState({ paneId: '   ' })).toBeNull();
		expect(parseTerminalState({ paneId: 42 })).toBeNull();
	});

	it('trims the pane id so a stray space still matches a leaf', () => {
		expect(parseTerminalState({ paneId: ' w4:p1 ' })?.paneId).toBe('w4:p1');
	});
});

describe('stateMatchesPane', () => {
	it('is the lookup main.ts uses for reuse and for muting notifications', () => {
		expect(stateMatchesPane({ paneId: 'w4:p1', mode: 'control' }, 'w4:p1')).toBe(true);
		expect(stateMatchesPane({ paneId: 'w4:p2' }, 'w4:p1')).toBe(false);
		expect(stateMatchesPane(undefined, 'w4:p1')).toBe(false);
	});

	it('keeps the view type stable — the layout file stores it', () => {
		expect(TERMINAL_VIEW_TYPE).toBe('herdr-terminal');
	});
});

describe('attachFor (PRD M15, S16)', () => {
	it('takes over in control mode and never in observe mode', () => {
		expect(attachFor('control')).toEqual({ mode: 'control', takeover: true });
		expect(attachFor('observe')).toEqual({ mode: 'observe', takeover: false });
	});

	it('produces the argv the bridge spawns', () => {
		const base = { command: ['/opt/homebrew/bin/herdr'], target: 'w4:p1', cols: 100, rows: 30 };
		expect(buildArgv({ ...base, ...attachFor('control') })).toEqual([
			'/opt/homebrew/bin/herdr',
			'terminal',
			'session',
			'control',
			'w4:p1',
			'--takeover',
			'--cols',
			'100',
			'--rows',
			'30',
		]);
		expect(buildArgv({ ...base, ...attachFor('observe') })).toEqual([
			'/opt/homebrew/bin/herdr',
			'terminal',
			'session',
			'observe',
			'w4:p1',
			'--cols',
			'100',
			'--rows',
			'30',
		]);
	});
});

describe('debounce', () => {
	const fakeTimers = (): DebounceTimers & { run: () => void; pending: () => number } => {
		let next = 1;
		const queue = new Map<number, () => void>();
		return {
			setTimeout: (callback) => {
				const handle = next++;
				queue.set(handle, callback);
				return handle;
			},
			clearTimeout: (handle) => {
				queue.delete(handle);
			},
			run: () => {
				for (const [handle, callback] of [...queue]) {
					queue.delete(handle);
					callback();
				}
			},
			pending: () => queue.size,
		};
	};

	it('collapses a burst into one trailing call', () => {
		const timers = fakeTimers();
		const fn = vi.fn();
		const debounced = debounce(fn, 100, timers);
		debounced();
		debounced();
		debounced();
		expect(fn).not.toHaveBeenCalled();
		expect(timers.pending()).toBe(1);
		timers.run();
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('runs again after the previous call fired', () => {
		const timers = fakeTimers();
		const fn = vi.fn();
		const debounced = debounce(fn, 100, timers);
		debounced();
		timers.run();
		debounced();
		timers.run();
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('cancel drops the pending call, and is idempotent', () => {
		const timers = fakeTimers();
		const fn = vi.fn();
		const debounced = debounce(fn, 100, timers);
		debounced();
		debounced.cancel();
		debounced.cancel();
		expect(timers.pending()).toBe(0);
		timers.run();
		expect(fn).not.toHaveBeenCalled();
	});
});

describe('wheelToScroll', () => {
	it('maps direction from the sign of deltaY', () => {
		expect(wheelToScroll(-100, 0, 24)?.direction).toBe('up');
		expect(wheelToScroll(100, 0, 24)?.direction).toBe('down');
	});

	it('converts pixels, lines and pages', () => {
		expect(wheelToScroll(WHEEL_PIXELS_PER_LINE * 3, 0, 24)?.lines).toBe(3);
		expect(wheelToScroll(-4, 1, 24)?.lines).toBe(4);
		expect(wheelToScroll(2, 2, 30)?.lines).toBe(60);
	});

	it('never asks for zero lines, and clamps a fling', () => {
		expect(wheelToScroll(1, 0, 24)?.lines).toBe(1);
		expect(wheelToScroll(100000, 0, 24)?.lines).toBe(MAX_SCROLL_LINES);
	});

	it('ignores a delta of zero or a broken event', () => {
		expect(wheelToScroll(0, 0, 24)).toBeNull();
		expect(wheelToScroll(Number.NaN, 0, 24)).toBeNull();
	});

	it('falls back to a 24-row page when the session has no rows yet', () => {
		expect(wheelToScroll(1, 2, 0)?.lines).toBe(FALLBACK_ROWS);
	});
});

describe('spawnEnv', () => {
	it('leaves the environment alone when there is no extra path', () => {
		expect(spawnEnv({ PATH: '/usr/bin' }, '')).toEqual({ PATH: '/usr/bin' });
		expect(spawnEnv({ PATH: '/usr/bin' }, '   ')).toEqual({ PATH: '/usr/bin' });
	});

	it('prepends the extra directories, in order, without duplicates', () => {
		expect(spawnEnv({ PATH: '/usr/bin:/bin' }, '~/.local/bin: /opt/homebrew/bin :/usr/bin')).toEqual(
			{ PATH: '~/.local/bin:/opt/homebrew/bin:/usr/bin:/bin' },
		);
	});

	it('copies the environment rather than mutating it, and copes with no PATH', () => {
		const env = { HOME: '/Users/lasse' };
		const result = spawnEnv(env, '/opt/homebrew/bin');
		expect(result).toEqual({ HOME: '/Users/lasse', PATH: '/opt/homebrew/bin' });
		expect(env).toEqual({ HOME: '/Users/lasse' });
	});
});

describe('isRecoverable (notes/herdr-terminal-bridge.md reasons)', () => {
	it('offers a reconnect after a takeover or a live update', () => {
		expect(isRecoverable('terminal attach taken over')).toBe(true);
		expect(isRecoverable('live update in progress; reconnect after handoff completes')).toBe(true);
		expect(
			isRecoverable('terminal attach failed: terminal w4:p1 has a read in progress; retry'),
		).toBe(true);
		expect(
			isRecoverable(
				'terminal attach failed: terminal w4:p1 already has an attached client; retry with --takeover',
			),
		).toBe(true);
	});

	it('does not, once the pane is gone', () => {
		expect(isRecoverable('terminal term_7 exited')).toBe(false);
		expect(isRecoverable('terminal session observe failed: terminal target w9:p9 not found')).toBe(
			false,
		);
	});

	it('treats a plain detach or an unknown reason as retryable', () => {
		expect(isRecoverable('detached')).toBe(true);
		expect(isRecoverable(null)).toBe(true);
	});
});

describe('summariseStderr', () => {
	it('is null while stderr stays quiet', () => {
		expect(summariseStderr([])).toBeNull();
	});

	it('shows the newest line and counts the rest', () => {
		expect(summariseStderr(['a'])).toBe('a');
		expect(summariseStderr(['a', 'b', 'c'])).toBe('c (+2 more)');
	});

	it('clips a very long line', () => {
		const summary = summariseStderr(['x'.repeat(500)]);
		expect(summary).toHaveLength(201);
		expect(summary?.endsWith('…')).toBe(true);
	});
});

describe('statusLine', () => {
	it('states the mode while the session is live', () => {
		expect(statusLine({ mode: 'control', closedReason: null, exited: false, stderr: [] })).toEqual({
			text: 'Controlling this pane.',
			warning: false,
			detail: null,
		});
		expect(statusLine({ mode: 'observe', closedReason: null, exited: false, stderr: [] }).text).toBe(
			'Observing (read-only).',
		);
	});

	it('renders the close reason and suggests a reconnect when one can help', () => {
		const takenOver = statusLine({
			mode: 'control',
			closedReason: 'terminal attach taken over',
			exited: true,
			stderr: [],
		});
		expect(takenOver.text).toBe(
			'Session closed: terminal attach taken over. Reconnect to attach again.',
		);
		expect(takenOver.warning).toBe(true);

		const gone = statusLine({
			mode: 'control',
			closedReason: 'terminal term_7 exited',
			exited: true,
			stderr: [],
		});
		expect(gone.text).toBe('Session closed: terminal term_7 exited.');
	});

	it('reports a silent exit, and always carries the stderr summary', () => {
		const line = statusLine({
			mode: 'control',
			closedReason: null,
			exited: true,
			stderr: ['herdr: connection failed'],
		});
		expect(line.text).toBe('Bridge process exited. Reconnect to attach again.');
		expect(line.warning).toBe(true);
		expect(line.detail).toBe('herdr: connection failed');
	});
});
