/**
 * One Claude Code process in stream-json mode, a child of the plugin over
 * plain pipes (ADR-0007): no pty, no shell, no native code.
 *
 * - **Out.** Every stdin line goes through `encodeLine` (`./protocol.ts`):
 *   one malformed line kills the process.
 * - **In.** stdout is split into lines with no size limit (the spike saw
 *   48 KB lines, and tool results are larger) and handed on parsed. Nothing
 *   is logged. stderr is kept as a short tail, for the one sentence an
 *   unexpected exit is reported with.
 * - **Stop**, in the ADR's order: pending permission requests denied, the
 *   `interrupt` control request while a turn runs (which keeps the partial
 *   text and writes the interrupt marker), then stdin EOF (an idle process
 *   exits about 0.8 s later), then SIGTERM, then SIGKILL. The waits follow
 *   the spike and the SDK's own `close()` (EOF, 2 s, SIGTERM, 5 s, SIGKILL).
 *
 * Everything that touches the OS is injected, so `tests/claudeProcess.test.ts`
 * runs the whole order against a fake child and fake timers.
 */

import { LineSplitter } from '../herdr/lineSplitter';
import {
	contextUsageRequest,
	controlResponse,
	denyResponse,
	encodeLine,
	interruptRequest,
	parseStreamLine,
	sessionControlRequest,
	STOPPED_DENIAL,
	type SessionControl,
	type StreamEvent,
} from './protocol';

/** The slice of a `ChildProcess` used here. */
export interface ClaudeChild {
	readonly pid?: number;
	stdin: {
		write(chunk: string): boolean;
		end(): void;
		on(event: 'error', handler: (error: Error) => void): unknown;
	} | null;
	stdout: { on(event: 'data', handler: (chunk: Buffer) => void): unknown } | null;
	stderr: { on(event: 'data', handler: (chunk: Buffer) => void): unknown } | null;
	on(event: 'exit', handler: (code: number | null, signal: string | null) => void): unknown;
	on(event: 'error', handler: (error: Error) => void): unknown;
	kill(signal?: NodeJS.Signals): boolean;
}

