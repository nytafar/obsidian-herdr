/**
 * herdr binary discovery and server probe (PRD M1, M2).
 *
 * Obsidian launched from the Dock does not inherit the login PATH, so the
 * search order is: settings override, `/opt/homebrew/bin`, `/usr/local/bin`,
 * `~/.local/bin`, then a PATH obtained by asking the user's login shell. That
 * order says where herdr tends to live, not which copy belongs to the running
 * server, so `discoverHerdr` reorders it when a later candidate speaks the
 * server's protocol and the first does not (issue #87).
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
import { executableName, expandHome, joinPathList, localPathStyle, pathListDelimiter, splitPathList } from '../platform';
import { joinHostPath } from '../platform';

/** Where herdr is looked for, in order, after the settings override. */
export const BINARY_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin', '~/.local/bin'] as const;
const WINDOWS_BINARY_DIRECTORIES = ['~/AppData/Local/Programs/herdr/bin', '~/AppData/Local/Microsoft/WinGet/Links'] as const;

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_SHELL_TIMEOUT_MS = 5000;
const DEFAULT_SOCKET_PATH = '~/.config/herdr/herdr.sock';

/** Expands a leading `~`. Duplicated from client.ts to keep the modules apart. */
export { expandHome };

/** How the binary was found; shown in settings so a wrong pick is obvious. */
export type BinarySource = 'setting' | 'directory' | 'extra-path' | 'path' | 'login-shell';

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
	platform: NodeJS.Platform;
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
		platform: process.platform,
	};
}

