/**
 * Claude Code's dialogs, read off a pane's visible screen (issue #163,
 * ADR-0009 §1): a question, its review, a tool permission, plan approval and
 * the workspace trust prompt, as Claude Code 2.1.318 draws them. The screen
 * is herdr's `pane.read {source: visible, format: text}` or hc's
 * `terminal.read {lines: 0}`; the recorded screens, wide and at 60 and 90
 * columns, are `tests/fixtures/screens/claude-2.1.318/`, and the facts are in
 * `docs/architecture.md`, "Answering Claude's dialogs from the screen".
 *
 * How a screen is read:
 *
 * - A dialog starts under a rule of `─` and runs to the last line of the
 *   screen. The rules are tried from the bottom up, and the first region
 *   that is wholly one dialog, every line accounted for, is the answer.
 *   Anything left over, a line out of place, a second cursor or a row
 *   numbered out of turn makes the region no dialog. A screen whose dialog
 *   is taller than the pane has lost its rule and reads as `unknown`.
 * - Empty rows are dropped first; nothing here depends on them.
 * - Rows are recognised by their shape (cursor column, number, indent), and
 *   their text is kept per screen line (`../screenDialog.ts`). Nothing here
 *   picks a row by position or a label by guess.
 * - Hint lines are only checked for their wording, never read for state:
 *   they lag the cursor (finding `answering-on-screen` §5).
 *
 * Pure: a string in, a {@link ScreenDialog} out.
 */

import {
	joinWrapped,
	UNKNOWN_DIALOG,
	type PermissionDialog,
	type PlanDialog,
	type QuestionDialog,
	type ReviewDialog,
	type ScreenDialog,
	type ScreenRow,
	type ScreenTab,
	type TrustDialog,
} from '../screenDialog';
import { isSafeSlug } from './planFile';

const CURSOR = '❯';

/** A rule of `─` across the screen, possibly indented (plan approval's is). */
const RULE = /^ *─{10,}$/;
/** A dotted rule around a permission's command or a plan. */
const DOTTED = /^ *╌{10,}$/;

/** Reads the dialog on a visible screen, or `unknown` when it is not wholly one. */
export function parseClaudeScreen(screen: string): ScreenDialog {
	const lines = screen
		.split('\n')
		.map((line) => line.replace(/\s+$/, ''))
		.filter((line) => line !== '');
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!RULE.test(lines[i] ?? '')) continue;
		const dialog = parseRegion(lines.slice(i + 1));
		if (dialog) return dialog;
	}
	return UNKNOWN_DIALOG;
}

function parseRegion(region: string[]): ScreenDialog | null {
	const first = region[0];
	if (first === undefined) return null;
	if (first === ' Accessing workspace:') return parseTrust(region);
	if (first === '   Ready to code?') return parsePlan(region);
	if (tabsOf(first)) return region[1] === 'Review your answers' ? parseReview(region) : parseQuestion(region);
	if (/^ \S/.test(first)) return parsePermission(region);
	return null;
}

// ---------------------------------------------------------------- questions

/** The tab bar (`←  ☐ Size  ☒ Lid  ✔ Submit  →`) or a lone question's header (` ☐ Drink`). */
function tabsOf(line: string): { tabs: ScreenTab[]; submitTab: boolean } | null {
	const bar = /^← {2}(.+) {2}✔ Submit {2}→$/.exec(line);
	if (bar) {
		const tabs: ScreenTab[] = [];
		for (const part of (bar[1] ?? '').split(/ {2}/)) {
			const tab = tabOf(part);
			if (!tab) return null;
			tabs.push(tab);
		}
		return { tabs, submitTab: true };
	}
	const lone = /^ (.+)$/.exec(line);
	const tab = lone ? tabOf(lone[1] ?? '') : null;
	return tab ? { tabs: [tab], submitTab: false } : null;
}

function tabOf(part: string): ScreenTab | null {
	const match = /^([☐☒]) (\S.*)$/.exec(part);
	if (!match) return null;
	return { header: match[2] ?? '', answered: match[1] === '☒' };
}

