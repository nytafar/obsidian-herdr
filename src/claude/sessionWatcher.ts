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
 * resumes it. So does a TUI that has not reported its status (`unknown` in
 * the agent list): a prompt to it asks the user before the TUI is stopped
 * for it. `trust` is never reported.
 *
 * **Seen.** "Done" lasts until a person looks. A native view says when a
 * person is in front of it (`looking`, per viewer, as herdr-core's
 * `herdr.seen` rules have it): the agent is marked seen then, and so is a
 * turn that ends while any view of it is still being looked at, since the
 * view's look does not change when the agent's status does. The pane stops
 * being looked at when its last viewer looks away.
 */

import type { AgentStatus } from '../herdr/types.gen';
import type { PendingRequest } from '../native/pendingRequest';
import type { BlockKind, PaneSnapshot, SessionWatcher, Unsubscribe } from '../native/sessionWatcher';
import type { ClaudeAgents } from './agents';
import { paneStatusOf } from './scope';

export function claudeSessionWatcher(agents: ClaudeAgents, runtimeId: string): SessionWatcher {
	/** Who is looking at which agent; an agent with nobody has no entry. */
	const lookers = new Map<string, Set<object>>();
	let offLooks: Unsubscribe | null = null;
	const seenIfLooked = (runtime: string, agentId: string): void => {
		if (runtime !== runtimeId || !lookers.has(agentId)) return;
		if (agents.get(runtimeId, agentId)?.status === 'done') agents.seen(runtimeId, agentId);
	};
	const snapshot = (paneId: string): PaneSnapshot | null => {
		const agent = agents.get(runtimeId, paneId);
		if (!agent) return null;
		const pane: PaneSnapshot = {
			paneId,
			cwd: agent.cwd,
			agentSession: agent.sessionId,
			transcriptPath: agent.transcriptPath,
			agentStatus: agent.status === 'unknown' ? 'idle' : paneStatusOf(agent.status),
		};
		if (agent.status === 'stopped') pane.stopped = true;
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
			const last = new Map<
				string,
				{ status: AgentStatus; kind: BlockKind | null; request: PendingRequest | null; stopped: boolean }
			>();
			return agents.on((runtime, agentId, change) => {
				if (runtime !== runtimeId) return;
				if (change === 'removed') {
					last.delete(agentId);
					return;
				}
				const pane = snapshot(agentId);
				if (!pane) return;
				const next = {
					status: pane.agentStatus,
					kind: pane.blockKind ?? null,
					request: pane.request ?? null,
					// A stop reads as `idle`, so it is a change of its own (#135).
					stopped: pane.stopped === true,
				};
				const before = last.get(agentId);
				if (
					before &&
					before.status === next.status &&
					before.kind === next.kind &&
					before.request === next.request &&
					before.stopped === next.stopped
				) {
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
		// A person in front of a native view has seen a finished turn, and
		// sees the next one finish too while still there.
		looking(paneId, viewer, looking): void {
			if (looking) {
				const viewers = lookers.get(paneId) ?? new Set<object>();
				viewers.add(viewer);
				lookers.set(paneId, viewers);
				offLooks ??= agents.on((runtime, agentId, change) => {
					if (change === 'removed') return;
					seenIfLooked(runtime, agentId);
				});
				agents.seen(runtimeId, paneId);
				return;
			}
			const viewers = lookers.get(paneId);
			if (!viewers?.delete(viewer) || viewers.size > 0) return;
			lookers.delete(paneId);
			if (lookers.size === 0) {
				offLooks?.();
				offLooks = null;
			}
		},
	};
}
