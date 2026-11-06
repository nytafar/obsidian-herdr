/**
 * The conversation model (issue #137, ADR-0010): what the native view shows of
 * an agent's session, whichever agent wrote it.
 *
 * Everything above the agent seam — the surface, the turn renderer, the table
 * of contents, the waiting card and the session chrome — reads these types and
 * nothing else. What a line of one agent's transcript means is that agent's
 * parser (`ConversationParser`, supplied by its `AgentFormat` in
 * `../agents/format.ts`); Claude Code's is `../agents/claude/transcript.ts`.
 *
 * The model says only what a record says. Where an agent writes no fact, the
 * field is absent rather than guessed: a turn whose agent writes no lifecycle
 * has no {@link Turn.outcome}, a call whose outcome no record flags is
 * `unknown` (finding `agent-codex`, §7).
 *
 * Pure: no Obsidian, no I/O. {@link TurnDraft} is the copy-on-write working
 * set every parser folds a batch into, so a state the view already drew keeps
 * saying what it said.
 */

/** One assistant message's prose, merged across every record that carried it. */
export interface TextEntry {
	kind: 'text';
	messageId: string;
	text: string;
	/**
	 * Which part of the answer this is, where the agent says: `commentary`
	 * between tool calls, `final` the turn's answer. Absent where the agent
	 * writes no phase (Claude), and the view treats every text block alike.
	 */
	phase?: TextPhase;
}

/** Where a block of assistant prose stands in its turn, as the agent wrote it. */
export type TextPhase = 'commentary' | 'final';

/**
 * That a message thought before it spoke, and what it thought.
 *
 * The text is kept because the view shows it in a collapsed disclosure (#95).
 * A thought this build may not read — encrypted, or written with summaries off
 * — has an empty text, and the view shows nothing for it, never blank text.
 */
export interface ThinkingEntry {
	kind: 'thinking';
	messageId: string;
	text: string;
}

/**
 * Background work's completion, as the agent reported it (issue #96).
 *
 * The notification names the tool call it belongs to and the file the work
 * wrote. For a subagent that file holds its own conversation, and the report
 * is the last thing it said; the parser does not read it, because reading is
 * not pure — the session model does, through the agent's format, and feeds the
 * text back.
 */
export interface TaskNotification {
	/** The task's own id. */
	taskId: string;
	/**
	 * Whose notification it is (#135): a subagent's, a background command's,
	 * or something else's (a monitor). Only a subagent has a report to read.
	 */
	kind: 'agent' | 'command' | 'other';
	/** The file the task wrote, empty when the notification named none. */
	outputFile: string;
	/**
	 * When the notification was written, as an ISO timestamp, where the
	 * records say (#147): a subagent whose own transcript was written after
	 * this is working again.
	 */
	at?: string;
}

/**
 * How far a subagent has got (#147), read out of its own transcript while a
 * view shows it. Written by the session model, never by a record, onto the
 * call it hangs under ({@link ToolEntry.subagent}).
 */
export interface SubagentProgress {
	/**
	 * Whether it is working now: the records say it started and nothing has
	 * answered it yet, or its own transcript was written after the last
	 * notification that said it stopped.
	 */
	running: boolean;
	/** The last thing it did: its newest tool call or prose; null before it did anything. */
	latest: ToolEntry | TextEntry | null;
	/** How many tool calls it has made so far. */
	calls: number;
}

/**
 * Where a tool call has got to (#91, #137):
 *
 * - `pending` — the call is there and nothing has answered it.
 * - `running` — an answer came back but the work did not: a launch notice,
 *   whose real answer arrives later.
 * - `done` — answered, and the agent's record says it went well.
 * - `error` — the record says it failed. Claude's `is_error` is this, and it
 *   also covers a call the user refused, which Claude does not tell apart.
 * - `declined` — the user refused it, where the agent says so apart from a
 *   failure.
 * - `unknown` — answered, and no record says how it went: an agent that
 *   flags no failure (Codex's `exec`) is never guessed into `done`.
 * - `lost` — it was running when the agent went away, and nothing will ever
 *   report it (#135). Set by {@link markLost}, never by a record.
 */
export type ToolStatus = 'pending' | 'running' | 'done' | 'error' | 'declined' | 'unknown' | 'lost';

