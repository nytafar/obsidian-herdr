/**
 * The answer driver (#165, ADR-0009 §1–5), against a scripted fake screen
 * (`fixtures/fakeClaudeScreen.ts`) read through the real parser, and its
 * pure checks against the recorded screens of Claude Code 2.1.318.
 *
 * What every run here must hold: no digit is ever pressed, the answer's
 * final key is pressed once and never again, and a screen that is not the
 * request gets no key at all.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeScreen } from '../src/agents/claude/screenDialog';
import {
	answerIssue,
	expectedAnswer,
	matchScreen,
	receiptAgrees,
	ScreenAnswerer,
	statusAgrees,
	type AnswerOutcome,
	type AnswerReceipt,
	type AnswerRequest,
	type ScreenAnswer,
	type ScreenExpectation,
} from '../src/native/screenAnswer';
import {
	bashDialog,
	FakeClaudeScreen,
	FakeClock,
	planDialog,
	questionDialog,
	trustDialog,
	writeDialog,
	type SimDialog,
	type SimOptions,
	type SimQuestion,
} from './fixtures/fakeClaudeScreen';

const SCREENS = join(__dirname, 'fixtures', 'screens', 'claude-2.1.318');
const parseFixture = (name: string) => parseClaudeScreen(readFileSync(join(SCREENS, name), 'utf8'));

const DRINK: SimQuestion = {
	question: 'Which drink do you want?',
	header: 'Drink',
	options: [
		{ label: 'Tea', description: 'Tea' },
		{ label: 'Coffee', description: 'Coffee' },
		{ label: 'Water', description: 'Water' },
	],
	multiSelect: false,
};
const FRUIT: SimQuestion = {
	question: 'Which fruits do you like?',
	header: 'Fruit',
	options: ['Apple', 'Banana', 'Cherry', 'Durian'].map((label) => ({ label, description: label })),
	multiSelect: true,
};
const SIZE: SimQuestion = {
	question: 'Which size?',
	header: 'Size',
	options: ['Small', 'Large'].map((label) => ({ label, description: label })),
	multiSelect: false,
};
const LID: SimQuestion = {
	question: 'Which lid?',
	header: 'Lid',
	options: ['Yes', 'No'].map((label) => ({ label, description: label })),
	multiSelect: false,
};

function asked(...questions: SimQuestion[]): ScreenExpectation {
	return { kind: 'question', toolUseId: 'toolu_q', questions };
}

function bash(command: string): ScreenExpectation {
	return { kind: 'permission', toolUseId: 'toolu_b', tool: 'Bash', input: { command }, cwd: '/tmp/oh-test-sim' };
}

const PLAN: ScreenExpectation = { kind: 'plan', slug: 'tidy-unicorn' };
const TRUST: ScreenExpectation = { kind: 'trust', cwd: '/var/tmp/oh-test-trust' };
const OPTION_2 = 'Yes, and always allow access to /tmp/oh-test-sim from this project';

interface Setup {
	sim: FakeClaudeScreen;
	clock: FakeClock;
	driver: ScreenAnswerer;
}

function setup(dialog: SimDialog, options: SimOptions = {}): Setup {
	const sim = new FakeClaudeScreen(dialog, options);
	const clock = new FakeClock();
	const driver = new ScreenAnswerer({ screen: sim, parse: parseClaudeScreen, clock });
	return { sim, clock, driver };
}

async function answer(
	s: Setup,
	expectation: ScreenExpectation,
	given: ScreenAnswer,
	extra: Partial<AnswerRequest> = {},
): Promise<AnswerOutcome> {
	const run = s.driver.answer({ paneId: 'p1', expectation, answer: given, receipt: s.sim.receipt, ...extra });
	return s.clock.run(run.done);
}

/** The text of what Claude received first. */
function receivedText(s: Setup): string {
	const got = s.sim.received[0];
	return got?.kind === 'result' ? got.text : '';
}

/** The keys and the final one alone at the end; no key after the answer went. */
function finalOnce(s: Setup, key: string): void {
	expect(s.sim.keys.filter((k) => k === key).length).toBeGreaterThan(0);
	expect(s.sim.keys[s.sim.keys.length - 1]).toBe(key);
}

