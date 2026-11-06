/**
 * The session bar under the prompt box (#161): the model, effort and mode
 * pickers and the context readout, through the native surface with a fake
 * session model whose session info is Claude's format reading real 2.1.318
 * lines (`fixtures/transcripts/session-settings.jsonl`, as in
 * `claudeSessionInfo.test.ts`), and the pure helpers under it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { hostEl, type FakeElement } from './fixtures/dom';
import { MarkdownRenderer, Menu } from './fixtures/obsidian';
import { CLAUDE_FORMAT } from '../src/agents/claude/format';
import { emptyTranscript, reduce, type TranscriptState } from '../src/agents/claude/transcript';
import type { AgentFormat } from '../src/agents/format';
import type { SessionInfo } from '../src/native/conversation';
import type {
	BlockKind,
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from '../src/native/sessionModel';
import {
	BLOCKED_REASON,
	contextReadout,
	effortText,
	formatTokens,
	isCurrentMode,
	isCurrentModel,
	modelText,
	NO_AGENT_REASON,
	NO_CHOICES_REASON,
	NO_SENDER_REASON,
	pickerBlock,
	WORKING_REASON,
	type SessionSettingsSender,
	type SettingQuestion,
	type SettingScope,
} from '../src/native/sessionSettings';
import { NativePaneSurface, type NativePaneSurfaceOptions } from '../src/native/surface';
import {
	breakdownHeadline,
	contextBlock,
	contextTokens,
	CONTEXT_WAIT_MS,
	NO_BREAKDOWN_REASON,
	type ContextBreakdown,
} from '../src/native/contextBreakdown';
import type { AgentStatus } from '../src/herdr/types.gen';

const LINES = readFileSync(join(__dirname, 'fixtures', 'transcripts', 'session-settings.jsonl'), 'utf8')
	.split('\n')
	.filter(Boolean);

/** A session model whose info is the Claude format's reading of the lines pushed so far. */
class FakeModel implements SessionModelView {
	state: TranscriptState = emptyTranscript();
	path: string | null = '/transcript.jsonl';
	loaded = true;
	agentSession = 'session';
	agentStatus: AgentStatus = 'idle';
	blockKind: BlockKind | null = null;
	connected = true;
	format: AgentFormat | null = CLAUDE_FORMAT;
	/** The runtime's overlay, when a case gives one. */
	overlay: SessionInfo = {};
	private readonly listeners = new Set<(change: SessionChange) => void>();

	get sessionInfo(): SessionInfo {
		return { ...CLAUDE_FORMAT.sessionInfo(this.state), ...this.overlay };
	}

