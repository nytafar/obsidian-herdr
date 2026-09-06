/**
 * Connection coordinator (issue #57).
 *
 * One connection attempt at a time owns what it creates: discovery result,
 * SSH tunnel, JSON API client and workspace scope. Every attempt carries a
 * generation number; `connect()` bumps it, so an older attempt that is still
 * waiting on discovery, the tunnel or `ping` finds itself stale after the
 * await, disposes whatever it made and never publishes. `dispose()` bumps it
 * too, before any teardown is awaited, so nothing started before unload can
 * land after it.
 *
 * Priming (`session.snapshot` into the scope) belongs to the connection, not
 * to the plugin: a snapshot still pending on a retired connection cannot stop
 * the new one from priming, and a prime requested while one is in flight is
 * queued and run once more afterwards, never dropped.
 *
 * Everything Obsidian- or process-specific is injected, so the orchestration
 * is testable with fakes (see `tests/connection.test.ts`).
 */
import type { DiscoveryResult } from './herdr/binary';
import type { ClientEventMap, HerdrEvent, Subscription } from './herdr/client';
import type { AgentInfo, PaneInfo, SessionSnapshot, WorkspaceInfo } from './herdr/types.gen';
import type { RemoteSettings } from './settings';

/** Endpoint id of the local herdr; a remote one reads `ssh:<host>:<remote socket>`. */
export const LOCAL_ENDPOINT_ID = 'local';

/**
 * Where a connection, and everything that inherits from it, talks to (issue
 * #54). A terminal is pinned to the endpoint it first started on, so the same
 * pane id on the local and on a remote herdr never aliases: the id is what the
 * view persists and what the leaf lookup compares, the settings snapshot is what
 * a later start derives its spawn command from. The snapshot is taken once per
 * connection attempt and never changes afterwards, whatever the settings tab
 * does meanwhile.
 */
export interface Endpoint {
	/** `local`, or `ssh:<host>:<remote socket path>`. */
	readonly id: string;
	/** Remote settings as they were; `enabled` is false for the local endpoint. */
	readonly remote: Readonly<RemoteSettings>;
}

/** The id of the endpoint these remote settings describe. */
export function endpointIdOf(
	remote: Pick<RemoteSettings, 'enabled' | 'host' | 'remoteSocketPath'>,
): string {
	if (!remote.enabled) return LOCAL_ENDPOINT_ID;
	return `ssh:${remote.host.trim()}:${remote.remoteSocketPath.trim()}`;
}

/** Snapshots the remote settings into an endpoint; the copy is frozen. */
export function endpointOf(remote: RemoteSettings): Endpoint {
	const snapshot: RemoteSettings = Object.freeze({
		enabled: remote.enabled,
		host: remote.host.trim(),
		remoteSocketPath: remote.remoteSocketPath.trim(),
		remoteBinary: remote.remoteBinary.trim(),
		remoteVaultPath: remote.remoteVaultPath.trim(),
	});
	return { id: endpointIdOf(snapshot), remote: snapshot };
}

/**
 * Rebuilds the endpoint an id names from the settings as they are now: the
 * local one for `local`, the remote one when the configured host and socket
 * still match. Null when the settings no longer describe it (the host was
 * changed under a pinned terminal), which the caller reports rather than
 * silently pointing the terminal elsewhere.
 */
export function resolveEndpoint(id: string, remote: RemoteSettings): Endpoint | null {
	if (id === LOCAL_ENDPOINT_ID) return endpointOf({ ...remote, enabled: false });
	const candidate = endpointOf({ ...remote, enabled: true });
	return candidate.id === id ? candidate : null;
}

/** Short human name for status lines and tooltips: `local` or `ssh <host>`. */
export function endpointLabel(endpoint: Pick<Endpoint, 'remote'>): string {
	return endpoint.remote.enabled ? `ssh ${endpoint.remote.host}` : 'local';
}

/** The slice of `HerdrClient` a connection drives. */
export interface ConnectionClient {
	ping(): Promise<unknown>;
	snapshot(): Promise<SessionSnapshot | null>;
	listAgents(): Promise<AgentInfo[]>;
	listWorkspaces(): Promise<WorkspaceInfo[]>;
	listPanes(): Promise<PaneInfo[]>;
	subscribe(subscriptions: Subscription[]): void;
	on<K extends keyof ClientEventMap>(type: K, handler: (...args: ClientEventMap[K]) => void): unknown;
	on(type: '*', handler: (event: HerdrEvent) => void): unknown;
	setSocketPath(path: string): void;
	dispose(): void;
}

