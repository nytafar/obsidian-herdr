import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	buildTunnelArgv,
	localSocketPathFor,
	MAX_LOCAL_SOCKET_PATH,
	remoteHerdrCommand,
	SshTunnel,
	terminalArgvPrefix,
	type SshTunnelDeps,
	type TunnelChild,
	type TunnelStatus,
} from '../src/herdr/ssh';
// Type-only: `src/settings.ts` imports the `obsidian` module, which has no
// runtime entry point outside the app, so nothing from it may be imported here.
import type { RuntimeConfig } from '../src/runtimes';

const HOST = 'lasse@xl';
const REMOTE_SOCKET = '/home/lasse/.config/herdr/herdr.sock';

/** A stand-in for the `ssh` child: nothing is spawned in these tests. */
class FakeChild implements TunnelChild {
	readonly pid = 4242;
	readonly signals: NodeJS.Signals[] = [];
	readonly stderr = {
		on: (_event: 'data', listener: (chunk: unknown) => void) => {
			this.stderrListeners.push(listener);
		},
	};

	private readonly exitListeners: ((
		code: number | null,
		signal: NodeJS.Signals | null,
	) => void)[] = [];
	private readonly errorListeners: ((error: Error) => void)[] = [];
	private readonly stderrListeners: ((chunk: unknown) => void)[] = [];
	private exited = false;

	kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
		this.signals.push(signal);
		if (signal === 'SIGKILL') this.exit(null, 'SIGKILL');
		else this.exit(null, 'SIGTERM');
		return true;
	}

	on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	on(event: 'error', listener: (error: Error) => void): void;
	on(event: 'exit' | 'error', listener: (...args: never[]) => void): void {
		if (event === 'exit') {
			this.exitListeners.push(
				listener as unknown as (code: number | null, signal: NodeJS.Signals | null) => void,
			);
		} else {
			this.errorListeners.push(listener as unknown as (error: Error) => void);
		}
	}

	writeStderr(text: string): void {
		for (const listener of [...this.stderrListeners]) listener(Buffer.from(text));
	}

	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		if (this.exited) return;
		this.exited = true;
		for (const listener of [...this.exitListeners]) listener(code, signal);
	}
}

interface Harness {
	deps: SshTunnelDeps;
	children: FakeChild[];
	spawns: { file: string; args: string[] }[];
	removed: string[];
	runs: { file: string; args: string[]; signal: AbortSignal; timeoutMs: number }[];
	/** Flipped to make the probe succeed. */
	listening: boolean;
	/** Spawn ordinals (1-based) whose probe never succeeds. */
	deadSpawns: number[];
}

function harness(
	options: { listening?: boolean; deadSpawns?: number[]; home?: string } = {},
): Harness {
	const state: Harness = {
		children: [],
		spawns: [],
		removed: [],
		runs: [],
		listening: options.listening ?? true,
		deadSpawns: options.deadSpawns ?? [],
		deps: {} as SshTunnelDeps,
	};
	state.deps = {
		spawn: (file, args) => {
			state.spawns.push({ file, args });
			const child = new FakeChild();
			state.children.push(child);
			return child;
		},
		probe: async () => state.listening && !state.deadSpawns.includes(state.spawns.length),
		removeFile: async (path) => {
			state.removed.push(path);
		},
		run: async (file, args, { signal, timeoutMs }) => {
			state.runs.push({ file, args, signal, timeoutMs });
			return options.home ?? '/home/lasse';
		},
	};
	return state;
}

/** Only target, host and binary matter to the argv, so the helper takes that slice. */
function runtime(
	fields: Partial<Pick<RuntimeConfig, 'target' | 'host' | 'binary'>>,
): Pick<RuntimeConfig, 'target' | 'host' | 'binary'> {
	return { target: 'local', host: '', binary: '', ...fields };
}

