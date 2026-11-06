/**
 * The herdr-core runtime client (ADR-0005): one framed connection for
 * JSON-RPC and the event subscription, kept up across a core restart or a
 * dropped SSH line.
 *
 * It plays the part `HerdrClient` plays for herdr in the connection
 * coordinator (`../connection.ts`): `ping()` is the handshake, `subscribe()`
 * starts the event stream, `connected` fires after every successful
 * subscribe (the coordinator primes on it) and `disconnected` when the stream
 * goes. In between, `snapshot` and `event` carry the stream in wire order for
 * the scope (`./scope.ts`).
 *
 * - **Reconnect.** When the process exits or the event channel closes, the
 *   client redials with a backoff (1 s doubling to 30 s), says `hello` again
 *   and resubscribes; the new snapshot replaces the old state, since seq
 *   restarts with each core process ([[herdr-core-api]] §4).
 * - **Heartbeat watchdog.** The core sends a heartbeat every 15 s when it has
 *   nothing else; a stream silent for {@link STALL_MS} is treated as dropped.
 * - **Generation mismatch** is reported once and never refuses (ADR-0005).
 */

import {
	HcConnection,
	type HcHello,
	type HcMismatch,
	type HcSpawn,
} from './connection';
import { clearTimer, setTimer } from '../timers';
import { attachTerminal, subscribeEvents, type EventSubscription, type HcEvent } from './streams';

/** First redial delay, doubled per failure up to {@link RECONNECT_MAX_MS}. */
export const RECONNECT_INITIAL_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/** Three missed 15 s heartbeats and a margin. */
export const STALL_MS = 50_000;

export interface HcClientEventMap {
	/** The event stream is up (first subscribe, or after a redial). */
	connected: [];
	/** The stream or the process went; a redial is scheduled unless disposed. */
	disconnected: [error: Error | null];
	/** A snapshot that replaces all state: the subscribe reply, or `missed`. */
	snapshot: [seq: number, terminals: unknown[]];
	event: [event: HcEvent];
}

export interface HcTimers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const defaultTimers: HcTimers = {
	set: (callback, ms) => setTimer(callback, ms),
	clear: (handle) => clearTimer(handle as ReturnType<typeof setTimer>),
};

export interface HcClientOptions {
	/** `hc connect`, or the `ssh -T … connect` line. */
	argv: readonly string[];
	env?: NodeJS.ProcessEnv;
	spawn?: HcSpawn;
	timers?: HcTimers;
	/** Called once per client when the core speaks another generation. */
	onMismatch?: (mismatch: HcMismatch) => void;
}

export type HcClientState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disposed';

export class HcClient {
	private connection: HcConnection | null = null;
	private opening: Promise<HcHello> | null = null;
	private subscription: EventSubscription | null = null;
	private streaming = false;
	private disposed = false;
	private retryTimer: unknown = null;
	private stallTimer: unknown = null;
	private backoff = RECONNECT_INITIAL_MS;
	private mismatchReported = false;
	private lastErrorValue: Error | null = null;
	private stateValue: HcClientState = 'idle';
	private readonly handlers = new Map<string, Set<(...args: never) => void>>();
	private readonly timers: HcTimers;

	constructor(private readonly options: HcClientOptions) {
		this.timers = options.timers ?? defaultTimers;
	}

	get argv(): readonly string[] {
		return this.options.argv;
	}

	get state(): HcClientState {
		return this.stateValue;
	}

	/** The last connection's `hello`, or null before the first. */
	get hello(): HcHello | null {
		return this.connection?.hello ?? null;
	}

	get mismatch(): HcMismatch | null {
		return this.connection?.mismatch ?? null;
	}

	get lastError(): Error | null {
		return this.lastErrorValue;
	}

	/** The herdr kind's socket; herdr-core's transport finds its own. */
	get socket(): string {
		return '';
	}

	on<K extends keyof HcClientEventMap>(type: K, handler: (...args: HcClientEventMap[K]) => void): () => void {
		let set = this.handlers.get(type);
		if (!set) {
			set = new Set();
			this.handlers.set(type, set);
		}
		const stored = handler as unknown as (...args: never) => void;
		set.add(stored);
		return () => {
			this.handlers.get(type)?.delete(stored);
		};
	}

	/**
	 * Opens the connection (spawn and `hello`) if it is not open. Rejects with
	 * a readable error when the binary is missing or the host unreachable.
	 */
	ping(): Promise<HcHello> {
		if (this.disposed) return Promise.reject(new Error('herdr-core client disposed'));
		const live = this.connection;
		if (live && !live.isEnded && live.hello) return Promise.resolve(live.hello);
		return this.open();
	}

