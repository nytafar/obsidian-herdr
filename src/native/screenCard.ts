/**
 * The waiting card's request on a herdr or herdr-core pane, read off the
 * screen (#166, ADR-0009 §1 and §3). Pure: the card view
 * (`./waitingCardView.ts`) reads the screen and drives the answer; this says
 * what the request is, what the card offers, how the transcript says what
 * Claude received, and what each outcome reads as.
 *
 * **The call when it is there, the screen when it is not.** The dangling call
 * is the request ADR-0009 names, and it is tried first. On Claude Code
 * 2.1.318 it is usually missing while a question is up, and a Write or Bash
 * call can lag its dialog (`docs/architecture.md`, "Answering Claude's
 * dialogs from the screen"), so the request is otherwise read off the screen
 * itself: the card then shows exactly what the terminal shows, and every
 * answer must find that again before a key goes (`./screenAnswer.ts`). What
 * the screen cannot say exactly, the card does not offer: a question with
 * several tabs and no call (only the current tab is on screen), and an option
 * whose label may have wrapped into the line its description starts on.
 *
 * **Labels are Claude's.** Permission row 2 is a project rule, a directory
 * grant or a session mode switch depending on the tool, so it is offered with
 * its screen text; "switch to auto mode" is not offered, nor is a plan's
 * approve-with-feedback (it switches the session to auto mode).
 */

import { joinWrapped, type PermissionDialog, type QuestionDialog, type ScreenDialog, type ScreenRow } from '../agents/screenDialog';
import type { PendingCall } from '../agents/format';
import { questionsFromInput, type PendingQuestion, type PendingQuestionOption } from './pendingRequest';
import type { ToolEntry, Turn } from './conversation';
import { REFUSAL_TEXT, type AnswerOutcome, type AnswerReceipt, type ScreenExpectation } from './screenAnswer';

/** What a dangling call is, by the agent's format (`AgentFormat.pendingCall`); null for a plain tool. */
export type CallKind = (call: ToolEntry) => PendingCall['kind'] | null;

/** What the card knows beside the screen. */
export interface ScreenCardContext {
	/** The transcript's newest call when it has no result, else null. */
	dangling: ToolEntry | null;
	/** What kind of call `dangling` is. */
	callKind: CallKind;
	/** The pane's working directory, as its runtime reports it. */
	cwd: string;
	/** The runtime's own word on the request (hc's status `msg`), or null. */
	statusMessage: string | null;
}

/** The requests a screen may be, best first, or why the card offers no answer. */
export type ScreenRequests = { ok: true; expectations: ScreenExpectation[] } | { ok: false; reason: string };

/** The tools whose permission the driver answers. */
const ANSWERED_TOOLS = new Set(['Bash', 'Write', 'Edit']);

/**
 * The requests `dialog` may be answered as, the dangling call's first (ADR-0009
 * §1), then the one read off the screen. `screen` is the raw read the dialog
 * came from, for its width. Pure.
 */
export function screenRequests(dialog: ScreenDialog, screen: string, context: ScreenCardContext): ScreenRequests {
	const { dangling, callKind } = context;
	switch (dialog.kind) {
		case 'question': {
			const expectations: ScreenExpectation[] = [];
			if (dangling && callKind(dangling) === 'question') {
				const questions = questionsFromInput(dangling.input);
				if (questions.length > 0) expectations.push({ kind: 'question', toolUseId: dangling.id, questions });
			}
			const read = questionFromScreen(dialog, screenWidth(screen), context.statusMessage);
			if (read.ok) expectations.push({ kind: 'question', toolUseId: null, questions: [read.question] });
			if (expectations.length > 0) return { ok: true, expectations };
			return { ok: false, reason: read.ok ? 'The question shows nothing Gjetr can read.' : read.reason };
		}
		case 'review':
			return { ok: false, reason: 'The terminal shows the answers given there for review; submit or change them in the terminal.' };
		case 'permission': {
			const tool = dialog.tool;
			if (tool === null || !ANSWERED_TOOLS.has(tool)) {
				return { ok: false, reason: `Gjetr does not answer this kind of permission (${dialog.title}) from the view.` };
			}
			const expectations: ScreenExpectation[] = [];
			if (dangling && dangling.name === tool && callKind(dangling) === null) {
				expectations.push({ kind: 'permission', toolUseId: dangling.id, tool, input: dangling.input, cwd: context.cwd, content: null });
			}
			const input = permissionInput(dialog);
			if (input) expectations.push({ kind: 'permission', toolUseId: null, tool, input, cwd: context.cwd, content: null });
			return expectations.length > 0 ? { ok: true, expectations } : { ok: false, reason: 'The permission names nothing Gjetr can read.' };
		}
		case 'plan':
			if (dialog.slug === null) return { ok: false, reason: 'The plan names no plan file Gjetr can read.' };
			return { ok: true, expectations: [{ kind: 'plan', slug: dialog.slug, plan: null }] };
		case 'trust':
			if (!context.cwd) return { ok: false, reason: 'The pane reports no folder to check the prompt against.' };
			return { ok: true, expectations: [{ kind: 'trust', cwd: context.cwd }] };
		case 'unknown':
			return { ok: false, reason: 'The terminal shows no dialog Gjetr can read.' };
	}
}

