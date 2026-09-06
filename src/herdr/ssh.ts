/**
 * Remote herdr over SSH (PRD S5, S17, risks table; RESEARCH.md section 2c).
 *
 * Two independent seams, and they must not be confused:
 *
 *   - The **JSON API** socket (`herdr.sock`) is forwarded with
 *     `ssh -N -L <local>:<remote> host`, and the plugin's `HerdrClient` then
 *     talks to the local end as if herdr were local. Verified end to end
 *     against `lasse@xl`: `ping` and `workspace.list` both answer through it.
 *   - The **terminal bridge** talks to a *different* socket (`herdr-client.sock`)
 *     inside the herdr CLI process, so forwarding the API socket gives no
 *     terminals. Remote terminals therefore run the CLI on the far side:
 *     `ssh -T host <remoteBinary> terminal session control|observe …`
 *     (`terminalArgvPrefix`). Same NDJSON contract, different spawn.
 *
 * Gotchas encoded here, each measured:
 *   - Unix socket paths are capped around 104 bytes on macOS; a long local path
 *     is rejected outright with "Bad local forwarding specification". The local
 *     end is `/tmp/herdr-<8 hex>.sock` (24 chars), derived from host plus remote
 *     path so two profiles never collide.
 *   - A stale local socket file makes the bind fail. It is removed before every
 *     spawn and after every stop.
 *   - `ssh -L local:~/x` does **not** expand the tilde: the forward binds, and
 *     every connection through it then dies silently. Verified on `xl`. So a
 *     `~` in the remote socket path is expanded by asking the remote `$HOME`.
 *   - `~/.local/bin` is not on the non-interactive SSH PATH on `xl`, hence the
 *     absolute remote binary path from settings.
 *
 * Everything with a side effect (spawn, socket probe, unlink, timers) is
 * injectable, so the unit tests never invoke `ssh`.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { connect } from 'node:net';
import type { HerdrSettings } from '../settings';

import { clearTimer, setTimer } from '../timers';

/** macOS caps `sun_path` around 104 bytes; stay clear of it. */
export const MAX_LOCAL_SOCKET_PATH = 100;

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_INTERVAL_MS = 150;
const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 2000;
/** Keep only the tail of ssh's stderr; it is for the settings status line. */
const MAX_STDERR_CHARS = 2000;

/** Lifecycle of the forward, shown in settings and the list header. */
export type TunnelState =
	| 'idle'
	| 'starting'
	| 'connected'
	| 'reconnecting'
	| 'stopped'
	| 'failed';

export interface TunnelStatus {
	state: TunnelState;
	host: string;
	remoteSocketPath: string;
	localSocketPath: string;
	/** Last failure reason, kept while reconnecting. Null when healthy. */
	error: string | null;
	/** Spawn attempts since the last successful connect. */
	attempts: number;
}

/** The part of a `ChildProcess` this module uses. Keeps the tests spawn-free. */
export interface TunnelChild {
	readonly pid?: number | undefined;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	on(event: 'error', listener: (error: Error) => void): void;
	readonly stderr?: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
}

export type SpawnTunnel = (
	file: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv },
) => TunnelChild;

/** Resolves true when something is listening on the local socket. */
export type ProbeSocket = (path: string, timeoutMs: number) => Promise<boolean>;

/** Removes the local socket file. Must not throw when it is absent. */
export type RemoveFile = (path: string) => Promise<void>;

/** Runs a command and resolves with its stdout, trimmed. Empty on failure. */
export type RunCommand = (file: string, args: string[]) => Promise<string>;

export interface SshTunnelDeps {
	spawn: SpawnTunnel;
	probe: ProbeSocket;
	removeFile: RemoveFile;
	run: RunCommand;
}

