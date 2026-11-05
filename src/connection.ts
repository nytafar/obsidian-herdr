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
import {
	LOCAL_RUNTIME_ID,
	runtimeById,
	runtimeLocation,
	type RuntimeConfig,
	type RuntimeSettings,
} from './runtimes';

/**
 * Endpoint id of the local herdr. Since ADR-0004 an endpoint id is a runtime
 * id; this one, and the `ssh:<host>:<socket>` id a pre-registry remote got,
 * are kept verbatim by the migration (`runtimes.ts`).
 */
export const LOCAL_ENDPOINT_ID = LOCAL_RUNTIME_ID;

/**
 * Where a connection, and everything that inherits from it, talks to (issue
 * #54, ADR-0004): one runtime of the registry, frozen. A terminal is pinned to
 * the endpoint it first started on, so the same pane id on two runtimes never
 * aliases: the id is what the view persists and what the leaf lookup
 * compares, the runtime snapshot is what a later start derives its spawn
 * command from. The snapshot is taken once per connection attempt and never
 * changes afterwards, whatever the settings tab does meanwhile.
 */
export interface Endpoint {
	/** The runtime's id: `local`, a legacy `ssh:<host>:<socket>`, or a generated one. */
	readonly id: string;
	/** The runtime as it was when the snapshot was taken, trimmed and frozen. */
	readonly runtime: Readonly<RuntimeConfig>;
}

/** Snapshots a runtime into an endpoint; the copy is trimmed and frozen. */
export function endpointOf(runtime: RuntimeConfig): Endpoint {
	const snapshot: RuntimeConfig = Object.freeze({
		id: runtime.id,
		name: runtime.name.trim(),
		kind: runtime.kind,
		target: runtime.target,
		host: runtime.host.trim(),
		binary: runtime.binary.trim(),
		socketPath: runtime.socketPath.trim(),
		remoteVaultPath: runtime.remoteVaultPath.trim(),
		workspace: runtime.workspace.trim(),
	});
	return { id: snapshot.id, runtime: snapshot };
}

/**
 * Rebuilds the endpoint an id names from the registry as it is now. Null when
 * the registry no longer has it (the runtime was removed under a pinned
 * terminal), which the caller reports rather than silently pointing the
 * terminal elsewhere. An edited runtime keeps its id, so a pinned terminal
 * follows the edit.
 */
export function resolveEndpoint(id: string, settings: RuntimeSettings): Endpoint | null {
	const runtime = runtimeById(settings, id);
	return runtime ? endpointOf(runtime) : null;
}

/** True when the endpoint's runtime lives on another machine. */
export function isRemoteEndpoint(endpoint: Pick<Endpoint, 'runtime'>): boolean {
	return endpoint.runtime.target === 'ssh';
}

