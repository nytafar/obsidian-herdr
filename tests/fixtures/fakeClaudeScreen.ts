/**
 * A scripted stand-in for Claude Code 2.1.318's dialogs on a pane, for the
 * answer driver's tests (#165): it draws each dialog the way the recorded
 * screens in `screens/claude-2.1.318/` show it, so the driver reads it
 * through the real parser, and it takes keys the way the spike measured
 * them (finding `answering-on-screen` §3). It records every call, throws on a
 * digit, and writes what Claude would have received.
 *
 * Scripting: `staleReads` returns the screen from before the last key for
 * that many reads; `drop` loses keys; `onKey` changes the dialog under the
 * driver; `next` is what follows an answer; `received` rewrites what Claude
 * gets (a misfire).
 *
 * Also a fake clock: virtual time, advanced only when every promise has
 * settled, so the driver's polling runs in no real time at all.
 */

import type { AnswerClock, AnswerReceipt } from '../../src/native/screenAnswer';
import type { ScreenAccess, ScreenKey } from '../../src/native/screenAccess';

const RULE = '─'.repeat(100);
const DOTS = '╌'.repeat(100);
const REJECTED =
	"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";

export interface SimQuestion {
	question: string;
	header: string;
	options: { label: string; description: string }[];
	multiSelect: boolean;
}

interface TabState {
	cursor: number | 'submit';
	ticks: Set<number>;
	text: string;
	answer: string | null;
}

export type SimDialog =
	| {
			kind: 'question';
			questions: SimQuestion[];
			/** The tab shown; `questions.length` is the review. */
			tab: number;
			tabs: TabState[];
			review: 'submit' | 'cancel';
	  }
	| {
			kind: 'permission';
			tool: 'Bash' | 'Write';
			/** Bash's command, or Write's file as shown. */
			subject: string;
			/** The rows above "No". */
			options: string[];
			cursor: number;
			amending: boolean;
			feedback: string;
	  }
	| { kind: 'plan'; slug: string; cursor: number; feedback: string }
	| { kind: 'trust'; folder: string; cursor: 'no' | 'yes' }
	| { kind: 'composer' };

export function questionDialog(questions: SimQuestion[]): SimDialog {
	return {
		kind: 'question',
		questions,
		tab: 0,
		tabs: questions.map(() => ({ cursor: 1, ticks: new Set<number>(), text: '', answer: null })),
		review: 'submit',
	};
}

export function bashDialog(command: string, folder = '/tmp/oh-test-sim'): SimDialog {
	return {
		kind: 'permission',
		tool: 'Bash',
		subject: command,
		options: [
			'Yes',
			`Yes, and always allow access to ${folder} from this project`,
			'Yes, and switch to auto mode · auto mode handles these prompts for you',
		],
		cursor: 1,
		amending: false,
		feedback: '',
	};
}

export function writeDialog(file: string): SimDialog {
	return {
		kind: 'permission',
		tool: 'Write',
		subject: file,
		options: [
			'Yes',
			'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
		],
		cursor: 1,
		amending: false,
		feedback: '',
	};
}

export function planDialog(slug: string): SimDialog {
	return { kind: 'plan', slug, cursor: 1, feedback: '' };
}

export function trustDialog(folder: string): SimDialog {
	return { kind: 'trust', folder, cursor: 'no' };
}

// ------------------------------------------------------------------ drawing

