/**
 * The herdr-core kind (ADR-0005): the headless `hc` runtime, on this machine
 * or over SSH, behind the {@link RuntimeKindAdapter} seam.
 *
 * - **Connection.** A child process on both targets: `hc connect` locally
 *   (the binary is searched for like herdr's, by the name `hc`), and
 *   `ssh -T <host> sh -c '… connect'` remotely. There is no tunnel and no
 *   socket path: `hc connect` follows the core's own socket rules and starts
 *   the core if none runs. The client (`hc/client.ts`) speaks framed mode,
 *   subscribes to events and redials on its own.
 * - **Scope.** `HcScope`: the `herdr-app` document's space named by the
 *   override or like the vault, else terminals whose cwd is under the vault
 *   root; federated `machine/tN` terminals are left out (ADR-0004).
 * - **Prime.** Reads the `herdr-app` document's spaces on every `connected`
 *   edge and again on its `doc` event. The terminals themselves come with
 *   the subscription, not with the prime.
 * - **Terminal tabs.** One `hc connect` child per tab (`ssh -T` on an `ssh`
 *   target), one `terminal.attach` on it (`hc/terminalSession.ts`). A local
 *   runtime's binary is its override (`~` expanded), else the one its last
 *   discovery by this kind found, else it is searched for when the tab
 *   starts, so a tab pinned to an hc runtime still opens while a runtime of
 *   either kind is active.
 * - **Native view** (ADR-0006). The session is the label the Claude hook
 *   writes, read by `hc/sessionWatcher.ts` with the foreground pid check.
 *   Transcripts are this machine's files on a local runtime, and read with
 *   `file.read` over the runtime's own connection on an SSH one
 *   (`hc/transcriptSource.ts`). One watcher and one source per connection,
 *   so a session model never reopens a tail for a source that did not change.
 *   The prompt box's `/` list follows the same rule: this machine's files on
 *   a local runtime, the remote's through one `machine.exec` on an SSH one
 *   (`hc/commandCatalog.ts`).
 */

import type { ConnectionScope, ConnectionTunnel } from '../connection';
import { expandHome, resolveHerdrBinary, type DiscoveryResult } from '../herdr/binary';
import { HcActions, hcKeySender, hcPromptSender } from '../hc/actions';
import { HcClient, sshConnectArgv, type HcTimers } from '../hc/client';
import { HcError, type HcMismatch, type HcSpawn } from '../hc/connection';
import { HcTerminalSession } from '../hc/terminalSession';
import { LABEL_SEEN, parseSpaces } from '../hc/model';
import { HcScope } from '../hc/scope';
import { HcTabLabels } from '../hc/tabLabels';
import { hcSessionWatcher } from '../hc/sessionWatcher';
import { HcTranscriptSource } from '../hc/transcriptSource';
import { HcCommandCatalog } from '../hc/commandCatalog';
import { BUILTIN_CATALOG_SOURCE } from '../native/commandCatalog';
import { LocalTranscriptSource } from '../native/transcriptSource';
import type { SessionWatcher } from '../native/sessionWatcher';
import { remoteVaultPathIssue, type RuntimeConfig } from '../runtimes';
import { HERDR_CORE_CAPABILITIES, type RuntimeKindAdapter, type StatusLine } from './kind';

/** The document herdr-app keeps its spaces in. */
export const HERDR_APP_DOC = 'herdr-app';

export interface HerdrCoreKindHost {
	/** Colon-separated PATH additions from the settings, read per attempt. */
	extraPath(): string;
	/** The environment `hc` or `ssh` is spawned with (PATH widened). */
	spawnEnv(): NodeJS.ProcessEnv;
	/** This vault's absolute path on this machine. */
	vaultPath(): string;
	/** The vault folder's name, compared against space names. */
	vaultName(): string;
	/** The core speaks another generation: warn, never refuse (ADR-0005). */
	onMismatch(mismatch: HcMismatch, runtime: Readonly<RuntimeConfig>): void;
	/** The published connection's scope, for the space a started agent joins. */
	currentScope(): ConnectionScope | null;
	/** Injected in tests; the real child process otherwise. */
	spawn?: HcSpawn;
	timers?: HcTimers;
}

export type HerdrCoreKind = RuntimeKindAdapter<HcClient, HcScope, ConnectionTunnel>;

/** What `discover` reports for a target; herdr's status fields stay empty. */
function discovery(binary: DiscoveryResult['binary'], error: string | null): DiscoveryResult {
	return { binary, status: null, identity: null, socketPath: '', error };
}

/**
 * Reads the `herdr-app` spaces into the scope. A core without the document,
 * or too old for `doc.get`, has no spaces, which leaves the cwd rule; only a
 * lost connection is an error.
 */
export async function loadSpaces(
	client: Pick<HcClient, 'request'>,
	scope: Pick<HcScope, 'setSpaces'>,
	retired: () => boolean,
): Promise<void> {
	let value: unknown = null;
	try {
		const doc = await client.request<{ value?: unknown } | null>('doc.get', { name: HERDR_APP_DOC });
		value = doc?.value ?? null;
	} catch (error) {
		if (!(error instanceof HcError)) throw error;
	}
	if (retired()) return;
	scope.setSpaces(parseSpaces(value));
}

