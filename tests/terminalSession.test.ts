import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	buildArgv,
	LineSplitter,
	TerminalSession,
	type FrameMeta,
	type TerminalSessionOptions,
} from '../src/bridge/terminalSession';

const FAKE = fileURLToPath(new URL('./fixtures/fake-herdr.mjs', import.meta.url));
const COMMAND = [process.execPath, FAKE];

interface Recorded {
	frames: { text: string; bytes: Uint8Array; meta: FrameMeta }[];
	closed: string[];
	errors: Error[];
	stderr: string[];
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function makeSession(
	overrides: Partial<TerminalSessionOptions> = {},
	env: NodeJS.ProcessEnv = {},
): { session: TerminalSession; rec: Recorded } {
	const session = new TerminalSession({
		command: COMMAND,
		target: 'w4:p1',
		mode: 'control',
		takeover: true,
		cols: 80,
		rows: 24,
		// Generous by default so a loaded machine cannot mistake a slow clean exit
		// for a hung child; the escalation tests shorten these deliberately.
		releaseGraceMs: 2000,
		killGraceMs: 2000,
		env: { ...process.env, ...env },
		...overrides,
	});
	const frames: Recorded['frames'] = [];
	const closed: string[] = [];
	const errors: Error[] = [];
	const stderr: string[] = [];
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		session.on('exit', (code, signal) => resolve({ code, signal }));
	});
	session.on('frame', (bytes, meta) =>
		frames.push({ text: Buffer.from(bytes).toString('utf8'), bytes, meta }),
	);
	session.on('closed', (reason) => closed.push(reason));
	session.on('error', (err) => errors.push(err));
	session.on('stderr', (line) => stderr.push(line));
	session.start();
	return { session, rec: { frames, closed, errors, stderr, exit } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('timed out waiting for condition');
		await new Promise((r) => setTimeout(r, 10));
	}
}

describe('buildArgv', () => {
	it('appends the subcommand to the caller-supplied argv prefix', () => {
		expect(
			buildArgv({ command: ['/opt/homebrew/bin/herdr'], target: 'w4:p1', mode: 'control', takeover: true, cols: 100, rows: 30 }),
		).toEqual(['/opt/homebrew/bin/herdr', 'terminal', 'session', 'control', 'w4:p1', '--takeover', '--cols', '100', '--rows', '30']);
	});

	it('supports an ssh prefix and never passes --takeover in observe mode (S17, S16)', () => {
		expect(
			buildArgv({
				command: ['ssh', '-T', 'xl', '/home/lasse/.local/bin/herdr'],
				target: 'agent-one',
				mode: 'observe',
				takeover: true,
				cols: 0,
				rows: 99999,
			}),
		).toEqual([
			'ssh', '-T', 'xl', '/home/lasse/.local/bin/herdr',
			'terminal', 'session', 'observe', 'agent-one', '--cols', '1', '--rows', '65535',
		]);
	});

	it('rejects an empty command', () => {
		expect(() => buildArgv({ command: [], target: 'x', mode: 'control', cols: 80, rows: 24 })).toThrow();
	});
});

describe('LineSplitter', () => {
	it('reassembles lines split across chunks', () => {
		const s = new LineSplitter();
		expect(s.push(Buffer.from('{"a":'))).toEqual([]);
		expect(s.push(Buffer.from('1}\n{"b":2}\n{"c'))).toEqual(['{"a":1}', '{"b":2}']);
		expect(s.push(Buffer.from('":3}\n'))).toEqual(['{"c":3}']);
		expect(s.flush()).toBeNull();
	});

	it('strips a trailing carriage return and flushes a final unterminated line', () => {
		const s = new LineSplitter();
		expect(s.push(Buffer.from('one\r\ntwo'))).toEqual(['one']);
		expect(s.flush()).toBe('two');
		expect(s.flush()).toBeNull();
	});

	it('handles multibyte characters split across chunk boundaries', () => {
		const s = new LineSplitter();
		const bytes = Buffer.from('héllo →\n', 'utf8');
		expect(s.push(bytes.subarray(0, 2))).toEqual([]);
		expect(s.push(bytes.subarray(2))).toEqual(['héllo →']);
	});

	it('reports an oversized record via the callback instead of throwing (#60)', () => {
		const s = new LineSplitter(16);
		const overflows: number[] = [];
		expect(s.push(Buffer.from('x'.repeat(32) + '\n'), (bytes) => overflows.push(bytes))).toEqual([]);
		expect(overflows).toEqual([32]);
	});

	it('rejects a completed oversized line, not only an unterminated one (#60)', () => {
		// The 100-byte line above is fully terminated within the chunk: the old
		// bridge splitter only checked the size of a *pending* (unterminated)
		// tail, so a complete oversized line slipped through uncapped.
		const s = new LineSplitter(16);
		const overflows: number[] = [];
		const lines = s.push(Buffer.from(`${'x'.repeat(100)}\n`), (bytes) => overflows.push(bytes));
		expect(lines).toEqual([]);
		expect(overflows).toEqual([100]);
	});

	it('discards the remainder of a rejected record so the next real record is not misread as a suffix (#60)', () => {
		const s = new LineSplitter(16);
		s.push(Buffer.from('x'.repeat(17)), () => undefined);
		// A naive reset (rather than discard-until-newline) would let this next
		// push emit "suffix" as a standalone record; only "ok" is a real one.
		expect(s.push(Buffer.from('suffix\nok\n'))).toEqual(['ok']);
	});
});

