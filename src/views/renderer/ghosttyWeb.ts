/**
 * ghostty-web implementation of `TerminalRenderer` (PRD M14).
 *
 * The 423 KB `ghostty-vt.wasm` is already inlined as a `data:` URL inside
 * `ghostty-web`'s own bundle, so a plain esbuild bundle of this file satisfies
 * PRD N5 (ship only main.js/manifest.json/styles.css) with no wasm file next to
 * the plugin. See notes/ghostty-web.md.
 *
 * Colours and fonts come from Obsidian CSS variables (PRD S18). The only styling
 * this file does is handing the library colour strings and a font; every element
 * and inline style in the terminal surface is injected by ghostty-web itself.
 *
 * Smoke-testing this needs a DOM plus the WASM, so it is not unit tested; see
 * tests/README.md for the in-Obsidian recipe.
 */
import { FitAddon, init, Terminal, type ITheme } from 'ghostty-web';
import {
	cellFromPoint,
	computeFit,
	cssVar,
	parsePx,
	resolveFont,
	type CellCoordinates,
	type FitResult,
	type RendererOptions,
	type ResolvedFont,
	type TerminalRenderer,
	type Unsubscribe,
} from './TerminalRenderer';

type DataListener = (data: string) => void;
type ResizeListener = (size: { cols: number; rows: number }) => void;
/** Returns true when it consumed the event; see `TerminalRenderer.onKeyEvent`. */
type KeyListener = (event: KeyboardEvent) => boolean;
type WheelListener = (event: WheelEvent) => boolean;

/** Obsidian variable → ITheme key. Missing variables are simply left unset. */
const THEME_VARS: Record<keyof ITheme, string> = {
	foreground: '--text-normal',
	background: '--background-primary',
	cursor: '--text-accent',
	cursorAccent: '--background-primary',
	selectionBackground: '--text-selection',
	selectionForeground: '--text-normal',
	black: '--color-base-30',
	red: '--color-red',
	green: '--color-green',
	yellow: '--color-yellow',
	blue: '--color-blue',
	magenta: '--color-purple',
	cyan: '--color-cyan',
	white: '--color-base-70',
	brightBlack: '--color-base-50',
	brightRed: '--color-red',
	brightGreen: '--color-green',
	brightYellow: '--color-orange',
	brightBlue: '--color-blue',
	brightMagenta: '--color-pink',
	brightCyan: '--color-cyan',
	brightWhite: '--color-base-100',
};

/**
 * Ceiling on a `snapshotLines()` result. A 64 MB scrollback budget holds ~38 000
 * lines; keeping all of them as JS strings while the view is hidden would trade
 * one kind of memory for another, so only the newest ones survive a hide.
 */
export const MAX_SNAPSHOT_LINES = 10_000;

export class GhosttyWebRenderer implements TerminalRenderer {
	private readonly options: RendererOptions;
	private terminal: Terminal | undefined;
	private fitAddon: FitAddon | undefined;
	private container: HTMLElement | undefined;
	private mounting: Promise<void> | undefined;
	private disposed = false;

	/** Writes that arrived before the WASM finished loading. */
	private readonly pending: Uint8Array[] = [];
	private readonly dataListeners = new Set<DataListener>();
	private readonly resizeListeners = new Set<ResizeListener>();
	private readonly keyListeners = new Set<KeyListener>();
	private readonly wheelListeners = new Set<WheelListener>();
	private readonly libraryDisposables: { dispose(): void }[] = [];
	private focusRequested = false;
	/** ghostty-web holds one handler each; ours dispatch to the sets above. */
	private interceptorsAttached = false;

	constructor(options: RendererOptions = {}) {
		this.options = options;
	}

	async mount(el: HTMLElement): Promise<void> {
		if (this.disposed) throw new Error('renderer disposed');
		if (this.mounting) return this.mounting;
		this.container = el;
		this.mounting = this.doMount(el);
		return this.mounting;
	}