/** A question's numbered row: cursor column, number, then for multi-select a box. */
const QUESTION_ROW = /^([❯ ]) (\d+)\. (\[[ ✔]\] )?(\S.*)$/;
/** Multi-select's unnumbered `Submit` row, exactly: a torn repaint leaves letters after it. */
const SUBMIT_ROW = /^([❯ ]) {4}Submit$/;
const SINGLE_PLACEHOLDER = 'Type something.';
const MULTI_PLACEHOLDER = 'Type something';

interface RawRow {
	number: number;
	cursor: boolean;
	box: string | null;
	lines: string[];
}

function parseQuestion(region: string[]): QuestionDialog | null {
	const head = tabsOf(region[0] ?? '');
	if (!head) return null;
	let at = 1;

	const question: string[] = [];
	for (; at < region.length; at++) {
		const line = region[at] ?? '';
		if (QUESTION_ROW.test(line)) break;
		if (line.startsWith('│ ')) question.push(line.slice(2).trim());
		else if (/^\S/.test(line)) question.push(line.trim());
		else return null;
	}
	if (question.length === 0) return null;

	const rows: RawRow[] = [];
	let submit: { cursor: boolean } | null = null;
	for (; at < region.length; at++) {
		const line = region[at] ?? '';
		if (RULE.test(line)) break;
		const row = QUESTION_ROW.exec(line);
		if (row) {
			if (submit) return null;
			const box = row[3] ?? null;
			const indent = ' '.repeat(line.length - (row[4] ?? '').length);
			rows.push({ number: Number(row[2]), cursor: row[1] === CURSOR, box, lines: [row[4] ?? ''] });
			// Continuations sit at the label's own column.
			while (at + 1 < region.length && continues(region[at + 1] ?? '', indent)) {
				at++;
				rows[rows.length - 1]?.lines.push((region[at] ?? '').trim());
			}
			continue;
		}
		const sub = SUBMIT_ROW.exec(line);
		if (sub && !submit) {
			submit = { cursor: sub[1] === CURSOR };
			continue;
		}
		return null;
	}
	if (!RULE.test(region[at] ?? '')) return null;
	at++;

	const chatLine = /^([❯ ]) (\d+)\. Chat about this$/.exec(region[at] ?? '');
	if (!chatLine) return null;
	at++;
	if (!hintIs(region.slice(at), 'Enter to select · ', 'Esc to cancel')) return null;

	if (!numberedFromOne(rows)) return null;
	const textRow = rows[rows.length - 1];
	if (!textRow || rows.length < 2) return null;
	const chat = Number(chatLine[2]);
	if (chat !== textRow.number + 1) return null;

	const multiSelect = textRow.box !== null;
	if (rows.some((row) => (row.box !== null) !== multiSelect)) return null;
	if (multiSelect !== (submit !== null)) return null;
	// A lone single-choice question has a header, not a bar; a multi-select always a bar.
	if (multiSelect && !head.submitTab) return null;

	const cursors: (number | 'submit')[] = rows.filter((row) => row.cursor).map((row) => row.number);
	if (submit?.cursor) cursors.push('submit');
	if (chatLine[1] === CURSOR) cursors.push(chat);
	const cursor = cursors[0];
	if (cursors.length !== 1 || cursor === undefined) return null;

	const placeholder = multiSelect ? MULTI_PLACEHOLDER : SINGLE_PLACEHOLDER;
	const typed = textRow.lines.length === 1 && textRow.lines[0] === placeholder ? null : textRow.lines;
	return {
		kind: 'question',
		tabs: head.tabs,
		submitTab: head.submitTab,
		question,
		multiSelect,
		options: rows.slice(0, -1).map((row) => ({ number: row.number, lines: row.lines, ticked: tickOf(row.box) })),
		text: { number: textRow.number, lines: typed, ticked: tickOf(textRow.box) },
		submitRow: submit !== null,
		chat,
		cursor,
	};
}

function tickOf(box: string | null): boolean | null {
	return box === null ? null : box.startsWith('[✔]');
}

