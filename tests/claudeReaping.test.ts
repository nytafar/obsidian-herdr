/**
 * Reaping a `claude` pty with real processes (ADR-0007's amendment): the
 * real POSIX `sh` watchdog from `src/claude/pty.ts` around a fake `script`
 * (`tests/fixtures/fake-script/script`) that, like util-linux `script`,
 * ignores EOF on its stdin, so only the watchdog's signal can end it.
 *
 * - A SIGKILL of the plugin's process (a parent the test kills) closes fd 3,
 *   and the program is gone within a second and a half.
 * - A stop through `PtyProcess` with the real spawn and tools ends the
 *   watchdog, `script` and the program.
 *
 * Linux only (the stop finds the slave through `/proc`); the real `script`
 * and claude are checked live.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultPtySpawn, defaultPtyTools, ptyArgv, innerCommand, PtyProcess } from '../src/claude/pty';
import { setTimer, clearTimer } from '../src/timers';

const FAKE_SCRIPT_DIR = resolve(__dirname, 'fixtures/fake-script');
const PARENT = resolve(__dirname, 'fixtures/pty-parent.mjs');
const posix = process.platform === 'linux';

/** util-linux `script`, for the checks that need a real pty. */
function realScript(): boolean {
	if (!posix) return false;
	try {
		return execFileSync('script', ['--version'], { encoding: 'utf8' }).includes('util-linux');
	} catch {
		return false;
	}
}

/** The signals a process ignores, from `/proc/<pid>/status` (`SigIgn`, a hex mask). */
function ignored(pid: number): bigint {
	const line = readFileSync(`/proc/${pid}/status`, 'utf8')
		.split('\n')
		.find((each) => each.startsWith('SigIgn:'));
	return BigInt(`0x${line?.split(/\s+/)[1] ?? '0'}`);
}

/** SIGINT is 2 and SIGQUIT 3: bits 1 and 2 of the mask. */
const SIGINT_BIT = 1n << 1n;
const SIGQUIT_BIT = 1n << 2n;

const dirs: string[] = [];
const pids: number[] = [];

afterEach(() => {
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// Gone, as it should be.
		}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await new Promise((done) => setTimeout(done, 20));
	}
	return true;
}

/** A program that writes its pid where the test can read it, then sleeps. */
function program(dir: string): { argv: string[]; pidFile: string } {
	const pidFile = join(dir, 'program.pid');
	return { argv: ['/bin/sh', '-c', `echo $$ > '${pidFile}'; exec sleep 300`], pidFile };
}

function env(): NodeJS.ProcessEnv {
	return { ...process.env, PATH: `${FAKE_SCRIPT_DIR}:${process.env.PATH ?? ''}`, SHELL: '/bin/sh' };
}

function timers() {
	return {
		setTimeout: (handler: () => void, ms: number) => setTimer(handler, ms),
		clearTimeout: (handle: unknown) => clearTimer(handle as ReturnType<typeof setTimer>),
	};
}

describe.runIf(realScript())('signals on a real script pty', () => {
	function pidIn(file: string): number {
		return Number(readFileSync(file, 'utf8').trim());
	}

	async function started(file: string): Promise<number> {
		expect(await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').trim() !== '', 5000)).toBe(true);
		const pid = pidIn(file);
		pids.push(pid);
		return pid;
	}

	it('gives the program and an initial command default SIGINT and SIGQUIT, so Ctrl-C ends them', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'oh-pty-sig-'));
		dirs.push(dir);
		const before = join(dir, 'before.pid');
		const after = join(dir, 'program.pid');
		const pty = new PtyProcess({
			program: ['/bin/sh', '-c', `echo $$ > '${after}'; exec sleep 300`],
			before: `echo $$ > '${before}'; exec sleep 300`,
			cwd: dir,
			env: { ...process.env, SHELL: '/bin/sh' },
			cols: 80,
			rows: 24,
			platform: 'linux',
			stopSignal: 'SIGHUP',
			spawn: defaultPtySpawn,
			tools: defaultPtyTools('linux'),
			timers: timers(),
			onData: () => undefined,
			onExit: () => undefined,
		});
		pty.start();
		try {
			// The initial command (D3's installer runs here).
			const first = await started(before);
			expect(ignored(first) & (SIGINT_BIT | SIGQUIT_BIT)).toBe(0n);
			pty.write('\x03');
			expect(await waitFor(() => !alive(first), 2000)).toBe(true);
			// Ctrl-C ended the command, not the tab: the program runs after it.
			const program = await started(after);
			expect(ignored(program) & (SIGINT_BIT | SIGQUIT_BIT)).toBe(0n);
			pty.write('\x03');
			expect(await waitFor(() => !alive(program), 2000)).toBe(true);
		} finally {
			await pty.stop();
		}
	});
});

describe.runIf(posix)('reaping a pty with real processes', () => {
	it('ends the program within 1.5 s when the plugin process is SIGKILLed', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'oh-pty-reap-'));
		dirs.push(dir);
		const { argv, pidFile } = program(dir);
		const ptyArgvJson = JSON.stringify(ptyArgv('linux', innerCommand({ cols: 80, rows: 24, shell: '/bin/sh', program: argv })));
		const parent = spawn(process.execPath, [PARENT], { env: { ...env(), PTY_ARGV: ptyArgvJson }, stdio: ['ignore', 'pipe', 'inherit'] });
		if (parent.pid) pids.push(parent.pid);
		expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 5000)).toBe(true);
		const pid = Number(readFileSync(pidFile, 'utf8').trim());
		pids.push(pid);
		expect(alive(pid)).toBe(true);
		parent.kill('SIGKILL');
		expect(await waitFor(() => !alive(pid), 1500)).toBe(true);
	});

	it('stops the watchdog, script and the program in order', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'oh-pty-stop-'));
		dirs.push(dir);
		const { argv, pidFile } = program(dir);
		const exits: { stopping: boolean }[] = [];
		const pty = new PtyProcess({
			program: argv,
			cwd: dir,
			env: env(),
			cols: 80,
			rows: 24,
			platform: 'linux',
			stopSignal: 'SIGTERM',
			spawn: defaultPtySpawn,
			tools: defaultPtyTools('linux'),
			timers: {
				setTimeout: (handler, ms) => setTimer(handler, ms),
				clearTimeout: (handle) => clearTimer(handle as ReturnType<typeof setTimer>),
			},
			onData: () => undefined,
			onExit: (info) => exits.push(info),
		});
		pty.start();
		expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 5000)).toBe(true);
		const pid = Number(readFileSync(pidFile, 'utf8').trim());
		pids.push(pid);
		const started = Date.now();
		await pty.stop();
		expect(Date.now() - started).toBeLessThan(3000);
		expect(alive(pid)).toBe(false);
		expect(pty.alive).toBe(false);
		expect(exits).toEqual([expect.objectContaining({ stopping: true })]);
	});
});
