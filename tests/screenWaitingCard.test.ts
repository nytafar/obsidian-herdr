/**
 * The waiting card on a herdr or herdr-core pane (#166, ADR-0009 §3): built
 * from the screen through the card's own code, answered through the shared
 * driver against the scripted fake screen (`fixtures/fakeClaudeScreen.ts`),
 * judged by the transcript the fake writes into the session model.
 *
 * What every case holds, as the driver's tests do: no digit is pressed, and a
 * card whose request is no longer on screen presses nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { hostEl, type FakeElement } from './fixtures/dom';
import { MarkdownRenderer } from './fixtures/obsidian';
import { NativePaneSurface } from '../src/native/surface';
import { parseClaudeScreen } from '../src/agents/claude/screenDialog';
import { emptyTranscript, type TranscriptState } from '../src/agents/claude/transcript';
import { REFUSAL_TEXT, ScreenAnswerer, type AnswerTiming } from '../src/native/screenAnswer';
import { ScreenAnswerers, type ScreenAnswering } from '../src/native/screenAnswerers';
import { TRUST_CLAIMED_TEXT } from '../src/native/waitingCardView';
import type { ToolEntry, Turn } from '../src/native/conversation';
import type { BlockKind, SessionChange, SessionHandleOf, SessionModels, SessionModelView } from '../src/native/sessionModel';
import type { AgentStatus } from '../src/herdr/types.gen';
import {
	bashDialog,
	FakeClaudeScreen,
	planDialog,
	questionDialog,
	trustDialog,
	writeDialog,
	type SimDialog,
	type SimOptions,
	type SimQuestion,
	type SimResult,
} from './fixtures/fakeClaudeScreen';

const CWD = '/tmp/oh-test-sim';
const FAST: AnswerTiming = { pollMs: 1, stepMs: 300, confirmMs: 10, quietMs: 60, lateMs: 600, receiptMs: 300 };

class FakeModel implements SessionModelView {
	state: TranscriptState = emptyTranscript();
	path: string | null = '/transcript.jsonl';
	loaded = true;
	agentSession = 'session-1';
	agentStatus: AgentStatus = 'idle';
	blockKind: BlockKind | null = null;
	plan: string | null = null;
	connected = true;
	private readonly listeners = new Set<(change: SessionChange) => void>();

	claimBlock(): boolean {
		return true;
	}

	on(listener: (change: SessionChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setStatus(status: AgentStatus, blockKind: BlockKind | null = null): void {
		this.agentStatus = status;
		this.blockKind = status === 'blocked' ? blockKind : null;
		this.emit();
	}

	/** Claude got past the trust prompt: the runtime names its session. */
	start(): void {
		this.agentSession = 'session-2';
		this.emit();
	}

	/** A transcript line landed. */
	add(entry: ToolEntry): void {
		const turns = this.state.turns;
		const last = turns[turns.length - 1];
		const next: Turn = last
			? { ...last, entries: [...last.entries, entry] }
			: { id: 'u1', prompt: 'go', entries: [entry], headings: [] };
		this.state = { ...this.state, turns: [...turns.slice(0, -1), next] };
		this.emit();
	}

	private emit(): void {
		for (const listener of [...this.listeners]) listener({ changedTurnIds: [], reset: false });
	}
}

class FakeModels implements SessionModels {
	constructor(readonly model: FakeModel) {}
	acquire(): SessionHandleOf<SessionModelView> {
		return { model: this.model, release: () => {} };
	}
}

const DRINK: SimQuestion = {
	question: 'Which drink do you want?',
	header: 'Drink',
	options: ['Tea', 'Coffee', 'Water'].map((label) => ({ label, description: label })),
	multiSelect: false,
};
const FRUIT: SimQuestion = {
	question: 'Which fruits do you like?',
	header: 'Fruit',
	options: ['Apple', 'Banana', 'Cherry', 'Durian'].map((label) => ({ label, description: label })),
	multiSelect: true,
};