function parseReview(region: string[]): ReviewDialog | null {
	const head = tabsOf(region[0] ?? '');
	if (!head?.submitTab || region[1] !== 'Review your answers') return null;
	let at = 2;
	const answers: ReviewDialog['answers'] = [];
	while (at < region.length && region[at] !== 'Ready to submit your answers?') {
		// ` ● question` / `   more`, or behind a gutter: ` │ ● question` / ` │   more`.
		// Both were recorded for a wrapped question at 60 columns.
		const line = region[at] ?? '';
		const question: string[] = [];
		if (line.startsWith(' ● ')) {
			question.push(line.slice(3).trim());
			at++;
			while (/^ {3}\S/.test(region[at] ?? '') && !(region[at] ?? '').startsWith('   → ')) {
				question.push((region[at++] ?? '').trim());
			}
		} else if (line.startsWith(' │ ● ')) {
			question.push(line.slice(5).trim());
			at++;
			while (/^ │ {3}\S/.test(region[at] ?? '')) question.push((region[at++] ?? '').slice(4).trim());
		} else return null;
		const arrow = region[at] ?? '';
		if (!arrow.startsWith('   → ')) return null;
		const answer = [arrow.slice(5).trim()];
		at++;
		while (/^ {3}\S/.test(region[at] ?? '') && !(region[at] ?? '').startsWith('   → ')) {
			answer.push((region[at++] ?? '').trim());
		}
		if (answer[0] === '') return null;
		answers.push({ question, answer });
	}
	if (answers.length === 0 || region[at] !== 'Ready to submit your answers?') return null;
	const submit = /^([❯ ]) 1\. Submit answers$/.exec(region[at + 1] ?? '');
	const cancel = /^([❯ ]) 2\. Cancel$/.exec(region[at + 2] ?? '');
	if (!submit || !cancel || region.length !== at + 3) return null;
	const onSubmit = submit[1] === CURSOR;
	if (onSubmit === (cancel[1] === CURSOR)) return null;
	return { kind: 'review', tabs: head.tabs, answers, cursor: onSubmit ? 'submit' : 'cancel' };
}

// -------------------------------------------------------------- permissions

const PERMISSION_ROW = /^ ([❯ ]) (\d+)\. (\S.*)$/;
const TOOLS: Readonly<Record<string, PermissionDialog['tool']>> = {
	'Bash command': 'Bash',
	'Create file': 'Write',
	'Edit file': 'Edit',
};
const AMEND_PLACEHOLDER = 'and tell Claude what to do differently';
/** The hint under the rows: `Tab to amend` goes once the last row is open for words. */
const PERMISSION_HINTS = new Set(['Esc to cancel · Tab to amend', 'Esc to cancel']);

