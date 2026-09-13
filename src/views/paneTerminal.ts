/**
 * Pane terminal lifecycle (issue #83).
 *
 * One herdr pane's terminal, from the outside: a `TerminalSession` bridge
 * process and a `TerminalRenderer`, owned together because they are given up
 * together. A hidden leaf is suspended after its grace period (#15), and
 * suspension snapshots the renderer's scrollback *after* the session has been
 * released asynchronously — so nothing can own one half of that without owning
 * the other.
 *
 * `terminalView.ts` keeps the Obsidian wiring (open, close, set state, resize,
 * the hide/reveal tracker, the tab title) and drives this through the interface
 * below: {@link PaneTerminal.attach}, {@link PaneTerminal.detach},
 * {@link PaneTerminal.setVisible}, {@link PaneTerminal.setIdentity},
 * {@link PaneTerminal.reconnect}, {@link PaneTerminal.connectionArrived},
 * {@link PaneTerminal.resize} and {@link PaneTerminal.status}. Everything this
 * cannot do itself — Obsidian's `Notice`, the settings, endpoint resolution,
 * the herdr argv — arrives through {@link PaneTerminalHost}, and the session
 * factory, the renderer factory and the scheduler are injected too, so
 * `tests/paneTerminal.test.ts` drives the whole lifecycle, races included,
 * without a canvas, a child process or an `ItemView`.
 *
 * The plumbing itself is unchanged from the view it came out of —
 *
 *   session `frame`  -> renderer.write   (coalesced to one write per frame)
 *   renderer `onData`-> session.input        (control mode only)
 *   resize           -> renderer.fit -> session.resize   (control mode only)
 *   wheel            -> session.scroll
 *
 * — and so are its two guards. A **generation counter** is bumped by every
 * start, suspend and renderer rebuild, and every step that resumes after an
 * `await` re-checks it, so an old start can never spawn behind a newer one's
 * back. And every session callback checks `this.session === session`, so a
 * dying bridge's last words never land in the live one's status line.
 *
 * The mount continuation checks the same way (`this.renderer === renderer`): a
 * detach, a pane switch or a theme rebuild during an `await renderer.mount()`
 * gives that renderer up, and installing callbacks on it or replaying the
 * carried-over scrollback into it would aim both at a terminal nobody is
 * looking at — and would eat the snapshot the next mount is there to restore.
 *
 * Settings-driven effects come in through one door (issue #84):
 * {@link TERMINAL_SETTING_EFFECTS} maps each setting to a named effect and
 * {@link PaneTerminal.apply} runs it. Everything the renderer is built from is
 * still read per mount from {@link PaneTerminalHost}, so an effect that defers
 * costs nothing: the next mount reads the setting anyway.
 */

import { endpointLabel, type Endpoint } from '../connection';
import type {
	FrameMeta,
	ScrollDirection,
	ScrollOptions,
	TerminalSessionEventMap,
	TerminalSessionMode,
	TerminalSessionOptions,
} from '../bridge/terminalSession';
import type { AttachMode, HerdrSettings } from '../settings';
import type {
	CellCoordinates,
	CursorOptions,
	RendererOptions,
	TerminalRenderer,
} from './renderer/TerminalRenderer';
import {
	DEFAULT_HOST_KEY_POLICY,
	InputRouter,
	type HostKeyDecision,
} from './input/inputRouter';
import { pickModifiers } from './input/mouseEncoder';
import { WheelAccumulator } from './input/wheelAccumulator';

/** How long a burst of container resizes is collapsed before a `terminal.resize`. */
export const RESIZE_DEBOUNCE_MS = 100;

/** Grid used until the renderer can measure itself (hidden leaf, no metrics yet). */
export const FALLBACK_COLS = 80;
export const FALLBACK_ROWS = 24;

/** Stderr is unbounded noise on a broken host; keep only what the summary needs. */
const MAX_STDERR_LINES = 20;

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
	/** Drops a pending call. Always called from `detach`. */
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
 * the bytes until the lifecycle flushes them once per animation frame.
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
	/** Where the bridge runs, from {@link endpointLabel}: `local` or `ssh <host>`. */
	endpoint: string;
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
	const verb = input.mode === 'observe' ? 'Observing (read-only)' : 'Controlling this pane';
	return { text: `${verb} on ${input.endpoint}.`, warning: false, detail };
}

/** Newest stderr line plus a count of the ones before it; null when empty. */
export function summariseStderr(lines: readonly string[]): string | null {
	const last = lines.at(-1);
	if (!last) return null;
	const clipped = last.length > 200 ? `${last.slice(0, 200)}…` : last;
	return lines.length > 1 ? `${clipped} (+${lines.length - 1} more)` : clipped;
}

/** What a theme change costs on the renderer the lifecycle currently holds (#53). */
export type ThemeUpdatePlan = 'defer' | 'in-place' | 'rebuild-renderer';

/** State `planThemeUpdate` decides from; all of it is what the lifecycle knows. */
export interface ThemeUpdateInput {
	/** False before `attach` and after `detach`. */
	opened: boolean;
	/** True while the renderer and the session are given up for a hidden leaf. */
	suspended: boolean;
	/** False when nothing is mounted, e.g. a start that never got a renderer. */
	hasRenderer: boolean;
	/** `TerminalRenderer.canUpdateThemeInPlace()`; absent method → true. */
	inPlace: boolean;
}

/**
 * Issue #53: the theme dropdown is inert on ghostty-web, whose `theme` option is
 * a no-op after `open()`. The fix is to rebuild the **renderer**, never the
 * session — a palette must not reclaim a terminal another controller took over,
 * nor reconnect a tab whose session herdr closed.
 *
 * - `defer`: nothing is mounted (closed view, or a suspended one, #15). The next
 *   mount reads the setting, so there is nothing to do now.
 * - `in-place`: xterm.js; assign `options.theme` and let it repaint.
 * - `rebuild-renderer`: ghostty-web; dispose, mount a fresh terminal carrying the
 *   new theme, replay the snapshot. A closed session simply repaints its last
 *   frame from that snapshot and keeps its closed status line.
 */
