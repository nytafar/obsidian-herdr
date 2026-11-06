/**
 * The runtime kind seam (ADR-0004, ADR-0005): the herdr kind's choices per
 * target, the placeholder herdr-core kind's refusals, and the plugin's load
 * path migrating a pre-registry `data.json` and writing it back once.
 *
 * The herdr adapter is driven with a host of fakes; nothing here spawns ssh or
 * herdr (an `SshTunnel` does nothing until `start()`).
 */

import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import HerdrPlugin from '../src/main';
import { endpointOf } from '../src/connection';
import type { DiscoveryDeps, DiscoveryResult } from '../src/herdr/binary';
import type { TerminalSession } from '../src/bridge/terminalSession';
import { createHerdrCoreKind } from '../src/runtime/herdrCoreKind';
import { remoteHerdrCommand, SshTunnel } from '../src/herdr/ssh';
import { WorkspaceScope } from '../src/herdr/scope';
import { createHerdrKind, type HerdrKindHost } from '../src/runtime/herdrKind';
import {
	HERDR_CAPABILITIES,
	HERDR_CORE_CAPABILITIES,
	HERDR_CORE_UNAVAILABLE,
	nativeAdapterFor,
	nativeViewBlock,
	NATIVE_NO_SESSION_REASON,
	NATIVE_NO_TRANSCRIPT_REASON,
	unavailableKind,
	type TranscriptAccess,
} from '../src/runtime/kind';
import { LocalTranscriptSource } from '../src/native/transcriptSource';
import { defaultLocalRuntime, newRuntime, type RuntimeConfig } from '../src/runtimes';
import { DEFAULT_SETTINGS, type HerdrSettings } from '../src/settings';
import { paneViewAvailability } from '../src/native/surface';
import type { ActionHost } from '../src/actions';

const HOME = '/home/test';

/** A machine where only these paths are executable and nothing answers. */
function machine(executables: string[]): DiscoveryDeps {
	const set = new Set(executables);
	return {
		isExecutable: (path) => set.has(path),
		run: () => Promise.resolve({ stdout: '', stderr: 'no server', code: 1 }),
		env: {},
		home: HOME,
	};
}

function host(overrides: Partial<HerdrKindHost> = {}): HerdrKindHost {
	return {
		extraPath: () => '',
		vaultPath: () => '/Users/lasse/Vaults/hvelv',
		discoveryDeps: machine(['/usr/local/bin/herdr']),
		onProtocolMismatch: () => undefined,
		onUnsupportedMethod: () => undefined,
		isPublished: () => true,
		...overrides,
	};
}

const XL: RuntimeConfig = {
	...newRuntime('herdr', 'ssh', [], () => 0.5),
	id: 'ssh:lasse@xl:~/.config/herdr/herdr.sock',
	host: 'lasse@xl',
	binary: '/home/lasse/.local/bin/herdr',
	remoteVaultPath: '/home/lasse/hvelv',
	workspace: 'w7',
};

const FOUND: DiscoveryResult = {
	binary: { path: '/usr/bin/herdr', source: 'login-shell' },
	status: null,
	identity: null,
	socketPath: '/tmp/herdr.sock',
	error: null,
};
const MISSING: DiscoveryResult = { ...FOUND, binary: null, error: 'herdr was not found' };

