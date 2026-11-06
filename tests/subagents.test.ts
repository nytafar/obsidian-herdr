/**
 * Following a subagent while it works (#147): which subagents Claude's
 * records name and where each keeps its transcript (`claudeSubagents`), and
 * what the follower reads of them, when (`SubagentFollower`).
 *
 * The fixtures are recorded from real local sessions, scrubbed: a background
 * subagent (`subagent-parent`, `subagent-own`) and a synchronous one
 * (`subagent-sync-*`, with its meta file).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_FORMAT } from '../src/agents/claude/format';
import { claudeSubagents, claudeWrittenAt } from '../src/agents/claude/subagents';
import type { SubagentRef } from '../src/agents/format';
import type { Turn } from '../src/native/conversation';
import { SubagentFollower, type SubagentTimers } from '../src/native/subagents';
import type {
	TailOptions,
	TranscriptLines,
	TranscriptSource,
	TranscriptStream,
} from '../src/native/transcriptSource';

function fixture(name: string): string {
	return readFileSync(join(__dirname, 'fixtures', 'transcripts', name), 'utf8');
}

function fixtureLines(name: string): string[] {
	return fixture(`${name}.jsonl`).split('\n').filter(Boolean);
}

/** The parent session's turns after `lines`, as the session model holds them. */
function turnsOf(lines: string[]): Turn[] {
	return CLAUDE_FORMAT.parser.reduce(CLAUDE_FORMAT.parser.empty(), lines).state.turns;
}

const SESSION = '/home/user/.claude/projects/-home-user-project/d5d6abff-87c9-427d-9349-e2bd82c8d6fd.jsonl';
const OWN = '/home/user/.claude/projects/-home-user-project/d5d6abff-87c9-427d-9349-e2bd82c8d6fd/subagents/agent-aece3cfaa2db5aeaf.jsonl';
const CALL = 'toolu_01YMWC8bF9UHG7kbsWpcQewh';
/** When the background subagent's notification was enqueued. */
const NOTIFIED_AT = Date.parse('2026-10-26T15:34:03.954Z');

const SYNC_SESSION = '/home/user/.claude/projects/-tmp-k/33333333-3333-4333-8333-333333333333.jsonl';
const SYNC_FOLDER = '/home/user/.claude/projects/-tmp-k/33333333-3333-4333-8333-333333333333/subagents';
const SYNC_CALL = 'toolu_013JsCtA7Bd4sEwgyaSZFWFv';

/** A `SendMessage` to the background subagent, and Claude's answer to it. */
function sendMessage(id: string, at: string): string[] {
	return [
		JSON.stringify({
			type: 'assistant',
			uuid: `a-${id}`,
			timestamp: at,
			message: {
				id: `m-${id}`,
				role: 'assistant',
				content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to: 'aece3cfaa2db5aeaf', message: 'One more.' } }],
			},
		}),
		JSON.stringify({
			type: 'user',
			uuid: `r-${id}`,
			timestamp: at,
			message: {
				role: 'user',
				content: [{ tool_use_id: id, type: 'tool_result', content: '{"success":true,"message":"Message queued for delivery to aece3cfaa2db5aeaf at its next tool round."}' }],
			},
		}),
	];
}

/** The notification a resumed subagent writes when it stops again, on the `SendMessage` call. */
function notification(callId: string, at: string): string {
	const content = [
		'<task-notification>',
		'<task-id>aece3cfaa2db5aeaf</task-id>',
		`<tool-use-id>${callId}</tool-use-id>`,
		'<status>completed</status>',
		'<summary>Agent "Sort the pane snapshots" finished</summary>',
		'</task-notification>',
	].join('\n');
	return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content });
}

