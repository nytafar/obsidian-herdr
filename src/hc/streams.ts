/**
 * The two kinds of stream a herdr-core connection carries besides channel 0
 * ([[herdr-core-api]] §3, §4), over an {@link HcConnection}:
 *
 * - **Events** (`events.subscribe`): the reply holds a snapshot and a channel;
 *   the channel carries JSON lines with credit. Several lines can share one
 *   DATA frame and a line can split across frames, so the payloads go through
 *   a line splitter. Credit is 1 MiB up front, then each frame's length once
 *   it has been handled, as herdr-app does.
 * - **Attach** (`terminal.attach`): raw VT bytes on DATA, a CLOSE with the
 *   exit reason, and RESIZE to an observer that asked for notifications.
 *   Input is DATA, or AUTOMATIC_INPUT when both the core's `hello` and the
 *   attach reply advertise it; resizes are RESIZE frames; display facts are
 *   FACTS. The terminal tab (`./terminalSession.ts`) builds on
 *   {@link attachTerminal}: one connection per tab, one attach on it.
 */

import { LineSplitter } from '../herdr/lineSplitter';
import { decodeResize, encodeCredit, encodeResize, FrameKind } from './frames';
import type { ChannelHandle, HcConnection } from './connection';

/** Credit granted on an event channel before the first frame is handled. */
export const EVENTS_INITIAL_CREDIT = 1024 * 1024;
/** A `missed` snapshot holds every terminal; bound a line generously. */
const MAX_EVENT_LINE = 64 * 1024 * 1024;

/** One `event` notification's params. `data` is the type's own shape. */
export interface HcEvent {
	seq: number;
	type: string;
	/** Absent on `doc` events. */
	terminal?: string;
	data: unknown;
}

export interface EventHandlers {
	/** The subscribe reply's snapshot, and every `missed` after it: replace all state. */
	snapshot(seq: number, terminals: unknown[]): void;
	event(event: HcEvent): void;
	heartbeat?(seq: number): void;
	/** The channel ended: the core closed it, or the connection went. */
	closed(error: Error | null): void;
}

export interface EventSubscription {
	readonly channel: number;
	readonly seq: number;
	/** Stops reading; the connection itself stays up. */
	release(): void;
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Subscribes on a framed connection. The snapshot is delivered before any
 * event, and events the core sent before the reply was read are buffered by
 * the connection and delivered right after it, so nothing is lost or reordered.
 */
export async function subscribeEvents(
	connection: HcConnection,
	params: Record<string, unknown>,
	handlers: EventHandlers,
): Promise<EventSubscription> {
	const result = await connection.request<Record<string, unknown>>('events.subscribe', params);
	const seq = numberOr(result?.seq, 0);
	const channel = result?.channel;
	handlers.snapshot(seq, Array.isArray(result?.terminals) ? (result.terminals as unknown[]) : []);
	if (typeof channel !== 'number') {
		throw new Error('herdr-core answered events.subscribe without a channel (not framed?)');
	}
	const splitter = new LineSplitter(MAX_EVENT_LINE);
	let open = true;
	// Early frames are delivered inside `register`, before it returns a handle,
	// so the handlers below talk to the connection by channel number.
	let handle: ChannelHandle | null = null;
	const end = (error: Error | null): void => {
		if (!open) return;
		open = false;
		handle?.release();
		handlers.closed(error);
	};
	const handleLine = (line: string): void => {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof message !== 'object' || message === null) return;
		const { method, params: body } = message as { method?: unknown; params?: unknown };
		const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
		if (method === 'event') {
			if (typeof record.type !== 'string') return;
			handlers.event({
				seq: numberOr(record.seq, 0),
				type: record.type,
				terminal: typeof record.terminal === 'string' ? record.terminal : undefined,
				data: record.data,
			});
		} else if (method === 'missed') {
			handlers.snapshot(
				numberOr(record.seq, 0),
				Array.isArray(record.terminals) ? (record.terminals as unknown[]) : [],
			);
		} else if (method === 'heartbeat') {
			handlers.heartbeat?.(numberOr(record.seq, 0));
		}
	};
	// The up-front grant goes first, so the core never waits on the drain below.
	connection.send(channel, FrameKind.Credit, encodeCreditPayload(EVENTS_INITIAL_CREDIT));
	const registered: ChannelHandle = connection.register(channel, {
		frame: (kind, payload) => {
			if (!open) return;
			if (kind === FrameKind.Data) {
				for (const line of splitter.push(payload)) {
					if (line.length > 0) handleLine(line);
					if (!open) return;
				}
				// Handled, so the core may send that much more.
				connection.send(channel, FrameKind.Credit, encodeCreditPayload(payload.length));
			} else if (kind === FrameKind.Close) {
				end(null);
			}
		},
		ended: (error) => end(error),
	});
	handle = registered;
	if (!open) registered.release();
	return {
		channel,
		seq,
		release: () => {
			open = false;
			registered.release();
		},
	};
}

/** The 4-byte CREDIT payload (the header comes from `send`). */
function encodeCreditPayload(bytes: number): Buffer {
	return encodeCredit(0, bytes).subarray(9);
}

/** Why an attach stream ended, from the core's CLOSE payload. */
export interface HcCloseReason {
	reason: string | null;
	exitCode: number | null;
	signal: number | string | null;
}

