/**
 * Transcript shapes the reducer once misread (the Ovis prior-art batch,
 * `findings/prior-art-ovis.md` §1 in the vault docs root): a prompt of content
 * blocks, a compaction, a rewind and a cancelled re-send, the runtime's own
 * notices and bash mode, an in-file `/clear`, and background notifications.
 *
 * Every fixture under `tests/fixtures/transcripts/` named here is cut from a
 * real transcript on this machine and scrubbed, or copied from Ovis where
 * `tests/README.md` says so; a case written inline says what real shape it
 * follows.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyTranscript, reduce, type TranscriptState } from '../src/native/reducer';

/** A fixture transcript's lines, newline-split the way a tail delivers them. */
function fixtureLines(name: string): string[] {
	const path = join(__dirname, 'fixtures', 'transcripts', `${name}.jsonl`);
	return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

/** The lines reduced in one go from nothing. */
function cold(lines: string[]): TranscriptState {
	return reduce(emptyTranscript(), lines).state;
}

/** The lines reduced one at a time, as a tail of a growing file would. */
function live(lines: string[]): TranscriptState {
	let state = emptyTranscript();
	for (const line of lines) state = reduce(state, [line]).state;
	return state;
}

describe('a prompt sent as content blocks (#129)', () => {
	// Recorded on Claude Code 2.1.283 (the only TUI prompt with a pasted image
	// on this machine): `[{text: "[Image #3]"}, {image}]`, no `isMeta`, then an
	// `isMeta` line naming where the picture came from.
	const lines = fixtureLines('array-prompt');

	it('opens a turn with the prompt text and a placeholder for the picture, and the reply lands in it', () => {
		const state = cold(lines);

		expect(state.turns.map((turn) => turn.prompt)).toEqual([
			'both work now',
			'can the screenshot key copy the image path so I can paste it here?',
			'[Image #3]',
		]);
		const pictured = state.turns[2];
		expect(pictured?.id).toBe('d19a1ed3-34b4-4edf-8422-90a8069b701f');
		expect(pictured?.entries[0]).toEqual({ kind: 'image', mediaType: 'image/png' });
		const prose = pictured?.entries.flatMap((entry) => (entry.kind === 'text' ? [entry.text] : []));
		expect(prose).toEqual([
			'It works: the path was read and the image shown.',
			'The pictures folder points at home; moving screenshots.',
			'Done: screenshots now land in their own folder.',
		]);
		// The turn before it ends with its own answer, not with this one's.
		const before = state.turns[1]?.entries.flatMap((entry) => (entry.kind === 'text' ? [entry.text] : []));
		expect(before).toEqual(['The key now copies the path to the image.']);
	});

	it('still attaches the tool results a block line carries, and opens nothing for them', () => {
		const state = cold(lines);

		const calls = state.turns.flatMap((turn) => turn.entries.filter((entry) => entry.kind === 'tool'));
		expect(calls).toHaveLength(3);
		expect(calls.every((call) => call.kind === 'tool' && call.result === 'scrubbed output')).toBe(true);
		expect(state.turns).toHaveLength(3);
	});

	it('opens nothing for the interruption marker Claude Code writes as blocks', () => {
		// 2.1.286: `[Request interrupted by user]` as a text block, with the
		// interrupted message's id.
		const state = cold([
			JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Go' } }),
			JSON.stringify({
				type: 'user',
				uuid: 'u2',
				interruptedMessageId: 'msg_1',
				message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
			}),
			JSON.stringify({
				type: 'user',
				uuid: 'u3',
				message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
			}),
		]);

		expect(state.turns.map((turn) => turn.prompt)).toEqual(['Go']);
	});

	it('reads the same live as cold', () => {
		expect(live(lines)).toEqual(cold(lines));
	});
});
