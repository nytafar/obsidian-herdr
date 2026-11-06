/**
 * A tool group's header and default fold (issue #128): where the group stands
 * — working, needs you, worked — its counts, how many calls failed, and
 * whether it starts open. All pure, in `src/native/toolCalls.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
	openRunIndex,
	toolGroupCounts,
	toolGroupHeader,
	toolGroupStartsOpen,
	toolGroupState,
	turnActivity,
	turnItems,
} from '../src/native/toolCalls';
import type { ToolEntry, ToolStatus, TurnEntry } from '../src/native/reducer';

function tool(id: string, name = 'Read', status: ToolStatus = 'done'): ToolEntry {
	return {
		kind: 'tool',
		id,
		name,
		input: { file_path: `/vault/${id}.md` },
		result: status === 'pending' ? null : 'ok',
		status,
		notification: null,
		report: null,
	};
}

describe('turnActivity', () => {
	it('is working or blocked while herdr says so, and nothing otherwise', () => {
		expect(turnActivity('working')).toBe('working');
		expect(turnActivity('blocked')).toBe('blocked');
		expect(turnActivity('idle')).toBeNull();
		expect(turnActivity('done')).toBeNull();
		expect(turnActivity('unknown')).toBeNull();
	});
});

describe('toolGroupState', () => {
	it('is settled in a turn the agent is not working in, whatever its calls say', () => {
		expect(toolGroupState([tool('t1', 'Bash', 'pending')], null, true)).toBe('settled');
	});

	it('is live or waiting for the open run, as the agent is', () => {
		expect(toolGroupState([tool('t1')], 'working', true)).toBe('live');
		expect(toolGroupState([tool('t1')], 'blocked', true)).toBe('waiting');
	});

	it('is settled further up the turn, unless a call there has not come back', () => {
		expect(toolGroupState([tool('t1')], 'working', false)).toBe('settled');
		expect(toolGroupState([tool('t1', 'Agent', 'running')], 'working', false)).toBe('live');
		// The block is in the open run, never in a group further up.
		expect(toolGroupState([tool('t1', 'Agent', 'running')], 'blocked', false)).toBe('live');
	});
});

describe('openRunIndex', () => {
	const items = (entries: TurnEntry[]) => turnItems(entries, 'highlight');

	it('is the last group when nothing after it ends the run', () => {
		expect(openRunIndex(items([{ kind: 'text', messageId: 'm1', text: 'a' }, tool('t1')]))).toBe(1);
		// A vault change escapes the group without ending its run.
		expect(openRunIndex(items([tool('t1'), tool('t2', 'Write')]))).toBe(0);
	});

	it('is none once prose, a thought or a steer follows the last group', () => {
		expect(openRunIndex(items([tool('t1'), { kind: 'text', messageId: 'm1', text: 'a' }]))).toBe(-1);
		expect(openRunIndex(items([tool('t1'), { kind: 'steer', text: 'and' }]))).toBe(-1);
		expect(openRunIndex(items([]))).toBe(-1);
	});
});

describe('toolGroupHeader', () => {
	it('titles the group by where it stands', () => {
		const tools = [tool('t1')];
		expect(toolGroupHeader(tools, 'live').title).toBe('Working…');
		expect(toolGroupHeader(tools, 'waiting').title).toBe('Needs you');
		expect(toolGroupHeader(tools, 'settled').title).toBe('Worked');
	});

	it('counts by kind in lower case, to read after the title', () => {
		const header = toolGroupHeader([tool('t1'), tool('t2'), tool('t3', 'Bash')], 'settled');
		expect(header.counts).toBe('read 2 files, ran 1 command');
		expect(toolGroupCounts([])).toBe('');
	});

	it('says how many calls failed, apart from the counts, and nothing when none did', () => {
		const tools = [tool('t1', 'Bash', 'error'), tool('t2', 'Read', 'error'), tool('t3')];
		expect(toolGroupHeader(tools, 'settled').failed).toBe('2 failed');
		expect(toolGroupHeader([tool('t1')], 'settled').failed).toBeNull();
	});
});

describe('toolGroupStartsOpen', () => {
	it('opens a running or waiting group and folds a settled one', () => {
		expect(toolGroupStartsOpen('live')).toBe(true);
		expect(toolGroupStartsOpen('waiting')).toBe(true);
		expect(toolGroupStartsOpen('settled')).toBe(false);
	});
});
