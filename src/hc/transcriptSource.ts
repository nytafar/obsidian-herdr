/**
 * herdr-core's transcript source over the runtime's own connection
 * (ADR-0006): the transcripts of an SSH hc runtime live on the remote host,
 * so they are read with `file.read {path, offset, limit}`, by line, through
 * the same `hc connect` the agent list runs on. A local hc runtime reads its
 * files directly (`../native/transcriptSource.ts`).
 *
 * What `file.read` does, from hc's `files.rs` (0.1.18) and measured live
 * (`docs/architecture.md`, "herdr-core: the native view"):
 *
 * - It reads the whole file on the core, up to 64 MB, and answers lines
 *   `offset..` (1-based), at most `limit` of them and at most 8 MB of them
 *   as JSON, whole lines only: `{text, first, last, lines}`, `lines` being
 *   the file's count. A trailing line with no newline yet counts as a line
 *   and is in `text` as it stands.
 * - An `offset` past the end is an `invalid_params` error, not an empty
 *   answer, unless it is 1. So is a single line over the 8 MB.
 *
 * How the tail uses that:
 *
 * - **Delivered lines are whole lines.** The tail counts the complete lines
 *   it delivered and never delivers a partial one; the next read starts at
 *   the last complete line, which hc sends again, finished or not.
 * - **Each read re-reads the last delivered line** (the anchor), which keeps
 *   the offset valid when nothing was appended and checks that the file still
 *   says what it said. With the head fingerprint (line 1, re-read whenever
 *   something new came) and the line count, a file **replaced or truncated**
 *   under the tail is noticed and read again from the start with
 *   `restart: true`.
 * - **Pages** follow `last` until it reaches `lines`, so a file over 8 MB is
 *   read in pieces. A line hc cannot send at all is skipped and counted.
 *   When hc refuses even line 1 (the file over 64 MB, or line 1 over 8 MB)
 *   nothing can be read or told apart, and the tail says so to the view
 *   (`TailOptions.onProblem`) instead of staying empty.
 * - **Kicks, not watches.** There is nothing to watch on another machine. A
 *   `status` or `turn` event of the terminal whose session label names the
 *   file reads it (and once more a moment later, for what Claude writes just
 *   after reporting), a new snapshot reads every open file, and a slow poll
 *   runs while that agent is working, or never reported its status at all.
 *   A slower one runs otherwise, as a safety net.
 */

import { sessionLabelOf } from '../sessionHook/label';
import { clearTimer, setTimer } from '../timers';
import type { HcTimers } from './client';
import { HcError } from './connection';
import type { HcTerminal } from './model';
import type { IngestListener } from './scope';
import type {
	TailOptions,
	TranscriptLines,
	TranscriptSource,
	TranscriptStream,
} from '../native/transcriptSource';

/**
 * What the view says when hc refuses the file itself: `file.read` answers
 * `invalid_params` for a file over 64 MB, and for line 1 over 8 MB the probe
 * that tells the other refusals apart is refused the same way.
 */
export const HC_TRANSCRIPT_UNREADABLE =
	'This transcript cannot be read over the connection: herdr-core’s file.read refuses a file over 64 MB and a first line over 8 MB. Open the terminal to follow the agent.';

/** `file.read`'s answer. */
export interface HcFileLines {
	text: string;
	first: number;
	last: number;
	lines: number;
}

/** The requester the source reads through: the runtime's `HcClient`. */
export interface HcFileReader {
	request<T>(method: string, params: unknown): Promise<T>;
}

/** The part of an `HcScope` the source reads: which terminal names which file. */
export interface HcTranscriptScope {
	terminals(): HcTerminal[];
	onIngested(listener: IngestListener): () => void;
}