describe('the herdr kind (ADR-0004)', () => {
	const kind = createHerdrKind(host());
	const driver = kind.connection;
	if (!driver) throw new Error('the herdr kind has a connection driver');
	const local = endpointOf(defaultLocalRuntime());
	const xl = endpointOf(XL);

	it('is available and can do everything', () => {
		expect(kind.unavailable).toBeNull();
		expect(kind.capabilities).toEqual(HERDR_CAPABILITIES);
	});

	it('needs the local binary on a local runtime only', () => {
		expect(driver.discoveryIssue(local, MISSING)).toBe('herdr was not found');
		expect(driver.discoveryIssue(local, FOUND)).toBeNull();
		// Over SSH only `ssh` is needed here.
		expect(driver.discoveryIssue(xl, MISSING)).toBeNull();
	});

	it('forwards the runtime’s socket over SSH, and opens the local one directly', () => {
		expect(driver.createTunnel(local, () => undefined)).toBeNull();
		expect(driver.createTunnel(xl, () => undefined)).toBeInstanceOf(SshTunnel);
		expect(() =>
			driver.createTunnel(endpointOf({ ...XL, host: '  ' }), () => undefined),
		).toThrow('the runtime has no SSH host');
	});

	it('scopes to the runtime’s own workspace and remote vault path', () => {
		const scope = driver.createScope(xl, driver.createClient('/tmp/x.sock', xl, FOUND));
		expect(scope).toBeInstanceOf(WorkspaceScope);
		expect((scope as unknown as { options: { workspaceId: string } }).options.workspaceId).toBe(
			'w7',
		);
	});

	it('builds terminal argv from the pinned runtime', async () => {
		const fresh = createHerdrKind(host());
		// Nothing discovered yet: the session finds the binary itself.
		expect(fresh.terminalCommand(local)).toEqual([]);
		await fresh.connection?.discover(local);
		expect(fresh.terminalCommand(local)).toEqual(['/usr/local/bin/herdr']);
		// A local runtime naming its own binary uses it over the discovered one.
		expect(fresh.terminalCommand(endpointOf({ ...defaultLocalRuntime(), binary: '/opt/herdr' }))).toEqual([
			'/opt/herdr',
		]);
		expect(fresh.terminalCommand(xl)).toEqual([
			'ssh',
			'-T',
			'lasse@xl',
			remoteHerdrCommand('/home/lasse/.local/bin/herdr'),
		]);
	});

	it('expands a `~` override for a local spawn, and leaves it to the remote shell over SSH', () => {
		const tilde = endpointOf({ ...defaultLocalRuntime(), binary: '~/.local/bin/herdr' });
		expect(kind.terminalCommand(tilde)).toEqual([`${HOME}/.local/bin/herdr`]);
		expect(kind.terminalCommand(endpointOf({ ...XL, binary: '~/.local/bin/herdr' }))).toEqual([
			'ssh',
			'-T',
			'lasse@xl',
			`sh -c 'exec "$HOME"/.local/bin/herdr "$@"' herdr`,
		]);
	});

	it('searches the remote host for herdr when an SSH runtime names no binary', () => {
		expect(kind.terminalCommand(endpointOf({ ...XL, binary: '' }))).toEqual([
			'ssh',
			'-T',
			'lasse@xl',
			remoteHerdrCommand(''),
		]);
	});

	it('finds the local binary for a tab itself, whichever runtime is active', async () => {
		// The plugin is connected to some other runtime (an SSH hc one, say):
		// this kind has discovered nothing, and asks nobody else.
		const fresh = createHerdrKind(host());
		const session = fresh.createTerminalSession(
			{ command: fresh.terminalCommand(local), target: 'w1:p1', mode: 'observe', cols: 80, rows: 24 },
			local,
		) as TerminalSession;
		const exited = new Promise<void>((resolve) => session.on('exit', () => resolve()));
		session.on('error', () => undefined);
		session.start();
		await exited;
		expect(session.argv[0]).toBe('/usr/local/bin/herdr');
		// Found once, kept for the next tab.
		expect(fresh.terminalCommand(local)).toEqual(['/usr/local/bin/herdr']);
		await session.dispose();
	});

	it('says why when no local binary can be found', async () => {
		const none = createHerdrKind(host({ discoveryDeps: machine([]) }));
		const session = none.createTerminalSession(
			{ command: [], target: 'w1:p1', mode: 'observe', cols: 80, rows: 24 },
			local,
		);
		const errors: Error[] = [];
		const exited = new Promise<void>((resolve) => session.on('exit', () => resolve()));
		session.on('error', (error) => errors.push(error));
		session.start();
		await exited;
		expect(errors[0]?.message).toMatch(/herdr was not found/);
		await session.dispose();
	});

	it('allows the native view on a local runtime only', () => {
		const local = endpointOf(defaultLocalRuntime());
		const remote = endpointOf({ ...newRuntime('herdr', 'ssh', []), host: 'xl' });
		expect(paneViewAvailability('native', nativeViewBlock(kind, local)).available).toBe(true);
		// herdr over SSH has no transcript adapter, so it reads as it always has.
		expect(paneViewAvailability('native', nativeViewBlock(kind, remote)).reason).toBe(
			'local panes only',
		);
	});

	it('reads local transcripts on a local target and none over SSH', () => {
		const local = endpointOf(defaultLocalRuntime());
		const remote = endpointOf({ ...newRuntime('herdr', 'ssh', []), host: 'xl' });
		expect(kind.native?.transcriptAccess(local)).toBe('local');
		expect(kind.native?.transcriptAccess(remote)).toBeNull();
		expect(kind.native?.transcripts(local, null)).toBeInstanceOf(LocalTranscriptSource);
		// The same source for every local runtime and every call: a session
		// model reopens its tail whenever the source it is handed changes.
		expect(kind.native?.transcripts(local, null)).toBe(kind.native?.transcripts(local, null));
		expect(kind.native?.transcripts(remote, null)).toBeNull();
	});
});

