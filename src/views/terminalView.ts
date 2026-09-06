/**
 * Terminal view (PRD M13, M15, S16, S18; T9).
 *
 * One main-area tab per herdr pane. The view owns three things and nothing else:
 * a `TerminalRenderer` (T8), a `TerminalSession` bridge process (T7), and the
 * plumbing between them —
 *
 *   session `frame`  -> renderer.write   (coalesced to one write per frame)
 *   renderer `onData`-> session.input        (control mode only)
 *   ResizeObserver   -> renderer.fit -> session.resize   (control mode only)
 *   wheel            -> session.scroll
 *
 * A leaf that stays hidden (Obsidian gives an inactive tab `display: none`) is
 * suspended after `HIDE_GRACE_MS`: the session is released back to herdr and the
 * renderer disposed, which is the only way to stop ghostty-web's 60 fps repaint
 * loop and to hand its WASM terminal and canvas back (#15, notes/memory.md). The
 * scrollback is carried across as plain text and written into the new terminal on
 * reveal, before the first frame.
 *
 * Keys and wheel notches go through `InputRouter` (`./input/`, #17) on the way:
 * shift+enter becomes a line break (#18) and every wheel notch becomes a
 * `terminal.scroll` carrying the cell under the pointer, which herdr turns into
 * a mouse report for an application that asked for one (#25). Clicks are still
 * the renderer's, so text selection keeps working; gating them needs a mode
 * signal herdr does not send (notes/herdr-terminal-bridge.md, #33).
 *
 * Attach mode comes from `settings.defaultAttachMode`: control attaches with
 * `--takeover` (PRD M15, the herdr TUI pane then follows Obsidian's size), observe
 * is read-only (PRD S16) and never sends input or resizes. The header actions
 * toggle the mode — which restarts the bridge — and reconnect after a close.
 *
 * Guidelines: no `innerHTML`, no inline styles (see `styles.css`), every listener
 * goes through `registerDomEvent` / `registerEvent` / `register`, and `main.ts`
 * finds this view with `getLeavesOfType` instead of holding a reference.
 *
 * The DOM-free decisions (state parsing, mode -> takeover, wheel maths, the
 * resize debounce, the spawn environment, the status text) live as exported pure
 * functions at the top of this file; `tests/terminalView.test.ts` covers them.
 * The wiring itself needs a canvas and a live herdr, so it is smoke-tested by
 * hand (recipe in `tests/README.md`).
 */

import { ItemView, Notice, setIcon, setTooltip, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type HerdrPlugin from '../main';
import { scrollbackBytes, type AttachMode } from '../settings';
import { terminalArgvPrefix } from '../herdr/ssh';
import {
	TerminalSession,
	type ScrollDirection,
	type TerminalSessionMode,
} from '../bridge/terminalSession';
import { createRenderer } from './renderer/create';
import type { CellCoordinates, TerminalRenderer } from './renderer/TerminalRenderer';
import { InputRouter } from './input/inputRouter';

export const TERMINAL_VIEW_TYPE = 'herdr-terminal';

/** How long a burst of container resizes is collapsed before a `terminal.resize`. */
export const RESIZE_DEBOUNCE_MS = 100;

/** Grid used until the renderer can measure itself (hidden leaf, no metrics yet). */
export const FALLBACK_COLS = 80;
export const FALLBACK_ROWS = 24;

/** Persisted view state. `paneId` is a herdr pane id such as `w4:p1`. */
export interface TerminalViewState {
	paneId: string;
	mode: AttachMode;
}

/**
 * Parses whatever Obsidian hands `setState` (a restored workspace layout may hold
 * anything). Returns null when there is no usable pane id; an unknown mode falls
 * back to control, which is the documented default (PRD M15).
 */
export function parseTerminalState(raw: unknown): TerminalViewState | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const paneId = typeof record.paneId === 'string' ? record.paneId.trim() : '';
	if (paneId.length === 0) return null;
	return { paneId, mode: record.mode === 'observe' ? 'observe' : 'control' };
}

/** True when a leaf's persisted state points at this pane. Used by `main.ts`. */
export function stateMatchesPane(raw: unknown, paneId: string): boolean {
	return parseTerminalState(raw)?.paneId === paneId;
}

/**
 * PRD M15/S16: control attaches with `--takeover` (one controller per terminal,
 * and the user asked for this pane), observe never does — herdr rejects
 * `--takeover` outside control mode anyway.
 */
export function attachFor(mode: AttachMode): { mode: TerminalSessionMode; takeover: boolean } {
	return mode === 'observe'
		? { mode: 'observe', takeover: false }
		: { mode: 'control', takeover: true };
}

