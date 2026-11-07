/**
 * The agent seam's acceptance test (issue #137, ADR-0010): a second agent's
 * recorded session, read by a stub parser behind the seam's interface, goes
 * through everything above the seam — the session model, the turn renderer,
 * the tool groups, the table of contents, copy, find and the waiting card —
 * with nothing there knowing it is not Claude.
 *
 * The stub is a test's parser, not Codex support: no format for Codex is
 * registered, and the native view is not offered for it (`agentFormat.test.ts`).
 * It reads the recorded rollouts in `fixtures/codex/` the way the finding
 * `agent-codex` says a parser should: prompts and replies from the
 * `item_completed` layer, calls from `response_item`, turns from their own
 * lifecycle records, outcomes from the output text (`fixtures/codexParser.ts`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostEl } from './fixtures/dom';
import type { ToolEntry, Turn } from '../src/native/conversation';
import { codexParser, text, type CodexState } from './fixtures/codexParser';
import type { AgentFormat } from '../src/agents/format';
import { SessionModel } from '../src/native/sessionModel';
import type { PaneSnapshot, SessionWatcher } from '../src/native/sessionWatcher';
import type { TranscriptSource } from '../src/native/transcriptSource';
import { TurnRenderer } from '../src/native/turnRenderer';
import { changeLine, toolGroupHeader, turnItems } from '../src/native/toolCalls';
import { turnLabel } from '../src/native/tocView';
import { replyMarkdown } from '../src/native/copyActions';
import { findInTurns } from '../src/native/conversationFind';
import { waitingCard } from '../src/native/waitingCard';

/** The stub as a format. Only what the view asks of a Codex session. */
const CODEX_STUB: AgentFormat<CodexState> = {
	agent: 'codex',
	name: 'Codex',
	parser: codexParser,
	transcriptPath: ({ agentSession }) => (agentSession ? `/codex/sessions/rollout-${agentSession}.jsonl` : null),
	readImage: () => null,
	// A call waiting on approval says why in its own input (finding §4).
	pendingCall: (call) => {
		const reason = /justification:"([^"]*)"/.exec(text(call.input.script));
		return reason ? { kind: 'permission', reason: reason[1] ?? '' } : null;
	},
	// Codex's own names: no other format knows them, so only this table can
	// make them anything but `other`.
	toolKinds: { exec: 'bash', wait: 'bash' },
	commands: { builtin: () => [], local: () => ({ catalog: () => [] }) },
	sessionInfo: (state) => state.info,
	efforts: ['low', 'medium', 'high'],
	modes: ['on-request', 'never'],
};

function fixture(name: string): string[] {
	return readFileSync(join(__dirname, 'fixtures', 'codex', name), 'utf8').split('\n').filter(Boolean);
}

const STEER = fixture('tui-approval-steer-0.167.0.jsonl');
const DAEMON = fixture('tui-daemon-0.166.0.jsonl');

function parse(lines: string[]): CodexState {
	return codexParser.reduce(codexParser.empty(), lines).state;
}

function tools(turn: Turn | undefined): ToolEntry[] {
	return (turn?.entries ?? []).filter((entry): entry is ToolEntry => entry.kind === 'tool');
}

describe('a Codex rollout through the seam’s parser interface', () => {
	it('takes turns from their own records: ids, prompts, steers and how each ended', () => {
		const { turns } = parse(STEER);
		expect(turns.map((turn) => turn.id)).toEqual([
			'01a1b168-f02b-7391-8719-476cd4589acb',
			'01a1b169-a064-7d40-b771-03e336830123',
			'01a1b16a-783a-78e3-9645-69bcc538bedc',
			'01a1b16a-96b3-7fe3-8528-8de6f5d07857',
		]);
		expect(turns.map((turn) => turn.outcome)).toEqual(['aborted', 'completed', 'completed', 'completed']);
		expect(turns[1]?.prompt).toBe('Run the shell command `sleep 10` inside the workspace, then reply with the word done.');
		// The steer joined the running turn instead of opening one.
		expect(turns[1]?.entries.filter((entry) => entry.kind === 'steer')).toEqual([
			{ kind: 'steer', text: 'Also add the word banana to your reply.' },
		]);
		const replies = turns[1]?.entries.filter((entry) => entry.kind === 'text');
		expect(replies?.map((entry) => entry.kind === 'text' && entry.phase)).toEqual(['commentary', 'final']);
	});

	it('says unknown and declined where no record flags an outcome, and links a wait to its cell', () => {
		const { turns } = parse(STEER);
		expect(tools(turns[0]).map((call) => call.status)).toEqual(['unknown', 'declined']);
		const [exec, wait] = tools(turns[1]);
		expect(wait?.name).toBe('wait');
		expect(wait?.continues).toBe(exec?.id);
		expect([exec?.status, wait?.status]).toEqual(['unknown', 'unknown']);
	});

	it('reads a compaction with no summary as its own unprompted turn, and empty reasoning as present', () => {
		const { turns, info } = parse(DAEMON);
		const compacted = turns.find((turn) => turn.entries.some((entry) => entry.kind === 'compaction'));
		expect(compacted?.prompt).toBe('');
		expect(compacted?.entries.find((entry) => entry.kind === 'compaction')).toEqual({ kind: 'compaction', summary: '' });
		expect(turns.flatMap((turn) => turn.entries).filter((entry) => entry.kind === 'thinking')).toEqual([
			expect.objectContaining({ kind: 'thinking', text: '' }),
		]);
		expect(info).toMatchObject({ model: { id: 'gpt-6.1-sol' }, effort: 'medium', contextWindow: { tokens: 475000, source: 'agent' } });
	});

	it('folds a tail batch by batch to what the whole file folds to', () => {
		let state = codexParser.empty();
		for (let at = 0; at < STEER.length; at += 7) state = codexParser.reduce(state, STEER.slice(at, at + 7)).state;
		expect(state.turns).toEqual(parse(STEER).turns);
	});
});

