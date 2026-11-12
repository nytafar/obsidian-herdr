/**
 * herdr's status lines in the settings tab (issue #185), asserted at the herdr
 * adapter: `statusLines` over a connection the test describes and the
 * plugin's context (runtime, discovery, error). The text is the text the
 * settings tests asserted before the herdr adapter owned it.
 */

import { describe, expect, it } from 'vitest';
import type { Connection } from '../src/connection';
import type { DiscoveryResult } from '../src/herdr/binary';
import type { ProtocolMismatch } from '../src/herdr/client';
import { createHerdrKind } from '../src/runtime/herdrKind';
import { defaultLocalRuntime, newRuntime, type RuntimeConfig } from '../src/runtimes';

const kind = createHerdrKind({
	extraPath: () => '',
	vaultPath: () => '/vault',
	discoveryDeps: {
		isExecutable: () => false,
		run: () => Promise.resolve({ stdout: '', stderr: '', code: 1 }),
		env: {},
		home: '/home/u',
	},
	onUnsupportedMethod: () => undefined,
	isPublished: () => true,
});

const DISCOVERY = {
	binary: { path: '/opt/homebrew/bin/herdr', source: 'homebrew' },
	socketPath: '/tmp/herdr.sock',
	status: { status: 'running', version: '0.8.0', protocol: 19 },
	error: null,
} as unknown as DiscoveryResult;

const WORKSPACE = { workspaceId: 'w4', workspaceLabel: 'hvelv', method: 'label', size: 3 };

/** The local herdr, or an SSH herdr runtime with these fields. */
function runtime(ssh?: Partial<RuntimeConfig>): RuntimeConfig {
	if (!ssh) return defaultLocalRuntime();
	return { ...newRuntime('herdr', 'ssh', [], () => 0.25), ...ssh };
}

interface Live {
	socket?: string;
	lastMismatch?: ProtocolMismatch | null;
	tunnel?: { statusText: string; status: { state: string } } | null;
	scope?: Partial<typeof WORKSPACE> | null;
}

/** The adapter's lines for this runtime, discovery and error, over a connection or none. */
function lines(
	rt: RuntimeConfig,
	options: { discovery?: DiscoveryResult | null; error?: string | null; live?: Live | null } = {},
): { text: string; warning?: boolean }[] {
	const live = options.live === undefined ? {} : options.live;
	const connection = live
		? ({
				client: { socket: live.socket ?? '/tmp/herdr.sock', lastMismatch: live.lastMismatch ?? null },
				tunnel: live.tunnel ?? null,
				scope: live.scope === null ? { workspaceId: null } : { ...WORKSPACE, ...live.scope },
			} as unknown as Connection)
		: null;
	return (
		kind.statusLines(connection as never, {
			runtime: rt,
			discovery: options.discovery === undefined ? DISCOVERY : options.discovery,
			error: options.error ?? null,
		}) ?? []
	);
}