export interface HcTranscriptOptions {
	timers?: HcTimers;
	/** Quiet period after a kick before reading, so a burst is one read. */
	debounceMs?: number;
	/** A second read this long after a kick. */
	settleMs?: number;
	/** How often to read while the agent works. */
	workingPollMs?: number;
	/** How often to read otherwise. */
	idlePollMs?: number;
	/** The most lines one `file.read` asks for; hc's 8 MB cap may stop it sooner. */
	pageLines?: number;
}

const DEFAULT_DEBOUNCE_MS = 50;
const DEFAULT_SETTLE_MS = 1000;
const DEFAULT_WORKING_POLL_MS = 2000;
const DEFAULT_IDLE_POLL_MS = 15_000;
export const DEFAULT_PAGE_LINES = 4000;

const defaultTimers: HcTimers = {
	set: (callback, ms) => setTimer(callback, ms),
	clear: (handle) => clearTimer(handle as ReturnType<typeof setTimer>),
};

/** Lines with their newlines, as hc counts them; a trailing partial line last. */
function splitLines(text: string): string[] {
	const out: string[] = [];
	let start = 0;
	for (;;) {
		const end = text.indexOf('\n', start);
		if (end === -1) break;
		out.push(text.slice(start, end + 1));
		start = end + 1;
	}
	if (start < text.length) out.push(text.slice(start));
	return out;
}

function isInvalidParams(error: unknown): boolean {
	return error instanceof HcError && error.kind === 'invalid_params';
}

/** The transcript source of one herdr-core connection. */
export class HcTranscriptSource implements TranscriptSource {
	private readonly tails = new Set<HcTranscriptTail>();
	private unsubscribe: (() => void) | null = null;
	readonly timers: HcTimers;
	readonly debounceMs: number;
	readonly settleMs: number;
	readonly workingPollMs: number;
	readonly idlePollMs: number;
	readonly pageLines: number;

	constructor(
		private readonly reader: HcFileReader,
		private readonly scope: HcTranscriptScope,
		options: HcTranscriptOptions = {},
	) {
		this.timers = options.timers ?? defaultTimers;
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
		this.workingPollMs = options.workingPollMs ?? DEFAULT_WORKING_POLL_MS;
		this.idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
		this.pageLines = Math.max(1, options.pageLines ?? DEFAULT_PAGE_LINES);
	}

	/** Lines `offset..` of a file on the runtime's machine. */
	readLines(path: string, offset: number, limit: number): Promise<HcFileLines> {
		return this.reader.request<HcFileLines>('file.read', { path, offset, limit });
	}

	/** The whole file, page by page; null when it is not there or not text. */
	async read(path: string): Promise<string | null> {
		try {
			let text = '';
			let offset = 1;
			for (;;) {
				const page = await this.readLines(path, offset, this.pageLines);
				text += page.text;
				if (page.last >= page.lines || page.last < offset) return text;
				offset = page.last + 1;
			}
		} catch {
			// Missing, not text, over hc's limits, or the line went: the report
			// stays unread, as a missing local file leaves it.
			return null;
		}
	}

	open(path: string, onLines: TranscriptLines, options: TailOptions = {}): TranscriptStream {
		const tail = new HcTranscriptTail(this, path, onLines, () => this.closed(tail), options);
		this.tails.add(tail);
		this.unsubscribe ??= this.scope.onIngested((address, type) => this.onIngested(address, type));
		tail.start();
		return tail;
	}

	/** The terminals whose session label names `path`. */
	terminalsFor(path: string): HcTerminal[] {
		return this.scope
			.terminals()
			.filter((terminal) => sessionLabelOf(terminal.labels)?.transcriptPath === path);
	}

	private closed(tail: HcTranscriptTail): void {
		this.tails.delete(tail);
		if (this.tails.size === 0) {
			this.unsubscribe?.();
			this.unsubscribe = null;
		}
	}

