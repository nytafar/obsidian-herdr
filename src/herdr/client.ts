/**
 * herdr JSON API client (PRD M1, M3, M4; contract in PRD section 7 and
 * notes/herdr-api.md).
 *
 * Framing, verified against herdr 0.8.0 `src/api/server.rs`:
 * the server reads exactly ONE request line per connection and never reads
 * again. Pipelining `ping` then `pane.list` on one socket returns only the pong.
 * So:
 *
 *   - `request()` opens a fresh `net.createConnection`, writes one JSON line,
 *     reads one line, and closes. No multiplexing, no keep-alive.
 *   - `events.subscribe` is the only long-lived connection: it answers
 *     `{"id":…,"result":{"type":"subscription_started"}}` and then streams
 *     event lines. That stream is what reconnects with backoff.
 *
 * Ids are still sent and echoed, but parse-stage errors come back with `id: ""`,
 * so a single-request connection matches on "the first line back", not on the id.
 *
 * Everything here is Node-side (`node:net`); it must stay importable from plain
 * node so the tests can drive it against a fake NDJSON server on a temp socket.
 */

/* eslint-disable obsidianmd/prefer-window-timers -- process-side module: it also
   runs under plain node in tests, where there is no `window`. */

import { connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import {
	HERDR_PROTOCOL,
	type HerdrMethod,
	type PaneInfo,
	type Subscription,
	type WorkspaceInfo,
} from './types.gen';

/** Request line cap on the server side; keep well under it. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
/** A single event line: layout snapshots and session snapshots can be large. */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** An error carrying herdr's own `error.code`, or a locally minted one. */
export class HerdrError extends Error {
	readonly code: string;
	readonly method?: string;

	constructor(code: string, message: string, method?: string) {
		super(message);
		this.name = 'HerdrError';
		this.code = code;
		this.method = method;
	}

	/**
	 * herdr rejects an unknown method at deserialisation time, as
	 * `invalid_request` with "unknown variant `x`, expected one of …". PRD M3
	 * wants that to disable one action, not the connection.
	 */
	get isUnsupportedMethod(): boolean {
		return this.code === 'invalid_request' && this.message.includes('unknown variant');
	}
}

/** Codes minted by the client itself, never by the server. */
export const CLIENT_ERROR_CODES = {
	timeout: 'client_timeout',
	connect: 'client_connect_failed',
	protocol: 'client_protocol_error',
	disposed: 'client_disposed',
} as const;

export interface ProtocolMismatch {
	/** Protocol the running server reports. */
	server: number;
	/** Protocol this bundle's generated types were built against. */
	expected: number;
	version: string;
}

/** Lifecycle event stream states, surfaced for the settings tab and list header. */
export type EventStreamState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface HerdrClientOptions {
	/** Unix socket path. `~` is expanded. */
	socketPath: string;
	/** Per-request timeout, connect plus response. */
	requestTimeoutMs?: number;
	/** First reconnect delay for the event stream; doubles up to the max. */
	backoffMs?: number;
	maxBackoffMs?: number;
	/**
	 * Called once per successful `ping()` whose protocol differs from the one the
	 * bundle was generated against. A warning, never a refusal (PRD M3).
	 */
	onProtocolMismatch?: (mismatch: ProtocolMismatch) => void;
	/** Protocol to compare against. Defaults to the generated `HERDR_PROTOCOL`. */
	expectedProtocol?: number;
}

/** `{"type":"pong",…}` as returned by `ping`. */
export interface PongResult {
	type: 'pong';
	version: string;
	protocol: number;
	capabilities?: Record<string, unknown> | null;
}

/**
 * A push line from the event stream. Lifecycle events use snake_case names
 * (`pane_updated`); subscription-specific events keep the dotted name
 * (`pane.agent_status_changed`). Both arrive on the same stream.
 */
export interface HerdrEvent {
	event: string;
	data: Record<string, unknown>;
}

/** Meta events the client emits itself, alongside server event names. */
export interface ClientEventMap {
	/** The event stream is up and every subscription has been re-sent. */
	connected: [];
	/** The event stream dropped; a reconnect is scheduled unless disposed. */
	disconnected: [error: Error | null];
	/** Non-fatal problem: bad line, oversized line, failed re-subscribe. */
	error: [error: Error];
}

/**
 * A generated method name, or any other string: a newer herdr knows methods this
 * bundle's schema does not, and an unknown one is an ordinary error (PRD M3).
 * The intersection keeps editor completion for the known names.
 */
export type HerdrMethodName = HerdrMethod | (string & Record<never, never>);

/** A server event name, or `'*'` for every event. */
export type EventName = string;

type EventHandler = (event: HerdrEvent) => void;
type MetaHandler = (...args: never[]) => void;
export type Unsubscribe = () => void;

/** Expands a leading `~` and nothing else; herdr paths are otherwise absolute. */
export function expandHome(path: string): string {
	if (path === '~') return homedir();
	if (path.startsWith('~/')) return `${homedir()}/${path.slice(2)}`;
	return path;
}

/** Splits a byte stream into NDJSON lines with a bounded pending buffer. */
class LineSplitter {
	private pending: Buffer[] = [];
	private pendingBytes = 0;

	constructor(private readonly maxLineBytes: number) {}

	push(chunk: Buffer): string[] {
		const lines: string[] = [];
		let offset = 0;
		let newline = chunk.indexOf(0x0a, offset);
		while (newline !== -1) {
			lines.push(this.take(chunk.subarray(offset, newline)));
			offset = newline + 1;
			newline = chunk.indexOf(0x0a, offset);
		}
		if (offset < chunk.length) {
			const rest = chunk.subarray(offset);
			this.pending.push(rest);
			this.pendingBytes += rest.length;
			if (this.pendingBytes > this.maxLineBytes) {
				this.reset();
				throw new HerdrError(CLIENT_ERROR_CODES.protocol, 'herdr sent an oversized line');
			}
		}
		return lines;
	}

	private take(tail: Buffer): string {
		if (this.pending.length === 0) return stripCr(tail.toString('utf8'));
		this.pending.push(tail);
		const line = Buffer.concat(this.pending).toString('utf8');
		this.reset();
		return stripCr(line);
	}

	reset(): void {
		this.pending = [];
		this.pendingBytes = 0;
	}
}

function stripCr(line: string): string {
	return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turns one response line into a result, or throws a `HerdrError`.
 * Unknown fields are ignored by construction: nothing is validated beyond the
 * `result` / `error` split (PRD M3).
 */
export function parseResponse<T>(line: string, method?: string): T {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new HerdrError(
			CLIENT_ERROR_CODES.protocol,
			`herdr sent a non-JSON response: ${line.slice(0, 200)}`,
			method,
		);
	}
	if (!isRecord(parsed)) {
		throw new HerdrError(CLIENT_ERROR_CODES.protocol, 'herdr sent a non-object response', method);
	}
	const error = parsed.error;
	if (isRecord(error)) {
		const code = typeof error.code === 'string' ? error.code : 'unknown';
		const message = typeof error.message === 'string' ? error.message : 'herdr returned an error';
		throw new HerdrError(code, message, method);
	}
	if (!('result' in parsed)) {
		throw new HerdrError(
			CLIENT_ERROR_CODES.protocol,
			'herdr response had neither result nor error',
			method,
		);
	}
	return parsed.result as T;
}

/** Classifies a push line. `id` present means it is an RPC reply, not an event. */
export function parseEventLine(line: string): HerdrEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || typeof parsed.event !== 'string') return null;
	const data = isRecord(parsed.data) ? parsed.data : {};
	return { event: parsed.event, data };
}

