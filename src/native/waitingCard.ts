/**
 * The waiting card (issue #99).
 *
 * What the native view shows when the agent status is `blocked`
 * (CONTEXT.md): the kind of block and a way to answer it. This file is the
 * *kind*, as a value — the surface draws it — because which kind a block is
 * decides the one thing in the native view that presses a key in someone's
 * session, namely whether the workspace trust prompt is what is on screen.
 *
 * **Only the trust prompt is answered from here.** Tool permissions are
 * Claude's own, decided by its permission mode, and a plugin that pressed
 * "Yes" for them would be answering a question it was never asked; questions
 * and plan approval are the user's. Those three kinds exist so the card can
 * say what the block is, and the terminal is where they are answered.
 *
 * **The runtime's word first.** A runtime that reports what kind of block it
 * is (herdr-core's `permission`, `question` and `auth`, ADR-0006) is believed,
 * and the transcript only fills in the detail. One that does not (herdr) gets
 * the transcript-shape guess, in the ticket's order, an order rather than a
 * set: no transcript at all → startup; the last `tool_use` with no result →
 * that tool; anything else → a permission with no tool named.
 *
 * **A dialog the runtime owns is answered here.** The `claude` kind runs its
 * agents itself and its permission prompts arrive as requests it holds
 * (ADR-0007): the card is then built from that {@link PendingRequest} — a
 * tool permission, an `AskUserQuestion` or an `ExitPlanMode` plan — and the
 * surface answers it through the kind's responder. That is a different thing
 * from pressing keys in a terminal: the runtime asked, and it says what for.
 *
 * **The agent's word on its calls.** Which dangling call is a question or a
 * plan, and what it asks, is the agent format's (`AgentFormat.pendingCall`,
 * ADR-0010): Claude blocks on `AskUserQuestion` and `ExitPlanMode`, another
 * agent on a call whose input says why it needs approval. The card names the
 * agent by its format.
 *
 * **A guess is never answered unasked.** The card says whether its kind was
 * {@link WaitingCardModel.reported} by the runtime. A startup guessed from "no
 * transcript yet" is also what an auth prompt, or any other dialog before the
 * session exists, looks like, so only a runtime-reported `trust` may be
 * answered automatically; a guessed one still gets the button.
 */

import type { PendingQuestionOption, PendingRequest } from './pendingRequest';
import type { ToolEntry, Turn } from './conversation';
import type { BlockKind } from './sessionWatcher';
import { toolDetail } from './toolCalls';
import type { AgentFormat } from '../agents/format';
import { defaultAgentFormat } from '../agents/catalog';

/** The blocks a session can be sitting in, as the card tells them apart. */
export type WaitingKind = 'startup' | 'question' | 'plan' | 'permission' | 'auth';

