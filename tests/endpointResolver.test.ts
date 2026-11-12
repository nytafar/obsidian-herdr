/**
 * The endpoint resolver (issue #182): what is behind an endpoint id, over
 * fake kinds, a fake published connection and the settings. Each answer must
 * be for the runtime asked about and never hand out the published runtime's
 * watcher, connection or client on another's behalf (issue #54, ADR-0006).
 */

import { describe, expect, it } from 'vitest';
import { endpointOf, type Connection } from '../src/connection';
import { EndpointResolver } from '../src/runtime/endpoints';
import { HERDR_CAPABILITIES, HERDR_CORE_CAPABILITIES, type RuntimeKindAdapter, type TranscriptAccess } from '../src/runtime/kind';
import { createHerdrKind } from '../src/runtime/herdrKind';
import { createHerdrCoreKind } from '../src/runtime/herdrCoreKind';
import { LocalTranscriptSource } from '../src/native/transcriptSource';
import { defaultLocalRuntime, newRuntime, type RuntimeConfig, type RuntimeKind } from '../src/runtimes';
import { DEFAULT_SETTINGS, type HerdrSettings } from '../src/settings';

const XL: RuntimeConfig = {
	...newRuntime('herdr', 'ssh', [], () => 0.5),
	id: 'ssh:lasse@xl:~/.config/herdr/herdr.sock',
	host: 'lasse@xl',
	remoteVaultPath: '/home/lasse/hvelv',
};
const CORE_A: RuntimeConfig = { ...newRuntime('herdr-core', 'local', [], () => 0.1), id: 'rt-core-a', name: 'Core A' };
const CORE_B: RuntimeConfig = { ...newRuntime('herdr-core', 'local', [], () => 0.2), id: 'rt-core-b', name: 'Core B' };
const CLAUDE: RuntimeConfig = { ...newRuntime('claude', 'local', [], () => 0.3), id: 'rt-claude', name: 'Claude' };

interface Pane {
	paneId: string;
	pinned?: boolean;
}

function harness(published: RuntimeConfig | null, panes: Pane[] = []) {
	const settings: HerdrSettings = {
		...structuredClone(DEFAULT_SETTINGS),
		runtimes: [defaultLocalRuntime(), XL, CORE_A, CORE_B, CLAUDE],
		activeRuntime: published?.id ?? 'local',
	};
	const client = { name: `client of ${published?.id ?? 'none'}` };
	const scope = {
		list: () => panes,
		get: (paneId: string) => panes.find((pane) => pane.paneId === paneId),
	};
	const current = published
		? ({ endpoint: endpointOf(published), client, scope, tunnel: null } as unknown as Connection)
		: null;
	const transcriptCalls: [string, string | null][] = [];
	const catalogCalls: [string, string | null, string][] = [];
	const source = new LocalTranscriptSource();
	// herdr reads only local transcripts; herdr-core reads them everywhere.
	const native = (access: (target: string) => TranscriptAccess | null) => ({
		transcriptAccess: (endpoint: { runtime: RuntimeConfig }) => access(endpoint.runtime.target),
		watcher: (connection: { endpoint: { id: string } }) => ({ watching: connection.endpoint.id }),
		transcripts: (endpoint: { id: string }, connection: { endpoint: { id: string } } | null) => {
			transcriptCalls.push([endpoint.id, connection?.endpoint.id ?? null]);
			return source;
		},
		commandCatalog: (endpoint: { id: string }, connection: { endpoint: { id: string } } | null, agent: string) => {
			catalogCalls.push([endpoint.id, connection?.endpoint.id ?? null, agent]);
			return { agent };
		},
	});
	const tabLabels: string[] = [];
	const kind = (name: RuntimeKind, extra: Record<string, unknown>) => ({
		kind: name,
		unavailable: null,
		createTabLabels: (connection: { endpoint: { id: string } }) => {
			tabLabels.push(connection.endpoint.id);
			return { dispose: () => undefined };
		},
		...extra,
	});
	const kinds = {
		herdr: kind('herdr', {
			capabilities: HERDR_CAPABILITIES,
			native: native((target) => (target === 'ssh' ? null : 'local')),
		}),
		'herdr-core': kind('herdr-core', {
			capabilities: HERDR_CORE_CAPABILITIES,
			native: native(() => 'local'),
		}),
		// A kind with no native adapter.
		claude: kind('claude', {
			capabilities: { ...HERDR_CAPABILITIES, nativeView: false, sharedPins: false },
			native: null,
			unavailable: 'not in this build',
		}),
	} as unknown as Record<RuntimeKind, RuntimeKindAdapter>;
	const sharedPinWrites: [string, boolean][] = [];
	let saves = 0;
	const resolver = new EndpointResolver({
		kinds,
		current: () => current,
		settings: () => settings,
		save: () => {
			saves += 1;
			return Promise.resolve();
		},
		listActions: () => ({
			endpointId: published?.id ?? 'local',
			actions: {
				setPinned: (paneId: string, pinned: boolean) => {
					sharedPinWrites.push([paneId, pinned]);
					return Promise.resolve(true);
				},
			} as never,
		}),
	});
	return {
		resolver,
		settings,
		client,
		source,
		transcriptCalls,
		catalogCalls,
		tabLabels,
		sharedPinWrites,
		saves: () => saves,
	};
}