describe('localSocketPathFor (S5)', () => {
	it('stays far under the 104 byte macOS socket limit', () => {
		const path = localSocketPathFor(HOST, REMOTE_SOCKET);
		expect(path).toMatch(/^\/tmp\/herdr-[0-9a-f]{8}\.sock$/);
		expect(path.length).toBeLessThan(MAX_LOCAL_SOCKET_PATH);
	});

	it('is stable per profile and different across profiles', () => {
		expect(localSocketPathFor(HOST, REMOTE_SOCKET)).toBe(localSocketPathFor(HOST, REMOTE_SOCKET));
		expect(localSocketPathFor(HOST, REMOTE_SOCKET)).not.toBe(
			localSocketPathFor('other@host', REMOTE_SOCKET),
		);
		expect(localSocketPathFor(HOST, REMOTE_SOCKET)).not.toBe(
			localSocketPathFor(HOST, '/run/herdr.sock'),
		);
	});

	it('gives every tunnel instance its own path for identical settings (#59)', () => {
		const a = new SshTunnel({ host: HOST, remoteSocketPath: REMOTE_SOCKET });
		const b = new SshTunnel({ host: HOST, remoteSocketPath: REMOTE_SOCKET });
		expect(a.localSocketPath).not.toBe(b.localSocketPath);
		expect(a.localSocketPath).toMatch(/^\/tmp\/herdr-[0-9a-f]{8}\.sock$/);
		expect(localSocketPathFor(HOST, REMOTE_SOCKET, '/tmp', 'x')).not.toBe(
			localSocketPathFor(HOST, REMOTE_SOCKET, '/tmp', 'y'),
		);
	});

	it('rejects an over-long explicit local path instead of letting ssh fail', () => {
		const long = `/tmp/${'x'.repeat(120)}.sock`;
		expect(
			() =>
				new SshTunnel({ host: HOST, remoteSocketPath: REMOTE_SOCKET, localSocketPath: long }),
		).toThrow(/over the 100 character limit/);
	});
});

describe('buildTunnelArgv (S5)', () => {
	it('runs no remote command, never prompts, and exits on a failed bind', () => {
		expect(
			buildTunnelArgv({
				host: HOST,
				localSocketPath: '/tmp/herdr-abcd1234.sock',
				remoteSocketPath: REMOTE_SOCKET,
			}),
		).toEqual([
			'-N',
			'-o',
			'BatchMode=yes',
			'-o',
			'ExitOnForwardFailure=yes',
			'-o',
			'ServerAliveInterval=15',
			'-o',
			'ServerAliveCountMax=3',
			'-L',
			`/tmp/herdr-abcd1234.sock:${REMOTE_SOCKET}`,
			HOST,
		]);
	});

	it('keeps extra ssh arguments before the forward spec', () => {
		const argv = buildTunnelArgv({
			host: HOST,
			localSocketPath: '/tmp/a.sock',
			remoteSocketPath: REMOTE_SOCKET,
			sshArgs: ['-p', '2222'],
		});
		expect(argv.slice(argv.indexOf('-p'), argv.indexOf('-p') + 2)).toEqual(['-p', '2222']);
		expect(argv.indexOf('-p')).toBeLessThan(argv.indexOf('-L'));
	});
});