export function parseCloseReason(payload: Buffer): HcCloseReason | null {
	if (payload.length === 0) return null;
	try {
		const value = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
		return {
			reason: typeof value.reason === 'string' ? value.reason : null,
			exitCode: typeof value.exit_code === 'number' ? value.exit_code : null,
			signal:
				typeof value.signal === 'number' || typeof value.signal === 'string' ? value.signal : null,
		};
	} catch {
		return null;
	}
}

export interface AttachOptions {
	/** `t7`, a name, or `machine/t7`. */
	terminal: string;
	cols: number;
	rows: number;
	/** Scrollback lines in the first paint. */
	history?: number;
	/** Never types or resizes; its DATA is dropped by the core. */
	observe?: boolean;
	/** For an observer: RESIZE plus a full repaint on every grid change. */
	resizeNotifications?: boolean;
	/** Reattaching after a drop: does not take size ownership. */
	resumed?: boolean;
	/** Display facts (cell size in pixels, colours) for pixel and colour queries. */
	display?: HcDisplay;
	/** No reply within this long aborts the connection (`HcConnection.request`). */
	timeoutMs?: number;
}

/** The core's `Display`: colours as `#rrggbb`, the cell as `[width, height]` pixels. */
export interface HcDisplay {
	fg?: string;
	bg?: string;
	cursor?: string;
	cell?: [number, number];
}

export interface AttachHandlers {
	/** VT bytes; the first one starts with CAN and a full repaint. Call `credit` once rendered. */
	data(bytes: Buffer): void;
	/** The terminal's grid, for an observer with notifications. */
	resize?(cols: number, rows: number): void;
	/** The stream ended: a CLOSE (reason when the program ended), or the connection went. */
	closed(reason: HcCloseReason | null, error: Error | null): void;
}

/** One attached terminal stream. */
export interface HcAttachStream {
	readonly channel: number;
	/** The terminal record the attach reply carried. */
	readonly terminal: unknown;
	/** Both ends support AUTOMATIC_INPUT, so emulator replies use it. */
	readonly automaticInput: boolean;
	readonly resizeNotifications: boolean;
	/** Keystrokes and pastes. Human activity: takes size ownership. */
	write(bytes: Uint8Array | string): void;
	/** Emulator replies (DA, DSR, …): AUTOMATIC_INPUT when supported, else DATA. */
	reply(bytes: Uint8Array | string): void;
	resize(cols: number, rows: number): void;
	focus(gained: boolean): void;
	/** Display facts (FACTS), merged per field by the core. */
	facts(display: HcDisplay): void;
	/** Returns credit for bytes consumed (rendered). */
	credit(bytes: number): void;
	/** Sends CLOSE and stops delivering. */
	detach(): void;
}

/**
 * Attaches to a terminal on a framed connection. The first paint is never
 * lost: the connection buffers the channel's frames until this registers it.
 */
export async function attachTerminal(
	connection: HcConnection,
	options: AttachOptions,
	handlers: AttachHandlers,
): Promise<HcAttachStream> {
	const params: Record<string, unknown> = {
		terminal: options.terminal,
		cols: options.cols,
		rows: options.rows,
	};
	if (options.history !== undefined) params.history = options.history;
	if (options.observe) params.observe = true;
	if (options.resizeNotifications) params.resize_notifications = true;
	if (options.resumed) params.resumed = true;
	if (options.display) params.display = options.display;
	const result = await connection.request<Record<string, unknown>>('terminal.attach', params, {
		timeoutMs: options.timeoutMs,
	});
	const channel = result?.channel;
	if (typeof channel !== 'number') throw new Error('herdr-core answered terminal.attach without a channel');
	const automaticInput = result.automatic_input === true && connection.hasFeature('automatic_input');
	let open = true;
	let handle: ChannelHandle | null = null;
	const end = (reason: HcCloseReason | null, error: Error | null): void => {
		if (!open) return;
		open = false;
		handle?.release();
		handlers.closed(reason, error);
	};
	const registered = connection.register(channel, {
		frame: (kind, payload) => {
			if (!open) return;
			if (kind === FrameKind.Data) handlers.data(payload);
			else if (kind === FrameKind.Resize) {
				const size = decodeResize(payload);
				if (size) handlers.resize?.(size.cols, size.rows);
			} else if (kind === FrameKind.Close) end(parseCloseReason(payload), null);
		},
		ended: (error) => end(null, error),
	});
	handle = registered;
	if (!open) registered.release();
	const send = (kind: number, payload?: Uint8Array | string): void => {
		if (open) connection.send(channel, kind, payload);
	};
	return {
		channel,
		terminal: result.terminal,
		automaticInput,
		resizeNotifications: result.resize_notifications === true,
		write: (bytes) => send(FrameKind.Data, bytes),
		reply: (bytes) => send(automaticInput ? FrameKind.AutomaticInput : FrameKind.Data, bytes),
		resize: (cols, rows) => send(FrameKind.Resize, encodeResize(0, cols, rows).subarray(9)),
		focus: (gained) => send(FrameKind.Focus, Buffer.from([gained ? 1 : 0])),
		facts: (display) => send(FrameKind.Facts, JSON.stringify(display)),
		credit: (bytes) => {
			if (bytes > 0) send(FrameKind.Credit, encodeCreditPayload(bytes));
		},
		detach: () => {
			if (!open) return;
			send(FrameKind.Close);
			end(null, null);
		},
	};
}

