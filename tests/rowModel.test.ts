import { describe, expect, it } from 'vitest';
import {
	agentDisplayName,
	buildRows,
	countStatuses,
	relativeCwd,
	toRow,
	type RowModel,
} from '../src/views/rowModel';
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

/** Every row of every group, in the order the sidebar would draw them. */
function flatten(groups: readonly { rows: RowModel[] }[]): RowModel[] {
	return groups.flatMap((group) => group.rows);
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

describe('toRow', () => {
	it('carries everything a row displays', () => {
		const row = toRow(
			pane('w4:p1', 'w4:t1', 'blocked', {
				name: 'vault-maintenance',
				title: 'Refactor scope',
				cwd: `${VAULT}/projects/herdr`,
				focused: true,
			}),
			VAULT,
		);
		expect(row).toEqual({
			paneId: 'w4:p1',
			kind: 'claude',
			displayName: 'vault-maintenance',
			title: 'Refactor scope',
			pathLabel: 'projects/herdr',
			status: 'blocked',
			statusLabel: 'Blocked',
			focused: true,
			badges: [],
		});
	});

	it('keeps the kind separate from the name', () => {
		const row = toRow(pane('w4:p1', 'w4:t1', 'idle', { agent: 'codex', name: 'scribe' }), VAULT);
		expect(row.kind).toBe('codex');
		expect(row.displayName).toBe('scribe');
	});

	it('suppresses a title that only repeats the display name', () => {
		// No herdr name, so the title *is* the display name: showing it twice on
		// one line is what the view used to guard against inline.
		expect(toRow(pane('w4:p1', 'w4:t1', 'idle', { title: 'Refactor scope' }), VAULT).title).toBe(
			'',
		);
		// A herdr name of its own: the title is extra information, so it stays.
		expect(
			toRow(pane('w4:p1', 'w4:t1', 'idle', { name: 'scribe', title: 'Refactor scope' }), VAULT)
				.title,
		).toBe('Refactor scope');
	});

	it('labels an unknown status with its own name', () => {
		const row = toRow(pane('w4:p1', 'w4:t1', 'unknown'), VAULT);
		expect(row.statusLabel).toBe('Unknown');
	});

	it('leaves the vault root out of the path label', () => {
		expect(toRow(pane('w4:p1', 'w4:t1', 'idle'), VAULT).pathLabel).toBe('');
		expect(toRow(pane('w4:p1', 'w4:t1', 'idle', { cwd: '/etc' }), VAULT).pathLabel).toBe('/etc');
	});
});

describe('buildRows', () => {
	it('groups rows by tab and labels them from the tab list', () => {
		const groups = buildRows(
			[pane('p1', 'w4:t1', 'idle'), pane('p2', 'w4:t2', 'idle'), pane('p3', 'w4:t1', 'idle')],
			new Map([
				['w4:t1', 'notes'],
				['w4:t2', 'code'],
			]),
			VAULT,
		);
		expect(groups.map((group) => group.label)).toEqual(['code', 'notes']);
		expect(groups.map((group) => group.key)).toEqual(['w4:t2', 'w4:t1']);
		expect(groups.find((group) => group.key === 'w4:t1')?.rows.map((row) => row.paneId)).toEqual([
			'p1',
			'p3',
		]);
	});

	it('falls back to the tab id when no label is known', () => {
		const groups = buildRows([pane('p1', 'w4:t1', 'idle')], new Map(), VAULT);
		expect(groups[0]?.label).toBe('w4:t1');
	});

	it('floats blocked before done before the rest, inside and across tabs', () => {
		const groups = buildRows(
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
			VAULT,
		);
		expect(groups.map((group) => group.key)).toEqual(['w4:t2', 'w4:t1']);
		expect(groups[0]?.rows.map((row) => row.paneId)).toEqual(['p3', 'p2']);
		expect(groups[1]?.rows.map((row) => row.paneId)).toEqual(['p4', 'p1']);
		expect(flatten(groups).map((row) => row.status)).toEqual([
			'blocked',
			'done',
			'working',
			'idle',
		]);
	});

	it('breaks a tie on title, then on pane id', () => {
		const groups = buildRows(
			[
				pane('p2', 'w4:t1', 'idle', { title: 'same' }),
				pane('p1', 'w4:t1', 'idle', { title: 'same' }),
				pane('p3', 'w4:t1', 'idle', { title: 'alpha' }),
			],
			new Map(),
			VAULT,
		);
		expect(groups[0]?.rows.map((row) => row.paneId)).toEqual(['p3', 'p1', 'p2']);
	});

	it('orders two equally urgent tabs by label', () => {
		const groups = buildRows(
			[pane('p1', 'w4:t1', 'idle'), pane('p2', 'w4:t2', 'idle')],
			new Map([
				['w4:t1', 'zeta'],
				['w4:t2', 'alpha'],
			]),
			VAULT,
		);
		expect(groups.map((group) => group.label)).toEqual(['alpha', 'zeta']);
	});

	it('builds display names, titles and path labels per row', () => {
		const groups = buildRows(
			[
				pane('p1', 'w4:t1', 'idle', {
					name: 'scribe',
					title: 'Refactor scope',
					cwd: `${VAULT}/notes`,
				}),
				pane('p2', 'w4:t1', 'idle', { name: '', title: 'Plain title', cwd: '/opt/thing' }),
			],
			new Map([['w4:t1', 'notes']]),
			VAULT,
		);
		const rows = groups[0]?.rows ?? [];
		expect(rows.map((row) => row.displayName)).toEqual(['Plain title', 'scribe']);
		// The unnamed agent's title equals its display name, so it is suppressed.
		expect(rows.map((row) => row.title)).toEqual(['', 'Refactor scope']);
		expect(rows.map((row) => row.pathLabel)).toEqual(['/opt/thing', 'notes']);
		expect(rows.every((row) => row.badges.length === 0)).toBe(true);
	});

	it('accepts explicit options without changing the default behaviour', () => {
		const panes = [pane('p1', 'w4:t1', 'done'), pane('p2', 'w4:t2', 'blocked')];
		expect(buildRows(panes, new Map(), VAULT, { groupBy: 'tab', sort: 'status' })).toEqual(
			buildRows(panes, new Map(), VAULT),
		);
	});

	it('returns nothing for no panes', () => {
		expect(buildRows([], new Map(), VAULT)).toEqual([]);
	});

	it('does not mutate the pane list it is given', () => {
		const panes = [pane('p1', 'w4:t1', 'idle'), pane('p2', 'w4:t1', 'blocked')];
		buildRows(panes, new Map(), VAULT);
		expect(panes.map((entry) => entry.paneId)).toEqual(['p1', 'p2']);
	});
});
