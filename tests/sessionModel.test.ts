/**
 * The session model (issues #93 and #94, ADR-0003, ADR-0006).
 *
 * The plugin-held, per-runtime-and-pane reduced state of a transcript
 * (CONTEXT.md). Driven here through a fake transcript source and a fake
 * session watcher — a pane snapshot, session pushes and status transitions —
 * because that is exactly what it is made of: identity from the runtime,
 * content from a path. herdr's own watcher, and the raw `pane_updated` it
 * reads, are `tests/herdrSessionWatcher.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	SessionModelRegistry,
	type BlockKind,
	type PaneSnapshot,
	type SessionChange,
	type SessionWatcher,
	type Unsubscribe,
} from '../src/native/sessionModel';
import type {
	TailOptions,
	TranscriptLines,
	TranscriptSource,
	TranscriptStream,
} from '../src/native/transcriptSource';
import type { AgentStatus } from '../src/herdr/types.gen';

/** One tail the fake source handed out. */
class FakeTail implements TranscriptStream {
	closed = false;
	constructor(
		readonly path: string,
		private readonly onLines: TranscriptLines,
		private readonly options: TailOptions = {},
	) {}
	/** The source's own limit stopped it reading, or no longer does. */
	problem(problem: string | null): void {
		if (!this.closed) this.options.onProblem?.(problem);
	}
	/** What the file growing looks like from the model's side. */
	emit(lines: string[]): void {
		if (!this.closed) this.onLines(lines);
	}
	/** The file was replaced or truncated: these lines are it from its start. */
	restart(lines: string[]): void {
		if (!this.closed) this.onLines(lines, true);
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

	open(path: string, onLines: TranscriptLines, options?: TailOptions): TranscriptStream {
		const tail = new FakeTail(path, onLines, options);
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

/** A runtime that reports one pane, and says what a test asks it to. */
class FakeWatcher implements SessionWatcher {
	private readonly sessionHandlers = new Set<
		(paneId: string, agentSession: string, transcriptPath?: string) => void
	>();
	private readonly statusHandlers = new Set<
		(paneId: string, status: AgentStatus, blockKind?: BlockKind) => void
	>();
	private readonly membershipHandlers = new Set<(paneId: string) => void>();
	private readonly infoHandlers = new Set<(paneId: string) => void>();
	constructor(private pane: PaneSnapshot | null) {}

	onSessionInfo(handler: (paneId: string) => void): Unsubscribe {
		this.infoHandlers.add(handler);
		return () => this.infoHandlers.delete(handler);
	}

	/** What the runtime itself says of the session moved, and nothing else did (#160). */
	infoChanged(paneId: string): void {
		for (const handler of [...this.infoHandlers]) handler(paneId);
	}

	snapshot(paneId: string): PaneSnapshot | null {
		return this.pane && this.pane.paneId === paneId ? this.pane : null;
	}

	onSession(
		handler: (paneId: string, agentSession: string, transcriptPath?: string) => void,
	): Unsubscribe {
		this.sessionHandlers.add(handler);
		return () => this.sessionHandlers.delete(handler);
	}

	onStatus(
		handler: (paneId: string, status: AgentStatus, blockKind?: BlockKind) => void,
	): Unsubscribe {
		this.statusHandlers.add(handler);
		return () => this.statusHandlers.delete(handler);
	}

	onMembership(handler: (paneId: string) => void): Unsubscribe {
		this.membershipHandlers.add(handler);
		return () => this.membershipHandlers.delete(handler);
	}

	/** Whether anything is still subscribed: a model that let go leaves nothing. */
	get subscribed(): boolean {
		return (
			this.sessionHandlers.size + this.statusHandlers.size + this.membershipHandlers.size + this.infoHandlers.size > 0
		);
	}

	/** What the pane now is, as far as the runtime is concerned. */
	set(pane: PaneSnapshot | null): void {
		this.pane = pane;
	}

	/**
	 * The session the runtime reports for a pane, as herdr's watcher passes on
	 * every `pane_updated` and herdr-core's would on every `labels` event.
	 */
	paneUpdated(paneId: string, agentSession: string | null, transcriptPath?: string): void {
		for (const handler of [...this.sessionHandlers]) {
			handler(paneId, agentSession ?? '', transcriptPath);
		}
	}

	statusChanged(paneId: string, status: AgentStatus, blockKind?: BlockKind): void {
		for (const handler of [...this.statusHandlers]) handler(paneId, status, blockKind);
	}

	/** The pane left the scope: the runtime still has it, this vault does not. */
	removed(paneId: string): void {
		if (this.pane?.paneId === paneId) this.pane = null;
		for (const handler of [...this.membershipHandlers]) handler(paneId);
	}

	/** The pane joined the scope, as every pane does when a fresh scope primes. */
	added(pane: PaneSnapshot): void {
		this.pane = pane;
		for (const handler of [...this.membershipHandlers]) handler(pane.paneId);
	}
}

/** The local runtime's id, as a tab pinned to it stores it. */
const LOCAL = 'local';
/** Another runtime, on another machine, with panes of its own. */
const XL = 'xl';

function registryWith(
	files: Map<string, string>,
	pane: PaneSnapshot | null = PANE,
): {
	registry: SessionModelRegistry;
	source: FakeSource;
	watcher: FakeWatcher;
	/** A fresh connection to the local runtime, the way a reconnect replaces the scope (#94). */
	reconnect: () => FakeWatcher;
	/**
	 * Publishes another runtime, or none, the way a runtime switch does: one
	 * connection at a time (ADR-0004). Returns that runtime's watcher.
	 */
	publish: (endpointId: string | null, pane?: PaneSnapshot | null) => FakeWatcher | null;
} {
	const source = new FakeSource(files);
	let published: { endpointId: string; watcher: FakeWatcher } | null = {
		endpointId: LOCAL,
		watcher: new FakeWatcher(pane),
	};
	const registry = new SessionModelRegistry({
		watcher: (endpointId) =>
			published && published.endpointId === endpointId ? published.watcher : null,
		source: () => source,
		home: '/home/lasse',
	});
	const publish = (
		endpointId: string | null,
		next: PaneSnapshot | null = pane,
	): FakeWatcher | null => {
		published = endpointId ? { endpointId, watcher: new FakeWatcher(next) } : null;
		registry.rebind();
		return published?.watcher ?? null;
	};
	return {
		registry,
		source,
		watcher: published.watcher,
		reconnect: () => publish(LOCAL) as FakeWatcher,
		publish,
	};
}

function filesWith(...pairs: [string, string][]): Map<string, string> {
	return new Map(pairs);
}

describe('SessionModel: the pane’s current transcript', () => {
	it('tails the file its cwd and agent session name, and reduces what it delivers', () => {
		const { registry, source } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));

		const handle = registry.acquire(LOCAL, 'w4:p1');

		expect(source.tails.map((tail) => tail.path)).toEqual([PATH_1]);
		expect(handle.model.path).toBe(PATH_1);
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['First question']);
		expect(handle.model.agentStatus).toBe('idle');
	});

	it('names the turns a rewind dropped in the change it emits (#131)', () => {
		const { registry, source } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		// A prompt hanging from before the first one, with an answer since.
		source.tails[0]?.emit([
			'{"type":"user","message":{"role":"user","content":"Instead"},"uuid":"u9","parentUuid":null}',
		]);

		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['Instead']);
		expect(changes).toEqual([{ changedTurnIds: ['u9'], removedTurnIds: ['u1'], reset: false }]);
	});

