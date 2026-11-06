/**
 * Screen access per runtime (#164, ADR-0009): read the visible screen, press
 * one key, type text, on herdr and herdr-core. The facts these pin are in
 * `docs/architecture.md`, "Answering Claude's dialogs from the screen":
 * herdr merges printable keys sent in one `agent.send_keys`, so every press
 * is its own call. On hc, text whose every character has a key name goes
 * through `terminal.keys` (capitals as `shift+<letter>`), which never touches
 * the size; other text as one AUTOMATIC_INPUT frame on a resumed attach at the
 * terminal's own grid, refused where that attach's close would put the
 * terminal back to 200x120 (#172).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	herdrScreenAccess,
	SCREEN_KEYS,
	screenTextIssue,
	type ScreenAccess,
	type ScreenKey,
} from '../src/native/screenAccess';
import { NO_CONNECTION_MESSAGE, type PromptClient } from '../src/native/promptSender';
import { hcScreenAccess, hcTextKeys } from '../src/hc/actions';
import { HcClient } from '../src/hc/client';
import { FrameKind } from '../src/hc/frames';
import { createHerdrKind } from '../src/runtime/herdrKind';
import { createHerdrCoreKind } from '../src/runtime/herdrCoreKind';
import { createClaudeKind } from '../src/runtime/claudeKind';
import { fakeSpawner, HELLO_RESULT, RpcError, type FakeCore } from './fixtures/fakeHc';

const SCREENS = join(__dirname, 'fixtures', 'screens', 'claude-2.1.318');
const HERDR_SCREEN = readFileSync(join(SCREENS, 'herdr-ask-single.txt'), 'utf8');
const HC_SCREEN = readFileSync(join(SCREENS, 'hc-ask-single.txt'), 'utf8');

/** A herdr client that records every request and answers like herdr 0.9.5. */
function fakeHerdr(): { client: PromptClient; calls: { method: string; params: unknown }[] } {
	const calls: { method: string; params: unknown }[] = [];
	const client: PromptClient = {
		request<T>(method: string, params: unknown): Promise<T> {
			calls.push({ method, params });
			if (method === 'pane.read') {
				const { pane_id } = params as { pane_id: string };
				return Promise.resolve({
					type: 'pane_read',
					read: {
						pane_id,
						workspace_id: 'w1',
						tab_id: 'w1:t1',
						source: 'visible',
						format: 'text',
						revision: 15,
						truncated: false,
						text: HERDR_SCREEN,
					},
				} as T);
			}
			return Promise.resolve({ type: 'ok' } as T);
		},
	};
	return { client, calls };
}

describe('herdr screen access', () => {
	it('reads the visible screen as text', async () => {
		const { client, calls } = fakeHerdr();
		const screen = herdrScreenAccess(() => client);

		expect(await screen.read('w1:p2')).toBe(HERDR_SCREEN);
		expect(calls).toEqual([
			{ method: 'pane.read', params: { pane_id: 'w1:p2', source: 'visible', format: 'text' } },
		]);
	});

	it('presses one key per agent.send_keys call, so herdr never merges two digits', async () => {
		const { client, calls } = fakeHerdr();
		const screen = herdrScreenAccess(() => client);

		await screen.press('w1:p2', '1');
		await screen.press('w1:p2', '3');
		await screen.press('w1:p2', 'down');

		expect(calls).toEqual([
			{ method: 'agent.send_keys', params: { target: 'w1:p2', keys: ['1'] } },
			{ method: 'agent.send_keys', params: { target: 'w1:p2', keys: ['3'] } },
			{ method: 'agent.send_keys', params: { target: 'w1:p2', keys: ['down'] } },
		]);
		for (const call of calls) expect((call.params as { keys: string[] }).keys).toHaveLength(1);
	});

	it('types text exactly with pane.send_text and nothing that resizes', async () => {
		const { client, calls } = fakeHerdr();
		const screen = herdrScreenAccess(() => client);

		await screen.type('w1:p2', 'Mango, Ripe 2');

		expect(calls).toEqual([{ method: 'pane.send_text', params: { pane_id: 'w1:p2', text: 'Mango, Ripe 2' } }]);
	});

	it('refuses, sending nothing, a key outside the set or text with a control character', async () => {
		const { client, calls } = fakeHerdr();
		const screen = herdrScreenAccess(() => client);

		await expect(screen.press('w1:p2', 'a' as ScreenKey)).rejects.toThrow('not a key an answer presses');
		await expect(screen.press('w1:p2', '13' as ScreenKey)).rejects.toThrow();
		await expect(screen.type('w1:p2', 'one\ntwo')).rejects.toThrow('line break');
		await expect(screen.type('w1:p2', 'x\u001b[A')).rejects.toThrow('control character');
		await screen.type('w1:p2', '');
		expect(calls).toEqual([]);
	});

	it('says so when herdr is not connected', async () => {
		const screen = herdrScreenAccess(() => null);
		await expect(screen.read('w1:p2')).rejects.toThrow(NO_CONNECTION_MESSAGE);
		await expect(screen.press('w1:p2', 'enter')).rejects.toThrow(NO_CONNECTION_MESSAGE);
		await expect(screen.type('w1:p2', 'x')).rejects.toThrow(NO_CONNECTION_MESSAGE);
	});

	it('fails readably on a read without a screen', async () => {
		const screen = herdrScreenAccess(() => ({ request: <T>() => Promise.resolve({ type: 'ok' } as T) }));
		await expect(screen.read('w1:p2')).rejects.toThrow('herdr did not return the screen');
	});
});

