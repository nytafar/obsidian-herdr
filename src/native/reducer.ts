/**
 * The transcript reducer (issue #93, ADR-0003).
 *
 * Pure, and the only place that knows what a Claude Code transcript line means.
 * `reduce(state, lines)` folds a batch of NDJSON lines — a whole file on open,
 * a tail's worth afterwards — into the session model's state and says which
 * turns changed, so the native surface can redraw those and nothing else.
 *
 * The rules come from the verified facts in `docs/architecture.md` (section
 * "Agent prompts and session identity") and the design (`native-view-design.md`
 * in the vault docs root):
 *
 * - A **turn** starts at a human prompt: a `user` line whose content is a
 *   string, that is not `isMeta`, and that no queue enqueue of the same content
 *   preceded. That last clause is the whole of the difference between a prompt
 *   and a background subagent's `<task-notification>`, which also arrives as a
 *   string `user` line. One exception: a prompt sent over stream-json (the
 *   `claude` kind, ADR-0007) is enqueued and dequeued before its `user` line
 *   as a matter of course, and that line says where it came from
 *   (`promptSource: "sdk"`, `entrypoint: "sdk-cli"`), so it is a prompt.
 *   A prompt written as content blocks — a pasted image — is a prompt too
 *   (#129): its text blocks are the prompt and each image a placeholder entry.
 * - A **steer** — a prompt accepted while the agent was working — never becomes
 *   a `user` line at all. It shows as a `queued_command` attachment with
 *   `origin.kind: "human"`, and belongs inline in the turn already running.
 * - Assistant content is **merged by message id**: one message's text blocks
 *   are one block of prose however many transcript lines carried them, and its
 *   `thinking` and `tool_use` blocks are entries of their own.
 * - A `tool_result` attaches to the `tool_use` it answers.
 * - Everything else is **raw**: counted by line type so a session can be
 *   diagnosed, rendered nowhere. A line that is not JSON at all — a half-
 *   written tail — is raw too rather than an error. Unknown types are normal:
 *   a newer Claude Code writes line types this build has never seen.
 *
 * What is deliberately *not* here: status (that is herdr's `agent_status`, and
 * the session model's), following (also the session model's), and rendering.
 */

/**
 * A human prompt written by a stream-json host rather than typed in a
 * terminal: Claude Code 2.1.318 enqueues and dequeues every such prompt
 * before its `user` line (measured 2026-11-06, ADR-0007), so the enqueue that
 * marks injected content elsewhere says nothing here. The line names its
 * source; a task notification is still one, whatever carried it.
 */
function isStreamPrompt(line: Record<string, unknown>, content: string): boolean {
	const origin = isRecord(line.origin) ? line.origin : null;
	if (origin?.kind === 'task-notification' || taskNotification(content)) return false;
	return line.promptSource === 'sdk' || line.entrypoint === 'sdk-cli';
}

/** One assistant message's prose, merged across every line that carried it. */
export interface TextEntry {
	kind: 'text';
	messageId: string;
	text: string;
}

/**
 * That a message thought before it spoke, and what it thought.
 *
 * The text is kept because the view shows it in a collapsed disclosure (#95).
 * A block that carries only a `signature` — an encrypted thought this build may
 * not read — has an empty text, and the view shows nothing for it.
 */
export interface ThinkingEntry {
	kind: 'thinking';
	messageId: string;
	text: string;
}

/**
 * A background task's completion, as its `<task-notification>` reported it
 * (issue #96, `docs/architecture.md`).
 *
 * The notification names the tool call it belongs to and the file the task
 * wrote. For an `Agent` call that file is the subagent's own transcript, and
 * the report is the last thing it said; the reducer does not read it, because
 * reading is not pure — the session model does, and feeds the text back.
 */
export interface TaskNotification {
	/** The task's own id; also the name of the subagent transcript. */
	taskId: string;
	/** The file the task wrote, empty when the notification named none. */
	outputFile: string;
}

