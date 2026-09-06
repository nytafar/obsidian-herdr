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
	computeFit,
	cssVar,
	parsePx,
	resolveFont,
	type FitResult,
	type RendererOptions,
	type ResolvedFont,
	type TerminalRenderer,
	type Unsubscribe,
} from './TerminalRenderer';

type DataListener = (data: string) => void;
type ResizeListener = (size: { cols: number; rows: number }) => void;

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
	private readonly libraryDisposables: { dispose(): void }[] = [];
	private focusRequested = false;

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

	onData(cb: DataListener): Unsubscribe {
		this.dataListeners.add(cb);
		return () => this.dataListeners.delete(cb);
	}

	onResize(cb: ResizeListener): Unsubscribe {
		this.resizeListeners.add(cb);
		return () => this.resizeListeners.delete(cb);
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

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.dataListeners.clear();
		this.resizeListeners.clear();
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
