/**
 * One framed connection to a herdr-core over a child process's pipes
 * (ADR-0005): `hc connect` locally, `ssh -T <host> <hc> connect` remotely.
 *
 * This is the piece both halves of the herdr-core kind reuse: the runtime's
 * client (`./client.ts`) holds one for JSON-RPC and the event stream, and a
 * terminal tab holds one of its own for a single `terminal.attach`
 * (`./terminalSession.ts`).
 *
 * - **Handshake.** `hello {generation: 1, framed: true}` as a plain line; its
 *   reply is the last plain line, and the decoder switches to frames inside
 *   the same chunk. A core that answers `unsupported_generation` is asked
 *   again without a generation and reported as a mismatch, never refused
 *   ([[herdr-core-api]] §1).
 * - **Channel 0** carries JSON-RPC both ways; calls run concurrently.
 * - **Other channels** are registered by whoever asked for them (an attach, an
 *   event subscription). The core may put a channel's first frame right
 *   behind the reply that names it, and a promise continuation runs after the
 *   decoder has already read that frame, so frames for a channel nobody has
 *   registered yet are buffered and handed over on registration. A first
 *   paint is therefore never lost (§3, surprises 1).
 * - **Ending.** stdin EOF half-closes the core socket; the process exiting
 *   rejects every pending call and ends every channel.
 * - **Silence.** A `hello` with no answer, or a call given a timeout that
 *   passes, aborts the connection: the link is wedged (an ssh that never got
 *   through, a reply lost in a login banner), and ending it is what sends the
 *   caller down its ordinary dead-process path. Text a login shell prints
 *   before the reply is skipped, also when it shares the reply's line.
 *
 * No Obsidian import, and the process is injected ({@link HcSpawn}), so the
 * whole protocol is tested against a fake core.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { clearTimer, setTimer } from '../timers';
import { encodeFrame, FrameDecoder, FrameKind, type Frame } from './frames';

/** The protocol generation this build speaks. */
export const HC_GENERATION = 1;

/** How much stderr is kept for an error message. */
const STDERR_TAIL_BYTES = 4096;
/** Frames held for one not-yet-registered channel before the oldest go. */
const EARLY_BYTES_PER_CHANNEL = 8 * 1024 * 1024;
/** After stdin EOF, how long the child gets before it is killed. */
const CLOSE_GRACE_MS = 1000;
/**
 * How long `hello` may take: ssh's own `ConnectTimeout` (10 s) plus a core
 * that `hc connect` has to start first.
 */
export const HELLO_TIMEOUT_MS = 20_000;
/** Where on a plain line the reply may start, after a banner's leftovers. */
const MAX_REPLY_STARTS = 32;

/** Timers the connection's own deadlines run on; injectable for tests. */
export interface HcTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const defaultTimers: HcTimers = {
	setTimeout: (callback, ms) => setTimer(callback, ms),
	clearTimeout: (handle) => clearTimer(handle as ReturnType<typeof setTimer>),
};

/** A call (or the handshake) that got no answer in time; the connection is aborted. */
export class HcTimeoutError extends Error {
	readonly kind = 'timeout';
	constructor(readonly method: string, ms: number) {
		super(`herdr-core did not answer ${method} within ${Math.round(ms / 1000)} s`);
		this.name = 'HcTimeoutError';
	}
}

/** The child process, as far as the connection needs it. */
export interface HcProcess {
	write(data: Buffer): void;
	/** Closes stdin; the core reads EOF and half-closes. */
	end(): void;
	kill(): void;
	onStdout(handler: (chunk: Buffer) => void): void;
	onStderr(handler: (chunk: Buffer) => void): void;
	/** Fires once: the process exited, or could not be started (`error`). */
	onExit(handler: (exit: { code: number | null; signal: string | null; error?: Error }) => void): void;
}

export type HcSpawn = (argv: readonly string[], env?: NodeJS.ProcessEnv) => HcProcess;

