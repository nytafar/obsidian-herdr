/**
 * What the native surface and the table of contents draw for the transcript
 * shapes the native view once misread (issues #129–#135): a
 * picture sent with a prompt, a compaction, turns a rewind dropped, the
 * runtime's notices, a bash-mode exchange and background work that was lost.
 *
 * The reducer's side is `tests/transcriptShapes.test.ts`; here the turns are
 * handed over as the reducer would, through a fake session model, and what is
 * asserted is the DOM (`tests/fixtures/dom.ts`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostEl, type FakeElement } from './fixtures/dom';
import { MarkdownRenderer } from './fixtures/obsidian';
import { NativePaneSurface } from '../src/native/surface';
import { TocPanel } from '../src/native/tocView';
import { TurnRenderer } from '../src/native/turnRenderer';
import { FoldMemory } from '../src/native/foldMemory';
import { emptyTranscript, type TranscriptState, type Turn } from '../src/native/reducer';
import type {
	BlockKind,
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from '../src/native/sessionModel';
import type { AgentStatus } from '../src/herdr/types.gen';
import type { App, WorkspaceLeaf } from 'obsidian';

/** A session model a test drives by hand, as in `tests/nativeSurface.test.ts`. */
class FakeModel implements SessionModelView {
	state: TranscriptState = emptyTranscript();
	path: string | null = '/transcript.jsonl';
	loaded = true;
	agentSession = 's1';
	agentStatus: AgentStatus = 'idle';
	blockKind: BlockKind | null = null;
	connected = true;
	private readonly listeners = new Set<(change: SessionChange) => void>();