	it('has no session yet when the pane has no agent session', () => {
		// A freshly started Claude sits idle with no `agent_session` until its
		// first prompt (docs/architecture.md); the view shows "no session yet".
		const { registry, source } = registryWith(new Map(), { ...PANE, agentSession: '' });

		const handle = registry.acquire(LOCAL, 'w4:p1');

		expect(handle.model.path).toBeNull();
		expect(handle.model.state.turns).toEqual([]);
		expect(source.tails).toEqual([]);
	});

	it('is not loaded while it only knows the path, and is once a line lands', () => {
		// The path comes from herdr's `agent_session` and the lines come from the
		// tail afterwards, so "path known" is not "transcript read": anything
		// that acts on what the state does not hold has to wait for this.
		const { registry, source } = registryWith(new Map());
		const handle = registry.acquire(LOCAL, 'w4:p1');

		expect(handle.model.path).toBe(PATH_1);
		expect(handle.model.loaded).toBe(false);

		source.tails[0]?.emit(TRANSCRIPT_1.split('\n').filter(Boolean));

		expect(handle.model.loaded).toBe(true);
	});

	it('is not loaded again until the rotated session’s first lines land', () => {
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		expect(handle.model.loaded).toBe(true);

		// `/clear`: a new file, of which nothing has been read (ADR-0003).
		watcher.set({ ...PANE, agentSession: 'session-2' });
		watcher.paneUpdated('w4:p1', 'session-2');

		expect(handle.model.path).toBe(PATH_2);
		expect(handle.model.loaded).toBe(false);

		source.tails[1]?.emit(TRANSCRIPT_2.split('\n').filter(Boolean));

		expect(handle.model.loaded).toBe(true);
	});

	it('tells its subscribers which turns each batch of lines changed', () => {
		const { registry, source } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
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
		const handle = registry.acquire(LOCAL, 'w4:p1');
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
		registry.acquire(LOCAL, 'w4:p1');

		// Deduplicated by value: herdr sends about ten pane updates a second.
		watcher.paneUpdated('w4:p1', 'session-1');
		watcher.paneUpdated('w4:p1', 'session-1');
		// Another pane's rotation is none of this model's business.
		watcher.paneUpdated('w4:p2', 'session-9');

		expect(source.tails).toHaveLength(1);
		expect(source.openTails).toHaveLength(1);
	});

	it('passes on why its tail cannot read the file, and forgets it with the file', () => {
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));
		expect(handle.model.readProblem).toBeNull();

		source.tails[0]?.problem('over the limit');
		expect(handle.model.readProblem).toBe('over the limit');
		expect(changes).toEqual([{ changedTurnIds: [], reset: false }]);
		// Said again, unchanged: no news.
		source.tails[0]?.problem('over the limit');
		expect(changes).toHaveLength(1);
		source.tails[0]?.problem(null);
		expect(handle.model.readProblem).toBeNull();