describe('the herdr-core kind’s terminal argv', () => {
	const core = createHerdrCoreKind({
		extraPath: () => '',
		spawnEnv: () => ({}),
		vaultPath: () => '/v',
		vaultName: () => 'v',
		onMismatch: () => undefined,
		currentScope: () => null,
	});

	it('expands a `~` override for a local spawn, and leaves it to the remote shell over SSH', () => {
		const tilde = endpointOf({ ...newRuntime('herdr-core', 'local', []), binary: '~/.local/bin/hc' });
		expect(core.terminalCommand(tilde)).toEqual([`${homedir()}/.local/bin/hc`, 'connect']);
		const remote = core.terminalCommand(
			endpointOf({ ...newRuntime('herdr-core', 'ssh', []), host: 'asher', binary: '~/.local/bin/hc' }),
		);
		expect(remote.slice(0, 2)).toEqual(['ssh', '-T']);
		expect(remote).toContain('asher');
		// The remote shell expands it (as $HOME), not this machine.
		expect(remote.join(' ')).toContain('"$HOME"/.local/bin/hc');
	});

	it('leaves an undiscovered local binary to the session, whichever runtime is active', () => {
		expect(core.terminalCommand(endpointOf(newRuntime('herdr-core', 'local', [])))).toEqual([]);
	});
});

describe('a kind this build cannot run yet', () => {
	const core = unavailableKind(
		'herdr-core',
		HERDR_CORE_UNAVAILABLE,
		HERDR_CORE_CAPABILITIES,
		NATIVE_NO_SESSION_REASON,
	);
	const endpoint = endpointOf(newRuntime('herdr-core', 'local', []));

	it('has no connection and says why', () => {
		expect(core.connection).toBeNull();
		expect(core.unavailable).toBe(HERDR_CORE_UNAVAILABLE);
	});

	it('refuses a terminal tab with the same reason', () => {
		expect(() => core.terminalCommand(endpoint)).toThrow(HERDR_CORE_UNAVAILABLE);
	});

	it('answers an action with a notice instead of a request', async () => {
		const notices: string[] = [];
		const actions = core.createActions({
			notice: (message: string) => notices.push(message),
		} as unknown as ActionHost);
		expect(await actions.closePane('t1', endpoint.id)).toBe(false);
		await actions.startAgentHere('/x');
		expect(notices).toEqual([
			`Herdr: ${HERDR_CORE_UNAVAILABLE}.`,
			`Herdr: ${HERDR_CORE_UNAVAILABLE}.`,
		]);
		await expect(core.promptSender(() => null).send('t1', 'hi')).rejects.toThrow(
			HERDR_CORE_UNAVAILABLE,
		);
	});

	it('leaves out tabs, splits, rename and focus, and has no native adapter to show anything with', () => {
		expect(core.capabilities).toMatchObject({
			tabs: false,
			splits: false,
			rename: false,
			focus: false,
			startAgent: true,
			close: true,
		});
		// The capability is herdr-core's (ADR-0006), but a kind that cannot run
		// supplies no watcher or source, so the view says why instead.
		expect(core.native).toBeNull();
		expect(paneViewAvailability('native', nativeViewBlock(core, endpoint)).reason).toBe(
			NATIVE_NO_SESSION_REASON,
		);
	});
});

