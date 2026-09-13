/**
 * The pane terminal lifecycle (issue #83), driven through its own interface.
 *
 * Everything it owns is injected — the session factory, the renderer factory,
 * the scheduler and the host — so the races that used to be smoke-tested by
 * hand run here instead: a suspend landing inside a start, a reveal landing
 * inside a release, a mount finishing after its renderer was given up, and a
 * connection arriving after a start had already given up on one.
 *
 * The fakes are deliberately step-controlled. `FakeRenderer` can hold its
 * mount open and `FakeSession` can hold its `dispose()` open, which is what
 * makes an interleaving expressible at all: the lifecycle's `await` points are
 * exactly those two.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	PaneTerminal,
	type PaneIdentity,
	type PaneSession,
	type PaneTerminalHost,
	type PaneTerminalScheduler,
	type StatusLine,
} from '../src/views/paneTerminal';
import type {
	TerminalSessionEventMap,
	TerminalSessionOptions,
} from '../src/bridge/terminalSession';
import type {
	FitResult,
	RendererOptions,
	TerminalRenderer,
	Unsubscribe,
} from '../src/views/renderer/TerminalRenderer';
import type { Endpoint } from '../src/connection';

/** A promise plus the handle that settles it, for holding an await open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * Lets the lifecycle's own awaits run. A start is parked on `renderer.mount()`
 * after one of these, which is where every interesting race lands.
 */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

const LOCAL: Endpoint = {
	id: 'local',
	remote: {
		enabled: false,
		host: '',
		remoteSocketPath: '',
		remoteBinary: '',
		remoteVaultPath: '',
	},
};

class FakeRenderer implements TerminalRenderer {
	readonly writes: string[] = [];
	mountedOn: unknown = null;
	disposed = 0;
	focused = 0;
	dataCallbacks = 0;
	keyCallbacks = 0;
	wheelCallbacks = 0;
	fitResult: FitResult = { cols: 100, rows: 40, cellWidthPx: 8, cellHeightPx: 16 };
	/** Lines this renderer claims to hold when it is snapshotted. */
	lines: string[] = [];
	private readonly gate = deferred<void>();
	private readonly deferMount: boolean;

	constructor(readonly options: RendererOptions, deferMount = false) {
		this.deferMount = deferMount;
	}

	/** Lets a held-open mount finish. */
	finishMount(): void {
		this.gate.resolve();
	}

	failMount(error: unknown): void {
		this.gate.reject(error);
	}

	mount(el: HTMLElement): Promise<void> {
		this.mountedOn = el;
		return this.deferMount ? this.gate.promise : Promise.resolve();
	}

	write(bytes: Uint8Array): void {
		this.writes.push(new TextDecoder().decode(bytes));
	}

	resize(): void {}

	fit(): FitResult {
		return this.fitResult;
	}

	onData(): Unsubscribe {
		this.dataCallbacks++;
		return () => {};
	}

	onResize(): Unsubscribe {
		return () => {};
	}

	onKeyEvent(): Unsubscribe {
		this.keyCallbacks++;
		return () => {};
	}

	onWheelEvent(): Unsubscribe {
		this.wheelCallbacks++;
		return () => {};
	}

	focus(): void {
		this.focused++;
	}

	snapshotLines(): string[] {
		return this.lines;
	}

	dispose(): void {
		this.disposed++;
	}
}

class FakeSession implements PaneSession {
	started = 0;
	disposed = 0;
	readonly inputs: string[] = [];
	readonly resizes: number[][] = [];
	size: { cols: number; rows: number };
	private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	private release: (() => void) | null = null;

	constructor(readonly options: TerminalSessionOptions) {
		this.size = { cols: options.cols, rows: options.rows };
	}

	get mode(): 'control' | 'observe' {
		return this.options.mode;
	}

	on<K extends keyof TerminalSessionEventMap>(
		event: K,
		listener: (...args: TerminalSessionEventMap[K]) => void,
	): unknown {
		const list = this.listeners.get(event) ?? [];
		list.push(listener as (...args: unknown[]) => void);
		this.listeners.set(event, list);
		return this;
	}

	/** What the bridge would have said; only a live listener hears it. */
	emit(event: keyof TerminalSessionEventMap, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
	}

