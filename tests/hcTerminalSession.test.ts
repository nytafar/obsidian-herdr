/**
 * A herdr-core terminal tab's session (ADR-0005) against a fake `hc connect`:
 * first paint, input and replies, observe vs control, size ownership, credit,
 * the ways a stream ends and comes back, and the shared `herdr.seen` label.
 */
import { describe, expect, it } from 'vitest';
import { decodeCredit, decodeResize, FrameKind } from '../src/hc/frames';
import { SeenTracker } from '../src/hc/seen';
import {
	ATTACH_HISTORY_LINES,
	describeEnd,
	HcTerminalSession,
	RETRY_INITIAL_MS,
	type HcSessionTimers,
} from '../src/hc/terminalSession';
import type { FrameMeta } from '../src/bridge/terminalSession';
import { FakeCore, fakeSpawner, HELLO_RESULT, RpcError, settle } from './fixtures/fakeHc';

const CAN = '\x18';
const PAINT = `${CAN}\x1b[!p\x1b[H\x1b[2Jhello$ `;

function manualTimers() {
	const pending = new Map<number, { callback: () => void; ms: number }>();
	let next = 1;
	const timers: HcSessionTimers = {
		setTimeout: (callback, ms) => {
			const id = next++;
			pending.set(id, { callback, ms });
			return id;
		},
		clearTimeout: (handle) => {
			pending.delete(handle as number);
		},
	};
	const fire = (ms: number): number => {
		let fired = 0;
		for (const [id, entry] of [...pending]) {
			if (entry.ms !== ms) continue;
			pending.delete(id);
			entry.callback();
			fired++;
		}
		return fired;
	};
	return { timers, fire, pending };
}

interface CoreOptions {
	features?: string[];
	automaticInput?: boolean;
	/** The terminal record the attach reply and the snapshot carry. */
	record?: Record<string, unknown>;
	/** Frames to put before the paint on the attach channel (e.g. RESIZE). */
	beforePaint?: (core: FakeCore, channel: number) => Buffer[];
	attachError?: RpcError;
	/** Whether the reply confirms resize notifications an observer asked for. */
	resizeNotifications?: boolean;
}

const RECORD = {
	address: 't7',
	name: 'oh-test-x',
	state: 'live',
	cols: 80,
	rows: 24,
	status: { state: 'idle', app: 'claude-code' },
	turn: 2,
	labels: { 'herdr.seen': '1' },
};

/** A fake core that answers attach (reply, then the paint), subscribe and label. */
function setupCore(options: CoreOptions = {}) {
	return (core: FakeCore): void => {
		let channel = 0;
		core.handlers.set('hello', () => ({ ...HELLO_RESULT, features: options.features ?? HELLO_RESULT.features }));
		core.handlers.set('terminal.attach', (params, c, id) => {
			if (options.attachError) throw options.attachError;
			channel++;
			const reply = c.rpcFrame({
				jsonrpc: '2.0',
				id,
				result: {
					channel,
					automatic_input: options.automaticInput ?? true,
					resize_notifications:
						(options.resizeNotifications ?? true) && params.observe === true && params.resize_notifications === true,
					terminal: options.record ?? RECORD,
				},
			});
			const before = options.beforePaint?.(c, channel) ?? [];
			return Buffer.concat([reply, ...before, c.frame(channel, FrameKind.Data, PAINT)]);
		});
		core.handlers.set('events.subscribe', () => {
			channel++;
			return { seq: 10, channel, terminals: [options.record ?? RECORD] };
		});
		core.handlers.set('terminal.label', () => ({}));
		// The real child exits once its stdin closes.
		const end = core.process.end.bind(core.process);
		core.process.end = () => {
			end();
			core.exit(0);
		};
	};
}

function harness(
	mode: 'control' | 'observe' = 'control',
	options: CoreOptions = {},
	argv: readonly string[] | (() => Promise<readonly string[]>) = ['hc', 'connect'],
) {
	const { spawn, cores } = fakeSpawner(setupCore(options));
	const { timers, fire, pending } = manualTimers();
	const session = new HcTerminalSession({ argv, target: 'oh-test-x', mode, cols: 80, rows: 24, spawn, timers });
	const events: string[] = [];
	const frames: { text: string; meta: FrameMeta }[] = [];
	session.on('frame', (bytes, meta) => {
		frames.push({ text: Buffer.from(bytes).toString('latin1'), meta });
		events.push(`frame ${meta.seq}${meta.full ? ' full' : ''}`);
	});
	session.on('closed', (reason) => events.push(`closed ${reason}`));
	session.on('grid', (cols, rows) => events.push(`grid ${cols}x${rows}`));
	session.on('reopened', () => events.push('reopened'));
	session.on('exit', () => events.push('exit'));
	session.on('stderr', (line) => events.push(`stderr ${line}`));
	const core = (index = -1): FakeCore => {
		const found = cores.at(index);
		if (!found) throw new Error('no core');
		return found;
	};
	const calls = (method: string, index = -1) => core(index).calls.filter((call) => call.method === method);
	const event = (type: string, data: unknown, seq: number, index = -1) => {
		const c = core(index);
		// The subscription's channel is the last one the core handed out.
		const subscribe = c.calls.filter((call) => call.method === 'events.subscribe').length;
		const channel = c.calls.filter((call) => call.method === 'terminal.attach').length + subscribe;
		c.write(c.eventFrames(channel, [{ method: 'event', params: { seq, type, terminal: 't7', data } }]));
	};
	return { session, events, frames, cores, core, calls, event, fire, pending };
}

