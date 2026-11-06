/**
 * Following a subagent while it works (#147): its own transcript, read
 * through the session's transcript source, so a view can show what it is
 * doing now and open the whole of it on request.
 *
 * Which subagents there are, and where each keeps its transcript, is the
 * agent's format's (`BackgroundReports.subagents`, `../agents/format.ts`); what
 * a line means is the format's parser, the same one the session is read with.
 * This decides what is read, and when:
 *
 * - **Only what a view shows.** Nothing is followed until the session model
 *   says a visible view shows the session; a transcript opened on request
 *   is followed while it is open, shown or not.
 * - **Incrementally and within a budget.** Each subagent is one tail on the
 *   source, which reads only what the file gained, and at most
 *   {@link SUBAGENT_READ_BUDGET} bytes per look; what is left waits for the
 *   next look. At most {@link MAX_FOLLOWED_SUBAGENTS} files are followed at
 *   once: those working first, then the newest.
 * - **Working again.** A subagent the records say stopped is working again
 *   when its own transcript is written after that: resumed by a message, it
 *   says nothing in the session's records until it stops again. One already
 *   followed is kept while it is shown; one a later call addressed is opened
 *   to find out.
 *
 * No Obsidian here; the session model owns one per file it follows.
 */

import type { AgentFormat, SubagentRef } from '../agents/format';
import type { ConversationState, SubagentProgress, TextEntry, ToolEntry } from './conversation';
import type { TranscriptSource, TranscriptStream } from './transcriptSource';
import { clearTimer, setTimer } from '../timers';

/** The most bytes one look at a subagent's transcript reads. */
export const SUBAGENT_READ_BUDGET = 1024 * 1024;
/** How many subagent transcripts are followed at once, at most. */
export const MAX_FOLLOWED_SUBAGENTS = 8;
/** How often a followed subagent's transcript is looked at without a change to say so. */
export const SUBAGENT_POLL_MS = 1000;

/** The timers the follower waits with; injectable for tests. */
export interface SubagentTimers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const defaultTimers: SubagentTimers = {
	set: (callback, ms) => setTimer(callback, ms),
	clear: (handle) => clearTimer(handle as ReturnType<typeof setTimer>),
};

/** A subagent's transcript, opened on request; see {@link SubagentFollower.open}. */
export interface SubagentTranscript {
	/** Its conversation as read so far. */
	readonly state: ConversationState;
	/** Whether it is working now. */
	readonly running: boolean;
	/** Called whenever more of it was read or it stopped or started. */
	on(listener: () => void): () => void;
	/** Lets it go; the follower stops reading it unless a view still shows it. */
	release(): void;
}

export interface SubagentFollowerOptions {
	source: TranscriptSource;
	format: AgentFormat;
	/** Some subagent's progress moved: read {@link SubagentFollower.progress} again. */
	onChange: () => void;
	timers?: SubagentTimers;
	budgetBytes?: number;
	pollMs?: number;
	maxFollowed?: number;
}

/** One subagent transcript being read. */
interface Followed {
	/** The file, or `search:<call>` while it is being looked for. */
	key: string;
	ref: SubagentRef;
	path: string;
	stream: TranscriptStream | null;
	state: ConversationState;
	/** The newest time a line of it says it was written, ms; null before one says. */
	writtenAt: number | null;
	progress: SubagentProgress;
	/** Transcripts opened on request that hold it. */
	holds: number;
	listeners: Set<() => void>;
	/** The search's retry, while its file is not found. */
	retry: unknown;
	/** Probe files already read and found to be another call's. */
	ruledOut: Set<string>;
	closed: boolean;
}

/** The last thing a subagent did, and how many calls it made, from its turns. */
function latestOf(state: ConversationState): { latest: ToolEntry | TextEntry | null; calls: number } {
	let latest: ToolEntry | TextEntry | null = null;
	let calls = 0;
	for (const turn of state.turns) {
		for (const entry of turn.entries) {
			if (entry.kind === 'tool') {
				calls++;
				latest = entry;
			} else if (entry.kind === 'text' && entry.text.trim()) latest = entry;
		}
	}
	return { latest, calls };
}

/** Where its progress stands: what the records say, or its file written since. */
function isRunning(ref: SubagentRef, writtenAt: number | null): boolean {
	if (ref.running) return true;
	return ref.stoppedAt !== null && writtenAt !== null && writtenAt > ref.stoppedAt;
}

