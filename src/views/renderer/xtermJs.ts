/**
 * xterm.js implementation of `TerminalRenderer` (PRD M14, issue #27).
 *
 * `@xterm/xterm` 5.5.0 and `@xterm/addon-fit` 0.10.0, both MIT (see
 * `node_modules/@xterm/xterm/LICENSE`). Pinned to exact versions like
 * ghostty-web, for the same reason: the terminal is the risky dependency.
 *
 * Why a second engine at all: ghostty-web repaints unconditionally at 60 fps per
 * open terminal and never gives its WebAssembly memory back to the OS
 * (notes/memory.md). xterm.js renders into the DOM, only touches rows its render
 * debouncer marked dirty, and keeps its buffer on the JS heap, which a GC can
 * return. It is also nine years old where ghostty-web is months old.
 *
 * Three things differ from ghostty-web and are handled here, not by the caller:
 *
 * 1. **Key polarity is inverted.** `attachCustomKeyEventHandler` returns "let
 *    xterm handle it", the interface's `onKeyEvent` returns "I consumed it".
 * 2. **The wheel needs a capture-phase listener.** xterm has
 *    `attachCustomWheelEventHandler`, but it runs on a listener bound to
 *    `.xterm` in the bubble phase and returning false there does not stop the
 *    browser scrolling `.xterm-viewport`, which is a real scrollable div. Our
 *    listener sits on the host element in the capture phase, so a consumed notch
 *    is stopped before either can act — the same polarity ghostty-web has:
 *    **true means consumed**.
 * 3. **`scrollback` means lines here, bytes there.** `RendererOptions.scrollback`
 *    is ghostty-web's byte budget; see {@link scrollbackLines}.
 *
 * No WebGL addon: `@xterm/addon-webgl` would work in Electron but costs bundle
 * size, and the DOM renderer is what this engine is being measured as.
 *
 * Styling: the rules xterm needs from its `xterm.css` are inlined in
 * `styles.css` under `.herdr-terminal-host`, because PRD N5 ships only
 * main.js/manifest.json/styles.css. No inline styles are set here; colours and
 * fonts go through `terminal.options`, exactly like the ghostty-web renderer.
 *
 * Smoke-testing needs a DOM, so this file is not unit tested; see
 * `tests/README.md`.
 */
import type { FitAddon } from '@xterm/addon-fit';
import type { IDisposable, ITheme, Terminal } from '@xterm/xterm';
import {
	cellFromPoint,
	computeFit,
	cssVar,
	parsePx,
	resolveFont,
	type CellCoordinates,
	type CursorOptions,
	type FitResult,
	type RendererOptions,
	type ResolvedFont,
	type TerminalRenderer,
	type Unsubscribe,
} from './TerminalRenderer';
import {
	followsObsidian,
	normalizeThemeName,
	obsidianTheme,
	resolveTheme,
	type TerminalTheme,
	type TerminalThemeName,
} from './themes';
import {
	applyUnicodeWidths,
	UNICODE_TERMINAL_OPTIONS,
} from './unicodeWidth';
import { isHTMLElement } from '../dom';

/**
 * The libraries are loaded on first mount rather than at module scope, so a
 * vault that never leaves the default engine never evaluates them. The Unicode
 * 11 width table loads the same way, from `unicodeWidth.ts`. esbuild keeps
 * both inside `main.js` (the output is one CJS file, so a dynamic import becomes
 * a lazy `require` of a bundled module, not a second file — PRD N5); what is
 * deferred is the cost of running them, and, incidentally, the `self` reference
 * in their UMD preamble, which node has none of.
 */
type XtermModule = typeof import('@xterm/xterm');
type FitModule = typeof import('@xterm/addon-fit');

let libraries: Promise<{ xterm: XtermModule; fit: FitModule }> | undefined;

/** Loads `@xterm/xterm` and `@xterm/addon-fit` once per window. */
async function loadLibraries(): Promise<{ xterm: XtermModule; fit: FitModule }> {
	libraries ??= (async () => {
		const [xterm, fit] = await Promise.all([
			import('@xterm/xterm'),
			import('@xterm/addon-fit'),
		]);
		return { xterm, fit };
	})();
	return libraries;
}

type DataListener = (data: string) => void;
type ResizeListener = (size: { cols: number; rows: number }) => void;
/** Returns true when it consumed the event; see `TerminalRenderer.onKeyEvent`. */
type KeyListener = (event: KeyboardEvent) => boolean;
type WheelListener = (event: WheelEvent) => boolean;