export function planThemeUpdate(input: ThemeUpdateInput): ThemeUpdatePlan {
	if (!input.opened || input.suspended || !input.hasRenderer) return 'defer';
	return input.inPlace ? 'in-place' : 'rebuild-renderer';
}

/**
 * The settings-effect matrix (issue #84).
 *
 * Every setting an open terminal reacts to maps to exactly one **named
 * effect**, and that effect — not the setting — is what the lifecycle runs. The
 * table below is the whole of it, and `tests/paneTerminal.test.ts` asserts it
 * row by row, so "which setting restarts the bridge?" is answered here instead
 * of by reading four fan-out methods in `main.ts`.
 *
 * The effects:
 *
 * - `theme`: repaint with the colours and fonts the settings hold now. The
 *   renderer is remounted when its engine cannot repaint in place
 *   ({@link planThemeUpdate}); the session is never touched either way.
 * - `cursor`: shape and blink, in place on both engines.
 * - `engine`: the renderer is a different library, so it is mounted afresh and
 *   the bridge restarted around it. The one effect that does not keep the
 *   session; preserving it across an engine switch would be a behaviour change
 *   and is deliberately out of #84.
 * - `title`: the tab's name and the view header. The view's work, not the
 *   lifecycle's, and the only effect a hidden leaf still applies at once — a
 *   background tab's header is on screen even when its content is not.
 * - `next-mount`: nothing to do now. Font, size and scrollback are read by
 *   {@link PaneTerminalHost.rendererOptions} on every mount, so the setting
 *   lands the next time the terminal is built; routing them through a rebuild
 *   would throw away a live terminal for a value nobody asked to see applied.
 */
export type TerminalEffect = 'theme' | 'cursor' | 'engine' | 'title' | 'next-mount';

/**
 * The settings an open terminal reacts to. Checked against `HerdrSettings`, so
 * a renamed setting fails the build here instead of silently losing its effect.
 */
export const TERMINAL_SETTING_KEYS = [
	'terminalTheme',
	'terminalCursorStyle',
	'terminalCursorBlink',
	'terminalEngine',
	'terminalFontFamily',
	'terminalFontSize',
	'terminalScrollbackMb',
	'terminalTitleSource',
] as const satisfies readonly (keyof HerdrSettings)[];

/**
 * A setting, or `cssVariables` for Obsidian's `css-change`: not a setting of
 * ours at all, but the same question — the colours and fonts the renderer was
 * handed have changed underneath it.
 */
export type TerminalSetting = (typeof TERMINAL_SETTING_KEYS)[number] | 'cssVariables';

/** One row of the matrix: what a setting does to a terminal. */
export interface TerminalEffectSpec {
	/** The effect the lifecycle — or, for `title`, the view — runs. */
	effect: TerminalEffect;
	/**
	 * Whether the running bridge survives. False means the pane is released and
	 * attached again, which on a control terminal re-sends `--takeover`.
	 */
	keepsSession: boolean;
	/**
	 * Whether a hidden leaf holds the effect until it is revealed. True for
	 * everything the renderer shows: a hidden leaf either has no renderer at all
	 * (suspended, #15) or one nobody can see, and remounting it would spend a
	 * WASM terminal on a tab in the background.
	 */
	defersWhenHidden: boolean;
}

/**
 * The matrix itself. The plugin names a setting, this decides the effect; no
 * caller anywhere else picks one.
 *
 * Theme and cursor refresh the renderer, in place when the engine can and by
 * remount otherwise; the session is preserved either way. Issue #84 recorded
 * that as "remounts the renderer", which named the ghostty-web half of it —
 * xterm.js repaints in place and always has, and spending a remount on an
 * engine that does not need one would throw away a live terminal for nothing.
 */
export const TERMINAL_SETTING_EFFECTS: Readonly<Record<TerminalSetting, TerminalEffectSpec>> = {
	// #26/#53: a palette change must never reclaim a pane or reconnect a closed
	// tab, so it stops at the renderer.
	terminalTheme: { effect: 'theme', keepsSession: true, defersWhenHidden: true },
	// #52: both engines take these in place.
	terminalCursorStyle: { effect: 'cursor', keepsSession: true, defersWhenHidden: true },
	terminalCursorBlink: { effect: 'cursor', keepsSession: true, defersWhenHidden: true },
	// #27: another library draws it, so the terminal is built again and the
	// bridge with it.
	terminalEngine: { effect: 'engine', keepsSession: false, defersWhenHidden: true },
	terminalFontFamily: { effect: 'next-mount', keepsSession: true, defersWhenHidden: true },
	terminalFontSize: { effect: 'next-mount', keepsSession: true, defersWhenHidden: true },
	terminalScrollbackMb: { effect: 'next-mount', keepsSession: true, defersWhenHidden: true },
	// #43: the header, which a hidden leaf still shows.
	terminalTitleSource: { effect: 'title', keepsSession: true, defersWhenHidden: false },
	// PRD S18: the vault's theme changed every colour the renderer was handed.
	// Refreshed whatever the settings say, since none of them moved.
	cssVariables: { effect: 'theme', keepsSession: true, defersWhenHidden: true },
};

/** The row for a setting. Total over {@link TerminalSetting} by construction. */
export function effectOf(setting: TerminalSetting): TerminalEffectSpec {
	return TERMINAL_SETTING_EFFECTS[setting];
}

/** What a leaf does with a setting change right now (issue #84). */
export type SettingEffectPlan = 'run' | 'queue' | 'drop';

