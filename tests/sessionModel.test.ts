/**
 * The session model (issues #93 and #94, ADR-0003).
 *
 * The plugin-held, per-pane reduced state of a transcript (CONTEXT.md). Driven
 * here through a fake transcript source and a fake herdr — a pane snapshot,
 * raw client events and status transitions — because that is exactly what it is
 * made of: identity from the pane, content from a path.
 *
 * The `pane_updated` events are raw, the shape herdr really sends, because
 * reading `agent_session` off them is the one recorded exception to "react to
 * status transitions, never to raw pane updates" (CLAUDE.md, ADR-0003) and the
 * exception is only sound if the parsing is.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	scopeWatcher,
	SessionModelRegistry,
	type PaneSnapshot,
	type SessionChange,
	type SessionWatcher,
	type Unsubscribe,
} from '../src/native/sessionModel';
import type {
	TailOptions,
	TranscriptSource,
	TranscriptStream,
} from '../src/native/transcriptSource';
import type { HerdrEvent } from '../src/herdr/client';
import type { PaneState } from '../src/herdr/scope';
import type { AgentStatus, PaneInfo } from '../src/herdr/types.gen';

/** One tail the fake source handed out. */
class FakeTail implements TranscriptStream {
	closed = false;
	constructor(
		readonly path: string,
		private readonly onLines: (lines: string[]) => void,
	) {}
	/** What the file growing looks like from the model's side. */
	emit(lines: string[]): void {
		if (!this.closed) this.onLines(lines);
	}
	close(): void {
		this.closed = true;
	}
}

/**
 * A transcript source over an in-memory map of path to contents. A tail
 * delivers what the "file" holds as it opens, the way the local one does.
 */
class FakeSource implements TranscriptSource {
	readonly reads: string[] = [];
	readonly tails: FakeTail[] = [];
	/** While set, a read waits for {@link release}, so a test can finish it late. */
	hold = false;
	private readonly held: (() => void)[] = [];
	constructor(readonly files: Map<string, string>) {}

	async read(path: string): Promise<string | null> {
		this.reads.push(path);
		if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve));
		return this.files.get(path) ?? null;
	}

	/** Finishes every read that was held. */
	release(): void {
		for (const resolve of this.held.splice(0)) resolve();
	}

	open(path: string, onLines: (lines: string[]) => void, _options?: TailOptions): TranscriptStream {
		const tail = new FakeTail(path, onLines);
		this.tails.push(tail);
		const text = this.files.get(path);
		if (text) tail.emit(text.split('\n').filter(Boolean));
		return tail;
	}

	/** Tails still open, which is what "one tail per pane" is asserted against. */
	get openTails(): FakeTail[] {
		return this.tails.filter((tail) => !tail.closed);
	}
}

const PANE: PaneSnapshot = {
	paneId: 'w4:p1',
	cwd: '/home/lasse/hvelv',
	agentSession: 'session-1',
	agentStatus: 'idle',
};

const PATH_1 = '/home/lasse/.claude/projects/-home-lasse-hvelv/session-1.jsonl';
const PATH_2 = '/home/lasse/.claude/projects/-home-lasse-hvelv/session-2.jsonl';

function transcript(prompt: string, answer: string, uuid: string): string {
	return [
		`{"type":"user","message":{"role":"user","content":${JSON.stringify(prompt)}},"uuid":"${uuid}"}`,
		`{"type":"assistant","message":{"id":"m-${uuid}","role":"assistant","content":[{"type":"text","text":${JSON.stringify(answer)}}]},"uuid":"a-${uuid}"}`,
		'',
	].join('\n');
}

const TRANSCRIPT_1 = transcript('First question', 'First answer.', 'u1');
const TRANSCRIPT_2 = transcript('After the clear', 'A clean slate.', 'u2');