describe('TerminalSession with a command still to be found', () => {
	it('spawns what resolveCommand finds', async () => {
		const { session, rec } = makeSession({ command: [], resolveCommand: () => Promise.resolve(COMMAND) });
		await waitFor(() => rec.frames.length >= 1);
		expect(session.argv.slice(0, 2)).toEqual(COMMAND);
		await session.dispose();
	});

	it('spawns at the latest grid and delivers the latest resize, cell metrics and all', async () => {
		// What the child reads on stdin, for a direct spawn and a deferred one.
		const record = async (deferred: boolean): Promise<{ stdin: unknown[]; argv: string[] }> => {
			const dir = mkdtempSync(join(tmpdir(), 'oh-bridge-'));
			const out = join(dir, 'stdin.log');
			const prefix = ['sh', '-c', `cat > '${out}'`, 'sh'];
			const session = new TerminalSession({
				command: deferred ? [] : prefix,
				resolveCommand: deferred
					? () => new Promise((resolve) => setTimeout(() => resolve(prefix), 50))
					: undefined,
				target: 'w4:p1',
				mode: 'control',
				cols: 80,
				rows: 24,
				releaseGraceMs: 2000,
				killGraceMs: 2000,
			});
			session.start();
			// PaneTerminal: the fitted grid with cell metrics right after start,
			// then a window resize while the binary may still be looked up.
			expect(session.resize(100, 30, 9, 18)).toBe(true);
			expect(session.resize(110, 35)).toBe(true);
			expect(session.resize(120, 40, 9, 18)).toBe(true);
			await waitFor(() => session.pid !== undefined);
			const argv = session.argv;
			await new Promise((resolve) => setTimeout(resolve, 100));
			await session.dispose();
			const stdin = readFileSync(out, 'utf8')
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as unknown);
			rmSync(dir, { recursive: true, force: true });
			return { stdin, argv };
		};
		const direct = await record(false);
		const deferred = await record(true);
		const latest = { type: 'terminal.resize', cols: 120, rows: 40, cell_width_px: 9, cell_height_px: 18 };
		expect(direct.stdin).toContainEqual(latest);
		expect(deferred.stdin).toContainEqual(latest);
		// The child starts at the grid asked for last, not the constructor's.
		expect(deferred.argv.slice(-4)).toEqual(['--cols', '120', '--rows', '40']);
		expect(deferred.stdin.at(-1)).toEqual({ type: 'terminal.release' });
	});

	it('keeps the cell metrics of an earlier resize when a later one has none', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'oh-bridge-'));
		const out = join(dir, 'stdin.log');
		const session = new TerminalSession({
			command: [],
			resolveCommand: () => Promise.resolve(['sh', '-c', `cat > '${out}'`, 'sh']),
			target: 'w4:p1',
			mode: 'control',
			cols: 80,
			rows: 24,
		});
		session.start();
		session.resize(100, 30, 9, 18);
		session.resize(120, 40);
		await waitFor(() => session.pid !== undefined);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await session.dispose();
		const first = JSON.parse(readFileSync(out, 'utf8').split('\n')[0] ?? '') as unknown;
		rmSync(dir, { recursive: true, force: true });
		expect(first).toEqual({ type: 'terminal.resize', cols: 120, rows: 40, cell_width_px: 9, cell_height_px: 18 });
	});

	it('reports a failed lookup as an error and an exit', async () => {
		const { session, rec } = makeSession({
			command: [],
			resolveCommand: () => Promise.reject(new Error('herdr was not found')),
		});
		expect(await rec.exit).toEqual({ code: null, signal: null });
		expect(rec.errors.map((error) => error.message)).toEqual(['herdr was not found']);
		await session.dispose();
	});

	it('spawns nothing when disposed before the lookup ends', async () => {
		let finish: (command: string[]) => void = () => undefined;
		const { session } = makeSession({
			command: [],
			resolveCommand: () => new Promise<string[]>((resolve) => (finish = resolve)),
		});
		await session.dispose();
		finish(COMMAND);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(session.pid).toBeUndefined();
	});
});

