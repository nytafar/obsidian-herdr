/**
 * Claude Code's transcript parser (issues #93, #137; ADR-0003, ADR-0010).
 *
 * Pure, and the only place that knows what a Claude Code transcript line means.
 * It sits behind the agent seam (`../format.ts`): `reduce(state, lines)` folds a
 * batch of NDJSON lines — a whole file on open, a tail's worth afterwards —
 * into the agent-neutral conversation model (`../../native/conversation.ts`)
 * and says which turns changed, so the native surface can redraw those and
 * nothing else.
 *
 * The rules come from the verified facts in `docs/architecture.md` (section
 * "Agent prompts and session identity") and the design (`native-view-design.md`
 * in the vault docs root):
 *
 * - A **turn** starts at a human prompt: a `user` line whose content is a
 *   string, that is not `isMeta`, and that either says a human sent it or no
 *   pending queue enqueue of the same content preceded. A line says so by
 *   `origin.kind: "human"` or its `promptSource` (`typed`, `queued`, `sdk`):
 *   a prompt queued while Claude worked and run as a turn of its own after
 *   the turn ended is `enqueue`, `dequeue`, then such a line with
 *   `promptSource: "queued"` (#157), and a prompt sent over stream-json (the
 *   `claude` kind, ADR-0007) is enqueued and dequeued before its line as a
 *   matter of course (`promptSource: "sdk"`, `entrypoint: "sdk-cli"`). A line
 *   that says nothing of where it came from, after an enqueue of its words,
 *   is injected content and opens nothing.
 * - The **queue** is mirrored only as far as the transcript says: `remove`
 *   and `popAll` name the entry they spend; `dequeue` names none, and is not
 *   always the oldest (measured: 47 of 1,434 on this machine took another),
 *   so a dequeue spends entries only once the dequeues not yet paired with a
 *   line cover every entry pending. A cancelled stream-json message is such a
 *   bare dequeue. Nothing a human sends is dropped against a stale entry.
 *   A prompt written as content blocks — a pasted image — is a prompt too
 *   (#129): its text blocks are the prompt and each image an entry that
 *   says where its bytes are (#144), never the bytes.
 * - A **steer** — a prompt accepted while the agent was working — never becomes
 *   a `user` line at all. It shows as a `queued_command` attachment with
 *   `origin.kind: "human"`, and belongs inline in the turn already running.
 * - Assistant content is **merged by message id**: one message's text blocks
 *   are one block of prose however many transcript lines carried them, and its
 *   `thinking` and `tool_use` blocks are entries of their own.
 * - A `tool_result` attaches to the `tool_use` it answers.
 * - A turn runs from prompt to prompt. Work Claude takes up again on its own
 *   after an `end_turn` reply (a Stop hook, a notification) stays in the
 *   prompt's turn behind a resume entry, and the turn's `endTs` is its
 *   answer's (#139, `./resume.ts`).
 * - Everything else is **raw**: counted by line type so a session can be
 *   diagnosed, rendered nowhere. A line that is not JSON at all — a half-
 *   written tail — is raw too rather than an error. Unknown types are normal:
 *   a newer Claude Code writes line types this build has never seen.
 *
 * Claude writes no turn lifecycle, no text phase and no outcome apart from
 * `is_error`, so its turns have no `outcome`, its text no `phase`, and its
 * calls end `done` or `error`, never `declined` or `unknown`.
 *
 * What is deliberately *not* here: status (that is the runtime's
 * `agent_status`, and the session model's), following (also the session
 * model's), and rendering.
 */

import {
	TurnDraft as Draft,
	forkConversation,
	type ConversationParser,
	type ImageBytes,
	type ImageEntry,
	type ReduceResult as ConversationReduceResult,
	type SessionInfo,
	type ShellEntry,
	type TaskNotification,
	type TextEntry,
	type ThinkingEntry,
	type ToolEntry,
	type ToolStatus,
	type Turn,
	type TurnEntry,
	type TurnWindow,
} from '../../native/conversation';
import { emptyResume, Resumes, stampReply, type ResumeState } from './resume';
import { CONTEXT_NAME, emptyReading, SessionReader, type SessionReading } from './sessionInfo';

/** What one batch did to a Claude session's state. */
export type ReduceResult = ConversationReduceResult<TranscriptState>;

