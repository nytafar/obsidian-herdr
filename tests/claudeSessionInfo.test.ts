/**
 * Claude's session info (#160): model, effort, permission mode and context as
 * the transcript states them, newest record first (`src/agents/claude/
 * sessionInfo.ts`), and what the `claude` kind hears from its process
 * (`src/claude/sessionInfo.ts`).
 *
 * `session-settings.jsonl` is the herdr pane of spike #110 (Claude Code
 * 2.1.318, `/tmp/oh-test-model-herdr`), scrubbed: the attachments that carry
 * the account and the machine dropped, the `/context` tables cut after the
 * category table, the TUI's coloured `/context` stdout replaced. Between
 * "1 to 400" and "four" an `/effort high` was sent mid-turn, which wrote
 * nothing. `session-settings-sdk.jsonl` is a `claude -p` stream-json process
 * of the same spike (`/tmp/oh-test-model-cl`), where `set_model` replays its
 * stdout with the id.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_FORMAT } from '../src/agents/claude/format';
import { emptyTranscript, reduce, type TranscriptState } from '../src/agents/claude/transcript';
import { foldRuntimeInfo } from '../src/claude/sessionInfo';
import type { StreamEvent } from '../src/claude/protocol';
import { mergeSessionInfo, type SessionInfo } from '../src/native/conversation';

function fixtureLines(name: string): string[] {
	const path = join(__dirname, 'fixtures', 'transcripts', `${name}.jsonl`);
	return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

function cold(lines: string[]): TranscriptState {
	return reduce(emptyTranscript(), lines).state;
}

function live(lines: string[]): TranscriptState {
	let state = emptyTranscript();
	for (const line of lines) state = reduce(state, [line]).state;
	return state;
}

const SETTINGS = fixtureLines('session-settings');

/** The session info after the fixture's lines up to and including line `index` (0-based). */
function infoAt(index: number): SessionInfo {
	return CLAUDE_FORMAT.sessionInfo(cold(SETTINGS.slice(0, index + 1)));
}

