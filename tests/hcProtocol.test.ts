/**
 * herdr-core's framed protocol (ADR-0005): the codec, one connection over a
 * fake `hc connect`, the event subscription with its credit, and the attach
 * stream the terminal-tab batch builds on.
 */
import { describe, expect, it } from 'vitest';
import {
	decodeCredit,
	decodeResize,
	encodeCredit,
	encodeFrame,
	encodeResize,
	FrameDecoder,
	FrameKind,
	MAX_FRAME_PAYLOAD,
	type Frame,
} from '../src/hc/frames';
import { describeExit, HcConnection, HcError } from '../src/hc/connection';
import { attachTerminal, EVENTS_INITIAL_CREDIT, subscribeEvents, type HcEvent } from '../src/hc/streams';
import { FakeCore, fakeSpawner, HELLO_RESULT, RpcError, settle } from './fixtures/fakeHc';

function collect(decoder?: (d: FrameDecoder) => void) {
	const lines: string[] = [];
	const frames: Frame[] = [];
	const errors: Error[] = [];
	const d: FrameDecoder = new FrameDecoder({
		line: (text) => {
			lines.push(text);
			decoder?.(d);
		},
		frame: (frame) => frames.push(frame),
		error: (error) => errors.push(error),
	});
	return { d, lines, frames, errors };
}

describe('frame codec', () => {
	it('round-trips a frame header and payload', () => {
		const bytes = encodeFrame(7, FrameKind.Data, 'hello');
		expect(bytes.length).toBe(9 + 5);
		expect(bytes.readUInt32LE(0)).toBe(7);
		expect(bytes[4]).toBe(FrameKind.Data);
		expect(bytes.readUInt32LE(5)).toBe(5);
		const { d, frames } = collect();
		d.startFrames();
		d.push(bytes);
		expect(frames).toHaveLength(1);
		expect(frames[0]?.payload.toString()).toBe('hello');
	});

	it('matches the bytes captured from hc 0.1.18', () => {
		// [[herdr-core-api]] §3: RESIZE ch2 120x40, CREDIT ch1 262144, CLOSE ch2.
		expect(encodeResize(2, 120, 40).toString('hex')).toBe('02000000030400000078002800');
		expect(encodeCredit(1, 262144).toString('hex')).toBe('01000000010400000000000400');
		expect(encodeFrame(2, FrameKind.Close).toString('hex')).toBe('020000000200000000');
		expect(decodeResize(encodeResize(0, 90, 25).subarray(9))).toEqual({ cols: 90, rows: 25 });
		expect(decodeCredit(encodeCredit(0, 42).subarray(9))).toBe(42);
	});

	it('reassembles frames split across chunks, byte by byte', () => {
		const stream = Buffer.concat([
			encodeFrame(0, FrameKind.Data, '{"id":1}'),
			encodeFrame(3, FrameKind.Data, Buffer.alloc(1000, 0x41)),
			encodeFrame(3, FrameKind.Close),
		]);
		const { d, frames } = collect();
		d.startFrames();
		for (const byte of stream) d.push(Buffer.from([byte]));
		expect(frames.map((frame) => [frame.channel, frame.kind, frame.payload.length])).toEqual([
			[0, 0, 8],
			[3, 0, 1000],
			[3, 2, 0],
		]);
	});

	it('switches from the plain hello line to frames inside one chunk', () => {
		const chunk = Buffer.concat([
			Buffer.from('{"id":1,"result":{"framed":true}}\n'),
			encodeFrame(0, FrameKind.Data, '{"id":2}'),
		]);
		const { d, lines, frames } = collect((decoder) => decoder.startFrames());
		d.push(chunk);
		expect(lines).toEqual(['{"id":1,"result":{"framed":true}}']);
		expect(frames).toHaveLength(1);
	});

	it('refuses an oversized frame once and stops', () => {
		const header = Buffer.alloc(9);
		header.writeUInt32LE(1, 0);
		header.writeUInt32LE(MAX_FRAME_PAYLOAD + 1, 5);
		const { d, errors, frames } = collect();
		d.startFrames();
		d.push(header);
		d.push(encodeFrame(0, FrameKind.Data, 'x'));
		expect(errors).toHaveLength(1);
		expect(frames).toHaveLength(0);
	});
});

async function opened(setup?: (core: FakeCore) => void) {
	const { spawn, cores } = fakeSpawner(setup);
	const connection = new HcConnection({ argv: ['hc', 'connect'], spawn });
	const hello = await connection.open();
	const core = cores[0];
	if (!core) throw new Error('no core');
	return { connection, core, hello };
}

