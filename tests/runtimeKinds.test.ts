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
import { SshTunnel } from '../src/herdr/ssh';
import { WorkspaceScope } from '../src/herdr/scope';
import { createHerdrKind, type HerdrKindHost } from '../src/runtime/herdrKind';
import {
	HERDR_CAPABILITIES,
	HERDR_CORE_CAPABILITIES,
	HERDR_CORE_UNAVAILABLE,
	nativeViewBlock,
	NATIVE_NO_SESSION_REASON,
	unavailableKind,
} from '../src/runtime/kind';
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
			'/home/lasse/.local/bin/herdr',
		]);
	});

	it('expands a `~` override for a local spawn, and leaves it to the remote shell over SSH', () => {
		const tilde = endpointOf({ ...defaultLocalRuntime(), binary: '~/.local/bin/herdr' });
		expect(kind.terminalCommand(tilde)).toEqual([`${HOME}/.local/bin/herdr`]);
		expect(kind.terminalCommand(endpointOf({ ...XL, binary: '~/.local/bin/herdr' }))).toEqual([
			'ssh',
			'-T',
			'lasse@xl',
			'~/.local/bin/herdr',
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
		expect(paneViewAvailability('native', nativeViewBlock(kind, false)).available).toBe(true);
		expect(paneViewAvailability('native', nativeViewBlock(kind, true)).reason).toBe(
			'local panes only',
		);
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

	it('leaves out tabs, splits, rename, focus and the native view (ADR-0005)', () => {
		expect(core.capabilities).toMatchObject({
			tabs: false,
			splits: false,
			rename: false,
			focus: false,
			nativeView: false,
			startAgent: true,
			close: true,
		});
		expect(paneViewAvailability('native', nativeViewBlock(core, false)).reason).toBe(
			NATIVE_NO_SESSION_REASON,
		);
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
});