/** The key a ref is followed under: its file, or its call while there is none. */
function keyOf(ref: SubagentRef): string {
	return ref.path || `search:${ref.callId}`;
}

/** The subagents of one session transcript, read while they are wanted. */
export class SubagentFollower {
	private readonly followed = new Map<string, Followed>();
	/** The refs as the records last named them, by key. */
	private refs = new Map<string, SubagentRef>();
	private showing = false;
	private disposed = false;
	private readonly timers: SubagentTimers;
	private readonly budgetBytes: number;
	private readonly pollMs: number;
	private readonly maxFollowed: number;

	constructor(private readonly options: SubagentFollowerOptions) {
		this.timers = options.timers ?? defaultTimers;
		this.budgetBytes = options.budgetBytes ?? SUBAGENT_READ_BUDGET;
		this.pollMs = options.pollMs ?? SUBAGENT_POLL_MS;
		this.maxFollowed = options.maxFollowed ?? MAX_FOLLOWED_SUBAGENTS;
	}

	/** The paths of the transcripts being read now, for a test or a diagnosis. */
	get following(): string[] {
		return [...this.followed.values()].filter((item) => item.stream).map((item) => item.path);
	}

	/**
	 * Takes the subagents the records name now, and whether a view shows
	 * them, and follows what that wants: opens what it newly wants, closes
	 * what it no longer does.
	 */
	sync(refs: readonly SubagentRef[], showing: boolean): void {
		if (this.disposed) return;
		this.showing = showing;
		this.refs = new Map(refs.map((ref) => [keyOf(ref), ref]));
		// A file followed under a call the search found it for keeps its key:
		// the records name the same file once the call is answered.
		for (const item of [...this.followed.values()]) {
			const ref = this.refs.get(item.key) ?? (item.path ? this.refs.get(item.path) : undefined);
			if (!ref) continue;
			const key = keyOf(ref);
			if (key !== item.key && !this.followed.has(key)) {
				this.followed.delete(item.key);
				item.key = key;
				this.followed.set(key, item);
			}
			this.retarget(item, ref);
		}
		const wanted = this.wanted();
		for (const [key, item] of [...this.followed]) {
			if (!wanted.has(key) && item.holds === 0) this.close(item);
		}
		for (const key of wanted) {
			if (this.followed.has(key)) continue;
			const ref = this.refs.get(key);
			if (ref) this.start(ref);
		}
	}

	/** A followed subagent's progress, under the call it is shown with; undefined when none is followed. */
	progress(callId: string): SubagentProgress | undefined {
		for (const item of this.followed.values()) {
			if (item.ref.callId === callId && !item.closed) return item.progress;
		}
		return undefined;
	}

	/**
	 * The transcript of the subagent shown under `callId`, followed while it is
	 * held, or null when the records name no subagent there.
	 */
	open(callId: string): SubagentTranscript | null {
		if (this.disposed) return null;
		let item = [...this.followed.values()].find((candidate) => candidate.ref.callId === callId);
		if (!item) {
			const ref = [...this.refs.values()].find((candidate) => candidate.callId === callId);
			if (!ref || !this.locatable(ref)) return null;
			item = this.start(ref);
		}
		const held = item;
		held.holds++;
		let live = true;
		return {
			get state() {
				return held.state;
			},
			get running() {
				return held.progress.running;
			},
			on: (listener) => {
				held.listeners.add(listener);
				return () => held.listeners.delete(listener);
			},
			release: () => {
				if (!live) return;
				live = false;
				held.holds--;
				held.listeners.clear();
				if (held.holds === 0 && !this.disposed) this.sync([...this.refs.values()], this.showing);
			},
		};
	}

	/** Closes every tail. */
	dispose(): void {
		this.disposed = true;
		for (const item of [...this.followed.values()]) this.close(item);
	}