/**
 * Where a tool call has got to, in the four states of the normalized model
 * (#91). What each means in a Claude Code transcript:
 *
 * - `pending` — the `tool_use` block is there and nothing has answered it.
 * - `running` — the result came back but the work did not: an async subagent's
 *   launch notice, whose real answer is the task notification later on.
 * - `done` — a result answered, or the notification reported the background
 *   work completed.
 * - `error` — the result carried `is_error`, which is what a failed call and a
 *   call the user refused both look like, or the notification reported
 *   anything other than completion.
 */
export type ToolStatus = 'pending' | 'running' | 'done' | 'error';

/** A tool call and, once it lands, the result that answered it. */
export interface ToolEntry {
	kind: 'tool';
	id: string;
	name: string;
	/**
	 * The call's input, exactly as the transcript gave it. The reducer knows no
	 * tool: which field is a path, a command or a query is the view's kind table
	 * (`./toolCalls.ts`), so that stays one place and this stays dumb.
	 */
	input: Record<string, unknown>;
	/** null until the `tool_result` line arrives. */
	result: string | null;
	/** How far the call has got; the view says so for a vault change (#95). */
	status: ToolStatus;
	/**
	 * The task notification that reported this call finished, for the background
	 * calls that get one; null for every other call.
	 */
	notification: TaskNotification | null;
	/**
	 * A background subagent's report, once it has been read out of the file the
	 * notification named. Written by the session model, never by a transcript
	 * line. A synchronous subagent has no notification and its report is simply
	 * its {@link ToolEntry.result}.
	 */
	report: string | null;
}

/** A human prompt consumed inside a running turn, shown where it entered. */
export interface SteerEntry {
	kind: 'steer';
	text: string;
}

/**
 * A picture the human sent with a prompt (#129), kept as a placeholder: the
 * bytes stay in the transcript, and the view says only that one was there.
 * Placed first in its turn's entries, so it reads under the prompt it came
 * with.
 */
export interface ImageEntry {
	kind: 'image';
	/** The picture's media type as the transcript gave it, '' when it gave none. */
	mediaType: string;
}

/**
 * Where the agent's context was compacted (#130): the conversation before it
 * was folded into a summary, which the agent continues from. Shown as a
 * divider with the summary folded, at the point it happened, never as a
 * prompt.
 */
