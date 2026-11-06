/**
 * What the native view, the table of contents and find say about the turns a
 * session model does not hold (issue #152), and the button that loads them.
 * The model's side, the window and the read that loads another page, is
 * `tests/sessionWindow.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostEl, type FakeElement } from './fixtures/dom';
import { MarkdownRenderer } from './fixtures/obsidian';
import { NativePaneSurface } from '../src/native/surface';
import { TocPanel, type ActiveLeafFacts } from '../src/native/tocView';
import { findEmptyText } from '../src/native/conversationFind';
import { earlierLine, LOAD_EARLIER, LOADING_EARLIER } from '../src/native/earlierTurns';
import { emptyTranscript, type TranscriptState } from '../src/agents/claude/transcript';
import { turnWindow, type Turn } from '../src/native/conversation';
import type {
	BlockKind,
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from '../src/native/sessionModel';
import type { AgentStatus } from '../src/herdr/types.gen';
import type { App, WorkspaceLeaf } from 'obsidian';

/** A model holding some turns and naming earlier ones, driven by hand. */
class FakeModel implements SessionModelView {
	state: TranscriptState = emptyTranscript();
	path: string | null = '/transcript.jsonl';
	loaded = true;
	agentSession = 'session-1';
	agentStatus: AgentStatus = 'idle';
	blockKind: BlockKind | null = null;
	connected = true;
	loadingEarlier = false;
	loads = 0;
	private readonly listeners = new Set<(change: SessionChange) => void>();

	loadEarlier(): void {
		this.loads++;
	}

	on(listener: (change: SessionChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	claimBlock(): boolean {
		return true;
	}

	/** Holds `turns`, with `earlier` turns before them not held. */
	hold(turns: Turn[], earlier: number, change: SessionChange = { changedTurnIds: [], reset: true }): void {
		const window = turnWindow();
		window.earlier = Array.from({ length: earlier }, (_, i) => `old-${i}`);
		this.state = { ...this.state, turns, window };
		for (const listener of [...this.listeners]) listener(change);
	}
}

class FakeModels implements SessionModels {
	released = 0;
	constructor(readonly model: FakeModel) {}
	acquire(): SessionHandleOf<SessionModelView> {
		return { model: this.model, release: () => this.released++ };
	}
}

function turn(id: string, prompt: string): Turn {
	return { id, prompt, entries: [], headings: [] };
}

function surfaceOn(model: FakeModel): { surface: NativePaneSurface; el: FakeElement; host: HTMLElement } {
	const { el, host } = hostEl();
	const app = { workspace: { openLinkText: () => {} }, vault: { getConfig: () => false, on: () => null, offref: () => {} } };
	const surface = new NativePaneSurface({
		app: app as unknown as App,
		identity: { paneId: 'w4:p1', mode: 'control', endpointId: 'local' },
		onStatus: () => {},
		models: new FakeModels(model),
		sender: { send: async () => {} },
		keySender: { sendKeys: async () => {} },
		openInTerminal: () => {},
		autoTrustFolders: () => false,
		presentation: () => 'highlight',
		vaultPath: () => '',
	});
	return { surface, el, host };
}

const bar = (el: FakeElement): FakeElement => el.find('herdr-native-earlier-view');
const turnsEl = (el: FakeElement): FakeElement => el.find('herdr-native-turns');
/** The sizer the turns are drawn into: the scroll container's one child. */
const sizer = (el: FakeElement): FakeElement => turnsEl(el).children[0] as FakeElement;

beforeEach(() => {
	MarkdownRenderer.reset();
});

describe('the native view: earlier turns not loaded (#152)', () => {
	it('says nothing for a session held whole', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'One')] };
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		expect(bar(el).hasClass('herdr-is-hidden')).toBe(true);
	});

	it('says how many earlier turns are not loaded, above the first turn, and loads them on a click', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		model.hold([turn('u8', 'Eight'), turn('u9', 'Nine')], 7);

		expect(bar(el).hasClass('herdr-is-hidden')).toBe(false);
		expect(bar(el).find('herdr-native-earlier-text').textContent).toBe('7 earlier turns are not loaded.');
		// First in the sizer, before every turn, and still there after a full redraw.
		expect(sizer(el).children[0]).toBe(bar(el));
		model.hold([turn('u9', 'Nine'), turn('u10', 'Ten')], 8);
		expect(sizer(el).children[0]).toBe(bar(el));
		expect(sizer(el).findAll('herdr-native-turn')).toHaveLength(2);

		const button = bar(el).find('herdr-native-earlier-load');
		expect(button.textContent).toBe(LOAD_EARLIER);
		button.dispatch('click');
		expect(model.loads).toBe(1);

		// While it reads, the button says so and cannot be pressed again.
		model.loadingEarlier = true;
		model.hold(model.state.turns, 8, { changedTurnIds: [], reset: false });
		expect(button.textContent).toBe(LOADING_EARLIER);
		expect(button.disabled).toBe(true);
	});

	it('keeps the reader’s place when earlier turns arrive, where a new session goes to the end', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		model.hold([turn('u8', 'Eight'), turn('u9', 'Nine')], 7);
		const scroller = turnsEl(el);
		scroller.scrollHeight = 5000;
		scroller.clientHeight = 500;
		scroller.scrollTop = 0;
		// The reader scrolled up to the top, to the button.
		scroller.dispatch('scroll');

		model.loadingEarlier = false;
		model.hold([turn('u5', 'Five'), turn('u6', 'Six'), turn('u7', 'Seven'), turn('u8', 'Eight'), turn('u9', 'Nine')], 4, {
			changedTurnIds: [],
			reset: true,
			earlier: true,
		});
		expect(sizer(el).findAll('herdr-native-turn')).toHaveLength(5);
		expect(scroller.scrollTop).toBe(0);
		expect(bar(el).find('herdr-native-earlier-text').textContent).toBe('4 earlier turns are not loaded.');

		model.hold([turn('n1', 'New session')], 0);
		expect(scroller.scrollTop).toBe(4500);
		expect(bar(el).hasClass('herdr-is-hidden')).toBe(true);
	});
});