		// Another file starts with no problem, whatever the last one had.
		source.tails[0]?.problem('over the limit');
		watcher.set({ ...PANE, agentSession: 'session-2' });
		watcher.paneUpdated('w4:p1', 'session-2');
		expect(handle.model.path).toBe(PATH_2);
		expect(handle.model.readProblem).toBeNull();
	});

	it('reads the file again on a fresh tail when asked to try again (#146)', () => {
		const { registry, source } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));
		source.tails[0]?.problem('over the limit');
		expect(handle.model.readProblem).toBe('over the limit');
		changes.length = 0;

		handle.model.retryRead();

		expect(source.tails).toHaveLength(2);
		expect(source.tails[0]?.closed).toBe(true);
		expect(source.openTails).toHaveLength(1);
		expect(source.openTails[0]?.path).toBe(PATH_1);
		expect(handle.model.readProblem).toBeNull();
		// The file again from its start: the view draws it whole.
		expect(changes[0]).toEqual({ changedTurnIds: [], reset: true });
		expect(handle.model.state.turns).toHaveLength(1);
	});

	it('leaves a model whose runtime is not connected alone on a retry', () => {
		const { registry, source, publish } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		publish(null);
		const open = source.openTails.length;

		handle.model.retryRead();

		expect(source.openTails).toHaveLength(open);
	});

	it('starts tailing when a fresh Claude’s session id appears', () => {
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]), {
			...PANE,
			agentSession: '',
		});
		const handle = registry.acquire(LOCAL, 'w4:p1');
		expect(handle.model.path).toBeNull();

		watcher.set(PANE);
		watcher.paneUpdated('w4:p1', 'session-1');

		expect(source.tails.map((tail) => tail.path)).toEqual([PATH_1]);
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['First question']);
	});

	it('drops everything when the pane leaves the workspace', () => {
		// Everything is scoped to one workspace (CLAUDE.md). A pane that leaves
		// it is not this vault's any more: the tail closes, the turns go, and the
		// status falls back to "no agent here", which is also what disables the
		// prompt box (#94, #97).
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		watcher.removed('w4:p1');

		expect(source.openTails).toEqual([]);
		expect(handle.model.path).toBeNull();
		expect(handle.model.state.turns).toEqual([]);
		expect(handle.model.agentSession).toBe('');
		expect(handle.model.agentStatus).toBe('unknown');
		expect(changes).toEqual([{ changedTurnIds: [], reset: true }]);
	});

	it('ignores another pane leaving the workspace', () => {
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');

		watcher.removed('w4:p2');

		expect(source.openTails).toHaveLength(1);
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['First question']);
	});

	it('starts following a pane that joins the scope after the model was opened', () => {
		// A reconnect rebinds the models before the fresh scope has primed, so
		// the pane is not there yet; priming then announces it as added (#94).
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]), null);
		const handle = registry.acquire(LOCAL, 'w4:p1');
		expect(handle.model.agentStatus).toBe('unknown');

		watcher.added(PANE);

		expect(source.tails.map((tail) => tail.path)).toEqual([PATH_1]);
		expect(handle.model.agentStatus).toBe('idle');
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['First question']);
	});

	it('empties the view when the pane loses its session', () => {
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');

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
		const handle = registry.acquire(LOCAL, 'w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		watcher.statusChanged('w4:p1', 'working');

		expect(handle.model.agentStatus).toBe('working');
		expect(changes).toEqual([{ changedTurnIds: [], reset: false }]);
	});

	it('grants the block claim once, and again after the block is over (#99)', () => {
		// The claim is the pane's, not a view's: two tabs on one pane hold this
		// same model, and each draws the same waiting card (ADR-0003).
		const { registry, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		const second = registry.acquire(LOCAL, 'w4:p1');
		expect(second.model).toBe(handle.model);

		watcher.statusChanged('w4:p1', 'blocked');
		expect(handle.model.claimBlock('toolu_01XB')).toBe(true);
		expect(second.model.claimBlock('toolu_01XB')).toBe(false);

		// The block ended and another one started: a claim of its own.
		watcher.statusChanged('w4:p1', 'working');
		watcher.statusChanged('w4:p1', 'blocked');
		expect(handle.model.claimBlock('toolu_02YC')).toBe(true);

		handle.release();
		second.release();
	});

	it('grants a claim for the next call while the pane stays blocked (#99)', () => {
		// Claude can move from one permission to the next without herdr's status
		// leaving `blocked`. The claim is one press per block, and the block is
		// which call is dangling, so the next call is a block of its own.
		const { registry, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');

		watcher.statusChanged('w4:p1', 'blocked');
		expect(handle.model.claimBlock('toolu_01XB')).toBe(true);
		expect(handle.model.claimBlock('toolu_01XB')).toBe(false);
		expect(handle.model.claimBlock('toolu_02YC')).toBe(true);

		handle.release();
	});

	it('claims the startup block, which names no call at all (#99)', () => {
		// The trust prompt blocks before any transcript exists, so the block the
		// trust answer is claimed for is the empty one. Once for the pane, and
		// again once the pane has left `blocked`.
		const { registry, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		const second = registry.acquire(LOCAL, 'w4:p1');

		watcher.statusChanged('w4:p1', 'blocked');
		expect(handle.model.claimBlock('')).toBe(true);
		expect(second.model.claimBlock('')).toBe(false);

		watcher.statusChanged('w4:p1', 'working');
		watcher.statusChanged('w4:p1', 'blocked');
		expect(handle.model.claimBlock('')).toBe(true);

		handle.release();
		second.release();
	});

	it('drops the block claim when the session rotates', () => {
		const { registry, watcher } = registryWith(
			filesWith([PATH_1, TRANSCRIPT_1], [PATH_2, TRANSCRIPT_2]),
		);
		const handle = registry.acquire(LOCAL, 'w4:p1');
		watcher.statusChanged('w4:p1', 'blocked');
		expect(handle.model.claimBlock('toolu_01XB')).toBe(true);

		// `/clear` while blocked: another session, so another block.
		watcher.set({ ...PANE, agentSession: 'session-2', agentStatus: 'blocked' });
		watcher.paneUpdated('w4:p1', 'session-2');

		expect(handle.model.claimBlock('toolu_01XB')).toBe(true);
	});

	it('ignores another pane’s status', () => {
		const { registry, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');

		watcher.statusChanged('w4:p2', 'blocked');

		expect(handle.model.agentStatus).toBe('idle');
	});
});

describe('SessionModel: a replaced connection (#94, ADR-0006)', () => {
	it('rebinds to a fresh connection of its own runtime and re-reads the pane', () => {
		// A reconnect replaces the watcher; a model that kept the old
		// subscription would simply stop following.
		const { registry, source, watcher, reconnect } = registryWith(
			filesWith([PATH_1, TRANSCRIPT_1], [PATH_2, TRANSCRIPT_2]),
		);
		const handle = registry.acquire(LOCAL, 'w4:p1');

		const fresh = reconnect();
		// The old connection is gone; anything it says now is ignored.
		expect(watcher.subscribed).toBe(false);
		watcher.set({ ...PANE, agentSession: 'session-2' });
		watcher.paneUpdated('w4:p1', 'session-2');
		expect(handle.model.agentSession).toBe('session-1');

		fresh.set({ ...PANE, agentSession: 'session-2' });
		fresh.paneUpdated('w4:p1', 'session-2');

		expect(handle.model.connected).toBe(true);
		expect(handle.model.agentSession).toBe('session-2');
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['After the clear']);
		expect(source.openTails.map((tail) => tail.path)).toEqual([PATH_2]);
	});

	it('keeps its content and says it is disconnected while another runtime is active', () => {
		const { registry, source, watcher, publish } = registryWith(
			filesWith([PATH_1, TRANSCRIPT_1], [PATH_2, TRANSCRIPT_2]),
		);
		const handle = registry.acquire(LOCAL, 'w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));
		watcher.statusChanged('w4:p1', 'working');
		changes.length = 0;

		// The switch: `xl` has a `w4:p1` of its own, on another session.
		const other = publish(XL, { ...PANE, agentSession: 'session-2' });

		expect(handle.model.connected).toBe(false);
		expect(watcher.subscribed).toBe(false);
		// What it showed stays: still the local pane's session, nothing of xl's.
		expect(handle.model.path).toBe(PATH_1);
		expect(handle.model.agentSession).toBe('session-1');
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['First question']);
		// Nothing is known of the agent now, which is what disables the prompt box.
		expect(handle.model.agentStatus).toBe('unknown');
		expect(changes).toEqual([{ changedTurnIds: [], reset: false }]);
		// The local file is still readable without a connection, so it is still followed.
		expect(source.openTails.map((tail) => tail.path)).toEqual([PATH_1]);

		// xl's pane with the same id is none of this model's business.
		other?.paneUpdated('w4:p1', 'session-2');
		other?.statusChanged('w4:p1', 'blocked');
		expect(handle.model.agentSession).toBe('session-1');
		expect(handle.model.agentStatus).toBe('unknown');
		expect(source.tails.map((tail) => tail.path)).toEqual([PATH_1]);
	});

	it('never shows another runtime’s pane with the same id', () => {
		// A tab pinned to xl opened while local is published: local's `w4:p1`
		// is another pane, and must not be read on xl's behalf.
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const local = registry.acquire(LOCAL, 'w4:p1');
		const remote = registry.acquire(XL, 'w4:p1');

		expect(remote.model).not.toBe(local.model);
		expect(remote.model.connected).toBe(false);
		expect(remote.model.path).toBeNull();
		expect(remote.model.state.turns).toEqual([]);

		watcher.statusChanged('w4:p1', 'working');
		watcher.paneUpdated('w4:p1', 'session-9');
		expect(remote.model.agentStatus).toBe('unknown');
		expect(remote.model.agentSession).toBe('');
		expect(source.tails.map((tail) => tail.path)).toEqual([PATH_1]);
	});

	it('follows its own pane once its runtime is published, and lets go when it is not', () => {
		const { registry, publish } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const remote = registry.acquire(XL, 'w4:p1');

		const xl = publish(XL, { ...PANE, agentStatus: 'working' });
		expect(remote.model.connected).toBe(true);
		expect(remote.model.agentStatus).toBe('working');
		expect(remote.model.state.turns.map((turn) => turn.prompt)).toEqual(['First question']);

		publish(LOCAL);
		expect(remote.model.connected).toBe(false);
		expect(xl?.subscribed).toBe(false);
		expect(remote.model.state.turns.map((turn) => turn.prompt)).toEqual(['First question']);
	});

	it('picks up where it was when its own runtime comes back, on the same tail', () => {
		const { registry, source, publish } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		publish(XL);
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		publish(LOCAL);

		expect(handle.model.connected).toBe(true);
		expect(handle.model.agentStatus).toBe('idle');
		// Same session, same file, same source: nothing to read again.
		expect(source.tails).toHaveLength(1);
		expect(changes).toEqual([{ changedTurnIds: [], reset: false }]);
	});

	it('closes a tail whose source went with the connection, and reads again from the start', () => {
		// A source that needs the runtime's connection (herdr-core over SSH reads
		// with `file.read`, ADR-0006) is none while another runtime is active.
		const files = filesWith([PATH_1, TRANSCRIPT_1]);
		const source = new FakeSource(files);
		let published: { endpointId: string; watcher: FakeWatcher } | null = {
			endpointId: XL,
			watcher: new FakeWatcher(PANE),
		};
		const registry = new SessionModelRegistry({
			watcher: (id) => (published?.endpointId === id ? published.watcher : null),
			source: (id) => (published?.endpointId === id ? source : null),
			home: '/home/lasse',
		});
		const handle = registry.acquire(XL, 'w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		published = null;
		registry.rebind();
		expect(source.openTails).toEqual([]);
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['First question']);

		published = { endpointId: XL, watcher: new FakeWatcher(PANE) };
		registry.rebind();
		expect(source.openTails.map((tail) => tail.path)).toEqual([PATH_1]);
		// Read again whole, so not appended to what was already there.
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['First question']);
		expect(changes.some((change) => change.reset)).toBe(true);
	});

	it('reports a status that moved across the rebind, on the same session', () => {
		const { registry, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		watcher.set({ ...PANE, agentStatus: 'working' });
		registry.rebind();

		expect(handle.model.agentStatus).toBe('working');
		expect(changes).toEqual([{ changedTurnIds: [], reset: false }]);
	});
});

describe('SessionModel: what the runtime says beyond herdr (ADR-0006)', () => {
	it('carries the block kind a runtime reports, and drops it when the block ends', () => {
		const { registry, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		expect(handle.model.blockKind).toBeNull();

		watcher.statusChanged('w4:p1', 'blocked', 'auth');
		expect(handle.model.blockKind).toBe('auth');
		// The kind moving inside one block is news too.
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));
		watcher.statusChanged('w4:p1', 'blocked', 'permission');
		expect(handle.model.blockKind).toBe('permission');
		expect(changes).toHaveLength(1);

		watcher.statusChanged('w4:p1', 'working', 'permission');
		expect(handle.model.blockKind).toBeNull();
	});

	it('reads the block kind off the snapshot too, as after a rebind', () => {
		const { registry } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]), {
			...PANE,
			agentStatus: 'blocked',
			blockKind: 'trust',
		});
		expect(registry.acquire(LOCAL, 'w4:p1').model.blockKind).toBe('trust');
	});

	it('tails the path the runtime names rather than deriving one', () => {
		const named = '/srv/claude/projects/x/session-1.jsonl';
		const { registry, source } = registryWith(filesWith([named, TRANSCRIPT_1]), {
			...PANE,
			transcriptPath: named,
		});
		const handle = registry.acquire(LOCAL, 'w4:p1');

		expect(handle.model.path).toBe(named);
		expect(source.tails.map((tail) => tail.path)).toEqual([named]);
	});

	it('follows a new path even when the session id stays the same', () => {
		// A resumed or forked session can keep its id and move its file; a model
		// that only compared ids would go on tailing the old one.
		const moved = '/srv/claude/projects/y/session-1.jsonl';
		const { registry, source, watcher } = registryWith(
			filesWith([PATH_1, TRANSCRIPT_1], [moved, TRANSCRIPT_2]),
		);
		const handle = registry.acquire(LOCAL, 'w4:p1');

		watcher.set({ ...PANE, transcriptPath: moved });
		watcher.paneUpdated('w4:p1', 'session-1', moved);

		expect(handle.model.path).toBe(moved);
		expect(source.openTails.map((tail) => tail.path)).toEqual([moved]);
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['After the clear']);
	});

	it('starts over when the tail says the file was replaced under it', () => {
		const { registry, source } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		source.tails[0]?.restart(TRANSCRIPT_2.split('\n').filter(Boolean));

		// The old file's turns are gone, not merged with the new file's.
		expect(handle.model.state.turns.map((turn) => turn.prompt)).toEqual(['After the clear']);
		expect(changes).toEqual([{ changedTurnIds: [], reset: true }]);
		// Same path, same tail: the replacement is the tail's to read.
		expect(source.tails).toHaveLength(1);
	});

	it('drops the block claim when the file is replaced', () => {
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		watcher.statusChanged('w4:p1', 'blocked');
		expect(handle.model.claimBlock('')).toBe(true);

		source.tails[0]?.restart([]);

		expect(handle.model.claimBlock('')).toBe(true);
	});
});