	start(): unknown {
		this.started++;
		return this;
	}

	input(data: string | Uint8Array): boolean {
		this.inputs.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
		return true;
	}

	resize(cols: number, rows: number, cellWidthPx?: number, cellHeightPx?: number): boolean {
		this.size = { cols, rows };
		this.resizes.push([cols, rows, cellWidthPx ?? 0, cellHeightPx ?? 0]);
		return true;
	}

	scroll(): boolean {
		return true;
	}

	/** Holds the next `dispose()` open until {@link finishDispose}. */
	holdDispose(): void {
		this.release = null;
		this.held = true;
	}

	finishDispose(): void {
		this.held = false;
		this.release?.();
		this.release = null;
	}

	private held = false;

	dispose(): Promise<void> {
		this.disposed++;
		if (!this.held) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.release = resolve;
		});
	}
}

class FakeScheduler implements PaneTerminalScheduler {
	private nextHandle = 1;
	readonly frames = new Map<number, () => void>();
	readonly timers = new Map<number, () => void>();

	requestAnimationFrame = (callback: () => void): number => {
		const handle = this.nextHandle++;
		this.frames.set(handle, callback);
		return handle;
	};

	cancelAnimationFrame = (handle: number): void => {
		this.frames.delete(handle);
	};

	setTimeout = (callback: () => void): number => {
		const handle = this.nextHandle++;
		this.timers.set(handle, callback);
		return handle;
	};

	clearTimeout = (handle: number): void => {
		this.timers.delete(handle);
	};

	/** Everything still scheduled: zero is what a clean teardown looks like. */
	get pending(): number {
		return this.frames.size + this.timers.size;
	}

	runFrames(): void {
		for (const [handle, callback] of [...this.frames]) {
			this.frames.delete(handle);
			callback();
		}
	}

	runTimers(): void {
		for (const [handle, callback] of [...this.timers]) {
			this.timers.delete(handle);
			callback();
		}
	}
}

interface HarnessOptions {
	identity?: Partial<PaneIdentity>;
	/** Renderers created from this point on hold their mount open. */
	deferMounts?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const scheduler = new FakeScheduler();
	const renderers: FakeRenderer[] = [];
	const sessions: FakeSession[] = [];
	const statuses: StatusLine[] = [];
	const started: number[] = [];
	const identityChanges: boolean[] = [];
	const rendererErrors: unknown[] = [];
	const state = {
		deferMounts: options.deferMounts ?? false,
		endpoint: LOCAL as Endpoint | null,
		command: ['/usr/bin/herdr'] as string[] | null,
		connected: true,
	};
	const hostEl = { empty: vi.fn() } as unknown as HTMLElement;

	const host: PaneTerminalHost = {
		rendererOptions: () => ({ engine: 'ghostty-web' }),
		cursorOptions: () => ({ cursorStyle: 'block', cursorBlink: false }),
		env: () => ({ PATH: '/usr/bin' }),
		endpointFor: () => state.endpoint,
		commandFor: () => {
			if (!state.command) throw new Error('herdr binary not found');
			return state.command;
		},
		connected: () => state.connected,
		perfEnabled: () => false,
		onStatus: (line) => statuses.push(line),
		onStarted: () => started.push(renderers.length),
		onRendererError: (error) => rendererErrors.push(error),
		onIdentityChanged: ({ switchedPane }) => identityChanges.push(switchedPane),
	};

	const terminal = new PaneTerminal({
		identity: {
			paneId: 'w4:p1',
			mode: 'control',
			endpointId: 'local',
			...options.identity,
		},
		host,
		scheduler,
		createSession: (sessionOptions) => {
			const session = new FakeSession(sessionOptions);
			sessions.push(session);
			return session;
		},
		createRenderer: (rendererOptions) => {
			const renderer = new FakeRenderer(rendererOptions, state.deferMounts);
			renderers.push(renderer);
			return renderer;
		},
		macOS: false,
	});