/** Injected so the debounce is testable without real timers. */
export interface DebounceTimers {
	setTimeout: (callback: () => void, ms: number) => number;
	clearTimeout: (handle: number) => void;
}

export interface Debounced {
	(): void;
	/** Drops a pending call. Always called from `onClose`. */
	cancel(): void;
}

/**
 * Trailing-edge debounce. A ResizeObserver fires per frame while a split is
 * dragged; herdr must see one `terminal.resize`, not sixty.
 */
export function debounce(fn: () => void, ms: number, timers: DebounceTimers): Debounced {
	let handle: number | null = null;
	return Object.assign(
		(): void => {
			if (handle !== null) timers.clearTimeout(handle);
			handle = timers.setTimeout(() => {
				handle = null;
				fn();
			}, ms);
		},
		{
			cancel: (): void => {
				if (handle === null) return;
				timers.clearTimeout(handle);
				handle = null;
			},
		},
	);
}

/**
 * How long a terminal's leaf must stay hidden before the view gives its renderer
 * and its bridge session back (#15). Long enough that flipping between two tabs
 * costs nothing, short enough that a terminal left in a background tab stops
 * burning a WASM terminal, a dpr-scaled canvas and a 60 fps repaint loop.
 */
export const HIDE_GRACE_MS = 30_000;

/** What a measurement did to the tracker's state. */
export type VisibilityChange = 'hidden' | 'revealed' | null;

/**
 * The hide/reveal decision, with no DOM in it: the view feeds it measurements
 * ("does the host still have a box?") and it decides when the grace period has
 * run out. Timers are injected, like `debounce`, so `tests/terminalView.test.ts`
 * can run the whole state machine without a browser.
 *
 * Obsidian gives an inactive tab's content `display: none`, so a hidden leaf
 * measures 0x0 — that, plus `layout-change` and `onResize`, is how the view
 * finds out. Only transitions matter: a stream of "still hidden" measurements
 * must not keep pushing the deadline out.
 */
export class VisibilityTracker {
	private hiddenNow = false;
	private handle: number | null = null;

	constructor(
		private readonly graceMs: number,
		/** Called once, `graceMs` after the host went away, if it is still away. */
		private readonly onGraceExpired: () => void,
		private readonly timers: DebounceTimers,
	) {}

	get hidden(): boolean {
		return this.hiddenNow;
	}

	/** True while a grace period is running. */
	get pending(): boolean {
		return this.handle !== null;
	}

	/** Feeds one measurement. Returns the transition it caused, or null. */
	update(visible: boolean): VisibilityChange {
		if (visible) {
			if (!this.hiddenNow) return null;
			this.hiddenNow = false;
			this.cancel();
			return 'revealed';
		}
		if (this.hiddenNow) return null;
		this.hiddenNow = true;
		this.arm();
		return 'hidden';
	}

	/**
	 * Starts the grace period when the host is hidden and nothing is pending. The
	 * view calls this after a (re)start too: a reconnect while hidden mounts a new
	 * renderer that nothing would otherwise come back to free.
	 */
	arm(): void {
		if (!this.hiddenNow || this.handle !== null) return;
		this.handle = this.timers.setTimeout(() => {
			this.handle = null;
			this.onGraceExpired();
		}, this.graceMs);
	}

	/** Drops a pending grace period. Idempotent; always called from `onClose`. */
	cancel(): void {
		if (this.handle === null) return;
		this.timers.clearTimeout(this.handle);
		this.handle = null;
	}
}

/**
 * Frames arrive as fast as the pane produces output; a `renderer.write` per frame
 * is a wasm parse, a link-cache flush and a scroll-to-bottom per frame. This holds
 * the bytes until the view flushes them once per animation frame.
 *
 * Two invariants, because a terminal stream is not idempotent: bytes are never
 * reordered or dropped inside what is written, and a `full: true` frame (a
 * complete repaint from herdr) supersedes everything buffered before it.
 */
export class FrameBuffer {
	private chunks: Uint8Array[] = [];
	private bytes = 0;

	push(frame: Uint8Array, full = false): void {
		if (full) this.clear();
		if (frame.length === 0) return;
		this.chunks.push(frame);
		this.bytes += frame.length;
	}

	/** Bytes waiting to be written. */
	get pending(): number {
		return this.bytes;
	}

	/** Everything buffered, in arrival order, as one write. Null when empty. */
	take(): Uint8Array | null {
		if (this.chunks.length === 0) return null;
		const first = this.chunks[0];
		if (this.chunks.length === 1 && first) {
			this.clear();
			return first;
		}
		const out = new Uint8Array(this.bytes);
		let at = 0;
		for (const chunk of this.chunks) {
			out.set(chunk, at);
			at += chunk.length;
		}
		this.clear();
		return out;
	}