describe('HcConnection', () => {
	it('says hello with generation 1 in framed mode, then calls on channel 0', async () => {
		const { connection, core, hello } = await opened((c) => {
			c.handlers.set('server.status', () => ({ core: 'oma', version: '0.1.18' }));
		});
		expect(JSON.parse(core.plainLines[0] ?? '{}')).toMatchObject({
			method: 'hello',
			params: { generation: 1, framed: true },
		});
		expect(hello.version).toBe('0.1.18');
		expect(connection.mismatch).toBeNull();
		await expect(connection.request('server.status')).resolves.toMatchObject({ core: 'oma' });
		expect(core.sent(0, FrameKind.Data)).toHaveLength(1);
	});

	it('retries hello without a generation on unsupported_generation, and warns', async () => {
		const { connection, core } = await opened((c) => {
			c.handlers.set('hello', (params) => {
				if (params.generation !== undefined) throw new RpcError('unsupported_generation', 'no');
				return { ...HELLO_RESULT, generation: 2 };
			});
		});
		expect(core.plainLines).toHaveLength(2);
		expect((JSON.parse(core.plainLines[1] ?? '{}') as { params: unknown }).params).toEqual({ framed: true });
		expect(connection.mismatch).toEqual({ server: 2, expected: 1, version: '0.1.18' });
	});

	it('warns on a different generation in the reply without refusing', async () => {
		const { connection } = await opened((c) => {
			c.handlers.set('hello', () => ({ ...HELLO_RESULT, generation: 3 }));
		});
		expect(connection.mismatch?.server).toBe(3);
		expect(connection.hello?.framed).toBe(true);
	});

	it('rejects errors with the core’s data.kind', async () => {
		const { connection } = await opened((c) => {
			c.handlers.set('terminal.get', () => {
				throw new RpcError('not_found', 'no terminal t99');
			});
		});
		const error = await connection.request('terminal.get', { terminal: 't99' }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HcError);
		expect((error as HcError).kind).toBe('not_found');
		expect((error as HcError).message).toBe('no terminal t99');
	});

	it('turns a missing binary or a dead ssh into a readable error', async () => {
		const { spawn, cores } = fakeSpawner((core) => {
			core.silent = true;
		});
		const missing = new HcConnection({ argv: ['hc', 'connect'], spawn });
		const opening = missing.open();
		cores[0]?.exit(null, null, Object.assign(new Error('spawn hc ENOENT'), { code: 'ENOENT' }));
		await expect(opening).rejects.toThrow('hc was not found (hc connect)');

		const ssh = new HcConnection({ argv: ['ssh', '-T', '-o', 'BatchMode=yes', 'nohost', "sh -c 'x'"], spawn });
		const sshOpening = ssh.open();
		cores[1]?.stderrText('ssh: Could not resolve hostname nohost: Name or service not known\r\n');
		cores[1]?.exit(255);
		await expect(sshOpening).rejects.toThrow(
			'ssh nohost exited: ssh: Could not resolve hostname nohost: Name or service not known',
		);

		expect(describeExit(['hc'], { code: 127, signal: null }, '')).toContain('not installed');
	});

	it('closes with stdin EOF first and rejects what is pending', async () => {
		const { connection, core } = await opened();
		core.manual = true;
		const pending = connection.request('terminal.list');
		connection.close();
		await expect(pending).rejects.toThrow('closed');
		expect(core.stdinEnded).toBe(true);
		expect(connection.isEnded).toBe(true);
	});
});