function draw(dialog: SimDialog): string {
	const top = ['╭─── Claude Code v2.1.318', '', '❯ do the thing', '', '● On it.', ''];
	switch (dialog.kind) {
		case 'composer':
			return [...top, '● Done.', '', RULE, '❯ ', RULE, '  ? for shortcuts', ''].join('\n');
		case 'question':
			return [...top, RULE, ...drawQuestion(dialog), ''].join('\n');
		case 'permission':
			return [...top, RULE, ...drawPermission(dialog), ''].join('\n');
		case 'plan':
			return [...top, ...drawPlan(dialog), ''].join('\n');
		case 'trust':
			return [
				'…/tmp ❯ claude',
				RULE,
				' Accessing workspace:',
				'',
				` ${dialog.folder}`,
				'',
				" Quick safety check: Is this a project you created or one you trust? If not, take a moment to review what's in this folder first.",
				'',
				" Claude Code'll be able to read, edit, and execute files here.",
				'',
				' Security guide',
				'',
				` ${dialog.cursor === 'no' ? '❯' : ' '} No, exit`,
				` ${dialog.cursor === 'yes' ? '❯' : ' '} Yes, I trust this folder`,
				'',
				' Enter to confirm · Esc to cancel',
				'',
			].join('\n');
	}
}

function bar(d: Extract<SimDialog, { kind: 'question' }>): string {
	const tabs = d.questions.map((q, i) => {
		const tab = d.tabs[i] as TabState;
		const answered = q.multiSelect ? tab.ticks.size > 0 : tab.answer !== null;
		return `${answered ? '☒' : '☐'} ${q.header}`;
	});
	return `←  ${tabs.join('  ')}  ✔ Submit  →`;
}

function lone(d: Extract<SimDialog, { kind: 'question' }>): boolean {
	return d.questions.length === 1 && !d.questions[0]?.multiSelect;
}

function drawQuestion(d: Extract<SimDialog, { kind: 'question' }>): string[] {
	const n = d.questions.length;
	if (d.tab === n) {
		const lines = [bar(d), 'Review your answers', ''];
		d.questions.forEach((q, i) => lines.push(` ● ${q.question}`, `   → ${answerOf(q, d.tabs[i] as TabState)}`));
		lines.push('', 'Ready to submit your answers?', '');
		lines.push(`${d.review === 'submit' ? '❯' : ' '} 1. Submit answers`, `${d.review === 'cancel' ? '❯' : ' '} 2. Cancel`);
		return lines;
	}
	const q = d.questions[d.tab] as SimQuestion;
	const tab = d.tabs[d.tab] as TabState;
	const lines = [lone(d) ? ` ☐ ${q.header}` : bar(d), '', q.question, ''];
	const c = (row: number | 'submit'): string => (tab.cursor === row ? '❯' : ' ');
	q.options.forEach((option, i) => {
		const row = i + 1;
		if (q.multiSelect) {
			lines.push(`${c(row)} ${row}. [${tab.ticks.has(row) ? '✔' : ' '}] ${option.label}`);
			lines.push(`         ${option.description}`);
		} else {
			lines.push(`${c(row)} ${row}. ${option.label}`);
			lines.push(`     ${option.description}`);
		}
	});
	const textRow = q.options.length + 1;
	if (q.multiSelect) {
		lines.push(`${c(textRow)} ${textRow}. [${tab.ticks.has(textRow) ? '✔' : ' '}] ${tab.text || 'Type something'}`);
		lines.push(`${c('submit')}    Submit`);
	} else {
		lines.push(`${c(textRow)} ${textRow}. ${tab.text || 'Type something.'}`);
	}
	lines.push(RULE, `${c(textRow + 1)} ${textRow + 1}. Chat about this`, '');
	lines.push(
		n > 1
			? 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'
			: 'Enter to select · ↑/↓ to navigate · Esc to cancel',
	);
	return lines;
}

function drawPermission(d: Extract<SimDialog, { kind: 'permission' }>): string[] {
	const lines =
		d.tool === 'Bash'
			? [' Bash command', '', ' Run the command', DOTS, ` ${d.subject}`, DOTS, ' Do you want to proceed?']
			: [' Create file', ` ${d.subject}`, DOTS, '  1 hi', DOTS, ` Do you want to create ${d.subject}?`];
	const rows = [...d.options, d.amending ? `No, ${d.feedback || 'and tell Claude what to do differently'}` : 'No'];
	rows.forEach((label, i) => lines.push(` ${d.cursor === i + 1 ? '❯' : ' '} ${i + 1}. ${label}`));
	lines.push('', d.amending ? ' Esc to cancel' : ' Esc to cancel · Tab to amend');
	return lines;
}

