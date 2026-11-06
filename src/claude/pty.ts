/**
 * A program on a real pty, with no native code (ADR-0007's recorded
 * exception to "not a PTY", the `claude` kind only): `script(1)` allocates the
 * pty, and a POSIX `sh` watchdog on an extra pipe (fd 3) makes sure `script`
 * dies with the plugin.
 *
 * - **Spawn.** `/bin/sh -c WATCHDOG oh-pty script …` over four plain pipes,
 *   in a process group of its own. `script` runs in the foreground with the
 *   plugin's stdin and stdout; the watchdog's `cat` reads fd 3, which the
 *   plugin never writes, so it sees EOF only when the plugin closes that
 *   pipe or dies, and then sends the group SIGTERM. `script` ignores stdin
 *   EOF, which is why the pipe is needed (finding `direct-claude-spike` §5).
 *   `script` is not an asynchronous list: one in a non-interactive shell
 *   starts with SIGINT and SIGQUIT ignored, and that is inherited down to
 *   the program, where Ctrl-C then does nothing (the D2 review measured
 *   `SigIgn: 0x6`).
 * - **Inside.** `script` runs one `/bin/sh` command line: the grid
 *   (`stty rows R cols C`, since a pty made from a pipe starts at 0x0), the
 *   user's `SHELL` put back (`script` itself is given `/bin/sh`, so the
 *   command line is parsed by a known shell), an optional command run first
 *   (a shell tab's initial command) while the line's shell traps SIGINT and
 *   SIGQUIT, so Ctrl-C ends the command and not the tab, then `exec` of the
 *   program.
 * - **Platforms.** Linux: util-linux `script -qfec <cmd> /dev/null`, the
 *   slave found as `/proc/<script's child>/fd/0`, resized with `stty -F`.
 *   macOS: BSD `script -q /dev/null /bin/sh -c <cmd>`, the slave from
 *   `ps -o tty=`, resized with `stty -f` — written, **not verified**, so it
 *   is off ({@link ptyPlatformOf}) until it is (ADR-0007: "on macOS once
 *   verified"); a host can still ask for it by name to verify it. No pty on
 *   Windows at all.
 * - **Resize** from outside: `stty` on the slave, which makes the kernel send
 *   the program SIGWINCH. Held back until the program has written its first
 *   byte, so the command line's own `stty` cannot undo it, and coalesced so
 *   only the latest grid is applied.
 * - **Stop**, in order: the program's own signal (SIGTERM for claude, which
 *   exits 0.8 s later; SIGHUP for a shell, which ignores SIGTERM), then the
 *   watchdog's pipe closed (`script` gives its child 2 s, then kills it),
 *   then SIGKILL to the whole group and the program.
 *
 * Everything that touches the OS is injected ({@link PtySpawn},
 * {@link PtyTools}, the timers), so `tests/claudePty.test.ts` runs the argv,
 * the resize and the whole stop order against fakes.
 */

import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import type { ClaudeTimers } from './process';

/** The two platforms with a `script(1)` the plugin can drive. */
export type PtyPlatform = 'linux' | 'darwin';

/**
 * The pty platform of this machine, or null where there is none: Windows,
 * and macOS until its path is verified (the `'darwin'` code stays, for that).
 */
export function ptyPlatformOf(platform: NodeJS.Platform): PtyPlatform | null {
	if (platform === 'win32' || platform === 'darwin') return null;
	return 'linux';
}

/**
 * The watchdog, run as `/bin/sh -c WATCHDOG oh-pty <script argv…>` as the
 * leader of its own process group (the spawn is detached):
 *
 * - `trap : TERM` lets the shell outlive the group's SIGTERM, so it exits
 *   only once `script` has, with its status; a caught signal is back to
 *   its default in every child;
 * - the subshell, the one asynchronous list, waits for EOF on fd 3 and then
 *   sends SIGTERM to the group (`-$$`, the shell's own group), `script` in it;
 * - `"$@" 3<&-` runs `script` in the foreground, without the pipe, on the
 *   real stdin and with SIGINT and SIGQUIT at their defaults;
 * - the shell then ends the subshell and exits with `script`'s status.
 */
