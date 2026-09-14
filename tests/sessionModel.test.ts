/**
 * The session model (issues #93 and #94, ADR-0003).
 *
 * The plugin-held, per-pane reduced state of a transcript (CONTEXT.md). Driven
 * here through a fake transcript source and a fake herdr — a pane snapshot and
 * raw client events — because that is exactly what it is made of: identity from
 * the pane, content from a path.
 */

import { describe, expect, it } from 'vitest';
import {
	scopeWatcher,
	SessionModelRegistry,
	type PaneSnapshot,
	type SessionWatcher,
} from '../src/native/sessionModel';
import type { TranscriptSource } from '../src/native/transcriptSource';
import type { PaneState } from '../src/herdr/scope';
import type { PaneInfo } from '../src/herdr/types.gen';

/** A transcript source over an in-memory map of path to file contents. */
class FakeSource implements TranscriptSource {
	readonly reads: string[] = [];
	constructor(readonly files: Map<string, string>) {}
	async read(path: string): Promise<string | null> {
		this.reads.push(path);
		return this.files.get(path) ?? null;
	}
}

const PANE: PaneSnapshot = {
	paneId: 'w4:p1',
	cwd: '/home/lasse/hvelv',
	agentSession: 'session-1',
	agentStatus: 'idle',
};

const TRANSCRIPT_1 = [
	'{"type":"user","message":{"role":"user","content":"First question"},"uuid":"u1"}',
	'{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"First answer."}]},"uuid":"a1"}',
	'',
].join('\n');

/** A herdr that reports one pane and nothing else. */
class FakeWatcher implements SessionWatcher {
	constructor(private pane: PaneSnapshot | null) {}
	snapshot(paneId: string): PaneSnapshot | null {
		return this.pane && this.pane.paneId === paneId ? this.pane : null;
	}
	set(pane: PaneSnapshot | null): void {
		this.pane = pane;
	}
}

function registryWith(
	files: Map<string, string>,
	pane: PaneSnapshot | null = PANE,
): { registry: SessionModelRegistry; source: FakeSource; watcher: FakeWatcher } {
	const source = new FakeSource(files);
	const watcher = new FakeWatcher(pane);
	const registry = new SessionModelRegistry({
		source,
		watcher: () => watcher,
		home: '/home/lasse',
	});
	return { registry, source, watcher };
}

const PATH_1 = '/home/lasse/.claude/projects/-home-lasse-hvelv/session-1.jsonl';

describe('SessionModel: the pane’s current transcript', () => {
	it('takes its path from the pane’s cwd and agent session, and reduces the file', async () => {
		const { registry, source } = registryWith(new Map([[PATH_1, TRANSCRIPT_1]]));
		const handle = registry.acquire('w4:p1');

		await handle.model.ready;

		expect(source.reads).toEqual([PATH_1]);
		expect(handle.model.path).toBe(PATH_1);
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['First question']);
		expect(handle.model.agentStatus).toBe('idle');
	});

	it('has no session yet when the pane has no agent session', async () => {
		// A freshly started Claude sits idle with no `agent_session` until its
		// first prompt (docs/architecture.md); the view shows "no session yet".
		const { registry, source } = registryWith(new Map(), { ...PANE, agentSession: '' });
		const handle = registry.acquire('w4:p1');

		await handle.model.ready;

		expect(handle.model.path).toBeNull();
		expect(handle.model.state.turns).toEqual([]);
		expect(source.reads).toEqual([]);
	});

	it('tells its subscribers which turns the load brought in', async () => {
		const { registry } = registryWith(new Map([[PATH_1, TRANSCRIPT_1]]));
		const handle = registry.acquire('w4:p1');
		const changes: { changedTurnIds: string[]; reset: boolean }[] = [];
		handle.model.on((change) => changes.push(change));

		await handle.model.ready;

		expect(changes).toEqual([{ changedTurnIds: ['u1'], reset: true }]);
	});
});

describe('scopeWatcher: the pane as herdr reports it', () => {
	it('takes cwd and status from the scope and the agent session from the raw pane', () => {
		// `PaneState` has no `agent_session` — nothing renders it — so the one
		// field the session model needs comes from the pane herdr last sent.
		const scope = {
			get: (paneId: string) =>
				paneId === 'w4:p1'
					? ({ paneId, cwd: '/home/lasse/hvelv', agentStatus: 'working' } as PaneState)
					: undefined,
			paneInfo: (paneId: string) =>
				paneId === 'w4:p1'
					? ({
							pane_id: paneId,
							agent_session: { agent: 'claude', kind: 'id', source: 'screen', value: 'session-1' },
						} as PaneInfo)
					: undefined,
		};

		expect(scopeWatcher(scope)?.snapshot('w4:p1')).toEqual({
			paneId: 'w4:p1',
			cwd: '/home/lasse/hvelv',
			agentSession: 'session-1',
			agentStatus: 'working',
		});
		expect(scopeWatcher(scope)?.snapshot('w4:p9')).toBeNull();
		// Nothing connected: no pane to read, which is not an error.
		expect(scopeWatcher(null)).toBeNull();
	});

	it('reports no agent session for a pane that has not taken a prompt yet', () => {
		const scope = {
			get: () => ({ paneId: 'w4:p1', cwd: '/home/lasse', agentStatus: 'idle' }) as PaneState,
			paneInfo: () => ({ pane_id: 'w4:p1' }) as PaneInfo,
		};

		expect(scopeWatcher(scope)?.snapshot('w4:p1')?.agentSession).toBe('');
	});
});

describe('SessionModelRegistry: one model per pane', () => {
	it('gives two subscribers the same model and drops it when the last one lets go', async () => {
		const { registry } = registryWith(new Map([[PATH_1, TRANSCRIPT_1]]));

		const first = registry.acquire('w4:p1');
		const second = registry.acquire('w4:p1');
		expect(second.model).toBe(first.model);

		first.release();
		// One leaf closed, the other still watching: the model stays.
		expect(registry.has('w4:p1')).toBe(true);

		second.release();
		expect(registry.has('w4:p1')).toBe(false);
		// Opening the pane again starts a model of its own.
		expect(registry.acquire('w4:p1').model).not.toBe(first.model);
	});

	it('ignores a second release from the same handle', () => {
		const { registry } = registryWith(new Map());
		const handle = registry.acquire('w4:p1');
		const other = registry.acquire('w4:p1');

		handle.release();
		handle.release();

		expect(registry.has('w4:p1')).toBe(true);
		other.release();
		expect(registry.has('w4:p1')).toBe(false);
	});

	it('gives different panes different models', () => {
		const { registry } = registryWith(new Map());

		expect(registry.acquire('w4:p1').model).not.toBe(registry.acquire('w4:p2').model);
	});
});