	clear(): void {
		this.chunks = [];
		this.bytes = 0;
	}
}

/**
 * A hidden leaf gets no animation frames while the pane keeps streaming, so the
 * buffer is flushed straight away once it grows past this. Bounded memory beats
 * a perfect frame budget.
 */
export const MAX_PENDING_BYTES = 1 << 20;

/** True when someone set `window.herdrPerf` in the dev console. */
function perfEnabled(): boolean {
	return (window as unknown as { herdrPerf?: unknown }).herdrPerf === true;
}

/** Sink for `PerfCounter`; the view passes `console.debug`. */
export type PerfLog = (line: string) => void;

/**
 * Dev-only instrumentation (work item 3 of #24). Off unless someone sets
 * `window.herdrPerf = true` before the view attaches; there is deliberately no
 * command and no setting for it. Reports once a second.
 */
export class PerfCounter {
	private frames = 0;
	private bytes = 0;
	private repaints = 0;
	private since: number;

	constructor(
		private readonly label: string,
		private readonly log: PerfLog,
		private readonly now: () => number = () => Date.now(),
	) {
		this.since = now();
	}

	frame(bytes: number): void {
		this.frames++;
		this.bytes += bytes;
		this.report();
	}

	repaint(): void {
		this.repaints++;
		this.report();
	}

	private report(): void {
		const elapsed = this.now() - this.since;
		if (elapsed < 1000) return;
		const perSecond = (n: number): string => (n / (elapsed / 1000)).toFixed(1);
		this.log(
			`herdr perf ${this.label}: ${perSecond(this.frames)} frames/s, ` +
				`${perSecond(this.bytes)} bytes/s, ${perSecond(this.repaints)} repaints/s`,
		);
		this.frames = 0;
		this.bytes = 0;
		this.repaints = 0;
		this.since = this.now();
	}
}

/** Pixels per scrolled line when the wheel reports `deltaMode: 0` (pixels). */
export const WHEEL_PIXELS_PER_LINE = 24;
/** Upper bound so a trackpad fling cannot ask herdr for thousands of lines. */
export const MAX_SCROLL_LINES = 200;

/**
 * Wheel delta -> `terminal.scroll` payload. `deltaMode` is 0 pixels, 1 lines,
 * 2 pages (DOM_DELTA_*). Returns null for a delta that rounds to nothing.
 */
export function wheelToScroll(
	deltaY: number,
	deltaMode: number,
	rows: number,
): { direction: ScrollDirection; lines: number } | null {
	if (!Number.isFinite(deltaY) || deltaY === 0) return null;
	const page = Math.max(1, Math.trunc(rows) || FALLBACK_ROWS);
	const magnitude = Math.abs(deltaY);
	const raw =
		deltaMode === 2 ? magnitude * page : deltaMode === 1 ? magnitude : magnitude / WHEEL_PIXELS_PER_LINE;
	const lines = Math.min(MAX_SCROLL_LINES, Math.max(1, Math.round(raw)));
	return { direction: deltaY < 0 ? 'up' : 'down', lines };
}

/**
 * PATH for the spawned bridge. Obsidian inherits the launcher's environment, so
 * a GUI launch may not see `~/.local/bin`; the same `extraPath` setting that
 * feeds binary discovery is prepended here (deduplicated, order preserved).
 */
export function spawnEnv(env: NodeJS.ProcessEnv, extraPath: string): NodeJS.ProcessEnv {
	const extra = extraPath
		.split(':')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (extra.length === 0) return { ...env };
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const part of [...extra, ...(env.PATH ?? '').split(':')]) {
		if (part.length === 0 || seen.has(part)) continue;
		seen.add(part);
		parts.push(part);
	}
	return { ...env, PATH: parts.join(':') };
}

/** What the status line shows, derived from the session's last words. */
export interface StatusInput {
	mode: AttachMode;
	/** `terminal.closed` reason, or a locally produced message. */
	closedReason: string | null;
	/** Whether the bridge process is gone. */
	exited: boolean;
	/** Stderr lines seen since the last (re)start, newest last. */
	stderr: readonly string[];
}

export interface StatusLine {
	text: string;
	/** Rendered in the warning colour: something the user probably has to act on. */
	warning: boolean;
	/** Second line: a short stderr summary, or null when stderr stayed quiet. */
	detail: string | null;
}

/**
 * Close reasons no reconnect can fix (notes/herdr-terminal-bridge.md): the pane's
 * process is gone, or the target never existed. Everything else — a takeover, a
 * live-update handoff, a read in progress, our own `detached` — is worth a retry,
 * and an unrecognised reason is treated as retryable rather than final.
 */