/** Where an async subagent wrote its transcript, as its notification named it. */
const OUTPUT_FILE = '/tmp/claude-1000/-home-lasse-hvelv/session-1/tasks/a1f2.output';
/** Where the same subagent's transcript also lives, beside the session's file. */
const SUBAGENT_FILE =
	'/home/lasse/.claude/projects/-home-lasse-hvelv/session-1/subagents/agent-a1f2.jsonl';

/** The notification a finished background subagent enqueues (docs/architecture.md). */
const NOTIFICATION = [
	'<task-notification>',
	'<task-id>a1f2</task-id>',
	'<tool-use-id>toolu_a1</tool-use-id>',
	`<output-file>${OUTPUT_FILE}</output-file>`,
	'<status>completed</status>',
	'</task-notification>',
].join('\n');

/** A turn that launches an async subagent and is told it finished. */
const LAUNCHED = [
	'{"type":"user","message":{"role":"user","content":"Start the long job"},"uuid":"u1"}',
	'{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"toolu_a1","name":"Agent","input":{"description":"Check the styles"}}]},"uuid":"a1"}',
	`{"type":"queue-operation","operation":"enqueue","content":${JSON.stringify(NOTIFICATION)}}`,
	`{"type":"user","message":{"role":"user","content":${JSON.stringify(NOTIFICATION)}},"uuid":"u2"}`,
	'',
].join('\n');

/** The subagent's own transcript: its report is the last thing it said. */
const SUBAGENT_TRANSCRIPT = [
	'{"type":"user","message":{"role":"user","content":"Check the styles"}}',
	'{"type":"assistant","message":{"id":"s1","role":"assistant","content":[{"type":"text","text":"Halfway through."}]}}',
	'{"type":"assistant","message":{"id":"s2","role":"assistant","content":[{"type":"text","text":"The styles are **fine**."}]}}',
	'',
].join('\n');

/** The report the model attached to the `Agent` call, or null when it has none. */
function reportOf(model: { state: { turns: { entries: unknown[] }[] } }): string | null {
	for (const turn of model.state.turns) {
		for (const entry of turn.entries) {
			const tool = entry as { kind: string; report?: string | null };
			if (tool.kind === 'tool') return tool.report ?? null;
		}
	}
	return null;
}

/** A herdr that reports one pane, and sends the events a test asks it to. */
class FakeWatcher implements SessionWatcher {
	private readonly eventHandlers = new Set<(event: HerdrEvent) => void>();
	private readonly statusHandlers = new Set<(paneId: string, status: AgentStatus) => void>();
	constructor(private pane: PaneSnapshot | null) {}

	snapshot(paneId: string): PaneSnapshot | null {
		return this.pane && this.pane.paneId === paneId ? this.pane : null;
	}

	onEvent(handler: (event: HerdrEvent) => void): Unsubscribe {
		this.eventHandlers.add(handler);
		return () => this.eventHandlers.delete(handler);
	}

	onStatus(handler: (paneId: string, status: AgentStatus) => void): Unsubscribe {
		this.statusHandlers.add(handler);
		return () => this.statusHandlers.delete(handler);
	}

	/** What the pane now is, as far as herdr is concerned. */
	set(pane: PaneSnapshot | null): void {
		this.pane = pane;
	}

	/** A `pane_updated` push, in the shape herdr really sends it. */
	paneUpdated(paneId: string, agentSession: string | null): void {
		const event: HerdrEvent = {
			event: 'pane_updated',
			data: {
				type: 'pane_updated',
				pane: {
					pane_id: paneId,
					workspace_id: 'w4',
					tab_id: 'w4:t1',
					terminal_id: 'term_1',
					agent: 'claude',
					agent_status: 'idle',
					focused: false,
					revision: 7,
					...(agentSession
						? {
								agent_session: {
									agent: 'claude',
									kind: 'id',
									source: 'herdr:claude',
									value: agentSession,
								},
							}
						: {}),
				},
			},
		};
		for (const handler of [...this.eventHandlers]) handler(event);
	}

