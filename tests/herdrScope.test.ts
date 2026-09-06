import { describe, expect, it } from 'vitest';
import type { HerdrEvent } from '../src/herdr/client';
import {
	WorkspaceScope,
	isUnder,
	relevantDiff,
	resolveWorkspace,
	stripTitleSpinner,
	toPaneState,
	type PaneState,
} from '../src/herdr/scope';
import type { PaneInfo, WorkspaceInfo } from '../src/herdr/types.gen';

const VAULT = '/Users/lasse/Vaults/hvelv';

function workspace(id: string, label: string): WorkspaceInfo {
	return {
		workspace_id: id,
		number: Number(id.replace(/\D/g, '')) || 1,
		label,
		focused: false,
		pane_count: 1,
		tab_count: 1,
		active_tab_id: `${id}:t1`,
		agent_status: 'idle',
	};
}

function pane(overrides: Partial<PaneInfo> & { pane_id: string }): PaneInfo {
	const id = overrides.pane_id;
	const workspaceId = overrides.workspace_id ?? id.split(':')[0] ?? 'w4';
	return {
		terminal_id: `term_${id}`,
		workspace_id: workspaceId,
		tab_id: `${workspaceId}:t1`,
		focused: false,
		agent_status: 'idle',
		revision: 1,
		agent: 'claude',
		cwd: VAULT,
		...overrides,
		pane_id: id,
	};
}

function event(name: string, data: Record<string, unknown>): HerdrEvent {
	return { event: name, data: { type: name, ...data } };
}

interface Recorded {
	added: PaneState[];
	removed: PaneState[];
	changed: { paneId: string; prev: PaneState; next: PaneState }[];
	resolved: { workspaceId: string | null; method: string }[];
}

function record(scope: WorkspaceScope): Recorded {
	const rec: Recorded = { added: [], removed: [], changed: [], resolved: [] };
	scope.on('added', (state) => rec.added.push(state));
	scope.on('removed', (state) => rec.removed.push(state));
	scope.on('changed', (paneId, prev, next) => rec.changed.push({ paneId, prev, next }));
	scope.on('workspaceResolved', (workspaceId, method) => rec.resolved.push({ workspaceId, method }));
	return rec;
}

describe('isUnder', () => {
	it('matches the root and paths below it, not a sibling with the same prefix', () => {
		expect(isUnder(VAULT, VAULT)).toBe(true);
		expect(isUnder(`${VAULT}/notes`, `${VAULT}/`)).toBe(true);
		expect(isUnder(`${VAULT}-old/notes`, VAULT)).toBe(false);
		expect(isUnder('', VAULT)).toBe(false);
	});
});

describe('toPaneState (M7)', () => {
	it('drops panes without an agent and prefers the stripped title', () => {
		expect(toPaneState(pane({ pane_id: 'w4:p1', agent: null }))).toBeNull();
		const state = toPaneState(
			pane({
				pane_id: 'w4:p1',
				terminal_title: '✳ Document skills',
				terminal_title_stripped: 'Document skills',
			}),
		);
		expect(state).toMatchObject({ paneId: 'w4:p1', agent: 'claude', title: 'Document skills' });
	});

	it('keeps the token map, dropping non-string values (issue #23)', () => {
		expect(
			toPaneState(
				pane({ pane_id: 'w4:p1', tokens: { cache_ok: '31m', cache_sort: '001868' } }),
			)?.tokens,
		).toEqual({ cache_ok: '31m', cache_sort: '001868' });
		// No `tokens` at all is what a non-Claude pane looks like.
		expect(toPaneState(pane({ pane_id: 'w4:p1' }))?.tokens).toEqual({});
		expect(
			toPaneState(
				pane({ pane_id: 'w4:p1', tokens: { cache_ok: null } as unknown as undefined }),
			)?.tokens,
		).toEqual({});
	});

	it('falls back to foreground_cwd when cwd is absent', () => {
		expect(
			toPaneState(pane({ pane_id: 'w4:p1', cwd: null, foreground_cwd: '/tmp/x' }))?.cwd,
		).toBe('/tmp/x');
	});
});

describe('stripTitleSpinner (N4)', () => {
	it('drops the leading spinner glyph herdr leaves in terminal_title_stripped', () => {
		// Captured live: these two alternate about four times a second.
		expect(stripTitleSpinner('◐ Obsidian-herdr repository')).toBe('Obsidian-herdr repository');
		expect(stripTitleSpinner('◑ Obsidian-herdr repository')).toBe('Obsidian-herdr repository');
		expect(stripTitleSpinner('✳ Document dormant skills')).toBe('Document dormant skills');
	});

	it('leaves an ordinary title alone and never empties a symbol-only title', () => {
		expect(stripTitleSpinner('Spesialkaffe rapport')).toBe('Spesialkaffe rapport');
		expect(stripTitleSpinner('…')).toBe('…');
		expect(stripTitleSpinner('')).toBe('');
	});
});

