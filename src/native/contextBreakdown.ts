/**
 * The context breakdown (issue #171; finding `native-view-header` T7): what
 * a click on the session bar's context readout shows, in a popover over the
 * bar. One neutral shape from two sources:
 *
 * - **a context command** (Claude's `/context`) sent through the prompt
 *   sender, idle or done only, on a kind whose agent runs in a terminal
 *   (herdr, herdr-core). Its output lands in the transcript, where the
 *   agent's format reads it into `SessionInfo.contextReport` and keeps it
 *   out of the turns; the bar waits for a report newer than the one it saw
 *   when it sent;
 * - **a runtime's own request** ({@link ContextUsageReader}), on a kind
 *   that can ask its agent without writing to the conversation (the
 *   `claude` kind's `get_context_usage`), at any status.
 *
 * No Obsidian here: what is pure is tested without a DOM.
 */

import type { AgentStatus } from '../herdr/types.gen';
import { BLOCKED_REASON, NO_AGENT_REASON, WORKING_REASON } from './sessionSettings';

/** One row of the breakdown: a category and its share of the window. */
export interface ContextCategory {
	name: string;
	/** As the agent words it: `2.4k`, `276`. */
	tokens: string;
	/** Of the window: `0.2%`; empty when not stated. */
	share: string;
}

/** The context breakdown as the popover shows it. */
export interface ContextBreakdown {
	/**
	 * Tells one report from the next, so a wait for a new one is not ended by
	 * the one already there: the transcript line's uuid, or a request's own id.
	 */
	id: string;
	/** The model it was measured for, as the agent names it; empty when not stated. */
	model: string;
	/** Tokens in use, the window and the share, as the agent words them (`22.6k`, `1m`, `2%`). */
	used: string;
	window: string;
	percent: string;
	/** The categories, in the agent's order. */
	categories: ContextCategory[];
}

/**
 * A runtime kind's way of asking for the breakdown without writing to the
 * conversation (`RuntimeKindAdapter.contextUsage`). Rejects with a readable
 * message.
 */
export interface ContextUsageReader {
	read(paneId: string): Promise<ContextBreakdown>;
}

/** Why the readout opens nothing for an agent with no breakdown to ask for. */
export const NO_BREAKDOWN_REASON = 'This agent has no context breakdown.';

/** How long the bar waits for a context command's output to reach the transcript. */
export const CONTEXT_WAIT_MS = 20_000;

/** What a context command that never answered says. */
export const CONTEXT_TIMEOUT_MESSAGE = 'Gjetr: the context breakdown did not arrive in the transcript';

/**
 * Whether a click on the readout may ask now, and why not. A reader asks at
 * any status but a block; a context command goes through the prompt, so
 * only while the agent is idle or done.
 */
export function contextBlock(input: {
	status: AgentStatus;
	connected: boolean;
	paneId: string;
	reader: boolean;
	command: string | undefined;
}): string | null {
	const { status } = input;
	if (!input.connected || status === 'unknown' || !input.paneId) return NO_AGENT_REASON;
	if (!input.reader && !input.command) return NO_BREAKDOWN_REASON;
	if (status === 'blocked') return BLOCKED_REASON;
	if (!input.reader && status !== 'idle' && status !== 'done') return WORKING_REASON;
	return null;
}

/** A token count the way Claude's `/context` words it: `276`, `2.4k`, `22.6k`, `1m`. */
export function contextTokens(tokens: number): string {
	const trim = (value: number): string => value.toFixed(1).replace(/\.0$/, '');
	if (tokens < 1000) return String(Math.round(tokens));
	if (tokens < 999_950) return `${trim(tokens / 1000)}k`;
	return `${trim(tokens / 1_000_000)}m`;
}

/** The popover's headline: `claude-opus-5-5 · 22.6k / 1m tokens (2%)`. */
export function breakdownHeadline(breakdown: ContextBreakdown): string {
	const tokens = breakdown.window ? `${breakdown.used} / ${breakdown.window} tokens` : `${breakdown.used} tokens`;
	const percent = breakdown.percent ? ` (${breakdown.percent})` : '';
	return breakdown.model ? `${breakdown.model} · ${tokens}${percent}` : `${tokens}${percent}`;
}

/** What a failed read says, with the runtime's own words in the tail. */
export function contextFailureMessage(error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return `Gjetr: could not read the context breakdown (${reason})`;
}
