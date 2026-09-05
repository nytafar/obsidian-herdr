/**
 * herdr binary discovery and server probe (PRD M1, M2).
 *
 * Obsidian launched from the Dock does not inherit the login PATH, so the
 * search order is: settings override, `/opt/homebrew/bin`, `/usr/local/bin`,
 * `~/.local/bin`, then a PATH obtained by asking the user's login shell.
 *
 * The probe is `herdr status server --json`, which reports version, protocol
 * and the API socket path in one call. Note that the socket it reports is the
 * *JSON API* socket; the terminal bridge talks to herdr through a child
 * process, not through this socket, and herdr keeps a separate client socket
 * for that. Nothing here should be handed to the bridge as a socket path.
 *
 * Every side effect (fs probe, process spawn) is injectable so the unit tests
 * never touch the real filesystem or spawn anything.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where herdr is looked for, in order, after the settings override. */
export const BINARY_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin', '~/.local/bin'] as const;

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_SHELL_TIMEOUT_MS = 5000;
const DEFAULT_SOCKET_PATH = '~/.config/herdr/herdr.sock';

/** Expands a leading `~`. Duplicated from client.ts to keep the modules apart. */
export function expandHome(path: string, home: string = homedir()): string {
	if (path === '~') return home;
	if (path.startsWith('~/')) return `${home}/${path.slice(2)}`;
	return path;
}

/** How the binary was found; shown in settings so a wrong pick is obvious. */
export type BinarySource = 'setting' | 'directory' | 'extra-path' | 'login-shell';

export interface ResolvedBinary {
	path: string;
	source: BinarySource;
}

export interface RunResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

