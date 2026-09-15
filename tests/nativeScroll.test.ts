/**
 * Where the native view sits in a session, and when it moves (#106, #103).
 *
 * The same fakes as `tests/nativeSurface.test.ts` — a session model driven by
 * hand, the DOM harness, the recording `MarkdownRenderer` — plus the one thing
 * this file is about: the turns element as a **scroll container**, with the
 * `scrollTop`, `scrollHeight` and `clientHeight` a real one reports. The
 * numbers are worked by hand: a container 1000 tall showing 400 of it is at the
 * bottom at 600, and nowhere else.
 *
 * `MarkdownRenderer.render` is async and embeds load later still, so the pin
 * that matters is not the one right after a draw. Two things re-pin while the
 * view is following: the renders settling, and a `ResizeObserver` on the turns
 * element and the turn being written. Node has no `ResizeObserver`, so the
 * surface must mount without one — one test says so, and the rest install a
 * fake to fire by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostEl, type FakeElement } from './fixtures/dom';
import { MarkdownRenderer } from './fixtures/obsidian';
import { isAtBottom, NativePaneSurface } from '../src/native/surface';
import { emptyTranscript, type TranscriptState, type Turn } from '../src/native/reducer';
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
	path: string | null = '/transcript.jsonl';
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
		for (const listener of [...this.listeners]) listener(change);
	}
}

class FakeModels implements SessionModels {
	constructor(readonly model: FakeModel) {}
	acquire(): SessionHandleOf<SessionModelView> {
		return { model: this.model, release: () => {} };
	}
}

/** One observer per surface; the test fires its callback where a layout would. */
class FakeResizeObserver {
	static readonly instances: FakeResizeObserver[] = [];
	readonly observed: unknown[] = [];
	disconnected = false;

	constructor(readonly callback: () => void) {
		FakeResizeObserver.instances.push(this);
	}

	observe(target: unknown): void {
		this.observed.push(target);
	}

	unobserve(target: unknown): void {
		const at = this.observed.indexOf(target);
		if (at !== -1) this.observed.splice(at, 1);
	}

	disconnect(): void {
		this.disconnected = true;
	}
}

const globals = globalThis as unknown as { ResizeObserver?: unknown };

function turn(id: string, prompt: string): Turn {
	return { id, prompt, entries: [{ kind: 'text', messageId: `m-${id}`, text: `answer ${id}` }] };
}

/** The turns element, which is the view's one scroll container (#103). */
function turnsEl(el: FakeElement): FakeElement {
	return el.find('herdr-native-turns');
}

/** What a browser would have measured after laying the turns out. */
function laidOut(el: FakeElement, height: number, view = 400): void {
	const turns = turnsEl(el);
	turns.scrollHeight = height;
	turns.clientHeight = view;
}

/** Lets the Markdown renders, and the pin that waits on them, settle. */
async function settle(): Promise<void> {
	for (let tick = 0; tick < 5; tick++) await Promise.resolve();
}

/**
 * A surface attached to a view 400 tall over 1000 of turns — the numbers every
 * case below is worked from. The layout is applied between the draw and the
 * renders landing, which is the order a browser does it in: the elements exist
 * and are measured while `MarkdownRenderer` is still working.
 */
async function surfaceOn(
	model: FakeModel,
): Promise<{ surface: NativePaneSurface; el: FakeElement }> {
	const { el, host } = hostEl();
	const app = { workspace: { openLinkText: vi.fn() } } as unknown as App;
	const surface = new NativePaneSurface({
		app,
		identity: { paneId: 'w4:p1', mode: 'control', endpointId: 'local' },
		onStatus: () => {},
		models: new FakeModels(model),
		sender: { send: async () => {} },
		// The waiting card is `tests/nativeWaiting.test.ts`; nothing here presses it.
		keySender: { sendKeys: async () => {} },
		openInTerminal: () => {},
		autoAcceptPermissions: () => false,
		presentation: () => 'highlight',
		vaultPath: () => '',
	});
	const attaching = surface.attach(host);
	laidOut(el, 1000);
	await attaching;
	return { surface, el };
}

beforeEach(() => {
	MarkdownRenderer.reset();
	FakeResizeObserver.instances.length = 0;
	globals.ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
	delete globals.ResizeObserver;
});

