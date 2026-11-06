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
 * - A titled rule as the screen's last line (`──── create-d-txt-file ─`),
 *   which Claude draws under the dialog once the session has a name (seen
 *   under the Write permission after a plan was approved), is the frame's
 *   bottom, not a line of the dialog, and is dropped. Only there, only with
 *   a lowercase hyphenated name for its title: anywhere else, or with any
 *   other title, it is a line out of place.
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
	type ScreenTab,
	type TrustDialog,
} from '../screenDialog';
import {
	UNKNOWN_SETTINGS_SCREEN,
	type CommandResult,
	type EffortPickerScreen,
	type ModelPickerScreen,
	type PickerRow,
	type PromptScreen,
	type ScreenSettingsReader,
	type SettingsScreen,
	type SwitchModelScreen,
} from '../settingsScreen';
import { isSafeSlug } from './planFile';

const CURSOR = '❯';

/** A rule of `─` across the screen, possibly indented (plan approval's is). */
const RULE = /^ *─{10,}$/;
/** A dotted rule around a permission's command or a plan. */
const DOTTED = /^ *╌{10,}$/;
/** The titled rule under a dialog once the session has a name: `──── create-d-txt-file ─`. */
const TITLED_RULE = /^─{10,} [a-z0-9]+(?:-[a-z0-9]+)* ─$/;

/** Reads the dialog on a visible screen, or `unknown` when it is not wholly one. */
export function parseClaudeScreen(screen: string): ScreenDialog {
	const lines = screen
		.split('\n')
		.map((line) => line.replace(/\s+$/, ''))
		.filter((line) => line !== '');
	if (TITLED_RULE.test(lines[lines.length - 1] ?? '')) lines.pop();
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

// ------------------------------------------------- settings pickers (#169, #170)

/*
 * Claude Code's own settings screens (issues #169, #170): the `/model` and
 * `/effort` pickers, the "Switch model?" confirm, and the prompt with its
 * footer, as 2.1.318 draws them (fixtures `*-model-picker*`,
 * `*-effort-picker*`, `*-switch-model`, `*-footer-*`). A picker sits under a
 * rule of `▔` (which may carry `◐ medium · /effort` near its end) and runs to
 * the last line; the prompt sits between two rules of `─`, with the user's
 * own statusline, whatever it shows, and the footer under it. The facts are
 * in `docs/architecture.md`, "Model, effort, permission mode and context".
 */

/** The rule over a picker: `▔` across, maybe with the effort indicator near its end. */
const PICKER_RULE = /^▔{10,}(?: .* ▔)?$/;
const MODEL_HINT = 'Enter to set as default · s to use this session only · Esc to cancel';
const EFFORT_HINT = '←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel';
/** A model row: cursor or scroll mark, number, then the name and, two spaces on, a description. */
const MODEL_ROW = /^ {3}([❯↑↓ ]) (\d+)\.\s+(\S.*)$/;
/** The tick on the model the session runs now. */
const CURRENT_TICK = ' ✔';
/** The `… +3 models` line under a scrolled list. */
const MORE_MODELS = /^ +… \+\d+ models?$/;
/** The effort row inside the model picker (`◐ Medium effort (default) ←/→ to adjust`). */
const EFFORT_ROW = /^ {3}\S+ .*effort.* ←\/→ to adjust$/;
const SWITCH_ROW = /^ {3}([❯ ]) ([12])\. (\S.*)$/;
const SWITCH_YES = /^Yes, switch to (.+)$/;
const SWITCH_NO = 'No, go back';

/**
 * The footer under the prompt, by mode: `⏸ manual mode on`, `⏵⏵ accept edits
 * on (shift+tab to cycle)`, `⏸ plan mode on …`, `⏵⏵ auto mode on …`; what
 * follows the words (`· ← for agents`) is not read. The bypass wording is
 * Claude's for a session started to allow it, not measured here.
 */
const FOOTER_MODES: readonly (readonly [RegExp, string])[] = [
	[/^ {2}⏸ manual mode on(?: |$)/, 'default'],
	[/^ {2}⏵⏵ accept edits on(?: |$)/, 'acceptEdits'],
	[/^ {2}⏸ plan mode on(?: |$)/, 'plan'],
	[/^ {2}⏵⏵ auto mode on(?: |$)/, 'auto'],
	[/^ {2}⏵⏵ bypass permissions on(?: |$)/, 'bypassPermissions'],
];
/** The most lines a statusline draws between the prompt's lower rule and the footer. */
const MAX_STATUS_LINES = 4;
/** A rule of `─` across the screen, as the prompt is framed. */
const PROMPT_RULE = /^─{10,}$/;

/** Reads Claude's settings pickers, or the prompt with its footer, off a visible screen. */
export function parseClaudeSettingsScreen(screen: string): SettingsScreen {
	const lines = screen
		.split('\n')
		.map((line) => line.replace(/\s+$/, ''))
		.filter((line) => line !== '');
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!PICKER_RULE.test(lines[i] ?? '')) continue;
		const region = lines.slice(i + 1);
		return parseModelPicker(region) ?? parseEffortPicker(region) ?? parseSwitchModel(region) ?? UNKNOWN_SETTINGS_SCREEN;
	}
	// A dialog Claude asks with (a question, a permission, …) is never the prompt.
	if (parseClaudeScreen(screen).kind !== 'unknown') return UNKNOWN_SETTINGS_SCREEN;
	return parsePrompt(lines) ?? UNKNOWN_SETTINGS_SCREEN;
}