describe('answer driver: each dialog, the keys it takes', () => {
	it('answers a single choice by moving to it and one enter', async () => {
		const s = setup(questionDialog([DRINK]));
		const out = await answer(s, asked(DRINK), { kind: 'questions', picks: [{ options: ['Coffee'], text: '' }] });
		expect(out.kind).toBe('answered');
		expect(s.sim.keys).toEqual(['down', 'enter']);
		expect(receivedText(s)).toContain('"Which drink do you want?"="Coffee"');
	});

	it('answers a single choice with the user’s own words on the text row', async () => {
		const s = setup(questionDialog([DRINK]));
		const out = await answer(s, asked(DRINK), {
			kind: 'questions',
			picks: [{ options: [], text: 'Light blue, please' }],
		});
		expect(out.kind).toBe('answered');
		expect(s.sim.keys).toEqual(['down', 'down', 'down', 'text:Light blue, please', 'enter']);
	});

	it('ticks a multi-select, types its own answer, opens the review with right and submits there', async () => {
		const s = setup(questionDialog([FRUIT]));
		const out = await answer(s, asked(FRUIT), {
			kind: 'questions',
			picks: [{ options: ['Apple', 'Cherry'], text: 'Mango, Ripe 2' }],
		});
		expect(out.kind).toBe('answered');
		// Up off the text row before right (there it moves within the words), never down onto Submit.
		expect(s.sim.keys).toEqual(['enter', 'down', 'down', 'enter', 'down', 'down', 'text:Mango, Ripe 2', 'up', 'right', 'enter']);
		expect(receivedText(s)).toContain('"Which fruits do you like?"="Apple, Cherry, "Mango, Ripe 2""');
	});

	it('answers several questions tab by tab and submits on the review', async () => {
		const s = setup(questionDialog([SIZE, LID]));
		const out = await answer(s, asked(SIZE, LID), {
			kind: 'questions',
			picks: [
				{ options: ['Large'], text: '' },
				{ options: ['Yes'], text: '' },
			],
		});
		expect(out.kind).toBe('answered');
		expect(s.sim.keys).toEqual(['down', 'enter', 'enter', 'enter']);
	});

	it('cancels a question with esc', async () => {
		const s = setup(questionDialog([DRINK]));
		const out = await answer(s, asked(DRINK), { kind: 'cancel-question' });
		expect(out.kind).toBe('answered');
		expect(s.sim.keys).toEqual(['esc']);
	});

	it('allows a Bash command once with enter on "Yes"', async () => {
		const s = setup(bashDialog('touch one.txt'));
		const out = await answer(s, bash('touch one.txt'), { kind: 'allow' });
		expect(out.kind).toBe('answered');
		expect(s.sim.keys).toEqual(['enter']);
	});

	it('chooses option 2 only when it reads what the card showed', async () => {
		const s = setup(bashDialog('touch one.txt'));
		const out = await answer(s, bash('touch one.txt'), { kind: 'allow-option-2', label: OPTION_2 });
		expect(out.kind).toBe('answered');
		expect(s.sim.keys).toEqual(['down', 'enter']);

		const other = setup(bashDialog('touch one.txt'));
		const refused = await answer(other, bash('touch one.txt'), {
			kind: 'allow-option-2',
			label: 'Yes, and don’t ask again for: touch *',
		});
		expect(refused).toMatchObject({ kind: 'refused', reason: 'mismatch', pressed: 0 });
		expect(other.sim.keys).toEqual([]);
	});

	it('denies with esc', async () => {
		const s = setup(bashDialog('touch one.txt'));
		const out = await answer(s, bash('touch one.txt'), { kind: 'deny' });
		expect(out.kind).toBe('answered');
		expect(s.sim.keys).toEqual(['esc']);
	});

	it('denies with feedback: No, tab, the words, enter', async () => {
		const s = setup(bashDialog('touch one.txt'));
		const out = await answer(s, bash('touch one.txt'), { kind: 'deny-with-feedback', feedback: 'use mkdir instead' });
		expect(out.kind).toBe('answered');
		expect(s.sim.keys).toEqual(['down', 'down', 'down', 'tab', 'text:use mkdir instead', 'enter']);
	});

	it('allows a Write named relative to the session’s folder', async () => {
		const s = setup(writeDialog('b.txt'));
		const expectation: ScreenExpectation = {
			kind: 'permission',
			toolUseId: 'toolu_w',
			tool: 'Write',
			input: { file_path: '/tmp/oh-test-sim/b.txt' },
			cwd: '/tmp/oh-test-sim',
		};
		expect((await answer(s, expectation, { kind: 'allow' })).kind).toBe('answered');
		expect(s.sim.keys).toEqual(['enter']);
	});

	it('approves a plan with manual edits on row 2, never shift+tab', async () => {
		const s = setup(planDialog('tidy-unicorn'));
		const out = await answer(s, PLAN, { kind: 'approve-plan', mode: 'manual' });
		expect(out.kind).toBe('answered');
		expect(s.sim.keys).toEqual(['down', 'enter']);
	});

	it('rejects a plan with feedback on row 3', async () => {
		const s = setup(planDialog('tidy-unicorn'));
		const out = await answer(s, PLAN, { kind: 'reject-plan', feedback: 'name it d.txt instead' });
		expect(out.kind).toBe('answered');
		expect(s.sim.keys).toEqual(['down', 'down', 'text:name it d.txt instead', 'enter']);
	});

	it('trusts a folder with down and enter, never a bare enter', async () => {
		const s = setup(trustDialog('/var/tmp/oh-test-trust'));
		const out = await answer(s, TRUST, { kind: 'trust' });
		expect(out).toEqual({ kind: 'answered', receipt: { kind: 'started' } });
		expect(s.sim.keys).toEqual(['down', 'enter']);
	});
});

