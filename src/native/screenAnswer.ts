/**
 * The answer driver (issue #165, ADR-0009 §1–5): answers an agent's dialog on
 * a herdr or herdr-core pane by reading the screen and pressing keys, and
 * refuses whenever the screen is not the request.
 *
 * A wrong key can approve what the user never approved (`1` on a question
 * picks an answer, `1` on a permission runs the command), so almost all of
 * this is about when *not* to press:
 *
 * - **The request is the expectation.** The card's request (the dangling
 *   call, the plan's slug and the plan the card showed, the pane's folder) is
 *   a {@link ScreenExpectation}; every read is parsed by the agent format's
 *   reader and must match it exactly ({@link matchScreen}), and so must the
 *   runtime's own status message when it has one ({@link statusAgrees}),
 *   before any key. What the card showed of a plan or a file's content comes
 *   from the screen at card time ({@link ScreenAnswerer.inspect},
 *   {@link withShown}): Claude replans under the same slug, and writes the
 *   same file again with other content.
 * - **Moves, then a fresh read, then one commit.** Keys are derived from the
 *   parsed screen (where the cursor is, what is ticked), never a fixed
 *   layout. Moves change nothing Claude acts on; after them the driver reads
 *   again until the screen shows the intended state (the cursor on the
 *   intended row, the ticks, the typed text exactly) and only then presses
 *   one commit key, alone in its call. Every `enter`, a multi-select toggle
 *   included, follows a read with the expected row under the cursor. No
 *   digit is ever pressed. A move that does not show is not repeated: held
 *   keys land late, and a repeat would overshoot. Typed words are
 *   never a lone digit, which Claude reads as that digit's key.
 * - **Confirm by content, never resend.** After the final key the screen is
 *   re-read every 100 ms; it has moved on when the dialog no longer matches
 *   the request (a new permission with the same command has not). Then the
 *   transcript's word ({@link AnswerReceipt}) decides between answered and a
 *   misfire. Nothing is ever pressed a second time. A move, the words or a
 *   toggle after which the request is gone is judged the same way: something
 *   answered the dialog, and the card says what Claude received.
 * - **A key may land late.** hc holds keys until no one has typed for 3 s, so
 *   a key that has not shown is not given up on until the screen has stayed
 *   the same for {@link AnswerTiming.quietMs} since the key and since its last
 *   change; until then the pane stays locked and the receipt watched. If the
 *   screen never settles the run ends at {@link AnswerTiming.lateMs} and says
 *   the key may still land.
 * - **One answer per pane.** A second answer while one is in flight is
 *   `busy`. {@link AnswerRun.cancel} stops a run between moves, before any
 *   commit key (a toggle, a tab's answer, the final key), never after.
 *
 * Agent-neutral: the format's parser and the runtime's {@link ScreenAccess}
 * are injected, and so is the clock, so the whole of it runs against a fake
 * screen in the tests. Facts: `docs/architecture.md`, "Answering Claude's
 * dialogs from the screen"; the finding `answering-on-screen`.
 */

import {
	wrappedEquals,
	type PermissionDialog,
	type PlanDialog,
	type QuestionDialog,
	type ReviewDialog,
	type ScreenDialog,
	type TrustDialog,
} from '../agents/screenDialog';
import type { PendingQuestion } from './pendingRequest';
import { screenTextIssue, type ScreenAccess, type ScreenKey } from './screenAccess';
import { setTimer } from '../timers';

// ------------------------------------------------------------------- inputs

/**
 * The request an answer is for, as the card knows it from the runtime and
 * the transcript (ADR-0009 §1). The screen must show exactly this.
 */
export type ScreenExpectation =
	| {
			kind: 'question';
			/**
			 * The dangling `AskUserQuestion` call's id: what the transcript
			 * answers. Null when the card has none: on 2.1.318 the call is
			 * usually written only with its result, and the receipt then looks
			 * for the first answer to these questions.
			 */
			toolUseId: string | null;
			/** The call's questions, in order. */
			questions: readonly PendingQuestion[];
	  }
	| {
			kind: 'permission';
			/**
			 * The dangling call's id. Null when the card has none: a Write call
			 * was seen missing from the transcript for over a minute while its
			 * dialog was up, and a Bash call lags its dialog. The card then takes
			 * the tool and its input from the screen, and the receipt waits for
			 * a call to that tool with that input that the transcript did not
			 * hold when the card was built (ADR-0009 §1).
			 */
			toolUseId: string | null;
			/** The tool asking: `Bash`, `Write` or `Edit`; any other is refused. */
			tool: string;
			/** The call's input: Bash's `command`, Write's and Edit's `file_path`. */
			input: Readonly<Record<string, unknown>>;
			/** The session's folder: Write and Edit show a file inside it relative to it. */
			cwd: string;
			/**
			 * Write and Edit: what the dialog showed between its dotted rules when
			 * the card was built (`PermissionDialog.content` from
			 * {@link ScreenAnswerer.inspect}), which must still be what it shows:
			 * the same file may be asked for again with other content. Null before
			 * the card has read it, which {@link ScreenAnswerer.inspect} accepts
			 * and an answer refuses. Not used for Bash, whose command is the content.
			 */
			content?: readonly string[] | null;
	  }
	| {
			kind: 'plan';
			/** The plan file's slug (`~/.claude/plans/<slug>.md`), as the card read it. */
			slug: string;
			/**
			 * The plan as the card showed it: the dialog's plan lines when the card
			 * was built (`PlanDialog.plan` from {@link ScreenAnswerer.inspect}).
			 * Claude replans under the same slug, so the slug alone does not say
			 * the screen shows the plan the user read. Null before the card has
			 * read it, which an answer refuses.
			 */
			plan: readonly string[] | null;
	  }
	| {
			kind: 'trust';
			/** The pane's folder, which the prompt must name. */
			cwd: string;
	  };

/** One question's answer: the option labels chosen, and the user's own words ('' for none). */
export interface QuestionPick {
	options: readonly string[];
	text: string;
}

/** What the user pressed on the card. */
export type ScreenAnswer =
	/** Every question of the call answered, one pick per question in the call's order. */
	| { kind: 'questions'; picks: readonly QuestionPick[] }
	/** `esc` on a question. */
	| { kind: 'cancel-question' }
	/** A permission's row 1, "Yes". */
	| { kind: 'allow' }
	/**
	 * A permission's row 2, with the label the card showed. It is a project
	 * rule, a directory grant or a session mode switch depending on the tool,
	 * so the screen must say exactly what the user read.
	 */
	| { kind: 'allow-option-2'; label: string }
	/** `esc` on a permission. */
	| { kind: 'deny' }
	/** A permission's "No", `tab`, the words, `enter`. */
	| { kind: 'deny-with-feedback'; feedback: string }
	/**
	 * Plan row 2 (`manual`, "Yes, manually approve edits") or row 1 (`auto`,
	 * "Yes, and use auto mode"). `label`, when given, is the row's text as the
	 * card showed it, which the screen must still show on that row.
	 */
	| { kind: 'approve-plan'; mode: 'manual' | 'auto'; label?: string }
	/** Plan row 3, the words, `enter`: Claude keeps planning. */
	| { kind: 'reject-plan'; feedback: string }
	/** "Yes, I trust this folder". */
	| { kind: 'trust' };