/** `child_process.spawn` with plain pipes, no PTY and no shell. */
export const spawnHcProcess: HcSpawn = (argv, env) => {
	const [file, ...args] = argv;
	if (!file) throw new Error('no herdr-core command to run');
	const child = nodeSpawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env });
	let exited = false;
	const exitHandlers: ((exit: { code: number | null; signal: string | null; error?: Error }) => void)[] =
		[];
	const finish = (exit: { code: number | null; signal: string | null; error?: Error }): void => {
		if (exited) return;
		exited = true;
		for (const handler of exitHandlers) handler(exit);
	};
	child.on('error', (error) => finish({ code: null, signal: null, error }));
	child.on('close', (code, signal) => finish({ code, signal }));
	// A write after the child is gone raises EPIPE on the stream; the exit
	// handler is what reports it.
	child.stdin.on('error', () => undefined);
	return {
		write: (data) => {
			if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(data);
		},
		end: () => {
			if (!child.stdin.destroyed) child.stdin.end();
		},
		kill: () => {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
		},
		onStdout: (handler) => child.stdout.on('data', handler),
		onStderr: (handler) => child.stderr.on('data', handler),
		onExit: (handler) => {
			exitHandlers.push(handler);
		},
	};
};

/** A JSON-RPC error from the core. Switch on {@link kind} (`data.kind`). */
export class HcError extends Error {
	/** `data.kind`: `not_found`, `blocked`, `unknown_method`, …; else the numeric code. */
	readonly kind: string;
	readonly code: number | null;
	readonly hint: string | null;
	readonly method: string;

	constructor(method: string, error: unknown) {
		const record = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
		const data = (typeof record.data === 'object' && record.data !== null ? record.data : {}) as Record<
			string,
			unknown
		>;
		const message = typeof record.message === 'string' ? record.message : 'herdr-core error';
		super(message);
		this.name = 'HcError';
		this.method = method;
		this.code = typeof record.code === 'number' ? record.code : null;
		this.kind =
			typeof data.kind === 'string' ? data.kind : this.code !== null ? String(this.code) : 'error';
		this.hint = typeof data.hint === 'string' ? data.hint : null;
	}

	get isUnknownMethod(): boolean {
		return this.kind === 'unknown_method' || this.code === -32601;
	}
}

/** The `hello` result fields the plugin reads; unknown fields are ignored. */
export interface HcHello {
	generation: number | null;
	version: string;
	core: { id: string; name: string } | null;
	framed: boolean;
	methods: string[];
	features: string[];
}

/** A generation the core speaks that this build does not, reported once. */
export interface HcMismatch {
	/** The core's generation, or null when it did not say. */
	server: number | null;
	expected: number;
	version: string;
}

/** Handler of one registered channel. */
export interface ChannelHandler {
	frame(kind: number, payload: Buffer): void;
	/** The connection ended (process exit or `close()`); no more frames. */
	ended(error: Error | null): void;
}

export interface ChannelHandle {
	readonly channel: number;
	send(kind: number, payload?: Uint8Array | string): void;
	/** Stops delivering; later frames for the channel are dropped. Sends nothing. */
	release(): void;
}

export interface HcConnectionOptions {
	argv: readonly string[];
	env?: NodeJS.ProcessEnv;
	spawn?: HcSpawn;
	/** Notifications on channel 0 (none are documented; kept for growth). */
	onNotification?: (method: string, params: unknown) => void;
	/** The process ended; `error` says why when it was not asked to. */
	onExit?: (error: Error | null) => void;
	/** {@link HELLO_TIMEOUT_MS} by default. */
	helloTimeoutMs?: number;
	timers?: HcTimers;
}

/** Per-call options. */
export interface HcRequestOptions {
	/** No answer within this long aborts the whole connection ({@link HcTimeoutError}). */
	timeoutMs?: number;
}

/** One JSON-RPC message, as far as routing it goes. */
interface RpcMessage {
	id?: number;
	result?: unknown;
	error?: unknown;
	method?: string;
	params?: unknown;
}