describe('SessionModelRegistry: one model per pane', () => {
	it('gives two subscribers the same model, one tail, and closes it on the last release', () => {
		const { registry, source } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));

		const first = registry.acquire(LOCAL, 'w4:p1');
		const second = registry.acquire(LOCAL, 'w4:p1');
		expect(second.model).toBe(first.model);
		expect(source.tails).toHaveLength(1);

		first.release();
		// One leaf closed, the other still watching: the model and its tail stay.
		expect(registry.has(LOCAL, 'w4:p1')).toBe(true);
		expect(source.openTails).toHaveLength(1);

		second.release();
		expect(registry.has(LOCAL, 'w4:p1')).toBe(false);
		expect(source.openTails).toEqual([]);
		// Opening the pane again starts a model of its own.
		expect(registry.acquire(LOCAL, 'w4:p1').model).not.toBe(first.model);
	});

	it('ignores a second release from the same handle', () => {
		const { registry } = registryWith(new Map());
		const handle = registry.acquire(LOCAL, 'w4:p1');
		const other = registry.acquire(LOCAL, 'w4:p1');

		handle.release();
		handle.release();

		expect(registry.has(LOCAL, 'w4:p1')).toBe(true);
		other.release();
		expect(registry.has(LOCAL, 'w4:p1')).toBe(false);
	});

	it('gives different panes different models', () => {
		const { registry } = registryWith(new Map());

		expect(registry.acquire(LOCAL, 'w4:p1').model).not.toBe(registry.acquire(LOCAL, 'w4:p2').model);
	});

	it('gives the same pane id on two runtimes two models, released apart', () => {
		const { registry } = registryWith(new Map());
		const local = registry.acquire(LOCAL, 'w4:p1');
		const remote = registry.acquire(XL, 'w4:p1');

		expect(remote.model).not.toBe(local.model);
		local.release();
		expect(registry.has(LOCAL, 'w4:p1')).toBe(false);
		expect(registry.has(XL, 'w4:p1')).toBe(true);
	});

	it('closes every tail on dispose', () => {
		const { registry, source } = registryWith(filesWith([PATH_1, TRANSCRIPT_1]));
		registry.acquire(LOCAL, 'w4:p1');

		registry.dispose();

		expect(source.openTails).toEqual([]);
		expect(registry.has(LOCAL, 'w4:p1')).toBe(false);
	});
});