describe('SshTunnel.start', () => {
	it('removes a stale socket, spawns ssh and resolves with the local path', async () => {
		const h = harness();
		const states: TunnelStatus['state'][] = [];
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: REMOTE_SOCKET,
			deps: h.deps,
			onStatus: (status) => states.push(status.state),
		});

		const local = await tunnel.start();

		expect(local).toBe(tunnel.localSocketPath);
		expect(h.removed).toEqual([local]);
		expect(h.spawns).toHaveLength(1);
		expect(h.spawns[0]?.file).toBe('ssh');
		expect(h.spawns[0]?.args).toContain(`${local}:${REMOTE_SOCKET}`);
		expect(states).toEqual(['starting', 'connected']);
		expect(tunnel.status.error).toBeNull();
		expect(tunnel.statusText).toContain('connected to lasse@xl');

		await tunnel.stop();
	});

	it('expands a tilde in the remote socket path, which ssh does not do itself', async () => {
		const h = harness({ home: '/home/lasse' });
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: '~/.config/herdr/herdr.sock',
			deps: h.deps,
		});

		await tunnel.start();

		expect(h.runs).toHaveLength(1);
		// The lookup is bounded and cancellable (#59).
		expect(h.runs[0]?.timeoutMs).toBeGreaterThan(0);
		expect(h.runs[0]?.signal.aborted).toBe(false);
		expect(h.spawns[0]?.args).toContain(
			`${tunnel.localSocketPath}:/home/lasse/.config/herdr/herdr.sock`,
		);
		expect(tunnel.status.remoteSocketPath).toBe('/home/lasse/.config/herdr/herdr.sock');
		// The row model shortens remote cwds with this (issue #22).
		expect(tunnel.remoteHome).toBe('/home/lasse');

		await tunnel.stop();
	});

	it('does not shell out for an absolute remote socket path', async () => {
		const h = harness();
		const tunnel = new SshTunnel({ host: HOST, remoteSocketPath: REMOTE_SOCKET, deps: h.deps });
		await tunnel.start();
		expect(h.runs).toEqual([]);
		// Nothing was resolved, so there is no remote home to reuse (issue #22).
		expect(tunnel.remoteHome).toBe('');
		await tunnel.stop();
	});

	it('fails with ssh stderr, kills the child and removes the socket file', async () => {
		const h = harness({ listening: false });
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: REMOTE_SOCKET,
			connectTimeoutMs: 30,
			probeIntervalMs: 5,
			deps: h.deps,
		});
		// The forward is refused: ssh writes to stderr and exits.
		void waitFor(() => h.children.length === 1).then(() => {
			const child = h.children[0];
			child?.writeStderr('bind: Address already in use\n');
			child?.exit(255);
		});

		await expect(tunnel.start()).rejects.toThrow(/Address already in use/);
		expect(tunnel.status.state).toBe('failed');
		expect(tunnel.status.error).toContain('Address already in use');
		// Once before the spawn, once during the cleanup.
		expect(h.removed.filter((p) => p === tunnel.localSocketPath)).toHaveLength(2);
	});

	it('reports a timeout when the socket never accepts a connection', async () => {
		const h = harness({ listening: false });
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: REMOTE_SOCKET,
			connectTimeoutMs: 20,
			probeIntervalMs: 5,
			deps: h.deps,
		});
		await expect(tunnel.start()).rejects.toThrow(/never accepted a connection/);
		expect(h.children[0]?.signals).toContain('SIGTERM');
	});
});

describe('SshTunnel reconnect and stop', () => {
	it('respawns with backoff after the link drops', async () => {
		const h = harness();
		const states: TunnelStatus['state'][] = [];
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: REMOTE_SOCKET,
			backoffMs: 5,
			probeIntervalMs: 5,
			deps: h.deps,
			onStatus: (status) => states.push(status.state),
		});
		await tunnel.start();

		h.children[0]?.exit(255);
		expect(tunnel.status.state).toBe('reconnecting');

		await waitFor(() => h.spawns.length === 2 && tunnel.status.state === 'connected');
		expect(states[0]).toBe('starting');
		expect(states[1]).toBe('connected');
		expect(states.slice(2, -1).every((state) => state === 'reconnecting')).toBe(true);
		expect(states.at(-1)).toBe('connected');

		await tunnel.stop();
	});

	it('keeps retrying with a growing delay while the host stays down', async () => {
		const h = harness({ deadSpawns: [2, 3] });
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: REMOTE_SOCKET,
			backoffMs: 5,
			maxBackoffMs: 20,
			connectTimeoutMs: 20,
			probeIntervalMs: 5,
			deps: h.deps,
		});
		await tunnel.start();
		h.children[0]?.exit(255);

		await waitFor(() => tunnel.status.state === 'connected');
		expect(h.spawns).toHaveLength(4);

		await tunnel.stop();
	});

	it('does not reconnect when reconnect is off', async () => {
		const h = harness();
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: REMOTE_SOCKET,
			reconnect: false,
			deps: h.deps,
		});
		await tunnel.start();
		h.children[0]?.exit(0);
		await delay(20);
		expect(h.spawns).toHaveLength(1);
		await tunnel.stop();
	});

	it('stop terminates the child, removes the socket and cancels the retry', async () => {
		const h = harness();
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: REMOTE_SOCKET,
			backoffMs: 5,
			deps: h.deps,
		});
		await tunnel.start();
		h.children[0]?.exit(255);
		expect(tunnel.status.state).toBe('reconnecting');

		await tunnel.stop();
		await delay(30);

		expect(h.spawns).toHaveLength(1);
		expect(tunnel.status.state).toBe('stopped');
		expect(h.removed.at(-1)).toBe(tunnel.localSocketPath);
	});

	it('stop is idempotent and sends SIGTERM first', async () => {
		const h = harness();
		const tunnel = new SshTunnel({ host: HOST, remoteSocketPath: REMOTE_SOCKET, deps: h.deps });
		await tunnel.start();
		await tunnel.stop();
		await tunnel.stop();
		expect(h.children[0]?.signals[0]).toBe('SIGTERM');
	});
});

