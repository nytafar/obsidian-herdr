/**
 * The waiting card's request read off a herdr or herdr-core screen (#166,
 * ADR-0009 §1, §3): which requests a recorded screen may be, what the card
 * offers of it, how the transcript's result is found for a request that had
 * no call, and what each outcome of the driver reads as.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeScreen } from '../src/agents/claude/screenDialog';
import { CLAUDE_FORMAT } from '../src/agents/claude/format';
import type { PermissionDialog, PlanDialog, QuestionDialog } from '../src/agents/screenDialog';
import type { ToolEntry, Turn } from '../src/native/conversation';
import { REFUSAL_TEXT, type AnswerOutcome, type ScreenExpectation } from '../src/native/screenAnswer';
import {
	findReceipt,
	inputAgrees,
	knownCalls,
	optionFromRow,
	outcomeView,
	ownCall,
	permissionOption2,
	planAgrees,
	questionFromScreen,
	screenRequests,
	screenWidth,
	type CallKind,
	type ScreenCardContext,
} from '../src/native/screenCard';

const SCREENS = join(__dirname, 'fixtures', 'screens', 'claude-2.1.318');
const raw = (name: string): string => readFileSync(join(SCREENS, `${name}.txt`), 'utf8');

const callKind: CallKind = (call) => CLAUDE_FORMAT.pendingCall(call)?.kind ?? null;

function tool(id: string, name: string, input: Record<string, unknown>, result: string | null = null): ToolEntry {
	return { kind: 'tool', id, name, input, result, status: result === null ? 'running' : 'done', notification: null, report: null };
}

function turnOf(id: string, ...entries: ToolEntry[]): Turn {
	return { id, entries } as unknown as Turn;
}

function context(extra: Partial<ScreenCardContext> = {}): ScreenCardContext {
	return { dangling: null, callKind, cwd: '/tmp/oh-test-ask-herdr', statusMessage: null, ...extra };
}

const DRINK_CALL = tool('toolu_q', 'AskUserQuestion', {
	questions: [
		{
			question: 'Which drink do you want?',
			header: 'Drink',
			options: ['Tea', 'Coffee', 'Water'].map((label) => ({ label, description: label })),
			multiSelect: false,
		},
	],
});

describe('screen card: the requests a screen may be', () => {
	it('reads a lone question off the screen when no call dangles, labels and descriptions apart', () => {
		const screen = raw('herdr-ask-single');
		const got = screenRequests(parseClaudeScreen(screen), screen, context());
		expect(got).toEqual({
			ok: true,
			expectations: [
				{
					kind: 'question',
					toolUseId: null,
					questions: [
						{
							question: 'Which drink do you want?',
							header: 'Drink',
							options: ['Tea', 'Coffee', 'Water'].map((label) => ({ label, description: label })),
							multiSelect: false,
						},
					],
				},
			],
		});
	});

	it('tries the dangling call first, then the screen', () => {
		const screen = raw('herdr-ask-single');
		const got = screenRequests(parseClaudeScreen(screen), screen, context({ dangling: DRINK_CALL }));
		expect(got.ok && got.expectations.map((e) => (e.kind === 'question' ? e.toolUseId : e.kind))).toEqual(['toolu_q', null]);
	});

	it('reads a wrapped question at 60 columns, the label known from where its line ends', () => {
		const screen = raw('herdr-60-ask-single');
		const got = screenRequests(parseClaudeScreen(screen), screen, context());
		expect(got.ok).toBe(true);
		const q = got.ok && got.expectations[0]?.kind === 'question' ? got.expectations[0].questions[0] : null;
		expect(q?.options[0]).toEqual({
			label: 'Tea with milk and a little honey',
			description: 'A mild black tea, served with milk and a spoon of honey on the side',
		});
		expect(q?.question).toBe('Which of these hot drinks would you like me to prepare for the long afternoon meeting today?');
	});

	it('takes the question’s exact words from hc’s status message when they are the screen’s', () => {
		const dialog = parseClaudeScreen(raw('hc-ask-single')) as QuestionDialog;
		const got = questionFromScreen(dialog, 200, 'answer: Which drink do you want? (Tea · Coffee · Water)');
		expect(got.ok && got.question.question).toBe('Which drink do you want?');
		// Words that differ are the screen's own.
		const other = questionFromScreen(dialog, 200, 'answer: Which colour? (Red)');
		expect(other.ok && other.question.question).toBe('Which drink do you want?');
	});

	it('offers no answer to several questions without their call: only one tab is on screen', () => {
		const screen = raw('herdr-ask-two');
		const got = screenRequests(parseClaudeScreen(screen), screen, context());
		expect(got.ok).toBe(false);
		expect(!got.ok && got.reason).toMatch(/several parts/);
	});

	it('offers no answer when a label may have wrapped into its description', () => {
		const row = { number: 1, lines: ['A label long enough to reach the edge', 'and its description'], ticked: null };
		expect(optionFromRow(row, 45)).toBeNull();
		expect(optionFromRow(row, 120)).toEqual({ label: 'A label long enough to reach the edge', description: 'and its description' });
		expect(optionFromRow({ number: 1, lines: ['Solo'], ticked: null }, 10)).toEqual({ label: 'Solo', description: '' });
	});

	it('measures the screen by its rule, else its widest line', () => {
		expect(screenWidth('a long line of text\n────\nx')).toBe(4);
		expect(screenWidth('ab\nxyz')).toBe(3);
	});

	it('reads a Bash permission off the screen, and the call’s when it is the same tool', () => {
		const screen = raw('herdr-bash-permission');
		const dialog = parseClaudeScreen(screen) as PermissionDialog;
		const bash = tool('toolu_b', 'Bash', { command: 'touch one.txt' });
		const got = screenRequests(dialog, screen, context({ dangling: bash }));
		expect(got.ok && got.expectations).toEqual([
			{ kind: 'permission', toolUseId: 'toolu_b', tool: 'Bash', input: { command: 'touch one.txt' }, cwd: '/tmp/oh-test-ask-herdr', content: null },
			{ kind: 'permission', toolUseId: null, tool: 'Bash', input: { command: 'touch one.txt' }, cwd: '/tmp/oh-test-ask-herdr', content: null },
		]);
	});

	it('reads a Write permission’s file off the screen', () => {
		const screen = raw('herdr-write-permission');
		const got = screenRequests(parseClaudeScreen(screen), screen, context());
		expect(got.ok && got.expectations[0]).toMatchObject({ kind: 'permission', toolUseId: null, tool: 'Write', input: { file_path: 'b.txt' } });
	});

	it('reads a plan by its slug, with no lines until the card’s read', () => {
		const screen = raw('hc-plan');
		const got = screenRequests(parseClaudeScreen(screen), screen, context());
		expect(got.ok && got.expectations).toEqual([{ kind: 'plan', slug: 'plan-a-one-step-change-quirky-cosmos', plan: null }]);
	});

	it('offers nothing for a screen with no dialog, or the review of answers given in the terminal', () => {
		expect(screenRequests({ kind: 'unknown' }, '', context()).ok).toBe(false);
		const review = raw('herdr-ask-multi-review');
		expect(screenRequests(parseClaudeScreen(review), review, context()).ok).toBe(false);
	});
});

describe('screen card: what is offered', () => {
	it('offers permission row 2 in Claude’s words, never one that switches to auto mode', () => {
		const bash = parseClaudeScreen(raw('herdr-60-bash-permission')) as PermissionDialog;
		expect(permissionOption2(bash)).toBe('Yes, and always allow access to /tmp/oh-test-narrow-herdr60 from this project');
		const write = parseClaudeScreen(raw('herdr-write-permission')) as PermissionDialog;
		expect(permissionOption2(write)).toMatch(/^Yes, and switch to accept edits/);
		const auto = { ...bash, options: [bash.options[0], { number: 2, lines: ['Yes, and switch to auto mode'], ticked: null }, bash.options[3]] };
		expect(permissionOption2(auto as PermissionDialog)).toBeNull();
	});

	it('shows the plan file only when its words are the screen’s', () => {
		const plan = parseClaudeScreen(raw('hc-plan')) as PlanDialog;
		const file = 'Create `c.txt` in `/tmp/oh-test-ask-hc` containing the single word "plan".\n\n- Verify by reading c.txt back.\n';
		expect(planAgrees(file, plan.plan)).toBe(true);
		expect(planAgrees(file.replace('c.txt', 'd.txt'), plan.plan)).toBe(false);
		expect(planAgrees('', [])).toBe(false);
	});
});

describe('screen card: what the transcript says Claude received', () => {
	const fromScreen: ScreenExpectation = {
		kind: 'question',
		toolUseId: null,
		questions: [{ question: 'Which drink do you want ?', header: 'Drink', options: [], multiSelect: false }],
	};

	it('finds the card’s call by its id', () => {
		const turns = [turnOf('t1', tool('toolu_b', 'Bash', { command: 'ls' }, 'a.txt'))];
		const expectation: ScreenExpectation = { kind: 'permission', toolUseId: 'toolu_b', tool: 'Bash', input: { command: 'ls' }, cwd: '/tmp' };
		expect(findReceipt(turns, expectation, new Set(['toolu_b']), callKind)).toEqual({
			receipt: { kind: 'result', text: 'a.txt', isError: false },
			turnId: 't1',
		});
	});

	it('finds a question read off the screen by a new call with its questions, in the card’s words', () => {
		const answered = tool('toolu_new', 'AskUserQuestion', DRINK_CALL.input, 'The user answered: "Which drink do you want?"="Coffee". Go on.');
		const old = tool('toolu_old', 'AskUserQuestion', DRINK_CALL.input, 'The user answered: "Which drink do you want?"="Tea".');
		const turns = [turnOf('t1', old), turnOf('t2', answered)];
		const found = findReceipt(turns, fromScreen, new Set(['toolu_old']), callKind);
		expect(found?.turnId).toBe('t2');
		expect(found?.receipt).toMatchObject({ text: 'The user answered: "Which drink do you want ?"="Coffee". Go on.' });
	});

	it('finds a permission read off the screen by a new call to that tool with that input', () => {
		const expectation: Extract<ScreenExpectation, { kind: 'permission' }> = {
			kind: 'permission',
			toolUseId: null,
			tool: 'Write',
			input: { file_path: 'b.txt' },
			cwd: '/tmp/x',
		};
		const other = tool('toolu_1', 'Write', { file_path: '/tmp/x/c.txt' }, 'ok');
		const mine = tool('toolu_2', 'Write', { file_path: '/tmp/x/b.txt' }, 'File created');
		const found = findReceipt([turnOf('t1', other, mine)], expectation, new Set(), callKind);
		expect(found?.receipt).toMatchObject({ text: 'File created' });
		expect(inputAgrees({ file_path: '/tmp/x/b.txt' }, expectation)).toBe(true);
		expect(ownCall(mine, expectation, callKind)).toBe(true);
		expect(ownCall(other, expectation, callKind)).toBe(false);
	});

	it('finds a plan’s new ExitPlanMode result, and nothing for trust', () => {
		const plan = tool('toolu_p', 'ExitPlanMode', { plan: 'x' }, 'User has approved your plan.');
		const expectation: ScreenExpectation = { kind: 'plan', slug: 's', plan: ['x'] };
		expect(findReceipt([turnOf('t1', plan)], expectation, new Set(), callKind)?.receipt).toMatchObject({ text: 'User has approved your plan.' });
		expect(findReceipt([turnOf('t1', plan)], expectation, knownCalls([turnOf('t1', plan)]), callKind)).toBeNull();
		expect(findReceipt([], { kind: 'trust', cwd: '/x' }, new Set(), callKind)).toBeNull();
	});

	it('takes a newer question as another request', () => {
		const other = tool('toolu_x', 'AskUserQuestion', { questions: [{ question: 'Which size?', options: [] }] });
		expect(ownCall(other, fromScreen, callKind)).toBe(false);
		expect(ownCall(DRINK_CALL, fromScreen, callKind)).toBe(true);
	});
});

describe('screen card: each outcome on the card', () => {
	const cases: [AnswerOutcome, RegExp, Partial<ReturnType<typeof outcomeView>>][] = [
		[{ kind: 'answered', receipt: { kind: 'started' } }, /received your answer/, { tone: 'done' }],
		[{ kind: 'moved-on', final: true }, /^Sent\./, { tone: 'done' }],
		[{ kind: 'moved-on', final: false }, /before your answer was complete/, { tone: 'problem', reread: true }],
		[
			{ kind: 'misfire', expected: 'allow once', received: 'denied', receipt: { kind: 'started' } },
			/something else than you pressed: denied\. This cannot be undone\./,
			{ tone: 'problem' },
		],
		[{ kind: 'not-taken', final: true, detail: 'x', mayLand: true }, /may still arrive/, { reread: true }],
		[{ kind: 'not-taken', final: true, detail: 'x', mayLand: false }, /did not take the answer/, { reread: true }],
		[{ kind: 'refused', reason: 'mismatch', detail: 'x', pressed: 0 }, new RegExp(`^${REFUSAL_TEXT.replace('.', '\\.')}$`), { retry: false, reread: true }],
		[{ kind: 'refused', reason: 'mismatch', detail: 'x', pressed: 2 }, /cursor may have moved/, {}],
		[{ kind: 'refused', reason: 'invalid', detail: 'the words are empty', pressed: 0 }, /cannot be sent: the words are empty/, { retry: true }],
		[{ kind: 'refused', reason: 'read-failed', detail: 'gone', pressed: 0 }, /Could not read the terminal \(gone\)/, {}],
		[{ kind: 'cancelled', reason: 'Claude is no longer waiting', pressed: 1 }, /Stopped before anything was sent/, {}],
		[{ kind: 'busy' }, /still on its way/, { retry: true }],
	];
	it.each(cases)('%j', (outcome, text, extra) => {
		const view = outcomeView(outcome);
		expect(view.text).toMatch(text);
		expect(view).toMatchObject(extra);
	});
});
