/**
 * The waiting card (issue #99).
 *
 * What the native view shows when herdr's `agent_status` is `blocked`
 * (CONTEXT.md): the kind of block and a way to answer it. This file is the
 * *kind*, as a value — the surface draws it — because which kind a block is
 * decides the one thing in the native view that has a lasting side effect if it
 * is decided wrong, namely whether a bare Enter may be sent.
 *
 * The order is the ticket's, and it is an order rather than a set: no
 * transcript at all → startup; the last `tool_use` with no result → that tool;
 * anything else → a permission with no tool named.
 */

import type { ToolEntry, Turn } from './reducer';
import { toolDetail } from './toolCalls';

/** The tool a question blocks under; its answers are the dialog's options. */
const ASK_USER_QUESTION = 'AskUserQuestion';
/** The tool plan approval blocks under; its `plan` is what the dialog shows. */
const EXIT_PLAN_MODE = 'ExitPlanMode';

/** The four blocks a Claude session can be sitting in. */
export type WaitingKind = 'startup' | 'question' | 'plan' | 'permission';

/** What the card says, and which block it says it about. */
export interface WaitingCardModel {
	kind: WaitingKind;
	/** The card's one heading line, sentence case (Obsidian guidelines). */
	title: string;
	/** The question, the plan or the tool's one-line detail; empty for none. */
	body: string;
	/** The answers `AskUserQuestion` offered; empty for every other kind. */
	options: string[];
	/**
	 * The dangling `tool_use` this block is about, empty when none dangles. It is
	 * what tells one block from the next, so auto-accept presses each once.
	 */
	toolUseId: string;
}

/**
 * The transcript's **newest** `tool_use` when no `tool_result` has answered it,
 * and null otherwise — including when the newest call has landed and an older
 * one never did.
 *
 * Scanned backwards over every turn for the last call of any kind, because that
 * is what the transcript shows a block as (`docs/architecture.md`): the call
 * Claude is waiting on is the last one written, and it has no result yet. A
 * call further back that never got one — a background launch that was
 * interrupted — is not what the dialog on screen is about, so a newest call
 * that has landed names nothing rather than reaching past it: an unnamed block
 * is one the view refuses to answer by itself (#99), which is the safe end to
 * fall off.
 */
export function danglingToolUse(turns: readonly Turn[]): ToolEntry | null {
	for (let t = turns.length - 1; t >= 0; t--) {
		const entries = turns[t]?.entries ?? [];
		for (let e = entries.length - 1; e >= 0; e--) {
			const entry = entries[e];
			if (entry?.kind !== 'tool') continue;
			return entry.result === null ? entry : null;
		}
	}
	return null;
}

/**
 * The card for a blocked agent.
 *
 * `hasTranscript` is the session model's path: a pane whose Claude has not
 * written a file yet is blocked at startup on the workspace trust prompt, which
 * is the one block that exists before any transcript does.
 */
export function waitingCard(input: {
	hasTranscript: boolean;
	turns: readonly Turn[];
	/** For the tool detail line, which is the tool group's own formatting. */
	vaultPath: string;
}): WaitingCardModel {
	if (!input.hasTranscript) {
		return {
			kind: 'startup',
			title: 'Claude is asking whether to trust this folder',
			body: 'Answer it in the terminal. Enter would choose "No, exit" here.',
			options: [],
			toolUseId: '',
		};
	}
	const tool = danglingToolUse(input.turns);
	if (tool?.name === ASK_USER_QUESTION) {
		const { question, options } = firstQuestion(tool);
		return {
			kind: 'question',
			title: 'Claude asked a question',
			body: question,
			options,
			toolUseId: tool.id,
		};
	}
	if (tool?.name === EXIT_PLAN_MODE) {
		return {
			kind: 'plan',
			title: 'Claude is ready to code',
			body: textField(tool, 'plan'),
			options: [],
			toolUseId: tool.id,
		};
	}
	if (tool) {
		return {
			kind: 'permission',
			title: `Claude wants to use ${tool.name}`,
			// The tool group's own one-line detail (#95), so a call reads the same
			// here as it does in the turn it belongs to.
			body: toolDetail(tool, input.vaultPath),
			options: [],
			toolUseId: tool.id,
		};
	}
	return {
		kind: 'permission',
		title: 'Claude is waiting for permission',
		body: '',
		options: [],
		toolUseId: '',
	};
}

/**
 * The question an `AskUserQuestion` call is blocked on, and the answers it
 * offered.
 *
 * The **first** question: the input is a list, and a call that asks several
 * shows them one dialog at a time in the terminal, which is where the rest are
 * answered anyway. The card's job is to say what the block is, not to be the
 * dialog.
 */
function firstQuestion(entry: ToolEntry): { question: string; options: string[] } {
	const first = firstOf(entry.input.questions);
	if (!first || typeof first !== 'object') return { question: '', options: [] };
	const asked: unknown = (first as { question?: unknown }).question;
	const offered: unknown = (first as { options?: unknown }).options;
	const options = (Array.isArray(offered) ? (offered as unknown[]) : [])
		.map((option) =>
			option && typeof option === 'object' ? (option as { label?: unknown }).label : null,
		)
		.filter((label): label is string => typeof label === 'string' && label !== '');
	return { question: typeof asked === 'string' ? asked.trim() : '', options };
}

/** The first element of a value that is a list, and null for anything else. */
function firstOf(value: unknown): unknown {
	return Array.isArray(value) ? ((value as unknown[])[0] ?? null) : null;
}

/** One string field of a call's input, trimmed; empty when it is not a string. */
function textField(entry: ToolEntry, field: string): string {
	const value = entry.input[field];
	return typeof value === 'string' ? value.trim() : '';
}