/**
 * Whether a setting change runs now, waits for the leaf to be revealed, or is
 * not worth remembering at all.
 *
 * A hidden leaf defers every effect the renderer would show; `title` is not one
 * of them, since a background tab's header is on screen. And a leaf the grace
 * period already suspended (#15) drops the effect instead of queueing it: it has
 * no renderer, and the one it mounts on reveal is built from the settings as
 * they are then.
 */
export function planSettingEffect(input: {
	setting: TerminalSetting;
	/** The leaf has no box on screen (`VisibilityTracker.hidden`). */
	hidden: boolean;
	/** The lifecycle gave the renderer and the session up (`PaneTerminal.suspended`). */
	suspended: boolean;
}): SettingEffectPlan {
	if (!effectOf(input.setting).defersWhenHidden || !input.hidden) return 'run';
	return input.suspended ? 'drop' : 'queue';
}

/**
 * What a leaf that deferred effects runs when it is revealed, in order.
 *
 * An `engine` swallows the rest: it mounts a terminal from every current
 * setting, so a `theme` or a `cursor` queued beside it is already in the options
 * it is built with. Otherwise the theme goes first, since a remount would undo a
 * cursor applied before it, and effects that never defer are dropped.
 */
export function collapseEffects(effects: Iterable<TerminalEffect>): TerminalEffect[] {
	const queued = new Set(effects);
	if (queued.has('engine')) return ['engine'];
	return (['theme', 'cursor'] as const).filter((effect) => queued.has(effect));
}

/** What a leaf is doing right now, as far as a settings change is concerned. */
export interface SettingEffectState {
	/** The leaf has no box on screen (`VisibilityTracker.hidden`). */
	hidden: boolean;
	/** The lifecycle gave the renderer and the session up (`PaneTerminal.suspended`). */
	suspended: boolean;
}

/**
 * The queue behind a leaf's `applySetting` (issue #84): the whole of what a tab
 * remembers about settings that moved while nobody could see it. DOM-free on
 * purpose, so the queue-while-hidden and flush-on-reveal wiring is a test rather
 * than a reading of the view.
 *
 * {@link apply} answers with the effect to run now, or null when the change was
 * queued or dropped; {@link flush} hands back what a reveal owes, collapsed to
 * the least work that lands every queued effect; {@link clear} forgets it all,
 * which is what a suspend and a close both do.
 */
export class SettingEffectQueue {
	/**
	 * Effects a settings change asked for while the leaf was hidden. Deduplicated
	 * by the set and collapsed on the way out, so five theme switches behind a
	 * background tab cost one remount.
	 */
	private readonly pending = new Set<TerminalEffect>();

	/**
	 * A setting moved. Returns the effect the caller runs now, or null when the
	 * leaf held it back (queued for the reveal) or threw it away (suspended: its
	 * next mount reads every setting again).
	 */
	apply(setting: TerminalSetting, state: SettingEffectState): TerminalEffect | null {
		const plan = planSettingEffect({ setting, ...state });
		if (plan === 'drop') return null;
		const { effect } = effectOf(setting);
		if (plan !== 'queue') return effect;
		this.pending.add(effect);
		return null;
	}

	/** What the reveal runs, in order, emptying the queue as it goes. */
	flush(): TerminalEffect[] {
		const effects = collapseEffects(this.pending);
		this.pending.clear();
		return effects;
	}

	/** Forget everything queued. Nothing survives a suspend or a close. */
	clear(): void {
		this.pending.clear();
	}

	/** What is queued, for tests and for the view's own assertions. */
	get queued(): ReadonlySet<TerminalEffect> {
		return this.pending;
	}
}

/**
 * Which pane, on which herdr, in which mode. The whole of what a terminal is
 * pointed at; a pane id alone aliases across endpoints (issue #54).
 */
export interface PaneIdentity {
	paneId: string;
	mode: AttachMode;
	endpointId: string;
}

/** What {@link PaneTerminal.setIdentity} changed, for the view's header. */
export interface PaneIdentityChange {
	/** The pane or the endpoint changed, so the previous agent's output is gone. */
	switchedPane: boolean;
}

/**
 * The bit of `TerminalSession` the lifecycle uses. Structural, so a test fakes
 * a bridge without spawning one; `TerminalSession` satisfies it as it stands.
 */
export interface PaneSession {
	readonly mode: TerminalSessionMode;
	readonly size: { cols: number; rows: number };
	on<K extends keyof TerminalSessionEventMap>(
		event: K,
		listener: (...args: TerminalSessionEventMap[K]) => void,
	): unknown;
	start(): unknown;
	input(data: string | Uint8Array): boolean;
	resize(cols: number, rows: number, cellWidthPx?: number, cellHeightPx?: number): boolean;
	scroll(direction: ScrollDirection, lines: number, options?: ScrollOptions): boolean;
	dispose(): Promise<void>;
}

/**
 * Frames and timers, from the window the terminal actually lives in
 * (`containerEl.win`), so a popout keeps painting while the main window is
 * hidden — and so a test can run the whole lifecycle on queues it controls.
 */
export interface PaneTerminalScheduler extends DebounceTimers {
	requestAnimationFrame: (callback: () => void) => number;
	cancelAnimationFrame: (handle: number) => void;
}

/**
 * Everything the lifecycle cannot do itself. The terminal view implements this
 * over the plugin, the settings and Obsidian; nothing else here imports any of
 * the three.
 */
