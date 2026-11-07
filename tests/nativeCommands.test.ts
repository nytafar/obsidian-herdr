/**
 * The native view's commands (#145): focus the prompt box, go to the next or
 * the previous turn, and find in the conversation. The picker and the search
 * are pure enough to hold here; the surface is driven with the same fakes as
 * `tests/nativeScroll.test.ts`, with each turn's top set where a layout would
 * have put it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeText, hostEl, type FakeElement } from './fixtures/dom';
import { MarkdownRenderer, SuggestModal } from './fixtures/obsidian';
import { NativePaneSurface } from '../src/native/surface';
import { turnStep } from '../src/native/scrollFollower';
import {
	ConversationFindModal,
	FIND_HIT_CLASS,
	findInTurns,
	locateMatch,
	type FindHit,
} from '../src/native/conversationFind';
import { nativeViewCommand } from '../src/views/terminalView';
import { emptyTranscript, type TranscriptState } from '../src/agents/claude/transcript';
import type { Turn } from '../src/native/conversation';
import type {
	BlockKind,
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from '../src/native/sessionModel';
import type { AgentStatus } from '../src/herdr/types.gen';
import type { App } from 'obsidian';

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
	push(change: SessionChange): void {
		for (const listener of [...this.listeners]) listener(change);
	}
}

class FakeModels implements SessionModels {
	constructor(readonly model: FakeModel) {}
	acquire(): SessionHandleOf<SessionModelView> {
		return { model: this.model, release: () => {} };
	}
}

function turn(id: string, prompt: string, reply = `answer ${id}`, steer?: string): Turn {
	const entries: Turn['entries'] = [];
	if (steer) entries.push({ kind: 'steer', text: steer });
	entries.push({ kind: 'text', messageId: `m-${id}`, text: reply });
	return { id, prompt, entries, headings: [] };
}

async function surfaceOn(turns: Turn[]): Promise<{ surface: NativePaneSurface; el: FakeElement; model: FakeModel }> {
	const model = new FakeModel();
	model.state = { ...model.state, turns };
	const { el, host } = hostEl();
	const app = { workspace: { openLinkText: vi.fn() } } as unknown as App;
	const surface = new NativePaneSurface({
		app,
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
	await surface.attach(host);
	for (let tick = 0; tick < 5; tick++) await Promise.resolve();
	return { surface, el, model };
}

function turnsEl(el: FakeElement): FakeElement {
	return el.find('herdr-native-turns');
}

/** A view 400 tall over 1200 of turns, scrolled so turn `t2` starts 100px below its top. */
function laidOut(el: FakeElement, tops: number[]): void {
	const scroller = turnsEl(el);
	scroller.scrollHeight = 1200;
	scroller.clientHeight = 400;
	scroller.scrollTop = 300;
	scroller.top = 0;
	el.findAll('herdr-native-turn').forEach((turnEl, index) => {
		turnEl.top = tops[index] ?? 0;
	});
}

beforeEach(() => {
	MarkdownRenderer.reset();
	SuggestModal.opened.length = 0;
});

describe('turnStep', () => {
	it('goes to the first turn starting below the top, or the last starting above it', () => {
		const offsets = [-500, -120, 100, 600];
		expect(turnStep(offsets, 1)).toBe(2);
		expect(turnStep(offsets, -1)).toBe(1);
	});

	it('counts a turn a pixel or two off the top as the one the reader is on', () => {
		const offsets = [-300, 2, 400];
		expect(turnStep(offsets, 1)).toBe(2);
		expect(turnStep(offsets, -1)).toBe(0);
	});

	it('has nowhere to go past either end', () => {
		expect(turnStep([-400, -100], 1)).toBeNull();
		expect(turnStep([0, 300], -1)).toBeNull();
	});
});

describe('NativePaneSurface: next and previous turn (#145)', () => {
	it('brings the next turn into view, and the previous one', async () => {
		const { surface, el } = await surfaceOn([turn('t1', 'one'), turn('t2', 'two'), turn('t3', 'three')]);
		laidOut(el, [-300, 100, 500]);
		const [, second, , ] = el.findAll('herdr-native-turn');

		surface.stepTurn(1);
		expect(second?.scrolledIntoView).toEqual([{ block: 'start' }]);

		surface.stepTurn(-1);
		expect(el.findAll('herdr-native-turn')[0]?.scrolledIntoView).toEqual([{ block: 'start' }]);
	});

	it('goes to the end and follows again past the last turn', async () => {
		const { surface, el } = await surfaceOn([turn('t1', 'one'), turn('t2', 'two')]);
		laidOut(el, [-600, -200]);

		surface.stepTurn(1);

		expect(turnsEl(el).scrollTop).toBe(800);
		expect(el.find('herdr-native-jump').hasClass('herdr-is-hidden')).toBe(true);
	});
});

describe('NativePaneSurface: focus the prompt box (#145)', () => {
	it('puts the cursor in the box, and not while the agent is blocked', async () => {
		const { surface, el, model } = await surfaceOn([turn('t1', 'one')]);
		const input = el.find('herdr-native-prompt-input');

		expect(surface.canFocusPrompt()).toBe(true);
		expect(surface.focusPrompt()).toBe(true);
		expect(input.focused).toBe(true);

		input.focused = false;
		model.agentStatus = 'blocked';
		model.push({ changedTurnIds: [], reset: false });
		expect(surface.canFocusPrompt()).toBe(false);
		expect(surface.focusPrompt()).toBe(false);
		expect(input.focused).toBe(false);
	});
});

