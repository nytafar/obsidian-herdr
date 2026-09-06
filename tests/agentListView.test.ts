import { describe, expect, it } from 'vitest';
import {
	agentDisplayName,
	countStatuses,
	groupByTab,
	relativeCwd,
} from '../src/views/agentListView';
import type { PaneState } from '../src/herdr/scope';
import type { AgentStatus } from '../src/herdr/types.gen';

const VAULT = '/Users/lasse/Vaults/hvelv';

function pane(
	paneId: string,
	tabId: string,
	agentStatus: AgentStatus,
	overrides: Partial<PaneState> = {},
): PaneState {
	return {
		paneId,
		workspaceId: 'w4',
		tabId,
		agent: 'claude',
		name: '',
		agentStatus,
		title: paneId,
		label: '',
		cwd: VAULT,
		focused: false,
		...overrides,
	};
}

describe('relativeCwd', () => {
	it('strips the vault prefix', () => {
		expect(relativeCwd(`${VAULT}/projects/herdr`, VAULT)).toBe('projects/herdr');
	});

	it('renders the vault root as nothing', () => {
		expect(relativeCwd(VAULT, VAULT)).toBe('');
		expect(relativeCwd(VAULT, `${VAULT}/`)).toBe('');
	});

	it('keeps a path outside the vault absolute', () => {
		expect(relativeCwd('/Users/lasse/code/herdr', VAULT)).toBe('/Users/lasse/code/herdr');
		// A sibling folder whose name merely starts with the vault path is outside.
		expect(relativeCwd(`${VAULT}-backup/x`, VAULT)).toBe(`${VAULT}-backup/x`);
	});

	it('survives an unknown vault path', () => {
		expect(relativeCwd('/tmp/x', '')).toBe('/tmp/x');
		expect(relativeCwd('', VAULT)).toBe('');
	});
});

describe('agentDisplayName (M8)', () => {
	it('prefers the agent name, then the title, and never the kind', () => {
		expect(agentDisplayName(pane('w4:p1', 'w4:t1', 'idle', { name: 'vault-maintenance' }))).toBe(
			'vault-maintenance',
		);
		expect(
			agentDisplayName(pane('w4:p1', 'w4:t1', 'idle', { name: '  ', title: 'Refactor scope' })),
		).toBe('Refactor scope');
		expect(agentDisplayName(pane('w4:p1', 'w4:t1', 'idle', { title: '' }))).toBe('w4:p1');
	});
});

describe('countStatuses', () => {
	it('counts blocked and done only', () => {
		expect(
			countStatuses([
				pane('p1', 't1', 'blocked'),
				pane('p2', 't1', 'done'),
				pane('p3', 't1', 'working'),
				pane('p4', 't1', 'idle'),
				pane('p5', 't1', 'done'),
			]),
		).toEqual({ blocked: 1, done: 2 });
	});

	it('counts an empty list as zero', () => {
		expect(countStatuses([])).toEqual({ blocked: 0, done: 0 });
	});
});

describe('groupByTab', () => {
	it('groups panes by tab and labels them from the tab list', () => {
		const groups = groupByTab(
			[pane('p1', 'w4:t1', 'idle'), pane('p2', 'w4:t2', 'idle'), pane('p3', 'w4:t1', 'idle')],
			new Map([
				['w4:t1', 'notes'],
				['w4:t2', 'code'],
			]),
		);
		expect(groups.map((group) => group.label)).toEqual(['code', 'notes']);
		expect(groups.find((group) => group.tabId === 'w4:t1')?.panes.map((p) => p.paneId)).toEqual([
			'p1',
			'p3',
		]);
	});

	it('falls back to the tab id when no label is known', () => {
		const groups = groupByTab([pane('p1', 'w4:t1', 'idle')], new Map());
		expect(groups[0]?.label).toBe('w4:t1');
	});

	it('floats blocked before done before the rest, inside and across tabs', () => {
		const groups = groupByTab(
			[
				pane('p1', 'w4:t1', 'idle'),
				pane('p2', 'w4:t2', 'done'),
				pane('p3', 'w4:t2', 'blocked'),
				pane('p4', 'w4:t1', 'working'),
			],
			new Map([
				['w4:t1', 'zeta'],
				['w4:t2', 'alpha'],
			]),
		);
		expect(groups.map((group) => group.tabId)).toEqual(['w4:t2', 'w4:t1']);
		expect(groups[0]?.panes.map((p) => p.paneId)).toEqual(['p3', 'p2']);
		expect(groups[1]?.panes.map((p) => p.paneId)).toEqual(['p4', 'p1']);
	});

	it('returns nothing for no panes', () => {
		expect(groupByTab([], new Map())).toEqual([]);
	});
});