export interface ResolveOptions {
	/** Settings override. Empty or whitespace means auto-discovery. */
	override?: string;
	/** Path-delimiter-separated extra directories from settings, searched before PATH. */
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
	if (deps.platform === 'win32') return null;
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
 * Every herdr in the fixed directories and the settings extras, in search
 * order and deduplicated. Filesystem probes only; it never spawns anything.
 */
export function localCandidates(
	options: ResolveOptions = {},
	deps: DiscoveryDeps = defaultDeps(),
): ResolvedBinary[] {
	const found: ResolvedBinary[] = [];
	const seen = new Set<string>();
	const binaryName = executableName('herdr', deps.platform);
	const add = (directory: string, source: BinarySource): void => {
		const style = localPathStyle(deps.platform);
		const path = joinHostPath(
			style,
			expandHome(directory, { home: deps.home, style }),
			binaryName,
		);
		if (seen.has(path) || !deps.isExecutable(path)) return;
		seen.add(path);
		found.push({ path, source });
	};
	const fixed = deps.platform === 'win32' ? WINDOWS_BINARY_DIRECTORIES : BINARY_DIRECTORIES;
	for (const directory of fixed) add(directory, 'directory');
	for (const directory of splitPath(options.extraPath ?? '', deps.platform)) add(directory, 'extra-path');
	for (const directory of splitPath(deps.env.PATH ?? '', deps.platform)) add(directory, 'path');
	return found;
}

/** Every herdr on the login shell's PATH, in order. Spawns a shell. */
export async function loginShellCandidates(
	options: ResolveOptions = {},
	deps: DiscoveryDeps = defaultDeps(),
): Promise<ResolvedBinary[]> {
	if (options.skipLoginShell) return [];
	const shellPath = await loginShellPath(deps, options.loginShellTimeoutMs);
	const found: ResolvedBinary[] = [];
	const seen = new Set<string>();
	const binaryName = executableName('herdr', deps.platform);
	const style = localPathStyle(deps.platform);
	for (const directory of splitPath(shellPath ?? '', deps.platform)) {
		const path = joinHostPath(
			style,
			expandHome(directory, { home: deps.home, style }),
			binaryName,
		);
		if (seen.has(path) || !deps.isExecutable(path)) continue;
		seen.add(path);
		found.push({ path, source: 'login-shell' });
	}
	return found;
}

/**
 * The settings override, which wins unconditionally. An override that is not
 * executable is still what the user asked for, so this reports a null binary
 * rather than letting the search continue; settings then says "this path is
 * not executable".
 */
function overrideBinary(
	options: ResolveOptions,
	deps: DiscoveryDeps,
): { binary: ResolvedBinary | null } | null {
	const override = options.override?.trim();
	if (!override) return null;
	const path = expandHome(override, { home: deps.home, style: localPathStyle(deps.platform) });
	return { binary: deps.isExecutable(path) ? { path, source: 'setting' } : null };
}

/**
 * Finds the herdr binary (PRD M2).
 *
 * The first candidate wins here, and the login shell is only asked when the
 * cheap directories come up empty. Only {@link discoverHerdr} looks past the
 * first candidate, because only it knows what the running server speaks.
 *
 * @returns null when nothing was found; the caller shows the settings error
 *   and the `Notice`.
 */
export async function resolveHerdrBinary(
	options: ResolveOptions = {},
	deps: DiscoveryDeps = defaultDeps(),
): Promise<ResolvedBinary | null> {
	const override = overrideBinary(options, deps);
	if (override) return override.binary;

	const local = localCandidates(options, deps);
	if (local.length > 0) return local[0] ?? null;
	return (await loginShellCandidates(options, deps))[0] ?? null;
}

function splitPath(value: string, platform: NodeJS.Platform): string[] {
	return splitPathList(value, pathListDelimiter(platform));
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
	const delimiter = pathListDelimiter(deps.platform);
	const push = (dir: string): void => {
		const expanded = expandHome(dir, { home: deps.home, style: localPathStyle(deps.platform) });
		if (expanded.length > 0 && !parts.includes(expanded)) parts.push(expanded);
	};
	const fixed = deps.platform === 'win32' ? WINDOWS_BINARY_DIRECTORIES : BINARY_DIRECTORIES;
	for (const dir of splitPath(options.extraPath ?? '', deps.platform)) push(dir);
	for (const dir of fixed) push(dir);
	for (const dir of splitPath(deps.env.PATH ?? '', deps.platform)) push(dir);
	if (!options.skipLoginShell) {
		const shellPath = await loginShellPath(deps, options.loginShellTimeoutMs);
		for (const dir of splitPath(shellPath ?? '', deps.platform)) push(dir);
	}
	return joinPathList(parts, delimiter);
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

/** What a candidate binary says about itself, as opposed to about the server. */
export interface BinaryIdentity {
	version: string | null;
	protocol: number | null;
}

/** Pulls a semantic version out of `herdr --version` ("herdr 0.8.2"). */
export function parseVersionOutput(text: string): string | null {
	const match = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(text);
	return match ? match[0] : null;
}

/**
 * Asks a candidate binary what it is (issue #87). `status client --json`
 * reports the CLI's own version and protocol; `--version` is the fallback for
 * a build that does not know that subcommand, and yields no protocol.
 *
 * Never throws: an unknown binary is simply an unknown identity.
 */
export async function probeBinary(
	binary: string,
	deps: DiscoveryDeps = defaultDeps(),
	timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<BinaryIdentity> {
	try {
		const result = await deps.run(binary, ['status', 'client', '--json'], {
			timeoutMs,
			env: deps.env,
		});
		const stdout = result.stdout.trim();
		if (stdout.startsWith('{')) {
			const parsed: unknown = JSON.parse(stdout);
			if (typeof parsed === 'object' && parsed !== null) {
				const fields = parsed as Record<string, unknown>;
				const version = typeof fields.version === 'string' ? fields.version : null;
				const protocol = typeof fields.protocol === 'number' ? fields.protocol : null;
				if (version !== null || protocol !== null) return { version, protocol };
			}
		}
	} catch {
		// fall through to `--version`
	}
	try {
		const result = await deps.run(binary, ['--version'], { timeoutMs, env: deps.env });
		return { version: parseVersionOutput(result.stdout), protocol: null };
	} catch {
		return { version: null, protocol: null };
	}
}

/** True when the server reports something a candidate can be compared against. */
function serverIsComparable(status: ServerStatus | null): boolean {
	return Boolean(status && (status.protocol !== null || status.version !== null));
}

/**
 * Whether a candidate binary speaks what the server speaks. Protocol first,
 * version as the fallback for a binary that only answered `--version`. An
 * identity we could not read counts as not matching, so a candidate that
 * demonstrably matches is preferred over one that stays silent.
 */
export function binaryMatchesServer(
	identity: BinaryIdentity,
	status: ServerStatus | null,
): boolean {
	if (!status) return false;
	if (status.protocol !== null && identity.protocol !== null)
		return identity.protocol === status.protocol;
	if (status.version !== null && identity.version !== null)
		return identity.version === status.version;
	return false;
}

/**
 * Socket path to connect to, in the order PRD M1 asks for: settings override,
 * then what the server reports, then `HERDR_SOCKET_PATH`, then the default.
 * `HERDR_SESSION` names a per-session socket and wins over `HERDR_SOCKET_PATH`,
 * matching herdr's own resolution in `src/session.rs`.
 */
export function resolveSocketPath(
	options: { override?: string; status?: ServerStatus | null },
	deps: Pick<DiscoveryDeps, 'env' | 'home'> & { platform?: NodeJS.Platform } = {
		env: process.env,
		home: homedir(),
		platform: process.platform,
	},
): string {
	const platform = deps.platform ?? process.platform;
	const style = localPathStyle(platform);
	const override = options.override?.trim();
	if (override) return expandHome(override, { home: deps.home, style });
	const reported = options.status?.socket?.trim();
	if (reported) return expandHome(reported, { home: deps.home, style });
	const session = deps.env.HERDR_SESSION?.trim();
	if (session && platform !== 'win32') return `${deps.home}/.config/herdr/sessions/${session}/herdr.sock`;
	const fromEnv = deps.env.HERDR_SOCKET_PATH?.trim();
	if (fromEnv) return expandHome(fromEnv, { home: deps.home, style });
	return expandHome(DEFAULT_SOCKET_PATH, { home: deps.home, style });
}

export interface DiscoveryResult {
	binary: ResolvedBinary | null;
	status: ServerStatus | null;
	/** The chosen binary's own version and protocol, when it could be asked. */
	identity: BinaryIdentity | null;
	socketPath: string;
	/** Human-readable reason the binary or the probe failed. */
	error: string | null;
}

/**
 * One call for the plugin's load path and the settings tab: find the binary,
 * probe the server, decide the socket path. Never throws.
 *
 * Discovery happens before the client connects, so the protocol compared
 * against is the one `herdr status server` reports rather than the one `ping`
 * will: the same daemon, and known early enough to choose a binary with. A
 * stale CLI still reports the running server correctly (verified against 0.8.0
 * talking to a 0.8.2 server), which is what makes one probe enough to judge
 * every candidate.
 */
export async function discoverHerdr(
	options: ResolveOptions & { socketOverride?: string } = {},
	deps: DiscoveryDeps = defaultDeps(),
): Promise<DiscoveryResult> {
	const override = overrideBinary(options, deps);
	const local = override ? [] : localCandidates(options, deps);
	let candidates = override?.binary ? [override.binary] : local;
	// The login shell is the only way to see a PATH install; ask it now only
	// when the cheap directories found nothing at all.
	if (candidates.length === 0 && !override)
		candidates = await loginShellCandidates(options, deps);
	const first = candidates[0];
	if (!first) {
		return {
			binary: null,
			status: null,
			identity: null,
			socketPath: resolveSocketPath({ override: options.socketOverride }, deps),
			error: options.override?.trim()
				? `herdr is not executable at ${options.override.trim()}`
				: 'herdr was not found in configured paths, known install directories or PATH',
		};
	}

	let binary: ResolvedBinary = first;
	let probe = await probeServer(binary.path, deps);
	let identity = await probeBinary(binary.path, deps);

	// The search order is about where herdr tends to live, not about which copy
	// belongs to the running server. When the first candidate speaks a different
	// protocol, a later one that matches wins (issue #87); the settings override
	// is exempt, and so is the case where the server told us nothing to compare.
	const shouldLookFurther =
		!override && serverIsComparable(probe.status) && !binaryMatchesServer(identity, probe.status);
	if (shouldLookFurther) {
		const seen = new Set(candidates.map((candidate) => candidate.path));
		const pool = candidates.slice(1);
		// Widen to the login shell's PATH, where a package-manager install in a
		// directory the fixed list does not cover shows up.
		if (candidates === local) {
			for (const candidate of await loginShellCandidates(options, deps))
				if (!seen.has(candidate.path)) pool.push(candidate);
		}
		for (const candidate of pool) {
			const candidateIdentity = await probeBinary(candidate.path, deps);
			if (!binaryMatchesServer(candidateIdentity, probe.status)) continue;
			binary = candidate;
			identity = candidateIdentity;
			// Re-probe through the binary we will actually spawn: `compatible`
			// and `restart_needed` are the CLI's view, not the server's.
			const reprobe = await probeServer(binary.path, deps);
			if (reprobe.status) probe = reprobe;
			break;
		}
	}

	return {
		binary,
		status: probe.status,
		identity,
		socketPath: resolveSocketPath({ override: options.socketOverride, status: probe.status }, deps),
		error: probe.error,
	};
}