const OPUS = { id: 'claude-opus-5-5', label: 'Opus 5.5' };
const HAIKU = { id: 'claude-haiku-5-5', label: 'Haiku 5.5' };
const SONNET = { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' };
const ONE_M = { tokens: 1_000_000, source: 'context-command' as const };

describe('session info from a 2.1.318 transcript (#160)', () => {
	it('knows nothing before the first record that says something', () => {
		expect(CLAUDE_FORMAT.sessionInfo(emptyTranscript())).toEqual({});
		// The first prompt says the mode; no reply has said an effort yet.
		expect(infoAt(0)).toEqual({ permissionMode: 'default' });
		expect(infoAt(1)).toEqual({ permissionMode: 'default', model: OPUS });
	});

	it('reads the reply’s effort and the context it used', () => {
		expect(infoAt(2)).toEqual({
			permissionMode: 'default',
			model: OPUS,
			effort: 'medium',
			contextUsed: 22550,
			usage: { input: 22550, output: 4, cached: 13395 },
		});
	});

	it('takes the window from /context’s output, for the model it names', () => {
		expect(infoAt(5).contextWindow).toBeUndefined();
		expect(infoAt(6).contextWindow).toEqual(ONE_M);
	});

	it('takes /model’s display name at once and its id from the attachment, and drops the window it changed', () => {
		// "Set model to `Haiku 5.5` and saved as your default for new sessions":
		// no attachment has named Haiku yet, so the id is not known.
		expect(infoAt(9)).toMatchObject({ model: { id: '', label: 'Haiku 5.5' }, effort: 'medium' });
		expect(infoAt(9).contextWindow).toBeUndefined();
		expect(infoAt(19).model).toEqual(HAIKU);
	});

	it('takes /effort at once, and ignores an invalid argument to either command', () => {
		expect(infoAt(12)).toMatchObject({ effort: 'low', model: { label: 'Haiku 5.5' } });
		// `/effort bogus` (a user stdout line) and `/model bogus` (a system line).
		expect(infoAt(17)).toEqual(infoAt(12));
		expect(infoAt(20)).toMatchObject({ model: HAIKU, effort: 'low', contextUsed: 26922 });
		expect(infoAt(24).contextWindow).toEqual(ONE_M);
	});

	it('reads a switch for this session only, with the effort it was set with', () => {
		expect(infoAt(27)).toMatchObject({ model: { id: '', label: 'Sonnet 5.5' } });
		expect(infoAt(27).contextWindow).toBeUndefined();
		expect(infoAt(30)).toMatchObject({ model: SONNET, effort: 'low' });
		// "Set model to `Sonnet 5.5` for this session only with `medium` effort".
		expect(infoAt(34)).toMatchObject({ model: SONNET, effort: 'medium' });
		// "Set effort level to low (this session only)".
		expect(infoAt(37)).toMatchObject({ effort: 'low' });
	});

	it('learns an effort set mid-turn from the next reply, the only record of it', () => {
		expect(infoAt(39).effort).toBe('low');
		expect(infoAt(42).effort).toBe('high');
	});

	it('follows the permission mode of each prompt', () => {
		expect(infoAt(46).permissionMode).toBe('default');
		expect(infoAt(47).permissionMode).toBe('acceptEdits');
	});

	it('ignores a kept model, and names a model by a label it knows', () => {
		// Five "Kept model as `Sonnet 5.5`" lines change nothing.
		expect(infoAt(59)).toEqual(infoAt(48));
		expect(infoAt(62).model).toEqual({ id: '', label: 'Opus in plan mode, else Sonnet' });
		// `sonnet[1m]`: the name an attachment gave, so the id is known.
		expect(infoAt(65).model).toEqual(SONNET);
		expect(infoAt(69)).toEqual(infoAt(65));
	});

	it('reads the same whether the file comes at once or a line at a time', () => {
		const whole = CLAUDE_FORMAT.sessionInfo(cold(SETTINGS));
		expect(CLAUDE_FORMAT.sessionInfo(live(SETTINGS))).toEqual(whole);
		expect(whole).toEqual({
			permissionMode: 'acceptEdits',
			model: SONNET,
			effort: 'high',
			contextUsed: 32868,
			usage: { input: 32868, output: 3, cached: 32816 },
		});
	});

	it('leaves the info object alone when a batch says nothing new', () => {
		const state = cold(SETTINGS);
		const next = reduce(state, [JSON.stringify({ type: 'file-history-snapshot' })]).state;
		expect(next.info).toBe(state.info);
	});

	it('reads the `claude` kind’s set_model echo, id in brackets', () => {
		const lines = fixtureLines('session-settings-sdk');
		const at = lines.findIndex((line) => line.includes('Set model to'));
		// "Set model to `sonnet (claude-sonnet-5-5)`": no attachment has named it yet.
		expect(CLAUDE_FORMAT.sessionInfo(cold(lines.slice(0, at + 1))).model).toEqual({
			id: 'claude-sonnet-5-5',
			label: 'claude-sonnet-5-5',
		});
		expect(CLAUDE_FORMAT.sessionInfo(cold(lines)).model).toEqual(SONNET);
	});

	it('does not read a subagent’s records as the session’s', () => {
		const lines = [
			{ type: 'user', uuid: 'u1', permissionMode: 'default', message: { role: 'user', content: 'Go' } },
			{ type: 'user', uuid: 's1', isSidechain: true, permissionMode: 'plan', message: { role: 'user', content: 'Sub' } },
			{
				type: 'system',
				subtype: 'local_command',
				isSidechain: true,
				content: '<local-command-stdout>Set effort level to max (this session only)</local-command-stdout>',
			},
		].map((line) => JSON.stringify(line));
		expect(CLAUDE_FORMAT.sessionInfo(cold(lines))).toEqual({ permissionMode: 'default' });
	});
});

describe('what the `claude` kind hears from its process (#160)', () => {
	const init = (model: string, permissionMode = 'default'): StreamEvent => ({
		type: 'init',
		sessionId: 's',
		cwd: '/tmp/x',
		permissionMode,
		model,
	});
	const result = (windows: Record<string, number>): StreamEvent => ({
		type: 'result',
		isError: false,
		subtype: 'success',
		terminalReason: '',
		message: '',
		sessionId: 's',
		answered: null,
		windows,
	});

	it('takes model and mode from init, the window from the result, and keeps the object while nothing moves', () => {
		let info = foldRuntimeInfo({}, init('claude-haiku-5-5'));
		expect(info).toEqual({ model: { id: 'claude-haiku-5-5', label: 'claude-haiku-5-5' }, permissionMode: 'default' });
		info = foldRuntimeInfo(info, result({ 'claude-haiku-5-5': 1_000_000, 'claude-sonnet-5-5': 200_000 }));
		expect(info.contextWindow).toEqual({ tokens: 1_000_000, source: 'runtime' });
		expect(foldRuntimeInfo(info, init('claude-haiku-5-5'))).toBe(info);
		expect(foldRuntimeInfo(info, result({ 'claude-haiku-5-5': 1_000_000 }))).toBe(info);
		expect(foldRuntimeInfo(info, { type: 'other' })).toBe(info);
	});

	it('drops the window with the model it was for, and matches a window suffix', () => {
		let info = foldRuntimeInfo(foldRuntimeInfo({}, init('claude-opus-5-5[1m]')), result({ 'claude-opus-5-5': 1_000_000 }));
		expect(info.contextWindow?.tokens).toBe(1_000_000);
		info = foldRuntimeInfo(info, { type: 'response', requestId: 'r', ok: true, model: 'claude-sonnet-5-5', mode: '' });
		expect(info).toEqual({ model: { id: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5' }, permissionMode: 'default' });
	});

	it('takes the mode from a status line and from a set_permission_mode answer, never from a failed one', () => {
		let info = foldRuntimeInfo({}, { type: 'status', permissionMode: 'plan' });
		expect(info.permissionMode).toBe('plan');
		info = foldRuntimeInfo(info, { type: 'response', requestId: 'r', ok: false, model: '', mode: 'auto' });
		expect(info.permissionMode).toBe('plan');
		info = foldRuntimeInfo(info, { type: 'response', requestId: 'r', ok: true, model: '', mode: 'acceptEdits' });
		expect(info.permissionMode).toBe('acceptEdits');
		expect(foldRuntimeInfo(info, { type: 'status', permissionMode: null })).toBe(info);
	});

	it('wins over the transcript per field, keeping the transcript’s name for the same model', () => {
		const read: SessionInfo = { model: SONNET, effort: 'high', permissionMode: 'default', contextUsed: 30000 };
		const overlay = foldRuntimeInfo(foldRuntimeInfo({}, init('claude-sonnet-5-5', 'plan')), result({ 'claude-sonnet-5-5': 1_000_000 }));
		expect(mergeSessionInfo(read, overlay)).toEqual({
			model: SONNET,
			effort: 'high',
			permissionMode: 'plan',
			contextUsed: 30000,
			contextWindow: { tokens: 1_000_000, source: 'runtime' },
		});
		// A model the transcript has not reached yet is the process’s, by its id.
		const switched = foldRuntimeInfo(overlay, { type: 'response', requestId: 'r', ok: true, model: 'claude-haiku-5-5', mode: '' });
		expect(mergeSessionInfo(read, switched).model).toEqual({ id: 'claude-haiku-5-5', label: 'claude-haiku-5-5' });
	});
});
