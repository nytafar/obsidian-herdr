/**
 * A terminal tab's session on a herdr-core terminal (ADR-0005): one
 * `hc connect` child process (or `ssh -T <host> … connect`) per tab, one
 * `terminal.attach` on it, behind the same {@link PaneSession} shape as
 * herdr's NDJSON bridge, so `PaneTerminal` drives either.
 *
 * What it does with the attach stream ([[herdr-core-api]] §3):
 *
 * - **First paint.** The attach reply comes before the paint, and the
 *   connection buffers frames for a channel nobody registered yet, so the
 *   paint is never lost. Every paint starts with CAN and a full reset, and is
 *   emitted as a `full` frame. The first paint of an attach carries the
 *   scrollback (`history`), so it is prefixed with an erase-scrollback: the
 *   core's history, with its colours, replaces whatever text the tab replayed
 *   from before a suspend.
 * - **Credit.** The core sends 256 KiB, then waits for credit. The tab returns
 *   credit through {@link HcTerminalSession.consumed} once the bytes are
 *   written into the renderer, so a renderer that falls behind slows the
 *   stream instead of growing a queue; a viewer more than 4 MiB behind gets a
 *   fresh repaint from the core.
 * - **Control and observe.** Control attaches as a viewer, which takes the
 *   shared terminal's size at once (last active viewer wins); it types with
 *   DATA, resizes with RESIZE and tells the core its cell size with FACTS.
 *   Emulator replies (DA, DSR, …) go as AUTOMATIC_INPUT when both the hello
 *   and the attach advertise it, else as DATA. Observe attaches with
 *   `observe: true` and `resize_notifications: true`, and never sends input
 *   or a resize; the core would drop them anyway.
 * - **The grid.** The stream is the program's own bytes at the terminal's one
 *   size, so the tab's renderer follows it: an observer from the RESIZE
 *   notifications (or the `size` event when a core cannot notify), a
 *   controller from `size` events that are not its own, which means another
 *   viewer typed or resized last. Emitted as `grid`.
 * - **Ends.** A CLOSE with a reason is the program ending; the tab shows it.
 *   A `restarted` terminal (a kept one after a loss) is attached again on its
 *   own; `finished` and `removed` end the session for good. When the
 *   `hc connect` process dies after an attach, or the core closes the stream
 *   without a reason, the session dials again with backoff and attaches with
 *   `resumed: true`, so it does not take the size from someone else.
 * - **Seen.** A filtered `events.subscribe {terminal}` on the same connection
 *   keeps the terminal's record (turn, labels, status), and a
 *   {@link SeenTracker} writes `herdr.seen=<turn>` while the view says a
 *   person is looking.
 *
 * Wheel scrolling is the renderer's: hc has no scroll method, so
 * {@link HcTerminalSession.scroll} answers false and the renderer scrolls its
 * own scrollback (or encodes the wheel for a program that asked for mouse
 * reports).
 *
 * No Obsidian import; the process and the timers are injected.
 */

import type {
	FrameMeta,
	TerminalSessionEventMap,
	TerminalSessionMode,
} from '../bridge/terminalSession';
import { clearTimer, setTimer } from '../timers';
import { HcConnection, HcError, type HcSpawn } from './connection';
import { LABEL_SEEN, TerminalStore, parseTerminal } from './model';
import { SeenTracker } from './seen';
import {
	attachTerminal,
	subscribeEvents,
	type EventSubscription,
	type HcAttachStream,
	type HcCloseReason,
	type HcEvent,
} from './streams';

/** Scrollback lines in the first paint, as herdr-app asks for. */
export const ATTACH_HISTORY_LINES = 2000;
/** First and longest wait before dialling or attaching again. */
export const RETRY_INITIAL_MS = 1000;
export const RETRY_MAX_MS = 30_000;
/** How long `dispose` waits for the child after stdin EOF (it is killed at 1 s). */
const DISPOSE_WAIT_MS = 1500;
/** Input is sent in frames of at most this much. */
const INPUT_CHUNK_BYTES = 64 * 1024;
/** Own sizes still in flight that a `size` event may echo. */
const RECENT_SIZES = 4;

