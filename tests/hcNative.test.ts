/**
 * The native view on herdr-core (ADR-0006): the session watcher over the
 * Claude hook's label with the foreground pid check, the transcript source
 * over `file.read` for an SSH runtime, the kind's native adapter and its
 * per-pane gate, and a session model driven end to end over a fake
 * `hc connect`.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConnectionCoordinator, endpointOf, type Connection } from '../src/connection';
import type { HcClient, HcTimers } from '../src/hc/client';
import { HcError } from '../src/hc/connection';
import { hcKeySender, hcPromptSender } from '../src/hc/actions';
import { HcScope } from '../src/hc/scope';
import {
	hcSessionWatcher,
	NATIVE_NO_CLAUDE_REASON,
	NATIVE_NO_LABEL_REASON,
	SESSION_HOOK_COMMAND_NAME,
} from '../src/hc/sessionWatcher';
import { HcTranscriptSource } from '../src/hc/transcriptSource';
import { HcCommandCatalog } from '../src/hc/commandCatalog';
import { BUILTIN_CATALOG_SOURCE } from '../src/native/commandCatalog';
import type { HcTerminal } from '../src/hc/model';
import type { HcEvent } from '../src/hc/streams';
import { createHerdrCoreKind } from '../src/runtime/herdrCoreKind';
import { HERDR_CORE_CAPABILITIES, nativeViewBlock, type RuntimeKindAdapter } from '../src/runtime/kind';
import { newRuntime, type RuntimeConfig } from '../src/runtimes';
import { SESSION_LABEL_KEY } from '../src/sessionHook/label';
import { LocalTranscriptSource } from '../src/native/transcriptSource';
import { SessionModelRegistry } from '../src/native/sessionModel';
import { paneViewAvailability } from '../src/native/surface';
import { fakeSpawner, fileLines, RpcError, settle, type FakeCore } from './fixtures/fakeHc';

/** Timers fired by hand, by their delay. */
function manualTimers() {
	const pending = new Map<number, { callback: () => void; ms: number }>();
	let next = 1;
	const timers: HcTimers = {
		set: (callback, ms) => {
			const id = next++;
			pending.set(id, { callback, ms });
			return id;
		},
		clear: (handle) => {
			pending.delete(handle as number);
		},
	};
	const fire = (ms: number): number => {
		let fired = 0;
		for (const [id, entry] of [...pending]) {
			if (entry.ms !== ms) continue;
			pending.delete(id);
			entry.callback();
			fired++;
		}
		return fired;
	};
	const delays = (): number[] => [...pending.values()].map((entry) => entry.ms).sort((a, b) => a - b);
	return { timers, fire, delays };
}

const CWD = '/root/vault/notes';
const PATH_1 = '/root/.claude/projects/-root-vault-notes/s-1.jsonl';
const PATH_2 = '/root/.claude/projects/-root-vault-notes/s-2.jsonl';

function label(session: string, pid: number, transcript: string): Record<string, string> {
	return { [SESSION_LABEL_KEY]: JSON.stringify({ v: 1, session, pid, transcript }) };
}

/** A Terminal record as hc sends it: Claude in the foreground at pid 4242. */
function terminal(address: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		address,
		argv: ['bash'],
		cwd: CWD,
		state: 'live',
		labels: {},
		foreground: { name: 'claude', argv: ['claude'], cwd: CWD, pid: 4242 },
		status: { state: 'idle', app: 'claude-code' },
		reported: true,
		turn: 0,
		title: '',
		...extra,
	};
}

/** An `HcScope` in cwd mode over the remote vault, fed by hand. */
function scopeWith(...terminals: Record<string, unknown>[]): { scope: HcScope; send: (type: string, address: string, data: unknown) => void } {
	const scope = new HcScope({ space: '', vaultPath: '/home/lasse/hvelv', vaultName: 'hvelv', remoteVaultPath: '/root/vault' });
	scope.setSpaces([]);
	scope.reset(10, terminals);
	let seq = 10;
	return {
		scope,
		send: (type, address, data) => {
			const event: HcEvent = { seq: ++seq, type, terminal: address, data };
			scope.ingest(event);
		},
	};
}

