/**
 * The transcript source (issue #93, ADR-0003).
 *
 * Deliberately dumb: where the file is, how to read it whole, and — from issue
 * #94 — how to follow it. Nothing here knows what a line means (that is
 * `./reducer.ts`) or which session is current (that is `./sessionModel.ts`).
 * The interface is "tail and read a path", which is the whole of what an SSH
 * adapter will have to implement later.
 *
 * The path is Claude Code's own layout, `~/.claude/projects/<encoded
 * cwd>/<agent session>.jsonl`, with the encoding read off Claude Code 2.1.266
 * and checked against every project folder on this machine: every character
 * that is not a letter or a digit becomes a dash, and a name longer than 200
 * characters is cut to 200 with a hash of the whole path appended.
 */

import { watch, type FSWatcher } from 'node:fs';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { clearTimer, setTimer } from '../timers';

/** Claude Code's cap on a project folder name before it hashes the rest. */
const MAX_PROJECT_DIR = 200;

/**
 * Claude Code's string hash: `h = h * 31 + c`, wrapped to int32. Only used for
 * the tail of an over-long project folder name.
 */
function pathHash(path: string): number {
	let hash = 0;
	for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
	return hash;
}

/**
 * The folder under `~/.claude/projects` that holds the transcripts of sessions
 * started in `cwd`.
 */
export function encodeProjectDir(cwd: string): string {
	const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
	if (encoded.length <= MAX_PROJECT_DIR) return encoded;
	return `${encoded.slice(0, MAX_PROJECT_DIR)}-${Math.abs(pathHash(cwd)).toString(36)}`;
}

export interface TranscriptLocation {
	/** The pane's working directory, as herdr reports it. */
	cwd: string;
	/** herdr's `agent_session` value; empty until the first prompt. */
	agentSession: string;
	/** Home directory of the host the transcript lives on. Defaults to this one. */
	home?: string;
}

/**
 * Where a pane's current transcript is, or null when there is not one yet: a
 * freshly started Claude has no `agent_session` and no file until its first
 * turn begins (docs/architecture.md).
 */
export function transcriptPath(location: TranscriptLocation): string | null {
	if (!location.cwd || !location.agentSession) return null;
	const home = location.home ?? homedir();
	return `${home}/.claude/projects/${encodeProjectDir(location.cwd)}/${location.agentSession}.jsonl`;
}

/**
 * Reading a transcript, on whatever host it lives. Two calls: `read` for a file
 * wanted once (a subagent's report), and `open` to follow one that is still
 * being written. Following is all this does — deciding *which* file to follow,
 * and what the lines mean, belongs to the session model and the reducer.
 */
export interface TranscriptSource {
	/** The whole file, or null when it does not exist or cannot be read. */
	read(path: string): Promise<string | null>;
	/**
	 * Follows `path`, delivering whole lines: what the file already holds first,
	 * then every line appended to it, in order. A trailing partial line is held
	 * until its newline arrives. The file need not exist yet.
	 */
	open(path: string, onLines: (lines: string[]) => void, options?: TailOptions): TranscriptStream;
}

/** A tail in progress. Closing is idempotent and delivers nothing afterwards. */
export interface TranscriptStream {
	close(): void;
}

export interface TailOptions {
	/** Quiet period after a change before reading, so a burst is one read. */
	debounceMs?: number;
	/** Safety net: how often to look anyway, for the events `watch` misses. */
	pollMs?: number;
}

/** A burst of writes inside this window is read once. */
const DEFAULT_DEBOUNCE_MS = 50;
/**
 * How often the tail looks without having been told to. `fs.watch` misses
 * changes on some filesystems and delivers nothing at all on others, and a view
 * that silently stops following is worse than a second of latency.
 */
const DEFAULT_POLL_MS = 2000;

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

	open(
		path: string,
		onLines: (lines: string[]) => void,
		options: TailOptions = {},
	): TranscriptStream {
		return new LocalTranscriptTail(path, onLines, options);
	}
}

/**
 * One followed file.
 *
 * A byte offset and a buffer, rather than re-reading the file: a session runs
 * to megabytes and grows by a line at a time. The buffer holds bytes, not a
 * string, because a read can end in the middle of a UTF-8 character as easily
 * as in the middle of a line.
 *
 * A transcript only ever grows. A file that has become shorter than the offset
 * is therefore not this file any more — it is a rotation, which the session
 * model handles by opening a new tail — so the offset simply follows it down
 * and the next append is read from there.
 */
class LocalTranscriptTail implements TranscriptStream {
	private offset = 0;
	private pending = Buffer.alloc(0);
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

	constructor(
		private readonly path: string,
		private readonly onLines: (lines: string[]) => void,
		options: TailOptions,
	) {
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
		this.watch();
		this.schedulePoll();
		// The file as it stands, before anything is appended to it.
		void this.pump();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.watcher?.close();
		this.watcher = null;
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
			this.watcher = watch(this.path, () => this.trigger());
			// A watcher on a file that is replaced rather than appended to goes
			// deaf; the poll is what notices, and rebuilds it.
			this.watcher.on('error', () => {
				this.watcher?.close();
				this.watcher = null;
			});
		} catch {
			this.watcher = null;
		}
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
			const { size } = await handle.stat();
			if (size < this.offset) {
				// Not the file this tail started on any more.
				this.offset = size;
				this.pending = Buffer.alloc(0);
			}
			if (size === this.offset) return;
			const chunk = Buffer.alloc(size - this.offset);
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, this.offset);
			this.offset += bytesRead;
			this.pending = Buffer.concat([this.pending, chunk.subarray(0, bytesRead)]);
			this.deliver();
		} catch {
			// No file yet, or it went away: the poll looks again.
		} finally {
			await handle?.close().catch(() => {});
		}
	}

	/** Splits off every complete line, keeping the unfinished tail for next time. */
	private deliver(): void {
		const lastNewline = this.pending.lastIndexOf(0x0a);
		if (lastNewline === -1) return;
		const complete = this.pending.subarray(0, lastNewline).toString('utf8');
		this.pending = this.pending.subarray(lastNewline + 1);
		const lines = complete.split('\n').filter((line) => line !== '');
		if (lines.length && !this.closed) this.onLines(lines);
	}
}