describe('the herdr-core terminal session', () => {
	it('attaches once with the grid and history, and paints first', async () => {
		const h = harness();
		h.session.start();
		await settle();
		const attach = h.calls('terminal.attach');
		expect(attach).toHaveLength(1);
		expect(attach[0]?.params).toEqual({ terminal: 'oh-test-x', cols: 80, rows: 24, history: ATTACH_HISTORY_LINES });
		expect(h.frames[0]?.text).toBe(`\x1b[3J${PAINT}`);
		expect(h.frames[0]?.meta).toMatchObject({ seq: 1, full: true });
		// One per-terminal subscription, by address, on the same connection.
		expect(h.calls('events.subscribe')[0]?.params).toEqual({ terminal: 't7' });
		expect(h.cores).toHaveLength(1);
		expect(h.events).not.toContain('exit');
	});

	it('finds a local binary on start when the kind had none', async () => {
		const h = harness('control', {}, () => Promise.resolve(['/found/hc', 'connect']));
		h.session.start();
		await settle();
		expect(h.core().argv).toEqual(['/found/hc', 'connect']);
	});

	it('types as DATA and answers as AUTOMATIC_INPUT when both ends advertise it', async () => {
		const h = harness();
		h.session.start();
		await settle();
		expect(h.session.input('ls\r')).toBe(true);
		expect(h.session.reply('\x1b[?1;2c')).toBe(true);
		const sent = h.core().sent(1);
		expect(sent.map((frame) => [frame.kind, frame.payload.toString()])).toEqual([
			[FrameKind.Data, 'ls\r'],
			[FrameKind.AutomaticInput, '\x1b[?1;2c'],
		]);
	});

	it('answers as DATA to a core without automatic_input (0.1.17)', async () => {
		const h = harness('control', { features: ['framed', 'attach', 'events', 'resize_notifications'], automaticInput: false });
		h.session.start();
		await settle();
		h.session.reply('\x1b[0n');
		expect(h.core().sent(1).map((frame) => frame.kind)).toEqual([FrameKind.Data]);
	});

	it('takes the size as a controller: RESIZE, and FACTS once per cell size', async () => {
		const h = harness();
		h.session.start();
		await settle();
		expect(h.session.resize(100, 30, 8.4, 17)).toBe(true);
		expect(h.session.resize(101, 30, 8.4, 17)).toBe(true);
		const sent = h.core().sent(1);
		expect(sent.filter((f) => f.kind === FrameKind.Resize).map((f) => decodeResize(f.payload))).toEqual([
			{ cols: 100, rows: 30 },
			{ cols: 101, rows: 30 },
		]);
		expect(sent.filter((f) => f.kind === FrameKind.Facts).map((f) => JSON.parse(f.payload.toString()) as unknown)).toEqual([
			{ cell: [8, 17] },
		]);
		expect(h.session.size).toEqual({ cols: 101, rows: 30 });
	});

	it('sends the cell size it already knows with the attach', async () => {
		const h = harness();
		h.session.resize(90, 20, 9, 18);
		h.session.start();
		await settle();
		expect(h.calls('terminal.attach')[0]?.params).toMatchObject({ cols: 90, rows: 20, display: { cell: [9, 18] } });
	});

	it('observes without typing or resizing, and follows the grid it is notified of', async () => {
		const h = harness('observe', {
			beforePaint: (core, channel) => [core.frame(channel, FrameKind.Resize, Buffer.from([100, 0, 30, 0]))],
		});
		h.session.start();
		await settle();
		expect(h.calls('terminal.attach')[0]?.params).toMatchObject({ observe: true, resize_notifications: true });
		// The grid lands before the paint, so the paint is drawn at it.
		expect(h.events.slice(0, 2)).toEqual(['grid 100x30', 'frame 1 full']);
		expect(h.session.input('echo no\r')).toBe(false);
		expect(h.session.reply('\x1b[0n')).toBe(false);
		expect(h.session.resize(50, 10)).toBe(false);
		expect(h.core().sent(1)).toEqual([]);
		// `size` events are left to the notifications.
		h.event('size', { cols: 120, rows: 40 }, 11);
		expect(h.events.filter((e) => e.startsWith('grid'))).toEqual(['grid 100x30']);
		h.core().write(h.core().frame(1, FrameKind.Resize, Buffer.from([120, 0, 40, 0])));
		expect(h.events.at(-1)).toBe('grid 120x40');
	});

	it('an observer a core cannot notify follows the record and size events', async () => {
		const h = harness('observe', { record: { ...RECORD, cols: 191, rows: 42 }, resizeNotifications: false });
		h.session.start();
		await settle();
		expect(h.events).toContain('grid 191x42');
		h.event('size', { cols: 100, rows: 30 }, 11);
		expect(h.events.at(-1)).toBe('grid 100x30');
	});

	it('tells a controller when another viewer has the size, and when it has it back', async () => {
		const h = harness();
		h.session.start();
		await settle();
		// The echo of its own attach size is not news.
		h.event('size', { cols: 80, rows: 24 }, 11);
		expect(h.events.filter((e) => e.startsWith('grid'))).toEqual([]);
		h.event('size', { cols: 200, rows: 50 }, 12);
		h.event('size', { cols: 200, rows: 50 }, 13);
		expect(h.events.filter((e) => e.startsWith('grid'))).toEqual(['grid 200x50']);
		h.session.resize(81, 24);
		h.event('size', { cols: 81, rows: 24 }, 14);
		expect(h.events.filter((e) => e.startsWith('grid'))).toEqual(['grid 200x50', 'grid 81x24']);
	});

	it('returns credit as bytes are consumed, never more than it was sent', async () => {
		const h = harness();
		h.session.start();
		await settle();
		const painted = h.frames[0]?.text.length ?? 0;
		h.session.consumed(10);
		h.session.consumed(painted + 1000);
		h.session.consumed(5);
		const credits = h.core().sent(1, FrameKind.Credit).map((f) => decodeCredit(f.payload));
		expect(credits).toEqual([10, painted - 10]);
	});

	it('shows the end reason and ends for good when the program exits', async () => {
		const h = harness();
		h.session.start();
		await settle();
		h.core().write(h.core().frame(1, FrameKind.Close, JSON.stringify({ reason: 'exited', exit_code: 3, signal: null })));
		expect(h.events.at(-1)).toBe('closed the program exited with code 3');
		expect(h.session.input('x')).toBe(false);
		h.event('finished', { reason: 'exited', exit_code: 3, signal: null, finished_ms: 1 }, 11);
		expect(h.events.slice(-2)).toEqual(['closed the program exited with code 3', 'exit']);
		expect(h.core().stdinEnded).toBe(true);
	});

	it('attaches again by itself when a kept terminal is restarted', async () => {
		const h = harness();
		h.session.start();
		await settle();
		h.core().write(h.core().frame(1, FrameKind.Close, JSON.stringify({ reason: 'holder_lost', exit_code: null, signal: null })));
		expect(h.events.at(-1)).toBe('closed the program was lost (holder_lost); waiting for herdr-core to restart it');
		h.event('restarted', { ...RECORD, turn: 0 }, 11);
		await settle();
		const attaches = h.calls('terminal.attach');
		expect(attaches).toHaveLength(2);
		expect(attaches[1]?.params).toMatchObject({ terminal: 't7', resumed: true });
		expect(h.events.slice(-2)).toEqual(['frame 1 full', 'reopened']);
		expect(h.session.input('a')).toBe(true);
	});

	it('dials again with backoff when hc connect dies, and attaches resumed', async () => {
		const h = harness();
		h.session.start();
		await settle();
		h.core().stderrText('broken pipe\n');
		h.core().exit(1);
		expect(h.events.at(-1)).toMatch(/^closed herdr-core connection lost: hc connect exited: broken pipe; trying again$/);
		expect(h.fire(RETRY_INITIAL_MS)).toBe(1);
		await settle();
		expect(h.cores).toHaveLength(2);
		expect(h.calls('terminal.attach')[0]?.params).toMatchObject({ resumed: true });
		expect(h.events.at(-1)).toBe('reopened');
		// It attached again, so the backoff starts over.
		h.core().exit(1);
		expect(h.fire(RETRY_INITIAL_MS)).toBe(1);
	});

	it('gives up at once on a terminal that does not exist', async () => {
		const h = harness('control', { attachError: new RpcError('not_found', 'no terminal oh-test-x') });
		h.session.start();
		await settle();
		expect(h.events).toEqual(['closed terminal oh-test-x not found', 'exit']);
		expect(h.pending.size).toBe(0);
	});

	it('says why when hc cannot be started, without retrying', async () => {
		const h = harness('control', {}, () => Promise.reject(new Error('hc was not found in …')));
		h.session.start();
		await settle();
		expect(h.events).toEqual(['closed hc was not found in …', 'exit']);
		expect(h.cores).toHaveLength(0);
	});

	it('repaints on a fresh attach before letting the old stream go', async () => {
		const h = harness();
		h.session.start();
		await settle();
		h.session.repaint();
		// Bytes on the old stream while the new attach is in flight are dropped.
		h.core().write(h.core().frame(1, FrameKind.Data, 'stale'));
		await settle();
		expect(h.calls('terminal.attach')[1]?.params).toMatchObject({ resumed: true });
		expect(h.frames.map((f) => f.text)).toEqual([`\x1b[3J${PAINT}`, `\x1b[3J${PAINT}`]);
		expect(h.core().sent(1, FrameKind.Close)).toHaveLength(1);
		h.session.input('z');
		// The new stream is channel 3 (2 is the subscription).
		expect(h.core().sent(3, FrameKind.Data).map((f) => f.payload.toString())).toEqual(['z']);
	});

	it('detaches and closes the child on dispose', async () => {
		const h = harness();
		h.session.start();
		await settle();
		await h.session.dispose();
		expect(h.core().sent(1, FrameKind.Close)).toHaveLength(1);
		expect(h.core().stdinEnded).toBe(true);
		expect(h.events).not.toContain('exit');
	});

	describe('herdr.seen', () => {
		it('writes the turn once while looking, only to raise it', async () => {
			const h = harness('observe');
			h.session.start();
			await settle();
			expect(h.calls('terminal.label')).toEqual([]);
			h.session.setLooking(true);
			await settle();
			expect(h.calls('terminal.label').map((c) => c.params)).toEqual([
				{ terminal: 't7', labels: { 'herdr.seen': '2' } },
			]);
			// Another client marks it unread while it stays on screen: not overruled.
			h.event('labels', { labels: { 'herdr.seen': '1' } }, 11);
			// The turn ends: status first, then turn. Decided on the turn.
			h.event('status', { status: { state: 'working', app: 'claude-code' }, reported: true }, 12);
			h.event('status', { status: { state: 'done', app: 'claude-code' }, reported: true }, 13);
			expect(h.calls('terminal.label')).toHaveLength(1);
			h.event('turn', { turn: 3, state: 'done' }, 14);
			await settle();
			expect(h.calls('terminal.label').at(-1)?.params).toEqual({ terminal: 't7', labels: { 'herdr.seen': '3' } });
			// Looking away and back again raises a lowered label.
			h.event('labels', { labels: { 'herdr.seen': '2' } }, 15);
			h.session.setLooking(false);
			h.session.setLooking(true);
			await settle();
			expect(h.calls('terminal.label')).toHaveLength(3);
		});

		it('writes nothing while nobody looks', async () => {
			const h = harness();
			h.session.start();
			await settle();
			h.event('turn', { turn: 5, state: 'done' }, 11);
			await settle();
			expect(h.calls('terminal.label')).toEqual([]);
		});
	});
});

