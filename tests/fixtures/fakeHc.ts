/**
 * A fake herdr-core behind `hc connect`: an {@link HcProcess} whose stdin is
 * parsed like the core parses it (a plain `hello` line, then frames) and whose
 * stdout the test writes, in whatever chunks it likes.
 */
import { spawnSync } from 'node:child_process';
import { encodeFrame, FrameDecoder, FrameKind, type Frame } from '../../src/hc/frames';
import type { HcProcess, HcSpawn, HcTimers } from '../../src/hc/connection';

export type Handler = (params: Record<string, unknown>, core: FakeCore, id: number) => unknown;

/** Throw this from a handler to answer with a JSON-RPC error. */
export class RpcError extends Error {
	constructor(
		readonly kind: string,
		message: string,
		readonly code = -32000,
	) {
		super(message);
	}
}

export const HELLO_RESULT = {
	generation: 1,
	version: '0.1.18',
	core: { id: 'c0ffee', name: 'oma' },
	framed: true,
	methods: ['hello', 'events.subscribe', 'terminal.run'],
	features: ['framed', 'attach', 'events', 'status', 'shell', 'resize_notifications', 'automatic_input'],
};

export class FakeCore {
	readonly frames: Frame[] = [];
	readonly calls: { method: string; params: Record<string, unknown> }[] = [];
	readonly plainLines: string[] = [];
	readonly handlers = new Map<string, Handler>();
	/** Set to delay replies: the test answers with `reply`. */
	manual = false;
	/** Set to never answer the plain `hello`: a process that dies before talking. */
	silent = false;
	/** Printed right before the `hello` reply, as a login shell's banner would be. */
	banner = '';
	readonly pendingIds: { id: number; method: string }[] = [];
	stdinEnded = false;
	killed = false;
	private stdout: ((chunk: Buffer) => void)[] = [];
	private stderr: ((chunk: Buffer) => void)[] = [];
	private exits: ((exit: { code: number | null; signal: string | null; error?: Error }) => void)[] = [];
	private exited = false;
	private readonly decoder: FrameDecoder;

	constructor(readonly argv: readonly string[]) {
		this.decoder = new FrameDecoder({
			line: (text) => this.onLine(text),
			frame: (frame) => this.onFrame(frame),
			error: () => undefined,
		});
		this.handlers.set('hello', () => HELLO_RESULT);
	}

	readonly process: HcProcess = {
		write: (data) => this.decoder.push(Buffer.from(data)),
		end: () => {
			this.stdinEnded = true;
		},
		kill: () => {
			this.killed = true;
			this.exit(null, 'SIGTERM');
		},
		onStdout: (handler) => this.stdout.push(handler),
		onStderr: (handler) => this.stderr.push(handler),
		onExit: (handler) => this.exits.push(handler),
	};

	/**
	 * Raw bytes to the client, optionally cut into chunks of `chunk` bytes. A
	 * write the client provokes while it is still reading (a reply to a call
	 * made from inside an event handler) is queued behind the chunk being
	 * read, as a real pipe would deliver it.
	 */
	write(bytes: Buffer, chunk = 0): void {
		const pieces: Buffer[] = [];
		if (chunk <= 0) pieces.push(bytes);
		else {
			for (let offset = 0; offset < bytes.length; offset += chunk) {
				pieces.push(Buffer.from(bytes.subarray(offset, offset + chunk)));
			}
		}
		this.outbox.push(...pieces);
		if (this.delivering) return;
		this.delivering = true;
		try {
			for (let piece = this.outbox.shift(); piece; piece = this.outbox.shift()) {
				for (const handler of this.stdout) handler(piece);
			}
		} finally {
			this.delivering = false;
		}
	}

	private readonly outbox: Buffer[] = [];
	private delivering = false;

	frame(channel: number, kind: number, payload?: Buffer | string): Buffer {
		return encodeFrame(channel, kind, payload);
	}

	rpcFrame(message: unknown): Buffer {
		return encodeFrame(0, FrameKind.Data, JSON.stringify(message));
	}

	reply(id: number, result: unknown): void {
		this.write(this.rpcFrame({ jsonrpc: '2.0', id, result }));
	}

	/** Event lines on a channel: `perFrame` lines in each DATA frame. */
	eventFrames(channel: number, messages: unknown[], perFrame = 1): Buffer {
		const frames: Buffer[] = [];
		for (let i = 0; i < messages.length; i += perFrame) {
			const text = messages
				.slice(i, i + perFrame)
				.map((message) => `${JSON.stringify(message)}\n`)
				.join('');
			frames.push(encodeFrame(channel, FrameKind.Data, text));
		}
		return Buffer.concat(frames);
	}

	stderrText(text: string): void {
		for (const handler of this.stderr) handler(Buffer.from(text));
	}

	exit(code: number | null, signal: string | null = null, error?: Error): void {
		if (this.exited) return;
		this.exited = true;
		for (const handler of this.exits) handler({ code, signal, error });
	}

	get isExited(): boolean {
		return this.exited;
	}

	/** Frames the client sent on a channel, of a kind. */
	sent(channel: number, kind?: number): Frame[] {
		return this.frames.filter((frame) => frame.channel === channel && (kind === undefined || frame.kind === kind));
	}

