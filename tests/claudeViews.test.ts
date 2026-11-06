/**
 * What the `claude` kind changes in the views (ADR-0007): the stopped row,
 * the native view forced where a kind has no terminal, the waiting card that
 * answers the runtime's own request, and the prompt box's Stop button.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { hostEl, type FakeElement } from './fixtures/dom';
import { MarkdownRenderer } from './fixtures/obsidian';
import { graduationArgs } from '../src/claude/actions';
import { agentLaunchLine } from '../src/hc/actions';
import { CLAUDE_PERMISSION_MODES } from '../src/runtimes';
import type { PaneState } from '../src/herdr/scope';
import type { AgentStatus } from '../src/herdr/types.gen';
import type { PendingRequest, WaitingAnswer } from '../src/native/pendingRequest';
import { PromptBox } from '../src/native/promptBox';
import { emptyTranscript, type TranscriptState } from '../src/agents/claude/transcript';
import type { BlockKind, SessionChange, SessionHandleOf, SessionModels, SessionModelView } from '../src/native/sessionModel';
import { NativePaneSurface } from '../src/native/surface';
import { effectivePaneView, paneViewAvailability } from '../src/native/paneSurface';
import { isTypedAnswerKey, optionName, questionAnswer, requestCard, waitingCard } from '../src/native/waitingCard';
import { buildRows, toRow } from '../src/views/rowModel';
import { answerFailureText, SENDING_TEXT } from '../src/native/waitingCardView';

const VAULT = '/home/lasse/hvelv';

function row(paneId: string, overrides: Partial<PaneState> = {}): PaneState {
	return {
		paneId,
		workspaceId: VAULT,
		tabId: '',
		agent: 'claude',
		name: paneId,
		agentStatus: 'idle',
		title: '',
		label: '',
		cwd: VAULT,
		focused: false,
		tokens: {},
		statusChangedSeq: 0,
		...overrides,
	};
}

describe('the stopped row', () => {
	it('says stopped, and sorts after every live row', () => {
		expect(toRow(row('cl-a', { stopped: true }), VAULT)).toMatchObject({ status: 'stopped', statusLabel: 'Stopped' });
		const [group] = buildRows(
			[row('cl-a', { stopped: true }), row('cl-b'), row('cl-c', { agentStatus: 'unknown' }), row('cl-d', { agentStatus: 'done' })],
			new Map(),
			VAULT,
			{ groupBy: 'none' },
		);
		expect(group?.rows.map((entry) => entry.paneId)).toEqual(['cl-d', 'cl-b', 'cl-c', 'cl-a']);
	});
});

describe('a kind with no terminal view', () => {
	const where = { remote: false, terminalReason: 'not available yet for Claude run by Obsidian' };

	it('offers the terminal disabled, with the reason', () => {
		expect(paneViewAvailability('terminal', where)).toEqual({ available: false, reason: where.terminalReason });
		expect(paneViewAvailability('native', where)).toEqual({ available: true, reason: null });
	});

	it('shows the native view whatever the tab or the default asks for', () => {
		expect(effectivePaneView({ stored: 'terminal', fallback: 'terminal', ...where })).toBe('native');
		expect(effectivePaneView({ stored: null, fallback: 'terminal', ...where })).toBe('native');
		// Everything else keeps the terminal fallback it had.
		expect(effectivePaneView({ stored: 'native', fallback: 'native', remote: true })).toBe('terminal');
	});
});

describe('the launch line with arguments (graduation on herdr-core)', () => {
	it('puts plain arguments after the program and refuses anything a shell would read', () => {
		expect(agentLaunchLine('claude', ['--resume', '3b3ad50c-0000-4000-8000-000000000001'])).toContain(
			"-ic 'claude --resume 3b3ad50c-0000-4000-8000-000000000001; exec",
		);
		expect(() => agentLaunchLine('claude', ["x'; rm -rf ~; '"])).toThrow();
		expect(() => agentLaunchLine('claude', ['$(id)'])).toThrow();
	});

	it('keeps the row’s permission mode, which every mode passes as a plain word', () => {
		const sessionId = '3b3ad50c-0000-4000-8000-000000000001';
		expect(graduationArgs({ cwd: '/vault', sessionId, permissionMode: 'acceptEdits' })).toEqual([
			'--permission-mode',
			'acceptEdits',
			'--resume',
			sessionId,
		]);
		expect(graduationArgs({ cwd: '/vault', sessionId })).toEqual(['--resume', sessionId]);
		for (const permissionMode of CLAUDE_PERMISSION_MODES) {
			expect(agentLaunchLine('claude', graduationArgs({ cwd: '/vault', sessionId, permissionMode }))).toContain(
				`-ic 'claude --permission-mode ${permissionMode} --resume ${sessionId}; exec`,
			);
		}
	});
});

const WRITE: PendingRequest = {
	id: 'req-1',
	kind: 'permission',
	toolName: 'Write',
	toolUseId: 'toolu_1',
	input: { file_path: `${VAULT}/notes/hello.txt`, content: 'hi\n' },
	reason: '',
	questions: [],
	plan: '',
	session: { lines: ['accept file edits'] },
	project: {
		lines: ['allow Bash(touch two.txt)'],
		file: `${VAULT}/.claude/settings.local.json`,
		root: VAULT,
		scope: 'repository',
	},
};

const QUESTION: PendingRequest = {
	...WRITE,
	id: 'req-2',
	kind: 'question',
	toolName: 'AskUserQuestion',
	input: {},
	questions: [
		{
			question: 'Which colour do you prefer?',
			header: 'Colour',
			options: [
				{ label: 'Red', description: '' },
				{ label: 'Blue', description: '' },
			],
			multiSelect: false,
		},
	],
	session: null,
	project: null,
};

const PLAN: PendingRequest = { ...WRITE, id: 'req-3', kind: 'plan', toolName: 'ExitPlanMode', input: {}, plan: '1. Do it.', session: null, project: null };

describe('requestCard', () => {
	it('is never the startup card, so nothing is answered unasked', () => {
		expect(requestCard(WRITE, VAULT)).toMatchObject({ kind: 'permission', title: 'Claude wants to use Write', body: 'notes/hello.txt', reported: true });
		expect(requestCard(QUESTION, VAULT)).toMatchObject({ kind: 'question', body: 'Which colour do you prefer?', options: [
				{ label: 'Red', description: '' },
				{ label: 'Blue', description: '' },
			],
		});
		expect(requestCard(PLAN, VAULT)).toMatchObject({ kind: 'plan', body: '1. Do it.' });
		// The request wins over a guess from the transcript.
		expect(waitingCard({ request: WRITE, hasTranscript: false, turns: [], vaultPath: VAULT }).kind).toBe('permission');
	});
});

class FakeModel implements SessionModelView {
	state: TranscriptState = emptyTranscript();
	path: string | null = '/transcript.jsonl';
	loaded = true;
	agentSession = 's';
	agentStatus: AgentStatus = 'idle';
	blockKind: BlockKind | null = null;
	request: PendingRequest | null = null;
	connected = true;
	private readonly listeners = new Set<(change: SessionChange) => void>();
	claimBlock(): boolean {
		return true;
	}
	on(listener: (change: SessionChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	block(request: PendingRequest | null): void {
		this.agentStatus = request ? 'blocked' : 'working';
		this.blockKind = request ? 'permission' : null;
		this.request = request;
		this.emit();
	}
	emit(): void {
		for (const listener of [...this.listeners]) listener({ changedTurnIds: [], reset: false });
	}
}

async function surfaceOn(model: FakeModel, respond?: (answer: WaitingAnswer) => Promise<void>) {
	const { el, host } = hostEl();
	const answers: { paneId: string; requestId: string; answer: WaitingAnswer }[] = [];
	const interrupts: string[] = [];
	const notices: string[] = [];
	const models: SessionModels = {
		acquire: (): SessionHandleOf<SessionModelView> => ({ model, release: () => {} }),
	};
	const surface = new NativePaneSurface({
		app: { workspace: { openLinkText: () => undefined } } as unknown as App,
		identity: { paneId: 'cl-1', mode: 'control', endpointId: 'rt-c' },
		onStatus: () => {},
		models,
		sender: {
			send: async () => {},
			interrupt: async (paneId) => {
				interrupts.push(paneId);
			},
		},
		keySender: { sendKeys: async () => {} },
		responder: {
			respond: async (paneId, requestId, answer) => {
				answers.push({ paneId, requestId, answer });
				await respond?.(answer);
			},
		},
		notify: (message) => notices.push(message),
		openInTerminal: () => {},
		autoTrustFolders: () => true,
		presentation: () => 'highlight',
		vaultPath: () => VAULT,
	});
	await surface.attach(host);
	return { el, answers, interrupts, notices };
}

function buttons(el: FakeElement): FakeElement[] {
	return el.find('herdr-native-waiting').findAll('herdr-native-waiting-action');
}

/** A button's name: an option's label without its tag and description, else its text. */
function nameOf(button: FakeElement): string {
	return button.findAll('herdr-native-waiting-choice-label')[0]?.textContent ?? button.textContent;
}