export interface SshTunnelOptions {
	/** SSH destination: `user@host` or an alias from `~/.ssh/config`. */
	host: string;
	/** Socket of the herdr server on the remote host. A leading `~` is expanded. */
	remoteSocketPath: string;
	/** Override for the derived `/tmp/herdr-<hash>.sock`. */
	localSocketPath?: string;
	/** `ssh` executable. Defaults to whatever is on PATH. */
	sshBinary?: string;
	/** Extra `ssh` arguments inserted before `-L`, e.g. `['-p', '2222']`. */
	sshArgs?: string[];
	/** How long to wait for the forwarded socket to accept a connection. */
	connectTimeoutMs?: number;
	probeIntervalMs?: number;
	probeTimeoutMs?: number;
	/** First reconnect delay after an unexpected exit; doubles up to the max. */
	backoffMs?: number;
	maxBackoffMs?: number;
	/** How long SIGTERM is given before SIGKILL. */
	killGraceMs?: number;
	/** Reconnect after the ssh child exits on its own. Default true. */
	reconnect?: boolean;
	env?: NodeJS.ProcessEnv;
	/** Called on every state change, and on every reconnect attempt. */
	onStatus?: (status: TunnelStatus) => void;
	deps?: Partial<SshTunnelDeps>;
}

/**
 * Short, collision-free local socket path for one (host, remote socket) pair.
 * The hash keeps two profiles apart while staying far under the length cap.
 */
export function localSocketPathFor(host: string, remoteSocketPath: string, dir = '/tmp'): string {
	const digest = createHash('sha256')
		.update(`${host}\0${remoteSocketPath}`)
		.digest('hex')
		.slice(0, 8);
	return `${dir.replace(/\/+$/, '')}/herdr-${digest}.sock`;
}

/** Default probe: open a connection, then drop it. Nothing is written. */
export const defaultProbe: ProbeSocket = (path, timeoutMs) =>
	new Promise<boolean>((resolve) => {
		let settled = false;
		const done = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(ok);
		};
		const socket = connect(path);
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => {
			done(true);
		});
		socket.once('timeout', () => {
			done(false);
		});
		socket.once('error', () => {
			done(false);
		});
	});

export function defaultDeps(): SshTunnelDeps {
	return {
		spawn: (file, args, options) =>
			spawn(file, args, { env: options.env, stdio: ['ignore', 'ignore', 'pipe'] }),
		probe: defaultProbe,
		removeFile: async (path) => {
			await rm(path, { force: true });
		},
		run: (file, args) =>
			new Promise<string>((resolve) => {
				const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] });
				let out = '';
				child.stdout?.on('data', (chunk: unknown) => {
					out += String(chunk);
				});
				child.on('error', () => {
					resolve('');
				});
				child.on('close', () => {
					resolve(out.trim());
				});
			}),
	};
}

/**
 * Builds the `ssh` argv for the forward. `-N` runs no remote command,
 * `BatchMode=yes` fails instead of prompting for a password (an Obsidian
 * renderer has no terminal to prompt on), `ExitOnForwardFailure=yes` makes a
 * refused bind an exit rather than a live-but-useless connection, and the
 * keepalives make a dead link exit so the reconnect loop can act on it.
 */
export function buildTunnelArgv(options: {
	host: string;
	localSocketPath: string;
	remoteSocketPath: string;
	sshArgs?: string[];
}): string[] {
	return [
		'-N',
		'-o',
		'BatchMode=yes',
		'-o',
		'ExitOnForwardFailure=yes',
		'-o',
		'ServerAliveInterval=15',
		'-o',
		'ServerAliveCountMax=3',
		...(options.sshArgs ?? []),
		'-L',
		`${options.localSocketPath}:${options.remoteSocketPath}`,
		options.host,
	];
}

/**
 * Owns one `ssh -N -L` child and the local socket file it binds.
 *
 * `start()` resolves with the local socket path once the forward accepts a
 * connection; hand that to `HerdrClient` in place of the discovered socket.
 * After a successful start, an unexpected exit reconnects with backoff.
 * `stop()` is idempotent and always leaves no child and no socket file behind.
 */
export class SshTunnel {
	private readonly options: SshTunnelOptions;
	private readonly deps: SshTunnelDeps;
	private readonly localPath: string;