describe('herdr-core screen access', () => {
	let clients: HcClient[] = [];
	afterEach(() => {
		for (const client of clients) client.dispose();
		clients = [];
	});

	async function connected(
		options: { features?: string[]; size?: { cols?: number; rows?: number } } = {},
	): Promise<{ client: HcClient; core: FakeCore; screen: ScreenAccess }> {
		const { spawn, cores } = fakeSpawner((core) => {
			core.handlers.set('hello', () => ({ ...HELLO_RESULT, features: options.features ?? HELLO_RESULT.features }));
			core.handlers.set('terminal.get', () => ({ address: 't7', ...(options.size ?? { cols: 200, rows: 120 }) }));
			core.handlers.set('terminal.attach', () => ({ channel: 3, automatic_input: true, terminal: { address: 't7' } }));
			core.handlers.set('terminal.read', () => ({ text: HC_SCREEN, complete: true, how: 'screen' }));
			core.handlers.set('terminal.keys', () => ({ status: 'blocked', turn: 1 }));
		});
		const client = new HcClient({ argv: ['hc', 'connect'], spawn });
		clients.push(client);
		await client.ping();
		return { client, core: cores[0] as FakeCore, screen: hcScreenAccess(() => client) };
	}

	const methods = (core: FakeCore): string[] =>
		core.calls.map((call) => call.method).filter((method) => method !== 'hello' && method !== 'events.subscribe');

	it('reads the visible screen with terminal.read and no history', async () => {
		const { core, screen } = await connected();

		expect(await screen.read('t7')).toBe(HC_SCREEN);
		expect(core.calls.find((call) => call.method === 'terminal.read')?.params).toEqual({ terminal: 't7', lines: 0 });
	});

	it('presses one key per terminal.keys call, in hc’s own names', async () => {
		const { core, screen } = await connected();

		for (const key of ['down', 'shift+tab', 'ctrl+u', 'esc', 'enter', '2'] as const) await screen.press('t7', key);

		expect(core.calls.filter((call) => call.method === 'terminal.keys').map((call) => call.params)).toEqual([
			{ terminal: 't7', keys: ['down'] },
			{ terminal: 't7', keys: ['shift+tab'] },
			{ terminal: 't7', keys: ['ctrl+u'] },
			{ terminal: 't7', keys: ['esc'] },
			{ terminal: 't7', keys: ['enter'] },
			{ terminal: 't7', keys: ['2'] },
		]);
	});

	it('types text every character of which has a key name key by key, in one terminal.keys call (#172)', async () => {
		const { core, screen } = await connected({ size: { cols: 60, rows: 40 } });

		await screen.type('t7', "Mango, Ripe 2; a-b/c\\d 'e' [f] = `g`.");

		// No attach, so nothing that closes and puts the terminal back to 200x120.
		expect(methods(core)).toEqual(['terminal.keys']);
		expect(core.calls.find((call) => call.method === 'terminal.keys')?.params).toEqual({
			terminal: 't7',
			keys: [...'Mango, Ripe 2; a-b/c\\d \'e\' [f] = `g`.'].map((char) =>
				char === ' ' ? 'space' : /[A-Z]/.test(char) ? `shift+${char.toLowerCase()}` : char,
			),
		});
	});

	it('types other text as one automatic-input frame at the terminal’s own grid, never send', async () => {
		const { core, screen } = await connected();

		await screen.type('t7', 'Mango, Ripe 2 — ✔');

		expect(methods(core)).toEqual(['terminal.get', 'terminal.attach']);
		expect(core.calls.find((call) => call.method === 'terminal.attach')?.params).toEqual({
			terminal: 't7',
			cols: 200,
			rows: 120,
			history: 0,
			resumed: true,
		});
		const sent = core.sent(3);
		expect(sent.map((frame) => frame.kind)).toEqual([FrameKind.AutomaticInput, FrameKind.Close]);
		expect(sent[0]?.payload.toString('utf8')).toBe('Mango, Ripe 2 — ✔');
		// No RESIZE, no FOCUS: typing never takes or changes the grid.
		expect(sent.some((frame) => frame.kind === FrameKind.Resize)).toBe(false);
	});

	it('types as DATA at the terminal’s own grid on a core without automatic input', async () => {
		const { core, screen } = await connected({ features: ['framed', 'attach'] });

		await screen.type('t7', 'Abc!');

		expect(core.calls.find((call) => call.method === 'terminal.attach')?.params).toMatchObject({ cols: 200, rows: 120 });
		expect(core.sent(3).map((frame) => frame.kind)).toEqual([FrameKind.Data, FrameKind.Close]);
		expect(core.sent(3)[0]?.payload.toString()).toBe('Abc!');
	});

	it('refuses to type, attaching nothing, when the core does not say the terminal’s size', async () => {
		const { core, screen } = await connected({ size: {} });

		await expect(screen.type('t7', 'why?')).rejects.toThrow('did not say the terminal’s size');
		expect(methods(core)).toEqual(['terminal.get']);
	});

	it('refuses text with no key names on a terminal whose size the typing would change (#172)', async () => {
		const { core, screen } = await connected({ size: { cols: 60, rows: 40 } });

		await expect(screen.type('t7', 'Ripe — ✔')).rejects.toThrow(
			'typing here would resize the terminal from 60x40 to 200x120',
		);
		expect(methods(core)).toEqual(['terminal.get']);
	});

	it('refuses, sending nothing, a key outside the set or text with a control character', async () => {
		const { core, screen } = await connected();

		await expect(screen.press('t7', 'A' as ScreenKey)).rejects.toThrow('not a key an answer presses');
		await expect(screen.type('t7', 'one\rtwo')).rejects.toThrow('line break');
		await expect(screen.type('t7', '\u0015')).rejects.toThrow('control character');
		await screen.type('t7', '');
		expect(methods(core)).toEqual([]);
	});

	it('reports the core’s error readably', async () => {
		const { core, screen } = await connected();
		core.handlers.set('terminal.read', () => {
			throw new RpcError('not_found', 'no such terminal');
		});

		await expect(screen.read('t9')).rejects.toThrow('no such terminal (not_found)');
	});

	it('says so when herdr-core is not connected', async () => {
		const screen = hcScreenAccess(() => null);
		await expect(screen.read('t7')).rejects.toThrow(NO_CONNECTION_MESSAGE);
		await expect(screen.press('t7', 'enter')).rejects.toThrow(NO_CONNECTION_MESSAGE);
		await expect(screen.type('t7', 'x')).rejects.toThrow(NO_CONNECTION_MESSAGE);
	});
});