function drawPlan(d: Extract<SimDialog, { kind: 'plan' }>): string[] {
	const c = (row: number): string => (d.cursor === row ? '❯' : ' ');
	return [
		`  ${RULE}`,
		'   Ready to code?',
		'',
		"   Here is Claude's plan:",
		`  ${DOTS}`,
		'   Step: write c.txt.',
		`  ${DOTS}`,
		`  ${RULE}`,
		'',
		'   Claude has written up a plan and is ready to execute. Would you like to proceed?',
		'',
		`   ${c(1)} 1. Yes, and use auto mode`,
		`   ${c(2)} 2. Yes, manually approve edits`,
		`   ${c(3)} 3. ${d.feedback || 'Tell Claude what to change'}`,
		'        shift+tab to approve with this feedback',
		'',
		`   ctrl+g to edit in nvim · ~/.claude/plans/${d.slug}.md`,
	];
}

function answerOf(q: SimQuestion, tab: TabState): string {
	if (!q.multiSelect) return tab.answer ?? '';
	const parts = q.options.flatMap((option, i) => (tab.ticks.has(i + 1) ? [option.label] : []));
	if (tab.text) parts.push(tab.text.includes(',') ? `"${tab.text}"` : tab.text);
	return parts.join(', ');
}

// -------------------------------------------------------------------- keys

export type SimCall = { key: ScreenKey } | { text: string };

export interface SimOptions {
	/** Reads after each key that still return the screen from before it. */
	staleReads?: number;
	/** Keys that are lost: the call succeeds and nothing happens. */
	drop?: (key: ScreenKey, sim: FakeClaudeScreen) => boolean;
	/** Runs after each key or text took effect; may replace the dialog. */
	onKey?: (call: SimCall, sim: FakeClaudeScreen) => void;
	/** What follows an answer; the composer by default. */
	next?: (received: AnswerReceipt) => SimDialog;
	/** Rewrites what Claude receives: a misfire. */
	received?: (receipt: AnswerReceipt) => AnswerReceipt;
	/** Reads fail. */
	failReads?: boolean;
}

export class FakeClaudeScreen implements ScreenAccess {
	readonly calls: SimCall[] = [];
	readonly received: AnswerReceipt[] = [];
	reads = 0;
	private stale: string | null = null;
	private staleLeft = 0;
	private waiters: ((receipt: AnswerReceipt) => void)[] = [];

	constructor(
		public dialog: SimDialog,
		private readonly options: SimOptions = {},
	) {}

	/** The keys pressed, in order; text as `text:<words>`. */
	get keys(): string[] {
		return this.calls.map((call) => ('key' in call ? call.key : `text:${call.text}`));
	}

	read(): Promise<string> {
		this.reads++;
		if (this.options.failReads) return Promise.reject(new Error('read failed'));
		if (this.stale !== null && this.staleLeft > 0) {
			this.staleLeft--;
			return Promise.resolve(this.stale);
		}
		return Promise.resolve(draw(this.dialog));
	}

	press(_paneId: string, key: ScreenKey): Promise<void> {
		if (/^\d$/.test(key)) throw new Error(`digit ${key} pressed`);
		this.calls.push({ key });
		this.beforeChange();
		if (!this.options.drop?.(key, this)) this.key(key);
		this.options.onKey?.({ key }, this);
		return Promise.resolve();
	}

	type(_paneId: string, text: string): Promise<void> {
		this.calls.push({ text });
		this.beforeChange();
		this.text(text);
		this.options.onKey?.({ text }, this);
		return Promise.resolve();
	}

	/** Resolves with what Claude received for the answer; at once when it already has. */
	receipt = (signal: AbortSignal): Promise<AnswerReceipt> =>
		new Promise((resolve) => {
			const now = this.received[0];
			if (now) return resolve(now);
			this.waiters.push(resolve);
			signal.addEventListener('abort', () => (this.waiters = this.waiters.filter((w) => w !== resolve)));
		});

