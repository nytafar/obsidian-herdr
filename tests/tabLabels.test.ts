/**
 * The shared tab-label cache (issue #43): one `tab.list` per workspace per
 * connection, shared by every view, invalidated by `tab_renamed` and by a
 * workspace re-resolution, and deaf to answers for a connection or workspace
 * that has moved on. Everything herdr-side is a fake, so each case drives the
 * exact interleaving it is about.
 */

import { describe, expect, it, vi } from 'vitest';
import { TabLabelCache, type TabLabelClient, type TabLabelScope } from '../src/tabLabels';
import type { TabInfo } from '../src/herdr/types.gen';

type EventHandler = (event: { event: string; data: Record<string, unknown> }) => void;

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

function tab(tabId: string, label: string): TabInfo {
	return {
		tab_id: tabId,
		label,
		workspace_id: 'w4',
		agent_status: 'idle',
		focused: false,
		number: 1,
		pane_count: 1,
	};
}

/** A client whose `tab.list` answers are handed out one call at a time. */
class FakeClient implements TabLabelClient {
	readonly calls: unknown[] = [];
	readonly pending: Deferred<{ tabs?: TabInfo[] } | null>[] = [];
	readonly handlers = new Map<string, Set<EventHandler>>();
	unsupported = new Set<string>();

	requestOptional<T>(method: string, params: unknown): Promise<T | null> {
		this.calls.push({ method, params });
		const next = deferred<{ tabs?: TabInfo[] } | null>();
		this.pending.push(next);
		return next.promise as Promise<T | null>;
	}

	isUnsupported(method: string): boolean {
		return this.unsupported.has(method);
	}

	on(type: string, handler: EventHandler): () => void {
		let set = this.handlers.get(type);
		if (!set) {
			set = new Set();
			this.handlers.set(type, set);
		}
		set.add(handler);
		return () => {
			set?.delete(handler);
		};
	}

	emit(event: string, data: Record<string, unknown>): void {
		for (const handler of this.handlers.get(event) ?? []) handler({ event, data });
	}

	/** Answers the oldest outstanding `tab.list`. */
	async answer(tabs: TabInfo[] | null): Promise<void> {
		const next = this.pending.shift();
		if (!next) throw new Error('no tab.list outstanding');
		next.resolve(tabs === null ? null : { tabs });
		// Let the `.then` and `.finally` chains run.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}

	async fail(): Promise<void> {
		const next = this.pending.shift();
		if (!next) throw new Error('no tab.list outstanding');
		next.reject(new Error('socket closed'));
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}
}

class FakeScope implements TabLabelScope {
	workspaceId: string | null = 'w4';
	tabs: string[] = ['w4:t1'];
	private readonly resolved = new Set<() => void>();

	tabIds(): Iterable<string> {
		return this.tabs;
	}

	onWorkspaceResolved(handler: () => void): () => void {
		this.resolved.add(handler);
		return () => {
			this.resolved.delete(handler);
		};
	}