	on(listener: (change: SessionChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	claimBlock(): boolean {
		return true;
	}

	/** Reduces `lines` and tells the views, as the real model does after a tail batch. */
	read(lines: string[]): void {
		const result = reduce(this.state, lines);
		this.state = result.state;
		this.emit({ changedTurnIds: result.changedTurnIds, reset: false });
	}

	emit(change: SessionChange = { changedTurnIds: [], reset: false }): void {
		for (const listener of [...this.listeners]) listener(change);
	}
}

class FakeModels implements SessionModels {
	constructor(readonly model: FakeModel) {}
	acquire(): SessionHandleOf<SessionModelView> {
		return { model: this.model, release: () => {} };
	}
}

/** A sender that records its calls and answers as a case says. */
class FakeSender implements SessionSettingsSender {
	scopes: SettingScope[] = ['session'];
	settings: SessionSettingsSender['settings'] = ['model', 'effort', 'mode'];
	midTurn = true;
	modes?: readonly string[];
	readMode?: (paneId: string) => Promise<string | null>;
	unavailable?: (paneId: string) => string | null;
	readonly calls: string[] = [];
	failWith: string | null = null;
	/** Holds every call open until released, so the busy state can be seen. */
	hold: Promise<void> | null = null;

	private async answer(call: string): Promise<void> {
		this.calls.push(call);
		if (this.hold) await this.hold;
		if (this.failWith) throw new Error(this.failWith);
	}

	setModel(paneId: string, model: string, scope: SettingScope): Promise<void> {
		return this.answer(`model ${paneId} ${model} ${scope}`);
	}

	setEffort(paneId: string, effort: string, scope: SettingScope): Promise<void> {
		return this.answer(`effort ${paneId} ${effort} ${scope}`);
	}

	setMode(paneId: string, mode: string): Promise<void> {
		return this.answer(`mode ${paneId} ${mode}`);
	}
}

function surfaceOn(
	model: FakeModel,
	sender: SessionSettingsSender | null,
	extra: Partial<NativePaneSurfaceOptions> = {},
) {
	const { el, host } = hostEl();
	const notices: string[] = [];
	const app = {
		workspace: { openLinkText: () => {} },
		vault: { getConfig: () => false, on: () => ({}), offref: () => {} },
	} as unknown as App;
	const surface = new NativePaneSurface({
		app,
		identity: { paneId: 'w4:p1', mode: 'control', endpointId: 'local' },
		onStatus: () => {},
		models: new FakeModels(model),
		sender: { send: async () => {} },
		keySender: { sendKeys: async () => {} },
		...(sender ? { sessionSettings: () => sender } : {}),
		notify: (message) => notices.push(message),
		openInTerminal: () => {},
		autoTrustFolders: () => false,
		presentation: () => 'highlight',
		vaultPath: () => '/vault',
		...extra,
	});
	return { surface, el, host, notices };
}

function picker(el: FakeElement, setting: 'model' | 'effort' | 'mode'): FakeElement {
	return el.find(`herdr-native-session-${setting}`);
}

function shown(el: FakeElement, setting: 'model' | 'effort' | 'mode'): string {
	return picker(el, setting).find('herdr-native-session-value').textContent;
}

/** Waits for the microtasks a pick's promise chain needs. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
	MarkdownRenderer.reset();
	Menu.shown = [];
});

describe('the session bar in the native surface (#161)', () => {
	it('shows — for every value before anything states one, and no readout', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model, null);
		await surface.attach(host);

		const bar = el.find('herdr-native-session-bar');
		expect(bar.hasClass('herdr-native-sizer')).toBe(true);
		expect(shown(el, 'model')).toBe('—');
		expect(shown(el, 'effort')).toBe('—');
		expect(shown(el, 'mode')).toBe('—');
		expect(el.find('herdr-native-session-context').hasClass('herdr-is-hidden')).toBe(true);
	});

	it('updates in place for a reply, a /model line and a compaction', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model, null);
		await surface.attach(host);
		const bar = el.find('herdr-native-session-bar');
		const modelButton = picker(el, 'model');
		const tokens = el.find('herdr-native-session-tokens');

		// The first prompt, the model attachment and the first reply.
		model.read(LINES.slice(0, 3));
		expect(shown(el, 'model')).toBe('Opus 5.5');
		expect(picker(el, 'model').find('herdr-native-session-short').textContent).toBe('Opus');
		expect(shown(el, 'effort')).toBe('◐ medium');
		expect(shown(el, 'mode')).toBe('Manual');
		// No window yet: tokens alone, no percentage.
		expect(tokens.textContent).toBe('23k');
		expect(el.find('herdr-native-session-context').hasClass('herdr-has-window')).toBe(false);

		// `/context` states the window: now the share.
		model.read(LINES.slice(3, 7));
		expect(tokens.textContent).toBe('23k / 1M');
		expect(el.find('herdr-native-session-percent').textContent).toBe('2%');
		expect(el.find('herdr-native-session-context').hasClass('herdr-has-window')).toBe(true);

		// "Set model to `Haiku 5.5` and saved as your default": at once, and
		// the window it stated was the old model's.
		model.read(LINES.slice(7, 10));
		expect(shown(el, 'model')).toBe('Haiku 5.5');
		expect(el.find('herdr-native-session-context').hasClass('herdr-has-window')).toBe(false);

		// A compaction, then a reply that used far less.
		model.read([
			JSON.stringify({
				type: 'system',
				subtype: 'compact_boundary',
				content: 'Conversation compacted',
				isSidechain: false,
				uuid: 'compact-1',
				compactMetadata: { trigger: 'manual', preTokens: 26922 },
			}),
			JSON.stringify({
				type: 'assistant',
				isSidechain: false,
				uuid: 'after-compact',
				effort: 'low',
				message: {
					model: 'claude-haiku-5-5',
					id: 'msg_after',
					role: 'assistant',
					content: [{ type: 'text', text: 'ok' }],
					usage: { input_tokens: 2, cache_creation_input_tokens: 4000, cache_read_input_tokens: 0, output_tokens: 3 },
				},
			}),
		]);
		expect(tokens.textContent).toBe('4k');
		expect(shown(el, 'effort')).toBe('○ low');

		// Never redrawn: the same row, the same buttons, the same readout.
		expect(el.find('herdr-native-session-bar')).toBe(bar);
		expect(picker(el, 'model')).toBe(modelButton);
		expect(el.find('herdr-native-session-tokens')).toBe(tokens);
	});

	it('turns amber from 80% of the window', async () => {
		const model = new FakeModel();
		model.overlay = { contextUsed: 170_000, contextWindow: { tokens: 200_000, source: 'runtime' } };
		const { surface, el, host } = surfaceOn(model, null);
		await surface.attach(host);
		const readout = el.find('herdr-native-session-context');
		expect(readout.hasClass('herdr-is-warning')).toBe(true);
		expect(el.find('herdr-native-session-percent').textContent).toBe('85%');
		model.overlay = { contextUsed: 100_000, contextWindow: { tokens: 200_000, source: 'runtime' } };
		model.emit();
		expect(readout.hasClass('herdr-is-warning')).toBe(false);
	});

	it('disables the pickers with the reason on a runtime with no sender yet', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model, null);
		await surface.attach(host);
		model.read(LINES.slice(0, 3));

		for (const setting of ['model', 'effort', 'mode'] as const) {
			expect(picker(el, setting).disabled).toBe(true);
		}
		expect(picker(el, 'model').getAttribute('aria-label')).toBe(`Model: Opus 5.5. ${NO_SENDER_REASON}`);
		picker(el, 'model').dispatch('click', { clientX: 1, clientY: 2 });
		expect(Menu.shown).toEqual([]);
	});

	it('lists the format’s values with the current one checked, and sends a pick', async () => {
		const model = new FakeModel();
		const sender = new FakeSender();
		const { surface, el, host } = surfaceOn(model, sender);
		await surface.attach(host);
		model.read(LINES.slice(0, 3));
		expect(picker(el, 'model').disabled).toBe(false);
		expect(picker(el, 'model').getAttribute('aria-label')).toBe('Model: Opus 5.5');

		picker(el, 'model').dispatch('click', { clientX: 1, clientY: 2 });
		const menu = Menu.shown[0];
		expect(menu?.items.map((item) => item.title)).toEqual(['Opus', 'Sonnet', 'Haiku', 'Fable']);
		expect(menu?.items.map((item) => item.checked)).toEqual([true, false, false, false]);
		menu?.items[1]?.click?.();
		await settle();
		expect(sender.calls).toEqual(['model w4:p1 sonnet session']);

		picker(el, 'effort').dispatch('click', {});
		const efforts = Menu.shown[1];
		expect(efforts?.items.map((item) => item.title)).toEqual(['○ low', '◐ medium', '● high', 'xhigh', 'max', 'auto']);
		expect(efforts?.items.find((item) => item.checked)?.title).toBe('◐ medium');
		efforts?.items[2]?.click?.();

		picker(el, 'mode').dispatch('click', {});
		const modes = Menu.shown[2];
		// `bypassPermissions` is never one click away.
		expect(modes?.items.map((item) => item.title)).toEqual(['Manual', 'Accept edits', 'Plan', 'Auto', "Don't ask"]);
		expect(modes?.items.find((item) => item.checked)?.title).toBe('Manual');
		modes?.items[1]?.click?.();
		await settle();
		expect(sender.calls).toEqual(['model w4:p1 sonnet session', 'effort w4:p1 high session', 'mode w4:p1 acceptEdits']);
	});

	it('offers the default as a second group where the kind can save it', async () => {
		const model = new FakeModel();
		const sender = new FakeSender();
		sender.scopes = ['session', 'default'];
		const { surface, el, host } = surfaceOn(model, sender);
		await surface.attach(host);
		model.read(LINES.slice(0, 3));
		picker(el, 'model').dispatch('click', {});
		const items = Menu.shown[0]?.items ?? [];
		expect(items.map((item) => item.title)).toEqual([
			'Opus', 'Sonnet', 'Haiku', 'Fable',
			'Use for new sessions too',
			"Also becomes Claude's default for new sessions, in and outside Obsidian.",
			'Opus', 'Sonnet', 'Haiku', 'Fable',
		]);
		expect(items[4]?.isLabel).toBe(true);
		expect(items[5]?.isLabel).toBe(true);
		items[8]?.click?.();
		await settle();
		expect(sender.calls).toEqual(['model w4:p1 haiku default']);

		// The effort's default is per model.
		picker(el, 'effort').dispatch('click', {});
		expect(Menu.shown[1]?.items.map((item) => item.title)).toContain(
			"Also becomes Claude's default for this model in new sessions, in and outside Obsidian.",
		);
	});

	it("hands the agent's question on the way to a model switch to the user (#169)", async () => {
		const model = new FakeModel();
		const asked: SettingQuestion[] = [];
		let answer: boolean | null = null;
		const sender: SessionSettingsSender = {
			scopes: ['session'],
			settings: ['model', 'effort', 'mode'],
			midTurn: false,
			async setModel(_paneId, _model, _scope, ask) {
				const question = { title: 'Switch model?', body: 'Re-read', confirm: 'Yes, switch to Sonnet 5.5', cancel: 'No, go back' };
				answer = (await ask?.(question)) ?? null;
			},
			setEffort: () => Promise.resolve(),
			setMode: () => Promise.resolve(),
		};
		const { surface, el, host } = surfaceOn(model, sender, {
			confirmSetting: (question) => {
				asked.push(question);
				return Promise.resolve(false);
			},
		});
		await surface.attach(host);
		model.read(LINES.slice(0, 3));
		picker(el, 'model').dispatch('click', {});
		Menu.shown[0]?.items[1]?.click?.();
		await settle();
		expect(asked.map((q) => q.confirm)).toEqual(['Yes, switch to Sonnet 5.5']);
		expect(answer).toBe(false);
	});

	it("shows the footer's mode where the runtime reports none, and the transcript's as at the last prompt (#170)", async () => {
		const model = new FakeModel();
		const sender = new FakeSender();
		sender.modes = ['default', 'acceptEdits', 'plan', 'auto'];
		let footer: string | null = 'plan';
		sender.readMode = () => Promise.resolve(footer);
		const { surface, el, host } = surfaceOn(model, sender);
		await surface.attach(host);
		model.read(LINES.slice(0, 3));
		expect(shown(el, 'mode')).toBe('Manual');
		expect(picker(el, 'mode').getAttribute('aria-label')).toBe('Permission mode: Manual (at the last prompt)');

		// Opening the menu reads the footer first, and lists only what shift+tab reaches.
		picker(el, 'mode').dispatch('click', { clientX: 3, clientY: 4 });
		await settle();
		expect(shown(el, 'mode')).toBe('Plan');
		expect(picker(el, 'mode').getAttribute('aria-label')).toBe('Permission mode: Plan');
		const menu = Menu.shown[0];
		expect(menu?.position).toEqual({ x: 3, y: 4 });
		expect(menu?.items.map((item) => item.title)).toEqual(['Manual', 'Accept edits', 'Plan', 'Auto']);
		expect(menu?.items.find((item) => item.checked)?.title).toBe('Plan');

		// After a change the footer is read again, whatever the sender said.
		footer = 'auto';
		menu?.items[3]?.click?.();
		await settle();
		await settle();
		expect(sender.calls).toEqual(['mode w4:p1 auto']);
		expect(shown(el, 'mode')).toBe('Auto');

		// A new prompt's mode is the transcript's again.
		model.overlay = { permissionMode: 'acceptEdits' };
		model.emit();
		expect(shown(el, 'mode')).toBe('Accept edits');
	});

	it('disables the other pickers while a kind that changes one thing at a time is busy', async () => {
		const model = new FakeModel();
		const sender = new FakeSender();
		let busy = false;
		sender.unavailable = () => (busy ? 'Another change is on its way to this pane.' : null);
		let release = (): void => {};
		sender.hold = new Promise((done) => {
			release = done;
		});
		const { surface, el, host } = surfaceOn(model, sender);
		await surface.attach(host);
		model.read(LINES.slice(0, 3));
		picker(el, 'effort').dispatch('click', {});
		busy = true;
		Menu.shown[0]?.items[0]?.click?.();
		await settle();
		expect(picker(el, 'model').disabled).toBe(true);
		busy = false;
		release();
		await settle();
		expect(picker(el, 'model').disabled).toBe(false);
	});

	it('keeps a picker disabled until its change is answered, and turns a refusal into a notice', async () => {
		const model = new FakeModel();
		const sender = new FakeSender();
		let release = (): void => {};
		sender.hold = new Promise((done) => {
			release = done;
		});
		sender.failWith = 'Cannot set permission mode: must be one of acceptEdits, auto';
		const { surface, el, host, notices } = surfaceOn(model, sender);
		await surface.attach(host);
		model.read(LINES.slice(0, 3));

		picker(el, 'mode').dispatch('click', {});
		Menu.shown[0]?.items[2]?.click?.();
		await settle();
		expect(picker(el, 'mode').disabled).toBe(true);
		expect(picker(el, 'model').disabled).toBe(false);
		release();
		await settle();
		expect(picker(el, 'mode').disabled).toBe(false);
		expect(notices).toEqual([
			'Gjetr: could not change the permission mode (Cannot set permission mode: must be one of acceptEdits, auto)',
		]);
		// Nothing optimistic: the value is still the session's.
		expect(shown(el, 'mode')).toBe('Manual');
	});

	it('stays in sight, disabled, while the waiting card hides the prompt box', async () => {
		const model = new FakeModel();
		const sender = new FakeSender();
		const { surface, el, host } = surfaceOn(model, sender);
		await surface.attach(host);
		model.read(LINES.slice(0, 3));
		model.agentStatus = 'blocked';
		model.emit();

		expect(el.find('herdr-native-prompt-box').hasClass('herdr-is-hidden')).toBe(true);
		const bar = el.find('herdr-native-session-bar');
		expect(bar.hasClass('herdr-is-hidden')).toBe(false);
		expect(shown(el, 'model')).toBe('Opus 5.5');
		expect(picker(el, 'model').disabled).toBe(true);
		expect(picker(el, 'model').getAttribute('aria-label')).toBe(`Model: Opus 5.5. ${BLOCKED_REASON}`);
	});

	it('goes with the surface on detach', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model, null);
		await surface.attach(host);
		await surface.detach();
		expect(el.findAll('herdr-native-session-bar')).toEqual([]);
	});
});

describe('session settings helpers (#161)', () => {
	const plain = (overrides: Partial<SessionSettingsSender> = {}): SessionSettingsSender => ({
		scopes: ['session'],
		settings: ['model', 'effort', 'mode'],
		midTurn: true,
		setModel: () => Promise.resolve(),
		setEffort: () => Promise.resolve(),
		setMode: () => Promise.resolve(),
		...overrides,
	});
	const sender = plain();
	const base = { setting: 'model' as const, status: 'idle' as AgentStatus, connected: true, sender, paneId: 'p', choices: 3 };

	it('words why a picker is disabled, in the order the reader fixes things', () => {
		expect(pickerBlock(base)).toBeNull();
		expect(pickerBlock({ ...base, connected: false })).toBe(NO_AGENT_REASON);
		expect(pickerBlock({ ...base, status: 'unknown' })).toBe(NO_AGENT_REASON);
		expect(pickerBlock({ ...base, sender: null })).toBe(NO_SENDER_REASON);
		expect(pickerBlock({ ...base, status: 'blocked' })).toBe(BLOCKED_REASON);
		expect(pickerBlock({ ...base, status: 'working' })).toBeNull();
		expect(pickerBlock({ ...base, status: 'working', sender: plain({ midTurn: false }) })).toBe(WORKING_REASON);
		expect(pickerBlock({ ...base, setting: 'mode', sender: plain({ settings: ['model'] }) })).toBe(NO_SENDER_REASON);
		const busyPane = plain({ unavailable: () => 'the agent is in its terminal view' });
		expect(pickerBlock({ ...base, sender: busyPane })).toBe('the agent is in its terminal view');
		expect(pickerBlock({ ...base, choices: 0 })).toBe(NO_CHOICES_REASON);
	});

	it('counts tokens the way /context does', () => {
		expect(formatTokens(850)).toBe('850');
		expect(formatTokens(22_550)).toBe('23k');
		expect(formatTokens(200_000)).toBe('200k');
		expect(formatTokens(1_000_000)).toBe('1M');
		expect(formatTokens(1_500_000)).toBe('1.5M');
	});

	it('shows no percentage without a window, and says where a window came from', () => {
		expect(contextReadout({})).toEqual({ tokens: '', percent: '', warning: false, title: '' });
		expect(contextReadout({ contextUsed: 22_550 })).toMatchObject({ tokens: '23k', percent: '' });
		const known = contextReadout({ contextUsed: 22_550, contextWindow: { tokens: 1_000_000, source: 'context-command' } });
		expect(known).toMatchObject({ tokens: '23k / 1M', percent: '2%', warning: false });
		expect(known.title).toBe('Context: 22,550 of 1,000,000 tokens, the window from /context');
	});

	it('knows the current model by name or by id', () => {
		const opus = { value: 'opus', label: 'Opus' };
		expect(isCurrentModel({ id: 'claude-opus-5-5', label: 'Opus 5.5' }, opus)).toBe(true);
		expect(isCurrentModel({ id: 'claude-opus-5-5', label: 'claude-opus-5-5' }, opus)).toBe(true);
		expect(isCurrentModel({ id: '', label: 'Opus in plan mode, else Sonnet' }, { value: 'sonnet', label: 'Sonnet' })).toBe(true);
		expect(isCurrentModel({ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, opus)).toBe(false);
		expect(isCurrentModel(undefined, opus)).toBe(false);
		expect(modelText(undefined)).toEqual({ full: '—', short: '—' });
		expect(modelText({ id: 'claude-haiku-5-5', label: 'Haiku 5.5' })).toEqual({ full: 'Haiku 5.5', short: 'Haiku' });
	});

	it('takes default and manual for one mode, and shows Claude’s effort glyphs', () => {
		const labels = CLAUDE_FORMAT.modeLabels;
		expect(isCurrentMode('manual', 'default', labels)).toBe(true);
		expect(isCurrentMode('plan', 'default', labels)).toBe(false);
		expect(effortText('medium')).toEqual({ full: '◐ medium', short: '◐' });
		expect(effortText('xhigh')).toEqual({ full: 'xhigh', short: 'xhigh' });
		expect(effortText(undefined)).toEqual({ full: '—', short: '—' });
	});
});

describe('the context breakdown from the readout (#171)', () => {
	beforeEach(() => {
		vi.stubGlobal('window', globalThis);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	/** A prompt sender that records what it sent. */
	function promptSender() {
		const sent: string[] = [];
		return { sent, sender: { send: async (paneId: string, text: string) => void sent.push(`${paneId} ${text}`) } };
	}

	function readout(el: FakeElement): FakeElement {
		return el.find('herdr-native-session-context');
	}

	function rows(el: FakeElement): string[][] {
		return el
			.find('herdr-native-context-table')
			.querySelectorAll('tr')
			.map((row) => row.querySelectorAll('td').map((cell) => cell.textContent))
			.filter((cells) => cells.length > 0);
	}

	it('sends /context through the prompt when idle, and shows its output, never as a turn (herdr, herdr-core)', async () => {
		const model = new FakeModel();
		const { sent, sender } = promptSender();
		const { surface, el, host, notices } = surfaceOn(model, null, { sender });
		await surface.attach(host);
		model.read(LINES.slice(0, 4));
		const turns = model.state.turns.length;

		readout(el).dispatch('click');
		await settle();
		expect(sent).toEqual(['w4:p1 /context']);
		expect(readout(el).disabled).toBe(true);
		expect(el.findAll('herdr-native-context-popover')).toEqual([]);

		// The `local_command` lines and the `isMeta` Markdown, as Claude writes them.
		model.read(LINES.slice(4, 7));
		await settle();
		expect(model.state.turns).toHaveLength(turns);
		const popover = el.find('herdr-native-context-popover');
		expect(popover.find('herdr-native-context-title').textContent).toBe('claude-opus-5-5 · 22.6k / 1m tokens (2%)');
		expect(rows(el)[0]).toEqual(['System prompt', '2.4k', '0.2%']);
		expect(readout(el).disabled).toBe(false);
		expect(readout(el).getAttribute('aria-expanded')).toBe('true');
		expect(notices).toEqual([]);

		// A second click closes it, as the close button does.
		readout(el).dispatch('click');
		await settle();
		expect(el.findAll('herdr-native-context-popover')).toEqual([]);
		expect(sent).toHaveLength(1);
	});

	it('waits for a report newer than the one the session already had', async () => {
		const model = new FakeModel();
		const { sent, sender } = promptSender();
		const { surface, el, host } = surfaceOn(model, null, { sender });
		await surface.attach(host);
		// The first `/context` is history by the time of the click.
		model.read(LINES.slice(0, 20));
		readout(el).dispatch('click');
		await settle();
		model.emit();
		await settle();
		expect(el.findAll('herdr-native-context-popover')).toEqual([]);
		model.read(LINES.slice(20, 25));
		await settle();
		expect(sent).toHaveLength(1);
		expect(el.find('herdr-native-context-title').textContent).toBe('claude-haiku-5-5 · 26.9k / 1m tokens (3%)');
		el.find('herdr-native-context-close').dispatch('click');
		expect(el.findAll('herdr-native-context-popover')).toEqual([]);
	});

	it('sends nothing while the agent works or is blocked, and says why', async () => {
		const model = new FakeModel();
		const { sent, sender } = promptSender();
		const { surface, el, host } = surfaceOn(model, null, { sender });
		await surface.attach(host);
		model.read(LINES.slice(0, 3));
		model.agentStatus = 'working';
		model.emit();
		expect(readout(el).disabled).toBe(true);
		expect(readout(el).getAttribute('aria-label')).toBe(`Context: 22,550 tokens. ${WORKING_REASON}`);
		readout(el).dispatch('click');
		model.agentStatus = 'blocked';
		model.emit();
		expect(readout(el).getAttribute('aria-label')).toBe(`Context: 22,550 tokens. ${BLOCKED_REASON}`);
		readout(el).dispatch('click');
		await settle();
		expect(sent).toEqual([]);
		model.agentStatus = 'done';
		model.emit();
		expect(readout(el).disabled).toBe(false);
	});

	it('gives up with a notice when the output never reaches the transcript', async () => {
		vi.useFakeTimers();
		const model = new FakeModel();
		const { sender } = promptSender();
		const { surface, el, host, notices } = surfaceOn(model, null, { sender });
		await surface.attach(host);
		model.read(LINES.slice(0, 3));
		readout(el).dispatch('click');
		await settle();
		vi.advanceTimersByTime(CONTEXT_WAIT_MS);
		await settle();
		expect(notices).toEqual([
			'Gjetr: could not read the context breakdown (it did not reach the transcript in time)',
		]);
		expect(readout(el).disabled).toBe(false);
	});

	it('asks the runtime’s reader instead where there is one, mid-turn too, and sends no prompt (claude kind)', async () => {
		const model = new FakeModel();
		const { sent, sender } = promptSender();
		const reads: string[] = [];
		const breakdown: ContextBreakdown = {
			id: 'r1',
			model: 'claude-opus-5-5',
			used: '14.6k',
			window: '1m',
			percent: '1%',
			categories: [{ name: 'Messages', tokens: '107', share: '0.0%' }],
		};
		let fail: string | null = null;
		const { surface, el, host, notices } = surfaceOn(model, null, {
			sender,
			contextUsage: () => ({
				read: async (paneId: string) => {
					reads.push(paneId);
					if (fail) throw new Error(fail);
					return breakdown;
				},
			}),
		});
		await surface.attach(host);
		model.read(LINES.slice(0, 3));
		model.agentStatus = 'working';
		model.emit();
		expect(readout(el).disabled).toBe(false);
		readout(el).dispatch('click');
		await settle();
		expect(reads).toEqual(['w4:p1']);
		expect(sent).toEqual([]);
		expect(rows(el)).toEqual([['Messages', '107', '0.0%']]);
		readout(el).dispatch('click');
		fail = 'the agent is in its terminal view; run /context there';
		readout(el).dispatch('click');
		await settle();
		expect(notices).toEqual([
			'Gjetr: could not read the context breakdown (the agent is in its terminal view; run /context there)',
		]);
		expect(el.findAll('herdr-native-context-popover')).toEqual([]);
	});

	it('opens nothing for an agent with no breakdown, and goes with the surface on detach', async () => {
		const model = new FakeModel();
		model.format = { ...CLAUDE_FORMAT, contextCommand: undefined };
		const { sender } = promptSender();
		const { surface, el, host } = surfaceOn(model, null, { sender });
		await surface.attach(host);
		model.read(LINES.slice(0, 3));
		expect(readout(el).disabled).toBe(true);
		expect(readout(el).getAttribute('aria-label')).toBe(`Context: 22,550 tokens. ${NO_BREAKDOWN_REASON}`);

		model.format = CLAUDE_FORMAT;
		model.emit();
		readout(el).dispatch('click');
		await settle();
		model.read(LINES.slice(3, 7));
		await settle();
		expect(el.findAll('herdr-native-context-popover')).toHaveLength(1);
		await surface.detach();
		expect(el.findAll('herdr-native-context-popover')).toEqual([]);
	});
});