interface Pending {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/**
 * What a dead or never-started `hc connect` most likely means, in the same
 * register as the herdr kind's errors: the binary is missing, ssh could not
 * reach the host, or the core said something on stderr.
 */
export function describeExit(
	argv: readonly string[],
	exit: { code: number | null; signal: string | null; error?: Error },
	stderr: string,
): string {
	const command = commandLabel(argv);
	const err: (Error & { code?: string }) | undefined = exit.error;
	if (err?.code === 'ENOENT') return `${argv[0] ?? 'hc'} was not found (${command})`;
	if (err) return `could not start ${command}: ${err.message}`;
	const said = lastLine(stderr);
	if (said) return `${command} exited: ${said}`;
	if (exit.code === 127) return `${command} exited: herdr-core is not installed there`;
	if (exit.signal) return `${command} ended by ${exit.signal}`;
	return `${command} exited with code ${exit.code ?? 'unknown'}`;
}

/**
 * How a transport is named in an error: `ssh <host>` for the SSH line (its
 * options and remote script say nothing a reader needs), the argv otherwise.
 */
export function commandLabel(argv: readonly string[]): string {
	const first = argv[0] ?? '';
	if (first === 'ssh' || first.endsWith('/ssh')) return `ssh ${argv.at(-2) ?? ''}`.trim();
	return argv.join(' ');
}

function lastLine(text: string): string {
	const lines = text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines.at(-1) ?? '';
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function parseHello(result: unknown): HcHello {
	const record = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>;
	const core = record.core as Record<string, unknown> | undefined;
	return {
		generation: typeof record.generation === 'number' ? record.generation : null,
		version: typeof record.version === 'string' ? record.version : '',
		core:
			core && typeof core === 'object'
				? {
						id: typeof core.id === 'string' ? core.id : '',
						name: typeof core.name === 'string' ? core.name : '',
					}
				: null,
		framed: record.framed === true,
		methods: stringList(record.methods),
		features: stringList(record.features),
	};
}

export class HcConnection {
	private readonly process: HcProcess;
	private readonly decoder: FrameDecoder;
	private readonly pending = new Map<number, Pending>();
	private readonly channels = new Map<number, ChannelHandler>();
	private readonly early = new Map<number, { frames: Frame[]; bytes: number }>();
	private readonly released = new Set<number>();
	private nextId = 1;
	/** The id of the framed `hello` in flight: its reply is the switch. */
	private framedHelloId: number | null = null;
	private stderr = '';
	private endedError: Error | null | undefined = undefined;
	private helloResult: HcHello | null = null;
	private mismatchResult: HcMismatch | null = null;
	private closeTimer: ReturnType<typeof setTimer> | null = null;
	private readonly timers: HcTimers;
	/** Deadlines of calls still waiting, by id. */
	private readonly deadlines = new Map<number, unknown>();

	constructor(private readonly options: HcConnectionOptions) {
		this.timers = options.timers ?? defaultTimers;
		this.decoder = new FrameDecoder({
			line: (text) => this.onLine(text),
			frame: (frame) => this.onFrame(frame),
			error: (error) => this.abort(error),
		});
		this.process = (options.spawn ?? spawnHcProcess)(options.argv, options.env);
		this.process.onStdout((chunk) => this.decoder.push(chunk));
		this.process.onStderr((chunk) => {
			this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
		});
		this.process.onExit((exit) => {
			if (this.closeTimer) clearTimer(this.closeTimer);
			this.closeTimer = null;
			const asked = this.endedError !== undefined;
			this.finish(asked ? this.endedError ?? null : new Error(describeExit(options.argv, exit, this.stderr)));
		});
	}

	/** The `hello` answer, once {@link open} resolved. */
	get hello(): HcHello | null {
		return this.helloResult;
	}

	/** Set when the core's generation differs from {@link HC_GENERATION}. */
	get mismatch(): HcMismatch | null {
		return this.mismatchResult;
	}

	get isEnded(): boolean {
		return this.endedError !== undefined;
	}

	/** Whether both the core and (for an attach) the stream advertise a feature. */
	hasFeature(name: string): boolean {
		return this.helloResult?.features.includes(name) ?? false;
	}

	/**
	 * The handshake. Resolves with the core's `hello`; rejects with a readable
	 * error when the process dies first (no binary, no host) or the core
	 * refuses framing. A generation mismatch resolves, with {@link mismatch} set.
	 */
	async open(): Promise<HcHello> {
		const timeout = this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
		const deadline = this.timers.setTimeout(() => this.abort(new HcTimeoutError('hello', timeout)), timeout);
		try {
			return await this.handshake();
		} finally {
			this.timers.clearTimeout(deadline);
		}
	}

	private async handshake(): Promise<HcHello> {
		let result: unknown;
		try {
			result = await this.plainHello({ generation: HC_GENERATION, framed: true });
		} catch (error) {
			if (!(error instanceof HcError && error.kind === 'unsupported_generation')) throw error;
			// herdr-app's path: ask again without a generation, then compare.
			result = await this.plainHello({ framed: true });
		}
		const hello = parseHello(result);
		if (!hello.framed) throw new Error('herdr-core did not switch to framed mode');
		this.helloResult = hello;
		if (hello.generation !== HC_GENERATION) {
			this.mismatchResult = {
				server: hello.generation,
				expected: HC_GENERATION,
				version: hello.version,
			};
		}
		return hello;
	}

	/** One JSON-RPC call on channel 0. Rejects with {@link HcError} on an error reply. */
	request<T>(method: string, params: unknown = {}, options: HcRequestOptions = {}): Promise<T> {
		if (this.endedError !== undefined) {
			return Promise.reject(this.endedError ?? new Error('herdr-core connection closed'));
		}
		if (!this.decoder.isFramed) {
			return Promise.reject(new Error('herdr-core connection is not open yet'));
		}
		const id = this.nextId++;
		const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
			const timeout = options.timeoutMs;
			if (timeout !== undefined && timeout > 0) {
				this.deadlines.set(
					id,
					this.timers.setTimeout(() => {
						this.deadlines.delete(id);
						this.abort(new HcTimeoutError(method, timeout));
					}, timeout),
				);
			}
			this.process.write(encodeFrame(0, FrameKind.Data, body));
		});
	}