/**
 * What the transcript (or, for trust, the runtime) shows the agent received,
 * supplied by the caller through {@link AnswerRequest.receipt}.
 */
export type AnswerReceipt =
	| {
			kind: 'result';
			/** The `tool_result` text of the expected call, or of the `ExitPlanMode` written with it. */
			text: string;
			isError: boolean;
			/** `toolUseResult.answers` of a question, when the caller has it; compared exactly. */
			answers?: Readonly<Record<string, string>> | null;
	  }
	/** Trust: the session started. */
	| { kind: 'started' }
	/** Trust: Claude exited instead. */
	| { kind: 'exited' };

/** One answer to drive. */
export interface AnswerRequest {
	paneId: string;
	expectation: ScreenExpectation;
	answer: ScreenAnswer;
	/**
	 * The runtime's own word on what the agent waits for (hc's status `msg`),
	 * read before every key; null or absent when it says nothing.
	 */
	statusMessage?: () => string | null | undefined;
	/**
	 * Resolves with what the agent received once the transcript shows it:
	 * the expected `tool_use_id`'s result, the `ExitPlanMode` result, or the
	 * session starting, and at once when it is already written. Called at
	 * most once: as the final key is pressed, or when an earlier key cleared
	 * the dialog. The signal aborts when the driver stops waiting. Absent:
	 * a run whose screen moved on ends at `moved-on`.
	 */
	receipt?: (signal: AbortSignal) => Promise<AnswerReceipt>;
}

// ------------------------------------------------------------------ outputs

/** Why nothing was sent that Claude acts on. */
export type RefusalReason =
	/** The answer does not fit the request, or its words cannot be typed. */
	| 'invalid'
	/** The screen could not be read. */
	| 'read-failed'
	/** The screen shows no dialog, or another one, or this one in a state the driver will not touch. */
	| 'mismatch'
	/** The runtime's status message names another request. */
	| 'status'
	/** The screen did not follow a move or the typed words. */
	| 'stuck'
	/** A move or the typing failed. */
	| 'key-failed';

export type AnswerOutcome =
	/** The screen moved on and the transcript shows what was pressed. */
	| { kind: 'answered'; receipt: AnswerReceipt }
	/**
	 * The screen moved on; the transcript said nothing in time (or nobody
	 * asked it). `final`: after the key that sends the answer; otherwise the
	 * request went away after a toggle or a tab's answer, and what Claude
	 * received, if anything, is unknown.
	 */
	| { kind: 'moved-on'; final: boolean }
	/**
	 * The agent received something else than was pressed. It cannot be
	 * undone; the card says what Claude actually received.
	 */
	| { kind: 'misfire'; expected: string; received: string; receipt: AnswerReceipt }
	/**
	 * A commit key was pressed and the screen did not show it taking. It is
	 * never pressed again. `final`: it was the key that sends the answer;
	 * otherwise a toggle or a tab's answer, which Claude has not received.
	 * `mayLand`: the screen never stayed still long enough to rule out a key
	 * hc still holds, so it may yet arrive; otherwise it stayed unchanged for
	 * {@link AnswerTiming.quietMs} and the key is taken as lost.
	 */
	| { kind: 'not-taken'; final: boolean; detail: string; mayLand: boolean }
	/**
	 * Nothing was sent to Claude, as far as the screen and the transcript
	 * show. `pressed` counts the moves, toggles, tab answers and typing already
	 * sent to the terminal (its cursor and ticks may have changed).
	 */
	| { kind: 'refused'; reason: RefusalReason; detail: string; pressed: number }
	/** Cancelled before any commit key. */
	| { kind: 'cancelled'; reason: string; pressed: number }
	/** Another answer is in flight on this pane; nothing was read or sent. */
	| { kind: 'busy' };

/** A running answer. */
export interface AnswerRun {
	/** Settles once, with the outcome; never rejects. */
	readonly done: Promise<AnswerOutcome>;
	/**
	 * Stops the run before its next key: a runtime status that left `blocked`,
	 * a `/clear` rotation, a newer dangling call. True when it took; false once
	 * any commit key is out (a toggle, a tab's answer, the final key), once the
	 * request went away under the run, or once the run has ended: from there
	 * the outcome says what was sent.
	 */
	readonly cancel: (reason: string) => boolean;
}

/** What a read matched against a request says. */
export type Inspection =
	| { ok: true; dialog: ScreenDialog }
	| { ok: false; reason: Extract<RefusalReason, 'read-failed' | 'mismatch' | 'status'>; detail: string };

/** The card's line for a refusal (ADR-0009 §1). */
export const REFUSAL_TEXT = 'The terminal shows a different dialog now. Answer it there.';

// ------------------------------------------------------------------- timing

export interface AnswerClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export const SYSTEM_CLOCK: AnswerClock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise<void>((resolve) => setTimer(resolve, ms)),
};

export interface AnswerTiming {
	/** Between reads while waiting for the screen. */
	pollMs: number;
	/** How long a move, a toggle or typing has to show. hc may hold keys while a person types. */
	stepMs: number;
	/** The least the final key is given to clear the dialog (ADR-0009 §4: 1.5 s). */
	confirmMs: number;
	/**
	 * How long the screen must stay unchanged, counted from a key that has not
	 * shown and from the screen's last change, before the run takes the key as
	 * lost and lets the pane go: hc holds a key until no one has typed for 3 s,
	 * and a key that lands takes up to 1.5 s to show.
	 */
	quietMs: number;
	/** The most a run waits, after such a key, for that quiet; past it the key may still land. */
	lateMs: number;
	/** How long the transcript has, once the screen moved on. */
	receiptMs: number;
}

export const ANSWER_TIMING: AnswerTiming = {
	pollMs: 100,
	stepMs: 3000,
	confirmMs: 1500,
	quietMs: 4500,
	lateMs: 15000,
	receiptMs: 15000,
};

/** More steps than any measured dialog needs; past it the run refuses. */
const MAX_STEPS = 80;

// ----------------------------------------------------------------- matching

/** Where a matched screen is: a question's tab (by index into the call's questions), the review, or the dialog. */
export type ScreenPlace = number | 'review' | 'dialog';

export type ScreenMatch = { ok: true; place: ScreenPlace } | { ok: false; detail: string };

/**
 * Whether `dialog` is the request, exactly (ADR-0009 §1): the question's
 * text, options and headers; the permission's tool and command, or file and
 * content; the plan's slug and lines; the trust prompt's folder. A plan or
 * content of null (a card still reading the screen) is not checked. Pure.
 */
