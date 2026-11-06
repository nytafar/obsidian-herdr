/**
 * Claude Code's subagents as its records name them (#147), for following one
 * while it works (`../format.ts`, `BackgroundReports.subagents`).
 *
 * What Claude writes (measured 2026-11-06 over every transcript on this
 * machine, 2.1.263 to 2.1.318, `docs/architecture.md`):
 *
 * - Each subagent keeps its own transcript beside the session's,
 *   `<session>/subagents/agent-<id>.jsonl`, with `agent-<id>.meta.json` beside
 *   it, whose `toolUseId` is the `Agent` call that started it.
 * - A **background** call is answered at once with a launch notice that names
 *   the id (`agentId: <id>`); it works until a `<task-notification>` for its
 *   call says it stopped. Its answer does not end it.
 * - A **synchronous** call is answered when the subagent ends, and that answer
 *   is the first record to name the id. Until then the subagent is found by
 *   its meta file.
 * - `SendMessage` with `to: <id>` addresses one again. Sent to one that
 *   stopped, it sets it working; its next notification names the
 *   `SendMessage` call. Nothing in the session's records says it started
 *   again, so only its own transcript, written after it stopped, can.
 */

import type { SubagentRef, SubagentSearch } from '../format';
import type { ToolEntry, Turn } from '../../native/conversation';
import { subagentTranscript } from './paths';

/** Tool names of a subagent call. */
const AGENT_TOOL = /^(agent|task)$/i;
/** The tool that sends a subagent a message. */
const SEND_MESSAGE = /^sendmessage$/i;
/** How a launch notice names its subagent. */
const LAUNCHED_ID = /\bagentId:\s*([A-Za-z0-9_-]+)/;
/** An id that becomes part of a path: a plain word, nothing that leaves the folder. */
const AGENT_ID = /^[A-Za-z0-9_-]+$/;
/** A subagent transcript's name in the folder. */
const TRANSCRIPT_NAME = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;

/** The id a call's records give its subagent, or '' while they give none. */
function agentIdOf(call: ToolEntry): string {
	const notified = call.notification?.kind === 'agent' ? call.notification.taskId : '';
	if (notified && AGENT_ID.test(notified)) return notified;
	return LAUNCHED_ID.exec(call.result ?? '')?.[1] ?? '';
}

/** When a call's notification was written, in ms, or null. */
function notifiedAt(call: ToolEntry): number | null {
	const at = call.notification?.at;
	const ms = at ? Date.parse(at) : NaN;
	return Number.isNaN(ms) ? null : ms;
}

/** The folder the session's subagents keep their transcripts in. */
function subagentFolder(transcript: string): string {
	return `${transcript.replace(/\.jsonl$/, '')}/subagents`;
}

/** Finding a synchronous call's subagent by the meta file beside each transcript. */
function searchFor(callId: string, transcript: string): SubagentSearch {
	const folder = subagentFolder(transcript);
	return {
		folder,
		candidates: (names) =>
			names.flatMap((name) => {
				const id = TRANSCRIPT_NAME.exec(name)?.[1];
				return id ? [{ probe: `${folder}/agent-${id}.meta.json`, transcript: `${folder}/${name}` }] : [];
			}),
		owns: (text) => {
			try {
				const meta: unknown = JSON.parse(text);
				return !!meta && typeof meta === 'object' && (meta as { toolUseId?: unknown }).toolUseId === callId;
			} catch {
				return false;
			}
		},
	};
}

/**
 * The session's subagents, oldest first, each under the newest call that
 * started or resumed it.
 */
export function claudeSubagents(turns: readonly Turn[], transcript: string): SubagentRef[] {
	const refs: SubagentRef[] = [];
	/** The ref of each subagent whose id is known, by id. */
	const byAgent = new Map<string, SubagentRef>();
	for (const turn of turns) {
		for (const entry of turn.entries) {
			if (entry.kind !== 'tool') continue;
			const name = entry.name.trim();
			if (AGENT_TOOL.test(name)) {
				const id = agentIdOf(entry);
				// Unanswered, or answered with a launch notice: working (the
				// parser's `pending` and `running`). A synchronous call ends at its
				// answer, a background one at its notification.
				const running = entry.status === 'pending' || entry.status === 'running';
				const ref: SubagentRef = {
					callId: entry.id,
					path: id ? subagentTranscript(transcript, id) : '',
					search: !id && entry.status === 'pending' ? searchFor(entry.id, transcript) : null,
					running,
					stoppedAt: running ? null : notifiedAt(entry),
					resumed: false,
				};
				refs.push(ref);
				if (id) byAgent.set(id, ref);
				continue;
			}
			if (!SEND_MESSAGE.test(name)) continue;
			const to = typeof entry.input.to === 'string' ? entry.input.to.trim() : '';
			const before = byAgent.get(to);
			// A message to a subagent still at work is taken in by it; the call
			// that started it goes on showing it.
			if (!before || before.running) continue;
			const notified = entry.notification?.kind === 'agent';
			// A message sent while it worked is taken in when it stops, and its
			// next stop may be told on the call that started it: the latest stop wins.
			const own = notified ? notifiedAt(entry) : null;
			const ref: SubagentRef = {
				callId: entry.id,
				path: before.path,
				search: null,
				running: false,
				stoppedAt: own !== null && (before.stoppedAt === null || own > before.stoppedAt) ? own : before.stoppedAt,
				// Its own notification says it stopped again; without one, only
				// its transcript can say whether it is working. Only a message of
				// the session's latest turn is worth opening the file for: most
				// are taken in by a subagent at work, whose stop is then told on
				// the call that started it, and nothing says which came first.
				resumed: !notified && turn === turns[turns.length - 1],
			};
			refs.splice(refs.indexOf(before), 1);
			refs.push(ref);
			byAgent.set(to, ref);
		}
	}
	return refs;
}

/** When a line of a subagent's transcript was written, in ms, or null. */
export function claudeWrittenAt(line: string): number | null {
	let record: unknown;
	try {
		record = JSON.parse(line);
	} catch {
		return null;
	}
	const at = record && typeof record === 'object' ? (record as { timestamp?: unknown }).timestamp : undefined;
	const ms = typeof at === 'string' ? Date.parse(at) : NaN;
	return Number.isNaN(ms) ? null : ms;
}