export interface CompactionEntry {
	kind: 'compaction';
	/** The summary the agent continued from, as Markdown. */
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
	/** When it was written, '' when the line did not say; lines a moment apart join. */
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

export type TurnEntry =
	| TextEntry
	| ThinkingEntry
	| ToolEntry
	| SteerEntry
	| ImageEntry
	| CompactionEntry
	| NoticeEntry
	| ShellEntry;

/** One Markdown heading in a turn's assistant prose, for the TOC (#100). */
export interface TurnHeading {
	/** 1 to 6, as the number of `#` says. */
	level: number;
	text: string;
}

/** A human prompt and everything the agent did until it stopped. */
export interface Turn {
	/** The prompt line's uuid; stable, so a view can redraw one turn in place. */
	id: string;
	prompt: string;
	entries: TurnEntry[];
	/**
	 * The headings of this turn's assistant prose, in order (#100). Computed
	 * here so the table of contents parses nothing; recomputed whenever the turn
	 * changes, because prose arrives a block at a time.
	 */
	headings: TurnHeading[];
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

export interface TranscriptState {
	turns: Turn[];
	/**
	 * Lines that render nothing, counted by their `type` field. `(unparsed)`
	 * counts lines that were not JSON and `(untyped)` JSON without a string
	 * type. Counts rather than the lines themselves: a transcript is mostly
	 * attachments, and the view has no use for their content.
	 */
	raw: Record<string, number>;
	/**
	 * Contents of queue enqueues not yet matched to a `user` line, oldest first.
	 * This is what tells a subagent notification from a human prompt.
	 */
	pendingQueue: string[];
	/** Which records the conversation stands on, for a rewind (#131). */
	branch: BranchState;
}

/** Where one record landed, for a prompt that later hangs from it (#131). */
export interface RecordMark {
	/** The turn that was last when the record was folded, '' before any. */
	turn: string;
	/** How many answers had been written by then, this record included. */
	answers: number;
}

/**
 * The branch of the conversation the session is on (#131).
 *
 * Claude Code links every record to the one before it (`parentUuid`) and never
 * rewrites the file. A rewind (Esc Esc, Restore) leaves the turns it went back
 * over in place, and the next prompt hangs from the record it went back to;
 * a prompt cancelled before any reply and sent again is written as a sibling
 * of the cancelled one, under the same parent. This is what reading a prompt
 * needs to know to drop what the conversation left behind.
 */
export interface BranchState {
	/** The record folded last, null before any. */
	last: string | null;
	/** Every record folded so far, by uuid. Replaced, never written into. */
	records: ReadonlyMap<string, RecordMark>;
	/** Answers (assistant records) written so far. */
	answers: number;
	/**
	 * Answers written before the conversation last started over (an in-file
	 * `/clear`, #134): a prompt that hangs from nothing reaches back to here.
	 */
	floor: number;
	/** The newest prompt, what it hangs from and whether anything answered it. */
	lastPrompt: { turnId: string; parent: string; answered: boolean } | null;
}

export interface ReduceResult {
	state: TranscriptState;
	/** Turn ids created or changed by this batch, in order, each once. */
	changedTurnIds: string[];
	/**
	 * Turn ids the state held before this batch and holds no more: a rewind's
	 * abandoned turns and a cancelled prompt's (#131). A view drops them.
	 */
	removedTurnIds: string[];
}

/** The state a session starts from, and what a rotation goes back to. */
export function emptyTranscript(): TranscriptState {
	return {
		turns: [],
		raw: {},
		pendingQueue: [],
		branch: { last: null, records: new Map(), answers: 0, floor: 0, lastPrompt: null },
	};
}

/** Raw counter key for a line that was not JSON. */
const UNPARSED = '(unparsed)';
/** Raw counter key for a JSON line with no string `type`. */
const UNTYPED = '(untyped)';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(source: Json, key: string): string {
	const value = source[key];
	return typeof value === 'string' ? value : '';
}

/**
 * The text of a `tool_result` block's content, which is either a string or the
 * usual array of content blocks.
 */
function resultText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === 'text') parts.push(stringField(block, 'text'));
	}
	return parts.join('\n\n');
}

/**
 * What a string `user` line is, beyond a plain prompt.
 *
 * A slash command run at the keyboard reaches the transcript as three `user`
 * lines: an `isMeta` caveat, the command itself wrapped in `<command-name>`,
 * and its `<local-command-stdout>`. Only the middle one is the human speaking,
 * and what it should say is the command as typed.
 */
function commandPrompt(content: string): string | null {
	const name = /^<command-name>([^<]*)<\/command-name>/.exec(content);
	if (!name) return null;
	const args = /<command-args>([^<]*)<\/command-args>/.exec(content);
	return `${name[1] ?? ''} ${args?.[1] ?? ''}`.trim();
}

/** The text of one `<tag>` in a task notification, empty when it has none. */
function notificationField(content: string, tag: string): string {
	const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(content);
	return match?.[1]?.trim() ?? '';
}

/**
 * The notification in a string `user` line, or null when the line is not one.
 *
 * A background task — a `Bash` run in the background or an async `Agent` —
 * reports its completion as a `<task-notification>` block that names the tool
 * call it answers and the file it wrote (`docs/architecture.md`, measured
 * 2026-09-15). It arrives as an enqueue and then a `user` line, which is why it
 * is never a turn.
 */
function taskNotification(
	content: string,
): { toolUseId: string; completed: boolean; notification: TaskNotification } | null {
	if (!content.trimStart().startsWith('<task-notification>')) return null;
	return {
		toolUseId: notificationField(content, 'tool-use-id'),
		// `completed`, `failed` and `killed` are the three values this machine's
		// transcripts carry; only the first is the work having gone well.
		completed: notificationField(content, 'status') === 'completed',
		notification: {
			taskId: notificationField(content, 'task-id'),
			outputFile: notificationField(content, 'output-file'),
		},
	};
}

