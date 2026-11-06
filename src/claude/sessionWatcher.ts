/**
 * The `claude` kind's session watcher (ADR-0007): what the native view's
 * session models read of an agent the plugin runs, behind the kind-neutral
 * contract in `../native/sessionWatcher.ts`.
 *
 * Everything comes from the stream through the agent table, never from the
 * transcript: the session id (plugin-generated, then whatever the next
 * `system:init` says after a `/clear`), the status from the turn boundaries,
 * and while a `can_use_tool` request waits, the block kind and the request
 * itself, which the waiting card answers. Content stays the transcript's
 * (ADR-0003), at the path the agent table resolves the way Claude files it
 * (`CLAUDE_CONFIG_DIR`, the cwd's real path as `init` reports it), so a
 * symlinked folder or a moved configuration folder is still found.
 *
 * A stopped agent reads as `idle`, so its prompt box sends, and sending
 * resumes it. `trust` is never reported.
 */

import type { AgentStatus } from '../herdr/types.gen';
import type { PendingRequest } from '../native/pendingRequest';
import type { BlockKind, PaneSnapshot, SessionWatcher, Unsubscribe } from '../native/sessionWatcher';
import type { ClaudeAgents } from './agents';
import { paneStatusOf } from './scope';

export function claudeSessionWatcher(agents: ClaudeAgents, runtimeId: string): SessionWatcher {
	const snapshot = (paneId: string): PaneSnapshot | null => {
		const agent = agents.get(runtimeId, paneId);
		if (!agent) return null;
		const pane: PaneSnapshot = {
			paneId,
			cwd: agent.cwd,
			agentSession: agent.sessionId,
			transcriptPath: agent.transcriptPath,
			agentStatus: paneStatusOf(agent.status),
		};
		if (agent.blockKind) pane.blockKind = agent.blockKind;
		if (agent.request) pane.request = agent.request;
		return pane;
	};
	return {
		snapshot,
		onSession(handler): Unsubscribe {
			return agents.on((runtime, agentId, change) => {
				if (runtime !== runtimeId || (change !== 'session' && change !== 'added')) return;
				const agent = agents.get(runtimeId, agentId);
				if (agent) handler(agentId, agent.sessionId, agent.transcriptPath);
			});
		},
		onStatus(handler): Unsubscribe {
			// One call per actual change of status, block kind or request.
			const last = new Map<string, { status: AgentStatus; kind: BlockKind | null; request: PendingRequest | null }>();
			return agents.on((runtime, agentId, change) => {
				if (runtime !== runtimeId) return;
				if (change === 'removed') {
					last.delete(agentId);
					return;
				}
				const pane = snapshot(agentId);
				if (!pane) return;
				const next = { status: pane.agentStatus, kind: pane.blockKind ?? null, request: pane.request ?? null };
				const before = last.get(agentId);
				if (before && before.status === next.status && before.kind === next.kind && before.request === next.request) {
					return;
				}
				last.set(agentId, next);
				handler(agentId, next.status, next.kind ?? undefined);
			});
		},
		onMembership(handler): Unsubscribe {
			return agents.on((runtime, agentId, change) => {
				if (runtime === runtimeId && (change === 'added' || change === 'removed')) handler(agentId);
			});
		},
		// A person in front of a native view has seen a finished turn.
		looking(paneId, _viewer, looking): void {
			if (looking) agents.seen(runtimeId, paneId);
		},
	};
}