export function matchScreen(dialog: ScreenDialog, expectation: ScreenExpectation): ScreenMatch {
	switch (expectation.kind) {
		case 'question':
			return matchQuestion(dialog, expectation.questions);
		case 'permission':
			return matchPermission(dialog, expectation);
		case 'plan':
			if (dialog.kind !== 'plan') return miss(dialog, 'a plan approval');
			if (dialog.slug !== expectation.slug) return { ok: false, detail: 'the plan shown is another plan' };
			if (expectation.plan !== null && !wrappedEquals(dialog.plan, expectation.plan.join('\n'))) {
				return { ok: false, detail: 'the plan shown is not the plan the card showed' };
			}
			if (dialog.feedback === null && !wrappedEquals(dialog.options[2]?.lines ?? [], PLAN_ROW_3)) {
				return { ok: false, detail: 'plan row 3 is not "Tell Claude what to change"' };
			}
			return { ok: true, place: 'dialog' };
		case 'trust':
			if (dialog.kind !== 'trust') return miss(dialog, 'the trust prompt');
			if (!expectation.cwd || !wrappedEquals(dialog.folder, expectation.cwd)) {
				return { ok: false, detail: 'the trust prompt names another folder' };
			}
			return { ok: true, place: 'dialog' };
	}
}

const PLAN_ROW_3 = 'Tell Claude what to change';

function miss(dialog: ScreenDialog, wanted: string): ScreenMatch {
	const shown = dialog.kind === 'unknown' ? 'no dialog it can read' : `a ${dialog.kind}`;
	return { ok: false, detail: `the screen shows ${shown}, not ${wanted}` };
}

function optionText(option: { label: string; description: string }): string {
	return option.description ? `${option.label}\n${option.description}` : option.label;
}

function matchQuestion(dialog: ScreenDialog, questions: readonly PendingQuestion[]): ScreenMatch {
	if (dialog.kind !== 'question' && dialog.kind !== 'review') return miss(dialog, 'the question');
	if (questions.length === 0) return { ok: false, detail: 'the request has no questions' };
	const lone = questions.length === 1 && !questions[0]?.multiSelect;
	const headers = dialog.tabs.map((tab) => tab.header);
	if (headers.length !== questions.length || questions.some((q, i) => q.header !== headers[i])) {
		return { ok: false, detail: 'the tabs name other questions' };
	}
	if (dialog.kind === 'review') {
		if (lone) return { ok: false, detail: 'a lone question has no review' };
		const all = dialog.answers.length === questions.length;
		if (!all || questions.some((q, i) => !wrappedEquals(dialog.answers[i]?.question ?? [], q.question))) {
			return { ok: false, detail: 'the review lists other questions' };
		}
		return { ok: true, place: 'review' };
	}
	if (dialog.submitTab === lone) return { ok: false, detail: 'the tab bar does not fit the request' };
	const at = questions.flatMap((q, i) => (wrappedEquals(dialog.question, q.question) ? [i] : []));
	const index = at[0];
	if (at.length !== 1 || index === undefined) return { ok: false, detail: 'the question shown is not one asked' };
	const q = questions[index] as PendingQuestion;
	if (dialog.multiSelect !== q.multiSelect) return { ok: false, detail: 'the question shown takes another kind of answer' };
	if (dialog.options.length !== q.options.length) return { ok: false, detail: 'the question shows other options' };
	const same = q.options.every((option, i) => {
		const row = dialog.options[i];
		return row?.number === i + 1 && wrappedEquals(row.lines, optionText(option));
	});
	if (!same) return { ok: false, detail: 'the question shows other options' };
	return { ok: true, place: index };
}