const FINAL_REASONS = ['exited', 'not found'];

export function isRecoverable(reason: string | null): boolean {
	if (!reason) return true;
	const lower = reason.toLowerCase();
	return !FINAL_REASONS.some((needle) => lower.includes(needle));
}

/** Sentence-case status text for the strip under the terminal. */
export function statusLine(input: StatusInput): StatusLine {
	const detail = summariseStderr(input.stderr);
	if (input.closedReason) {
		const hint = isRecoverable(input.closedReason) ? ' Reconnect to attach again.' : '';
		return { text: `Session closed: ${input.closedReason}.${hint}`, warning: true, detail };
	}
	if (input.exited) {
		return { text: 'Bridge process exited. Reconnect to attach again.', warning: true, detail };
	}
	return {
		text: input.mode === 'observe' ? 'Observing (read-only).' : 'Controlling this pane.',
		warning: false,
		detail,
	};
}

/** Newest stderr line plus a count of the ones before it; null when empty. */
export function summariseStderr(lines: readonly string[]): string | null {
	const last = lines.at(-1);
	if (!last) return null;
	const clipped = last.length > 200 ? `${last.slice(0, 200)}…` : last;
	return lines.length > 1 ? `${clipped} (+${lines.length - 1} more)` : clipped;
}

/** Stderr is unbounded noise on a broken host; keep only what the summary needs. */
const MAX_STDERR_LINES = 20;