describe('SshTunnel ownership (#59)', () => {
	it('stop during remote HOME resolution spawns nothing and leaves stopped', async () => {
		const h = harness();
		const home = deferred<string>();
		let lookup: AbortSignal | null = null;
		h.deps.run = (_file, _args, { signal }) => {
			lookup = signal;
			// The real dep resolves '' once the signal kills the child.
			signal.addEventListener('abort', () => home.resolve(''));
			return home.promise;
		};
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: '~/.config/herdr/herdr.sock',
			homeTimeoutMs: 50,
			killGraceMs: 1,
			deps: h.deps,
		});

		const starting = tunnel.start();
		await delay(5);
		await tunnel.stop();
		// The lookup child is killed rather than left to finish on its own.
		expect((lookup as AbortSignal | null)?.aborted).toBe(true);

		await expect(starting).rejects.toThrow(/stopped while connecting/);
		expect(h.spawns).toHaveLength(0);
		expect(tunnel.remoteHome).toBe('');
		expect(h.children).toHaveLength(0);
		expect(tunnel.status.state).toBe('stopped');
		expect(h.removed.at(-1)).toBe(tunnel.localSocketPath);
	});

	it('stop during the pre-spawn unlink spawns nothing', async () => {
		const h = harness();
		const unlink = deferred<void>();
		let removals = 0;
		h.deps.removeFile = async (path) => {
			h.removed.push(path);
			removals += 1;
			// The first removal is the one before the spawn; hold it.
			if (removals === 1) await unlink.promise;
		};
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: REMOTE_SOCKET,
			killGraceMs: 1,
			deps: h.deps,
		});

		const starting = tunnel.start();
		await delay(5);
		expect(tunnel.status.state).toBe('starting');
		await tunnel.stop();
		unlink.resolve();

		await expect(starting).rejects.toThrow(/stopped while connecting/);
		expect(h.spawns).toHaveLength(0);
		expect(tunnel.status.state).toBe('stopped');
	});

	it('stop during the probe kills the child and never reports connected', async () => {
		const h = harness();
		const probe = deferred<boolean>();
		h.deps.probe = () => probe.promise;
		const states: TunnelStatus['state'][] = [];
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: REMOTE_SOCKET,
			killGraceMs: 1,
			deps: h.deps,
			onStatus: (status) => states.push(status.state),
		});

		const starting = tunnel.start();
		await waitFor(() => h.children.length === 1);
		await tunnel.stop();
		probe.resolve(true);

		await expect(starting).rejects.toThrow(/stopped while connecting/);
		expect(h.children[0]?.signals).toEqual(['SIGTERM']);
		expect(states).not.toContain('connected');
		expect(tunnel.status.state).toBe('stopped');
		expect(h.removed.at(-1)).toBe(tunnel.localSocketPath);
	});

	it('an attempt whose child was never handed to stop still reaps it', async () => {
		// stop() lands between spawn and the probe, but before the exit handler
		// has any say: the attempt itself must kill the child it created.
		const h = harness();
		const probe = deferred<boolean>();
		h.deps.probe = () => probe.promise;
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: REMOTE_SOCKET,
			killGraceMs: 1,
			deps: h.deps,
		});
		const starting = tunnel.start();
		await waitFor(() => h.children.length === 1);
		// A second start supersedes the first without a stop in between.
		h.deps.probe = async () => true;
		const restarted = tunnel.start();
		probe.resolve(true);

		await expect(starting).rejects.toThrow(/stopped while connecting/);
		await restarted;
		expect(h.children).toHaveLength(2);
		expect(h.children[0]?.signals).toEqual(['SIGTERM']);
		expect(tunnel.status.state).toBe('connected');
		await tunnel.stop();
	});

	it('two tunnels with identical settings start and stop without touching each other', async () => {
		// A Map stands in for /tmp: spawn binds, removeFile unlinks, probe checks.
		const sockets = new Map<string, string>();
		const make = (owner: string): { tunnel: SshTunnel; children: FakeChild[] } => {
			const children: FakeChild[] = [];
			const tunnel = new SshTunnel({
				host: HOST,
				remoteSocketPath: REMOTE_SOCKET,
				killGraceMs: 1,
				deps: {
					run: async () => '',
					removeFile: async (path) => {
						sockets.delete(path);
					},
					probe: async (path) => sockets.has(path),
					spawn: (_file, args) => {
						const spec = args[args.indexOf('-L') + 1] ?? '';
						sockets.set(spec.slice(0, spec.indexOf(':')), owner);
						const child = new FakeChild();
						children.push(child);
						return child;
					},
				},
			});
			return { tunnel, children };
		};
		const a = make('vault A');
		const b = make('vault B');
		await a.tunnel.start();
		await b.tunnel.start();

		expect(a.tunnel.localSocketPath).not.toBe(b.tunnel.localSocketPath);
		expect(sockets.get(a.tunnel.localSocketPath)).toBe('vault A');
		expect(sockets.get(b.tunnel.localSocketPath)).toBe('vault B');

		await a.tunnel.stop();
		expect(sockets.has(a.tunnel.localSocketPath)).toBe(false);
		expect(sockets.get(b.tunnel.localSocketPath)).toBe('vault B');
		expect(b.children[0]?.signals).toEqual([]);
		expect(b.tunnel.status.state).toBe('connected');

		await b.tunnel.stop();
		expect(sockets.size).toBe(0);
	});

	it('retries reuse the instance path, not a fresh one', async () => {
		const h = harness();
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: REMOTE_SOCKET,
			backoffMs: 5,
			killGraceMs: 1,
			deps: h.deps,
		});
		const path = tunnel.localSocketPath;
		await tunnel.start();
		h.children[0]?.exit(255);
		await waitFor(() => h.spawns.length === 2 && tunnel.status.state === 'connected');
		for (const spawn of h.spawns) expect(spawn.args).toContain(`${path}:${REMOTE_SOCKET}`);
		expect(new Set(h.removed)).toEqual(new Set([path]));
		await tunnel.stop();
	});

	it('stop while a reconnect is mid-flight does not leave a child behind', async () => {
		const h = harness();
		const probe = deferred<boolean>();
		const tunnel = new SshTunnel({
			host: HOST,
			remoteSocketPath: REMOTE_SOCKET,
			backoffMs: 5,
			killGraceMs: 1,
			deps: h.deps,
		});
		await tunnel.start();
		h.deps.probe = () => probe.promise;
		h.children[0]?.exit(255);
		await waitFor(() => h.children.length === 2);

		await tunnel.stop();
		probe.resolve(true);
		await delay(20);

		expect(h.children[1]?.signals).toEqual(['SIGTERM']);
		expect(h.spawns).toHaveLength(2);
		expect(tunnel.status.state).toBe('stopped');
	});
});

