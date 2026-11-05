/**
 * The runtime kind seam (ADR-0004, ADR-0005): the herdr kind's choices per
 * target, the placeholder herdr-core kind's refusals, and the plugin's load
 * path migrating a pre-registry `data.json` and writing it back once.
 *
 * The herdr adapter is driven with a host of fakes; nothing here spawns ssh or
 * herdr (an `SshTunnel` does nothing until `start()`).
 */

import { describe, expect, it } from 'vitest';
import HerdrPlugin from '../src/main';
import { endpointOf } from '../src/connection';
import type { DiscoveryResult } from '../src/herdr/binary';
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

function host(overrides: Partial<HerdrKindHost> = {}): HerdrKindHost {
	return {
		extraPath: () => '',
		vaultPath: () => '/Users/lasse/Vaults/hvelv',
		discoveredBinary: () => '/usr/bin/herdr',
		onProtocolMismatch: () => undefined,
		onUnsupportedMethod: () => undefined,
		lookupPanes: () => Promise.resolve([]),
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
		const scope = driver.createScope(xl);
		expect(scope).toBeInstanceOf(WorkspaceScope);
		expect((scope as unknown as { options: { workspaceId: string } }).options.workspaceId).toBe(
			'w7',
		);
	});

	it('builds terminal argv from the pinned runtime', () => {
		expect(kind.terminalCommand(local)).toEqual(['/usr/bin/herdr']);
		// A local runtime naming its own binary uses it over the discovered one.
		expect(kind.terminalCommand(endpointOf({ ...defaultLocalRuntime(), binary: '/opt/herdr' }))).toEqual([
			'/opt/herdr',
		]);
		expect(kind.terminalCommand(xl)).toEqual([
			'ssh',
			'-T',
			'lasse@xl',
			'/home/lasse/.local/bin/herdr',
		]);
		const undiscovered = createHerdrKind(host({ discoveredBinary: () => '' }));
		expect(() => undiscovered.terminalCommand(local)).toThrow('the herdr binary path is empty');
	});

	it('allows the native view on a local runtime only', () => {
		expect(paneViewAvailability('native', nativeViewBlock(kind, false)).available).toBe(true);
		expect(paneViewAvailability('native', nativeViewBlock(kind, true)).reason).toBe(
			'local panes only',
		);
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

	it('starts a fresh install on the local herdr without sharing the defaults', async () => {
		const { settings } = await load(null);
		expect(settings.runtimes).toEqual(DEFAULT_SETTINGS.runtimes);
		expect(settings.runtimes).not.toBe(DEFAULT_SETTINGS.runtimes);
		expect(settings.activeRuntime).toBe('local');
	});
});