/** Runs a command and resolves even on a non-zero exit. */
export type Runner = (
	file: string,
	args: string[],
	options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<RunResult>;

export interface DiscoveryDeps {
	/** True when the path exists and is executable by this process. */
	isExecutable: (path: string) => boolean;
	run: Runner;
	env: NodeJS.ProcessEnv;
	home: string;
}

export const defaultRunner: Runner = (file, args, options) =>
	new Promise<RunResult>((resolve) => {
		execFile(
			file,
			args,
			{ timeout: options.timeoutMs, env: options.env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
						? ((error as unknown as { code: number }).code ?? 1)
						: error
							? 1
							: 0;
				resolve({ stdout: String(stdout), stderr: String(stderr), code });
			},
		);
	});

export function defaultDeps(): DiscoveryDeps {
	return {
		isExecutable: (path: string) => {
			try {
				accessSync(path, constants.X_OK);
				return true;
			} catch {
				return false;
			}
		},
		run: defaultRunner,
		env: process.env,
		home: homedir(),
	};
}

export interface ResolveOptions {
	/** Settings override. Empty or whitespace means auto-discovery. */
	override?: string;
	/** Colon-separated extra directories from settings, searched before PATH. */
	extraPath?: string;
	/** Skip the login-shell step (it spawns a shell and can be slow). */
	skipLoginShell?: boolean;
	loginShellTimeoutMs?: number;
}

/**
 * Asks the user's login shell for its PATH. Dock-launched Obsidian has a
 * minimal PATH, so this is the only way to see a user's own installs.
 *
 * Failures are silent: the caller falls back to what it already had.
 */
export async function loginShellPath(
	deps: DiscoveryDeps,
	timeoutMs = DEFAULT_SHELL_TIMEOUT_MS,
): Promise<string | null> {
	const shell = deps.env.SHELL;
	if (!shell) return null;
	try {
		// `-l` for the login profile, `-i` because zsh users put PATH in .zshrc.
		// `printf` avoids a trailing newline surprise from `echo`.
		const result = await deps.run(shell, ['-lic', 'printf %s "$PATH"'], { timeoutMs });
		const path = result.stdout.trim();
		return path.length > 0 ? path : null;
	} catch {
		return null;
	}
}

/**
 * Finds the herdr binary (PRD M2).
 *
 * @returns null when nothing was found; the caller shows the settings error
 *   and the `Notice`.
 */
export async function resolveHerdrBinary(
	options: ResolveOptions = {},
	deps: DiscoveryDeps = defaultDeps(),
): Promise<ResolvedBinary | null> {
	const override = options.override?.trim();
	if (override) {
		const path = expandHome(override, deps.home);
		// An override that does not work is still what the user asked for; report
		// it back so settings can say "this path is not executable".
		return deps.isExecutable(path) ? { path, source: 'setting' } : null;
	}

	for (const directory of BINARY_DIRECTORIES) {
		const path = join(expandHome(directory, deps.home), 'herdr');
		if (deps.isExecutable(path)) return { path, source: 'directory' };
	}

	for (const directory of splitPath(options.extraPath ?? '')) {
		const path = join(expandHome(directory, deps.home), 'herdr');
		if (deps.isExecutable(path)) return { path, source: 'extra-path' };
	}

	if (options.skipLoginShell) return null;
	const shellPath = await loginShellPath(deps, options.loginShellTimeoutMs);
	for (const directory of splitPath(shellPath ?? '')) {
		const path = join(expandHome(directory, deps.home), 'herdr');
		if (deps.isExecutable(path)) return { path, source: 'login-shell' };
	}
	return null;
}

function splitPath(value: string): string[] {
	return value
		.split(':')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/**
 * A PATH for spawning herdr (and `ssh`) from Obsidian: the discovered
 * directories, the settings extras, and whatever the login shell reports.
 */
export async function buildSpawnPath(
	options: ResolveOptions = {},
	deps: DiscoveryDeps = defaultDeps(),
): Promise<string> {
	const parts: string[] = [];
	const push = (dir: string): void => {
		const expanded = expandHome(dir, deps.home);
		if (expanded.length > 0 && !parts.includes(expanded)) parts.push(expanded);
	};
	for (const dir of splitPath(options.extraPath ?? '')) push(dir);
	for (const dir of BINARY_DIRECTORIES) push(dir);
	for (const dir of splitPath(deps.env.PATH ?? '')) push(dir);
	if (!options.skipLoginShell) {
		const shellPath = await loginShellPath(deps, options.loginShellTimeoutMs);
		for (const dir of splitPath(shellPath ?? '')) push(dir);
	}
	return parts.join(':');
}

/** `herdr status server --json`, tolerant of unknown and missing fields. */
export interface ServerStatus {
	running: boolean;
	status: string;
	version: string | null;
	protocol: number | null;
	/** JSON API socket. Not the terminal bridge's socket. */
	socket: string | null;
	/** herdr's own view of whether the running server matches the CLI. */
	compatible: boolean | null;
	capabilities: Record<string, unknown> | null;
	restartNeeded: boolean;
}

export interface ProbeResult {
	status: ServerStatus | null;
	/** Empty when the probe succeeded. */
	error: string | null;
	/** Raw stdout, kept for the settings tab when parsing failed. */
	raw: string;
}

function toStatus(parsed: Record<string, unknown>): ServerStatus {
	const capabilities = parsed.capabilities;
	return {
		running: parsed.running === true || parsed.status === 'running',
		status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
		version: typeof parsed.version === 'string' ? parsed.version : null,
		protocol: typeof parsed.protocol === 'number' ? parsed.protocol : null,
		socket: typeof parsed.socket === 'string' ? parsed.socket : null,
		compatible: typeof parsed.compatible === 'boolean' ? parsed.compatible : null,
		capabilities:
			typeof capabilities === 'object' && capabilities !== null && !Array.isArray(capabilities)
				? (capabilities as Record<string, unknown>)
				: null,
		restartNeeded: parsed.restart_needed === true,
	};
}

/** Parses the `key: value` lines of `herdr status server` without `--json`. */
export function parsePlainStatus(text: string): ServerStatus | null {
	const fields = new Map<string, string>();
	for (const line of text.split('\n')) {
		const separator = line.indexOf(':');
		if (separator === -1) continue;
		fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
	}
	if (fields.size === 0) return null;
	const protocol = Number(fields.get('protocol'));
	return {
		running: fields.get('status') === 'running',
		status: fields.get('status') ?? 'unknown',
		version: fields.get('version') ?? null,
		protocol: Number.isFinite(protocol) ? protocol : null,
		socket: fields.get('socket') ?? null,
		compatible: fields.has('compatible') ? fields.get('compatible') === 'true' : null,
		capabilities: null,
		restartNeeded: false,
	};
}

/**
 * Probes the server for version, protocol and socket path (PRD M1, M3).
 * Falls back to the plain output if `--json` is not understood by an older build.
 */
export async function probeServer(
	binary: string,
	deps: DiscoveryDeps = defaultDeps(),
	timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
	let result: RunResult;
	try {
		result = await deps.run(binary, ['status', 'server', '--json'], { timeoutMs, env: deps.env });
	} catch (error) {
		return { status: null, error: (error as Error).message, raw: '' };
	}
	const stdout = result.stdout.trim();
	if (stdout.startsWith('{')) {
		try {
			const parsed: unknown = JSON.parse(stdout);
			if (typeof parsed === 'object' && parsed !== null) {
				return { status: toStatus(parsed as Record<string, unknown>), error: null, raw: stdout };
			}
		} catch {
			// fall through to the plain parser
		}
	}
	const plain = parsePlainStatus(stdout);
	if (plain) return { status: plain, error: null, raw: stdout };
	const stderr = result.stderr.trim();
	return {
		status: null,
		error: stderr.length > 0 ? stderr : `herdr status server exited with ${result.code}`,
		raw: stdout,
	};
}

/**
 * Socket path to connect to, in the order PRD M1 asks for: settings override,
 * then what the server reports, then `HERDR_SOCKET_PATH`, then the default.
 * `HERDR_SESSION` names a per-session socket and wins over `HERDR_SOCKET_PATH`,
 * matching herdr's own resolution in `src/session.rs`.
 */
export function resolveSocketPath(
	options: { override?: string; status?: ServerStatus | null },
	deps: Pick<DiscoveryDeps, 'env' | 'home'> = { env: process.env, home: homedir() },
): string {
	const override = options.override?.trim();
	if (override) return expandHome(override, deps.home);
	const reported = options.status?.socket?.trim();
	if (reported) return expandHome(reported, deps.home);
	const session = deps.env.HERDR_SESSION?.trim();
	if (session) return `${deps.home}/.config/herdr/sessions/${session}/herdr.sock`;
	const fromEnv = deps.env.HERDR_SOCKET_PATH?.trim();
	if (fromEnv) return expandHome(fromEnv, deps.home);
	return expandHome(DEFAULT_SOCKET_PATH, deps.home);
}

export interface DiscoveryResult {
	binary: ResolvedBinary | null;
	status: ServerStatus | null;
	socketPath: string;
	/** Human-readable reason the binary or the probe failed. */
	error: string | null;
}

/**
 * One call for the plugin's load path and the settings tab: find the binary,
 * probe the server, decide the socket path. Never throws.
 */
export async function discoverHerdr(
	options: ResolveOptions & { socketOverride?: string } = {},
	deps: DiscoveryDeps = defaultDeps(),
): Promise<DiscoveryResult> {
	const binary = await resolveHerdrBinary(options, deps);
	if (!binary) {
		return {
			binary: null,
			status: null,
			socketPath: resolveSocketPath({ override: options.socketOverride }, deps),
			error: options.override?.trim()
				? `herdr is not executable at ${options.override.trim()}`
				: 'herdr was not found in /opt/homebrew/bin, /usr/local/bin, ~/.local/bin or the login shell PATH',
		};
	}
	const probe = await probeServer(binary.path, deps);
	return {
		binary,
		status: probe.status,
		socketPath: resolveSocketPath({ override: options.socketOverride, status: probe.status }, deps),
		error: probe.error,
	};
}