describe('Claude’s subagents as the records name them (#147)', () => {
	it('names a background subagent by its launch notice and keeps it working past its answer', () => {
		const lines = fixtureLines('subagent-parent');
		// The prompt, the call and its launch notice: answered, still working.
		const [launched] = claudeSubagents(turnsOf(lines.slice(0, 3)), SESSION);
		expect(launched).toMatchObject({ callId: CALL, path: OWN, search: null, running: true, stoppedAt: null, resumed: false });
		// Its notification ends it, and says when.
		const [stopped] = claudeSubagents(turnsOf(lines), SESSION);
		expect(stopped).toMatchObject({ callId: CALL, path: OWN, running: false, stoppedAt: NOTIFIED_AT, resumed: false });
	});

	it('ends a synchronous call at its answer, and finds its file by the meta file meanwhile', () => {
		const lines = fixtureLines('subagent-sync-parent');
		const [pending] = claudeSubagents(turnsOf(lines.slice(0, 2)), SYNC_SESSION);
		expect(pending).toMatchObject({ callId: SYNC_CALL, path: '', running: true });
		const search = pending?.search;
		expect(search?.folder).toBe(SYNC_FOLDER);
		expect(search?.candidates(['agent-a6bd2410ad5aed73e.jsonl', 'agent-a6bd2410ad5aed73e.meta.json', 'notes.txt'])).toEqual([
			{
				probe: `${SYNC_FOLDER}/agent-a6bd2410ad5aed73e.meta.json`,
				transcript: `${SYNC_FOLDER}/agent-a6bd2410ad5aed73e.jsonl`,
			},
		]);
		expect(search?.owns(fixture('subagent-sync.meta.json'))).toBe(true);
		expect(search?.owns('{"toolUseId":"toolu_other"}')).toBe(false);
		expect(search?.owns('not json')).toBe(false);
		// Its answer ends it: no notification follows a synchronous call.
		const [answered] = claudeSubagents(turnsOf(lines), SYNC_SESSION);
		expect(answered).toMatchObject({ callId: SYNC_CALL, running: false, search: null, stoppedAt: null });
	});

	it('moves a stopped subagent under the message that may set it working again', () => {
		const lines = [...fixtureLines('subagent-parent'), ...sendMessage('toolu_send', '2026-10-26T15:40:00.000Z')];
		expect(claudeSubagents(turnsOf(lines), SESSION)).toEqual([
			expect.objectContaining({ callId: 'toolu_send', path: OWN, running: false, stoppedAt: NOTIFIED_AT, resumed: true }),
		]);
		// Its next notification names the message's call: stopped again, then.
		const again = [...lines, notification('toolu_send', '2026-10-26T15:45:00.000Z')];
		expect(claudeSubagents(turnsOf(again), SESSION)).toEqual([
			expect.objectContaining({
				callId: 'toolu_send',
				resumed: false,
				stoppedAt: Date.parse('2026-10-26T15:45:00.000Z'),
			}),
		]);
	});

	it('opens no file for a message of an earlier turn that no notification answered', () => {
		const lines = [
			...fixtureLines('subagent-parent'),
			...sendMessage('toolu_send', '2026-10-26T15:40:00.000Z'),
			JSON.stringify({ type: 'user', uuid: 'u-next', timestamp: '2026-10-26T16:00:00.000Z', message: { role: 'user', content: 'Next.' } }),
		];
		expect(claudeSubagents(turnsOf(lines), SESSION)).toEqual([
			expect.objectContaining({ callId: 'toolu_send', resumed: false, stoppedAt: NOTIFIED_AT }),
		]);
	});

	it('leaves a message to a subagent still at work under the call that started it', () => {
		const lines = [...fixtureLines('subagent-parent').slice(0, 3), ...sendMessage('toolu_send', '2026-10-26T15:33:50.000Z')];
		expect(claudeSubagents(turnsOf(lines), SESSION)).toEqual([
			expect.objectContaining({ callId: CALL, running: true }),
		]);
	});

	it('takes a subagent’s latest stop, told on the call that started it, as when it stopped', () => {
		// Measured 2026-11-06: a message sent while it worked, its stop, then
		// the message taken in and a second stop, both told on the `Agent` call.
		const [prompt, call, launched, enqueued, taken] = fixtureLines('subagent-parent');
		const lines = [
			prompt,
			call,
			launched,
			...sendMessage('toolu_send', '2026-10-26T15:33:50.000Z'),
			enqueued,
			taken,
			notification(CALL, '2026-10-26T15:36:00.000Z'),
		].filter((line): line is string => line !== undefined);
		const [ref] = claudeSubagents(turnsOf(lines), SESSION);
		expect(ref).toMatchObject({ callId: 'toolu_send', resumed: true, stoppedAt: Date.parse('2026-10-26T15:36:00.000Z') });
	});

	it('takes a notification that names no call as the newest call’s that addressed the subagent', () => {
		// Measured 2026-11-06 (2.1.318): stopping again after taking in a
		// message sent while it worked, it notifies with an empty tool-use id.
		const [prompt, call, launched, enqueued, taken] = fixtureLines('subagent-parent');
		const lines = [
			prompt,
			call,
			launched,
			...sendMessage('toolu_send', '2026-10-26T15:33:50.000Z'),
			enqueued,
			taken,
			notification('', '2026-10-26T15:36:00.000Z'),
		].filter((line): line is string => line !== undefined);
		const send = turnsOf(lines)
			.flatMap((turn) => turn.entries)
			.find((entry) => entry.kind === 'tool' && entry.id === 'toolu_send');
		expect(send?.kind === 'tool' && send.notification).toMatchObject({ taskId: 'aece3cfaa2db5aeaf', at: '2026-10-26T15:36:00.000Z' });
		const [ref] = claudeSubagents(turnsOf(lines), SESSION);
		expect(ref).toMatchObject({ callId: 'toolu_send', resumed: false, stoppedAt: Date.parse('2026-10-26T15:36:00.000Z') });
	});

	it('reads when a notification stopped it from its enqueue, not from the records taken in later', () => {
		const lines = fixtureLines('subagent-parent');
		const [entry] = turnsOf(lines).flatMap((turn) => turn.entries);
		expect(entry?.kind === 'tool' && entry.notification?.at).toBe('2026-10-26T15:34:03.954Z');
	});

	it('takes no id that would leave the folder', () => {
		const lines = fixtureLines('subagent-parent').slice(0, 3);
		const tampered = lines.map((line) => line.replace('agentId: aece3cfaa2db5aeaf', 'agentId: ../../x'));
		const [ref] = claudeSubagents(turnsOf(tampered), SESSION);
		expect(ref?.path).not.toContain('..');
	});

	it('reads when a line of a subagent’s transcript was written', () => {
		const [first] = fixtureLines('subagent-own');
		expect(claudeWrittenAt(first ?? '')).toBe(Date.parse('2026-10-26T15:33:43.796Z'));
		expect(claudeWrittenAt('{"type":"user"}')).toBeNull();
		expect(claudeWrittenAt('not json')).toBeNull();
	});
});

