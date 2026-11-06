/**
 * Screen access (issue #164, ADR-0009): what answering Claude's dialogs on a
 * multiplexer pane needs of the runtime, and nothing more. Read the visible
 * screen, press one key, type text. Which key, and when, is the answer
 * driver's business (ADR-0009 §2); this layer only guarantees that each call
 * is exactly one thing on the wire.
 *
 * - **herdr** (`herdrScreenAccess` here): `pane.read {source: visible,
 *   format: text}`, `agent.send_keys` with **one key per call** (herdr merges
 *   printable keys sent in one call, so `["1", "3"]` reaches Claude as `13`),
 *   and `pane.send_text`, which types exactly.
 * - **herdr-core** (`hcScreenAccess` in `hc/actions.ts`): `terminal.read
 *   {lines: 0}`, `terminal.keys` with one key, and text as one
 *   AUTOMATIC_INPUT frame on a short resumed `terminal.attach` at the
 *   terminal's own grid (`HcClient.input`): `terminal.keys` lowercases
 *   letters and `terminal.send` presses Enter.
 *
 * Local and SSH runtimes use the same calls over their own client. The
 * `claude` kind owns its process and answers requests as structured messages
 * (ADR-0007), so it has no screen access (`RuntimeKindAdapter.screen`).
 *
 * Measured 2026-11-06 against herdr 0.9.5 and hc 0.1.18: `docs/architecture.md`,
 * "Answering Claude's dialogs from the screen".
 */

import type { AgentSendKeysParams, PaneReadParams, PaneSendTextParams } from '../herdr/types.gen';
import { NO_CONNECTION_MESSAGE, type PromptClient } from './promptSender';

/**
 * The keys a dialog answer uses, in the one spelling both runtimes accept:
 * moves (`up`, `down`, `left`, `right`, `tab`, `ctrl+u`) and commits
 * (`enter`, `esc`, `shift+tab`, a digit). One letter, `s`: Claude's model
 * and effort pickers take it as "this session only" (#169), and it is
 * already lower case, which is what hc's `terminal.keys` makes of a letter.
 * No other: text goes through {@link ScreenAccess.type}.
 */
export const SCREEN_KEYS = [
	'up',
	'down',
	'left',
	'right',
	'tab',
	'shift+tab',
	'enter',
	'esc',
	'ctrl+u',
	's',
	'1',
	'2',
	'3',
	'4',
	'5',
	'6',
	'7',
	'8',
	'9',
] as const;

export type ScreenKey = (typeof SCREEN_KEYS)[number];

export function isScreenKey(key: string): key is ScreenKey {
	return (SCREEN_KEYS as readonly string[]).includes(key);
}

/** One pane's screen, as the answer driver sees it. */
export interface ScreenAccess {
	/**
	 * The visible screen as plain text, one row per line, no history. Cursor
	 * and ticks are glyphs (`❯`, `[✔]`), so no colour is needed. Rejects with a
	 * readable message.
	 */
	read(paneId: string): Promise<string>;
	/**
	 * Presses one key, alone in its call. Rejects a key outside
	 * {@link SCREEN_KEYS} before anything is sent.
	 */
	press(paneId: string, key: ScreenKey): Promise<void>;
	/**
	 * Types `text` exactly, with no Enter, and without changing the pane's
	 * size. Rejects text with a line break or any other control character
	 * before anything is sent ({@link screenTextIssue}); empty text sends
	 * nothing.
	 */
	type(paneId: string, text: string): Promise<void>;
}

/**
 * Why `text` cannot be typed as an answer, or null when it can: a line break
 * would submit, and any other control character would act as a key. C0, DEL
 * and C1 are all refused.
 */
export function screenTextIssue(text: string): string | null {
	if (/[\r\n]/.test(text)) return 'the text has a line break';
	// eslint-disable-next-line no-control-regex -- matching control characters is the point
	if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return 'the text has a control character';
	return null;
}

/** Throws the readable refusal for a key outside the set. */
export function checkScreenKey(key: string): ScreenKey {
	if (!isScreenKey(key)) throw new Error(`"${key}" is not a key an answer presses`);
	return key;
}

/** Throws the readable refusal for text that cannot be typed. */
export function checkScreenText(text: string): void {
	const issue = screenTextIssue(text);
	if (issue) throw new Error(`Cannot type this: ${issue}.`);
}

/** The `pane.read` request for the visible screen as text. */
export function paneReadVisibleParams(paneId: string): PaneReadParams {
	return { pane_id: paneId, source: 'visible', format: 'text' };
}

/** The `agent.send_keys` request for one key, never more. */
export function oneKeyParams(paneId: string, key: ScreenKey): AgentSendKeysParams {
	return { target: paneId, keys: [key] };
}

/** The `pane.send_text` request that types `text` exactly. */
function typeParams(paneId: string, text: string): PaneSendTextParams {
	return { pane_id: paneId, text };
}

/** The text of a `pane.read` result (`{type: 'pane_read', read: {text}}`). */
function readText(result: unknown): string {
	const read = (result as { read?: { text?: unknown } } | null)?.read;
	if (typeof read?.text !== 'string') throw new Error('herdr did not return the screen');
	return read.text;
}

/**
 * Screen access over the herdr that is connected *now*: the client is read per
 * call because a reconnect replaces it, and a null one is an ordinary failure.
 */
export function herdrScreenAccess(client: () => PromptClient | null): ScreenAccess {
	const connected = (): PromptClient => {
		const current = client();
		if (!current) throw new Error(NO_CONNECTION_MESSAGE);
		return current;
	};
	return {
		async read(paneId: string): Promise<string> {
			return readText(await connected().request<unknown>('pane.read', paneReadVisibleParams(paneId)));
		},
		async press(paneId: string, key: ScreenKey): Promise<void> {
			const checked = checkScreenKey(key);
			await connected().request('agent.send_keys', oneKeyParams(paneId, checked));
		},
		async type(paneId: string, text: string): Promise<void> {
			checkScreenText(text);
			if (!text) return;
			await connected().request('pane.send_text', typeParams(paneId, text));
		},
	};
}

/**
 * The pane's agent status as herdr reports it now (`pane.get`'s
 * `agent_status`: `idle`, `working`, `blocked`, `done`, `unknown`), or null
 * for a pane with no agent: what the session settings driver checks before
 * it sends anything (#169, #170).
 */
export function herdrAgentStatus(client: () => PromptClient | null): (paneId: string) => Promise<string | null> {
	return async (paneId) => {
		const connected = client();
		if (!connected) throw new Error(NO_CONNECTION_MESSAGE);
		const result = await connected.request<{ pane?: { agent?: unknown; agent_status?: unknown } } | null>('pane.get', {
			pane_id: paneId,
		});
		const pane = result?.pane;
		return pane?.agent && typeof pane.agent_status === 'string' ? pane.agent_status : null;
	};
}
