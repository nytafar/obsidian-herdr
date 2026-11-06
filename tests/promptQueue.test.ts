/**
 * Queued prompts held by the plugin (#159).
 *
 * The queue model with a fake sender and a status fed by hand; the registry
 * over a fake session model, as a reconnect and a detach look to it; the
 * three senders' held and Send now paths over fake clients; and the prompt
 * box and native surface drawing the rows (`tests/fixtures/dom.ts`).
 */

import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { hostEl, type FakeElement } from './fixtures/dom';
import { PaneQueue, PromptQueues, TURN_GRACE_MS, type QueueTimers } from '../src/native/promptQueue';
import {
	clientPromptSender,
	PromptHeldBack,
	SEND_NOW,
	type PromptClient,
	type PromptSender,
	type PromptSendOptions,
} from '../src/native/promptSender';
import { hcPromptSender } from '../src/hc/actions';
import { CHANGING_REASON, gatePromptSender, PaneGate } from '../src/native/paneGate';
import { HcError } from '../src/hc/connection';
import { HerdrError } from '../src/herdr/client';
import type { ImageFiles, PromptImage } from '../src/native/promptImages';
import { PromptBox } from '../src/native/promptBox';
import { NativePaneSurface } from '../src/native/surface';
import { emptyTranscript, type TranscriptState } from '../src/agents/claude/transcript';
import type { SessionChange, SessionHandleOf, SessionModels, SessionModelView } from '../src/native/sessionModel';
import type { AgentStatus } from '../src/herdr/types.gen';

/** Timers fired by hand. */
function manualTimers(): QueueTimers & { fire: () => void; pending: () => number } {
	const pending = new Set<{ callback: () => void }>();
	return {
		set: (callback) => {
			const handle = { callback };
			pending.add(handle);
			return handle;
		},
		clear: (handle) => pending.delete(handle as { callback: () => void }),
		fire: () => {
			for (const handle of [...pending]) {
				pending.delete(handle);
				handle.callback();
			}
		},
		pending: () => pending.size,
	};
}

interface Sent {
	text: string;
	images: readonly PromptImage[];
	options: PromptSendOptions;
}