/** What the screen shows of a Bash command or a file, as the call's input would hold it. */
function permissionInput(dialog: PermissionDialog): Record<string, unknown> | null {
	if (dialog.tool === 'Bash') {
		const command = joinWrapped(dialog.command ?? []);
		return command ? { command } : null;
	}
	const file = joinWrapped(dialog.file ?? []);
	return file ? { file_path: file } : null;
}

// ---------------------------------------------------------------- questions

/**
 * Where a question option's text starts, at most: behind the cursor, the
 * number and a multi-select's box. A label is taken as read only when its
 * line ends so far from the screen's edge that the description's first word
 * would have fitted on it.
 */
const OPTION_INDENT = 9;

/**
 * How wide the screen is, in cells: its widest rule of `─`, which runs edge
 * to edge (one cell per character), else its widest line counted the same.
 */
export function screenWidth(screen: string): number {
	let rule = 0;
	let line = 0;
	for (const text of screen.split('\n')) {
		const trimmed = text.replace(/\s+$/, '');
		const cells = [...trimmed].length;
		line = Math.max(line, cells);
		if (/^\s*─+$/.test(trimmed)) rule = Math.max(rule, cells);
	}
	return rule || line;
}

/**
 * Terminal cells a text takes, counted high: a character from the wide East
 * Asian blocks or an emoji as two. Too high only makes a label read as
 * unsure, which the card then does not offer.
 */
function cellWidth(text: string): number {
	let cells = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe4f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			code >= 0x1f000;
		cells += wide ? 2 : 1;
	}
	return cells;
}

/**
 * One option's label and description from its screen row, or null when the
 * label may have wrapped onto the line the description starts on: a wrapped
 * label and the description under it share one indent, and only where the
 * first line ends can say it did not wrap.
 */
export function optionFromRow(row: ScreenRow, width: number): PendingQuestionOption | null {
	const [first, ...rest] = row.lines.map((line) => line.trim());
	if (first === undefined || first === '') return null;
	if (rest.length === 0) return { label: first, description: '' };
	const nextWord = rest[0]?.split(/\s+/)[0] ?? '';
	if (OPTION_INDENT + cellWidth(first) + 1 + cellWidth(nextWord) > width) return null;
	return { label: first, description: joinWrapped(rest) };
}

type QuestionRead = { ok: true; question: PendingQuestion } | { ok: false; reason: string };

/**
 * A lone question as the screen shows it, for a card with no call to take it
 * from. The question's text is the runtime's when its status message names
 * the same words (hc's `answer: <question> (…)`), which keeps the spaces a
 * wrap lost; else the screen lines joined.
 */
export function questionFromScreen(dialog: QuestionDialog, width: number, statusMessage: string | null): QuestionRead {
	if (dialog.tabs.length !== 1) {
		return { ok: false, reason: 'This question has several parts, and only the one on screen can be read; answer it in the terminal.' };
	}
	const options: PendingQuestionOption[] = [];
	for (const row of dialog.options) {
		const option = optionFromRow(row, width);
		if (!option) return { ok: false, reason: 'The terminal is too narrow to read the options exactly; answer it there.' };
		options.push(option);
	}
	const shown = joinWrapped(dialog.question);
	if (!shown) return { ok: false, reason: 'The question shows no text Gjetr can read.' };
	return {
		ok: true,
		question: {
			question: exactFromStatus(shown, statusMessage) ?? shown,
			header: dialog.tabs[0]?.header ?? '',
			options,
			multiSelect: dialog.multiSelect,
		},
	};
}

/** The question as hc's status message words it, when its words are the screen's; else null. */
function exactFromStatus(shown: string, statusMessage: string | null): string | null {
	const msg = statusMessage?.trim() ?? '';
	if (!msg.startsWith('answer: ')) return null;
	const rest = msg.slice('answer: '.length);
	const want = bare(shown);
	let seen = '';
	for (let i = 0; i < rest.length; i++) {
		const char = rest[i] ?? '';
		if (!/\s/.test(char)) seen += char;
		if (seen === want) return rest.slice(0, i + 1);
		if (!want.startsWith(seen)) return null;
	}
	return null;
}

