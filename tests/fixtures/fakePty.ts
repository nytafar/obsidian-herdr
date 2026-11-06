/**
 * A fake `script` pty for the `claude` kind's terminal tests (ADR-0007's
 * D2): the watchdog child the plugin spawns, its fd-3 pipe, and the tools a
 * pty asks the OS for (`findSlave`, `stty`, signals), all in memory.
 *
 * With `tui: true` the program behaves like Claude 2.1.318's TUI as measured
 * under `script`: it paints in the alternate screen and sends the OSC 7501
 * probe; once the probe is answered it reports `idle`; a line typed and
 * Enter is a turn (`working`, then `done`); SIGTERM reports `clear` and
 * exits 143. `Esc` while working ends the turn.
 */

import type { ClaudeTimers } from '../../src/claude/process';
import type { PtyChild, PtySlave, PtySpawn, PtyTools } from '../../src/claude/pty';

type Handler = (...args: never[]) => void;

export const PROBE_REPLY_PREFIX = '\x1b]7501;?:';

export class FakePtyChild implements PtyChild {
	readonly input: string[] = [];
	watchdogClosed = false;
	exited = false;
	private readonly handlers = new Map<string, Handler[]>();
	private typed = '';
	private working = false;
	/** Set by the owner: what an input or the watchdog's EOF does. */
	onInput: ((data: string) => void) | null = null;
	onWatchdogClosed: (() => void) | null = null;

	constructor(
		readonly pid: number,
		readonly argv: readonly string[],
		readonly cwd: string,
		readonly env: NodeJS.ProcessEnv,
		private readonly behaviour: { tui: boolean; quitOnWatchdog: boolean },
	) {}

	stdin = {
		write: (chunk: string | Uint8Array): boolean => {
			const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('latin1');
			this.input.push(text);
			this.onInput?.(text);
			if (this.behaviour.tui) this.tuiInput(text);
			return true;
		},
		on: (): unknown => undefined,
	};

	stdout = {
		on: (_event: 'data', handler: (chunk: Buffer) => void): unknown => this.add('data', handler),
	};

	stderr = {
		on: (_event: 'data', handler: (chunk: Buffer) => void): unknown => this.add('stderr', handler),
	};

	watchdog = {
		destroy: (): void => {
			if (this.watchdogClosed) return;
			this.watchdogClosed = true;
			this.onWatchdogClosed?.();
			if (this.behaviour.quitOnWatchdog) setTimeout(() => this.exit(143), 1);
		},
	};

	on(event: 'exit' | 'error', handler: Handler): unknown {
		return this.add(event, handler);
	}

	/** Output from the program, as the pty's master reads it. */
	emit(text: string): void {
		for (const handler of this.handlers.get('data') ?? []) {
			(handler as (chunk: Buffer) => void)(Buffer.from(text, 'utf8'));
		}
	}

	exit(code: number | null, signal: string | null = null): void {
		if (this.exited) return;
		this.exited = true;
		for (const handler of this.handlers.get('exit') ?? []) {
			(handler as (code: number | null, signal: string | null) => void)(code, signal);
		}
	}

	/** The TUI's answer to a signal at its own pid. */
	signal(signal: NodeJS.Signals): void {
		if (!this.behaviour.tui || this.exited) return;
		if (signal === 'SIGTERM' || signal === 'SIGHUP' || signal === 'SIGKILL') {
			setTimeout(() => {
				this.emit('\x1b]7501;state=clear:app=claude-code\x1b\\');
				this.exit(signal === 'SIGKILL' ? null : 143, signal === 'SIGKILL' ? 'SIGKILL' : null);
			}, 1);
		}
	}

	/** Starts the program: the paint and the probe, as Claude does. */
	boot(): void {
		if (!this.behaviour.tui) return;
		setTimeout(() => {
			this.emit('\x1b[?1049h\x1b[2J\x1b[HClaude Code (fake)\r\n\x1b]7501;?\x1b\\');
		}, 1);
	}