	statusChanged(paneId: string, status: AgentStatus): void {
		for (const handler of [...this.statusHandlers]) handler(paneId, status);
	}
}

function registryWith(
	files: Map<string, string>,
	pane: PaneSnapshot | null = PANE,
): {
	registry: SessionModelRegistry;
	source: FakeSource;
	watcher: FakeWatcher;
	/** Replaces the watcher the way a reconnect replaces the scope (#94). */
	reconnect: () => FakeWatcher;
} {
	const source = new FakeSource(files);
	let watcher = new FakeWatcher(pane);
	const registry = new SessionModelRegistry({
		source,
		watcher: () => watcher,
		home: '/home/lasse',
	});
	return {
		registry,
		source,
		watcher,
		reconnect: () => {
			watcher = new FakeWatcher(pane);
			registry.rebind();
			return watcher;
		},
	};
}

function filesWith(...pairs: [string, string][]): Map<string, string> {
	return new Map(pairs);
}

describe('SessionModel: the pane’s current transcript', () => {
	it('tails the file its cwd and agent session name, and reduces what it delivers', () => {
		const { registry, source } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));

		const handle = registry.acquire('w4:p1');

		expect(source.tails.map((tail) => tail.path)).toEqual([PATH_1]);
		expect(handle.model.path).toBe(PATH_1);
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['First question']);
		expect(handle.model.agentStatus).toBe('idle');
	});

	it('has no session yet when the pane has no agent session', () => {
		// A freshly started Claude sits idle with no `agent_session` until its
		// first prompt (docs/architecture.md); the view shows "no session yet".
		const { registry, source } = registryWith(new Map(), { ...PANE, agentSession: '' });

		const handle = registry.acquire('w4:p1');

		expect(handle.model.path).toBeNull();
		expect(handle.model.state.turns).toEqual([]);
		expect(source.tails).toEqual([]);
	});

	it('tells its subscribers which turns each batch of lines changed', () => {
		const { registry, source } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire('w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		source.tails[0]?.emit([
			'{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"And more."}]},"uuid":"a2"}',
		]);

		expect(changes).toEqual([{ changedTurnIds: ['u1'], reset: false }]);
		expect(handle.model.state.turns[0]?.entries).toHaveLength(2);
	});
});

describe('SessionModel: following the agent session (ADR-0003)', () => {
	it('starts the new file from empty when /clear rotates the session', () => {
		const { registry, source, watcher } = registryWith(
			filesWith([PATH_1, TRANSCRIPT_1], [PATH_2, TRANSCRIPT_2]),
		);
		const handle = registry.acquire('w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		// Rotation has no event of its own: it shows as `agent_session` on a
		// `pane.updated` for this pane.
		watcher.set({ ...PANE, agentSession: 'session-2' });
		watcher.paneUpdated('w4:p1', 'session-2');

		expect(source.tails[0]?.closed).toBe(true);
		expect(source.tails.map((tail) => tail.path)).toEqual([PATH_1, PATH_2]);
		expect(handle.model.agentSession).toBe('session-2');
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['After the clear']);
		// The view is emptied the moment the rotation is seen, not when the new
		// file's first lines arrive: a real tail delivers those asynchronously,
		// and the old session must not still be on screen in between.
		expect(changes).toEqual([
			{ changedTurnIds: [], reset: true },
			{ changedTurnIds: ['u2'], reset: false },
		]);
	});

	it('ignores a repeat of the session it is already showing, and other panes', () => {
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		registry.acquire('w4:p1');

		// Deduplicated by value: herdr sends about ten pane updates a second.
		watcher.paneUpdated('w4:p1', 'session-1');
		watcher.paneUpdated('w4:p1', 'session-1');
		// Another pane's rotation is none of this model's business.
		watcher.paneUpdated('w4:p2', 'session-9');

		expect(source.tails).toHaveLength(1);
		expect(source.openTails).toHaveLength(1);
	});

	it('starts tailing when a fresh Claude’s session id appears', () => {
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]), {
			...PANE,
			agentSession: '',
		});
		const handle = registry.acquire('w4:p1');
		expect(handle.model.path).toBeNull();

		watcher.set(PANE);
		watcher.paneUpdated('w4:p1', 'session-1');

		expect(source.tails.map((tail) => tail.path)).toEqual([PATH_1]);
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['First question']);
	});

	it('empties the view when the pane loses its session', () => {
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire('w4:p1');

		watcher.set({ ...PANE, agentSession: '' });
		watcher.paneUpdated('w4:p1', null);

		expect(source.tails[0]?.closed).toBe(true);
		expect(handle.model.path).toBeNull();
		expect(handle.model.state.turns).toEqual([]);
	});
});