	private onIngested(address: string | null, type: string): void {
		if (address === null) {
			// A fresh snapshot: the connection came back, or the stream fell
			// behind. Whatever happened meanwhile is in the files.
			for (const tail of [...this.tails]) tail.kick();
			return;
		}
		if (type !== 'status' && type !== 'turn') return;
		for (const tail of [...this.tails]) {
			const named = this.terminalsFor(tail.path);
			// A file no label names (a path derived from the cwd) is kicked by
			// any agent, since nothing says which one writes it.
			if (named.length === 0 || named.some((terminal) => terminal.address === address)) tail.kick();
		}
	}
}

/**
 * One followed file. See the module comment for the reading rules; the
 * state is the count of complete lines delivered, the last of them (the
 * anchor) and the first (the head).
 */
class HcTranscriptTail implements TranscriptStream {
	private complete = 0;
	/** Line `complete` as delivered, newline and all; null when there is none or hc cannot send it. */
	private anchor: string | null = null;
	/** Line 1 as delivered. */
	private head: string | null = null;
	private restartPending = false;
	private closedFlag = false;
	private reading = false;
	private again = false;
	private debounce: unknown = null;
	private settle: unknown = null;
	private poll: unknown = null;

	constructor(
		private readonly source: HcTranscriptSource,
		readonly path: string,
		private readonly onLines: TranscriptLines,
		private readonly onClose: () => void,
		private readonly options: TailOptions = {},
	) {}

	private onProblem(problem: string | null): void {
		this.options.onProblem?.(problem);
	}

	/** The problem said last, so each change is said once. */
	private problem: string | null = null;

	private sayProblem(problem: string | null): void {
		if (this.closedFlag || problem === this.problem) return;
		this.problem = problem;
		this.onProblem(problem);
	}

	start(): void {
		void this.pump();
		this.schedulePoll();
	}

	close(): void {
		if (this.closedFlag) return;
		this.closedFlag = true;
		const timers = this.source.timers;
		for (const handle of [this.debounce, this.settle, this.poll]) if (handle !== null) timers.clear(handle);
		this.debounce = this.settle = this.poll = null;
		this.onClose();
	}

	/** Something may have been written: read soon, and once more a moment later. */
	kick(): void {
		if (this.closedFlag) return;
		const timers = this.source.timers;
		if (this.debounce === null) {
			this.debounce = timers.set(() => {
				this.debounce = null;
				void this.pump();
			}, this.source.debounceMs);
		}
		if (this.settle !== null) timers.clear(this.settle);
		this.settle = timers.set(() => {
			this.settle = null;
			void this.pump();
		}, this.source.settleMs);
	}

	/** Working, or never reported: the agent may be writing with nothing said. */
	private working(): boolean {
		return this.source
			.terminalsFor(this.path)
			.some((terminal) => terminal.status?.state === 'working' || (!terminal.reported && terminal.status === null));
	}

	private schedulePoll(): void {
		if (this.closedFlag) return;
		// A file followed on the side (#147) names its own pace: no terminal's
		// label names a subagent's transcript, so no status says it is written.
		const ms = this.options.pollMs ?? (this.working() ? this.source.workingPollMs : this.source.idlePollMs);
		this.poll = this.source.timers.set(() => {
			this.poll = null;
			void this.pump();
			this.schedulePoll();
		}, ms);
	}

	private async pump(): Promise<void> {
		if (this.closedFlag) return;
		if (this.reading) {
			this.again = true;
			return;
		}
		this.reading = true;
		try {
			await this.readNew();
		} catch {
			// Not connected, the line dropped, or the core said no: the next
			// kick or poll looks again.
		} finally {
			this.reading = false;
		}
		if (this.again && !this.closedFlag) {
			this.again = false;
			await this.pump();
		}
	}