/**
 * The kinds a tool call is shown as. Each agent format names its own tools
 * in a table over these (`AgentFormat.toolKinds`); a name no table knows is
 * `other` rather than a gap.
 */
export type ToolKind =
	| 'bash'
	| 'read'
	| 'edit'
	| 'write'
	| 'grep'
	| 'glob'
	| 'webfetch'
	| 'websearch'
	| 'todo'
	| 'agent'
	| 'question'
	| 'other';

/** A tool call and, once it lands, the result that answered it. */
export interface ToolEntry {
	kind: 'tool';
	/** The call's id, which its answer names (`tool_use_id`, `call_id`). */
	id: string;
	name: string;
	/**
	 * The call's input, exactly as the transcript gave it. The parser knows no
	 * tool: which field is a path, a command or a query is the view's kind table
	 * (`./toolCalls.ts`), so that stays one place and this stays dumb.
	 */
	input: Record<string, unknown>;
	/** null until the answer arrives. */
	result: string | null;
	/** How far the call has got; the view says so for a vault change (#95). */
	status: ToolStatus;
	/**
	 * The notification that reported this call finished, for the background
	 * calls that get one; null for every other call.
	 */
	notification: TaskNotification | null;
	/**
	 * A background subagent's report, once it has been read out of the file the
	 * notification named. Written by the session model, never by a record. A
	 * synchronous subagent has no notification and its report is simply its
	 * {@link ToolEntry.result}.
	 */
	report: string | null;
	/**
	 * The subagent this call started or resumed, as far as its own transcript
	 * has been read (#147). Absent while no view follows it.
	 */
	subagent?: SubagentProgress;
	/**
	 * The call this one continues, by id, where the agent splits one piece of
	 * work across calls (a yielded cell, then a `wait` on it). Absent for a
	 * call that stands alone.
	 */
	continues?: string;
}

/** A human prompt consumed inside a running turn, shown where it entered. */
export interface SteerEntry {
	kind: 'steer';
	text: string;
}

/**
 * A picture the human sent with a prompt (#129). The bytes stay in the
 * transcript: the entry says where they are, the record and which of its
 * images, and the view reads them through the agent's format when it shows
 * the thumbnail (#144), so a session's pictures are never all held at once.
 * Placed first in its turn's entries, so it reads under the prompt it came
 * with; a steer's follow the steer.
 */
export interface ImageEntry {
	kind: 'image';
	/** Stable within the session: the record and the index, for the view's item names. */
	id: string;
	/** The id of the transcript record that carries the bytes, '' when it had none. */
	record: string;
	/** Which of that record's images this is, from 0. */
	index: number;
	/** The picture's media type as the transcript gave it, '' when it gave none. */
	mediaType: string;
}

/** An image's bytes as the transcript holds them (#144). */
export interface ImageBytes {
	mediaType: string;
	/** base64, as written. */
	data: string;
}

/**
 * Where the agent's context was compacted (#130): the conversation before it
 * was folded into a summary, which the agent continues from. Shown as a
 * divider at the point it happened, never as a prompt.
 */
export interface CompactionEntry {
	kind: 'compaction';
	/**
	 * The summary the agent continued from, as Markdown; '' when the agent
	 * keeps it unreadable (Codex's is opaque), and the divider has nothing to
	 * unfold.
	 */
	summary: string;
}

/**
 * The runtime speaking to the human, not the agent (#133): an unknown
 * command, a usage limit reached or reset, a connection dropped. Shown where
 * it was written, in the turn running then, and never as a turn of its own.
 */
export interface NoticeEntry {
	kind: 'notice';
	text: string;
	/** When it was written, '' when the record did not say; lines a moment apart join. */
	at: string;
}

/**
 * A command the human ran in the agent's shell (bash mode, `!` in Claude
 * Code), and what it printed (#133). It opens a turn as a prompt does.
 */
export interface ShellEntry {
	kind: 'shell';
	command: string;
	/** What it printed, null until the output has arrived. */
	stdout: string | null;
	stderr: string;
}

/**
 * What set the agent working again after it had finished answering, with no
 * prompt between (#139): a hook (a Stop hook's feedback, a hook's added
 * context), a background task's or another session's notification, a line
 * the runtime wrote for the agent (a background command that failed), or
 * nothing the parser recognised.
 */