	/**
	 * Takes a channel the core allocated (an attach or event subscription
	 * reply). Frames that arrived before this call are delivered first, in
	 * order, synchronously.
	 */
	register(channel: number, handler: ChannelHandler): ChannelHandle {
		this.released.delete(channel);
		this.channels.set(channel, handler);
		const early = this.early.get(channel);
		this.early.delete(channel);
		for (const frame of early?.frames ?? []) {
			if (this.channels.get(channel) !== handler) break;
			handler.frame(frame.kind, frame.payload);
		}
		if (this.endedError !== undefined) handler.ended(this.endedError);
		return {
			channel,
			send: (kind, payload) => this.send(channel, kind, payload),
			release: () => {
				if (this.channels.get(channel) !== handler) return;
				this.channels.delete(channel);
				this.released.add(channel);
			},
		};
	}

	/** One frame on any channel; ignored once the connection ended. */
	send(channel: number, kind: number, payload?: Uint8Array | string): void {
		if (this.endedError !== undefined || !this.decoder.isFramed) return;
		this.process.write(encodeFrame(channel, kind, payload));
	}

	/**
	 * Ends the connection: stdin EOF first, so the core half-closes cleanly,
	 * then a kill if the child is still there after a grace period.
	 */
	close(): void {
		if (this.endedError !== undefined) return;
		this.endedError = null;
		this.rejectAll(new Error('herdr-core connection closed'));
		for (const handler of [...this.channels.values()]) handler.ended(null);
		this.channels.clear();
		this.early.clear();
		this.process.end();
		this.closeTimer = setTimer(() => {
			this.closeTimer = null;
			this.process.kill();
		}, CLOSE_GRACE_MS);
	}