/** Starts a child: `argv[0]` with the rest as its arguments, never through a shell. */
export type ClaudeSpawn = (argv: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ClaudeChild;

export interface ClaudeTimers {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** How long a stop waits for the interrupted turn's `result`. Measured: 12 ms. */
export const INTERRUPT_WAIT_MS = 1500;
/** How long a stop waits for the exit after stdin EOF. Measured: 0.8–1 s idle. */
export const EOF_WAIT_MS = 2000;
/** How long a stop waits after SIGTERM before SIGKILL. Measured: 0.75 s. */
export const TERM_WAIT_MS = 5000;

/**
 * How long a session setting waits for Claude's answer. Measured: a few
 * milliseconds, mid-turn too (#162).
 */
export const CONTROL_WAIT_MS = 10000;

/** Claude's answer to one of the plugin's control requests. */
export type ControlAnswer = Extract<StreamEvent, { type: 'response' }>;

/** Said when Claude has not answered a setting in {@link CONTROL_WAIT_MS}. */
export const CONTROL_TIMEOUT = 'Claude did not answer';
/** Said for a setting whose process went before Claude answered it. */
export const CONTROL_EXITED = 'the agent stopped before Claude answered';

/** How much stderr is kept for an exit report. */
const STDERR_TAIL_BYTES = 2048;

export interface ClaudeProcessOptions {
	argv: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	spawn: ClaudeSpawn;
	timers: ClaudeTimers;
	/** One parsed stdout line. Lines that are not JSON are dropped. */
	onEvent(event: StreamEvent): void;
	/**
	 * The process is gone. `stopping` is true when the plugin stopped it; the
	 * error is the spawn failure or the stderr tail of an unexpected exit.
	 */
	onExit(info: { code: number | null; signal: string | null; stopping: boolean; error: string }): void;
}

/** The stderr tail as one line for a notice, or the exit status when it is empty. */
function exitReason(stderr: string, code: number | null, signal: string | null): string {
	const lines = stderr
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	const last = lines.at(-1) ?? '';
	if (last) return last.length > 200 ? `${last.slice(0, 200)}…` : last;
	return signal ? `exited on ${signal}` : `exited with code ${code ?? 'unknown'}`;
}

export class ClaudeProcess {
	private child: ClaudeChild | null = null;
	private exited = false;
	private stopping: Promise<void> | null = null;
	private readonly splitter = new LineSplitter(Number.POSITIVE_INFINITY);
	private stderr = '';
	private exitWaiters: (() => void)[] = [];
	private resultWaiters: (() => void)[] = [];
	private requestSeq = 0;
	/** The plugin's control requests waiting for Claude's answer, by request id. */
	private readonly controls = new Map<string, { settle: (answer: ControlAnswer | Error) => void }>();

	constructor(private readonly options: ClaudeProcessOptions) {}

	/** True from `start` until the process exits. */
	get alive(): boolean {
		return this.child !== null && !this.exited;
	}

	/** True once a stop has begun; the agent takes no prompts from then on. */
	get isStopping(): boolean {
		return this.stopping !== null;
	}

	start(): void {
		if (this.child) return;
		let child: ClaudeChild;
		try {
			child = this.options.spawn(this.options.argv, { cwd: this.options.cwd, env: this.options.env });
		} catch (error) {
			this.exited = true;
			this.finish(null, null, error instanceof Error ? error.message : String(error));
			return;
		}
		this.child = child;
		// A write after the pipe closed is an EPIPE on the stream, not a throw.
		child.stdin?.on('error', () => undefined);
		child.stdout?.on('data', (chunk) => {
			for (const line of this.splitter.push(chunk)) this.line(line);
		});
		child.stderr?.on('data', (chunk) => {
			this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
		});
		child.on('error', (error) => {
			// Spawn failures (ENOENT) arrive here, with no exit to follow.
			if (this.exited) return;
			this.exited = true;
			this.finish(null, null, error.message);
		});
		child.on('exit', (code, signal) => {
			if (this.exited) return;
			this.exited = true;
			this.finish(code, signal, exitReason(this.stderr, code, signal));
		});
	}

	/** Writes one message through the strict writer. Throws when the process cannot take it. */
	send(message: object): void {
		const line = encodeLine(message);
		const stdin = this.child?.stdin;
		if (!stdin || this.exited) throw new Error('the agent is not running');
		stdin.write(line);
	}

	/** The `interrupt` control request: ends the running turn, keeps the process. */
	interrupt(): void {
		this.send(interruptRequest(this.nextRequestId('interrupt')));
	}

	/**
	 * Changes a session setting (#162) and settles with Claude's answer, a
	 * refusal included. Rejects when the line cannot be written, when the
	 * process exits first, or when no answer comes in {@link CONTROL_WAIT_MS}.
	 */
	sessionControl(control: SessionControl): Promise<ControlAnswer> {
		const requestId = this.nextRequestId(control.setting);
		return this.control(requestId, sessionControlRequest(requestId, control));
	}

	/**
	 * Asks for the context breakdown (#171), which writes nothing to the
	 * conversation; settles as {@link sessionControl} does.
	 */
	contextUsage(): Promise<ControlAnswer> {
		const requestId = this.nextRequestId('context');
		return this.control(requestId, contextUsageRequest(requestId));
	}

	/** Writes one control request and settles with the answer to its id. */
	private control(requestId: string, request: object): Promise<ControlAnswer> {
		return new Promise<ControlAnswer>((resolve, reject) => {
			try {
				this.send(request);
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			const handle = this.options.timers.setTimeout(() => {
				this.controls.delete(requestId);
				reject(new Error(CONTROL_TIMEOUT));
			}, CONTROL_WAIT_MS);
			this.controls.set(requestId, {
				settle: (answer) => {
					this.options.timers.clearTimeout(handle);
					this.controls.delete(requestId);
					if (answer instanceof Error) reject(answer);
					else resolve(answer);
				},
			});
		});
	}

	/**
	 * Stops the process in the ADR's order and resolves once it has exited.
	 * `pending` are the permission requests still waiting, which are denied
	 * first; `busy` says a turn is running and gets the interrupt. Calling it
	 * again returns the same stop.
	 */
	stop(options: { busy: boolean; pending: readonly string[] }): Promise<void> {
		if (this.stopping) return this.stopping;
		this.stopping = this.runStop(options);
		return this.stopping;
	}

	private async runStop({ busy, pending }: { busy: boolean; pending: readonly string[] }): Promise<void> {
		if (!this.alive) return;
		for (const requestId of pending) {
			this.trySend(controlResponse(requestId, denyResponse(STOPPED_DENIAL)));
		}
		if (busy && this.trySend(interruptRequest(this.nextRequestId('interrupt')))) {
			await this.waitFor(this.resultWaiters, INTERRUPT_WAIT_MS);
		}
		if (!this.alive) return;
		try {
			this.child?.stdin?.end();
		} catch {
			// Already closed: the signals below still apply.
		}
		if (await this.waitFor(this.exitWaiters, EOF_WAIT_MS)) return;
		this.child?.kill('SIGTERM');
		if (await this.waitFor(this.exitWaiters, TERM_WAIT_MS)) return;
		this.child?.kill('SIGKILL');
		await this.waitFor(this.exitWaiters, TERM_WAIT_MS);
	}

	private trySend(message: object): boolean {
		try {
			this.send(message);
			return true;
		} catch {
			return false;
		}
	}

	private nextRequestId(kind: string): string {
		return `oh-${kind}-${++this.requestSeq}`;
	}

	/** True when the awaited thing happened, false on the timeout; true too once exited. */
	private waitFor(waiters: (() => void)[], ms: number): Promise<boolean> {
		if (this.exited) return Promise.resolve(true);
		return new Promise((resolve) => {
			let settled = false;
			const done = (value: boolean): void => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			const handle = this.options.timers.setTimeout(() => done(this.exited), ms);
			waiters.push(() => {
				this.options.timers.clearTimeout(handle);
				done(true);
			});
			// An exit ends every wait, whatever it waited for.
			if (waiters !== this.exitWaiters) {
				this.exitWaiters.push(() => {
					this.options.timers.clearTimeout(handle);
					done(true);
				});
			}
		});
	}

	private line(line: string): void {
		if (!line.trim()) return;
		const event = parseStreamLine(line);
		if (!event) return;
		if (event.type === 'result') this.release(this.resultWaiters);
		try {
			this.options.onEvent(event);
		} catch {
			// A failing subscriber must not stop the stream.
		}
		// After the event: what the answer set is folded in before its caller hears of it.
		if (event.type === 'response') this.controls.get(event.requestId)?.settle(event);
	}

	private release(waiters: (() => void)[]): void {
		for (const waiter of waiters.splice(0)) waiter();
	}

	private finish(code: number | null, signal: string | null, error: string): void {
		this.release(this.exitWaiters);
		this.release(this.resultWaiters);
		for (const control of [...this.controls.values()]) control.settle(new Error(CONTROL_EXITED));
		this.options.onExit({ code, signal, stopping: this.stopping !== null, error });
	}
}
