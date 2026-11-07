/**
 * Work Claude takes up again on its own after answering (issue #139, finding
 * `prior-art-chat-client` §2.1).
 *
 * Claude ends an answer with a reply whose `stop_reason` is `end_turn`. With
 * no prompt after it, a new main-chain reply is Claude working again because
 * something told it to (measured on 2.1.318, `tests/fixtures/transcripts/
 * resume-*.jsonl`):
 *
 * - a **Stop hook** that blocked: an `isMeta` `user` line "Stop hook
 *   feedback:\n<reason>" and a `hook_blocking_error` attachment
 *   (`hookEvent: "Stop"`), then `stop_hook_summary`;
 * - a **task notification**: a background command or subagent finishing
 *   (`<task-notification>` as an enqueue, a `user` line with `origin.kind:
 *   "task-notification"`, or a `queued_command` attachment);
 * - **another session's message** (a subagent's hand-back): an `isMeta` `user`
 *   line with `origin.kind: "peer"`;
 * - a **runtime line** for the model: "Background command … failed with exit
 *   code …", or a hook's added context.
 *
 * The turn stays the prompt's (turns are prompt-anchored, so turn ids and
 * heading indexes do not move): a {@link ResumeEntry} marks where the resumed
 * work starts, and {@link Turn.endTs} stops at the prompt's own last reply.
 * The cause is the first such record after the answer; a reply with none is
 * `other`. Pure: the parser's working copy of one batch, as its branch is.
 */

import type { ResumeCause, ResumeEntry, Turn } from '../../native/conversation';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(source: Json, key: string): string {
	const value = source[key];
	return typeof value === 'string' ? value : '';
}

/** What the parser keeps across batches. */
export interface ResumeState {
	/** The id of the reply that ended the answer, while nothing has prompted or resumed since; null otherwise. */
	ended: string | null;
	/** The first thing since that answer that would set Claude working again. */
	cause: { cause: ResumeCause; text: string; ts: string } | null;
}

export function emptyResume(): ResumeState {
	return { ended: null, cause: null };
}

/** A Stop hook's feedback, as Claude writes it for the model. */
const STOP_HOOK = /^Stop hook feedback:\s*/;
/** A background command that failed, as the runtime writes it for the model. */
const COMMAND_FAILED = /^Background command\b[\s\S]*\bfailed\b/;
/** A hook's added context, inside a reminder. */
const HOOK_CONTEXT = /^<system-reminder>\s*([\s\S]*?hook[\s\S]*?)\s*<\/system-reminder>\s*$/i;

/** One line of a cause's text, as the view shows it: the first non-empty one. */
function firstLine(text: string): string {
	return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

/** The text of a `user` line's content: the string, or its text blocks joined. */
function contentText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === 'text') parts.push(stringField(block, 'text'));
	}
	return parts.join('\n');
}

/** The working copy of one batch. */
export class Resumes {
	private ended: string | null;
	private cause: ResumeState['cause'];

	constructor(state: ResumeState) {
		this.ended = state.ended;
		this.cause = state.cause;
	}

	/** A prompt, a steer or a `/clear`: what follows answers it, not resumed work. */
	prompted(): void {
		this.ended = null;
		this.cause = null;
	}

	/** A task notification arrived (`summary` is what it said). */
	notified(summary: string, ts: string): void {
		this.offer('notification', summary, ts);
	}

	/** An `isMeta` main-chain `user` line: a Stop hook's feedback, a peer's message, a runtime line. */
	meta(line: Json): void {
		if (this.ended === null) return;
		const message = isRecord(line.message) ? line.message : null;
		const text = contentText(message?.content).trim();
		const ts = stringField(line, 'timestamp');
		const origin = isRecord(line.origin) ? line.origin : null;
		if (origin?.kind === 'peer') {
			const name = stringField(origin, 'name');
			this.offer('notification', name ? `Message from ${name}` : 'Message from another session', ts);
			return;
		}
		if (STOP_HOOK.test(text)) {
			this.offer('hook', firstLine(text.replace(STOP_HOOK, '')), ts);
			return;
		}
		if (COMMAND_FAILED.test(text)) {
			this.offer('meta', firstLine(text), ts);
			return;
		}
		const context = HOOK_CONTEXT.exec(text);
		if (context) this.offer('hook', firstLine(context[1] ?? ''), ts);
	}

	/** A main-chain attachment: a Stop hook's block, or a hook's added context. */
	attachment(line: Json, attachment: Json): void {
		if (this.ended === null) return;
		const ts = stringField(line, 'timestamp');
		if (attachment.type === 'hook_blocking_error') {
			const error = isRecord(attachment.blockingError) ? attachment.blockingError : null;
			this.offer('hook', firstLine(error ? stringField(error, 'blockingError') : ''), ts);
		} else if (attachment.type === 'hook_additional_context') {
			const content = attachment.content;
			const text = Array.isArray(content)
				? content.filter((item): item is string => typeof item === 'string').join('\n')
				: typeof content === 'string'
					? content
					: '';
			this.offer('hook', firstLine(text), ts);
		}
	}

	/**
	 * A main-chain reply, before its content is added to `turn`: the resume
	 * entry to put first when it takes up work after the answer ended, else
	 * null. Remembers whether this reply ends an answer.
	 */
	reply(messageId: string, record: string, ts: string, stopReason: string): ResumeEntry | null {
		let resumed: ResumeEntry | null = null;
		if (this.ended !== null && messageId !== this.ended) {
			const cause = this.cause;
			const at = cause?.ts || ts;
			resumed = {
				kind: 'resume',
				id: record || messageId,
				cause: cause?.cause ?? 'other',
				text: cause?.text ?? '',
				...(at ? { ts: at } : {}),
			};
			this.cause = null;
		}
		if (stopReason === 'end_turn') this.ended = messageId;
		else if (resumed || messageId !== this.ended) this.ended = null;
		return resumed;
	}

	finish(): ResumeState {
		return { ended: this.ended, cause: this.cause };
	}

	private offer(cause: ResumeCause, text: string, ts: string): void {
		if (this.ended === null || this.cause) return;
		this.cause = { cause, text, ts };
	}
}

/**
 * Stamps a reply's time on what it belongs to (#139): the turn's resumed work
 * when it has any, else the prompt's own answer. `turn` is the batch's own copy.
 */
export function stampReply(turn: Turn, ts: string): void {
	if (!ts) return;
	for (let i = turn.entries.length - 1; i >= 0; i--) {
		const entry = turn.entries[i];
		if (entry?.kind !== 'resume') continue;
		entry.endTs = ts;
		return;
	}
	turn.endTs = ts;
}