	private plainHello(params: Record<string, unknown>): Promise<unknown> {
		if (this.endedError !== undefined) {
			return Promise.reject(this.endedError ?? new Error('herdr-core connection closed'));
		}
		const id = this.nextId++;
		this.framedHelloId = params.framed === true ? id : null;
		const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'hello', params });
		return new Promise((resolve, reject) => {
			this.pending.set(id, { method: 'hello', resolve, reject });
			this.process.write(Buffer.from(`${body}\n`, 'utf8'));
		});
	}

	private onLine(text: string): void {
		const message = this.parsePlain(text);
		if (!message) return;
		// The framed hello's success is the last plain line: switch before the
		// decoder reads the rest of this chunk.
		if (
			message.id !== undefined &&
			message.id === this.framedHelloId &&
			message.error === undefined &&
			(message.result as Record<string, unknown> | undefined)?.framed === true
		) {
			this.framedHelloId = null;
			this.decoder.startFrames();
		}
		this.dispatch(message);
	}

	private onFrame(frame: Frame): void {
		if (frame.channel === 0) {
			if (frame.kind !== FrameKind.Data) return;
			const message = this.parse(frame.payload.toString('utf8'));
			if (message) this.dispatch(message);
			return;
		}
		const handler = this.channels.get(frame.channel);
		if (handler) {
			handler.frame(frame.kind, frame.payload);
			return;
		}
		if (this.released.has(frame.channel)) return;
		let early = this.early.get(frame.channel);
		if (!early) {
			early = { frames: [], bytes: 0 };
			this.early.set(frame.channel, early);
		}
		early.frames.push(frame);
		early.bytes += frame.payload.length;
		while (early.bytes > EARLY_BYTES_PER_CHANNEL && early.frames.length > 1) {
			const dropped = early.frames.shift();
			early.bytes -= dropped?.payload.length ?? 0;
		}
	}

	/**
	 * A plain line before framing: the `hello` reply, or whatever a login
	 * shell printed (a banner, a title escape). A banner without its own
	 * newline shares the reply's line, so the reply is looked for at each
	 * `{` from the left.
	 */
	private parsePlain(text: string): RpcMessage | null {
		const whole = this.parse(text);
		if (whole) return whole;
		let at = text.indexOf('{', 1);
		for (let tries = 0; at !== -1 && tries < MAX_REPLY_STARTS; tries++) {
			const message = this.parse(text.slice(at));
			if (message && (message.id !== undefined || message.method !== undefined)) return message;
			at = text.indexOf('{', at + 1);
		}
		return null;
	}

	private parse(text: string): RpcMessage | null {
		try {
			const value: unknown = JSON.parse(text);
			return typeof value === 'object' && value !== null ? value : null;
		} catch {
			return null;
		}
	}

	private dispatch(message: RpcMessage): void {
		if (typeof message.id === 'number' && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			this.clearDeadline(message.id);
			if (!pending) return;
			if (message.error !== undefined && message.error !== null) {
				pending.reject(new HcError(pending.method, message.error));
			} else {
				pending.resolve(message.result);
			}
			return;
		}
		if (typeof message.method === 'string') this.options.onNotification?.(message.method, message.params);
	}

	private abort(error: Error): void {
		if (this.endedError !== undefined) return;
		this.endedError = error;
		this.process.end();
		this.process.kill();
		this.finish(error);
	}

	private finish(error: Error | null): void {
		if (this.endedError === undefined) this.endedError = error;
		this.rejectAll(error ?? new Error('herdr-core connection closed'));
		for (const handler of [...this.channels.values()]) handler.ended(error);
		this.channels.clear();
		this.early.clear();
		const exit = this.options.onExit;
		this.options.onExit = undefined;
		exit?.(error);
	}

	private clearDeadline(id: number): void {
		const deadline = this.deadlines.get(id);
		if (deadline === undefined) return;
		this.deadlines.delete(id);
		this.timers.clearTimeout(deadline);
	}

	private rejectAll(error: Error): void {
		for (const deadline of this.deadlines.values()) this.timers.clearTimeout(deadline);
		this.deadlines.clear();
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const entry of pending) entry.reject(error);
	}
}