	return {
		terminal,
		scheduler,
		renderers,
		sessions,
		statuses,
		started,
		identityChanges,
		rendererErrors,
		state,
		hostEl,
		/** The renderer at `index`, asserted to exist. */
		renderer: (index = 0): FakeRenderer => {
			const renderer = renderers[index];
			if (!renderer) throw new Error(`no renderer ${index}`);
			return renderer;
		},
		session: (index = 0): FakeSession => {
			const session = sessions[index];
			if (!session) throw new Error(`no session ${index}`);
			return session;
		},
		lastStatus: (): StatusLine => {
			const line = statuses.at(-1);
			if (!line) throw new Error('no status yet');
			return line;
		},
	};
}

function frame(text: string, seq = 1, full = false): [Uint8Array, { seq: number; encoding: string; width: number; height: number; full: boolean }] {
	return [new TextEncoder().encode(text), { seq, encoding: 'ansi', width: 100, height: 40, full }];
}

describe('PaneTerminal.attach', () => {
	it('mounts the renderer and spawns the bridge through the injected factories', async () => {
		const h = harness();
		await h.terminal.attach(h.hostEl);

		expect(h.renderers).toHaveLength(1);
		expect(h.renderer().mountedOn).toBe(h.hostEl);
		expect(h.renderer().dataCallbacks).toBe(1);
		expect(h.sessions).toHaveLength(1);
		expect(h.session().options).toMatchObject({
			command: ['/usr/bin/herdr'],
			target: 'w4:p1',
			mode: 'control',
			takeover: true,
			cols: 100,
			rows: 40,
		});
		expect(h.session().started).toBe(1);
		// Control mode adds the cell metrics the spawn argv could not carry.
		expect(h.session().resizes).toEqual([[100, 40, 8, 16]]);
		expect(h.renderer().focused).toBe(1);
		expect(h.started).toEqual([1]);
		expect(h.lastStatus().text).toBe('Controlling this pane on local.');
	});

	it('starts nothing without a pane id', async () => {
		const h = harness({ identity: { paneId: '' } });
		await h.terminal.attach(h.hostEl);
		expect(h.renderers).toHaveLength(0);
		expect(h.sessions).toHaveLength(0);
	});

	it('writes a frame into the renderer once per animation frame', async () => {
		const h = harness();
		await h.terminal.attach(h.hostEl);

		h.session().emit('frame', ...frame('one'));
		h.session().emit('frame', ...frame('two', 2));
		expect(h.renderer().writes).toEqual([]);
		h.scheduler.runFrames();
		expect(h.renderer().writes).toEqual(['onetwo']);
	});

	it('reports what the bridge says through the status hook', async () => {
		const h = harness();
		await h.terminal.attach(h.hostEl);

		h.session().emit('stderr', 'ssh: connect to host xl port 22: No route to host');
		expect(h.lastStatus().detail).toContain('No route to host');
		h.session().emit('closed', 'taken over');
		expect(h.lastStatus()).toMatchObject({
			text: 'Session closed: taken over. Reconnect to attach again.',
			warning: true,
		});
	});
});

