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
 * No Obsidian, no I/O. {@link TurnDraft} is how every parser folds a batch
 * into the turns: in place, saying which turns changed and which went (#138);
 * a preview folds into a fork instead ({@link previewTail}), so the session's
 * own state only ever holds lines that ended.
 */

import type { ContextBreakdown } from './contextBreakdown';

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
	/**
	 * How much of the session is held (#152): {@link turns} is then its newest
	 * turns only, and the window names the earlier ones. Absent, every turn is
	 * held. The session model sets it; a parser only folds through it.
	 */
	window?: TurnWindow;
	/**
	 * Prompts the agent itself holds, oldest first: Claude's queue enqueues
	 * not yet spent (#157). The view shows them as queued in the agent (#159).
	 * Absent for a format that reads no queue.
	 */
	readonly pendingQueue?: readonly string[];
}

/**
 * A page of a session (#152): the newest this many turns, and at most this
 * many bytes of transcript lines between them, are held. A session model
 * holds one page, and one more on each "Load earlier turns".
 */
export interface TurnPage {
	turns: number;
	bytes: number;
}

/**
 * The page a session is held in: 100 turns and 16 MiB of transcript. A turn
 * on a real session is tens of kilobytes of transcript on average and the
 * largest are megabytes, so either bound can be the one that holds; what a
 * page costs is measured in the finding `native-view-performance`.
 */
export const DEFAULT_PAGE: TurnPage = { turns: 100, bytes: 16 * 1024 * 1024 };

/**
 * Which turns of a session are held and which are not (#152), folded in place
 * with the turns. Earlier turns are dropped as the window fills, oldest first
 * and never the newest, at the line that fills it, so where a tail cuts a
 * file into batches never changes what is held (live equals cold).
 *
 * The turns that are not held are kept by id, in order: a rewind can reach
 * back to one (#131), and then it drops everything after it, held or not.
 */
export interface TurnWindow {
	/** The most turns held. */
	turns: number;
	/** The most transcript bytes held, counted over the lines read while each held turn was the newest. */
	bytes: number;
	/** The ids of the turns not held, oldest first. */
	earlier: string[];
	/** Transcript bytes counted to each held turn, by id. */
	weights: Map<string, number>;
	/** The sum of {@link weights}. */
	held: number;
}

/** An empty window holding `pages` pages of `page` each. */
export function turnWindow(pages = 1, page: TurnPage = DEFAULT_PAGE): TurnWindow {
	return { turns: page.turns * pages, bytes: page.bytes * pages, earlier: [], weights: new Map(), held: 0 };
}

/** How many turns of the session `state` does not hold (#152). */
export function earlierTurnCount(state: ConversationState): number {
	return state.window?.earlier.length ?? 0;
}