export type { Subscription };

export class HerdrClient {
	private socketPath: string;
	private readonly requestTimeoutMs: number;
	private readonly backoffMs: number;
	private readonly maxBackoffMs: number;
	private readonly expectedProtocol: number;
	private readonly onProtocolMismatch?: (mismatch: ProtocolMismatch) => void;

	private nextId = 1;
	private disposed = false;

	private stream: Socket | null = null;
	private streamState: EventStreamState = 'idle';
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private currentBackoff: number;
	private subscriptions: Subscription[] = [];
	private readonly handlers = new Map<string, Set<EventHandler | MetaHandler>>();

	/** Last mismatch seen by `ping()`, for the settings tab. */
	lastMismatch: ProtocolMismatch | null = null;

	constructor(options: HerdrClientOptions) {
		this.socketPath = expandHome(options.socketPath);
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
		this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
		this.currentBackoff = this.backoffMs;
		this.expectedProtocol = options.expectedProtocol ?? HERDR_PROTOCOL;
		this.onProtocolMismatch = options.onProtocolMismatch;
	}

	/** Socket path in use, already `~`-expanded. */
	get socket(): string {
		return this.socketPath;
	}

	get eventStreamState(): EventStreamState {
		return this.streamState;
	}

	/** Points the client at another socket. Reconnects the stream if one is up. */
	setSocketPath(path: string): void {
		const expanded = expandHome(path);
		if (expanded === this.socketPath) return;
		this.socketPath = expanded;
		if (this.stream || this.reconnectTimer) {
			this.closeStream(null);
			this.openStream();
		}
	}