/** What the transcript writes for a result the fake screen sent: the call and its result together. */
function entryFor(result: SimResult, dialogs: Map<string, SimDialog>): ToolEntry {
	const dialog = dialogs.get(result.id);
	const text = result.receipt.kind === 'result' ? result.receipt.text : '';
	const base = { kind: 'tool' as const, id: result.id, result: text, notification: null, report: null };
	const status = result.receipt.kind === 'result' && result.receipt.isError ? 'error' : 'done';
	if (dialog?.kind === 'question') {
		return { ...base, name: 'AskUserQuestion', input: { questions: dialog.questions }, status };
	}
	if (dialog?.kind === 'permission') {
		const input = dialog.tool === 'Bash' ? { command: dialog.subject } : { file_path: `${CWD}/${dialog.subject}` };
		return { ...base, name: dialog.tool, input, status };
	}
	return { ...base, name: 'ExitPlanMode', input: { plan: 'x' }, status };
}

interface Setup {
	model: FakeModel;
	sim: FakeClaudeScreen;
	el: FakeElement;
	notices: string[];
	answering: ScreenAnswering;
	surface: NativePaneSurface;
	/** The plugin-wide trust claims, as the tabs share them. */
	claims: ScreenAnswerers;
}

const PANE_KEY = 'local\nw4:p1';

async function setup(dialog: SimDialog, options: SimOptions = {}, statusMessage: string | null = null): Promise<Setup> {
	const model = new FakeModel();
	const dialogs = new Map<string, SimDialog>();
	const remember = (d: SimDialog): void => {
		if (d.kind !== 'trust' && d.kind !== 'composer') dialogs.set(d.id, d);
	};
	remember(dialog);
	let written = 0;
	const sim = new FakeClaudeScreen(dialog, {
		...options,
		onKey: (call, s) => {
			options.onKey?.(call, s);
			remember(s.dialog);
			// The transcript gets the call and its result once Claude received it.
			while (written < s.results.length) {
				const result = s.results[written++] as SimResult;
				// The trust prompt has no transcript: the session starts instead.
				if (result.kind === 'trust') model.start();
				else model.add(entryFor(result, dialogs));
			}
		},
	});
	const claims = new ScreenAnswerers();
	const answering: ScreenAnswering = {
		answerer: new ScreenAnswerer({ screen: sim, parse: parseClaudeScreen, timing: FAST }),
		screen: sim,
		parse: parseClaudeScreen,
		statusMessage: () => statusMessage,
		cwd: () => CWD,
		claimTrust: () => claims.claimTrust(PANE_KEY),
		releaseTrust: () => claims.releaseTrust(PANE_KEY),
		retryMs: 1,
		nextReadMs: 60_000,
	};
	const { el, host } = hostEl();
	const notices: string[] = [];
	const surface = new NativePaneSurface({
		app: { workspace: { openLinkText: vi.fn() } } as unknown as App,
		identity: { paneId: 'w4:p1', mode: 'control', endpointId: 'local' },
		onStatus: () => {},
		models: new FakeModels(model),
		sender: { send: async () => {} },
		keySender: { sendKeys: async () => {} },
		screen: () => answering,
		notify: (message) => notices.push(message),
		openInTerminal: vi.fn(),
		autoTrustFolders: () => false,
		presentation: () => 'highlight',
		vaultPath: () => '/vault',
	});
	await surface.attach(host);
	return { model, sim, el, notices, answering, surface, claims };
}

function title(el: FakeElement): string {
	return el.find('herdr-native-waiting-title').textContent;
}

function buttons(el: FakeElement): FakeElement[] {
	return el.find('herdr-native-waiting').findAll('herdr-native-waiting-action');
}

function labels(el: FakeElement): string[] {
	return buttons(el).map((b) => b.textContent);
}