	private onLine(text: string): void {
		this.plainLines.push(text);
		const message = JSON.parse(text) as { id: number; method: string; params?: Record<string, unknown> };
		this.calls.push({ method: message.method, params: message.params ?? {} });
		if (this.silent) return;
		const handler = this.handlers.get(message.method);
		let reply: string;
		try {
			const result = handler ? handler(message.params ?? {}, this, message.id) : null;
			reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
			if (message.method === 'hello' && (result as { framed?: boolean })?.framed) {
				this.decoder.startFrames();
			}
		} catch (error) {
			if (!(error instanceof RpcError)) throw error;
			reply = JSON.stringify({
				jsonrpc: '2.0',
				id: message.id,
				error: { code: error.code, message: error.message, data: { kind: error.kind } },
			});
		}
		this.write(Buffer.from(`${this.banner}${reply}\n`));
	}

	private onFrame(frame: Frame): void {
		this.frames.push(frame);
		if (frame.channel !== 0 || frame.kind !== FrameKind.Data) return;
		const message = JSON.parse(frame.payload.toString('utf8')) as {
			id: number;
			method: string;
			params?: Record<string, unknown>;
		};
		this.calls.push({ method: message.method, params: message.params ?? {} });
		if (this.manual) {
			this.pendingIds.push({ id: message.id, method: message.method });
			return;
		}
		const handler = this.handlers.get(message.method);
		try {
			const result = handler ? handler(message.params ?? {}, this, message.id) : null;
			if (result instanceof Buffer) {
				// A handler that wants to put bytes right behind its reply.
				this.write(result);
				return;
			}
			this.reply(message.id, result);
		} catch (error) {
			if (!(error instanceof RpcError)) throw error;
			this.write(
				this.rpcFrame({
					jsonrpc: '2.0',
					id: message.id,
					error: { code: error.code, message: error.message, data: { kind: error.kind } },
				}),
			);
		}
	}

	/** The id of the last call to `method`. */
	lastId(method: string): number {
		const pending = this.pendingIds.filter((entry) => entry.method === method).at(-1);
		if (!pending) throw new Error(`no pending ${method}`);
		return pending.id;
	}
}

/** A spawn that hands out fake cores, newest last. */
export function fakeSpawner(setup?: (core: FakeCore) => void): { spawn: HcSpawn; cores: FakeCore[] } {
	const cores: FakeCore[] = [];
	const spawn: HcSpawn = (argv) => {
		const core = new FakeCore(argv);
		setup?.(core);
		cores.push(core);
		return core.process;
	};
	return { spawn, cores };
}

/** Lets queued microtasks and immediates run. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Timers a test fires by hand, by their delay. */
export function manualTimers() {
	const pending = new Map<number, { callback: () => void; ms: number }>();
	let next = 1;
	const timers: HcTimers = {
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

/**
 * hc's `file.read` over in-memory files, as `files.rs` answers it (0.1.18):
 * lines `offset..`, at most `limit` and at most `maxBytes` of them as JSON
 * (whole lines; a control character, `"` or `\` counts six), a trailing
 * partial line counted and sent as it stands, and `invalid_params` for an
 * offset past the end (unless 1) or a line over the cap. `maxBytes` is 8 MB
 * in hc; a test scales it down.
 */
export function fileLines(
	files: ReadonlyMap<string, string>,
	params: Record<string, unknown>,
	maxBytes = 8 << 20,
): { text: string; first: number; last: number; lines: number } {
	const path = String(params.path);
	const text = files.get(path);
	if (text === undefined) throw new RpcError('not_found', `no file ${path}`);
	const first = typeof params.offset === 'number' ? params.offset : 1;
	const limit = typeof params.limit === 'number' ? params.limit : Number.MAX_SAFE_INTEGER;
	const all = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const total = all.length;
	if (first === 0 || (first > total && first > 1)) {
		throw new RpcError('invalid_params', `offset ${first}: the file has ${total} lines`, -32602);
	}
	const jsonLength = (line: string): number =>
		Buffer.byteLength(line) + 5 * [...Buffer.from(line)].filter((b) => b < 0x20 || b === 0x22 || b === 0x5c).length;
	let out = '';
	let size = 0;
	let given = 0;
	for (const line of all.slice(first - 1, first - 1 + limit)) {
		size += jsonLength(line);
		if (size > maxBytes) break;
		out += line;
		given++;
	}
	if (given === 0 && limit > 0 && first <= total) {
		throw new RpcError('invalid_params', `line ${first} is over the cap`, -32602);
	}
	return { text: out, first, last: first + given - 1, lines: total };
}

/**
 * hc's `machine.exec` with `argv`, run for real on this machine with `env`
 * on top of the test's own environment, answered as hc answers (0.1.18):
 * `{code, signal, stdout, stderr, truncated, timed_out, ms}`, the output in
 * base64 and cut at hc's 8 MB. What a remote runs, run here instead.
 */
export function machineExec(env: Record<string, string | undefined> = {}): Handler {
	return (params) => {
		const argv = params.argv as string[];
		const run = spawnSync(argv[0] as string, argv.slice(1), {
			env: { ...process.env, ...env },
			maxBuffer: 64 << 20,
		});
		const stdout = run.stdout ?? Buffer.alloc(0);
		const max = 8 << 20;
		return {
			code: run.status,
			signal: run.signal,
			stdout: stdout.subarray(0, max).toString('base64'),
			stderr: (run.stderr ?? Buffer.alloc(0)).subarray(0, 1 << 20).toString('base64'),
			truncated: stdout.length > max,
			timed_out: false,
			ms: 1,
		};
	};
}
