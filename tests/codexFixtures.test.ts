/**
 * The recorded Codex fixtures (issue #136), and the facts about them that the
 * finding `findings/agent-codex.md` and `docs/architecture.md` ("A second
 * agent: Codex") rest on. No parser reads them yet: the agent-neutral model
 * (#137) will, and these tests keep the fixtures saying what those documents
 * claim they say.
 *
 * - `tui-daemon-0.166.0.jsonl`: a Codex 0.163.0 TUI on the shared app-server
 *   daemon (0.166.0, which writes the rollout): a one-word reply, a command
 *   the sandbox refused (`exit_code` 1 inside a completed script), `/compact`.
 * - `tui-approval-steer-0.167.0.jsonl`: Codex 0.167.0 with `--no-daemon -a
 *   on-request`: an escalation the user declined, a steer sent while a turn
 *   ran, a yielded command cell and its `wait`.
 * - `exec-json-0.167.0.jsonl`: `codex exec --json` stdout for one prompt.
 *
 * Recorded 2026-11-06 in `/tmp/oh-codex-live`, then scrubbed: account ids,
 * instructions, tool definitions, encrypted reasoning and rate-limit details
 * replaced, every record kept in order with its real shape.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Rec = { timestamp: string; ordinal: number; type: string; payload: Record<string, unknown> };

function text(name: string): string {
	return readFileSync(join(__dirname, 'fixtures', 'codex', name), 'utf8');
}

function rollout(name: string): Rec[] {
	return text(name)
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Rec);
}

const ROLLOUTS = ['tui-daemon-0.166.0.jsonl', 'tui-approval-steer-0.167.0.jsonl'];

function itemsOf(records: Rec[], type: string): Record<string, unknown>[] {
	return records
		.filter((r) => r.type === 'event_msg' && r.payload.type === 'item_completed')
		.map((r) => r.payload.item as Record<string, unknown>)
		.filter((item) => item.type === type);
}

function eventsOf(records: Rec[], type: string): Rec[] {
	return records.filter((r) => r.type === 'event_msg' && r.payload.type === type);
}

describe('Codex fixtures: scrubbed', () => {
	it.each([...ROLLOUTS, 'exec-json-0.167.0.jsonl'])('%s holds no personal path, account id or ciphertext', (name) => {
		const body = text(name);
		expect(body).not.toMatch(/\/home\/(?!user\b)/);
		expect(body).not.toMatch(/creator_(user|account)_id/);
		expect(body).not.toMatch(/"encrypted_content":"(?!<encrypted, scrubbed>)/);
		expect(body).not.toMatch(/plan_type|credits/);
	});
});

describe('Codex rollouts: record shape', () => {
	it.each(ROLLOUTS)('%s opens with session_meta and numbers its records 0, 1, 2, …', (name) => {
		const records = rollout(name);
		expect(records[0]?.type).toBe('session_meta');
		expect(records.map((r) => r.ordinal)).toEqual(records.map((_, i) => i));
	});

	it('names the writer: the daemon writes the TUI rollout with its own version', () => {
		const meta = rollout('tui-daemon-0.166.0.jsonl')[0]?.payload;
		expect(meta).toMatchObject({ originator: 'codex-tui', cli_version: '0.166.0', source: 'vscode' });
		const direct = rollout('tui-approval-steer-0.167.0.jsonl')[0]?.payload;
		expect(direct).toMatchObject({ originator: 'codex-tui', cli_version: '0.167.0', source: 'cli' });
	});

	it.each(ROLLOUTS)('%s writes every prompt and reply twice, as a response item and as a completed item', (name) => {
		const records = rollout(name);
		const prompts = records.filter(
			(r) =>
				r.type === 'response_item' &&
				r.payload.type === 'message' &&
				r.payload.role === 'user' &&
				(r.payload.internal_chat_message_metadata_passthrough as { content_item_kinds?: string[] })
					?.content_item_kinds?.[0] === 'user.text',
		);
		const userItems = itemsOf(records, 'UserMessage');
		expect(prompts.length).toBeGreaterThan(0);
		expect(userItems).toHaveLength(prompts.length);
		const replies = records.filter((r) => r.type === 'response_item' && r.payload.type === 'message' && r.payload.role === 'assistant');
		expect(itemsOf(records, 'AgentMessage')).toHaveLength(replies.length);
		for (const reply of replies) expect(['commentary', 'final_answer']).toContain(reply.payload.phase);
	});

	it.each(ROLLOUTS)('%s ends every turn with task_complete or turn_aborted', (name) => {
		const records = rollout(name);
		const started = eventsOf(records, 'task_started').map((r) => r.payload.turn_id);
		const ended = [...eventsOf(records, 'task_complete'), ...eventsOf(records, 'turn_aborted')].map((r) => r.payload.turn_id);
		expect(new Set(ended)).toEqual(new Set(started));
	});
});

describe('Codex rollouts: tool calls carry no outcome flag', () => {
	it('a refused command is a completed script whose output holds exit_code 1', () => {
		const records = rollout('tui-daemon-0.166.0.jsonl');
		const call = records.find((r) => r.payload.type === 'custom_tool_call');
		expect(call?.payload).toMatchObject({ name: 'exec', status: 'completed' });
		const output = records.find((r) => r.payload.type === 'custom_tool_call_output' && r.payload.call_id === call?.payload.call_id);
		const blocks = output?.payload.output as { type: string; text: string }[];
		expect(blocks[0]?.text).toMatch(/^Script completed\n/);
		expect(JSON.parse(blocks[1]?.text ?? '{}')).toMatchObject({ exit_code: 1 });
		expect(Object.keys(output?.payload ?? {})).not.toContain('is_error');
		// No CommandExecution item is written for a command run inside a script.
		expect(itemsOf(records, 'CommandExecution')).toHaveLength(0);
	});

	it('a declined escalation leaves its call answered by a plain string and aborts the turn', () => {
		const records = rollout('tui-approval-steer-0.167.0.jsonl');
		const escalated = records.find(
			(r) => r.payload.type === 'custom_tool_call' && String(r.payload.input).includes('require_escalated'),
		);
		expect(escalated?.payload.status).toBe('completed');
		const output = records.find((r) => r.payload.type === 'custom_tool_call_output' && r.payload.call_id === escalated?.payload.call_id);
		expect(output?.payload.output).toMatch(/^aborted by user after [\d.]+s$/);
		expect(eventsOf(records, 'turn_aborted')[0]?.payload).toMatchObject({ reason: 'interrupted' });
	});

	it('a command a script yielded ends as a CommandExecution item with status and exit code', () => {
		const records = rollout('tui-approval-steer-0.167.0.jsonl');
		const yielded = records.find((r) => r.payload.type === 'custom_tool_call_output' && /^Script running with cell ID/.test(String(r.payload.output)));
		expect(yielded).toBeDefined();
		const wait = records.find((r) => r.payload.type === 'function_call' && r.payload.name === 'wait');
		expect(wait).toBeDefined();
		expect(itemsOf(records, 'CommandExecution')[0]).toMatchObject({ status: 'completed', exit_code: 0, command: ['/usr/bin/bash', '-lc', 'sleep 10'] });
	});
});

describe('Codex rollouts: steering and compaction', () => {
	it('a prompt sent while a turn runs joins that turn: a second user message under the same turn id', () => {
		const records = rollout('tui-approval-steer-0.167.0.jsonl');
		const steer = itemsOf(records, 'UserMessage').find((item) =>
			JSON.stringify(item.content).includes('banana'),
		);
		const steerRecord = records.find((r) => r.payload.item === steer);
		const turnId = steerRecord?.payload.turn_id;
		const sameTurn = records.filter((r) => r.payload.type === 'item_completed' && r.payload.turn_id === turnId);
		expect(itemsOf(sameTurn, 'UserMessage')).toHaveLength(2);
		expect(eventsOf(records, 'task_started').filter((r) => r.payload.turn_id === turnId)).toHaveLength(1);
	});

	it('/compact is a turn of its own with no prompt, a compacted record without readable summary, and a ContextCompaction item', () => {
		const records = rollout('tui-daemon-0.166.0.jsonl');
		const compacted = records.find((r) => r.type === 'compacted');
		expect(compacted?.payload.message).toBe('');
		const item = records.find((r) => r.payload.type === 'item_completed' && (r.payload.item as { type?: string }).type === 'ContextCompaction');
		const turn = records.filter((r) => r.payload.turn_id === item?.payload.turn_id);
		expect(itemsOf(turn, 'UserMessage')).toHaveLength(0);
		expect(eventsOf(turn, 'task_complete')[0]?.payload.last_agent_message).toBeNull();
	});

	it('reads model and effort from turn_context', () => {
		const context = rollout('tui-approval-steer-0.167.0.jsonl').find((r) => r.type === 'turn_context');
		expect(typeof context?.payload.model).toBe('string');
		expect(context?.payload.effort).toBe('medium');
	});
});

describe('codex exec --json', () => {
	it('is a stream of its own: thread, turn and item events, not rollout records', () => {
		const events = text('exec-json-0.167.0.jsonl')
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string });
		expect(events.map((event) => event.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
	});
});
