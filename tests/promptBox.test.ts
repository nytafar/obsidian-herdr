/**
 * The prompt box (issue #97, ADR-0003).
 *
 * The DOM harness in place of a document (`tests/fixtures/dom.ts`), a fake
 * sender in place of herdr and, for the surface half, a fake session model:
 * what is asserted is the text that goes out, and the button's label and
 * enabled state per agent status. herdr's five states are the only thing that
 * says what the box may do, so they are the table this file walks.
 */

import { describe, expect, it, vi } from 'vitest';
import { hostEl, type FakeElement } from './fixtures/dom';
import { PromptBox, promptBoxState } from '../src/native/promptBox';
import { NativePaneSurface } from '../src/native/surface';
import { emptyTranscript, type TranscriptState } from '../src/native/reducer';
import type { PromptSender } from '../src/native/promptSender';
import type {
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from '../src/native/sessionModel';
import type { AgentStatus } from '../src/herdr/types.gen';
import type { App } from 'obsidian';

/** A sender that records what it was given, and fails when told to. */
function fakeSender(failWith?: string): PromptSender & { sent: { paneId: string; text: string }[] } {
	const sent: { paneId: string; text: string }[] = [];
	return {
		sent,
		async send(paneId: string, text: string): Promise<void> {
			sent.push({ paneId, text });
			if (failWith) throw new Error(failWith);
		},
	};
}

/** A sender that holds the request open until the test finishes it. */
function deferredSender(): PromptSender & {
	sent: { paneId: string; text: string }[];
	finish: () => void;
} {
	const sent: { paneId: string; text: string }[] = [];
	let finish = (): void => {};
	return {
		sent,
		finish: () => finish(),
		async send(paneId: string, text: string): Promise<void> {
			sent.push({ paneId, text });
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		},
	};
}

function boxOn(
	status: AgentStatus,
	sender: PromptSender,
): { box: PromptBox; el: FakeElement; notices: string[] } {
	const { el, host } = hostEl();
	const notices: string[] = [];
	const box = new PromptBox({
		paneId: () => 'w4:p1',
		sender,
		notify: (message) => notices.push(message),
	});
	box.mount(host);
	box.setStatus(status);
	return { box, el, notices };
}

function input(el: FakeElement): FakeElement {
	return el.find('herdr-native-prompt-input');
}

function sendButton(el: FakeElement): FakeElement {
	return el.find('herdr-native-prompt-send');
}

describe('promptBoxState', () => {
	it('says Send when the agent is idle or done', () => {
		expect(promptBoxState('idle')).toEqual({ label: 'Send', enabled: true, hint: '' });
		expect(promptBoxState('done')).toEqual({ label: 'Send', enabled: true, hint: '' });
	});

	it('says Queue while the agent is working, because herdr accepts the prompt', () => {
		expect(promptBoxState('working')).toEqual({ label: 'Queue', enabled: true, hint: '' });
	});

	it('is disabled while the agent is blocked', () => {
		expect(promptBoxState('blocked')).toEqual({ label: 'Send', enabled: false, hint: '' });
	});

	it('is disabled with a reason when there is no agent in the pane', () => {
		expect(promptBoxState('unknown')).toEqual({
			label: 'Send',
			enabled: false,
			hint: 'No agent in this pane.',
		});
	});
});

describe('PromptBox: the box itself', () => {
	it('names the text area for a screen reader', () => {
		const { el } = boxOn('idle', fakeSender());
		expect(input(el).attrs['aria-label']).toBe('Message the agent');
	});

	it('puts the send button on the same row as the text area (#103)', () => {
		const { el } = boxOn('idle', fakeSender());
		const row = el.find('herdr-native-prompt-row');
		expect(row.findAll('herdr-native-prompt-input')).toHaveLength(1);
		expect(row.findAll('herdr-native-prompt-send')).toHaveLength(1);
	});

	it('keeps a manual resize until the box is emptied (#103)', () => {
		const { el } = boxOn('idle', fakeSender());
		// What a drag on the text area's resizer leaves behind: the browser
		// writes the height itself, and it wins over the auto-grow until there
		// is nothing left to size.
		input(el).attrs.style = 'height: 320px;';

		input(el).value = 'still typing';
		input(el).dispatch('input');
		expect(input(el).attrs.style).toBe('height: 320px;');

		input(el).value = '';
		input(el).dispatch('input');
		expect(input(el).attrs.style).toBeUndefined();
	});

	it('drops a manual resize once a send has emptied the box (#103)', async () => {
		const { box, el } = boxOn('idle', fakeSender());
		input(el).value = 'Summarise the design';
		input(el).attrs.style = 'height: 320px;';

		await box.send();

		expect(input(el).attrs.style).toBeUndefined();
	});

	it('closes what was hung on the text area when the box goes, once', () => {
		const { host } = hostEl();
		const close = vi.fn();
		const box = new PromptBox({ paneId: () => 'w4:p1', sender: fakeSender(), onInput: () => close });
		box.mount(host);
		expect(close).not.toHaveBeenCalled();

		box.destroy();
		box.destroy();

		expect(close).toHaveBeenCalledTimes(1);
	});
});

describe('PromptBox: sending', () => {
	it('sends the text verbatim, newlines and all, and empties the box', async () => {
		const sender = fakeSender();
		const { box, el } = boxOn('idle', sender);
		input(el).value = 'first line\n\nthird line';

		await box.send();

		expect(sender.sent).toEqual([{ paneId: 'w4:p1', text: 'first line\n\nthird line' }]);
		expect(input(el).value).toBe('');
	});

	it('keeps what was typed while the send was in flight', async () => {
		// Typing stays enabled during a request, so the box may hold more than
		// was sent by the time herdr answers. Only the sent text goes (#97).
		const sender = deferredSender();
		const { box, el } = boxOn('idle', sender);
		input(el).value = 'again';

		const sending = box.send();
		input(el).value = 'again and the styles too';
		sender.finish();
		await sending;

		expect(sender.sent).toEqual([{ paneId: 'w4:p1', text: 'again' }]);
		expect(input(el).value).toBe(' and the styles too');
	});

	it('keeps a draft that replaced the sent text entirely', async () => {
		const sender = deferredSender();
		const { box, el } = boxOn('idle', sender);
		input(el).value = 'again';

		const sending = box.send();
		input(el).value = 'a different thought';
		sender.finish();
		await sending;

		expect(input(el).value).toBe('a different thought');
	});

	it('sends a leading slash command as typed', async () => {
		const sender = fakeSender();
		const { box, el } = boxOn('idle', sender);
		input(el).value = '/clear';

		await box.send();

		expect(sender.sent).toEqual([{ paneId: 'w4:p1', text: '/clear' }]);
	});

	it('queues while the agent is working, with no optimistic echo in the box', async () => {
		const sender = fakeSender();
		const { box, el } = boxOn('working', sender);
		expect(sendButton(el).textContent).toBe('Queue');
		input(el).value = 'also check the tests';

		await box.send();

		expect(sender.sent).toEqual([{ paneId: 'w4:p1', text: 'also check the tests' }]);
		expect(el.findAll('herdr-native-turn')).toEqual([]);
	});

	it('sends nothing when the box is empty or the agent is blocked', async () => {
		const sender = fakeSender();
		const empty = boxOn('idle', sender);
		await empty.box.send();

		const blocked = boxOn('blocked', sender);
		input(blocked.el).value = 'let me in';
		await blocked.box.send();

		expect(sender.sent).toEqual([]);
	});

	it('shows a notice and keeps the text when the send fails', async () => {
		const sender = fakeSender('agent_blocked');
		const { box, el, notices } = boxOn('idle', sender);
		input(el).value = 'Summarise the design';

		await box.send();

		expect(notices).toEqual(['Herdr: could not send the prompt (agent_blocked)']);
		expect(input(el).value).toBe('Summarise the design');
	});

	it('sends on a plain enter, and on mod+enter too (#103)', async () => {
		const sender = fakeSender();
		const { el } = boxOn('idle', sender);
		input(el).value = 'Summarise the design';

		input(el).dispatch('keydown', { key: 'Enter', ctrlKey: false, metaKey: false });
		await Promise.resolve();
		expect(sender.sent).toEqual([{ paneId: 'w4:p1', text: 'Summarise the design' }]);

		input(el).value = 'And the tests';
		input(el).dispatch('keydown', { key: 'Enter', ctrlKey: true, metaKey: false });
		await Promise.resolve();
		expect(sender.sent).toEqual([
			{ paneId: 'w4:p1', text: 'Summarise the design' },
			{ paneId: 'w4:p1', text: 'And the tests' },
		]);
	});

	it('makes a newline on shift+enter and sends nothing', async () => {
		const sender = fakeSender();
		const { el } = boxOn('idle', sender);
		input(el).value = 'first line';
		const preventDefault = vi.fn();

		input(el).dispatch('keydown', { key: 'Enter', shiftKey: true, preventDefault });
		await Promise.resolve();

		expect(sender.sent).toEqual([]);
		// The text area's own newline: nothing stops it.
		expect(preventDefault).not.toHaveBeenCalled();
	});

	it('leaves the enter to an input method that is composing (#49)', async () => {
		const sender = fakeSender();
		const { el } = boxOn('idle', sender);
		input(el).value = 'にほんご';
		const preventDefault = vi.fn();

		input(el).dispatch('keydown', { key: 'Enter', isComposing: true, preventDefault });
		await Promise.resolve();

		expect(sender.sent).toEqual([]);
		expect(preventDefault).not.toHaveBeenCalled();
	});

	it('leaves the enter to the suggest while its popover is open (#98)', async () => {
		const sender = fakeSender();
		const { el, host } = hostEl();
		let open = true;
		const box = new PromptBox({
			paneId: () => 'w4:p1',
			sender,
			onInput: () => ({ close: () => {}, isOpen: () => open }),
		});
		box.mount(host);
		box.setStatus('idle');
		input(el).value = '/clear';

		input(el).dispatch('keydown', { key: 'Enter' });
		await Promise.resolve();
		expect(sender.sent).toEqual([]);

		open = false;
		input(el).dispatch('keydown', { key: 'Enter' });
		await Promise.resolve();
		expect(sender.sent).toEqual([{ paneId: 'w4:p1', text: '/clear' }]);
	});
});

describe('PromptBox: state per agent status', () => {
	it('enables and labels the button, and says when there is no agent', () => {
		const { box, el } = boxOn('idle', fakeSender());
		expect(sendButton(el).textContent).toBe('Send');
		expect(sendButton(el).disabled).toBe(false);
		expect(el.findAll('herdr-native-prompt-hint')).toEqual([]);

		box.setStatus('working');
		expect(sendButton(el).textContent).toBe('Queue');
		expect(sendButton(el).disabled).toBe(false);

		box.setStatus('blocked');
		expect(sendButton(el).disabled).toBe(true);
		expect(el.findAll('herdr-native-prompt-hint')).toEqual([]);

		box.setStatus('unknown');
		expect(sendButton(el).disabled).toBe(true);
		expect(input(el).disabled).toBe(true);
		expect(el.find('herdr-native-prompt-hint').textContent).toBe('No agent in this pane.');
	});
});

// -- The box inside the native surface ------------------------------------

/** A session model a test drives by hand (as in `tests/nativeSurface.test.ts`). */
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

	/** herdr moved the agent's status; no turn changed. */
	setStatus(status: AgentStatus): void {
		this.agentStatus = status;
		for (const listener of [...this.listeners]) listener({ changedTurnIds: [], reset: false });
	}
}