/** The tools whose permission the reader knows, and what the screen shows of their input. */
function matchPermission(dialog: ScreenDialog, expectation: Extract<ScreenExpectation, { kind: 'permission' }>): ScreenMatch {
	if (dialog.kind !== 'permission') return miss(dialog, 'the permission');
	if (dialog.tool === null || dialog.tool !== expectation.tool) {
		return { ok: false, detail: `the permission is for ${dialog.title}, not ${expectation.tool}` };
	}
	if (dialog.tool === 'Bash') {
		const command = expectation.input.command;
		if (typeof command !== 'string' || !command.trim()) return { ok: false, detail: 'the request has no command' };
		if (!wrappedEquals(dialog.command ?? [], command)) return { ok: false, detail: 'the permission shows another command' };
		return { ok: true, place: 'dialog' };
	}
	const file = expectation.input.file_path;
	if (typeof file !== 'string' || !file) return { ok: false, detail: 'the request has no file' };
	const shown = dialog.file ?? [];
	const relative = relativeTo(file, expectation.cwd);
	if (!wrappedEquals(shown, file) && !(relative !== null && wrappedEquals(shown, relative))) {
		return { ok: false, detail: 'the permission names another file' };
	}
	// Exactly as read at card time: indentation is content, and the same render shows the same lines.
	const content = expectation.content ?? null;
	if (content !== null && !sameLines(dialog.content, content)) {
		return { ok: false, detail: 'the permission shows other content than the card showed' };
	}
	return { ok: true, place: 'dialog' };
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * The request completed with what the card's read of the screen showed: a
 * plan's lines, a Write's or Edit's content. The card builds its expectation
 * without them, reads the screen with {@link ScreenAnswerer.inspect}, shows
 * what it read, and answers with this. Pure.
 */
export function withShown(expectation: ScreenExpectation, dialog: ScreenDialog): ScreenExpectation {
	if (expectation.kind === 'plan' && dialog.kind === 'plan') return { ...expectation, plan: [...dialog.plan] };
	if (expectation.kind === 'permission' && dialog.kind === 'permission' && needsContent(expectation.tool)) {
		return { ...expectation, content: [...dialog.content] };
	}
	return expectation;
}

function needsContent(tool: string): boolean {
	return tool === 'Write' || tool === 'Edit';
}

/** `file` relative to `folder` when it lies inside it, else null. Write and Edit show it so. */
function relativeTo(file: string, folder: string): string | null {
	const base = folder.replace(/\/+$/, '');
	if (!base || !file.startsWith(`${base}/`)) return null;
	const rest = file.slice(base.length + 1);
	return rest || null;
}

/** The ellipsis a runtime may cut a long message with. */
const ELLIPSIS = /\s*(…|\.\.\.)$/;

/**
 * Whether the runtime's status message (hc's OSC 7501 `msg`) agrees with the
 * request. Its known forms are measured on hc 0.1.18: `answer: <question>
 * (A · B)`, `approve Bash: <command>`, `approve plan`; a known form naming
 * another request disagrees. Absent, empty or of another form, it is no
 * evidence either way: the screen is the check. Pure.
 */
export function statusAgrees(expectation: ScreenExpectation, message: string | null | undefined): boolean {
	const msg = (message ?? '').trim();
	if (!msg) return true;
	if (msg.startsWith('answer: ')) {
		if (expectation.kind !== 'question') return false;
		const rest = msg.slice('answer: '.length);
		return expectation.questions.some((q) => bare(rest).startsWith(bare(q.question)) || cutFrom(rest, q.question));
	}
	if (msg === 'approve plan') return expectation.kind === 'plan';
	const approve = /^approve (\S+?)(?::\s*([\s\S]*))?$/.exec(msg);
	if (!approve) return true;
	if (expectation.kind !== 'permission' || approve[1] !== expectation.tool) return false;
	const detail = approve[2]?.trim() ?? '';
	if (expectation.tool !== 'Bash' || !detail) return true;
	const command = expectation.input.command;
	return typeof command === 'string' && (bare(detail) === bare(command) || cutFrom(detail, command));
}

/**
 * Whether `shown` is `full` cut short (by an ellipsis or the line's end).
 * Whitespace is not compared: a request the card read off the screen has it
 * only as the screen wrapped it.
 */
function cutFrom(shown: string, full: string): boolean {
	const head = bare(shown.replace(ELLIPSIS, ''));
	return head.length > 0 && bare(full).startsWith(head);
}

/** Text without whitespace, for comparing a status message with a request. */
function bare(text: string): string {
	return text.replace(/\s+/g, '');
}

// --------------------------------------------------------------- the answer

/** Why `answer` cannot answer `expectation`, or null when it can. Pure. */
export function answerIssue(expectation: ScreenExpectation, answer: ScreenAnswer): string | null {
	const fits: Record<ScreenAnswer['kind'], ScreenExpectation['kind']> = {
		questions: 'question',
		'cancel-question': 'question',
		allow: 'permission',
		'allow-option-2': 'permission',
		deny: 'permission',
		'deny-with-feedback': 'permission',
		'approve-plan': 'plan',
		'reject-plan': 'plan',
		trust: 'trust',
	};
	if (fits[answer.kind] !== expectation.kind) return `a ${answer.kind} answer does not fit a ${expectation.kind}`;
	if (expectation.kind === 'plan' && expectation.plan === null) return 'the answer needs the plan the card showed';
	if (expectation.kind === 'permission' && needsContent(expectation.tool) && (expectation.content ?? null) === null) {
		return 'the answer needs the content the card showed';
	}
	switch (answer.kind) {
		case 'questions': {
			if (expectation.kind !== 'question') return 'not a question';
			const { questions } = expectation;
			if (answer.picks.length !== questions.length) return 'one pick per question is needed';
			for (let i = 0; i < questions.length; i++) {
				const issue = pickIssue(questions[i] as PendingQuestion, answer.picks[i] as QuestionPick);
				if (issue) return issue;
			}
			return null;
		}
		case 'allow-option-2':
			return answer.label.trim() ? null : 'option 2 needs the label the card showed';
		case 'deny-with-feedback':
		case 'reject-plan':
			return wordsIssue(answer.feedback);
		default:
			return null;
	}
}

function wordsIssue(text: string): string | null {
	if (!text.trim()) return 'the words are empty';
	return typedIssue(text.trim());
}

/**
 * Why words cannot be typed into a dialog. A lone digit is the same bytes as
 * the digit's key, which picks that row and answers wherever the cursor is
 * not on a text row (finding `answering-on-screen` §4), and how Claude reads
 * one on a text row is unmeasured: refused until it is.
 */
function typedIssue(text: string): string | null {
	if (/^\d$/.test(text)) return 'a single digit would be read as that option; add a word';
	return screenTextIssue(text);
}

function pickIssue(question: PendingQuestion, pick: QuestionPick): string | null {
	const labels = question.options.map((option) => option.label);
	if (new Set(labels).size !== labels.length) return `"${question.question}" offers one label twice`;
	if (new Set(pick.options).size !== pick.options.length) return 'an option is picked twice';
	if (pick.options.some((label) => !labels.includes(label))) return `"${question.question}" offers no such option`;
	const text = pick.text.trim();
	if (text) {
		const issue = typedIssue(text);
		if (issue) return issue;
	}
	const count = pick.options.length + (text ? 1 : 0);
	if (question.multiSelect ? count === 0 : count !== 1) {
		return question.multiSelect ? 'pick at least one answer' : 'pick exactly one answer';
	}
	return null;
}

/**
 * The answer Claude writes for one question (`toolUseResult.answers`, the
 * review's `→` line): the chosen labels in the options' order, then the own
 * words; for a multi-select joined with `, `, own words with a comma quoted.
 */
export function expectedAnswer(question: PendingQuestion, pick: QuestionPick): string {
	const labels = question.options.map((option) => option.label).filter((label) => pick.options.includes(label));
	const text = pick.text.trim();
	if (!question.multiSelect) return labels[0] ?? text;
	const parts = [...labels];
	if (text) parts.push(text.includes(',') ? `"${text}"` : text);
	return parts.join(', ');
}

/** The answer in words, for a misfire notice. */
export function describeAnswer(expectation: ScreenExpectation, answer: ScreenAnswer): string {
	switch (answer.kind) {
		case 'questions':
			if (expectation.kind !== 'question') return 'answers';
			return expectation.questions
				.map((q, i) => `${q.question} → ${expectedAnswer(q, answer.picks[i] ?? { options: [], text: '' })}`)
				.join('; ');
		case 'cancel-question':
			return 'cancel the question';
		case 'allow':
			return 'allow once';
		case 'allow-option-2':
			return answer.label.trim();
		case 'deny':
			return 'deny';
		case 'deny-with-feedback':
			return `deny: ${answer.feedback.trim()}`;
		case 'approve-plan':
			return answer.mode === 'auto' ? 'approve the plan and use auto mode' : 'approve the plan, approving edits by hand';
		case 'reject-plan':
			return `keep planning: ${answer.feedback.trim()}`;
		case 'trust':
			return 'trust the folder';
	}
}

const REJECTED = "The user doesn't want to proceed with this tool use.";
const PLAN_APPROVED = 'User has approved your plan';

/**
 * Whether what the agent received is what was pressed (ADR-0009 §4). The
 * texts are Claude Code 2.1.318's: a denial or rejection starts with "The
 * user doesn't want to proceed with this tool use." and carries "the user
 * said:\n<words>"; an approved plan starts "User has approved your plan";
 * an answered question carries `"<question>"="<answer>"` per question. A
 * Bash command that ran and failed is an error too, so allow is judged by
 * the rejection text, not by `isError`. Pure.
 */
export function receiptAgrees(expectation: ScreenExpectation, answer: ScreenAnswer, receipt: AnswerReceipt): boolean {
	if (answer.kind === 'trust') return receipt.kind === 'started';
	if (receipt.kind !== 'result') return false;
	const text = receipt.text.trim();
	const rejected = text.startsWith(REJECTED);
	const said = (words: string): boolean => rejected && text.includes(`the user said:\n${words.trim()}`);
	switch (answer.kind) {
		case 'questions': {
			if (expectation.kind !== 'question' || rejected) return false;
			return expectation.questions.every((q, i) => {
				const want = expectedAnswer(q, answer.picks[i] ?? { options: [], text: '' });
				const got = receipt.answers?.[q.question];
				if (receipt.answers) return got === want;
				return text.includes(`"${q.question}"="${want}"`);
			});
		}
		case 'cancel-question':
		case 'deny':
			return rejected && !text.includes('the user said:');
		case 'allow':
		case 'allow-option-2':
			return !rejected;
		case 'deny-with-feedback':
		case 'reject-plan':
			return said(answer.feedback);
		case 'approve-plan':
			return text.startsWith(PLAN_APPROVED);
	}
}

/** What the agent received, in a line, for the misfire notice. */
export function describeReceipt(receipt: AnswerReceipt): string {
	if (receipt.kind === 'started') return 'the session started';
	if (receipt.kind === 'exited') return 'Claude exited';
	if (receipt.answers) {
		return Object.entries(receipt.answers)
			.map(([q, a]) => `${q} → ${a}`)
			.join('; ');
	}
	const line = receipt.text.trim().replace(/\s+/g, ' ');
	return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

// -------------------------------------------------------------------- steps

type MoveKey = 'up' | 'down' | 'left' | 'right' | 'tab' | 'ctrl+u';
type CommitKey = 'enter' | 'esc';

/** A read that matched the request. */
interface Seen {
	dialog: ScreenDialog;
	place: ScreenPlace;
}

type Until = (seen: Seen) => boolean;

/**
 * The next thing to do, from one matched read. `moves` and `type` then wait
 * for `until`; `commit` (a toggle, a tab's answer) too; `final` sends the
 * answer and is never followed by another key.
 */
type Step =
	| { type: 'moves'; keys: MoveKey[]; until: Until; tabDone?: number }
	| { type: 'type'; text: string; until: Until; tabDone?: undefined }
	| { type: 'commit'; key: CommitKey; until: Until; tabDone?: number }
	| { type: 'final'; key: CommitKey }
	| { type: 'refuse'; reason: RefusalReason; detail: string };

interface Progress {
	/** The tabs this run has answered, by question index. */
	done: Set<number>;
}

function refuse(detail: string, reason: RefusalReason = 'mismatch'): Step {
	return { type: 'refuse', reason, detail };
}

function repeat(key: MoveKey, count: number): MoveKey[] {
	return Array.from({ length: count }, () => key);
}

/** The next step towards `answer` from `seen`. Pure. */
function nextStep(seen: Seen, expectation: ScreenExpectation, answer: ScreenAnswer, progress: Progress): Step {
	const { dialog } = seen;
	switch (answer.kind) {
		case 'questions':
		case 'cancel-question':
			if (expectation.kind !== 'question') return refuse('not a question', 'invalid');
			return questionStep(seen, expectation.questions, answer, progress);
		case 'allow':
		case 'allow-option-2':
		case 'deny':
		case 'deny-with-feedback':
			if (dialog.kind !== 'permission') return refuse('not a permission');
			return permissionStep(dialog, answer);
		case 'approve-plan':
		case 'reject-plan':
			if (dialog.kind !== 'plan') return refuse('not a plan');
			return planStep(dialog, answer);
		case 'trust':
			if (dialog.kind !== 'trust') return refuse('not the trust prompt');
			return trustStep(dialog);
	}
}

// questions

/** A question's rows top to bottom, as `up`/`down` walk them. */
function rowOrder(d: QuestionDialog): (number | 'submit')[] {
	const rows: (number | 'submit')[] = [...d.options.map((row) => row.number), d.text.number];
	if (d.submitRow) rows.push('submit');
	rows.push(d.chat);
	return rows;
}

function cursorMoves(d: QuestionDialog, place: ScreenPlace, target: number): Step {
	const order = rowOrder(d);
	const from = order.indexOf(d.cursor);
	const to = order.indexOf(target);
	if (from < 0 || to < 0) return refuse('the cursor is on no row it knows');
	const keys = to > from ? repeat('down', to - from) : repeat('up', from - to);
	return {
		type: 'moves',
		keys,
		until: (seen) => seen.place === place && seen.dialog.kind === 'question' && seen.dialog.cursor === target,
	};
}

/** The screen shows tab `index` (a question index, or `questions.length` for the review). */
function onTab(index: number, count: number): Until {
	return (seen) => (index >= count ? seen.place === 'review' : seen.place === index);
}

function questionStep(
	seen: Seen,
	questions: readonly PendingQuestion[],
	answer: Extract<ScreenAnswer, { kind: 'questions' | 'cancel-question' }>,
	progress: Progress,
): Step {
	const count = questions.length;
	const here = seen.place === 'review' ? count : seen.place;
	if (typeof here !== 'number') return refuse('not a question');
	if (answer.kind === 'cancel-question') {
		// `esc` from a question tab; the review is left first.
		if (seen.dialog.kind === 'review') return { type: 'moves', keys: ['left'], until: (s) => s.dialog.kind === 'question' };
		return { type: 'final', key: 'esc' };
	}
	const lone = count === 1 && !questions[0]?.multiSelect;
	if (lone) {
		if (seen.dialog.kind !== 'question') return refuse('not a question');
		return tabStep(seen, 0, questions[0] as PendingQuestion, answer.picks[0] as QuestionPick, true, count);
	}
	let first = 0;
	while (first < count && progress.done.has(first)) first++;
	if (here !== first) {
		const keys = here < first ? repeat('right', first - here) : repeat('left', here - first);
		return tabMoves(seen, keys, onTab(first, count));
	}
	if (seen.dialog.kind === 'review') return reviewStep(seen.dialog, questions, answer.picks);
	return tabStep(seen, first, questions[first] as PendingQuestion, answer.picks[first] as QuestionPick, false, count);
}

/**
 * `left`/`right` to another tab, from an option row. On the own-answer row
 * the arrows move within the typed words and the tab stays (measured
 * 2026-11-06, Claude Code 2.1.318, herdr and hc), so the cursor goes up to
 * the last option first; never down onto `Submit`, whose repaint can tear.
 */
function tabMoves(seen: Seen, keys: MoveKey[], until: Until, tabDone?: number): Step {
	const d = seen.dialog;
	if (d.kind === 'question' && !(typeof d.cursor === 'number' && d.cursor <= d.options.length)) {
		return cursorMoves(d, seen.place, d.options.length);
	}
	return { type: 'moves', keys, until, tabDone };
}

/** One tab's answer: ticks, then the own words, then `enter` (single choice) or `right` (multi-select). */
function tabStep(
	seen: Seen,
	index: number,
	question: PendingQuestion,
	pick: QuestionPick,
	lone: boolean,
	count: number,
): Step {
	const d = seen.dialog as QuestionDialog;
	const text = pick.text.trim();
	const next = onTab(index + 1, count);

	if (question.multiSelect) {
		for (const row of d.options) {
			const label = question.options[row.number - 1]?.label ?? '';
			const want = pick.options.includes(label);
			if (row.ticked === want) continue;
			if (d.cursor !== row.number) return cursorMoves(d, seen.place, row.number);
			const before = d.options.map((r) => r.ticked);
			return {
				type: 'commit',
				key: 'enter',
				// The toggle shows: this row flipped, the others and the cursor as they were.
				until: (s) =>
					s.place === seen.place &&
					s.dialog.kind === 'question' &&
					s.dialog.cursor === row.number &&
					s.dialog.options.every((r, i) => r.ticked === (r.number === row.number ? want : before[i])),
			};
		}
	}

	if (text || (question.multiSelect && d.text.lines !== null)) {
		const step = ownWords(d, seen.place, text);
		if (step) return step;
	}
	if (question.multiSelect) {
		if ((d.text.ticked ?? false) !== Boolean(text)) {
			return refuse(text ? 'the own answer is typed but not ticked' : 'the own-answer row is ticked with nothing typed');
		}
		return tabMoves(seen, ['right'], next, index);
	}
	const target = text ? d.text.number : question.options.findIndex((option) => option.label === pick.options[0]) + 1;
	if (target < 1) return refuse('no such option', 'invalid');
	if (d.cursor !== target) return cursorMoves(d, seen.place, target);
	if (lone) return { type: 'final', key: 'enter' };
	return { type: 'commit', key: 'enter', until: next, tabDone: index };
}

/**
 * Gets the own-answer row to show exactly `text` ('' for nothing): the
 * cursor there, `ctrl+u` over other words, then the words typed. Null once it
 * does and the cursor is where the answer needs it.
 */
function ownWords(d: QuestionDialog, place: ScreenPlace, text: string): Step | null {
	const row = d.text.number;
	const shown = d.text.lines;
	const right = text ? shown !== null && wrappedEquals(shown, text) : shown === null;
	if (right) return null;
	if (d.cursor !== row) return cursorMoves(d, place, row);
	const atRow = (s: Seen): s is Seen & { dialog: QuestionDialog } =>
		s.place === place && s.dialog.kind === 'question' && s.dialog.cursor === row;
	if (shown !== null) return { type: 'moves', keys: ['ctrl+u'], until: (s) => atRow(s) && s.dialog.text.lines === null };
	return { type: 'type', text, until: (s) => atRow(s) && wrappedEquals(s.dialog.text.lines ?? [], text) };
}

function reviewStep(d: ReviewDialog, questions: readonly PendingQuestion[], picks: readonly QuestionPick[]): Step {
	const right = questions.every((q, i) => {
		const shown = d.answers[i];
		return shown && wrappedEquals(shown.answer, expectedAnswer(q, picks[i] ?? { options: [], text: '' }));
	});
	if (!right) return refuse('the review shows other answers than the ones chosen');
	if (d.cursor === 'cancel') {
		return { type: 'moves', keys: ['up'], until: (s) => s.dialog.kind === 'review' && s.dialog.cursor === 'submit' };
	}
	return { type: 'final', key: 'enter' };
}

// permissions

function permissionStep(
	d: PermissionDialog,
	answer: Extract<ScreenAnswer, { kind: 'allow' | 'allow-option-2' | 'deny' | 'deny-with-feedback' }>,
): Step {
	const last = d.options.length;
	const toRow = (target: number): Step => ({
		type: 'moves',
		keys: target > d.cursor ? repeat('down', target - d.cursor) : repeat('up', d.cursor - target),
		until: (s) => s.dialog.kind === 'permission' && s.dialog.cursor === target && s.dialog.amending === d.amending,
	});
	if (answer.kind !== 'deny-with-feedback' && d.amending) return refuse('the terminal is in the middle of an answer');
	switch (answer.kind) {
		case 'deny':
			return { type: 'final', key: 'esc' };
		case 'allow':
		case 'allow-option-2': {
			const target = answer.kind === 'allow' ? 1 : 2;
			const label = answer.kind === 'allow' ? 'Yes' : answer.label;
			const row = d.options[target - 1];
			if (target >= last || !row || !wrappedEquals(row.lines, label)) {
				return refuse(`row ${target} does not read "${label.trim()}"`);
			}
			return d.cursor === target ? { type: 'final', key: 'enter' } : toRow(target);
		}
		case 'deny-with-feedback': {
			const words = answer.feedback.trim();
			if (!d.amending) {
				if (d.cursor !== last) return toRow(last);
				return {
					type: 'moves',
					keys: ['tab'],
					until: (s) => s.dialog.kind === 'permission' && s.dialog.amending && s.dialog.cursor === last,
				};
			}
			if (d.cursor !== last) return refuse('the terminal is in the middle of an answer');
			const amending = (s: Seen): s is Seen & { dialog: PermissionDialog } =>
				s.dialog.kind === 'permission' && s.dialog.amending && s.dialog.cursor === last;
			if (d.feedback === null) {
				return { type: 'type', text: words, until: (s) => amending(s) && wrappedEquals(s.dialog.feedback ?? [], words) };
			}
			if (!wrappedEquals(d.feedback, words)) {
				return { type: 'moves', keys: ['ctrl+u'], until: (s) => amending(s) && s.dialog.feedback === null };
			}
			return { type: 'final', key: 'enter' };
		}
	}
}

// plan

function planStep(d: PlanDialog, answer: Extract<ScreenAnswer, { kind: 'approve-plan' | 'reject-plan' }>): Step {
	const target = answer.kind === 'reject-plan' ? 3 : answer.mode === 'auto' ? 1 : 2;
	if (d.cursor !== target) {
		return {
			type: 'moves',
			keys: target > d.cursor ? repeat('down', target - d.cursor) : repeat('up', d.cursor - target),
			until: (s) => s.dialog.kind === 'plan' && s.dialog.cursor === target,
		};
	}
	if (answer.kind === 'approve-plan') {
		const label = answer.label?.trim() ?? '';
		if (label && !wrappedEquals(d.options[target - 1]?.lines ?? [], label)) {
			return refuse(`plan row ${target} does not read "${label}"`);
		}
		return { type: 'final', key: 'enter' };
	}
	const words = answer.feedback.trim();
	const onRow = (s: Seen): s is Seen & { dialog: PlanDialog } => s.dialog.kind === 'plan' && s.dialog.cursor === 3;
	if (d.feedback === null) {
		return { type: 'type', text: words, until: (s) => onRow(s) && wrappedEquals(s.dialog.feedback ?? [], words) };
	}
	if (!wrappedEquals(d.feedback, words)) {
		return { type: 'moves', keys: ['ctrl+u'], until: (s) => onRow(s) && s.dialog.feedback === null };
	}
	return { type: 'final', key: 'enter' };
}

// trust

function trustStep(d: TrustDialog): Step {
	// Never a bare `enter`: the cursor starts on "No, exit".
	if (d.cursor === 'no') {
		return { type: 'moves', keys: ['down'], until: (s) => s.dialog.kind === 'trust' && s.dialog.cursor === 'yes' };
	}
	return { type: 'final', key: 'enter' };
}

// ------------------------------------------------------------------- driver

/** What the driver needs: the runtime's screen, the agent's reader, a clock. */
export interface ScreenAnswerDeps {
	screen: ScreenAccess;
	/** The agent format's reader (`AgentFormat.screenDialog`). */
	parse: (screen: string) => ScreenDialog;
	clock?: AnswerClock;
	timing?: Partial<AnswerTiming>;
}

interface Resolved {
	screen: ScreenAccess;
	parse: (screen: string) => ScreenDialog;
	clock: AnswerClock;
	timing: AnswerTiming;
}

/**
 * Answers dialogs on one runtime's panes, one answer per pane at a time.
 * Hold one per runtime connection and agent format: the in-flight guard is
 * per instance.
 */
export class ScreenAnswerer {
	private readonly deps: Resolved;
	private readonly running = new Set<string>();

	constructor(deps: ScreenAnswerDeps) {
		this.deps = {
			screen: deps.screen,
			parse: deps.parse,
			clock: deps.clock ?? SYSTEM_CLOCK,
			timing: { ...ANSWER_TIMING, ...deps.timing },
		};
	}

	/** Whether an answer is in flight on `paneId`: the card's controls stay disabled. */
	busy(paneId: string): boolean {
		return this.running.has(paneId);
	}

	/**
	 * Reads the screen once and matches it against the request, pressing
	 * nothing: what the card takes Claude's labels from (permission row 2) and
	 * whether it offers controls at all. Trust has no transcript, so this is
	 * also how a trust prompt is recognised.
	 */
	async inspect(
		paneId: string,
		expectation: ScreenExpectation,
		statusMessage?: () => string | null | undefined,
	): Promise<Inspection> {
		const read = await readDialog(this.deps, paneId);
		if (!read.ok) return { ok: false, reason: 'read-failed', detail: read.detail };
		const match = matchScreen(read.dialog, expectation);
		if (!match.ok) return { ok: false, reason: 'mismatch', detail: match.detail };
		if (!statusAgrees(expectation, statusMessage?.())) return { ok: false, reason: 'status', detail: STATUS_DETAIL };
		return { ok: true, dialog: read.dialog };
	}

	/** Starts answering; see {@link AnswerRun}. A pane with an answer in flight gets `busy`. */
	answer(request: AnswerRequest): AnswerRun {
		if (this.running.has(request.paneId)) {
			return { done: Promise.resolve({ kind: 'busy' }), cancel: () => false };
		}
		this.running.add(request.paneId);
		const run = new Run(this.deps, request);
		const done = run
			.drive()
			.catch((error: unknown): AnswerOutcome => {
				// Every call inside is guarded; this is the last net.
				const detail = messageOf(error);
				return run.committed
					? { kind: 'not-taken', final: run.finalSent, detail, mayLand: true }
					: { kind: 'refused', reason: 'key-failed', detail, pressed: run.pressed };
			})
			.finally(() => this.running.delete(request.paneId));
		return { done, cancel: (reason) => run.cancel(reason) };
	}
}

const STATUS_DETAIL = 'the runtime says it waits for something else';

async function readDialog(
	deps: Resolved,
	paneId: string,
): Promise<{ ok: true; dialog: ScreenDialog } | { ok: false; detail: string }> {
	try {
		return { ok: true, dialog: deps.parse(await deps.screen.read(paneId)) };
	} catch (error) {
		return { ok: false, detail: messageOf(error) };
	}
}

/** One read: the request (`seen`), not the request (`gone`), the runtime naming another (`status`), or no read. */
type Read =
	| { kind: 'seen'; seen: Seen }
	| { kind: 'gone'; detail: string; definite: boolean }
	| { kind: 'status' }
	| { kind: 'failed'; detail: string };

type Missed = Exclude<Read, { kind: 'seen' }>;

type Waited = { ok: true; seen: Seen } | { ok: false; last: Missed | null };

/**
 * After a key that has not shown: what the reads say while the run holds on
 * (see {@link Run.watch}).
 */
type Watched =
	/** The intended state showed after all: the key landed late. */
	| { kind: 'shown'; seen: Seen }
	/** The request is gone, from two reads in a row. */
	| { kind: 'gone'; detail: string }
	/** The transcript answered. */
	| { kind: 'receipt'; receipt: AnswerReceipt }
	/**
	 * The screen stayed the same for `quietMs` (`mayLand` false), or never did
	 * by `lateMs` (`mayLand` true); `failed` when the last read failed.
	 */
	| { kind: 'still'; mayLand: boolean; failed: boolean };

/** One answer, start to end. */
class Run {
	pressed = 0;
	/**
	 * A commit key is out (a toggle, a tab's answer, the final key), or the
	 * request went away under the run: no cancel from here, the outcome says
	 * what was sent.
	 */
	committed = false;
	/** The final key is out. */
	finalSent = false;
	private cancelled: string | null = null;
	private finished = false;
	private readonly progress: Progress = { done: new Set() };
	private readonly abort = new AbortController();
	private receiptAsked: Promise<AnswerReceipt | null> | null = null;
	private receipt: AnswerReceipt | null = null;
	/** The last read, by its parsed content, and when a read last differed from the one before. */
	private lastShot: string | null = null;
	private changedAt = 0;

	constructor(
		private readonly deps: Resolved,
		private readonly request: AnswerRequest,
	) {}

	cancel(reason: string): boolean {
		if (this.committed || this.finished) return false;
		this.cancelled ??= reason;
		return true;
	}

	async drive(): Promise<AnswerOutcome> {
		try {
			return await this.steps();
		} finally {
			this.finished = true;
			this.abort.abort();
		}
	}

	private refused(reason: RefusalReason, detail: string): AnswerOutcome {
		return { kind: 'refused', reason, detail, pressed: this.pressed };
	}

	private stopped(): AnswerOutcome | null {
		return this.cancelled === null ? null : { kind: 'cancelled', reason: this.cancelled, pressed: this.pressed };
	}

	private fromRead(read: Missed | null): AnswerOutcome {
		if (!read) return this.refused('stuck', 'the screen did not follow the keys');
		if (read.kind === 'status') return this.refused('status', STATUS_DETAIL);
		if (read.kind === 'failed') return this.refused('read-failed', read.detail);
		return this.refused('mismatch', read.detail);
	}

	/** One read, parsed and matched against the request and, before keys, the runtime's word. */
	private async look(withStatus: boolean): Promise<Read> {
		const read = await readDialog(this.deps, this.request.paneId);
		this.note(read.ok ? JSON.stringify(read.dialog) : null);
		if (!read.ok) return { kind: 'failed', detail: read.detail };
		const match = matchScreen(read.dialog, this.request.expectation);
		if (!match.ok) return { kind: 'gone', detail: match.detail, definite: read.dialog.kind !== 'unknown' };
		if (withStatus && !statusAgrees(this.request.expectation, this.request.statusMessage?.())) {
			return { kind: 'status' };
		}
		return { kind: 'seen', seen: { dialog: read.dialog, place: match.place } };
	}

	/** Keeps when the screen last changed; a failed read counts as a change, since it shows nothing. */
	private note(shot: string | null): void {
		if (shot === null || shot !== this.lastShot) this.changedAt = this.deps.clock.now();
		this.lastShot = shot;
	}

	/**
	 * Reads until the screen shows `until`, for up to `ms`. Another known
	 * dialog, or the runtime naming another request, ends it at once; an
	 * unreadable screen (a repaint caught half way) is read again. `last` is
	 * null when the request stayed up and never showed `until`.
	 */
	private async waitFor(until: Until, ms: number): Promise<Waited> {
		const { clock, timing } = this.deps;
		const deadline = clock.now() + ms;
		let last: Missed | null = null;
		do {
			await clock.sleep(timing.pollMs);
			const read = await this.look(true);
			if (read.kind === 'seen') {
				if (until(read.seen)) return { ok: true, seen: read.seen };
				last = null;
			} else {
				last = read;
				if (read.kind === 'status' || (read.kind === 'gone' && read.definite)) break;
			}
		} while (clock.now() < deadline);
		return { ok: false, last };
	}

	/**
	 * After a key that has not shown (`pressedAt`, when its call returned):
	 * reads on, holding the pane and the receipt, until the key shows
	 * (`until`), the request is gone from two reads in a row, the transcript
	 * answers, or the screen has stayed the same for `quietMs` counted from
	 * the key and from its last change, and at least `minMs` from the key.
	 * hc holds a key until no one has typed for 3 s; a person typing changes
	 * the screen, so a screen that stays still that long is past the hold and
	 * the key is lost. One that never stays still ends at `lateMs`, with the
	 * key possibly still to land.
	 */
	private async watch(pressedAt: number, until: Until | null, minMs: number): Promise<Watched> {
		const { clock, timing } = this.deps;
		let gone = 0;
		let failed = false;
		for (;;) {
			if (this.receipt) return { kind: 'receipt', receipt: this.receipt };
			const now = clock.now();
			const still = now - Math.max(pressedAt, this.changedAt);
			if (now - pressedAt >= minMs && still >= timing.quietMs) return { kind: 'still', mayLand: false, failed };
			if (now - pressedAt >= timing.lateMs) return { kind: 'still', mayLand: true, failed };
			await clock.sleep(timing.pollMs);
			const read = await this.look(false);
			failed = read.kind === 'failed';
			if (read.kind === 'gone') {
				if (++gone >= 2) return { kind: 'gone', detail: read.detail };
				continue;
			}
			gone = 0;
			if (read.kind === 'seen' && until?.(read.seen)) return { kind: 'shown', seen: read.seen };
		}
	}

	private async press(key: ScreenKey): Promise<void> {
		// A digit answers without the row being checked; the driver never sends one.
		if (/^\d$/.test(key)) throw new Error('the answer driver presses no digits');
		await this.deps.screen.press(this.request.paneId, key);
	}

	private async type(text: string): Promise<void> {
		// A lone digit is the digit's key (answerIssue refuses it first).
		const issue = typedIssue(text.trim());
		if (issue) throw new Error(issue);
		await this.deps.screen.type(this.request.paneId, text);
	}

	/** Sends one move, toggle or the words, unless cancelled; the outcome when it did not go. */
	private async send(action: () => Promise<void>): Promise<AnswerOutcome | null> {
		const halt = this.stopped();
		if (halt) return halt;
		try {
			await action();
		} catch (error) {
			return this.refused('key-failed', messageOf(error));
		}
		this.pressed++;
		return null;
	}

	private async steps(): Promise<AnswerOutcome> {
		const { expectation, answer } = this.request;
		const issue = answerIssue(expectation, answer);
		if (issue) return this.refused('invalid', issue);
		const { clock, timing } = this.deps;

		const first = await this.look(true);
		if (first.kind !== 'seen') return this.fromRead(first);
		let seen = first.seen;

		for (let n = 0; n < MAX_STEPS; n++) {
			const stop = this.stopped();
			if (stop) return stop;
			const step = nextStep(seen, expectation, answer, this.progress);
			if (step.type === 'refuse') return this.refused(step.reason, step.detail);
			if (step.type === 'final') return this.final(step.key);

			if (step.type === 'moves') {
				for (const key of step.keys) {
					const failed = await this.send(() => this.press(key));
					if (failed) return failed;
				}
			} else if (step.type === 'type') {
				const failed = await this.send(() => this.type(step.text));
				if (failed) return failed;
			} else {
				// Set in the same synchronous stretch as the cancel check in send().
				const failed = await this.send(() => {
					this.committed = true;
					return this.press(step.key);
				});
				if (failed) return failed;
			}
			const pressedAt = clock.now();

			const next = await this.waitFor(step.until, timing.stepMs);
			if (next.ok) {
				seen = next.seen;
			} else {
				// A move or the words change nothing Claude acts on: if the transcript
				// stays silent, nothing was sent. A toggle or a tab's answer may have.
				const silent = (read: Missed | null): AnswerOutcome | null =>
					step.type === 'commit' ? null : this.fromRead(read);
				const last = next.last;
				if (last?.kind === 'status' || (last?.kind === 'gone' && last.definite)) {
					return this.judgeGone(false, silent(last));
				}
				// Still the request, or a screen not read: the key may land yet.
				const late = await this.watch(pressedAt, step.until, 0);
				if (late.kind === 'gone') {
					return this.judgeGone(false, silent({ kind: 'gone', detail: late.detail, definite: false }));
				}
				if (late.kind !== 'shown') {
					const halt = this.stopped();
					if (halt) return halt;
					if (step.type === 'commit') {
						const mayLand = late.kind === 'still' && late.mayLand;
						return { kind: 'not-taken', final: false, detail: `${step.key} did not show on the screen`, mayLand };
					}
					return late.kind === 'still' && late.failed
						? this.refused('read-failed', 'the screen could not be read after the keys')
						: this.fromRead(null);
				}
				seen = late.seen;
			}
			if (step.tabDone !== undefined) this.progress.done.add(step.tabDone);
		}
		return this.refused('stuck', 'the answer took more steps than any dialog needs');
	}

	/** Asks for the transcript's word, once; it may already be there. */
	private askReceipt(): Promise<AnswerReceipt | null> | null {
		const { receipt } = this.request;
		if (!receipt) return null;
		this.receiptAsked ??= receipt(this.abort.signal).then(
			(value) => {
				this.receipt = value;
				return value;
			},
			() => null,
		);
		return this.receiptAsked;
	}

	private judge(receipt: AnswerReceipt): AnswerOutcome {
		const { expectation, answer } = this.request;
		if (receiptAgrees(expectation, answer, receipt)) return { kind: 'answered', receipt };
		return {
			kind: 'misfire',
			expected: describeAnswer(expectation, answer),
			received: describeReceipt(receipt),
			receipt,
		};
	}

	/**
	 * The request is gone from the screen: the transcript decides, for up to
	 * `receiptMs`. Silent, the outcome is `silent` when given (after a move or
	 * the words, which send nothing), else `moved-on`.
	 */
	private async judgeGone(final: boolean, silent: AnswerOutcome | null): Promise<AnswerOutcome> {
		this.committed = true;
		const fallback: AnswerOutcome = silent ?? { kind: 'moved-on', final };
		const waiting = this.askReceipt();
		if (!waiting) return fallback;
		const { clock, timing } = this.deps;
		const value = await Promise.race([waiting, clock.sleep(timing.receiptMs).then(() => null)]);
		return value ? this.judge(value) : fallback;
	}

	/**
	 * Presses the final key, once, and confirms by content (ADR-0009 §4): the
	 * request gone from two reads in a row (one torn repaint is not taken for
	 * it), or the transcript's word, whichever comes first. A key that does not
	 * show is held on to past hc's hold ({@link Run.watch}) before it is called
	 * not taken.
	 */
	private async final(key: CommitKey): Promise<AnswerOutcome> {
		// Checked and set in one synchronous stretch: a cancel after this is refused.
		const stop = this.stopped();
		if (stop) return stop;
		this.committed = true;
		this.finalSent = true;
		const { clock, timing } = this.deps;

		void this.askReceipt();
		let pressError: string | null = null;
		try {
			await this.press(key);
		} catch (error) {
			// It may have landed all the same: the screen says.
			pressError = messageOf(error);
		}

		const watched = await this.watch(clock.now(), null, timing.confirmMs);
		if (watched.kind === 'receipt') return this.judge(watched.receipt);
		if (watched.kind === 'gone') return this.judgeGone(true, null);
		const mayLand = watched.kind === 'still' && watched.mayLand;
		return { kind: 'not-taken', final: true, detail: pressError ?? `${key} did not clear the dialog`, mayLand };
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

