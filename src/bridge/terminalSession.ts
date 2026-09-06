/**
 * Terminal session bridge (PRD M13, S16, S17; contract in PRD section 7).
 *
 * Spawns `<argv prefix> terminal session control|observe <target> …` with piped
 * stdio and speaks the newline-delimited JSON protocol herdr's
 * `src/client/terminal_sessions.rs` implements:
 *
 *   stdout  {"type":"terminal.frame","seq","encoding":"ansi","width","height","full","bytes":base64}
 *           {"type":"terminal.closed","reason"}
 *   stdin   {"type":"terminal.input","text"|"bytes"}
 *           {"type":"terminal.resize","cols","rows","cell_width_px"?,"cell_height_px"?}
 *           {"type":"terminal.scroll","direction","lines","source"?,"column"?,"row"?,"modifiers"?}
 *           {"type":"terminal.release"}
 *
 * The bridge knows nothing about how the herdr binary is found: callers pass the
 * whole argv prefix, so a remote profile (S17) is just
 * `['ssh', '-T', 'host', '/home/lasse/.local/bin/herdr']`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { clearTimer, setTimer } from '../timers';

/** herdr caps a frame payload at 32 MiB; base64 inflates that by 4/3. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
/** Line budget for the NDJSON parser: a max-size frame plus envelope headroom. */
export const MAX_LINE_BYTES = Math.ceil((MAX_FRAME_BYTES * 4) / 3) + 64 * 1024;

const DEFAULT_RELEASE_GRACE_MS = 400;
const DEFAULT_KILL_GRACE_MS = 1000;

export type TerminalSessionMode = 'control' | 'observe';
export type ScrollDirection = 'up' | 'down';
export type ScrollSource = 'wheel' | 'page_key';

export interface TerminalSessionOptions {
	/**
	 * Full argv prefix ending in the herdr binary, e.g. `['/opt/homebrew/bin/herdr']`
	 * or `['ssh', '-T', 'xl', '/home/lasse/.local/bin/herdr']`. The bridge appends
	 * `terminal session <mode> <target> …` itself.
	 */
	command: string[];
	/** Pane id (`w4:p1`) or unique agent name. */
	target: string;
	mode: TerminalSessionMode;
	/** Control mode only: replace the current controller. */
	takeover?: boolean;
	cols: number;
	rows: number;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** How long `release()` waits for a clean exit before SIGTERM. */
	releaseGraceMs?: number;
	/** How long SIGTERM is given before SIGKILL. */
	killGraceMs?: number;
}

export interface FrameMeta {
	seq: number;
	encoding: string;
	width: number;
	height: number;
	full: boolean;
}

/**
 * herdr forks a scroll server-side (`server/pane_input.rs::apply_scroll`): a
 * pane whose application enabled mouse reporting gets an SGR wheel report built
 * from these fields, one wanting alternate scroll gets `ESC[A`/`ESC[B`, and any
 * other pane has its viewport moved. So the client must not encode the wheel
 * itself; it only says where the pointer was.
 */
export interface ScrollOptions {
	source?: ScrollSource;
	/** 0-based cell; herdr adds the 1 the wire format wants. Defaults to 0. */
	column?: number;
	row?: number;
	/**
	 * crossterm `KeyModifiers` bits — shift 1, ctrl 2, alt 4, super 8 — not the
	 * xterm bits an SGR report carries. `herdrModifierBits` in
	 * `views/input/mouseEncoder.ts` builds it; unknown bits are truncated away.
	 */
	modifiers?: number;
}

export interface TerminalSessionEventMap {
	/** A decoded `terminal.frame`. `bytes` is the raw ANSI payload. */
	frame: [bytes: Uint8Array, meta: FrameMeta];
	/** `terminal.closed` from herdr. The process usually exits right after. */
	closed: [reason: string];
	/** Spawn failure, protocol violation, or an oversized line. Never fatal by itself. */
	error: [error: Error];
	/** One line of the child's stderr, verbatim. Non-JSON noise lands here. */
	stderr: [line: string];
	/** The child is gone. Always the last event. */
	exit: [code: number | null, signal: NodeJS.Signals | null];
}

type Listener<K extends keyof TerminalSessionEventMap> = (
	...args: TerminalSessionEventMap[K]
) => void;

/** Storage type for the listener table; call sites re-narrow with `Listener<K>`. */
type AnyListener = (...args: unknown[]) => void;