describe('event subscription', () => {
	const snapshot = { seq: 10, channel: 1, terminals: [{ address: 't1' }] };

	it('delivers the snapshot, then events buffered before the channel was registered', async () => {
		const { connection } = await opened((c) => {
			// The reply and the first event frame in one chunk: the event arrives
			// before any continuation could register the channel.
			c.handlers.set('events.subscribe', (_params, core, id) =>
				Buffer.concat([
					core.rpcFrame({ jsonrpc: '2.0', id, result: snapshot }),
					core.eventFrames(1, [{ method: 'event', params: { seq: 11, type: 'title', terminal: 't1', data: { title: 'x' } } }]),
				]),
			);
		});
		const order: string[] = [];
		await subscribeEvents(connection, {}, {
			snapshot: (seq, terminals) => order.push(`snapshot ${seq} ${terminals.length}`),
			event: (event) => order.push(`event ${event.seq} ${event.type}`),
			closed: () => order.push('closed'),
		});
		expect(order).toEqual(['snapshot 10 1', 'event 11 title']);
	});

	it('reads several lines per frame and a line split across frames', async () => {
		const { connection, core } = await opened((c) => {
			c.handlers.set('events.subscribe', () => snapshot);
		});
		const events: HcEvent[] = [];
		const snapshots: number[] = [];
		const heartbeats: number[] = [];
		await subscribeEvents(connection, {}, {
			snapshot: (seq) => snapshots.push(seq),
			event: (event) => events.push(event),
			heartbeat: (seq) => heartbeats.push(seq),
			closed: () => undefined,
		});
		const status = { method: 'event', params: { seq: 11, type: 'status', terminal: 't1', data: { status: { state: 'working' } } } };
		const turn = { method: 'event', params: { seq: 12, type: 'turn', terminal: 't1', data: { turn: 1, state: 'done' } } };
		core.write(core.eventFrames(1, [status, turn], 2));
		const text = `${JSON.stringify({ method: 'heartbeat', params: { seq: 12 } })}\n${JSON.stringify({ method: 'missed', params: { seq: 40, terminals: [] } })}\n`;
		const cut = 20;
		core.write(Buffer.concat([
			encodeFrame(1, FrameKind.Data, text.slice(0, cut)),
			encodeFrame(1, FrameKind.Data, text.slice(cut)),
		]), 7);
		expect(events.map((event) => event.type)).toEqual(['status', 'turn']);
		expect(heartbeats).toEqual([12]);
		expect(snapshots).toEqual([10, 40]);
	});

	it('grants 1 MiB up front, then credits each frame’s length once handled', async () => {
		const { connection, core } = await opened((c) => {
			c.handlers.set('events.subscribe', () => snapshot);
		});
		await subscribeEvents(connection, {}, { snapshot: () => undefined, event: () => undefined, closed: () => undefined });
		const frames = core.eventFrames(1, [
			{ method: 'heartbeat', params: { seq: 1 } },
			{ method: 'heartbeat', params: { seq: 2 } },
		]);
		core.write(frames);
		const credits = core.sent(1, FrameKind.Credit).map((frame) => decodeCredit(frame.payload));
		const first = JSON.stringify({ method: 'heartbeat', params: { seq: 1 } }).length + 1;
		expect(credits[0]).toBe(EVENTS_INITIAL_CREDIT);
		expect(credits.slice(1)).toEqual([first, first]);
	});

	it('reports a CLOSE on the channel and the connection ending', async () => {
		const { connection, core } = await opened((c) => {
			c.handlers.set('events.subscribe', () => snapshot);
		});
		const closed: (Error | null)[] = [];
		await subscribeEvents(connection, {}, { snapshot: () => undefined, event: () => undefined, closed: (e) => closed.push(e) });
		core.write(encodeFrame(1, FrameKind.Close));
		expect(closed).toEqual([null]);
	});
});

describe('terminal attach (for the terminal-tab batch)', () => {
	it('never loses the first paint, and sends input, resize and credit on its channel', async () => {
		const paint = Buffer.from('\x18\x1b[!p\x1b[Hhello');
		const { connection, core } = await opened((c) => {
			c.handlers.set('terminal.attach', (_params, fake, id) =>
				Buffer.concat([
					fake.rpcFrame({ jsonrpc: '2.0', id, result: { channel: 2, automatic_input: true, resize_notifications: false, terminal: { address: 't2' } } }),
					encodeFrame(2, FrameKind.Data, paint),
				]),
			);
		});
		const data: Buffer[] = [];
		const stream = await attachTerminal(connection, { terminal: 't2', cols: 80, rows: 24, observe: false }, {
			data: (bytes) => data.push(bytes),
			closed: () => undefined,
		});
		await settle();
		expect(Buffer.concat(data).equals(paint)).toBe(true);
		expect(stream.automaticInput).toBe(true);
		stream.write('ls\r');
		stream.reply('\x1b[?1;2c');
		stream.resize(120, 40);
		stream.credit(paint.length);
		expect(core.sent(2).map((frame) => frame.kind)).toEqual([
			FrameKind.Data,
			FrameKind.AutomaticInput,
			FrameKind.Resize,
			FrameKind.Credit,
		]);
		stream.detach();
		expect(core.sent(2, FrameKind.Close)).toHaveLength(1);
	});

	it('sends emulator replies as DATA to a core without automatic_input (0.1.17)', async () => {
		const { connection, core } = await opened((c) => {
			c.handlers.set('hello', () => ({ ...HELLO_RESULT, version: '0.1.17', features: ['framed', 'attach', 'events'] }));
			c.handlers.set('terminal.attach', () => ({ channel: 1, automatic_input: true }));
		});
		const stream = await attachTerminal(connection, { terminal: 't1', cols: 80, rows: 24 }, { data: () => undefined, closed: () => undefined });
		stream.reply('\x1b[0n');
		expect(core.sent(1).map((frame) => frame.kind)).toEqual([FrameKind.Data]);
	});

	it('reads the exit reason from the core’s CLOSE', async () => {
		const { connection, core } = await opened((c) => {
			c.handlers.set('terminal.attach', () => ({ channel: 1 }));
		});
		const reasons: unknown[] = [];
		await attachTerminal(connection, { terminal: 't1', cols: 80, rows: 24 }, {
			data: () => undefined,
			closed: (reason) => reasons.push(reason),
		});
		core.write(encodeFrame(1, FrameKind.Close, '{"exit_code":3,"finished_ms":1,"reason":"exited","signal":null}'));
		expect(reasons).toEqual([{ reason: 'exited', exitCode: 3, signal: null }]);
	});
});