export class TerminalView extends ItemView {
	private readonly plugin: HerdrPlugin;
	private paneId = '';
	private mode: AttachMode;
	private hostEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private toggleActionEl: HTMLElement | null = null;
	private renderer: TerminalRenderer | null = null;
	private rendererReady: Promise<void> | null = null;
	private session: TerminalSession | null = null;
	private closedReason: string | null = null;
	private exited = false;
	private stderr: string[] = [];
	private resizeObserver: ResizeObserver | null = null;
	private scheduleResize: Debounced | null = null;
	/** Hide/reveal state machine; null before `onOpen` and after `onClose`. */
	private visibility: VisibilityTracker | null = null;
	/** True while the renderer and the session are given up for a hidden leaf. */
	private suspended = false;
	/** The last start failed before the plugin had found herdr; retried on connect. */
	private awaitingConnection = false;
	/** Scrollback carried across a suspend, as plain text. Null when there is none. */
	private snapshot: string[] | null = null;
	/** Guards against an old start finishing after a newer one began. */
	private generation = 0;
	private opened = false;
	/** Frame bytes waiting for the next animation frame. */
	private readonly frames = new FrameBuffer();
	/**
	 * Keyboard/mouse/scroll encoding (#17, `src/views/input/`). It watches frames
	 * for the modes the pane's application sets and decides what a key or a wheel
	 * notch becomes: shift+enter is ours (#18), every wheel notch becomes a
	 * `terminal.scroll` with the cell under the pointer (#25), everything else is
	 * left to the renderer.
	 */
	private readonly input = new InputRouter({ wheelToScroll });
	/**
	 * True once the renderer intercepts the wheel, so `onWheel` stands down. Only
	 * meaningful while a renderer exists: a suspended view (#15) has none, and the
	 * host element's own listener is all there is again.
	 */
	private wheelIntercepted = false;
	private flushHandle = 0;
	private perf: PerfCounter | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: HerdrPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.mode = plugin.settings.defaultAttachMode;
	}

	getViewType(): string {
		return TERMINAL_VIEW_TYPE;
	}

	/** Agent name of the pane, falling back to the pane id (PRD M13). */
	getDisplayText(): string {
		const pane = this.paneId ? this.plugin.scope?.get(this.paneId) : undefined;
		return pane?.label || pane?.agent || this.paneId || 'Herdr terminal';
	}

	override getIcon(): string {
		return 'square-terminal';
	}

	override getState(): Record<string, unknown> {
		return { paneId: this.paneId, mode: this.mode };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const parsed = parseTerminalState(state);
		if (!parsed) return;
		const changed = parsed.paneId !== this.paneId || parsed.mode !== this.mode;
		this.paneId = parsed.paneId;
		this.mode = parsed.mode;
		if (changed && this.opened) await this.start();
	}

	protected override async onOpen(): Promise<void> {
		this.opened = true;
		const container = this.contentEl;
		container.empty();
		container.addClass('herdr-terminal-view');
		this.hostEl = container.createDiv({ cls: 'herdr-terminal-host' });
		this.statusEl = container.createDiv({ cls: 'herdr-terminal-status' });

		this.toggleActionEl = this.addAction('eye', 'Switch to observe mode', () => {
			void this.toggleMode();
		});
		this.updateToggleAction();
		this.addAction('refresh-cw', 'Reconnect', () => {
			void this.start();
		});

		this.registerDomEvent(this.hostEl, 'wheel', (event) => this.onWheel(event));
		this.register(
			this.plugin.onScopeReplaced(() => {
				if (this.awaitingConnection) void this.start();
			}),
		);
		// A theme switch changes every colour the renderer was handed (PRD S18).
		this.registerEvent(
			// Optional on the interface: a renderer without it keeps its colours.
			this.app.workspace.on('css-change', () => this.renderer?.refreshTheme?.()),
		);

		this.scheduleResize = debounce(() => this.applyFit(), RESIZE_DEBOUNCE_MS, {
			setTimeout: (cb, ms) => window.setTimeout(cb, ms),
			clearTimeout: (handle) => window.clearTimeout(handle),
		});
		this.register(() => this.scheduleResize?.cancel());

		this.visibility = new VisibilityTracker(HIDE_GRACE_MS, () => void this.suspend(), {
			setTimeout: (cb, ms) => window.setTimeout(cb, ms),
			clearTimeout: (handle) => window.clearTimeout(handle),
		});
		this.register(() => this.visibility?.cancel());
		// A tab that goes to the background has its content hidden rather than
		// resized, so both of these are really "measure the host again".
		this.registerEvent(this.app.workspace.on('layout-change', () => this.checkVisibility()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.checkVisibility()));

		const observer = new ResizeObserver(() => {
			this.checkVisibility();
			this.scheduleResize?.();
		});
		observer.observe(this.hostEl);
		this.resizeObserver = observer;
		this.register(() => {
			observer.disconnect();
			this.resizeObserver = null;
		});

		this.renderStatus();
		if (this.paneId) await this.start();
	}

	protected override async onClose(): Promise<void> {
		this.opened = false;
		this.generation++;
		this.visibility?.cancel();
		this.visibility = null;
		this.snapshot = null;
		this.suspended = false;
		this.cancelFlush();
		this.frames.clear();
		this.perf = null;
		await this.stopSession();
		this.renderer?.dispose();
		this.renderer = null;
		this.rendererReady = null;
		this.hostEl = null;
		this.statusEl = null;
		this.toggleActionEl = null;
		this.contentEl.empty();
	}

	/** Obsidian's own resize hook; the observer covers the rest. */
	override onResize(): void {
		this.checkVisibility();
		this.scheduleResize?.();
	}

	/**
	 * One measurement into the tracker. A hidden leaf's content has `display: none`
	 * and therefore no box at all, so a zero measurement means hidden and anything
	 * else means shown. Cheap enough to call from every resize and layout change.
	 */
	private checkVisibility(): void {
		const host = this.hostEl;
		const tracker = this.visibility;
		if (!host || !tracker) return;
		const visible = host.clientWidth > 0 && host.clientHeight > 0;
		if (tracker.update(visible) === 'revealed') void this.resume();
	}

	/**
	 * The leaf has been hidden for the whole grace period: hand everything back.
	 * Releasing the session tells herdr the terminal is free again (a control-mode
	 * view gives up its takeover), and disposing the renderer is what actually
	 * stops ghostty-web's repaint loop and frees its canvas.
	 */
	private async suspend(): Promise<void> {
		if (!this.opened || this.suspended) return;
		// Belt and braces: a measurement can be missed (a layout change nobody
		// reported), so never suspend a host that has a box right now.
		const host = this.hostEl;
		if (host && host.clientWidth > 0 && host.clientHeight > 0) {
			this.visibility?.update(true);
			return;
		}
		if (!this.renderer && !this.session) {
			this.suspended = true;
			return;
		}
		// Invalidates any `start()` still in flight: it re-checks the generation
		// before it builds a session, so nothing can be spawned behind our back.
		const generation = ++this.generation;
		// Set before the await, so a reveal arriving while the child goes down sees
		// a suspended view and restarts it (which bumps the generation again).
		this.suspended = true;
		this.cancelFlush();
		this.frames.clear();
		this.perf = null;
		await this.stopSession();
		// A reconnect or a reveal raced us; it owns the view now, it has already
		// cleared `suspended`, and the renderer it kept must stay.
		if (generation !== this.generation) return;
		const renderer = this.renderer;
		if (renderer) {
			// Text only: colours, styles and cursor position do not survive this
			// (see `TerminalRenderer.snapshotLines`). Accepted — the alternative is
			// keeping ~5.4 MB of WASM plus a dpr-scaled canvas for a tab nobody is
			// looking at.
			this.snapshot = renderer.snapshotLines?.() ?? null;
			renderer.dispose();
		}
		this.renderer = null;
		this.rendererReady = null;
		this.hostEl?.empty();
	}

	/** The leaf is back: mount a fresh renderer, replay the snapshot, reattach. */
	private async resume(): Promise<void> {
		if (!this.opened || !this.suspended) return;
		this.suspended = false;
		if (!this.paneId) return;
		await this.start();
	}

	/**
	 * (Re)starts the bridge: releases the old session, makes sure the renderer is
	 * mounted, fits it, then spawns `herdr terminal session <mode> <pane>`.
	 */
	private async start(): Promise<void> {
		const paneId = this.paneId;
		const host = this.hostEl;
		if (!paneId || !host) return;
		const generation = ++this.generation;
		// Whatever the reason for this start — reconnect, mode toggle, reveal — the
		// view is live again from here on.
		this.suspended = false;
		await this.stopSession();
		if (generation !== this.generation) return;

		this.closedReason = null;
		this.exited = false;
		this.stderr = [];
		// Bytes from the previous session must never land in the new one's grid.
		this.cancelFlush();
		this.frames.clear();
		this.perf = perfEnabled()
			? new PerfCounter(`${paneId} ${this.mode}`, (line) => console.debug(line))
			: null;
		this.renderStatus();

		const renderer = await this.ensureRenderer(host);
		if (!renderer || generation !== this.generation) return;

		let command: string[];
		try {
			// Local: `[<herdr>]`. Remote profile: `['ssh','-T',host,<remote herdr>]`
			// — terminals never go through the forwarded API socket (PRD S17).
			command = terminalArgvPrefix(this.plugin.settings, this.plugin.herdrBinaryPath());
		} catch (error) {
			// A restored tab opens before `connect()` has discovered the binary
			// (discovery is async); the plugin announces the connection through
			// `onScopeReplaced`, which retries this start once.
			this.awaitingConnection = !this.plugin.client;
			this.closedReason = this.awaitingConnection
				? 'waiting for herdr'
				: (error as Error).message;
			this.exited = true;
			this.renderStatus();
			return;
		}
		this.awaitingConnection = false;

		const fit = renderer.fit();
		const cols = fit.cols > 0 ? fit.cols : FALLBACK_COLS;
		const rows = fit.rows > 0 ? fit.rows : FALLBACK_ROWS;
		const attach = attachFor(this.mode);
		const session = new TerminalSession({
			command,
			target: paneId,
			mode: attach.mode,
			takeover: attach.takeover,
			cols,
			rows,
			env: spawnEnv(process.env, this.plugin.settings.extraPath),
		});
		this.session = session;

		session.on('frame', (bytes, meta) => {
			if (this.session !== session) return;
			// #17: the input layer watches for the modes the pane's application
			// sets; seq 1 means a fresh bridge, so it starts from the defaults.
			this.input.observeFrame(bytes, meta.seq);
			this.perf?.frame(bytes.length);
			this.frames.push(bytes, meta.full);
			if (this.frames.pending >= MAX_PENDING_BYTES) this.flush(renderer);
			else this.scheduleFlush(renderer);
		});
		session.on('closed', (reason) => {
			if (this.session !== session) return;
			this.closedReason = reason;
			this.renderStatus();
		});
		session.on('stderr', (line) => {
			if (this.session !== session) return;
			this.stderr.push(line);
			if (this.stderr.length > MAX_STDERR_LINES) this.stderr.shift();
			this.renderStatus();
		});
		session.on('error', (error) => {
			if (this.session !== session) return;
			this.stderr.push(error.message);
			if (this.stderr.length > MAX_STDERR_LINES) this.stderr.shift();
			this.renderStatus();
		});
		session.on('exit', () => {
			if (this.session !== session) return;
			this.exited = true;
			this.renderStatus();
		});

		session.start();
		if (attach.mode === 'control') {
			// The spawn argv already carries the grid; this adds the cell metrics
			// herdr uses for pixel-aware programs.
			session.resize(cols, rows, fit.cellWidthPx, fit.cellHeightPx);
			renderer.focus();
		}
		// Reconnecting a leaf that is still hidden starts a fresh grace period;
		// without this the tracker sits in its hidden state with no timer.
		this.visibility?.arm();
		this.renderStatus();
	}

	/**
	 * One repaint per animation frame, however many frames herdr sent. Frames come
	 * from the window the view actually lives in (`containerEl.win`), so a popout
	 * keeps painting while the main window is hidden.
	 */
	private scheduleFlush(renderer: TerminalRenderer): void {
		if (this.flushHandle) return;
		this.flushHandle = this.containerEl.win.requestAnimationFrame(() => {
			this.flushHandle = 0;
			this.flush(renderer);
		});
	}

	private flush(renderer: TerminalRenderer): void {
		const batch = this.frames.take();
		if (!batch) return;
		renderer.write(batch);
		this.perf?.repaint();
	}

	private cancelFlush(): void {
		if (!this.flushHandle) return;
		this.containerEl.win.cancelAnimationFrame(this.flushHandle);
		this.flushHandle = 0;
	}

	/**
	 * Repaints with the theme the settings now hold (issue #26). Called by
	 * `HerdrPlugin.refreshTerminals()` after the setting changes, so an open
	 * terminal switches palette without being reopened. A view whose renderer is
	 * suspended picks the theme up from the options when it mounts again.
	 */
	applyTheme(theme: string): void {
		this.renderer?.refreshTheme?.(theme);
	}

	/** Mounts the renderer once per view; later calls reuse the same instance. */
	private async ensureRenderer(host: HTMLElement): Promise<TerminalRenderer | null> {
		if (!this.renderer) {
			const settings = this.plugin.settings;
			const renderer = createRenderer({
				fontFamily: settings.terminalFontFamily,
				fontSize: settings.terminalFontSize,
				// Colours: `obsidian` by default, which is the CSS variables (#26).
				theme: settings.terminalTheme,
				// Bytes, not lines — see `RendererOptions.scrollback`.
				scrollback: scrollbackBytes(settings),
				// Input is gated on the session's mode instead of here, so toggling
				// control/observe does not have to rebuild the terminal.
			});
			this.renderer = renderer;
			this.rendererReady = renderer.mount(host).then(() => {
				renderer.onData((data) => this.onData(data));
				this.replaySnapshot(renderer);
				// #17/#18: keys pass the input layer before the renderer encodes
				// them, so shift+enter can be sent as a line break. Optional on the
				// interface; a renderer without it keeps its own encoding.
				renderer.onKeyEvent?.((event) => this.onKeyEvent(event));
				// #25: and every wheel notch, including the ones over the canvas
				// that the host element's own listener never sees.
				this.wheelIntercepted = renderer.onWheelEvent !== undefined;
				renderer.onWheelEvent?.((event) => this.onWheelEvent(event));
			});
		}
		try {
			await this.rendererReady;
		} catch (error) {
			new Notice(`Herdr: terminal renderer failed to start (${String(error)})`);
			this.closedReason = 'the terminal renderer failed to start';
			this.exited = true;
			this.renderStatus();
			return null;
		}
		return this.renderer;
	}

	/**
	 * Writes back what a suspended terminal held, before the new session's first
	 * frame lands, so scrolling up still reaches the history. Plain text: the
	 * trailing newline leaves herdr's repaint a clean line to start on.
	 */
	private replaySnapshot(renderer: TerminalRenderer): void {
		const lines = this.snapshot;
		this.snapshot = null;
		if (!lines || lines.length === 0) return;
		// One write per line, not one write for the lot: writing the whole
		// snapshot as a single buffer into a freshly fitted ghostty-web terminal
		// trapped inside the WASM ("memory access out of bounds", reproduced on a
		// 102x46 grid with 46 lines), while the same bytes written line by line
		// never did. And a replay must never fail the mount: history is a
		// nicety, the reattach is not.
		const encoder = new TextEncoder();
		try {
			for (const line of lines) renderer.write(encoder.encode(`${line}\r\n`));
		} catch (error) {
			console.warn('herdr: could not restore scrollback after reveal', error);
		}
	}

	/** Keystrokes. Observers never write to the pane (PRD S16). */
	private onData(data: string): void {
		const session = this.session;
		if (!session || session.mode !== 'control') return;
		session.input(data);
	}

	/**
	 * Keys the input layer encodes itself (#17, #18). True means "consumed": the
	 * renderer swallows the event and emits nothing through `onData`, so a key we
	 * send is never also sent by ghostty-web's own encoder. Today that is
	 * shift+enter and alt+enter; every other key returns false and is typed
	 * exactly as before.
	 */
	private onKeyEvent(event: KeyboardEvent): boolean {
		const session = this.session;
		if (!session || session.mode !== 'control') return false;
		// ghostty-web only routes keydown through its custom handler; a renderer
		// that also offered keyup must not send the same key twice.
		if (event.type !== 'keydown') return false;
		const data = this.input.routeKey(event);
		if (data === null) return false;
		session.input(data);
		return true;
	}

	/**
	 * The wheel, intercepted before ghostty-web scrolls its own buffer (#25).
	 * True consumes the notch, which is what makes the wheel work over the canvas
	 * at all: ghostty-web registers its `wheel` listener on the host element in
	 * the capture phase and calls `stopPropagation()`, so `onWheel` below never
	 * sees an event whose target is the canvas, and the local buffer it scrolls
	 * instead holds one screen — herdr's frames reposition cells and never
	 * scroll (notes/herdr-terminal-bridge.md).
	 *
	 * False when nothing was sent — no session, an observer (which may not
	 * scroll), or a delta that rounds to nothing — so a terminal holding replayed
	 * scrollback still scrolls locally.
	 */
	private onWheelEvent(event: WheelEvent): boolean {
		return this.sendWheel(event);
	}

	/**
	 * Wheel events that reach the host element itself. A renderer with
	 * `onWheelEvent` sees every notch first, including this one, so this listener
	 * would report it twice; it is the fallback for a renderer without that hook.
	 */
	private onWheel(event: WheelEvent): void {
		if (this.wheelIntercepted && this.renderer) return;
		this.sendWheel(event);
	}

	/**
	 * Turns a notch into `terminal.scroll`. herdr forks it server-side into an SGR
	 * wheel report, an alternate-scroll key or a viewport move, using the cell and
	 * the modifier bits we pass; the client never encodes the wheel itself, or the
	 * pane would get every notch twice (PRD section 7, `apply_scroll`).
	 *
	 * Returns true when the notch actually went to herdr, i.e. when the renderer
	 * must not also act on it.
	 */
	private sendWheel(event: WheelEvent): boolean {
		const session = this.session;
		if (!session) return false;
		const position = this.cellAt(event);
		const route = this.input.routeWheel({
			deltaY: event.deltaY,
			deltaMode: event.deltaMode,
			rows: session.size.rows,
			// Undefined before the renderer has been measured; herdr then reports
			// on cell (0, 0), which is better than not scrolling at all.
			...(position === undefined ? {} : { position }),
			shiftKey: event.shiftKey,
			altKey: event.altKey,
			ctrlKey: event.ctrlKey,
			metaKey: event.metaKey,
		});
		if (!route) return false;
		// False from an observer (`scroll` is control-only, PRD section 7) or from
		// a session whose bridge has exited: the notch was not sent, so the
		// renderer may as well scroll whatever it holds locally.
		return session.scroll(route.direction, route.lines, {
			source: route.source,
			...(route.column === undefined ? {} : { column: route.column }),
			...(route.row === undefined ? {} : { row: route.row }),
			modifiers: route.modifiers,
		});
	}

	/** The cell under a mouse event, when the renderer can measure one. */
	private cellAt(event: WheelEvent): CellCoordinates | undefined {
		return this.renderer?.cellAt?.(event.clientX, event.clientY);
	}

	/** Re-fits the renderer and tells herdr about the new grid (control only). */
	private applyFit(): void {
		const renderer = this.renderer;
		if (!renderer) return;
		const fit = renderer.fit();
		if (fit.cols <= 0 || fit.rows <= 0) return;
		const session = this.session;
		if (!session || session.mode !== 'control') return;
		const current = session.size;
		if (current.cols === fit.cols && current.rows === fit.rows) return;
		session.resize(fit.cols, fit.rows, fit.cellWidthPx, fit.cellHeightPx);
	}

	/** Header action: swap control/observe, which means a fresh bridge process. */
	private async toggleMode(): Promise<void> {
		this.mode = this.mode === 'control' ? 'observe' : 'control';
		this.updateToggleAction();
		// Keeps the layout file in step with what the view is actually doing.
		this.app.workspace.requestSaveLayout();
		await this.start();
	}

	private updateToggleAction(): void {
		const el = this.toggleActionEl;
		if (!el) return;
		const observing = this.mode === 'observe';
		const title = observing ? 'Switch to control mode' : 'Switch to observe mode';
		setIcon(el, observing ? 'square-terminal' : 'eye');
		setTooltip(el, title);
		el.setAttribute('aria-label', title);
	}

	private renderStatus(): void {
		const el = this.statusEl;
		if (!el) return;
		el.empty();
		const line = statusLine({
			mode: this.mode,
			closedReason: this.closedReason,
			exited: this.exited && this.closedReason === null,
			stderr: this.stderr,
		});
		el.toggleClass('mod-warning', line.warning);
		el.createSpan({ cls: 'herdr-terminal-status-text', text: line.text });
		if (line.detail) el.createSpan({ cls: 'herdr-terminal-status-detail', text: line.detail });
	}

	/** Releases the terminal back to herdr; never leaves the child running. */
	private async stopSession(): Promise<void> {
		const session = this.session;
		this.session = null;
		if (!session) return;
		await session.dispose();
	}
}