	private beforeChange(): void {
		if (this.options.staleReads) {
			this.stale = draw(this.dialog);
			this.staleLeft = this.options.staleReads;
		}
	}

	private send(receipt: AnswerReceipt): void {
		const got = this.options.received ? this.options.received(receipt) : receipt;
		this.received.push(got);
		this.dialog = this.options.next ? this.options.next(got) : { kind: 'composer' };
		for (const waiter of this.waiters.splice(0)) waiter(got);
	}

	private text(text: string): void {
		const d = this.dialog;
		if (d.kind === 'question' && d.tab < d.questions.length) {
			const q = d.questions[d.tab] as SimQuestion;
			const tab = d.tabs[d.tab] as TabState;
			const textRow = q.options.length + 1;
			if (tab.cursor !== textRow) return; // ignored off the text row
			tab.text += text;
			if (q.multiSelect) tab.ticks.add(textRow);
		} else if (d.kind === 'permission' && d.amending) {
			d.feedback += text;
		} else if (d.kind === 'plan' && d.cursor === 3) {
			d.feedback += text;
		}
	}

	private key(key: ScreenKey): void {
		const d = this.dialog;
		if (key === 'shift+tab') throw new Error('shift+tab approves with auto mode');
		switch (d.kind) {
			case 'question':
				return this.questionKey(d, key);
			case 'permission':
				return this.permissionKey(d, key);
			case 'plan':
				return this.planKey(d, key);
			case 'trust':
				if (key === 'down') d.cursor = 'yes';
				if (key === 'up') d.cursor = 'no';
				if (key === 'enter') this.send(d.cursor === 'yes' ? { kind: 'started' } : { kind: 'exited' });
				if (key === 'esc') this.send({ kind: 'exited' });
				return;
			case 'composer':
				return;
		}
	}

	private questionKey(d: Extract<SimDialog, { kind: 'question' }>, key: ScreenKey): void {
		const n = d.questions.length;
		if (key === 'esc') return this.send({ kind: 'result', text: REJECTED, isError: true });
		if ((key === 'left' || key === 'right') && !lone(d)) {
			// On the own-answer row the arrows move within the words.
			const onText = d.tab < n && d.tabs[d.tab]?.cursor === (d.questions[d.tab]?.options.length ?? 0) + 1;
			if (!onText) d.tab = Math.max(0, Math.min(n, d.tab + (key === 'right' ? 1 : -1)));
			return;
		}
		if (d.tab === n) {
			if (key === 'up') d.review = 'submit';
			if (key === 'down') d.review = 'cancel';
			if (key === 'enter' && d.review === 'submit') this.submit(d);
			if (key === 'enter' && d.review === 'cancel') d.tab = 0;
			return;
		}
		const q = d.questions[d.tab] as SimQuestion;
		const tab = d.tabs[d.tab] as TabState;
		const textRow = q.options.length + 1;
		const order: (number | 'submit')[] = [...q.options.map((_, i) => i + 1), textRow];
		if (q.multiSelect) order.push('submit');
		order.push(textRow + 1);
		const at = order.indexOf(tab.cursor);
		if (key === 'down') tab.cursor = order[Math.min(order.length - 1, at + 1)] ?? tab.cursor;
		if (key === 'up') tab.cursor = order[Math.max(0, at - 1)] ?? tab.cursor;
		if (key === 'ctrl+u' && tab.cursor === textRow) {
			tab.text = '';
			tab.ticks.delete(textRow);
		}
		if (key !== 'enter') return;
		if (q.multiSelect) {
			if (tab.cursor === 'submit') d.tab = n;
			else if (typeof tab.cursor === 'number' && tab.cursor <= q.options.length) {
				if (tab.ticks.has(tab.cursor)) tab.ticks.delete(tab.cursor);
				else tab.ticks.add(tab.cursor);
			}
			return;
		}
		if (tab.cursor === textRow + 1) return;
		if (tab.cursor === textRow && !tab.text) return;
		tab.answer = tab.cursor === textRow ? tab.text : (q.options[(tab.cursor as number) - 1]?.label ?? '');
		if (lone(d)) return this.submit(d);
		d.tab++;
	}