/** The `promptSource` values of a prompt a human sent (2.1.263–2.1.318). */
const HUMAN_SOURCES: ReadonlySet<unknown> = new Set(['typed', 'queued', 'sdk', 'suggestion_accepted']);

/**
 * Whether a string `user` line says a human sent it, so an enqueue of the
 * same words does not make it injected content (#157). Claude Code writes
 * `origin.kind: "human"` and a `promptSource` on such a line: `typed` at an
 * idle TUI, `queued` for a prompt that waited in the queue and ran as a turn
 * of its own, `sdk` over stream-json (which Claude enqueues and dequeues
 * before every prompt, ADR-0007, as does `entrypoint: "sdk-cli"`). A task
 * notification is never one, whatever carried it.
 */
function sentByHuman(line: Record<string, unknown>, content: string): boolean {
	const origin = isRecord(line.origin) ? line.origin : null;
	if (origin?.kind === 'task-notification' || taskNotification(content)) return false;
	if (origin?.kind === 'human') return true;
	return HUMAN_SOURCES.has(line.promptSource) || line.entrypoint === 'sdk-cli';
}

/** A Claude session's state: the conversation, and what the parser keeps across batches. */
export interface TranscriptState {
	turns: Turn[];
	/**
	 * Lines that render nothing, counted by their `type` field. `(unparsed)`
	 * counts lines that were not JSON and `(untyped)` JSON without a string
	 * type. Counts rather than the lines themselves: a transcript is mostly
	 * attachments, and the view has no use for their content.
	 */
	raw: Record<string, number>;
	/** Which turns are held, when the session model holds only some (#152). */
	window?: TurnWindow;
	/**
	 * Contents of queue enqueues not yet spent, oldest first: by a `user`
	 * line or a steer of the same words, by a `remove` or `popAll` naming
	 * them, or by dequeues once they cover them all ({@link dequeued}). What
	 * a line that does not say a human sent it is matched against.
	 */
	pendingQueue: string[];
	/**
	 * Dequeues not yet paired with a line that spent an entry. A dequeue
	 * names no entry, so these spend {@link pendingQueue} only once they
	 * cover all of it (#157).
	 */
	dequeued: number;
	/** Which records the conversation stands on, for a rewind (#131). */
	branch: BranchState;
	/**
	 * What the records say of the session's settings (#110, #111, #160):
	 * model, effort, permission mode and context, the newest record winning
	 * (`./sessionInfo.ts`).
	 */
	info: SessionInfo;
	/** What reading {@link info} keeps across batches. */
	reading: SessionReading;
	/** Whether the answer has ended, and what may set Claude working again (#139, `./resume.ts`). */
	resume: ResumeState;
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
	/** Every record folded so far, by uuid. */
	records: RecordMarks;
	/** Answers (assistant records) written so far. */
	answers: number;
	/**
	 * Answers written before the conversation last started over (an in-file
	 * `/clear`, #134): a prompt that hangs from nothing reaches back to here.
	 */
	floor: number;
	/** The newest prompt, what it hangs from and whether anything answered it. */
	lastPrompt: { turnId: string; parent: string; answered: boolean } | null;
	/**
	 * The newest local-command caveat and what it hangs from. A slash command
	 * hangs from its caveat, and the caveat is where the command entered the
	 * conversation: the sibling of a prompt cancelled just before it.
	 */
	caveat: { uuid: string; parent: string } | null;
}

/**
 * Where every record folded so far landed, by uuid (#131): written into as
 * records are folded, and a fork's reads through to the marks it was forked
 * from without writing into them (#138), so a preview copies none.
 */
export class RecordMarks {
	private readonly own = new Map<string, RecordMark>();

	constructor(private readonly base: RecordMarks | null = null) {}

	get(uuid: string): RecordMark | undefined {
		return this.own.get(uuid) ?? this.base?.get(uuid);
	}

	set(uuid: string, mark: RecordMark): void {
		this.own.set(uuid, mark);
	}

	/** Marks that read these and write only their own. */
	fork(): RecordMarks {
		return new RecordMarks(this);
	}
}

/** The state a session starts from, and what a rotation goes back to. */
export function emptyTranscript(): TranscriptState {
	return {
		turns: [],
		raw: {},
		pendingQueue: [],
		dequeued: 0,
		branch: { last: null, records: new RecordMarks(), answers: 0, floor: 0, lastPrompt: null, caveat: null },
		info: {},
		reading: emptyReading(),
		resume: emptyResume(),
	};
}