/**
 * How an async `Agent` call's `tool_result` opens: the launch notice Claude
 * Code writes when the subagent goes to the background, measured across every
 * transcript on this machine on 2026-09-15. The rest of the notice is the agent
 * id, the output file and instructions never to quote any of it.
 */
const ASYNC_LAUNCH_NOTICE = /^async agent launched/i;

/**
 * Whether a tool result is an async subagent's launch notice rather than
 * anything it did: the work is still running and its report will come from the
 * file the notification names (`docs/architecture.md`, #96).
 */
export function isAsyncLaunchNotice(result: string | null): boolean {
	return ASYNC_LAUNCH_NOTICE.test((result ?? '').trimStart());
}

/**
 * The marker Claude Code writes when the human stops a turn, as a `user` line
 * of content blocks: `[Request interrupted by user]`, or `… for tool use]`.
 * It is the runtime's bookkeeping, not anything the human typed.
 */
const INTERRUPTED = /^\[Request interrupted by user/;

/**
 * A prompt written as content blocks rather than a string (#129): what a TUI
 * prompt with a pasted image is (`[{text: "[Image #3]"}, {image}]`, measured
 * on 2.1.283), with no `isMeta`. The text blocks are the prompt; each image is
 * kept as a placeholder. Null for a line that is no prompt: one that carries
 * nothing but tool results, an interruption marker, or a task notification.
 */
function blockPrompt(
	line: Json,
	content: readonly unknown[],
): { text: string; images: ImageEntry[] } | null {
	if (line.isMeta === true || typeof line.interruptedMessageId === 'string') return null;
	const texts: string[] = [];
	const images: ImageEntry[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === 'text') {
			const text = stringField(block, 'text');
			if (INTERRUPTED.test(text) || taskNotification(text)) continue;
			if (text.trim()) texts.push(text);
		} else if (block.type === 'image') {
			const source = isRecord(block.source) ? block.source : {};
			images.push({ kind: 'image', mediaType: stringField(source, 'media_type') });
		}
	}
	if (texts.length === 0 && images.length === 0) return null;
	return { text: texts.join('\n'), images };
}

/** What the runtime writes for the model's eyes only, inside a summary. */
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;

/**
 * The summary of a compaction, from its `user` line (#130): Claude Code
 * writes it as a string `user` line with `isCompactSummary: true` (measured on
 * 2.1.286 and 2.1.318), sometimes as text blocks. The reminders inside it are
 * the model's, not the reader's.
 */
function compactionSummary(content: unknown): string {
	const text = typeof content === 'string' ? content : resultText(content);
	return text.replace(SYSTEM_REMINDER, '').trim();
}

/** Notices written this close together are one notice (#133). */
const NOTICE_JOIN_MS = 1000;

/** A notice is not a log: past this, the rest stays in the terminal. */
const NOTICE_MAX_CHARS = 4000;

/** Terminal escape sequences and other controls, which a notice or a shell's output may carry. */
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROLS = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

/** Text as the terminal showed it, without its escape codes, cut to a notice's length. */
function plainText(text: string): string {
	const plain = text.replace(TERMINAL_CONTROLS, '');
	return plain.length > NOTICE_MAX_CHARS ? `${plain.slice(0, NOTICE_MAX_CHARS)}\u2026` : plain;
}

/** Whether two lines were written together; never when either has no readable time. */
function writtenTogether(a: string, b: string): boolean {
	const first = Date.parse(a);
	const second = Date.parse(b);
	return !Number.isNaN(first) && !Number.isNaN(second) && Math.abs(first - second) <= NOTICE_JOIN_MS;
}

/**
 * Whether a string `user` line is the human's own, as bash mode writes it:
 * a typed prompt carries `origin` and `permissionMode`, a bash-mode line
 * neither (measured on 2.1.286 and 2.1.318), so a prompt that merely quotes
 * the tags is not taken for one.
 */