describe('resolveWorkspace (M6)', () => {
	const workspaces = [workspace('w1', 'other'), workspace('w4', 'hvelv')];
	const panes = [pane({ pane_id: 'w1:p1', cwd: '/tmp' }), pane({ pane_id: 'w4:p1' })];

	it('uses the settings id first, without needing it in the list', () => {
		expect(resolveWorkspace(workspaces, panes, { workspaceId: 'wZ', vaultPath: VAULT })).toEqual({
			workspaceId: 'wZ',
			method: 'setting',
		});
	});

	it('then the label equal to the vault folder name', () => {
		expect(resolveWorkspace(workspaces, panes, { vaultPath: VAULT })).toEqual({
			workspaceId: 'w4',
			method: 'label',
		});
	});

	it('matches a label case-insensitively as a fallback', () => {
		expect(
			resolveWorkspace([workspace('w7', 'Hvelv')], panes, { vaultPath: VAULT }),
		).toEqual({ workspaceId: 'w7', method: 'label' });
	});

	it('then the workspace with the most panes under the vault path', () => {
		const byCwd = [
			pane({ pane_id: 'w1:p1', cwd: '/tmp' }),
			pane({ pane_id: 'w5:p1', workspace_id: 'w5', cwd: `${VAULT}/notes` }),
			pane({ pane_id: 'w5:p2', workspace_id: 'w5', cwd: VAULT }),
			pane({ pane_id: 'w6:p1', workspace_id: 'w6', cwd: `${VAULT}/x` }),
		];
		expect(
			resolveWorkspace([workspace('w1', 'other')], byCwd, { vaultPath: VAULT }),
		).toEqual({ workspaceId: 'w5', method: 'cwd' });
	});

	it('uses the remote vault path for the cwd rule when a remote profile is on', () => {
		const remotePanes = [pane({ pane_id: 'w9:p1', workspace_id: 'w9', cwd: '/home/lasse/hvelv/n' })];
		expect(
			resolveWorkspace([], remotePanes, {
				vaultPath: VAULT,
				vaultName: 'not-a-label',
				remoteVaultPath: '/home/lasse/hvelv',
			}),
		).toEqual({ workspaceId: 'w9', method: 'cwd' });
	});

	it('resolves to nothing when no rule matches', () => {
		expect(
			resolveWorkspace([workspace('w1', 'other')], [pane({ pane_id: 'w1:p1', cwd: '/tmp' })], {
				vaultPath: VAULT,
			}),
		).toEqual({ workspaceId: null, method: 'none' });
	});
});

describe('WorkspaceScope.prime', () => {
	it('keeps only agent panes of the scoped workspace (M6, M7)', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		const rec = record(scope);
		scope.prime(
			[workspace('w4', 'hvelv'), workspace('w1', 'other')],
			[
				pane({ pane_id: 'w4:p1' }),
				pane({ pane_id: 'w4:p2', agent: null }),
				pane({ pane_id: 'w1:p1', workspace_id: 'w1' }),
			],
		);
		expect(scope.workspaceId).toBe('w4');
		expect(scope.method).toBe('label');
		expect(scope.workspaceLabel).toBe('hvelv');
		expect(scope.list().map((state) => state.paneId)).toEqual(['w4:p1']);
		expect(rec.added.map((state) => state.paneId)).toEqual(['w4:p1']);
		expect(rec.resolved).toEqual([{ workspaceId: 'w4', method: 'label' }]);
	});

	it('re-priming after a reconnect only reports real differences', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		const workspaces = [workspace('w4', 'hvelv')];
		scope.prime(workspaces, [pane({ pane_id: 'w4:p1' }), pane({ pane_id: 'w4:p2' })]);
		const rec = record(scope);
		scope.prime(workspaces, [
			pane({ pane_id: 'w4:p1', revision: 99 }),
			pane({ pane_id: 'w4:p3' }),
		]);
		expect(rec.added.map((state) => state.paneId)).toEqual(['w4:p3']);
		expect(rec.removed.map((state) => state.paneId)).toEqual(['w4:p2']);
		expect(rec.changed).toHaveLength(0);
		expect(rec.resolved).toHaveLength(0);
	});

	it('re-resolves when settings change', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime([workspace('w4', 'hvelv')], [pane({ pane_id: 'w4:p1' })]);
		const rec = record(scope);
		scope.configure({ workspaceId: 'w9' });
		expect(scope.workspaceId).toBe('w9');
		expect(rec.resolved).toEqual([{ workspaceId: 'w9', method: 'setting' }]);
		expect(rec.removed.map((state) => state.paneId)).toEqual(['w4:p1']);
	});
});

