/**
 * The native surface's rendering (issues #93 and #94, ADR-0002, ADR-0003).
 *
 * A fake session model in place of a transcript, the DOM harness in place of a
 * document (`tests/fixtures/dom.ts`) and the recording `MarkdownRenderer` from
 * `tests/fixtures/obsidian.ts`: what is asserted is what the surface draws per
 * turn, which is the one thing about the native view that no other test covers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostEl, type FakeElement } from './fixtures/dom';
import { MarkdownRenderer } from './fixtures/obsidian';
import { NativePaneSurface } from '../src/native/surface';
import { emptyTranscript, type TranscriptState, type Turn } from '../src/native/reducer';
import type {
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from '../src/native/sessionModel';
import type { AgentStatus } from '../src/herdr/types.gen';
import type { App } from 'obsidian';

/** A session model a test drives by hand. */
class FakeModel implements SessionModelView {
	state: TranscriptState = emptyTranscript();
	path: string | null = null;
	agentSession = '';
	agentStatus: AgentStatus = 'idle';
	private readonly listeners = new Set<(change: SessionChange) => void>();

	on(listener: (change: SessionChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** What the model does when the reducer moved: new state, then the change. */
	push(turns: Turn[], change: SessionChange): void {
		this.state = { ...this.state, turns };
		this.path = this.path ?? '/transcript.jsonl';
		for (const listener of [...this.listeners]) listener(change);
	}
}

class FakeModels implements SessionModels {
	readonly acquired: string[] = [];
	released = 0;
	constructor(readonly model: FakeModel) {}
	acquire(paneId: string): SessionHandleOf<SessionModelView> {
		this.acquired.push(paneId);
		return {
			model: this.model,
			release: () => {
				this.released++;
			},
		};
	}
}

function turn(id: string, prompt: string, entries: Turn['entries'] = []): Turn {
	return { id, prompt, entries };
}

function surfaceOn(model: FakeModel): {
	surface: NativePaneSurface;
	models: FakeModels;
	el: FakeElement;
	host: HTMLElement;
	openLinkText: ReturnType<typeof vi.fn>;
} {
	const { el, host } = hostEl();
	const models = new FakeModels(model);
	const openLinkText = vi.fn();
	const app = { workspace: { openLinkText } } as unknown as App;
	const surface = new NativePaneSurface({
		app,
		identity: { paneId: 'w4:p1', mode: 'control', endpointId: 'local' },
		onStatus: () => {},
		models,
	});
	return { surface, models, el, host, openLinkText };
}

beforeEach(() => {
	MarkdownRenderer.reset();
});

describe('NativePaneSurface: no session yet', () => {
	it('says so, and shows no turns', async () => {
		const model = new FakeModel();
		const { surface, el, host, models } = surfaceOn(model);

		await surface.attach(host);

		expect(models.acquired).toEqual(['w4:p1']);
		expect(el.find('herdr-native-empty').textContent).toBe('No session yet.');
		expect(el.findAll('herdr-native-turn')).toEqual([]);
	});
});

describe('NativePaneSurface: a turn', () => {
	it('renders the human prompt as plain text and the assistant prose as Markdown', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);

		model.push(
			[
				turn('u1', 'Summarise the design', [
					{ kind: 'text', messageId: 'm1', text: 'It settles **two** seams.' },
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		const turns = el.findAll('herdr-native-turn');
		expect(turns).toHaveLength(1);
		expect(turns[0]?.find('herdr-native-prompt').textContent).toBe('Summarise the design');
		// The prose goes through Obsidian's own renderer, so wikilinks, callouts
		// and embeds are the app's business and not this file's.
		expect(MarkdownRenderer.calls.map((call) => call.markdown)).toEqual([
			'It settles **two** seams.',
		]);
		expect(turns[0]?.find('herdr-native-block').textContent).toBe('It settles **two** seams.');
		expect(el.findAll('herdr-native-empty')).toEqual([]);
	});

	it('linkifies a wikilink in the prompt and opens it when it is clicked', async () => {
		const model = new FakeModel();
		const { surface, el, host, openLinkText } = surfaceOn(model);
		await surface.attach(host);

		model.push([turn('u1', 'Read [[native-view-design|the design]] first')], {
			changedTurnIds: ['u1'],
			reset: false,
		});

		const prompt = el.find('herdr-native-prompt');
		const link = prompt.find('internal-link');
		expect(link.tag).toBe('a');
		expect(link.textContent).toBe('the design');
		expect(link.attrs['data-href']).toBe('native-view-design');
		// The text around the link survives, whitespace and all.
		expect(prompt.textContent).toBe('Read the design first');

		link.dispatch('click');

		expect(openLinkText).toHaveBeenCalledWith('native-view-design', '', false);
	});

	it('shows tool calls, thinking and steers as placeholders', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);

		model.push(
			[
				turn('u1', 'Run it', [
					{ kind: 'thinking', messageId: 'm1' },
					{ kind: 'tool', id: 't1', name: 'Bash', result: 'ok' },
					{ kind: 'steer', text: 'and check the styles' },
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		expect(el.findAll('herdr-native-aside').map((aside) => aside.textContent)).toEqual([
			'Thinking',
			'Bash',
		]);
		expect(el.find('herdr-native-steer').textContent).toBe('and check the styles');
	});
});

describe('NativePaneSurface: keeping up', () => {
	it('redraws the turns that changed and leaves the rest standing', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		model.push([turn('u1', 'First')], { changedTurnIds: ['u1'], reset: false });
		const first = el.find('herdr-native-turn');

		model.push([turn('u1', 'First'), turn('u2', 'Second')], {
			changedTurnIds: ['u2'],
			reset: false,
		});

		const turns = el.findAll('herdr-native-turn');
		expect(turns).toHaveLength(2);
		expect(turns[0]).toBe(first);
		expect(turns[1]?.find('herdr-native-prompt').textContent).toBe('Second');
	});

	it('starts from empty on a reset', async () => {
		// Session following is strict: `/clear` empties the view (ADR-0003).
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		model.push([turn('u1', 'Before the clear')], { changedTurnIds: ['u1'], reset: false });

		model.push([], { changedTurnIds: [], reset: true });

		expect(el.findAll('herdr-native-turn')).toEqual([]);
		// The pane does have a session — a new one — so the empty line says that
		// rather than "no session yet".
		expect(el.find('herdr-native-empty').textContent).toBe('No turns in this session yet.');
	});
});

describe('NativePaneSurface: detach', () => {
	it('gives the model back and takes its element with it', async () => {
		const model = new FakeModel();
		const { surface, el, host, models } = surfaceOn(model);
		await surface.attach(host);
		model.push([turn('u1', 'First')], { changedTurnIds: ['u1'], reset: false });

		await surface.detach();

		expect(models.released).toBe(1);
		expect(el.children).toEqual([]);
		// Nothing arrives after a detach, and nothing is drawn if it does.
		model.push([turn('u2', 'After')], { changedTurnIds: ['u2'], reset: false });
		expect(el.children).toEqual([]);
	});
});

describe('NativePaneSurface: what the agent is doing (#94)', () => {
	it('says the agent is working, between blocks and while nothing arrives', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		model.push([turn('u1', 'Run it')], { changedTurnIds: ['u1'], reset: false });

		// herdr's `agent_status`, not anything read out of the transcript.
		model.agentStatus = 'working';
		model.push([turn('u1', 'Run it')], { changedTurnIds: [], reset: false });

		expect(el.find('herdr-native-status').textContent).toBe('Working…');
	});

	it('says nothing once the agent is idle or done', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		model.agentStatus = 'working';
		model.push([], { changedTurnIds: [], reset: false });
		expect(el.findAll('herdr-native-status')).toHaveLength(1);

		model.agentStatus = 'done';
		model.push([], { changedTurnIds: [], reset: false });

		expect(el.findAll('herdr-native-status')).toEqual([]);
	});

	it('says the agent is waiting when it is blocked', async () => {
		// The waiting card itself comes later; what #94 owes is that the state
		// shows at all.
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);

		model.agentStatus = 'blocked';
		model.push([], { changedTurnIds: [], reset: false });

		expect(el.find('herdr-native-status').textContent).toBe('Waiting for you.');
	});

	it('keeps its model and keeps up while the leaf is hidden', async () => {
		// A hidden tab keeps its subscription and catches up on reveal (ADR-0003);
		// there is no process to hand back, so hiding costs nothing to keep.
		const model = new FakeModel();
		const { surface, el, host, models } = surfaceOn(model);
		await surface.attach(host);

		await surface.setVisible(false);
		model.push([turn('u1', 'Arrived while hidden')], { changedTurnIds: ['u1'], reset: false });
		await surface.setVisible(true);

		expect(models.released).toBe(0);
		expect(el.find('herdr-native-prompt').textContent).toBe('Arrived while hidden');
	});
});