describe('an endpoint that is the published one', () => {
	it('answers its connection’s own snapshot, kind, connection and client', () => {
		const { resolver, client, settings } = harness(CORE_A);
		// A rename after connecting does not change the connection's snapshot.
		settings.runtimes = settings.runtimes.map((runtime) =>
			runtime.id === CORE_A.id ? { ...runtime, name: 'Renamed' } : runtime,
		);
		expect(resolver.endpoint(CORE_A.id)?.runtime.name).toBe('Core A');
		expect(resolver.kind(CORE_A.id)?.kind).toBe('herdr-core');
		expect(resolver.connection(CORE_A.id)?.endpoint.id).toBe(CORE_A.id);
		expect(resolver.session(CORE_A.id)?.client).toBe(client);
		expect(resolver.client(CORE_A.id)).toBe(client);
		expect(resolver.watcher(CORE_A.id)).toEqual({ watching: CORE_A.id });
	});

	it('builds the tab-label cache once per connection, through the endpoint’s kind', () => {
		const { resolver, tabLabels } = harness(CORE_A);
		void resolver.session(CORE_A.id)?.tabLabels;
		void resolver.session(CORE_A.id)?.tabLabels;
		expect(tabLabels).toEqual([CORE_A.id]);
	});
});

describe('an endpoint pinned to another runtime than the published one', () => {
	it('has no connection, session, watcher or client, but its kind and endpoint are answered', () => {
		const { resolver } = harness(CORE_A);
		expect(resolver.connection(CORE_B.id)).toBeNull();
		expect(resolver.session(CORE_B.id)).toBeNull();
		// The same pane id on two runtimes is two panes: never A's on B's behalf.
		expect(resolver.watcher(CORE_B.id)).toBeNull();
		expect(resolver.client(CORE_B.id)).toBeNull();
		expect(resolver.endpoint(CORE_B.id)?.runtime.name).toBe('Core B');
		expect(resolver.kind(CORE_B.id)?.kind).toBe('herdr-core');
	});

	it('passes a runtime’s transcript source and `/` list its own connection, and null for another’s', () => {
		const { resolver, transcriptCalls, catalogCalls, source } = harness(CORE_A);
		expect(resolver.transcripts(CORE_A.id)).toBe(source);
		expect(resolver.transcripts(CORE_B.id)).toBe(source);
		expect(transcriptCalls).toEqual([
			[CORE_A.id, CORE_A.id],
			// B's source must not read through A's connection.
			[CORE_B.id, null],
		]);
		resolver.commandCatalog(CORE_A.id, 'claude');
		resolver.commandCatalog(CORE_B.id, 'codex');
		expect(catalogCalls).toEqual([
			[CORE_A.id, CORE_A.id, 'claude'],
			[CORE_B.id, null, 'codex'],
		]);
	});

	it('answers with nothing published at all', () => {
		const { resolver } = harness(null);
		expect(resolver.connection('local')).toBeNull();
		expect(resolver.endpoint('local')?.runtime.kind).toBe('herdr');
		expect(resolver.transcripts('local')).not.toBeNull();
	});
});

describe('an unknown endpoint id', () => {
	it('answers null everywhere', () => {
		const { resolver } = harness(CORE_A);
		expect(resolver.endpoint('rt-gone')).toBeNull();
		expect(resolver.kind('rt-gone')).toBeNull();
		expect(resolver.connection('rt-gone')).toBeNull();
		expect(resolver.watcher('rt-gone')).toBeNull();
		expect(resolver.transcripts('rt-gone')).toBeNull();
		expect(resolver.commandCatalog('rt-gone', 'claude')).toBeNull();
		expect(resolver.client('rt-gone')).toBeNull();
		expect(resolver.pinnedPaneIds('rt-gone')).toEqual([]);
	});
});