function parsePermission(region: string[]): PermissionDialog | null {
	const title = (region[0] ?? '').trim();
	// The rows come after the last dotted rule; what the rules frame may look like rows.
	let lastDotted = -1;
	region.forEach((line, i) => {
		if (DOTTED.test(line)) lastDotted = i;
	});
	const firstRow = region.findIndex((line, i) => i > lastDotted && PERMISSION_ROW.test(line));
	if (lastDotted < 0 || firstRow < 0) return null;

	const sections: string[][] = [[]];
	for (const line of region.slice(1, firstRow)) {
		if (DOTTED.test(line)) sections.push([]);
		else sections[sections.length - 1]?.push(line);
	}
	// The header, what the dotted rules frame, and the prompt: nothing else.
	if (sections.length !== 3) return null;
	const [headerLines = [], contentLines = [], promptLines = []] = sections;
	if (!headerLines.every((line) => /^ \S/.test(line))) return null;
	if (!promptLines.every((line) => /^ \S/.test(line))) return null;
	const prompt = promptLines.map((line) => line.trim());
	const header = headerLines.map((line) => line.trim());
	if (!/(^| )Do you want to .*\?$/.test(prompt.join(' '))) return null;
	const content = contentLines.map((line) => (line.startsWith(' │ ') ? line.slice(3) : line.slice(1)).trimEnd());

	const rows: RawRow[] = [];
	let at = firstRow;
	for (; at < region.length; at++) {
		const line = region[at] ?? '';
		const row = PERMISSION_ROW.exec(line);
		if (!row) break;
		const indent = ' '.repeat(line.length - (row[3] ?? '').length);
		rows.push({ number: Number(row[2]), cursor: row[1] === CURSOR, box: null, lines: [row[3] ?? ''] });
		while (at + 1 < region.length && continues(region[at + 1] ?? '', indent)) {
			at++;
			rows[rows.length - 1]?.lines.push((region[at] ?? '').trim());
		}
	}
	const hint = region.slice(at);
	if (!hint.every((line) => /^ \S/.test(line)) || !PERMISSION_HINTS.has(joinWrapped(hint))) return null;
	if (!numberedFromOne(rows) || rows.length < 2) return null;
	const cursor = onlyCursor(rows);
	if (cursor === null) return null;

	const last = rows[rows.length - 1];
	if (!last) return null;
	const head = last.lines[0] ?? '';
	let amending = false;
	let feedback: string[] | null = null;
	if (head === 'No' && last.lines.length === 1) {
		amending = false;
	} else if (head.startsWith('No, ')) {
		amending = true;
		const words = [head.slice(4), ...last.lines.slice(1)];
		feedback = words.length === 1 && words[0] === AMEND_PLACEHOLDER ? null : words;
	} else return null;

	const tool = TOOLS[title] ?? null;
	return {
		kind: 'permission',
		title,
		tool,
		command: tool === 'Bash' ? content.filter((line) => line.trim() !== '') : null,
		file: tool === 'Write' || tool === 'Edit' ? header : null,
		header,
		content,
		prompt,
		options: rows.map((row) => ({ number: row.number, lines: row.lines, ticked: null })),
		cursor,
		amending,
		feedback,
	};
}

// ---------------------------------------------------------------------- plan

const PLAN_ROW = /^ {3}([❯ ]) (\d+)\. (\S.*)$/;
const PLAN_PROMPT = 'Claude has written up a plan and is ready to execute. Would you like to proceed?';
const PLAN_LABELS = ['Yes, and use auto mode', 'Yes, manually approve edits'];
const PLAN_PLACEHOLDER = 'Tell Claude what to change';
const PLAN_FEEDBACK_HINT = 'shift+tab to approve with this feedback';

function parsePlan(region: string[]): PlanDialog | null {
	if (region[0] !== '   Ready to code?' || region[1] !== "   Here is Claude's plan:") return null;
	if (!DOTTED.test(region[2] ?? '')) return null;
	let at = 3;
	const plan: string[] = [];
	while (at < region.length && !DOTTED.test(region[at] ?? '')) plan.push((region[at++] ?? '').trim());
	if (!DOTTED.test(region[at] ?? '') || !RULE.test(region[at + 1] ?? '')) return null;
	at += 2;

	const prompt: string[] = [];
	while (at < region.length && !PLAN_ROW.test(region[at] ?? '')) {
		const line = region[at++] ?? '';
		if (!/^ {3}\S/.test(line)) return null;
		prompt.push(line.trim());
	}
	if (prompt.join(' ') !== PLAN_PROMPT) return null;

	const rows: RawRow[] = [];
	for (; at < region.length; at++) {
		const line = region[at] ?? '';
		const row = PLAN_ROW.exec(line);
		if (!row) break;
		const indent = ' '.repeat(line.length - (row[3] ?? '').length);
		rows.push({ number: Number(row[2]), cursor: row[1] === CURSOR, box: null, lines: [row[3] ?? ''] });
		while (at + 1 < region.length && continues(region[at + 1] ?? '', indent)) {
			at++;
			rows[rows.length - 1]?.lines.push((region[at] ?? '').trim());
		}
	}
	if (rows.length !== 3 || !numberedFromOne(rows)) return null;
	const [one, two, three] = rows;
	if (!one || !two || !three) return null;
	if (!sameLines(one.lines, [PLAN_LABELS[0] ?? '']) || !sameLines(two.lines, [PLAN_LABELS[1] ?? ''])) return null;
	// Row 3 ends in its `shift+tab` line, under the placeholder or the words typed.
	if (three.lines.length < 2 || three.lines[three.lines.length - 1] !== PLAN_FEEDBACK_HINT) return null;
	const words = three.lines.slice(0, -1);
	const feedback = words.length === 1 && words[0] === PLAN_PLACEHOLDER ? null : words;
	const cursor = onlyCursor(rows);
	if (cursor === null) return null;

	const hint = region.slice(at);
	if (hint.length === 0 || !hint.every((line) => /^ {3}\S/.test(line))) return null;
	const planFile = planFileOf(hint.map((line) => line.trim()));
	const slug = planFile ? slugOf(planFile) : null;
	return {
		kind: 'plan',
		plan,
		planFile: slug ? planFile : null,
		slug,
		options: [
			{ number: 1, lines: one.lines, ticked: null },
			{ number: 2, lines: two.lines, ticked: null },
			{ number: 3, lines: words, ticked: null },
		],
		cursor,
		feedback,
	};
}

