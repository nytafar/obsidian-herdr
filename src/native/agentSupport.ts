/**
 * Which panes the native view can show, by the agent they run (issues #155,
 * #137; ADR-0010).
 *
 * A runtime's session watcher asks this with its own kind and the pane's
 * agent as the runtime reports it (finding `agent-codex`, fact 1): herdr's
 * `PaneInfo.agent`, herdr-core's `agentKindOf`; the `claude` kind runs only
 * Claude and never asks. The answer is the agent seam's gate
 * (`offersNativeView` in `../agents/format.ts`): a format for the agent, and a
 * session binding the runtime can vouch for. This module only words the
 * refusal, so the + menu, the settings and the native view agree because they
 * read one rule.
 */

import { BUILTIN_AGENTS } from '../agents/catalog';
import { agentFormat, formatAgents, nativeSupport } from '../agents/format';
import type { RuntimeKind } from '../runtimes';

/** An agent kind's name as the menu shows it, or the kind itself. */
function agentName(kind: string): string {
	return BUILTIN_AGENTS.find((agent) => agent.kind === kind)?.name ?? kind;
}

/** The agents the native view reads, as a sentence names them: "Claude", "Claude or Codex". */
function readableAgents(): string {
	const names = formatAgents().map((agent) => agentFormat(agent)?.name ?? agent);
	if (names.length <= 1) return names[0] ?? 'no agent';
	return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1] ?? ''}`;
}

/**
 * Why a pane running `agent` on a runtime of `kind` cannot be shown
 * natively, or null when it can or runs no agent yet: a pane with no agent
 * behaves as it always did, and its runtime decides.
 */
export function nativeAgentReason(kind: RuntimeKind, agent: string | null | undefined): string | null {
	const id = agent?.trim().toLowerCase() ?? '';
	if (!id) return null;
	const { format, binding } = nativeSupport(kind, id);
	if (!format) return `this pane runs ${agentName(id)}, and the native view reads only ${readableAgents()}`;
	if (binding === 'hint') {
		return `this pane runs ${agentName(id)}, and the session this runtime reports for it may be another pane's`;
	}
	if (binding === 'absent') return `this pane runs ${agentName(id)}, and this runtime reports no session for it`;
	return null;
}