describe('answer driver: a screen that is not the request gets no key', () => {
	it('refuses another command, and sends nothing', async () => {
		const s = setup(bashDialog('rm -rf build'));
		const out = await answer(s, bash('touch one.txt'), { kind: 'allow' });
		expect(out).toMatchObject({ kind: 'refused', reason: 'mismatch', pressed: 0 });
		expect(s.sim.keys).toEqual([]);
	});

	it('refuses a permission where a question was asked', async () => {
		const s = setup(bashDialog('touch one.txt'));
		const out = await answer(s, asked(DRINK), { kind: 'questions', picks: [{ options: ['Tea'], text: '' }] });
		expect(out).toMatchObject({ kind: 'refused', reason: 'mismatch' });
		expect(s.sim.keys).toEqual([]);
	});

	it('refuses a question whose options differ from the call’s', async () => {
		const s = setup(questionDialog([{ ...DRINK, options: DRINK.options.slice(0, 2) }]));
		const out = await answer(s, asked(DRINK), { kind: 'questions', picks: [{ options: ['Tea'], text: '' }] });
		expect(out).toMatchObject({ kind: 'refused', reason: 'mismatch' });
		expect(s.sim.keys).toEqual([]);
	});

	it('refuses the composer, an unreadable screen and a failing read', async () => {
		const composer = setup({ kind: 'composer' });
		expect(await answer(composer, bash('touch one.txt'), { kind: 'allow' })).toMatchObject({
			kind: 'refused',
			reason: 'mismatch',
		});
		const failing = setup(bashDialog('touch one.txt'), { failReads: true });
		expect(await answer(failing, bash('touch one.txt'), { kind: 'allow' })).toMatchObject({
			kind: 'refused',
			reason: 'read-failed',
		});
		expect([...composer.sim.keys, ...failing.sim.keys]).toEqual([]);
	});

	it('refuses when the runtime’s status names another request', async () => {
		const s = setup(bashDialog('touch one.txt'));
		const out = await answer(s, bash('touch one.txt'), { kind: 'allow' }, { statusMessage: () => 'approve Bash: rm x' });
		expect(out).toMatchObject({ kind: 'refused', reason: 'status', pressed: 0 });
		expect(s.sim.keys).toEqual([]);
	});

	it('refuses a plan with another slug and a trust prompt for another folder', async () => {
		const plan = setup(planDialog('other-plan'));
		expect(await answer(plan, PLAN, { kind: 'approve-plan', mode: 'manual' })).toMatchObject({ kind: 'refused' });
		const trust = setup(trustDialog('/home/someone'));
		expect(await answer(trust, TRUST, { kind: 'trust' })).toMatchObject({ kind: 'refused' });
		expect([...plan.sim.keys, ...trust.sim.keys]).toEqual([]);
	});

	it('refuses an answer that does not fit, before reading', async () => {
		const s = setup(questionDialog([DRINK]));
		const two = await answer(s, asked(DRINK), { kind: 'questions', picks: [{ options: ['Tea', 'Coffee'], text: '' }] });
		expect(two).toMatchObject({ kind: 'refused', reason: 'invalid' });
		const line = await answer(s, asked(DRINK), { kind: 'questions', picks: [{ options: [], text: 'a\nb' }] });
		expect(line).toMatchObject({ kind: 'refused', reason: 'invalid' });
		const wrong = await answer(s, asked(DRINK), { kind: 'allow' });
		expect(wrong).toMatchObject({ kind: 'refused', reason: 'invalid' });
		expect(s.sim.reads).toBe(0);
	});
});