describe('terminalArgvPrefix (S17)', () => {
	it('uses the local binary on a local runtime', () => {
		expect(terminalArgvPrefix(runtime({ target: 'local' }), '/opt/homebrew/bin/herdr')).toEqual([
			'/opt/homebrew/bin/herdr',
		]);
	});

	it('goes over ssh -T with the remote binary, never through the tunnel', () => {
		expect(
			terminalArgvPrefix(
				runtime({
					target: 'ssh',
					host: HOST,
					binary: '/home/lasse/.local/bin/herdr',
				}),
				'/opt/homebrew/bin/herdr',
			),
		).toEqual(['ssh', '-T', HOST, `sh -c 'exec /home/lasse/.local/bin/herdr "$@"' herdr`]);
	});

	it('searches the remote host when the binary is empty', () => {
		expect(terminalArgvPrefix(runtime({ target: 'ssh', host: HOST, binary: ' ' }), '/bin/herdr')).toEqual([
			'ssh',
			'-T',
			HOST,
			remoteHerdrCommand(''),
		]);
	});

	it('refuses an SSH runtime without a host rather than spawning a broken command', () => {
		expect(() => terminalArgvPrefix(runtime({ target: 'ssh', host: '' }), '/bin/herdr')).toThrow(
			/SSH host/,
		);
	});
});