export interface PaneTerminalHost {
	/** Renderer options for the next mount, read fresh so a setting change lands. */
	rendererOptions(): RendererOptions;
	/** Cursor shape and blink (issue #52); applied in place on both engines. */
	cursorOptions(): CursorOptions;
	/** Environment for the spawned bridge, `extraPath` included. */
	env(): NodeJS.ProcessEnv;
	/** The endpoint snapshot to pin to, or null when it is no longer configured. */
	endpointFor(endpointId: string): Endpoint | null;
	/** argv prefix for the bridge. Throws while herdr has not been found yet. */
	commandFor(endpoint: Endpoint): string[];
	/** Whether the plugin has connected to *any* herdr; decides a late retry. */
	connected(): boolean;
	/** `window.herdrPerf`, asked once per start (#24). */
	perfEnabled(): boolean;
	/** The status text changed; the view repaints its strip. */
	onStatus(line: StatusLine): void;
	/**
	 * A start has a renderer mounted. The view owes the hide grace period an
	 * `arm()` from here: a reconnect on a still-hidden leaf mounts a renderer
	 * that nothing would otherwise come back to free (#15).
	 */
	onStarted(): void;
	/** The renderer would not mount; the view tells the user. */
	onRendererError(error: unknown): void;
	/** The identity changed, before the restart. The view retitles from here. */
	onIdentityChanged(change: PaneIdentityChange): void;
}

export interface PaneTerminalOptions {
	identity: PaneIdentity;
	host: PaneTerminalHost;
	scheduler: PaneTerminalScheduler;
	createSession: (options: TerminalSessionOptions) => PaneSession;
	createRenderer: (options: RendererOptions) => TerminalRenderer;
	/** Decides the host-key policy (#47); `Platform.isMacOS` in the view. */
	macOS: boolean;
}

/** The erase-display a pane switch writes: the screen, then the scrollback. */
const ERASE_DISPLAY = '\x1b[H\x1b[2J\x1b[3J';

export class PaneTerminal {
	private readonly host: PaneTerminalHost;
	private readonly scheduler: PaneTerminalScheduler;
	private readonly newSession: (options: TerminalSessionOptions) => PaneSession;
	private readonly newRenderer: (options: RendererOptions) => TerminalRenderer;

