/**
 * Which agents the native view can show (issue #155).
 *
 * The native view reads Claude Code's transcript, so a pane running any other
 * agent stays a terminal and says why. A runtime's session watcher asks this
 * with the pane's agent kind as the runtime reports it (finding
 * `agent-codex`, fact 1): herdr's `PaneInfo.agent`, herdr-core's
 * `agentKindOf`; the `claude` kind runs only Claude and never asks. Without
 * this a Codex pane on herdr opened an empty native view, its thread id taken
 * for a Claude session.
 *
 * The one place the rule lives: #137 replaces "is Claude" with "a transcript
 * format is registered for the agent and its session binding is trusted".
 */

import { BUILTIN_AGENTS } from '../agents/catalog';

/** The agent kind the native view reads. */
export const NATIVE_AGENT_KIND = 'claude';

/** An agent kind's name as the menu shows it, or the kind itself. */
function agentName(kind: string): string {
	return BUILTIN_AGENTS.find((agent) => agent.kind === kind)?.name ?? kind;
}

/**
 * Why a pane running `agent` cannot be shown natively, or null when it can or
 * runs no agent yet: a pane with no agent behaves as it always did, and its
 * runtime decides.
 */
export function nativeAgentReason(agent: string | null | undefined): string | null {
	const kind = agent?.trim().toLowerCase() ?? '';
	if (!kind || kind === NATIVE_AGENT_KIND) return null;
	return `this pane runs ${agentName(kind)}, and the native view reads only Claude`;
}