	resolve(workspaceId: string | null): void {
		this.workspaceId = workspaceId;
		for (const handler of [...this.resolved]) handler();
	}
}

function setup(options: { alive?: () => boolean } = {}) {
	const client = new FakeClient();
	const scope = new FakeScope();
	const cache = new TabLabelCache({
		client,
		scope,
		alive: options.alive ?? (() => true),
	});
	const changes = vi.fn();
	cache.subscribe(changes);
	return { client, scope, cache, changes };
}

describe('TabLabelCache (issue #43)', () => {
	it('fetches once for the workspace and strips herdr’s status prefix', async () => {
		const { client, cache, changes } = setup();
		cache.ensure('w4:t1');
		expect(client.calls).toEqual([{ method: 'tab.list', params: { workspace_id: 'w4' } }]);
		await client.answer([tab('w4:t1', '! trauma'), tab('w4:t2', '? vault-maintenance')]);
		expect(cache.get('w4:t1')).toBe('trauma');
		expect(cache.get('w4:t2')).toBe('vault-maintenance');
		expect(changes).toHaveBeenCalledTimes(1);
	});

	it('shares one fetch between two views asking at the same time', async () => {
		const { client, cache } = setup();
		// Two list views bind: both ask, one request goes out.
		cache.ensure();
		cache.ensure('w4:t1');
		expect(client.calls).toHaveLength(1);
		await client.answer([tab('w4:t1', 'trauma')]);
		// Once answered, a third view finds the label without a round trip.
		cache.ensure('w4:t1');
		expect(client.calls).toHaveLength(1);
	});

	it('never fetches from get() or labels()', () => {
		const { client, cache } = setup();
		expect(cache.get('w4:t1')).toBeUndefined();
		expect(cache.labels().size).toBe(0);
		expect(client.calls).toHaveLength(0);
	});

	it('applies a tab rename in place, without a pane creation or a fetch', async () => {
		const { client, cache, changes } = setup();
		cache.ensure();
		await client.answer([tab('w4:t1', 'trauma')]);
		client.emit('tab_renamed', { tab_id: 'w4:t1', workspace_id: 'w4', label: '? renamed' });
		expect(cache.get('w4:t1')).toBe('renamed');
		expect(client.calls).toHaveLength(1);
		expect(changes).toHaveBeenCalledTimes(2);
	});

	it('ignores a rename in another workspace', async () => {
		const { client, cache, changes } = setup();
		cache.ensure();
		await client.answer([tab('w4:t1', 'trauma')]);
		client.emit('tab_renamed', { tab_id: 'w4:t1', workspace_id: 'w9', label: 'other' });
		expect(cache.get('w4:t1')).toBe('trauma');
		expect(changes).toHaveBeenCalledTimes(1);
	});

	it('rejects an answer once the connection is no longer the published one', async () => {
		let alive = true;
		const { client, cache, changes } = setup({ alive: () => alive });
		cache.ensure();
		// The plugin reconnected while `tab.list` was out.
		alive = false;
		await client.answer([tab('w4:t1', 'stale')]);
		expect(cache.get('w4:t1')).toBeUndefined();
		expect(changes).not.toHaveBeenCalled();
	});

	it('rejects an answer for a workspace the scope has since left', async () => {
		const { client, scope, cache } = setup();
		cache.ensure();
		// Re-resolution mid-flight: the cache asks again for the new workspace,
		// and the first answer, when it lands, is about the old one.
		scope.resolve('w9');
		expect(client.calls).toHaveLength(1);
		await client.answer([tab('w4:t1', 'old workspace')]);
		expect(cache.get('w4:t1')).toBeUndefined();
		expect(client.calls).toHaveLength(2);
		expect(client.calls[1]).toEqual({ method: 'tab.list', params: { workspace_id: 'w9' } });
		await client.answer([tab('w9:t1', 'new workspace')]);
		expect(cache.get('w9:t1')).toBe('new workspace');
		expect(cache.get('w4:t1')).toBeUndefined();
	});

	it('keys entries by workspace: a re-resolution starts from nothing', async () => {
		const { client, scope, cache, changes } = setup();
		cache.ensure();
		await client.answer([tab('w4:t1', 'trauma')]);
		scope.resolve('w9');
		// Cleared and told, before the new workspace has answered.
		expect(cache.labels().size).toBe(0);
		expect(changes).toHaveBeenCalledTimes(2);
		await client.answer([]);
		expect(cache.labels().size).toBe(0);
	});

	it('explicitly clears on an empty answer instead of keeping old labels', async () => {
		const { client, cache, changes } = setup();
		cache.ensure();
		await client.answer([tab('w4:t1', 'trauma')]);
		cache.refresh();
		await client.answer([]);
		expect(cache.get('w4:t1')).toBeUndefined();
		expect(cache.labels().size).toBe(0);
		expect(changes).toHaveBeenCalledTimes(2);
	});

	it('leaves an empty entry when herdr has no tab.list, and stops asking', () => {
		const { client, cache } = setup();
		client.unsupported.add('tab.list');
		cache.ensure('w4:t1');
		cache.ensure('w4:t2');
		expect(client.calls).toHaveLength(0);
		expect(cache.labels().size).toBe(0);
	});

	it('does not ask again for a tab herdr already omitted', async () => {
		const { client, scope, cache } = setup();
		scope.tabs = ['w4:t1', 'w4:t7'];
		cache.ensure();
		await client.answer([tab('w4:t1', 'trauma')]);
		// t7 was in scope when the request went out: it counts as asked.
		cache.ensure('w4:t7');
		expect(client.calls).toHaveLength(1);
		// A genuinely new tab is asked about once more.
		cache.ensure('w4:t8');
		expect(client.calls).toHaveLength(2);
	});

	it('queues one more fetch when asked mid-flight rather than dropping it', async () => {
		const { client, cache } = setup();
		cache.ensure();
		cache.ensure('w4:t9');
		expect(client.calls).toHaveLength(1);
		await client.answer([tab('w4:t1', 'trauma')]);
		expect(client.calls).toHaveLength(2);
		await client.answer([tab('w4:t1', 'trauma'), tab('w4:t9', 'nine')]);
		expect(cache.get('w4:t9')).toBe('nine');
	});

	it('keeps what it knew when a fetch fails, and lets the next new pane retry', async () => {
		const { client, cache, changes } = setup();
		cache.ensure();
		await client.answer([tab('w4:t1', 'trauma')]);
		cache.refresh();
		await client.fail();
		expect(cache.get('w4:t1')).toBe('trauma');
		expect(changes).toHaveBeenCalledTimes(1);
	});

	it('does nothing without a resolved workspace', () => {
		const { client, scope, cache } = setup();
		scope.workspaceId = null;
		cache.ensure('w4:t1');
		cache.refresh();
		expect(client.calls).toHaveLength(0);
		expect(cache.labels().size).toBe(0);
	});

	it('goes quiet after dispose: no answer, rename or resolution gets through', async () => {
		const { client, scope, cache, changes } = setup();
		cache.ensure();
		cache.dispose();
		await client.answer([tab('w4:t1', 'trauma')]);
		client.emit('tab_renamed', { tab_id: 'w4:t1', workspace_id: 'w4', label: 'x' });
		scope.resolve('w9');
		expect(cache.labels().size).toBe(0);
		expect(client.calls).toHaveLength(1);
		expect(changes).not.toHaveBeenCalled();
	});

	it('unsubscribes a listener', async () => {
		const { client, cache } = setup();
		const listener = vi.fn();
		const off = cache.subscribe(listener);
		off();
		cache.ensure();
		await client.answer([tab('w4:t1', 'trauma')]);
		expect(listener).not.toHaveBeenCalled();
	});
});
