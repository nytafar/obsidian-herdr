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
import { emptyTranscript, type TranscriptState } from '../src/native/reducer';
import type { BlockKind, SessionChange, SessionHandleOf, SessionModels, SessionModelView } from '../src/native/sessionModel';
import { NativePaneSurface } from '../src/native/surface';
import { effectivePaneView, paneViewAvailability } from '../src/native/paneSurface';
import { requestCard, waitingCard } from '../src/native/waitingCard';
import { buildRows, toRow } from '../src/views/rowModel';

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
		expect(requestCard(QUESTION, VAULT)).toMatchObject({ kind: 'question', body: 'Which colour do you prefer?', options: ['Red', 'Blue'] });
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

async function surfaceOn(model: FakeModel) {
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

function press(el: FakeElement, label: string): void {
	const button = buttons(el).find((entry) => entry.textContent === label);
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
		expect(buttons(el).map((entry) => entry.textContent)).toEqual(['Red', 'Blue', 'Dismiss']);
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
