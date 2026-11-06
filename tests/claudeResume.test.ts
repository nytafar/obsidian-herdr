/**
 * Work Claude takes up again on its own after answering (#139): the turn
 * stays the prompt's, a resume entry marks where the resumed work starts,
 * and the prompt's own answer ends before it (`Turn.endTs`).
 *
 * `resume-stop-hook.jsonl` and `resume-task-notification.jsonl` were recorded
 * for this issue with Claude Code 2.1.318 (`claude -p --model haiku` in
 * `/tmp/oh-test-stophook`, a project Stop hook that blocks once), scrubbed:
 * the attachments that name the account and the machine dropped, the folder
 * moved under `/home/user`. The rest of the shapes are written inline after
 * real 2.1.318 records, as each case says.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyTranscript, reduce, type TranscriptState } from '../src/agents/claude/transcript';
import type { ResumeEntry, Turn } from '../src/native/conversation';
import { workDuration } from '../src/native/turnTime';

/** Any record id: which record resumed is the parser's to say. */
const ANY_ID: unknown = expect.any(String);

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

function resumes(turn: Turn | undefined): ResumeEntry[] {
	return (turn?.entries ?? []).filter((entry): entry is ResumeEntry => entry.kind === 'resume');
}

/** The kinds of a turn's entries, prose by its words, for reading the order. */
function shape(turn: Turn | undefined): string[] {
	return (turn?.entries ?? []).map((entry) =>
		entry.kind === 'text' ? `text:${entry.text}` : entry.kind === 'tool' ? `tool:${entry.name}` : entry.kind,
	);
}

describe('a Stop hook that sets Claude working again (2.1.318)', () => {
	const lines = fixtureLines('resume-stop-hook');

	it('keeps one turn, and marks the resumed work inside it with the hook’s words', () => {
		const state = cold(lines);
		expect(state.turns).toHaveLength(1);
		const [turn] = state.turns;
		expect(turn?.prompt).toBe('Reply with the single word: ready');
		expect(shape(turn)).toEqual(['text:ready', 'resume', 'thinking', 'tool:Bash', 'text:Output of `echo verified`: `verified`']);
		expect(resumes(turn)).toEqual([
			{
				kind: 'resume',
				id: ANY_ID,
				cause: 'hook',
				text: 'Before you finish, run the shell command `echo verified` and report its output in one line.',
				ts: '2026-11-06T17:29:26.070Z',
				endTs: '2026-11-06T17:29:27.900Z',
			},
		]);
	});

	it('times the prompt’s own answer, not the work the hook asked for', () => {
		const [turn] = cold(lines).turns;
		expect(turn?.ts).toBe('2026-11-06T17:29:25.170Z');
		expect(turn?.endTs).toBe('2026-11-06T17:29:26.053Z');
		expect(workDuration(turn?.ts, turn?.endTs)).toBe('1s');
		const [resumed] = resumes(turn);
		expect(workDuration(resumed?.ts, resumed?.endTs)).toBe('2s');
	});

	it('reads the same a line at a time', () => {
		expect(live(lines).turns).toEqual(cold(lines).turns);
	});
});

describe('a task notification that sets Claude working again (2.1.318)', () => {
	const lines = fixtureLines('resume-task-notification');

	it('marks the resumed work with the notification’s summary, and times the first answer to its end', () => {
		const state = cold(lines);
		expect(state.turns).toHaveLength(1);
		const [turn] = state.turns;
		expect(shape(turn)).toEqual(['tool:Bash', 'text:started', 'resume', 'text:finished']);
		expect(resumes(turn)).toEqual([
			{
				kind: 'resume',
				id: ANY_ID,
				cause: 'notification',
				text: 'Background command "Sleep 4 seconds then echo finished" completed (exit code 0)',
				// The enqueue: when the notification reached Claude.
				ts: '2026-11-06T17:29:34.468Z',
				endTs: '2026-11-06T17:29:35.431Z',
			},
		]);
		expect(turn?.endTs).toBe('2026-11-06T17:29:31.090Z');
		expect(workDuration(turn?.ts, turn?.endTs)).toBe('2s');
		// The background call is answered all the same (#135).
		const call = turn?.entries.find((entry) => entry.kind === 'tool');
		expect(call).toMatchObject({ status: 'done', notification: { kind: 'command' } });
	});

	it('keeps the turn id and the headings where they were', () => {
		const before = cold(lines.slice(0, lines.findIndex((line) => line.includes('"operation":"enqueue"') && line.includes('task-notification'))));
		const after = cold(lines);
		expect(after.turns.map((turn) => turn.id)).toEqual(before.turns.map((turn) => turn.id));
		expect(after.turns[0]?.headings).toEqual([]);
		expect(live(lines).turns).toEqual(after.turns);
	});
});