	private child: TunnelChild | null = null;
	private state: TunnelState = 'idle';
	private error: string | null = null;
	private attempts = 0;
	private stderrTail = '';
	private retryTimer: ReturnType<typeof setTimer> | null = null;
	private currentBackoff: number;
	private stopped = false;
	/**
	 * Bumped by every `start()` and `stop()`. An attempt records the value it
	 * was born with and gives up, cleaning up after itself, whenever the two
	 * differ after an await: a `stop()` that lands mid-startup must not leave a
	 * child that was spawned after it returned (issue #59).
	 */
	private generation = 0;
	/** True once the forward has come up; makes later attempts "reconnecting". */
	private everConnected = false;
	/** Set once the remote `~` has been expanded; avoids a second ssh call. */
	private resolvedRemotePath: string | null = null;
	/** Remote `$HOME`, learned while expanding a `~` socket path (issue #22). */
	private resolvedHome = '';

	constructor(options: SshTunnelOptions) {
		this.options = options;
		this.deps = { ...defaultDeps(), ...options.deps };
		this.localPath =
			options.localSocketPath ?? localSocketPathFor(options.host, options.remoteSocketPath);
		this.currentBackoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
		if (this.localPath.length > MAX_LOCAL_SOCKET_PATH) {
			throw new Error(
				`local socket path is ${this.localPath.length} characters, over the ${MAX_LOCAL_SOCKET_PATH} character limit: ${this.localPath}`,
			);
		}
	}

	/** Local end of the forward. Valid before `start()`, it is derived, not discovered. */
	get localSocketPath(): string {
		return this.localPath;
	}

	get status(): TunnelStatus {
		return {
			state: this.state,
			host: this.options.host,
			remoteSocketPath: this.resolvedRemotePath ?? this.options.remoteSocketPath,
			localSocketPath: this.localPath,
			error: this.error,
			attempts: this.attempts,
		};
	}

	/**
	 * The remote user's home directory, or empty when it was never needed — a
	 * configured socket path that is already absolute costs no round trip, so
	 * there is nothing to reuse and callers keep showing absolute paths
	 * (issue #22). Never resolved on its own account: one ssh call per tunnel.
	 */
	get remoteHome(): string {
		return this.resolvedHome;
	}

	/** One line for the settings status block and the list header. */
	get statusText(): string {
		const { state, host, localSocketPath, error } = this.status;
		switch (state) {
			case 'idle':
				return `SSH tunnel: not started (${host})`;
			case 'starting':
				return `SSH tunnel: connecting to ${host}…`;
			case 'connected':
				return `SSH tunnel: connected to ${host} via ${localSocketPath}`;
			case 'reconnecting':
				return `SSH tunnel: reconnecting to ${host}${error ? ` after ${error}` : ''}`;
			case 'stopped':
				return `SSH tunnel: stopped (${host})`;
			case 'failed':
				return `SSH tunnel: failed for ${host}${error ? ` — ${error}` : ''}`;
		}
	}

	/**
	 * Spawns the forward and waits for the local socket to accept a connection.
	 *
	 * @returns the local socket path, to be used as the client's socket.
	 * @throws when the first attempt fails; the tunnel is then fully cleaned up
	 *   and no background retry is running, so the caller decides what to show.
	 */
	async start(): Promise<string> {
		if (this.state === 'connected' && this.child) return this.localPath;
		this.stopped = false;
		this.error = null;
		const generation = ++this.generation;
		const remotePath = await this.remotePath();
		this.throwIfAborted(generation);
		await this.attempt(remotePath, generation);
		return this.localPath;
	}