describe('find and the table of contents: earlier turns not loaded (#152)', () => {
	it('find says the earlier turns were not searched', () => {
		expect(findEmptyText(0)).toBe('No matches.');
		expect(findEmptyText(1)).toBe('No matches. 1 earlier turn is not loaded. Load them to search them.');
		expect(earlierLine(12)).toBe('12 earlier turns are not loaded.');
	});

	function panelWith(model: FakeModel, shown: () => boolean): { panel: TocPanel; el: FakeElement; models: FakeModels } {
		const { el, host } = hostEl();
		const models = new FakeModels(model);
		const leaf = { name: 'native' } as unknown as WorkspaceLeaf;
		const facts: ActiveLeafFacts = { inMainArea: true, nativePaneId: 'w4:p1', nativeEndpointId: 'local' };
		const panel = new TocPanel({
			models,
			facts: () => facts,
			scrollToTurn: vi.fn(),
			scrollToHeading: vi.fn(),
			shown,
		});
		panel.mount(host);
		panel.activeLeafChanged(leaf);
		return { panel, el, models };
	}

	it('the table of contents says what is not loaded, ahead of the turns, and loads it', () => {
		const model = new FakeModel();
		const { el } = panelWith(model, () => true);
		model.hold([turn('u8', 'Eight')], 7);
		const row = el.find('herdr-toc-earlier');
		expect(row.find('herdr-native-earlier-text').textContent).toBe('7 earlier turns are not loaded.');
		expect(el.find('herdr-toc').children[0]).toBe(row);
		expect(el.findAll('herdr-toc-item').map((item) => item.textContent)).toEqual(['Eight']);
		row.find('herdr-native-earlier-load').dispatch('click');
		expect(model.loads).toBe(1);
	});

	it('lets the model go once no native view shows its pane', () => {
		const model = new FakeModel();
		let shown = true;
		const { panel, el, models } = panelWith(model, () => shown);
		panel.layoutChanged();
		expect(models.released).toBe(0);
		shown = false;
		panel.layoutChanged();
		expect(models.released).toBe(1);
		expect(el.find('herdr-toc-empty').textContent).toBe('No native view is active.');
	});
});
