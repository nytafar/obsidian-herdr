/**
 * The session model (issues #93 and #94, ADR-0003, ADR-0006).
 *
 * The plugin-held, per-pane reduced state of a transcript (CONTEXT.md). One
 * model per **runtime and pane**, reference counted, so two native tabs on the
 * same pane — and the table of contents — follow one file once and see the
 * same turns, while the same pane id on two runtimes is two models that never
 * meet.
 *
 * What it knows and nobody else does: which file is the pane's *current*
 * transcript, and when that stops being true. Its inputs are kind-neutral: a
 * {@link SessionWatcher} the runtime's kind supplies (session, transcript path,
 * cwd, status and block kind) and a {@link TranscriptSource} for the runtime's
 * transcripts. **Following is strict**: on a rotation the old session is
 * dropped whole and the new file is read from its beginning.
 *
 * **Bound to its own runtime.** A model asks for the watcher of the runtime it
 * belongs to, never for whatever is published: while another runtime is the
 * connected one (one at a time, ADR-0004) it holds no watcher at all, keeps
 * the content it has, reports {@link SessionModelView.connected} false and its
 * status as `unknown`, which is also what disables the prompt box. It follows
 * again when its own runtime comes back.
 *
 * Content comes from the transcript source, meaning from the reducer, and
 * status from the watcher's transitions; none of those three knows a pane
 * exists.
 *
 * No Obsidian here: the view layer subscribes, and `src/main.ts` holds the
 * registry and hands it each runtime's watcher and source through its kind.
 */

import {
	attachSubagentReport,
	emptyTranscript,
	lastAssistantText,
	markLost,
	reduce,
	transcriptImage,
	type ImageBytes,
	type ImageEntry,
	type TaskNotification,
	type TranscriptState,
} from './reducer';
import { toolKind } from './toolCalls';
import {
	transcriptPath,
	type TranscriptSource,
	type TranscriptStream,
} from './transcriptSource';
import type { BlockKind, SessionWatcher, Unsubscribe } from './sessionWatcher';
import type { PendingRequest } from './pendingRequest';
import { PlanTracker, planFilePath } from './planFile';
import type { AgentStatus } from '../herdr/types.gen';

export type { BlockKind, PaneSnapshot, SessionWatcher, Unsubscribe } from './sessionWatcher';

/** What a subscriber is told when a model's state moved. */
export interface SessionChange {
	/** Turns created or changed, in order. Empty when only the status moved. */
	changedTurnIds: string[];
	/**
	 * Turns that are gone without a reset: what a rewind or a re-sent prompt
	 * left behind (#131). Absent when none are.
	 */
	removedTurnIds?: string[];
	/** The whole view is stale: reloaded, replaced, or the session rotated. */
	reset: boolean;
}

/**
 * What a view may read from a model. The narrow half of {@link SessionModel},
 * so a surface test can drive a fake through the same interface the real one
 * satisfies.
 */