describe('answer driver: when the screen changes under it', () => {
	it('refuses, with no commit, when the dialog changes between the moves and the commit', async () => {
		const s = setup(bashDialog('touch one.txt'), {
			onKey: (call, sim) => {
				if (!('key' in call) || call.key !== 'down') return;
				// Another command, its cursor where the move put the old one.
				const other = bashDialog('rm -rf /tmp/x');
				if (other.kind === 'permission') other.cursor = 2;
				sim.dialog = other;
			},
		});
		const out = await answer(s, bash('touch one.txt'), { kind: 'allow-option-2', label: OPTION_2 });
		expect(out).toMatchObject({ kind: 'refused', reason: 'mismatch', pressed: 1 });
		expect(s.sim.keys).toEqual(['down']);
	});

	it('waits out stale reads without pressing more, and commits on the fresh one', async () => {
		const s = setup(questionDialog([DRINK]), { staleReads: 3 });
		const out = await answer(s, asked(DRINK), { kind: 'questions', picks: [{ options: ['Water'], text: '' }] });
		expect(out.kind).toBe('answered');
		expect(s.sim.keys).toEqual(['down', 'down', 'enter']);
		expect(receivedText(s)).toContain('"Which drink do you want?"="Water"');
	});

	it('does not toggle twice when a stale read still shows the box empty', async () => {
		const s = setup(questionDialog([FRUIT]), { staleReads: 2 });
		const out = await answer(s, asked(FRUIT), { kind: 'questions', picks: [{ options: ['Apple', 'Cherry'], text: '' }] });
		expect(out.kind).toBe('answered');
		expect(s.sim.keys).toEqual(['enter', 'down', 'down', 'enter', 'right', 'enter']);
		expect(receivedText(s)).toContain('="Apple, Cherry"');
	});

	it('hands a tab’s answer that cleared the whole dialog to the transcript, as sent', async () => {
		const s = setup(questionDialog([SIZE, LID]), {
			onKey: (call, sim) => {
				if ('key' in call && call.key === 'enter') sim.dialog = { kind: 'composer' };
			},
		});
		const picks = [
			{ options: ['Large'], text: '' },
			{ options: ['Yes'], text: '' },
		];
		const out = await answer(s, asked(SIZE, LID), { kind: 'questions', picks }, { receipt: undefined });
		expect(out).toEqual({ kind: 'moved-on' });
		expect(s.sim.keys).toEqual(['down', 'enter']);
	});

	it('does not repeat a move that never shows', async () => {
		const s = setup(questionDialog([DRINK]), { drop: (key) => key === 'down' });
		const out = await answer(s, asked(DRINK), { kind: 'questions', picks: [{ options: ['Coffee'], text: '' }] });
		expect(out).toMatchObject({ kind: 'refused', reason: 'stuck', pressed: 1 });
		expect(s.sim.keys).toEqual(['down']);
	});

	it('does not repeat a toggle that never shows', async () => {
		const s = setup(questionDialog([FRUIT]), { drop: (key) => key === 'enter' });
		const out = await answer(s, asked(FRUIT), { kind: 'questions', picks: [{ options: ['Apple'], text: '' }] });
		expect(out).toMatchObject({ kind: 'not-taken', final: false });
		expect(s.sim.keys).toEqual(['enter']);
	});

	it('takes an identical next dialog for the key not taking, and never sends it again', async () => {
		const s = setup(bashDialog('touch one.txt'), { next: () => bashDialog('touch one.txt') });
		const out = await answer(s, bash('touch one.txt'), { kind: 'allow' }, { receipt: undefined });
		expect(out).toMatchObject({ kind: 'not-taken', final: true });
		expect(s.sim.keys).toEqual(['enter']);
	});

	it('knows it went through when the transcript says so, even under an identical next dialog', async () => {
		const s = setup(bashDialog('touch one.txt'), { next: () => bashDialog('touch one.txt') });
		const out = await answer(s, bash('touch one.txt'), { kind: 'allow' });
		expect(out.kind).toBe('answered');
		expect(s.sim.keys).toEqual(['enter']);
	});

	it('takes a next dialog that differs only in its command for moved on', async () => {
		const s = setup(bashDialog('touch one.txt'), { next: () => bashDialog('mkdir one.txt') });
		const out = await answer(
			s,
			bash('touch one.txt'),
			{ kind: 'deny-with-feedback', feedback: 'use mkdir instead' },
			{ receipt: undefined },
		);
		expect(out).toEqual({ kind: 'moved-on' });
		finalOnce(s, 'enter');
		expect(s.sim.keys.filter((k) => k === 'enter')).toHaveLength(1);
	});

	it('says moved on when the transcript stays silent', async () => {
		const s = setup(bashDialog('touch one.txt'));
		const silent = (): Promise<AnswerReceipt> => new Promise(() => undefined);
		const out = await answer(s, bash('touch one.txt'), { kind: 'allow' }, { receipt: silent });
		expect(out).toEqual({ kind: 'moved-on' });
	});

	it('says not taken when the final key is lost, and presses it once', async () => {
		const s = setup(bashDialog('touch one.txt'), { drop: (key) => key === 'enter' });
		const out = await answer(s, bash('touch one.txt'), { kind: 'allow' });
		expect(out).toMatchObject({ kind: 'not-taken', final: true });
		expect(s.sim.keys).toEqual(['enter']);
	});

	it('reports a misfire: what Claude received is not what was pressed', async () => {
		const s = setup(bashDialog('touch one.txt'), {
			received: () => ({ kind: 'result', text: "The user doesn't want to proceed with this tool use.", isError: true }),
		});
		const out = await answer(s, bash('touch one.txt'), { kind: 'allow' });
		expect(out).toMatchObject({
			kind: 'misfire',
			expected: 'allow once',
			received: "The user doesn't want to proceed with this tool use.",
		});
		expect(s.sim.keys).toEqual(['enter']);
	});

	it('reports a misfire on a question answered otherwise', async () => {
		const s = setup(questionDialog([DRINK]), {
			received: () => ({ kind: 'result', text: '', isError: false, answers: { 'Which drink do you want?': 'Tea' } }),
		});
		const out = await answer(s, asked(DRINK), { kind: 'questions', picks: [{ options: ['Coffee'], text: '' }] });
		expect(out).toMatchObject({
			kind: 'misfire',
			expected: 'Which drink do you want? → Coffee',
			received: 'Which drink do you want? → Tea',
		});
	});
});

