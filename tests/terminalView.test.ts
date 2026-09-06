import { describe, expect, it, vi } from 'vitest';
import {
	attachFor,
	debounce,
	FrameBuffer,
	PerfCounter,
	isRecoverable,
	parseTerminalState,
	planThemeUpdate,
	spawnEnv,
	stateMatchesPane,
	statusLine,
	terminalTabTitle,
	HIDE_GRACE_MS,
	hostKeyPolicyApplies,
	keymapReturn,
	VisibilityTracker,
	summariseStderr,
	TERMINAL_VIEW_TYPE,
	type DebounceTimers,
} from '../src/views/terminalView';
import { buildArgv } from '../src/bridge/terminalSession';
import type { PaneState } from '../src/herdr/scope';

// Only the DOM-free decisions are unit tested: the view itself needs a canvas,
// the ghostty WASM and a live herdr. See tests/README.md for the smoke recipe.

describe('parseTerminalState', () => {
	it('reads a well-formed state', () => {
		expect(
			parseTerminalState({ paneId: 'w4:p1', mode: 'observe', endpointId: 'ssh:xl:/s.sock' }),
		).toEqual({
			paneId: 'w4:p1',
			mode: 'observe',
			endpointId: 'ssh:xl:/s.sock',
		});
	});

	it('treats a state saved before endpoints existed as local (issue #54)', () => {
		expect(parseTerminalState({ paneId: 'w4:p1', mode: 'control' })?.endpointId).toBe('local');
		expect(parseTerminalState({ paneId: 'w4:p1', endpointId: '  ' })?.endpointId).toBe('local');
		expect(parseTerminalState({ paneId: 'w4:p1', endpointId: 7 })?.endpointId).toBe('local');
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

/** A pane as the scope holds it; only the name fields matter here. */
function pane(overrides: Partial<PaneState> = {}): PaneState {
	return {
		paneId: 'w4:p1G',
		workspaceId: 'w4',
		tabId: 't1',
		agent: 'claude',
		name: '',
		agentStatus: 'idle',
		title: '',
		label: '',
		cwd: '/Users/lasse/Vaults/hvelv',
		focused: false,
		tokens: {},
		statusChangedSeq: 0,
		...overrides,
	};
}

describe('terminalTabTitle (issue #36)', () => {
	it('prefers the agent name over anything herdr labels the pane', () => {
		const state = pane({
			name: 'vault-maintenance',
			title: 'claude — hvelv',
			label: '● claude',
		});
		expect(terminalTabTitle(state, state.paneId)).toBe('vault-maintenance');
	});

	it('falls back to the stripped title, never to the kind', () => {
		const state = pane({ title: 'npm run dev', label: '● claude' });
		expect(terminalTabTitle(state, state.paneId)).toBe('npm run dev');
	});

	it('falls back to the pane id when the pane has neither', () => {
		const state = pane();
		expect(terminalTabTitle(state, state.paneId)).toBe('w4:p1G');
	});

	it('shows the pane id while the scope does not know the pane yet', () => {
		// The case from the report: a pane started from the file pane is opened
		// before `agent.list` has answered for it.
		expect(terminalTabTitle(undefined, 'w4:p1G')).toBe('w4:p1G');
	});

	it('says nothing at all when there is no pane either (issue #37)', () => {
		// No fixed "Herdr terminal": the tab and the view header read the same
		// string, and a constant there disagreed with an empty tab title.
		expect(terminalTabTitle(undefined, '')).toBe('');
	});
});

describe('stateMatchesPane', () => {
	it('is the lookup main.ts uses for reuse and for muting notifications', () => {
		expect(stateMatchesPane({ paneId: 'w4:p1', mode: 'control' }, 'w4:p1', 'local')).toBe(true);
		expect(stateMatchesPane({ paneId: 'w4:p2' }, 'w4:p1', 'local')).toBe(false);
		expect(stateMatchesPane(undefined, 'w4:p1', 'local')).toBe(false);
	});

	it('never aliases the same pane id across endpoints (issue #54)', () => {
		const remote = { paneId: 'w4:p1', mode: 'control', endpointId: 'ssh:lasse@xl:/s.sock' };
		expect(stateMatchesPane(remote, 'w4:p1', 'ssh:lasse@xl:/s.sock')).toBe(true);
		expect(stateMatchesPane(remote, 'w4:p1', 'local')).toBe(false);
		// A pre-endpoint state is a local terminal, so a remote lookup misses it.
		expect(stateMatchesPane({ paneId: 'w4:p1' }, 'w4:p1', 'ssh:lasse@xl:/s.sock')).toBe(false);
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
		const live = { closedReason: null, exited: false, stderr: [] };
		expect(statusLine({ mode: 'control', endpoint: 'local', ...live })).toEqual({
			text: 'Controlling this pane on local.',
			warning: false,
			detail: null,
		});
		// The endpoint is in the line (issue #54): a terminal pinned to the other
		// herdr keeps saying so after the list switches.
		expect(statusLine({ mode: 'observe', endpoint: 'ssh lasse@xl', ...live }).text).toBe(
			'Observing (read-only) on ssh lasse@xl.',
		);
	});

	it('renders the close reason and suggests a reconnect when one can help', () => {
		const takenOver = statusLine({
			mode: 'control',
			endpoint: 'local',
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
			endpoint: 'local',
			closedReason: 'terminal term_7 exited',
			exited: true,
			stderr: [],
		});
		expect(gone.text).toBe('Session closed: terminal term_7 exited.');
	});

	it('reports a silent exit, and always carries the stderr summary', () => {
		const line = statusLine({
			mode: 'control',
			endpoint: 'local',
			closedReason: null,
			exited: true,
			stderr: ['herdr: connection failed'],
		});
		expect(line.text).toBe('Bridge process exited. Reconnect to attach again.');
		expect(line.warning).toBe(true);
		expect(line.detail).toBe('herdr: connection failed');
	});
});

describe('FrameBuffer (#24)', () => {
	const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

	it('concatenates in arrival order and empties itself', () => {
		const buffer = new FrameBuffer();
		buffer.push(bytes(1, 2));
		buffer.push(bytes(3));
		buffer.push(bytes(4, 5));
		expect(buffer.pending).toBe(5);
		expect(Array.from(buffer.take() ?? [])).toEqual([1, 2, 3, 4, 5]);
		expect(buffer.pending).toBe(0);
		expect(buffer.take()).toBeNull();
	});

	it('returns a single chunk untouched', () => {
		const buffer = new FrameBuffer();
		const only = bytes(7, 8);
		buffer.push(only);
		expect(buffer.take()).toBe(only);
	});

	it('drops everything buffered before a full frame, and keeps what follows', () => {
		const buffer = new FrameBuffer();
		buffer.push(bytes(1, 2));
		buffer.push(bytes(9, 9), true);
		buffer.push(bytes(3));
		expect(Array.from(buffer.take() ?? [])).toEqual([9, 9, 3]);
	});

	it('lets an empty full frame supersede the buffer', () => {
		const buffer = new FrameBuffer();
		buffer.push(bytes(1));
		buffer.push(bytes(), true);
		expect(buffer.take()).toBeNull();
	});

	it('ignores empty non-full frames', () => {
		const buffer = new FrameBuffer();
		buffer.push(bytes(1));
		buffer.push(bytes());
		expect(Array.from(buffer.take() ?? [])).toEqual([1]);
	});
});

describe('PerfCounter (#24)', () => {
	it('reports rates once a second and then resets', () => {
		const lines: string[] = [];
		let now = 0;
		const counter = new PerfCounter('w1:p1 observe', (line) => lines.push(line), () => now);
		counter.frame(100);
		counter.frame(100);
		counter.repaint();
		expect(lines).toEqual([]);
		now = 2000;
		counter.repaint();
		expect(lines).toEqual([
			'herdr perf w1:p1 observe: 1.0 frames/s, 100.0 bytes/s, 1.0 repaints/s',
		]);
		now = 3000;
		counter.frame(10);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toBe('herdr perf w1:p1 observe: 1.0 frames/s, 10.0 bytes/s, 0.0 repaints/s');
	});
});

describe('VisibilityTracker (#15 item 1)', () => {
	/** A fake timer table: `run()` fires whatever is still scheduled. */
	function timers(): DebounceTimers & { run(): void; scheduled(): number } {
		const pending = new Map<number, () => void>();
		let next = 1;
		return {
			setTimeout: (cb) => {
				const handle = next++;
				pending.set(handle, cb);
				return handle;
			},
			clearTimeout: (handle) => {
				pending.delete(handle);
			},
			run: () => {
				for (const [handle, cb] of [...pending]) {
					pending.delete(handle);
					cb();
				}
			},
			scheduled: () => pending.size,
		};
	}

	function tracker(): {
		t: VisibilityTracker;
		clock: ReturnType<typeof timers>;
		expiries: number;
	} {
		const clock = timers();
		const state = { expiries: 0 };
		const t = new VisibilityTracker(HIDE_GRACE_MS, () => state.expiries++, clock);
		return {
			t,
			clock,
			get expiries() {
				return state.expiries;
			},
		};
	}

	it('starts shown and arms the grace period on the first hidden measurement', () => {
		const h = tracker();
		expect(h.t.hidden).toBe(false);
		expect(h.t.update(true)).toBeNull();
		expect(h.clock.scheduled()).toBe(0);

		expect(h.t.update(false)).toBe('hidden');
		expect(h.t.hidden).toBe(true);
		expect(h.t.pending).toBe(true);
	});

	it('disposes only after the grace period, and only once', () => {
		const h = tracker();
		h.t.update(false);
		expect(h.expiries).toBe(0);
		h.clock.run();
		expect(h.expiries).toBe(1);
		expect(h.t.pending).toBe(false);
		h.clock.run();
		expect(h.expiries).toBe(1);
	});

	it('does not push the deadline out while it stays hidden', () => {
		const h = tracker();
		h.t.update(false);
		expect(h.t.update(false)).toBeNull();
		expect(h.t.update(false)).toBeNull();
		expect(h.clock.scheduled()).toBe(1);
		h.clock.run();
		expect(h.expiries).toBe(1);
	});

	it('a reveal inside the grace period cancels it and reports the transition once', () => {
		const h = tracker();
		h.t.update(false);
		expect(h.t.update(true)).toBe('revealed');
		expect(h.t.hidden).toBe(false);
		expect(h.clock.scheduled()).toBe(0);
		// A second shown measurement is not a transition: no remount.
		expect(h.t.update(true)).toBeNull();
		h.clock.run();
		expect(h.expiries).toBe(0);
	});

	it('re-arms after a reconnect that happens while still hidden', () => {
		const h = tracker();
		h.t.update(false);
		h.clock.run();
		expect(h.expiries).toBe(1);
		// What the view does at the end of `start()`.
		h.t.arm();
		expect(h.t.pending).toBe(true);
		h.clock.run();
		expect(h.expiries).toBe(2);
	});

	it('never arms while the host is shown, however often arm() is called', () => {
		const h = tracker();
		h.t.arm();
		h.t.arm();
		expect(h.clock.scheduled()).toBe(0);
		h.t.update(false);
		h.t.arm();
		h.t.arm();
		expect(h.clock.scheduled()).toBe(1);
	});

	it('cancel is idempotent and stops a pending disposal (onClose)', () => {
		const h = tracker();
		h.t.update(false);
		h.t.cancel();
		h.t.cancel();
		expect(h.t.pending).toBe(false);
		h.clock.run();
		expect(h.expiries).toBe(0);
	});

	it('grace period is long enough to survive tab flipping', () => {
		expect(HIDE_GRACE_MS).toBeGreaterThanOrEqual(10_000);
	});
});

describe('planThemeUpdate (issue #53)', () => {
	const live = { opened: true, suspended: false, hasRenderer: true, inPlace: true };

	it('lets xterm.js repaint in place', () => {
		expect(planThemeUpdate(live)).toBe('in-place');
	});

	it('rebuilds the renderer for an engine whose theme option is inert', () => {
		expect(planThemeUpdate({ ...live, inPlace: false })).toBe('rebuild-renderer');
	});

	it('defers for a suspended view, which reads the setting when it mounts', () => {
		expect(planThemeUpdate({ ...live, suspended: true })).toBe('defer');
		expect(planThemeUpdate({ ...live, suspended: true, inPlace: false })).toBe('defer');
	});

	it('defers for a closed view and for one with no renderer mounted', () => {
		expect(planThemeUpdate({ ...live, opened: false })).toBe('defer');
		expect(planThemeUpdate({ ...live, hasRenderer: false })).toBe('defer');
	});

	it('is decided by the renderer, not by the session: a closed tab still repaints', () => {
		// Nothing in the input names the session, which is the point: a palette
		// change must never reattach or take a pane over.
		expect(planThemeUpdate({ ...live, inPlace: false })).toBe('rebuild-renderer');
		expect(Object.keys(live).sort()).toEqual([
			'hasRenderer',
			'inPlace',
			'opened',
			'suspended',
		]);
	});
});

describe('keymapReturn (#47)', () => {
	it('maps the three decisions onto the Scope handler protocol', () => {
		// undefined: fall through to the app scope, so the hotkey fires.
		expect(keymapReturn('host')).toBeUndefined();
		// true: stop looking, touch nothing, the event still reaches the terminal.
		expect(keymapReturn('terminal')).toBe(true);
		// false: Obsidian prevents and stops it at the window.
		expect(keymapReturn('drop')).toBe(false);
	});
});

describe('hostKeyPolicyApplies (#47)', () => {
	it('applies to a focused control-mode terminal only', () => {
		expect(hostKeyPolicyApplies({ mode: 'control', focusInside: true })).toBe(true);
	});

	it('leaves every key to Obsidian for an observer, whatever has focus', () => {
		expect(hostKeyPolicyApplies({ mode: 'observe', focusInside: true })).toBe(false);
	});

	it('leaves every key to Obsidian when the leaf is active but the terminal is not focused', () => {
		expect(hostKeyPolicyApplies({ mode: 'control', focusInside: false })).toBe(false);
	});

	it('does nothing without a session', () => {
		expect(hostKeyPolicyApplies({ mode: null, focusInside: true })).toBe(false);
	});
});
