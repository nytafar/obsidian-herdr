/**
 * Transcript shapes the reducer once misread (issues #129–#135): a prompt of content
 * blocks, a compaction, a rewind and a cancelled re-send, the runtime's own
 * notices and bash mode, an in-file `/clear`, and background notifications.
 *
 * Every fixture under `tests/fixtures/transcripts/` named here is cut from a
 * real transcript on this machine and scrubbed, or copied where
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

describe('a compaction (#130)', () => {
	// Recorded on Claude Code 2.1.286: an idle compaction after a finished turn
	// — the `compact_boundary` system line, the summary as a string `user` line
	// with `isCompactSummary: true`, the attachments re-read after it, the
	// "Compacted while idle" notice — and the next prompt. 2.1.318 writes the
	// same lines (checked against a local transcript).
	const lines = fixtureLines('compaction');

	it('is a divider in the turn it happened in, never a prompt', () => {
		const state = cold(lines);

		expect(state.turns.map((turn) => turn.prompt)).toEqual(['', 'now let us address font matching']);
		const kinds = state.turns[0]?.entries.map((entry) => entry.kind);
		expect(kinds).toEqual(['thinking', 'text', 'compaction']);
	});

	it('keeps the summary readable, without the reminders meant for the model', () => {
		const state = cold(lines);

		const compaction = state.turns[0]?.entries.find((entry) => entry.kind === 'compaction');
		expect(compaction?.kind === 'compaction' && compaction.summary).toBe(
			'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. **Primary Request and Intent**\n   - Build a font catalog browser.\n2. **Pending Tasks**\n   - None.',
		);
		const withReminder = cold([
			JSON.stringify({
				type: 'user',
				uuid: 'c1',
				isCompactSummary: true,
				message: {
					role: 'user',
					content:
						'Continued.\n\n<system-reminder>\n<tools-used-before-summary>Bash</tools-used-before-summary>\n</system-reminder>\nSummary: done.',
				},
			}),
		]);
		const entry = withReminder.turns[0]?.entries[0];
		expect(entry?.kind === 'compaction' && entry.summary).toBe('Continued.\n\nSummary: done.');
	});

	it('leaves the work after a compaction mid-turn in the same turn, after the divider', () => {
		// An automatic compaction while the agent works: the summary, then the
		// agent carrying on (the shape of 2.1.286 sessions on this machine).
		const state = cold([
			JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Refactor it' } }),
			JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Starting.' }] } }),
			JSON.stringify({
				type: 'system',
				subtype: 'compact_boundary',
				uuid: 'b1',
				parentUuid: null,
				content: 'Conversation compacted',
			}),
			JSON.stringify({
				type: 'user',
				uuid: 'c1',
				parentUuid: 'b1',
				isCompactSummary: true,
				message: { role: 'user', content: 'Summary.' },
			}),
			JSON.stringify({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Carrying on.' }] } }),
		]);

		expect(state.turns).toHaveLength(1);
		expect(state.turns[0]?.entries.map((entry) => entry.kind)).toEqual(['text', 'compaction', 'text']);
	});

	it('reads the same live as cold', () => {
		expect(live(lines)).toEqual(cold(lines));
	});
});

describe('a rewind and a cancelled re-send (#131)', () => {
	const prompts = (state: TranscriptState): string[] => state.turns.map((turn) => turn.prompt);

	describe('a rewind', () => {
		// A recording of Claude Code 2.1.304 (MIT, see tests/README.md): apple
		// and banana answered, Restore to before apple, then "cherry", which hangs
		// from apple's parent (null) while the old turns stay in the file.
		const lines = fixtureLines('rewind-fork');
		const fork = lines.findIndex((line) => line.includes('"content":"cherry"'));

		it('drops the abandoned turns once the forking prompt arrives', () => {
			expect(prompts(cold(lines))).toEqual(['cherry']);
		});

		it('says which turns it dropped, and live and cold reads agree', () => {
			const before = reduce(emptyTranscript(), lines.slice(0, fork));
			expect(prompts(before.state)).toEqual(['apple', 'banana']);

			const after = reduce(before.state, lines.slice(fork));

			expect(prompts(after.state)).toEqual(['cherry']);
			expect(after.removedTurnIds).toEqual(before.state.turns.map((turn) => turn.id));
			expect(after.changedTurnIds).toEqual([after.state.turns[0]?.id]);
			expect(live(lines).turns).toEqual(cold(lines).turns);
		});
	});

	describe('a prompt cancelled before any reply and sent again', () => {
		// Recorded on Claude Code 2.1.318: the cancelled prompt and its re-send are
		// siblings under the same parent, only an attachment between them.
		const lines = fixtureLines('resend');
		const cancelled = '57ad87a6-8036-4e8a-a145-99d1ac523a15';
		const resent = '609f3e46-3c2b-4895-9501-79ec254e0a2c';
		const answered = '3203531b-51ee-400e-b1d8-e4dc66840907';

		it('shows the re-send once, and keeps the earlier prompt that got a reply', () => {
			const ids = cold(lines).turns.map((turn) => turn.id);

			expect(ids).not.toContain(cancelled);
			expect(ids.filter((id) => id === resent)).toHaveLength(1);
			expect(ids).toContain(answered);
			expect(cold(lines).turns.at(-1)?.entries.some((entry) => entry.kind === 'tool')).toBe(true);
		});

		it('drops the cancelled turn when the re-send arrives, live as cold', () => {
			const at = lines.findIndex((line) => line.includes(`"uuid":"${resent}"`));
			const before = reduce(emptyTranscript(), lines.slice(0, at));
			expect(before.state.turns.at(-1)?.id).toBe(cancelled);

			const after = reduce(before.state, lines.slice(at));

			expect(after.removedTurnIds).toEqual([cancelled]);
			expect(live(lines).turns).toEqual(cold(lines).turns);
		});
	});

	// The edges of the rule, written inline.
	const user = (uuid: string, parentUuid: string, content: unknown): string =>
		JSON.stringify({ type: 'user', uuid, parentUuid, message: { role: 'user', content } });
	const answer = (uuid: string, parentUuid: string, text: string): string =>
		JSON.stringify({ type: 'assistant', uuid, parentUuid, message: { id: `m-${uuid}`, content: [{ type: 'text', text }] } });

	it('keeps a prompt re-sent from the same parent when the first one was answered', () => {
		const state = cold([user('u1', 'p', 'first'), answer('a1', 'u1', 'one'), user('u2', 'p', 'second')]);
		expect(prompts(state)).toEqual(['first', 'second']);
	});

	it('keeps an unanswered prompt when the next one hangs from another parent', () => {
		const state = cold([user('u1', 'p', 'first'), user('u2', 'q', 'second')]);
		expect(prompts(state)).toEqual(['first', 'second']);
	});

	it('sees the cancelled prompt whether it was written as a string or as blocks', () => {
		const state = cold([
			user('u1', 'p', 'string draft'),
			user('u2', 'p', [{ type: 'text', text: 'block resend' }]),
			answer('a2', 'u2', 'answer'),
			user('u3', 'a2', [{ type: 'text', text: 'block draft' }]),
			user('u4', 'a2', 'string resend'),
			answer('a4', 'u4', 'another'),
		]);
		expect(prompts(state)).toEqual(['block resend', 'string resend']);
	});

	it('hides nothing for a parent it never saw', () => {
		const state = cold([user('u1', 'p', 'first'), answer('a1', 'u1', 'one'), user('u2', 'elsewhere', 'second')]);
		expect(prompts(state)).toEqual(['first', 'second']);
	});
});