export const WATCHDOG =
	'trap : TERM; ' +
	'(cat <&3 >/dev/null; kill -s TERM -- -$$ 2>/dev/null) </dev/null >/dev/null 2>&1 & w=$!; ' +
	'"$@" 3<&-; st=$?; kill $w 2>/dev/null; exit $st';

/** `$0` of the watchdog shell, which is how `ps` shows it. */
export const WATCHDOG_NAME = 'oh-pty';

/** A word for `/bin/sh`, single-quoted. */
export function shellQuote(word: string): string {
	return `'${word.replaceAll("'", "'\\''")}'`;
}

function clampDimension(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(9999, Math.max(1, Math.trunc(value)));
}

export interface InnerCommandOptions {
	cols: number;
	rows: number;
	/** The user's `SHELL`, put back for the program; unset when there was none. */
	shell: string | undefined;
	/** A command line run first through `/bin/sh -c` (a shell tab's initial command). */
	before?: string;
	/** The program, `argv[0]` first, which replaces the command line's shell. */
	program: readonly string[];
}

/** The one command line `script` runs. */
export function innerCommand(options: InnerCommandOptions): string {
	if (options.program.length === 0) throw new Error('a pty needs a program');
	const parts = [`stty rows ${clampDimension(options.rows)} cols ${clampDimension(options.cols)} 2>/dev/null`];
	parts.push(options.shell ? `SHELL=${shellQuote(options.shell)}; export SHELL` : 'unset SHELL');
	// The line's shell catches SIGINT and SIGQUIT while the command runs, so
	// Ctrl-C ends the command (which gets them at their defaults) and the
	// program still starts after it.
	if (options.before?.trim()) parts.push(`trap : INT QUIT; /bin/sh -c ${shellQuote(options.before)}; trap - INT QUIT`);
	parts.push(`exec ${options.program.map(shellQuote).join(' ')}`);
	return parts.join('; ');
}

/** `script`'s argv for one command line: util-linux on Linux, BSD on macOS. */
export function scriptArgv(platform: PtyPlatform, inner: string): string[] {
	return platform === 'darwin'
		? ['script', '-q', '/dev/null', '/bin/sh', '-c', inner]
		: ['script', '-qfec', inner, '/dev/null'];
}

/** The whole argv the plugin spawns: the watchdog shell around `script`. */
export function ptyArgv(platform: PtyPlatform, inner: string): string[] {
	return ['/bin/sh', '-c', WATCHDOG, WATCHDOG_NAME, ...scriptArgv(platform, inner)];
}

/** The `stty` that resizes a slave from outside: `-F` on Linux, `-f` on macOS. */
export function sttyArgv(platform: PtyPlatform, tty: string, cols: number, rows: number): string[] {
	return [
		'stty',
		platform === 'darwin' ? '-f' : '-F',
		tty,
		'rows',
		String(clampDimension(rows)),
		'cols',
		String(clampDimension(cols)),
	];
}

/**
 * The environment `script` starts with, and the user's shell to put back
 * inside. `script` runs its command line with `$SHELL -c` (util-linux), so it
 * is given `/bin/sh`; the terminal is what the plugin's renderers are
 * (`xterm-256color`, truecolour), not whatever launched Obsidian.
 */
export function ptyEnv(base: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; shell: string | undefined } {
	const env: NodeJS.ProcessEnv = { ...base };
	const shell = env.SHELL || undefined;
	env.SHELL = '/bin/sh';
	env.TERM = 'xterm-256color';
	env.COLORTERM = 'truecolor';
	delete env.TERM_PROGRAM;
	delete env.TERM_PROGRAM_VERSION;
	// A GUI launch can come without a locale, and a program then draws ASCII.
	if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'C.UTF-8';
	return { env, shell };
}

/** The slice of a `ChildProcess` a pty uses. */
export interface PtyChild {
	readonly pid?: number;
	stdin: {
		write(chunk: string | Uint8Array): boolean;
		on(event: 'error', handler: (error: Error) => void): unknown;
	} | null;
	stdout: { on(event: 'data', handler: (chunk: Buffer) => void): unknown } | null;
	stderr: { on(event: 'data', handler: (chunk: Buffer) => void): unknown } | null;
	/** The plugin's end of fd 3. Destroying it is how the watchdog is told to end `script`. */
	watchdog: { destroy(): void } | null;
	on(event: 'exit', handler: (code: number | null, signal: string | null) => void): unknown;
	on(event: 'error', handler: (error: Error) => void): unknown;
}

