import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	CLIENT_ERROR_CODES,
	HerdrClient,
	HerdrError,
	expandHome,
	parseEventLine,
	parseResponse,
	type HerdrEvent,
} from '../src/herdr/client';
import { unsupportedMethodMessage } from '../src/notify';
import { FakeApiServer, FakeError } from './fixtures/fakeApiServer';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(options: ConstructorParameters<typeof FakeApiServer>[0] = {}) {
	const server = new FakeApiServer(options);
	await server.start();
	cleanups.push(() => server.stop());
	return server;
}

function makeClient(server: FakeApiServer, options: Partial<{ requestTimeoutMs: number; backoffMs: number; maxBackoffMs: number; expectedProtocol: number; onProtocolMismatch: (m: { server: number; expected: number; version: string }) => void }> = {}) {
	const client = new HerdrClient({ socketPath: server.socketPath, requestTimeoutMs: 2000, ...options });
	cleanups.push(() => client.dispose());
	return client;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('timed out waiting for condition');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe('parseResponse', () => {
	it('returns the result and ignores unknown envelope fields (M3)', () => {
		expect(parseResponse<{ type: string }>('{"id":"1","result":{"type":"pong"},"extra":9}')).toEqual({
			type: 'pong',
		});
	});

	it('turns an error body into a HerdrError carrying the code', () => {
		try {
			parseResponse('{"id":"f","error":{"code":"pane_not_found","message":"pane w99:p99 not found"}}', 'pane.focus');
			throw new Error('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(HerdrError);
			expect((error as HerdrError).code).toBe('pane_not_found');
			expect((error as HerdrError).method).toBe('pane.focus');
			expect((error as HerdrError).isUnsupportedMethod).toBe(false);
		}
	});

	it('flags an unknown method as an unsupported method, not a broken connection', () => {
		try {
			parseResponse('{"id":"","error":{"code":"invalid_request","message":"invalid request: unknown variant `no.such.method`, expected one of `ping`"}}');
			throw new Error('should have thrown');
		} catch (error) {
			expect((error as HerdrError).isUnsupportedMethod).toBe(true);
		}
	});
});

describe('parseEventLine', () => {
	it('accepts a push envelope and ignores an RPC reply', () => {
		expect(parseEventLine('{"event":"pane_updated","data":{"type":"pane_updated"}}')).toEqual({
			event: 'pane_updated',
			data: { type: 'pane_updated' },
		});
		expect(parseEventLine('{"id":"1","result":{}}')).toBeNull();
		expect(parseEventLine('not json')).toBeNull();
	});
});

describe('expandHome', () => {
	it('expands only a leading tilde', () => {
		expect(expandHome('/absolute/path')).toBe('/absolute/path');
		expect(expandHome('~/x').endsWith('/x')).toBe(true);
		expect(expandHome('~/x').startsWith('~')).toBe(false);
	});
});

describe('HerdrClient.request', () => {
	it('sends id, method and a params object, and returns the result', async () => {
		const server = await startServer();
		const client = makeClient(server);
		const pong = await client.ping();
		expect(pong.version).toBe('0.8.0');
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]?.method).toBe('ping');
		// `params` is mandatory even for ping (notes/herdr-api.md).
		expect(server.requests[0]?.hasParams).toBe(true);
		expect(server.requests[0]?.id).toBeTruthy();
	});

	it('uses one connection per request, because the server reads one line only', async () => {
		const server = await startServer();
		const client = makeClient(server);
		await Promise.all([client.ping(), client.listPanes(), client.listWorkspaces()]);
		expect(server.requests.map((request) => request.method).sort()).toEqual([
			'pane.list',
			'ping',
			'workspace.list',
		]);
		expect(server.connections).toBe(3);
		// Ids are still distinct, even though matching is positional.
		expect(new Set(server.requests.map((request) => request.id)).size).toBe(3);
	});

	it('reassembles a response split across chunks', async () => {
		const server = await startServer({ chunked: true });
		const client = makeClient(server);
		await expect(client.ping()).resolves.toMatchObject({ type: 'pong' });
	});

	it('surfaces an unsupported method as a typed error', async () => {
		const server = await startServer();
		const client = makeClient(server);
		await expect(client.request('no.such.method', {})).rejects.toMatchObject({
			code: 'invalid_request',
		});
		const error = await client.request('no.such.method', {}).catch((e: HerdrError) => e);
		expect((error as HerdrError).isUnsupportedMethod).toBe(true);
	});

	it('propagates a server error code even when the id is echoed empty', async () => {
		const server = await startServer({
			methods: {
				'pane.focus': () => {
					throw new FakeError('pane_not_found', 'pane w99:p99 not found');
				},
			},
		});
		const client = makeClient(server);
		await expect(client.request('pane.focus', { pane_id: 'w99:p99' })).rejects.toMatchObject({
			code: 'pane_not_found',
		});
	});

	it('times out per request', async () => {
		const server = await startServer({ hang: true });
		const client = makeClient(server, { requestTimeoutMs: 120 });
		await expect(client.ping()).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.timeout });
	});

	it('reports a missing socket as a connect failure', async () => {
		const client = new HerdrClient({
			socketPath: join(tmpdir(), 'herdr-does-not-exist.sock'),
			requestTimeoutMs: 500,
		});
		cleanups.push(() => client.dispose());
		await expect(client.ping()).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.connect });
	});

	it('reports a connection closed without an answer', async () => {
		const server = await startServer({ closeWithoutAnswer: true });
		const client = makeClient(server, { requestTimeoutMs: 1000 });
		await expect(client.ping()).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.protocol });
	});

	it('reports a non-JSON response line', async () => {
		const server = await startServer({ garbage: true });
		const client = makeClient(server);
		await expect(client.ping()).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.protocol });
	});

	it('turns an unsupported optional method into null, once (M3)', async () => {
		const server = await startServer();
		const unsupported: string[] = [];
		const client = new HerdrClient({
			socketPath: server.socketPath,
			requestTimeoutMs: 2000,
			onUnsupportedMethod: (method) => unsupported.push(method),
		});
		cleanups.push(() => client.dispose());
		await expect(client.requestOptional('no.such.method', {})).resolves.toBeNull();
		// Remembered: the second call never reaches the socket, and the user is
		// told exactly once.
		const before = server.requests.length;
		await expect(client.requestOptional('no.such.method', {})).resolves.toBeNull();
		expect(server.requests.length).toBe(before);
		expect(unsupported).toEqual(['no.such.method']);
		expect(client.isUnsupported('no.such.method')).toBe(true);
	});

	it('degrades agent names once when agent.list is missing (M3)', async () => {
		// The fake server knows ping, workspace.list and pane.list only, so
		// `agent.list` comes back as herdr's "unknown variant" invalid_request.
		const server = await startServer();
		const messages: string[] = [];
		const client = new HerdrClient({
			socketPath: server.socketPath,
			requestTimeoutMs: 2000,
			onUnsupportedMethod: (method) => messages.push(unsupportedMethodMessage(method)),
		});
		cleanups.push(() => client.dispose());

		// Empty, not a rejection: a prime that falls back to the list calls still
		// gets its workspaces and panes.
		await expect(client.listAgents()).resolves.toEqual([]);
		expect(messages).toEqual([
			'Herdr: this herdr does not support agent.list; agent rows show titles instead of names.',
		]);

		// Second time: no wire traffic, no second notice, still off.
		const before = server.requests.length;
		await expect(client.listAgents()).resolves.toEqual([]);
		expect(server.requests.length).toBe(before);
		expect(messages).toHaveLength(1);
		expect(client.isUnsupported('agent.list')).toBe(true);
	});

	it('still rejects an optional call that failed for another reason', async () => {
		const server = await startServer({
			methods: {
				'session.snapshot': () => {
					throw new FakeError('internal', 'boom');
				},
			},
		});
		const client = makeClient(server);
		await expect(client.snapshot()).rejects.toMatchObject({ code: 'internal' });
		expect(client.isUnsupported('session.snapshot')).toBe(false);
	});

	it('reads a session snapshot in one call (PRD section 7)', async () => {
		const server = await startServer({
			methods: {
				'session.snapshot': () => ({
					type: 'session_snapshot',
					snapshot: {
						version: '0.8.0',
						protocol: 19,
						workspaces: [],
						tabs: [],
						panes: [],
						layouts: [],
						agents: [{ pane_id: 'w4:p1', name: 'vault-maintenance' }],
					},
				}),
			},
		});
		const client = makeClient(server);
		const snapshot = await client.snapshot();
		expect(snapshot?.agents?.[0]?.name).toBe('vault-maintenance');
		expect(server.requests).toHaveLength(1);
	});

	it('refuses requests after dispose', async () => {
		const server = await startServer();
		const client = makeClient(server);
		client.dispose();
		await expect(client.ping()).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.disposed });
	});

	it('rejects requests still in flight when disposed, before their timeout (#57)', async () => {
		const server = await startServer({ hang: true });
		const client = makeClient(server, { requestTimeoutMs: 10_000 });
		const pending = client.ping();
		const snapshot = client.snapshot();
		await waitFor(() => server.requests.length === 2);
		const started = Date.now();
		client.dispose();
		await expect(pending).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.disposed });
		await expect(snapshot).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.disposed });
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it('is unaffected by a request that settled before dispose', async () => {
		const server = await startServer();
		const client = makeClient(server);
		await client.ping();
		client.dispose();
		await expect(client.ping()).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.disposed });
	});
});