describe('above the seam, a Codex session is a conversation like any other', () => {
	it('follows the pane through the session model with the pane’s agent’s format', async () => {
		let deliver: ((lines: string[]) => void) | null = null;
		const pane: PaneSnapshot = {
			paneId: 'p1',
			cwd: '/tmp/oh-codex-live',
			agent: 'codex',
			agentSession: '01a1b168-d212-7d00-995a-37e0d2746856',
			agentStatus: 'done',
		};
		const watcher: SessionWatcher = {
			snapshot: (paneId) => (paneId === 'p1' ? pane : null),
			onSession: () => () => {},
			onStatus: () => () => {},
			onMembership: () => () => {},
		};
		const opened: string[] = [];
		const source: TranscriptSource = {
			read: () => Promise.resolve(null),
			open: (path, onLines) => {
				opened.push(path);
				deliver = onLines;
				return { close: () => {} };
			},
		};
		const asked: string[] = [];
		const model = new SessionModel({
			endpointId: 'local',
			paneId: 'p1',
			watcher: () => watcher,
			source: () => source,
			formats: (agent) => {
				asked.push(agent);
				return agent === 'codex' ? CODEX_STUB : null;
			},
		});
		model.start();
		expect(asked).toEqual(['codex']);
		expect(opened).toEqual(['/codex/sessions/rollout-01a1b168-d212-7d00-995a-37e0d2746856.jsonl']);
		expect(model.format).toBe(CODEX_STUB);
		(deliver as ((lines: string[]) => void) | null)?.(STEER);
		expect(model.state.turns).toEqual(parse(STEER).turns);
		expect(model.sessionInfo).toMatchObject({ model: { id: 'gpt-6.1-sol' }, effort: 'medium' });
		model.dispose();
	});

	it('draws every turn, groups the calls and says what was declined', () => {
		const { turns } = parse(STEER);
		const { el, host } = hostEl();
		const renderer = new TurnRenderer(host, {
			presentation: () => 'highlight',
			vaultPath: () => '/vault',
			renderMarkdown: () => Promise.resolve(),
			resolveUri: () => null,
		});
		for (const turn of turns) renderer.render(turn);
		expect(turns.every((turn) => renderer.turnEl(turn.id))).toBe(true);
		expect(el.findAll('herdr-native-steer')).toHaveLength(1);
		const groups = turnItems(turns[0]?.entries ?? [], 'highlight').filter((item) => item.kind === 'group');
		expect(groups).toHaveLength(1);
		const group = groups[0];
		expect(group?.kind === 'group' && toolGroupHeader(group.tools, 'settled').failed).toBe('1 declined');
		expect(changeLine('unknown').lead).toBe('Tried to update ');
	});

	it('shows the calls by the session’s own format’s tool table, not by the registry’s', () => {
		const { turns } = parse(STEER);
		const group = turnItems(turns[0]?.entries ?? [], 'highlight', CODEX_STUB).find((item) => item.kind === 'group');
		const calls = group?.kind === 'group' ? group.tools : [];
		expect(calls.length).toBeGreaterThan(0);
		expect(toolGroupHeader(calls, 'settled', CODEX_STUB).counts).toBe(`ran ${calls.length} commands`);
		// Read with every format's table, Codex's names are no one's.
		expect(toolGroupHeader(calls, 'settled').counts).toBe(`used ${calls.length} tools`);

		const { el, host } = hostEl();
		const renderer = new TurnRenderer(host, {
			presentation: () => 'highlight',
			vaultPath: () => '/vault',
			renderMarkdown: () => Promise.resolve(),
			resolveUri: () => null,
			toolTable: () => CODEX_STUB,
		});
		for (const turn of turns) renderer.render(turn);
		const counts = el.findAll('herdr-native-tools-counts').map((node) => node.textContent);
		expect(counts).toContain(`ran ${calls.length} commands`);
	});

	it('lists, copies and finds the turns by what was asked and answered', () => {
		const { turns } = parse(STEER);
		expect(turnLabel(turns[1] as Turn)).toContain('sleep 10');
		expect(replyMarkdown(turns[1] as Turn)).toContain('done banana');
		expect(findInTurns(turns, 'banana').length).toBeGreaterThan(0);
	});

	it('names the call the agent is blocked on, and the reason it gave, on the waiting card', () => {
		// The rollout up to the escalated call, before anyone answered it.
		const before = STEER.slice(0, STEER.findIndex((line) => line.includes('"output":"aborted by user')));
		const { turns } = parse(before);
		const card = waitingCard({ blockKind: null, hasTranscript: true, turns, vaultPath: '/vault', format: CODEX_STUB });
		expect(card).toMatchObject({
			kind: 'permission',
			title: 'Codex wants to use exec',
			body: 'Allow the exact touch command to run outside the sandbox after the sandbox blocked writing to /var/tmp?',
			reported: false,
		});
	});
});