/** Short human name for status lines and tooltips: `local` or `ssh <host>`. */
export function endpointLabel(endpoint: Pick<Endpoint, 'runtime'>): string {
	return runtimeLocation(endpoint.runtime);
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

/**
 * How one runtime kind opens a connection (ADR-0004, ADR-0005): the steps the
 * coordinator runs in order, each of which a kind answers its own way. The
 * coordinator owns the order, the generations and the teardown; the driver
 * owns what is built. The herdr kind discovers the local binary, forwards the
 * API socket over SSH for an `ssh` target and opens a `HerdrClient` on it
 * (`runtime/herdrKind.ts`); herdr-core will spawn `hc connect` as its
 * transport instead.
 */
export interface ConnectionDriver<
	C extends ConnectionClient = ConnectionClient,
	S extends ConnectionScope = ConnectionScope,
	T extends ConnectionTunnel = ConnectionTunnel,
> {
	/** Finds the binary and the socket. Never expected to throw. */
	discover(endpoint: Endpoint): Promise<DiscoveryResult>;
	/**
	 * Why this discovery cannot carry an attempt on this endpoint, or null when
	 * it can. herdr on `local` needs the binary it found; over SSH only `ssh`
	 * is needed here, so a missing local binary stops nothing.
	 */
	discoveryIssue(endpoint: Endpoint, discovery: DiscoveryResult): string | null;
	/**
	 * The transport the client talks through, or null when the client opens
	 * `discovery.socketPath` itself. `onSocket` reports the client's socket
	 * after every (re)connect of the transport. May throw synchronously (no
	 * host configured); the attempt reports that as its error.
	 */
	createTunnel(endpoint: Endpoint, onSocket: (socketPath: string) => void): T | null;
	createClient(socketPath: string, endpoint: Endpoint): C;
	/**
	 * Builds the scope. The endpoint is the attempt's, so whatever hangs off
	 * the scope's events can label what it reports.
	 */
	createScope(endpoint: Endpoint): S;
	/** Event subscriptions the scope needs (`SCOPE_SUBSCRIPTIONS` for herdr). */
	subscriptions: readonly Subscription[];
}

/** A kind this build cannot connect, and the sentence that says so. */
export interface UnavailableDriver {
	unavailable: string;
}

export interface ConnectionDeps<
	C extends ConnectionClient = ConnectionClient,
	S extends ConnectionScope = ConnectionScope,
	T extends ConnectionTunnel = ConnectionTunnel,
> {
	/**
	 * The endpoint the attempt targets, read once at its start. Everything the
	 * connection derives from the settings comes from this snapshot, not from
	 * the live settings.
	 */
	endpoint(): Endpoint;
	/**
	 * The driver of the endpoint's kind, or why that kind cannot connect. An
	 * unavailable kind fails the attempt before anything is created, so there
	 * is never a half-open connection to tear down.
	 */
	driver(endpoint: Endpoint): ConnectionDriver<C, S, T> | UnavailableDriver;
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

		const endpoint = this.deps.endpoint();
		const driver = this.deps.driver(endpoint);
		if ('unavailable' in driver) {
			this.fail(driver.unavailable);
			return;
		}

		const discovery = await driver.discover(endpoint);
		if (!alive()) return;
		this.latestDiscovery = discovery;
		const issue = driver.discoveryIssue(endpoint, discovery);
		if (issue !== null) {
			this.fail(issue);
			return;
		}

		// A transport of the kind's own, when it has one: for herdr over SSH the
		// API socket is the local end of a forward (PRD S5); terminals do not use
		// it, they run the CLI over `ssh -T` (PRD S17).
		let client: C | null = null;
		let tunnel: T | null = null;
		let socketPath = discovery.socketPath;
		try {
			// The forward's local path never changes, so this matters after a
			// tunnel reconnect: the client picks the fresh socket up next call.
			tunnel = driver.createTunnel(endpoint, (path) => client?.setSocketPath(path));
			if (tunnel) socketPath = await tunnel.start();
		} catch (error) {
			void tunnel?.stop();
			if (alive()) this.fail((error as Error).message);
			return;
		}
		if (!alive()) {
			void tunnel?.stop();
			return;
		}

		client = driver.createClient(socketPath, endpoint);
		const scope = driver.createScope(endpoint);
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
			client.subscribe([...driver.subscriptions]);
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

/**
 * The tab-label cache seen from here: something built per connection and
 * disposed with it. Kept to `dispose` so this module owns the lifetime without
 * knowing what a label is (`src/tabLabels.ts` does).
 */
export interface EndpointSessionLabels {
	dispose(): void;
}

/**
 * What one connection generation offers the views pinned to its endpoint
 * (issue #81): the endpoint's own settings snapshot, the client, the workspace
 * scope and the tab-label cache, together, so a view asks the endpoint-match
 * question once instead of once per getter.
 *
 * It is a *session*, not a per-endpoint record: it lives and dies with the
 * connection's identity, because the caches hanging off it are built from that
 * connection's client and scope. A connection is published before its first
 * ping answers and stays published through a transport outage, so a session
 * existing means "this endpoint is the one the plugin is on", never "herdr is
 * reachable right now" — what counts as usable is the caller's call.
 */
export interface EndpointSession<
	C extends ConnectionClient = ConnectionClient,
	S extends ConnectionScope = ConnectionScope,
	L extends EndpointSessionLabels = EndpointSessionLabels,
> {
	/** The connection's own endpoint snapshot, not the settings as they are now. */
	readonly endpoint: Endpoint;
	readonly client: C;
	readonly scope: S;
	/** Built on first read, shared by every view on this connection. */
	readonly tabLabels: L;
}

class LiveEndpointSession<
	C extends ConnectionClient,
	S extends ConnectionScope,
	L extends EndpointSessionLabels,
	T extends ConnectionTunnel,
> implements EndpointSession<C, S, L>
{
	private labels: L | null = null;

	constructor(
		readonly connection: Connection<C, S, T>,
		private readonly create: (connection: Connection<C, S, T>) => L,
	) {}

	get endpoint(): Endpoint {
		return this.connection.endpoint;
	}

	get client(): C {
		return this.connection.client;
	}

	get scope(): S {
		return this.connection.scope;
	}

	get tabLabels(): L {
		// Lazily, because a lookup for the scope alone (a tab title repaint) must
		// not make the cache subscribe to a client it will never fetch from.
		return (this.labels ??= this.create(this.connection));
	}

	dispose(): void {
		this.labels?.dispose();
		this.labels = null;
	}
}

export interface EndpointSessionDeps<
	C extends ConnectionClient,
	S extends ConnectionScope,
	L extends EndpointSessionLabels,
	T extends ConnectionTunnel,
> {
	/** The published connection, or null while none is. */
	current(): Connection<C, S, T> | null;
	/** Builds the tab-label cache of a connection; called at most once per one. */
	createTabLabels(connection: Connection<C, S, T>): L;
}

/**
 * The one place that answers "is the published connection the one this endpoint
 * id names, and if so what does it give me" (issue #81). One session at a time,
 * for the published connection; a new connection on the same endpoint disposes
 * the previous session rather than handing on caches built from a client that
 * has been retired.
 */
export class EndpointSessions<
	C extends ConnectionClient = ConnectionClient,
	S extends ConnectionScope = ConnectionScope,
	L extends EndpointSessionLabels = EndpointSessionLabels,
	T extends ConnectionTunnel = ConnectionTunnel,
> {
	private live: LiveEndpointSession<C, S, L, T> | null = null;

	constructor(private readonly deps: EndpointSessionDeps<C, S, L, T>) {}

	/**
	 * The session of the published connection when its endpoint is `endpointId`,
	 * else null: a terminal pinned to the other herdr must not read titles, tab
	 * labels or an endpoint from this one (issue #54).
	 */
	for(endpointId: string): EndpointSession<C, S, L> | null {
		const connection = this.sync();
		if (!connection || connection.endpoint.id !== endpointId) return null;
		return (this.live ??= new LiveEndpointSession(connection, (owner) =>
			this.deps.createTabLabels(owner),
		));
	}

	/**
	 * Drops the session of a connection that is no longer published. Call it on
	 * every replacement, so the caches go when the connection does rather than
	 * when someone next looks one up. Returns the published connection.
	 */
	sync(): Connection<C, S, T> | null {
		const connection = this.deps.current();
		if (this.live && this.live.connection !== connection) {
			this.live.dispose();
			this.live = null;
		}
		return connection;
	}

	/** Unload: drops the session whatever the coordinator still reports. */
	dispose(): void {
		this.live?.dispose();
		this.live = null;
	}
}