/**
 * Same ceiling as the ghostty-web renderer's, and for the same reason: a
 * `snapshotLines()` result lives on the JS heap for as long as the view is
 * hidden (#15).
 */
export const MAX_SNAPSHOT_LINES = 10_000;

/**
 * How many scrollback *lines* one megabyte of ghostty-web's byte budget buys,
 * measured at ~600 in notes/memory.md. The setting is written in those units, so
 * the two engines have to be told the same history in the units each takes.
 */
export const LINES_PER_SCROLLBACK_MB = 600;
const BYTES_PER_MB = 1_000_000;
export const MIN_SCROLLBACK_LINES = 100;
/** 64 MB, the setting's ceiling, at 600 lines/MB. */
export const MAX_SCROLLBACK_LINES = 40_000;

/**
 * The byte budget the setting hands us, expressed as the line count xterm.js
 * wants, so both engines hold roughly the same history for one setting value.
 *
 * xterm's own cost is not this number of bytes: a `BufferLine` is a
 * `Uint32Array` of three words per cell, i.e. ~1.4 KB for a 120-column line, so
 * 6 000 lines is ~8 MB of JS heap. That heap is reclaimable, which the WASM one
 * is not (notes/memory.md). Undefined in → undefined out, meaning xterm's own
 * default of 1 000 lines.
 */
export function scrollbackLines(bytes: number | undefined): number | undefined {
	if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
		return undefined;
	}
	const lines = Math.round((bytes / BYTES_PER_MB) * LINES_PER_SCROLLBACK_MB);
	return Math.min(MAX_SCROLLBACK_LINES, Math.max(MIN_SCROLLBACK_LINES, lines));
}

/** Cell box in CSS pixels. */
interface CellMetrics {
	width: number;
	height: number;
}

/**
 * xterm's internals as `@xterm/addon-fit` itself reaches into them. The addon's
 * own `proposeDimensions()` reads `_core._renderService.dimensions.css.cell`
 * (see `node_modules/@xterm/addon-fit/src/FitAddon.ts`), so this is the
 * supported-in-practice path rather than a new liberty; it is still private, so
 * every access below is guarded and falls back to measuring the DOM.
 */
interface XtermInternals {
	_core?: {
		_renderService?: {
			dimensions?: { css?: { cell?: { width?: number; height?: number } } };
		};
	};
}

export class XtermJsRenderer implements TerminalRenderer {
	private readonly options: RendererOptions;
	private themeName: TerminalThemeName;
	private terminal: Terminal | undefined;
	private fitAddon: FitAddon | undefined;
	private container: HTMLElement | undefined;
	private mounting: Promise<void> | undefined;
	private disposed = false;

	/** Writes that arrived before `mount()` built the terminal. */
	private readonly pending: Uint8Array[] = [];
	private readonly dataListeners = new Set<DataListener>();
	private readonly resizeListeners = new Set<ResizeListener>();
	private readonly keyListeners = new Set<KeyListener>();
	private readonly wheelListeners = new Set<WheelListener>();
	private readonly libraryDisposables: IDisposable[] = [];
	private focusRequested = false;
	private interceptorsAttached = false;
	/** Removes the capture-phase wheel listener; see `attachInterceptors`. */
	private detachWheel: (() => void) | undefined;

	constructor(options: RendererOptions = {}) {
		this.options = options;
		this.themeName = normalizeThemeName(options.theme);
	}

	async mount(el: HTMLElement): Promise<void> {
		if (this.disposed) throw new Error('renderer disposed');
		if (this.mounting) return this.mounting;
		this.container = el;
		this.mounting = this.doMount(el);
		return this.mounting;
	}

