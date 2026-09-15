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

	/** How many turns the draft holds, for naming a turn whose line had no uuid. */
	get length(): number {
		return this.turns.length;
	}

	/** The turns as they now stand; the caller assembles the state around them. */
	finish(): { turns: Turn[]; changedTurnIds: string[] } {
		return { turns: this.turns, changedTurnIds: this.changed };
	}

	/** A copy of `turn` that this batch owns, swapped into the list on first ask. */
	private own(turn: Turn): Turn {
		if (this.mine.has(turn.id)) return turn;
		const copy: Turn = { ...turn, entries: [...turn.entries] };
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
						const entry = draft.toolEntry(stringField(block, 'tool_use_id'));
						if (!entry) continue;
						entry.result = resultText(block.content);
						attached = true;
					}
					if (!attached) countRaw(type);
					else {
						const turn = draft.current();
						if (turn) draft.touch(turn.id);
					}
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
