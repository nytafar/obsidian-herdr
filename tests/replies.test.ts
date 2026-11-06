/**
 * Telling emulator replies from typing (`TerminalRenderer.onReply`), which
 * herdr-core needs apart: replies go as AUTOMATIC_INPUT. The xterm.js half runs
 * against the real xterm core (`@xterm/headless` shares it with the browser
 * build), so a release that drops its internal `onUserInput` fails here.
 */
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { DataRouter } from '../src/views/renderer/replies';
import { userInputEvent } from '../src/views/renderer/xtermJs';

function routed(router: DataRouter) {
	const data: string[] = [];
	const replies: string[] = [];
	router.data.add((d) => data.push(d));
	router.replies.add((d) => replies.push(d));
	return { data, replies };
}

describe('DataRouter', () => {
	it('write-scope: what an engine emits inside a write is a reply (ghostty-web)', () => {
		const router = new DataRouter('write-scope');
		const { data, replies } = routed(router);
		router.write(() => router.dispatch('\x1b[1;1R'));
		router.dispatch('a');
		expect(replies).toEqual(['\x1b[1;1R']);
		expect(data).toEqual(['a']);
	});

	it('sends everything to data while nobody listens for replies', () => {
		const router = new DataRouter('write-scope');
		const data: string[] = [];
		router.data.add((d) => data.push(d));
		router.write(() => router.dispatch('\x1b[0n'));
		expect(data).toEqual(['\x1b[0n']);
	});

	it('user-input: without the signal wired, everything is input', () => {
		const router = new DataRouter('user-input');
		const { data, replies } = routed(router);
		router.dispatch('\x1b[?1;2c');
		expect(data).toEqual(['\x1b[?1;2c']);
		expect(replies).toEqual([]);
	});

	it('user-input: against the real xterm core, DA and DSR are replies and typing is input', async () => {
		const terminal = new Terminal({ allowProposedApi: true });
		const router = new DataRouter('user-input');
		const { data, replies } = routed(router);
		const subscribe = userInputEvent(terminal);
		expect(subscribe).toBeDefined();
		subscribe?.(() => router.markUserInput());
		router.enableUserSignal();
		terminal.onData((d) => router.dispatch(d));
		await new Promise<void>((resolve) => terminal.write('\x1b[c\x1b[6n', resolve));
		terminal.input('x', true);
		expect(replies).toEqual(['\x1b[?1;2c', '\x1b[1;1R']);
		expect(data).toEqual(['x']);
		terminal.dispose();
	});
});
