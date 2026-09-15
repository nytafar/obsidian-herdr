/**
 * The waiting card (#99): what the native view shows while the agent is
 * blocked, and the two things it may press.
 *
 * The same fakes as `tests/nativeSurface.test.ts` — a session model driven by
 * hand, the DOM harness, the recording `MarkdownRenderer` — plus a fake key
 * sender, which is the whole of what "Allow" is.
 *
 * The transcripts the cases are worked from are real: the scratch pane of the
 * 2026-09-15 verification (`docs/architecture.md`, "What a bare Enter selects
 * on each of Claude's blocking dialogs") blocked on `Bash echo permission-test`,
 * asked the tea-or-coffee question and offered a one-line plan, and those are
 * the inputs below.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostEl, type FakeElement } from './fixtures/dom';
import { MarkdownRenderer } from './fixtures/obsidian';
import { NativePaneSurface } from '../src/native/surface';
import {
	emptyTranscript,
	type ToolEntry,
	type TranscriptState,
	type Turn,
} from '../src/native/reducer';
import type {
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from '../src/native/sessionModel';
import type { AgentStatus } from '../src/herdr/types.gen';
import type { App } from 'obsidian';

/** A session model a test drives by hand (as in `tests/nativeSurface.test.ts`). */
class FakeModel implements SessionModelView {
	state: TranscriptState = emptyTranscript();
	/** Null is "no transcript yet", which is the startup card's whole condition. */
	path: string | null = null;
	/** False until the tail has delivered a line, as the real model's is (#99). */
	loaded = false;
	agentSession = '';
	agentStatus: AgentStatus = 'idle';
	private readonly listeners = new Set<(change: SessionChange) => void>();

