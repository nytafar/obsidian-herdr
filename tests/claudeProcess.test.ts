/**
 * One Claude process (ADR-0007): the stop order — pending requests denied,
 * `interrupt`, stdin EOF, SIGTERM, SIGKILL — against a fake child and
 * hand-driven timers, the strict writer at the pipe, and what an unexpected
 * exit reports.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
	ClaudeProcess,
	CONTROL_EXITED,
	CONTROL_TIMEOUT,
	CONTROL_WAIT_MS,
	EOF_WAIT_MS,
	INTERRUPT_WAIT_MS,
	TERM_WAIT_MS,
	type ClaudeTimers,
} from '../src/claude/process';
import type { StreamEvent } from '../src/claude/protocol';

/** A child whose every write, end and signal is recorded in one list. */
class FakeChild extends EventEmitter {
	readonly events: string[] = [];
	readonly writes: unknown[] = [];
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	/** What a signal does: exit at once, or nothing (a stuck process). */
	exitOn: Partial<Record<string, number | null>> = {};
	/** Exits on stdin EOF, as an idle stream claude does. */
	exitOnEof = false;
	stdin = {
		write: (chunk: string): boolean => {
			const message = JSON.parse(chunk) as { type: string };
			this.writes.push(message);
			this.events.push(`write ${message.type}`);
			return true;
		},
		end: (): void => {
			this.events.push('eof');
			if (this.exitOnEof) queueMicrotask(() => this.emit('exit', 0, null));
		},
		on: () => this.stdin,
	};

	kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
		this.events.push(signal);
		if (signal in this.exitOn) queueMicrotask(() => this.emit('exit', this.exitOn[signal] ?? null, signal));
		return true;
	}

	/** One stdout line from Claude. */
	line(message: object): void {
		this.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
	}
}