describe('isAtBottom', () => {
	it('is the bottom at the last scrollable pixel, and a couple of lines above it', () => {
		expect(isAtBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
		expect(isAtBottom({ scrollTop: 590, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
	});

	it('is not the bottom once the user has scrolled away from it', () => {
		expect(isAtBottom({ scrollTop: 200, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
	});

	it('is the bottom when there is nothing to scroll', () => {
		expect(isAtBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
	});
});

describe('NativePaneSurface: opening a session', () => {
	it('lands on the latest turn once the late Markdown has rendered', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first'), turn('u2', 'last')] };
		const { el } = await surfaceOn(model);

		await settle();

		expect(turnsEl(el).scrollTop).toBe(600);
	});

	it('mounts where there is no ResizeObserver at all', async () => {
		delete globals.ResizeObserver;
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first')] };

		const { el } = await surfaceOn(model);

		expect(el.findAll('herdr-native-turn')).toHaveLength(1);
	});
});

describe('NativePaneSurface: following new content', () => {
	it('stays at the bottom while it is at the bottom', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first')] };
		const { el } = await surfaceOn(model);
		await settle();

		laidOut(el, 1400);
		model.push([turn('u1', 'first'), turn('u2', 'next')], {
			changedTurnIds: ['u2'],
			reset: false,
		});

		expect(turnsEl(el).scrollTop).toBe(1000);
	});

	it('leaves the reader alone once they have scrolled up', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first')] };
		const { el } = await surfaceOn(model);
		await settle();

		turnsEl(el).scrollTop = 200;
		turnsEl(el).dispatch('scroll');
		laidOut(el, 1400);
		model.push([turn('u1', 'first'), turn('u2', 'next')], {
			changedTurnIds: ['u2'],
			reset: false,
		});

		expect(turnsEl(el).scrollTop).toBe(200);
	});

	it('follows again once the reader is back at the bottom', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first')] };
		const { el } = await surfaceOn(model);
		await settle();

		turnsEl(el).scrollTop = 200;
		turnsEl(el).dispatch('scroll');
		turnsEl(el).scrollTop = 600;
		turnsEl(el).dispatch('scroll');
		laidOut(el, 1400);
		model.push([turn('u1', 'first'), turn('u2', 'next')], {
			changedTurnIds: ['u2'],
			reset: false,
		});

		expect(turnsEl(el).scrollTop).toBe(1000);
	});

	it('goes back to the bottom when the session rotates', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first')] };
		const { el } = await surfaceOn(model);
		await settle();
		turnsEl(el).scrollTop = 200;
		turnsEl(el).dispatch('scroll');

		// `/clear`: another session, and its own latest turn is what to show.
		model.push([turn('n1', 'after the clear')], { changedTurnIds: [], reset: true });
		laidOut(el, 800);
		await settle();

		expect(turnsEl(el).scrollTop).toBe(400);
	});
});

describe('NativePaneSurface: re-pinning as the view grows', () => {
	it('watches the turns element and the turn being written', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first')] };
		const { el } = await surfaceOn(model);
		const [observer] = FakeResizeObserver.instances;

		model.push([turn('u1', 'first'), turn('u2', 'next')], {
			changedTurnIds: ['u2'],
			reset: false,
		});

		expect(observer?.observed).toEqual([turnsEl(el), el.findAll('herdr-native-turn')[1]]);
	});

	it('re-pins while following when an embed lands long after the draw', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first')] };
		const { el } = await surfaceOn(model);
		await settle();
		const [observer] = FakeResizeObserver.instances;

		laidOut(el, 1600);
		observer?.callback();

		expect(turnsEl(el).scrollTop).toBe(1200);
	});

	it('does not re-pin when the reader has scrolled up', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first')] };
		const { el } = await surfaceOn(model);
		await settle();
		turnsEl(el).scrollTop = 200;
		turnsEl(el).dispatch('scroll');
		const [observer] = FakeResizeObserver.instances;

		laidOut(el, 1600);
		observer?.callback();

		expect(turnsEl(el).scrollTop).toBe(200);
	});

	it('stops watching when the surface is given back', async () => {
		const model = new FakeModel();
		const { surface } = await surfaceOn(model);
		const [observer] = FakeResizeObserver.instances;

		await surface.detach();

		expect(observer?.disconnected).toBe(true);
	});
});

describe('NativePaneSurface: what a scroll costs (#101)', () => {
	it('draws nothing and touches no turn when the reader scrolls', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first'), turn('u2', 'last')] };
		const { el } = await surfaceOn(model);
		await settle();
		const drawn = MarkdownRenderer.calls.length;

		// A flick through a long session: the only thing a scroll may do is
		// decide whether the view is still following.
		for (const position of [500, 300, 100, 0, 600]) {
			turnsEl(el).scrollTop = position;
			turnsEl(el).dispatch('scroll');
		}

		expect(MarkdownRenderer.calls).toHaveLength(drawn);
		expect(el.findAll('herdr-native-turn')).toHaveLength(2);
	});
});

describe('NativePaneSurface: a tab that was hidden', () => {
	it('is at the bottom when it is revealed, if it was following', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first')] };
		const { surface, el } = await surfaceOn(model);
		await settle();

		await surface.setVisible(false);
		// A hidden leaf lays nothing out, so what arrived meanwhile is measured
		// only when the tab comes back.
		model.push([turn('u1', 'first'), turn('u2', 'next')], {
			changedTurnIds: ['u2'],
			reset: false,
		});
		laidOut(el, 1400);
		await surface.setVisible(true);

		expect(turnsEl(el).scrollTop).toBe(1000);
	});

	it('keeps the reader where they were, if they had scrolled up', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first')] };
		const { surface, el } = await surfaceOn(model);
		await settle();
		turnsEl(el).scrollTop = 200;
		turnsEl(el).dispatch('scroll');

		await surface.setVisible(false);
		laidOut(el, 1400);
		await surface.setVisible(true);

		expect(turnsEl(el).scrollTop).toBe(200);
	});
});

describe('NativePaneSurface: scrolling to one turn', () => {
	it('brings the turn into view and stops following (#100)', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first'), turn('u2', 'last')] };
		const { surface, el } = await surfaceOn(model);
		await settle();

		surface.scrollToTurn('u1');

		expect(el.findAll('herdr-native-turn')[0]?.scrolledIntoView).toEqual([{ block: 'start' }]);

		laidOut(el, 1400);
		model.push([turn('u1', 'first'), turn('u2', 'last'), turn('u3', 'next')], {
			changedTurnIds: ['u3'],
			reset: false,
		});
		expect(turnsEl(el).scrollTop).toBe(600);
	});

	it('does nothing for a turn that is not in this session', async () => {
		const model = new FakeModel();
		model.state = { ...model.state, turns: [turn('u1', 'first')] };
		const { surface, el } = await surfaceOn(model);
		await settle();

		surface.scrollToTurn('nope');

		laidOut(el, 1400);
		model.push([turn('u1', 'first'), turn('u2', 'next')], {
			changedTurnIds: ['u2'],
			reset: false,
		});
		expect(turnsEl(el).scrollTop).toBe(1000);
	});
});