describe('SessionModel: the agent’s status', () => {
	it('follows status transitions and tells its subscribers', () => {
		const { registry, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire('w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		watcher.statusChanged('w4:p1', 'working');

		expect(handle.model.agentStatus).toBe('working');
		expect(changes).toEqual([{ changedTurnIds: [], reset: false }]);
	});

	it('ignores another pane’s status', () => {
		const { registry, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire('w4:p1');

		watcher.statusChanged('w4:p2', 'blocked');

		expect(handle.model.agentStatus).toBe('idle');
	});
});

describe('SessionModel: a replaced scope (#94)', () => {
	it('rebinds to the new herdr and re-reads the pane', () => {
		// Endpoint sessions are replaced on reconnect and on an endpoint switch;
		// a model that kept the old subscription would simply stop following.
		const { registry, source, watcher, reconnect } = registryWith(
			filesWith([PATH_1, TRANSCRIPT_1], [PATH_2, TRANSCRIPT_2]),
		);
		const handle = registry.acquire('w4:p1');

		const fresh = reconnect();
		// The old herdr is gone; anything it says now is ignored.
		watcher.set({ ...PANE, agentSession: 'session-2' });
		watcher.paneUpdated('w4:p1', 'session-2');
		expect(handle.model.agentSession).toBe('session-1');

		fresh.set({ ...PANE, agentSession: 'session-2' });
		fresh.paneUpdated('w4:p1', 'session-2');

		expect(handle.model.agentSession).toBe('session-2');
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['After the clear']);
		expect(source.openTails.map((tail) => tail.path)).toEqual([PATH_2]);
	});
});

describe('scopeWatcher: the pane as herdr reports it', () => {
	const events = new Set<(event: HerdrEvent) => void>();
	const client = {
		on: (type: string, handler: (event: HerdrEvent) => void): Unsubscribe => {
			expect(type).toBe('pane_updated');
			events.add(handler);
			return () => events.delete(handler);
		},
	};

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
			on: () => () => {},
		};

		expect(scopeWatcher({ scope, client })?.snapshot('w4:p1')).toEqual({
			paneId: 'w4:p1',
			cwd: '/home/lasse/hvelv',
			agentSession: 'session-1',
			agentStatus: 'working',
		});
		expect(scopeWatcher({ scope, client })?.snapshot('w4:p9')).toBeNull();
		// Nothing connected: no pane to read, which is not an error.
		expect(scopeWatcher(null)).toBeNull();
	});

	it('reports no agent session for a pane that has not taken a prompt yet', () => {
		const scope = {
			get: () => ({ paneId: 'w4:p1', cwd: '/home/lasse', agentStatus: 'idle' }) as PaneState,
			paneInfo: () => ({ pane_id: 'w4:p1' }) as PaneInfo,
			on: () => () => {},
		};

		expect(scopeWatcher({ scope, client })?.snapshot('w4:p1')?.agentSession).toBe('');
	});

	it('reports a status transition, and only a transition', () => {
		const handlers: ((paneId: string, prev: PaneState, next: PaneState) => void)[] = [];
		const scope = {
			get: () => undefined,
			paneInfo: () => undefined,
			on: (event: string, handler: (paneId: string, prev: PaneState, next: PaneState) => void) => {
				expect(event).toBe('changed');
				handlers.push(handler);
				return () => {};
			},
		};
		const seen: [string, AgentStatus][] = [];
		scopeWatcher({ scope, client })?.onStatus((paneId, status) => seen.push([paneId, status]));

		const idle = { agentStatus: 'idle' } as PaneState;
		const working = { agentStatus: 'working' } as PaneState;
		handlers[0]?.('w4:p1', idle, working);
		// A title or token change is not a transition, and moves nothing here.
		handlers[0]?.('w4:p1', working, working);

		expect(seen).toEqual([['w4:p1', 'working']]);
	});
});