	on(listener: (change: SessionChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	claimBlock(): boolean {
		return true;
	}

	/** New turns, then the change that says which of them moved. */
	push(turns: Turn[], change: SessionChange): void {
		this.state = { ...this.state, turns };
		for (const listener of [...this.listeners]) listener(change);
	}
}

function modelsOf(model: FakeModel): SessionModels {
	return {
		acquire: (): SessionHandleOf<SessionModelView> => ({ model, release: () => {} }),
	};
}

function turn(id: string, prompt: string, entries: Turn['entries'] = []): Turn {
	return { id, prompt, entries, headings: [] };
}

async function surfaceOn(model: FakeModel): Promise<FakeElement> {
	const { el, host } = hostEl();
	const app = {
		workspace: { openLinkText: vi.fn() },
		vault: { getConfig: () => false, on: () => null, offref: () => {} },
	} as unknown as App;
	const surface = new NativePaneSurface({
		app,
		identity: { paneId: 'w4:p1', mode: 'control', endpointId: 'local' },
		onStatus: () => {},
		models: modelsOf(model),
		sender: { send: async () => {} },
		keySender: { sendKeys: async () => {} },
		openInTerminal: () => {},
		autoTrustFolders: () => false,
		presentation: () => 'highlight',
		vaultPath: () => '/vault',
	});
	await surface.attach(host);
	return el;
}

/** The TOC following the model's pane, and what its rows say. */
function tocOn(model: FakeModel): { rows: () => string[] } {
	const { el, host } = hostEl();
	const leaf = {} as WorkspaceLeaf;
	const panel = new TocPanel({
		models: modelsOf(model),
		facts: () => ({ inMainArea: true, nativePaneId: 'w4:p1', nativeEndpointId: 'local' }),
		scrollToTurn: () => {},
		scrollToHeading: () => {},
	});
	panel.mount(host);
	panel.activeLeafChanged(leaf);
	return { rows: () => el.findAll('herdr-toc-item').map((row) => row.textContent) };
}

beforeEach(() => {
	MarkdownRenderer.reset();
});

describe('a picture sent with a prompt (#129)', () => {
	it('draws a placeholder under the prompt, before the reply', async () => {
		const model = new FakeModel();
		const el = await surfaceOn(model);

		model.push(
			[
				turn('u1', '[Image #3]', [
					{ kind: 'image', id: 'u1#0', record: 'u1', index: 0, mediaType: 'image/png' },
					{ kind: 'text', messageId: 'm1', text: 'It works.' },
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		const turnEl = el.find('herdr-native-turn');
		expect(turnEl.children.map((child) => [...child.classList][0])).toEqual([
			'herdr-native-prompt',
			'herdr-native-image',
			'herdr-native-block',
			'herdr-native-reply-actions',
		]);
		expect(turnEl.find('herdr-native-image').textContent).toBe('Image (PNG)');
	});

	it('names a prompt that was only a picture in the TOC', () => {
		const model = new FakeModel();
		const toc = tocOn(model);

		model.push([turn('u1', '', [{ kind: 'image', id: 'u1#0', record: 'u1', index: 0, mediaType: 'image/jpeg' }])], {
			changedTurnIds: ['u1'],
			reset: false,
		});

		expect(toc.rows()).toEqual(['Image']);
	});
});

describe('a compaction (#130)', () => {
	const summary = 'Summary:\n1. **Primary request**';

	it('draws a slim divider that opens to the summary, rendered on the first open', async () => {
		const model = new FakeModel();
		const el = await surfaceOn(model);

		model.push(
			[
				turn('u1', 'Refactor it', [
					{ kind: 'text', messageId: 'm1', text: 'Starting.' },
					{ kind: 'compaction', summary },
					{ kind: 'text', messageId: 'm2', text: 'Carrying on.' },
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		const divider = el.find('herdr-native-compaction');
		expect(divider.tag).toBe('details');
		expect(divider.find('herdr-native-compaction-summary').textContent).toBe('Context compacted');
		expect(MarkdownRenderer.calls.map((call) => call.markdown)).toEqual(['Starting.', 'Carrying on.']);

		(divider as unknown as { open: boolean }).open = true;
		divider.dispatch('toggle');
		divider.dispatch('toggle');

		expect(MarkdownRenderer.calls.map((call) => call.markdown)).toEqual([
			'Starting.',
			'Carrying on.',
			summary,
		]);
		expect(divider.find('herdr-native-compaction-body').textContent).toBe(summary);
	});

	it('opens no TOC row, inside a turn or before the first prompt', () => {
		const model = new FakeModel();
		const toc = tocOn(model);

		model.push(
			[
				turn('m0', '', [{ kind: 'compaction', summary }]),
				turn('u1', 'Refactor it', [{ kind: 'compaction', summary }]),
			],
			{ changedTurnIds: ['m0', 'u1'], reset: false },
		);

		expect(toc.rows()).toEqual(['Refactor it']);
	});
});

describe('turns a rewind dropped (#131)', () => {
	it('takes them off the surface and draws the new branch after what stays', async () => {
		const model = new FakeModel();
		const el = await surfaceOn(model);
		model.push([turn('u1', 'apple'), turn('u2', 'banana')], { changedTurnIds: ['u1', 'u2'], reset: false });
		const kept = el.findAll('herdr-native-turn')[0];

		model.push([turn('u1', 'apple'), turn('u3', 'cherry')], {
			changedTurnIds: ['u3'],
			removedTurnIds: ['u2'],
			reset: false,
		});

		const turns = el.findAll('herdr-native-turn');
		expect(turns.map((turnEl) => turnEl.find('herdr-native-prompt').textContent)).toEqual(['apple', 'cherry']);
		expect(turns[0]).toBe(kept);
	});

	it('takes them out of the TOC', () => {
		const model = new FakeModel();
		const toc = tocOn(model);
		model.push([turn('u1', 'apple'), turn('u2', 'banana')], { changedTurnIds: ['u1', 'u2'], reset: false });

		model.push([turn('u3', 'cherry')], { changedTurnIds: ['u3'], removedTurnIds: ['u1', 'u2'], reset: false });

		expect(toc.rows()).toEqual(['cherry']);
	});
});

describe('a dropped turn in the renderer (#131)', () => {
	it('forgets what the reader opened in it', () => {
		const { el, host } = hostEl();
		const folds = new FoldMemory();
		const renderer = new TurnRenderer(host, {
			presentation: () => 'highlight',
			vaultPath: () => '/vault',
			renderMarkdown: () => Promise.resolve(),
			resolveUri: () => null,
			folds,
		});
		renderer.render(turn('u1', 'apple', [{ kind: 'thinking', messageId: 'm1', text: 'weighing' }]));
		folds.turn('u1').open.set('thinking:m1', true);

		renderer.remove('u1');

		expect(el.findAll('herdr-native-turn')).toEqual([]);
		expect(folds.turn('u1').open.size).toBe(0);
		expect(renderer.size).toBe(0);
	});
});

describe('the runtime’s notices and bash mode (#133)', () => {
	it('draws a notice where it was written, without splitting the tool group around it', async () => {
		const model = new FakeModel();
		const el = await surfaceOn(model);
		const read = (id: string): Turn['entries'][number] => ({
			kind: 'tool',
			id,
			name: 'Read',
			input: { file_path: '/vault/a.md' },
			result: 'ok',
			status: 'done',
			notification: null,
			report: null,
		});

		model.push(
			[
				turn('u1', 'Look', [
					read('t1'),
					{ kind: 'notice', text: 'Usage limit reached', at: '' },
					read('t2'),
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		const turnEl = el.find('herdr-native-turn');
		expect(turnEl.findAll('herdr-native-tools')).toHaveLength(1);
		expect(turnEl.find('herdr-native-notice').textContent).toBe('Usage limit reached');
	});

	it('draws a bash-mode command and its output, stderr apart', async () => {
		const model = new FakeModel();
		const el = await surfaceOn(model);

		model.push(
			[turn('u1', '', [{ kind: 'shell', command: 'ls', stdout: 'a\nb', stderr: 'ls: c: no such file' }])],
			{ changedTurnIds: ['u1'], reset: false },
		);

		const shell = el.find('herdr-native-shell');
		expect(shell.find('herdr-native-shell-command').textContent).toBe('! ls');
		const outputs = shell.findAll('herdr-native-shell-output');
		expect(outputs.map((output) => output.textContent)).toEqual(['a\nb', 'ls: c: no such file']);
		expect(outputs[1]?.hasClass('is-error')).toBe(true);
		expect(el.findAll('herdr-native-prompt')).toEqual([]);
	});

	it('lists a bash-mode command in the TOC, and nothing for notices', () => {
		const model = new FakeModel();
		const toc = tocOn(model);

		model.push(
			[
				turn('n0', '', [{ kind: 'notice', text: 'Your organization may apply configuration', at: '' }]),
				turn('u1', 'Look', [{ kind: 'notice', text: 'Usage limit reached', at: '' }]),
				turn('u2', '', [{ kind: 'shell', command: 'ls -la', stdout: null, stderr: '' }]),
			],
			{ changedTurnIds: ['n0', 'u1', 'u2'], reset: false },
		);

		expect(toc.rows()).toEqual(['Look', '! ls -la']);
	});
});

describe('background work left behind (#135)', () => {
	it('says in the tool group what was lost, and strikes its row', async () => {
		const model = new FakeModel();
		const el = await surfaceOn(model);

		model.push(
			[
				turn('u1', 'Start it', [
					{
						kind: 'tool',
						id: 't1',
						name: 'Bash',
						input: { command: 'sleep 600', run_in_background: true },
						result: 'Command running in background with ID: b1.',
						status: 'lost',
						notification: null,
						report: null,
					},
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		const group = el.find('herdr-native-tools');
		expect(group.find('herdr-native-tools-failed').textContent).toBe('1 lost');
		expect(group.find('herdr-native-tool').hasClass('is-lost')).toBe(true);
	});
});