describe('what counts as resumed work (#139)', () => {
	let seq = 0;
	const base = (line: Record<string, unknown>) => JSON.stringify({ uuid: `r${++seq}`, ...line });
	const prompt = (text: string, ts: string) =>
		base({ type: 'user', timestamp: ts, origin: { kind: 'human' }, promptSource: 'typed', permissionMode: 'default', message: { role: 'user', content: text } });
	const reply = (id: string, text: string, ts: string, stop = 'end_turn') =>
		base({ type: 'assistant', timestamp: ts, message: { id, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: stop } });
	const meta = (content: string, ts: string, extra: Record<string, unknown> = {}) =>
		base({ type: 'user', isMeta: true, timestamp: ts, message: { role: 'user', content }, ...extra });

	it('names another session’s message, as a subagent’s hand-back arrives (2.1.318)', () => {
		const [turn] = cold([
			prompt('Go', '2026-11-06T10:00:00Z'),
			reply('m1', 'Delegated.', '2026-11-06T10:00:05Z'),
			meta('<agent-message from="a6">[Subagent hand-back] Report</agent-message>', '2026-11-06T10:03:00Z', {
				origin: { kind: 'peer', from: 'a6', name: 'implementer' },
			}),
			reply('m2', 'Merged it.', '2026-11-06T10:03:20Z'),
		]).turns;
		expect(resumes(turn)).toEqual([
			{ kind: 'resume', id: ANY_ID, cause: 'notification', text: 'Message from implementer', ts: '2026-11-06T10:03:00Z', endTs: '2026-11-06T10:03:20Z' },
		]);
		expect(turn?.endTs).toBe('2026-11-06T10:00:05Z');
	});

	it('names a hook’s added context, as the attachment writes it (`content` a list, 2.1.318)', () => {
		const [turn] = cold([
			prompt('Go', '2026-11-06T10:00:00Z'),
			reply('m1', 'Done.', '2026-11-06T10:00:05Z'),
			base({
				type: 'attachment',
				timestamp: '2026-11-06T10:00:06Z',
				attachment: { type: 'hook_additional_context', content: ['Lint failed in two files.\nFix them.'], hookName: 'Stop' },
			}),
			reply('m2', 'Fixed.', '2026-11-06T10:00:20Z'),
		]).turns;
		expect(resumes(turn)).toMatchObject([{ cause: 'hook', text: 'Lint failed in two files.', ts: '2026-11-06T10:00:06Z' }]);
	});

	it('names a background command’s failure the runtime wrote for Claude', () => {
		const [turn] = cold([
			prompt('Go', '2026-11-06T10:00:00Z'),
			reply('m1', 'Started.', '2026-11-06T10:00:05Z'),
			meta('Background command catalog-check failed with exit code 124', '2026-11-06T10:01:00Z'),
			reply('m2', 'It timed out.', '2026-11-06T10:01:10Z'),
		]).turns;
		expect(resumes(turn)).toMatchObject([{ cause: 'meta', text: 'Background command catalog-check failed with exit code 124' }]);
	});

	it('marks work with no cause it can name as resumed on its own, and each stretch apart', () => {
		const [turn] = cold([
			prompt('Go', '2026-11-06T10:00:00Z'),
			reply('m1', 'One.', '2026-11-06T10:00:05Z'),
			reply('m2', 'Two.', '2026-11-06T10:00:30Z'),
			meta('Stop hook feedback:\nCheck again.', '2026-11-06T10:00:31Z'),
			reply('m3', 'Three.', '2026-11-06T10:00:40Z'),
		]).turns;
		expect(resumes(turn).map((entry) => [entry.cause, entry.text, entry.ts, entry.endTs])).toEqual([
			['other', '', '2026-11-06T10:00:30Z', '2026-11-06T10:00:30Z'],
			['hook', 'Check again.', '2026-11-06T10:00:31Z', '2026-11-06T10:00:40Z'],
		]);
		expect(turn?.endTs).toBe('2026-11-06T10:00:05Z');
	});

	it('does not take the next prompt’s answer, a later line of the same reply, or work still going for resumed work', () => {
		const state = cold([
			prompt('Go', '2026-11-06T10:00:00Z'),
			reply('m1', 'Calling.', '2026-11-06T10:00:01Z', 'tool_use'),
			reply('m2', 'Done.', '2026-11-06T10:00:05Z'),
			// Claude writes one message over several lines.
			reply('m2', 'And more.', '2026-11-06T10:00:06Z'),
			meta('Stop hook feedback:\nnever acted on', '2026-11-06T10:00:07Z'),
			prompt('Next', '2026-11-06T10:01:00Z'),
			reply('m3', 'Next answer.', '2026-11-06T10:01:02Z'),
		]);
		expect(state.turns.map((turn) => resumes(turn).length)).toEqual([0, 0]);
		expect(state.turns.map((turn) => [turn.ts, turn.endTs])).toEqual([
			['2026-11-06T10:00:00Z', '2026-11-06T10:00:06Z'],
			['2026-11-06T10:01:00Z', '2026-11-06T10:01:02Z'],
		]);
	});

	it('answers a steer taken after the answer, not resumed work', () => {
		const [turn] = cold([
			prompt('Go', '2026-11-06T10:00:00Z'),
			reply('m1', 'Done.', '2026-11-06T10:00:05Z'),
			base({ type: 'attachment', timestamp: '2026-11-06T10:00:06Z', attachment: { type: 'queued_command', prompt: 'also this', origin: { kind: 'human' } } }),
			reply('m2', 'Also done.', '2026-11-06T10:00:09Z'),
		]).turns;
		expect(shape(turn)).toEqual(['text:Done.', 'steer', 'text:Also done.']);
		expect(turn?.endTs).toBe('2026-11-06T10:00:09Z');
	});

	it('leaves a subagent’s own replies out', () => {
		const [turn] = cold([
			prompt('Go', '2026-11-06T10:00:00Z'),
			reply('m1', 'Done.', '2026-11-06T10:00:05Z'),
			base({ type: 'assistant', isSidechain: true, timestamp: '2026-11-06T10:00:09Z', message: { id: 's1', role: 'assistant', content: [], stop_reason: 'end_turn' } }),
		]).turns;
		expect(resumes(turn)).toEqual([]);
		expect(turn?.endTs).toBe('2026-11-06T10:00:05Z');
	});
});