/** Timers advanced by hand, in order. */
class Clock implements ClaudeTimers {
	now = 0;
	private timers: { at: number; handler: () => void; id: number }[] = [];
	private seq = 0;
	setTimeout(handler: () => void, ms: number): unknown {
		const id = ++this.seq;
		this.timers.push({ at: this.now + ms, handler, id });
		return id;
	}
	clearTimeout(handle: unknown): void {
		this.timers = this.timers.filter((timer) => timer.id !== handle);
	}
	async advance(ms: number): Promise<void> {
		const until = this.now + ms;
		for (;;) {
			await flush();
			const due = this.timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			this.timers = this.timers.filter((timer) => timer !== due);
			this.now = due.at;
			due.handler();
		}
		this.now = until;
		await flush();
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function start(child: FakeChild, clock = new Clock()) {
	const events: StreamEvent[] = [];
	const exits: { code: number | null; stopping: boolean; error: string }[] = [];
	const argvs: (readonly string[])[] = [];
	const process = new ClaudeProcess({
		argv: ['claude', '-p'],
		cwd: '/tmp/oh-d1-x',
		env: {},
		spawn: (argv) => {
			argvs.push(argv);
			return child;
		},
		timers: clock,
		onEvent: (event) => events.push(event),
		onExit: (info) => exits.push(info),
	});
	process.start();
	return { process, events, exits, clock, argvs };
}

describe('ClaudeProcess', () => {
	it('reads lines split across chunks, and drops lines that are not JSON', () => {
		const child = new FakeChild();
		const { events } = start(child);
		child.stdout.emit('data', Buffer.from('{"type":"system","subtype":"init","session_id":"a"'));
		child.stdout.emit('data', Buffer.from('}\nnot json\n{"type":"result","is_error":false}\n'));
		expect(events.map((event) => event.type)).toEqual(['init', 'result']);
	});

	it('writes only through the strict writer', () => {
		const child = new FakeChild();
		const { process } = start(child);
		process.send({ type: 'user', message: { role: 'user', content: 'hi' } });
		expect(child.writes).toEqual([{ type: 'user', message: { role: 'user', content: 'hi' } }]);
		expect(() => process.send([])).toThrow();
		expect(child.writes).toHaveLength(1);
	});

	it('stops an idle process with stdin EOF alone', async () => {
		const child = new FakeChild();
		child.exitOnEof = true;
		const { process, exits } = start(child);
		await process.stop({ busy: false, pending: [] });
		expect(child.events).toEqual(['eof']);
		expect(exits).toEqual([{ code: 0, signal: null, stopping: true, error: 'exited with code 0' }]);
	});

	it('denies pending requests, interrupts a running turn, waits for its result, then closes stdin', async () => {
		const child = new FakeChild();
		child.exitOnEof = true;
		const { process, clock } = start(child);
		const stopped = process.stop({ busy: true, pending: ['req-1'] });
		await flush();
		expect(child.events).toEqual(['write control_response', 'write control_request']);
		expect(child.writes[0]).toEqual({
			type: 'control_response',
			response: {
				subtype: 'success',
				request_id: 'req-1',
				response: { behavior: 'deny', message: 'The agent was stopped before this was answered.' },
			},
		});
		expect(child.writes[1]).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
		// Nothing more until the interrupted turn's result, or the timeout.
		await clock.advance(INTERRUPT_WAIT_MS - 1);
		expect(child.events).not.toContain('eof');
		child.line({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' });
		await flush();
		await stopped;
		expect(child.events.at(-1)).toBe('eof');
	});

	it('escalates to SIGTERM after the EOF wait and to SIGKILL after the TERM wait', async () => {
		const child = new FakeChild();
		child.exitOn = { SIGKILL: null };
		const { process, clock, exits } = start(child);
		let done = false;
		void process.stop({ busy: false, pending: [] }).then(() => {
			done = true;
		});
		await flush();
		expect(child.events).toEqual(['eof']);
		await clock.advance(EOF_WAIT_MS - 1);
		expect(child.events).toEqual(['eof']);
		await clock.advance(1);
		expect(child.events).toEqual(['eof', 'SIGTERM']);
		await clock.advance(TERM_WAIT_MS);
		expect(child.events).toEqual(['eof', 'SIGTERM', 'SIGKILL']);
		await flush();
		expect(done).toBe(true);
		expect(exits[0]).toMatchObject({ signal: 'SIGKILL', stopping: true });
	});

	it('stops once however often it is asked', async () => {
		const child = new FakeChild();
		child.exitOnEof = true;
		const { process } = start(child);
		const first = process.stop({ busy: false, pending: [] });
		const second = process.stop({ busy: false, pending: [] });
		expect(second).toBe(first);
		await first;
		expect(child.events).toEqual(['eof']);
	});

	it('reports an unexpected exit with the last stderr line', () => {
		const child = new FakeChild();
		const { exits, process } = start(child);
		child.stderr.emit('data', Buffer.from('Error parsing streaming input line (type=unknown, 16 chars): SyntaxError\n'));
		child.emit('exit', 1, null);
		expect(exits).toEqual([
			{ code: 1, signal: null, stopping: false, error: 'Error parsing streaming input line (type=unknown, 16 chars): SyntaxError' },
		]);
		expect(process.alive).toBe(false);
		expect(() => process.send({ type: 'user' })).toThrow('the agent is not running');
	});

	it('settles a session setting with Claude’s answer to its own request id, after the event (#162)', async () => {
		const child = new FakeChild();
		const { process, events } = start(child);
		const first = process.sessionControl({ setting: 'model', model: 'sonnet' });
		const second = process.sessionControl({ setting: 'mode', mode: 'bogus' });
		const [one, two] = child.writes as { request_id: string; request: { subtype: string } }[];
		expect(one?.request.subtype).toBe('set_model');
		expect(two?.request.subtype).toBe('set_permission_mode');
		expect(one?.request_id).not.toBe(two?.request_id);
		// Answered out of order, as Claude answered set_model last in the spike.
		child.line({
			type: 'control_response',
			response: { subtype: 'error', request_id: two?.request_id, error: 'Cannot set permission mode', error_code: 'invalid_mode' },
		});
		child.line({ type: 'control_response', response: { subtype: 'success', request_id: one?.request_id, response: { model: 'claude-sonnet-5-5' } } });
		await expect(second).resolves.toMatchObject({ ok: false, errorCode: 'invalid_mode' });
		await expect(first).resolves.toMatchObject({ ok: true, model: 'claude-sonnet-5-5' });
		// The subscriber heard both, so the session info had moved before the caller was told.
		expect(events.filter((event) => event.type === 'response')).toHaveLength(2);
	});

	it('rejects a session setting nobody answers, and one whose process exits first', async () => {
		const child = new FakeChild();
		const { process, clock } = start(child);
		const silent = process.sessionControl({ setting: 'effort', effort: 'low' });
		const rejected = expect(silent).rejects.toThrow(CONTROL_TIMEOUT);
		await clock.advance(CONTROL_WAIT_MS);
		await rejected;
		const orphan = process.sessionControl({ setting: 'effort', effort: 'high' });
		child.emit('exit', 0, null);
		await expect(orphan).rejects.toThrow(CONTROL_EXITED);
		await expect(process.sessionControl({ setting: 'mode', mode: 'plan' })).rejects.toThrow('the agent is not running');
	});

	it('reports a spawn failure as an exit', () => {
		const child = new FakeChild();
		const { exits } = start(child);
		child.emit('error', new Error('spawn claude ENOENT'));
		expect(exits).toEqual([{ code: null, signal: null, stopping: false, error: 'spawn claude ENOENT' }]);
	});
});