	private paneIdentity: PaneIdentity;
	/**
	 * The endpoint this terminal is pinned to, captured on the first start after
	 * the identity named it and kept across every later start, so a reconnect, a
	 * mode toggle or a renderer rebuild spawns against the same herdr whatever
	 * the list is connected to now.
	 */
	private endpoint: Endpoint | null = null;
	private hostEl: HTMLElement | null = null;
	private renderer: TerminalRenderer | null = null;
	private rendererReady: Promise<void> | null = null;
	/**
	 * Whether {@link renderer} has been through its mount continuation, i.e.
	 * whether the carried-over scrollback has been replayed into it. Frames are
	 * held back until it has: both renderers queue writes taken before `mount()`
	 * resolves and drain that queue during the mount, so a frame written into a
	 * terminal still mounting lands *above* the scrollback the replay is about to
	 * write — new output printed before the history it followed.
	 */
	private rendererMounted = false;
	private session: PaneSession | null = null;
	private closedReason: string | null = null;
	private exited = false;
	private stderr: string[] = [];
	/** True while the renderer and the session are given up for a hidden leaf. */
	private isSuspended = false;
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
	 * Fractional wheel accumulator (#65). A trackpad's small pixel deltas add up
	 * to whole lines here instead of each becoming one, fed the renderer's
	 * measured cell height as the divisor.
	 */
	private readonly wheel = new WheelAccumulator();
	/**
	 * Keyboard/mouse/scroll encoding (#17, `src/views/input/`). It watches frames
	 * for the modes the pane's application sets and decides what a key or a wheel
	 * notch becomes: shift+enter is ours (#18), every wheel notch becomes a
	 * `terminal.scroll` with the cell under the pointer (#25), everything else is
	 * left to the renderer.
	 */
	private readonly input: InputRouter;
	/** Pending coalescing frame for held wheel lines; 0 when none. */
	private wheelFrame = 0;
	/** Whether the last emission reached herdr, i.e. whether to consume a notch. */
	private lastWheelSent = false;
	/** Cell and modifiers of the most recent notch, for a deferred emission. */
	private lastWheelRoute: { column?: number; row?: number; modifiers: number } = { modifiers: 0 };
	/**
	 * True once the renderer intercepts the wheel, so the host element's own
	 * listener stands down. Only meaningful while a renderer exists: a suspended
	 * terminal (#15) has none, and that listener is all there is again.
	 */
	private wheelIntercepted = false;
	private flushHandle = 0;
	private perf: PerfCounter | null = null;
	private readonly scheduleFit: Debounced;

	constructor(options: PaneTerminalOptions) {
		this.paneIdentity = { ...options.identity };
		this.host = options.host;
		this.scheduler = options.scheduler;
		this.newSession = options.createSession;
		this.newRenderer = options.createRenderer;
		this.input = new InputRouter(
			{
				// Bound rather than passed directly: the accumulator is stateful, and
				// the router only ever asks the same three-argument question.
				wheelToScroll: (deltaY, deltaMode, rows) => this.wheel.push(deltaY, deltaMode, rows),
			},
			{
				hostKeys: {
					...DEFAULT_HOST_KEY_POLICY,
					platform: options.macOS ? 'macOS' : 'other',
				},
			},
		);
		this.scheduleFit = debounce(() => this.applyFit(), RESIZE_DEBOUNCE_MS, this.scheduler);
	}

	/** Which pane, on which herdr, in which mode. What the view persists. */
	get identity(): PaneIdentity {
		return { ...this.paneIdentity };
	}

	/** The attach mode of the *running* bridge, or null when none runs (#47). */
	get sessionMode(): TerminalSessionMode | null {
		return this.session?.mode ?? null;
	}

	/**
	 * True while the session and the renderer are given up for a hidden leaf
	 * (#15). The view asks before it queues a deferred effect (#84): a suspended
	 * terminal reads every setting again on its next mount, so there is nothing
	 * worth remembering for it.
	 */
	get suspended(): boolean {
		return this.isSuspended;
	}

	/** What the status strip says right now. */
	status(): StatusLine {
		const identity = this.paneIdentity;
		return statusLine({
			mode: identity.mode,
			endpoint: this.endpoint ? endpointLabel(this.endpoint) : identity.endpointId,
			closedReason: this.closedReason,
			exited: this.exited && this.closedReason === null,
			stderr: this.stderr,
		});
	}

	/** The view opened: take the element and start, if there is a pane to start. */
	async attach(hostEl: HTMLElement): Promise<void> {
		this.opened = true;
		this.hostEl = hostEl;
		this.host.onStatus(this.status());
		if (this.paneIdentity.paneId) await this.start();
	}

	/**
	 * The view closed. Releases the terminal back to herdr and hands the renderer
	 * back; leaves no timer, no frame and no live callback behind.
	 */
	async detach(): Promise<void> {
		this.opened = false;
		// Invalidates anything still in flight: a start that resumes after this
		// re-checks the generation and stops before it spawns.
		this.generation++;
		this.snapshot = null;
		this.isSuspended = false;
		this.scheduleFit.cancel();
		this.cancelFlush();
		this.cancelWheel();
		this.frames.clear();
		this.perf = null;
		try {
			await this.stopSession();
		} catch (error) {
			// As in `suspend()`: a child that will not die is herdr's problem, and
			// no reason to leave a renderer — and ghostty-web's repaint loop, and
			// its canvas — alive on a view that is closing. The view's `onClose`
			// waits on this, so a rejection here would strand its teardown too.
			console.warn('Herdr: releasing the terminal session failed', error);
		}
		this.renderer?.dispose();
		this.renderer = null;
		this.rendererReady = null;
		this.wheelIntercepted = false;
		this.hostEl = null;
	}

	/**
	 * Points this terminal at another pane, endpoint or mode (`setState`, the
	 * mode toggle, and #38's leaf reuse). A change clears the previous agent's
	 * output and restarts the bridge; anything else is a no-op.
	 */
	async setIdentity(identity: PaneIdentity): Promise<void> {
		const previous = this.paneIdentity;
		const switchedEndpoint = identity.endpointId !== previous.endpointId;
		const switchedPane = switchedEndpoint || identity.paneId !== previous.paneId;
		const changed = switchedPane || identity.mode !== previous.mode;
		this.paneIdentity = { ...identity };
		// A new endpoint means a new pin; `start()` captures it.
		if (switchedEndpoint) this.endpoint = null;
		// Reuse mode (#38) points this terminal at another agent, and the previous
		// agent's output belongs to the previous agent.
		if (switchedPane) this.forgetOutput();
		if (!changed) return;
		this.host.onIdentityChanged({ switchedPane });
		if (this.opened) await this.start();
	}

	/** Header action: attach again after a close, a takeover or an exit. */
	async reconnect(): Promise<void> {
		await this.start();
	}

	/**
	 * The plugin published a connection. Only a start that failed for want of one
	 * retries, so a reconnect elsewhere never respawns this bridge.
	 */
	async connectionArrived(): Promise<void> {
		if (!this.awaitingConnection) return;
		await this.start();
	}

	/**
	 * Hidden (the grace period ran out) or revealed. Hiding hands the session back
	 * to herdr and disposes the renderer — the only way to stop ghostty-web's
	 * 60 fps repaint loop and free its canvas (#15) — carrying the scrollback
	 * across as text; revealing mounts a fresh renderer and attaches again.
	 */
	async setVisible(visible: boolean): Promise<void> {
		if (visible) await this.resume();
		else await this.suspend();
	}

	/** The container changed size. Debounced: herdr sees one resize, not sixty. */
	resize(): void {
		// A detached terminal takes no resize: an `onResize` arriving between
		// `detach` and the view's teardown would otherwise arm a debounce timer
		// that nothing is left to cancel.
		if (!this.opened) return;
		this.scheduleFit();
	}

	/** An IME owns every key between composition start and end (#49). */
	setComposing(composing: boolean): void {
		this.input.setComposing(composing);
	}

	/**
	 * A wheel event that reached the host element itself. A renderer with
	 * `onWheelEvent` sees every notch first, including this one, so this would
	 * report it twice; it is the fallback for a renderer without that hook.
	 */
	handleWheel(event: WheelEvent): void {
		if (this.wheelIntercepted && this.renderer) return;
		this.sendWheel(event);
	}

	/** Obsidian's keymap asking what to do with a keydown (#47). */
	routeHostKey(event: KeyboardEvent): HostKeyDecision {
		return this.input.routeHostKey(event);
	}

	/**
	 * The one thing a settings change asks of a terminal (issue #84): run the
	 * effect {@link TERMINAL_SETTING_EFFECTS} chose for the setting that moved.
	 *
	 * The view calls this and nothing else; which setting it was, and whether a
	 * hidden leaf should have held the effect back, are both decided before the
	 * call. `title` and `next-mount` are listed and do nothing here on purpose:
	 * the title belongs to the view, and the rest of the renderer options are
	 * read fresh by the next mount.
	 */
	async apply(effect: TerminalEffect): Promise<void> {
		switch (effect) {
			case 'theme':
				this.applyTheme();
				return;
			case 'cursor':
				this.applyCursor();
				return;
			case 'engine':
				await this.rebuildRenderer();
				return;
			case 'title':
			case 'next-mount':
				return;
		}
	}

	/**
	 * Repaints with the theme the settings now hold (issue #26, fixed in #53).
	 * Which of the two paths runs is `planThemeUpdate`'s decision; neither touches
	 * the session, so no takeover is re-sent and a closed tab stays closed.
	 *
	 * The theme name comes from the host rather than from the caller: the
	 * renderer was mounted with whatever the setting said, so a `css-change`
	 * passing the same name re-reads the vault's colours exactly as a bare
	 * `refreshTheme()` used to (#84). Nothing is compared against the value the
	 * renderer already has, which is what makes a CSS variable change repaint
	 * even though no setting of ours moved.
	 */
	private applyTheme(): void {
		const theme = this.host.rendererOptions().theme;
		const renderer = this.renderer;
		const plan = planThemeUpdate({
			opened: this.opened,
			suspended: this.isSuspended,
			hasRenderer: renderer !== null,
			// A renderer without the method is taken at its word: `refreshTheme`
			// implies it repaints.
			inPlace: renderer?.canUpdateThemeInPlace?.() ?? true,
		});
		if (plan === 'defer' || !renderer) return;
		// Assigned either way: it is what a fresh terminal is built from, and the
		// font half of the refresh works on both engines.
		renderer.refreshTheme?.(theme);
		if (plan === 'rebuild-renderer') {
			this.remountRenderer().catch((error: unknown) => {
				console.warn('Herdr: terminal theme rebuild failed', error);
			});
		}
	}

	/** Cursor shape and blink from the settings (issue #52); in place on both. */
	private applyCursor(): void {
		this.renderer?.applyCursor?.(this.host.cursorOptions());
	}

	/**
	 * The engine setting changed (#27): the renderer is a different library now,
	 * so the bridge is restarted around a fresh mount.
	 */
	private async rebuildRenderer(): Promise<void> {
		if (!this.opened || this.isSuspended) return;
		// Invalidates any `start()` still in flight, so nothing can go on using
		// the renderer this is about to dispose. `start()` below bumps it again.
		this.generation++;
		const renderer = this.renderer;
		if (renderer) {
			// Bytes coalesced but not yet painted are output like any other: write
			// them before the snapshot, or an engine switch loses whatever the pane
			// said in the animation frame it happened in.
			this.flush();
			this.cancelFlush();
			this.snapshot = renderer.snapshotLines?.() ?? null;
			renderer.dispose();
		}
		this.renderer = null;
		this.rendererReady = null;
		this.wheelIntercepted = false;
		this.hostEl?.empty();
		if (!this.paneIdentity.paneId) return;
		await this.start();
	}

	/**
	 * Drops everything on screen that belonged to the pane this was showing.
	 *
	 * Only a pane switch calls this. The renderer is kept — rebuilding it would
	 * cost another WASM terminal — so the grid and its scrollback are cleared the
	 * way a terminal clears them, with an erase-display for the screen and for
	 * the scrollback. A suspended terminal has no renderer, and its carried-over
	 * scrollback is dropped instead, or it would be replayed into the new pane's
	 * terminal on reveal.
	 */
	private forgetOutput(): void {
		this.snapshot = null;
		this.cancelFlush();
		this.frames.clear();
		this.renderer?.write(new TextEncoder().encode(ERASE_DISPLAY));
	}

	/**
	 * The leaf has been hidden for the whole grace period: hand everything back.
	 * Releasing the session tells herdr the terminal is free again (a control-mode
	 * view gives up its takeover), and disposing the renderer is what actually
	 * stops ghostty-web's repaint loop and frees its canvas.
	 */
	private async suspend(): Promise<void> {
		if (!this.opened || this.isSuspended) return;
		if (!this.renderer && !this.session) {
			this.isSuspended = true;
			return;
		}
		// Invalidates any `start()` still in flight: it re-checks the generation
		// before it builds a session, so nothing can be spawned behind our back.
		const generation = ++this.generation;
		// Set before the await, so a reveal arriving while the child goes down sees
		// a suspended terminal and restarts it (which bumps the generation again).
		this.isSuspended = true;
		this.cancelFlush();
		this.frames.clear();
		this.perf = null;
		try {
			await this.stopSession();
		} catch (error) {
			// A child that will not die is herdr's problem, not a reason to keep a
			// renderer alive: `suspended` is already true, so bailing out here would
			// leave a 60 fps repaint loop running with nothing left to come back and
			// stop it. Fall through to the dispose below.
			console.warn('Herdr: releasing the terminal session failed', error);
		}
		// A reconnect or a reveal raced us; it owns the terminal now, it has
		// already cleared `suspended`, and the renderer it kept must stay.
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
		this.wheelIntercepted = false;
		this.hostEl?.empty();
	}

	/** The leaf is back: mount a fresh renderer, replay the snapshot, reattach. */
	private async resume(): Promise<void> {
		if (!this.opened || !this.isSuspended) return;
		this.isSuspended = false;
		if (!this.paneIdentity.paneId) return;
		await this.start();
	}

	/**
	 * (Re)starts the bridge: releases the old session, makes sure the renderer is
	 * mounted, fits it, then spawns `herdr terminal session <mode> <pane>`.
	 */
	private async start(): Promise<void> {
		const { paneId, mode, endpointId } = this.paneIdentity;
		const hostEl = this.hostEl;
		if (!paneId || !hostEl) return;
		const generation = ++this.generation;
		// Whatever the reason for this start — reconnect, mode toggle, reveal — the
		// terminal is live again from here on.
		this.isSuspended = false;
		await this.stopSession();
		if (generation !== this.generation) return;

		this.closedReason = null;
		this.exited = false;
		this.stderr = [];
		// Bytes from the previous session must never land in the new one's grid.
		this.cancelFlush();
		this.frames.clear();
		this.perf = this.host.perfEnabled()
			? new PerfCounter(`${paneId} ${mode}`, (line) => console.debug(line))
			: null;
		// Pinned on the first start and kept: the endpoint's settings snapshot is
		// what every later start spawns from, not the settings as they are then.
		this.endpoint ??= this.host.endpointFor(endpointId);
		this.host.onStatus(this.status());

		const renderer = await this.ensureRenderer(hostEl);
		if (!renderer || generation !== this.generation) return;
		// From here on a renderer is mounted, so from here on every exit path owes
		// the tracker a grace period: a start that fails on a still-hidden leaf
		// (no herdr binary yet, say) would otherwise leave the renderer painting
		// with no timer left to suspend it. `arm()` is a no-op while visible.
		this.host.onStarted();

		let command: string[];
		try {
			// Local: `[<herdr>]`. Remote profile: `['ssh','-T',host,<remote herdr>]`
			// — terminals never go through the forwarded API socket (PRD S17).
			// The argv comes from the pinned endpoint's snapshot (issue #54).
			if (!this.endpoint) {
				throw new Error(`the endpoint ${endpointId} is no longer configured`);
			}
			command = this.host.commandFor(this.endpoint);
		} catch (error) {
			// A restored tab opens before `connect()` has discovered the binary
			// (discovery is async); the plugin announces the connection, and the
			// view retries this start once through `connectionArrived`. The
			// question here is whether the plugin has connected to *anything* yet:
			// a connection to the other herdr still means the binary was found, and
			// the error above is then the honest answer.
			this.awaitingConnection = !this.host.connected();
			this.closedReason = this.awaitingConnection
				? 'waiting for herdr'
				: (error as Error).message;
			this.exited = true;
			this.host.onStatus(this.status());
			return;
		}
		this.awaitingConnection = false;

		const fit = renderer.fit();
		// #65: the wheel's pixels-per-line divisor, and a fresh session is a fresh
		// gesture, so nothing of the previous one is carried.
		this.wheel.setPixelsPerLine(fit.cellHeightPx);
		this.cancelWheel();
		const cols = fit.cols > 0 ? fit.cols : FALLBACK_COLS;
		const rows = fit.rows > 0 ? fit.rows : FALLBACK_ROWS;
		const attach = attachFor(mode);
		const session = this.newSession({
			command,
			target: paneId,
			mode: attach.mode,
			takeover: attach.takeover,
			cols,
			rows,
			env: this.host.env(),
		});
		this.session = session;

		session.on('frame', (bytes: Uint8Array, meta: FrameMeta) => {
			if (this.session !== session) return;
			// #17: the input layer watches for the modes the pane's application
			// sets; seq 1 means a fresh bridge, so it starts from the defaults.
			this.input.observeFrame(bytes, meta.seq);
			this.perf?.frame(bytes.length);
			this.frames.push(bytes, meta.full);
			// Flushed into `this.renderer`, not the one captured above: a theme
			// rebuild (#53) swaps the renderer under a live session, and bytes must
			// land in the terminal that is on screen now.
			if (this.frames.pending >= MAX_PENDING_BYTES) this.flush();
			else this.scheduleFlush();
		});
		session.on('closed', (reason: string) => {
			if (this.session !== session) return;
			this.closedReason = reason;
			this.host.onStatus(this.status());
		});
		session.on('stderr', (line: string) => {
			if (this.session !== session) return;
			this.pushStderr(line);
		});
		session.on('error', (error: Error) => {
			if (this.session !== session) return;
			this.pushStderr(error.message);
		});
		session.on('exit', () => {
			if (this.session !== session) return;
			this.exited = true;
			this.host.onStatus(this.status());
		});

		session.start();
		if (attach.mode === 'control') {
			// The spawn argv already carries the grid; this adds the cell metrics
			// herdr uses for pixel-aware programs.
			session.resize(cols, rows, fit.cellWidthPx, fit.cellHeightPx);
			renderer.focus();
		}
		this.host.onStatus(this.status());
	}

	private pushStderr(line: string): void {
		this.stderr.push(line);
		if (this.stderr.length > MAX_STDERR_LINES) this.stderr.shift();
		this.host.onStatus(this.status());
	}

	/**
	 * Swaps the renderer under a **live** session (#53): snapshot, dispose, mount
	 * a fresh one from the current settings, replay the snapshot, re-fit.
	 *
	 * Deliberately not `start()`: the bridge process, its attach mode and its
	 * takeover are left exactly as they are, so a palette change cannot reclaim a
	 * pane another controller owns, cannot reconnect a session herdr closed, and
	 * cannot turn an observer into a controller. A terminal with no session at
	 * all — closed, or never started — just repaints its last frame.
	 */
	private async remountRenderer(): Promise<void> {
		// A mount already in flight has a `start()` waiting on it, and swapping the
		// renderer under that start makes its `ensureRenderer` answer null: it
		// leaves without spawning, and this path only mounts a terminal, so the
		// leaf would sit there attached to nothing. Let the mount finish first —
		// the terminal it built is the one snapshotted below, so the user loses
		// nothing by the wait. A mount that failed is awaited just the same; the
		// rejection is `ensureRenderer`'s to report, not this path's.
		await this.rendererReady?.catch(() => {});
		const hostEl = this.hostEl;
		if (!this.opened || this.isSuspended || !hostEl) return;
		const renderer = this.renderer;
		if (!renderer) return;
		// Coalesced bytes belong in the snapshot, not in the buffer a replacement
		// terminal may never be given a reason to drain.
		this.flush();
		this.cancelFlush();
		this.snapshot = renderer.snapshotLines?.() ?? null;
		renderer.dispose();
		this.renderer = null;
		this.rendererReady = null;
		this.wheelIntercepted = false;
		hostEl.empty();
		// `ensureRenderer` replays the snapshot into the new terminal on mount.
		const next = await this.ensureRenderer(hostEl);
		if (!next) return;
		// Same grid as before, so this normally sends herdr nothing at all.
		this.applyFit();
	}

	/**
	 * Mounts the renderer once; later calls reuse the same instance.
	 *
	 * Returns null when the mount failed **or** when the renderer it waited for
	 * was given up while it waited — a detach, a suspend or a rebuild during the
	 * mount — so no caller goes on to use a terminal that is already gone.
	 */
	private async ensureRenderer(hostEl: HTMLElement): Promise<TerminalRenderer | null> {
		let renderer = this.renderer;
		if (!renderer) {
			const mounting = this.newRenderer(this.host.rendererOptions());
			renderer = mounting;
			this.renderer = mounting;
			// Nothing is written into it until its mount continuation has replayed
			// what the previous terminal held.
			this.rendererMounted = false;
			this.rendererReady = mounting.mount(hostEl).then(() => {
				// The continuation of a mount nobody is waiting for any more: the
				// terminal it would install callbacks on is disposed, and replaying
				// here would eat the snapshot the next mount is there to restore.
				if (this.renderer !== mounting) return;
				mounting.onData((data) => this.onData(data));
				this.replaySnapshot(mounting);
				// The history is in; whatever the pane said while this was mounting
				// goes in after it, in arrival order.
				this.rendererMounted = true;
				this.flush();
				// #17/#18: keys pass the input layer before the renderer encodes
				// them, so shift+enter can be sent as a line break. Optional on the
				// interface; a renderer without it keeps its own encoding.
				mounting.onKeyEvent?.((event) => this.onKeyEvent(event));
				// #25: and every wheel notch, including the ones over the canvas
				// that the host element's own listener never sees.
				this.wheelIntercepted = mounting.onWheelEvent !== undefined;
				mounting.onWheelEvent?.((event) => this.onWheelEvent(event));
			});
		}
		try {
			await this.rendererReady;
		} catch (error) {
			// The failed renderer and its rejected promise are kept: mounting the
			// same engine again would fail the same way, and the status line
			// already says so.
			this.host.onRendererError(error);
			this.closedReason = 'the terminal renderer failed to start';
			this.exited = true;
			this.host.onStatus(this.status());
			return null;
		}
		return this.renderer === renderer ? renderer : null;
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

	/**
	 * One repaint per animation frame, however many frames herdr sent. Frames come
	 * from the window the terminal actually lives in, so a popout keeps painting
	 * while the main window is hidden.
	 */
	private scheduleFlush(): void {
		if (this.flushHandle) return;
		this.flushHandle = this.scheduler.requestAnimationFrame(() => {
			this.flushHandle = 0;
			this.flush();
		});
	}

	private flush(): void {
		const renderer = this.renderer;
		// Held, not dropped, while a renderer is still mounting: the mount
		// continuation flushes the buffer itself once the scrollback is replayed.
		if (!renderer || !this.rendererMounted) return;
		const batch = this.frames.take();
		if (!batch) return;
		renderer.write(batch);
		this.perf?.repaint();
	}

	private cancelFlush(): void {
		if (!this.flushHandle) return;
		this.scheduler.cancelAnimationFrame(this.flushHandle);
		this.flushHandle = 0;
	}

	/** Keystrokes. Observers never write to the pane (PRD S16). */
	private onData(data: string): void {
		const session = this.session;
		if (!session || session.mode !== 'control') return;
		session.input(data);
	}

	/**
	 * Keys the input layer encodes itself (#17, #18, #47). True means "consumed":
	 * the renderer swallows the event and emits nothing through `onData`, so a
	 * key we send is never also sent by ghostty-web's own encoder, and the
	 * renderer's `preventDefault` keeps shift+tab from moving focus.
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
	 * True consumes the notch; false when nothing was sent — no session, an
	 * observer, or a delta that rounds to nothing — so a terminal holding
	 * replayed scrollback still scrolls locally.
	 */
	private onWheelEvent(event: WheelEvent): boolean {
		return this.sendWheel(event);
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
			...pickModifiers(event),
		});
		// #65: a delta that only moved the accumulator's fraction along still
		// belongs to us — the gesture is being handled, one line at a time — so the
		// answer is whatever the gesture's last real emission got. Handing it back
		// to the renderer instead would let it scroll its own buffer on every
		// sub-line trackpad event, which is the flood this issue is about.
		if (!route) return this.lastWheelSent;
		this.lastWheelRoute = {
			...(route.column === undefined ? {} : { column: route.column }),
			...(route.row === undefined ? {} : { row: route.row }),
			modifiers: route.modifiers,
		};
		// One `terminal.scroll` per animation frame: the first notch of a frame goes
		// out at once so the terminal answers immediately, and everything that
		// arrives before the next frame — momentum, mostly — merges into the
		// accumulator and leaves as one request.
		if (this.wheelFrame) return this.lastWheelSent;
		this.lastWheelSent = this.emitWheel();
		this.wheelFrame = this.scheduler.requestAnimationFrame(() => {
			this.wheelFrame = 0;
			this.emitWheel();
		});
		return this.lastWheelSent;
	}

