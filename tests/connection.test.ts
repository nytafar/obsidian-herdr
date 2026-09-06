/**
 * Orchestration tests for the connection coordinator (issue #57). The
 * scenarios come from `docs/reviews/2026-09-06/lifecycle-repros.mjs`, which
 * asserted the defects; here they assert the fixed behaviour. Discovery, the
 * tunnel, the client and the scope are all fakes with deferred promises so the
 * tests decide in which order asynchronous steps complete.
 */
import { describe, expect, it } from 'vitest';
import type { DiscoveryResult } from '../src/herdr/binary';
import type { HerdrEvent } from '../src/herdr/client';
import type { SessionSnapshot } from '../src/herdr/types.gen';
import {
	ConnectionCoordinator,
	type ConnectionClient,
	type ConnectionDeps,
	type ConnectionScope,
	type ConnectionTunnel,
} from '../src/connection';

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Lets every microtask queued so far run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const DISCOVERY: DiscoveryResult = {
	binary: { path: '/fake/herdr', source: 'setting' },
	status: null,
	socketPath: '/fake/api.sock',
	error: null,
};

const EMPTY_SNAPSHOT: SessionSnapshot = {
	workspaces: [],
	panes: [],
	agents: [],
	layouts: [],
	tabs: [],
	protocol: 22,
	version: '0.8.2',
};

class FakeClient implements ConnectionClient {
	disposed = false;
	subscribed = 0;
	socketPath: string;
	readonly handlers = new Map<string, ((...args: never[]) => void)[]>();
	/** Deferred answers to `ping`, `snapshot`; resolved by the test. */
	readonly pings: Deferred<unknown>[] = [];
	readonly snapshots: Deferred<SessionSnapshot | null>[] = [];

	constructor(socketPath: string) {
		this.socketPath = socketPath;
	}

	ping(): Promise<unknown> {
		const d = deferred<unknown>();
		this.pings.push(d);
		return d.promise;
	}

	snapshot(): Promise<SessionSnapshot | null> {
		const d = deferred<SessionSnapshot | null>();
		this.snapshots.push(d);
		return d.promise;
	}

	listAgents = () => Promise.resolve([]);
	listWorkspaces = () => Promise.resolve([]);
	listPanes = () => Promise.resolve([]);

	subscribe(): void {
		this.subscribed++;
	}

	on(type: string, handler: (...args: never[]) => void): void {
		const list = this.handlers.get(type) ?? [];
		list.push(handler);
		this.handlers.set(type, list);
	}

	emit(type: string, ...args: unknown[]): void {
		for (const handler of this.handlers.get(type) ?? []) handler(...(args as never[]));
	}

	setSocketPath(path: string): void {
		this.socketPath = path;
	}

	dispose(): void {
		this.disposed = true;
	}
}

class FakeScope implements ConnectionScope {
	primed = 0;
	ingested: HerdrEvent[] = [];
	setAgentNames(): void {}
	prime(): void {
		this.primed++;
	}
	ingest(event: HerdrEvent): void {
		this.ingested.push(event);
	}
}

class FakeTunnel implements ConnectionTunnel {
	stopped = false;
	readonly started = deferred<string>();
	constructor(readonly onSocket: (path: string) => void) {}
	start(): Promise<string> {
		return this.started.promise;
	}
	stop(): Promise<void> {
		this.stopped = true;
		return Promise.resolve();
	}
}

function harness(options: { remote?: boolean; tunnelThrows?: boolean } = {}) {
	const discoveries: Deferred<DiscoveryResult>[] = [];
	const clients: FakeClient[] = [];
	const scopes: FakeScope[] = [];
	const tunnels: FakeTunnel[] = [];
	const notices: string[] = [];
	const errors: (string | null)[] = [];
	let replaced = 0;
	let primed = 0;
	const deps: ConnectionDeps = {
		discover: () => {
			const d = deferred<DiscoveryResult>();
			discoveries.push(d);
			return d.promise;
		},
		remoteEnabled: () => options.remote ?? false,
		createTunnel: (onSocket) => {
			if (options.tunnelThrows) throw new Error('the remote profile has no SSH host');
			const tunnel = new FakeTunnel(onSocket);
			tunnels.push(tunnel);
			return tunnel;
		},
		createClient: (socketPath) => {
			const client = new FakeClient(socketPath);
			clients.push(client);
			return client;
		},
		createScope: () => {
			const scope = new FakeScope();
			scopes.push(scope);
			return scope;
		},
		subscriptions: [{ kind: 'pane.updated' } as never],
		notice: (message) => notices.push(message),
		setError: (message) => errors.push(message),
		onReplaced: () => {
			replaced++;
		},
		onPrimed: () => {
			primed++;
		},
	};
	const coordinator = new ConnectionCoordinator(deps);
	return {
		coordinator,
		discoveries,
		clients,
		scopes,
		tunnels,
		notices,
		errors,
		replaced: () => replaced,
		primed: () => primed,
	};
}