	on(listener: (change: SessionChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** herdr's status moved, with whatever the transcript holds by then. */
	setStatus(status: AgentStatus): void {
		this.agentStatus = status;
		for (const listener of [...this.listeners]) listener({ changedTurnIds: [], reset: false });
	}

	/** A transcript line landed: new turns, then the change. */
	push(turns: Turn[], changedTurnIds: string[] = turns.map((t) => t.id)): void {
		this.state = { ...this.state, turns };
		this.path = this.path ?? '/transcript.jsonl';
		// Lines have been delivered, which is the whole of what `loaded` says.
		this.loaded = true;
		for (const listener of [...this.listeners]) listener({ changedTurnIds, reset: false });
	}

	/**
	 * herdr named the session, so the path is known — and nothing has been read
	 * from it yet. The state a view is in for as long as the first read takes.
	 */
	setPath(path: string): void {
		this.path = path;
		for (const listener of [...this.listeners]) listener({ changedTurnIds: [], reset: false });
	}
}

class FakeModels implements SessionModels {
	constructor(readonly model: FakeModel) {}
	acquire(): SessionHandleOf<SessionModelView> {
		return { model: this.model, release: () => {} };
	}
}

/** Every `agent.send_keys` the surface asked for. */
interface FakeKeys {
	calls: { paneId: string; keys: string[] }[];
	fail: string | null;
}

const VAULT = '/home/lasse/hvelv';

async function surfaceOn(
	model: FakeModel,
	options: { autoAccept?: boolean } = {},
): Promise<{
	surface: NativePaneSurface;
	el: FakeElement;
	keys: FakeKeys;
	notices: string[];
	openInTerminal: ReturnType<typeof vi.fn>;
}> {
	const { el, host } = hostEl();
	const app = { workspace: { openLinkText: vi.fn() } } as unknown as App;
	const keys: FakeKeys = { calls: [], fail: null };
	const notices: string[] = [];
	const openInTerminal = vi.fn();
	const surface = new NativePaneSurface({
		app,
		identity: { paneId: 'w4:p1', mode: 'control', endpointId: 'local' },
		onStatus: () => {},
		models: new FakeModels(model),
		sender: { send: async () => {} },
		keySender: {
			sendKeys: async (paneId: string, sent: readonly string[]) => {
				keys.calls.push({ paneId, keys: [...sent] });
				if (keys.fail) throw new Error(keys.fail);
			},
		},
		notify: (message) => notices.push(message),
		openInTerminal,
		// Off by default, as the setting is (#99).
		autoAcceptPermissions: () => options.autoAccept ?? false,
		presentation: () => 'highlight',
		vaultPath: () => VAULT,
	});
	await surface.attach(host);
	return { surface, el, keys, notices, openInTerminal };
}

/** A tool call as the reducer hands it over: pending until a result answers it. */
function tool(
	id: string,
	name: string,
	input: Record<string, unknown> = {},
	result: string | null = null,
): ToolEntry {
	return {
		kind: 'tool',
		id,
		name,
		input,
		result,
		status: result === null ? 'pending' : 'done',
		notification: null,
		report: null,
	};
}

function turn(id: string, prompt: string, entries: Turn['entries'] = []): Turn {
	return { id, prompt, entries, headings: [] };
}

/** The card, or null when the view is showing none. */
function card(el: FakeElement): FakeElement | null {
	return el.findAll('herdr-native-waiting')[0] ?? null;
}

function title(el: FakeElement): string {
	return el.find('herdr-native-waiting-title').textContent;
}

function buttonLabels(el: FakeElement): string[] {
	return el.find('herdr-native-waiting').findAll('herdr-native-waiting-action').map(
		(button) => button.textContent,
	);
}

beforeEach(() => {
	MarkdownRenderer.reset();
});

describe('waiting card: which kind (#99)', () => {
	it('is the startup card when there is no transcript yet', async () => {
		// A new directory blocks at startup with the workspace trust prompt, before
		// any session or file exists (`docs/architecture.md`).
		const model = new FakeModel();
		const { el } = await surfaceOn(model);

		model.setStatus('blocked');

		const shown = card(el);
		expect(shown).not.toBeNull();
		expect(title(el)).toBe('Claude is asking whether to trust this folder');
		// A bare enter here is "No, exit", so there is nothing but the terminal.
		expect(buttonLabels(el)).toEqual(['Open in terminal']);
	});

	it('names the tool of the last tool_use with no result, and offers Allow', async () => {
		const model = new FakeModel();
		const { el } = await surfaceOn(model);

		model.push([
			turn('u1', 'Run the shell command `echo permission-test` with the Bash tool.', [
				tool('toolu_01XB', 'Bash', {
					command: 'echo permission-test',
					description: 'Echo a test string',
				}),
			]),
		]);
		model.setStatus('blocked');

		expect(title(el)).toBe('Claude wants to use Bash');
		// The detail line is the tool group's own formatting, reused (#95).
		expect(el.find('herdr-native-waiting-body').textContent).toBe('echo permission-test');
		expect(buttonLabels(el)).toEqual(['Allow', 'Open in terminal']);
	});

	it('shows the question and its options for AskUserQuestion, with no Allow', async () => {
		const model = new FakeModel();
		const { el } = await surfaceOn(model);

		model.push([
			turn('u1', 'Ask me whether I prefer tea or coffee.', [
				tool('toolu_01Gw', 'AskUserQuestion', {
					questions: [
						{
							question: 'Do you prefer tea or coffee?',
							header: 'Beverage',
							multiSelect: false,
							options: [
								{ label: 'Tea', description: 'You prefer tea.' },
								{ label: 'Coffee', description: 'You prefer coffee.' },
							],
						},
					],
				}),
			]),
		]);
		model.setStatus('blocked');

		expect(title(el)).toBe('Claude asked a question');
		expect(el.find('herdr-native-waiting-body').textContent).toBe(
			'Do you prefer tea or coffee?',
		);
		expect(el.findAll('herdr-native-waiting-option').map((o) => o.textContent)).toEqual([
			'Tea',
			'Coffee',
		]);
		// Enter would choose the first answer, and answering is never "Allow".
		expect(buttonLabels(el)).toEqual(['Open in terminal']);
	});

	it('shows the plan for ExitPlanMode, with no Allow', async () => {
		const model = new FakeModel();
		const { el } = await surfaceOn(model);

		model.push([
			turn('u1', 'Write a one-line plan, then use the ExitPlanMode tool.', [
				tool('toolu_01Rr', 'Write', { file_path: '/home/lasse/.claude/plans/p.md' }, 'File created'),
				tool('toolu_01JU', 'ExitPlanMode', {
					plan: 'Create `d.txt` in /tmp/herdr-perm-FJK7 with the Write tool.\n',
					planFilePath: '/home/lasse/.claude/plans/p.md',
				}),
			]),
		]);
		model.setStatus('blocked');

		expect(title(el)).toBe('Claude is ready to code');
		expect(el.find('herdr-native-waiting-body').textContent).toBe(
			'Create `d.txt` in /tmp/herdr-perm-FJK7 with the Write tool.',
		);
		// Enter here switches the session to auto mode, a lasting side effect.
		expect(buttonLabels(el)).toEqual(['Open in terminal']);
	});

	it('is a permission with no tool named when every call has landed', async () => {
		const model = new FakeModel();
		const { el } = await surfaceOn(model);

		model.push([
			turn('u1', 'Run it', [tool('toolu_01XB', 'Bash', { command: 'echo hi' }, 'hi')]),
		]);
		model.setStatus('blocked');

		expect(title(el)).toBe('Claude is waiting for permission');
		expect(el.findAll('herdr-native-waiting-body')).toEqual([]);
		expect(buttonLabels(el)).toEqual(['Allow', 'Open in terminal']);
	});
});

describe('waiting card: what it presses (#99)', () => {
	it('sends a bare enter to the pane when Allow is pressed', async () => {
		const model = new FakeModel();
		const { el, keys } = await surfaceOn(model);
		model.push([turn('u1', 'Run it', [tool('toolu_01XB', 'Bash', { command: 'echo hi' })])]);
		model.setStatus('blocked');

		el.find('herdr-native-waiting-allow').dispatch('click');
		await Promise.resolve();

		// The first option of a Bash or Write permission is "Yes": it allows the
		// call once and changes no mode (`docs/architecture.md`).
		expect(keys.calls).toEqual([{ paneId: 'w4:p1', keys: ['Enter'] }]);
	});

	it('says so as a notice when the enter does not get through', async () => {
		const model = new FakeModel();
		const { el, keys, notices } = await surfaceOn(model);
		keys.fail = 'pane is gone';
		model.push([turn('u1', 'Run it', [tool('toolu_01XB', 'Bash', { command: 'echo hi' })])]);
		model.setStatus('blocked');

		el.find('herdr-native-waiting-allow').dispatch('click');
		await Promise.resolve();
		await Promise.resolve();

		expect(notices).toEqual(['Herdr: could not allow the tool call (pane is gone)']);
	});

	it('switches the tab to a terminal when Open in terminal is pressed', async () => {
		const model = new FakeModel();
		const { el, openInTerminal } = await surfaceOn(model);
		model.setStatus('blocked');

		el.find('herdr-native-waiting-terminal').dispatch('click');

		expect(openInTerminal).toHaveBeenCalledTimes(1);
	});

	it('stands in for the prompt box while the block lasts', async () => {
		const model = new FakeModel();
		const { el } = await surfaceOn(model);
		const box = el.find('herdr-native-prompt-box');
		expect(box.hasClass('herdr-is-hidden')).toBe(false);

		model.setStatus('blocked');
		expect(box.hasClass('herdr-is-hidden')).toBe(true);

		model.setStatus('working');
		expect(card(el)).toBeNull();
		expect(box.hasClass('herdr-is-hidden')).toBe(false);
	});
});

describe('waiting card: auto-accept permissions (#99)', () => {
	it('presses Allow once for a permission block, however often it is drawn', async () => {
		const model = new FakeModel();
		const { keys } = await surfaceOn(model, { autoAccept: true });
		model.push([turn('u1', 'Run it', [tool('toolu_01XB', 'Bash', { command: 'echo hi' })])]);

		model.setStatus('blocked');
		// More of the transcript lands under the same block: the card is drawn
		// again, and the block is still the one that was pressed.
		model.push([
			turn('u1', 'Run it', [
				{ kind: 'text', messageId: 'm1', text: 'Running it.' },
				tool('toolu_01XB', 'Bash', { command: 'echo hi' }),
			]),
		]);
		await Promise.resolve();

		expect(keys.calls).toEqual([{ paneId: 'w4:p1', keys: ['Enter'] }]);
	});

	it('presses again for the next block', async () => {
		const model = new FakeModel();
		const { keys } = await surfaceOn(model, { autoAccept: true });
		model.push([turn('u1', 'Run it', [tool('toolu_01XB', 'Bash', { command: 'echo one' })])]);
		model.setStatus('blocked');

		model.setStatus('working');
		model.push([
			turn('u1', 'Run it', [
				tool('toolu_01XB', 'Bash', { command: 'echo one' }, 'one'),
				tool('toolu_02YC', 'Bash', { command: 'echo two' }),
			]),
		]);
		model.setStatus('blocked');
		await Promise.resolve();

		expect(keys.calls).toHaveLength(2);
	});

	it('never presses for a question, a plan or the startup prompt', async () => {
		for (const entries of [
			[],
			[tool('toolu_01Gw', 'AskUserQuestion', { questions: [{ question: 'Tea?' }] })],
			[tool('toolu_01JU', 'ExitPlanMode', { plan: 'Write d.txt.' })],
		]) {
			const model = new FakeModel();
			const { keys } = await surfaceOn(model, { autoAccept: true });
			if (entries.length > 0) model.push([turn('u1', 'Ask me', entries)]);
			model.setStatus('blocked');
			await Promise.resolve();

			expect(keys.calls).toEqual([]);
		}
	});

	it('presses nothing until the transcript has been read, path or no path', async () => {
		const model = new FakeModel();
		const { el, keys } = await surfaceOn(model, { autoAccept: true });

		// herdr has named the agent session, so the model knows the file — and the
		// tail has delivered nothing from it yet. Every call in it is unread, so
		// the card can only fall back to "waiting for permission", which is the
		// one card auto-accept presses.
		model.setPath('/transcript.jsonl');
		model.setStatus('blocked');
		await Promise.resolve();

		expect(title(el)).toBe('Claude is waiting for permission');
		expect(keys.calls).toEqual([]);

		// What the block was all along: plan approval, where a bare Enter switches
		// the session to auto mode (`docs/architecture.md`).
		model.push([
			turn('u1', 'Write a plan', [tool('toolu_01JU', 'ExitPlanMode', { plan: 'Write d.txt.' })]),
		]);
		await Promise.resolve();

		expect(title(el)).toBe('Claude is ready to code');
		expect(keys.calls).toEqual([]);
	});

	it('presses nothing while the setting is off, which is its default', async () => {
		const model = new FakeModel();
		const { keys } = await surfaceOn(model);
		model.push([turn('u1', 'Run it', [tool('toolu_01XB', 'Bash', { command: 'echo hi' })])]);

		model.setStatus('blocked');
		await Promise.resolve();

		expect(keys.calls).toEqual([]);
	});
});