/**
 * A state to fold a preview into (#138): the turns borrowed, the record marks
 * layered, and the rest — a few small values — copied, so nothing a fold does
 * to the fork reaches `state`. The session reading and the resume state are
 * replaced rather than written into, so they are shared as they are.
 */
export function forkTranscript(state: TranscriptState): TranscriptState {
	return {
		...forkConversation(state),
		pendingQueue: [...state.pendingQueue],
		branch: { ...state.branch, records: state.branch.records.fork() },
	};
}

/** Claude Code's reasoning efforts, as `/effort` and `--effort` take them (#110). */
export const CLAUDE_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

/**
 * Claude Code's permission modes a picker offers, as `permissionMode` writes
 * them (#110). `bypassPermissions` is written too, and shown when a session
 * runs in it, but not offered: Claude takes it only from a process started to
 * allow it, and a picker must not put it one click away (#161).
 */
export const CLAUDE_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'];

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
	// A skill run as a command writes its `<command-message>` first (2.1.286).
	const name = /^\s*(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>([^<]*)<\/command-name>/.exec(content);
	if (!name) return null;
	const args = /<command-args>([^<]*)<\/command-args>/.exec(content);
	return `${name[1] ?? ''} ${args?.[1] ?? ''}`.trim();
}

/**
 * A `/clear` run at the keyboard, as its whole envelope (#134): the name, and
 * at most its own message and empty arguments. Prose that quotes `/clear`,
 * or a command with arguments, is not one.
 */
const CONTEXT_CLEAR =
	/^\s*(?:<command-message>clear<\/command-message>\s*)?<command-name>\s*\/clear\s*<\/command-name>(?:\s*<command-message>clear<\/command-message>)?(?:\s*<command-args>\s*<\/command-args>)?\s*$/;

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
): { toolUseId: string; completed: boolean; summary: string; notification: TaskNotification } | null {
	if (!content.trimStart().startsWith('<task-notification>')) return null;
	const summary = notificationField(content, 'summary');
	return {
		toolUseId: notificationField(content, 'tool-use-id'),
		// `completed`, `failed` and `killed` are the three values this machine's
		// transcripts carry; only the first is the work having gone well.
		completed: notificationField(content, 'status') === 'completed',
		summary,
		notification: {
			taskId: notificationField(content, 'task-id'),
			kind: summary.startsWith('Agent "')
				? 'agent'
				: summary.startsWith('Background command')
					? 'command'
					: 'other',
			outputFile: notificationField(content, 'output-file'),
		},
	};
}

/** Tool names of a subagent call, as `./toolCalls.ts` aliases them. */
const AGENT_TOOL = /^(agent|task)$/i;

/** The tool that sends a subagent a message. */
const SEND_MESSAGE = /^sendmessage$/i;

/**
 * The call a subagent's notification that names no call belongs to (#147):
 * the newest that started it or sent it a message. Measured 2026-11-06,
 * 2.1.318: a subagent that stops again after taking in a message sent while
 * it worked notifies with an empty `<tool-use-id>`, only its task id.
 */
function subagentCall(draft: Draft, notification: TaskNotification): string {
	const id = notification.taskId;
	if (notification.kind !== 'agent' || !id) return '';
	return (
		draft.findToolId((entry) => {
			const name = entry.name.trim();
			if (SEND_MESSAGE.test(name)) return entry.input.to === id;
			if (!AGENT_TOOL.test(name)) return false;
			return entry.notification?.taskId === id || (entry.result ?? '').includes(`agentId: ${id}`);
		}) ?? ''
	);
}

/**
 * How a background command's `tool_result` opens: the command went to the
 * background and its notification will say how it ended (2.1.286, 2.1.318).
 */
const BACKGROUND_COMMAND_NOTICE = /^command running in background with id:/i;

/**
 * How an async `Agent` call's `tool_result` opens: the launch notice Claude
 * Code writes when the subagent goes to the background, measured across every
 * transcript on this machine on 2026-09-15. The rest of the notice is the agent
 * id, the output file and instructions never to quote any of it.
 */
const ASYNC_LAUNCH_NOTICE = /^async agent launched/i;