describe('nativeViewBlock: capability and transcript access, not the target', () => {
	const remote = endpointOf({ ...newRuntime('herdr', 'ssh', []), host: 'xl' });
	const local = endpointOf(defaultLocalRuntime());
	const withAccess = (access: TranscriptAccess | null): Parameters<typeof nativeViewBlock>[0] => ({
		capabilities: HERDR_CAPABILITIES,
		nativeUnavailable: null,
		native: {
			transcriptAccess: () => access,
			watcher: () => null,
			transcripts: () => null,
		},
	});

	it('offers the view on a remote runtime whose kind reads transcripts over its connection', () => {
		expect(paneViewAvailability('native', nativeViewBlock(withAccess('rpc'), remote))).toEqual({
			available: true,
			reason: null,
		});
	});

	it('refuses it where the transcripts are out of reach, saying why', () => {
		expect(paneViewAvailability('native', nativeViewBlock(withAccess(null), remote)).reason).toBe(
			'local panes only',
		);
		expect(paneViewAvailability('native', nativeViewBlock(withAccess(null), local)).reason).toBe(
			NATIVE_NO_TRANSCRIPT_REASON,
		);
	});

	it('refuses it for a kind that claims the capability but supplies no native adapter', () => {
		const block = nativeViewBlock({ ...withAccess('local'), native: null }, local);
		expect(paneViewAvailability('native', block).reason).toBe(NATIVE_NO_SESSION_REASON);
		expect(nativeAdapterFor({ capabilities: HERDR_CAPABILITIES, native: null }, local)).toBeNull();
	});
});

/** The plugin's `loadSettings` over a stored `data.json`, with the save recorded. */
async function load(stored: unknown): Promise<{ settings: HerdrSettings; saved: unknown[] }> {
	const plugin = Object.create(HerdrPlugin.prototype) as HerdrPlugin & Record<string, unknown>;
	const saved: unknown[] = [];
	plugin.loadData = () => Promise.resolve(structuredClone(stored));
	plugin.saveData = (data: unknown) => {
		saved.push(structuredClone(data));
		return Promise.resolve();
	};
	await plugin.loadSettings();
	return { settings: plugin.settings, saved };
}