describe('the herdr-core session watcher (ADR-0006)', () => {
	it('takes the label only while its pid is the terminal’s foreground pid', () => {
		const { scope, send } = scopeWith(terminal('t1', { foreground: { name: 'bash', argv: ['bash'], cwd: CWD, pid: 100 } }));
		const watcher = hcSessionWatcher(scope);
		const seen: [string, string, string | undefined, string | undefined][] = [];
		watcher.onSession((paneId, session, path) =>
			// What the model does: re-read the snapshot inside the handler.
			seen.push([paneId, session, path, watcher.snapshot(paneId)?.transcriptPath]),
		);

		// The hook ran before the foreground poll saw Claude: not yet.
		send('labels', 't1', { labels: label('s-1', 4242, PATH_1) });
		expect(watcher.snapshot('t1')?.agentSession).toBe('');
		expect(seen).toEqual([]);
		// It reported itself as Claude, so what is missing is a label it owns.
		expect(watcher.unavailable?.('t1')).toBe(NATIVE_NO_LABEL_REASON);

		// Then it did, and the label holds.
		send('foreground', 't1', { name: 'claude', argv: ['claude'], cwd: CWD, pid: 4242 });
		expect(seen).toEqual([['t1', 's-1', PATH_1, PATH_1]]);
		expect(watcher.snapshot('t1')).toMatchObject({ agentSession: 's-1', transcriptPath: PATH_1, cwd: CWD });
		expect(watcher.unavailable?.('t1')).toBeNull();
	});

	it('clears the session when Claude goes, and takes it back when it returns', () => {
		const { scope, send } = scopeWith(terminal('t1', { labels: label('s-1', 4242, PATH_1) }));
		const watcher = hcSessionWatcher(scope);
		const seen: string[] = [];
		watcher.onSession((_paneId, session) => seen.push(session));
		expect(watcher.snapshot('t1')?.agentSession).toBe('s-1');

		// Ctrl-G hands the terminal to an editor: not Claude's foreground now.
		send('foreground', 't1', { name: 'vim', argv: ['vim'], cwd: CWD, pid: 5000 });
		expect(seen).toEqual(['']);
		send('foreground', 't1', { name: 'claude', argv: ['claude'], cwd: CWD, pid: 4242 });
		expect(seen).toEqual(['', 's-1']);

		// Claude exits: the label stays behind, its pid with nobody.
		send('status', 't1', { status: null, reported: true });
		send('foreground', 't1', { name: 'bash', argv: ['bash'], cwd: CWD, pid: 100 });
		expect(seen).toEqual(['', 's-1', '']);
		expect(watcher.unavailable?.('t1')).toBe(NATIVE_NO_CLAUDE_REASON);

		// A new Claude with the same stale label but another pid: still nothing.
		send('foreground', 't1', { name: 'claude', argv: ['claude'], cwd: CWD, pid: 6000 });
		expect(seen).toEqual(['', 's-1', '']);
		expect(watcher.unavailable?.('t1')).toBe(NATIVE_NO_LABEL_REASON);
	});

	it('clears on a lost or finished terminal', () => {
		const { scope, send } = scopeWith(
			terminal('t1', { labels: label('s-1', 4242, PATH_1) }),
			terminal('t2', { labels: label('s-9', 4242, PATH_2) }),
		);
		const watcher = hcSessionWatcher(scope);
		const seen: string[] = [];
		watcher.onSession((paneId, session) => seen.push(`${paneId}=${session}`));
		send('lost', 't1', { reason: 'holder_lost', exit_code: null, signal: null, finished_ms: null });
		send('finished', 't2', { reason: 'exited', exit_code: 0, signal: null, finished_ms: 1 });
		expect(seen).toEqual(['t1=', 't2=']);
	});

	it('follows the label through /clear and resume, and says nothing for the same value', () => {
		const { scope, send } = scopeWith(terminal('t1', { labels: label('s-1', 4242, PATH_1) }));
		const watcher = hcSessionWatcher(scope);
		const seen: string[] = [];
		watcher.onSession((_paneId, session, path) => seen.push(`${session} ${path ?? ''}`));
		send('labels', 't1', { labels: label('s-2', 4242, PATH_2) });
		send('labels', 't1', { labels: label('s-2', 4242, PATH_2) });
		// Unrelated labels (herdr.seen) change nothing either.
		send('labels', 't1', { labels: { ...label('s-2', 4242, PATH_2), 'herdr.seen': '3' } });
		// A resume names the first session's file again.
		send('labels', 't1', { labels: label('s-1', 4242, PATH_1) });
		expect(seen).toEqual([`s-2 ${PATH_2}`, `s-1 ${PATH_1}`]);
	});

	it('maps hc’s status and blocked kinds, never reports trust, and reads error as a turn’s end', () => {
		const { scope, send } = scopeWith(terminal('t1', { labels: label('s-1', 4242, PATH_1) }));
		const watcher = hcSessionWatcher(scope);
		const seen: string[] = [];
		watcher.onStatus((_paneId, status, kind) => seen.push(kind ? `${status}:${kind}` : status));
		const status = (state: string, kind?: string): void =>
			send('status', 't1', { status: { state, app: 'claude-code', ...(kind ? { kind } : {}) }, records: {}, reported: true });

		status('working');
		status('blocked', 'permission');
		status('blocked', 'permission');
		status('blocked', 'question');
		status('blocked', 'auth');
		// Nothing hc sends is a trust prompt, and an unknown kind is no kind.
		status('blocked', 'trust');
		status('blocked', 'sudo');
		status('error');
		// Done, as a turn that ended is without `herdr.seen` (ADR-0005's mapping).
		expect(seen).toEqual(['working', 'blocked:permission', 'blocked:question', 'blocked:auth', 'blocked', 'done']);
		expect(watcher.snapshot('t1')?.blockKind).toBeUndefined();
		status('blocked', 'question');
		expect(watcher.snapshot('t1')).toMatchObject({ agentStatus: 'blocked', blockKind: 'question' });
	});

	it('names the install command for a Claude without a label, and says when that changes', () => {
		const { scope, send } = scopeWith(terminal('t1'), terminal('t2', { foreground: { name: 'bash', argv: [], cwd: CWD, pid: 7 }, status: null }));
		const watcher = hcSessionWatcher(scope);
		expect(NATIVE_NO_LABEL_REASON).toContain(SESSION_HOOK_COMMAND_NAME);
		expect(SESSION_HOOK_COMMAND_NAME).toBe('Install or remove the Claude session hook');
		expect(watcher.unavailable?.('t1')).toBe(NATIVE_NO_LABEL_REASON);
		expect(watcher.unavailable?.('t2')).toBe(NATIVE_NO_CLAUDE_REASON);
		// A terminal nobody reported (not connected yet, or gone) is not refused.
		expect(watcher.unavailable?.('t99')).toBeNull();

		const moved: string[] = [];
		watcher.onAvailability?.((paneId) => moved.push(paneId));
		send('labels', 't1', { labels: label('s-1', 4242, PATH_1) });
		send('title', 't1', { title: 'busy' });
		expect(moved).toEqual(['t1']);
		expect(watcher.unavailable?.('t1')).toBeNull();
		// A fresh snapshot (a redial, or `missed`) re-reads every terminal.
		scope.reset(50, [terminal('t1')]);
		expect(moved.slice(1).sort()).toEqual(['t1', 't2']);
	});

	it('has no snapshot for a terminal outside the vault’s scope', () => {
		const { scope } = scopeWith(terminal('t1', { cwd: '/srv', foreground: { name: 'claude', argv: [], cwd: '/srv', pid: 4242 }, labels: label('s-1', 4242, PATH_1) }));
		expect(hcSessionWatcher(scope).snapshot('t1')).toBeNull();
	});
});