describe('the native adapter', () => {
	it('is none for a kind with no native adapter, even when published', () => {
		const { resolver } = harness(CLAUDE);
		expect(resolver.native(endpointOf(CLAUDE))).toBeNull();
		expect(resolver.watcher(CLAUDE.id)).toBeNull();
		expect(resolver.transcripts(CLAUDE.id)).toBeNull();
		expect(resolver.commandCatalog(CLAUDE.id, 'claude')).toBeNull();
		expect(resolver.client(CLAUDE.id)).toBeNull();
		// Its kind is still answered, unavailability and all.
		expect(resolver.kind(CLAUDE.id)?.kind).toBe('claude');
		expect(resolver.kindUnavailable('claude')).toBe('not in this build');
	});

	it('hands out the client only where the kind can back a native view on that endpoint', () => {
		// herdr over SSH: no transcripts from here, so no native view to send for.
		expect(harness(XL).resolver.client(XL.id)).toBeNull();
		expect(harness(XL).resolver.watcher(XL.id)).toBeNull();
		const local = harness(defaultLocalRuntime());
		expect(local.resolver.client('local')).toBe(local.client);
	});

	it('says a runtime has the native view only where its transcripts can be read, over the real kinds (ADR-0010)', () => {
		const herdrKind = createHerdrKind({
			extraPath: () => '',
			vaultPath: () => '/vault',
			discoveryDeps: { isExecutable: () => false, run: () => Promise.resolve({ stdout: '', stderr: '', code: 1 }), env: {}, home: '/home/u' },
			sshRun: () => Promise.reject(new Error('no ssh in tests')),
			onProtocolMismatch: () => undefined,
			onUnsupportedMethod: () => undefined,
			isPublished: () => true,
		});
		const coreKind = createHerdrCoreKind({
			extraPath: () => '',
			spawnEnv: () => ({}),
			vaultPath: () => '/vault',
			vaultName: () => 'vault',
			onMismatch: () => undefined,
			currentScope: () => null,
		});
		const resolver = new EndpointResolver({
			kinds: { herdr: herdrKind, 'herdr-core': coreKind } as unknown as Record<RuntimeKind, RuntimeKindAdapter>,
			current: () => null,
			settings: () => DEFAULT_SETTINGS,
			save: () => Promise.resolve(),
			listActions: () => ({ endpointId: 'local', actions: {} as never }),
		});
		expect(resolver.nativeReachable(defaultLocalRuntime())).toBe(true);
		expect(resolver.nativeReachable({ ...newRuntime('herdr', 'ssh', []), host: 'xl' })).toBe(false);
		// herdr-core reads an SSH runtime's transcripts over its connection.
		expect(resolver.nativeReachable({ ...newRuntime('herdr-core', 'ssh', []), id: 'asher', host: 'asher' })).toBe(true);
	});
});

describe('pins', () => {
	it('keeps a herdr runtime’s pins in the settings and saves them', async () => {
		const { resolver, settings, saves } = harness(defaultLocalRuntime());
		await resolver.setPanePinned('local', 'w1:p1', true);
		expect(settings.pinnedPanes).toEqual({ local: ['w1:p1'] });
		expect(resolver.isPanePinned('local', 'w1:p1')).toBe(true);
		expect(resolver.pinnedPaneIds('local')).toEqual(['w1:p1']);
		// Pinning what is pinned changes nothing, but still saves.
		await resolver.setPanePinned('local', 'w1:p1', true);
		expect(settings.pinnedPanes).toEqual({ local: ['w1:p1'] });
		expect(saves()).toBe(2);
		// Another runtime's pins are its own.
		expect(resolver.isPanePinned(XL.id, 'w1:p1')).toBe(false);
	});

	it('reads a herdr-core runtime’s pins from its rows, and writes them only through the list’s runtime', async () => {
		const { resolver, sharedPinWrites, saves } = harness(CORE_A, [{ paneId: 't1', pinned: true }, { paneId: 't2' }]);
		expect(resolver.pinnedPaneIds(CORE_A.id)).toEqual(['t1']);
		expect(resolver.isPanePinned(CORE_A.id, 't1')).toBe(true);
		expect(resolver.isPanePinned(CORE_A.id, 't2')).toBe(false);
		// Not published: no rows to read.
		expect(resolver.pinnedPaneIds(CORE_B.id)).toEqual([]);
		await resolver.setPanePinned(CORE_A.id, 't2', true);
		await resolver.setPanePinned(CORE_B.id, 't2', true);
		expect(sharedPinWrites).toEqual([['t2', true]]);
		expect(saves()).toBe(0);
	});
});