describe('WorkspaceScope.prime statusChangedSeq (issue #20)', () => {
	it('starts every primed pane at zero and stamps a status that moved meanwhile', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime(
			[workspace('w4', 'hvelv')],
			[pane({ pane_id: 'w4:p1' }), pane({ pane_id: 'w4:p2' })],
		);
		expect(scope.list().map((state) => state.statusChangedSeq)).toEqual([0, 0]);

		// A reconnect re-primes: the pane whose status moved while we were away
		// sorts ahead of the one that did not.
		scope.prime(
			[workspace('w4', 'hvelv')],
			[pane({ pane_id: 'w4:p1' }), pane({ pane_id: 'w4:p2', agent_status: 'blocked' })],
		);
		expect(scope.get('w4:p1')?.statusChangedSeq).toBe(0);
		expect(scope.get('w4:p2')?.statusChangedSeq).toBeGreaterThan(0);
	});
});

describe('WorkspaceScope.setAgentNames (M8, M20)', () => {
	it('fills in names from agent.list and repaints only the rows that changed', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime(
			[workspace('w4', 'hvelv')],
			[pane({ pane_id: 'w4:p1' }), pane({ pane_id: 'w4:p2' })],
		);
		const rec = record(scope);
		scope.setAgentNames([
			{ pane_id: 'w4:p1', name: 'vault-maintenance' },
			// Another workspace's agent still counts for name uniqueness.
			{ pane_id: 'w9:p1', name: 'blekksprut' },
		] as never);
		expect(scope.get('w4:p1')?.name).toBe('vault-maintenance');
		expect(scope.get('w4:p2')?.name).toBe('');
		expect(rec.changed.map((entry) => entry.paneId)).toEqual(['w4:p1']);
		expect(scope.agentNames()).toEqual(new Set(['vault-maintenance', 'blekksprut']));

		// Idempotent: the same list again is not a repaint.
		const rec2 = record(scope);
		scope.setAgentNames([{ pane_id: 'w4:p1', name: 'vault-maintenance' }] as never);
		expect(rec2.changed).toHaveLength(0);
	});

	it('keeps names across a re-prime', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		const workspaces = [workspace('w4', 'hvelv')];
		scope.setAgentNames([{ pane_id: 'w4:p1', name: 'notes' }] as never);
		scope.prime(workspaces, [pane({ pane_id: 'w4:p1' })]);
		expect(scope.get('w4:p1')?.name).toBe('notes');
	});
});