describe('HerdrClient.ping protocol handling (M3)', () => {
	it('warns on a mismatch and still resolves', async () => {
		const server = await startServer({ protocol: 22, version: '0.8.2' });
		const mismatches: { server: number; expected: number; version: string }[] = [];
		const client = makeClient(server, {
			expectedProtocol: 19,
			onProtocolMismatch: (mismatch) => mismatches.push(mismatch),
		});
		const pong = await client.ping();
		expect(pong.protocol).toBe(22);
		expect(mismatches).toEqual([{ server: 22, expected: 19, version: '0.8.2' }]);
		expect(client.lastMismatch).not.toBeNull();
	});

	it('clears the mismatch when protocols agree', async () => {
		const server = await startServer({ protocol: 19 });
		const client = makeClient(server, { expectedProtocol: 19 });
		await client.ping();
		expect(client.lastMismatch).toBeNull();
	});
});

describe('HerdrClient events', () => {
	it('subscribes, fans out by event name and to the wildcard, and unsubscribes', async () => {
		const server = await startServer();
		const client = makeClient(server);
		const updates: HerdrEvent[] = [];
		const all: HerdrEvent[] = [];
		const off = client.on('pane_updated', (event) => updates.push(event));
		client.on('*', (event) => all.push(event));

		client.subscribe([{ type: 'pane.updated' }, { type: 'pane.created' }]);
		await waitFor(() => server.subscriberCount === 1);
		expect(client.eventStreamState).toBe('open');

		server.push('pane_updated', { type: 'pane_updated', pane: { pane_id: 'w4:p1' } });
		server.push('pane_created', { type: 'pane_created', pane: { pane_id: 'w4:p2' } });
		await waitFor(() => all.length === 2);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.data.pane).toEqual({ pane_id: 'w4:p1' });

		off();
		server.push('pane_updated', { type: 'pane_updated', pane: { pane_id: 'w4:p1' } });
		await waitFor(() => all.length === 3);
		expect(updates).toHaveLength(1);

		const request = server.requests.find((entry) => entry.method === 'events.subscribe');
		expect(request?.params).toEqual({ subscriptions: [{ type: 'pane.updated' }, { type: 'pane.created' }] });
	});

	it('ignores unparseable push lines instead of dropping the stream', async () => {
		const server = await startServer();
		const client = makeClient(server);
		const seen: HerdrEvent[] = [];
		client.on('*', (event) => seen.push(event));
		client.subscribe([{ type: 'pane.updated' }]);
		await waitFor(() => server.subscriberCount === 1);
		server.pushRaw('}{ not json');
		server.push('pane_focused', { type: 'pane_focused', pane_id: 'w4:p1' });
		await waitFor(() => seen.length === 1);
		expect(seen[0]?.event).toBe('pane_focused');
	});

	it('reconnects with backoff and re-sends every subscription (M4)', async () => {
		const server = await startServer();
		const client = makeClient(server, { backoffMs: 20, maxBackoffMs: 40 });
		let connects = 0;
		let drops = 0;
		client.on('connected', () => (connects += 1));
		client.on('disconnected', () => (drops += 1));
		client.subscribe([{ type: 'pane.updated' }]);
		await waitFor(() => connects === 1);

		server.dropSubscribers();
		await waitFor(() => drops >= 1);
		await waitFor(() => connects === 2);
		expect(client.eventStreamState).toBe('open');
		expect(server.requests.filter((entry) => entry.method === 'events.subscribe')).toHaveLength(2);

		const events: HerdrEvent[] = [];
		client.on('pane_updated', (event) => events.push(event));
		server.push('pane_updated', { type: 'pane_updated' });
		await waitFor(() => events.length === 1);
	});

	it('stops reconnecting once disposed', async () => {
		const server = await startServer();
		const client = makeClient(server, { backoffMs: 10 });
		client.subscribe([{ type: 'pane.updated' }]);
		await waitFor(() => server.subscriberCount === 1);
		client.dispose();
		await waitFor(() => server.subscriberCount === 0);
		const before = server.requests.length;
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(server.requests).toHaveLength(before);
		expect(client.eventStreamState).toBe('closed');
	});

	it('re-opens the stream when new subscriptions are added', async () => {
		const server = await startServer();
		const client = makeClient(server, { backoffMs: 10 });
		client.subscribe([{ type: 'pane.updated' }]);
		await waitFor(() => server.subscriberCount === 1);
		client.subscribe([{ type: 'pane.updated' }, { type: 'tab.created' }]);
		await waitFor(() => server.requests.filter((entry) => entry.method === 'events.subscribe').length === 2);
		const last = server.requests.filter((entry) => entry.method === 'events.subscribe').at(-1);
		expect(last?.params).toEqual({
			subscriptions: [{ type: 'pane.updated' }, { type: 'tab.created' }],
		});
	});
});