describe('TerminalSession against the fake herdr', () => {
	it('emits the initial full frame with decoded bytes and argv-derived size', async () => {
		const { session, rec } = makeSession();
		await waitFor(() => rec.frames.length >= 1);
		const first = rec.frames[0]!;
		expect(first.text).toBe('hello w4:p1 control takeover 80x24');
		expect(first.meta).toMatchObject({ seq: 0, encoding: 'ansi', width: 80, height: 24, full: true });
		// The frame owns its bytes: a view on a pooled node Buffer would report an
		// 8 KB backing store for a short frame and pin the pool (notes/memory.md).
		expect(first.bytes.byteOffset).toBe(0);
		expect(first.bytes.buffer.byteLength).toBe(first.bytes.length);
		await session.dispose();
	});

	it('echoes text and byte input back as frames', async () => {
		const { session, rec } = makeSession();
		await waitFor(() => rec.frames.length >= 1);
		expect(session.input('ls -la\r')).toBe(true);
		expect(session.input(new Uint8Array([0x03]))).toBe(true);
		await waitFor(() => rec.frames.length >= 3);
		expect(rec.frames[1]!.text).toBe('ls -la\r');
		expect(rec.frames[2]!.text).toBe('\x03');
		await session.dispose();
	});

	it('sends resize and scroll', async () => {
		const { session, rec } = makeSession();
		await waitFor(() => rec.frames.length >= 1);
		session.resize(120, 40, 8, 17);
		session.scroll('up', 3, { source: 'wheel' });
		await waitFor(() => rec.frames.length >= 3);
		expect(rec.frames[1]!.text).toBe('resize 120x40');
		expect(rec.frames[2]!.text).toBe('scroll up 3 wheel');
		expect(session.size).toEqual({ cols: 120, rows: 40 });
		await session.dispose();
	});

	it('parses byte-at-a-time output and a very large frame', async () => {
		const big = 2 * 1024 * 1024;
		const { session, rec } = makeSession({}, { FAKE_BIG: String(big) });
		await waitFor(() => rec.frames.length >= 1, 20000);
		expect(rec.frames[0]!.text.length).toBe(big);
		expect(rec.errors).toEqual([]);
		await session.dispose();
	});

	it('surfaces non-JSON stderr without treating it as protocol, and reports non-JSON stdout as an error', async () => {
		const { session, rec } = makeSession({}, { FAKE_STDERR: 'herdr: connection failed', FAKE_GARBAGE: '1' });
		// stdout and stderr are separate pipes: wait for all three, in no fixed order.
		await waitFor(() => rec.stderr.length >= 1 && rec.errors.length >= 1 && rec.frames.length >= 1);
		expect(rec.stderr[0]).toBe('herdr: connection failed');
		expect(rec.errors[0]!.message).toContain('non-JSON stdout line');
		expect(rec.frames.length).toBeGreaterThanOrEqual(1);
		await session.dispose();
	});

	it('release() writes terminal.release and the child exits cleanly', async () => {
		const { session, rec } = makeSession();
		await waitFor(() => rec.frames.length >= 1);
		const pid = session.pid!;
		await session.release();
		const { code, signal } = await rec.exit;
		expect(rec.closed).toContain('released');
		expect(code).toBe(0);
		expect(signal).toBeNull();
		expect(isAlive(pid)).toBe(false);
	});

	it('escalates to SIGTERM when release is ignored', async () => {
		const { session, rec } = makeSession({ releaseGraceMs: 150 }, { FAKE_IGNORE_RELEASE: '1' });
		await waitFor(() => rec.frames.length >= 1);
		const pid = session.pid!;
		await session.dispose();
		const { signal } = await rec.exit;
		expect(signal).toBe('SIGTERM');
		expect(isAlive(pid)).toBe(false);
	});

	it('escalates to SIGKILL when SIGTERM is ignored too', async () => {
		const { session, rec } = makeSession(
			{ releaseGraceMs: 150, killGraceMs: 200 },
			{ FAKE_IGNORE_RELEASE: '1', FAKE_IGNORE_SIGTERM: '1' },
		);
		await waitFor(() => rec.frames.length >= 1);
		const pid = session.pid!;
		await session.dispose();
		const { signal } = await rec.exit;
		expect(signal).toBe('SIGKILL');
		await waitFor(() => !isAlive(pid));
	});

	it('dispose is idempotent and safe before any output', async () => {
		const { session, rec } = makeSession();
		await Promise.all([session.dispose(), session.dispose()]);
		await session.dispose();
		await rec.exit;
		expect(session.writable).toBe(false);
	});

	it('observe mode never writes to the child (S16)', async () => {
		const { session, rec } = makeSession({ mode: 'observe', takeover: false });
		await waitFor(() => rec.frames.length >= 1);
		expect(rec.frames[0]!.text).toBe('hello w4:p1 observe 80x24');
		expect(session.writable).toBe(false);
		expect(session.input('should not be sent')).toBe(false);
		expect(session.resize(200, 60)).toBe(false);
		expect(session.scroll('down', 1)).toBe(false);
		await session.dispose();
		await rec.exit;
		expect(rec.frames.length).toBe(1);
	});

	it('reports a spawn failure as an error followed by exit, with no throw', async () => {
		const { session, rec } = makeSession({ command: ['/nonexistent/herdr-binary'] });
		await rec.exit;
		expect(rec.errors.length).toBeGreaterThanOrEqual(1);
		expect(session.writable).toBe(false);
		await session.dispose();
	});
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