/** Runs a connect through to a subscribed client. */
async function connected(h: ReturnType<typeof harness>): Promise<FakeClient> {
	const connecting = h.coordinator.connect();
	await settle();
	h.discoveries.at(-1)?.resolve(DISCOVERY);
	await settle();
	const client = h.clients.at(-1);
	if (!client) throw new Error('no client created');
	client.pings.at(-1)?.resolve({ type: 'pong' });
	await connecting;
	return client;
}

describe('ConnectionCoordinator: a plain connect', () => {
	it('publishes the client and scope, pings, subscribes and announces once', async () => {
		const h = harness();
		const client = await connected(h);
		expect(h.coordinator.current?.client).toBe(client);
		expect(h.coordinator.current?.scope).toBe(h.scopes[0]);
		expect(h.coordinator.discovery).toBe(DISCOVERY);
		expect(client.subscribed).toBe(1);
		expect(h.replaced()).toBe(1);
		expect(h.notices).toEqual([]);
	});

	it('reports a missing local binary without creating anything', async () => {
		const h = harness();
		const connecting = h.coordinator.connect();
		await settle();
		h.discoveries[0]?.resolve({ ...DISCOVERY, binary: null, error: 'herdr not on PATH' });
		await connecting;
		expect(h.clients).toHaveLength(0);
		expect(h.coordinator.current).toBeNull();
		expect(h.notices).toEqual(['Herdr: herdr not on PATH']);
		expect(h.errors.at(-1)).toBe('herdr not on PATH');
	});

	it('keeps the client published when ping fails, and reports the error', async () => {
		const h = harness();
		const connecting = h.coordinator.connect();
		await settle();
		h.discoveries[0]?.resolve(DISCOVERY);
		await settle();
		h.clients[0]?.pings[0]?.reject(new Error('cannot reach herdr'));
		await connecting;
		expect(h.coordinator.current?.client).toBe(h.clients[0]);
		expect(h.clients[0]?.subscribed).toBe(0);
		expect(h.errors.at(-1)).toBe('cannot reach herdr');
		expect(h.notices).toEqual(['Herdr: cannot reach herdr']);
	});

	it('routes events from the stream into the scope of the same connection', async () => {
		const h = harness();
		const client = await connected(h);
		const event: HerdrEvent = { event: 'pane_updated', data: {} };
		client.emit('*', event);
		expect(h.scopes[0]?.ingested).toEqual([event]);
	});
});

describe('ConnectionCoordinator: dispose during an attempt', () => {
	it('never publishes when discovery resolves after dispose', async () => {
		const h = harness();
		const connecting = h.coordinator.connect();
		h.coordinator.dispose();
		await settle();
		h.discoveries[0]?.resolve(DISCOVERY);
		await connecting;
		expect(h.clients).toHaveLength(0);
		expect(h.scopes).toHaveLength(0);
		expect(h.coordinator.current).toBeNull();
		expect(h.coordinator.discovery).toBeNull();
		expect(h.notices).toEqual([]);
	});

	it('disposes a client whose ping answers after dispose, and never subscribes', async () => {
		const h = harness();
		const connecting = h.coordinator.connect();
		await settle();
		h.discoveries[0]?.resolve(DISCOVERY);
		await settle();
		const client = h.clients[0];
		expect(h.coordinator.current?.client).toBe(client);
		h.coordinator.dispose();
		expect(client?.disposed).toBe(true);
		expect(h.coordinator.current).toBeNull();
		client?.pings[0]?.resolve({ type: 'pong' });
		await connecting;
		expect(client?.subscribed).toBe(0);
	});

	it('stops a tunnel that comes up after dispose and creates no client', async () => {
		const h = harness({ remote: true });
		const connecting = h.coordinator.connect();
		await settle();
		h.discoveries[0]?.resolve({ ...DISCOVERY, binary: null });
		await settle();
		const tunnel = h.tunnels[0];
		expect(tunnel).toBeDefined();
		h.coordinator.dispose();
		tunnel?.started.resolve('/tmp/forward.sock');
		await connecting;
		expect(tunnel?.stopped).toBe(true);
		expect(h.clients).toHaveLength(0);
	});

	it('refuses to connect once disposed', async () => {
		const h = harness();
		h.coordinator.dispose();
		await h.coordinator.connect();
		expect(h.discoveries).toHaveLength(0);
	});

	it('announces the disconnected state to views when the connection is retired', async () => {
		const h = harness();
		await connected(h);
		expect(h.replaced()).toBe(1);
		h.coordinator.dispose();
		expect(h.replaced()).toBe(2);
		expect(h.coordinator.current).toBeNull();
	});
});