	private submit(d: Extract<SimDialog, { kind: 'question' }>): void {
		const answers: Record<string, string> = {};
		d.questions.forEach((q, i) => (answers[q.question] = answerOf(q, d.tabs[i] as TabState)));
		const pairs = Object.entries(answers)
			.map(([q, a]) => `"${q}"="${a}"`)
			.join(', ');
		this.send({
			kind: 'result',
			text: `Your questions have been answered: ${pairs}. You can now continue with these answers in mind.`,
			isError: false,
		});
	}

	private permissionKey(d: Extract<SimDialog, { kind: 'permission' }>, key: ScreenKey): void {
		const last = d.options.length + 1;
		if (key === 'down') d.cursor = Math.min(last, d.cursor + 1);
		if (key === 'up') d.cursor = Math.max(1, d.cursor - 1);
		if (key === 'tab' && d.cursor === last) d.amending = true;
		if (key === 'ctrl+u' && d.amending) d.feedback = '';
		if (key === 'esc') this.send({ kind: 'result', text: `${REJECTED} STOP what you are doing.`, isError: true });
		if (key !== 'enter') return;
		if (d.cursor < last) {
			this.send({ kind: 'result', text: '(Bash completed with no output)', isError: false });
		} else if (!d.amending) {
			this.send({ kind: 'result', text: `${REJECTED} STOP what you are doing.`, isError: true });
		} else if (d.feedback) {
			this.send({
				kind: 'result',
				text: `${REJECTED} To tell you how to proceed, the user said:\n${d.feedback}\n\nNote: …`,
				isError: true,
			});
		}
	}

	private planKey(d: Extract<SimDialog, { kind: 'plan' }>, key: ScreenKey): void {
		if (key === 'down') d.cursor = Math.min(3, d.cursor + 1);
		if (key === 'up') d.cursor = Math.max(1, d.cursor - 1);
		if (key === 'ctrl+u' && d.cursor === 3) d.feedback = '';
		if (key === 'esc') this.send({ kind: 'result', text: `${REJECTED} STOP.`, isError: true });
		if (key !== 'enter') return;
		if (d.cursor < 3) {
			this.send({ kind: 'result', text: 'User has approved your plan. You can now start coding.', isError: false });
		} else if (d.feedback) {
			this.send({
				kind: 'result',
				text: `${REJECTED} To tell you how to proceed, the user said:\n${d.feedback}\n\nNote: …`,
				isError: true,
			});
		}
	}
}

// -------------------------------------------------------------------- clock

/**
 * Virtual time. `sleep` parks until {@link FakeClock.run} advances to it,
 * which it does only once every pending promise has settled.
 */
export class FakeClock implements AnswerClock {
	private time = 0;
	private timers: { at: number; seq: number; resolve: () => void }[] = [];
	private seq = 0;

	now(): number {
		return this.time;
	}

	sleep(ms: number): Promise<void> {
		return new Promise((resolve) => this.timers.push({ at: this.time + ms, seq: this.seq++, resolve }));
	}

	/** Advances virtual time, timer by timer, until `promise` settles. */
	async run<T>(promise: Promise<T>): Promise<T> {
		let settled = false;
		const watched = promise.finally(() => (settled = true));
		for (let i = 0; i < 100_000; i++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (settled) return watched;
			this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
			const next = this.timers.shift();
			if (!next) throw new Error('nothing left to wait for, and the run has not ended');
			this.time = Math.max(this.time, next.at);
			next.resolve();
		}
		throw new Error('the run did not end');
	}
}
