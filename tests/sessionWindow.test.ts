/**
 * A long session held a page at a time (issue #152): the session model holds
 * its newest turns within a page of turns and bytes, names the earlier ones,
 * and loads another page on request by reading the file again beside its
 * tail, then taking that read's place. Driven through a fake source whose
 * tails deliver when the test says, so a load can be caught mid-read.
 */

import { describe, expect, it } from 'vitest';
import { SessionModelRegistry, type PaneSnapshot, type SessionChange, type SessionWatcher } from '../src/native/sessionModel';
import { earlierTurnCount, type ToolEntry } from '../src/native/conversation';
import type { TailOptions, TranscriptLines, TranscriptSource, TranscriptStream } from '../src/native/transcriptSource';

const PATH = '/home/lasse/.claude/projects/-home-lasse-hvelv/session-1.jsonl';

class Tail implements TranscriptStream {
	closed = false;
	constructor(
		private readonly onLines: TranscriptLines,
		readonly options: TailOptions = {},
	) {}
	emit(lines: string[], restart = false): void {
		if (!this.closed) this.onLines(lines, restart);
	}
	close(): void {
		this.closed = true;
	}
}

/** A source over one growing file. A tail delivers the file as it opens unless `defer` is set. */
class Source implements TranscriptSource {
	lines: string[] = [];
	readonly tails: Tail[] = [];
	defer = false;
	readonly reads: string[] = [];
	files = new Map<string, string>();
	async read(path: string): Promise<string | null> {
		this.reads.push(path);
		return this.files.get(path) ?? null;
	}
	open(_path: string, onLines: TranscriptLines, options?: TailOptions): TranscriptStream {
		const tail = new Tail(onLines, options);
		this.tails.push(tail);
		if (!this.defer) tail.emit([...this.lines]);
		return tail;
	}
	/** The file grows: every open tail hears it. */
	append(lines: string[]): void {
		this.lines.push(...lines);
		for (const tail of this.tails) tail.emit(lines);
	}
	get open_(): Tail[] {
		return this.tails.filter((tail) => !tail.closed);
	}
}

const PANE: PaneSnapshot = {
	paneId: 'w4:p1',
	cwd: '/home/lasse/hvelv',
	agentSession: 'session-1',
	agentStatus: 'idle',
	transcriptPath: PATH,
};

function watcher(): SessionWatcher {
	return {
		snapshot: (paneId) => (paneId === PANE.paneId ? PANE : null),
		onSession: () => () => {},
		onStatus: () => () => {},
		onMembership: () => () => {},
	};
}

/** One turn: a prompt and its answer, `n` in the session. */
function turn(n: number, answer = `Answer ${n}.`): string[] {
	return [
		`{"type":"user","message":{"role":"user","content":"Question ${n}"},"uuid":"u${n}","parentUuid":${n === 1 ? 'null' : `"a${n - 1}"`}}`,
		`{"type":"assistant","message":{"id":"m${n}","role":"assistant","content":[{"type":"text","text":${JSON.stringify(answer)}}]},"uuid":"a${n}","parentUuid":"u${n}"}`,
	];
}

function turns(from: number, to: number): string[] {
	const lines: string[] = [];
	for (let n = from; n <= to; n++) lines.push(...turn(n));
	return lines;
}

function setup(page = { turns: 3, bytes: Infinity }) {
	const source = new Source();
	const registry = new SessionModelRegistry({ watcher: () => watcher(), source: () => source, home: '/home/lasse', page });
	return { source, registry };
}

const ids = (model: { state: { turns: { id: string }[] } }): string[] => model.state.turns.map((t) => t.id);