	/**
	 * One request over its own connection (see the framing note at the top).
	 *
	 * @throws HerdrError with the server's `error.code`, or one of
	 *   `CLIENT_ERROR_CODES` for connect failures and timeouts.
	 */
	request<T = unknown>(method: HerdrMethodName, params: unknown = {}): Promise<T> {
		if (this.disposed) {
			return Promise.reject(
				new HerdrError(CLIENT_ERROR_CODES.disposed, 'herdr client is disposed', method),
			);
		}
		const id = String(this.nextId++);
		// `params` is mandatory even for `ping`: omitting the key is a parse error.
		const line = `${JSON.stringify({ id, method, params: params ?? {} })}\n`;
		if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
			return Promise.reject(
				new HerdrError(CLIENT_ERROR_CODES.protocol, 'request line is too large', method),
			);
		}

		return new Promise<T>((resolve, reject) => {
			const socket = connect(this.socketPath);
			const splitter = new LineSplitter(MAX_LINE_BYTES);
			let settled = false;

			const timer = setTimeout(() => {
				finish(
					new HerdrError(
						CLIENT_ERROR_CODES.timeout,
						`herdr did not answer ${method} within ${this.requestTimeoutMs} ms`,
						method,
					),
				);
			}, this.requestTimeoutMs);

			function finish(error: Error | null, result?: T): void {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				if (error) reject(error);
				else resolve(result as T);
			}

			socket.on('connect', () => {
				// The server has a read timeout on the first line: write immediately.
				socket.write(line);
			});
			socket.on('data', (chunk: Buffer) => {
				let lines: string[];
				try {
					lines = splitter.push(chunk);
				} catch (error) {
					finish(error as Error);
					return;
				}
				// Match the first line back, not the id: parse errors echo `id: ""`.
				const first = lines.find((candidate) => candidate.length > 0);
				if (first === undefined) return;
				try {
					finish(null, parseResponse<T>(first, method));
				} catch (error) {
					finish(error as Error);
				}
			});
			socket.on('error', (error: NodeJS.ErrnoException) => {
				finish(
					new HerdrError(
						CLIENT_ERROR_CODES.connect,
						`cannot reach herdr at ${this.socketPath}: ${error.message}`,
						method,
					),
				);
			});
			socket.on('close', () => {
				finish(
					new HerdrError(
						CLIENT_ERROR_CODES.protocol,
						`herdr closed the connection without answering ${method}`,
						method,
					),
				);
			});
		});
	}

	/**
	 * `ping`, and the protocol comparison PRD M3 asks for. A mismatch calls
	 * `onProtocolMismatch` and is recorded; it never rejects.
	 */
	async ping(): Promise<PongResult> {
		const pong = await this.request<PongResult>('ping', {});
		if (typeof pong.protocol === 'number' && pong.protocol !== this.expectedProtocol) {
			const mismatch: ProtocolMismatch = {
				server: pong.protocol,
				expected: this.expectedProtocol,
				version: typeof pong.version === 'string' ? pong.version : 'unknown',
			};
			this.lastMismatch = mismatch;
			this.onProtocolMismatch?.(mismatch);
		} else {
			this.lastMismatch = null;
		}
		return pong;
	}

	/** `workspace.list`. */
	async listWorkspaces(): Promise<WorkspaceInfo[]> {
		const result = await this.request<{ workspaces?: WorkspaceInfo[] }>('workspace.list', {});
		return result.workspaces ?? [];
	}

	/** `pane.list`, optionally scoped to one workspace server-side. */
	async listPanes(workspaceId?: string): Promise<PaneInfo[]> {
		const result = await this.request<{ panes?: PaneInfo[] }>('pane.list', {
			workspace_id: workspaceId ?? null,
		});
		return result.panes ?? [];
	}

	/**
	 * Registers a handler for a server event name (`pane_updated`,
	 * `pane.agent_status_changed`), for `'*'` (every event), or for one of the
	 * client meta events in `ClientEventMap`.
	 *
	 * @returns an unsubscribe function. Safe to call twice.
	 */
	on<K extends keyof ClientEventMap>(
		type: K,
		handler: (...args: ClientEventMap[K]) => void,
	): Unsubscribe;
	on(type: EventName, handler: EventHandler): Unsubscribe;
	on(type: string, handler: EventHandler | MetaHandler): Unsubscribe {
		let set = this.handlers.get(type);
		if (!set) {
			set = new Set();
			this.handlers.set(type, set);
		}
		set.add(handler);
		let live = true;
		return () => {
			if (!live) return;
			live = false;
			const current = this.handlers.get(type);
			current?.delete(handler);
			if (current && current.size === 0) this.handlers.delete(type);
		};
	}

	/**
	 * Adds subscriptions and makes sure the event stream is up. Subscriptions
	 * accumulate and are re-sent verbatim after every reconnect (PRD M4:
	 * nothing arrives before subscribing).
	 */
	subscribe(subscriptions: Subscription[]): void {
		if (this.disposed) return;
		const seen = new Set(this.subscriptions.map((sub) => JSON.stringify(sub)));
		let added = false;
		for (const sub of subscriptions) {
			const key = JSON.stringify(sub);
			if (seen.has(key)) continue;
			seen.add(key);
			this.subscriptions.push(sub);
			added = true;
		}
		if (this.stream && added) {
			// The stream connection is also single-request: new subscriptions need a
			// fresh one. Cheap, and only happens when the view set changes.
			this.closeStream(null);
			this.openStream();
			return;
		}
		if (!this.stream && !this.reconnectTimer) this.openStream();
	}

	/** Drops every subscription and closes the event stream. */
	unsubscribeAll(): void {
		this.subscriptions = [];
		this.closeStream(null);
	}

	/** Closes the event stream and refuses further requests. */
	dispose(): void {
		this.disposed = true;
		this.subscriptions = [];
		this.closeStream(null);
		this.handlers.clear();
	}

	private openStream(): void {
		if (this.disposed || this.stream || this.subscriptions.length === 0) return;
		this.streamState = this.streamState === 'reconnecting' ? 'reconnecting' : 'connecting';

		const socket = connect(this.socketPath);
		this.stream = socket;
		const splitter = new LineSplitter(MAX_LINE_BYTES);
		let acked = false;

		socket.on('connect', () => {
			const id = String(this.nextId++);
			socket.write(
				`${JSON.stringify({
					id,
					method: 'events.subscribe',
					params: { subscriptions: this.subscriptions },
				})}\n`,
			);
		});

		socket.on('data', (chunk: Buffer) => {
			let lines: string[];
			try {
				lines = splitter.push(chunk);
			} catch (error) {
				this.emitError(error as Error);
				socket.destroy();
				return;
			}
			for (const line of lines) {
				if (line.length === 0) continue;
				if (!acked) {
					acked = true;
					try {
						parseResponse(line, 'events.subscribe');
					} catch (error) {
						// A rejected subscribe is worth reporting, but the stream still
						// reconnects: the server may simply have been restarting.
						this.emitError(error as Error);
						socket.destroy();
						return;
					}
					this.streamState = 'open';
					this.currentBackoff = this.backoffMs;
					this.emitMeta('connected');
					continue;
				}
				const event = parseEventLine(line);
				if (!event) continue;
				this.dispatch(event);
			}
		});

		socket.on('error', (error: Error) => {
			if (this.stream !== socket) return;
			this.stream = null;
			this.emitMeta('disconnected', error);
			this.scheduleReconnect();
		});

		socket.on('close', () => {
			if (this.stream !== socket) return;
			this.stream = null;
			this.emitMeta('disconnected', null);
			this.scheduleReconnect();
		});
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer || this.subscriptions.length === 0) {
			if (!this.disposed && this.subscriptions.length === 0) this.streamState = 'idle';
			return;
		}
		this.streamState = 'reconnecting';
		const delay = this.currentBackoff;
		this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxBackoffMs);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.openStream();
		}, delay);
		// Never keep the process (or an Obsidian reload) waiting on a retry.
		this.reconnectTimer.unref?.();
	}

	private closeStream(error: Error | null): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		const socket = this.stream;
		this.stream = null;
		this.currentBackoff = this.backoffMs;
		this.streamState = this.disposed ? 'closed' : 'idle';
		if (socket) {
			socket.removeAllListeners();
			socket.destroy();
			if (error) this.emitMeta('disconnected', error);
		}
	}

	private dispatch(event: HerdrEvent): void {
		this.fan(this.handlers.get(event.event), event);
		this.fan(this.handlers.get('*'), event);
	}

	private fan(set: Set<EventHandler | MetaHandler> | undefined, event: HerdrEvent): void {
		if (!set) return;
		for (const handler of [...set]) {
			try {
				(handler as EventHandler)(event);
			} catch (error) {
				this.emitError(error as Error);
			}
		}
	}

	private emitMeta(type: 'connected'): void;
	private emitMeta(type: 'disconnected', error: Error | null): void;
	private emitMeta(type: string, ...args: unknown[]): void {
		const set = this.handlers.get(type);
		if (!set) return;
		for (const handler of [...set]) {
			try {
				(handler as (...rest: unknown[]) => void)(...args);
			} catch {
				// A meta handler that throws must not take the stream down.
			}
		}
	}

	private emitError(error: Error): void {
		const set = this.handlers.get('error');
		if (!set) return;
		for (const handler of [...set]) {
			try {
				(handler as (err: Error) => void)(error);
			} catch {
				// Same reasoning as emitMeta.
			}
		}
	}
}