describe('answer driver: one answer per pane, cancellable before the commit', () => {
	it('answers busy for a second answer on the same pane, not on another', async () => {
		const s = setup(bashDialog('touch one.txt'));
		const first = s.driver.answer({ paneId: 'p1', expectation: bash('touch one.txt'), answer: { kind: 'allow' } });
		expect(s.driver.busy('p1')).toBe(true);
		const second = s.driver.answer({ paneId: 'p1', expectation: bash('touch one.txt'), answer: { kind: 'deny' } });
		expect(await second.done).toEqual({ kind: 'busy' });
		expect(second.cancel('x')).toBe(false);
		const other = s.driver.answer({ paneId: 'p2', expectation: bash('touch one.txt'), answer: { kind: 'deny' } });
		expect(other.done).not.toBe(second.done);
		await s.clock.run(Promise.all([first.done, other.done]));
		expect(s.driver.busy('p1')).toBe(false);
	});

	it('stops between moves when cancelled, and cannot be cancelled after the final key', async () => {
		let cancel: (reason: string) => boolean = () => false;
		const s = setup(bashDialog('touch one.txt'), {
			onKey: (call) => {
				if ('key' in call && call.key === 'down') expect(cancel('status left blocked')).toBe(true);
			},
		});
		const run = s.driver.answer({
			paneId: 'p1',
			expectation: bash('touch one.txt'),
			answer: { kind: 'deny-with-feedback', feedback: 'no' },
		});
		cancel = run.cancel;
		expect(await s.clock.run(run.done)).toMatchObject({ kind: 'cancelled', reason: 'status left blocked', pressed: 1 });
		expect(s.sim.keys).toEqual(['down']);

		let late: boolean | null = null;
		const t = setup(bashDialog('touch one.txt'), {
			onKey: (call) => {
				if ('key' in call && call.key === 'enter') late = lateCancel('newer call');
			},
		});
		const after = t.driver.answer({ paneId: 'p1', expectation: bash('touch one.txt'), answer: { kind: 'allow' } });
		const lateCancel = after.cancel;
		expect((await t.clock.run(after.done)).kind).toBe('moved-on');
		expect(late).toBe(false);
	});
});