export type ResumeCause = 'hook' | 'notification' | 'meta' | 'other';

/**
 * Where the agent took up work again on its own after answering the prompt
 * (#139). The turn stays the prompt's: what follows this entry is the resumed
 * work, so the prompt's answer and its time end before it
 * ({@link Turn.endTs}).
 */
export interface ResumeEntry {
	kind: 'resume';
	/** Stable within the session: the record that resumed, for the view's item names. */
	id: string;
	cause: ResumeCause;
	/** What the cause said, in the agent's or the runtime's words; '' when it said nothing readable. */
	text: string;
	/** When the work was taken up again, where the records say. */
	ts?: string;
	/** When the agent last wrote in the resumed work so far, where the records say. */
	endTs?: string;
}

export type TurnEntry =
	| TextEntry
	| ThinkingEntry
	| ToolEntry
	| SteerEntry
	| ImageEntry
	| CompactionEntry
	| NoticeEntry
	| ShellEntry
	| ResumeEntry;

/** One Markdown heading in a turn's assistant prose, for the TOC (#100). */
export interface TurnHeading {
	/** 1 to 6, as the number of `#` says. */
	level: number;
	text: string;
}

/**
 * How a turn ended, where the agent writes it (Codex's `task_complete` and
 * `turn_aborted`): `aborted` is the human stopping it. Absent while it runs,
 * and always for an agent that writes no lifecycle (Claude), whose turn ends
 * where the agent status says.
 */
export type TurnOutcome = 'completed' | 'aborted' | 'failed';

/** A human prompt and everything the agent did until it stopped. */
export interface Turn {
	/**
	 * Stable, so a view can redraw one turn in place: the agent's own turn id
	 * where it writes one, else the id of the record that opened the turn.
	 */
	id: string;
	/** The prompt that opened it; '' for a turn nobody prompted (a compaction, a notice). */
	prompt: string;
	entries: TurnEntry[];
	/**
	 * The headings of this turn's assistant prose, in order (#100). Computed
	 * by {@link TurnDraft} so the table of contents parses nothing.
	 */
	headings: TurnHeading[];
	/** How the turn ended, where the agent says; see {@link TurnOutcome}. */
	outcome?: TurnOutcome;
	/** When the turn opened (the prompt's time), as an ISO timestamp, where the records say (#139). */
	ts?: string;
	/**
	 * When the agent last wrote in answer to the prompt, where the records say
	 * (#139): its newest reply before any work it resumed on its own
	 * ({@link ResumeEntry}), so the prompt's duration is the prompt's.
	 */
	endTs?: string;
}

/**
 * The state the view reads: the turns, and the records that render nothing.
 * A parser keeps whatever else it needs across batches in its own state,
 * which extends this one and is opaque above the seam.
 */
export interface ConversationState {
	readonly turns: Turn[];
	/**
	 * Records that render nothing, counted by their type, so a session can be
	 * diagnosed. Counts rather than the records: the view has no use for
	 * their content.
	 */
	readonly raw: Record<string, number>;
}

/** What folding a batch did. */
export interface ReduceResult<S extends ConversationState = ConversationState> {
	state: S;
	/** Turn ids created or changed by this batch, in order, each once. */
	changedTurnIds: string[];
	/**
	 * Turn ids the state held before this batch and holds no more: a rewind's
	 * abandoned turns and a cancelled prompt's (#131). A view drops them.
	 */
	removedTurnIds: string[];
}

/**
 * One agent's transcript reader. Pure: `reduce` never mutates the state it is
 * given, and the state carries whatever the parser must remember across
 * batches (records an agent writes twice, a queue that pairs with a later
 * line), so a tail's batches and a whole file read at once fold the same.
 */
export interface ConversationParser<S extends ConversationState = ConversationState> {
	/** The state a session starts from, and what a rotation goes back to. */
	empty(): S;
	/**
	 * Folds a batch of whole lines — a whole file on open, a tail's worth
	 * afterwards — into `state`. A line it cannot read is counted raw, never
	 * an error: a newer agent writes records this build has never seen.
	 */
	reduce(state: S, lines: string[]): ReduceResult<S>;
}

