/**
 * The herdr kind (ADR-0004): the herdr TUI multiplexer, on this machine or
 * over SSH, behind the {@link RuntimeKindAdapter} seam.
 *
 * Nothing here is new behaviour; it is what `main.ts` did for "local, or the
 * one remote" before the registry, moved behind the seam and reading the
 * runtime snapshot of the attempt instead of the live settings:
 *
 * - **Connection.** On `local` the client opens the discovered socket; on
 *   `ssh` it opens the local end of an `ssh -N -L` forward to the runtime's
 *   socket (PRD S5).
 * - **Scope.** `WorkspaceScope`, one workspace, chosen by the runtime's
 *   workspace override, then the vault name, then cwd (`herdr/scope.ts`).
 * - **Terminal tabs.** `herdr terminal session` over child-process pipes,
 *   spawned through `ssh -T` on an `ssh` target (PRD S17). A local runtime's
 *   binary is its override, `~` expanded (spawn has no shell), else what this
 *   kind's own last discovery of that runtime found, else it is discovered
 *   when the tab starts. Never the active connection's discovery: that may be
 *   another kind's binary, or none (an SSH herdr-core runtime).
 * - **Actions and prompts.** herdr's JSON API methods (`actions.ts`,
 *   `native/promptSender.ts`).
 * - **Native view.** A session watcher over the connection's scope and
 *   client (`herdr/sessionWatcher.ts`) and this machine's transcript files,
 *   on a `local` target only: herdr over SSH has no transcript adapter, so
 *   its panes keep the terminal (ADR-0002).
 */

import { TerminalSession } from '../bridge/terminalSession';
import type { Endpoint } from '../connection';
import { HerdrActions } from '../actions';
import { homedir } from 'node:os';
import type { RuntimeConfig } from '../runtimes';
import { defaultDeps, discoverHerdr, expandHome, type DiscoveryDeps } from '../herdr/binary';
import { HerdrClient, type ProtocolMismatch } from '../herdr/client';
import { SCOPE_SUBSCRIPTIONS, WorkspaceScope } from '../herdr/scope';
import { primeHerdrScope, startHerdrStream } from '../herdr/connect';
import { defaultDeps as sshDefaultDeps, SshTunnel, terminalArgvPrefix, type RunCommand } from '../herdr/ssh';
import { probeLocal, probeOverSsh } from '../agents/probe';
import { clientKeySender, clientPromptSender } from '../native/promptSender';
import { herdrAgentStatus, herdrScreenAccess } from '../native/screenAccess';
import { screenSettingsSender } from '../native/screenSettings';
import { gatePromptSender } from '../native/paneGate';
import { LocalTranscriptSource } from '../native/transcriptSource';
import { herdrSessionWatcher, sessionBelongsTo } from '../herdr/sessionWatcher';
import { HerdrCommandCatalog, localPaneClaudeDeps, PaneClaudeResolver } from '../herdr/paneClaude';
import { TabLabelCache } from '../tabLabels';
import { herdrStatusLines } from '../herdr/status';
import { HERDR_CAPABILITIES, type RuntimeKindAdapter } from './kind';