describe('context breakdown helpers (#171)', () => {
	it('counts tokens the way /context words them', () => {
		expect(contextTokens(276)).toBe('276');
		expect(contextTokens(2256)).toBe('2.3k');
		expect(contextTokens(33000)).toBe('33k');
		expect(contextTokens(952351)).toBe('952.4k');
		expect(contextTokens(999_990)).toBe('1m');
		expect(contextTokens(1_000_000)).toBe('1m');
		expect(contextTokens(1_500_000)).toBe('1.5m');
	});

	it('words the headline with what it has', () => {
		const base = { id: 'x', model: '', used: '23k', window: '', percent: '', categories: [] };
		expect(breakdownHeadline(base)).toBe('23k tokens');
		expect(breakdownHeadline({ ...base, model: 'm', window: '1m', percent: '2%' })).toBe('m · 23k / 1m tokens (2%)');
	});

	it('asks through a context command only when idle or done, through a reader at any status but a block', () => {
		const at = (status: AgentStatus, reader: boolean, command?: string) =>
			contextBlock({ status, connected: true, paneId: 'p', reader, command });
		expect(at('idle', false, '/context')).toBeNull();
		expect(at('done', false, '/context')).toBeNull();
		expect(at('working', false, '/context')).toBe(WORKING_REASON);
		expect(at('working', true)).toBeNull();
		expect(at('blocked', true)).toBe(BLOCKED_REASON);
		expect(at('idle', false)).toBe(NO_BREAKDOWN_REASON);
		expect(contextBlock({ status: 'idle', connected: false, paneId: 'p', reader: true, command: undefined })).toBe(
			NO_AGENT_REASON,
		);
	});
});