/**
 * What the session chrome can say about the session (#110, #111). The agent's
 * format reads it from the records (`AgentFormat.sessionInfo`); a runtime
 * that knows a field sooner (the `claude` kind, from its process) overlays it
 * per field (`PaneSnapshot.sessionInfo`), and the session model merges the
 * two. Every field is absent until something states it.
 */
export interface SessionInfo {
	/** The model the agent last answered with: its id, and the name to show. */
	model?: { id: string; label: string };
	/** The reasoning effort, in the agent's own word (`AgentFormat.efforts` lists them). */
	effort?: string;
	/** The permission mode at the last prompt, in the agent's own word (`AgentFormat.modes`). */
	permissionMode?: string;
	/**
	 * Tokens in the context now, as the agent counts them: the format's sum,
	 * since agents count differently (Claude's is input, cache write and cache
	 * read of the newest main-chain reply).
	 */
	contextUsed?: number;
	/**
	 * The context window the model has, in tokens, and who said so: the
	 * agent's own record, a context command's output, or the runtime.
	 */
	contextWindow?: { tokens: number; source: 'agent' | 'context-command' | 'runtime' };
	/** Tokens of the latest answer, as the agent counts them. */
	usage?: {
		input: number;
		output: number;
		/** Input tokens served from the cache. */
		cached?: number;
	};
}

/**
 * `info` with every field `overlay` states put over it: the runtime's word
 * first, the transcript's where the runtime says nothing. Returns `info`
 * itself when the overlay states nothing.
 *
 * A runtime that knows a model by its id only says so with the id as its
 * label; for the model the reading names too, the reading's label stays, so
 * the name the agent shows is not traded for the id (#160).
 */
export function mergeSessionInfo(info: SessionInfo, overlay: SessionInfo | null | undefined): SessionInfo {
	if (!overlay) return info;
	const merged: SessionInfo = { ...info };
	let changed = false;
	for (const key of Object.keys(overlay) as (keyof SessionInfo)[]) {
		const value = overlay[key];
		if (value === undefined) continue;
		if (key === 'model' && overlay.model?.label === overlay.model?.id && info.model?.id === overlay.model?.id) {
			continue;
		}
		(merged as Record<string, unknown>)[key] = value;
		changed = true;
	}
	return changed ? merged : info;
}

