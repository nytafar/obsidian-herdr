import { describe, expect, it } from 'vitest';
import {
	buildSpawnPath,
	discoverHerdr,
	parsePlainStatus,
	probeServer,
	resolveHerdrBinary,
	resolveSocketPath,
	type DiscoveryDeps,
	type RunResult,
} from '../src/herdr/binary';

const HOME = '/Users/test';

interface Call {
	file: string;
	args: string[];
}

function deps(
	executables: string[],
	options: {
		env?: NodeJS.ProcessEnv;
		responses?: Record<string, RunResult>;
		calls?: Call[];
	} = {},
): DiscoveryDeps {
	const set = new Set(executables);
	return {
		isExecutable: (path) => set.has(path),
		run: async (file, args) => {
			options.calls?.push({ file, args });
			const key = [file, ...args].join(' ');
			return options.responses?.[key] ?? { stdout: '', stderr: 'not found', code: 127 };
		},
		env: options.env ?? {},
		home: HOME,
	};
}

const STATUS_JSON =
	'{"status":"running","running":true,"version":"0.8.0","protocol":19,' +
	'"capabilities":{"live_handoff":true},"compatible":true,' +
	'"socket":"/Users/test/.config/herdr/herdr.sock","session":null,"restart_needed":false,' +
	'"a_field_from_a_newer_herdr":123}';

describe('resolveHerdrBinary (M2)', () => {
	it('prefers the settings override, tilde expanded', async () => {
		const resolved = await resolveHerdrBinary(
			{ override: '~/bin/herdr' },
			deps([`${HOME}/bin/herdr`, '/opt/homebrew/bin/herdr']),
		);
		expect(resolved).toEqual({ path: `${HOME}/bin/herdr`, source: 'setting' });
	});

	it('returns null when the override is not executable, rather than searching on', async () => {
		expect(
			await resolveHerdrBinary({ override: '/nope/herdr' }, deps(['/opt/homebrew/bin/herdr'])),
		).toBeNull();
	});

	it('searches homebrew, /usr/local and ~/.local in that order', async () => {
		expect(
			await resolveHerdrBinary({}, deps(['/opt/homebrew/bin/herdr', '/usr/local/bin/herdr'])),
		).toEqual({ path: '/opt/homebrew/bin/herdr', source: 'directory' });
		expect(await resolveHerdrBinary({}, deps(['/usr/local/bin/herdr']))).toEqual({
			path: '/usr/local/bin/herdr',
			source: 'directory',
		});
		expect(await resolveHerdrBinary({}, deps([`${HOME}/.local/bin/herdr`]))).toEqual({
			path: `${HOME}/.local/bin/herdr`,
			source: 'directory',
		});
	});

	it('uses the extra PATH setting before asking a shell', async () => {
		const calls: Call[] = [];
		const resolved = await resolveHerdrBinary(
			{ extraPath: '/opt/mine/bin' },
			deps(['/opt/mine/bin/herdr'], { env: { SHELL: '/bin/zsh' }, calls }),
		);
		expect(resolved).toEqual({ path: '/opt/mine/bin/herdr', source: 'extra-path' });
		expect(calls).toHaveLength(0);
	});

	it('falls back to the login shell PATH, which Dock-launched Obsidian lacks', async () => {
		const calls: Call[] = [];
		const resolved = await resolveHerdrBinary(
			{},
			deps(['/Users/test/.cargo/bin/herdr'], {
				env: { SHELL: '/bin/zsh' },
				calls,
				responses: {
					'/bin/zsh -lic printf %s "$PATH"': {
						stdout: '/usr/bin:/Users/test/.cargo/bin\n',
						stderr: '',
						code: 0,
					},
				},
			}),
		);
		expect(resolved).toEqual({ path: '/Users/test/.cargo/bin/herdr', source: 'login-shell' });
		expect(calls[0]).toEqual({ file: '/bin/zsh', args: ['-lic', 'printf %s "$PATH"'] });
	});

	it('returns null when nothing is found', async () => {
		expect(await resolveHerdrBinary({ skipLoginShell: true }, deps([]))).toBeNull();
	});
});

describe('buildSpawnPath', () => {
	it('puts the extras first, then the known directories, then the inherited PATH', async () => {
		const path = await buildSpawnPath(
			{ extraPath: '/opt/mine/bin', skipLoginShell: true },
			deps([], { env: { PATH: '/usr/bin:/opt/homebrew/bin' } }),
		);
		expect(path.split(':')).toEqual([
			'/opt/mine/bin',
			'/opt/homebrew/bin',
			'/usr/local/bin',
			`${HOME}/.local/bin`,
			'/usr/bin',
		]);
	});
});

