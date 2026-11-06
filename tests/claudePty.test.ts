/**
 * The `claude` kind's pty (ADR-0007's D2, `src/claude/pty.ts`): the argv
 * around `script(1)` on Linux and macOS, the fd-3 watchdog, the command line
 * inside, the environment, resizing through `stty` on the slave, and the
 * stop order, against a fake child, fake tools and hand-fired timers.
 */

import { describe, expect, it } from 'vitest';
import {
	innerCommand,
	PROGRAM_STOP_WAIT_MS,
	ptyArgv,
	ptyEnv,
	ptyPlatformOf,
	PtyProcess,
	scriptArgv,
	shellQuote,
	slaveFromPs,
	sttyArgv,
	WATCHDOG,
	WATCHDOG_STOP_WAIT_MS,
} from '../src/claude/pty';
import { FakePty, ManualTimers } from './fixtures/fakePty';

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 5));

describe('the argv around script(1)', () => {
	it('wraps util-linux script in the fd-3 watchdog on Linux', () => {
		expect(ptyArgv('linux', 'CMD')).toEqual(['/bin/sh', '-c', WATCHDOG, 'oh-pty', 'script', '-qfec', 'CMD', '/dev/null']);
	});

	it('runs BSD script with the command line through /bin/sh on macOS', () => {
		expect(scriptArgv('darwin', 'CMD')).toEqual(['script', '-q', '/dev/null', '/bin/sh', '-c', 'CMD']);
		expect(ptyArgv('darwin', 'CMD').slice(0, 4)).toEqual(['/bin/sh', '-c', WATCHDOG, 'oh-pty']);
	});

	it('runs script in the foreground without fd 3, and ends its group when fd 3 reaches EOF', () => {
		// Not an asynchronous list, which would start it with SIGINT and SIGQUIT
		// ignored (and with /dev/null for stdin).
		expect(WATCHDOG).toContain('"$@" 3<&-; st=$?; kill $w 2>/dev/null; exit $st');
		expect(WATCHDOG).toContain('(cat <&3 >/dev/null; kill -s TERM -- -$$');
		// The shell outlives the group's SIGTERM, to report script's exit.
		expect(WATCHDOG.startsWith('trap : TERM; ')).toBe(true);
	});

	it('has no pty on Windows, nor on macOS until its path is verified', () => {
		expect(ptyPlatformOf('win32')).toBeNull();
		expect(ptyPlatformOf('darwin')).toBeNull();
		expect(ptyPlatformOf('linux')).toBe('linux');
		expect(ptyPlatformOf('freebsd')).toBe('linux');
	});
});