	private async doMount(el: HTMLElement): Promise<void> {
		// Loads the inlined WASM; a no-op on later calls.
		await init();
		if (this.disposed) return;

		const font = this.readFont(el);
		const terminal = new Terminal({
			fontFamily: font.fontFamily,
			fontSize: font.fontSize,
			theme: this.readTheme(el),
			// ghostty-web's `scrollback` is a BYTE budget handed to libghostty-vt's
			// page list, not a line count, and `0` means "no limit": measured
			// headlessly, a terminal with 0 grew the shared WASM heap past 1 GB
			// after 200k lines, while the 10 KB default caps it at ~5.4 MB / ~445
			// lines (notes/memory.md). Only a positive number is ever passed on.
			...(typeof this.options.scrollback === 'number' &&
			Number.isFinite(this.options.scrollback) &&
			this.options.scrollback > 0
				? { scrollback: this.options.scrollback }
				: {}),
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
		const fitAddon = new FitAddon();
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
		// Listeners registered before the WASM finished loading.
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

	fit(): FitResult {
		const terminal = this.terminal;
		const el = terminal?.element ?? this.container;
		const current: FitResult = {
			cols: terminal?.cols ?? 0,
			rows: terminal?.rows ?? 0,
			cellWidthPx: 0,
			cellHeightPx: 0,
		};
		if (this.disposed || !terminal || !el) return current;

		const metrics = terminal.renderer?.getMetrics();
		if (!metrics) return current;

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
	 * `TerminalRenderer.cellAt`. Measures against the canvas when there is one —
	 * it is the grid box itself, so no padding has to be subtracted — and falls
	 * back to the container, whose padding then does. Both rects and the cell
	 * metrics are CSS pixels; see `cellFromPoint`.
	 */
	cellAt(clientX: number, clientY: number): CellCoordinates | undefined {
		const terminal = this.terminal;
		if (this.disposed || !terminal) return undefined;
		const metrics = terminal.renderer?.getMetrics();
		if (!metrics) return undefined;
		const canvas = terminal.renderer?.getCanvas();
		const el = canvas ?? terminal.element ?? this.container;
		if (!el) return undefined;
		const rect = el.getBoundingClientRect();
		const view = el.ownerDocument.defaultView;
		const style = canvas ? undefined : view?.getComputedStyle(el);
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

	/** See `TerminalRenderer.onKeyEvent`: true from `cb` consumes the key. */
	onKeyEvent(cb: KeyListener): Unsubscribe {
		this.keyListeners.add(cb);
		this.attachInterceptors();
		return () => this.keyListeners.delete(cb);
	}

	onWheelEvent(cb: WheelListener): Unsubscribe {
		this.wheelListeners.add(cb);
		this.attachInterceptors();
		return () => this.wheelListeners.delete(cb);
	}

	/**
	 * ghostty-web takes a single key handler and a single wheel handler, and both
	 * mean "true: I handled it, stop" — the opposite of xterm.js. They are
	 * attached once, after `open()`, and dispatch to the listener sets; with no
	 * listeners they return false and the library behaves exactly as before.
	 */
	private attachInterceptors(): void {
		const terminal = this.terminal;
		if (this.interceptorsAttached || this.disposed || !terminal) return;
		this.interceptorsAttached = true;
		terminal.attachCustomKeyEventHandler((event) =>
			dispatch(this.keyListeners, event),
		);
		terminal.attachCustomWheelEventHandler((event) =>
			dispatch(this.wheelListeners, event),
		);
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
	 * Re-read Obsidian's CSS variables. The optional `TerminalRenderer.refreshTheme`;
	 * the view calls it from the workspace `css-change` event (PRD S18).
	 */
	refreshTheme(): void {
		const el = this.container;
		if (this.disposed || !this.terminal || !el) return;
		const font = this.readFont(el);
		this.terminal.options.theme = this.readTheme(el);
		this.terminal.options.fontFamily = font.fontFamily;
		this.terminal.options.fontSize = font.fontSize;
		this.fit();
	}

	/**
	 * `TerminalRenderer.snapshotLines`. `buffer.active` indexes scrollback first and
	 * the screen after it (`length` = scrollback + rows), so one pass over it is the
	 * whole history; on the alternate screen it is just the visible grid, which is
	 * all that screen ever holds.
	 *
	 * Plain text only: `translateToString` drops every colour and attribute. That is
	 * the accepted cost of freeing a hidden terminal's WASM state (notes/memory.md).
	 */
	snapshotLines(): string[] {
		const terminal = this.terminal;
		if (this.disposed || !terminal) return [];
		const buffer = terminal.buffer.active;
		const total = Math.max(0, Math.min(buffer.length, MAX_SNAPSHOT_LINES));
		// Keep the newest lines: a large budget can hold tens of thousands, and the
		// snapshot lives on the JS heap while the view is hidden.
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
		for (const d of this.libraryDisposables.splice(0)) {
			try {
				d.dispose();
			} catch {
				// A listener the library already tore down; nothing to do.
			}
		}
		this.fitAddon?.dispose();
		this.fitAddon = undefined;
		this.terminal?.dispose();
		this.terminal = undefined;
		this.container = undefined;
		this.mounting = undefined;
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

	private readTheme(el: HTMLElement): ITheme {
		const read = this.readVars(el);
		const theme: ITheme = {};
		for (const [key, varName] of Object.entries(THEME_VARS)) {
			const value = read(varName);
			if (value) theme[key as keyof ITheme] = value;
		}
		return theme;
	}
}

/**
 * Runs every interceptor; true from any of them consumes the event. A listener
 * that throws must not take the keyboard down with it, so it counts as "not
 * consumed" and the library's own encoding still runs.
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