describe('SessionModel: a page of a long session (#152)', () => {
	it('holds the newest page of turns and counts the earlier ones', () => {
		const { source, registry } = setup();
		source.lines = turns(1, 10);
		const { model } = registry.acquire('local', PANE.paneId);
		expect(ids(model)).toEqual(['u8', 'u9', 'u10']);
		expect(earlierTurnCount(model.state)).toBe(7);
		// A live turn drops the earliest held, and says so as a removal.
		const changes: SessionChange[] = [];
		model.on((change) => changes.push(change));
		source.append(turn(11));
		expect(ids(model)).toEqual(['u9', 'u10', 'u11']);
		expect(changes.at(-1)).toEqual({ changedTurnIds: ['u11'], removedTurnIds: ['u8'], reset: false });
		expect(earlierTurnCount(model.state)).toBe(8);
	});

	it('holds by bytes too, never less than the newest turn', () => {
		const { source, registry } = setup({ turns: 100, bytes: 600 });
		source.lines = [...turns(1, 4), ...turn(5, 'x'.repeat(2000))];
		const { model } = registry.acquire('local', PANE.paneId);
		expect(ids(model)).toEqual(['u5']);
		expect(earlierTurnCount(model.state)).toBe(4);
	});

	it('loads earlier turns beside the tail, and takes its place once caught up', () => {
		const { source, registry } = setup();
		source.lines = turns(1, 10);
		const { model } = registry.acquire('local', PANE.paneId);
		const changes: SessionChange[] = [];
		model.on((change) => changes.push(change));
		const first = source.tails[0] as Tail;

		source.defer = true;
		model.loadEarlier();
		expect(model.loadingEarlier).toBe(true);
		expect(changes.at(-1)).toEqual({ changedTurnIds: [], reset: false });
		// A second request while one reads is the same request.
		model.loadEarlier();
		expect(source.tails).toHaveLength(2);
		const side = source.tails[1] as Tail;

		// The session moves on while the earlier read is behind: the tail still follows it.
		source.lines.push(...turn(11));
		first.emit(turn(11));
		expect(ids(model)).toEqual(['u9', 'u10', 'u11']);
		// The read catches up part of the way, and nothing is swapped yet.
		side.emit(turns(1, 6));
		expect(model.loadingEarlier).toBe(true);
		expect(ids(model)).toEqual(['u9', 'u10', 'u11']);
		side.emit([...turns(7, 10), ...turn(11)]);

		expect(model.loadingEarlier).toBe(false);
		expect(ids(model)).toEqual(['u6', 'u7', 'u8', 'u9', 'u10', 'u11']);
		expect(earlierTurnCount(model.state)).toBe(5);
		expect(changes.at(-1)).toEqual({ changedTurnIds: [], reset: true, earlier: true });
		// One tail follows the file now: the read that caught up.
		expect(first.closed).toBe(true);
		expect(source.open_).toEqual([side]);
		source.append(turn(12));
		expect(ids(model)).toEqual(['u7', 'u8', 'u9', 'u10', 'u11', 'u12']);
	});

	it('loads at once from a source that delivers as it opens, and stops when all is held', () => {
		const { source, registry } = setup();
		source.lines = turns(1, 5);
		const { model } = registry.acquire('local', PANE.paneId);
		model.loadEarlier();
		expect(model.loadingEarlier).toBe(false);
		expect(ids(model)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
		expect(earlierTurnCount(model.state)).toBe(0);
		model.loadEarlier();
		expect(source.tails).toHaveLength(2);
	});

	it('gives the page back when the file is replaced under the earlier read', () => {
		const { source, registry } = setup();
		source.lines = turns(1, 10);
		const { model } = registry.acquire('local', PANE.paneId);
		source.defer = true;
		model.loadEarlier();
		const side = source.tails[1] as Tail;
		side.emit(turns(1, 2), true);
		expect(model.loadingEarlier).toBe(false);
		expect(side.closed).toBe(true);
		expect(ids(model)).toEqual(['u8', 'u9', 'u10']);
	});

	it('reads the file again from one page when the tail restarts', () => {
		const { source, registry } = setup();
		source.lines = turns(1, 10);
		const { model } = registry.acquire('local', PANE.paneId);
		model.loadEarlier();
		expect(ids(model)).toHaveLength(6);
		(source.tails[1] as Tail).emit(turns(1, 10), true);
		expect(ids(model)).toEqual(['u8', 'u9', 'u10']);
	});

	it('a rewind past what is held drops every turn after it, held or not', () => {
		const { source, registry } = setup();
		source.lines = turns(1, 10);
		const { model } = registry.acquire('local', PANE.paneId);
		// A prompt hanging from turn 2's answer: Esc Esc back to turn 2.
		source.append([
			'{"type":"user","message":{"role":"user","content":"Again from two"},"uuid":"r1","parentUuid":"a2"}',
		]);
		expect(ids(model)).toEqual(['r1']);
		expect(earlierTurnCount(model.state)).toBe(2);
		model.loadEarlier();
		expect(ids(model)).toEqual(['u1', 'u2', 'r1']);
	});

	it('carries the reports it read onto the calls the larger page still holds', async () => {
		const { source, registry } = setup({ turns: 1, bytes: Infinity });
		const output = '/tmp/claude-1000/-home-lasse-hvelv/session-1/tasks/a1f2.output';
		const notification = [
			'<task-notification>',
			'<task-id>a1f2</task-id>',
			'<tool-use-id>toolu_a1</tool-use-id>',
			`<output-file>${output}</output-file>`,
			'<status>completed</status>',
			'</task-notification>',
		].join('\n');
		source.files.set(
			output,
			'{"type":"assistant","message":{"id":"s1","role":"assistant","content":[{"type":"text","text":"Report."}]}}\n',
		);
		source.lines = [
			...turns(1, 2),
			'{"type":"user","message":{"role":"user","content":"Start the job"},"uuid":"u3","parentUuid":"a2"}',
			'{"type":"assistant","message":{"id":"m3","role":"assistant","content":[{"type":"tool_use","id":"toolu_a1","name":"Agent","input":{"description":"Job"}}]},"uuid":"a3","parentUuid":"u3"}',
			`{"type":"queue-operation","operation":"enqueue","content":${JSON.stringify(notification)}}`,
		];
		const { model } = registry.acquire('local', PANE.paneId);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const call = (): ToolEntry | undefined =>
			model.state.turns.flatMap((t) => t.entries).find((e): e is ToolEntry => e.kind === 'tool');
		expect(call()?.report).toBe('Report.');
		const reads = source.reads.length;
		model.loadEarlier();
		expect(ids(model)).toEqual(['u2', 'u3']);
		expect(call()?.report).toBe('Report.');
		// Carried, not read again.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(source.reads.length).toBe(reads);
	});
});