describe('the command line script runs', () => {
	it('sets the grid, puts the user shell back and execs the program, every word quoted', () => {
		expect(
			innerCommand({
				cols: 100,
				rows: 30,
				shell: '/usr/bin/zsh',
				program: ['/home/u/.local/bin/claude', '--permission-mode', 'manual', '--resume', 'a b'],
			}),
		).toBe(
			"stty rows 30 cols 100 2>/dev/null; SHELL='/usr/bin/zsh'; export SHELL; exec '/home/u/.local/bin/claude' '--permission-mode' 'manual' '--resume' 'a b'",
		);
	});

	it('unsets SHELL when there was none, and runs a command first', () => {
		expect(innerCommand({ cols: 0, rows: Number.NaN, shell: undefined, before: 'echo hi', program: ['/bin/bash'] })).toBe(
			"stty rows 1 cols 1 2>/dev/null; unset SHELL; trap : INT QUIT; /bin/sh -c 'echo hi'; trap - INT QUIT; exec '/bin/bash'",
		);
	});

	it("quotes a single quote the POSIX way", () => {
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	it('gives script /bin/sh and the renderers’ terminal, keeping the user shell aside', () => {
		const { env, shell } = ptyEnv({ SHELL: '/usr/bin/fish', TERM: 'dumb', TERM_PROGRAM: 'herdr', TERM_PROGRAM_VERSION: '1', PATH: '/usr/bin' });
		expect(shell).toBe('/usr/bin/fish');
		expect(env).toEqual({ SHELL: '/bin/sh', TERM: 'xterm-256color', COLORTERM: 'truecolor', PATH: '/usr/bin', LANG: 'C.UTF-8' });
		expect(ptyEnv({ LANG: 'nb_NO.UTF-8' }).env.LANG).toBe('nb_NO.UTF-8');
	});
});

describe('resizing from outside', () => {
	it('uses stty -F on Linux and stty -f on macOS', () => {
		expect(sttyArgv('linux', '/dev/pts/7', 132, 40)).toEqual(['stty', '-F', '/dev/pts/7', 'rows', '40', 'cols', '132']);
		expect(sttyArgv('darwin', '/dev/ttys004', 132, 40)).toEqual(['stty', '-f', '/dev/ttys004', 'rows', '40', 'cols', '132']);
	});

	it('finds the slave from ps on macOS: script under the watchdog, then its child’s tty', () => {
		const listing = [
			'  500     1 ??       /Applications/Obsidian.app/Contents/MacOS/Obsidian',
			'  610   500 ??       /bin/sh',
			'  611   610 ??       script',
			'  612   610 ??       cat',
			'  613   611 ttys004  claude',
		].join('\n');
		expect(slaveFromPs(listing, 610)).toEqual({ pid: 613, tty: '/dev/ttys004' });
		expect(slaveFromPs(listing, 999)).toBeNull();
	});

	it('waits for the first output, then applies only the latest grid', async () => {
		const pty = new FakePty();
		const process = new PtyProcess({
			program: ['claude'],
			cwd: '/tmp',
			env: {},
			cols: 80,
			rows: 24,
			platform: 'linux',
			stopSignal: 'SIGTERM',
			spawn: pty.spawn,
			tools: pty.tools,
			timers: new ManualTimers(),
			onData: () => undefined,
			onExit: () => undefined,
		});
		process.start();
		process.resize(100, 30);
		process.resize(120, 40);
		await tick();
		// Before any output the command line's own stty may not have run yet.
		expect(pty.runs).toEqual([]);
		pty.last.emit('prompt');
		await tick();
		expect(pty.runs).toEqual([['stty', '-F', '/dev/pts/10', 'rows', '40', 'cols', '120']]);
		process.resize(120, 40);
		await tick();
		expect(pty.runs).toHaveLength(1);
		// A redraw at the same grid passes through one row less: a SIGWINCH.
		process.redraw();
		await tick();
		expect(pty.resizes.slice(1)).toEqual([
			[120, 39],
			[120, 40],
		]);
	});
});

describe('stopping', () => {
	function running(options: ConstructorParameters<typeof FakePty>[0] = {}, stopSignal: NodeJS.Signals = 'SIGTERM') {
		const pty = new FakePty(options);
		const timers = new ManualTimers();
		const exits: { stopping: boolean; code: number | null }[] = [];
		const process = new PtyProcess({
			program: ['claude'],
			cwd: '/tmp',
			env: {},
			cols: 80,
			rows: 24,
			platform: 'linux',
			stopSignal,
			spawn: pty.spawn,
			tools: pty.tools,
			timers,
			onData: () => undefined,
			onExit: (info) => exits.push(info),
		});
		process.start();
		return { pty, timers, process, exits };
	}

	it('signals the program first, and is done when it exits', async () => {
		const { pty, process, exits } = running({ tui: true });
		await process.stop();
		expect(pty.kills).toEqual([[1002, 'SIGTERM']]);
		expect(pty.last.watchdogClosed).toBe(true);
		expect(exits).toEqual([expect.objectContaining({ stopping: true, code: 143 })]);
		expect(process.alive).toBe(false);
	});

	it('then closes the watchdog pipe, then kills the group and the program', async () => {
		const { pty, timers, process } = running({ ignoreSignals: true, quitOnWatchdog: false });
		const stopped = process.stop();
		await tick();
		expect(pty.kills).toEqual([[1002, 'SIGTERM']]);
		expect(timers.delays).toEqual([PROGRAM_STOP_WAIT_MS]);
		expect(pty.last.watchdogClosed).toBe(false);
		timers.fireNext();
		await tick();
		expect(pty.last.watchdogClosed).toBe(true);
		expect(timers.delays).toEqual([WATCHDOG_STOP_WAIT_MS]);
		timers.fireNext();
		await tick();
		expect(pty.kills.slice(1)).toEqual([
			[-1000, 'SIGKILL'],
			[1002, 'SIGKILL'],
		]);
		// The group's SIGKILL ended it; the last wait is cleared.
		await stopped;
		expect(timers.delays).toEqual([]);
		expect(process.alive).toBe(false);
	});

	it('ends a shell with a hangup, which an interactive shell does not ignore', async () => {
		const { pty, process } = running({}, 'SIGHUP');
		await process.stop();
		expect(pty.kills[0]).toEqual([1002, 'SIGHUP']);
	});

	it('goes straight to the watchdog when the slave cannot be found', async () => {
		const { pty, process } = running({ noSlave: true });
		await process.stop();
		expect(pty.kills).toEqual([]);
		expect(pty.last.watchdogClosed).toBe(true);
	});

	it('closes the watchdog pipe when the program ends by itself, so no cat is left', () => {
		const { pty, exits } = running();
		pty.last.exit(0);
		expect(pty.last.watchdogClosed).toBe(true);
		expect(exits).toEqual([expect.objectContaining({ stopping: false, code: 0 })]);
	});
});