/** What the herdr kind needs from the plugin; everything Obsidian-shaped is here. */
export interface HerdrKindHost {
	/** Colon-separated PATH additions from the settings, read per attempt. */
	extraPath(): string;
	/** This vault's absolute path on this machine. */
	vaultPath(): string;
	/** Injected in tests; the real filesystem, PATH and processes otherwise. */
	discoveryDeps?: DiscoveryDeps;
	/** Runs the agent probe's `ssh` (issue #125); injected in tests, never spawned there. */
	sshRun?: RunCommand;
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
	const deps = (): DiscoveryDeps => host.discoveryDeps ?? defaultDeps();
	const home = (): string => host.discoveryDeps?.home ?? homedir();
	/**
	 * The binary each local runtime's last discovery found, by runtime id;
	 * only searches, since an override is read from the runtime itself.
	 */
	const discovered = new Map<string, string>();
	const discoverLocal = (runtime: Readonly<RuntimeConfig>) =>
		discoverHerdr(
			{
				override: runtime.binary,
				extraPath: host.extraPath(),
				socketOverride: runtime.socketPath,
			},
			deps(),
		).then((found) => {
			if (found.binary && found.binary.source !== 'setting') {
				discovered.set(runtime.id, found.binary.path);
			}
			return found;
		});
	/** A local runtime's binary as spawn needs it, or empty until discovered. */
	const localBinary = (runtime: Readonly<RuntimeConfig>): string => {
		const override = runtime.binary.trim();
		return override ? expandHome(override, home()) : (discovered.get(runtime.id) ?? '');
	};
	/**
	 * The protocol mismatch the newest attempt's client reported, until the
	 * next attempt (ADR-0004: warn, never refuse). Kept apart from the client
	 * so the status still says it after the client's own record is cleared.
	 */
	let mismatch: ProtocolMismatch | null = null;
	const mismatchOf = (client: HerdrClient | null): ProtocolMismatch | null => mismatch ?? client?.lastMismatch ?? null;
	/** One for every local runtime of this kind: they all read this machine's files. */
	const localTranscripts = new LocalTranscriptSource();
	/**
	 * Each local connection's pane Claude reader (issue #132), shared by its
	 * session watcher and its `/` list. A connection over SSH has none: its
	 * panes' processes are on another machine, and its native view is off.
	 */
	const paneClaude = new WeakMap<HerdrClient, PaneClaudeResolver>();
	const paneCatalogs = new WeakMap<HerdrClient, HerdrCommandCatalog>();
	const resolverFor = (connection: {
		endpoint: Endpoint;
		client: HerdrClient;
	}): PaneClaudeResolver | null => {
		if (connection.endpoint.runtime.target !== 'local') return null;
		const { client } = connection;
		let resolver = paneClaude.get(client);
		if (!resolver) {
			resolver = new PaneClaudeResolver(localPaneClaudeDeps((paneId) => client.paneProcessInfo(paneId), home()));
			paneClaude.set(client, resolver);
		}
		return resolver;
	};
	return {
		kind: 'herdr',
		unavailable: null,
		terminalUnavailable: null,
		capabilities: HERDR_CAPABILITIES,
		nativeUnavailable: null,
		native: {
			transcriptAccess: (endpoint) => (endpoint.runtime.target === 'local' ? 'local' : null),
			watcher: (connection) => herdrSessionWatcher(connection, resolverFor(connection)),
			// A local file needs no connection, so a tab on a local herdr keeps
			// following its transcript while another runtime is active.
			transcripts: (endpoint) => (endpoint.runtime.target === 'local' ? localTranscripts : null),
			// A Claude pane's: its own Claude's configuration folder, read over
			// the connection; without it, this machine's `~/.claude` as before.
			// Any other agent's is its format's, read here (ADR-0010).
			commandCatalog: (_endpoint, connection, agent) => {
				if (agent !== 'claude') return null;
				const resolver = connection ? resolverFor(connection) : null;
				if (!connection || !resolver) return null;
				let catalog = paneCatalogs.get(connection.client);
				if (!catalog) {
					const { scope } = connection;
					catalog = new HerdrCommandCatalog(resolver, (paneId) => {
						const session = scope.paneInfo(paneId)?.agent_session;
						return sessionBelongsTo(scope.get(paneId)?.agent, session?.agent) ? (session?.value ?? '') : '';
					});
					paneCatalogs.set(connection.client, catalog);
				}
				return catalog;
			},
		},
		connection: {
			discover: (endpoint) => {
				// A new attempt: what the last one's client said no longer holds.
				mismatch = null;
				const runtime = endpoint.runtime;
				if (runtime.target === 'local') return discoverLocal(runtime);
				// An SSH runtime's binary lives on the remote host; the local one
				// is only searched for, for the settings status.
				return discoverHerdr({ override: '', extraPath: host.extraPath() }, deps());
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
					onProtocolMismatch: (reported) => {
						mismatch = reported;
					},
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
		createTerminalSession: (options, endpoint) => {
			const runtime = endpoint.runtime;
			// SSH: `['ssh','-T',host,<remote herdr>]`, the remote shell expanding
			// a `~` — terminals never go through the forwarded API socket (PRD
			// S17); a runtime with no host throws its reason. Local: `[<herdr>]`,
			// or, while the binary is still to be found, the session finds it.
			if (runtime.target === 'ssh') {
				return new TerminalSession({ ...options, command: terminalArgvPrefix(runtime, '') });
			}
			const local = localBinary(runtime);
			if (local) return new TerminalSession({ ...options, command: terminalArgvPrefix(runtime, local) });
			return new TerminalSession({
				...options,
				command: [],
				resolveCommand: async () => {
					const known = localBinary(runtime);
					if (known) return [known];
					const found = await discoverLocal(runtime);
					if (!found.binary) throw new Error(found.error ?? 'herdr binary not found');
					return [found.binary.path];
				},
			});
		},
		createActions: (actionHost) => new HerdrActions(actionHost),
		// The agent catalog's probe (issue #125): this machine's binary search,
		// or one `ssh` to the host; herdr's version gates the kinds it accepts.
		// The catalog asks once the first ping answered, so the version is
		// known; it is read after the probe, as the connection has it then.
		probeAgents: async (connection, programs) => {
			const runtime = connection.endpoint.runtime;
			const probe =
				runtime.target === 'ssh'
					? await probeOverSsh(runtime.host, programs, host.sshRun ?? sshDefaultDeps().run, {
							vaultRoot: runtime.remoteVaultPath,
						})
					: await probeLocal(programs, { extraPath: host.extraPath(), vaultRoot: host.vaultPath() }, deps());
			return { ...probe, herdrVersion: connection.client.serverVersion };
		},
		// Behind the pane gate: nothing is typed into a picker the session bar
		// opened (review of #169). The settings driver sends unwrapped.
		promptSender: (client) => gatePromptSender(clientPromptSender(client), () => client()),
		keySender: (client) => clientKeySender(client),
		screen: (client) => herdrScreenAccess(client),
		// The session bar's pickers (#169, #170): Claude's own pickers and
		// footer on the pane's screen, for an agent whose format reads them.
		sessionSettings: (client, format) =>
			format?.screenSettings
				? screenSettingsSender({
						screen: herdrScreenAccess(client),
						prompt: clientPromptSender(client),
						reader: format.screenSettings,
						status: herdrAgentStatus(client),
						owner: () => client(),
						models: format.models,
						modeLabels: format.modeLabels,
					})
				: null,
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
		// Binary, socket, server, tunnel and workspace (`../herdr/status.ts`).
		statusLines: (connection, context) => {
			const client = connection?.client ?? null;
			const tunnel = connection?.tunnel ?? null;
			const scope = connection?.scope ?? null;
			return herdrStatusLines({
				runtime: context.runtime,
				discovery: context.discovery,
				socketPath: client?.socket ?? context.discovery?.socketPath ?? '',
				tunnel: tunnel ? { text: tunnel.statusText, connected: tunnel.status.state === 'connected' } : null,
				mismatch: mismatchOf(client),
				workspace: scope?.workspaceId
					? { id: scope.workspaceId, label: scope.workspaceLabel, method: scope.method, agentCount: scope.size }
					: null,
				error: context.error,
			});
		},
		mismatched: (connection) => mismatchOf(connection?.client ?? null) !== null,
	};
}