describe('SessionModel: a background subagent’s report (#96)', () => {
	it('reads the report out of the file the notification named and feeds it back with the turn it changed', async () => {
		const { registry, source } = registryWith(
			filesWith([PATH_1, LAUNCHED], [OUTPUT_FILE, SUBAGENT_TRANSCRIPT]),
		);
		const handle = registry.acquire(LOCAL, 'w4:p1');
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
		const handle = registry.acquire(LOCAL, 'w4:p1');

		await vi.waitFor(() => expect(reportOf(handle.model)).not.toBeNull());

		expect(source.reads).toEqual([OUTPUT_FILE, SUBAGENT_FILE]);
		expect(reportOf(handle.model)).toBe('The styles are **fine**.');
	});

	it('discards a report whose session rotated before the read resolved', async () => {
		const { registry, source, watcher } = registryWith(
			filesWith([PATH_1, LAUNCHED], [OUTPUT_FILE, SUBAGENT_TRANSCRIPT], [PATH_2, TRANSCRIPT_2]),
		);
		source.hold = true;
		const handle = registry.acquire(LOCAL, 'w4:p1');
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

describe('SessionModel: background work the agent left behind (#135)', () => {
	/** A turn whose background command is still running when it ends. */
	const RUNNING = [
		'{"type":"user","message":{"role":"user","content":"Start the slow check"},"uuid":"u1"}',
		'{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"toolu_b1","name":"Bash","input":{"command":"sleep 600","run_in_background":true}}]},"uuid":"a1"}',
		'{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_b1","content":"Command running in background with ID: b1. Output is being written to: /tmp/b1.output"}]},"uuid":"r1","parentUuid":"a1"}',
		'',
	].join('\n');

	function statusOf(model: { state: { turns: { entries: unknown[] }[] } }, id: string): string | undefined {
		for (const turn of model.state.turns) {
			for (const entry of turn.entries) {
				const tool = entry as { kind: string; id?: string; status?: string };
				if (tool.kind === 'tool' && tool.id === id) return tool.status;
			}
		}
		return undefined;
	}

	it('marks it lost once the runtime says the agent stopped, and says so', () => {
		const { registry, watcher } = registryWith(filesWith([PATH_1, RUNNING]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		expect(statusOf(handle.model, 'toolu_b1')).toBe('running');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		// The `claude` kind keeps a stopped agent's session on show.
		watcher.set({ ...PANE, stopped: true });
		watcher.statusChanged('w4:p1', 'idle');

		expect(statusOf(handle.model, 'toolu_b1')).toBe('lost');
		expect(changes).toEqual([{ changedTurnIds: ['u1'], reset: false }]);
	});

	it('marks lost what the earlier run left running when Claude resumes the session, and nothing after', () => {
		// herdr and herdr-core drop the session when the agent exits: the view
		// empties, and `--resume` brings the same file back.
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, RUNNING]));
		const handle = registry.acquire(LOCAL, 'w4:p1');

		watcher.set({ ...PANE, agentSession: '' });
		watcher.paneUpdated('w4:p1', '');
		expect(handle.model.state.turns).toEqual([]);

		source.files.set(
			PATH_1,
			RUNNING +
				[
					'{"type":"user","message":{"role":"user","content":"Again"},"uuid":"u2","parentUuid":"r1"}',
					'{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"tool_use","id":"toolu_b2","name":"Bash","input":{"command":"sleep 5","run_in_background":true}}]},"uuid":"a2"}',
					'{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_b2","content":"Command running in background with ID: b2."}]},"uuid":"r2","parentUuid":"a2"}',
					'',
				].join('\n'),
		);
		watcher.set(PANE);
		watcher.paneUpdated('w4:p1', 'session-1');

		expect(statusOf(handle.model, 'toolu_b1')).toBe('lost');
		expect(statusOf(handle.model, 'toolu_b2')).toBe('running');
	});

	it('leaves running work running across a reconnect to the same session', () => {
		const { registry, reconnect } = registryWith(filesWith([PATH_1, RUNNING]));
		const handle = registry.acquire(LOCAL, 'w4:p1');

		reconnect();

		expect(statusOf(handle.model, 'toolu_b1')).toBe('running');
	});

	it('leaves it running across a reconnect whose scope primes the pane after the rebind', () => {
		// herdr and herdr-core: the fresh scope is empty when the registry
		// rebinds, and the pane arrives as added once it has primed.
		const { registry, publish } = registryWith(filesWith([PATH_1, RUNNING]));
		const handle = registry.acquire(LOCAL, 'w4:p1');

		const fresh = publish(LOCAL, null) as FakeWatcher;
		fresh.added(PANE);

		expect(statusOf(handle.model, 'toolu_b1')).toBe('running');
	});

	it('leaves it running when the pane leaves the scope and comes back', () => {
		const { registry, watcher } = registryWith(filesWith([PATH_1, RUNNING]));
		const handle = registry.acquire(LOCAL, 'w4:p1');

		watcher.removed('w4:p1');
		watcher.added(PANE);

		expect(statusOf(handle.model, 'toolu_b1')).toBe('running');
	});

	it('still marks it lost when the session rotated away and Claude resumed it', () => {
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, RUNNING], [PATH_2, TRANSCRIPT_2]));
		const handle = registry.acquire(LOCAL, 'w4:p1');

		// `/clear` moved the agent to another file, then `--resume` came back.
		watcher.set({ ...PANE, agentSession: 'session-2' });
		watcher.paneUpdated('w4:p1', 'session-2');
		expect(handle.model.path).toBe(PATH_2);
		source.files.set(PATH_1, RUNNING);
		watcher.set(PANE);
		watcher.paneUpdated('w4:p1', 'session-1');

		expect(statusOf(handle.model, 'toolu_b1')).toBe('lost');
	});
});