/** One tail the fake source handed out. */
class FakeTail implements TranscriptStream {
	closed = false;
	constructor(
		readonly path: string,
		private readonly onLines: TranscriptLines,
		readonly options: TailOptions,
	) {}
	emit(lines: string[], restart = false): void {
		if (!this.closed) this.onLines(lines, restart);
	}
	close(): void {
		this.closed = true;
	}
}

/** A source over in-memory files and folders, recording every read and tail. */
class FakeSource implements TranscriptSource {
	readonly tails: FakeTail[] = [];
	readonly reads: string[] = [];
	readonly lists: string[] = [];
	constructor(
		readonly files = new Map<string, string>(),
		readonly folders = new Map<string, string[]>(),
	) {}
	async read(path: string): Promise<string | null> {
		this.reads.push(path);
		return this.files.get(path) ?? null;
	}
	async list(folder: string): Promise<string[] | null> {
		this.lists.push(folder);
		return this.folders.get(folder) ?? null;
	}
	open(path: string, onLines: TranscriptLines, options: TailOptions = {}): TranscriptStream {
		const tail = new FakeTail(path, onLines, options);
		this.tails.push(tail);
		return tail;
	}
	get open_(): string[] {
		return this.tails.filter((tail) => !tail.closed).map((tail) => tail.path);
	}
}

/** Timers fired by hand. */
function manualTimers(): { timers: SubagentTimers; fire: () => void } {
	const pending = new Map<number, () => void>();
	let next = 1;
	return {
		timers: {
			set: (callback) => {
				pending.set(next, callback);
				return next++;
			},
			clear: (handle) => {
				pending.delete(handle as number);
			},
		},
		fire: () => {
			for (const [id, callback] of [...pending]) {
				pending.delete(id);
				callback();
			}
		},
	};
}

function ref(callId: string, path: string, extra: Partial<SubagentRef> = {}): SubagentRef {
	return { callId, path, search: null, running: true, stoppedAt: null, resumed: false, ...extra };
}