	/** Starts the event stream; it stays up, redialling, until {@link dispose}. */
	subscribe(): void {
		if (this.disposed || this.streaming) return;
		this.streaming = true;
		void this.startStream();
	}

	/** One JSON-RPC call over the connection as it is now. */
	request<T>(method: string, params: unknown = {}): Promise<T> {
		const connection = this.connection;
		if (this.disposed || !connection || connection.isEnded || !connection.hello) {
			return Promise.reject(new Error('not connected to herdr-core'));
		}
		return connection.request<T>(method, params);
	}

	/**
	 * Types `text` into a terminal's program as it stands, with no Enter
	 * (#144): what an image's bracketed paste needs, which `terminal.send`
	 * cannot carry (it presses the submit key itself, and strips an embedded
	 * end-of-paste). There is no raw-input method, so this is one short
	 * attach on the terminal's own grid, `resumed` so it takes no size, its
	 * output ignored, the bytes as AUTOMATIC_INPUT where both ends have it
	 * (not a person's activity, so a `terminal.send` right after it is not
	 * held for hc's quiet period) and as DATA on a core without it, then
	 * CLOSE. Frames go out in order on the one pipe, so the input is in before
	 * anything sent after this resolves (measured 2026-11-06, hc 0.1.18,
	 * `docs/architecture.md`, "Images in prompts"). Rejects, sending nothing,
	 * when `terminal.get` gives no size, so typing never changes the grid.
	 * Also how a dialog answer types (#164, `hcScreenAccess`).
	 */
	async input(terminal: string, text: string): Promise<void> {
		const connection = this.connection;
		if (this.disposed || !connection || connection.isEnded || !connection.hello) {
			throw new Error('not connected to herdr-core');
		}
		const record = await connection.request<{ cols?: unknown; rows?: unknown } | null>('terminal.get', {
			terminal,
		});
		// Never a guessed grid: on a core without AUTOMATIC_INPUT the bytes go
		// as DATA, which makes this attach the size leader at its cols/rows.
		const cols = typeof record?.cols === 'number' && record.cols > 0 ? record.cols : null;
		const rows = typeof record?.rows === 'number' && record.rows > 0 ? record.rows : null;
		if (cols === null || rows === null) throw new Error('herdr-core did not say the terminal’s size');
		const stream = await attachTerminal(
			connection,
			{ terminal, cols, rows, history: 0, resumed: true },
			{ data: () => undefined, closed: () => undefined },
		);
		stream.reply(text);
		stream.detach();
	}

	/** Whether the core lists `method` in its `hello`; false while not connected. */
	hasMethod(method: string): boolean {
		return this.connection?.hello?.methods.includes(method) === true;
	}

	/** Nothing to do: there is no socket path (ADR-0005). */
	setSocketPath(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stateValue = 'disposed';
		this.clearTimer('retry');
		this.clearTimer('stall');
		this.subscription?.release();
		this.subscription = null;
		this.connection?.close();
		this.connection = null;
		this.handlers.clear();
	}

	private open(): Promise<HcHello> {
		if (this.opening) return this.opening;
		this.stateValue = this.stateValue === 'idle' ? 'connecting' : this.stateValue;
		const connection = new HcConnection({
			argv: this.options.argv,
			env: this.options.env,
			spawn: this.options.spawn,
			onExit: (error) => this.onConnectionEnded(connection, error),
		});
		this.connection = connection;
		const opening = connection.open().then(
			(hello) => {
				const mismatch = connection.mismatch;
				if (mismatch && !this.mismatchReported) {
					this.mismatchReported = true;
					this.options.onMismatch?.(mismatch);
				}
				return hello;
			},
			(error: unknown) => {
				// A handshake that failed leaves nothing worth keeping open.
				connection.close();
				throw error instanceof Error ? error : new Error(String(error));
			},
		);
		this.opening = opening;
		void opening.then(
			() => {
				if (this.opening === opening) this.opening = null;
			},
			() => {
				if (this.opening === opening) this.opening = null;
			},
		);
		return opening;
	}

	private async startStream(): Promise<void> {
		if (this.disposed) return;
		try {
			await this.ping();
			const connection = this.connection;
			if (this.disposed || !connection) return;
			const subscription = await subscribeEvents(
				connection,
				{},
				{
					snapshot: (seq, terminals) => {
						this.touch();
						this.emit('snapshot', seq, terminals);
					},
					event: (event) => {
						this.touch();
						this.emit('event', event);
					},
					heartbeat: () => this.touch(),
					closed: (error) => this.onStreamClosed(connection, error),
				},
			);
			if (this.disposed || this.connection !== connection) {
				subscription.release();
				return;
			}
			this.subscription = subscription;
			this.backoff = RECONNECT_INITIAL_MS;
			this.lastErrorValue = null;
			this.stateValue = 'connected';
			this.emit('connected');
		} catch (error) {
			if (this.disposed) return;
			const failure = error instanceof Error ? error : new Error(String(error));
			this.lastErrorValue = failure;
			this.connection?.close();
			this.connection = null;
			this.scheduleRetry();
		}
	}