/** What folding a batch did. */
export interface ReduceResult<S extends ConversationState = ConversationState> {
	/** The state folded into: the one the batch was given, changed in place. */
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
 * One agent's transcript reader (#137, #138). `reduce` folds a batch into the
 * state it is given, in place, and says which turns it changed; the state
 * carries whatever the parser must remember across batches (records an agent
 * writes twice, a queue that pairs with a later line), so a tail's batches
 * and a whole file read at once fold the same, whatever the split.
 *
 * Nothing copies the conversation per batch: a batch costs the lines in it,
 * not the session behind it. What must not be changed — the session's state
 * while a line not yet finished is previewed over it ({@link previewTail}) —
 * is {@link ConversationParser.fork}ed first, and the fork is folded instead.
 *
 * A parser folds through a {@link TurnDraft} built on the state's turns and
 * its {@link ConversationState.window}, and tells it each line's length
 * ({@link TurnDraft.weigh}) so the window can count bytes (#152).
 */
export interface ConversationParser<S extends ConversationState = ConversationState> {
	/** The state a session starts from, and what a rotation goes back to. */
	empty(): S;
	/**
	 * Folds a batch of whole lines — a whole file on open, a tail's worth
	 * afterwards — into `state`, changing it in place, and returns it. A line it
	 * cannot read is counted raw, never an error: a newer agent writes records
	 * this build has never seen.
	 */
	reduce(state: S, lines: string[]): ReduceResult<S>;
	/**
	 * A state to fold into in `state`'s stead: whatever `reduce` does to the
	 * fork leaves `state`, and everything reachable from it, as it was. Cheap:
	 * the turns are shared until the fork's fold writes into one
	 * ({@link forkConversation}), and the parser copies only what it keeps of
	 * its own. For a preview, which is thrown away; never folded into twice.
	 */
	fork(state: S): S;
}

/**
 * The part of a fork every parser shares (#138): the turns, borrowed, and the
 * raw counts, copied. A parser's own {@link ConversationParser.fork} adds what
 * it keeps besides.
 *
 * The turns are not copied here. {@link TurnDraft} copies a borrowed turn,
 * entry by entry, the first time a fold writes into it, so a preview of one
 * line copies the one or two turns that line touches and shares the rest.
 */
export function forkConversation<S extends ConversationState>(state: S): S {
	const turns = [...state.turns];
	BORROWED.set(turns, new WeakSet(state.turns));
	const fork: S = { ...state, turns, raw: { ...state.raw } };
	// A preview adds to what is shown and never drops a turn (#152): the fork
	// holds everything, and knows the earlier turns only for a rewind to name.
	if (state.window) {
		fork.window = {
			turns: Infinity,
			bytes: Infinity,
			earlier: [...state.window.earlier],
			weights: new Map(),
			held: 0,
		};
	}
	return fork;
}

/**
 * What the conversation would show if `tail` — the last line of the
 * transcript, written but not yet ended with its newline — were folded in
 * (#138), or null when it would show nothing new.
 *
 * An agent may write its newest record a moment before the newline that
 * ends it, and the view need not wait for that: a tail that is a whole JSON
 * record is folded into a {@link ConversationParser.fork} of `state`, which is
 * left as it was, so the line is folded for real, once, when it ends. A tail
 * that is not a whole record yet (the agent is still writing it), one that
 * changes no turn, and one whose fold would remove a turn (a rewind, a
 * re-sent prompt) show nothing until the line ends: a preview adds to what is
 * shown, it never takes a turn away. Every agent this view reads writes JSON
 * Lines, so "whole" is "parses as a JSON object".
 */
export function previewTail<S extends ConversationState>(
	parser: ConversationParser<S>,
	state: S,
	tail: string,
): ReduceResult<S> | null {
	const line = tail.trim();
	if (!line.startsWith('{') || !line.endsWith('}')) return null;
	try {
		JSON.parse(line);
	} catch {
		return null;
	}
	const result = parser.reduce(parser.fork(state), [line]);
	if (result.removedTurnIds.length || !result.changedTurnIds.length) return null;
	return result;
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
	/**
	 * The newest context breakdown a context command wrote into the
	 * transcript (Claude's `/context`, #171), which the session bar shows
	 * when its readout asked for it.
	 */
	contextReport?: ContextBreakdown;
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

/**
 * The turns of a fork that still belong to the state it was forked from, by
 * the fork's turn list: a fold copies one of these before writing into it.
 */
const BORROWED = new WeakMap<readonly Turn[], WeakSet<Turn>>();

/**
 * How a parser folds a batch into the turns (#138): in place, keeping count of
 * which turns the batch changed and which it removed.
 *
 * The turns are written into where they are, except in a fork
 * ({@link forkConversation}), where a turn the fork still shares with the
 * state it came from is copied, entry by entry, before the first write.
 * Nothing here walks every turn per batch: a change is almost always to the
 * newest turn or one just before it, and every lookup starts from the end.
 */
export class TurnDraft {
	/** Turns this batch opened: never anyone's to remove. */
	private readonly opened = new WeakSet<Turn>();
	/** Turn ids this batch changed, in order; a set, so marking is not a scan (#101). */
	private readonly changed = new Set<string>();
	/** Ids of turns that left the list in this batch, whether or not one came back. */
	private readonly left = new Set<string>();
	/**
	 * The ids of the turns the batch found, in order, taken at its first
	 * removal: what is reported removed, in the order it was found.
	 */
	private found: string[] | null = null;
	/** The turns still shared with the state this fork came from; null for a state's own turns. */
	private readonly borrowed: WeakSet<Turn> | null;

	/**
	 * `turns` is the state's own list, which this changes in place, and
	 * `window` the state's window, if it has one (#152), which it keeps.
	 */
	constructor(
		private readonly turns: Turn[],
		private readonly window: TurnWindow | null = null,
	) {
		this.borrowed = BORROWED.get(turns) ?? null;
	}

	/** The id of the turn open for new content, '' before the first. */
	lastId(): string {
		return this.turns[this.turns.length - 1]?.id ?? '';
	}

	/**
	 * Counts `bytes` of transcript to the newest turn (#152), and drops the
	 * earliest turns held while the window is over. A parser calls it once per
	 * line, with the line's length, after the line is folded; a parser that
	 * never calls it is held by its turn count alone.
	 */
	weigh(bytes: number): void {
		const window = this.window;
		const id = this.lastId();
		if (!window || !id || bytes <= 0) return;
		window.weights.set(id, (window.weights.get(id) ?? 0) + bytes);
		window.held += bytes;
		this.trim();
	}

	/** Drops one turn, if it is still here (#131), held or not (#152). */
	remove(turnId: string): void {
		const index = this.indexOf(turnId);
		if (index === -1) {
			const earlier = this.window?.earlier;
			const at = earlier ? earlier.lastIndexOf(turnId) : -1;
			if (earlier && at !== -1) earlier.splice(at, 1);
			return;
		}
		this.noteFound();
		this.turns.splice(index, 1);
		this.left.add(turnId);
		this.unweigh(turnId);
	}

	/**
	 * Drops every turn after `turnId`, or every turn for '' (#131). A turn
	 * that is no longer here drops nothing: what it named is already gone. A
	 * turn the window no longer holds (#152) drops every turn held and the
	 * earlier ones after it.
	 */
	dropAfter(turnId: string): void {
		let index = turnId ? this.indexOf(turnId) : -1;
		const earlier = this.window?.earlier;
		if (turnId && index === -1) {
			const at = earlier ? earlier.lastIndexOf(turnId) : -1;
			if (!earlier || at === -1) return;
			earlier.splice(at + 1);
		} else if (!turnId && earlier) earlier.length = 0;
		if (index === this.turns.length - 1) return;
		index = Math.max(index, -1);
		this.noteFound();
		for (const turn of this.turns.splice(index + 1)) {
			this.left.add(turn.id);
			this.unweigh(turn.id);
		}
	}

	/** The turn open for new content, or null before the first prompt. */
	current(): Turn | null {
		const index = this.turns.length - 1;
		return index >= 0 ? this.own(index) : null;
	}

	/** The turn `id`, ready to write into, or null when the draft holds none. */
	turn(id: string): Turn | null {
		const index = this.indexOf(id);
		return index === -1 ? null : this.own(index);
	}

	/** Opens a turn; `ts` is when, where the record that opened it says (#139). */
	open(id: string, prompt: string, ts = ''): Turn {
		const turn: Turn = { id, prompt, entries: [], headings: [], ...(ts ? { ts } : {}) };
		this.turns.push(turn);
		this.opened.add(turn);
		this.touch(id);
		this.trim();
		return turn;
	}

	/** Marks a turn as changed by this batch. */
	touch(id: string): void {
		this.changed.add(id);
	}

	/**
	 * The tool call `toolUseId`, ready to write into, searched from the newest
	 * turn back: an answer always answers a call that is already in the state.
	 */
	toolEntry(toolUseId: string): ToolEntry | null {
		for (let i = this.turns.length - 1; i >= 0; i--) {
			const turn = this.turns[i];
			if (!turn) continue;
			const at = turn.entries.findIndex((entry) => entry.kind === 'tool' && entry.id === toolUseId);
			if (at === -1) continue;
			const entry = this.own(i).entries[at];
			return entry?.kind === 'tool' ? entry : null;
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
			if (turn?.entries.some((entry) => entry.kind === 'tool' && entry.id === toolUseId)) return turn;
		}
		return null;
	}

	/**
	 * How many turns the session has, held or not (#152), for naming a turn
	 * whose record had no id: the same name however much is held.
	 */
	get length(): number {
		return this.turns.length + (this.window?.earlier.length ?? 0);
	}

	/**
	 * What the batch did: the turns it changed that are still here, and the
	 * turns it found and removed, in the order it found them. A turn opened and
	 * dropped within the batch was never anyone's to draw, and is neither.
	 *
	 * The headings of every turn the batch changed are recomputed here, in one
	 * place: prose arrives a block at a time, and a turn the batch did not touch
	 * still says what it said (#100). The changed turns are looked for from the
	 * newest back, which is where a batch changes them, so a tail's batch does
	 * not walk the session.
	 */
	finish(): { turns: Turn[]; changedTurnIds: string[]; removedTurnIds: string[] } {
		// Only a batch that removed something asks what is still here.
		const present = this.left.size ? new Set(this.turns.map((turn) => turn.id)) : null;
		const here = (id: string): boolean => !present || !this.left.has(id) || present.has(id);
		const changedTurnIds = [...this.changed].filter(here);
		const wanted = new Set(changedTurnIds);
		for (let i = this.turns.length - 1; i >= 0 && wanted.size > 0; i--) {
			const turn = this.turns[i];
			if (!turn || !wanted.delete(turn.id)) continue;
			this.own(i).headings = turnHeadings(turn.entries);
		}
		const removedTurnIds = present
			? [...new Set(this.found ?? [])].filter((id) => this.left.has(id) && !present.has(id))
			: [];
		return { turns: this.turns, changedTurnIds, removedTurnIds };
	}

	/**
	 * Drops the earliest turns held while the window holds too many or too
	 * many bytes (#152), never the newest. A dropped turn is reported removed,
	 * like a rewind's, unless this batch opened it: nobody drew that one.
	 */
	private trim(): void {
		const window = this.window;
		if (!window) return;
		while (this.turns.length > 1 && (this.turns.length > window.turns || window.held > window.bytes)) {
			this.noteFound();
			const turn = this.turns.shift() as Turn;
			this.left.add(turn.id);
			this.unweigh(turn.id);
			window.earlier.push(turn.id);
		}
	}

	/** Takes a turn that left the held ones out of the window's count. */
	private unweigh(id: string): void {
		const window = this.window;
		const weight = window?.weights.get(id);
		if (!window || weight === undefined) return;
		window.weights.delete(id);
		window.held -= weight;
	}

	/** Where turn `id` is, the newest first, or -1. */
	private indexOf(id: string): number {
		for (let i = this.turns.length - 1; i >= 0; i--) {
			if (this.turns[i]?.id === id) return i;
		}
		return -1;
	}

	/** Remembers the turns the batch found, in order, before the first removal. */
	private noteFound(): void {
		if (this.found) return;
		this.found = this.turns.filter((turn) => !this.opened.has(turn)).map((turn) => turn.id);
	}

	/**
	 * The turn at `index`, ready to write into: itself, or in a fork, a copy
	 * swapped in for one still shared with the state the fork came from.
	 *
	 * The entries are copied too, one object each: a text merge, a tool result,
	 * a notification and a report all write into an entry. The `input` record
	 * and the notification inside an entry are replaced rather than written
	 * into, so sharing those costs nothing.
	 */
	private own(index: number): Turn {
		const turn = this.turns[index] as Turn;
		if (!this.borrowed?.has(turn)) return turn;
		const copy: Turn = { ...turn, entries: turn.entries.map((entry) => ({ ...entry })) };
		this.turns[index] = copy;
		return copy;
	}
}

/**
 * A background subagent's report, attached to the call that launched it (#96).
 *
 * The read itself is the session model's: this is the part without I/O, so a
 * report that arrives long after its lines did still goes through one place
 * and comes back as a changed turn id like everything else. An id no turn
 * holds changes nothing, which is what a rotation between the read and its
 * answer looks like. In place, like a parser's fold.
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
	const { changedTurnIds, removedTurnIds } = draft.finish();
	return { state, changedTurnIds, removedTurnIds };
}

/**
 * A subagent's progress put on the call it hangs under, or taken off it
 * (`undefined`) once nothing follows it (#147). In place, like
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
	const { changedTurnIds, removedTurnIds } = draft.finish();
	return { state, changedTurnIds, removedTurnIds };
}

/**
 * Every call still running marked lost (#135): the agent that ran it is gone,
 * and nothing will report it. In place, like {@link attachSubagentReport};
 * the session model decides when the agent is gone.
 */
export function markLost<S extends ConversationState>(state: S): ReduceResult<S> {
	const draft = new TurnDraft(state.turns);
	for (const turn of state.turns) {
		for (const entry of turn.entries) {
			if (entry.kind !== 'tool' || entry.status !== 'running') continue;
			entry.status = 'lost';
			draft.touch(turn.id);
		}
	}
	const { changedTurnIds, removedTurnIds } = draft.finish();
	return { state, changedTurnIds, removedTurnIds };
}


/** An empty conversation, for a view with nothing to show and for a fake. */
export function emptyConversation(): ConversationState {
	return { turns: [], raw: {} };
}