/** Whether a tool result says the work went on in the background (#91, #135). */
function isBackgroundLaunch(result: string): boolean {
	const text = result.trimStart();
	return ASYNC_LAUNCH_NOTICE.test(text) || BACKGROUND_COMMAND_NOTICE.test(text);
}

/**
 * The marker Claude Code writes when the human stops a turn, as a `user` line
 * of content blocks: `[Request interrupted by user]`, or `… for tool use]`.
 * It is the runtime's bookkeeping, not anything the human typed.
 */
const INTERRUPTED = /^\[Request interrupted by user/;

/**
 * The text block Claude Code 2.1.318 writes after a prompt's images, naming
 * the file each came from (`[Image: source: /tmp/a.png]`, measured
 * 2026-11-06 for a pasted path and for a stream-json image block alike). It is
 * the runtime's note for the model, not anything the human typed.
 */
const IMAGE_SOURCE = /^\[Image: source: [^\n]*\]$/;

/**
 * Where a terminal Claude's input showed a pasted image (`[Image #3]`): the
 * picture's stand-in in the text, which the thumbnail replaces.
 */
const IMAGE_MARKER = /\[Image #\d+\]/g;

/**
 * The text and the images of a prompt written as content blocks (#129,
 * #144). `raw` is the text blocks joined as written, which is what a queue
 * enqueue holds; `text` is what the human typed, without the stand-ins and
 * the source notes the images brought along. Each image says where its bytes
 * are: `record` and its index among the record's images.
 */
function promptBlocks(
	content: readonly unknown[],
	record: string,
): { raw: string; text: string; images: ImageEntry[] } {
	const texts: string[] = [];
	const images: ImageEntry[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === 'text') {
			const text = stringField(block, 'text');
			if (INTERRUPTED.test(text) || taskNotification(text) || IMAGE_SOURCE.test(text.trim())) continue;
			if (text.trim()) texts.push(text);
		} else if (block.type === 'image') {
			const source = isRecord(block.source) ? block.source : {};
			const index = images.length;
			images.push({
				kind: 'image',
				id: `${record}#${index}`,
				record,
				index,
				mediaType: stringField(source, 'media_type'),
			});
		}
	}
	const raw = texts.join('\n');
	const text = images.length ? raw.replace(IMAGE_MARKER, '').trim() : raw;
	return { raw, text, images };
}

/**
 * A prompt written as content blocks rather than a string (#129): what a TUI
 * prompt with a pasted image is (`[{text: "[Image #3]"}, {image}]`, measured
 * on 2.1.283; 2.1.318 adds a `[Image: source: …]` text block per image), with
 * no `isMeta`. The text blocks are the prompt; each image is an entry. Null
 * for a line that is no prompt: one that carries nothing but tool results,
 * an interruption marker, or a task notification.
 */
function blockPrompt(
	line: Json,
	content: readonly unknown[],
): { raw: string; text: string; images: ImageEntry[] } | null {
	if (line.isMeta === true || typeof line.interruptedMessageId === 'string') return null;
	const blocks = promptBlocks(content, stringField(line, 'uuid'));
	if (!blocks.raw.trim() && blocks.images.length === 0) return null;
	return blocks;
}

/**
 * The human's text in a line of content blocks: its text blocks joined, less
 * the interruption marker and task notifications, which are the runtime's.
 */
function blockText(content: readonly unknown[]): string {
	const texts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== 'text') continue;
		const text = stringField(block, 'text');
		if (INTERRUPTED.test(text) || taskNotification(text)) continue;
		if (text.trim()) texts.push(text);
	}
	return texts.join('\n');
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
// eslint-disable-next-line no-control-regex -- matching terminal control characters is the point
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

/**
 * The `isMeta` line Claude Code writes before a slash command run at the
 * keyboard (`commandPrompt`): `<local-command-caveat>…`, measured on 2.1.281.
 */
function isLocalCommandCaveat(line: Json): boolean {
	if (line.type !== 'user' || line.isMeta !== true) return false;
	const message = isRecord(line.message) ? line.message : null;
	const content = message?.content;
	return typeof content === 'string' && content.trimStart().startsWith('<local-command-caveat>');
}