describe('SeenTracker', () => {
	const live = (turn: number, labels: Record<string, string>, state: string | null = 'done') => ({
		state: 'live',
		status: state === null ? null : { state, app: 'x' },
		turn,
		labels,
	});

	it('joins a terminal with no label, and skips one that never reported', async () => {
		const writes: number[] = [];
		const tracker = new SeenTracker((turn) => {
			writes.push(turn);
			return Promise.resolve();
		});
		tracker.setLooking(true);
		tracker.update(live(0, {}, null));
		expect(writes).toEqual([]);
		tracker.update(live(0, {}));
		expect(writes).toEqual([0]);
		tracker.update({ ...live(4, {}), state: 'finished' });
		expect(writes).toEqual([0]);
		await settle();
	});

	it('tries again on the next change after a failed write', async () => {
		let fail = true;
		const writes: number[] = [];
		const tracker = new SeenTracker((turn) => {
			writes.push(turn);
			return fail ? Promise.reject(new Error('gone')) : Promise.resolve();
		});
		tracker.update(live(2, { 'herdr.seen': '1' }));
		tracker.setLooking(true);
		await settle();
		fail = false;
		tracker.update(live(2, { 'herdr.seen': '1' }));
		expect(writes).toEqual([2, 2]);
	});
});

describe('describeEnd', () => {
	it('says "exited" for every final ending, and not for a loss', () => {
		expect(describeEnd({ reason: 'exited', exitCode: 0, signal: null })).toBe('the program exited with code 0');
		expect(describeEnd({ reason: 'killed', exitCode: null, signal: 1 })).toBe('the program exited: killed by signal 1');
		expect(describeEnd(null)).toBe('the program exited');
		expect(describeEnd({ reason: 'server_stop', exitCode: null, signal: null })).not.toContain('exited');
	});
});
