/**
 * A fake herdr-core behind `hc connect`: an {@link HcProcess} whose stdin is
 * parsed like the core parses it (a plain `hello` line, then frames) and whose
 * stdout the test writes, in whatever chunks it likes.
 */
import { encodeFrame, FrameDecoder, FrameKind, type Frame } from '../../src/hc/frames';
import type { HcProcess, HcSpawn } from '../../src/hc/connection';

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
		this.write(Buffer.from(`${reply}\n`));
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