	private tuiInput(text: string): void {
		if (text.startsWith(PROBE_REPLY_PREFIX)) {
			setTimeout(() => this.emit('\x1b]7501;state=idle:app=claude-code\x1b\\'), 1);
			return;
		}
		if (text === '\x1b' && this.working) {
			this.working = false;
			setTimeout(() => this.emit('\x1b]7501;state=idle:app=claude-code\x1b\\'), 1);
			return;
		}
		this.typed += text;
		if (!this.typed.includes('\r')) return;
		const line = this.typed.split('\r')[0] ?? '';
		this.typed = '';
		this.working = true;
		setTimeout(() => this.emit(`\r\n> ${line}\r\n\x1b]7501;state=working:app=claude-code\x1b\\`), 1);
		// SLOW runs until Esc, like the stream fake's.
		if (line.includes('SLOW')) return;
		setTimeout(() => {
			if (!this.working) return;
			this.working = false;
			this.emit('answer\r\n\x1b]7501;state=done:app=claude-code\x1b\\');
		}, 20);
	}

	private add(event: string, handler: Handler): unknown {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return this;
	}
}

export interface FakePtyOptions {
	/** The program acts like Claude's TUI (else it stays silent until told). */
	tui?: boolean;
	/** The watchdog ends the child when its pipe closes (else only SIGKILL does). */
	quitOnWatchdog?: boolean;
	/** The program ignores its stop signal, so the stop has to go further. */
	ignoreSignals?: boolean;
	/** No slave can be found (no `/proc`, say). */
	noSlave?: boolean;
}

export class FakePty {
	readonly children: FakePtyChild[] = [];
	readonly runs: string[][] = [];
	readonly kills: [number, NodeJS.Signals][] = [];
	private nextPid = 1000;

	constructor(private readonly options: FakePtyOptions = {}) {}

	readonly spawn: PtySpawn = (argv, spawnOptions) => {
		const child = new FakePtyChild(this.nextPid, argv, spawnOptions.cwd, spawnOptions.env, {
			tui: this.options.tui === true,
			quitOnWatchdog: this.options.quitOnWatchdog !== false,
		});
		this.nextPid += 10;
		this.children.push(child);
		child.boot();
		return child;
	};

	readonly tools: PtyTools = {
		findSlave: (pid): Promise<PtySlave | null> =>
			Promise.resolve(this.options.noSlave ? null : { pid: pid + 2, tty: `/dev/pts/${pid - 990}` }),
		run: (argv) => {
			this.runs.push([...argv]);
			return Promise.resolve();
		},
		kill: (pid, signal) => {
			this.kills.push([pid, signal]);
			if (this.options.ignoreSignals && signal !== 'SIGKILL') return;
			const child = this.children.find((each) => each.pid === Math.abs(pid) || each.pid + 2 === pid);
			if (!child) return;
			if (pid < 0 && signal === 'SIGKILL') setTimeout(() => child.exit(null, 'SIGKILL'), 1);
			else child.signal(signal);
			if (!this.options.tui && !child.exited && signal !== 'SIGKILL') setTimeout(() => child.exit(129), 1);
		},
	};

	get last(): FakePtyChild {
		const child = this.children.at(-1);
		if (!child) throw new Error('nothing was spawned');
		return child;
	}

	/** The `stty` resizes, as `[cols, rows]`. */
	get resizes(): [number, number][] {
		return this.runs
			.filter((argv) => argv[0] === 'stty')
			.map((argv) => [Number(argv[argv.indexOf('cols') + 1]), Number(argv[argv.indexOf('rows') + 1])]);
	}
}

/** Timers the test fires by hand, in order of when they are due. */
export class ManualTimers implements ClaudeTimers {
	private pending: { at: number; handler: () => void; id: number }[] = [];
	private now = 0;
	private seq = 0;

	setTimeout(handler: () => void, ms: number): unknown {
		const id = ++this.seq;
		this.pending.push({ at: this.now + ms, handler, id });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.pending = this.pending.filter((timer) => timer.id !== handle);
	}

	/** Delays scheduled now, in ms. */
	get delays(): number[] {
		return this.pending.map((timer) => timer.at - this.now);
	}

	/** Runs the next timer due. */
	fireNext(): void {
		this.pending.sort((a, b) => a.at - b.at);
		const next = this.pending.shift();
		if (!next) throw new Error('no timer pending');
		this.now = next.at;
		next.handler();
	}
}