/**
 * The plan file at the end of the hint, `… · ~/.claude/plans/<slug>.md`.
 * A path has no spaces here, so it runs from where it starts to the end of
 * the hint, its lines joined as they are: it wraps mid-word, or after the `·`.
 */
function planFileOf(hint: string[]): string | null {
	for (let i = 0; i < hint.length; i++) {
		const line = hint[i] ?? '';
		const dot = line.lastIndexOf('· ');
		const start = /^[~/]/.test(line) ? 0 : dot >= 0 && /^[~/]/.test(line.slice(dot + 2)) ? dot + 2 : -1;
		if (start < 0) continue;
		const path = [line.slice(start), ...hint.slice(i + 1)].join('');
		return /^\S+\.md$/.test(path) ? path : null;
	}
	return null;
}

function slugOf(path: string): string | null {
	const match = /(?:^|\/)plans\/([^/]+)\.md$/.exec(path);
	const slug = match?.[1] ?? '';
	return isSafeSlug(slug) ? slug : null;
}

// --------------------------------------------------------------------- trust

const TRUST_SAFETY = ' Quick safety check: ';

function parseTrust(region: string[]): TrustDialog | null {
	let at = 1;
	const folder: string[] = [];
	while (at < region.length && !(region[at] ?? '').startsWith(TRUST_SAFETY)) {
		const line = region[at++] ?? '';
		if (!/^ \S/.test(line)) return null;
		folder.push(line.trim());
	}
	if (folder.length === 0 || at >= region.length) return null;
	// The safety text runs to "Security guide"; its wording is not checked.
	while (at < region.length && region[at] !== ' Security guide') {
		if (!/^ \S/.test(region[at] ?? '')) return null;
		at++;
	}
	const no = /^ ([❯ ]) No, exit$/.exec(region[at + 1] ?? '');
	const yes = /^ ([❯ ]) Yes, I trust this folder$/.exec(region[at + 2] ?? '');
	if (!no || !yes) return null;
	if (!hintIs(region.slice(at + 3), ' Enter to confirm · ', 'Esc to cancel')) return null;
	const onNo = no[1] === CURSOR;
	if (onNo === (yes[1] === CURSOR)) return null;
	return { kind: 'trust', folder, cursor: onNo ? 'no' : 'yes' };
}

// ------------------------------------------------------------------- helpers

/** A wrapped line of the row whose text starts at `indent`'s width. */
function continues(line: string, indent: string): boolean {
	return line.startsWith(indent) && line.length > indent.length && line.trim() !== '';
}

/** Rows numbered 1, 2, 3, … with none missing. */
function numberedFromOne(rows: readonly RawRow[]): boolean {
	return rows.every((row, i) => row.number === i + 1);
}

/** The number of the one row under the cursor, or null for none or several. */
function onlyCursor(rows: readonly RawRow[]): number | null {
	const under = rows.filter((row) => row.cursor);
	return under.length === 1 ? (under[0]?.number ?? null) : null;
}

/** A hint, possibly wrapped: its first line starts with `start`, and the whole ends with `end`. */
function hintIs(lines: readonly string[], start: string, end: string): boolean {
	const first = lines[0];
	if (first === undefined || !first.startsWith(start)) return false;
	return joinWrapped(lines).endsWith(end);
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((line, i) => line === b[i]);
}