describe('probeServer (M1, M3)', () => {
	it('parses the JSON status and ignores unknown fields', async () => {
		const probe = await probeServer(
			'/opt/homebrew/bin/herdr',
			deps([], {
				responses: {
					'/opt/homebrew/bin/herdr status server --json': {
						stdout: STATUS_JSON,
						stderr: '',
						code: 0,
					},
				},
			}),
		);
		expect(probe.error).toBeNull();
		expect(probe.status).toMatchObject({
			running: true,
			version: '0.8.0',
			protocol: 19,
			socket: '/Users/test/.config/herdr/herdr.sock',
			compatible: true,
			restartNeeded: false,
		});
	});

	it('falls back to the plain key: value output', async () => {
		const probe = await probeServer(
			'/usr/local/bin/herdr',
			deps([], {
				responses: {
					'/usr/local/bin/herdr status server --json': {
						stdout: 'status: running\nversion: 0.7.9\nprotocol: 18\nsocket: /tmp/h.sock\n',
						stderr: '',
						code: 0,
					},
				},
			}),
		);
		expect(probe.status).toMatchObject({ version: '0.7.9', protocol: 18, socket: '/tmp/h.sock' });
	});

	it('reports the stderr when the probe fails outright', async () => {
		const probe = await probeServer('/bin/herdr', deps([]));
		expect(probe.status).toBeNull();
		expect(probe.error).toBe('not found');
	});
});

describe('parsePlainStatus', () => {
	it('returns null for output with no key: value lines', () => {
		expect(parsePlainStatus('completely unrelated output')).toBeNull();
	});
});

describe('resolveSocketPath (M1)', () => {
	const env = { HERDR_SOCKET_PATH: '/tmp/from-env.sock', HERDR_SESSION: 'work' };

	it('prefers the settings override', () => {
		expect(
			resolveSocketPath(
				{ override: '~/custom.sock', status: { socket: '/tmp/reported.sock' } as never },
				{ env, home: HOME },
			),
		).toBe(`${HOME}/custom.sock`);
	});

	it('then what the server reports', () => {
		expect(
			resolveSocketPath({ status: { socket: '/tmp/reported.sock' } as never }, { env, home: HOME }),
		).toBe('/tmp/reported.sock');
	});

	it('then HERDR_SESSION, then HERDR_SOCKET_PATH, then the default', () => {
		expect(resolveSocketPath({}, { env, home: HOME })).toBe(
			`${HOME}/.config/herdr/sessions/work/herdr.sock`,
		);
		expect(
			resolveSocketPath({}, { env: { HERDR_SOCKET_PATH: '/tmp/from-env.sock' }, home: HOME }),
		).toBe('/tmp/from-env.sock');
		expect(resolveSocketPath({}, { env: {}, home: HOME })).toBe(
			`${HOME}/.config/herdr/herdr.sock`,
		);
	});
});

describe('discoverHerdr', () => {
	it('reports a clear error when the binary is missing (M2)', async () => {
		const result = await discoverHerdr({ skipLoginShell: true }, deps([], { env: {} }));
		expect(result.binary).toBeNull();
		expect(result.error).toContain('herdr was not found');
		// Still offers a socket path so settings can show the default.
		expect(result.socketPath).toBe(`${HOME}/.config/herdr/herdr.sock`);
	});

	it('names the override in the error when it is not executable', async () => {
		const result = await discoverHerdr({ override: '/nope/herdr' }, deps([]));
		expect(result.error).toContain('/nope/herdr');
	});

	it('returns binary, status and socket in one call', async () => {
		const result = await discoverHerdr(
			{ skipLoginShell: true },
			deps(['/opt/homebrew/bin/herdr'], {
				responses: {
					'/opt/homebrew/bin/herdr status server --json': {
						stdout: STATUS_JSON,
						stderr: '',
						code: 0,
					},
				},
			}),
		);
		expect(result.binary?.path).toBe('/opt/homebrew/bin/herdr');
		expect(result.status?.protocol).toBe(19);
		expect(result.socketPath).toBe('/Users/test/.config/herdr/herdr.sock');
		expect(result.error).toBeNull();
	});
});