/** A Markdown ATX heading: up to three spaces, one to six hashes, then text. */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
/** A fenced code block's fence, which is what a heading inside one is not. */
const FENCE = /^ {0,3}(```|~~~)/;

/**
 * The headings of a turn's assistant prose (#100).
 *
 * Only `text` entries are read: a thought is not prose, a prompt is the turn's
 * own title and a tool call's output is not the agent speaking. Lines inside a
 * fenced code block are skipped, because a shell comment opens with the same
 * character as a heading and a transcript is full of them. The trailing hashes
 * of a closed ATX heading are dropped, the way Markdown reads them.
 */
export function turnHeadings(entries: readonly TurnEntry[]): TurnHeading[] {
	const headings: TurnHeading[] = [];
	for (const entry of entries) {
		if (entry.kind !== 'text') continue;
		let fenced = false;
		for (const line of entry.text.split('\n')) {
			if (FENCE.test(line)) {
				fenced = !fenced;
				continue;
			}
			if (fenced) continue;
			const match = HEADING.exec(line);
			if (!match) continue;
			const text = (match[2] ?? '').replace(/[ \t]+#*[ \t]*$/, '').trim();
			if (text) headings.push({ level: (match[1] ?? '').length, text });
		}
	}
	return headings;
}

/** A working copy of the turns, so a parser never mutates the state it was given. */
export class TurnDraft {
	private readonly turns: Turn[];
	/** The turns as the batch found them, for what it removed. */
	private readonly initial: readonly Turn[];
	/** Turns this batch removed, by id. */
	private readonly removed = new Set<string>();
	private readonly changed: string[] = [];
	/** The same ids as a set: `changed` keeps the order, this answers `touch`. */
	private readonly changedIds = new Set<string>();
	/** Turns already copied in this batch, by id: copy once, then mutate freely. */
	private readonly mine = new Set<string>();

	constructor(turns: readonly Turn[]) {
		this.initial = turns;
		this.turns = [...turns];
	}

	/** The id of the turn open for new content, '' before the first. */
	lastId(): string {
		return this.turns[this.turns.length - 1]?.id ?? '';
	}

	/** Drops one turn, if it is still here (#131). */
	remove(turnId: string): void {
		const index = this.turns.findIndex((turn) => turn.id === turnId);
		if (index === -1) return;
		this.removed.add(turnId);
		this.turns.splice(index, 1);
	}

	/**
	 * Drops every turn after `turnId`, or every turn for '' (#131). A turn
	 * that is no longer here drops nothing: what it named is already gone.
	 */
	dropAfter(turnId: string): void {
		const index = turnId ? this.turns.findIndex((turn) => turn.id === turnId) : -1;
		if (turnId && index === -1) return;
		for (const turn of this.turns.splice(index + 1)) this.removed.add(turn.id);
	}

	/** The turn open for new content, or null before the first prompt. */
	current(): Turn | null {
		const last = this.turns[this.turns.length - 1];
		return last ? this.own(last) : null;
	}

	/** The turn `id`, owned by this batch, or null when the draft holds none. */
	turn(id: string): Turn | null {
		for (let i = this.turns.length - 1; i >= 0; i--) {
			const turn = this.turns[i];
			if (turn?.id === id) return this.own(turn);
		}
		return null;
	}

	/** Opens a turn; `ts` is when, where the record that opened it says (#139). */
	open(id: string, prompt: string, ts = ''): Turn {
		const turn: Turn = { id, prompt, entries: [], headings: [], ...(ts ? { ts } : {}) };
		this.turns.push(turn);
		this.mine.add(id);
		this.touch(id);
		return turn;
	}

	/**
	 * Marks a turn as changed by this batch. Asked once per line, so the
	 * "already marked?" question is a set rather than a scan of the list: a
	 * first batch is the whole file, and a scan each would be quadratic in the
	 * number of turns (#101).
	 */
	touch(id: string): void {
		if (this.changedIds.has(id)) return;
		this.changedIds.add(id);
		this.changed.push(id);
	}

	/**
	 * The tool call `toolUseId`, owned by this batch, searched from the newest
	 * turn back: an answer always answers a call that is already in the state.
	 */
	toolEntry(toolUseId: string): ToolEntry | null {
		for (let i = this.turns.length - 1; i >= 0; i--) {
			const turn = this.turns[i];
			if (!turn) continue;
			const found = turn.entries.find(
				(entry): entry is ToolEntry => entry.kind === 'tool' && entry.id === toolUseId,
			);
			if (!found) continue;
			const owned = this.own(turn);
			return (
				owned.entries.find(
					(entry): entry is ToolEntry => entry.kind === 'tool' && entry.id === toolUseId,
				) ?? null
			);
		}
		return null;
	}

	/** The id of the newest tool call `match` takes, or null when it takes none. */
	findToolId(match: (entry: ToolEntry) => boolean): string | null {
		for (let i = this.turns.length - 1; i >= 0; i--) {
			const entries = this.turns[i]?.entries ?? [];
			for (let j = entries.length - 1; j >= 0; j--) {
				const entry = entries[j];
				if (entry?.kind === 'tool' && match(entry)) return entry.id;
			}
		}
		return null;
	}

	/** The turn holding the tool call `toolUseId`, or null when none does. */
	turnOf(toolUseId: string): Turn | null {
		for (let i = this.turns.length - 1; i >= 0; i--) {
			const turn = this.turns[i];
			if (!turn) continue;
			const found = turn.entries.some(
				(entry) => entry.kind === 'tool' && entry.id === toolUseId,
			);
			if (found) return turn;
		}
		return null;
	}

	/** How many turns the draft holds, for naming a turn whose record had no id. */
	get length(): number {
		return this.turns.length;
	}

	/**
	 * The turns as they now stand; the caller assembles the state around them.
	 *
	 * The headings of every turn this batch touched are recomputed here, in one
	 * place: prose arrives a block at a time, and a turn the batch did not touch
	 * still says what it said (#100).
	 */
	finish(): { turns: Turn[]; changedTurnIds: string[]; removedTurnIds: string[] } {
		const removedTurnIds = this.removedIds();
		if (this.changed.length === 0) return { turns: this.turns, changedTurnIds: this.changed, removedTurnIds };
		// Indexed once rather than searched per id: the first batch of a tail is
		// the whole file, so every turn in a long session can be in `changed`, and
		// a `find` each would be quadratic in exactly the case the native view's
		// open time is measured on (#101).
		const byId = new Map(this.turns.map((turn) => [turn.id, turn]));
		for (const id of this.changed) {
			const turn = byId.get(id);
			if (turn) this.own(turn).headings = turnHeadings(turn.entries);
		}
		// A turn opened and dropped within the batch was never anyone's to draw.
		const changedTurnIds = this.removed.size
			? this.changed.filter((id) => byId.has(id))
			: this.changed;
		return { turns: this.turns, changedTurnIds, removedTurnIds };
	}

	/** The turns the batch found and no longer holds, in their old order. */
	private removedIds(): string[] {
		if (this.removed.size === 0) return [];
		const kept = new Set(this.turns.map((turn) => turn.id));
		return this.initial.map((turn) => turn.id).filter((id) => this.removed.has(id) && !kept.has(id));
	}

	/**
	 * A copy of `turn` that this batch owns, swapped into the list on first ask.
	 *
	 * The entries are copied too, one object each: a text merge, a tool result,
	 * a notification and a report all write into an entry, and a snapshot the
	 * view already drew must keep saying what it said. The `input` record and
	 * the notification inside an entry are replaced rather than written into, so
	 * sharing those costs nothing.
	 */
	private own(turn: Turn): Turn {
		if (this.mine.has(turn.id)) return turn;
		const copy: Turn = { ...turn, entries: turn.entries.map((entry) => ({ ...entry })) };
		this.turns[this.turns.indexOf(turn)] = copy;
		this.mine.add(turn.id);
		return copy;
	}
}

/**
 * A background subagent's report, attached to the call that launched it (#96).
 *
 * The read itself is the session model's: this is the pure half, so a report
 * that arrives long after its lines did still goes through one place and comes
 * back as a changed turn id like everything else. An id no turn holds changes
 * nothing, which is what a rotation between the read and its answer looks like.
 */
export function attachSubagentReport<S extends ConversationState>(
	state: S,
	toolUseId: string,
	report: string,
): ReduceResult<S> {
	const draft = new TurnDraft(state.turns);
	const entry = draft.toolEntry(toolUseId);
	const turn = entry ? draft.turnOf(toolUseId) : null;
	if (entry && turn) {
		entry.report = report;
		draft.touch(turn.id);
	}
	const { turns, changedTurnIds, removedTurnIds } = draft.finish();
	return { state: { ...state, turns }, changedTurnIds, removedTurnIds };
}

/**
 * A subagent's progress put on the call it hangs under, or taken off it
 * (`undefined`) once nothing follows it (#147). Pure, like
 * {@link attachSubagentReport}; the session model reads the subagent's file.
 */
export function attachSubagentProgress<S extends ConversationState>(
	state: S,
	toolUseId: string,
	progress: SubagentProgress | undefined,
): ReduceResult<S> {
	const draft = new TurnDraft(state.turns);
	const entry = draft.toolEntry(toolUseId);
	const turn = entry ? draft.turnOf(toolUseId) : null;
	if (entry && turn) {
		if (progress) entry.subagent = progress;
		else delete entry.subagent;
		draft.touch(turn.id);
	}
	const { turns, changedTurnIds, removedTurnIds } = draft.finish();
	return { state: { ...state, turns }, changedTurnIds, removedTurnIds };
}

/**
 * Every call still running marked lost (#135): the agent that ran it is gone,
 * and nothing will report it. Pure, like {@link attachSubagentReport}; the
 * session model decides when the agent is gone.
 */
export function markLost<S extends ConversationState>(state: S): ReduceResult<S> {
	const draft = new TurnDraft(state.turns);
	for (const turn of state.turns) {
		for (const entry of turn.entries) {
			if (entry.kind !== 'tool' || entry.status !== 'running') continue;
			const owned = draft.toolEntry(entry.id);
			if (owned) owned.status = 'lost';
			draft.touch(turn.id);
		}
	}
	const { turns, changedTurnIds, removedTurnIds } = draft.finish();
	return { state: { ...state, turns }, changedTurnIds, removedTurnIds };
}

/** An empty conversation, for a view with nothing to show and for a fake. */
export function emptyConversation(): ConversationState {
	return { turns: [], raw: {} };
}