/** Starts the watchdog: `argv[0]` with the rest, never through another shell, in its own group. */
export type PtySpawn = (argv: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => PtyChild;

/** The pty's slave and the program on it. */
export interface PtySlave {
	/** The program's pid (`script`'s child), which a stop signals first. */
	pid: number;
	/** The slave device, `/dev/pts/7` or `/dev/ttys004`. */
	tty: string;
}

/** What a pty asks of the OS besides the spawn. */
export interface PtyTools {
	/** The slave under a watchdog shell, or null while it cannot be found. */
	findSlave(watchdogPid: number): Promise<PtySlave | null>;
	/** Runs a short command (`stty`) to its end. */
	run(argv: readonly string[]): Promise<void>;
	/** A signal to a pid, or to a process group when negative. */
	kill(pid: number, signal: NodeJS.Signals): void;
}

/** How long the program has after its own signal. Measured: claude exits 0.79 s after SIGTERM. */
export const PROGRAM_STOP_WAIT_MS = 2000;
/** How long after the watchdog's pipe closes. Measured: `script` takes 2.0 s (SIGTERM, 2 s, SIGKILL). */
export const WATCHDOG_STOP_WAIT_MS = 4000;
/** How long after SIGKILL. */
export const KILL_WAIT_MS = 2000;

/** How much stderr is kept for an exit report. */
const STDERR_TAIL_BYTES = 2048;

export interface PtyProcessOptions {
	/** The program, `argv[0]` first. */
	program: readonly string[];
	/** A command line run before the program (a shell tab's initial command). */
	before?: string;
	cwd: string;
	/** The environment before {@link ptyEnv}. */
	env: NodeJS.ProcessEnv;
	cols: number;
	rows: number;
	platform: PtyPlatform;
	/** The program's own stop signal: SIGTERM for claude, SIGHUP for an interactive shell. */
	stopSignal: NodeJS.Signals;
	spawn: PtySpawn;
	tools: PtyTools;
	timers: ClaudeTimers;
	/** Raw bytes from the pty, in order. */
	onData(bytes: Uint8Array): void;
	/** The watchdog is gone, and with it `script`. `stopping` when the plugin stopped it. */
	onExit(info: { code: number | null; signal: string | null; stopping: boolean; error: string }): void;
}

function exitReason(stderr: string, code: number | null, signal: string | null): string {
	const lines = stderr
		.split('\n')
		.map((line) => line.trim())
		// `script`'s own words when it is told to stop.
		.filter((line) => line && !/^Session terminated|^\.\.\.killed\.?$/.test(line));
	const last = lines.at(-1) ?? '';
	if (last) return last.length > 200 ? `${last.slice(0, 200)}…` : last;
	return signal ? `exited on ${signal}` : `exited with code ${code ?? 'unknown'}`;
}

export class PtyProcess {
	private child: PtyChild | null = null;
	private exited = false;
	private stopping: Promise<void> | null = null;
	private stderr = '';
	private exitWaiters: (() => void)[] = [];
	/** The grid asked for, and the one the slave has. */
	private wanted: { cols: number; rows: number };
	private applied: { cols: number; rows: number };
	/** A full repaint was asked for: the next resize passes through another grid first. */
	private nudge = false;
	private resizing = false;
	/** The program has written, so the command line's own `stty` has run. */
	private ready = false;
	private slaveLookup: Promise<PtySlave | null> | null = null;

	constructor(private readonly options: PtyProcessOptions) {
		const size = { cols: clampDimension(options.cols), rows: clampDimension(options.rows) };
		this.wanted = { ...size };
		this.applied = { ...size };
	}

	/** True from `start` until the watchdog exits. */
	get alive(): boolean {
		return this.child !== null && !this.exited;
	}

	get isStopping(): boolean {
		return this.stopping !== null;
	}

	/** The grid the pty has, or is about to have. */
	get size(): { cols: number; rows: number } {
		return { ...this.wanted };
	}

	start(): void {
		if (this.child) return;
		const { env, shell } = ptyEnv(this.options.env);
		const inner = innerCommand({
			cols: this.wanted.cols,
			rows: this.wanted.rows,
			shell,
			program: this.options.program,
			...(this.options.before ? { before: this.options.before } : {}),
		});
		let child: PtyChild;
		try {
			child = this.options.spawn(ptyArgv(this.options.platform, inner), { cwd: this.options.cwd, env });
		} catch (error) {
			this.exited = true;
			this.finish(null, null, error instanceof Error ? error.message : String(error));
			return;
		}
		this.child = child;
		child.stdin?.on('error', () => undefined);
		child.stdout?.on('data', (chunk) => {
			if (!this.ready) {
				this.ready = true;
				void this.applyResize();
			}
			try {
				this.options.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
			} catch {
				// A failing subscriber must not stop the stream.
			}
		});
		child.stderr?.on('data', (chunk) => {
			this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
		});
		child.on('error', (error) => {
			if (this.exited) return;
			this.exited = true;
			this.closeWatchdog();
			this.finish(null, null, error.message);
		});
		child.on('exit', (code, signal) => {
			if (this.exited) return;
			this.exited = true;
			// The watchdog's `cat` may outlive its shell; EOF ends it.
			this.closeWatchdog();
			this.finish(code, signal, exitReason(this.stderr, code, signal));
		});
	}

	/** Bytes to the program, as typed. False when it cannot take them. */
	write(data: string | Uint8Array): boolean {
		const stdin = this.child?.stdin;
		if (!stdin || this.exited) return false;
		stdin.write(data);
		return true;
	}

	/** Asks for a grid; applied through `stty` once the program runs, latest wins. */
	resize(cols: number, rows: number): void {
		this.wanted = { cols: clampDimension(cols), rows: clampDimension(rows) };
		void this.applyResize();
	}

	/**
	 * Makes the program draw its whole screen again: a SIGWINCH, by passing
	 * through a grid one row shorter when the grid itself does not change.
	 */
	redraw(): void {
		this.nudge = true;
		void this.applyResize();
	}

	/** Stops the program in the order above; resolves once the watchdog has exited. */
	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.stopping = this.runStop();
		return this.stopping;
	}

	private async runStop(): Promise<void> {
		if (!this.alive) return;
		const slave = await this.slave();
		if (slave && this.alive) {
			this.trySignal(slave.pid, this.options.stopSignal);
			if (await this.waitExit(PROGRAM_STOP_WAIT_MS)) return;
		}
		this.closeWatchdog();
		if (await this.waitExit(WATCHDOG_STOP_WAIT_MS)) return;
		const pid = this.child?.pid;
		if (pid) this.trySignal(-pid, 'SIGKILL');
		if (slave) this.trySignal(slave.pid, 'SIGKILL');
		await this.waitExit(KILL_WAIT_MS);
	}

	private trySignal(pid: number, signal: NodeJS.Signals): void {
		try {
			this.options.tools.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}

	/** The slave, looked up once per process; null when it cannot be found. */
	private slave(): Promise<PtySlave | null> {
		const pid = this.child?.pid;
		if (!pid) return Promise.resolve(null);
		this.slaveLookup ??= this.options.tools.findSlave(pid).catch(() => null);
		return this.slaveLookup.then((found) => {
			// Not there yet (the program has not started): asked again next time.
			if (!found) this.slaveLookup = null;
			return found;
		});
	}

	private async applyResize(): Promise<void> {
		if (this.resizing || !this.ready) return;
		this.resizing = true;
		try {
			while (this.alive && !this.stopping) {
				const target = { ...this.wanted };
				const same = target.cols === this.applied.cols && target.rows === this.applied.rows;
				if (same && !this.nudge) break;
				const slave = await this.slave();
				if (!slave || !this.alive) break;
				const platform = this.options.platform;
				if (this.nudge && same) {
					const rows = target.rows > 1 ? target.rows - 1 : target.rows + 1;
					await this.options.tools.run(sttyArgv(platform, slave.tty, target.cols, rows));
				}
				this.nudge = false;
				await this.options.tools.run(sttyArgv(platform, slave.tty, target.cols, target.rows));
				this.applied = target;
			}
		} catch {
			// A resize that fails leaves the grid as it was; the next one tries again.
		} finally {
			this.resizing = false;
		}
	}

	private closeWatchdog(): void {
		try {
			this.child?.watchdog?.destroy();
		} catch {
			// Already closed.
		}
	}

	private waitExit(ms: number): Promise<boolean> {
		if (this.exited) return Promise.resolve(true);
		return new Promise((resolve) => {
			let settled = false;
			const handle = this.options.timers.setTimeout(() => {
				if (settled) return;
				settled = true;
				resolve(this.exited);
			}, ms);
			this.exitWaiters.push(() => {
				if (settled) return;
				settled = true;
				this.options.timers.clearTimeout(handle);
				resolve(true);
			});
		});
	}

	private finish(code: number | null, signal: string | null, error: string): void {
		for (const waiter of this.exitWaiters.splice(0)) waiter();
		this.options.onExit({ code, signal, stopping: this.stopping !== null, error });
	}
}

/** The children of a pid, from `/proc` (Linux). */
function procChildren(pid: number): number[] {
	return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map(Number);
}

/** Linux: `script` is the watchdog's child named `script`, and the program is its child. */
export function linuxFindSlave(watchdogPid: number): Promise<PtySlave | null> {
	try {
		for (const pid of procChildren(watchdogPid)) {
			if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'script') continue;
			const program = procChildren(pid)[0];
			if (!program) return Promise.resolve(null);
			const tty = readlinkSync(`/proc/${program}/fd/0`);
			return Promise.resolve(tty.startsWith('/dev/') ? { pid: program, tty } : null);
		}
	} catch {
		// Not there (yet), or no `/proc`.
	}
	return Promise.resolve(null);
}