describe('PaneTerminal generation races', () => {
	it('a suspend during a start gives the renderer back and spawns nothing', async () => {
		const h = harness({ deferMounts: true });
		const attaching = h.terminal.attach(h.hostEl);
		await settle();
		// The leaf was hidden before its first mount finished.
		await h.terminal.setVisible(false);
		h.renderer().finishMount();
		await attaching;

		expect(h.sessions).toHaveLength(0);
		expect(h.renderer().disposed).toBe(1);
		// The continuation of a mount nobody waited for installs nothing.
		expect(h.renderer().dataCallbacks).toBe(0);
		expect(h.renderer().keyCallbacks).toBe(0);
	});

	it('a reveal during the release restarts once and keeps the renderer', async () => {
		const h = harness();
		await h.terminal.attach(h.hostEl);
		h.session(0).holdDispose();

		const suspending = h.terminal.setVisible(false);
		// The user came back while the child was still going down.
		const resuming = h.terminal.setVisible(true);
		h.session(0).finishDispose();
		await Promise.all([suspending, resuming]);

		expect(h.session(0).disposed).toBe(1);
		expect(h.sessions).toHaveLength(2);
		expect(h.session(1).started).toBe(1);
		// The suspend that lost the race must not dispose the renderer the
		// reveal is now painting into.
		expect(h.renderers).toHaveLength(1);
		expect(h.renderer().disposed).toBe(0);
	});

	it('ignores frames from a session an earlier generation left behind', async () => {
		const h = harness();
		await h.terminal.attach(h.hostEl);
		const stale = h.session(0);
		await h.terminal.reconnect();

		stale.emit('frame', ...frame('ghost'));
		stale.emit('closed', 'detached');
		h.scheduler.runFrames();

		expect(h.renderer().writes).toEqual([]);
		expect(h.lastStatus().text).toBe('Controlling this pane on local.');

		h.session(1).emit('frame', ...frame('live'));
		h.scheduler.runFrames();
		expect(h.renderer().writes).toEqual(['live']);
	});

	it('starts once when the connection arrives after the start gave up', async () => {
		const h = harness();
		h.state.command = null;
		h.state.connected = false;
		await h.terminal.attach(h.hostEl);

		expect(h.sessions).toHaveLength(0);
		expect(h.lastStatus().text).toBe(
			'Session closed: waiting for herdr. Reconnect to attach again.',
		);

		h.state.command = ['/usr/bin/herdr'];
		h.state.connected = true;
		await h.terminal.connectionArrived();
		expect(h.sessions).toHaveLength(1);

		// A later connection to some other endpoint must not respawn this bridge.
		await h.terminal.connectionArrived();
		expect(h.sessions).toHaveLength(1);
	});

	it('reports the endpoint itself when herdr was found but the endpoint is gone', async () => {
		const h = harness();
		h.state.endpoint = null;
		await h.terminal.attach(h.hostEl);

		expect(h.sessions).toHaveLength(0);
		expect(h.lastStatus().text).toContain('the endpoint local is no longer configured');
		// Not a "waiting for herdr" case, so a connection does not retry it.
		await h.terminal.connectionArrived();
		expect(h.sessions).toHaveLength(0);
	});
});

describe('PaneTerminal mount and dispose races', () => {
	it('a detach during the mount installs no callbacks and leaves nothing scheduled', async () => {
		const h = harness({ deferMounts: true });
		const attaching = h.terminal.attach(h.hostEl);
		await settle();
		await h.terminal.detach();
		h.renderer().finishMount();
		await attaching;

		expect(h.renderer().dataCallbacks).toBe(0);
		expect(h.renderer().wheelCallbacks).toBe(0);
		expect(h.renderer().disposed).toBe(1);
		expect(h.sessions).toHaveLength(0);
		expect(h.scheduler.pending).toBe(0);
	});

	it('a stale mount continuation replays no snapshot into the renderer it lost', async () => {
		const h = harness();
		await h.terminal.attach(h.hostEl);
		h.renderer(0).lines = ['first screen'];

		// Hidden long enough to be given up; the scrollback is carried as text.
		await h.terminal.setVisible(false);
		expect(h.renderer(0).disposed).toBe(1);

		// Revealed: the second renderer is still mounting when the leaf is
		// hidden again, and a third one takes over on the next reveal.
		h.state.deferMounts = true;
		const revealing = h.terminal.setVisible(true);
		await settle();
		h.renderer(1).lines = ['second screen'];
		await h.terminal.setVisible(false);
		h.state.deferMounts = false;
		await h.terminal.setVisible(true);

		h.renderer(1).finishMount();
		await revealing;

		expect(h.renderers).toHaveLength(3);
		expect(h.renderer(1).dataCallbacks).toBe(0);
		expect(h.renderer(1).writes).toEqual([]);
		// The live renderer replayed what the terminal held, line by line, once.
		expect(h.renderer(2).writes).toEqual(['second screen\r\n']);
		expect(h.renderer(2).dataCallbacks).toBe(1);
	});

	it('a mount rejection is reported and spawns no bridge', async () => {
		const h = harness({ deferMounts: true });
		const attaching = h.terminal.attach(h.hostEl);
		await settle();
		h.renderer().failMount(new Error('no WebGL'));
		await attaching;

		expect(h.rendererErrors).toHaveLength(1);
		expect(h.sessions).toHaveLength(0);
		expect(h.lastStatus()).toMatchObject({
			text: 'Session closed: the terminal renderer failed to start. Reconnect to attach again.',
			warning: true,
		});
	});

	it('rapid pane switching leaves one bridge, on the pane switched to last', async () => {
		const h = harness();
		await h.terminal.attach(h.hostEl);
		h.session(0).holdDispose();

		const toSecond = h.terminal.setIdentity({
			paneId: 'w4:p2',
			mode: 'control',
			endpointId: 'local',
		});
		const toThird = h.terminal.setIdentity({
			paneId: 'w4:p3',
			mode: 'control',
			endpointId: 'local',
		});
		h.session(0).finishDispose();
		await Promise.all([toSecond, toThird]);

		expect(h.sessions).toHaveLength(2);
		expect(h.session(1).options.target).toBe('w4:p3');
		expect(h.terminal.identity.paneId).toBe('w4:p3');
		expect(h.identityChanges).toEqual([true, true]);
	});

	it('leaves no timer, frame or live session behind after a detach', async () => {
		const h = harness();
		await h.terminal.attach(h.hostEl);

		h.session().emit('frame', ...frame('pending'));
		h.terminal.resize();
		expect(h.scheduler.pending).toBeGreaterThan(0);

		await h.terminal.detach();

		expect(h.scheduler.pending).toBe(0);
		expect(h.session().disposed).toBe(1);
		expect(h.renderer().disposed).toBe(1);

		// And nothing the old session still shouts reaches the renderer.
		h.session().emit('frame', ...frame('after close'));
		h.scheduler.runFrames();
		expect(h.renderer().writes).toEqual([]);
	});
});