describe('ConnectionCoordinator: overlapping attempts', () => {
	it('keeps only the newest client when the older discovery finishes last', async () => {
		const h = harness();
		const first = h.coordinator.connect();
		await settle();
		const second = h.coordinator.connect();
		await settle();
		expect(h.discoveries).toHaveLength(2);
		const [oldDiscovery, newDiscovery] = h.discoveries;
		newDiscovery?.resolve(DISCOVERY);
		await settle();
		const newClient = h.clients[0];
		newClient?.pings[0]?.resolve({ type: 'pong' });
		await second;
		expect(h.coordinator.current?.client).toBe(newClient);

		oldDiscovery?.resolve(DISCOVERY);
		await first;
		expect(h.clients).toHaveLength(1);
		expect(h.coordinator.current?.client).toBe(newClient);
		expect(newClient?.disposed).toBe(false);
		expect(h.coordinator.discovery).toBe(DISCOVERY);
	});

	it('retires an older client that was already published when a newer attempt starts', async () => {
		const h = harness();
		const first = h.coordinator.connect();
		await settle();
		h.discoveries[0]?.resolve(DISCOVERY);
		await settle();
		const oldClient = h.clients[0];
		expect(h.coordinator.current?.client).toBe(oldClient);

		const second = h.coordinator.connect();
		expect(oldClient?.disposed).toBe(true);
		expect(h.coordinator.current).toBeNull();
		await settle();
		h.discoveries[1]?.resolve(DISCOVERY);
		await settle();
		const newClient = h.clients[1];
		newClient?.pings[0]?.resolve({ type: 'pong' });
		await second;
		// The old ping answering late must not subscribe or re-publish.
		oldClient?.pings[0]?.resolve({ type: 'pong' });
		await first;
		expect(oldClient?.subscribed).toBe(0);
		expect(newClient?.subscribed).toBe(1);
		expect(h.coordinator.current?.client).toBe(newClient);
	});

	it('stops a tunnel started by a superseded attempt', async () => {
		const h = harness({ remote: true });
		const first = h.coordinator.connect();
		await settle();
		h.discoveries[0]?.resolve({ ...DISCOVERY, binary: null });
		await settle();
		const oldTunnel = h.tunnels[0];
		const second = h.coordinator.connect();
		await settle();
		h.discoveries[1]?.resolve({ ...DISCOVERY, binary: null });
		await settle();
		const newTunnel = h.tunnels[1];
		newTunnel?.started.resolve('/tmp/new.sock');
		await settle();
		h.clients[0]?.pings[0]?.resolve({ type: 'pong' });
		await second;
		oldTunnel?.started.resolve('/tmp/old.sock');
		await first;
		expect(oldTunnel?.stopped).toBe(true);
		expect(newTunnel?.stopped).toBe(false);
		expect(h.clients).toHaveLength(1);
		expect(h.clients[0]?.socketPath).toBe('/tmp/new.sock');
		expect(h.coordinator.current?.tunnel).toBe(newTunnel);
	});

	it('waits for the previous tunnel to stop before discovering again', async () => {
		const h = harness({ remote: true });
		const first = h.coordinator.connect();
		await settle();
		h.discoveries[0]?.resolve({ ...DISCOVERY, binary: null });
		await settle();
		const tunnel = h.tunnels[0];
		let released!: () => void;
		if (tunnel) {
			tunnel.stop = () => {
				tunnel.stopped = true;
				return new Promise<void>((resolve) => {
					released = resolve;
				});
			};
		}
		tunnel?.started.resolve('/tmp/old.sock');
		await settle();
		h.clients[0]?.pings[0]?.resolve({ type: 'pong' });
		await first;

		const second = h.coordinator.connect();
		await settle();
		expect(tunnel?.stopped).toBe(true);
		expect(h.discoveries).toHaveLength(1);
		released();
		await settle();
		expect(h.discoveries).toHaveLength(2);
		// Discovery of the second attempt is never answered: it must not hold
		// dispose up, and dispose must not wait for it.
		h.coordinator.dispose();
		h.discoveries[1]?.resolve(DISCOVERY);
		await second;
		expect(h.clients).toHaveLength(1);
	});

	it('reports a tunnel that cannot be built and leaves nothing behind', async () => {
		const h = harness({ remote: true, tunnelThrows: true });
		const connecting = h.coordinator.connect();
		await settle();
		h.discoveries[0]?.resolve({ ...DISCOVERY, binary: null });
		await connecting;
		expect(h.clients).toHaveLength(0);
		expect(h.notices).toEqual(['Herdr: the remote profile has no SSH host']);
	});

	it('routes a tunnel reconnect socket to the client of the same attempt', async () => {
		const h = harness({ remote: true });
		const connecting = h.coordinator.connect();
		await settle();
		h.discoveries[0]?.resolve({ ...DISCOVERY, binary: null });
		await settle();
		const tunnel = h.tunnels[0];
		tunnel?.onSocket('/tmp/early.sock');
		tunnel?.started.resolve('/tmp/forward.sock');
		await settle();
		const client = h.clients[0];
		client?.pings[0]?.resolve({ type: 'pong' });
		await connecting;
		expect(client?.socketPath).toBe('/tmp/forward.sock');
		tunnel?.onSocket('/tmp/later.sock');
		expect(client?.socketPath).toBe('/tmp/later.sock');
	});
});