/** The slice of `WorkspaceScope` a connection feeds. */
export interface ConnectionScope {
	setAgentNames(agents: readonly AgentInfo[]): void;
	prime(workspaces: WorkspaceInfo[], panes: PaneInfo[]): void;
	ingest(event: HerdrEvent): void;
}

/** The slice of `SshTunnel` a connection owns. */
export interface ConnectionTunnel {
	/** Resolves to the local socket path once the forward accepts connections. */
	start(): Promise<string>;
	stop(): Promise<void>;
}

export interface ConnectionDeps<
	C extends ConnectionClient = ConnectionClient,
	S extends ConnectionScope = ConnectionScope,
	T extends ConnectionTunnel = ConnectionTunnel,
> {
	/** Finds the binary and the socket. Never expected to throw. */
	discover(): Promise<DiscoveryResult>;
	/**
	 * The endpoint the attempt targets, read once at its start; a remote one
	 * goes through an SSH forward. Everything the connection derives from the
	 * settings comes from this snapshot, not from the live settings.
	 */
	endpoint(): Endpoint;
	/**
	 * Builds the tunnel for a remote attempt. `onSocket` reports the local
	 * socket after every (re)connect of the forward. May throw synchronously
	 * (no host configured); the attempt reports that as its error.
	 */
	createTunnel(onSocket: (localSocketPath: string) => void): T;
	createClient(socketPath: string): C;
	/**
	 * Builds the scope and wires whatever the caller hangs off its events. The
	 * endpoint is the attempt's, so those handlers can label what they report.
	 */
	createScope(endpoint: Endpoint): S;
	/** Event subscriptions the scope needs (`SCOPE_SUBSCRIPTIONS`). */
	subscriptions: readonly Subscription[];
	/** Something the user should see (a missing binary, a failed ping). */
	notice(message: string): void;
	/** Latest connection error, or null when it cleared. */
	setError(message: string | null): void;
	/**
	 * The published connection changed: a new one is up, or the current one was
	 * retired and nothing replaced it yet (`current` is then null).
	 */
	onReplaced(): void;
	/** The current connection's scope was (re)primed; counts may have moved. */
	onPrimed(): void;
}

/** A live, published connection: what the plugin points views and actions at. */
export class Connection<
	C extends ConnectionClient = ConnectionClient,
	S extends ConnectionScope = ConnectionScope,
	T extends ConnectionTunnel = ConnectionTunnel,
> {
	private retired = false;
	private priming: Promise<void> | null = null;
	private primeQueued = false;

	constructor(
		readonly discovery: DiscoveryResult,
		readonly endpoint: Endpoint,
		readonly client: C,
		readonly scope: S,
		readonly tunnel: T | null,
		private readonly deps: Pick<ConnectionDeps, 'setError' | 'onPrimed'>,
	) {}

	get isRetired(): boolean {
		return this.retired;
	}

	/**
	 * Loads workspaces, panes and agent names into the scope. `session.snapshot`
	 * carries all three in one round trip (PRD section 7); a server without it
	 * falls back to the three list calls (PRD M3). `scope.prime` diffs rather
	 * than resets, so a re-prime is invisible unless something changed.
	 *
	 * One prime runs at a time per connection. A request that lands while one is
	 * in flight is queued: the stream's `connected` edge can fire again before
	 * the previous snapshot answered, and the later edge may carry newer state.
	 */
	prime(): Promise<void> {
		if (this.retired) return Promise.resolve();
		if (this.priming) {
			this.primeQueued = true;
			return this.priming;
		}
		this.priming = this.runPrime().finally(() => {
			this.priming = null;
			const again = this.primeQueued;
			this.primeQueued = false;
			if (again && !this.retired) void this.prime();
		});
		return this.priming;
	}

	private async runPrime(): Promise<void> {
		const { client, scope } = this;
		try {
			const snapshot = await client.snapshot();
			if (this.retired) return;
			// Names first: `prime` reads them when it builds the pane states.
			if (snapshot) {
				scope.setAgentNames(snapshot.agents ?? []);
				scope.prime(snapshot.workspaces ?? [], snapshot.panes ?? []);
			} else {
				const agents = await client.listAgents();
				if (this.retired) return;
				const workspaces = await client.listWorkspaces();
				if (this.retired) return;
				const panes = await client.listPanes();
				if (this.retired) return;
				scope.setAgentNames(agents);
				scope.prime(workspaces, panes);
			}
			this.deps.setError(null);
		} catch (error) {
			if (this.retired) return;
			this.deps.setError((error as Error).message);
		}
		this.deps.onPrimed();
	}

	/**
	 * Takes the connection out of service. Synchronous as far as the client goes
	 * (no further requests, pending ones rejected); the tunnel's teardown is
	 * async and is what the returned promise waits for.
	 */
	retire(): Promise<void> {
		if (this.retired) return Promise.resolve();
		this.retired = true;
		this.client.dispose();
		return this.tunnel?.stop() ?? Promise.resolve();
	}
}