	/**
	 * Resolves once both libraries are loaded and `open()` has run; unlike
	 * ghostty-web there is no WASM to compile, so this is one dynamic import.
	 */
	private async doMount(el: HTMLElement): Promise<void> {
		const { xterm, fit } = await loadLibraries();
		if (this.disposed) return;

		const font = this.readFont(el);
		const scrollback = scrollbackLines(this.options.scrollback);
		const terminal = new xterm.Terminal({
			// Wide-glyph widths; the flag and the addon travel together, see
			// `unicodeWidth.ts`.
			...UNICODE_TERMINAL_OPTIONS,
			fontFamily: font.fontFamily,
			fontSize: font.fontSize,
			theme: this.currentTheme(el),
			// Lines, not bytes — see `scrollbackLines`.
			...(scrollback === undefined ? {} : { scrollback }),
			...(this.options.disableStdin === undefined
				? {}
				: { disableStdin: this.options.disableStdin }),
			...(this.options.cursorBlink === undefined
				? {}
				: { cursorBlink: this.options.cursorBlink }),
			...(this.options.cursorStyle === undefined
				? {}
				: { cursorStyle: this.options.cursorStyle }),
		});
		// Before `open()` and before any pending frame is replayed: a glyph
		// written under the built-in Unicode 6 table stays mismeasured in the
		// buffer, and herdr's frames start arriving the moment the session opens.
		await applyUnicodeWidths(terminal);
		if (this.disposed) {
			terminal.dispose();
			return;
		}

		const fitAddon = new fit.FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(el);

		this.libraryDisposables.push(
			terminal.onData((data) => {
				for (const cb of [...this.dataListeners]) cb(data);
			}),
			terminal.onResize((size) => {
				for (const cb of [...this.resizeListeners]) cb(size);
			}),
		);

		this.terminal = terminal;
		this.fitAddon = fitAddon;
		this.attachInterceptors();

		for (const chunk of this.pending.splice(0)) terminal.write(chunk);
		this.fit();
		if (this.focusRequested) {
			this.focusRequested = false;
			terminal.focus();
		}
	}

	write(bytes: Uint8Array): void {
		if (this.disposed) return;
		if (!this.terminal) {
			this.pending.push(bytes);
			return;
		}
		this.terminal.write(bytes);
	}

	resize(cols: number, rows: number): void {
		if (this.disposed || !this.terminal) return;
		if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
		const safeCols = Math.max(1, Math.floor(cols));
		const safeRows = Math.max(1, Math.floor(rows));
		if (safeCols === this.terminal.cols && safeRows === this.terminal.rows) {
			return;
		}
		this.terminal.resize(safeCols, safeRows);
	}

	/**
	 * The shared `computeFit` maths on the container box, so a terminal is the
	 * same grid whichever engine drew it. `proposeDimensions()` from
	 * `@xterm/addon-fit` is the fallback for the case where we can read a grid but
	 * not the cell box; it measures `element.parentElement`, which is our host.
	 */
	fit(): FitResult {
		const terminal = this.terminal;
		const el = this.container ?? terminal?.element?.parentElement ?? undefined;
		const current: FitResult = {
			cols: terminal?.cols ?? 0,
			rows: terminal?.rows ?? 0,
			cellWidthPx: 0,
			cellHeightPx: 0,
		};
		if (this.disposed || !terminal || !el) return current;

		const metrics = this.cellMetrics();
		if (!metrics) {
			const proposal = this.fitAddon?.proposeDimensions();
			if (!proposal) return current;
			this.resize(proposal.cols, proposal.rows);
			return { ...current, cols: proposal.cols, rows: proposal.rows };
		}

		const view = el.ownerDocument.defaultView;
		const style = view?.getComputedStyle(el);
		const proposal = computeFit({
			clientWidth: el.clientWidth,
			clientHeight: el.clientHeight,
			paddingLeft: parsePx(style?.paddingLeft) ?? 0,
			paddingRight: parsePx(style?.paddingRight) ?? 0,
			paddingTop: parsePx(style?.paddingTop) ?? 0,
			paddingBottom: parsePx(style?.paddingBottom) ?? 0,
			cellWidthPx: metrics.width,
			cellHeightPx: metrics.height,
		});
		if (!proposal) {
			return {
				...current,
				cellWidthPx: metrics.width,
				cellHeightPx: metrics.height,
			};
		}
		this.resize(proposal.cols, proposal.rows);
		return proposal;
	}

	/**
	 * `TerminalRenderer.cellAt`. Measured against `.xterm-screen`, the element the
	 * rows are laid out in, so no padding has to be subtracted; the terminal
	 * element and then the container are the fallbacks, and the container's
	 * padding does count.
	 */
	cellAt(clientX: number, clientY: number): CellCoordinates | undefined {
		const terminal = this.terminal;
		if (this.disposed || !terminal) return undefined;
		const metrics = this.cellMetrics();
		if (!metrics) return undefined;
		const screen = terminal.element?.querySelector('.xterm-screen');
		const el = isHTMLElement(screen)
			? screen
			: (terminal.element ?? this.container);
		if (!el) return undefined;
		const rect = el.getBoundingClientRect();
		const view = el.ownerDocument.defaultView;
		const style = screen ? undefined : view?.getComputedStyle(el);
		return cellFromPoint({
			clientX,
			clientY,
			left: rect.left,
			top: rect.top,
			paddingLeft: parsePx(style?.paddingLeft) ?? 0,
			paddingTop: parsePx(style?.paddingTop) ?? 0,
			cellWidthPx: metrics.width,
			cellHeightPx: metrics.height,
			cols: terminal.cols,
			rows: terminal.rows,
		});
	}