describe('remoteHerdrCommand', () => {
	it('runs a named binary as given, a leading ~/ being the remote home', () => {
		expect(remoteHerdrCommand('/opt/homebrew/bin/herdr')).toBe(
			`sh -c 'exec /opt/homebrew/bin/herdr "$@"' herdr`,
		);
		expect(remoteHerdrCommand(' ~/.local/bin/herdr ')).toBe(
			`sh -c 'exec "$HOME"/.local/bin/herdr "$@"' herdr`,
		);
	});

	it('searches the PATH, then Homebrew, /usr/local/bin and ~/.local/bin, in that order', () => {
		const command = remoteHerdrCommand('');
		expect(command.startsWith(`sh -c 'p=$(command -v herdr)`)).toBe(true);
		expect(command).toContain('for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do');
		expect(command).toContain('exit 127');
		expect(command.endsWith(`exec "$p" "$@"' herdr`)).toBe(true);
	});

	it('quotes the script once, with nothing a fish or nu shell reads differently', () => {
		// The only single quotes are the outer pair, and no backslash at all:
		// fish and nu then hand sh the script byte for byte.
		const command = remoteHerdrCommand('');
		const script = command.slice('sh -c '.length, -' herdr'.length);
		expect(script.startsWith("'") && script.endsWith("'")).toBe(true);
		expect(script.slice(1, -1)).not.toMatch(/['\\]/);
	});
});

/**
 * The remote command run by a local `/bin/sh`, as the remote login shell runs
 * what `ssh` hands it: the bridge's arguments appended to the command line.
 * No `ssh` is involved, and the PATH is a directory the test owns.
 */
describe('remoteHerdrCommand under sh', () => {
	let home: string;
	let path: string;
	// The fixed directories are the machine's own; a herdr in one of them would
	// be found before the test's `~/.local/bin`.
	const systemHerdr = ['/opt/homebrew/bin/herdr', '/usr/local/bin/herdr'].some((file) => existsSync(file));

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'oh-remote-herdr-'));
		path = join(home, 'path');
		mkdirSync(path);
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	/** A herdr that prints its own path and its arguments, one per line. */
	function fakeHerdr(dir: string): string {
		mkdirSync(dir, { recursive: true });
		const file = join(dir, 'herdr');
		writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n');
		chmodSync(file, 0o755);
		return file;
	}

	function run(binary: string) {
		// The PATH holds the test's directory and a `sh`, nothing else.
		const shell = join(home, 'shell');
		mkdirSync(shell, { recursive: true });
		if (!existsSync(join(shell, 'sh'))) symlinkSync('/bin/sh', join(shell, 'sh'));
		const line = `${remoteHerdrCommand(binary)} terminal session observe w1:p2 --cols 80`;
		return spawnSync('/bin/sh', ['-c', line], {
			env: { HOME: home, PATH: `${path}:${shell}` },
			encoding: 'utf8',
		});
	}

	it('finds herdr on the PATH first', () => {
		const onPath = fakeHerdr(path);
		fakeHerdr(join(home, '.local', 'bin'));
		const result = run('');
		expect(result.status).toBe(0);
		expect(result.stdout.split('\n')).toEqual([onPath, 'terminal', 'session', 'observe', 'w1:p2', '--cols', '80', '']);
	});

	it.skipIf(systemHerdr)('falls back to ~/.local/bin when the PATH has none', () => {
		const local = fakeHerdr(join(home, '.local', 'bin'));
		const result = run('');
		expect(result.status).toBe(0);
		expect(result.stdout.split('\n')[0]).toBe(local);
	});

	it.skipIf(systemHerdr)('fails with exit 127 and says where it looked', () => {
		const result = run('');
		expect(result.status).toBe(127);
		expect(result.stderr).toContain('herdr is not installed here');
		expect(result.stderr).toContain('/opt/homebrew/bin, /usr/local/bin or ~/.local/bin');
	});

	it('runs a named binary under the remote home, with a space in its path', () => {
		const named = fakeHerdr(join(home, 'my tools'));
		const result = run('~/my tools/herdr');
		expect(result.status).toBe(0);
		expect(result.stdout.split('\n').slice(0, 3)).toEqual([named, 'terminal', 'session']);
	});
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('condition was not met in time');
		await delay(5);
	}
}