/** True for a `user` line that is a local command's own output, not a prompt. */
function isLocalCommandOutput(content: string): boolean {
	return content.startsWith('<local-command-stdout>');
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
 * The {@link BranchState} as one batch folds it (#131): the record marks are
 * written into where they are, the few values beside them put back at the end.
 *
 * A record is marked once it has been folded, so the mark names the turn it
 * landed in — a prompt's own record names the turn it opened. Records on a
 * side chain (a subagent's, inlined by older builds) are not the session's
 * conversation and are not marked.
 */
class Branch {
	private last: string | null;
	private readonly records: RecordMarks;
	private answers: number;
	private floor: number;
	private lastPrompt: BranchState['lastPrompt'];
	private caveat: BranchState['caveat'];
	/** The record being folded, marked by {@link settle}. */
	private pending: { uuid: string; answer: boolean } | null = null;

	constructor(state: BranchState) {
		this.last = state.last;
		this.records = state.records;
		this.answers = state.answers;
		this.floor = state.floor;
		this.lastPrompt = state.lastPrompt;
		this.caveat = state.caveat;
	}

	/** The line about to be folded; marked when the next one arrives. */
	saw(line: Json): void {
		const uuid = line.uuid;
		if (typeof uuid !== 'string' || !uuid || line.isSidechain === true) return;
		this.pending = { uuid, answer: line.type === 'assistant' };
		const parent = parentOf(line);
		if (isLocalCommandCaveat(line) && typeof parent === 'string') this.caveat = { uuid, parent };
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
	 *
	 * A slash command hangs from its local-command caveat, which hangs from
	 * where the command entered the conversation; that record is the
	 * command's parent here, so a command typed after a cancelled prompt drops
	 * it as a re-send does.
	 */
	fork(line: Json, draft: Draft): void {
		const written = parentOf(line);
		if (written === undefined) return;
		const parent = this.caveat && written === this.caveat.uuid ? this.caveat.parent : written;
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
	/**
	 * The conversation started over in the same file (#134): what was read
	 * before is no branch to go back to, and a prompt that hangs from nothing
	 * reaches back only to here.
	 */
	cleared(): void {
		this.floor = this.answers;
		this.lastPrompt = null;
	}

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
			caveat: this.caveat,
		};
	}
}

/**
 * Folds `lines` into `state`, in place (#138), and returns it with the turns
 * the batch changed and removed. Nothing the session holds is copied: a batch
 * costs its own lines. To fold without changing `state`, fold into
 * {@link forkTranscript}`(state)`.
 */
export function reduce(state: TranscriptState, lines: string[]): ReduceResult {
	const draft = new Draft(state.turns, state.window ?? null);
	const raw = state.raw;
	const pendingQueue = state.pendingQueue;
	let dequeued = state.dequeued;
	const branch = new Branch(state.branch);
	const reader = new SessionReader(state.info, state.reading);
	const resumes = new Resumes(state.resume);

	const countRaw = (key: string): void => {
		raw[key] = (raw[key] ?? 0) + 1;
	};
	/**
	 * Every entry pending has left Claude's queue once the dequeues not yet
	 * paired with a line are as many: a cancel (a bare dequeue) leaves no
	 * stale entry behind, and nothing is guessed while two or more wait.
	 */
	const settleQueue = (): void => {
		if (dequeued === 0 || dequeued < pendingQueue.length) return;
		pendingQueue.length = 0;
		dequeued = 0;
	};
	/**
	 * Spends the pending entry of these words, if any. `run` is a line that
	 * ran the entry, which pairs it with a dequeue; a steer is taken in by a
	 * `remove` instead, and a `popAll` gives it back.
	 */
	const spend = (content: string, run: boolean): boolean => {
		const index = pendingQueue.indexOf(content);
		if (index === -1) return false;
		pendingQueue.splice(index, 1);
		if (run && dequeued > 0) dequeued--;
		settleQueue();
		return true;
	};
	/**
	 * Opens the turn a human prompt starts, after dropping what a rewind or a
	 * re-send left behind (#131).
	 */
	/**
	 * A background task's notification, applied to the call it names (#96,
	 * #135). Claude Code writes one notification as its enqueue, a mid-turn
	 * attachment, a `user` line, or several of these, so applying it is
	 * idempotent: the same notification again changes nothing. A background
	 * command's notification never ends a subagent's call.
	 */
	const notify = (task: NonNullable<ReturnType<typeof taskNotification>>, ts: string, enqueued = false): void => {
		// After the answer, a notification is what sets Claude working again (#139).
		resumes.notified(task.summary, ts);
		const entry = draft.toolEntry(task.toolUseId || subagentCall(draft, task.notification));
		if (!entry) return;
		if (task.notification.kind === 'command' && AGENT_TOOL.test(entry.name.trim())) return;
		const status: ToolStatus = task.completed ? 'done' : 'error';
		const same =
			entry.notification?.taskId === task.notification.taskId &&
			entry.notification.outputFile === task.notification.outputFile &&
			entry.status === status;
		// When it stopped (#147) is its enqueue's time, which always comes first;
		// the records after it carry the same notification, taken in later. A
		// subagent notifies each time it stops, so a later enqueue is a later stop.
		const at = enqueued || !entry.notification?.at ? ts : entry.notification.at;
		if (same) {
			if (!enqueued || !ts || ts === entry.notification?.at) return;
			entry.notification = { ...task.notification, at: ts };
			const turn = draft.turnOf(task.toolUseId);
			if (turn) draft.touch(turn.id);
			return;
		}
		entry.notification = at ? { ...task.notification, at } : task.notification;
		// The background work is over, one way or the other (#91).
		entry.status = status;
		const turn = draft.turnOf(task.toolUseId);
		if (turn) draft.touch(turn.id);
	};
	const openPrompt = (line: Json, prompt: string): Turn => {
		branch.fork(line, draft);
		const turn = draft.open(stringField(line, 'uuid') || `turn-${draft.length}`, prompt, stringField(line, 'timestamp'));
		branch.prompted(turn.id, line);
		resumes.prompted();
		return turn;
	};

	// Each line counts to the turn that is newest once it is folded (#152),
	// weighed as the next one starts, so no `continue` below can skip it.
	let weight = 0;
	for (const line of lines) {
		// The line before this one has landed; where is what a rewind reads.
		branch.settle(draft);
		draft.weigh(weight);
		weight = line.length;
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
				// The enqueue is what a later line of the same words is matched
				// against; the rest spend it (#157). `remove` (taken in mid-turn)
				// and `popAll` (pulled back with Up, re-sent as new words) name the
				// entry; `dequeue` names none, and is settled by count.
				const operation = stringField(parsed, 'operation');
				const content = stringField(parsed, 'content');
				if (operation === 'enqueue') {
					// A notification is read from whichever record carries it, and
					// some reach the transcript as their enqueue alone (#135).
					const task = taskNotification(content);
					if (task) notify(task, stringField(parsed, 'timestamp'), true);
					else if (content) pendingQueue.push(content);
				} else if (operation === 'remove' || operation === 'popAll') {
					spend(content, false);
				} else if (operation === 'dequeue') {
					dequeued++;
					settleQueue();
				}
				countRaw(type);
				continue;
			}
			case 'attachment': {
				const attachment = isRecord(parsed.attachment) ? parsed.attachment : null;
				const origin = attachment && isRecord(attachment.origin) ? attachment.origin : null;
				// A steer says a human sent it; over stream-json (the `claude` kind)
				// Claude writes it with no origin, as a prompt from the SDK host
				// (measured 2026-11-06, 2.1.318, #157).
				const fromHost =
					origin === null && parsed.entrypoint === 'sdk-cli' && attachment?.commandMode === 'prompt';
				const human = attachment?.type === 'queued_command' && (origin?.kind === 'human' || fromHost);
				// The model's id and display name, before the first reply after a
				// switch and at the first prompt (#110).
				const identity = attachment?.type === 'model' && isRecord(attachment.identity) ? attachment.identity : null;
				if (identity && parsed.isSidechain !== true) reader.identity(identity);
				// A notification taken in mid-turn is this attachment, with no
				// `user` line after it (#135).
				const task =
					attachment?.type === 'queued_command' ? taskNotification(stringField(attachment, 'prompt')) : null;
				if (task) {
					notify(task, stringField(parsed, 'timestamp'));
					countRaw(type);
					continue;
				}
				if (attachment && parsed.isSidechain !== true) resumes.attachment(parsed, attachment);
				if (!human) {
					countRaw(type);
					continue;
				}
				// A steer with a picture carries content blocks rather than a
				// string (measured 2026-11-06, 2.1.318): its enqueue holds the text
				// blocks as written, and the images are entries after it (#144).
				const blocks = Array.isArray(attachment.prompt)
					? promptBlocks(attachment.prompt as unknown[], stringField(parsed, 'uuid'))
					: null;
				const enqueuedText = blocks ? blocks.raw : stringField(attachment, 'prompt');
				const text = blocks ? blocks.text : enqueuedText;
				const images = blocks?.images ?? [];
				// The steer's own enqueue is spent here: it was pushed when the
				// prompt was accepted and no `user` line will ever pair with it.
				// Left behind, it would swallow the next ordinary prompt of the
				// same words as injected content (#93, #96).
				spend(enqueuedText, false);
				const turn = draft.current();
				// What follows answers the steer, not anything that resumed.
				resumes.prompted();
				if (turn) {
					// A steer is consumed inside the turn already running, and shows
					// where it entered the context (CONTEXT.md, native-view-design.md).
					if (text) turn.entries.push({ kind: 'steer', text });
					turn.entries.push(...images);
					draft.touch(turn.id);
				} else {
					// Nothing is running: the prompt is simply this turn's prompt.
					const opened = draft.open(
						stringField(parsed, 'uuid') || `steer-${text.slice(0, 32)}`,
						text,
						stringField(parsed, 'timestamp'),
					);
					opened.entries.push(...images);
				}
				continue;
			}
			case 'user': {
				const message = isRecord(parsed.message) ? parsed.message : null;
				const content = message?.content;
				if (parsed.isSidechain !== true) {
					reader.user(parsed);
					if (parsed.isMeta === true) resumes.meta(parsed);
				}
				if (parsed.isCompactSummary === true) {
					// Not the human speaking, however much it reads like a prompt: a
					// divider in the turn it happened in (#130).
					const turn =
						draft.current() ??
						draft.open(stringField(parsed, 'uuid') || `turn-${draft.length}`, '', stringField(parsed, 'timestamp'));
					turn.entries.push({ kind: 'compaction', summary: compactionSummary(content) });
					draft.touch(turn.id);
					continue;
				}
				if (Array.isArray(content)) {
					let attached = false;
					let answers = false;
					let answered: ToolEntry | null = null;
					for (const block of content) {
						if (!isRecord(block) || block.type !== 'tool_result') continue;
						answers = true;
						const toolUseId = stringField(block, 'tool_use_id');
						const entry = draft.toolEntry(toolUseId);
						if (!entry) continue;
						answered = entry;
						entry.result = resultText(block.content);
						// A failed call and one the user refused both arrive as
						// `is_error`; a launch notice means the work goes on (#91).
						// A notification that already landed has said how it ended.
						if (!entry.notification) {
							entry.status =
								block.is_error === true
									? 'error'
									: isBackgroundLaunch(entry.result)
										? 'running'
										: 'done';
						}
						// The turn that changed is the one holding the call, which is
						// not always the turn now open: a background command answers
						// after the next prompt has started one (#93, #94).
						const turn = draft.turnOf(toolUseId);
						if (turn) draft.touch(turn.id);
						attached = true;
					}
					if (answers) {
						// Text beside a tool result is part of that answer, never a
						// prompt: approving a plan with feedback writes the feedback
						// as a text block after the ExitPlanMode result (2.1.318).
						const rider = blockText(content);
						if (answered && rider) answered.result = `${answered.result ?? ''}\n\n${rider}`.trim();
						if (!attached) countRaw(type);
						continue;
					}
					// A prompt of content blocks — a pasted image, a pasted block —
					// is a prompt like a string one (#129). A line of tool results
					// carries no text of the human's and opens nothing.
					const sent = blockPrompt(parsed, content);
					if (sent) {
						// A prompt queued while Claude worked and sent as a prompt of its
						// own afterwards: its enqueue, written as the text blocks, is spent.
						spend(sent.raw, true);
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
				const task = taskNotification(content);
				if (task) {
					// Never a prompt, whether or not its enqueue was seen (#96, #135).
					notify(task, stringField(parsed, 'timestamp'));
					countRaw(type);
					continue;
				}
				// A human's line spends its own enqueue and is a prompt below,
				// stale entry or not (#157). Any other line enqueued before it
				// arrived is injected content.
				const enqueued = spend(content, true);
				if (enqueued && !sentByHuman(parsed, content)) {
					countRaw(type);
					continue;
				}
				if (isLocalCommandOutput(content)) {
					countRaw(type);
					continue;
				}
				if (CONTEXT_NAME.test(content)) {
					// `/context` (#171): what it printed is the session bar's
					// breakdown, never a turn, whichever line form it took. Claude
					// 2.1.281 to 2.1.318 write it as `system` lines, which open
					// nothing either.
					countRaw(type);
					continue;
				}
				if (CONTEXT_CLEAR.test(content)) {
					// `/clear` inside the file (#134): the turns go, and with them
					// every call a late result could still find. Usually Claude moves
					// to a new file instead, and there this clears nothing.
					draft.dropAfter('');
					branch.cleared();
					resumes.prompted();
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
				// A sidechain's answers are a subagent's, not the session's model.
				const mainChain = parsed.isSidechain !== true;
				const ts = stringField(parsed, 'timestamp');
				if (mainChain) reader.reply(message, stringField(parsed, 'effort'));
				// Content before any prompt (a transcript read from the middle) still
				// belongs somewhere: it opens a turn with no prompt of its own.
				const turn = draft.current() ?? draft.open(messageId || 'turn-0', '', ts);
				// Work taken up again after the answer ended is marked where it
				// starts, inside the prompt's turn (#139).
				if (mainChain) {
					const resumed = resumes.reply(messageId, stringField(parsed, 'uuid'), ts, stringField(message, 'stop_reason'));
					if (resumed) turn.entries.push(resumed);
				}
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
				if (mainChain) stampReply(turn, ts);
				draft.touch(turn.id);
				continue;
			}
			case 'system': {
				// The runtime's own notices (#133). A slash command's output, the
				// `local_command` subtype, stays hidden as its `user` form does: the
				// command itself is the turn, and what it set is the session
				// chrome's to show.
				const subtype = stringField(parsed, 'subtype');
				// What `/model`, `/effort` and `/context` set is the session
				// info's (#160).
				if (subtype === 'local_command' && parsed.isSidechain !== true) reader.localCommand(parsed);
				if (subtype !== 'informational') {
					countRaw(type);
					continue;
				}
				const text = plainText(stringField(parsed, 'content')).trim();
				if (!text) {
					countRaw(type);
					continue;
				}
				const at = stringField(parsed, 'timestamp');
				const turn = draft.current() ?? draft.open(stringField(parsed, 'uuid') || `notice-${draft.length}`, '', at);
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
	draft.weigh(weight);
	const { changedTurnIds, removedTurnIds } = draft.finish();
	const { info, reading } = reader.finish();
	state.dequeued = dequeued;
	state.branch = branch.finish();
	state.info = info;
	state.reading = reading;
	state.resume = resumes.finish();
	return { state, changedTurnIds, removedTurnIds };
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

/**
 * The bytes of one image a prompt carried (#144): the `index`-th image block
 * of the record whose uuid is `record`, in a `user` line's content or a
 * steer's `queued_command` attachment, or null when the transcript has no
 * such image.
 *
 * Only that record is parsed: the file is searched for the uuid as a JSON
 * string and the line around each hit tried in turn (the uuid also appears as
 * the next record's `parentUuid`), so reading a thumbnail costs one search,
 * not a parse of the session.
 */
export function transcriptImage(text: string, record: string, index: number): ImageBytes | null {
	if (!record) return null;
	const needle = JSON.stringify(record);
	for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
		const start = text.lastIndexOf('\n', at) + 1;
		const end = text.indexOf('\n', at);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text.slice(start, end === -1 ? text.length : end));
		} catch {
			continue;
		}
		if (!isRecord(parsed) || parsed.uuid !== record) continue;
		const message = isRecord(parsed.message) ? parsed.message : null;
		const attachment = isRecord(parsed.attachment) ? parsed.attachment : null;
		const blocks: unknown[] = Array.isArray(message?.content)
			? (message.content as unknown[])
			: Array.isArray(attachment?.prompt)
				? (attachment.prompt as unknown[])
				: [];
		const block = blocks.filter((candidate) => isRecord(candidate) && candidate.type === 'image')[index];
		const source = isRecord(block) && isRecord(block.source) ? block.source : null;
		const data = source ? stringField(source, 'data') : '';
		if (!source || !data) return null;
		return { mediaType: stringField(source, 'media_type'), data };
	}
	return null;
}

/** Claude Code's parser, as the agent seam takes it (`../format.ts`). */
export const claudeParser: ConversationParser<TranscriptState> = {
	empty: emptyTranscript,
	fork: forkTranscript,
	reduce,
};
