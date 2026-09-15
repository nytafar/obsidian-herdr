/**
 * The transcript reducer (issue #93, ADR-0003).
 *
 * `reduce(state, lines)` is pure, so every case here is a fixture transcript
 * under `tests/fixtures/transcripts/` reduced from the empty state: the shapes
 * are trimmed copies of real Claude Code lines (`docs/architecture.md`,
 * "Agent prompts and session identity"), never invented ones.
 *
 * The last test is the live corpus: the transcript of the session running the
 * tests, found through `CLAUDE_CODE_SESSION_ID`, skipped when the tests are not
 * run from inside a session. It grows with every session, which is the point —
 * it is the case nobody wrote by hand.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyTranscript, reduce, type TranscriptState } from '../src/native/reducer';

/** A fixture transcript's lines, newline-split the way a tail delivers them. */
function fixtureLines(name: string): string[] {
	const path = join(__dirname, 'fixtures', 'transcripts', `${name}.jsonl`);
	return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

/** The fixture reduced in one go from nothing. */
function reduceFixture(name: string): { state: TranscriptState; changedTurnIds: string[] } {
	return reduce(emptyTranscript(), fixtureLines(name));
}

describe('reduce: a plain turn', () => {
	it('starts a turn at the human prompt and hangs the assistant text off it', () => {
		const { state, changedTurnIds } = reduceFixture('plain-turn');

		expect(state.turns).toEqual([
			{
				id: 'u1',
				prompt: 'Summarise [[native-view-design]] for me',
				entries: [{ kind: 'text', messageId: 'msg_1', text: 'The design settles two seams.' }],
			},
		]);
		expect(changedTurnIds).toEqual(['u1']);
	});
});

describe('reduce: assistant blocks merged by message id', () => {
	it('concatenates the text of one message and keeps the next message apart', () => {
		const { state } = reduceFixture('merged-blocks');

		expect(state.turns).toHaveLength(1);
		expect(state.turns[0]?.entries).toEqual([
			// The thinking text rides along: the view shows it in a collapsed
			// disclosure (#95), and only the signature is dropped.
			{ kind: 'thinking', messageId: 'msg_2', text: 'weighing the rule' },
			{
				kind: 'text',
				messageId: 'msg_2',
				text: 'A turn starts at a human prompt.\n\nEverything after it belongs to that turn.',
			},
			{ kind: 'text', messageId: 'msg_3', text: 'A second message stays its own block.' },
		]);
	});
});

describe('reduce: unknown lines', () => {
	it('keeps every line it does not render as raw, counted by type, and opens no turn', () => {
		const { state, changedTurnIds } = reduceFixture('unknown-lines');

		expect(state.turns).toEqual([]);
		expect(changedTurnIds).toEqual([]);
		expect(state.raw).toEqual({
			mode: 1,
			'atis-latch': 1,
			'file-history-snapshot': 1,
			system: 1,
			// No `compact_boundary` line exists on this machine, so its shape is
			// unverified and it is raw until one is seen (native-view-design.md).
			compact_boundary: 1,
			// A meta `user` line is Claude talking to itself, not a prompt.
			user: 1,
			// The last fixture line is half-written, as a tail can deliver it.
			'(unparsed)': 1,
		});
	});
});

describe('reduce: tool results', () => {
	it('attaches a tool result to the tool use it answers', () => {
		const { state } = reduceFixture('tool-results');

		expect(state.turns).toHaveLength(1);
		expect(state.turns[0]?.entries).toEqual([
			{ kind: 'text', messageId: 'msg_5', text: 'Running them.' },
			// The call's input rides along too: what a tool line and a vault
			// change say comes out of it (#95), and only the surface knows how.
			{
				kind: 'tool',
				id: 'toolu_1',
				name: 'Bash',
				input: { command: 'npm test' },
				result: '3 passed',
				notification: null,
				report: null,
			},
			{ kind: 'text', messageId: 'msg_6', text: 'All green.' },
		]);
	});
});

describe('reduce: steers and task notifications', () => {
	it('renders a human steer inline in the running turn and opens no turn for it', () => {
		const { state } = reduceFixture('steer-and-notification');

		expect(state.turns).toHaveLength(1);
		expect(state.turns[0]?.prompt).toBe('Start the long job');
		expect(state.turns[0]?.entries).toEqual([
			{ kind: 'text', messageId: 'msg_7', text: 'Starting it.' },
			{
				kind: 'tool',
				id: 'toolu_a1',
				name: 'Agent',
				input: {
					description: 'Check the styles',
					subagent_type: 'general-purpose',
					prompt: 'Check the styles',
				},
				// The launch result is internal metadata, never the report; the
				// report is read from the notification's output file (#96).
				result: 'Async agent launched successfully. agentId: a1f2',
				notification: {
					taskId: 'a1f2',
					outputFile: '/tmp/claude-1000/-home-lasse-hvelv/s1/tasks/a1f2.output',
				},
				report: null,
			},
			{ kind: 'steer', text: 'also check the styles' },
			{ kind: 'text', messageId: 'msg_8', text: 'Styles checked too.' },
		]);
	});

	it('attaches a task notification to the tool call it names, and starts no turn for it', () => {
		const { state } = reduceFixture('steer-and-notification');

		const entries = state.turns[0]?.entries ?? [];
		const call = entries.find((entry) => entry.kind === 'tool');
		expect(call?.kind === 'tool' && call.notification?.taskId).toBe('a1f2');
		// It is not a turn of its own, and it renders nothing by itself.
		expect(state.turns).toHaveLength(1);
		expect(state.raw.user).toBe(1);
	});

	it('does not read a subagent task notification as a human turn', () => {
		const { state } = reduceFixture('steer-and-notification');

		// The notification arrives as an enqueue and then a string `user` line;
		// only the enqueue pairing tells it apart from a prompt (ADR-0003).
		expect(state.turns.map((turn) => turn.prompt)).toEqual(['Start the long job']);
		expect(state.raw.user).toBe(1);
	});
});

describe('reduce: a slash command run at the keyboard', () => {
	it('shows the command the human ran, and not the caveat or the output around it', () => {
		const { state } = reduceFixture('local-command');

		expect(state.turns).toHaveLength(1);
		expect(state.turns[0]?.prompt).toBe('/model opus');
		expect(state.turns[0]?.entries).toEqual([]);
		// The caveat is `isMeta`; the stdout line is the command answering, not
		// the human speaking, so neither opens a turn.
		expect(state.raw.user).toBe(2);
	});
});

describe('reduce: incremental', () => {
	it('reports only the turns a batch of lines changed, and leaves the old state alone', () => {
		const lines = fixtureLines('tool-results');
		const first = reduce(emptyTranscript(), lines.slice(0, 2));
		const second = reduce(first.state, lines.slice(2));

		expect(first.changedTurnIds).toEqual(['u4']);
		expect(second.changedTurnIds).toEqual(['u4']);
		// The first result is a snapshot: reducing on does not mutate it.
		expect(first.state.turns[0]?.entries).toEqual([
			{ kind: 'text', messageId: 'msg_5', text: 'Running them.' },
		]);
		expect(second.state.turns[0]?.entries).toHaveLength(3);
	});

	it('reports a new turn once, however the lines are batched', () => {
		const lines = fixtureLines('merged-blocks');
		let state = emptyTranscript();
		const changed: string[][] = [];
		for (const line of lines) {
			const result = reduce(state, [line]);
			state = result.state;
			changed.push(result.changedTurnIds);
		}

		expect(changed).toEqual([['u2'], ['u2'], ['u2'], ['u2'], ['u2']]);
	});
});

describe('reduce: the live corpus', () => {
	const sessionId = process.env.CLAUDE_CODE_SESSION_ID;

	/**
	 * The running session's transcript. The project folder is the *session's*
	 * cwd encoded, which is not necessarily the directory vitest runs in (an
	 * agent working a worktree was started from the main checkout), so the file
	 * is looked up by name across the project folders.
	 */
	function liveTranscript(id: string): string | null {
		const projects = join(homedir(), '.claude', 'projects');
		for (const folder of readdirSync(projects)) {
			const path = join(projects, folder, `${id}.jsonl`);
			if (existsSync(path)) return path;
		}
		return null;
	}

	it.skipIf(!sessionId)('reduces the running session without throwing', () => {
		const path = liveTranscript(sessionId ?? '');
		expect(path).not.toBeNull();
		const lines = readFileSync(path ?? '', 'utf8')
			.split('\n')
			.filter(Boolean);

		const { state } = reduce(emptyTranscript(), lines);

		expect(state.turns.length).toBeGreaterThanOrEqual(1);
		for (const turn of state.turns) expect(typeof turn.prompt).toBe('string');
	});
});