/**
 * The same from one `ps -A -o pid=,ppid=,tty=,comm=` listing, as macOS has
 * it (no `/proc`): `script` under the watchdog, its child, and that child's
 * tty. Pure, for the test; **not verified** on a Mac.
 */
export function slaveFromPs(listing: string, watchdogPid: number): PtySlave | null {
	const rows = listing
		.split('\n')
		.map((line) => line.trim().split(/\s+/))
		.filter((cells) => cells.length >= 4)
		.map(([pid, ppid, tty, ...comm]) => ({
			pid: Number(pid),
			ppid: Number(ppid),
			tty: tty ?? '',
			comm: comm.join(' '),
		}));
	const script = rows.find((row) => row.ppid === watchdogPid && /(^|\/)script$/.test(row.comm));
	if (!script) return null;
	const program = rows.find((row) => row.ppid === script.pid);
	if (!program || !program.tty || program.tty === '?' || program.tty === '??') return null;
	return { pid: program.pid, tty: program.tty.startsWith('/dev/') ? program.tty : `/dev/${program.tty}` };
}

function execText(argv: readonly string[]): Promise<string> {
	const [command, ...args] = argv;
	return new Promise((resolve, reject) => {
		if (!command) {
			reject(new Error('no command'));
			return;
		}
		execFile(command, args, { timeout: 5000 }, (error: Error | null, stdout) => {
			if (error) reject(error);
			else resolve(String(stdout));
		});
	});
}

/** The real tools for a platform. */
export function defaultPtyTools(platform: PtyPlatform): PtyTools {
	return {
		findSlave:
			platform === 'linux'
				? linuxFindSlave
				: async (pid) => slaveFromPs(await execText(['ps', '-A', '-o', 'pid=,ppid=,tty=,comm=']), pid),
		run: async (argv) => {
			await execText(argv);
		},
		kill: (pid, signal) => {
			process.kill(pid, signal);
		},
	};
}

/** `child_process.spawn` of the watchdog: four pipes, its own process group, no shell around it. */
export const defaultPtySpawn: PtySpawn = (argv, options) => {
	const [command, ...args] = argv;
	if (!command) throw new Error('no pty command');
	const child = nodeSpawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
		detached: true,
	});
	const watchdog = child.stdio[3] as { destroy(): void } | null | undefined;
	return {
		get pid() {
			return child.pid;
		},
		stdin: child.stdin,
		stdout: child.stdout,
		stderr: child.stderr,
		watchdog: watchdog ?? null,
		on: (event: 'exit' | 'error', handler: (...args: unknown[]) => void) => child.on(event, handler),
	} as PtyChild;
};
