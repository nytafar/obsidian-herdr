/**
 * The dialog an agent shows on a pane's visible screen, read as text (issue
 * #163, ADR-0009 §1). An agent's format reads its own dialogs
 * (`AgentFormat.screenDialog`); Claude Code's reader is
 * `./claude/screenDialog.ts`. The answer driver matches what is read here
 * against the request it answers, and presses nothing unless they agree.
 *
 * **Text stays as the screen wrapped it.** A label, a question, a command
 * or a folder is kept as its screen lines, never joined into a guess: a
 * wrapped line lost a space or nothing at all (a path breaks mid-word), and
 * an option's label and its description sit at the same indent, so where one
 * ends is not on the screen. {@link wrappedEquals} compares such lines with
 * the text they should show; {@link joinWrapped} joins them for display only.
 *
 * **Unsure is `unknown`.** A screen that is not wholly one known dialog,
 * from its rule to the last line, parses as `unknown`, never as the nearest
 * fit: a key pressed into the wrong dialog answers it.
 */

/** One tab of a question's tab bar, or the header of a lone question. */
export interface ScreenTab {
	/** The header as shown (`Drink`). */
	header: string;
	/** Whether the tab shows as answered (`☒`) rather than open (`☐`). */
	answered: boolean;
}

/** One numbered row of a list, as the screen shows it. */
export interface ScreenRow {
	/** The number Claude shows before it: what a digit would choose. */
	number: number;
	/**
	 * The row's text, one entry per screen line, trimmed: the label, its
	 * wrapped continuation and, for a question's option, the description under
	 * it. Match with {@link wrappedEquals}.
	 */
	lines: string[];
	/** Multi-select only: whether its box is ticked (`[✔]`); null elsewhere. */
	ticked: boolean | null;
}

/** A question (`AskUserQuestion`), one tab of it. */
export interface QuestionDialog {
	kind: 'question';
	/**
	 * Every tab in the bar, in order, or the lone question's header. Which tab
	 * is current is shown only in colour: match {@link question} instead.
	 */
	tabs: ScreenTab[];
	/** Whether a tab bar with a `Submit` tab is shown (several questions, or multi-select). */
	submitTab: boolean;
	/** The current tab's question, one entry per screen line. */
	question: string[];
	multiSelect: boolean;
	/** The answers offered, in screen order, without the own-answer row. */
	options: ScreenRow[];
	/** The own-answer row ("Type something"). */
	text: {
		number: number;
		/** What is typed there, per screen line; null while it shows its placeholder. */
		lines: string[] | null;
		/** Multi-select only: whether its box is ticked; null elsewhere. */
		ticked: boolean | null;
	};
	/** Multi-select: the unnumbered `Submit` row under the own-answer row. */
	submitRow: boolean;
	/** The number of the "Chat about this" row, under the rule. */
	chat: number;
	/** The row under the cursor: an option's, the own-answer row's or the chat row's number, or the `Submit` row. */
	cursor: number | 'submit';
}

/** The review a question with several tabs, or a multi-select, shows before it sends. */
export interface ReviewDialog {
	kind: 'review';
	tabs: ScreenTab[];
	/** Per question, its text and the answer that will be sent, each per screen line. */
	answers: { question: string[]; answer: string[] }[];
	/** `submit` on "1. Submit answers", `cancel` on "2. Cancel". */
	cursor: 'submit' | 'cancel';
}

/** A tool permission. */
export interface PermissionDialog {
	kind: 'permission';
	/** The dialog's title as shown (`Bash command`, `Create file`, `Edit file`). */
	title: string;
	/** The tool the title names, or null for a title this reader does not know. */
	tool: 'Bash' | 'Write' | 'Edit' | null;
	/** Bash: the command, per screen line; null for other tools. */
	command: string[] | null;
	/**
	 * Write and Edit: the file as shown, per screen line, which is relative to
	 * the session's folder when it is inside it; null for other tools.
	 */
	file: string[] | null;
	/** The lines above the first dotted rule, under the title. */
	header: string[];
	/** The lines between the dotted rules: the command, or the file's content or diff. */
	content: string[];
	/** The question over the options (`Do you want to proceed?`), per screen line. */
	prompt: string[];
	/** The options as shown, numbered from 1. The last is "No", or "No, …" while amending. */
	options: ScreenRow[];
	/** The number of the row under the cursor. */
	cursor: number;
	/** Whether the last row is open for words to Claude (after `tab` on "No"). */
	amending: boolean;
	/** The words typed there, per screen line; null when not amending or still empty. */
	feedback: string[] | null;
}

/** Plan approval ("Ready to code?"). */
export interface PlanDialog {
	kind: 'plan';
	/** The plan as shown between the dotted rules, per screen line. */
	plan: string[];
	/**
	 * The plan file the hint names, as written there (`~/.claude/plans/<slug>.md`),
	 * or null when the hint names none that can be read.
	 */
	planFile: string | null;
	/** The plan file's slug, or null with it. */
	slug: string | null;
	/** Rows 1 and 2 as shown, and row 3 as shown without the `shift+tab` line under it. */
	options: ScreenRow[];
	/** The number of the row under the cursor. */
	cursor: number;
	/** What is typed on row 3, per screen line; null while it shows its placeholder. */
	feedback: string[] | null;
}

/** The workspace trust prompt at startup. */
export interface TrustDialog {
	kind: 'trust';
	/** The folder asked about, per screen line (a path wraps mid-word). */
	folder: string[];
	/** `no` on "No, exit", `yes` on "Yes, I trust this folder". */
	cursor: 'no' | 'yes';
}

/** Anything else: no dialog, a dialog this reader does not know, or one it cannot read whole. */
export interface UnknownDialog {
	kind: 'unknown';
}

export type ScreenDialog = QuestionDialog | ReviewDialog | PermissionDialog | PlanDialog | TrustDialog | UnknownDialog;

export const UNKNOWN_DIALOG: UnknownDialog = Object.freeze({ kind: 'unknown' });

/**
 * Whether `lines`, as the screen wrapped them, show exactly `expected`.
 * Within a line the text must be equal; where one line ends and the next
 * begins, `expected` may have a run of spaces and at most one line break,
 * or nothing (a word or path broken mid-way). Both are trimmed at the ends.
 * An empty `lines` matches only empty text.
 *
 * Whitespace at a wrap point is the one thing the screen cannot tell apart
 * (`a b` and `ab` wrapped there read the same); everything else must agree.
 */
export function wrappedEquals(lines: readonly string[], expected: string): boolean {
	const want = expected.trim();
	let pos = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? '').trim();
		if (!want.startsWith(line, pos)) return false;
		pos += line.length;
		if (i < lines.length - 1) pos = skipWrap(want, pos);
	}
	return pos === want.length;
}

/** Past the whitespace a wrap may have swallowed at `pos`: spaces, at most one line break, spaces. */
function skipWrap(text: string, pos: number): number {
	let at = pos;
	while (text[at] === ' ') at++;
	if (text[at] === '\n') at++;
	while (text[at] === ' ') at++;
	return at;
}

/** Screen lines joined with single spaces, for showing; never for matching. */
export function joinWrapped(lines: readonly string[]): string {
	return lines
		.map((line) => line.trim())
		.filter(Boolean)
		.join(' ');
}