describe('answer driver: matching the recorded screens', () => {
	it('matches a single choice, two questions and their review', () => {
		expect(matchScreen(parseFixture('herdr-ask-single.txt'), asked(DRINK))).toEqual({ ok: true, place: 0 });
		expect(matchScreen(parseFixture('hc-ask-single.txt'), asked(DRINK))).toEqual({ ok: true, place: 0 });
		expect(matchScreen(parseFixture('herdr-ask-two.txt'), asked(SIZE, LID))).toEqual({ ok: true, place: 0 });
		expect(matchScreen(parseFixture('herdr-ask-two-review.txt'), asked(SIZE, LID))).toEqual({
			ok: true,
			place: 'review',
		});
		expect(matchScreen(parseFixture('herdr-ask-multi-review.txt'), asked(FRUIT))).toEqual({ ok: true, place: 'review' });
	});

	it('does not match a question with another text, header, option or order', () => {
		const single = parseFixture('herdr-ask-single.txt');
		expect(matchScreen(single, asked({ ...DRINK, question: 'Which drink?' })).ok).toBe(false);
		expect(matchScreen(single, asked({ ...DRINK, header: 'Drinks' })).ok).toBe(false);
		expect(matchScreen(single, asked({ ...DRINK, options: [...DRINK.options].reverse() })).ok).toBe(false);
		expect(matchScreen(single, asked({ ...DRINK, multiSelect: true })).ok).toBe(false);
		expect(matchScreen(single, asked(DRINK, LID)).ok).toBe(false);
		expect(matchScreen(parseFixture('herdr-ask-two.txt'), asked(SIZE)).ok).toBe(false);
	});

	it('matches a permission by its command or file, and a plan and a trust prompt by theirs', () => {
		expect(matchScreen(parseFixture('herdr-bash-permission.txt'), bash('touch one.txt')).ok).toBe(true);
		expect(matchScreen(parseFixture('herdr-bash-permission.txt'), bash('touch two.txt')).ok).toBe(false);
		const write: ScreenExpectation = {
			kind: 'permission',
			toolUseId: 't',
			tool: 'Write',
			input: { file_path: '/tmp/oh-test-ask-herdr/b.txt' },
			cwd: '/tmp/oh-test-ask-herdr',
		};
		expect(matchScreen(parseFixture('herdr-write-permission.txt'), write).ok).toBe(true);
		expect(matchScreen(parseFixture('herdr-write-permission.txt'), { ...write, cwd: '/tmp/elsewhere' }).ok).toBe(false);
		expect(matchScreen(parseFixture('herdr-write-permission.txt'), { ...write, tool: 'Edit' }).ok).toBe(false);
		const slug = 'plan-a-one-step-change-tidy-unicorn';
		expect(matchScreen(parseFixture('herdr-plan.txt'), { kind: 'plan', slug }).ok).toBe(true);
		expect(matchScreen(parseFixture('herdr-plan.txt'), { kind: 'plan', slug: 'another' }).ok).toBe(false);
		expect(matchScreen(parseFixture('herdr-trust.txt'), { kind: 'trust', cwd: '/var/tmp/oh-test-trust-herdr' }).ok).toBe(
			true,
		);
		expect(matchScreen(parseFixture('herdr-trust.txt'), { kind: 'trust', cwd: '/var/tmp' }).ok).toBe(false);
	});

	it('matches nothing on a torn Submit row', () => {
		for (const name of ['herdr-90-ask-multi-submit-row-torn.txt', 'hc-60-ask-multi-submit-row-torn.txt']) {
			expect(parseFixture(name).kind).toBe('unknown');
		}
	});
});