/** The transport line as the settings tab shows it. */
export function transportText(runtime: Readonly<RuntimeConfig>, argv: readonly string[]): string {
	if (runtime.target === 'ssh') {
		const binary = runtime.binary.trim() || 'hc';
		return `ssh -T ${runtime.host} ${binary} connect`;
	}
	return argv.join(' ');
}

/** What a local runtime says when no `hc` can be found. */
const HC_NOT_FOUND =
	'hc was not found in /opt/homebrew/bin, /usr/local/bin, ~/.local/bin or the login shell PATH';

export function createHerdrCoreKind(host: HerdrCoreKindHost): HerdrCoreKind {
	/** The local `hc` each runtime's last discovery found, by runtime id. */
	const discovered = new Map<string, string>();
	const localTranscripts = new LocalTranscriptSource();
	// Per connection, keyed by its scope, which lives exactly as long.
	const watchers = new WeakMap<HcScope, SessionWatcher>();
	const remoteTranscripts = new WeakMap<HcScope, HcTranscriptSource>();
	const remoteCatalogs = new WeakMap<HcScope, HcCommandCatalog>();
	const localArgv = (runtime: Readonly<RuntimeConfig>): string[] | null => {
		// Spawned without a shell, so a `~` in the override is expanded here.
		const override = runtime.binary.trim();
		const path = override ? expandHome(override) : discovered.get(runtime.id) || '';
		return path ? [path, 'connect'] : null;
	};
	return {
		kind: 'herdr-core',
		unavailable: null,
		terminalUnavailable: null,
		capabilities: HERDR_CORE_CAPABILITIES,
		nativeUnavailable: null,
		native: {
			transcriptAccess: (endpoint) => (endpoint.runtime.target === 'ssh' ? 'rpc' : 'local'),
			watcher: (connection) => {
				const scope = connection.scope;
				let watcher = watchers.get(scope);
				if (!watcher) {
					const client = connection.client;
					// Over the plugin's own connection: a native view has no attach
					// connection, so this is the one that is there while it shows.
					watcher = hcSessionWatcher(scope, {
						writeSeen: (address, turn) =>
							client.request('terminal.label', { terminal: address, labels: { [LABEL_SEEN]: String(turn) } }),
					});
					watchers.set(scope, watcher);
				}
				return watcher;
			},
			// A local runtime's files stay readable while another runtime is
			// active; a remote one's only through its own live connection.
			transcripts: (endpoint, connection) => {
				if (endpoint.runtime.target !== 'ssh') return localTranscripts;
				if (!connection) return null;
				const scope = connection.scope;
				let source = remoteTranscripts.get(scope);
				if (!source) {
					const client = connection.client;
					source = new HcTranscriptSource(
						{ request: (method, params) => client.request(method, params) },
						scope,
						{ timers: host.timers },
					);
					remoteTranscripts.set(scope, source);
				}
				return source;
			},
			// The `/` list of the machine the agent runs on: this one's files on
			// a local runtime, one `machine.exec` over the connection on an SSH
			// one, and only the built-ins while that connection is not there.
			commandCatalog: (endpoint, connection) => {
				if (endpoint.runtime.target !== 'ssh') return null;
				if (!connection) return BUILTIN_CATALOG_SOURCE;
				const scope = connection.scope;
				let catalog = remoteCatalogs.get(scope);
				if (!catalog) {
					const client = connection.client;
					catalog = new HcCommandCatalog(
						{ request: (method, params) => client.request(method, params) },
						{ timers: host.timers },
					);
					remoteCatalogs.set(scope, catalog);
				}
				return catalog;
			},
		},
		connection: {
			discover: async (endpoint) => {
				const runtime = endpoint.runtime;
				// The remote binary is the remote's business; only ssh runs here.
				if (runtime.target === 'ssh') return discovery(null, null);
				const binary = await resolveHerdrBinary({
					override: runtime.binary,
					extraPath: host.extraPath(),
					binaryName: 'hc',
				});
				if (binary) {
					if (binary.source !== 'setting') discovered.set(runtime.id, binary.path);
					return discovery(binary, null);
				}
				return discovery(
					null,
					runtime.binary.trim() ? `hc is not executable at ${runtime.binary.trim()}` : HC_NOT_FOUND,
				);
			},
			discoveryIssue: (endpoint, found) => {
				const runtime = endpoint.runtime;
				if (runtime.target === 'ssh') {
					return runtime.host.length === 0 ? 'the runtime has no SSH host' : null;
				}
				return found.binary ? null : (found.error ?? 'hc binary not found');
			},
			createTunnel: () => null,
			createClient: (_socketPath, endpoint, found) => {
				const runtime = endpoint.runtime;
				const argv =
					runtime.target === 'ssh'
						? sshConnectArgv(runtime.host, runtime.binary)
						: [found.binary?.path ?? 'hc', 'connect'];
				return new HcClient({
					argv,
					env: host.spawnEnv(),
					spawn: host.spawn,
					timers: host.timers,
					onMismatch: (mismatch) => host.onMismatch(mismatch, runtime),
				});
			},
			createScope: (endpoint, client) => {
				const runtime = endpoint.runtime;
				const scope = new HcScope({
					space: runtime.workspace,
					vaultPath: host.vaultPath(),
					vaultName: host.vaultName(),
					remoteVaultPath: runtime.target === 'ssh' ? runtime.remoteVaultPath : undefined,
				});
				// herdr-app wrote its document: spaces or tab names may have moved.
				// A failure here is a dropped connection, which redials and primes.
				scope.onDocChanged(() => {
					void loadSpaces(client, scope, () => client.state === 'disposed').catch(() => undefined);
				});
				return scope;
			},
			prime: (client, scope, retired) => loadSpaces(client, scope, retired),
			start: (client, scope) => {
				client.on('snapshot', (seq, terminals) => scope.reset(seq, terminals));
				client.on('event', (event) => scope.ingest(event));
				client.subscribe();
			},
		},
		// `ssh -T <host> sh -c '… connect'`, or `[<hc>, 'connect']`; empty when
		// the local binary is still to be found, which the session does itself.
		terminalCommand: (endpoint) => {
			const runtime = endpoint.runtime;
			if (runtime.target === 'ssh') return sshConnectArgv(runtime.host, runtime.binary);
			return localArgv(runtime) ?? [];
		},
		createTerminalSession: (options, endpoint) => {
			const runtime = endpoint.runtime;
			const argv =
				options.command.length > 0
					? options.command
					: async (): Promise<string[]> => {
							const known = localArgv(runtime);
							if (known) return known;
							const binary = await resolveHerdrBinary({
								override: runtime.binary,
								extraPath: host.extraPath(),
								binaryName: 'hc',
							});
							if (!binary) throw new Error(HC_NOT_FOUND);
							if (binary.source !== 'setting') discovered.set(runtime.id, binary.path);
							return [binary.path, 'connect'];
						};
			return new HcTerminalSession({
				argv,
				target: options.target,
				mode: options.mode,
				cols: options.cols,
				rows: options.rows,
				provisionalSize: options.provisionalSize,
				env: options.env,
				spawn: host.spawn,
			});
		},
		createActions: (actionHost) =>
			new HcActions(actionHost, () => {
				const scope = host.currentScope();
				return scope instanceof HcScope ? scope : null;
			}),
		promptSender: (client) => hcPromptSender(client),
		keySender: (client) => hcKeySender(client),
		createTabLabels: (connection) => new HcTabLabels(connection.scope),
		statusLines: (connection) => (connection ? hcStatusLines(connection) : null),
	};
}