/** Text without whitespace: what a screen read and the transcript can be compared on. */
export function bare(text: string): string {
	return text.replace(/\s+/g, '');
}

// ---------------------------------------------------------------- what is shown

/** Permission row 2 as the card offers it, or null when it is not offered. */
export function permissionOption2(dialog: PermissionDialog): string | null {
	if (dialog.options.length < 3) return null;
	const label = joinWrapped(dialog.options[1]?.lines ?? []);
	// "Yes, and switch to auto mode" hands every later prompt to auto mode.
	if (!label || /auto mode/i.test(label)) return null;
	return label;
}

/**
 * Whether the plan file's Markdown says what the screen's plan lines say:
 * the same letters and digits, in order. The screen draws the Markdown (no
 * `#`, no backticks, its own bullets and wraps), so markup and spacing cannot
 * be compared; a plan that differs in its words reads as another plan, and
 * the card then shows the screen's lines instead.
 */
export function planAgrees(markdown: string, lines: readonly string[]): boolean {
	const words = (text: string): string => text.replace(/[^\p{L}\p{N}]+/gu, '');
	const shown = words(lines.join('\n'));
	return shown.length > 0 && words(markdown) === shown;
}

// ---------------------------------------------------------------- receipts

/** A result the transcript holds for the card's request, and the turn it is in. */
export interface FoundReceipt {
	receipt: AnswerReceipt;
	turnId: string;
}

/**
 * The transcript's answer to the card's request (ADR-0009 §4): the result of
 * the card's call by its id; for a request read off the screen, the first
 * call the transcript did not hold when the card was built (`known`) that is
 * the same request, with its result. A question's call is written together
 * with its result on 2.1.318; a plan's `ExitPlanMode` always is. Null until
 * there is one. Pure.
 */
export function findReceipt(
	turns: readonly Turn[],
	expectation: ScreenExpectation,
	known: ReadonlySet<string>,
	callKind: CallKind,
): FoundReceipt | null {
	if (expectation.kind === 'trust') return null;
	for (const turn of turns) {
		for (const entry of turn.entries) {
			if (entry.kind !== 'tool' || entry.result === null) continue;
			const text = receiptText(entry, expectation, known, callKind);
			if (text === null) continue;
			return { receipt: { kind: 'result', text, isError: entry.status === 'error' }, turnId: turn.id };
		}
	}
	return null;
}

/** The result's text when `entry` answers the request, with a question's texts as the card has them; else null. */
function receiptText(
	entry: ToolEntry,
	expectation: Exclude<ScreenExpectation, { kind: 'trust' }>,
	known: ReadonlySet<string>,
	callKind: CallKind,
): string | null {
	const result = entry.result ?? '';
	const id = expectation.kind === 'plan' ? null : expectation.toolUseId;
	if (id !== null) return entry.id === id ? result : null;
	if (known.has(entry.id)) return null;
	switch (expectation.kind) {
		case 'question': {
			if (callKind(entry) !== 'question') return null;
			const asked = questionsFromInput(entry.input);
			const mine = expectation.questions;
			if (asked.length !== mine.length || asked.some((q, i) => bare(q.question) !== bare(mine[i]?.question ?? ''))) {
				return null;
			}
			// The card's question may be the screen's words; the result quotes Claude's.
			let text = result;
			asked.forEach((q, i) => {
				text = text.split(`"${q.question}"=`).join(`"${mine[i]?.question ?? q.question}"=`);
			});
			return text;
		}
		case 'permission':
			return entry.name === expectation.tool && callKind(entry) === null && inputAgrees(entry.input, expectation)
				? result
				: null;
		case 'plan':
			return callKind(entry) === 'plan' ? result : null;
	}
}

/** Whether a call's input is the permission the screen showed: the command, or the file. */
export function inputAgrees(
	input: Readonly<Record<string, unknown>>,
	expectation: Extract<ScreenExpectation, { kind: 'permission' }>,
): boolean {
	const field = expectation.tool === 'Bash' ? 'command' : 'file_path';
	const got = input[field];
	const want = expectation.input[field];
	if (typeof got !== 'string' || typeof want !== 'string') return false;
	if (bare(got) === bare(want)) return true;
	const base = expectation.cwd.replace(/\/+$/, '');
	return field === 'file_path' && base !== '' && got.startsWith(`${base}/`) && bare(got.slice(base.length + 1)) === bare(want);
}