function press(el: FakeElement, label: string): void {
	const button = buttons(el).find((b) => b.textContent === label || b.textContent.startsWith(label));
	if (!button) throw new Error(`no button "${label}" in ${JSON.stringify(labels(el))}`);
	expect(button.disabled).toBe(false);
	button.dispatch('click');
}

function type(el: FakeElement, index: number, text: string): void {
	const field = el.findAll('herdr-native-waiting-other-input')[index] as FakeElement;
	field.value = text;
	field.dispatch('input');
}

/** The card's status line or its error line, whichever speaks. */
function said(el: FakeElement): string {
	const error = el.findAll('herdr-native-waiting-error')[0];
	return error ? error.textContent : el.find('herdr-native-waiting-status').textContent;
}

/** The card has read the screen: its title, and its answers drawn. */
async function ready(el: FakeElement, heading: string): Promise<void> {
	await vi.waitFor(() => {
		expect(title(el)).toBe(heading);
		expect(labels(el).length).toBeGreaterThan(1);
	});
}

async function outcome(el: FakeElement, text: RegExp | string): Promise<void> {
	await vi.waitFor(() => expect(said(el)).toMatch(text));
}

beforeEach(() => {
	MarkdownRenderer.reset();
	// The card times its reads on the window, as view code does.
	vi.stubGlobal('window', globalThis);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('screen card: questions', () => {
	it('reads a question with no call off the screen and answers it by its option', async () => {
		const s = await setup(questionDialog([DRINK]));
		s.model.setStatus('blocked');
		await ready(s.el, 'Claude asked a question');
		// Each option with its description under it, as the `claude` kind's card draws them.
		expect(labels(s.el)).toEqual(['TeaTea', 'CoffeeCoffee', 'WaterWater', 'Send', 'Cancel', 'Open in terminal']);
		press(s.el, 'Coffee');
		await outcome(s.el, 'Claude received your answer.');
		expect(s.sim.keys).toEqual(['down', 'enter']);
	});

	it('answers a question from its dangling call, ticks and own words through the review', async () => {
		const s = await setup(questionDialog([FRUIT]));
		s.model.add({
			kind: 'tool',
			id: 'toolu_q',
			name: 'AskUserQuestion',
			input: { questions: [FRUIT] },
			result: null,
			status: 'pending',
			notification: null,
			report: null,
		});
		s.model.setStatus('blocked', 'question');
		await ready(s.el, 'Claude asked a question');
		press(s.el, 'Apple');
		press(s.el, 'Cherry');
		type(s.el, 0, 'Mango, Ripe 2');
		press(s.el, 'Send answers');
		await outcome(s.el, 'Claude received your answer.');
		const received = s.sim.received[0];
		expect(received?.kind === 'result' && received.text).toContain('"Apple, Cherry, "Mango, Ripe 2""');
		expect(s.sim.keys.some((key) => /^\d$/.test(key))).toBe(false);
	});

	it('refuses a lone digit as words before anything is sent, and lets the card answer again', async () => {
		const s = await setup(questionDialog([DRINK]));
		s.model.setStatus('blocked');
		await ready(s.el, 'Claude asked a question');
		type(s.el, 0, '2');
		press(s.el, 'Send');
		await outcome(s.el, /cannot be sent: a single digit/);
		expect(s.sim.keys).toEqual([]);
		press(s.el, 'Tea');
		await outcome(s.el, 'Claude received your answer.');
		expect(s.sim.keys).toEqual(['enter']);
	});

	it('cancels with esc', async () => {
		const s = await setup(questionDialog([DRINK]));
		s.model.setStatus('blocked');
		await ready(s.el, 'Claude asked a question');
		press(s.el, 'Cancel');
		await outcome(s.el, 'Claude received your answer.');
		expect(s.sim.keys).toEqual(['esc']);
	});
});

describe('screen card: permissions', () => {
	it('offers Claude’s own rows, not auto mode, and allows once with enter', async () => {
		const s = await setup(bashDialog('touch one.txt'));
		s.model.setStatus('blocked');
		await ready(s.el, 'Claude wants to use Bash');
		expect(labels(s.el)).toEqual([
			'Yes',
			`Yes, and always allow access to ${CWD} from this project`,
			'No',
			'No, and tell Claude',
			'Open in terminal',
		]);
		expect(s.el.find('herdr-native-waiting-screen').textContent).toBe('touch one.txt');
		press(s.el, 'Yes');
		await outcome(s.el, 'Claude received your answer.');
		expect(s.sim.keys).toEqual(['enter']);
	});

	it('denies with the user’s words', async () => {
		const s = await setup(bashDialog('touch one.txt'));
		s.model.setStatus('blocked');
		await ready(s.el, 'Claude wants to use Bash');
		type(s.el, 0, 'use mkdir instead');
		press(s.el, 'No, and tell Claude');
		await outcome(s.el, 'Claude received your answer.');
		expect(s.sim.keys).toEqual(['down', 'down', 'down', 'tab', 'text:use mkdir instead', 'enter']);
	});

	it('shows a Write’s content as the screen did and allows it by its option 2', async () => {
		const s = await setup(writeDialog('b.txt', [' 1 hello']));
		s.model.setStatus('blocked');
		await ready(s.el, 'Claude wants to use Write');
		expect(s.el.find('herdr-native-waiting-screen').textContent).toBe(' 1 hello');
		press(s.el, 'Yes, and switch to accept edits');
		await outcome(s.el, 'Claude received your answer.');
		expect(s.sim.keys).toEqual(['down', 'enter']);
	});

	it('refuses a card whose request is no longer on screen, presses nothing, and reads again', async () => {
		const s = await setup(bashDialog('touch one.txt'));
		s.model.setStatus('blocked');
		await ready(s.el, 'Claude wants to use Bash');
		// The next request looks the same but for its command (finding §5).
		s.sim.dialog = bashDialog('touch two.txt', 'toolu_b2');
		press(s.el, 'Yes');
		await outcome(s.el, REFUSAL_TEXT);
		expect(s.sim.keys).toEqual([]);
		press(s.el, 'Read the terminal again');
		await vi.waitFor(() => expect(s.el.find('herdr-native-waiting-screen').textContent).toBe('touch two.txt'));
	});

	it('names what Claude received when it is not what was pressed, on the card and as a notice', async () => {
		const s = await setup(bashDialog('touch one.txt'), {
			received: () => ({ kind: 'result', text: "The user doesn't want to proceed with this tool use.", isError: true }),
		});
		s.model.setStatus('blocked');
		await ready(s.el, 'Claude wants to use Bash');
		press(s.el, 'Yes');
		await outcome(s.el, /something else than you pressed: The user doesn't want to proceed/);
		expect(s.notices[0]).toMatch(/^Gjetr: Claude received something else/);
		expect(labels(s.el)).toContain('Show in the conversation');
	});

	it('says the terminal did not take a key that never showed, and never presses it again', async () => {
		const s = await setup(bashDialog('touch one.txt'), { drop: (key) => key === 'enter' });
		s.model.setStatus('blocked');
		await ready(s.el, 'Claude wants to use Bash');
		press(s.el, 'Yes');
		await outcome(s.el, 'The terminal did not take the answer. Answer it in the terminal.');
		expect(s.sim.keys).toEqual(['enter']);
	});

	it('stops an answer before its next key when Claude is no longer waiting', async () => {
		let s: Setup | null = null;
		s = await setup(bashDialog('touch one.txt'), {
			onKey: (call) => {
				if ('key' in call && call.key === 'down') s?.model.setStatus('working');
			},
		});
		s.model.setStatus('blocked');
		await ready(s.el, 'Claude wants to use Bash');
		type(s.el, 0, 'no');
		press(s.el, 'No, and tell Claude');
		await vi.waitFor(() => expect(s?.el.findAll('herdr-native-waiting')).toHaveLength(0));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(s.sim.keys).toEqual(['down']);
	});

	it('offers nothing when the runtime says it waits for something else', async () => {
		const s = await setup(bashDialog('touch one.txt'), {}, 'approve Bash: rm -rf build');
		s.model.setStatus('blocked', 'permission');
		await vi.waitFor(() => expect(labels(s.el)).toEqual(['Read the terminal again', 'Open in terminal']));
		expect(s.sim.keys).toEqual([]);
	});
});

describe('screen card: plans', () => {
	it('shows the plan file when it says what the screen shows, and approves by Claude’s label', async () => {
		const s = await setup(planDialog('tidy-unicorn'));
		s.model.plan = 'Step: write `c.txt`.';
		s.model.setStatus('blocked');
		await ready(s.el, 'Claude is ready to code');
		expect(MarkdownRenderer.calls.map((call) => call.markdown)).toContain('Step: write `c.txt`.');
		expect(labels(s.el)).toEqual([
			'Yes, manually approve edits',
			'Yes, and use auto mode',
			'Tell Claude what to change',
			'Open in terminal',
		]);
		press(s.el, 'Yes, manually approve edits');
		await outcome(s.el, 'Claude received your answer.');
		expect(s.sim.keys).toEqual(['down', 'enter']);
	});

	it('shows the screen’s plan when the file says something else, and rejects it with words', async () => {
		const s = await setup(planDialog('tidy-unicorn', ['Step: write d.txt.']));
		s.model.plan = 'Step: write `c.txt`.';
		s.model.setStatus('blocked');
		await ready(s.el, 'Claude is ready to code');
		expect(s.el.find('herdr-native-waiting-screen').textContent).toBe('Step: write d.txt.');
		type(s.el, 0, 'name it e.txt');
		press(s.el, 'Tell Claude what to change');
		await outcome(s.el, /Claude received your answer|^Sent\./);
		expect(s.sim.keys).toEqual(['down', 'down', 'text:name it e.txt', 'enter']);
	});
});

describe('screen card: the trust prompt (#167)', () => {
	it('offers to trust the folder only once the screen shows the prompt for it, and trusts with down enter', async () => {
		const s = await setup(trustDialog(CWD));
		s.model.path = null;
		s.model.agentSession = '';
		s.model.setStatus('blocked');
		await ready(s.el, 'Claude is asking whether to trust this folder');
		expect(labels(s.el)).toEqual(['Yes, I trust this folder', 'Open in terminal']);
		expect(s.el.find('herdr-native-waiting-body').textContent).toBe(CWD);
		press(s.el, 'Yes, I trust this folder');
		await outcome(s.el, 'Claude received your answer.');
		expect(s.sim.keys).toEqual(['down', 'enter']);
	});

	it('offers no trust for a prompt that names another folder', async () => {
		const s = await setup(trustDialog('/tmp/somewhere-else'));
		s.model.path = null;
		s.model.agentSession = '';
		s.model.setStatus('blocked');
		await vi.waitFor(() => expect(labels(s.el)).toEqual(['Read the terminal again', 'Open in terminal']));
		expect(s.el.find('herdr-native-waiting-hint').textContent).toMatch(/names another folder/);
		expect(s.sim.keys).toEqual([]);
	});
});

describe('screen card: a view detached and attached again (#166 review)', () => {
	it('draws the card afresh when a read was under way as the view detached', async () => {
		const s = await setup(bashDialog('ls -la'));
		const sim = s.sim;
		let release: (() => void) | null = null;
		s.answering.screen = {
			read: async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return sim.read();
			},
			press: (paneId, key) => sim.press(paneId, key),
			type: (paneId, text) => sim.type(paneId, text),
		};
		s.model.setStatus('blocked');
		await vi.waitFor(() => expect(release).not.toBeNull());
		await s.surface.detach();
		const held = release as unknown as () => void;
		s.answering.screen = sim;
		held();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const again = hostEl();
		await s.surface.attach(again.host);
		await ready(again.el, 'Claude wants to use Bash');
		expect(s.el.findAll('herdr-native-waiting')).toHaveLength(0);
		expect(again.el.find('herdr-native-prompt-box').hasClass('herdr-is-standing-in')).toBe(true);
	});

	it('cancels the reads it was waiting to make: none runs once the view is gone', async () => {
		const s = await setup(trustDialog(CWD));
		s.answering.retryMs = 40;
		s.model.path = null;
		s.model.agentSession = '';
		s.model.setStatus('blocked');
		// The first read showed the prompt; the card waits to read it again.
		await vi.waitFor(() => expect(s.sim.reads).toBe(1));
		await s.surface.detach();
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(s.sim.reads).toBe(1);
		expect(s.sim.keys).toEqual([]);
	});
});

describe('screen card: the trust prompt, one press per prompt (#167 review)', () => {
	function atPrompt(s: Setup): void {
		s.model.path = null;
		s.model.agentSession = '';
		s.model.setStatus('blocked');
	}

	it('waits from the first read that shows the prompt, though a torn read came before it', async () => {
		const trust = trustDialog(CWD);
		const shown: number[] = [];
		const s = await setup({ kind: 'composer' }, {
			onRead: (sim) => {
				if (sim.reads === 2) sim.dialog = trust;
				if (sim.dialog === trust) shown.push(sim.reads);
			},
		});
		atPrompt(s);
		await ready(s.el, 'Claude is asking whether to trust this folder');
		// A torn first read, then the prompt twice, the wait between them.
		expect(shown.length).toBeGreaterThanOrEqual(3);
	});

	it('waits again when a read between showed no prompt', async () => {
		const trust = trustDialog(CWD);
		const s = await setup(trust, {
			onRead: (sim) => {
				sim.dialog = sim.reads === 2 ? { kind: 'composer' } : trust;
			},
		});
		atPrompt(s);
		await ready(s.el, 'Claude is asking whether to trust this folder');
		// The prompt, a read without it, then the prompt on two reads.
		expect(s.sim.reads).toBeGreaterThanOrEqual(4);
	});

	it('presses nothing when the prompt is already claimed by a press elsewhere, and says so', async () => {
		const s = await setup(trustDialog(CWD));
		atPrompt(s);
		await ready(s.el, 'Claude is asking whether to trust this folder');
		// The trust watch, or another tab, pressed first.
		expect(s.claims.claimTrust(PANE_KEY)).toBe(true);
		press(s.el, 'Yes, I trust this folder');
		await outcome(s.el, /already answered this prompt once/);
		expect(said(s.el)).toBe(TRUST_CLAIMED_TEXT);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(s.sim.keys).toEqual([]);
	});

	it('keeps the claim after a key that did not take, so nothing presses the prompt again', async () => {
		const s = await setup(trustDialog(CWD), { drop: (key) => key === 'enter' });
		atPrompt(s);
		await ready(s.el, 'Claude is asking whether to trust this folder');
		press(s.el, 'Yes, I trust this folder');
		await outcome(s.el, /did not take/);
		expect(s.claims.claimTrust(PANE_KEY)).toBe(false);
		expect(s.sim.keys.filter((key) => key === 'enter')).toHaveLength(1);
	});

	it('gives the claim back when the press sent nothing', async () => {
		const s = await setup(trustDialog(CWD));
		atPrompt(s);
		await ready(s.el, 'Claude is asking whether to trust this folder');
		// The prompt went before the press: refused with nothing sent.
		s.sim.dialog = { kind: 'composer' };
		press(s.el, 'Yes, I trust this folder');
		await vi.waitFor(() => expect(said(s.el)).toMatch(/different dialog|Could not read|Stopped/));
		expect(s.sim.keys).toEqual([]);
		expect(s.claims.claimTrust(PANE_KEY)).toBe(true);
	});
});