/** A send that records, and answers as the test says: ok, held back, or failed. */
function fakeSend() {
	const sent: Sent[] = [];
	let answer: () => Promise<void> = () => Promise.resolve();
	return {
		sent,
		answer: (next: () => Promise<void>) => {
			answer = next;
		},
		send: (text: string, images: readonly PromptImage[], options: PromptSendOptions) => {
			sent.push({ text, images, options });
			return answer();
		},
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

function queueOn(status: AgentStatus) {
	const send = fakeSend();
	const timers = manualTimers();
	const notices: string[] = [];
	const queue = new PaneQueue({ send: send.send, timers, notify: (message) => notices.push(message) });
	queue.setStatus(status);
	return { queue, send, timers, notices };
}

const IMAGE: PromptImage = { mediaType: 'image/png', data: 'iVBORw0K', name: 'red.png' };

describe('PaneQueue: holding', () => {
	it('holds what is typed while the agent works, and sends nothing', async () => {
		const { queue, send } = queueOn('working');
		expect(queue.holds('working')).toBe(true);
		queue.add('first');
		queue.add('second', [IMAGE]);
		await settle();
		expect(send.sent).toEqual([]);
		expect(queue.rows.map((row) => row.text)).toEqual(['first', 'second']);
		expect(queue.rows[1]?.images).toEqual([IMAGE]);
	});

	it('holds behind waiting rows at rest, and sends at once with none', () => {
		const { queue } = queueOn('working');
		expect(queue.holds('idle')).toBe(false);
		queue.add('first');
		expect(queue.holds('done')).toBe(true);
		expect(queue.holds('unknown')).toBe(false);
	});

	it('discards and takes back locally, exactly, with nothing sent', async () => {
		const { queue, send } = queueOn('working');
		const a = queue.add('alpha');
		const b = queue.add('bravo', [IMAGE]);
		queue.add('charlie');
		expect(queue.discard(a.id)).toBe(true);
		expect(queue.take(b.id)).toMatchObject({ text: 'bravo', images: [IMAGE] });
		expect(queue.discard(a.id)).toBe(false);
		await settle();
		expect(queue.rows.map((row) => row.text)).toEqual(['charlie']);
		expect(send.sent).toEqual([]);
	});
});

describe('PaneQueue: delivery', () => {
	it('sends the oldest row, held, when the agent leaves working, and one per turn', async () => {
		const { queue, send } = queueOn('working');
		queue.add('first');
		queue.add('second');
		queue.setStatus('done');
		await settle();
		expect(send.sent).toEqual([{ text: 'first', images: [], options: { held: true } }]);
		expect(queue.rows.map((row) => row.text)).toEqual(['second']);

		// Still at rest: the turn the first started has not been seen yet.
		queue.setStatus('idle');
		await settle();
		expect(send.sent).toHaveLength(1);

		queue.setStatus('working');
		await settle();
		expect(send.sent).toHaveLength(1);
		queue.setStatus('done');
		await settle();
		expect(send.sent.map((entry) => entry.text)).toEqual(['first', 'second']);
		expect(queue.rows).toEqual([]);
	});

	it('sends nothing while blocked (a dialog or one of Claude’s pickers) or with no agent', async () => {
		const { queue, send } = queueOn('working');
		queue.add('first');
		queue.setStatus('blocked');
		queue.setStatus('unknown');
		await settle();
		expect(send.sent).toEqual([]);
		queue.setStatus('idle');
		await settle();
		expect(send.sent.map((entry) => entry.text)).toEqual(['first']);
	});

	it('lets the next row go when a sent one starts no turn (a local command)', async () => {
		const { queue, send, timers } = queueOn('working');
		queue.add('/help');
		queue.add('second');
		queue.setStatus('done');
		await settle();
		expect(send.sent).toHaveLength(1);
		expect(timers.pending()).toBe(1);
		timers.fire();
		await settle();
		expect(send.sent.map((entry) => entry.text)).toEqual(['/help', 'second']);
		expect(TURN_GRACE_MS).toBeGreaterThan(0);
	});

	it('keeps a row the runtime holds back, with nothing said, and tries on the next transition', async () => {
		const { queue, send, notices } = queueOn('working');
		queue.add('first');
		send.answer(() => Promise.reject(new PromptHeldBack('t1 is working, not idle')));
		queue.setStatus('done');
		await settle();
		expect(queue.rows).toMatchObject([{ text: 'first', sending: false, error: null }]);
		expect(notices).toEqual([]);

		send.answer(() => Promise.resolve());
		queue.setStatus('working');
		queue.setStatus('done');
		await settle();
		expect(send.sent.map((entry) => entry.text)).toEqual(['first', 'first']);
		expect(queue.rows).toEqual([]);
	});

	it('keeps a failed row with its error, says so once, and sends the rest past it next turn', async () => {
		const { queue, send, notices, timers } = queueOn('working');
		queue.add('first');
		queue.add('second');
		send.answer(() => Promise.reject(new Error('Not connected to herdr.')));
		queue.setStatus('done');
		await settle();
		expect(queue.rows[0]).toMatchObject({ text: 'first', error: 'Not connected to herdr.' });
		expect(notices).toEqual(['Gjetr: could not send the queued prompt (Not connected to herdr.)']);
		// One failure, not a cascade: the rest wait for the next transition.
		expect(send.sent.map((entry) => entry.text)).toEqual(['first']);
		expect(timers.pending()).toBe(0);
		send.answer(() => Promise.resolve());
		queue.setStatus('working');
		queue.setStatus('done');
		await settle();
		// The rest goes past it, and the failed one waits for the user.
		expect(send.sent.map((entry) => entry.text)).toEqual(['first', 'second']);
		expect(queue.rows.map((row) => row.text)).toEqual(['first']);
	});

	it('holds every row while suspended, and goes on when resumed', async () => {
		const { queue, send } = queueOn('working');
		queue.add('first');
		const resume = queue.suspend();
		queue.setStatus('idle');
		await settle();
		expect(send.sent).toEqual([]);
		resume();
		resume();
		await settle();
		expect(send.sent.map((entry) => entry.text)).toEqual(['first']);
	});
});

describe('PaneQueue: Send now', () => {
	it('hands a row over mid-turn at the agent’s next step, and keeps the rest held', async () => {
		const { queue, send } = queueOn('working');
		queue.add('first');
		const second = queue.add('second');
		await queue.sendNow(second.id);
		expect(send.sent).toEqual([{ text: 'second', images: [], options: SEND_NOW }]);
		expect(SEND_NOW).toEqual({});
		expect(queue.rows.map((row) => row.text)).toEqual(['first']);
	});

	it('is refused while blocked, and keeps a failure on the row', async () => {
		const { queue, send } = queueOn('working');
		const row = queue.add('first');
		queue.setStatus('blocked');
		expect(queue.canSendNow('blocked')).toBe(false);
		await queue.sendNow(row.id);
		expect(send.sent).toEqual([]);

		queue.setStatus('working');
		send.answer(() => Promise.reject(new Error('boom')));
		await queue.sendNow(row.id);
		expect(queue.rows[0]).toMatchObject({ error: 'boom', sending: false });
	});
});

/** A session model with a status set by hand. */
class FakeModel implements SessionModelView {
	state: TranscriptState = emptyTranscript();
	path: string | null = null;
	loaded = false;
	agentSession = '';
	agentStatus: AgentStatus = 'working';
	blockKind = null;
	connected = true;
	readonly listeners = new Set<(change: SessionChange) => void>();
	on(listener: (change: SessionChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	claimBlock(): boolean {
		return true;
	}
	setStatus(status: AgentStatus): void {
		this.agentStatus = status;
		for (const listener of [...this.listeners]) listener({ changedTurnIds: [], reset: false });
	}
}

class FakeModels implements SessionModels {
	held = 0;
	constructor(readonly model: FakeModel) {}
	acquire(): SessionHandleOf<SessionModelView> {
		this.held++;
		let live = true;
		return {
			model: this.model,
			release: () => {
				if (live) this.held--;
				live = false;
			},
		};
	}
}

function recordingSender(): PromptSender & { sent: { paneId: string; text: string; options?: PromptSendOptions }[] } {
	const sent: { paneId: string; text: string; options?: PromptSendOptions }[] = [];
	return {
		sent,
		async send(paneId, text, _images, options) {
			sent.push({ paneId, text, ...(options ? { options } : {}) });
		},
	};
}

describe('PromptQueues', () => {
	it('holds the pane’s model while it has rows, delivers with no view, and survives a reconnect', async () => {
		const model = new FakeModel();
		const models = new FakeModels(model);
		const sender = recordingSender();
		const queues = new PromptQueues({ models, sender: () => sender, timers: manualTimers() });
		const queue = queues.queue('local', 'w1:p1');
		expect(queues.queue('local', 'w1:p1')).toBe(queue);
		expect(models.held).toBe(0);

		queue.add('first');
		expect(models.held).toBe(1);
		// The runtime goes away and comes back: nothing is sent meanwhile.
		model.setStatus('unknown');
		await settle();
		expect(sender.sent).toEqual([]);
		model.setStatus('idle');
		await settle();
		expect(sender.sent).toEqual([{ paneId: 'w1:p1', text: 'first', options: { held: true } }]);
		expect(models.held).toBe(0);
		queues.dispose();
	});

	it('keeps a row with an error when the runtime has no sender', async () => {
		const model = new FakeModel();
		const queues = new PromptQueues({ models: new FakeModels(model), sender: () => null, timers: manualTimers() });
		const queue = queues.queue('gone', 'w1:p1');
		queue.add('first');
		model.setStatus('done');
		await settle();
		expect(queue.rows[0]?.error).toBe('Not connected to herdr.');
		queues.dispose();
	});
});

describe('PromptQueues behind the pane gate (review of #169)', () => {
	it('holds a row back while the session bar drives a picker, and sends it once the gate opens', async () => {
		const model = new FakeModel();
		const inner = recordingSender();
		const gate = new PaneGate({ now: () => 0, later: () => {} });
		const owner = {};
		const sender = gatePromptSender(inner, () => owner, gate);
		const queues = new PromptQueues({
			models: new FakeModels(model),
			sender: () => sender,
			timers: manualTimers(),
			gateChanges: (listener) => gate.on(listener),
		});
		const queue = queues.queue('local', 'w1:p1');
		model.setStatus('working');
		queue.add('first');
		const claim = gate.claim(owner, 'w1:p1');
		// The turn ends while the change runs: the row stays, quietly.
		model.setStatus('done');
		await settle();
		expect(inner.sent).toEqual([]);
		expect(queue.rows.map((row) => [row.text, row.error])).toEqual([['first', null]]);
		// Send now refuses with the gate's words, typing nothing.
		await queue.sendNow(queue.rows[0]?.id ?? '');
		expect(inner.sent).toEqual([]);
		expect(queue.rows[0]?.error).toBe(CHANGING_REASON);
		queue.add('second');
		claim.release(false);
		await settle();
		expect(inner.sent.map((sent) => sent.text)).toEqual(['second']);
		queues.dispose();
	});
});

/** A client that records requests and answers from a table, or throws. */
function fakeClient(answers: Record<string, (params: unknown) => unknown> = {}) {
	const calls: { method: string; params: unknown }[] = [];
	const client: PromptClient & { input: (paneId: string, data: string) => Promise<void>; hasMethod: () => boolean } = {
		async request<T>(method: string, params: unknown): Promise<T> {
			calls.push({ method, params });
			const answer = answers[method];
			return (answer ? answer(params) : null) as T;
		},
		input: async (paneId: string, data: string) => {
			calls.push({ method: 'input', params: { paneId, data } });
		},
		hasMethod: () => true,
	};
	return { client, calls };
}

function terminalIn(state: string) {
	return () => ({ address: 't1', state: 'live', turn: 1, status: { state } });
}

describe('herdr-core: a held row', () => {
	it('is typed with if: "idle" when the program says idle', async () => {
		const { client, calls } = fakeClient({ 'terminal.get': terminalIn('idle') });
		await hcPromptSender(() => client).send('t1', 'next', [], { held: true });
		expect(calls.at(-1)).toEqual({ method: 'terminal.send', params: { terminal: 't1', text: 'next', if: 'idle' } });
	});

	it('is typed with no guard when the program says done, which if: "idle" refuses', async () => {
		const { client, calls } = fakeClient({ 'terminal.get': terminalIn('done') });
		await hcPromptSender(() => client).send('t1', 'next', [], { held: true });
		expect(calls.at(-1)).toEqual({ method: 'terminal.send', params: { terminal: 't1', text: 'next' } });
	});

	it('is held back, with nothing typed, while the program works or is blocked', async () => {
		for (const state of ['working', 'blocked']) {
			const { client, calls } = fakeClient({ 'terminal.get': terminalIn(state) });
			await expect(hcPromptSender(() => client).send('t1', 'next', [], { held: true })).rejects.toBeInstanceOf(
				PromptHeldBack,
			);
			expect(calls.map((call) => call.method)).toEqual(['terminal.get']);
		}
	});

	it('is held back on status_mismatch, and an ordinary send is not', async () => {
		const mismatch = () => {
			throw new HcError('terminal.send', {
				code: -32000,
				message: 't1 is working, not idle',
				data: { kind: 'status_mismatch' },
			});
		};
		const held = fakeClient({ 'terminal.get': terminalIn('idle'), 'terminal.send': mismatch });
		await expect(hcPromptSender(() => held.client).send('t1', 'x', [], { held: true })).rejects.toBeInstanceOf(
			PromptHeldBack,
		);
		const plain = fakeClient({ 'terminal.send': mismatch });
		const error = await hcPromptSender(() => plain.client)
			.send('t1', 'x')
			.catch((caught: unknown) => caught);
		expect(error).not.toBeInstanceOf(PromptHeldBack);
		expect(plain.calls.map((call) => call.method)).toEqual(['terminal.send']);
	});

	it('never guards a held row with images, whose paste goes first', async () => {
		const { client, calls } = fakeClient({
			'terminal.get': terminalIn('idle'),
			'terminal.put': () => ({ path: '/state/files/t1/image.png', bytes: 3 }),
		});
		await hcPromptSender(() => client, () => 1).send('t1', 'see', [IMAGE], { held: true });
		expect(calls.at(-1)).toEqual({ method: 'terminal.send', params: { terminal: 't1', text: 'see' } });
	});

	it('Send now types at once, with no look at the status', async () => {
		const { client, calls } = fakeClient();
		await hcPromptSender(() => client).send('t1', 'now', [], SEND_NOW);
		expect(calls).toEqual([{ method: 'terminal.send', params: { terminal: 't1', text: 'now' } }]);
	});
});

describe('herdr: a held row', () => {
	const noFiles: ImageFiles = { write: async () => [], release: () => {} };

	it('goes with agent.prompt and two fields, held or now', async () => {
		const { client, calls } = fakeClient();
		await clientPromptSender(() => client, noFiles).send('w1:p1', 'held', [], { held: true });
		await clientPromptSender(() => client, noFiles).send('w1:p1', 'now', [], SEND_NOW);
		expect(calls).toEqual([
			{ method: 'agent.prompt', params: { target: 'w1:p1', text: 'held' } },
			{ method: 'agent.prompt', params: { target: 'w1:p1', text: 'now' } },
		]);
	});

	it('is held back on agent_blocked, and only when held', async () => {
		const blocked = () => {
			throw new HerdrError('agent_blocked', 'agent is blocked', 'agent.prompt');
		};
		const { client } = fakeClient({ 'agent.prompt': blocked });
		await expect(clientPromptSender(() => client, noFiles).send('w1:p1', 'x', [], { held: true })).rejects.toBeInstanceOf(
			PromptHeldBack,
		);
		const error = await clientPromptSender(() => client, noFiles)
			.send('w1:p1', 'x')
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(HerdrError);
	});
});

function input(el: FakeElement): FakeElement {
	return el.find('herdr-native-prompt-input');
}

describe('PromptBox with a queue', () => {
	it('holds a prompt typed while the agent works, empties the box, and sends nothing', async () => {
		const { el, host } = hostEl();
		const sender = recordingSender();
		const { queue } = queueOn('working');
		const box = new PromptBox({ paneId: () => 'w1:p1', sender, queue: () => queue, notify: () => {} });
		box.mount(host);
		box.setStatus('working');
		input(el).value = 'also run the tests';
		await box.send();
		expect(sender.sent).toEqual([]);
		expect(queue.rows.map((row) => row.text)).toEqual(['also run the tests']);
		expect(box.text).toBe('');
	});

	it('takes an edited row back before the draft, images first', () => {
		const { el, host } = hostEl();
		const box = new PromptBox({ paneId: () => 'w1:p1', sender: recordingSender(), notify: () => {} });
		box.mount(host);
		box.setStatus('working');
		input(el).value = 'my draft';
		box.restore('queued words', [IMAGE]);
		expect(box.text).toBe('queued words\nmy draft');
		expect(box.attachedImages).toEqual([IMAGE]);
	});
});

async function surfaceOn(model: FakeModel, queues: PromptQueues, sender: PromptSender) {
	const { el, host } = hostEl();
	const app = { workspace: { openLinkText: vi.fn() } } as unknown as App;
	const surface = new NativePaneSurface({
		app,
		identity: { paneId: 'w1:p1', mode: 'control', endpointId: 'local' },
		onStatus: () => {},
		models: new FakeModels(model),
		queues,
		sender,
		keySender: { sendKeys: async () => {} },
		openInTerminal: () => {},
		autoTrustFolders: () => false,
		presentation: () => 'highlight',
		vaultPath: () => '',
	});
	await surface.attach(host);
	return { surface, el };
}

describe('NativePaneSurface: queued rows', () => {
	it('draws a held row with Send now, Edit and Discard, and Edit puts it back in the box', async () => {
		const model = new FakeModel();
		const sender = recordingSender();
		const queues = new PromptQueues({ models: new FakeModels(model), sender: () => sender, timers: manualTimers() });
		const { el } = await surfaceOn(model, queues, sender);
		input(el).value = 'check the build';
		el.find('herdr-native-prompt-send').dispatch('click');
		await settle();
		expect(sender.sent).toEqual([]);

		const row = el.find('herdr-native-queue-row');
		expect(row.find('herdr-native-queue-text').textContent).toBe('check the build');
		expect(row.find('herdr-native-queue-send').disabled).toBe(false);

		row.find('herdr-native-queue-edit').dispatch('click');
		expect(el.findAll('herdr-native-queue-row')).toEqual([]);
		expect(input(el).value).toBe('check the build');
		queues.dispose();
	});

	it('keeps rows across a detach, disables Send now while blocked, and discards', async () => {
		const model = new FakeModel();
		const sender = recordingSender();
		const queues = new PromptQueues({ models: new FakeModels(model), sender: () => sender, timers: manualTimers() });
		queues.queue('local', 'w1:p1').add('later');
		const first = await surfaceOn(model, queues, sender);
		await first.surface.detach();
		const { el } = await surfaceOn(model, queues, sender);
		expect(el.find('herdr-native-queue-text').textContent).toBe('later');

		model.setStatus('blocked');
		expect(el.find('herdr-native-queue-send').disabled).toBe(true);
		el.find('herdr-native-queue-discard').dispatch('click');
		expect(el.findAll('herdr-native-queue-row')).toEqual([]);
		expect(sender.sent).toEqual([]);
		queues.dispose();
	});

	it('shows what Claude holds as queued in Claude, with no actions, only while it works', async () => {
		const model = new FakeModel();
		model.state = { ...emptyTranscript(), pendingQueue: ['typed in the terminal [Image #1]'] };
		const sender = recordingSender();
		const queues = new PromptQueues({ models: new FakeModels(model), sender: () => sender, timers: manualTimers() });
		const { el } = await surfaceOn(model, queues, sender);
		model.setStatus('working');
		const row = el.find('herdr-is-agent-held');
		expect(row.find('herdr-native-queue-text').textContent).toBe('typed in the terminal');
		expect(row.find('herdr-native-queue-note').textContent).toBe('Queued in Claude.');
		expect(row.findAll('herdr-native-queue-send')).toEqual([]);

		model.setStatus('done');
		expect(el.findAll('herdr-is-agent-held')).toEqual([]);
		queues.dispose();
	});
});