const CAN = 0x18;
/** Erase the scrollback: the first paint brings the core's own. */
const ERASE_SCROLLBACK = Buffer.from('\x1b[3J', 'latin1');

export interface HcSessionTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const defaultTimers: HcSessionTimers = {
	setTimeout: (callback, ms) => setTimer(callback, ms),
	clearTimeout: (handle) => clearTimer(handle as ReturnType<typeof setTimer>),
};

export interface HcTerminalSessionOptions {
	/**
	 * `hc connect`'s argv, or how to find it: a local runtime that has not
	 * discovered its binary yet resolves it on the first start.
	 */
	argv: readonly string[] | (() => Promise<readonly string[]>);
	/** `t7`, a name, or `machine/t7`. */
	target: string;
	mode: TerminalSessionMode;
	cols: number;
	rows: number;
	env?: NodeJS.ProcessEnv;
	spawn?: HcSpawn;
	timers?: HcSessionTimers;
	/** Scrollback lines in the first paint; {@link ATTACH_HISTORY_LINES} by default. */
	history?: number;
}

type Listener<K extends keyof TerminalSessionEventMap> = (...args: TerminalSessionEventMap[K]) => void;
type AnyListener = (...args: unknown[]) => void;

function clampDimension(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(65535, Math.max(1, Math.trunc(value)));
}

function messageOf(error: unknown): string {
	if (error instanceof HcError) return `${error.message} (${error.kind})`;
	return error instanceof Error ? error.message : String(error);
}

/**
 * The tab's status text for a program that ended. Every final ending says
 * "exited", which is what the status strip reads as nothing to reconnect to;
 * a loss (the holder went, the core stopped) does not, as the core restarts
 * a kept terminal and the session attaches again.
 */
export function describeEnd(end: HcCloseReason | null): string {
	const reason = end?.reason ?? null;
	if (reason === 'exited' || reason === null) {
		if (end?.exitCode !== null && end?.exitCode !== undefined) {
			return `the program exited with code ${end.exitCode}`;
		}
		if (end?.signal !== null && end?.signal !== undefined) return `the program exited on signal ${end.signal}`;
		return 'the program exited';
	}
	if (reason === 'killed' || reason === 'signaled') {
		const signal = end?.signal !== null && end?.signal !== undefined ? ` by signal ${end.signal}` : '';
		return `the program exited: ${reason === 'killed' ? 'killed' : 'signalled'}${signal}`;
	}
	return `the program was lost (${reason}); waiting for herdr-core to restart it`;
}

function closeReasonOf(data: unknown): HcCloseReason {
	const value = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
	return {
		reason: typeof value.reason === 'string' ? value.reason : null,
		exitCode: typeof value.exit_code === 'number' ? value.exit_code : null,
		signal: typeof value.signal === 'number' || typeof value.signal === 'string' ? value.signal : null,
	};
}

/** The terminal record's grid, when it carries one. */
function gridOf(record: unknown): { cols: number; rows: number } | null {
	const value = (typeof record === 'object' && record !== null ? record : {}) as Record<string, unknown>;
	const { cols, rows } = value;
	return typeof cols === 'number' && typeof rows === 'number' && cols > 0 && rows > 0 ? { cols, rows } : null;
}