/** The settings tab's status for a herdr-core connection. */
export function hcStatusLines(connection: {
	endpoint: { runtime: Readonly<RuntimeConfig> };
	client: Pick<HcClient, 'argv' | 'state' | 'hello' | 'mismatch' | 'lastError'>;
	scope: Pick<HcScope, 'workspaceId' | 'workspaceLabel' | 'method' | 'size' | 'spacesLoaded'>;
}): StatusLine[] {
	const { client, scope } = connection;
	const runtime = connection.endpoint.runtime;
	const lines: StatusLine[] = [{ text: `Transport: ${transportText(runtime, client.argv)}` }];
	const hello = client.hello;
	if (client.state === 'connected' && hello) {
		const core = hello.core?.name ? `${hello.core.name}, ` : '';
		lines.push({
			text: `Core: ${core}version ${hello.version || 'unknown'}, generation ${hello.generation ?? 'unknown'}`,
		});
	} else if (client.state === 'reconnecting') {
		lines.push({
			text: `Reconnecting to herdr-core${client.lastError ? `: ${client.lastError.message}` : ''}`,
			warning: true,
		});
	} else {
		lines.push({ text: 'Connecting to herdr-core…' });
	}
	const mismatch = client.mismatch;
	if (mismatch) {
		lines.push({
			text: `Generation mismatch: herdr-core ${mismatch.version || ''} speaks generation ${mismatch.server ?? 'unknown'}, this plugin speaks ${mismatch.expected}. Everything still works unless a method is missing.`,
			warning: true,
		});
	}
	if (runtime.target === 'ssh') {
		const issue = remoteVaultPathIssue(runtime);
		if (issue) lines.push({ text: `Folder actions are off: ${issue}.`, warning: true });
	}
	if (!scope.spacesLoaded) {
		lines.push({ text: 'Scope: reading the herdr-app spaces…' });
	} else if (scope.method === 'cwd') {
		lines.push({ text: `Scope: ${scope.workspaceLabel ?? scope.workspaceId ?? ''} (no space matched), ${scope.size} agents` });
	} else if (scope.workspaceId) {
		lines.push({
			text: `Space: ${scope.workspaceLabel ?? scope.workspaceId} (${scope.workspaceId}, matched by ${scope.method}), ${scope.size} agents`,
		});
	} else {
		lines.push({ text: 'Scope: nothing matches this vault yet.', warning: true });
	}
	return lines;
}