/**
 * Whether `call` is the card's own request: the call a request read off the
 * screen is answered by, which may land while the answer runs. Anything else
 * dangling is a newer request, which stops an answer before its next key
 * (ADR-0009 §5).
 */
export function ownCall(call: ToolEntry, expectation: ScreenExpectation, callKind: CallKind): boolean {
	switch (expectation.kind) {
		case 'question':
			if (expectation.toolUseId !== null) return call.id === expectation.toolUseId;
			return (
				callKind(call) === 'question' &&
				questionsFromInput(call.input).every((q, i) => bare(q.question) === bare(expectation.questions[i]?.question ?? ''))
			);
		case 'permission':
			if (expectation.toolUseId !== null) return call.id === expectation.toolUseId;
			return call.name === expectation.tool && inputAgrees(call.input, expectation);
		case 'plan':
			return callKind(call) === 'plan';
		case 'trust':
			return false;
	}
}

/** Every call id the transcript holds: what a request read off the screen is not answered by. */
export function knownCalls(turns: readonly Turn[]): Set<string> {
	const ids = new Set<string>();
	for (const turn of turns) for (const entry of turn.entries) if (entry.kind === 'tool') ids.add(entry.id);
	return ids;
}

// ---------------------------------------------------------------- outcomes

/** What the card says once an answer has run, and what it offers next. */
export interface OutcomeView {
	text: string;
	/** `done` reads as settled; `problem` as something the user must look at. */
	tone: 'done' | 'problem';
	/** The answer may be given again from the card as it is (nothing reached Claude, the card still holds). */
	retry: boolean;
	/** Offer to read the terminal again and rebuild the card. */
	reread: boolean;
}

/** What each outcome of the driver reads as on the card (ADR-0009 §1, §4). */
export function outcomeView(outcome: AnswerOutcome): OutcomeView {
	switch (outcome.kind) {
		case 'answered':
			return { text: 'Claude received your answer.', tone: 'done', retry: false, reread: false };
		case 'moved-on':
			return outcome.final
				? {
						text: 'Sent. The terminal moved on; the conversation has not said yet what Claude received.',
						tone: 'done',
						retry: false,
						reread: false,
					}
				: {
						text: 'The terminal moved on before your answer was complete. Check the terminal for what Claude received.',
						tone: 'problem',
						retry: false,
						reread: true,
					};
		case 'misfire':
			return {
				text: `Claude received something else than you pressed: ${outcome.received}. This cannot be undone.`,
				tone: 'problem',
				retry: false,
				reread: false,
			};
		case 'not-taken':
			if (outcome.mayLand) {
				return {
					text: 'The terminal has not taken the answer yet, and it may still arrive. Check the terminal before you answer again.',
					tone: 'problem',
					retry: false,
					reread: true,
				};
			}
			return {
				text: outcome.final
					? 'The terminal did not take the answer. Answer it in the terminal.'
					: 'The terminal did not take a step of the answer, and Claude has received nothing. Answer it in the terminal.',
				tone: 'problem',
				retry: false,
				reread: true,
			};
		case 'refused':
			return refusedView(outcome);
		case 'cancelled':
			return {
				text: `Stopped before anything was sent: ${outcome.reason}.`,
				tone: 'problem',
				retry: false,
				reread: true,
			};
		case 'busy':
			return {
				text: 'Another answer to this pane is still on its way. Wait for it, then answer again.',
				tone: 'problem',
				retry: true,
				reread: false,
			};
	}
}

function refusedView(outcome: Extract<AnswerOutcome, { kind: 'refused' }>): OutcomeView {
	const moved = outcome.pressed > 0 ? ' Some keys reached it, so its cursor may have moved.' : '';
	switch (outcome.reason) {
		case 'invalid':
			return { text: `This answer cannot be sent: ${outcome.detail}.`, tone: 'problem', retry: true, reread: false };
		case 'mismatch':
		case 'status':
			return { text: `${REFUSAL_TEXT}${moved}`, tone: 'problem', retry: false, reread: true };
		case 'read-failed':
			return {
				text: `Could not read the terminal (${outcome.detail}). Answer it there.${moved}`,
				tone: 'problem',
				retry: false,
				reread: true,
			};
		case 'stuck':
		case 'key-failed':
			return {
				text: `The terminal did not follow the keys (${outcome.detail}). Answer it there.${moved}`,
				tone: 'problem',
				retry: false,
				reread: true,
			};
	}
}