describe('answer driver: the runtime’s word and the transcript’s', () => {
	it('checks hc’s status message where it has a known form', () => {
		expect(statusAgrees(asked(DRINK), 'answer: Which drink do you want? (Tea · Coffee · Water)')).toBe(true);
		expect(statusAgrees(asked(DRINK), 'answer: Which colour? (Red · Green)')).toBe(false);
		expect(statusAgrees(bash('touch one.txt'), 'approve Bash: touch one.txt')).toBe(true);
		expect(statusAgrees(bash('touch one.txt'), 'approve Bash: touch…')).toBe(true);
		expect(statusAgrees(bash('touch one.txt'), 'approve Bash: mkdir one.txt')).toBe(false);
		expect(statusAgrees(bash('touch one.txt'), 'approve plan')).toBe(false);
		expect(statusAgrees(PLAN, 'approve plan')).toBe(true);
		expect(statusAgrees(PLAN, 'answer: Which drink do you want?')).toBe(false);
		expect(statusAgrees(TRUST, 'approve Bash: x')).toBe(false);
		expect(statusAgrees(TRUST, null)).toBe(true);
		expect(statusAgrees(bash('touch one.txt'), 'thinking')).toBe(true);
	});

	it('writes the answer the way Claude does', () => {
		const pick = { options: ['Cherry', 'Apple'], text: 'Mango, Ripe 2' };
		expect(expectedAnswer(FRUIT, pick)).toBe('Apple, Cherry, "Mango, Ripe 2"');
		expect(expectedAnswer(DRINK, { options: [], text: 'Light blue, please' })).toBe(
			'Light blue, please',
		);
	});

	it('judges the result Claude wrote against what was pressed', () => {
		const rejected = "The user doesn't want to proceed with this tool use. The tool use was rejected.";
		const said = `${rejected} To tell you how to proceed, the user said:\nuse mkdir instead\n\nNote: …`;
		const result = (text: string, isError = false): AnswerReceipt => ({ kind: 'result', text, isError });
		const b = bash('touch one.txt');
		expect(receiptAgrees(b, { kind: 'allow' }, result('Exit code 1', true))).toBe(true);
		expect(receiptAgrees(b, { kind: 'allow' }, result(rejected, true))).toBe(false);
		expect(receiptAgrees(b, { kind: 'deny' }, result(rejected, true))).toBe(true);
		expect(receiptAgrees(b, { kind: 'deny' }, result(said, true))).toBe(false);
		expect(receiptAgrees(b, { kind: 'deny-with-feedback', feedback: 'use mkdir instead' }, result(said, true))).toBe(true);
		expect(receiptAgrees(b, { kind: 'deny-with-feedback', feedback: 'use rm' }, result(said, true))).toBe(false);
		expect(receiptAgrees(PLAN, { kind: 'approve-plan', mode: 'manual' }, result('User has approved your plan.'))).toBe(
			true,
		);
		expect(receiptAgrees(PLAN, { kind: 'approve-plan', mode: 'manual' }, result(said, true))).toBe(false);
		expect(receiptAgrees(TRUST, { kind: 'trust' }, { kind: 'exited' })).toBe(false);
		const q = asked(DRINK);
		const coffee: ScreenAnswer = { kind: 'questions', picks: [{ options: ['Coffee'], text: '' }] };
		expect(
			receiptAgrees(q, coffee, result('The user answered: "Which drink do you want?"="Coffee". Read the answers carefully')),
		).toBe(true);
		expect(receiptAgrees(q, coffee, result('Your questions have been answered: "Which drink do you want?"="Tea".'))).toBe(
			false,
		);
	});

	it('refuses answers that cannot be typed or do not fit', () => {
		expect(answerIssue(asked(FRUIT), { kind: 'questions', picks: [{ options: [], text: '' }] })).not.toBeNull();
		expect(answerIssue(asked(FRUIT), { kind: 'questions', picks: [{ options: ['Kiwi'], text: '' }] })).not.toBeNull();
		expect(answerIssue(bash('x'), { kind: 'deny-with-feedback', feedback: '  ' })).not.toBeNull();
		expect(answerIssue(bash('x'), { kind: 'deny-with-feedback', feedback: 'a\u0007' })).not.toBeNull();
		expect(answerIssue(PLAN, { kind: 'trust' })).not.toBeNull();
		expect(answerIssue(PLAN, { kind: 'reject-plan', feedback: 'smaller' })).toBeNull();
	});
});