	onData(cb: DataListener): Unsubscribe {
		this.dataListeners.add(cb);
		return () => this.dataListeners.delete(cb);
	}

	onResize(cb: ResizeListener): Unsubscribe {
		this.resizeListeners.add(cb);
		return () => this.resizeListeners.delete(cb);
	}

	/**
	 * See `TerminalRenderer.onKeyEvent`: true from `cb` consumes the key. The
	 * inversion into xterm's polarity happens in `attachInterceptors`.
	 */
	onKeyEvent(cb: KeyListener): Unsubscribe {
		this.keyListeners.add(cb);
		this.attachInterceptors();
		return () => this.keyListeners.delete(cb);
	}

	/** True from `cb` means the notch was consumed and xterm must not scroll. */
	onWheelEvent(cb: WheelListener): Unsubscribe {
		this.wheelListeners.add(cb);
		this.attachInterceptors();
		return () => this.wheelListeners.delete(cb);
	}

	/**
	 * Attached once, after `open()`. Both hooks dispatch to the listener sets, so
	 * with no listeners xterm behaves exactly as it would unhooked.
	 *
	 * The key hook inverts: our callbacks return "consumed", xterm's contract is
	 * "process this in the terminal", so a consumed key returns false and xterm
	 * emits nothing through `onData` — plus a `preventDefault()` xterm would not
	 * do for us.
	 *
	 * The wheel hook is ours, not xterm's. `attachCustomWheelEventHandler` is
	 * consulted by a bubble-phase listener on `.xterm`, and returning false there
	 * leaves `.xterm-viewport` — a real overflow-scroll div — to scroll natively.
	 * A capture-phase listener on the host runs before both, and a consumed notch
	 * gets `preventDefault()` (no native scroll) and `stopPropagation()` (xterm
	 * never sees it).
	 */
	private attachInterceptors(): void {
		const terminal = this.terminal;
		const el = this.container;
		if (this.interceptorsAttached || this.disposed || !terminal || !el) return;
		this.interceptorsAttached = true;
		terminal.attachCustomKeyEventHandler((event) => {
			if (!dispatch(this.keyListeners, event)) return true;
			// xterm returns early without preventing the default when its embedder
			// claims a key, so the browser would still act on it: the character
			// would land in the hidden textarea, and Tab would move focus out of
			// the terminal. The interface promises the event is swallowed, so it
			// is swallowed here.
			event.preventDefault();
			return false;
		});
		const onWheel = (event: WheelEvent): void => {
			if (!dispatch(this.wheelListeners, event)) return;
			event.preventDefault();
			event.stopPropagation();
		};
		// `passive: false` because a consumed notch must be preventable.
		el.addEventListener('wheel', onWheel, { capture: true, passive: false });
		this.detachWheel = () =>
			el.removeEventListener('wheel', onWheel, { capture: true });
	}

	focus(): void {
		if (this.disposed) return;
		if (!this.terminal) {
			this.focusRequested = true;
			return;
		}
		this.terminal.focus();
	}

	/**
	 * The optional `TerminalRenderer.refreshTheme`, same contract and the same
	 * short-circuits as the ghostty-web renderer: no argument keeps the current
	 * theme and only re-reads the fonts, a name switches the palette.
	 */
	/**
	 * True (issue #53): xterm.js routes `options.theme` through its theme service,
	 * which repaints the open terminal, so the view never has to rebuild this one
	 * for a palette change.
	 */
	canUpdateThemeInPlace(): boolean {
		return true;
	}

	/** `TerminalRenderer.applyCursor` (issue #52); both options apply in place. */
	applyCursor(cursor: CursorOptions): void {
		this.options.cursorStyle = cursor.cursorStyle;
		this.options.cursorBlink = cursor.cursorBlink;
		if (this.disposed || !this.terminal) return;
		this.terminal.options.cursorStyle = cursor.cursorStyle;
		this.terminal.options.cursorBlink = cursor.cursorBlink;
	}

	refreshTheme(theme?: string): void {
		const next = theme === undefined ? this.themeName : normalizeThemeName(theme);
		const changed = next !== this.themeName;
		this.themeName = next;
		const el = this.container;
		if (this.disposed || !this.terminal || !el) return;
		const font = this.readFont(el);
		if (changed || followsObsidian(next)) {
			this.terminal.options.theme = this.currentTheme(el);
		}
		this.terminal.options.fontFamily = font.fontFamily;
		this.terminal.options.fontSize = font.fontSize;
		this.fit();
	}

