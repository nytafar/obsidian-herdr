import { describe, expect, it } from 'vitest';
import {
	agentDisplayName,
	buildRows,
	countStatuses,
	fullPathLabel,
	pathLabel,
	pathTooltip,
	relativeCwd,
	toRow,
	type RowModel,
} from '../src/views/rowModel';
// The badge sits under `herdr/` so the scope can ask it whether a token change
// is worth an event (PRD N4); a row is still its only reader.
import { cacheBadge, sameCacheBadge } from '../src/herdr/cacheBadge';
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
		tokens: {},
		statusChangedSeq: 0,
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

describe('fullPathLabel (issue #22)', () => {
	const HOME = '/Users/lasse';

	it('keeps a path inside the vault vault-relative', () => {
		expect(fullPathLabel(`${VAULT}/projects/herdr`, VAULT, HOME)).toBe('projects/herdr');
		expect(fullPathLabel(VAULT, VAULT, HOME)).toBe('');
	});

	it('shortens a path under the home but outside the vault', () => {
		expect(fullPathLabel('/Users/lasse/code/herdr', VAULT, HOME)).toBe('~/code/herdr');
		expect(fullPathLabel(HOME, VAULT, HOME)).toBe('~');
	});

	it('tolerates trailing slashes on both roots', () => {
		expect(fullPathLabel('/Users/lasse/code/herdr', `${VAULT}/`, `${HOME}/`)).toBe(
			'~/code/herdr',
		);
		expect(fullPathLabel(`${VAULT}/notes`, `${VAULT}//`, HOME)).toBe('notes');
	});

	it('leaves a path outside both absolute', () => {
		expect(fullPathLabel('/opt/thing', VAULT, HOME)).toBe('/opt/thing');
		// A home that is a string prefix but not a parent directory.
		expect(fullPathLabel('/Users/lasseX/code', VAULT, HOME)).toBe('/Users/lasseX/code');
	});

	it('falls back to the absolute path without a home', () => {
		expect(fullPathLabel('/Users/lasse/code/herdr', VAULT)).toBe('/Users/lasse/code/herdr');
		expect(fullPathLabel('/Users/lasse/code/herdr', VAULT, '   ')).toBe(
			'/Users/lasse/code/herdr',
		);
		expect(fullPathLabel('', VAULT, HOME)).toBe('');
	});

	it('prefers the vault when the vault sits inside the home', () => {
		expect(fullPathLabel(`${VAULT}/notes`, VAULT, HOME)).toBe('notes');
	});
});