describe('herdr’s status lines', () => {
	it('says nothing but "not connected" before discovery ran', () => {
		expect(lines(runtime(), { discovery: null, live: null })).toEqual([{ text: 'Not connected yet.', warning: false }]);
	});

	it('does not name the runtime: the page is its own', () => {
		const text = lines(runtime({ host: 'xl', name: 'XL' })).map((line) => line.text);
		expect(text.some((line) => line.startsWith('Runtime: '))).toBe(false);
	});

	it('reports a failure that came before discovery', () => {
		expect(lines(runtime(), { discovery: null, live: null, error: 'the runtime has no SSH host' })).toEqual([
			{ text: 'The runtime has no SSH host.', warning: true },
		]);
	});

	it('reports binary, socket, server and workspace', () => {
		const text = lines(runtime())
			.map((line) => line.text)
			.join('\n');
		expect(text).toContain('/opt/homebrew/bin/herdr');
		expect(text).toContain('Socket: /tmp/herdr.sock');
		expect(text).toContain('protocol 19');
		expect(text).toContain('Workspace: hvelv (w4, matched by label), 3 agent panes');
	});

	it('names the socket the client uses, and the discovered one before there is a client', () => {
		expect(lines(runtime(), { live: { socket: '/tmp/forwarded.sock' } }).map((line) => line.text)).toContain(
			'Socket: /tmp/forwarded.sock',
		);
		expect(lines(runtime(), { live: null }).map((line) => line.text)).toContain('Socket: /tmp/herdr.sock');
	});

	it('leaves a missing remote vault path to the page’s Problems row', () => {
		const result = lines(runtime({ host: 'lasse@xl', remoteVaultPath: '' }));
		expect(result.some((line) => /folder actions|remote vault path/i.test(line.text))).toBe(false);
	});

	it('says the tunnel’s state over SSH, and that it has not started without one', () => {
		const ssh = runtime({ host: 'lasse@xl', remoteVaultPath: '/home/lasse/hvelv' });
		expect(lines(ssh, { live: { tunnel: { statusText: 'SSH tunnel: connected.', status: { state: 'connected' } } } })[0]).toEqual({
			text: 'SSH tunnel: connected.',
			warning: false,
		});
		expect(lines(ssh, { live: { tunnel: { statusText: 'SSH tunnel: down.', status: { state: 'error' } } } })[0]).toEqual({
			text: 'SSH tunnel: down.',
			warning: true,
		});
		expect(lines(ssh, { live: null })[0]).toEqual({ text: 'SSH tunnel: not started.', warning: true });
	});

	it('warns when no workspace matches the vault', () => {
		expect(lines(runtime(), { live: { scope: null } }).at(-1)).toEqual({
			text: 'Workspace: no herdr workspace matches this vault yet.',
			warning: true,
		});
	});

	it('warns of a protocol mismatch the client reported, and the root line hears of it', () => {
		const mismatch: ProtocolMismatch = { server: 23, expected: 22, version: '0.10.0' };
		const warned = lines(runtime(), { live: { lastMismatch: mismatch } }).find((line) =>
			line.text.startsWith('Protocol mismatch'),
		);
		expect(warned).toEqual({
			text: 'Protocol mismatch: herdr speaks 23, this plugin was built against 22. Everything still works unless a method is missing.',
			warning: true,
		});
		const connection = { client: { lastMismatch: mismatch } } as unknown as Connection;
		expect(kind.mismatched?.(connection as never)).toBe(true);
		expect(kind.mismatched?.(null)).toBe(false);
	});

	it('warns when the chosen binary speaks another protocol than the server (#87)', () => {
		const result = lines(runtime(), {
			discovery: {
				binary: { path: '/Users/test/.local/bin/herdr', source: 'directory' },
				socketPath: '/tmp/herdr.sock',
				status: { status: 'running', version: '0.8.2', protocol: 20 },
				identity: { version: '0.8.0', protocol: 19 },
				error: null,
			} as unknown as DiscoveryResult,
		});
		const warning = result.find((line) => line.text.startsWith('Binary protocol mismatch'));
		expect(warning?.warning).toBe(true);
		expect(warning?.text).toContain('/Users/test/.local/bin/herdr');
		expect(warning?.text).toContain('protocol 19');
		expect(warning?.text).toContain('the server speaks 20');
	});

	it('says nothing about the binary protocol when it matches the server', () => {
		const result = lines(runtime(), {
			discovery: {
				binary: { path: '/usr/bin/herdr', source: 'login-shell' },
				socketPath: '/tmp/herdr.sock',
				status: { status: 'running', version: '0.8.2', protocol: 20 },
				identity: { version: '0.8.2', protocol: 20 },
				error: null,
			} as unknown as DiscoveryResult,
		});
		expect(result.some((line) => line.text.startsWith('Binary protocol mismatch'))).toBe(false);
	});

	it('stays quiet about the local binary protocol on an SSH runtime', () => {
		const result = lines(runtime({ host: 'lasse@xl', remoteVaultPath: '/home/lasse/hvelv' }), {
			discovery: {
				binary: { path: '/Users/test/.local/bin/herdr', source: 'directory' },
				socketPath: '/tmp/herdr.sock',
				status: { status: 'running', version: '0.8.2', protocol: 20 },
				identity: { version: '0.8.0', protocol: 19 },
				error: null,
			} as unknown as DiscoveryResult,
		});
		expect(result.some((line) => line.text.startsWith('Binary protocol mismatch'))).toBe(false);
	});

	it('ends with the last failure, as it is', () => {
		expect(lines(runtime(), { error: 'stream dropped' }).at(-1)).toEqual({ text: 'stream dropped', warning: true });
	});
});