/** What the card says, and which block it says it about. */
export interface WaitingCardModel {
	kind: WaitingKind;
	/** The card's one heading line, sentence case (Obsidian guidelines). */
	title: string;
	/** The question, the plan or the tool's one-line detail; empty for none. */
	body: string;
	/**
	 * The answers `AskUserQuestion` offered, each with the description Claude
	 * gave it (empty for none); empty for every other kind.
	 */
	options: PendingQuestionOption[];
	/**
	 * The dangling `tool_use` this block is about, empty when none dangles — as
	 * it always is at startup, which is the one kind that gets answered. It is
	 * what tells one block from the next, so the trust answer goes out once.
	 */
	toolUseId: string;
	/**
	 * True when the runtime reported the kind, false when it was guessed from
	 * the transcript's shape. Only a reported startup is answered without the
	 * user pressing anything.
	 */
	reported: boolean;
	/**
	 * The runtime's own request this card is about, which the card can answer;
	 * null for every card built from a block kind or the transcript.
	 */
	request: PendingRequest | null;
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
 * that has landed names nothing rather than reaching past it: a block with no
 * call named is still a block the view only describes (#99), which is the safe
 * end to fall off.
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
 * What the card calls the agent: its format's name, or the default agent's
 * for a caller that names no format, as before agents had formats.
 */
function nameOf(format: AgentFormat | null | undefined): string {
	return (format ?? defaultAgentFormat())?.name ?? 'The agent';
}

/** The startup card: the workspace trust prompt, the one block the view answers. */
function startupCard(reported: boolean, agent: string): WaitingCardModel {
	return {
		kind: 'startup',
		title: `${agent} is asking whether to trust this folder`,
		body: reported
			? 'Trusting it here answers the prompt; the terminal answers it too.'
			: 'No session has started yet, which is how the trust prompt looks. Open the terminal to be sure; trusting it here answers that prompt.',
		options: [],
		toolUseId: '',
		reported,
		request: null,
	};
}

/**
 * The card for a request the runtime is waiting on (ADR-0007). Never the
 * startup kind, so nothing here is ever answered without a press. `format`
 * is the agent's that asked; absent, the default agent's.
 */
export function requestCard(
	request: PendingRequest,
	vaultPath: string,
	format?: AgentFormat | null,
): WaitingCardModel {
	const agent = nameOf(format);
	if (request.kind === 'question') {
		const first = request.questions[0];
		return {
			kind: 'question',
			title: `${agent} asked a question`,
			body: first?.question ?? '',
			options: first?.options.map((option) => ({ ...option })) ?? [],
			toolUseId: request.toolUseId,
			reported: true,
			request,
		};
	}
	if (request.kind === 'plan') {
		return {
			kind: 'plan',
			title: `${agent} is ready to code`,
			body: request.plan,
			options: [],
			toolUseId: request.toolUseId,
			reported: true,
			request,
		};
	}
	const entry: ToolEntry = {
		kind: 'tool',
		id: request.toolUseId,
		name: request.toolName,
		input: { ...request.input },
		result: null,
		status: 'running',
		notification: null,
		report: null,
	};
	return {
		kind: 'permission',
		title: `${agent} wants to use ${request.toolName}`,
		body: toolDetail(entry, vaultPath),
		options: [],
		toolUseId: request.toolUseId,
		reported: true,
		request,
	};
}

/**
 * The card for a blocked agent.
 *
 * `blockKind` is what the runtime reported, null when it reports none.
 * `hasTranscript` is the session model's path: without a reported kind, a
 * pane whose agent has not written a file yet is taken to be blocked at
 * startup on the workspace trust prompt, which is the one block that exists
 * before any transcript does. What a dangling call asks is the agent's
 * format's to read (`AgentFormat.pendingCall`).
 */
export function waitingCard(input: {
	blockKind?: BlockKind | null;
	hasTranscript: boolean;
	turns: readonly Turn[];
	/** For the tool detail line, which is the tool group's own formatting. */
	vaultPath: string;
	/** The runtime's own pending request, which wins over everything else. */
	request?: PendingRequest | null;
	/**
	 * The plan from the agent's plan file, while the session is in plan mode
	 * (#148); null or absent otherwise. Claude's `ExitPlanMode` reaches the
	 * transcript only with its answer, so a block in plan mode with no call
	 * dangling is taken to be plan approval when there is a plan to show.
	 */
	plan?: string | null;
	/** The format of the pane's agent; absent, the default agent's. */
	format?: AgentFormat | null;
}): WaitingCardModel {
	const format = input.format ?? defaultAgentFormat();
	const agent = nameOf(format);
	if (input.request) return requestCard(input.request, input.vaultPath, format);
	const kind = input.blockKind ?? null;
	if (kind === 'trust') return startupCard(true, agent);
	if (kind === 'auth') {
		return {
			kind: 'auth',
			title: `${agent} needs you to sign in`,
			body: 'Signing in happens in the terminal.',
			options: [],
			toolUseId: '',
			reported: true,
			request: null,
		};
	}
	if (kind === null && !input.hasTranscript) return startupCard(false, agent);
	const reported = kind !== null;
	const tool = danglingToolUse(input.turns);
	const asked = tool ? (format?.pendingCall(tool) ?? null) : null;
	if (tool && asked?.kind === 'question' && kind !== 'permission') {
		return {
			kind: 'question',
			title: `${agent} asked a question`,
			body: asked.question,
			options: asked.options,
			toolUseId: tool.id,
			reported,
			request: null,
		};
	}
	if (kind === 'question') {
		// A pending question is not in the transcript (`docs/architecture.md`):
		// the runtime says it is one, and the terminal shows what it asks.
		return {
			kind: 'question',
			title: `${agent} asked a question`,
			body: '',
			options: [],
			toolUseId: tool?.id ?? '',
			reported,
			request: null,
		};
	}
	const planFile = input.plan?.trim() ?? '';
	if (tool && asked?.kind === 'plan') {
		return {
			kind: 'plan',
			title: `${agent} is ready to code`,
			body: asked.plan || planFile,
			options: [],
			toolUseId: tool.id,
			reported,
			request: null,
		};
	}
	if (!tool && planFile) {
		// Plan approval as Claude writes it now: no call dangles, and the plan is
		// the file it wrote before asking (#148). A question asked in plan mode
		// looks the same to a runtime that names no kind (herdr); the card says
		// where either is answered.
		return {
			kind: 'plan',
			title: `${agent} is ready to code`,
			body: planFile,
			options: [],
			toolUseId: '',
			reported,
			request: null,
		};
	}
	if (tool) {
		return {
			kind: 'permission',
			title: `${agent} wants to use ${tool.name}`,
			// The reason the agent gave in the call, where it writes one; else the
			// tool group's own one-line detail (#95), so a call reads the same
			// here as it does in the turn it belongs to.
			body: (asked?.kind === 'permission' && asked.reason) || toolDetail(tool, input.vaultPath),
			options: [],
			toolUseId: tool.id,
			reported,
			request: null,
		};
	}
	return {
		kind: 'permission',
		title: `${agent} is waiting for permission`,
		body: '',
		options: [],
		toolUseId: '',
		reported,
		request: null,
	};
}

/** Claude's own mark on the option it recommends: a suffix on the label. */
const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i;

/**
 * An option's label as the card shows it, and whether Claude recommended it.
 *
 * Claude marks its pick by writing "(Recommended)" after the label, which
 * the card draws as a tag instead. Only the shown text changes: an answer is
 * always sent under the label exactly as Claude wrote it, suffix included,
 * because that is the option it offered. A label that is nothing but the
 * suffix keeps it, so no option is ever drawn blank.
 */
export function optionName(label: string): { text: string; recommended: boolean } {
	const text = label.replace(RECOMMENDED_SUFFIX, '');
	if (text === label || text.trim() === '') return { text: label, recommended: false };
	return { text, recommended: true };
}
/**
 * Whether a keystroke in a typed answer sends it: Enter, unless an input
 * method is composing with it. WebKit can deliver the Enter that commits an
 * IME candidate after `compositionend`, as key code 229, so that one is the
 * input method's too.
 */
export function isTypedAnswerKey(event: { key: string; isComposing?: boolean; keyCode?: number }): boolean {
	return event.key === 'Enter' && event.isComposing !== true && event.keyCode !== 229;
}

/**
 * One question's answer as it is sent: the options picked, in the order Claude
 * offered them and under their labels exactly as written, then the user's
 * typed answer, joined with ", " as Claude's own dialog joins a multiple
 * choice. For a single choice the card keeps only one of the two. Empty when
 * nothing is given.
 */
export function questionAnswer(
	offered: readonly PendingQuestionOption[],
	picked: ReadonlySet<string>,
	typed: string,
): string {
	const parts = offered.map((option) => option.label).filter((label) => picked.has(label));
	const own = typed.trim();
	if (own) parts.push(own);
	return parts.join(', ');
}