describe('SessionModelRegistry: one model per pane', () => {
	it('gives two subscribers the same model, one tail, and closes it on the last release', () => {
		const { registry, source } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));

		const first = registry.acquire('w4:p1');
		const second = registry.acquire('w4:p1');
		expect(second.model).toBe(first.model);
		expect(source.tails).toHaveLength(1);

		first.release();
		// One leaf closed, the other still watching: the model and its tail stay.
		expect(registry.has('w4:p1')).toBe(true);
		expect(source.openTails).toHaveLength(1);

		second.release();
		expect(registry.has('w4:p1')).toBe(false);
		expect(source.openTails).toEqual([]);
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

	it('closes every tail on dispose', () => {
		const { registry, source } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		registry.acquire('w4:p1');

		registry.dispose();

		expect(source.openTails).toEqual([]);
		expect(registry.has('w4:p1')).toBe(false);
	});
});

describe('SessionModel: a background subagent’s report (#96)', () => {
	it('reads the report out of the file the notification named and feeds it back with the turn it changed', async () => {
		const { registry, source } = registryWith(
			filesWith([PATH_1, LAUNCHED], [OUTPUT_FILE, SUBAGENT_TRANSCRIPT]),
		);
		const handle = registry.acquire('w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		await vi.waitFor(() => expect(changes).toHaveLength(1));

		expect(source.reads).toEqual([OUTPUT_FILE]);
		// The read is not a line of the transcript: it changes one turn, and the
		// view redraws that turn (the seam note on #96).
		expect(changes).toEqual([{ changedTurnIds: ['u1'], reset: false }]);
		expect(reportOf(handle.model)).toBe('The styles are **fine**.');
	});

	it('falls back to the subagent transcript beside the session’s own file', async () => {
		const { registry, source } = registryWith(
			filesWith([PATH_1, LAUNCHED], [SUBAGENT_FILE, SUBAGENT_TRANSCRIPT]),
		);
		const handle = registry.acquire('w4:p1');

		await vi.waitFor(() => expect(reportOf(handle.model)).not.toBeNull());

		expect(source.reads).toEqual([OUTPUT_FILE, SUBAGENT_FILE]);
		expect(reportOf(handle.model)).toBe('The styles are **fine**.');
	});

	it('discards a report whose session rotated before the read resolved', async () => {
		const { registry, source, watcher } = registryWith(
			filesWith([PATH_1, LAUNCHED], [OUTPUT_FILE, SUBAGENT_TRANSCRIPT], [PATH_2, TRANSCRIPT_2]),
		);
		source.hold = true;
		const handle = registry.acquire('w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		// /clear, while the read is still in flight.
		watcher.set({ ...PANE, agentSession: 'session-2' });
		watcher.paneUpdated('w4:p1', 'session-2');
		source.release();
		await vi.waitFor(() => expect(handle.model.path).toBe(PATH_2));

		// The rotation emptied the view, and the report of the session that is
		// gone never arrives (ADR-0003: following is strict).
		expect(changes).toEqual([
			{ changedTurnIds: [], reset: true },
			{ changedTurnIds: ['u2'], reset: false },
		]);
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['After the clear']);
		expect(reportOf(handle.model)).toBeNull();
	});
});