function press(el: FakeElement, label: string): void {
	const button = buttons(el).find((entry) => nameOf(entry) === label);
	if (!button) throw new Error(`no button ${label}: ${buttons(el).map((entry) => entry.textContent).join(', ')}`);
	button.dispatch('click');
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('the waiting card answers the runtime’s request', () => {
	beforeEach(() => MarkdownRenderer.reset());

	it('offers allow, deny and the two grants, the project one naming its file', async () => {
		const model = new FakeModel();
		const { el, answers } = await surfaceOn(model);
		model.block(WRITE);
		expect(buttons(el).map((entry) => entry.textContent)).toEqual([
			'Allow',
			'Deny',
			'Allow for this session',
			'Always allow in this project',
		]);
		expect(el.find('herdr-native-waiting').textContent).toContain(
			`Writes ${VAULT}/.claude/settings.local.json: allow Bash(touch two.txt). It applies to the whole project at ${VAULT}, every agent in it and its worktrees, not just this folder.`,
		);
		// No terminal and no trust here, whatever the auto-trust setting says.
		expect(el.findAll('herdr-native-waiting-terminal')).toEqual([]);
		expect(el.findAll('herdr-native-waiting-trust')).toEqual([]);
		press(el, 'Allow for this session');
		press(el, 'Deny');
		await settle();
		// One answer per request, however often it is pressed.
		expect(answers).toEqual([{ paneId: 'cl-1', requestId: 'req-1', answer: { type: 'allow-session' } }]);
		expect(buttons(el).every((entry) => entry.disabled)).toBe(true);
	});

	it('says the agent is stopping and takes no answer once it is', async () => {
		const model = new FakeModel();
		const { el, answers } = await surfaceOn(model);
		model.block(WRITE);
		model.block({ ...WRITE, stopping: true });
		const card = el.find('herdr-native-waiting');
		expect(card.find('herdr-native-waiting-stopping').textContent).toBe(
			'The agent is stopping, so this request is being denied.',
		);
		expect(buttons(el).length).toBeGreaterThan(0);
		expect(buttons(el).every((entry) => entry.disabled)).toBe(true);
		press(el, 'Allow');
		await settle();
		expect(answers).toEqual([]);
	});

	it('keeps the card as it is while the same request waits', async () => {
		const model = new FakeModel();
		const { el } = await surfaceOn(model);
		model.block(PLAN);
		const card = el.find('herdr-native-waiting');
		const feedback = card.find('herdr-native-waiting-feedback');
		feedback.value = 'half typed';
		model.emit();
		expect(el.find('herdr-native-waiting')).toBe(card);
		expect(card.find('herdr-native-waiting-feedback').value).toBe('half typed');
	});

	it('answers a single question by its option, and a plan with approve or feedback', async () => {
		const model = new FakeModel();
		const { el, answers } = await surfaceOn(model);
		model.block(QUESTION);
		expect(buttons(el).map(nameOf)).toEqual(['Red', 'Blue', 'Send', 'Dismiss']);
		press(el, 'Blue');
		model.block(null);
		model.block(PLAN);
		el.find('herdr-native-waiting-feedback').value = 'add tests';
		press(el, 'Reject');
		await settle();
		expect(answers.map((entry) => entry.answer)).toEqual([
			{ type: 'answer', answers: { 'Which colour do you prefer?': 'Blue' } },
			{ type: 'reject-plan', feedback: 'add tests' },
		]);
	});

	it('sends several questions once each has an answer, joining a multiple choice', async () => {
		const model = new FakeModel();
		const { el, answers } = await surfaceOn(model);
		model.block({
			...QUESTION,
			questions: [
				{ ...QUESTION.questions[0]!, multiSelect: true },
				{ question: 'Size?', header: '', options: [{ label: 'S', description: '' }, { label: 'L', description: '' }], multiSelect: false },
			],
		});
		press(el, 'Send answers');
		press(el, 'Red');
		press(el, 'Blue');
		press(el, 'S');
		press(el, 'L');
		press(el, 'Send answers');
		await settle();
		expect(answers.map((entry) => entry.answer)).toEqual([
			{ type: 'answer', answers: { 'Which colour do you prefer?': 'Red, Blue', 'Size?': 'L' } },
		]);
	});
});

/** A question card with descriptions and Claude's own recommendation (#141). */
const DESCRIBED: PendingRequest = {
	...QUESTION,
	id: 'req-4',
	questions: [
		{
			question: 'Which store?',
			header: 'Store',
			options: [
				{ label: 'Redis (Recommended)', description: 'In memory, fast.' },
				{ label: 'Postgres', description: '' },
			],
			multiSelect: false,
		},
	],
};

function typedField(el: FakeElement, index = 0): FakeElement {
	const field = el.findAll('herdr-native-waiting-other-input')[index];
	if (!field) throw new Error('no typed answer field');
	return field;
}

function type(field: FakeElement, text: string): void {
	field.value = text;
	field.dispatch('input');
}

describe('a question answered in the user’s own words (#141)', () => {
	beforeEach(() => MarkdownRenderer.reset());

	it('shows each description under its option and the recommendation as a tag, and sends the label as written', async () => {
		const model = new FakeModel();
		const { el, answers } = await surfaceOn(model);
		model.block(DESCRIBED);
		const [redis, postgres] = el.findAll('herdr-native-waiting-choice');
		expect(redis?.find('herdr-native-waiting-choice-label').textContent).toBe('Redis');
		expect(redis?.find('herdr-native-waiting-tag').textContent).toBe('Recommended');
		expect(redis?.find('herdr-native-waiting-choice-description').textContent).toBe('In memory, fast.');
		expect(redis?.attrs.title).toBeUndefined();
		expect(postgres?.findAll('herdr-native-waiting-tag')).toEqual([]);
		expect(postgres?.findAll('herdr-native-waiting-choice-description')).toEqual([]);
		press(el, 'Redis');
		await settle();
		expect(answers.map((entry) => entry.answer)).toEqual([
			{ type: 'answer', answers: { 'Which store?': 'Redis (Recommended)' } },
		]);
	});

	it('sends a typed answer to one question by Send, which waits for text', async () => {
		const model = new FakeModel();
		const { el, answers } = await surfaceOn(model);
		model.block(DESCRIBED);
		const send = buttons(el).find((entry) => entry.textContent === 'Send');
		expect(send?.disabled).toBe(true);
		type(typedField(el), '  SQLite, on disk  ');
		expect(send?.disabled).toBe(false);
		press(el, 'Send');
		await settle();
		expect(answers.map((entry) => entry.answer)).toEqual([
			{ type: 'answer', answers: { 'Which store?': 'SQLite, on disk' } },
		]);
	});

	it('sends a typed answer by Enter, but not an Enter an input method is composing with', async () => {
		const model = new FakeModel();
		const { el, answers } = await surfaceOn(model);
		model.block(DESCRIBED);
		const field = typedField(el);
		field.dispatch('keydown', { key: 'Enter' });
		type(field, '日本');
		field.dispatch('keydown', { key: 'Enter', isComposing: true });
		field.dispatch('keydown', { key: 'Enter', keyCode: 229 });
		await settle();
		expect(answers).toEqual([]);
		const enter = field.dispatch('keydown', { key: 'Enter' });
		await settle();
		expect(enter.defaultPrevented).toBe(true);
		expect(answers.map((entry) => entry.answer)).toEqual([{ type: 'answer', answers: { 'Which store?': '日本' } }]);
	});

	it('adds a typed answer to a multiple choice, and lets it replace a single one in a form', async () => {
		const model = new FakeModel();
		const { el, answers } = await surfaceOn(model);
		model.block({
			...QUESTION,
			questions: [
				{ ...QUESTION.questions[0]!, multiSelect: true },
				{ question: 'Size?', header: '', options: [{ label: 'S', description: '' }, { label: 'L', description: '' }], multiSelect: false },
			],
		});
		const submit = (): FakeElement | undefined => buttons(el).find((entry) => entry.textContent === 'Send answers');
		press(el, 'Blue');
		type(typedField(el, 0), 'Green');
		expect(submit()?.disabled).toBe(true);
		press(el, 'S');
		expect(submit()?.disabled).toBe(false);
		// A typed answer to a single choice takes the option's place …
		type(typedField(el, 1), 'Medium');
		expect(el.findAll('herdr-native-waiting-choice').filter((entry) => entry.hasClass('is-selected')).map(nameOf)).toEqual(['Blue']);
		// … and Enter in a form sends the whole form once it is complete.
		typedField(el, 1).dispatch('keydown', { key: 'Enter' });
		await settle();
		expect(answers.map((entry) => entry.answer)).toEqual([
			{ type: 'answer', answers: { 'Which colour do you prefer?': 'Blue, Green', 'Size?': 'Medium' } },
		]);
	});

	it('clears a single choice’s typed answer when an option is picked instead', async () => {
		const model = new FakeModel();
		const { el, answers } = await surfaceOn(model);
		model.block({
			...QUESTION,
			questions: [
				QUESTION.questions[0]!,
				{ question: 'Size?', header: '', options: [{ label: 'S', description: '' }], multiSelect: false },
			],
		});
		type(typedField(el, 0), 'Green');
		press(el, 'Red');
		expect(typedField(el, 0).value).toBe('');
		press(el, 'S');
		press(el, 'Send answers');
		await settle();
		expect(answers.map((entry) => entry.answer)).toEqual([
			{ type: 'answer', answers: { 'Which colour do you prefer?': 'Red', 'Size?': 'S' } },
		]);
	});
});

/** A promise the test settles by hand: the runtime taking its time over an answer. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
	let resolve: () => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function cardStatus(el: FakeElement): FakeElement {
	return el.find('herdr-native-waiting').find('herdr-native-waiting-status');
}

describe('the waiting card while it sends, when it fails, folded, and to a screen reader (#142)', () => {
	beforeEach(() => MarkdownRenderer.reset());

	it('says it is sending, from a live region there from the first draw, with the options busy', async () => {
		const model = new FakeModel();
		const pending = deferred();
		const { el } = await surfaceOn(model, () => pending.promise);
		model.block(DESCRIBED);
		const status = cardStatus(el);
		expect(status.attrs.role).toBe('status');
		expect(status.attrs['aria-live']).toBe('polite');
		expect(status.textContent).toBe('');
		expect(status.hasClass('herdr-native-visually-hidden')).toBe(true);
		const choices = el.find('herdr-native-waiting-choices');
		expect(choices.attrs['aria-busy']).toBe('false');
		// Busy on the options alone: never on the card, whose status must be read.
		expect(el.find('herdr-native-waiting').attrs['aria-busy']).toBeUndefined();

		press(el, 'Postgres');
		expect(cardStatus(el)).toBe(status);
		expect(status.textContent).toBe(SENDING_TEXT);
		expect(status.hasClass('herdr-native-visually-hidden')).toBe(false);
		expect(choices.attrs['aria-busy']).toBe('true');
		expect(buttons(el).every((entry) => entry.disabled)).toBe(true);
		expect(typedField(el).disabled).toBe(true);

		pending.resolve();
		await settle();
		expect(status.textContent).toBe('Answer sent.');
		expect(choices.attrs['aria-busy']).toBe('false');
	});

	it('says a failure in place, keeps what was typed, and takes the answer again', async () => {
		const model = new FakeModel();
		let fail = true;
		const { el, notices, answers } = await surfaceOn(model, async () => {
			if (fail) throw new Error('the agent is not running');
		});
		model.block(DESCRIBED);
		type(typedField(el), 'SQLite');
		press(el, 'Send');
		await settle();
		const error = el.find('herdr-native-waiting-error');
		expect(error.attrs.role).toBe('alert');
		expect(error.textContent).toBe(answerFailureText(new Error('the agent is not running'), true));
		expect(error.textContent).toContain('the agent is not running');
		expect(notices).toEqual([]);
		expect(cardStatus(el).textContent).toBe('');
		// Usable again, with the typed answer still there and Send ready for it.
		expect(typedField(el).value).toBe('SQLite');
		expect(typedField(el).disabled).toBe(false);
		expect(buttons(el).every((entry) => !entry.disabled)).toBe(true);

		fail = false;
		press(el, 'Send');
		await settle();
		expect(el.findAll('herdr-native-waiting-error')).toEqual([]);
		expect(answers.map((entry) => entry.answer)).toEqual([
			{ type: 'answer', answers: { 'Which store?': 'SQLite' } },
			{ type: 'answer', answers: { 'Which store?': 'SQLite' } },
		]);
	});

	it('says so when the request went or changed before the answer arrived', async () => {
		const model = new FakeModel();
		const { el } = await surfaceOn(model, async () => {
			// The runtime moved on while the answer was on its way.
			model.request = null;
			throw new Error('that request is no longer waiting');
		});
		model.block(WRITE);
		press(el, 'Allow');
		await settle();
		expect(el.find('herdr-native-waiting-error').textContent).toBe(answerFailureText(new Error('x'), false));
	});

	it('folds to its title bar and opens again, and the next request opens unfolded', async () => {
		const model = new FakeModel();
		const { el } = await surfaceOn(model);
		model.block(PLAN);
		const fold = el.find('herdr-native-waiting-fold');
		expect(fold.attrs['aria-expanded']).toBe('true');
		expect(fold.attrs['aria-label']).toBe('Collapse the card');
		fold.dispatch('click');
		const card = el.find('herdr-native-waiting');
		expect(card.hasClass('is-folded')).toBe(true);
		expect(card.find('herdr-native-waiting-content').hasClass('herdr-is-hidden')).toBe(true);
		expect(fold.attrs['aria-expanded']).toBe('false');
		expect(fold.attrs['aria-label']).toBe('Expand the card');
		// The bar still says what is waiting, and the status stays outside the fold.
		expect(card.find('herdr-native-waiting-title').textContent).toBe('Claude is ready to code');
		expect(card.find('herdr-native-waiting-status').parent).toBe(card);
		fold.dispatch('click');
		expect(card.hasClass('is-folded')).toBe(false);
		expect(card.find('herdr-native-waiting-content').hasClass('herdr-is-hidden')).toBe(false);

		fold.dispatch('click');
		model.block(null);
		model.block(WRITE);
		expect(el.find('herdr-native-waiting').hasClass('is-folded')).toBe(false);
	});

	it('keeps a folded card folded while a block without a request is drawn again', async () => {
		const model = new FakeModel();
		const { el } = await surfaceOn(model);
		model.agentStatus = 'blocked';
		model.blockKind = 'question';
		model.emit();
		el.find('herdr-native-waiting-fold').dispatch('click');
		model.emit();
		expect(el.find('herdr-native-waiting').hasClass('is-folded')).toBe(true);
	});

	it('names the card, and says which toggles are on; an option that answers at once is no toggle', async () => {
		const model = new FakeModel();
		const { el } = await surfaceOn(model);
		model.block(DESCRIBED);
		const card = el.find('herdr-native-waiting');
		expect(card.attrs.role).toBe('region');
		expect(card.attrs['aria-label']).toBe('Claude asked a question');
		expect(el.findAll('herdr-native-waiting-choice').map((entry) => entry.attrs['aria-pressed'])).toEqual([
			undefined,
			undefined,
		]);
		model.block(null);
		model.block({ ...QUESTION, id: 'req-5', questions: [{ ...QUESTION.questions[0]!, multiSelect: true }] });
		const pressed = (): (string | undefined)[] => el.findAll('herdr-native-waiting-choice').map((entry) => entry.attrs['aria-pressed']);
		expect(pressed()).toEqual(['false', 'false']);
		press(el, 'Blue');
		expect(pressed()).toEqual(['false', 'true']);
		expect(el.find('herdr-native-waiting-choices').attrs).toMatchObject({ role: 'group', 'aria-label': 'Which colour do you prefer?' });
	});
});

describe('the question card’s pure parts (#141)', () => {
	it('reads Claude’s recommendation off the label, and never draws one blank', () => {
		expect(optionName('Redis (Recommended)')).toEqual({ text: 'Redis', recommended: true });
		expect(optionName('Redis (recommended) ')).toEqual({ text: 'Redis', recommended: true });
		expect(optionName('Redis')).toEqual({ text: 'Redis', recommended: false });
		expect(optionName('(Recommended)')).toEqual({ text: '(Recommended)', recommended: false });
		expect(optionName('Recommended')).toEqual({ text: 'Recommended', recommended: false });
	});

	it('joins the picks in Claude’s order, then the typed answer', () => {
		const offered = [
			{ label: 'Red', description: '' },
			{ label: 'Blue', description: '' },
		];
		expect(questionAnswer(offered, new Set(['Blue', 'Red']), ' Green ')).toBe('Red, Blue, Green');
		expect(questionAnswer(offered, new Set(), '   ')).toBe('');
		expect(questionAnswer(offered, new Set(['Gone']), '')).toBe('');
	});

	it('takes Enter as a send unless an input method holds it', () => {
		expect(isTypedAnswerKey({ key: 'Enter' })).toBe(true);
		expect(isTypedAnswerKey({ key: 'Enter', isComposing: true })).toBe(false);
		expect(isTypedAnswerKey({ key: 'Enter', keyCode: 229 })).toBe(false);
		expect(isTypedAnswerKey({ key: 'a' })).toBe(false);
	});
});

describe('the Stop button', () => {
	it('shows only while a turn runs, and sends the interrupt', async () => {
		const { el, host } = hostEl();
		const interrupts: string[] = [];
		const box = new PromptBox({
			paneId: () => 'cl-1',
			sender: { send: async () => {}, interrupt: async (paneId) => void interrupts.push(paneId) },
		});
		box.mount(host);
		const stop = el.find('herdr-native-prompt-stop');
		expect(stop.hasClass('herdr-is-hidden')).toBe(true);
		box.setStatus('working');
		expect(stop.hasClass('herdr-is-hidden')).toBe(false);
		stop.dispatch('click');
		await settle();
		expect(interrupts).toEqual(['cl-1']);
		box.setStatus('done');
		expect(stop.hasClass('herdr-is-hidden')).toBe(true);
	});

	it('is not there for a sender that cannot interrupt', () => {
		const { el, host } = hostEl();
		new PromptBox({ paneId: () => 'w1:p1', sender: { send: async () => {} } }).mount(host);
		expect(el.findAll('herdr-native-prompt-stop')).toEqual([]);
	});
});