	private async readNew(): Promise<void> {
		// Only this pump's first read checks the anchor; the pages after it
		// continue from what it verified.
		let verified = false;
		// The head is compared once per pump, and only when something is new.
		let headChecked = false;
		// What this pump may still deliver (#147); a page that crosses it is the
		// last, and the rest waits for the next kick or poll.
		let budget = this.options.budgetBytes ? Math.max(1, this.options.budgetBytes) : Infinity;
		while (!this.closedFlag && budget > 0) {
			const anchored = !verified && this.anchor !== null;
			const offset = anchored ? this.complete : this.complete + 1;
			let page: HcFileLines;
			try {
				page = await this.source.readLines(this.path, offset, this.source.pageLines);
			} catch (error) {
				// `not_found` (no file yet), or no connection: look again later.
				if (!isInvalidParams(error)) break;
				const verdict = await this.diagnose(offset);
				if (verdict === 'refused') {
					// Nothing to read and nothing to tell apart: say so, and look
					// again on the next kick or poll, in case the file changed.
					this.sayProblem(HC_TRANSCRIPT_UNREADABLE);
					break;
				}
				if (verdict === 'restart') {
					this.restart();
					continue;
				}
				if (verdict === 'skip') {
					// Line `offset` cannot be sent: past it, without it.
					if (offset > this.complete) this.complete = offset;
					this.anchor = null;
					continue;
				}
				break;
			}
			if (this.closedFlag) return;
			this.sayProblem(null);
			if (page.lines < this.complete) {
				this.restart();
				continue;
			}
			const lines = splitLines(page.text);
			if (anchored) {
				if (lines[0] !== this.anchor) {
					this.restart();
					continue;
				}
				lines.shift();
			}
			// What this read returned is the file as it is; the next page
			// starts right after it, at a line `page.last < page.lines` says exists.
			verified = true;
			const whole = lines.filter((line) => line.endsWith('\n'));
			if (whole.length === 0) {
				// Only the anchor fitted beside a line too big for one answer, or
				// nothing new: the next read starts past the anchor, or stops.
				if (anchored && page.last < page.lines && lines.length === 0) continue;
				break;
			}
			if (!headChecked && this.complete > 0 && offset > 1 && this.head !== null) {
				headChecked = true;
				let first: HcFileLines;
				try {
					first = await this.source.readLines(this.path, 1, 1);
				} catch {
					break;
				}
				if (this.closedFlag) return;
				if (first.text !== this.head) {
					this.restart();
					continue;
				}
			}
			if (this.complete === 0) this.head = whole[0] ?? null;
			this.complete += whole.length;
			this.anchor = whole[whole.length - 1] ?? null;
			this.deliver(whole.map((line) => line.slice(0, -1)).filter((line) => line !== ''));
			for (const line of whole) budget -= line.length;
			if (page.last >= page.lines) break;
		}
		if (this.restartPending && !this.closedFlag) this.deliver([]);
	}

	/**
	 * Why a read at `offset` was refused: the file got shorter or another one
	 * took its place (`restart`), the line there cannot be sent (`skip`),
	 * there is nothing at `offset` yet (`idle`), hc refuses even line 1, which
	 * is the file over 64 MB or line 1 over 8 MB (`refused`), or no telling
	 * (`later`).
	 */
	private async diagnose(offset: number): Promise<'restart' | 'skip' | 'idle' | 'refused' | 'later'> {
		let probe: HcFileLines;
		try {
			probe = await this.source.readLines(this.path, 1, 1);
		} catch (error) {
			return isInvalidParams(error) ? 'refused' : 'later';
		}
		if (probe.lines < this.complete) return 'restart';
		if (this.complete > 0 && this.head !== null && probe.text !== this.head) return 'restart';
		if (offset > probe.lines) return 'idle';
		return 'skip';
	}

	/** Starts over at line 1; the next delivery says so. */
	private restart(): void {
		this.complete = 0;
		this.anchor = null;
		this.head = null;
		this.restartPending = true;
	}

	private deliver(lines: string[]): void {
		if (this.closedFlag || (!lines.length && !this.restartPending)) return;
		const restart = this.restartPending;
		this.restartPending = false;
		this.onLines(lines, restart);
	}
}