class FakeModels implements SessionModels {
	constructor(readonly model: FakeModel) {}
	acquire(): SessionHandleOf<SessionModelView> {
		return { model: this.model, release: () => {} };
	}
}

async function surfaceOn(
	model: FakeModel,
	sender: PromptSender,
): Promise<{ surface: NativePaneSurface; el: FakeElement }> {
	const { el, host } = hostEl();
	const app = { workspace: { openLinkText: vi.fn() } } as unknown as App;
	const surface = new NativePaneSurface({
		app,
		identity: { paneId: 'w4:p1', mode: 'control', endpointId: 'local' },
		onStatus: () => {},
		models: new FakeModels(model),
		sender,
		// The waiting card is `tests/nativeWaiting.test.ts`; nothing here presses it.
		keySender: { sendKeys: async () => {} },
		openInTerminal: () => {},
		autoAcceptPermissions: () => false,
		// Turn presentation is `tests/nativeSurface.test.ts`; nothing here draws a tool group.
		presentation: () => 'highlight',
		vaultPath: () => '',
	});
	await surface.attach(host);
	return { surface, el };
}

describe('NativePaneSurface: the prompt box', () => {
	it('offers Send to a fresh Claude that has no session yet', async () => {
		const sender = fakeSender();
		const model = new FakeModel();
		// A freshly started Claude sits idle with no `agent_session` and no
		// transcript file until the first prompt (docs/architecture.md).
		const { el } = await surfaceOn(model, sender);

		expect(el.find('herdr-native-empty').textContent).toBe('No session yet.');
		expect(sendButton(el).textContent).toBe('Send');
		expect(sendButton(el).disabled).toBe(false);

		input(el).value = 'Summarise the design';
		sendButton(el).dispatch('click');
		await Promise.resolve();

		expect(sender.sent).toEqual([{ paneId: 'w4:p1', text: 'Summarise the design' }]);
	});

	it('follows the agent status the session model reports', async () => {
		const model = new FakeModel();
		const { el } = await surfaceOn(model, fakeSender());

		model.setStatus('working');
		expect(sendButton(el).textContent).toBe('Queue');

		model.setStatus('unknown');
		expect(sendButton(el).disabled).toBe(true);
		expect(el.find('herdr-native-prompt-hint').textContent).toBe('No agent in this pane.');
	});

	it('takes the box away with the view', async () => {
		const model = new FakeModel();
		const { surface, el } = await surfaceOn(model, fakeSender());
		expect(el.findAll('herdr-native-prompt-box')).toHaveLength(1);

		await surface.detach();

		expect(el.findAll('herdr-native-prompt-box')).toEqual([]);
	});
});