export interface SessionModelView {
	readonly state: TranscriptState;
	/** The transcript being shown, or null while the pane has no session yet. */
	readonly path: string | null;
	/**
	 * Whether the transcript's lines have been delivered, which a known path
	 * does **not** say: the model has the path the moment the runtime names the
	 * agent session, and the tail reads the file afterwards. Until then the
	 * state is empty for want of reading, not because the session is empty, and
	 * anything that would act on what the state does not hold must wait for this.
	 */
	readonly loaded: boolean;
	/**
	 * Why the transcript cannot be read although the session names it, in
	 * words for the view (herdr-core's `file.read` limits), or null. Optional
	 * so a fake need not say it; a missing value is no problem.
	 */
	readonly readProblem?: string | null;
	/**
	 * Reads the transcript again from its start, on a fresh tail, which is what
	 * the read-problem line's "Try again" does (#146). Optional so a fake need
	 * not have it; a model without one offers no retry.
	 */
	retryRead?(): void;
	/**
	 * The bytes of an image a prompt carried, read from the transcript when a
	 * view shows it (#144), or null. Optional so a fake need not read any; a
	 * view without it shows the image's label alone.
	 */
	readImage?(image: ImageEntry): Promise<ImageBytes | null>;
	readonly agentSession: string;
	readonly agentStatus: AgentStatus;
	/**
	 * The kind of block the runtime reported, while `blocked`; null when it is
	 * not blocked or the runtime does not say (herdr never does).
	 */
	readonly blockKind: BlockKind | null;
	/**
	 * The dialog the runtime is waiting on, while `blocked`, for a kind that
	 * reports one (ADR-0007); null otherwise. Optional so a fake need not say it.
	 */
	readonly request?: PendingRequest | null;
	/**
	 * The plan Claude is waiting to have approved, read from its plan file
	 * (#148), while the pane is blocked in plan mode on no request of the
	 * runtime's own; null otherwise, and until the file has been read. Claude
	 * writes `ExitPlanMode` to the transcript only with its answer, so this is
	 * where a herdr or herdr-core pane's plan comes from. Optional so a fake
	 * need not say it.
	 */
	readonly plan?: string | null;
	/**
	 * Whether the model's own runtime is the connected one. False while another
	 * runtime is active or none is: the content stays as it was, the status is
	 * `unknown`, and the view says the runtime is not connected.
	 */
	readonly connected: boolean;
	/**
	 * Claims the block the pane is sitting in for whatever answers it without
	 * being asked, and says whether this caller got it (#99).
	 *
	 * Per pane, not per view. Two tabs on one pane share this model (ADR-0003)
	 * and each of them draws the same waiting card, so a guard held by a view
	 * sends one answer per view — and the second lands on whatever Claude showed
	 * after the first. True for the first caller of a block, false for every one
	 * after it, until the pane leaves `blocked` or the session rotates.
	 * `toolUseId` is the dangling `tool_use` the claim was made for, empty when
	 * no call dangles — as it always is at the workspace trust prompt, the one
	 * block the view answers by itself.
	 */
	claimBlock(toolUseId: string): boolean;
	on(listener: (change: SessionChange) => void): Unsubscribe;
}

/** One subscriber's hold on a model of type `T`. */
export interface SessionHandleOf<T> {
	model: T;
	release(): void;
}

/** What a view asks for a model: the registry, narrowed to what it uses. */
export interface SessionModels {
	/** The model of `paneId` on the runtime `endpointId` names. */
	acquire(endpointId: string, paneId: string): SessionHandleOf<SessionModelView>;
}

export interface SessionModelOptions {
	/** The runtime this pane lives on; the model never reads another's. */
	endpointId: string;
	paneId: string;
	/**
	 * This runtime's watcher, re-read on every bind, or null while the runtime
	 * is not the connected one: watchers are replaced on every reconnect.
	 */
	watcher: () => SessionWatcher | null;
	/** This runtime's transcript source, re-read on every bind, or null while unreadable. */
	source: () => TranscriptSource | null;
	/**
	 * Home directory of the transcript's host, for a path derived from cwd and
	 * session (a runtime that names the path needs none). Defaults to this
	 * machine's.
	 */
	home?: string;
	/**
	 * Transcripts a model stopped following, with how many lines it had read
	 * of each (#135), shared by the registry's models. The agent that wrote
	 * them went away, or the session moved on, so if one is followed again —
	 * Claude resumed on it — what was running in its first lines is lost.
	 */
	ended?: Map<string, number>;
}