function followerOn(source: FakeSource, options: { maxFollowed?: number } = {}) {
	const { timers, fire } = manualTimers();
	let changes = 0;
	const follower = new SubagentFollower({
		source,
		format: CLAUDE_FORMAT,
		onChange: () => changes++,
		timers,
		...options,
	});
	return { follower, fire, changes: () => changes };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the subagent follower (#147)', () => {
	it('reads nothing while no view shows the session', () => {
		const source = new FakeSource();
		const { follower } = followerOn(source);
		follower.sync([ref(CALL, OWN)], false);
		expect(source.tails).toEqual([]);
		expect(follower.progress(CALL)).toBeUndefined();
	});

	it('follows a shown subagent within a read budget and says what it did last', () => {
		const source = new FakeSource();
		const { follower, changes } = followerOn(source);
		follower.sync([ref(CALL, OWN)], true);
		expect(source.open_).toEqual([OWN]);
		// Each look reads only what the file gained, and at most the budget.
		expect(source.tails[0]?.options.budgetBytes).toBe(1024 * 1024);
		expect(source.tails[0]?.options.pollMs).toBe(1000);
		expect(follower.progress(CALL)).toEqual({ running: true, latest: null, calls: 0 });

		const lines = fixtureLines('subagent-own');
		// Up to its first command's answer.
		source.tails[0]?.emit(lines.slice(0, 11));
		expect(follower.progress(CALL)).toMatchObject({ running: true, calls: 1, latest: { kind: 'tool', name: 'Bash' } });
		// The rest, a batch at a time: its report handed back last.
		const before = changes();
		source.tails[0]?.emit(lines.slice(11));
		expect(changes()).toBe(before + 1);
		expect(follower.progress(CALL)).toMatchObject({ calls: 4, latest: { kind: 'tool', name: 'SubagentHandback' } });
	});

	it('reads a subagent written to after its notification as working again', () => {
		const source = new FakeSource();
		const { follower } = followerOn(source);
		follower.sync([ref(CALL, OWN)], true);
		source.tails[0]?.emit(fixtureLines('subagent-own'));
		// The notification arrives: it stopped.
		follower.sync([ref(CALL, OWN, { running: false, stoppedAt: NOTIFIED_AT })], true);
		expect(follower.progress(CALL)?.running).toBe(false);
		// Followed still while shown: resumed by a message, it writes again.
		expect(source.open_).toEqual([OWN]);
		source.tails[0]?.emit([
			JSON.stringify({ type: 'user', timestamp: '2026-10-26T15:40:00.000Z', message: { role: 'user', content: 'One more.' } }),
		]);
		expect(follower.progress(CALL)?.running).toBe(true);
	});

	it('opens a stopped subagent a message addressed, and no other stopped one', () => {
		const source = new FakeSource();
		const { follower } = followerOn(source);
		const other = `${OWN.replace('aece', 'beef')}`;
		follower.sync(
			[
				ref('toolu_old', other, { running: false, stoppedAt: NOTIFIED_AT }),
				ref('toolu_send', OWN, { running: false, stoppedAt: NOTIFIED_AT, resumed: true }),
			],
			true,
		);
		expect(source.open_).toEqual([OWN]);
		// What it wrote before it stopped says nothing.
		source.tails[0]?.emit(fixtureLines('subagent-own'));
		expect(follower.progress('toolu_send')?.running).toBe(false);
	});

	it('keeps reading a file it follows when the records move it to another call', () => {
		const source = new FakeSource();
		const { follower } = followerOn(source);
		follower.sync([ref(CALL, OWN)], true);
		source.tails[0]?.emit(fixtureLines('subagent-own'));
		follower.sync([ref('toolu_send', OWN, { running: false, stoppedAt: NOTIFIED_AT, resumed: true })], true);
		expect(source.tails).toHaveLength(1);
		expect(follower.progress(CALL)).toBeUndefined();
		expect(follower.progress('toolu_send')).toMatchObject({ calls: 4 });
	});

	it('follows at most a handful at once, the working and the newest first', () => {
		const source = new FakeSource();
		const { follower } = followerOn(source, { maxFollowed: 3 });
		const refs = Array.from({ length: 6 }, (_, n) => ref(`toolu_${n}`, `/s/subagents/agent-a${n}.jsonl`));
		refs[1] = { ...(refs[1] as SubagentRef), running: false, resumed: true };
		follower.sync(refs, true);
		expect(source.open_.sort()).toEqual(['/s/subagents/agent-a3.jsonl', '/s/subagents/agent-a4.jsonl', '/s/subagents/agent-a5.jsonl']);
	});

	it('stops reading when no view shows the session, unless its transcript is open', () => {
		const source = new FakeSource();
		const { follower } = followerOn(source);
		const refs = [ref(CALL, OWN), ref('toolu_2', '/s/subagents/agent-b.jsonl')];
		follower.sync(refs, true);
		const transcript = follower.open(CALL);
		source.tails.find((tail) => tail.path === OWN)?.emit(fixtureLines('subagent-own'));
		expect(transcript?.state.turns).toHaveLength(1);
		expect(transcript?.running).toBe(true);
		follower.sync(refs, false);
		expect(source.open_).toEqual([OWN]);
		expect(follower.progress('toolu_2')).toBeUndefined();
		transcript?.release();
		expect(source.open_).toEqual([]);
		expect(follower.progress(CALL)).toBeUndefined();
	});

	it('opens a transcript on request with no view showing it, and no more once released', () => {
		const source = new FakeSource();
		const { follower } = followerOn(source);
		follower.sync([ref(CALL, OWN, { running: false, stoppedAt: NOTIFIED_AT })], false);
		expect(follower.open('toolu_unknown')).toBeNull();
		const transcript = follower.open(CALL);
		expect(source.open_).toEqual([OWN]);
		let heard = 0;
		transcript?.on(() => heard++);
		source.tails[0]?.emit(fixtureLines('subagent-own'));
		expect(heard).toBe(1);
		transcript?.release();
		transcript?.release();
		expect(source.open_).toEqual([]);
	});

	it('finds a synchronous call’s file by its meta file, and reads a sibling’s meta once', async () => {
		const source = new FakeSource(
			new Map([
				[`${SYNC_FOLDER}/agent-a1.meta.json`, '{"toolUseId":"toolu_other"}'],
				[`${SYNC_FOLDER}/agent-a6bd2410ad5aed73e.meta.json`, fixture('subagent-sync.meta.json')],
			]),
			new Map([[SYNC_FOLDER, ['agent-a1.jsonl', 'agent-a1.meta.json']]]),
		);
		const { follower, fire } = followerOn(source);
		const [pending] = claudeSubagents(turnsOf(fixtureLines('subagent-sync-parent').slice(0, 2)), SYNC_SESSION);
		follower.sync([pending as SubagentRef], true);
		await settle();
		// Not there yet: another call's subagent only.
		expect(source.open_).toEqual([]);
		expect(source.reads).toEqual([`${SYNC_FOLDER}/agent-a1.meta.json`]);
		source.folders.set(SYNC_FOLDER, [
			'agent-a1.jsonl',
			'agent-a1.meta.json',
			'agent-a6bd2410ad5aed73e.jsonl',
			'agent-a6bd2410ad5aed73e.meta.json',
		]);
		fire();
		await settle();
		expect(source.reads).toEqual([
			`${SYNC_FOLDER}/agent-a1.meta.json`,
			`${SYNC_FOLDER}/agent-a6bd2410ad5aed73e.meta.json`,
		]);
		expect(source.open_).toEqual([`${SYNC_FOLDER}/agent-a6bd2410ad5aed73e.jsonl`]);
		source.tails[0]?.emit(fixtureLines('subagent-sync-own'));
		expect(follower.progress(SYNC_CALL)).toMatchObject({ running: true, latest: { kind: 'text' } });
		// Answered: it stopped, and the records name the file it was read from.
		const [answered] = claudeSubagents(turnsOf(fixtureLines('subagent-sync-parent')), SYNC_SESSION);
		follower.sync([{ ...(answered as SubagentRef), path: `${SYNC_FOLDER}/agent-a6bd2410ad5aed73e.jsonl` }], true);
		expect(source.tails).toHaveLength(1);
		expect(follower.progress(SYNC_CALL)?.running).toBe(false);
	});

	it('leaves a synchronous call unfollowed on a source that cannot list its folder', () => {
		// herdr-core over SSH: `file.read` and nothing else.
		const source = new FakeSource();
		(source as { list?: unknown }).list = undefined;
		const { follower } = followerOn(source);
		const [pending] = claudeSubagents(turnsOf(fixtureLines('subagent-sync-parent').slice(0, 2)), SYNC_SESSION);
		follower.sync([pending as SubagentRef], true);
		expect(follower.progress(SYNC_CALL)).toBeUndefined();
		expect(follower.open(SYNC_CALL)).toBeNull();
		expect(source.tails).toEqual([]);
	});

	it('closes everything when disposed', () => {
		const source = new FakeSource();
		const { follower } = followerOn(source);
		follower.sync([ref(CALL, OWN)], true);
		follower.dispose();
		expect(source.open_).toEqual([]);
		follower.sync([ref(CALL, OWN)], true);
		expect(source.tails).toHaveLength(1);
	});
});