describe('SessionModel: the plan file of a pane in plan approval (#148)', () => {
	/** Where Claude writes the plan of PATH_1's session, by its slug. */
	const planOf = (slug: string): string => `/home/lasse/.claude/plans/${slug}.md`;
	/** The lines 2.1.286 writes up to its plan approval: plan mode entered, the slug on every line. */
	const planning = (slug: string): string =>
		[
			'{"type":"permission-mode","permissionMode":"auto","sessionId":"session-1"}',
			'{"type":"user","message":{"role":"user","content":"Plan it"},"uuid":"u1","permissionMode":"auto"}',
			`{"type":"attachment","attachment":{"type":"plan_mode","planFilePath":"${planOf(slug)}","planExists":false},"slug":"${slug}"}`,
			`{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Planning."}]},"uuid":"a1","slug":"${slug}"}`,
			'',
		].join('\n');
	/** Lets the read the model started land. */
	const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

	it('reads the plan file the slug names when the pane blocks in plan mode', async () => {
		const { registry, source, watcher } = registryWith(
			filesWith([PATH_1, planning('mellow-purring-pike')], [planOf('mellow-purring-pike'), '# Plan\n\n1. Step one\n']),
		);
		const handle = registry.acquire(LOCAL, 'w4:p1');
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));
		expect(handle.model.plan).toBeNull();

		watcher.statusChanged('w4:p1', 'blocked');
		await settle();
		expect(source.reads).toEqual([planOf('mellow-purring-pike')]);
		expect(handle.model.plan).toBe('# Plan\n\n1. Step one\n');
		// The status, then the plan once it was read.
		expect(changes).toHaveLength(2);

		// The block is over: the plan goes, and the next block reads it again,
		// since a rejected plan comes back revised.
		watcher.statusChanged('w4:p1', 'working');
		expect(handle.model.plan).toBeNull();
		watcher.statusChanged('w4:p1', 'blocked');
		await settle();
		expect(source.reads).toHaveLength(2);
		expect(handle.model.plan).toBe('# Plan\n\n1. Step one\n');
		handle.release();
	});

	it('reads it for a block the runtime calls a permission, as herdr-core may', async () => {
		const { registry, watcher } = registryWith(filesWith([PATH_1, planning('a-slug')], [planOf('a-slug'), 'Plan']));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		watcher.statusChanged('w4:p1', 'blocked', 'permission');
		await settle();
		expect(handle.model.plan).toBe('Plan');
		handle.release();
	});

	it('follows the session to its new slug', async () => {
		const files = filesWith([PATH_1, planning('old-slug')], [planOf('old-slug'), 'old'], [planOf('new-slug'), 'new']);
		const { registry, source, watcher } = registryWith(files);
		const handle = registry.acquire(LOCAL, 'w4:p1');
		watcher.statusChanged('w4:p1', 'blocked');
		await settle();
		expect(handle.model.plan).toBe('old');

		source.openTails[0]?.emit([
			'{"type":"assistant","message":{"id":"m2","role":"assistant","content":[]},"uuid":"a2","slug":"new-slug"}',
		]);
		await settle();
		expect(source.reads.at(-1)).toBe(planOf('new-slug'));
		expect(handle.model.plan).toBe('new');
		handle.release();
	});

	it('reads the plan once the lines saying plan mode land after the block', async () => {
		const { registry, source, watcher } = registryWith(
			filesWith([PATH_1, TRANSCRIPT_1], [planOf('late-slug'), 'Late plan']),
		);
		const handle = registry.acquire(LOCAL, 'w4:p1');
		watcher.statusChanged('w4:p1', 'blocked');
		await settle();
		expect(source.reads).toEqual([]);

		source.openTails[0]?.emit(planning('late-slug').split('\n').filter(Boolean));
		await settle();
		expect(handle.model.plan).toBe('Late plan');
		handle.release();
	});

	it('never reads outside the plans folder', async () => {
		const { registry, source, watcher } = registryWith(
			filesWith(
				[PATH_1, planning('fine-slug').replace(/fine-slug/g, '../../secret')],
				['/home/lasse/secret.md', 'not a plan'],
			),
		);
		const handle = registry.acquire(LOCAL, 'w4:p1');
		watcher.statusChanged('w4:p1', 'blocked');
		await settle();
		expect(source.reads).toEqual([]);
		expect(handle.model.plan).toBeNull();
		handle.release();
	});

	it('reads nothing once plan mode is over', async () => {
		const done = `${planning('a-slug')}{"type":"attachment","attachment":{"type":"plan_mode_exit"},"slug":"a-slug"}\n`;
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, done], [planOf('a-slug'), 'Stale plan']));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		watcher.statusChanged('w4:p1', 'blocked');
		await settle();
		expect(source.reads).toEqual([]);
		expect(handle.model.plan).toBeNull();
		handle.release();
	});

	it('reads nothing for a block the runtime names a question', async () => {
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, planning('a-slug')], [planOf('a-slug'), 'Plan']));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		watcher.statusChanged('w4:p1', 'blocked', 'question');
		await settle();
		expect(source.reads).toEqual([]);
		expect(handle.model.plan).toBeNull();
		handle.release();
	});

	it('has no plan when the file is missing or blank', async () => {
		const { registry, source, watcher } = registryWith(filesWith([PATH_1, planning('no-file')]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		watcher.statusChanged('w4:p1', 'blocked');
		await settle();
		expect(source.reads).toEqual([planOf('no-file')]);
		expect(handle.model.plan).toBeNull();
		handle.release();

		const blank = registryWith(filesWith([PATH_1, planning('blank')], [planOf('blank'), '  \n']));
		const other = blank.registry.acquire(LOCAL, 'w4:p1');
		blank.watcher.statusChanged('w4:p1', 'blocked');
		await settle();
		expect(other.model.plan).toBeNull();
		other.release();
	});

	it('drops a read that lands after the block ended', async () => {
		const { registry, source, watcher } = registryWith(
			filesWith([PATH_1, planning('slow-slug')], [planOf('slow-slug'), 'Slow plan']),
		);
		const handle = registry.acquire(LOCAL, 'w4:p1');
		source.hold = true;
		watcher.statusChanged('w4:p1', 'blocked');
		watcher.statusChanged('w4:p1', 'working');
		source.release();
		await settle();
		expect(handle.model.plan).toBeNull();
		handle.release();
	});
});

