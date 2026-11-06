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

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultPtySpawn, defaultPtyTools, ptyArgv, innerCommand, PtyProcess } from '../src/claude/pty';
import { setTimer, clearTimer } from '../src/timers';

const FAKE_SCRIPT_DIR = resolve(__dirname, 'fixtures/fake-script');
const PARENT = resolve(__dirname, 'fixtures/pty-parent.mjs');
const posix = process.platform === 'linux';

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