describe('screen access through the kind adapter', () => {
	it('herdr and herdr-core have it; the claude kind does not', () => {
		const herdr = createHerdrKind({
			extraPath: () => '',
			vaultPath: () => '/v',
			onProtocolMismatch: () => undefined,
			onUnsupportedMethod: () => undefined,
			isPublished: () => true,
		});
		const core = createHerdrCoreKind({
			extraPath: () => '',
			spawnEnv: () => ({}),
			vaultPath: () => '/v',
			vaultName: () => 'v',
			onMismatch: () => undefined,
			currentScope: () => null,
		});
		const claude = createClaudeKind({
			extraPath: () => '',
			spawnEnv: () => ({}),
			vaultPath: () => '/v',
			loadSessions: () => [],
			saveSessions: () => undefined,
			notice: () => undefined,
			ptyPlatform: null,
		});

		expect(typeof herdr.screen?.(() => null).press).toBe('function');
		expect(typeof core.screen?.(() => null).type).toBe('function');
		expect('screen' in claude).toBe(false);
		void claude.dispose();
	});
});

describe('screen text and keys', () => {
	it('takes no letters as keys: text goes through type', () => {
		expect(SCREEN_KEYS.some((key) => /^[a-z]$/i.test(key))).toBe(false);
	});

	it('names on hc only the characters terminal.keys types exactly (#172)', () => {
		expect(hcTextKeys('Ab 1')).toEqual(['shift+a', 'b', 'space', '1']);
		expect(hcTextKeys('')).toEqual([]);
		// hc has no name for a shifted symbol, and types shift+1 as 1.
		for (const text of ['why?', 'yes!', 'a:b', '(x)', '"q"', 'a_b', 'æ', '—', '✔', '😀']) expect(hcTextKeys(text), text).toBeNull();
	});

	it('accepts typographic text and refuses C0, DEL and C1', () => {
		expect(screenTextIssue('don’t ask again, "Mango"')).toBeNull();
		expect(screenTextIssue('a\tb')).toBe('the text has a control character');
		expect(screenTextIssue('a\u007fb')).toBe('the text has a control character');
		expect(screenTextIssue('a\u009bb')).toBe('the text has a control character');
	});
});