describe('PaneTerminal.setIdentity', () => {
	it('clears the previous pane and restarts on a pane switch', async () => {
		const h = harness();
		await h.terminal.attach(h.hostEl);

		await h.terminal.setIdentity({ paneId: 'w4:p9', mode: 'control', endpointId: 'local' });

		// Erase display, then erase scrollback: the previous agent's output is
		// not this agent's.
		expect(h.renderer().writes).toEqual(['[H[2J[3J']);
		expect(h.sessions).toHaveLength(2);
		expect(h.session(1).options.target).toBe('w4:p9');
		expect(h.identityChanges).toEqual([true]);
	});

	it('restarts without clearing when only the mode changed', async () => {
		const h = harness();
		await h.terminal.attach(h.hostEl);

		await h.terminal.setIdentity({ paneId: 'w4:p1', mode: 'observe', endpointId: 'local' });

		expect(h.renderer().writes).toEqual([]);
		expect(h.session(1).options).toMatchObject({ mode: 'observe', takeover: false });
		// An observer never takes the focus and never resizes the pane.
		expect(h.session(1).resizes).toEqual([]);
		expect(h.lastStatus().text).toBe('Observing (read-only) on local.');
		expect(h.identityChanges).toEqual([false]);
	});

	it('does nothing when the identity is the one it already has', async () => {
		const h = harness();
		await h.terminal.attach(h.hostEl);

		await h.terminal.setIdentity({ paneId: 'w4:p1', mode: 'control', endpointId: 'local' });

		expect(h.sessions).toHaveLength(1);
		expect(h.identityChanges).toEqual([]);
	});

	it('takes an identity before the view opens and starts on attach', async () => {
		const h = harness({ identity: { paneId: '' } });
		await h.terminal.setIdentity({ paneId: 'w4:p7', mode: 'control', endpointId: 'local' });
		expect(h.sessions).toHaveLength(0);

		await h.terminal.attach(h.hostEl);
		expect(h.session().options.target).toBe('w4:p7');
	});
});

describe('PaneTerminal.resize', () => {
	it('collapses a burst of resizes into one terminal.resize', async () => {
		const h = harness();
		await h.terminal.attach(h.hostEl);

		h.renderer().fitResult = { cols: 80, rows: 24, cellWidthPx: 8, cellHeightPx: 16 };
		h.terminal.resize();
		h.terminal.resize();
		h.terminal.resize();
		expect(h.scheduler.timers.size).toBe(1);
		h.scheduler.runTimers();

		expect(h.session().resizes).toEqual([
			[100, 40, 8, 16],
			[80, 24, 8, 16],
		]);
	});

	it('tells herdr nothing when the grid did not change', async () => {
		const h = harness();
		await h.terminal.attach(h.hostEl);

		h.terminal.resize();
		h.scheduler.runTimers();

		expect(h.session().resizes).toHaveLength(1);
	});
});