/** One pane's transcript, reduced, kept current. */
export class SessionModel implements SessionModelView {
	readonly endpointId: string;
	readonly paneId: string;
	private readonly options: SessionModelOptions;
	private transcript: TranscriptState = emptyTranscript();
	private readonly listeners = new Set<(change: SessionChange) => void>();
	private currentPath: string | null = null;
	private session = '';
	/** The transcript path the runtime last reported, '' when it reports none. */
	private reportedPath = '';
	private status: AgentStatus = 'unknown';
	private block: BlockKind | null = null;
	private pending: PendingRequest | null = null;
	/** The runtime's watcher while it is connected, else null. */
	private watcher: SessionWatcher | null = null;
	/** The runtime's transcript source as of the last bind. */
	private source: TranscriptSource | null = null;
	/** The tail of the file being shown, closed on rotation and on release. */
	private stream: TranscriptStream | null = null;
	/** The source {@link stream} came from, so a source that changed reopens it. */
	private streamSource: TranscriptSource | null = null;
	/** Whether the current tail has delivered anything; see {@link loaded}. */
	private delivered = false;
	/** What the tail last said it cannot read, for the file being shown. */
	private problem: string | null = null;
	/**
	 * The dangling `tool_use` this pane's block has been claimed for, or null
	 * while it is unclaimed. Per pane rather than per view, which is the whole
	 * point of it living here; see {@link SessionModelView.claimBlock}.
	 */
	private blockClaim: string | null = null;
	/** Unsubscribes from the watcher currently bound; replaced by `rebind`. */
	private bound: Unsubscribe[] = [];
	/**
	 * Which file contents the model is on. Bumped by every `follow` that
	 * changes file and by every restart of the tail, so a read that was in
	 * flight across either can tell that its answer is stale.
	 */
	private generation = 0;
	/** Calls whose report is being read, so a second batch does not read it twice. */
	private readingReports = new Set<string>();
	/** Lines of the current file reduced so far (#135). */
	private linesRead = 0;
	/** The one read of the transcript in flight for images (#144); null between reads. */
	private imageRead: { path: string; generation: number; text: Promise<string | null> } | null = null;
	/**
	 * Lines at the start of the current file that an agent now gone wrote, 0
	 * when none are known to be (#135): what was running in them is lost.
	 */
	private lostBefore = 0;
	/** Whether the runtime says the agent stopped while its session stays (#135). */
	private stopped = false;
	/** The session's slug and plan mode, from the lines read so far (#148). */
	private readonly planTracker = new PlanTracker();
	/** The plan file's text while it is wanted and has been read, else null. */
	private planText: string | null = null;
	/**
	 * Which plan file read is current: the file generation and the plan file's
	 * path, or empty while no plan is wanted. A read whose key is no longer
	 * this one is dropped, and a block that ends empties it, so the next block
	 * reads the file again (a rejected plan comes back revised).
	 */
	private planKey = '';

	constructor(options: SessionModelOptions) {
		this.options = options;
		this.endpointId = options.endpointId;
		this.paneId = options.paneId;
	}

	/**
	 * Subscribes to the runtime and starts following the pane's session. The
	 * registry calls it once, when the first subscriber arrives.
	 */
	start(): void {
		this.rebind();
	}

	/**
	 * Takes the watcher of this model's runtime as it is *now*: a new one after
	 * a reconnect, none while another runtime is connected. A model that kept
	 * the old subscription would quietly stop following (#94); one that took
	 * the published runtime's would show another runtime's pane (ADR-0006).
	 */
	rebind(): void {
		this.bind();
		if (this.watcher) {
			this.follow();
			return;
		}
		this.disconnected();
	}

	/** The reduced transcript as it stands. Never mutated in place. */
	get state(): TranscriptState {
		return this.transcript;
	}

	/** The file being shown, or null while the pane has no session yet. */
	get path(): string | null {
		return this.currentPath;
	}

	/**
	 * Whether the tail has delivered a line of the file being shown. False for a
	 * pane with no session, and false again from a rotation until the new file's
	 * first lines land.
	 */
	get loaded(): boolean {
		return this.delivered;
	}

	get readProblem(): string | null {
		return this.problem;
	}

	/** The runtime's agent session for the pane, empty when there is none yet. */
	get agentSession(): string {
		return this.session;
	}

	/** The runtime's view of the agent: what the view shows between blocks. */
	get agentStatus(): AgentStatus {
		return this.status;
	}

	get blockKind(): BlockKind | null {
		return this.block;
	}

	get request(): PendingRequest | null {
		return this.pending;
	}