function parseModelPicker(region: string[]): ModelPickerScreen | null {
	if (region[0] !== '   Select model') return null;
	let at = 1;
	while (at < region.length && !MODEL_ROW.test(region[at] ?? '')) {
		if (!/^ {3}\S/.test(region[at] ?? '')) return null;
		at++;
	}
	const rows: PickerRow[] = [];
	let cursor: number | null = null;
	let cursors = 0;
	for (; at < region.length; at++) {
		const line = region[at] ?? '';
		const row = MODEL_ROW.exec(line);
		if (!row) break;
		const text = row[3] ?? '';
		const named = text.split(/ {2,}/)[0] ?? '';
		const current = named.endsWith(CURRENT_TICK);
		const label = current ? named.slice(0, -CURRENT_TICK.length) : named;
		const number = Number(row[2]);
		const previous = rows[rows.length - 1];
		if (!label || (previous && number !== previous.number + 1)) return null;
		if (row[1] === CURSOR) {
			cursor = number;
			cursors++;
		}
		rows.push({ number, label, current });
		// A description wraps under its own column, past the name's.
		const column = line.length - text.length + named.length;
		while (at + 1 < region.length && describes(region[at + 1] ?? '', column)) at++;
	}
	if (MORE_MODELS.test(region[at] ?? '')) at++;
	if (EFFORT_ROW.test(region[at] ?? '')) at++;
	const hint = region.slice(at);
	if (hint.length === 0 || !hint.every((line) => /^ {3}\S/.test(line)) || joinWrapped(hint) !== MODEL_HINT) return null;
	if (rows.length < 2 || cursors !== 1 || cursor === null) return null;
	if (rows.filter((row) => row.current).length > 1) return null;
	return { kind: 'model-picker', rows, cursor };
}

/** A line of a description wrapped under a model row: indented past the row's name. */
function describes(line: string, column: number): boolean {
	const indent = line.length - line.trimStart().length;
	return indent > column && !MODEL_ROW.test(line) && !MORE_MODELS.test(line) && !EFFORT_ROW.test(line);
}

function parseEffortPicker(region: string[]): EffortPickerScreen | null {
	if (region[0] !== '   Effort') return null;
	if (!/^ +Faster +Smarter$/.test(region[1] ?? '')) return null;
	const slider = region[2] ?? '';
	if (!/^ +─*▲─*$/.test(slider)) return null;
	const mark = slider.indexOf('▲');
	const levels: Level[] = [];
	for (const match of (region[3] ?? '').matchAll(/\S+/g)) {
		const word = match[0];
		if (!/^[a-z]+$/.test(word)) return null;
		levels.push({ word, start: match.index, end: match.index + word.length - 1 });
	}
	if (levels.length < 2) return null;
	// At most one line saying what the level costs, then the hint.
	let at = 4;
	while (at < region.length && !(region[at] ?? '').startsWith('   ←/→')) at++;
	const hint = region.slice(at);
	if (at > 5 || hint.length === 0 || !hint.every((line) => /^ {3}\S/.test(line)) || joinWrapped(hint) !== EFFORT_HINT) {
		return null;
	}
	return { kind: 'effort-picker', levels: levels.map((level) => level.word), selected: levelUnder(levels, mark) };
}

interface Level {
	word: string;
	start: number;
	end: number;
}

/**
 * The level whose word the slider's mark stands over: within the word, or
 * one column beside it. Two candidates, or none, is no level.
 */
function levelUnder(levels: readonly Level[], mark: number): string | null {
	const near = levels.filter((level) => mark >= level.start - 1 && mark <= level.end + 1);
	return near.length === 1 ? (near[0]?.word ?? null) : null;
}

function parseSwitchModel(region: string[]): SwitchModelScreen | null {
	if (region[0] !== '   Switch model?') return null;
	const body: string[] = [];
	let at = 1;
	while (at < region.length && !SWITCH_ROW.test(region[at] ?? '')) {
		const line = region[at++] ?? '';
		if (!/^ {3}\S/.test(line)) return null;
		body.push(line.trim());
	}
	const one = SWITCH_ROW.exec(region[at] ?? '');
	const two = SWITCH_ROW.exec(region[at + 1] ?? '');
	if (!one || !two || one[2] !== '1' || two[2] !== '2' || region.length !== at + 2) return null;
	const yes = one[3] ?? '';
	const no = two[3] ?? '';
	const target = SWITCH_YES.exec(yes)?.[1] ?? '';
	if (!target || no !== SWITCH_NO || body.length === 0) return null;
	// The body names the model the yes row names.
	if (!joinWrapped(body).includes(`Switching to ${target} `)) return null;
	const onYes = one[1] === CURSOR;
	if (onYes === (two[1] === CURSOR)) return null;
	return { kind: 'switch-model', title: 'Switch model?', body, target, yes, no, cursor: onYes ? 'yes' : 'no' };
}