describe('loadSettings: a pre-registry data.json (ADR-0004)', () => {
	const remote = {
		enabled: true,
		host: 'lasse@xl',
		remoteSocketPath: '~/.config/herdr/herdr.sock',
		remoteBinary: '/home/lasse/.local/bin/herdr',
		remoteVaultPath: '/home/lasse/hvelv',
	};
	const stored = {
		socketPath: '~/.config/herdr/herdr.sock',
		herdrBinary: '',
		workspaceId: '',
		defaultView: 'terminal',
		terminalEngine: 'ghostty-web',
		remote,
		pinnedPanes: { 'ssh:lasse@xl:~/.config/herdr/herdr.sock': ['w4:p1'] },
	};

	it('migrates, keeps the active remote and the pins, and writes back once', async () => {
		const { settings, saved } = await load(stored);
		expect(settings.activeRuntime).toBe('ssh:lasse@xl:~/.config/herdr/herdr.sock');
		expect(settings.runtimes.map((runtime) => runtime.id)).toEqual([
			'local',
			'ssh:lasse@xl:~/.config/herdr/herdr.sock',
		]);
		expect(settings.pinnedPanes).toEqual(stored.pinnedPanes);
		expect(saved).toHaveLength(1);
		const written = saved[0] as Record<string, unknown>;
		for (const key of ['remote', 'workspaceId', 'socketPath', 'herdrBinary']) {
			expect(key in written).toBe(false);
		}
		expect(written.activeRuntime).toBe('ssh:lasse@xl:~/.config/herdr/herdr.sock');
	});

	it('reads its own write back without migrating again', async () => {
		const first = await load(stored);
		const second = await load(first.saved[0]);
		expect(second.saved).toHaveLength(0);
		expect(second.settings.runtimes).toEqual(first.settings.runtimes);
		expect(second.settings.activeRuntime).toBe(first.settings.activeRuntime);
	});

	it('re-imports a remote a downgraded build wrote beside the registry', async () => {
		const upgraded = (await load({ ...stored, remote: { ...remote, enabled: false } })).saved[0] as Record<string, unknown>;
		// The old build drops nothing it does not know and writes `remote` again,
		// now naming another host.
		const other = { ...remote, host: 'lasse@other', enabled: true };
		const { settings, saved } = await load({ ...upgraded, remote: other });
		const otherId = 'ssh:lasse@other:~/.config/herdr/herdr.sock';
		expect(settings.runtimes.map((runtime) => runtime.id)).toContain(otherId);
		expect(settings.activeRuntime).toBe(upgraded.activeRuntime);
		const written = saved[0] as { runtimes: RuntimeConfig[] } & Record<string, unknown>;
		expect('remote' in written).toBe(false);
		expect(written.runtimes.map((runtime) => runtime.id)).toContain(otherId);
	});

	it('keeps a newer build’s runtime through load and save, without showing it', async () => {
		const future = { id: 'rt-future', kind: 'tmux', target: 'local', name: 'Later', extra: 1 };
		const plugin = Object.create(HerdrPlugin.prototype) as HerdrPlugin;
		const saved: unknown[] = [];
		const file = { runtimes: [defaultLocalRuntime(), future], activeRuntime: 'local' };
		plugin.loadData = () => Promise.resolve(structuredClone(file));
		plugin.saveData = (data: unknown) => {
			saved.push(structuredClone(data));
			return Promise.resolve();
		};
		await plugin.loadSettings();
		expect(plugin.settings.runtimes.map((runtime) => runtime.id)).toEqual(['local']);
		await plugin.saveSettings();
		expect((saved[0] as { runtimes: unknown[] }).runtimes).toEqual([defaultLocalRuntime(), future]);
		// The live settings never gain it.
		expect(plugin.settings.runtimes.map((runtime) => runtime.id)).toEqual(['local']);
	});

	it('starts a fresh install on the local herdr without sharing the defaults', async () => {
		const { settings, saved } = await load(null);
		expect(saved).toHaveLength(0);
		expect(settings.runtimes).toEqual(DEFAULT_SETTINGS.runtimes);
		expect(settings.runtimes).not.toBe(DEFAULT_SETTINGS.runtimes);
		expect(settings.activeRuntime).toBe('local');
	});
});

describe('the plugin’s status after a rename (no reconnect)', () => {
	it('names the active runtime by its live name, not the connection’s snapshot', () => {
		const plugin = Object.create(HerdrPlugin.prototype) as Record<string, unknown>;
		const snapshot = { ...defaultLocalRuntime(), name: 'Old name' };
		plugin.settings = {
			...structuredClone(DEFAULT_SETTINGS),
			runtimes: [{ ...snapshot, name: 'New name' }],
			activeRuntime: 'local',
		};
		plugin.connection = {
			current: { endpoint: endpointOf(snapshot), client: null, scope: null, tunnel: null },
			discovery: null,
		};
		plugin.kinds = { herdr: { unavailable: null, statusLines: () => null } };
		const status = (plugin.connectionStatus as () => { runtime: RuntimeConfig }).call(plugin);
		expect(status.runtime.name).toBe('New name');
	});

	it('shows the live name in the status bar and its label', () => {
		const plugin = Object.create(HerdrPlugin.prototype) as Record<string, unknown>;
		const snapshot = { ...defaultLocalRuntime(), name: 'Old name' };
		plugin.settings = {
			...structuredClone(DEFAULT_SETTINGS),
			// Two runtimes, so the bar names the active one.
			runtimes: [{ ...snapshot, name: 'New name' }, XL],
			activeRuntime: 'local',
		};
		plugin.connection = {
			current: { endpoint: endpointOf(snapshot), client: null, scope: null, tunnel: null },
			discovery: null,
		};
		const spans: string[] = [];
		const attributes = new Map<string, string>();
		plugin.statusBarEl = {
			empty: () => spans.splice(0),
			createSpan: (options: { text: string }) => spans.push(options.text),
			setAttribute: (name: string, value: string) => attributes.set(name, value),
		};
		(plugin.updateStatusBar as () => void).call(plugin);
		expect(spans).toEqual(['New name']);
		expect(attributes.get('aria-label')).toBe('Herdr agents on New name');
	});
});