/**
 * Splits a byte stream into NDJSON lines without quadratic re-concatenation and
 * without letting an unterminated line grow without bound.
 */
export class LineSplitter {
	private pending: Buffer[] = [];
	private pendingBytes = 0;

	constructor(private readonly maxLineBytes: number = MAX_LINE_BYTES) {}

	/**
	 * @returns complete lines (without the newline), trailing `\r` stripped.
	 * @throws if a single line exceeds the budget; the splitter then resets so the
	 *   stream can resynchronise on the next newline.
	 */
	push(chunk: Buffer): string[] {
		const lines: string[] = [];
		let offset = 0;
		let newline = chunk.indexOf(0x0a, offset);
		while (newline !== -1) {
			const tail = chunk.subarray(offset, newline);
			lines.push(this.take(tail));
			offset = newline + 1;
			newline = chunk.indexOf(0x0a, offset);
		}
		if (offset < chunk.length) {
			const rest = chunk.subarray(offset);
			this.pending.push(rest);
			this.pendingBytes += rest.length;
			if (this.pendingBytes > this.maxLineBytes) {
				const overflow = this.pendingBytes;
				this.reset();
				throw new Error(
					`terminal bridge line exceeded ${this.maxLineBytes} bytes (${overflow}); dropped`,
				);
			}
		}
		return lines;
	}

	/** Whatever is buffered after the stream ends, if it is not empty. */
	flush(): string | null {
		if (this.pendingBytes === 0) return null;
		const line = this.take(Buffer.alloc(0));
		return line.length > 0 ? line : null;
	}

	reset(): void {
		this.pending = [];
		this.pendingBytes = 0;
	}

	private take(tail: Buffer): string {
		let line: string;
		if (this.pendingBytes === 0) {
			line = tail.toString('utf8');
		} else {
			this.pending.push(tail);
			line = Buffer.concat(this.pending, this.pendingBytes + tail.length).toString('utf8');
		}
		this.reset();
		return line.endsWith('\r') ? line.slice(0, -1) : line;
	}
}

/** Builds the argv the bridge spawns. Exported so callers can log or test it. */
export function buildArgv(options: TerminalSessionOptions): string[] {
	if (options.command.length === 0) {
		throw new Error('terminal bridge needs a command (the herdr binary argv)');
	}
	const argv = [...options.command, 'terminal', 'session', options.mode, options.target];
	if (options.mode === 'control' && options.takeover) argv.push('--takeover');
	argv.push('--cols', String(clampDimension(options.cols)));
	argv.push('--rows', String(clampDimension(options.rows)));
	return argv;
}

function clampDimension(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(65535, Math.max(1, Math.trunc(value)));
}

/**
 * One bridge process. Create, listen, and always `dispose()` — the class owns the
 * child and guarantees it is not left running.
 */
export class TerminalSession {
	private child: ChildProcessWithoutNullStreams | null = null;
	private readonly listeners = new Map<string, Set<AnyListener>>();
	private readonly stdoutSplitter = new LineSplitter();
	private readonly stderrSplitter = new LineSplitter(1024 * 1024);
	private readonly timers = new Set<ReturnType<typeof setTimer>>();
	private readonly options: TerminalSessionOptions;
	private started = false;
	private exited = false;
	private disposed = false;
	private releasing: Promise<void> | null = null;
	private lastCols: number;
	private lastRows: number;

	constructor(options: TerminalSessionOptions) {
		this.options = options;
		this.lastCols = clampDimension(options.cols);
		this.lastRows = clampDimension(options.rows);
	}

	get mode(): TerminalSessionMode {
		return this.options.mode;
	}

	/** True while the child is alive and its stdin can take commands. */
	get writable(): boolean {
		return (
			this.options.mode === 'control' &&
			!this.exited &&
			!this.disposed &&
			this.child !== null &&
			this.child.stdin.writable
		);
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get argv(): string[] {
		return buildArgv(this.options);
	}

	on<K extends keyof TerminalSessionEventMap>(event: K, listener: Listener<K>): this {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set<AnyListener>();
			this.listeners.set(event, set);
		}
		set.add(listener as unknown as AnyListener);
		return this;
	}

	off<K extends keyof TerminalSessionEventMap>(event: K, listener: Listener<K>): this {
		this.listeners.get(event)?.delete(listener as unknown as AnyListener);
		return this;
	}

