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
import type { AttachMode } from '../settings';
import { terminalArgvPrefix } from '../herdr/ssh';
import {
	TerminalSession,
	type ScrollDirection,
	type TerminalSessionMode,
} from '../bridge/terminalSession';
import { createRenderer } from './renderer/create';
import type { TerminalRenderer } from './renderer/TerminalRenderer';

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
	/** Guards against an old start finishing after a newer one began. */
	private generation = 0;
	private opened = false;
	/** Frame bytes waiting for the next animation frame. */
	private readonly frames = new FrameBuffer();
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

		const observer = new ResizeObserver(() => this.scheduleResize?.());
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
		this.scheduleResize?.();
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
			this.closedReason = (error as Error).message;
			this.exited = true;
			this.renderStatus();
			return;
		}

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

	/** Mounts the renderer once per view; later calls reuse the same instance. */
	private async ensureRenderer(host: HTMLElement): Promise<TerminalRenderer | null> {
		if (!this.renderer) {
			const settings = this.plugin.settings;
			const renderer = createRenderer({
				fontFamily: settings.terminalFontFamily,
				fontSize: settings.terminalFontSize,
				// Input is gated on the session's mode instead of here, so toggling
				// control/observe does not have to rebuild the terminal.
			});
			this.renderer = renderer;
			this.rendererReady = renderer.mount(host).then(() => {
				renderer.onData((data) => this.onData(data));
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

	/** Keystrokes. Observers never write to the pane (PRD S16). */
	private onData(data: string): void {
		const session = this.session;
		if (!session || session.mode !== 'control') return;
		session.input(data);
	}

	private onWheel(event: WheelEvent): void {
		const session = this.session;
		if (!session) return;
		const scroll = wheelToScroll(event.deltaY, event.deltaMode, session.size.rows);
		if (!scroll) return;
		session.scroll(scroll.direction, scroll.lines, { source: 'wheel' });
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