	get plan(): string | null {
		return this.planText;
	}

	get connected(): boolean {
		return this.watcher !== null;
	}

	/**
	 * The one automatic answer this block gets, for the first caller (#99).
	 *
	 * The block is the call that is dangling, which is what the claim stores:
	 * Claude can move from one dialog to the next without the status leaving
	 * `blocked`, and a claim that only asked whether *some* claim was held would
	 * have let the first swallow every one after it. Two tabs on one pane still
	 * get one answer between them, which is the claim's job (ADR-0003), because
	 * they ask about the same block.
	 */
	claimBlock(toolUseId: string): boolean {
		if (this.blockClaim === toolUseId) return false;
		this.blockClaim = toolUseId;
		return true;
	}

	/**
	 * The bytes of an image a prompt carried (#144), read from the transcript
	 * when a view shows it, never kept here: the state holds where each image
	 * is, not what it is. The reads a draw starts at once share one read of
	 * the file, which is dropped as soon as they have their images. Null when
	 * the session moved on meanwhile or the image is not there.
	 */
	async readImage(image: ImageEntry): Promise<ImageBytes | null> {
		const path = this.currentPath;
		const source = this.streamSource ?? this.source;
		if (!image.record || !path || !source) return null;
		const generation = this.generation;
		let read = this.imageRead;
		if (!read || read.path !== path || read.generation !== generation) {
			const text = source.read(path).catch(() => null);
			read = { path, generation, text };
			this.imageRead = read;
			const started = read;
			void text.then(() => {
				if (this.imageRead === started) this.imageRead = null;
			});
		}
		const text = await read.text;
		if (generation !== this.generation || !text) return null;
		return transcriptImage(text, image.record, image.index);
	}