	/** Spawns the child. Safe to call once; later calls are ignored. */
	start(): this {
		if (this.started || this.disposed) return this;
		this.started = true;
		let child: ChildProcessWithoutNullStreams;
		try {
			const [file, ...rest] = this.argv;
			if (file === undefined) throw new Error('terminal bridge has no command to spawn');
			child = spawn(file, rest, {
				cwd: this.options.cwd,
				env: this.options.env,
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch (err) {
			this.exited = true;
			this.emit('error', asError(err));
			this.emit('exit', null, null);
			return this;
		}
		this.child = child;

		child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
		child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk));
		// A dead controller must not take the plugin down with EPIPE.
		child.stdin.on('error', (err: Error) => this.emit('error', err));
		child.on('error', (err: Error) => this.emit('error', err));
		child.on('close', (code, signal) => {
			this.exited = true;
			this.child = null;
			this.clearTimers();
			const trailing = this.stdoutSplitter.flush();
			if (trailing) this.handleLine(trailing);
			const trailingErr = this.stderrSplitter.flush();
			if (trailingErr) this.emit('stderr', trailingErr);
			this.emit('exit', code, signal);
		});
		return this;
	}

	/** Sends text (or raw bytes) as `terminal.input`. No-op outside control mode. */
	input(data: string | Uint8Array): boolean {
		if (typeof data === 'string') {
			if (data.length === 0) return this.writable;
			return this.send({ type: 'terminal.input', text: data });
		}
		if (data.byteLength === 0) return this.writable;
		return this.send({
			type: 'terminal.input',
			bytes: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'),
		});
	}

	/** Sends `terminal.resize`. Observers never resize (PRD section 7). */
	resize(cols: number, rows: number, cellWidthPx?: number, cellHeightPx?: number): boolean {
		const c = clampDimension(cols);
		const r = clampDimension(rows);
		this.lastCols = c;
		this.lastRows = r;
		const message: Record<string, unknown> = { type: 'terminal.resize', cols: c, rows: r };
		if (cellWidthPx !== undefined) message.cell_width_px = Math.max(0, Math.trunc(cellWidthPx));
		if (cellHeightPx !== undefined) message.cell_height_px = Math.max(0, Math.trunc(cellHeightPx));
		return this.send(message);
	}

	/** The size last requested, so a view can restore it after a restart. */
	get size(): { cols: number; rows: number } {
		return { cols: this.lastCols, rows: this.lastRows };
	}

	/** Sends `terminal.scroll`. */
	scroll(direction: ScrollDirection, lines: number, options: ScrollOptions = {}): boolean {
		const message: Record<string, unknown> = {
			type: 'terminal.scroll',
			direction,
			lines: clampDimension(lines),
		};
		if (options.source !== undefined) message.source = options.source;
		if (options.column !== undefined) message.column = Math.max(0, Math.trunc(options.column));
		if (options.row !== undefined) message.row = Math.max(0, Math.trunc(options.row));
		if (options.modifiers !== undefined) message.modifiers = Math.max(0, Math.trunc(options.modifiers));
		return this.send(message);
	}

	/**
	 * Hands the terminal back: writes `terminal.release`, waits a short grace for a
	 * clean exit, then SIGTERM, then SIGKILL. Resolves when the child is gone.
	 * Idempotent — concurrent calls share one attempt.
	 */
	release(): Promise<void> {
		if (this.releasing) return this.releasing;
		this.releasing = this.doRelease();
		return this.releasing;
	}

	/** Idempotent teardown. Releases the child, then drops all listeners. */
	async dispose(): Promise<void> {
		if (this.disposed) {
			await this.releasing;
			return;
		}
		this.disposed = true;
		try {
			await this.release();
		} finally {
			this.clearTimers();
			this.listeners.clear();
		}
	}

	private async doRelease(): Promise<void> {
		const child = this.child;
		if (!child || this.exited) {
			this.clearTimers();
			return;
		}
		const exited = this.waitForExit();
		if (this.options.mode === 'control' && child.stdin.writable) {
			this.writeLine({ type: 'terminal.release' });
		}
		try {
			child.stdin.end();
		} catch {
			/* already closed */
		}
		if (await raceTimeout(exited, this.options.releaseGraceMs ?? DEFAULT_RELEASE_GRACE_MS, this)) {
			return;
		}
		this.signal('SIGTERM');
		if (await raceTimeout(exited, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, this)) {
			return;
		}
		this.signal('SIGKILL');
		await exited;
	}

	private waitForExit(): Promise<void> {
		if (this.exited || !this.child) return Promise.resolve();
		const child = this.child;
		return new Promise<void>((resolve) => {
			if (this.exited) {
				resolve();
				return;
			}
			child.once('close', () => resolve());
		});
	}

	private signal(sig: NodeJS.Signals): void {
		const child = this.child;
		if (!child || this.exited) return;
		try {
			child.kill(sig);
		} catch (err) {
			this.emit('error', asError(err));
		}
	}

	private send(message: Record<string, unknown>): boolean {
		if (!this.writable) return false;
		return this.writeLine(message);
	}

	private writeLine(message: Record<string, unknown>): boolean {
		const child = this.child;
		if (!child) return false;
		try {
			// herdr reads stdin line by line; one compact object per line.
			child.stdin.write(`${JSON.stringify(message)}\n`);
			return true;
		} catch (err) {
			this.emit('error', asError(err));
			return false;
		}
	}

	private onStdout(chunk: Buffer): void {
		let lines: string[];
		try {
			lines = this.stdoutSplitter.push(chunk);
		} catch (err) {
			this.emit('error', asError(err));
			return;
		}
		for (const line of lines) this.handleLine(line);
	}

	private onStderr(chunk: Buffer): void {
		let lines: string[];
		try {
			lines = this.stderrSplitter.push(chunk);
		} catch (err) {
			this.emit('error', asError(err));
			return;
		}
		// herdr logs plain text here; surface it, never try to parse it.
		for (const line of lines) {
			if (line.trim().length > 0) this.emit('stderr', line);
		}
	}

	private handleLine(line: string): void {
		if (line.trim().length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Tolerant parsing (PRD N-rules): a non-JSON stdout line is noise, not a crash.
			this.emit('error', new Error(`terminal bridge ignored non-JSON stdout line: ${clip(line)}`));
			return;
		}
		if (typeof parsed !== 'object' || parsed === null) return;
		const record = parsed as Record<string, unknown>;
		switch (record.type) {
			case 'terminal.frame': {
				const bytes = decodeBase64(record.bytes);
				if (!bytes) {
					this.emit('error', new Error('terminal bridge frame had no decodable bytes'));
					return;
				}
				this.emit('frame', bytes, {
					seq: numberOr(record.seq, 0),
					encoding: typeof record.encoding === 'string' ? record.encoding : 'ansi',
					width: numberOr(record.width, this.lastCols),
					height: numberOr(record.height, this.lastRows),
					full: record.full === true,
				});
				return;
			}
			case 'terminal.closed':
				this.emit('closed', typeof record.reason === 'string' ? record.reason : 'closed');
				return;
			default:
				// Unknown envelope types are ignored on purpose (forward compatibility).
				return;
		}
	}

	private emit<K extends keyof TerminalSessionEventMap>(
		event: K,
		...args: TerminalSessionEventMap[K]
	): void {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const listener of [...set]) {
			try {
				(listener as unknown as Listener<K>)(...args);
			} catch (err) {
				if (event !== 'error') this.emit('error', asError(err));
			}
		}
	}

