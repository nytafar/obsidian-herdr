/**
 * herdr-core's framed wire format (ADR-0005; [[herdr-core-api]] §1, §3).
 *
 * `hello {framed: true}` is answered as one plain JSON line; after that line
 * both directions are frames: `[channel u32 LE][kind u8][len u32 LE][payload]`,
 * a 9-byte header and at most 16 MiB of payload. Channel 0 carries JSON-RPC,
 * one message per DATA frame; attach and event channels are numbered by the
 * core from 1 per connection.
 *
 * Pure: no Node beyond `Buffer`, no process, no Obsidian. The decoder is fed
 * whatever chunks the pipe delivers, and a frame split across chunks, or
 * several frames in one, come out the same.
 */

/** Frame kinds (herdr-core `wire.rs`). */
export const FrameKind = {
	/** Core to viewer: VT bytes, or event JSON lines. Viewer to core: input. */
	Data: 0,
	/** Viewer to core: u32 LE bytes consumed. Also on event channels. */
	Credit: 1,
	/** Both ways: viewer empty; core a JSON reason or empty. */
	Close: 2,
	/** u16 LE cols, u16 LE rows; exactly four bytes. */
	Resize: 3,
	/** Viewer to core: `1` gained, `0` lost. */
	Focus: 4,
	/** Viewer to core: JSON display facts. */
	Facts: 5,
	/** Viewer to core: terminal-emulator replies; only when both ends advertise it. */
	AutomaticInput: 6,
} as const;

export type FrameKindValue = (typeof FrameKind)[keyof typeof FrameKind];

export const FRAME_HEADER_BYTES = 9;
/** The core refuses larger payloads (`wire.rs`); so does this decoder. */
export const MAX_FRAME_PAYLOAD = 16 * 1024 * 1024;
/** The plain line before framing starts is a `hello` reply; bound it anyway. */
export const MAX_PLAIN_LINE = 1024 * 1024;

export interface Frame {
	channel: number;
	kind: number;
	payload: Buffer;
}

/** One frame as bytes. `payload` defaults to empty (CLOSE). */
export function encodeFrame(channel: number, kind: number, payload?: Uint8Array | string): Buffer {
	const body =
		payload === undefined
			? Buffer.alloc(0)
			: typeof payload === 'string'
				? Buffer.from(payload, 'utf8')
				: Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
	if (body.length > MAX_FRAME_PAYLOAD) {
		throw new RangeError(`frame payload of ${body.length} bytes exceeds ${MAX_FRAME_PAYLOAD}`);
	}
	const header = Buffer.alloc(FRAME_HEADER_BYTES);
	header.writeUInt32LE(channel >>> 0, 0);
	header.writeUInt8(kind & 0xff, 4);
	header.writeUInt32LE(body.length, 5);
	return Buffer.concat([header, body]);
}

/** CREDIT: `bytes` more may be sent on `channel`. */
export function encodeCredit(channel: number, bytes: number): Buffer {
	const payload = Buffer.alloc(4);
	payload.writeUInt32LE(Math.max(0, Math.min(bytes, 0xffffffff)) >>> 0, 0);
	return encodeFrame(channel, FrameKind.Credit, payload);
}

/** RESIZE: the viewer's grid. */
export function encodeResize(channel: number, cols: number, rows: number): Buffer {
	const payload = Buffer.alloc(4);
	payload.writeUInt16LE(clampU16(cols), 0);
	payload.writeUInt16LE(clampU16(rows), 2);
	return encodeFrame(channel, FrameKind.Resize, payload);
}

/** A RESIZE payload read back, or null when it is not exactly four bytes. */
export function decodeResize(payload: Buffer): { cols: number; rows: number } | null {
	if (payload.length !== 4) return null;
	return { cols: payload.readUInt16LE(0), rows: payload.readUInt16LE(2) };
}

/** A CREDIT payload read back, or null when it is not exactly four bytes. */
export function decodeCredit(payload: Buffer): number | null {
	return payload.length === 4 ? payload.readUInt32LE(0) : null;
}

function clampU16(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(Math.floor(value), 0xffff));
}

/** What {@link FrameDecoder.push} hands back, in wire order. */
export interface DecoderSink {
	/** A plain line, before framing started. The sink may call `startFrames()` here. */
	line(text: string): void;
	frame(frame: Frame): void;
	/** The stream is unusable from here on (an oversized frame or line). */
	error(error: Error): void;
}

/**
 * Splits a byte stream into the plain lines before framing and the frames
 * after it. The switch is the caller's: it calls {@link startFrames} from the
 * `line` callback that carried the framed `hello` reply, and the bytes after
 * that line in the same chunk are already read as frames.
 */
export class FrameDecoder {
	private buffer: Buffer = Buffer.alloc(0);
	private framed = false;
	private failed = false;

	constructor(private readonly sink: DecoderSink) {}

	get isFramed(): boolean {
		return this.framed;
	}

	/** From the next byte on, the stream is frames. */
	startFrames(): void {
		this.framed = true;
	}

	push(chunk: Buffer): void {
		if (this.failed || chunk.length === 0) return;
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		let offset = 0;
		for (;;) {
			if (!this.framed) {
				const newline = this.buffer.indexOf(0x0a, offset);
				if (newline === -1) {
					if (this.buffer.length - offset > MAX_PLAIN_LINE) {
						this.fail(new Error('herdr-core sent an oversized line before framing'));
						return;
					}
					break;
				}
				let text = this.buffer.toString('utf8', offset, newline);
				if (text.endsWith('\r')) text = text.slice(0, -1);
				offset = newline + 1;
				if (text.trim().length > 0) this.sink.line(text);
				if (this.failed) return;
				continue;
			}
			if (this.buffer.length - offset < FRAME_HEADER_BYTES) break;
			const channel = this.buffer.readUInt32LE(offset);
			const kind = this.buffer.readUInt8(offset + 4);
			const length = this.buffer.readUInt32LE(offset + 5);
			if (length > MAX_FRAME_PAYLOAD) {
				this.fail(new Error(`herdr-core sent a frame of ${length} bytes`));
				return;
			}
			const end = offset + FRAME_HEADER_BYTES + length;
			if (this.buffer.length < end) break;
			// A copy: the shared buffer is sliced and dropped below.
			const payload = Buffer.from(this.buffer.subarray(offset + FRAME_HEADER_BYTES, end));
			offset = end;
			this.sink.frame({ channel, kind, payload });
			if (this.failed) return;
		}
		this.buffer = offset >= this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(offset);
	}

	private fail(error: Error): void {
		this.failed = true;
		this.buffer = Buffer.alloc(0);
		this.sink.error(error);
	}
}
