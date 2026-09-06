/**
 * Shared NDJSON line framing (issue #60), used by both the API client
 * (`src/herdr/client.ts`) and the terminal bridge (`src/bridge/terminalSession.ts`).
 *
 * Pure and transport-agnostic: no Obsidian or Node imports beyond the ambient
 * `Buffer` type, so it stays importable from plain Node for tests and from
 * either transport without pulling in sockets or child processes.
 *
 * Framing rule: validate the aggregate byte length — buffered pending bytes
 * plus the incoming bytes up to the newline — before concatenating or
 * decoding, so a *completed* oversized line is rejected exactly like an
 * unfinished one. On rejection the splitter discards through the next
 * newline so the following record starts at a real boundary, and it never
 * throws itself: a caller supplies an `onOversized` callback and decides how
 * to map that into its own error type, while still receiving any valid
 * records the same chunk carried alongside the rejected one. No quadratic
 * re-concatenation: pending fragments are buffered until a line completes,
 * then joined once.
 */
export class LineSplitter {
	private pending: Buffer[] = [];
	private pendingBytes = 0;
	private discarding = false;

	constructor(readonly maxLineBytes: number) {}

	/**
	 * @param chunk raw bytes from the stream.
	 * @param onOversized called once per rejected record with its total byte
	 *   length (pending plus tail), before the splitter resumes at the next
	 *   newline. Optional; if omitted, oversized records are silently dropped.
	 * @returns complete lines (without the newline), trailing `\r` stripped.
	 */
	push(chunk: Buffer, onOversized?: (byteLength: number) => void): string[] {
		const lines: string[] = [];
		let offset = 0;
		for (;;) {
			if (this.discarding) {
				const newline = chunk.indexOf(0x0a, offset);
				if (newline === -1) {
					offset = chunk.length;
					break;
				}
				this.discarding = false;
				offset = newline + 1;
				continue;
			}
			const newline = chunk.indexOf(0x0a, offset);
			if (newline === -1) break;
			const tail = chunk.subarray(offset, newline);
			const total = this.pendingBytes + tail.length;
			if (total > this.maxLineBytes) {
				// The terminating newline for the oversized record is already at
				// hand, so the record is fully consumed: no discard state needed,
				// parsing simply resumes right after it.
				this.reset();
				onOversized?.(total);
				offset = newline + 1;
				continue;
			}
			lines.push(this.take(tail));
			offset = newline + 1;
		}
		if (!this.discarding && offset < chunk.length) {
			const rest = chunk.subarray(offset);
			const total = this.pendingBytes + rest.length;
			if (total > this.maxLineBytes) {
				this.reset();
				this.discarding = true;
				onOversized?.(total);
			} else {
				this.pending.push(rest);
				this.pendingBytes += rest.length;
			}
		}
		return lines;
	}

	/**
	 * Whatever is buffered after the stream ends, if it is non-empty and the
	 * splitter is not mid-discard (a stream that ends inside a rejected record
	 * has nothing valid left to flush).
	 */
	flush(): string | null {
		if (this.discarding || this.pendingBytes === 0) return null;
		const line = this.take(Buffer.alloc(0));
		return line.length > 0 ? line : null;
	}

	/** Drops all buffered state, including any in-progress discard. */
	reset(): void {
		this.pending = [];
		this.pendingBytes = 0;
		this.discarding = false;
	}

	private take(tail: Buffer): string {
		let line: string;
		if (this.pendingBytes === 0) {
			line = tail.toString('utf8');
		} else {
			this.pending.push(tail);
			line = Buffer.concat(this.pending, this.pendingBytes + tail.length).toString('utf8');
		}
		this.pending = [];
		this.pendingBytes = 0;
		return line.endsWith('\r') ? line.slice(0, -1) : line;
	}
}