/** A copy, never a view on the decoder's chunk (see the herdr bridge's `decodeBase64`). */
function copyBytes(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

export class HcTerminalSession {
	private readonly options: HcTerminalSessionOptions;
	private readonly timers: HcSessionTimers;
	private readonly listeners = new Map<string, Set<AnyListener>>();
	private readonly store = new TerminalStore();
	private readonly seen: SeenTracker;

	private connection: HcConnection | null = null;
	/** Settles when {@link connection}'s process is gone. */
	private connectionGone: Promise<void> = Promise.resolve();
	/** The connection an attach last succeeded on: its death is worth a redial. */
	private attachedOn: HcConnection | null = null;
	private stream: HcAttachStream | null = null;
	private subscription: EventSubscription | null = null;
	/** The attach whose bytes are shown; an older stream's are dropped. */
	private token = 0;
	/** Bytes of the current attach delivered and not yet credited back. */
	private outstanding = 0;
	/** Credit owed while the attach reply had not been read yet. */
	private creditBacklog = 0;
	private frameSeq = 0;
	private address: string | null = null;

	private lastCols: number;
	private lastRows: number;
	private cell: [number, number] | null = null;
	private readonly recentSizes: { cols: number; rows: number }[] = [];
	/** The shared grid last emitted as not this session's own. */
	private foreignGrid: { cols: number; rows: number } | null = null;

	private started = false;
	private disposed = false;
	/** Ended for good: nothing to attach to any more. */
	private ended = false;
	private everAttached = false;
	/** A `closed` is showing that a later attach has to take back. */
	private closedShown: string | null = null;
	/** The stream closed with a reason; a `restarted` attaches again. */
	private awaitingRestart = false;
	private retryTimer: unknown = null;
	private backoff = RETRY_INITIAL_MS;
	private disposing: Promise<void> | null = null;

	constructor(options: HcTerminalSessionOptions) {
		this.options = options;
		this.timers = options.timers ?? defaultTimers;
		this.lastCols = clampDimension(options.cols);
		this.lastRows = clampDimension(options.rows);
		this.seen = new SeenTracker((turn) => this.writeSeen(turn));
	}

	get mode(): TerminalSessionMode {
		return this.options.mode;
	}

	get size(): { cols: number; rows: number } {
		return { cols: this.lastCols, rows: this.lastRows };
	}

	/** Whether input would reach the program now. */
	get writable(): boolean {
		return this.options.mode === 'control' && this.stream !== null && !this.disposed;
	}

	on<K extends keyof TerminalSessionEventMap>(event: K, listener: Listener<K>): this {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener as unknown as AnyListener);
		return this;
	}

	off<K extends keyof TerminalSessionEventMap>(event: K, listener: Listener<K>): this {
		this.listeners.get(event)?.delete(listener as unknown as AnyListener);
		return this;
	}

	/** Dials and attaches. Safe to call once; later calls are ignored. */
	start(): this {
		if (this.started || this.disposed) return this;
		this.started = true;
		void this.connect(false);
		return this;
	}

	/** Keystrokes and pastes: DATA, human activity. Control mode only. */
	input(data: string | Uint8Array): boolean {
		const stream = this.stream;
		if (!stream || this.options.mode !== 'control' || this.disposed) return false;
		const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
		for (let at = 0; at < bytes.length; at += INPUT_CHUNK_BYTES) {
			stream.write(bytes.subarray(at, at + INPUT_CHUNK_BYTES));
		}
		return true;
	}

	/** Emulator replies: AUTOMATIC_INPUT when both ends support it, else DATA. */
	reply(data: string | Uint8Array): boolean {
		const stream = this.stream;
		if (!stream || this.options.mode !== 'control' || this.disposed) return false;
		stream.reply(data);
		return true;
	}

	/**
	 * The renderer's grid. A controller sends it as RESIZE (and its cell size
	 * as FACTS), which takes the shared terminal's size; an observer only
	 * remembers it for its next attach, which never resizes anything.
	 */
	resize(cols: number, rows: number, cellWidthPx?: number, cellHeightPx?: number): boolean {
		this.lastCols = clampDimension(cols);
		this.lastRows = clampDimension(rows);
		const cell = this.cellOf(cellWidthPx, cellHeightPx);
		const cellChanged = cell !== null && (this.cell?.[0] !== cell[0] || this.cell?.[1] !== cell[1]);
		if (cell) this.cell = cell;
		const stream = this.stream;
		if (this.options.mode !== 'control' || !stream || this.disposed) return false;
		this.noteOwnSize();
		stream.resize(this.lastCols, this.lastRows);
		if (cellChanged && cell) stream.facts({ cell });
		return true;
	}

	/** hc has no scroll method: the renderer scrolls its own scrollback. */
	scroll(): boolean {
		return false;
	}

	/** Bytes written into the renderer: hands that much credit back. */
	consumed(bytes: number): void {
		const credit = Math.min(Math.max(0, Math.trunc(bytes)), this.outstanding);
		if (credit <= 0) return;
		this.outstanding -= credit;
		if (this.stream) this.stream.credit(credit);
		else this.creditBacklog += credit;
	}

	/**
	 * A fresh full paint, for a renderer rebuilt under a live session: the
	 * stream is the program's raw bytes, so a new terminal needs the core's
	 * screen, not the text the old one held. Attached again with
	 * `resumed: true`, before the old stream is let go, so the size stays put.
	 */
	repaint(): void {
		if (this.disposed || this.ended || !this.connection || !this.stream) return;
		void this.attach(this.connection, true).catch((error: unknown) => this.fail(error));
	}

	/** Whether a person is in front of this tab: shares `herdr.seen` while so. */
	setLooking(looking: boolean): void {
		this.seen.setLooking(looking);
	}

	/**
	 * Detaches, closes the connection and waits (briefly) for the child to go.
	 * Idempotent; nothing is emitted after it.
	 */
	dispose(): Promise<void> {
		if (this.disposing) return this.disposing;
		this.disposed = true;
		const gone = this.connectionGone;
		this.teardown();
		this.disposing = new Promise<void>((resolve) => {
			const timer = this.timers.setTimeout(resolve, DISPOSE_WAIT_MS);
			void gone.then(() => {
				this.timers.clearTimeout(timer);
				resolve();
			});
		}).then(() => {
			this.listeners.clear();
		});
		return this.disposing;
	}

	private cellOf(width?: number, height?: number): [number, number] | null {
		if (width === undefined || height === undefined) return null;
		if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
		return [Math.round(width), Math.round(height)];
	}

	private noteOwnSize(): void {
		const last = this.recentSizes.at(-1);
		if (last?.cols === this.lastCols && last.rows === this.lastRows) return;
		this.recentSizes.push({ cols: this.lastCols, rows: this.lastRows });
		if (this.recentSizes.length > RECENT_SIZES) this.recentSizes.shift();
	}

	private async connect(automatic: boolean): Promise<void> {
		let argv: readonly string[];
		try {
			argv = typeof this.options.argv === 'function' ? await this.options.argv() : this.options.argv;
		} catch (error) {
			this.fail(error);
			return;
		}
		if (this.disposed || this.ended) return;
		let markGone!: () => void;
		this.connectionGone = new Promise<void>((resolve) => {
			markGone = resolve;
		});
		const connection = new HcConnection({
			argv,
			env: this.options.env,
			spawn: this.options.spawn,
			onExit: (error) => {
				markGone();
				this.onConnectionExit(connection, error);
			},
		});
		this.connection = connection;
		try {
			await connection.open();
			if (this.connection !== connection) return;
			const mismatch = connection.mismatch;
			if (mismatch) {
				this.emit(
					'stderr',
					`herdr-core ${mismatch.version} speaks generation ${mismatch.server ?? 'unknown'}, this plugin ${mismatch.expected}`,
				);
			}
			await this.attach(connection, automatic);
		} catch (error) {
			if (this.connection !== connection) return;
			this.fail(error);
		}
	}

	private async attach(connection: HcConnection, resumed: boolean): Promise<void> {
		const token = ++this.token;
		this.outstanding = 0;
		this.creditBacklog = 0;
		this.frameSeq = 0;
		const observe = this.options.mode === 'observe';
		if (!observe) this.noteOwnSize();
		const stream = await attachTerminal(
			connection,
			{
				terminal: this.address ?? this.options.target,
				cols: this.lastCols,
				rows: this.lastRows,
				history: this.options.history ?? ATTACH_HISTORY_LINES,
				observe,
				resizeNotifications: observe,
				resumed,
				...(this.cell && !observe ? { display: { cell: this.cell } } : {}),
			},
			{
				data: (bytes) => this.onData(token, bytes),
				resize: (cols, rows) => {
					if (token === this.token) this.onGrid(cols, rows);
				},
				closed: (reason, error) => this.onStreamClosed(token, reason, error),
			},
		);
		if (this.disposed || token !== this.token || this.connection !== connection) {
			stream.detach();
			return;
		}
		const previous = this.stream;
		this.stream = stream;
		previous?.detach();
		if (this.creditBacklog > 0) {
			stream.credit(this.creditBacklog);
			this.creditBacklog = 0;
		}
		this.attachedOn = connection;
		this.everAttached = true;
		this.awaitingRestart = false;
		this.backoff = RETRY_INITIAL_MS;
		const record = parseTerminal(stream.terminal);
		if (record) this.address = record.address;
		// An observer the core cannot notify follows the record and `size` events.
		if (observe && !stream.resizeNotifications) {
			const grid = gridOf(stream.terminal);
			if (grid) this.onGrid(grid.cols, grid.rows);
		}
		if (this.closedShown !== null) {
			this.closedShown = null;
			this.emit('reopened');
		}
		if (!this.subscription) await this.subscribe(connection);
	}

	private async subscribe(connection: HcConnection): Promise<void> {
		const address = this.address ?? this.options.target;
		try {
			const subscription = await subscribeEvents(
				connection,
				{ terminal: address },
				{
					snapshot: (seq, terminals) => {
						this.store.reset(seq, terminals);
						this.recordChanged();
					},
					event: (event) => this.onEvent(event),
					closed: () => {
						if (this.subscription === subscription) this.subscription = null;
					},
				},
			);
			if (this.connection !== connection || this.disposed) {
				subscription.release();
				return;
			}
			this.subscription = subscription;
		} catch (error) {
			if (this.connection === connection && !this.disposed) {
				this.emit('stderr', `herdr-core events: ${messageOf(error)}`);
			}
		}
	}

	private recordChanged(): void {
		const address = this.address ?? this.options.target;
		this.seen.update(this.store.get(address) ?? null);
	}

	private onEvent(event: HcEvent): void {
		if (this.disposed) return;
		const address = this.address ?? this.options.target;
		if (event.terminal !== undefined && event.terminal !== address) return;
		this.store.apply(event);
		const data = event.data;
		switch (event.type) {
			case 'size': {
				const grid = gridOf(data);
				// An observer with notifications gets the same as RESIZE frames.
				if (grid && !(this.options.mode === 'observe' && this.stream?.resizeNotifications)) {
					this.onGrid(grid.cols, grid.rows);
				}
				break;
			}
			case 'lost':
				if (this.awaitingRestart) this.showClosed(describeEnd(closeReasonOf(data)));
				break;
			case 'restarted':
				if (this.awaitingRestart && this.connection && !this.ended) {
					const connection = this.connection;
					void this.attach(connection, true).catch((error: unknown) => this.fail(error));
				}
				break;
			case 'finished':
				this.finish(describeEnd(closeReasonOf(data)));
				return;
			case 'removed':
				this.finish(`terminal ${this.options.target} not found (removed)`);
				return;
		}
		this.recordChanged();
	}

	private onData(token: number, bytes: Buffer): void {
		if (token !== this.token || this.disposed) return;
		const first = this.frameSeq === 0;
		const out = copyBytes(first ? [ERASE_SCROLLBACK, bytes] : [bytes]);
		this.outstanding += out.length;
		const meta: FrameMeta = {
			seq: ++this.frameSeq,
			encoding: 'ansi',
			width: this.lastCols,
			height: this.lastRows,
			full: bytes[0] === CAN,
		};
		this.emit('frame', out, meta);
	}

	/**
	 * The shared terminal's grid. A controller's own sizes (in flight, or the
	 * current one) are not news, except as the end of someone else's; anything
	 * else is the grid the renderer has to draw at.
	 */
	private onGrid(cols: number, rows: number): void {
		if (this.options.mode === 'control') {
			const own = this.recentSizes.some((size) => size.cols === cols && size.rows === rows);
			if (own) {
				if (this.foreignGrid) {
					this.foreignGrid = null;
					this.emit('grid', this.lastCols, this.lastRows);
				}
				return;
			}
		}
		if (this.foreignGrid?.cols === cols && this.foreignGrid.rows === rows) return;
		this.foreignGrid = { cols, rows };
		this.emit('grid', cols, rows);
	}

	private onStreamClosed(token: number, reason: HcCloseReason | null, error: Error | null): void {
		if (token !== this.token) return;
		this.stream = null;
		if (this.disposed || this.ended) return;
		// The connection went: its exit handler redials.
		if (error) return;
		if (reason) {
			this.showClosed(describeEnd(reason));
			if (!this.subscription) {
				this.finish(null);
				return;
			}
			this.awaitingRestart = true;
			return;
		}
		// Closed with no reason and not by us: attach again.
		this.scheduleRetry('herdr-core closed the stream');
	}

	private onConnectionExit(connection: HcConnection, error: Error | null): void {
		if (connection !== this.connection) return;
		this.connection = null;
		this.stream = null;
		this.subscription = null;
		if (this.disposed || this.ended) return;
		// Before an attach, `connect` reports the failure itself.
		if (this.attachedOn !== connection) return;
		this.scheduleRetry(`herdr-core connection lost: ${error?.message ?? 'closed'}`);
	}

	/** A failed dial or attach: final when the terminal is gone, else retried once attached. */
	private fail(error: unknown): void {
		if (this.disposed || this.ended) return;
		if (error instanceof HcError && error.kind === 'not_found') {
			this.finish(`terminal ${this.options.target} not found`);
			return;
		}
		if (error instanceof HcError && error.kind === 'finished') {
			this.finish(`the program exited: ${error.message}`);
			return;
		}
		if (this.everAttached) {
			this.scheduleRetry(messageOf(error));
			return;
		}
		this.finish(messageOf(error));
	}

	private scheduleRetry(message: string): void {
		if (this.retryTimer !== null || this.disposed || this.ended) return;
		this.showClosed(`${message}; trying again`);
		const delay = this.backoff;
		this.backoff = Math.min(this.backoff * 2, RETRY_MAX_MS);
		this.retryTimer = this.timers.setTimeout(() => {
			this.retryTimer = null;
			if (this.disposed || this.ended) return;
			const connection = this.connection;
			if (connection && !connection.isEnded) {
				void this.attach(connection, true).catch((error: unknown) => this.fail(error));
			} else {
				this.connection = null;
				void this.connect(true);
			}
		}, delay);
	}

	private showClosed(reason: string): void {
		if (this.closedShown === reason) return;
		this.closedShown = reason;
		this.emit('closed', reason);
	}

	/** Ends the session for good: says why, lets everything go, then `exit`. */
	private finish(reason: string | null): void {
		if (this.ended || this.disposed) return;
		this.ended = true;
		if (reason) this.showClosed(reason);
		this.teardown();
		this.emit('exit', null, null);
	}

	private teardown(): void {
		if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.token++;
		const stream = this.stream;
		this.stream = null;
		stream?.detach();
		this.subscription?.release();
		this.subscription = null;
		const connection = this.connection;
		this.connection = null;
		connection?.close();
	}

	private writeSeen(turn: number): Promise<unknown> {
		const connection = this.connection;
		const address = this.address;
		if (!connection || !address || this.disposed) return Promise.reject(new Error('not attached'));
		return connection.request('terminal.label', { terminal: address, labels: { [LABEL_SEEN]: String(turn) } });
	}

	private emit<K extends keyof TerminalSessionEventMap>(event: K, ...args: TerminalSessionEventMap[K]): void {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const listener of [...set]) {
			try {
				(listener as unknown as Listener<K>)(...args);
			} catch (error) {
				if (event !== 'error') this.emit('error', error instanceof Error ? error : new Error(String(error)));
			}
		}
	}
}