function parsePrompt(lines: string[]): PromptScreen | null {
	// The prompt's lower rule, with at most the statusline between it and the footer.
	let bottom = -1;
	for (let i = lines.length - 2; i >= Math.max(0, lines.length - 2 - MAX_STATUS_LINES); i--) {
		if (PROMPT_RULE.test(lines[i] ?? '')) {
			bottom = i;
			break;
		}
	}
	if (bottom < 0) return null;
	let top = -1;
	for (let i = bottom - 1; i >= 0; i--) {
		if (PROMPT_RULE.test(lines[i] ?? '')) {
			top = i;
			break;
		}
	}
	if (top < 0 || !(lines[top + 1] ?? '').startsWith(CURSOR)) return null;
	const footer = lines[lines.length - 1] ?? '';
	const mode = FOOTER_MODES.find(([pattern]) => pattern.test(footer))?.[1] ?? null;
	return { kind: 'prompt', mode, last: lastEcho(lines.slice(0, top)) };
}

/**
 * The newest echoed prompt in the history (`❯ /model`) and the `⎿` lines
 * under it, wrapped lines joined.
 */
function lastEcho(history: string[]): PromptScreen['last'] {
	for (let i = history.length - 1; i >= 0; i--) {
		const line = history[i] ?? '';
		if (!line.startsWith(`${CURSOR} `)) continue;
		const out: string[] = [];
		let at = i + 1;
		const first = /^ {2}⎿ {2}(\S.*)$/.exec(history[at] ?? '');
		if (first) {
			out.push(first[1] ?? '');
			at++;
			while (/^ {5}\S/.test(history[at] ?? '')) out.push((history[at++] ?? '').trim());
		}
		return { echo: line.slice(2).trim(), result: out.length ? commandResult(out.join(' ')) : null };
	}
	return null;
}

/** What `/model` or `/effort` printed, in Claude 2.1.318's words; backticks, where drawn, dropped. */
export function commandResult(text: string): CommandResult {
	const plain = text.replace(/`/g, '').trim();
	const model = /^Set model to (.+?) (for this session only|and saved as your default for new sessions)\b/.exec(plain);
	if (model) {
		return { kind: 'model', label: model[1] ?? '', scope: model[2] === 'for this session only' ? 'session' : 'default' };
	}
	const effort = /^Set effort level to ([a-z]+) \((this session only|saved as your default for new sessions)\)/.exec(plain);
	if (effort) {
		return { kind: 'effort', level: effort[1] ?? '', scope: effort[2] === 'this session only' ? 'session' : 'default' };
	}
	const kept = /^Kept model as (.+)$/.exec(plain);
	if (kept) return { kind: 'kept', label: kept[1] ?? '' };
	if (plain === 'Cancelled') return { kind: 'cancelled' };
	return { kind: 'other', text: plain };
}

/** A model's name as the picker shows it (`Sonnet 5.5`): its family, and its version as numbers. */
function modelName(label: string): { family: string; version: number[] } | null {
	const match = /^([A-Za-z]+) (\d+(?:\.\d+)*)$/.exec(label.trim());
	if (!match) return null;
	return { family: (match[1] ?? '').toLowerCase(), version: (match[2] ?? '').split('.').map(Number) };
}

function newer(a: readonly number[], b: readonly number[]): boolean {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return false;
}

/**
 * Claude's settings screens, for the settings driver
 * (`../../native/screenSettings.ts`). A model choice is a family alias
 * (`sonnet`), which Claude takes as that family's newest model, so its row is
 * the one named `<Family> <version>` with the highest version on screen:
 * never "Default (recommended)", and never a row by its place.
 */
export const CLAUDE_SCREEN_SETTINGS: ScreenSettingsReader = {
	parse: parseClaudeSettingsScreen,
	modelCommand: '/model',
	effortCommand: '/effort',
	modelRow(choice, rows) {
		let best: { row: PickerRow; version: number[] } | null = null;
		for (const row of rows) {
			const name = modelName(row.label);
			if (!name || name.family !== choice.value.toLowerCase()) continue;
			if (!best || newer(name.version, best.version)) best = { row, version: name.version };
		}
		return best?.row ?? null;
	},
	isModel: (choice, label) => modelName(label)?.family === choice.value.toLowerCase(),
	sameMode(a, b) {
		const plain = (mode: string): string => (mode === 'manual' ? 'default' : mode);
		return plain(a) === plain(b);
	},
	// Measured on 2.1.318: manual, accept edits, plan, auto, and round again.
	// `dontAsk` is not on it; `bypassPermissions` only for a session started to allow it.
	cycleModes: ['default', 'acceptEdits', 'plan', 'auto'],
};