describe('WorkspaceScope.ingest', () => {
	function primed(): { scope: WorkspaceScope; rec: Recorded } {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime([workspace('w4', 'hvelv')], [pane({ pane_id: 'w4:p1' })]);
		return { scope, rec: record(scope) };
	}

	it('ignores pane_updated that only moves revision or the title spinner (N4)', () => {
		const { scope, rec } = primed();
		// Establish the title once; after that only the spinner and revision move.
		scope.ingest(
			event('pane_updated', {
				pane: pane({ pane_id: 'w4:p1', terminal_title_stripped: '◐ Same work' }),
			}),
		);
		rec.changed.length = 0;
		for (let revision = 2; revision < 40; revision += 1) {
			scope.ingest(
				event('pane_updated', {
					pane: pane({
						pane_id: 'w4:p1',
						revision,
						terminal_title_stripped: `${revision % 2 === 0 ? '◐' : '◑'} Same work`,
					}),
				}),
			);
		}
		expect(rec.changed).toHaveLength(0);
		expect(scope.get('w4:p1')?.agentStatus).toBe('idle');
	});

	it('emits changed on an agent_status transition with prev and next', () => {
		const { scope, rec } = primed();
		scope.ingest(
			event('pane_updated', { pane: pane({ pane_id: 'w4:p1', agent_status: 'blocked' }) }),
		);
		expect(rec.changed).toHaveLength(1);
		expect(rec.changed[0]?.prev.agentStatus).toBe('idle');
		expect(rec.changed[0]?.next.agentStatus).toBe('blocked');
		expect(scope.get('w4:p1')?.agentStatus).toBe('blocked');
	});

	it('emits changed on title, label, tab and cwd changes', () => {
		const { scope, rec } = primed();
		scope.ingest(
			event('pane_updated', {
				pane: pane({ pane_id: 'w4:p1', terminal_title_stripped: 'Refactor scope' }),
			}),
		);
		scope.ingest(event('pane_updated', { pane: pane({ pane_id: 'w4:p1', label: '? hvelv' }) }));
		scope.ingest(event('pane_moved', { pane: pane({ pane_id: 'w4:p1', tab_id: 'w4:t2' }) }));
		scope.ingest(
			event('pane_updated', { pane: pane({ pane_id: 'w4:p1', cwd: `${VAULT}/notes` }) }),
		);
		expect(rec.changed.map((entry) => relevantDiff(entry.prev, entry.next))).toEqual([
			['title'],
			['title', 'label'],
			['label', 'tabId'],
			['tabId', 'cwd'],
		]);
	});

	it('stamps statusChangedSeq on every status change, newest highest (#20)', () => {
		const { scope } = primed();
		expect(scope.get('w4:p1')?.statusChangedSeq).toBe(0);

		scope.ingest(
			event('pane_updated', { pane: pane({ pane_id: 'w4:p1', agent_status: 'working' }) }),
		);
		const first = scope.get('w4:p1')?.statusChangedSeq ?? 0;
		expect(first).toBeGreaterThan(0);

		// A repaint-worthy change that is not the status leaves the stamp alone.
		scope.ingest(
			event('pane_updated', {
				pane: pane({
					pane_id: 'w4:p1',
					agent_status: 'working',
					terminal_title_stripped: 'Refactor scope',
				}),
			}),
		);
		expect(scope.get('w4:p1')?.statusChangedSeq).toBe(first);

		scope.ingest(
			event('pane_updated', { pane: pane({ pane_id: 'w4:p1', agent_status: 'blocked' }) }),
		);
		expect(scope.get('w4:p1')?.statusChangedSeq).toBeGreaterThan(first);
	});

	it('stamps a pane that appears later ahead of the primed ones (#20)', () => {
		const { scope } = primed();
		scope.ingest(event('pane_created', { pane: pane({ pane_id: 'w4:p2' }) }));
		expect(scope.get('w4:p2')?.statusChangedSeq).toBeGreaterThan(
			scope.get('w4:p1')?.statusChangedSeq ?? 0,
		);
	});

	it('emits changed when the cache tokens tick (issue #23)', () => {
		const { scope, rec } = primed();
		scope.ingest(
			event('pane_updated', {
				pane: pane({ pane_id: 'w4:p1', tokens: { cache_ok: '31m', cache_sort: '001868' } }),
			}),
		);
		scope.ingest(
			event('pane_updated', {
				pane: pane({ pane_id: 'w4:p1', tokens: { cache_ok: '30m', cache_sort: '001808' } }),
			}),
		);
		// The same map again is not a change, however often herdr repeats it.
		scope.ingest(
			event('pane_updated', {
				pane: pane({ pane_id: 'w4:p1', tokens: { cache_ok: '30m', cache_sort: '001808' } }),
			}),
		);
		expect(rec.changed.map((entry) => relevantDiff(entry.prev, entry.next))).toEqual([
			['tokens'],
			['tokens'],
		]);
		expect(scope.get('w4:p1')?.tokens).toEqual({ cache_ok: '30m', cache_sort: '001808' });
	});

	it('stays quiet while only cache_sort ticks, and keeps the newest map (N4)', () => {
		const { scope, rec } = primed();
		scope.ingest(
			event('pane_updated', {
				pane: pane({ pane_id: 'w4:p1', tokens: { cache_ok: '31m', cache_sort: '003587' } }),
			}),
		);
		expect(rec.changed).toHaveLength(1);

		// A second of herdr's own churn: the badge still says 31m, so no row moves.
		for (const sort of ['003586', '003585', '003584']) {
			scope.ingest(
				event('pane_updated', {
					pane: pane({ pane_id: 'w4:p1', tokens: { cache_ok: '31m', cache_sort: sort } }),
				}),
			);
		}
		expect(rec.changed).toHaveLength(1);
		// Silent, but not stale: the row model reads `tokens` off this state.
		expect(scope.get('w4:p1')?.tokens).toEqual({ cache_ok: '31m', cache_sort: '003584' });

		// Anything a row does show still gets through, cache tokens and all.
		scope.ingest(
			event('pane_updated', {
				pane: pane({
					pane_id: 'w4:p1',
					label: 'renamed',
					tokens: { cache_ok: '31m', cache_sort: '003583' },
				}),
			}),
		);
		expect(rec.changed).toHaveLength(2);
		expect(relevantDiff(rec.changed[1]!.prev, rec.changed[1]!.next)).toEqual(['label']);
	});

	it('adds a new agent pane and ignores a new shell pane (M7)', () => {
		const { scope, rec } = primed();
		scope.ingest(event('pane_created', { pane: pane({ pane_id: 'w4:p2' }) }));
		scope.ingest(event('pane_created', { pane: pane({ pane_id: 'w4:p3', agent: null }) }));
		expect(rec.added.map((state) => state.paneId)).toEqual(['w4:p2']);
		expect(scope.size).toBe(2);
	});

	it('ignores panes of other workspaces entirely (M6)', () => {
		const { scope, rec } = primed();
		scope.ingest(
			event('pane_created', { pane: pane({ pane_id: 'wT:p8', workspace_id: 'wT' }) }),
		);
		scope.ingest(
			event('pane_updated', {
				pane: pane({ pane_id: 'wT:p8', workspace_id: 'wT', agent_status: 'blocked' }),
			}),
		);
		expect(rec.added).toHaveLength(0);
		expect(rec.changed).toHaveLength(0);
		expect(scope.size).toBe(1);
	});

	it('removes a pane on pane_closed and pane_exited', () => {
		const { scope, rec } = primed();
		scope.ingest(event('pane_closed', { pane_id: 'w4:p1', workspace_id: 'w4' }));
		scope.ingest(event('pane_closed', { pane_id: 'w4:p1', workspace_id: 'w4' }));
		expect(rec.removed.map((state) => state.paneId)).toEqual(['w4:p1']);
		expect(scope.size).toBe(0);
	});

	it('removes a pane whose agent was released, and one moved out of scope', () => {
		const { scope, rec } = primed();
		scope.ingest(event('pane_created', { pane: pane({ pane_id: 'w4:p2' }) }));
		scope.ingest(
			event('pane_agent_detected', { pane_id: 'w4:p1', workspace_id: 'w4', agent: null, released: true }),
		);
		scope.ingest(
			event('pane_moved', {
				pane: pane({ pane_id: 'w4:p2', workspace_id: 'wT' }),
				previous_pane_id: 'w4:p2',
				previous_workspace_id: 'w4',
				previous_tab_id: 'w4:t1',
			}),
		);
		expect(rec.removed.map((state) => state.paneId)).toEqual(['w4:p1', 'w4:p2']);
		expect(scope.size).toBe(0);
	});

	it('tracks focus, which pane_focused reports without a PaneInfo', () => {
		const { scope, rec } = primed();
		scope.ingest(event('pane_created', { pane: pane({ pane_id: 'w4:p2', focused: true }) }));
		rec.changed.length = 0;
		scope.ingest(event('pane_focused', { pane_id: 'w4:p1', workspace_id: 'w4' }));
		expect(rec.changed.map((entry) => [entry.paneId, entry.next.focused])).toEqual([
			['w4:p1', true],
			['w4:p2', false],
		]);
	});

	it('resolves later when a workspace is renamed to the vault name', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime([workspace('w4', 'scratch')], [pane({ pane_id: 'w4:p1', cwd: '/tmp' })]);
		expect(scope.workspaceId).toBeNull();
		const rec = record(scope);
		scope.ingest(event('workspace_renamed', { workspace_id: 'w4', label: 'hvelv' }));
		expect(rec.resolved).toEqual([{ workspaceId: 'w4', method: 'label' }]);
		// The workspace's existing panes arrive in the same step as the identity.
		expect(scope.list().map((state) => state.paneId)).toEqual(['w4:p1']);
		expect(rec.added.map((state) => state.paneId)).toEqual(['w4:p1']);
	});

	it('resolves when a matching workspace is created later', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime([], []);
		const rec = record(scope);
		scope.ingest(event('workspace_created', { workspace: workspace('w4', 'hvelv') }));
		expect(rec.resolved).toEqual([{ workspaceId: 'w4', method: 'label' }]);
		scope.ingest(event('pane_created', { pane: pane({ pane_id: 'w4:p1' }) }));
		expect(scope.list().map((state) => state.paneId)).toEqual(['w4:p1']);
	});

	it('empties the scope when the workspace is closed', () => {
		const { scope, rec } = primed();
		scope.ingest(event('workspace_closed', { workspace_id: 'w4' }));
		expect(rec.removed.map((state) => state.paneId)).toEqual(['w4:p1']);
		expect(rec.resolved).toEqual([{ workspaceId: null, method: 'none' }]);
		expect(scope.workspaceId).toBeNull();
	});

	it('resolves and populates from a workspace_updated that changes the label', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime([workspace('w4', 'scratch')], [pane({ pane_id: 'w4:p1', cwd: '/tmp' })]);
		const rec = record(scope);
		scope.ingest(event('workspace_updated', { workspace: workspace('w4', 'hvelv') }));
		expect(rec.resolved).toEqual([{ workspaceId: 'w4', method: 'label' }]);
		expect(scope.list().map((state) => state.paneId)).toEqual(['w4:p1']);
	});

	it('ignores malformed and unknown events', () => {
		const { scope, rec } = primed();
		scope.ingest(event('pane_updated', { pane: null }));
		scope.ingest(event('pane_updated', {}));
		scope.ingest(event('layout_updated', { layout: {} }));
		scope.ingest({ event: 'something_new', data: {} });
		expect(rec.changed).toHaveLength(0);
		expect(rec.removed).toHaveLength(0);
		expect(scope.size).toBe(1);
	});

	it('keeps delivering to other subscribers when one throws', () => {
		const { scope } = primed();
		const seen: string[] = [];
		scope.on('changed', () => {
			throw new Error('subscriber blew up');
		});
		scope.on('changed', (paneId) => seen.push(paneId));
		scope.ingest(
			event('pane_updated', { pane: pane({ pane_id: 'w4:p1', agent_status: 'done' }) }),
		);
		expect(seen).toEqual(['w4:p1']);
	});

	it('stops delivering after unsubscribe', () => {
		const { scope } = primed();
		const seen: string[] = [];
		const off = scope.on('changed', (paneId) => seen.push(paneId));
		off();
		off();
		scope.ingest(
			event('pane_updated', { pane: pane({ pane_id: 'w4:p1', agent_status: 'done' }) }),
		);
		expect(seen).toEqual([]);
	});
});

