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
 *   string `user` line.
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

export type TurnEntry = TextEntry | ThinkingEntry | ToolEntry | SteerEntry;

/** A human prompt and everything the agent did until it stopped. */
export interface Turn {
	/** The prompt line's uuid; stable, so a view can redraw one turn in place. */
	id: string;
	prompt: string;
	entries: TurnEntry[];
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
}

export interface ReduceResult {
	state: TranscriptState;
	/** Turn ids created or changed by this batch, in order, each once. */
	changedTurnIds: string[];
}

/** The state a session starts from, and what a rotation goes back to. */
export function emptyTranscript(): TranscriptState {
	return { turns: [], raw: {}, pendingQueue: [] };
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

/** True for a `user` line that is a local command's own output, not a prompt. */
function isLocalCommandOutput(content: string): boolean {
	return content.startsWith('<local-command-stdout>');
}

/** A working copy of one turn, so the reducer never mutates the state it was given. */
class Draft {
	private readonly turns: Turn[];
	private readonly changed: string[] = [];
	/** Turns already copied in this batch, by id: copy once, then mutate freely. */
	private readonly mine = new Set<string>();

	constructor(turns: Turn[]) {
		this.turns = [...turns];
	}

	/** The turn open for new content, or null before the first prompt. */
	current(): Turn | null {
		const last = this.turns[this.turns.length - 1];
		return last ? this.own(last) : null;
	}

	open(id: string, prompt: string): Turn {
		const turn: Turn = { id, prompt, entries: [] };
		this.turns.push(turn);
		this.mine.add(id);
		this.touch(id);
		return turn;
	}

	/** Marks a turn as changed by this batch. */
	touch(id: string): void {
		if (!this.changed.includes(id)) this.changed.push(id);
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

	/** The turns as they now stand; the caller assembles the state around them. */
	finish(): { turns: Turn[]; changedTurnIds: string[] } {
		return { turns: this.turns, changedTurnIds: this.changed };
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
 * Folds `lines` into `state`. Neither `state` nor anything reachable from it is
 * mutated: turns this batch touched are replaced by copies, the rest are shared.
 */
export function reduce(state: TranscriptState, lines: string[]): ReduceResult {
	const draft = new Draft(state.turns);
	const raw = { ...state.raw };
	const pendingQueue = [...state.pendingQueue];

	const countRaw = (key: string): void => {
		raw[key] = (raw[key] ?? 0) + 1;
	};

	for (const line of lines) {
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
					if (!attached) countRaw(type);
					continue;
				}
				if (typeof content !== 'string' || parsed.isMeta === true) {
					countRaw(type);
					continue;
				}
				const queued = pendingQueue.indexOf(content);
				if (queued !== -1) {
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
				const prompt = commandPrompt(content) ?? content;
				draft.open(stringField(parsed, 'uuid') || `turn-${draft.length}`, prompt);
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
			default:
				countRaw(type);
				continue;
		}
	}

	const { turns, changedTurnIds } = draft.finish();
	return { state: { turns, raw, pendingQueue }, changedTurnIds };
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
	const { turns, changedTurnIds } = draft.finish();
	return { state: { ...state, turns }, changedTurnIds };
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
