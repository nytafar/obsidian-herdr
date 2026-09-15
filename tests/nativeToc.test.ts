/**
 * The table of contents sidebar (issue #100, ADR-0003).
 *
 * The panel is the whole view minus the `ItemView` wrapper: what it draws for a
 * session model, which model it follows as leaves come and go, and what a click
 * does. Fakes stand in for the workspace and the session models, the DOM
 * harness for a document and the `obsidian` stub for the rest, the way the
 * surface tests do (`tests/nativeSurface.test.ts`).
 */

import { describe, expect, it, vi } from 'vitest';
import { hostEl, type FakeElement } from './fixtures/dom';
import { TocPanel, tocTarget, type ActiveLeafFacts } from '../src/native/tocView';
import { emptyTranscript, type Turn, type TranscriptState } from '../src/native/reducer';
import type {
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from '../src/native/sessionModel';
import type { AgentStatus } from '../src/herdr/types.gen';
import type { WorkspaceLeaf } from 'obsidian';

/** A session model a test drives by hand, as in the surface tests. */
class FakeModel implements SessionModelView {
	state: TranscriptState = emptyTranscript();
	path: string | null = null;
	/** The tail has delivered the file's lines, as a read transcript has (#99). */
	loaded = false;
	agentSession = '';
	agentStatus: AgentStatus = 'idle';
	private readonly listeners = new Set<(change: SessionChange) => void>();

	on(listener: (change: SessionChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Puts turns in and tells the subscribers, as the real model does. */
	push(turns: Turn[]): void {
		this.state = { ...this.state, turns };
		for (const listener of [...this.listeners]) listener({ changedTurnIds: [], reset: false });
	}
}

/** One model per pane, with what was acquired and what was given back. */
class FakeModels implements SessionModels {
	private readonly byPane = new Map<string, FakeModel>();
	readonly acquired: string[] = [];
	readonly released: string[] = [];

	model(paneId: string): FakeModel {
		const existing = this.byPane.get(paneId);
		if (existing) return existing;
		const model = new FakeModel();
		this.byPane.set(paneId, model);
		return model;
	}

	acquire(paneId: string): SessionHandleOf<SessionModelView> {
		this.acquired.push(paneId);
		return {
			model: this.model(paneId),
			release: () => {
				this.released.push(paneId);
			},
		};
	}
}

/** A turn as the reducer hands it over, headings and all (#100). */
function turn(id: string, prompt: string, headings: Turn['headings'] = []): Turn {
	return { id, prompt, entries: [], headings };
}

/** A leaf is only an identity here; what is true of it comes from the map. */
function leafOf(name: string): WorkspaceLeaf {
	return { name } as unknown as WorkspaceLeaf;
}

function panelOn(
	models: FakeModels,
	facts: Map<WorkspaceLeaf, ActiveLeafFacts>,
): { panel: TocPanel; el: FakeElement; scrollToTurn: ReturnType<typeof vi.fn> } {
	const { el, host } = hostEl();
	const scrollToTurn = vi.fn();
	const panel = new TocPanel({
		models,
		facts: (leaf) => (leaf ? (facts.get(leaf) ?? null) : null),
		scrollToTurn,
	});
	panel.mount(host);
	return { panel, el, scrollToTurn };
}

/** What every clickable line in the list says, in order. */
function items(el: FakeElement): string[] {
	return el.findAll('herdr-toc-item').map((item) => item.textContent);
}

describe('tocTarget: which leaf the TOC follows (#100)', () => {
	it('follows a native view in the main area', () => {
		expect(tocTarget({ inMainArea: true, nativePaneId: 'w4:p1' })).toEqual({
			kind: 'follow',
			paneId: 'w4:p1',
		});
	});

	it('empties for a main-area leaf that is not a native view', () => {
		expect(tocTarget({ inMainArea: true, nativePaneId: '' })).toEqual({ kind: 'empty' });
	});

	it('keeps what it shows when its own leaf, or any leaf outside the main area, is activated', () => {
		// Clicking in the table of contents activates the TOC's own leaf. If that
		// emptied the list, the list could never be clicked twice.
		expect(tocTarget({ inMainArea: false, nativePaneId: '' })).toEqual({ kind: 'keep' });
		expect(tocTarget(null)).toEqual({ kind: 'keep' });
	});
});

describe('TocPanel', () => {
	it('says so while no native view is active', () => {
		const models = new FakeModels();
		const { el } = panelOn(models, new Map());

		expect(el.find('herdr-toc-empty').textContent).toBe('No native view is active.');
		expect(models.acquired).toEqual([]);
	});

	it('lists the turns of the active native view with their headings nested', () => {
		const models = new FakeModels();
		const leaf = leafOf('native');
		const { panel, el } = panelOn(
			models,
			new Map([[leaf, { inMainArea: true, nativePaneId: 'w4:p1' }]]),
		);
		models.model('w4:p1').state = {
			...emptyTranscript(),
			turns: [
				turn('u1', 'Write up the seam', [
					{ level: 1, text: 'The seam' },
					{ level: 2, text: 'What it costs' },
				]),
				turn('u2', 'And the costs\nsecond line'),
			],
		};

		panel.activeLeafChanged(leaf);

		expect(models.acquired).toEqual(['w4:p1']);
		expect(items(el)).toEqual([
			'Write up the seam',
			'The seam',
			'What it costs',
			// A multi-line prompt is one line in the list.
			'And the costs',
		]);
		// A heading's level is a class, never an inline style.
		const nested = el.findAll('herdr-toc-heading');
		expect([...(nested[1]?.classList ?? [])]).toContain('mod-level-2');
	});

	it('redraws when the session model moves', () => {
		const models = new FakeModels();
		const leaf = leafOf('native');
		const { panel, el } = panelOn(
			models,
			new Map([[leaf, { inMainArea: true, nativePaneId: 'w4:p1' }]]),
		);
		panel.activeLeafChanged(leaf);

		models.model('w4:p1').push([turn('u1', 'First prompt')]);

		expect(items(el)).toEqual(['First prompt']);
	});

	it('gives the old model back when another native view becomes active, and empties for a note', () => {
		const models = new FakeModels();
		const first = leafOf('native-1');
		const second = leafOf('native-2');
		const note = leafOf('note');
		const { panel, el } = panelOn(
			models,
			new Map([
				[first, { inMainArea: true, nativePaneId: 'w4:p1' }],
				[second, { inMainArea: true, nativePaneId: 'w4:p2' }],
				[note, { inMainArea: true, nativePaneId: '' }],
			]),
		);

		panel.activeLeafChanged(first);
		panel.activeLeafChanged(second);
		expect(models.acquired).toEqual(['w4:p1', 'w4:p2']);
		expect(models.released).toEqual(['w4:p1']);

		panel.activeLeafChanged(note);
		expect(models.released).toEqual(['w4:p1', 'w4:p2']);
		expect(el.find('herdr-toc-empty').textContent).toBe('No native view is active.');
	});

	it('keeps the list when its own leaf is activated, so a second click still works', () => {
		const models = new FakeModels();
		const native = leafOf('native');
		const own = leafOf('toc');
		const { panel, el, scrollToTurn } = panelOn(
			models,
			new Map([
				[native, { inMainArea: true, nativePaneId: 'w4:p1' }],
				[own, { inMainArea: false, nativePaneId: '' }],
			]),
		);
		panel.activeLeafChanged(native);
		models.model('w4:p1').push([turn('u1', 'First prompt', [{ level: 2, text: 'A heading' }])]);

		panel.activeLeafChanged(own);

		expect(models.released).toEqual([]);
		expect(items(el)).toEqual(['First prompt', 'A heading']);
		el.findAll('herdr-toc-item')[1]?.dispatch('click');
		// A heading scrolls to the turn it belongs to (#100): the view's own seam
		// is `scrollToTurn`, which also switches following off.
		expect(scrollToTurn).toHaveBeenCalledWith('w4:p1', 'u1');
	});

	it('scrolls the view to the turn a click names', () => {
		const models = new FakeModels();
		const leaf = leafOf('native');
		const { panel, el, scrollToTurn } = panelOn(
			models,
			new Map([[leaf, { inMainArea: true, nativePaneId: 'w4:p1' }]]),
		);
		panel.activeLeafChanged(leaf);
		models.model('w4:p1').push([turn('u1', 'First'), turn('u2', 'Second')]);

		el.findAll('herdr-toc-item')[1]?.dispatch('click');

		expect(scrollToTurn).toHaveBeenCalledWith('w4:p1', 'u2');
	});

	it('gives the model back when the view closes', () => {
		const models = new FakeModels();
		const leaf = leafOf('native');
		const { panel } = panelOn(
			models,
			new Map([[leaf, { inMainArea: true, nativePaneId: 'w4:p1' }]]),
		);
		panel.activeLeafChanged(leaf);

		panel.unmount();

		expect(models.released).toEqual(['w4:p1']);
	});
});