describe('findInTurns', () => {
	const turns = [
		turn('t1', 'Where is the Config file?', 'The config lives in `~/.config`. Config again.'),
		turn('t2', 'thanks', 'You are welcome.', 'and the config for xl?'),
	];

	it('finds every match, case-insensitively, in prompt, reply and steer, counted per turn', () => {
		const hits = findInTurns(turns, 'config');
		expect(hits.map((hit) => [hit.turnId, hit.part, hit.occurrence, hit.match])).toEqual([
			['t1', 'prompt', 0, 'Config'],
			['t1', 'reply', 1, 'config'],
			['t1', 'reply', 2, 'config'],
			['t1', 'reply', 3, 'Config'],
			['t2', 'steer', 0, 'config'],
		]);
	});

	it('gives a snippet on one line around the match', () => {
		const [hit] = findInTurns([turn('t1', 'line one\nthe needle here\nline three')], 'needle');
		expect(hit?.before).toBe('line one the ');
		expect(hit?.after).toBe(' here line three');
	});

	it('finds nothing for a blank query, and stops at the limit', () => {
		expect(findInTurns(turns, '   ')).toEqual([]);
		expect(findInTurns(turns, 'config', 2)).toHaveLength(2);
	});
});

describe('locateMatch', () => {
	it('finds the nth match in the drawn prompt and prose, and falls back to the last', () => {
		const { el } = hostEl();
		const turnEl = el.createDiv({ cls: 'herdr-native-turn' });
		turnEl.createDiv({ cls: 'herdr-native-prompt', text: 'a config' });
		// Folded tool rows are not searched, whatever they say.
		turnEl.createDiv({ cls: 'herdr-native-tool', text: 'config' });
		const block = turnEl.createDiv({ cls: 'herdr-native-block' });
		const paragraph = block.createEl('p');
		paragraph.nodes.push(new FakeText('one config, two Config'));

		const second = locateMatch(turnEl as unknown as HTMLElement, 'CONFIG', 1);
		expect(second?.start).toBe(4);
		const tooFar = locateMatch(turnEl as unknown as HTMLElement, 'config', 9);
		expect(tooFar?.start).toBe(16);
		expect(locateMatch(turnEl as unknown as HTMLElement, 'absent', 0)).toBeNull();
	});
});

describe('NativePaneSurface: find in the conversation (#145)', () => {
	it('lists the matches and jumps to the picked one, marked until the next find', async () => {
		const { surface, el } = await surfaceOn([
			turn('t1', 'first prompt', 'nothing here'),
			turn('t2', 'second', 'the needle is here'),
		]);

		surface.findInConversation();
		const modal = SuggestModal.opened[0] as unknown as ConversationFindModal;
		const hits = modal.getSuggestions('needle');
		expect(hits.map((hit) => hit.turnId)).toEqual(['t2']);
		modal.onChooseSuggestion(hits[0] as FindHit);

		const marked = el.findAll(FIND_HIT_CLASS);
		expect(marked).toHaveLength(1);
		expect(marked[0]?.textContent).toContain('needle');
		expect(marked[0]?.scrolledIntoView).toEqual([{ block: 'center' }]);
		// The reader went somewhere: the view stops following.
		expect(el.find('herdr-native-jump').hasClass('herdr-is-hidden')).toBe(false);

		surface.findInConversation();
		const next = SuggestModal.opened[1] as unknown as ConversationFindModal;
		const firstHits = next.getSuggestions('first');
		next.onChooseSuggestion(firstHits[0] as FindHit);
		expect(el.findAll(FIND_HIT_CLASS).map((hit) => hit.textContent)).toEqual(['first prompt']);
	});

	it('renders a snippet with the match marked and the turn it is in', () => {
		const modal = new ConversationFindModal({} as App, () => [], () => {});
		const { el } = hostEl();
		modal.renderSuggestion(
			{ turnId: 't', turnIndex: 2, part: 'reply', occurrence: 0, before: 'a ', match: 'B', after: ' c' },
			el as unknown as HTMLElement,
		);
		expect(el.find('herdr-native-find-snippet').textContent).toBe('a B c');
		expect(el.find('herdr-native-find-snippet').querySelectorAll('mark')[0]?.textContent).toBe('B');
		expect(el.find('herdr-native-find-where').textContent).toBe('Turn 3, reply');
	});
});

describe('nativeViewCommand (#145)', () => {
	function appWith(view: unknown): App {
		return { workspace: { getActiveViewOfType: () => view } } as unknown as App;
	}

	it('is not offered without an active tab showing the native view', () => {
		expect(nativeViewCommand(appWith(null), 'find', true)).toBe(false);
		expect(nativeViewCommand(appWith({ nativeSurface: () => null }), 'next-turn', true)).toBe(false);
	});

	it('runs on the active native view', () => {
		const surface = {
			canFocusPrompt: () => true,
			focusPrompt: vi.fn(() => true),
			stepTurn: vi.fn(),
			findInConversation: vi.fn(),
		};
		const app = appWith({ nativeSurface: () => surface });

		expect(nativeViewCommand(app, 'previous-turn', true)).toBe(true);
		expect(surface.stepTurn).not.toHaveBeenCalled();
		nativeViewCommand(app, 'previous-turn', false);
		nativeViewCommand(app, 'next-turn', false);
		nativeViewCommand(app, 'find', false);
		nativeViewCommand(app, 'focus-prompt', false);

		expect(surface.stepTurn.mock.calls).toEqual([[-1], [1]]);
		expect(surface.findInConversation).toHaveBeenCalledTimes(1);
		expect(surface.focusPrompt).toHaveBeenCalledTimes(1);
	});
});
