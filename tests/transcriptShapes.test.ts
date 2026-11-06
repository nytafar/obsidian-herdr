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
import { emptyTranscript, markLost, reduce, type ToolEntry, type TranscriptState } from '../src/native/reducer';

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

describe('a plan approved with feedback (#129)', () => {
	// Recorded on Claude Code 2.1.318: the ExitPlanMode answer is one `user`
	// line of `[{tool_result}, {text: "<feedback>"}]`, with `toolUseResult` and
	// `sourceToolAssistantUUID`, and no `isMeta`.
	const lines = fixtureLines('plan-feedback');

	it('keeps the work after the approval in the planning turn', () => {
		const state = cold(lines);

		expect(state.turns.map((turn) => turn.prompt)).toEqual(['Plan a one-step change and ask me to approve it.']);
		const names = state.turns[0]?.entries.flatMap((entry) => (entry.kind === 'tool' ? [entry.name] : []));
		expect(names).toEqual(['Write', 'ToolSearch', 'ExitPlanMode', 'Write', 'Read']);
		expect(live(lines).turns).toEqual(state.turns);
	});

	it('reads the feedback as part of the call’s answer', () => {
		const exit = cold(lines).turns[0]?.entries.find(
			(entry): entry is ToolEntry => entry.kind === 'tool' && entry.name === 'ExitPlanMode',
		);
		expect(exit?.status).toBe('done');
		expect(exit?.result).toContain('User has approved your plan.');
		expect(exit?.result).toContain('also write the word twice');
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
		// The "Compacted while idle" notice after it is the runtime's (#133).
		expect(kinds).toEqual(['thinking', 'text', 'compaction', 'notice']);
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

	describe('a local command after a cancelled prompt', () => {
		// Recorded on Claude Code 2.1.281: a prompt cancelled and re-sent, the
		// re-send cancelled too, then `/model`. The command's caveat is the
		// sibling of the cancelled prompt, and the command hangs from the caveat.
		const lines = fixtureLines('command-after-cancel');

		it('drops the cancelled prompt when the next thing sent is a command', () => {
			expect(prompts(cold(lines))).toEqual(['/model', 'next']);
			expect(live(lines).turns).toEqual(cold(lines).turns);
		});

		it('says which turn it dropped when the command arrives', () => {
			const at = lines.findIndex((line) => line.includes('<local-command-caveat>'));
			const before = reduce(emptyTranscript(), lines.slice(0, at));
			expect(prompts(before.state)).toEqual(['second draft']);

			const after = reduce(before.state, lines.slice(at));

			expect(after.removedTurnIds).toEqual(['a9da4a97-d54a-479e-8506-ba222565e706']);
		});
	});

	it('keeps an answered prompt when a command follows it', () => {
		const caveat = JSON.stringify({
			type: 'user',
			uuid: 'c1',
			parentUuid: 'a1',
			isMeta: true,
			message: { role: 'user', content: '<local-command-caveat>Caveat: local.</local-command-caveat>' },
		});
		const state = cold([
			user('u1', 'p', 'first'),
			answer('a1', 'u1', 'one'),
			caveat,
			user('k1', 'c1', '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>'),
		]);
		expect(prompts(state)).toEqual(['first', '/model']);
	});

	it('hides nothing for a parent it never saw', () => {
		const state = cold([user('u1', 'p', 'first'), answer('a1', 'u1', 'one'), user('u2', 'elsewhere', 'second')]);
		expect(prompts(state)).toEqual(['first', 'second']);
	});
});

describe('the runtime’s notices and bash mode (#133)', () => {
	const notices = (state: TranscriptState): string[] =>
		state.turns.flatMap((turn) => turn.entries.flatMap((entry) => (entry.kind === 'notice' ? [entry.text] : [])));

	it('shows an unknown command as one notice, its two lines joined, and opens no turn for it', () => {
		// Recorded on 2.1.286: "Unknown command" and the arguments it dropped,
		// two `system` `informational` lines written in the same millisecond.
		const lines = fixtureLines('unknown-command');
		const state = cold(lines);

		expect(notices(state)).toEqual([
			'Unknown command: /github-expfind\nArgs from unknown skill: find a way to switch accounts',
		]);
		expect(state.turns).toHaveLength(2);
		expect(live(lines)).toEqual(state);
	});

	it('shows a usage limit reached and reset as notices in the turns they were written in', () => {
		// Recorded on 2.1.286.
		const lines = fixtureLines('usage-limit');
		const state = cold(lines);

		expect(notices(state)).toEqual([
			'Usage limit reached · continuing automatically at 3:10am · esc to cancel',
			'Usage limit reset · continuing automatically',
		]);
		expect(state.turns).toHaveLength(1);
		expect(live(lines)).toEqual(state);
	});

	it('keeps notices written apart as two', () => {
		const notice = (uuid: string, timestamp: string, content: string): string =>
			JSON.stringify({ type: 'system', subtype: 'informational', uuid, timestamp, content });
		const state = cold([
			JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Go' } }),
			notice('n1', '2026-11-06T10:00:00.000Z', 'Remote Control disconnected'),
			notice('n2', '2026-11-06T10:00:05.000Z', '\u001b[1mCompacted\u001b[22m while idle'),
		]);

		expect(notices(state)).toEqual(['Remote Control disconnected', 'Compacted while idle']);
	});

	it('opens a turn for a bash-mode command and puts what it printed in it', () => {
		// Recorded on 2.1.318: `<bash-input>` and then `<bash-stdout>…<bash-stderr>`,
		// neither line carrying `origin` or `permissionMode`, and the agent
		// answering what it printed.
		const lines = fixtureLines('bash-mode');
		const state = cold(lines);

		const shellTurn = state.turns.at(-1);
		expect(shellTurn?.id).toBe('3203531b-51ee-400e-b1d8-e4dc66840907');
		expect(shellTurn?.prompt).toBe('');
		expect(shellTurn?.entries[0]).toEqual({
			kind: 'shell',
			command: './issues.sh',
			stdout: 'A #126 (exists)\nB #127 (exists)\n./issues.sh: line 461: native: command not found\nPARENT #153',
			stderr: '',
		});
		expect(shellTurn?.entries.some((entry) => entry.kind === 'text')).toBe(true);
		expect(state.turns).toHaveLength(2);
		expect(live(lines)).toEqual(state);
	});

	it('takes a typed prompt that quotes the tags for a prompt', () => {
		const state = cold([
			JSON.stringify({
				type: 'user',
				uuid: 'u1',
				permissionMode: 'auto',
				origin: { kind: 'human' },
				message: { role: 'user', content: '<bash-input>ls</bash-input>' },
			}),
		]);

		expect(state.turns.map((turn) => turn.prompt)).toEqual(['<bash-input>ls</bash-input>']);
	});

	it('still hides a slash command’s own output', () => {
		const state = cold([
			JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
			JSON.stringify({
				type: 'system',
				subtype: 'local_command',
				uuid: 's1',
				content: '<local-command-stdout>Kept model as `Opus 5.5`</local-command-stdout>',
			}),
		]);

		expect(state.turns[0]?.entries).toEqual([]);
	});
});

describe('a /clear inside the same file (#134)', () => {
	// The three `/clear` lines are recorded (2.1.286, from the start of a file
	// Claude rotated to); the turn before them and the late result after them
	// are written around them in the same shapes.
	const lines = fixtureLines('in-file-clear');

	it('drops the turns before it and opens no turn of its own', () => {
		const state = cold(lines);

		expect(state.turns.map((turn) => turn.prompt)).toEqual(['Start afresh']);
		expect(live(lines).turns).toEqual(state.turns);
	});

	it('attaches a tool result for a call from before the clear to nothing', () => {
		const state = cold(lines);

		expect(state.turns.flatMap((turn) => turn.entries.map((entry) => entry.kind))).toEqual(['text']);
		expect(state.raw.user).toBeGreaterThanOrEqual(3);
	});

	it('says which turns it dropped', () => {
		const at = lines.findIndex((line) => line.includes('<command-name>/clear'));
		const before = reduce(emptyTranscript(), lines.slice(0, at));
		const after = reduce(before.state, lines.slice(at, at + 1));

		expect(after.removedTurnIds).toEqual(['u1']);
		expect(after.state.turns).toEqual([]);
	});

	it('does not reset for "/clear" quoted in a prompt, a command with arguments, or a compaction', () => {
		const prompt = (uuid: string, content: string, extra: Record<string, unknown> = {}): string =>
			JSON.stringify({ type: 'user', uuid, message: { role: 'user', content }, ...extra });
		const state = cold([
			prompt('u1', 'First'),
			prompt('u2', 'should I run /clear now?'),
			prompt('u3', '<command-name>/clear</command-name>\n<command-args>everything</command-args>'),
			prompt('c1', '<command-name>/clear</command-name>', { isCompactSummary: true }),
		]);

		expect(state.turns.map((turn) => turn.prompt)).toEqual([
			'First',
			'should I run /clear now?',
			'/clear everything',
		]);
	});

	it('shows a skill command whose message comes before its name as the command', () => {
		// 2.1.286 writes a skill run as a command message first.
		const state = cold([
			JSON.stringify({
				type: 'user',
				uuid: 'u1',
				message: {
					role: 'user',
					content:
						'<command-message>github-explore</command-message>\n<command-name>/github-explore</command-name>\n<command-args>find a way</command-args>',
				},
			}),
		]);

		expect(state.turns.map((turn) => turn.prompt)).toEqual(['/github-explore find a way']);
	});
});

describe('background notifications (#135)', () => {
	const call = (state: TranscriptState, id: string): ToolEntry | undefined =>
		state.turns
			.flatMap((turn) => turn.entries)
			.find((entry): entry is ToolEntry => entry.kind === 'tool' && entry.id === id);

	it('runs a background command until its notification, and updates it once', () => {
		// Recorded on 2.1.318: the launch result, then the notification as its
		// enqueue and as a `user` line.
		const lines = fixtureLines('background-command');
		const id = 'toolu_01A33MC8USCwTrLZnPZCMkZR';
		const enqueue = lines.findIndex((line) => line.includes('"operation":"enqueue"'));
		const before = reduce(emptyTranscript(), lines.slice(0, enqueue));
		expect(call(before.state, id)?.status).toBe('running');

		const queued = reduce(before.state, lines.slice(enqueue, enqueue + 1));
		const userLine = lines.findIndex((line, index) => index > enqueue && line.includes('"type":"user"'));
		const again = reduce(queued.state, lines.slice(enqueue + 1, userLine + 1));

		expect(call(queued.state, id)).toMatchObject({ status: 'done', notification: { kind: 'command', taskId: 'bwrgqc4ez' } });
		expect(queued.changedTurnIds).toHaveLength(1);
		expect(again.changedTurnIds).toEqual([]);
		expect(cold(lines).turns.map((turn) => turn.prompt)).toEqual(['great, wait for the other session and check back']);
		expect(live(lines)).toEqual(cold(lines));
	});

	it('ends a subagent from a notification taken in mid-turn, and reads it once', () => {
		// Recorded on 2.1.318: the notification as its enqueue, a `remove`, and
		// the `queued_command` attachment, with no `user` line at all.
		const lines = fixtureLines('subagent-notification');
		const id = 'toolu_015dmny5S9fW7gz3wk9eweTn';
		const state = cold(lines);

		expect(call(state, id)).toMatchObject({ status: 'done', notification: { kind: 'agent', taskId: 'a615da8d9e3c64686' } });
		const attachment = lines.findIndex((line) => line.includes('"commandMode":"task-notification"'));
		const upTo = reduce(emptyTranscript(), lines.slice(0, attachment));
		expect(reduce(upTo.state, lines.slice(attachment, attachment + 1)).changedTurnIds).toEqual([]);
		expect(live(lines)).toEqual(state);
	});

	it('does not take a background command’s notification for a subagent’s', () => {
		const notification = [
			'<task-notification>',
			'<task-id>a1</task-id>',
			'<tool-use-id>toolu_a1</tool-use-id>',
			'<status>completed</status>',
			'<summary>Background command "sleep 5" completed (exit code 0)</summary>',
			'</task-notification>',
		].join('\n');
		const state = cold([
			JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Go' } }),
			JSON.stringify({
				type: 'assistant',
				message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_a1', name: 'Agent', input: {} }] },
			}),
			JSON.stringify({
				type: 'user',
				message: {
					role: 'user',
					content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: 'Async agent launched successfully.' }],
				},
			}),
			JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: notification }),
		]);

		expect(call(state, 'toolu_a1')?.status).toBe('running');
	});

	it('never opens a turn for a notification whose enqueue it did not see', () => {
		const state = cold([
			JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Go' } }),
			JSON.stringify({
				type: 'user',
				uuid: 'n1',
				message: { role: 'user', content: '<task-notification>\n<task-id>x</task-id>\n</task-notification>' },
			}),
		]);

		expect(state.turns.map((turn) => turn.prompt)).toEqual(['Go']);
	});

	it('marks what was running lost, and leaves what ended alone', () => {
		const lines = fixtureLines('background-command');
		const enqueue = lines.findIndex((line) => line.includes('"operation":"enqueue"'));
		const running = reduce(emptyTranscript(), lines.slice(0, enqueue)).state;

		const { state, changedTurnIds } = markLost(running);

		expect(call(state, 'toolu_01A33MC8USCwTrLZnPZCMkZR')?.status).toBe('lost');
		expect(changedTurnIds).toEqual([running.turns[0]?.id]);
		expect(call(running, 'toolu_01A33MC8USCwTrLZnPZCMkZR')?.status).toBe('running');
		expect(markLost(state).changedTurnIds).toEqual([]);
	});
});
