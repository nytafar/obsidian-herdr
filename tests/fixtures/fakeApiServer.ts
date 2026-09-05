/**
 * A stand-in for herdr's JSON API socket for client tests.
 *
 * Mirrors the framing verified in notes/herdr-api.md: one request line per
 * connection, answered once, then the connection is closed — except
 * `events.subscribe`, which acks and then streams event lines.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RecordedRequest {
	raw: string;
	id?: string;
	method?: string;
	params?: unknown;
	/** Whether the line carried a `params` key at all; herdr requires one. */
	hasParams: boolean;
}

export interface FakeApiServerOptions {
	version?: string;
	protocol?: number;
	/** Delay before answering a non-streaming request, in ms. */
	responseDelayMs?: number;
	/** Accept the connection, read the line, and never answer. */
	hang?: boolean;
	/** Answer nothing and close the connection immediately. */
	closeWithoutAnswer?: boolean;
	/** Answer with a line that is not JSON. */
	garbage?: boolean;
	/** Write every response one byte at a time. */
	chunked?: boolean;
	/** Extra method handlers; return the `result` object or throw a FakeError. */
	methods?: Record<string, (params: unknown) => unknown>;
}

/** Throw this from a handler to produce an `error` response. */
export class FakeError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export class FakeApiServer {
	readonly requests: RecordedRequest[] = [];
	/** One entry per accepted connection, to prove requests are not pipelined. */
	connections = 0;

	private server: Server | null = null;
	private directory: string | null = null;
	private path = '';
	private readonly subscribers = new Set<Socket>();

	constructor(public options: FakeApiServerOptions = {}) {}

	get socketPath(): string {
		return this.path;
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}

	async start(): Promise<string> {
		// Keep the path short: macOS caps unix socket paths near 104 bytes.
		this.directory = mkdtempSync(join(tmpdir(), 'hs-'));
		this.path = join(this.directory, 's');
		const server = createServer((socket) => this.handle(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.path, () => resolve());
		});
		return this.path;
	}

	/** Sends a push line to every live subscriber. */
	push(event: string, data: Record<string, unknown>): void {
		const line = `${JSON.stringify({ event, data })}\n`;
		for (const socket of this.subscribers) socket.write(line);
	}

	/** Writes a raw line to every live subscriber, valid JSON or not. */
	pushRaw(line: string): void {
		for (const socket of this.subscribers) socket.write(`${line}\n`);
	}

	/** Drops every subscriber connection, as a server restart would. */
	dropSubscribers(): void {
		for (const socket of this.subscribers) socket.destroy();
		this.subscribers.clear();
	}

	async stop(): Promise<void> {
		this.dropSubscribers();
		const server = this.server;
		this.server = null;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (this.directory) rmSync(this.directory, { recursive: true, force: true });
		this.directory = null;
	}

	private handle(socket: Socket): void {
		this.connections += 1;
		let buffer = '';
		socket.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			const newline = buffer.indexOf('\n');
			if (newline === -1) return;
			const line = buffer.slice(0, newline);
			buffer = '';
			// Like herdr: exactly one request line is ever read per connection.
			socket.removeAllListeners('data');
			socket.on('data', () => undefined);
			this.dispatch(socket, line);
		});
		socket.on('error', () => undefined);
		socket.on('close', () => this.subscribers.delete(socket));
	}

	private dispatch(socket: Socket, line: string): void {
		let parsed: Record<string, unknown> = {};
		try {
			parsed = JSON.parse(line) as Record<string, unknown>;
		} catch {
			this.write(socket, JSON.stringify({ id: '', error: { code: 'invalid_request', message: 'invalid request: expected ident at line 1 column 2' } }), true);
			return;
		}
		const id = typeof parsed.id === 'string' ? parsed.id : '';
		const method = typeof parsed.method === 'string' ? parsed.method : '';
		this.requests.push({ raw: line, id, method, params: parsed.params, hasParams: 'params' in parsed });

		if (this.options.hang) return;
		if (this.options.closeWithoutAnswer) {
			socket.destroy();
			return;
		}
		if (this.options.garbage) {
			this.write(socket, 'not json at all', true);
			return;
		}
		if (!('params' in parsed)) {
			this.write(socket, JSON.stringify({ id: '', error: { code: 'invalid_request', message: 'invalid request: missing field `params` at line 1 column 31' } }), true);
			return;
		}

		if (method === 'events.subscribe') {
			this.subscribers.add(socket);
			this.write(socket, JSON.stringify({ id, result: { type: 'subscription_started' } }), false);
			return;
		}

		const delay = this.options.responseDelayMs ?? 0;
		const send = (): void => {
			try {
				this.write(socket, JSON.stringify({ id, result: this.result(method, parsed.params) }), true);
			} catch (error) {
				const code = error instanceof FakeError ? error.code : 'internal_error';
				this.write(socket, JSON.stringify({ id, error: { code, message: (error as Error).message } }), true);
			}
		};
		if (delay > 0) setTimeout(send, delay);
		else send();
	}

	private result(method: string, params: unknown): unknown {
		const custom = this.options.methods?.[method];
		if (custom) return custom(params);
		switch (method) {
			case 'ping':
				return {
					type: 'pong',
					version: this.options.version ?? '0.8.0',
					protocol: this.options.protocol ?? 19,
					capabilities: { live_handoff: true, unknown_future_field: 'ignored' },
				};
			case 'workspace.list':
				return { type: 'workspace_list', workspaces: [] };
			case 'pane.list':
				return { type: 'pane_list', panes: [] };
			default:
				throw new FakeError(
					'invalid_request',
					`invalid request: unknown variant \`${method}\`, expected one of \`ping\`, \`pane.list\``,
				);
		}
	}

	private write(socket: Socket, line: string, end: boolean): void {
		const payload = `${line}\n`;
		if (this.options.chunked) {
			for (const char of payload) socket.write(char);
		} else {
			socket.write(payload);
		}
		if (end) socket.end();
	}
}
