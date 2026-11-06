/**
 * The transcript source (issue #93, ADR-0003, ADR-0006).
 *
 * Deliberately dumb: how to read a file whole and — from issue #94 — how to
 * follow it. Nothing here knows what a line means (that is the agent's parser,
 * `../agents/format.ts`), where an agent keeps its session (also the agent's
 * format) or which session is current (that is `./sessionModel.ts`). The
 * interface is "tail and read a path", which is the whole of what a runtime
 * kind supplies for a target whose transcripts are not on this machine
 * (herdr-core's `file.read` over its connection, ADR-0006).
 */

import { watch, type FSWatcher, type Stats } from 'node:fs';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { clearTimer, setTimer } from '../timers';

/**
 * Reading a transcript, on whatever host it lives. Two calls: `read` for a file
 * wanted once (a subagent's report), and `open` to follow one that is still
 * being written. Following is all this does — deciding *which* file to follow,
 * and what the lines mean, belongs to the session model and the parser.
 *
 * A runtime kind supplies one per target (`RuntimeKindAdapter.native`): herdr
 * and a local herdr-core read this machine's files ({@link
 * LocalTranscriptSource}); an SSH herdr-core will read over its connection.
 */
export interface TranscriptSource {
	/** The whole file, or null when it does not exist or cannot be read. */
	read(path: string): Promise<string | null>;
	/**
	 * Follows `path`, delivering whole lines: what the file already holds first,
	 * then every line appended to it, in order. A trailing partial line is held
	 * until its newline arrives. The file need not exist yet.
	 *
	 * `restart` is true when the file was replaced or truncated under the tail:
	 * every line delivered before is void, and the batch it comes with (which
	 * may be empty) is the file again from its start.
	 */
	open(path: string, onLines: TranscriptLines, options?: TailOptions): TranscriptStream;
}

/** What a tail delivers to; see {@link TranscriptSource.open}. */
export type TranscriptLines = (lines: string[], restart?: boolean) => void;

/** A tail in progress. Closing is idempotent and delivers nothing afterwards. */
export interface TranscriptStream {
	close(): void;
}

export interface TailOptions {
	/** Quiet period after a change before reading, so a burst is one read. */
	debounceMs?: number;
	/** Safety net: how often to look anyway, for the events `watch` misses. */
	pollMs?: number;
	/** The most bytes one read takes; a longer file is read in pieces this size. */
	chunkBytes?: number;
	/**
	 * Why the tail cannot read the file although it is there, in words for
	 * the view, or null once it can again. Only a source with limits of its
	 * own says anything (herdr-core's `file.read`, `../hc/transcriptSource.ts`);
	 * a file that is not there yet is not a problem.
	 */
	onProblem?: (problem: string | null) => void;
}

/** A burst of writes inside this window is read once. */
const DEFAULT_DEBOUNCE_MS = 50;
/**
 * How often the tail looks without having been told to. `fs.watch` misses
 * changes on some filesystems and delivers nothing at all on others, and a view
 * that silently stops following is worse than a second of latency.
 */
const DEFAULT_POLL_MS = 2000;
/**
 * One read's worth. A session runs to tens of megabytes, and the first read of
 * one is the whole file: in pieces, nothing allocates the file at once and the
 * reducer takes it a batch at a time.
 */
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;
/**
 * How much of the file's start the tail remembers, to tell the file it has
 * been reading from another one written over it in place. A transcript's first
 * line holds the session's own ids and a timestamp, so two files that agree on
 * this much are the same file.
 */
const HEAD_BYTES = 1024;

/** The transcript source for a pane on this machine. */
export class LocalTranscriptSource implements TranscriptSource {
	async read(path: string): Promise<string | null> {
		try {
			return await readFile(path, 'utf8');
		} catch {
			// A transcript that is not there yet is not an error: the session may
			// not have taken its first prompt (ADR-0003).
			return null;
		}
	}

	open(path: string, onLines: TranscriptLines, options: TailOptions = {}): TranscriptStream {
		return new LocalTranscriptTail(path, onLines, options);
	}
}

/** Which file a path names: device and inode, or null where the OS reports none. */
function fileIdentity(stats: Pick<Stats, 'dev' | 'ino'>): string | null {
	return stats.ino ? `${stats.dev}:${stats.ino}` : null;
}

/**
 * One followed file.
 *
 * A byte offset and a buffer, rather than re-reading the file: a session runs
 * to megabytes and grows by a line at a time. The buffer holds bytes, not a
 * string, because a read can end in the middle of a UTF-8 character as easily
 * as in the middle of a line.
 *
 * A transcript only ever grows, so anything else means the path names another
 * file than the one being read: **replaced** (a new inode, as a rename over it
 * leaves), **truncated** (shorter than the offset), or **rewritten in place**
 * (its first bytes differ from the ones read). Any of the three restarts the
 * tail at the beginning and tells the session model so, which drops what the
 * old file said rather than feeding the new one's middle into it.
 */
class LocalTranscriptTail implements TranscriptStream {
	private offset = 0;
	private pending = Buffer.alloc(0);
	/** The first bytes of the file as read, up to {@link HEAD_BYTES}. */
	private head = Buffer.alloc(0);
	/** Device and inode of the file being read, once it has been opened. */
	private identity: string | null = null;
	/** The next delivery is the file from its start again; see `TranscriptLines`. */
	private restartPending = false;
	private watcher: FSWatcher | null = null;
	private debounce: ReturnType<typeof setTimer> | null = null;
	private poll: ReturnType<typeof setTimer> | null = null;
	private closed = false;
	/** True while a read is in flight, so two triggers do not interleave reads. */
	private reading = false;
	/** A change that arrived while a read was in flight. */
	private again = false;
	private readonly debounceMs: number;
	private readonly pollMs: number;
	private readonly chunkBytes: number;