	/**
	 * `TerminalRenderer.snapshotLines`. `buffer.active` indexes scrollback first
	 * and the screen after it, exactly like ghostty-web's, so one pass is the whole
	 * history. Plain text: `translateToString` drops every colour and attribute.
	 */
	snapshotLines(): string[] {
		const terminal = this.terminal;
		if (this.disposed || !terminal) return [];
		const buffer = terminal.buffer.active;
		const total = Math.max(0, Math.min(buffer.length, MAX_SNAPSHOT_LINES));
		const from = Math.max(0, buffer.length - total);
		const lines: string[] = [];
		for (let y = from; y < buffer.length; y++) {
			lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
		}
		while (lines.length > 0 && (lines.at(-1) ?? '').trim().length === 0) lines.pop();
		return lines;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.dataListeners.clear();
		this.resizeListeners.clear();
		this.keyListeners.clear();
		this.wheelListeners.clear();
		this.interceptorsAttached = false;
		this.pending.length = 0;
		this.detachWheel?.();
		this.detachWheel = undefined;
		for (const d of this.libraryDisposables.splice(0)) {
			try {
				d.dispose();
			} catch {
				// A listener the library already tore down; nothing to do.
			}
		}
		this.fitAddon?.dispose();
		this.fitAddon = undefined;
		const element = this.terminal?.element;
		this.terminal?.dispose();
		// xterm 5.5 leaves its element in the DOM; the WASM renderer's teardown
		// removes its canvas, so match that and give the host back empty.
		element?.remove();
		this.terminal = undefined;
		this.container = undefined;
		this.mounting = undefined;
	}

	/**
	 * The cell box in CSS pixels. First choice is the render service's own
	 * measurement, reached the way `@xterm/addon-fit` reaches it; when that is
	 * missing or zero (before the first render, or if a future xterm renames the
	 * field) the box is measured from the DOM instead: `.xterm-screen` is exactly
	 * `cols` by `rows` cells.
	 */
	private cellMetrics(): CellMetrics | undefined {
		const terminal = this.terminal;
		if (!terminal) return undefined;
		const cell = (terminal as unknown as XtermInternals)._core?._renderService
			?.dimensions?.css?.cell;
		if (isPositive(cell?.width) && isPositive(cell?.height)) {
			return { width: cell.width, height: cell.height };
		}
		const screen = terminal.element?.querySelector('.xterm-screen');
		if (!isHTMLElement(screen)) return undefined;
		const rect = screen.getBoundingClientRect();
		const width = rect.width / Math.max(1, terminal.cols);
		const height = rect.height / Math.max(1, terminal.rows);
		if (!isPositive(width) || !isPositive(height)) return undefined;
		return { width, height };
	}

	private readVars(el: HTMLElement): (name: string) => string | undefined {
		const view = el.ownerDocument.defaultView;
		if (!view) return () => undefined;
		const style = view.getComputedStyle(el.ownerDocument.body);
		return (name) => cssVar(style.getPropertyValue(name));
	}

	private readFont(el: HTMLElement): ResolvedFont {
		const read = this.readVars(el);
		const view = el.ownerDocument.defaultView;
		const computed = view?.getComputedStyle(el);
		return resolveFont(this.options, {
			fontFamily: read('--font-monospace') ?? read('--font-monospace-theme'),
			fontSize:
				parsePx(read('--font-text-size')) ?? parsePx(computed?.fontSize),
		});
	}

	/** Colours for the current theme name; `ITheme`'s keys are `TerminalTheme`'s. */
	private currentTheme(el: HTMLElement): ITheme {
		return resolveTheme(this.themeName, this.readObsidianTheme(el));
	}

	private readObsidianTheme(el: HTMLElement): TerminalTheme {
		// A palette needs none of this, and reading the CSS variables is not free.
		if (!followsObsidian(this.themeName)) return {};
		return obsidianTheme(this.readVars(el), {
			dark: el.ownerDocument.body.classList.contains('theme-dark'),
		});
	}
}

/**
 * Runs every interceptor; true from any of them consumes the event. A listener
 * that throws must not take the keyboard down with it, so it counts as "not
 * consumed" and xterm's own encoding still runs.
 */
function dispatch<E>(listeners: Set<(event: E) => boolean>, event: E): boolean {
	let consumed = false;
	for (const listener of [...listeners]) {
		try {
			if (listener(event)) consumed = true;
		} catch {
			// A broken interceptor falls back to the renderer's own handling.
		}
	}
	return consumed;
}

function isPositive(value: number | undefined): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