/**
 * The plugin's three native-view entry points (ADR-0006), over fake kinds:
 * each must answer for the runtime it is asked about and never hand out the
 * published runtime's watcher, connection or client on another's behalf.
 */
describe('the plugin’s native view inputs, per runtime', () => {
	const CORE_A: RuntimeConfig = { ...newRuntime('herdr-core', 'local', [], () => 0.1), id: 'rt-core-a', name: 'Core A' };
	const CORE_B: RuntimeConfig = { ...newRuntime('herdr-core', 'local', [], () => 0.2), id: 'rt-core-b', name: 'Core B' };

	function harness(published: RuntimeConfig) {
		const plugin = Object.create(HerdrPlugin.prototype) as HerdrPlugin;
		// The private fields the methods read, set the way the other cases do.
		const raw = plugin as unknown as Record<string, unknown>;
		plugin.settings = {
			...structuredClone(DEFAULT_SETTINGS),
			runtimes: [defaultLocalRuntime(), XL, CORE_A, CORE_B],
			activeRuntime: published.id,
		};
		const client = { name: `client of ${published.id}` };
		const current = { endpoint: endpointOf(published), client, scope: {}, tunnel: null };
		raw.connection = { current, discovery: null };
		// The endpoint-match rule (`EndpointSessions.for`), without its caches.
		raw.endpointSession = (id: string) =>
			current.endpoint.id === id ? { endpoint: current.endpoint, client } : null;
		const transcriptCalls: [string, string | null][] = [];
		const source = new LocalTranscriptSource();
		// herdr reads only local transcripts; herdr-core reads them everywhere.
		const native = (access: (target: string) => TranscriptAccess | null) => ({
			transcriptAccess: (endpoint: { runtime: RuntimeConfig }) => access(endpoint.runtime.target),
			watcher: (connection: { endpoint: { id: string } }) => ({ watching: connection.endpoint.id }),
			transcripts: (endpoint: { id: string }, connection: { endpoint: { id: string } } | null) => {
				transcriptCalls.push([endpoint.id, connection?.endpoint.id ?? null]);
				return source;
			},
		});
		raw.kinds = {
			herdr: {
				capabilities: HERDR_CAPABILITIES,
				native: native((target) => (target === 'ssh' ? null : 'local')),
			},
			'herdr-core': { capabilities: HERDR_CORE_CAPABILITIES, native: native(() => 'local') },
		};
		return { plugin, client, transcriptCalls, source };
	}

	it('gives a watcher only for the published runtime', () => {
		const { plugin } = harness(CORE_A);
		expect(plugin.nativeWatcher(CORE_A.id)).toEqual({ watching: CORE_A.id });
		// The same pane id on two runtimes is two panes: never A's on B's behalf.
		expect(plugin.nativeWatcher(CORE_B.id)).toBeNull();
		expect(plugin.nativeWatcher('rt-gone')).toBeNull();
	});

	it('passes a runtime’s transcript source its own connection, and null for another’s', () => {
		const { plugin, transcriptCalls, source } = harness(CORE_A);
		expect(plugin.nativeTranscripts(CORE_A.id)).toBe(source);
		expect(plugin.nativeTranscripts(CORE_B.id)).toBe(source);
		expect(transcriptCalls).toEqual([
			[CORE_A.id, CORE_A.id],
			// B's source must not read through A's connection.
			[CORE_B.id, null],
		]);
		expect(plugin.nativeTranscripts('rt-gone')).toBeNull();
	});

	it('hands out the client only where the kind can back a native view on that endpoint', () => {
		// herdr over SSH: no transcripts from here, so no native view to send for.
		expect(harness(XL).plugin.nativeClient(XL.id)).toBeNull();
		const local = harness(defaultLocalRuntime());
		expect(local.plugin.nativeClient('local')).toBe(local.client);
		const core = harness(CORE_A);
		expect(core.plugin.nativeClient(CORE_A.id)).toBe(core.client);
		// And never the published runtime's client for another runtime.
		expect(core.plugin.nativeClient(CORE_B.id)).toBeNull();
	});
});