	constructor(
		private readonly path: string,
		private readonly onLines: TranscriptLines,
		options: TailOptions,
	) {
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
		this.chunkBytes = Math.max(1, options.chunkBytes ?? DEFAULT_CHUNK_BYTES);
		this.watch();
		this.schedulePoll();
		// The file as it stands, before anything is appended to it.
		void this.pump();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unwatch();
		if (this.debounce !== null) clearTimer(this.debounce);
		this.debounce = null;
		if (this.poll !== null) clearTimer(this.poll);
		this.poll = null;
	}

	/**
	 * Watches the file itself. It may not exist yet — Claude creates it when the
	 * first prompt lands — and watching its directory instead would fire on every
	 * other session in the same project folder, so a missing file is left to the
	 * poll, which picks it up and starts the watch then.
	 */
	private watch(): void {
		if (this.closed || this.watcher) return;
		try {
			this.watcher = watch(this.path, (event) => {
				// A rename is the path moving off the inode being watched — a
				// replace, or a delete — and on Linux the watch stays on the old
				// inode without a word, deaf to the file the path names now. Watch
				// the path again, and read: the replacement may already be there.
				if (event === 'rename') this.rewatch();
				this.trigger();
			});
			this.watcher.on('error', () => this.unwatch());
		} catch {
			this.watcher = null;
		}
	}

	private unwatch(): void {
		this.watcher?.close();
		this.watcher = null;
	}

	/** Drops the watch and puts one on whatever the path names now, if anything. */
	private rewatch(): void {
		this.unwatch();
		this.watch();
	}

	private schedulePoll(): void {
		if (this.closed) return;
		this.poll = setTimer(() => {
			this.watch();
			void this.pump();
			this.schedulePoll();
		}, this.pollMs);
	}

	/** A change: read once the writes have stopped for the debounce window. */
	private trigger(): void {
		if (this.closed || this.debounce !== null) return;
		this.debounce = setTimer(() => {
			this.debounce = null;
			void this.pump();
		}, this.debounceMs);
	}

	/** Reads from the offset to the end and delivers whatever whole lines that made. */
	private async pump(): Promise<void> {
		if (this.closed) return;
		if (this.reading) {
			this.again = true;
			return;
		}
		this.reading = true;
		try {
			await this.readFrom();
		} finally {
			this.reading = false;
		}
		if (this.again && !this.closed) {
			this.again = false;
			await this.pump();
		}
	}

	private async readFrom(): Promise<void> {
		let handle: FileHandle | null = null;
		try {
			handle = await open(this.path, 'r');
			const stats = await handle.stat();
			if (await this.replaced(handle, stats)) this.restart();
			while (!this.closed && this.offset < stats.size) {
				const chunk = Buffer.alloc(Math.min(this.chunkBytes, stats.size - this.offset));
				const { bytesRead } = await handle.read(chunk, 0, chunk.length, this.offset);
				if (bytesRead === 0) break;
				const read = chunk.subarray(0, bytesRead);
				if (this.head.length < HEAD_BYTES && this.offset === this.head.length) {
					this.head = Buffer.concat([this.head, read.subarray(0, HEAD_BYTES - this.head.length)]);
				}
				this.offset += bytesRead;
				this.pending = this.pending.length ? Buffer.concat([this.pending, read]) : read;
				this.deliver();
			}
			// A replacement with no whole line in it yet is still news: what the
			// old file said is gone either way.
			if (this.restartPending && !this.closed) {
				this.restartPending = false;
				this.onLines([], true);
			}
		} catch {
			// No file yet, or it went away: the poll looks again.
		} finally {
			await handle?.close().catch(() => {});
		}
	}

	/**
	 * Whether the path names another file than the one read so far: a new
	 * inode, a size below the offset, or a start that no longer matches. The
	 * first open only records which file it is.
	 */
	private async replaced(handle: FileHandle, stats: Stats): Promise<boolean> {
		const identity = fileIdentity(stats);
		const known = this.identity;
		this.identity = identity;
		if (known !== null && identity !== null && known !== identity) {
			// The watch is on the old inode, if it is on anything.
			this.rewatch();
			return true;
		}
		if (stats.size < this.offset) return true;
		if (!this.head.length) return false;
		const now = Buffer.alloc(this.head.length);
		const { bytesRead } = await handle.read(now, 0, now.length, 0);
		return bytesRead !== this.head.length || !now.equals(this.head);
	}

	/** Starts over at the beginning; the next delivery says so. */
	private restart(): void {
		this.offset = 0;
		this.pending = Buffer.alloc(0);
		this.head = Buffer.alloc(0);
		this.restartPending = true;
	}

	/** Splits off every complete line, keeping the unfinished tail for next time. */
	private deliver(): void {
		const lastNewline = this.pending.lastIndexOf(0x0a);
		if (lastNewline === -1) return;
		const complete = this.pending.subarray(0, lastNewline).toString('utf8');
		this.pending = this.pending.subarray(lastNewline + 1);
		const lines = complete.split('\n').filter((line) => line !== '');
		if ((!lines.length && !this.restartPending) || this.closed) return;
		const restart = this.restartPending;
		this.restartPending = false;
		this.onLines(lines, restart);
	}
}