describe('Connection: priming', () => {
	it('primes the new connection while the old snapshot is still pending', async () => {
		const h = harness();
		const oldClient = await connected(h);
		const oldConnection = h.coordinator.current;
		oldClient.emit('connected');
		expect(oldClient.snapshots).toHaveLength(1);

		const newClient = await connected(h);
		const newConnection = h.coordinator.current;
		expect(newConnection).not.toBe(oldConnection);
		newClient.emit('connected');
		expect(newClient.snapshots).toHaveLength(1);
		newClient.snapshots[0]?.resolve(EMPTY_SNAPSHOT);
		await settle();
		expect(h.scopes[1]?.primed).toBe(1);

		// The old snapshot answering afterwards must not touch anything.
		oldClient.snapshots[0]?.resolve(EMPTY_SNAPSHOT);
		await settle();
		expect(h.scopes[0]?.primed).toBe(0);
	});

	it('queues one re-prime when a prime is requested while one is in flight', async () => {
		const h = harness();
		const client = await connected(h);
		const connection = h.coordinator.current;
		const first = connection?.prime();
		void connection?.prime();
		void connection?.prime();
		expect(client.snapshots).toHaveLength(1);
		client.snapshots[0]?.resolve(EMPTY_SNAPSHOT);
		await first;
		await settle();
		expect(client.snapshots).toHaveLength(2);
		client.snapshots[1]?.resolve(EMPTY_SNAPSHOT);
		await settle();
		expect(client.snapshots).toHaveLength(2);
		expect(h.scopes[0]?.primed).toBe(2);
	});

	it('falls back to the three list calls when the server has no snapshot', async () => {
		const h = harness();
		const client = await connected(h);
		const priming = h.coordinator.current?.prime();
		client.snapshots[0]?.resolve(null);
		await priming;
		expect(h.scopes[0]?.primed).toBe(1);
		expect(h.errors.at(-1)).toBeNull();
	});

	it('records a prime failure on the live connection only', async () => {
		const h = harness();
		const client = await connected(h);
		const priming = h.coordinator.current?.prime();
		client.snapshots[0]?.reject(new Error('timed out'));
		await priming;
		expect(h.errors.at(-1)).toBe('timed out');

		const replacedBefore = h.replaced();
		const next = await connected(h);
		const stale = h.coordinator.current;
		const stalePrime = stale?.prime();
		h.coordinator.dispose();
		h.errors.length = 0;
		next.snapshots[0]?.reject(new Error('disposed'));
		await stalePrime;
		expect(h.errors).toEqual([]);
		// Retire of the first, publish of the second, retire on dispose; a prime
		// never rebinds views, it only reports through `onPrimed`.
		expect(h.replaced()).toBe(replacedBefore + 3);
		expect(h.primed()).toBe(1);
	});

	it('does not run a queued re-prime on a retired connection', async () => {
		const h = harness();
		const client = await connected(h);
		const connection = h.coordinator.current;
		const first = connection?.prime();
		void connection?.prime();
		h.coordinator.dispose();
		client.snapshots[0]?.resolve(EMPTY_SNAPSHOT);
		await first;
		await settle();
		expect(client.snapshots).toHaveLength(1);
		expect(h.scopes[0]?.primed).toBe(0);
	});
});