	/**
	 * The keys to follow while a view shows the session: every subagent
	 * working, then those a message may have set working again, then those
	 * already followed (a stopped one may be working again), the newest
	 * first, at most {@link maxFollowed}.
	 */
	private wanted(): Set<string> {
		if (!this.showing) return new Set();
		const refs = [...this.refs.entries()].reverse().filter(([, ref]) => this.locatable(ref));
		const rank = ([key, ref]: [string, SubagentRef]): number =>
			ref.running ? 0 : ref.resumed ? 1 : this.followed.has(key) ? 2 : 3;
		const ranked = refs.filter((pair) => rank(pair) < 3).sort((a, b) => rank(a) - rank(b));
		return new Set(ranked.slice(0, this.maxFollowed).map(([key]) => key));
	}

	/**
	 * Whether its transcript can be found from here: the records name it, or
	 * the source can list the folder it is in. A synchronous subagent on a
	 * source that cannot list is not followed until its answer names it.
	 */
	private locatable(ref: SubagentRef): boolean {
		return ref.path !== '' || (ref.search !== null && typeof this.options.source.list === 'function');
	}

	private start(ref: SubagentRef): Followed {
		const item: Followed = {
			key: keyOf(ref),
			ref,
			path: ref.path,
			stream: null,
			state: this.options.format.parser.empty(),
			writtenAt: null,
			progress: { running: isRunning(ref, null), latest: null, calls: 0 },
			holds: 0,
			listeners: new Set(),
			retry: null,
			ruledOut: new Set(),
			closed: false,
		};
		this.followed.set(item.key, item);
		if (item.path) this.tail(item);
		else void this.search(item);
		this.changed(item);
		return item;
	}

	/** The records moved the subagent to another call, or changed what they say of it. */
	private retarget(item: Followed, ref: SubagentRef): void {
		const moved = item.ref.callId !== ref.callId;
		item.ref = ref;
		if (!item.path && ref.path) {
			item.path = ref.path;
			this.tail(item);
		}
		const running = isRunning(ref, item.writtenAt);
		if (moved || running !== item.progress.running) {
			item.progress = { ...item.progress, running };
			this.changed(item);
		}
	}

	private tail(item: Followed): void {
		if (item.retry !== null) this.timers.clear(item.retry);
		item.retry = null;
		item.stream = this.options.source.open(item.path, (lines, restart) => this.onLines(item, lines, restart === true), {
			budgetBytes: this.budgetBytes,
			pollMs: this.pollMs,
		});
	}

	/**
	 * Looks for the transcript of a subagent the records do not name yet, by
	 * the files beside each one, and again a moment later while it is not
	 * there; a probe found to be another call's is not read again.
	 */
	private async search(item: Followed): Promise<void> {
		const search = item.ref.search;
		const list = this.options.source.list?.bind(this.options.source);
		if (!search || !list) return;
		const names = (await list(search.folder)) ?? [];
		for (const candidate of search.candidates(names)) {
			if (item.closed || item.path) return;
			if (item.ruledOut.has(candidate.probe)) continue;
			const text = await this.options.source.read(candidate.probe);
			if (item.closed || item.path) return;
			if (text === null) continue;
			if (!search.owns(text)) {
				item.ruledOut.add(candidate.probe);
				continue;
			}
			item.path = candidate.transcript;
			this.tail(item);
			return;
		}
		if (item.closed || item.path) return;
		item.retry = this.timers.set(() => {
			item.retry = null;
			if (!item.closed && !item.path) void this.search(item);
		}, this.pollMs);
	}

	private onLines(item: Followed, lines: string[], restart: boolean): void {
		if (item.closed) return;
		const { parser, reports } = this.options.format;
		if (restart) {
			item.state = parser.empty();
			item.writtenAt = null;
		}
		item.state = parser.reduce(item.state, lines).state;
		for (const line of lines) {
			const at = reports?.writtenAt?.(line) ?? null;
			if (at !== null && (item.writtenAt === null || at > item.writtenAt)) item.writtenAt = at;
		}
		const { latest, calls } = latestOf(item.state);
		item.progress = { running: isRunning(item.ref, item.writtenAt), latest, calls };
		this.changed(item);
	}

	private changed(item: Followed): void {
		for (const listener of [...item.listeners]) listener();
		this.options.onChange();
	}

	private close(item: Followed): void {
		item.closed = true;
		item.stream?.close();
		item.stream = null;
		if (item.retry !== null) this.timers.clear(item.retry);
		item.retry = null;
		item.listeners.clear();
		if (this.followed.get(item.key) === item) this.followed.delete(item.key);
		if (!this.disposed) this.options.onChange();
	}
}
