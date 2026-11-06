/**
 * A stub Codex rollout parser behind the agent seam (issue #137, ADR-0010),
 * shared by the seam's acceptance test (`../agentSeam.test.ts`) and the
 * live-equals-cold property test (`../transcriptLiveCold.test.ts`, #138).
 *
 * The stub is a test's parser, not Codex support: no format for Codex is
 * registered, and the native view is not offered for it. It reads the
 * recorded rollouts in `./codex/` the way the finding `agent-codex` says a
 * parser should: prompts and replies from the `item_completed` layer, calls
 * from `response_item`, turns from their own lifecycle records, outcomes from
 * the output text. It folds in place and forks the way every parser does
 * (#138): the conversation's fork, and a copy of what it keeps besides.
 */

import {
	TurnDraft,
	forkConversation,
	type ConversationParser,
	type ConversationState,
	type ReduceResult,
	type SessionInfo,
	type TextPhase,
	type Turn,
} from '../../src/native/conversation';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** The text of a Codex content list (`[{type, text}]`) or a plain string. */
function contentText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter(isRecord)
		.map((part) => text(part.text))
		.join('');
}

export interface CodexState extends ConversationState {
	/** Yielded cells, by cell id, to the call that yielded them. */
	cells: Record<string, string>;
	info: SessionInfo;
}

const PHASES: Record<string, TextPhase> = { commentary: 'commentary', final_answer: 'final' };

/** A stub Codex rollout parser: enough of the format to prove the seam, no more. */
export const codexParser: ConversationParser<CodexState> = {
	empty: () => ({ turns: [], raw: {}, cells: {}, info: {} }),
	fork: (state) => ({ ...forkConversation(state), cells: { ...state.cells } }),
	reduce(state: CodexState, lines: string[]): ReduceResult<CodexState> {
		const draft = new TurnDraft(state.turns);
		const raw = state.raw;
		const cells = state.cells;
		let info = state.info;
		const count = (key: string): void => {
			raw[key] = (raw[key] ?? 0) + 1;
		};
		const turnFor = (turnId: string): Turn | null => draft.turn(turnId) ?? draft.current();
		for (const line of lines) {
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				count('(unparsed)');
				continue;
			}
			if (!isRecord(record) || !isRecord(record.payload)) {
				count('(untyped)');
				continue;
			}
			const type = text(record.type);
			const payload = record.payload;
			const kind = text(payload.type);
			if (type === 'turn_context') {
				const model = text(payload.model);
				info = {
					...info,
					...(model ? { model: { id: model, label: model } } : {}),
					...(text(payload.effort) ? { effort: text(payload.effort) } : {}),
				};
				continue;
			}
			if (type === 'event_msg' && kind === 'task_started') {
				const attribution = isRecord(payload.turn_attribution) ? payload.turn_attribution : {};
				draft.open(text(attribution.turn_id) || `turn-${draft.length}`, '');
				continue;
			}
			if (type === 'event_msg' && (kind === 'task_complete' || kind === 'turn_aborted')) {
				const turn = turnFor(text(payload.turn_id));
				if (turn) {
					turn.outcome = kind === 'task_complete' ? 'completed' : 'aborted';
					draft.touch(turn.id);
				}
				continue;
			}
			if (type === 'event_msg' && kind === 'token_count') {
				const window = isRecord(payload.info) ? payload.info.model_context_window : undefined;
				if (typeof window === 'number') info = { ...info, contextWindow: { tokens: window, source: 'agent' } };
				continue;
			}
			if (type === 'event_msg' && kind === 'item_completed' && isRecord(payload.item)) {
				const item = payload.item;
				const turn = turnFor(text(payload.turn_id));
				if (!turn) {
					count('item_completed');
					continue;
				}
				const itemType = text(item.type);
				if (itemType === 'UserMessage') {
					// A second prompt in a running turn is a steer (finding §4).
					const said = contentText(item.content);
					if (turn.prompt) turn.entries.push({ kind: 'steer', text: said });
					else turn.prompt = said;
				} else if (itemType === 'AgentMessage') {
					const phase = PHASES[text(item.phase)];
					turn.entries.push({
						kind: 'text',
						messageId: text(item.id),
						text: contentText(item.content),
						...(phase ? { phase } : {}),
					});
				} else if (itemType === 'Reasoning') {
					// Encrypted, summaries off: present, and empty.
					turn.entries.push({ kind: 'thinking', messageId: text(item.id), text: '' });
				} else if (itemType === 'ContextCompaction') {
					turn.entries.push({ kind: 'compaction', summary: '' });
				} else {
					count(`item:${itemType}`);
					continue;
				}
				draft.touch(turn.id);
				continue;
			}
			if (type === 'response_item' && (kind === 'custom_tool_call' || kind === 'function_call')) {
				const turn = draft.current();
				if (!turn) continue;
				let input: Json = {};
				if (kind === 'custom_tool_call') input = { script: text(payload.input) };
				else {
					try {
						const parsed: unknown = JSON.parse(text(payload.arguments));
						if (isRecord(parsed)) input = parsed;
					} catch {
						input = {};
					}
				}
				const continues = cells[text(input.cell_id)];
				turn.entries.push({
					kind: 'tool',
					id: text(payload.call_id),
					name: text(payload.name),
					input,
					result: null,
					status: 'pending',
					notification: null,
					report: null,
					...(continues ? { continues } : {}),
				});
				draft.touch(turn.id);
				continue;
			}
			if (type === 'response_item' && (kind === 'custom_tool_call_output' || kind === 'function_call_output')) {
				const callId = text(payload.call_id);
				const entry = draft.toolEntry(callId);
				const turn = draft.turnOf(callId);
				if (!entry || !turn) continue;
				const output = contentText(payload.output);
				entry.result = output;
				const yielded = /^Script running with cell ID (\S+)/.exec(output);
				// No record flags a failure: the text decides, and "completed" is
				// a script's, not a command's, so it stays unknown (finding §3).
				if (/^aborted by user/.test(output)) entry.status = 'declined';
				else if (yielded) {
					entry.status = 'running';
					cells[yielded[1] ?? ''] = callId;
				} else entry.status = 'unknown';
				if (entry.continues && entry.status === 'unknown') {
					const earlier = draft.toolEntry(entry.continues);
					if (earlier) earlier.status = 'unknown';
				}
				draft.touch(turn.id);
				continue;
			}
			count(kind ? `${type}:${kind}` : type);
		}
		const { changedTurnIds, removedTurnIds } = draft.finish();
		state.info = info;
		return { state, changedTurnIds, removedTurnIds };
	},
};