export class ConnectionCoordinator<
	C extends ConnectionClient = ConnectionClient,
	S extends ConnectionScope = ConnectionScope,
	T extends ConnectionTunnel = ConnectionTunnel,
> {
	private generation = 0;
	private disposed = false;
	private connection: Connection<C, S, T> | null = null;
	/** Teardown of retired connections, chained so attempts start after it. */
	private teardown: Promise<void> = Promise.resolve();
	/** Discovery of the newest attempt, kept for the settings status. */
	private latestDiscovery: DiscoveryResult | null = null;

	constructor(private readonly deps: ConnectionDeps<C, S, T>) {}

	get current(): Connection<C, S, T> | null {
		return this.connection;
	}

	get discovery(): DiscoveryResult | null {
		return this.latestDiscovery;
	}

	/**
	 * Retires the current connection and opens a new one from the settings as
	 * they are now. Overlapping calls are serialised by generation: only the
	 * newest attempt can publish, older ones dispose what they created.
	 * Never throws; failures land in `setError` and a notice.
	 */
	async connect(): Promise<void> {
		if (this.disposed) return;
		const generation = ++this.generation;
		const alive = () => !this.disposed && this.generation === generation;

		this.retireCurrent();
		this.latestDiscovery = null;
		this.deps.setError(null);
		// Wait for the previous tunnel to release its socket before starting
		// another; an attempt that got superseded meanwhile stops here.
		await this.teardown;
		if (!alive()) return;

		const discovery = await this.deps.discover();
		if (!alive()) return;
		this.latestDiscovery = discovery;
		const endpoint = this.deps.endpoint();
		const remote = endpoint.remote.enabled;
		// A remote profile needs `ssh`, not a local herdr, so a missing local
		// binary only stops the local path.
		if (!discovery.binary && !remote) {
			this.fail(discovery.error ?? 'herdr binary not found');
			return;
		}

		// Remote: the API socket is the local end of an SSH forward (PRD S5).
		// Terminals do not use it; they run the CLI over `ssh -T` (PRD S17).
		let client: C | null = null;
		let tunnel: T | null = null;
		let socketPath = discovery.socketPath;
		if (remote) {
			try {
				// The forward's local path never changes, so this matters after a
				// tunnel reconnect: the client picks the fresh socket up next call.
				tunnel = this.deps.createTunnel((path) => client?.setSocketPath(path));
				socketPath = await tunnel.start();
			} catch (error) {
				void tunnel?.stop();
				if (alive()) this.fail((error as Error).message);
				return;
			}
			if (!alive()) {
				void tunnel.stop();
				return;
			}
		}

		client = this.deps.createClient(socketPath);
		const scope = this.deps.createScope(endpoint);
		const connection = new Connection(discovery, endpoint, client, scope, tunnel, this.deps);
		// The one place the scope is loaded: the event stream's `connected` edge,
		// which fires on the first subscribe ack and again after every reconnect.
		// Listing only there means nothing is missed between the two (PRD M4) and
		// that panes closed during an outage do not stay listed forever.
		client.on('connected', () => {
			this.deps.setError(null);
			void connection.prime();
		});
		client.on('disconnected', (error) => {
			if (error && !connection.isRetired) this.deps.setError(error.message);
		});
		this.connection = connection;
		this.deps.onReplaced();

		try {
			await client.ping();
			if (!alive()) return;
			client.on('*', (event) => scope.ingest(event));
			client.subscribe([...this.deps.subscriptions]);
		} catch (error) {
			if (alive()) this.fail((error as Error).message);
		}
	}

	/**
	 * Invalidates every attempt and retires the current connection. The
	 * generation moves before any teardown is awaited, so an attempt resuming
	 * after this call finds itself stale whatever it was waiting on.
	 */
	dispose(): void {
		this.disposed = true;
		this.generation++;
		this.retireCurrent();
	}

	private retireCurrent(): void {
		const connection = this.connection;
		if (!connection) return;
		this.connection = null;
		// `retire()` disposes the client synchronously; only the tunnel's stop is
		// what the next attempt has to wait for.
		const stopped = connection.retire();
		this.teardown = this.teardown.then(() => stopped);
		// Views see the disconnected state right away rather than the stale
		// scope until the next attempt publishes.
		this.deps.onReplaced();
	}

	private fail(message: string): void {
		this.deps.setError(message);
		this.deps.notice(`Herdr: ${message}`);
	}
}