	/** SIGTERM, then SIGKILL after the grace period, then remove the socket file. */
	async stop(): Promise<void> {
		this.stopped = true;
		this.generation += 1;
		this.clearRetry();
		const child = this.child;
		this.child = null;
		if (child) await killChild(child, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
		await this.removeLocalSocket();
		this.setState('stopped');
	}

	/** True once a later `start()` or `stop()` has superseded this attempt. */
	private aborted(generation: number): boolean {
		return this.stopped || generation !== this.generation;
	}

	private throwIfAborted(generation: number): void {
		if (this.aborted(generation)) throw new Error('tunnel was stopped while connecting');
	}

	private async attempt(remotePath: string, generation: number): Promise<void> {
		this.attempts += 1;
		this.setState(this.everConnected ? 'reconnecting' : 'starting');
		await this.removeLocalSocket();
		this.throwIfAborted(generation);

		const argv = buildTunnelArgv({
			host: this.options.host,
			localSocketPath: this.localPath,
			remoteSocketPath: remotePath,
			sshArgs: this.options.sshArgs,
		});
		let child: TunnelChild;
		try {
			child = this.deps.spawn(this.options.sshBinary ?? 'ssh', argv, { env: this.options.env });
		} catch (cause) {
			this.error = `could not run ssh: ${(cause as Error).message}`;
			this.setState('failed');
			throw new Error(this.error);
		}
		this.child = child;
		this.stderrTail = '';
		child.stderr?.on('data', (chunk: unknown) => {
			this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-MAX_STDERR_CHARS);
		});

		// A holder, not a plain `let`: the value is written from a callback and
		// read in the loop below, which TypeScript's narrowing does not follow.
		const exit: { at: { code: number | null; signal: NodeJS.Signals | null } | null } = {
			at: null,
		};
		let connected = false;
		child.on('exit', (code, signal) => {
			exit.at = { code, signal };
			// Before the socket is up the connect loop owns the failure path;
			// afterwards this is a dropped link and the backoff loop takes over.
			if (connected && this.child === child) this.onChildExit(child);
		});
		child.on('error', (error) => {
			this.stderrTail = `${this.stderrTail}${error.message}`.slice(-MAX_STDERR_CHARS);
		});

		const deadline =
			Date.now() + (this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
		const interval = this.options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
		const probeTimeout = this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
		for (;;) {
			if (this.aborted(generation)) break;
			const listening = await this.deps.probe(this.localPath, probeTimeout);
			if (this.aborted(generation)) break;
			if (listening) {
				connected = true;
				this.everConnected = true;
				this.attempts = 0;
				this.error = null;
				this.currentBackoff = this.options.backoffMs ?? DEFAULT_BACKOFF_MS;
				this.setState('connected');
				return;
			}
			if (exit.at !== null) break;
			if (Date.now() >= deadline) break;
			await delay(interval);
		}

		// Superseded by a `stop()` or a newer `start()` while the socket was
		// coming up: `stop()` may already have killed the child (then `exit.at`
		// is set) or may have run before `this.child` was assigned, in which
		// case this attempt is the only owner and must reap it. Either way the
		// state belongs to whoever superseded us, so it is left alone.
		if (this.aborted(generation)) {
			if (this.child === child) this.child = null;
			if (exit.at === null) {
				await killChild(child, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
			}
			await this.removeLocalSocket();
			throw new Error('tunnel was stopped while connecting');
		}

		// Failed to come up: own the cleanup so no half-open ssh is left behind.
		// The reason is taken *before* the kill, or our own SIGTERM would
		// overwrite whatever ssh actually complained about.
		this.child = null;
		this.error = this.failureReason(exit.at);
		if (exit.at === null) {
			await killChild(child, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
		}
		await this.removeLocalSocket();
		if (this.aborted(generation)) throw new Error('tunnel was stopped while connecting');
		this.setState('failed');
		throw new Error(`ssh tunnel to ${this.options.host} failed: ${this.error}`);
	}

	private failureReason(
		exited: { code: number | null; signal: NodeJS.Signals | null } | null,
	): string {
		const stderr = this.stderrTail.trim().split('\n').filter(Boolean).slice(-3).join('; ');
		if (stderr) return stderr;
		if (exited) {
			return exited.signal
				? `ssh was killed by ${exited.signal}`
				: `ssh exited with code ${String(exited.code)}`;
		}
		return 'the forwarded socket never accepted a connection';
	}

	/** Unexpected exit of a connected tunnel: schedule a backoff reconnect. */
	private onChildExit(child: TunnelChild): void {
		if (this.child !== child) return;
		this.child = null;
		if (this.stopped || this.options.reconnect === false) return;
		this.error = this.failureReason(null) || 'the ssh connection dropped';
		this.setState('reconnecting');
		const wait = this.currentBackoff;
		this.currentBackoff = Math.min(
			this.currentBackoff * 2,
			this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
		);
		this.retryTimer = setTimer(() => {
			this.retryTimer = null;
			void this.reconnect();
		}, wait);
	}

	private async reconnect(): Promise<void> {
		if (this.stopped) return;
		const generation = this.generation;
		try {
			const remotePath = await this.remotePath();
			this.throwIfAborted(generation);
			await this.attempt(remotePath, generation);
		} catch {
			// `attempt` already recorded the reason and set the state; the exit
			// handler is not involved here, so re-arm the timer ourselves.
			if (this.aborted(generation) || this.options.reconnect === false) return;
			const wait = this.currentBackoff;
			this.currentBackoff = Math.min(
				this.currentBackoff * 2,
				this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
			);
			this.setState('reconnecting');
			this.retryTimer = setTimer(() => {
				this.retryTimer = null;
				void this.reconnect();
			}, wait);
		}
	}

	/**
	 * `ssh -L local:~/x` binds but never connects, so a tilde is expanded by
	 * asking the remote `$HOME` once. Absolute paths cost no round trip.
	 */
	private async remotePath(): Promise<string> {
		if (this.resolvedRemotePath) return this.resolvedRemotePath;
		const configured = this.options.remoteSocketPath.trim();
		if (!configured.startsWith('~')) {
			this.resolvedRemotePath = configured;
			return configured;
		}
		const home = await this.deps.run(this.options.sshBinary ?? 'ssh', [
			'-o',
			'BatchMode=yes',
			this.options.host,
			'printf %s "$HOME"',
		]);
		const trimmedHome = home.replace(/\/+$/, '');
		if (trimmedHome.length > 0) this.resolvedHome = trimmedHome;
		const resolved = trimmedHome.length > 0 ? `${trimmedHome}${configured.slice(1)}` : configured;
		this.resolvedRemotePath = resolved;
		return resolved;
	}

	private clearRetry(): void {
		if (this.retryTimer !== null) {
			clearTimer(this.retryTimer);
			this.retryTimer = null;
		}
	}

	private async removeLocalSocket(): Promise<void> {
		try {
			await this.deps.removeFile(this.localPath);
		} catch {
			// A socket we cannot remove shows up as a bind failure below, with a
			// better message than anything we could raise here.
		}
	}

	private setState(state: TunnelState): void {
		this.state = state;
		this.options.onStatus?.(this.status);
	}
}

async function killChild(child: TunnelChild, killGraceMs: number): Promise<void> {
	let exited = false;
	const done = new Promise<void>((resolve) => {
		child.on('exit', () => {
			exited = true;
			resolve();
		});
	});
	try {
		child.kill('SIGTERM');
	} catch {
		return;
	}
	await Promise.race([done, delay(killGraceMs)]);
	if (exited) return;
	try {
		child.kill('SIGKILL');
	} catch {
		// Already gone.
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimer(resolve, ms));
}

/**
 * Argv prefix for the terminal bridge (PRD S17). The API socket forward is no
 * help here: the bridge speaks to herdr's separate client socket, so the CLI
 * must run on the machine the panes live on.
 *
 * `-T` disables PTY allocation — the bridge is NDJSON over pipes, not a PTY.
 */
export function terminalArgvPrefix(
	settings: Pick<HerdrSettings, 'remote'>,
	localHerdrPath: string,
): string[] {
	const remote = settings.remote;
	if (remote.enabled) {
		const host = remote.host.trim();
		const binary = remote.remoteBinary.trim();
		if (host.length === 0) throw new Error('the remote profile has no SSH host');
		if (binary.length === 0) throw new Error('the remote profile has no remote herdr binary');
		return ['ssh', '-T', host, binary];
	}
	if (localHerdrPath.trim().length === 0) throw new Error('the herdr binary path is empty');
	return [localHerdrPath];
}