	private clearTimers(): void {
		for (const timer of this.timers) clearTimer(timer);
		this.timers.clear();
	}

	/** @internal used by raceTimeout so no timer outlives the session. */
	trackTimer(timer: ReturnType<typeof setTimer>): void {
		this.timers.add(timer);
	}

	/** @internal */
	untrackTimer(timer: ReturnType<typeof setTimer>): void {
		this.timers.delete(timer);
	}
}

/** Resolves true if `promise` settled within `ms`, false on timeout. */
function raceTimeout(promise: Promise<void>, ms: number, session: TerminalSession): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const timer = setTimer(() => {
			session.untrackTimer(timer);
			resolve(false);
		}, ms);
		session.trackTimer(timer);
		void promise.then(() => {
			clearTimer(timer);
			session.untrackTimer(timer);
			resolve(true);
		});
	});
}

/**
 * A copy, never a view. Node allocates buffers under 4 KB out of one shared 8 KB
 * pool, so a `Uint8Array` view on `Buffer.from(...)` keeps the whole slab alive
 * for as long as anyone holds the frame — 8 KB pinned for an average 945 B frame
 * (notes/memory.md, suspect 3). Nothing retains frames today; the copy is what
 * keeps that true for the next consumer.
 */
function decodeBase64(value: unknown): Uint8Array | null {
	if (typeof value !== 'string') return null;
	const buf = Buffer.from(value, 'base64');
	const out = new Uint8Array(buf.byteLength);
	out.set(buf);
	return out;
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

function clip(line: string): string {
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