/**
 * Identity and membership move together (issue #58). These mirror the
 * invariants in `docs/reviews/2026-09-06/scope-repros.mjs`; the review found
 * all three failing against a scope that changed `workspaceId` without touching
 * the pane map and resolved against a frozen `pane.list` snapshot.
 */
describe('WorkspaceScope re-resolution keeps the collection in step (#58)', () => {
	function members(scope: WorkspaceScope): [string, string][] {
		return scope.list().map((state) => [state.paneId, state.workspaceId]);
	}

	function twoWorkspaces(): { scope: WorkspaceScope; rec: Recorded } {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime(
			[workspace('wA', 'hvelv'), workspace('wB', 'other')],
			[
				pane({ pane_id: 'pa', workspace_id: 'wA', cwd: '/elsewhere' }),
				pane({ pane_id: 'pb', workspace_id: 'wB', cwd: '/elsewhere' }),
			],
		);
		expect(members(scope)).toEqual([['pa', 'wA']]);
		return { scope, rec: record(scope) };
	}

	it('renaming the matching workspace away removes its panes', () => {
		const { scope, rec } = twoWorkspaces();
		scope.ingest(event('workspace_renamed', { workspace_id: 'wA', label: 'old' }));
		expect(scope.workspaceId).toBeNull();
		expect(scope.method).toBe('none');
		expect(members(scope)).toEqual([]);
		expect(rec.removed.map((state) => state.paneId)).toEqual(['pa']);
		expect(rec.resolved).toEqual([{ workspaceId: null, method: 'none' }]);
	});

	it('renaming another workspace into scope replaces the pane collection', () => {
		const { scope, rec } = twoWorkspaces();
		scope.ingest(event('workspace_renamed', { workspace_id: 'wA', label: 'old' }));
		scope.ingest(event('workspace_renamed', { workspace_id: 'wB', label: 'hvelv' }));
		expect(scope.workspaceId).toBe('wB');
		expect(members(scope)).toEqual([['pb', 'wB']]);
		expect(rec.removed.map((state) => state.paneId)).toEqual(['pa']);
		expect(rec.added.map((state) => state.paneId)).toEqual(['pb']);
		expect(rec.resolved).toEqual([
			{ workspaceId: null, method: 'none' },
			{ workspaceId: 'wB', method: 'label' },
		]);
	});

	it('swaps the collection in one step when the label moves straight to another workspace', () => {
		const { scope, rec } = twoWorkspaces();
		scope.ingest(event('workspace_renamed', { workspace_id: 'wB', label: 'hvelv' }));
		// Two exact label matches: the first in list order still wins, so nothing moves...
		expect(scope.workspaceId).toBe('wA');
		expect(rec.resolved).toHaveLength(0);
		// ...until A stops matching, and then B's panes replace A's atomically.
		scope.ingest(event('workspace_renamed', { workspace_id: 'wA', label: 'old' }));
		expect(scope.workspaceId).toBe('wB');
		expect(members(scope)).toEqual([['pb', 'wB']]);
		expect(rec.resolved).toEqual([{ workspaceId: 'wB', method: 'label' }]);
		// Every pane the views were told about is accounted for: none from A survive.
		expect(rec.removed.map((state) => state.paneId)).toEqual(['pa']);
		expect(rec.added.map((state) => state.paneId)).toEqual(['pb']);
	});

	it('a newly created in-vault pane enables cwd fallback resolution', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime([workspace('wA', 'other')], []);
		expect(scope.workspaceId).toBeNull();
		const rec = record(scope);
		scope.ingest(event('pane_created', { pane: pane({ pane_id: 'pa', workspace_id: 'wA' }) }));
		expect(scope.workspaceId).toBe('wA');
		expect(scope.method).toBe('cwd');
		expect(members(scope)).toEqual([['pa', 'wA']]);
		expect(rec.resolved).toEqual([{ workspaceId: 'wA', method: 'cwd' }]);
		expect(rec.added.map((state) => state.paneId)).toEqual(['pa']);
	});

	it('a cwd change into the vault enables cwd fallback resolution', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime(
			[workspace('wA', 'other')],
			[pane({ pane_id: 'pa', workspace_id: 'wA', cwd: '/tmp' })],
		);
		expect(scope.workspaceId).toBeNull();
		scope.ingest(
			event('pane_updated', {
				pane: pane({ pane_id: 'pa', workspace_id: 'wA', cwd: `${VAULT}/n` }),
			}),
		);
		expect(scope.workspaceId).toBe('wA');
		expect(members(scope)).toEqual([['pa', 'wA']]);
	});

	it('a shell pane in the vault resolves the workspace but does not join the list (M7)', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime([workspace('wA', 'other')], []);
		scope.ingest(
			event('pane_created', { pane: pane({ pane_id: 'sh', workspace_id: 'wA', agent: null }) }),
		);
		expect(scope.workspaceId).toBe('wA');
		expect(scope.method).toBe('cwd');
		expect(members(scope)).toEqual([]);
		scope.ingest(
			event('pane_created', { pane: pane({ pane_id: 'pa', workspace_id: 'wA', cwd: '/tmp' }) }),
		);
		expect(members(scope)).toEqual([['pa', 'wA']]);
	});

	it('loses a cwd-resolved workspace when its last in-vault pane leaves or closes', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime(
			[workspace('wA', 'other')],
			[
				pane({ pane_id: 'pa', workspace_id: 'wA' }),
				pane({ pane_id: 'px', workspace_id: 'wA', cwd: '/tmp' }),
			],
		);
		expect(scope.method).toBe('cwd');
		expect(members(scope)).toEqual([
			['pa', 'wA'],
			['px', 'wA'],
		]);
		const rec = record(scope);

		scope.ingest(
			event('pane_updated', { pane: pane({ pane_id: 'pa', workspace_id: 'wA', cwd: '/tmp' }) }),
		);
		expect(scope.workspaceId).toBeNull();
		expect(members(scope)).toEqual([]);
		expect(rec.removed.map((state) => state.paneId).sort()).toEqual(['pa', 'px']);

		scope.ingest(event('pane_updated', { pane: pane({ pane_id: 'pa', workspace_id: 'wA' }) }));
		expect(scope.workspaceId).toBe('wA');
		expect(members(scope)).toEqual([
			['pa', 'wA'],
			['px', 'wA'],
		]);

		scope.ingest(event('pane_closed', { pane_id: 'pa', workspace_id: 'wA' }));
		expect(scope.workspaceId).toBeNull();
		expect(members(scope)).toEqual([]);
	});

	it('never resurrects a closed pane from stale inventory on a later re-resolution', () => {
		const { scope } = twoWorkspaces();
		scope.ingest(event('pane_closed', { pane_id: 'pb', workspace_id: 'wB' }));
		scope.ingest(event('workspace_renamed', { workspace_id: 'wA', label: 'old' }));
		scope.ingest(event('workspace_renamed', { workspace_id: 'wB', label: 'hvelv' }));
		expect(scope.workspaceId).toBe('wB');
		expect(members(scope)).toEqual([]);

		// A pane that moved and got a new id is not still known under the old one.
		scope.ingest(
			event('pane_moved', {
				pane: pane({ pane_id: 'wA:pa', workspace_id: 'wA', cwd: '/elsewhere' }),
				previous_pane_id: 'pa',
				previous_workspace_id: 'wA',
			}),
		);
		scope.ingest(event('workspace_renamed', { workspace_id: 'wB', label: 'other' }));
		scope.ingest(event('workspace_renamed', { workspace_id: 'wA', label: 'hvelv' }));
		expect(members(scope)).toEqual([['wA:pa', 'wA']]);
	});

	it("drops the closed workspace's panes from the inventory too", () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime([workspace('wA', 'other')], [pane({ pane_id: 'pa', workspace_id: 'wA' })]);
		expect(scope.method).toBe('cwd');
		const rec = record(scope);
		scope.ingest(event('workspace_closed', { workspace_id: 'wA' }));
		expect(scope.workspaceId).toBeNull();
		expect(members(scope)).toEqual([]);
		expect(rec.removed.map((state) => state.paneId)).toEqual(['pa']);
		expect(rec.resolved).toEqual([{ workspaceId: null, method: 'none' }]);
		// Re-creating the workspace with the same id finds no in-vault pane left.
		scope.ingest(event('workspace_created', { workspace: workspace('wA', 'other') }));
		expect(scope.workspaceId).toBeNull();
	});

	it('falls through to another workspace when a cwd-resolved one closes', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime(
			[workspace('wA', 'other'), workspace('wB', 'more')],
			[
				pane({ pane_id: 'pa', workspace_id: 'wA' }),
				pane({ pane_id: 'pa2', workspace_id: 'wA' }),
				pane({ pane_id: 'pb', workspace_id: 'wB' }),
			],
		);
		expect(scope.workspaceId).toBe('wA');
		const rec = record(scope);
		scope.ingest(event('workspace_closed', { workspace_id: 'wA' }));
		expect(scope.workspaceId).toBe('wB');
		expect(members(scope)).toEqual([['pb', 'wB']]);
		expect(rec.resolved).toEqual([{ workspaceId: 'wB', method: 'cwd' }]);
	});

	it('keeps a setting override unresolved after its workspace closes, with an empty list', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT, workspaceId: 'wA' });
		scope.prime([workspace('wA', 'other')], [pane({ pane_id: 'pa', workspace_id: 'wA' })]);
		const rec = record(scope);
		scope.ingest(event('workspace_closed', { workspace_id: 'wA' }));
		expect(scope.workspaceId).toBeNull();
		expect(members(scope)).toEqual([]);
		expect(rec.resolved).toEqual([{ workspaceId: null, method: 'none' }]);
	});

	it('stays quiet under the pane_updated storm while resolved by cwd (N4)', () => {
		const scope = new WorkspaceScope({ vaultPath: VAULT });
		scope.prime([workspace('wA', 'other')], [pane({ pane_id: 'pa', workspace_id: 'wA' })]);
		expect(scope.method).toBe('cwd');
		const rec = record(scope);
		for (let revision = 2; revision < 40; revision += 1) {
			scope.ingest(
				event('pane_updated', {
					pane: pane({
						pane_id: 'pa',
						workspace_id: 'wA',
						revision,
						terminal_title_stripped: `${revision % 2 === 0 ? '◐' : '◑'} Same work`,
						tokens: { cache_ok: '31m', cache_sort: String(4000 - revision) },
					}),
				}),
			);
		}
		// One repaint for the title and badge appearing; nothing for the churn.
		expect(rec.changed).toHaveLength(1);
		expect(rec.resolved).toHaveLength(0);
		expect(rec.added).toHaveLength(0);
		expect(rec.removed).toHaveLength(0);
	});

	it('re-primes after a reconnect from the fresh list, not from live inventory', () => {
		const { scope } = twoWorkspaces();
		scope.ingest(event('pane_created', { pane: pane({ pane_id: 'pa2', workspace_id: 'wA' }) }));
		expect(members(scope)).toEqual([
			['pa', 'wA'],
			['pa2', 'wA'],
		]);
		// The reconnect list no longer has pa2: it is gone, whatever the events said.
		scope.prime([workspace('wA', 'hvelv')], [pane({ pane_id: 'pa', workspace_id: 'wA' })]);
		expect(members(scope)).toEqual([['pa', 'wA']]);
		scope.ingest(event('workspace_renamed', { workspace_id: 'wA', label: 'old' }));
		scope.ingest(event('workspace_renamed', { workspace_id: 'wA', label: 'hvelv' }));
		expect(members(scope)).toEqual([['pa', 'wA']]);
	});
});