	/** Subscribes to state changes. Safe to call twice; unsubscribe is idempotent. */
	on(listener: (change: SessionChange) => void): Unsubscribe {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Drops the tail and its problem and follows the pane again from scratch:
	 * the source and the watcher as they are now, the file from its start
	 * (#146). A tail with limits of its own (herdr-core) also looks again on
	 * its own poll; this is the reader not wanting to wait for it.
	 */
	retryRead(): void {
		// Not connected: nothing would reopen it, and a local tail that still
		// follows would be lost for nothing.
		if (!this.watcher) return;
		const hadProblem = this.problem !== null;
		this.closeStream();
		this.rebind();
		// A source that is gone reopens nothing and says nothing; the problem
		// line it cleared is still news to the view.
		if (hadProblem && !this.stream) this.emit({ changedTurnIds: [], reset: false });
	}

	/** Closes the tail and drops every subscriber, here and in the runtime. */
	dispose(): void {
		this.unbind();
		this.closeStream();
		this.listeners.clear();
		this.planKey = '';
	}

	/** Subscribes to this runtime's watcher as it is now, dropping any older one. */
	private bind(): void {
		this.unbind();
		this.source = this.options.source();
		const watcher = this.options.watcher();
		this.watcher = watcher;
		if (!watcher) return;
		this.bound.push(
			watcher.onSession((paneId, session, path) => this.onSession(paneId, session, path)),
			watcher.onStatus((paneId, status, kind) => this.onStatusChanged(paneId, status, kind)),
			watcher.onMembership((paneId) => this.onPaneMembership(paneId)),
		);
	}

	private unbind(): void {
		for (const off of this.bound.splice(0)) off();
		this.watcher = null;
	}

	private closeStream(): void {
		this.stream?.close();
		this.stream = null;
		this.streamSource = null;
		this.problem = null;
	}

	/**
	 * The runtime is not connected: another one is active, or none is. Nothing
	 * is known about the pane now, so the status is `unknown` and no block is
	 * held; what was read stays on screen, because it is still what the session
	 * said. A tail whose source went with the connection is closed, and one
	 * that is still readable (a local file) keeps following it.
	 */
	private disconnected(): void {
		if (this.stream && this.streamSource !== this.source) this.closeStream();
		this.status = 'unknown';
		this.block = null;
		this.pending = null;
		this.blockClaim = null;
		this.refreshPlan();
		// Said every time, cheaply: the view's status line reads `connected`.
		this.emit({ changedTurnIds: [], reset: false });
	}

	/**
	 * The session the runtime reports for a pane. Compared with the one being
	 * shown, and nothing else happens when they match, which is most of the
	 * time: herdr emits a pane update about ten times a second.
	 */
	private onSession(paneId: string, session: string, path: string | undefined): void {
		if (paneId !== this.paneId) return;
		if (session === this.session && (path ?? '') === this.reportedPath) return;
		this.follow();
	}

	/**
	 * The pane joined or left the runtime's scope. Left, this model has nothing
	 * to follow: `follow` finds no pane, closes the tail, empties the state and
	 * falls back to `unknown`, which is also what disables the prompt box (#94,
	 * #97). Not a special path — a pane out of scope and a pane with no agent
	 * look the same from here, and both are "nothing of this vault's to show".
	 * Joined, `follow` finds it and starts on its session.
	 */
	private onPaneMembership(paneId: string): void {
		if (paneId !== this.paneId) return;
		this.follow();
	}

	private onStatusChanged(paneId: string, status: AgentStatus, kind?: BlockKind): void {
		if (paneId !== this.paneId) return;
		const block = status === 'blocked' ? (kind ?? null) : null;
		const request = status === 'blocked' ? (this.watcher?.snapshot(paneId)?.request ?? null) : null;
		const stopped = this.watcher?.snapshot(paneId)?.stopped === true;
		if (status === this.status && block === this.block && request === this.pending && stopped === this.stopped) {
			return;
		}
		this.status = status;
		this.block = block;
		this.pending = request;
		// The block is over, so the next one is a block of its own to answer.
		if (status !== 'blocked') this.blockClaim = null;
		this.refreshPlan();
		if (this.setStopped(stopped)) return;
		// No turn changed; the view redraws what it shows between blocks.
		this.emit({ changedTurnIds: [], reset: false });
	}

	/**
	 * Re-reads the pane's identity and follows whatever transcript it names now.
	 * A path that has not changed, on a tail from the same source, is left
	 * alone, tail and state and all; a new one starts from empty, because the
	 * session before it is simply gone.
	 */
	private follow(): void {
		const watcher = this.watcher;
		if (!watcher) return;
		const pane = watcher.snapshot(this.paneId);
		const status = pane?.agentStatus ?? 'unknown';
		const block = status === 'blocked' ? (pane?.blockKind ?? null) : null;
		const request = status === 'blocked' ? (pane?.request ?? null) : null;
		const statusMoved = status !== this.status || block !== this.block || request !== this.pending;
		this.pending = request;
		this.session = pane?.agentSession ?? '';
		this.reportedPath = pane?.transcriptPath ?? '';
		this.status = status;
		this.block = block;
		if (status !== 'blocked') this.blockClaim = null;
		// Before the file changes too: a plan wanted for this file is read now,
		// and one that no longer is goes with the status that ended it.
		this.refreshPlan();
		const path = pane?.agentSession
			? pane.transcriptPath ||
				transcriptPath({ cwd: pane.cwd, agentSession: pane.agentSession, home: this.options.home })
			: null;
		const source = this.source;
		// `streamSource` is set exactly while a tail is open, so this is "no
		// session then and now", or "the same file on a tail from the same
		// source" — including no tail at all while there is no source to read.
		if (path === this.currentPath && (path === null || this.streamSource === source)) {
			// The same session, so nothing to reload. A status read here rather
			// than off a transition, as after a rebind, is still news to the view.
			if (this.setStopped(pane?.stopped === true)) return;
			if (statusMoved) this.emit({ changedTurnIds: [], reset: false });
			return;
		}
		// The session shown is over for this pane: its agent went away or moved
		// to another file. If Claude comes back to it, what ran here is lost (#135).
		if (this.currentPath && path !== this.currentPath && this.linesRead > 0) {
			this.options.ended?.set(this.currentPath, this.linesRead);
		}
		this.closeStream();
		this.currentPath = path;
		this.restart();
		this.stopped = pane?.stopped === true;
		if (path) {
			this.lostBefore = this.options.ended?.get(path) ?? 0;
			this.options.ended?.delete(path);
		}
		// Said now, not when the new file's first lines land: a tail delivers
		// those asynchronously, and the session that is gone must not still be on
		// screen in between.
		this.emit({ changedTurnIds: [], reset: true });
		if (!path || !source) return;
		// The tail delivers the file as it stands before anything is appended, so
		// there is no gap between reading the history and following it.
		// A closed tail delivers nothing (`TranscriptStream`), so whatever this
		// hears is the file being shown.
		this.stream = source.open(path, (lines, restart) => this.onLines(lines, restart === true), {
			onProblem: (problem) => this.onProblem(problem),
		});
		this.streamSource = source;
	}

	/** The tail says it cannot read the file, or can again: news to the view. */
	private onProblem(problem: string | null): void {
		if (problem === this.problem) return;
		this.problem = problem;
		this.emit({ changedTurnIds: [], reset: false });
	}

	/** Empties everything read so far, for another file or the same one replaced. */
	private restart(): void {
		this.transcript = emptyTranscript();
		// Nothing of the new file has been read, whatever was read of the old one.
		this.delivered = false;
		// Another file is another block, whatever the status still says.
		this.blockClaim = null;
		this.generation++;
		this.readingReports.clear();
		this.linesRead = 0;
		this.lostBefore = 0;
		this.planTracker.reset();
		this.planText = null;
		this.planKey = '';
	}

	/**
	 * A batch of whole lines from the tail. `restart` is the tail saying the
	 * file was replaced or truncated under it: what was read before is void, and
	 * these lines are the file again from its start.
	 */
	private onLines(lines: string[], restart: boolean): void {
		if (restart) this.restart();
		this.delivered = true;
		const { state, changedTurnIds, removedTurnIds } = this.reduceLines(lines);
		this.transcript = state;
		this.planTracker.feed(lines);
		// The block may have come before the lines that say it is plan mode.
		this.refreshPlan();
		if (restart) this.emit({ changedTurnIds: [], reset: true });
		else if (removedTurnIds.length) this.emit({ changedTurnIds, removedTurnIds, reset: false });
		else this.emit({ changedTurnIds, reset: false });
		this.readReports(changedTurnIds);
	}

	/**
	 * Reduces a batch, marking lost what an agent now gone left running (#135):
	 * everything while the runtime says it stopped, and in a file Claude
	 * resumed, what was running when the lines its earlier run wrote ran out.
	 */
	private reduceLines(lines: string[]): ReturnType<typeof reduce> {
		const before = this.linesRead;
		this.linesRead += lines.length;
		const cut = this.lostBefore - before;
		let result: ReturnType<typeof reduce>;
		if (cut > 0 && cut <= lines.length) {
			const earlier = reduce(this.transcript, lines.slice(0, cut));
			const lost = markLost(earlier.state);
			const later = reduce(lost.state, lines.slice(cut));
			const changed = new Set([...earlier.changedTurnIds, ...lost.changedTurnIds, ...later.changedTurnIds]);
			const kept = new Set(later.state.turns.map((turn) => turn.id));
			result = {
				state: later.state,
				changedTurnIds: [...changed].filter((id) => kept.has(id)),
				removedTurnIds: [...earlier.removedTurnIds, ...later.removedTurnIds].filter((id) => !kept.has(id)),
			};
			this.lostBefore = 0;
		} else result = reduce(this.transcript, lines);
		if (!this.stopped) return result;
		const lost = markLost(result.state);
		const changed = new Set([...result.changedTurnIds, ...lost.changedTurnIds]);
		return { ...result, state: lost.state, changedTurnIds: [...changed] };
	}

	/**
	 * Takes the runtime's word on whether the agent stopped (#135). A stop
	 * marks lost what it left running, and says so as a change; true when it
	 * emitted one.
	 */
	private setStopped(stopped: boolean): boolean {
		if (stopped === this.stopped) return false;
		this.stopped = stopped;
		if (!stopped) return false;
		const { state, changedTurnIds } = markLost(this.transcript);
		this.transcript = state;
		this.emit({ changedTurnIds, reset: false });
		return true;
	}

	/**
	 * Starts the read for every finished background subagent in the turns that
	 * just moved (#96).
	 *
	 * The reducer stays pure, so this is where the file is opened: a report is
	 * not in the transcript at all, only the notification that names the file it
	 * was written to. Each call is read once, and the answer comes back as an
	 * ordinary changed turn.
	 */
	private readReports(changedTurnIds: readonly string[]): void {
		if (!changedTurnIds.length) return;
		for (const turn of this.transcript.turns) {
			if (!changedTurnIds.includes(turn.id)) continue;
			for (const entry of turn.entries) {
				if (entry.kind !== 'tool' || entry.report !== null) continue;
				// Only a subagent has a report; a background command's output file
				// is its stdout, which the tool group already accounts for. The
				// notification says whose it is (#135).
				if (!entry.notification || entry.notification.kind === 'command') continue;
				if (toolKind(entry.name) !== 'agent') continue;
				if (this.readingReports.has(entry.id)) continue;
				this.readingReports.add(entry.id);
				void this.readReport(entry.id, entry.notification);
			}
		}
	}

	/** Reads one report and feeds it back, unless the session moved on meanwhile. */
	private async readReport(toolUseId: string, notification: TaskNotification): Promise<void> {
		const generation = this.generation;
		const report = await this.subagentReport(notification);
		// The session rotated while the file was being read: that transcript is
		// gone and so is the turn this belonged to (ADR-0003).
		if (generation !== this.generation || !report) return;
		const { state, changedTurnIds } = attachSubagentReport(this.transcript, toolUseId, report);
		if (!changedTurnIds.length) return;
		this.transcript = state;
		this.emit({ changedTurnIds, reset: false });
	}

	/**
	 * A subagent's report: the last thing it said in the file its notification
	 * named, falling back to its transcript beside the session's own file, which
	 * is where Claude Code also keeps it (`docs/architecture.md`). Read through
	 * the source the tail came from, which is the transcript's own host.
	 */
	private async subagentReport(notification: TaskNotification): Promise<string> {
		const source = this.streamSource ?? this.source;
		if (!source) return '';
		for (const path of [notification.outputFile, this.subagentPath(notification.taskId)]) {
			if (!path) continue;
			const text = await source.read(path);
			if (!text) continue;
			const report = lastAssistantText(text.split('\n'));
			if (report) return report;
		}
		return '';
	}

	/**
	 * The plan file this pane's block wants read, as `<generation>\n<path>`, or
	 * empty when it wants none (#148): blocked in plan mode on no request of
	 * the runtime's own (the `claude` kind's carries its plan), and on no block
	 * the runtime named as something other than a permission. Read through the
	 * source the tail came from, so a remote runtime's plan is read on its own
	 * machine, and only where its transcript already is.
	 */
	private wantedPlan(): string {
		if (this.status !== 'blocked' || this.pending) return '';
		if (this.block !== null && this.block !== 'permission') return '';
		if (!this.planTracker.planMode || !this.currentPath || !(this.streamSource ?? this.source)) return '';
		const path = planFilePath(this.currentPath, this.planTracker.slug);
		return path ? `${this.generation}\n${path}` : '';
	}

	/**
	 * Starts reading the plan file when the block wants one it has not asked
	 * for, and drops the plan it held when it no longer wants that one. Says
	 * nothing itself: a plan that went goes with a change the caller emits, and
	 * one that was read is emitted when it lands.
	 */
	private refreshPlan(): void {
		const key = this.wantedPlan();
		if (key === this.planKey) return;
		this.planKey = key;
		this.planText = null;
		if (key) void this.readPlan(key);
	}

	private async readPlan(key: string): Promise<void> {
		const source = this.streamSource ?? this.source;
		const path = key.slice(key.indexOf('\n') + 1);
		const text = source ? await source.read(path).catch(() => null) : null;
		// The block ended, the slug changed or the file did, meanwhile.
		if (key !== this.planKey) return;
		const plan = text?.trim() ? text : null;
		if (plan === this.planText) return;
		this.planText = plan;
		this.emit({ changedTurnIds: [], reset: false });
	}

	/** `<session>/subagents/agent-<task id>.jsonl`, beside the session's transcript. */
	private subagentPath(taskId: string): string {
		const path = this.currentPath;
		if (!path || !taskId) return '';
		return `${path.replace(/\.jsonl$/, '')}/subagents/agent-${taskId}.jsonl`;
	}

	private emit(change: SessionChange): void {
		for (const listener of [...this.listeners]) listener(change);
	}
}

/** One subscriber's hold on a model. Releasing twice is the same as once. */
export type SessionHandle = SessionHandleOf<SessionModel>;

export interface SessionModelRegistryOptions {
	/**
	 * The watcher of the runtime `endpointId` names, or null while that runtime
	 * is not the connected one. Never the published runtime's on behalf of
	 * another: that is how one pane id on two runtimes would alias.
	 */
	watcher(endpointId: string): SessionWatcher | null;
	/** Where that runtime's transcripts are read, or null while they cannot be. */
	source(endpointId: string): TranscriptSource | null;
	home?: string;
}

/** The registry key of a pane on a runtime; a newline is in neither id. */
function modelKey(endpointId: string, paneId: string): string {
	return `${endpointId}\n${paneId}`;
}

/**
 * The plugin's session models, one per runtime and pane while anything is
 * watching it.
 *
 * Reference counted rather than cached: a model that nobody watches is a file
 * being tailed and a subscription nobody reads, and this is also what makes
 * "two tabs on one pane" a single tail (ADR-0003). A hidden tab keeps its hold,
 * so it catches up the moment it is revealed.
 */
export class SessionModelRegistry implements SessionModels {
	private readonly models = new Map<string, { model: SessionModel; holders: number }>();
	/** What every model stopped following, and how far it had read (#135). */
	private readonly ended = new Map<string, number>();

	constructor(private readonly options: SessionModelRegistryOptions) {}

	/** Whether a model for `paneId` on `endpointId` is currently held. */
	has(endpointId: string, paneId: string): boolean {
		return this.models.has(modelKey(endpointId, paneId));
	}

	/**
	 * The model for a pane on a runtime, built and started on the first hold.
	 * The caller must release exactly once; a released handle can be released
	 * again harmlessly.
	 */
	acquire(endpointId: string, paneId: string): SessionHandle {
		const key = modelKey(endpointId, paneId);
		let entry = this.models.get(key);
		if (!entry) {
			entry = {
				model: new SessionModel({
					endpointId,
					paneId,
					watcher: () => this.options.watcher(endpointId),
					source: () => this.options.source(endpointId),
					home: this.options.home,
					ended: this.ended,
				}),
				holders: 0,
			};
			this.models.set(key, entry);
			// The first hold pays for the tail; the second one just subscribes.
			entry.model.start();
		}
		entry.holders++;
		const held = entry;
		let live = true;
		return {
			model: held.model,
			release: () => {
				if (!live) return;
				live = false;
				held.holders--;
				if (held.holders > 0) return;
				this.models.delete(key);
				held.model.dispose();
			},
		};
	}

	/**
	 * Every model takes its own runtime's watcher as it is now
	 * (`onScopeReplaced`): a fresh one for the runtime that just connected,
	 * none for every other.
	 */
	rebind(): void {
		for (const entry of this.models.values()) entry.model.rebind();
	}

	/** Drops every model and closes every tail. `onunload` only. */
	dispose(): void {
		for (const entry of this.models.values()) entry.model.dispose();
		this.models.clear();
	}
}