describe('SessionModel: what the runtime says of the session (#160)', () => {
	const WITH_MODEL = [
		'{"type":"user","permissionMode":"default","message":{"role":"user","content":"Go"},"uuid":"u1"}',
		'{"type":"attachment","uuid":"m1","attachment":{"type":"model","identity":{"modelId":"claude-opus-5-5","marketingName":"Opus 5.5"}}}',
		'{"type":"assistant","effort":"high","message":{"id":"m-u1","model":"claude-opus-5-5","role":"assistant","content":[{"type":"text","text":"Done."}],"usage":{"input_tokens":2,"cache_creation_input_tokens":8,"cache_read_input_tokens":90,"output_tokens":4}},"uuid":"a-u1"}',
		'',
	].join('\n');

	it('lays the runtime’s word over the reading per field, and emits when only it moved', () => {
		const { registry, watcher } = registryWith(filesWith([PATH_1, WITH_MODEL]));
		const handle = registry.acquire(LOCAL, 'w4:p1');
		expect(handle.model.sessionInfo).toEqual({
			model: { id: 'claude-opus-5-5', label: 'Opus 5.5' },
			effort: 'high',
			permissionMode: 'default',
			contextUsed: 100,
			usage: { input: 100, output: 4, cached: 90 },
		});
		const changes: SessionChange[] = [];
		handle.model.on((change) => changes.push(change));

		watcher.set({
			...PANE,
			sessionInfo: {
				model: { id: 'claude-opus-5-5', label: 'claude-opus-5-5' },
				permissionMode: 'plan',
				contextWindow: { tokens: 1000000, source: 'runtime' },
			},
		});
		watcher.infoChanged('w4:p1');
		expect(changes).toEqual([{ changedTurnIds: [], reset: false }]);
		// The process knows the id only; the name the transcript gave stays.
		expect(handle.model.sessionInfo).toMatchObject({
			model: { id: 'claude-opus-5-5', label: 'Opus 5.5' },
			effort: 'high',
			permissionMode: 'plan',
			contextWindow: { tokens: 1000000, source: 'runtime' },
		});

		// The same overlay again, or another pane's, is nothing to tell.
		watcher.infoChanged('w4:p1');
		watcher.infoChanged('w9:p9');
		expect(changes).toHaveLength(1);

		// Another model from the process wins, by its id until a record names it.
		watcher.set({ ...PANE, sessionInfo: { model: { id: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5' } } });
		watcher.infoChanged('w4:p1');
		expect(handle.model.sessionInfo.model).toEqual({ id: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5' });
		expect(handle.model.sessionInfo.permissionMode).toBe('default');
		handle.release();
	});
});