/** A scope stand-in for the source: terminals and the ingest hook, by hand. */
function sourceScope(terminals: Partial<HcTerminal>[] = []) {
	const listeners = new Set<(address: string | null, type: string) => void>();
	const state = {
		terminals: terminals as HcTerminal[],
		emit: (address: string | null, type: string) => {
			for (const listener of [...listeners]) listener(address, type);
		},
		listeners,
	};
	return {
		state,
		scope: {
			terminals: () => state.terminals,
			onIngested: (listener: (address: string | null, type: string) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	};
}

/** A reader over in-memory files with hc's semantics, counting calls. */
function filesReader(files: Map<string, string>, maxBytes?: number) {
	const calls: { offset: number; limit: number }[] = [];
	return {
		calls,
		reader: {
			request: <T,>(method: string, params: unknown): Promise<T> => {
				if (method !== 'file.read') return Promise.reject(new Error(method));
				const p = params as { offset: number; limit: number };
				calls.push({ offset: p.offset, limit: p.limit });
				try {
					return Promise.resolve(fileLines(files, params as Record<string, unknown>, maxBytes) as T);
				} catch (error) {
					// Shaped as the client would: an HcError with the core's kind.
					const rpc = error as RpcError;
					return Promise.reject(hcError(rpc.kind, rpc.message));
				}
			},
		},
	};
}

/** What `HcClient.request` rejects with, built the way the connection builds it. */
function hcError(kind: string, message: string): Error {
	return new HcError('file.read', { code: kind === 'invalid_params' ? -32602 : -32000, message, data: { kind } });
}

function line(n: number, pad = ''): string {
	return `{"type":"user","n":${n}${pad ? `,"pad":"${pad}"` : ''}}`;
}

describe('the herdr-core transcript source over file.read', () => {
	function openTail(files: Map<string, string>, options: { maxBytes?: number; pageLines?: number; terminals?: Partial<HcTerminal>[] } = {}) {
		const { timers, fire, delays } = manualTimers();
		const { reader, calls } = filesReader(files, options.maxBytes);
		const { scope, state } = sourceScope(options.terminals);
		const source = new HcTranscriptSource(reader, scope, { timers, pageLines: options.pageLines });
		const batches: { lines: string[]; restart: boolean }[] = [];
		const stream = source.open(PATH_1, (lines, restart) => batches.push({ lines, restart: restart === true }));
		const delivered = (): string[] => batches.flatMap((batch) => batch.lines);
		return { source, stream, batches, delivered, fire, delays, calls, state };
	}

	it('delivers whole lines and holds a partial last line until its newline arrives', async () => {
		const files = new Map([[PATH_1, `${line(1)}\n${line(2)}\n{"type":"us`]]);
		const tail = openTail(files);
		await settle();
		expect(tail.delivered()).toEqual([line(1), line(2)]);
		files.set(PATH_1, `${line(1)}\n${line(2)}\n${line(3)}\n${line(4)}`);
		tail.fire(15_000);
		await settle();
		expect(tail.delivered()).toEqual([line(1), line(2), line(3)]);
		files.set(PATH_1, `${line(1)}\n${line(2)}\n${line(3)}\n${line(4)}\n`);
		tail.fire(15_000);
		await settle();
		expect(tail.delivered()).toEqual([line(1), line(2), line(3), line(4)]);
		expect(tail.batches.every((batch) => !batch.restart)).toBe(true);
		tail.stream.close();
	});

	it('pages a file larger than one answer, by offset and limit, each line once', async () => {
		const lines = Array.from({ length: 50 }, (_, i) => line(i + 1, 'x'.repeat(40)));
		const files = new Map([[PATH_1, `${lines.join('\n')}\n`]]);
		// A cap of about six lines per answer stands in for hc's 8 MB.
		const tail = openTail(files, { maxBytes: 400, pageLines: 1000 });
		await vi.waitFor(() => expect(tail.delivered()).toHaveLength(50));
		expect(tail.delivered()).toEqual(lines);
		expect(tail.calls.length).toBeGreaterThan(8);
		// And by the line limit alone.
		const byLimit = openTail(new Map([[PATH_1, `${lines.join('\n')}\n`]]), { pageLines: 7 });
		await vi.waitFor(() => expect(byLimit.delivered()).toHaveLength(50));
		expect(byLimit.delivered()).toEqual(lines);
		// Pages of 7; the only other reads are the one-line head checks.
		expect(byLimit.calls.every((call) => call.limit === 7 || call.limit === 1)).toBe(true);
		expect(byLimit.calls.filter((call) => call.limit === 7).length).toBeGreaterThanOrEqual(8);
		tail.stream.close();
		byLimit.stream.close();
	});

	it('waits for a file that is not there yet', async () => {
		const files = new Map<string, string>();
		const tail = openTail(files);
		await settle();
		expect(tail.batches).toEqual([]);
		files.set(PATH_1, `${line(1)}\n`);
		tail.fire(15_000);
		await settle();
		expect(tail.delivered()).toEqual([line(1)]);
		tail.stream.close();
	});

	it('restarts on a truncated file, including one truncated to nothing', async () => {
		const files = new Map([[PATH_1, `${line(1)}\n${line(2)}\n${line(3)}\n`]]);
		const tail = openTail(files);
		await settle();
		files.set(PATH_1, `${line(1)}\n`);
		tail.fire(15_000);
		await settle();
		expect(tail.batches.at(-1)).toEqual({ lines: [line(1)], restart: true });
		files.set(PATH_1, '');
		tail.fire(15_000);
		await settle();
		expect(tail.batches.at(-1)).toEqual({ lines: [], restart: true });
		files.set(PATH_1, `${line(7)}\n`);
		tail.fire(15_000);
		await settle();
		expect(tail.batches.at(-1)).toEqual({ lines: [line(7)], restart: false });
		tail.stream.close();
	});

	it('restarts on a file replaced by a longer one with another head', async () => {
		const files = new Map([[PATH_1, `${line(1)}\n${line(2)}\n`]]);
		const tail = openTail(files);
		await settle();
		// Same line 2, so only the head tells the files apart.
		files.set(PATH_1, `${line(9)}\n${line(2)}\n${line(3)}\n`);
		tail.fire(15_000);
		await settle();
		expect(tail.batches.at(-1)).toEqual({ lines: [line(9), line(2), line(3)], restart: true });
		tail.stream.close();
	});

	it('restarts on a file rewritten in place under the same head', async () => {
		const files = new Map([[PATH_1, `${line(1)}\n${line(2)}\n`]]);
		const tail = openTail(files);
		await settle();
		files.set(PATH_1, `${line(1)}\n${line(5)}\n${line(6)}\n`);
		tail.fire(15_000);
		await settle();
		expect(tail.batches.at(-1)).toEqual({ lines: [line(1), line(5), line(6)], restart: true });
		tail.stream.close();
	});

	it('skips a line hc cannot send and reads on past it', async () => {
		const big = line(2, 'y'.repeat(500));
		const files = new Map([[PATH_1, `${line(1)}\n${big}\n${line(3)}\n`]]);
		const tail = openTail(files, { maxBytes: 200 });
		await vi.waitFor(() => expect(tail.delivered()).toEqual([line(1), line(3)]));
		// Then nothing new: idle reads end without an error loop or a restart.
		files.set(PATH_1, `${line(1)}\n${big}\n${line(3)}\n${line(4)}\n`);
		tail.fire(15_000);
		await vi.waitFor(() => expect(tail.delivered()).toEqual([line(1), line(3), line(4)]));
		expect(tail.batches.some((batch) => batch.restart)).toBe(false);
		tail.stream.close();
	});

	it('is kicked by its own terminal’s status and turn and by a snapshot, and polls faster while working', async () => {
		const files = new Map([[PATH_1, `${line(1)}\n`]]);
		const mine = { address: 't1', labels: label('s-1', 4242, PATH_1), status: { state: 'idle', app: 'claude-code' }, reported: true };
		const other = { address: 't2', labels: label('s-2', 4243, PATH_2), status: { state: 'idle', app: 'claude-code' }, reported: true };
		const tail = openTail(files, { terminals: [mine, other] });
		await settle();
		expect(tail.delays()).toEqual([15_000]);
		const reads = (): number => tail.calls.length;
		const before = reads();

		files.set(PATH_1, `${line(1)}\n${line(2)}\n`);
		tail.state.emit('t2', 'status');
		tail.state.emit('t1', 'labels');
		expect(tail.delays()).toEqual([15_000]);
		tail.state.emit('t1', 'status');
		tail.state.emit('t1', 'turn');
		// One debounced read now, one more a moment later.
		expect(tail.delays()).toEqual([50, 1000, 15_000]);
		tail.fire(50);
		await settle();
		expect(tail.delivered()).toEqual([line(1), line(2)]);
		tail.fire(1000);
		await settle();
		expect(reads()).toBeGreaterThan(before + 1);

		files.set(PATH_1, `${line(1)}\n${line(2)}\n${line(3)}\n`);
		tail.state.emit(null, 'snapshot');
		tail.fire(50);
		await settle();
		expect(tail.delivered()).toEqual([line(1), line(2), line(3)]);

		// Working: the next poll is the fast one.
		(mine as { status: { state: string } }).status.state = 'working';
		tail.fire(15_000);
		await settle();
		expect(tail.delays()).toContain(2000);
		tail.stream.close();
		expect(tail.delays()).toEqual([]);
		expect(tail.state.listeners.size).toBe(0);
	});

	it('reads a report whole, page by page, and null for a file that is not there', async () => {
		const lines = Array.from({ length: 20 }, (_, i) => line(i + 1));
		const files = new Map([[PATH_2, `${lines.join('\n')}\n`]]);
		const { reader, calls } = filesReader(files);
		const source = new HcTranscriptSource(reader, sourceScope().scope, { pageLines: 6 });
		expect(await source.read(PATH_2)).toBe(`${lines.join('\n')}\n`);
		expect(calls.map((call) => call.offset)).toEqual([1, 7, 13, 19]);
		expect(await source.read('/nope')).toBeNull();
		files.set('/empty', '');
		expect(await source.read('/empty')).toBe('');
	});
});

const ASHER: RuntimeConfig = {
	...newRuntime('herdr-core', 'ssh', [], () => 0.5),
	host: 'asher',
	remoteVaultPath: '/root/vault',
};
const LOCAL_HC: RuntimeConfig = { ...newRuntime('herdr-core', 'local', [], () => 0.25), binary: '/opt/hc' };

function transcript(prompt: string, answer: string, uuid: string): string {
	return [
		`{"type":"user","message":{"role":"user","content":${JSON.stringify(prompt)}},"uuid":"${uuid}"}`,
		`{"type":"assistant","message":{"id":"m-${uuid}","role":"assistant","content":[{"type":"text","text":${JSON.stringify(answer)}}]},"uuid":"a-${uuid}"}`,
		'',
	].join('\n');
}

/** A herdr-core kind connected over a fake `ssh … hc connect`, with files on the "remote". */
async function connected(runtime: RuntimeConfig, terminals: unknown[], files: Map<string, string>) {
	const { timers, fire } = manualTimers();
	const { spawn, cores } = fakeSpawner((core) => {
		core.handlers.set('events.subscribe', () => ({ seq: 10, channel: 1, terminals }));
		core.handlers.set('doc.get', () => ({ value: { spaces: [] }, version: 1 }));
		core.handlers.set('file.read', (params) => fileLines(files, params));
		core.handlers.set('terminal.send', () => ({ turn: 1, status: 'working', started: true }));
		core.handlers.set('terminal.keys', () => ({ turn: 1, status: 'blocked' }));
	});
	const kind = createHerdrCoreKind({
		extraPath: () => '',
		spawnEnv: () => ({}),
		vaultPath: () => '/home/lasse/hvelv',
		vaultName: () => 'hvelv',
		onMismatch: () => undefined,
		currentScope: () => null,
		spawn,
		timers,
	});
	const driver = kind.connection;
	if (!driver) throw new Error('driver');
	const coordinator = new ConnectionCoordinator({
		endpoint: () => endpointOf(runtime),
		driver: () => driver,
		notice: () => undefined,
		setError: () => undefined,
		onReplaced: () => undefined,
		onPrimed: () => undefined,
	});
	await coordinator.connect();
	await settle();
	await settle();
	const connection = coordinator.current as unknown as Connection<HcClient, HcScope>;
	const core = cores[0] as FakeCore;
	let seq = 10;
	const event = (type: string, address: string, data: unknown): void => {
		core.write(core.eventFrames(1, [{ method: 'event', params: { seq: ++seq, type, terminal: address, data } }]));
	};
	return { kind: kind as unknown as RuntimeKindAdapter, connection, core, event, fire, coordinator };
}

describe('herdr-core’s native adapter and gate', () => {
	it('has the capability and reads transcripts locally or over the connection', async () => {
		expect(HERDR_CORE_CAPABILITIES.nativeView).toBe(true);
		const { kind, connection, coordinator } = await connected(ASHER, [], new Map());
		const native = kind.native;
		if (!native) throw new Error('native');
		const remote = endpointOf(ASHER);
		const local = endpointOf(LOCAL_HC);
		expect(native.transcriptAccess(local)).toBe('local');
		expect(native.transcriptAccess(remote)).toBe('rpc');
		expect(native.transcripts(local, null)).toBeInstanceOf(LocalTranscriptSource);
		// Nothing to read an SSH runtime's files through without its connection.
		expect(native.transcripts(remote, null)).toBeNull();
		const source = native.transcripts(remote, connection);
		expect(source).toBeInstanceOf(HcTranscriptSource);
		// One per connection, so a model never reopens for a source that did not change.
		expect(native.transcripts(remote, connection)).toBe(source);
		expect(native.watcher(connection)).toBe(native.watcher(connection));
		// The `/` list follows the same rule (#98): this machine's files for a
		// local runtime, the remote's over its connection, the built-ins only
		// without one, and never this machine's for a remote.
		expect(native.commandCatalog?.(local, null)).toBeNull();
		expect(native.commandCatalog?.(remote, null)).toBe(BUILTIN_CATALOG_SOURCE);
		const catalog = native.commandCatalog?.(remote, connection);
		expect(catalog).toBeInstanceOf(HcCommandCatalog);
		expect(native.commandCatalog?.(remote, connection)).toBe(catalog);
		expect(paneViewAvailability('native', nativeViewBlock(kind, remote)).available).toBe(true);
		expect(paneViewAvailability('native', nativeViewBlock(kind, local)).available).toBe(true);
		coordinator.dispose();
	});

	it('shows a label-less terminal as a terminal, with the install command as the reason', async () => {
		const { kind, connection, event, coordinator } = await connected(ASHER, [terminal('t1')], new Map());
		const watcher = kind.native?.watcher(connection);
		const reason = watcher?.unavailable?.('t1') ?? null;
		expect(paneViewAvailability('native', { remote: false, kindReason: reason })).toEqual({
			available: false,
			reason: NATIVE_NO_LABEL_REASON,
		});
		event('labels', 't1', { labels: label('s-1', 4242, PATH_1) });
		expect(watcher?.unavailable?.('t1')).toBeNull();
		coordinator.dispose();
	});
});

describe('a native session model on an SSH herdr-core runtime, over a fake hc connect', () => {
	it('picks up the session, renders the remote transcript, follows /clear and sends prompts and keys', async () => {
		const files = new Map([[PATH_1, transcript('First question', 'First answer.', 'u1')]]);
		const rig = await connected(ASHER, [terminal('t1', { labels: label('s-1', 4242, PATH_1) })], files);
		const native = rig.kind.native;
		if (!native) throw new Error('native');
		const endpoint = endpointOf(ASHER);
		const registry = new SessionModelRegistry({
			watcher: (id) => (id === endpoint.id ? native.watcher(rig.connection) : null),
			source: (id) => (id === endpoint.id ? native.transcripts(endpoint, rig.connection) : null),
		});
		const handle = registry.acquire(endpoint.id, 't1');
		const model = handle.model;
		expect(model.agentSession).toBe('s-1');
		expect(model.path).toBe(PATH_1);
		await vi.waitFor(() => expect(model.loaded).toBe(true));
		expect(model.state.turns).toHaveLength(1);
		expect(rig.core.calls.filter((call) => call.method === 'file.read')[0]?.params).toMatchObject({ path: PATH_1, offset: 1 });

		// Claude answers a second prompt; its status and turn kick the read.
		files.set(PATH_1, `${files.get(PATH_1) ?? ''}${transcript('Second', 'Second answer.', 'u2')}`);
		rig.event('status', 't1', { status: { state: 'done', app: 'claude-code' }, records: {}, reported: true });
		rig.event('turn', 't1', { turn: 1, state: 'done' });
		rig.fire(50);
		await vi.waitFor(() => expect(model.state.turns).toHaveLength(2));

		// /clear: the hook writes the next session, and the model moves to it.
		files.set(PATH_2, transcript('After the clear', 'A clean slate.', 'u3'));
		const resets: boolean[] = [];
		model.on((change) => resets.push(change.reset));
		rig.event('labels', 't1', { labels: label('s-2', 4242, PATH_2) });
		expect(model.agentSession).toBe('s-2');
		expect(resets[0]).toBe(true);
		await vi.waitFor(() => expect(model.state.turns).toHaveLength(1));
		expect(JSON.stringify(model.state.turns[0])).toContain('After the clear');

		// A permission block carries hc's kind; never trust.
		rig.event('status', 't1', { status: { state: 'blocked', kind: 'permission', app: 'claude-code' }, records: {}, reported: true });
		expect(model.agentStatus).toBe('blocked');
		expect(model.blockKind).toBe('permission');

		// Prompts and keys go through hc's senders on this runtime's client.
		const client = () => rig.connection.client;
		await hcPromptSender(client).send('t1', '/compact');
		await hcKeySender(client).sendKeys('t1', ['Down', 'Enter']);
		expect(rig.core.calls.find((call) => call.method === 'terminal.send')?.params).toEqual({ terminal: 't1', text: '/compact' });
		expect(rig.core.calls.find((call) => call.method === 'terminal.keys')?.params).toEqual({ terminal: 't1', keys: ['down', 'enter'] });

		// Claude exits: the session clears and the view empties.
		rig.event('foreground', 't1', { name: 'bash', argv: ['bash'], cwd: CWD, pid: 100 });
		expect(model.agentSession).toBe('');
		expect(model.path).toBeNull();
		handle.release();
		rig.coordinator.dispose();
	});

	it('reads a background subagent’s report through the same connection', async () => {
		const output = '/tmp/claude-0/-root-vault-notes/s-1/tasks/a1f2.output';
		const notification = [
			'<task-notification>',
			'<task-id>a1f2</task-id>',
			'<tool-use-id>toolu_a1</tool-use-id>',
			`<output-file>${output}</output-file>`,
			'<status>completed</status>',
			'</task-notification>',
		].join('\n');
		const launched = [
			'{"type":"user","message":{"role":"user","content":"Start the long job"},"uuid":"u1"}',
			'{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"toolu_a1","name":"Agent","input":{"description":"Check the styles"}}]},"uuid":"a1"}',
			`{"type":"queue-operation","operation":"enqueue","content":${JSON.stringify(notification)}}`,
			`{"type":"user","message":{"role":"user","content":${JSON.stringify(notification)}},"uuid":"u2"}`,
			'',
		].join('\n');
		const subagent = [
			'{"type":"user","message":{"role":"user","content":"Check the styles"}}',
			'{"type":"assistant","message":{"id":"s2","role":"assistant","content":[{"type":"text","text":"The styles are **fine**."}]}}',
			'',
		].join('\n');
		const files = new Map([
			[PATH_1, launched],
			[output, subagent],
		]);
		const rig = await connected(ASHER, [terminal('t1', { labels: label('s-1', 4242, PATH_1) })], files);
		const native = rig.kind.native;
		if (!native) throw new Error('native');
		const endpoint = endpointOf(ASHER);
		const registry = new SessionModelRegistry({
			watcher: () => native.watcher(rig.connection),
			source: () => native.transcripts(endpoint, rig.connection),
		});
		const handle = registry.acquire(endpoint.id, 't1');
		const report = (): string | null => {
			for (const turn of handle.model.state.turns) {
				for (const entry of turn.entries) {
					const tool = entry as { kind: string; report?: string | null };
					if (tool.kind === 'tool') return tool.report ?? null;
				}
			}
			return null;
		};
		await vi.waitFor(() => expect(report()).toBe('The styles are **fine**.'));
		expect(rig.core.calls.some((call) => call.method === 'file.read' && call.params.path === output)).toBe(true);
		handle.release();
		rig.coordinator.dispose();
	});

	it('keeps what it showed and closes the remote tail when another runtime becomes the connected one', async () => {
		const files = new Map([[PATH_1, transcript('First question', 'First answer.', 'u1')]]);
		const rig = await connected(ASHER, [terminal('t1', { labels: label('s-1', 4242, PATH_1) })], files);
		const native = rig.kind.native;
		if (!native) throw new Error('native');
		const endpoint = endpointOf(ASHER);
		let current = true;
		const registry = new SessionModelRegistry({
			watcher: () => (current ? native.watcher(rig.connection) : null),
			source: () => native.transcripts(endpoint, current ? rig.connection : null),
		});
		const handle = registry.acquire(endpoint.id, 't1');
		await vi.waitFor(() => expect(handle.model.state.turns).toHaveLength(1));
		current = false;
		registry.rebind();
		expect(handle.model.connected).toBe(false);
		expect(handle.model.agentStatus).toBe('unknown');
		expect(handle.model.state.turns).toHaveLength(1);
		const reads = rig.core.calls.filter((call) => call.method === 'file.read').length;
		files.set(PATH_1, `${files.get(PATH_1) ?? ''}${transcript('Second', 'Second answer.', 'u2')}`);
		rig.event('status', 't1', { status: { state: 'done', app: 'claude-code' }, records: {}, reported: true });
		rig.fire(50);
		rig.fire(15_000);
		await settle();
		expect(rig.core.calls.filter((call) => call.method === 'file.read').length).toBe(reads);
		// Back on its runtime: a fresh source reads the file again.
		current = true;
		registry.rebind();
		await vi.waitFor(() => expect(handle.model.state.turns).toHaveLength(2));
		handle.release();
		rig.coordinator.dispose();
	});
});
