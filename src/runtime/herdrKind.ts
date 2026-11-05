/**
 * The herdr kind (ADR-0004): the herdr TUI multiplexer, on this machine or
 * over SSH, behind the {@link RuntimeKindAdapter} seam.
 *
 * Nothing here is new behaviour; it is what `main.ts` did for "local, or the
 * one remote" before the registry, moved behind the seam and reading the
 * runtime snapshot of the attempt instead of the live settings:
 *
 * - **Connection.** The local binary is discovered for every attempt (a
 *   terminal pinned to a local runtime needs it while an SSH one is active).
 *   On `local` the client opens the discovered socket; on `ssh` it opens the
 *   local end of an `ssh -N -L` forward to the runtime's socket (PRD S5).
 * - **Scope.** `WorkspaceScope`, one workspace, chosen by the runtime's
 *   workspace override, then the vault name, then cwd (`herdr/scope.ts`).
 * - **Terminal tabs.** `herdr terminal session` over child-process pipes,
 *   spawned through `ssh -T` on an `ssh` target (PRD S17).
 * - **Actions and prompts.** herdr's JSON API methods (`actions.ts`,
 *   `native/promptSender.ts`).
 */

import { TerminalSession } from '../bridge/terminalSession';
import type { Endpoint } from '../connection';
import { HerdrActions } from '../actions';
import { discoverHerdr } from '../herdr/binary';
import { HerdrClient, type ProtocolMismatch } from '../herdr/client';
import { SCOPE_SUBSCRIPTIONS, WorkspaceScope } from '../herdr/scope';
import { primeHerdrScope, startHerdrStream } from '../herdr/connect';
import { SshTunnel, terminalArgvPrefix } from '../herdr/ssh';
import { clientKeySender, clientPromptSender } from '../native/promptSender';
import { TabLabelCache } from '../tabLabels';
import { HERDR_CAPABILITIES, type RuntimeKindAdapter } from './kind';

/** What the herdr kind needs from the plugin; everything Obsidian-shaped is here. */
export interface HerdrKindHost {
	/** Colon-separated PATH additions from the settings, read per attempt. */
	extraPath(): string;
	/** This vault's absolute path on this machine. */
	vaultPath(): string;
	/** The local herdr binary the latest discovery found, or empty. */
	discoveredBinary(): string;
	onProtocolMismatch(mismatch: ProtocolMismatch): void;
	onUnsupportedMethod(method: string): void;
	/**
	 * Whether this scope's connection is the published one. The scope's one
	 * request (`pane.list`, issue #75) is only answered while it is: a lookup
	 * still in flight when the connection is replaced must not write into a
	 * scope nothing renders.
	 */
	isPublished(scope: WorkspaceScope): boolean;
}

export type HerdrKind = RuntimeKindAdapter<HerdrClient, WorkspaceScope, SshTunnel>;

export function createHerdrKind(host: HerdrKindHost): HerdrKind {
	return {
		kind: 'herdr',
		unavailable: null,
		terminalUnavailable: null,
		capabilities: HERDR_CAPABILITIES,
		nativeUnavailable: null,
		connection: {
			discover: (endpoint) => {
				const runtime = endpoint.runtime;
				const local = runtime.target === 'local';
				return discoverHerdr({
					// An SSH runtime's binary lives on the remote host; the local one
					// is only searched for, for terminals pinned to a local runtime.
					override: local ? runtime.binary : '',
					extraPath: host.extraPath(),
					socketOverride: local ? runtime.socketPath : undefined,
				});
			},
			// An SSH runtime only needs `ssh` here, so a missing local binary only
			// stops the local path.
			discoveryIssue: (endpoint, discovery) => {
				if (endpoint.runtime.target === 'ssh' || discovery.binary) return null;
				return discovery.error ?? 'herdr binary not found';
			},
			createTunnel: (endpoint, onSocket) => {
				const runtime = endpoint.runtime;
				if (runtime.target !== 'ssh') return null;
				// The attempt's own snapshot, not the live settings: a host typed
				// meanwhile belongs to the next attempt.
				if (runtime.host.length === 0) throw new Error('the runtime has no SSH host');
				return new SshTunnel({
					host: runtime.host,
					remoteSocketPath: runtime.socketPath,
					onStatus: (status) => {
						if (status.state === 'connected') onSocket(status.localSocketPath);
					},
				});
			},
			createClient: (socketPath) =>
				new HerdrClient({
					socketPath,
					onProtocolMismatch: (mismatch) => host.onProtocolMismatch(mismatch),
					// PRD M3: an unsupported method is reported once, then never retried.
					onUnsupportedMethod: (method) => host.onUnsupportedMethod(method),
				}),
			createScope: (endpoint, client) => {
				const runtime = endpoint.runtime;
				const scope: WorkspaceScope = new WorkspaceScope({
					workspaceId: runtime.workspace,
					vaultPath: host.vaultPath(),
					remoteVaultPath: runtime.target === 'ssh' ? runtime.remoteVaultPath : undefined,
					// The one request the scope makes: what `pane_agent_detected`
					// leaves out for a pane that just gained an agent (issue #75).
					lookupPanes: (workspaceId) =>
						host.isPublished(scope) ? client.listPanes(workspaceId) : Promise.resolve([]),
				});
				return scope;
			},
			prime: (client, scope, retired) => primeHerdrScope(client, scope, retired),
			start: (client, scope) =>
				startHerdrStream(client, scope, { subscriptions: SCOPE_SUBSCRIPTIONS }),
		},
		terminalCommand: (endpoint: Endpoint) => {
			const runtime = endpoint.runtime;
			// Local: `[<herdr>]`, the runtime's own binary when it names one, else
			// the discovered one. SSH: `['ssh','-T',host,<remote herdr>]` —
			// terminals never go through the forwarded API socket (PRD S17).
			const local = runtime.target === 'local' ? runtime.binary || host.discoveredBinary() : '';
			return terminalArgvPrefix(runtime, local);
		},
		createTerminalSession: (options) => new TerminalSession(options),
		createActions: (actionHost) => new HerdrActions(actionHost),
		promptSender: (client) => clientPromptSender(client),
		keySender: (client) => clientKeySender(client),
		// One `tab.list` cache per connection (issue #43), over its own client
		// and scope.
		createTabLabels: (connection, alive) => {
			const { client, scope } = connection;
			return new TabLabelCache({
				client,
				scope: {
					get workspaceId() {
						return scope.workspaceId;
					},
					tabIds: () => scope.list().map((pane) => pane.tabId),
					onWorkspaceResolved: (handler) => scope.on('workspaceResolved', handler),
				},
				alive,
			});
		},
		statusLines: () => null,
	};
}