function bashModeLine(line: Json): boolean {
	return !('origin' in line) && !('permissionMode' in line);
}

/** The command of a bash-mode line: the whole line is `<bash-input>…</bash-input>`. */
const BASH_INPUT = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/;

/** What a bash-mode command printed: `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`. */
const BASH_OUTPUT = /^\s*<bash-stdout>([\s\S]*)<\/bash-stdout>\s*(?:<bash-stderr>([\s\S]*)<\/bash-stderr>)?\s*$/;

/** The newest shell entry still waiting for what its command printed, or null. */
function waitingShell(entries: readonly TurnEntry[]): ShellEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.kind === 'shell' && entry.stdout === null) return entry;
	}
	return null;
}

/** True for a `user` line that is a local command's own output, not a prompt. */
function isLocalCommandOutput(content: string): boolean {
	return content.startsWith('<local-command-stdout>');
}

/** A working copy of one turn, so the reducer never mutates the state it was given. */
class Draft {
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

	constructor(turns: Turn[]) {
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

	open(id: string, prompt: string): Turn {
		const turn: Turn = { id, prompt, entries: [], headings: [] };
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
	 * The turn holding the tool call `toolUseId`, searched from the newest back:
	 * a result always answers a call that is already in the state.
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

	/** How many turns the draft holds, for naming a turn whose line had no uuid. */
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
 * What a record hangs from: its `parentUuid`, or for a compaction's boundary,
 * which starts a chain of its own (`parentUuid: null`), the record it
 * continues (`logicalParentUuid`). Null for a record that hangs from nothing,
 * undefined for one that does not say.
 */
function parentOf(line: Json): string | null | undefined {
	const parent = line.parentUuid;
	if (parent === null) return typeof line.logicalParentUuid === 'string' ? line.logicalParentUuid : null;
	return typeof parent === 'string' ? parent : undefined;
}

/**
 * A working copy of the {@link BranchState}, for one batch (#131).
 *
 * A record is marked once it has been folded, so the mark names the turn it
 * landed in — a prompt's own record names the turn it opened. Records on a
 * side chain (a subagent's, inlined by older builds) are not the session's
 * conversation and are not marked.
 */
class Branch {
	private last: string | null;
	private readonly records: Map<string, RecordMark>;
	private answers: number;
	private floor: number;
	private lastPrompt: BranchState['lastPrompt'];
	/** The record being folded, marked by {@link settle}. */
	private pending: { uuid: string; answer: boolean } | null = null;

	constructor(state: BranchState) {
		this.last = state.last;
		this.records = new Map(state.records);
		this.answers = state.answers;
		this.floor = state.floor;
		this.lastPrompt = state.lastPrompt;
	}

	/** The line about to be folded; marked when the next one arrives. */
	saw(line: Json): void {
		const uuid = line.uuid;
		if (typeof uuid !== 'string' || !uuid || line.isSidechain === true) return;
		this.pending = { uuid, answer: line.type === 'assistant' };
	}

	/** Marks the line folded last where it landed. */
	settle(draft: Draft): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = null;
		if (pending.answer) {
			this.answers++;
			if (this.lastPrompt) this.lastPrompt = { ...this.lastPrompt, answered: true };
		}
		this.records.set(pending.uuid, { turn: draft.lastId(), answers: this.answers });
		this.last = pending.uuid;
	}

	/**
	 * A prompt is about to open a turn: drops what the conversation left
	 * behind to get here. A prompt that hangs from the newest prompt's own
	 * parent while nothing answered that one is its re-send, and the cancelled
	 * one goes. A prompt that hangs from an earlier record than the last, with
	 * an answer written since that record, forks: every turn after the one that
	 * record landed in goes. A parent this read never saw hides nothing.
	 */
	fork(line: Json, draft: Draft): void {
		const parent = parentOf(line);
		if (parent === undefined) return;
		const previous = this.lastPrompt;
		if (previous && !previous.answered && parent !== null && parent === previous.parent) {
			draft.remove(previous.turnId);
			return;
		}
		if (this.last === null || parent === this.last) return;
		const mark = parent === null ? { turn: '', answers: this.floor } : this.records.get(parent);
		if (mark && this.answers > mark.answers) draft.dropAfter(mark.turn);
	}

	/** A prompt opened `turnId`; it is the newest now, and nothing answered it yet. */
	prompted(turnId: string, line: Json): void {
		const parent = parentOf(line);
		this.lastPrompt = { turnId, parent: typeof parent === 'string' ? parent : '', answered: false };
	}

	finish(): BranchState {
		return {
			last: this.last,
			records: this.records,
			answers: this.answers,
			floor: this.floor,
			lastPrompt: this.lastPrompt,
		};
	}
}

/**
 * Folds `lines` into `state`. Neither `state` nor anything reachable from it is
 * mutated: turns this batch touched are replaced by copies, the rest are shared.
 */
export function reduce(state: TranscriptState, lines: string[]): ReduceResult {
	const draft = new Draft(state.turns);
	const raw = { ...state.raw };
	const pendingQueue = [...state.pendingQueue];
	const branch = new Branch(state.branch);

	const countRaw = (key: string): void => {
		raw[key] = (raw[key] ?? 0) + 1;
	};
	/**
	 * Opens the turn a human prompt starts, after dropping what a rewind or a
	 * re-send left behind (#131).
	 */
	const openPrompt = (line: Json, prompt: string): Turn => {
		branch.fork(line, draft);
		const turn = draft.open(stringField(line, 'uuid') || `turn-${draft.length}`, prompt);
		branch.prompted(turn.id, line);
		return turn;
	};

	for (const line of lines) {
		// The line before this one has landed; where is what a rewind reads.
		branch.settle(draft);
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			countRaw(UNPARSED);
			continue;
		}
		if (!isRecord(parsed)) {
			countRaw(UNTYPED);
			continue;
		}
		const type = stringField(parsed, 'type');
		if (!type) {
			countRaw(UNTYPED);
			continue;
		}
		branch.saw(parsed);

		switch (type) {
			case 'queue-operation': {
				// Only the enqueue matters: it is what a later `user` line of the
				// same content is matched against. `dequeue` and `remove` say the
				// queue moved on, and the pairing has already been made by then.
				if (stringField(parsed, 'operation') === 'enqueue') {
					const content = stringField(parsed, 'content');
					if (content) pendingQueue.push(content);
				}
				countRaw(type);
				continue;
			}
			case 'attachment': {
				const attachment = isRecord(parsed.attachment) ? parsed.attachment : null;
				const origin = attachment && isRecord(attachment.origin) ? attachment.origin : null;
				const human = attachment?.type === 'queued_command' && origin?.kind === 'human';
				if (!human) {
					countRaw(type);
					continue;
				}
				const text = stringField(attachment, 'prompt');
				// The steer's own enqueue is spent here: it was pushed when the
				// prompt was accepted and no `user` line will ever pair with it.
				// Left behind, it would swallow the next ordinary prompt of the
				// same words as injected content (#93, #96).
				const enqueued = pendingQueue.indexOf(text);
				if (enqueued !== -1) pendingQueue.splice(enqueued, 1);
				const turn = draft.current();
				if (turn) {
					// A steer is consumed inside the turn already running, and shows
					// where it entered the context (CONTEXT.md, native-view-design.md).
					turn.entries.push({ kind: 'steer', text });
					draft.touch(turn.id);
				} else {
					// Nothing is running: the prompt is simply this turn's prompt.
					draft.open(stringField(parsed, 'uuid') || `steer-${text.slice(0, 32)}`, text);
				}
				continue;
			}
			case 'user': {
				const message = isRecord(parsed.message) ? parsed.message : null;
				const content = message?.content;
				if (parsed.isCompactSummary === true) {
					// Not the human speaking, however much it reads like a prompt: a
					// divider in the turn it happened in (#130).
					const turn = draft.current() ?? draft.open(stringField(parsed, 'uuid') || `turn-${draft.length}`, '');
					turn.entries.push({ kind: 'compaction', summary: compactionSummary(content) });
					draft.touch(turn.id);
					continue;
				}
				if (Array.isArray(content)) {
					let attached = false;
					for (const block of content) {
						if (!isRecord(block) || block.type !== 'tool_result') continue;
						const toolUseId = stringField(block, 'tool_use_id');
						const entry = draft.toolEntry(toolUseId);
						if (!entry) continue;
						entry.result = resultText(block.content);
						// A failed call and one the user refused both arrive as
						// `is_error`; a launch notice means the work goes on (#91).
						entry.status =
							block.is_error === true
								? 'error'
								: isAsyncLaunchNotice(entry.result)
									? 'running'
									: 'done';
						// The turn that changed is the one holding the call, which is
						// not always the turn now open: a background command answers
						// after the next prompt has started one (#93, #94).
						const turn = draft.turnOf(toolUseId);
						if (turn) draft.touch(turn.id);
						attached = true;
					}
					// A prompt of content blocks — a pasted image, a pasted block —
					// is a prompt like a string one (#129). A line of tool results
					// carries no text of the human's and opens nothing.
					const sent = blockPrompt(parsed, content);
					if (sent) {
						const turn = openPrompt(parsed, sent.text);
						turn.entries.push(...sent.images);
						continue;
					}
					if (!attached) countRaw(type);
					continue;
				}
				if (typeof content !== 'string' || parsed.isMeta === true) {
					countRaw(type);
					continue;
				}
				const queued = pendingQueue.indexOf(content);
				if (queued !== -1 && isStreamPrompt(parsed, content)) {
					// Its own enqueue, spent; then an ordinary prompt below.
					pendingQueue.splice(queued, 1);
				} else if (queued !== -1) {
					// Enqueued before it arrived: a subagent's task notification, or a
					// steer that has already been rendered from its attachment.
					pendingQueue.splice(queued, 1);
					// A notification belongs to the call it names, not to the
					// conversation: it is how a background task says it finished (#96).
					const task = taskNotification(content);
					const entry = task ? draft.toolEntry(task.toolUseId) : null;
					if (task && entry) {
						entry.notification = task.notification;
						// The background work is over, one way or the other (#91).
						entry.status = task.completed ? 'done' : 'error';
						const turn = draft.turnOf(task.toolUseId);
						if (turn) draft.touch(turn.id);
					}
					countRaw(type);
					continue;
				}
				if (isLocalCommandOutput(content)) {
					countRaw(type);
					continue;
				}
				if (bashModeLine(parsed)) {
					// Bash mode (#133): the command opens a turn as a prompt does,
					// and the line after it holds what it printed.
					const command = BASH_INPUT.exec(content);
					if (command) {
						const turn = openPrompt(parsed, '');
						turn.entries.push({ kind: 'shell', command: (command[1] ?? '').trim(), stdout: null, stderr: '' });
						continue;
					}
					const printed = BASH_OUTPUT.exec(content);
					if (printed) {
						const turn = draft.current();
						const shell = turn ? waitingShell(turn.entries) : null;
						if (turn && shell) {
							shell.stdout = plainText((printed[1] ?? '').replace(/\n+$/, ''));
							shell.stderr = plainText((printed[2] ?? '').replace(/\n+$/, ''));
							draft.touch(turn.id);
						} else countRaw(type);
						continue;
					}
				}
				openPrompt(parsed, commandPrompt(content) ?? content);
				continue;
			}
			case 'assistant': {
				const message = isRecord(parsed.message) ? parsed.message : null;
				const content = message?.content;
				if (!message || !Array.isArray(content)) {
					countRaw(type);
					continue;
				}
				const messageId = stringField(message, 'id');
				// Content before any prompt (a transcript read from the middle) still
				// belongs somewhere: it opens a turn with no prompt of its own.
				const turn = draft.current() ?? draft.open(messageId || 'turn-0', '');
				for (const block of content) {
					if (!isRecord(block)) continue;
					if (block.type === 'text') {
						const text = stringField(block, 'text');
						if (!text) continue;
						const existing = turn.entries.find(
							(entry): entry is TextEntry =>
								entry.kind === 'text' && entry.messageId === messageId,
						);
						if (existing) existing.text = `${existing.text}\n\n${text}`;
						else turn.entries.push({ kind: 'text', messageId, text });
					} else if (block.type === 'thinking') {
						// Merged by message id like text, for the same reason: one
						// message's thought is one disclosure however many lines it took.
						const text = stringField(block, 'thinking');
						const existing = turn.entries.find(
							(entry): entry is ThinkingEntry =>
								entry.kind === 'thinking' && entry.messageId === messageId,
						);
						if (!existing) turn.entries.push({ kind: 'thinking', messageId, text });
						else if (text) {
							existing.text = existing.text ? `${existing.text}\n\n${text}` : text;
						}
					} else if (block.type === 'tool_use') {
						turn.entries.push({
							kind: 'tool',
							id: stringField(block, 'id'),
							name: stringField(block, 'name'),
							input: isRecord(block.input) ? block.input : {},
							result: null,
							// Nothing has answered it yet; a result or a notification
							// moves it on (#91).
							status: 'pending',
							notification: null,
							report: null,
						});
					}
				}
				draft.touch(turn.id);
				continue;
			}
			case 'system': {
				// The runtime's own notices (#133). A slash command's output, the
				// `local_command` subtype, stays hidden as its `user` form does: the
				// command itself is the turn, and what it set is the session
				// chrome's to show.
				if (stringField(parsed, 'subtype') !== 'informational') {
					countRaw(type);
					continue;
				}
				const text = plainText(stringField(parsed, 'content')).trim();
				if (!text) {
					countRaw(type);
					continue;
				}
				const at = stringField(parsed, 'timestamp');
				const turn = draft.current() ?? draft.open(stringField(parsed, 'uuid') || `notice-${draft.length}`, '');
				const last = turn.entries[turn.entries.length - 1];
				// Claude Code writes one notice as several lines a moment apart
				// ("Unknown command" and the arguments it dropped).
				if (last?.kind === 'notice' && writtenTogether(last.at, at)) {
					last.text = plainText(`${last.text}\n${text}`);
				} else turn.entries.push({ kind: 'notice', text, at });
				draft.touch(turn.id);
				continue;
			}
			default:
				countRaw(type);
				continue;
		}
	}

	branch.settle(draft);
	const { turns, changedTurnIds, removedTurnIds } = draft.finish();
	return { state: { turns, raw, pendingQueue, branch: branch.finish() }, changedTurnIds, removedTurnIds };
}

/**
 * A background subagent's report, attached to the call that launched it (#96).
 *
 * The read itself is the session model's: this is the pure half, so a report
 * that arrives long after its lines did still goes through one place and comes
 * back as a changed turn id like everything else. An id no turn holds changes
 * nothing, which is what a rotation between the read and its answer looks like.
 */
export function attachSubagentReport(
	state: TranscriptState,
	toolUseId: string,
	report: string,
): ReduceResult {
	const draft = new Draft(state.turns);
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
 * The last thing an assistant said in a transcript: a subagent's report, read
 * out of its own file (`docs/architecture.md`). Lines that are not JSON, and
 * everything that is not assistant text, are skipped; an empty answer means
 * the file held no report, and the caller tries the next place.
 */
export function lastAssistantText(lines: readonly string[]): string {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line?.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(parsed) || parsed.type !== 'assistant') continue;
		const message = isRecord(parsed.message) ? parsed.message : null;
		const content = message?.content;
		if (!Array.isArray(content)) continue;
		const parts: string[] = [];
		for (const block of content) {
			if (isRecord(block) && block.type === 'text') parts.push(stringField(block, 'text'));
		}
		const text = parts.join('\n\n').trim();
		if (text) return text;
	}
	return '';
}