	/** Sends whatever whole lines the accumulator holds. False when none went. */
	private emitWheel(): boolean {
		const session = this.session;
		const scroll = this.wheel.take();
		if (!session || !scroll) return false;
		// False from an observer (`scroll` is control-only, PRD section 7) or from
		// a session whose bridge has exited: the notch was not sent, so the
		// renderer may as well scroll whatever it holds locally.
		return session.scroll(scroll.direction, scroll.lines, {
			source: 'wheel',
			...this.lastWheelRoute,
		});
	}

	/** Drops a pending coalescing frame and the gesture the accumulator held. */
	private cancelWheel(): void {
		if (this.wheelFrame) this.scheduler.cancelAnimationFrame(this.wheelFrame);
		this.wheelFrame = 0;
		this.wheel.reset();
		this.lastWheelSent = false;
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
		// #65: pixel deltas divide by the measured cell height, as ghostty does.
		this.wheel.setPixelsPerLine(fit.cellHeightPx);
		const session = this.session;
		if (!session || session.mode !== 'control') return;
		const current = session.size;
		if (current.cols === fit.cols && current.rows === fit.rows) return;
		session.resize(fit.cols, fit.rows, fit.cellWidthPx, fit.cellHeightPx);
	}

	/** Releases the terminal back to herdr; never leaves the child running. */
	private async stopSession(): Promise<void> {
		const session = this.session;
		this.session = null;
		if (!session) return;
		await session.dispose();
	}
}