	private onStreamClosed(connection: HcConnection, error: Error | null): void {
		if (this.disposed || this.connection !== connection) return;
		this.subscription = null;
		// A closed event channel on a live process is still a lost stream: the
		// whole connection is redialled, which also covers a wedged process.
		connection.close();
		this.connection = null;
		this.dropped(error ?? new Error('herdr-core closed the event stream'));
	}

	private onConnectionEnded(connection: HcConnection, error: Error | null): void {
		if (this.disposed || this.connection !== connection) return;
		this.connection = null;
		this.subscription = null;
		if (this.stateValue === 'connected') this.dropped(error);
	}

	private dropped(error: Error | null): void {
		this.clearTimer('stall');
		this.lastErrorValue = error;
		const wasConnected = this.stateValue === 'connected';
		if (wasConnected) this.emit('disconnected', error);
		this.scheduleRetry();
	}

	private scheduleRetry(): void {
		if (this.disposed || !this.streaming) return;
		this.stateValue = 'reconnecting';
		if (this.retryTimer !== null) return;
		const delay = this.backoff;
		this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
		this.retryTimer = this.timers.set(() => {
			this.retryTimer = null;
			void this.startStream();
		}, delay);
	}

	/** Any sign of life on the stream pushes the stall deadline out. */
	private touch(): void {
		this.clearTimer('stall');
		if (this.disposed) return;
		this.stallTimer = this.timers.set(() => {
			this.stallTimer = null;
			const connection = this.connection;
			if (!connection || this.disposed) return;
			this.subscription?.release();
			this.subscription = null;
			connection.close();
			this.connection = null;
			this.dropped(new Error('herdr-core stopped sending heartbeats'));
		}, STALL_MS);
	}

	private clearTimer(which: 'retry' | 'stall'): void {
		const handle = which === 'retry' ? this.retryTimer : this.stallTimer;
		if (handle === null) return;
		this.timers.clear(handle);
		if (which === 'retry') this.retryTimer = null;
		else this.stallTimer = null;
	}

	private emit<K extends keyof HcClientEventMap>(type: K, ...args: HcClientEventMap[K]): void {
		const set = this.handlers.get(type);
		if (!set) return;
		for (const handler of [...set]) {
			try {
				(handler as unknown as (...rest: HcClientEventMap[K]) => void)(...args);
			} catch {
				// A bad listener must not take the stream down.
			}
		}
	}
}

/** POSIX single-quoting for one word of a remote command line. */
export function shellQuote(word: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The remote half of `ssh -T host …`: the runtime's binary when it names one
 * (a leading `~/` is the remote home), else herdr-core's own lookup — `hc` or
 * `herdr-core` on the PATH, then `~/.local/bin` — which is how the core
 * itself dials a machine (`machines.rs`), because non-interactive SSH rarely
 * has the login PATH. Wrapped in `sh -c` so a fish or nu login shell parses
 * it the same way.
 */
export function remoteConnectCommand(binary: string): string {
	const trimmed = binary.trim();
	let script: string;
	if (trimmed) {
		const path = trimmed.startsWith('~/') ? `"$HOME"/${shellQuote(trimmed.slice(2))}` : shellQuote(trimmed);
		script = `exec ${path} connect`;
	} else {
		script =
			'p=$(command -v hc || command -v herdr-core) || p=$HOME/.local/bin/herdr-core; ' +
			'[ -x "$p" ] || { echo "herdr-core is not installed here" >&2; exit 127; }; ' +
			'exec "$p" connect';
	}
	return `sh -c ${shellQuote(script)}`;
}

/** SSH options for a line that must never prompt and must notice a dead peer. */
export const HC_SSH_OPTIONS = [
	'-o',
	'BatchMode=yes',
	'-o',
	'ConnectTimeout=10',
	'-o',
	'ServerAliveInterval=15',
	'-o',
	'ServerAliveCountMax=4',
] as const;

/** `ssh -T <options> <host> sh -c '… connect'`: the same transport, remotely. */
export function sshConnectArgv(host: string, binary: string): string[] {
	const target = host.trim();
	if (!target) throw new Error('the runtime has no SSH host');
	return ['ssh', '-T', ...HC_SSH_OPTIONS, target, remoteConnectCommand(binary)];
}