describe('pathLabel and pathTooltip (issue #46)', () => {
	const HOME = '/Users/lasse';

	it('leaves a path inside the vault untouched and untooltipped', () => {
		expect(pathLabel(`${VAULT}/projects/herdr/src`, VAULT, HOME)).toBe('projects/herdr/src');
		expect(pathTooltip(`${VAULT}/projects/herdr/src`, VAULT, HOME)).toBe('');
	});

	it('keeps the vault root empty', () => {
		expect(pathLabel(VAULT, VAULT, HOME)).toBe('');
		expect(pathTooltip(VAULT, VAULT, HOME)).toBe('');
		expect(pathLabel('', VAULT, HOME)).toBe('');
		expect(pathTooltip('', VAULT, HOME)).toBe('');
	});

	it('cuts a home-relative path outside the vault to its last two segments', () => {
		// The case from the issue: every snapshot-vault row said the same `~/Vaults/…` root.
		expect(pathLabel('/Users/lasse/Vaults/live', VAULT, HOME)).toBe('Vaults/live');
		expect(pathTooltip('/Users/lasse/Vaults/live', VAULT, HOME)).toBe('~/Vaults/live');
	});

	it('cuts an absolute path outside both roots the same way', () => {
		expect(pathLabel('/srv/work/projects/herdr', VAULT, HOME)).toBe('projects/herdr');
		expect(pathTooltip('/srv/work/projects/herdr', VAULT, HOME)).toBe(
			'/srv/work/projects/herdr',
		);
	});

	it('leaves a label already at two segments or fewer whole', () => {
		expect(pathLabel('/opt/thing', VAULT, HOME)).toBe('/opt/thing');
		expect(pathTooltip('/opt/thing', VAULT, HOME)).toBe('');
		expect(pathLabel('/Users/lasse/code', VAULT, HOME)).toBe('~/code');
		expect(pathTooltip('/Users/lasse/code', VAULT, HOME)).toBe('');
		expect(pathLabel(HOME, VAULT, HOME)).toBe('~');
		expect(pathTooltip(HOME, VAULT, HOME)).toBe('');
	});

	it('abridges a folder group header and hands the view the full path', () => {
		const groups = buildRows(
			[pane('p1', 'w4:t1', 'idle', { cwd: '/Users/lasse/Vaults/live' })],
			new Map(),
			VAULT,
			{ groupBy: 'folder', homePath: HOME },
		);
		expect(groups[0]?.label).toBe('Vaults/live');
		expect(groups[0]?.tooltip).toBe('~/Vaults/live');
		// Grouping by folder still leaves the row's own path line empty (#39).
		expect(groups[0]?.rows[0]?.pathLabel).toBe('');
		expect(groups[0]?.rows[0]?.pathTooltip).toBe('');
	});

	it('gives a tab group no tooltip at all', () => {
		const groups = buildRows(
			[pane('p1', 'w4:t1', 'idle', { cwd: '/Users/lasse/Vaults/live' })],
			new Map([['w4:t1', 'notes']]),
			VAULT,
			{ homePath: HOME },
		);
		expect(groups[0]?.tooltip).toBe('');
		expect(groups[0]?.rows[0]?.pathTooltip).toBe('~/Vaults/live');
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

describe('cacheBadge (issue #23)', () => {
	it('reads the tone off the key that carries the label', () => {
		// Live shapes from `pane.list`, one counting pane per tone.
		expect(cacheBadge({ cache_ok: '31m', cache_sort: '001868' })).toEqual({
			text: '31m',
			tone: 'ok',
		});
		expect(cacheBadge({ cache_warn: '4m', cache_sort: '000240' })).toEqual({
			text: '4m',
			tone: 'warn',
		});
		expect(cacheBadge({ cache_crit: '1m', cache_sort: '000060' })).toEqual({
			text: '1m',
			tone: 'crit',
		});
	});

	it('says nothing for an expired cache', () => {
		expect(cacheBadge({ cache_crit: '0m', cache_sort: '000000' })).toBeNull();
		expect(cacheBadge({ cache_crit: '0s' })).toBeNull();
		expect(cacheBadge({ cache_ok: ' ' })).toBeNull();
	});

	it('says nothing for a pane the plugin does not track', () => {
		expect(cacheBadge({})).toBeNull();
		// `cache_sort` is for ordering, never for display.
		expect(cacheBadge({ cache_sort: '001868' })).toBeNull();
		expect(cacheBadge({ something_else: '5m' })).toBeNull();
	});
});

describe('sameCacheBadge (PRD N4)', () => {
	it('ignores the keys a row never shows', () => {
		// `cache_sort` counts seconds, so this is what one second of it looks like.
		expect(
			sameCacheBadge(
				{ cache_ok: '31m', cache_sort: '003587' },
				{ cache_ok: '31m', cache_sort: '003586' },
			),
		).toBe(true);
		expect(sameCacheBadge({ cache_ok: '31m' }, { cache_ok: '31m', other: 'x' })).toBe(true);
	});

	it('sees the badge appear, tick, change tone and go', () => {
		expect(sameCacheBadge({}, { cache_ok: '31m' })).toBe(false);
		expect(sameCacheBadge({ cache_ok: '31m' }, { cache_ok: '30m' })).toBe(false);
		expect(sameCacheBadge({ cache_warn: '4m' }, { cache_crit: '4m' })).toBe(false);
		// An expired cache shows nothing, which is the same as no cache at all.
		expect(sameCacheBadge({ cache_crit: '1m' }, { cache_crit: '0m' })).toBe(false);
		expect(sameCacheBadge({ cache_crit: '0m' }, {})).toBe(true);
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
			pathTooltip: '',
			status: 'blocked',
			statusLabel: 'Blocked',
			focused: true,
			pinned: false,
			badges: [],
		});
	});

	it('carries the cache countdown as a badge (issue #23)', () => {
		const row = toRow(
			pane('w4:p1', 'w4:t1', 'working', { tokens: { cache_ok: '31m', cache_sort: '001868' } }),
			VAULT,
		);
		expect(row.badges).toEqual([{ text: '31m', tone: 'ok' }]);
		expect(
			toRow(pane('w4:p1', 'w4:t1', 'idle', { tokens: { cache_crit: '0m' } }), VAULT).badges,
		).toEqual([]);
		expect(toRow(pane('w4:p1', 'w4:t1', 'idle'), VAULT).badges).toEqual([]);
	});

	it('leaves the path empty when the caller says the header carries it (issue #39)', () => {
		const state = pane('w4:p1', 'w4:t1', 'idle', { cwd: `${VAULT}/projects/herdr` });
		expect(toRow(state, VAULT, '', false).pathLabel).toBe('');
		// Everything else about the row is untouched.
		expect(toRow(state, VAULT, '', false).displayName).toBe('w4:p1');
		expect(toRow(state, VAULT, '', true).pathLabel).toBe('projects/herdr');
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

	it('shortens paths under the home when one is given (issue #22)', () => {
		const groups = buildRows(
			[
				pane('p1', 'w4:t1', 'idle', { cwd: '/Users/lasse/code/herdr', title: 'a' }),
				pane('p2', 'w4:t1', 'idle', { cwd: `${VAULT}/notes`, title: 'b' }),
				pane('p3', 'w4:t1', 'idle', { cwd: '/opt/thing', title: 'c' }),
			],
			new Map(),
			VAULT,
			{ homePath: '/Users/lasse' },
		);
		expect(groups[0]?.rows.map((row) => row.pathLabel)).toEqual([
			'code/herdr',
			'notes',
			'/opt/thing',
		]);
	});

	it('accepts explicit options without changing the default behaviour', () => {
		const panes = [pane('p1', 'w4:t1', 'done'), pane('p2', 'w4:t2', 'blocked')];
		expect(buildRows(panes, new Map(), VAULT, { groupBy: 'tab', sort: 'priority' })).toEqual(
			buildRows(panes, new Map(), VAULT),
		);
	});

	it('matches herdr’s priority order, unknown last (issue #20)', () => {
		// herdr scores blocked 4, unseen-idle (`done`) 3, working 2, seen-idle 1,
		// unknown 0, highest first: `tab_attention_priority` in its own source.
		const groups = buildRows(
			[
				pane('p1', 'w4:t1', 'unknown'),
				pane('p2', 'w4:t1', 'idle'),
				pane('p3', 'w4:t1', 'working'),
				pane('p4', 'w4:t1', 'done'),
				pane('p5', 'w4:t1', 'blocked'),
			],
			new Map(),
			VAULT,
			{ sort: 'priority' },
		);
		expect(groups[0]?.rows.map((row) => row.status)).toEqual([
			'blocked',
			'done',
			'working',
			'idle',
			'unknown',
		]);
	});

	it('breaks a priority tie on the most recent status change (issue #20)', () => {
		const groups = buildRows(
			[
				pane('p1', 'w4:t1', 'blocked', { title: 'a', statusChangedSeq: 4 }),
				pane('p2', 'w4:t1', 'blocked', { title: 'b', statusChangedSeq: 9 }),
				pane('p3', 'w4:t1', 'blocked', { title: 'c', statusChangedSeq: 7 }),
				// Never stamped, so it sorts behind everything that has moved.
				pane('p4', 'w4:t1', 'blocked', { title: 'a' }),
			],
			new Map(),
			VAULT,
			{ sort: 'priority' },
		);
		expect(groups[0]?.rows.map((row) => row.paneId)).toEqual(['p2', 'p3', 'p1', 'p4']);
	});

	it('sorts alphabetically by display name, not by status (issue #20)', () => {
		const groups = buildRows(
			[
				pane('p1', 'w4:t1', 'blocked', { name: 'zeta' }),
				pane('p2', 'w4:t1', 'idle', { name: 'Åse' }),
				pane('p3', 'w4:t1', 'idle', { name: 'alpha' }),
				// No herdr name: the display name is the title.
				pane('p4', 'w4:t1', 'working', { title: 'beta' }),
			],
			new Map(),
			VAULT,
			{ sort: 'alphabetical' },
		);
		// A locale compare, so "Åse" files under A rather than after Z.
		expect(groups[0]?.rows.map((row) => row.displayName)).toEqual([
			'alpha',
			'Åse',
			'beta',
			'zeta',
		]);
	});

	it('still orders groups by their most urgent row when sorting by name', () => {
		const groups = buildRows(
			[
				pane('p1', 'w4:t1', 'idle', { name: 'alpha' }),
				pane('p2', 'w4:t2', 'idle', { name: 'beta' }),
				// The blocked row is last alphabetically, but its tab still leads.
				pane('p3', 'w4:t2', 'blocked', { name: 'zeta' }),
			],
			new Map([
				['w4:t1', 'notes'],
				['w4:t2', 'code'],
			]),
			VAULT,
			{ sort: 'alphabetical' },
		);
		expect(groups.map((group) => group.label)).toEqual(['code', 'notes']);
		expect(groups[0]?.rows.map((row) => row.displayName)).toEqual(['beta', 'zeta']);
	});

	it('groups by folder, labelled like the path a row shows (issue #20)', () => {
		const groups = buildRows(
			[
				// The same folder split over two herdr tabs stays one group.
				pane('p1', 'w4:t1', 'idle', { cwd: `${VAULT}/projects/herdr`, title: 'a' }),
				pane('p2', 'w4:t2', 'blocked', { cwd: `${VAULT}/projects/herdr`, title: 'b' }),
				pane('p3', 'w4:t1', 'idle', { cwd: '/Users/lasse/code/herdr' }),
				pane('p4', 'w4:t1', 'idle', { cwd: VAULT }),
			],
			new Map([['w4:t1', 'notes']]),
			VAULT,
			{ groupBy: 'folder', homePath: '/Users/lasse' },
		);
		// The blocked folder leads; the two idle ones tie and fall back to their
		// labels, both of them abridged to two segments (issue #46).
		expect(groups.map((group) => group.label)).toEqual([
			'projects/herdr',
			'code/herdr',
			'hvelv',
		]);
		expect(groups[0]?.rows.map((row) => row.paneId)).toEqual(['p2', 'p1']);
		expect(groups.map((group) => group.key)).toEqual([
			`${VAULT}/projects/herdr`,
			'/Users/lasse/code/herdr',
			VAULT,
		]);
	});

	it('drops the row path line when the group header is the folder (issue #39)', () => {
		const panes = [
			pane('p1', 'w4:t1', 'idle', { cwd: `${VAULT}/projects/herdr` }),
			pane('p2', 'w4:t1', 'idle', { cwd: '/Users/lasse/code/herdr' }),
		];
		const options = { homePath: '/Users/lasse' };
		const grouped = buildRows(panes, new Map(), VAULT, { ...options, groupBy: 'folder' });
		expect(flatten(grouped).map((row) => row.pathLabel)).toEqual(['', '']);
		// The headers still carry the folders, so nothing is lost. Both groups are
		// idle, so they tie and fall back to a locale compare of their labels.
		expect(grouped.map((group) => group.label)).toEqual(['code/herdr', 'projects/herdr']);

		// Every other grouping keeps the line: nothing else names the folder.
		for (const groupBy of ['tab', 'none'] as const) {
			const rows = flatten(buildRows(panes, new Map(), VAULT, { ...options, groupBy }));
			expect(rows.map((row) => row.pathLabel).sort()).toEqual([
				'code/herdr',
				'projects/herdr',
			]);
		}
	});

	it('names a folder group without a cwd rather than leaving it blank', () => {
		const groups = buildRows([pane('p1', 'w4:t1', 'idle', { cwd: '' })], new Map(), VAULT, {
			groupBy: 'folder',
		});
		expect(groups.map((group) => group.label)).toEqual(['No folder']);
	});

	it('puts everything in one unlabelled group when grouping is off (issue #20)', () => {
		const groups = buildRows(
			[
				pane('p1', 'w4:t1', 'idle'),
				pane('p2', 'w4:t2', 'blocked'),
				pane('p3', 'w4:t3', 'done'),
			],
			new Map([['w4:t1', 'notes']]),
			VAULT,
			{ groupBy: 'none' },
		);
		expect(groups).toHaveLength(1);
		// The view draws no header for an empty label.
		expect(groups[0]?.label).toBe('');
		expect(groups[0]?.rows.map((row) => row.paneId)).toEqual(['p2', 'p3', 'p1']);
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

describe('pinned rows (issue #35)', () => {
	const panes = [
		pane('p1', 'w4:t1', 'idle', { name: 'zed' }),
		pane('p2', 'w4:t1', 'blocked', { name: 'bob' }),
		pane('p3', 'w4:t1', 'done', { name: 'amy' }),
		pane('p4', 'w4:t2', 'blocked', { name: 'cal' }),
	];

	it('puts a pinned row first in its group, ahead of the priority order', () => {
		const rows = flatten(
			buildRows(panes, new Map(), VAULT, { pinnedPaneIds: ['p1'] }),
		);
		// t1 is still the more urgent group (it holds a blocked row), and inside
		// it the idle pinned row now leads.
		expect(rows.map((row) => row.paneId)).toEqual(['p1', 'p2', 'p3', 'p4']);
		expect(rows.map((row) => row.pinned)).toEqual([true, false, false, false]);
	});

	it('is group-local: a pin never lifts a row into another group', () => {
		const groups = buildRows(panes, new Map(), VAULT, { pinnedPaneIds: ['p4'] });
		expect(groups.map((group) => group.rows.map((row) => row.paneId))).toEqual([
			['p2', 'p3', 'p1'],
			['p4'],
		]);
	});

	it('keeps the chosen sort among the pinned rows themselves', () => {
		const alphabetical = flatten(
			buildRows(panes, new Map(), VAULT, {
				sort: 'alphabetical',
				pinnedPaneIds: ['p1', 'p2'],
			}),
		);
		expect(alphabetical.map((row) => row.paneId)).toEqual(['p2', 'p1', 'p3', 'p4']);
		const priority = flatten(
			buildRows(panes, new Map(), VAULT, { pinnedPaneIds: ['p1', 'p3'] }),
		);
		expect(priority.map((row) => row.paneId)).toEqual(['p3', 'p1', 'p2', 'p4']);
	});

	it('ignores pins for panes that are not listed and pins nothing by default', () => {
		const rows = flatten(buildRows(panes, new Map(), VAULT, { pinnedPaneIds: ['gone'] }));
		expect(rows.map((row) => row.paneId)).toEqual(['p2', 'p3', 'p1', 'p4']);
		expect(rows.every((row) => !row.pinned)).toBe(true);
		expect(toRow(panes[0]!, VAULT).pinned).toBe(false);
	});
});
