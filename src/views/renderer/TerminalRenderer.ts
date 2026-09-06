/**
 * PRD M14: the terminal view talks to a renderer only through this interface, so
 * ghostty-web can be swapped for xterm.js without touching the bridge.
 *
 * Nothing in this file may import a renderer library: it holds the contract plus
 * the pure helpers (option normalisation, fit maths) that the DOM-free unit tests
 * cover. The one place that names an implementation is `createRenderer` in
 * `./create.ts`; swapping ghostty-web for xterm.js is that one line plus a new
 * file next to `ghosttyWeb.ts`. See `tests/README.md` for the manual smoke.
 */

/** Removes a listener registered with `onData` / `onResize`. Idempotent. */
export type Unsubscribe = () => void;

/** Result of a fit: the grid the container can hold, plus the measured cell box. */
export interface FitResult {
	cols: number;
	rows: number;
	cellWidthPx: number;
	cellHeightPx: number;
}

/**
 * Renderer knobs the plugin owns. PRD S18: fonts follow Obsidian unless the user
 * overrides them, so `undefined` (and `0` / `''`, which is what an emptied
 * settings field produces) means "ask Obsidian".
 */
export interface RendererOptions {
	/** Font family stack. Undefined/empty → Obsidian's `--font-monospace`. */
	fontFamily?: string;
	/** Font size in px. Undefined/0 → Obsidian's computed monospace size. */
	fontSize?: number;
	/** Scrollback lines. Undefined → renderer default. */
	scrollback?: number;
	/** Observe mode (PRD S16) sets this so keystrokes never reach the pane. */
	disableStdin?: boolean;
	cursorBlink?: boolean;
	cursorStyle?: 'block' | 'underline' | 'bar';
}

export interface TerminalRenderer {
	/** Create the terminal inside `el`. Resolves once it can accept writes. */
	mount(el: HTMLElement): Promise<void>;
	/** Feed raw bytes from the herdr bridge. Buffered until mounted. */
	write(bytes: Uint8Array): void;
	/** Force a grid size (e.g. to match what herdr reports for a pane). */
	resize(cols: number, rows: number): void;
	/** Measure the container and resize to fit it. */
	fit(): FitResult;
	/** User input as UTF-8-encodable text, ready for `terminal.input`. */
	onData(cb: (data: string) => void): Unsubscribe;
	onResize(cb: (size: { cols: number; rows: number }) => void): Unsubscribe;
	/**
	 * Sees a keydown *before* the renderer encodes it, so the input layer
	 * (`src/views/input/`, #17) can send its own bytes for keys the renderer
	 * would get wrong — shift+enter in #18, for one.
	 *
	 * The callback returns **true when it consumed the key**: the renderer must
	 * then swallow the event and emit nothing through `onData`. Note the polarity
	 * is ghostty-web's, and it is the inverse of xterm.js's
	 * `attachCustomKeyEventHandler`, where true means "let the terminal handle
	 * it"; an xterm.js renderer implementing this method has to invert.
	 *
	 * Optional: a renderer without it simply never routes keys through the layer,
	 * and the view falls back to the default encoding.
	 */
	onKeyEvent?(cb: (event: KeyboardEvent) => boolean): Unsubscribe;
	/**
	 * The same interception for the wheel, for #25/#33: true means the callback
	 * handled the notch and the renderer must not scroll its own viewport.
	 */
	onWheelEvent?(cb: (event: WheelEvent) => boolean): Unsubscribe;
	focus(): void;
	/**
	 * Re-read Obsidian's CSS variables after a theme switch (PRD S18). Optional:
	 * a renderer that takes its colours some other way simply omits it and the
	 * view's `css-change` handler does nothing.
	 */
	refreshTheme?(): void;
	dispose(): void;
}

/** Font values resolved from options plus whatever Obsidian's CSS gives us. */
export interface ResolvedFont {
	fontFamily: string;
	fontSize: number;
}

/** Last-resort values if Obsidian hands us nothing usable (headless tests, etc.). */
export const FALLBACK_FONT_FAMILY = 'monospace';
export const FALLBACK_FONT_SIZE = 14;

/**
 * PRD S18. Explicit settings win; blank/zero settings fall back to the Obsidian
 * values, then to a neutral default. Sizes are clamped to a sane range so a
 * corrupt setting cannot produce a zero-height cell (which would make fit maths
 * divide by zero).
 */
export function resolveFont(
	options: RendererOptions | undefined,
	fromObsidian: Partial<ResolvedFont> = {},
): ResolvedFont {
	const family = firstNonEmpty(
		options?.fontFamily,
		fromObsidian.fontFamily,
		FALLBACK_FONT_FAMILY,
	);
	const size = firstPositive(
		options?.fontSize,
		fromObsidian.fontSize,
		FALLBACK_FONT_SIZE,
	);
	return { fontFamily: family, fontSize: clamp(size, 6, 72) };
}

/** Container geometry needed for a fit; all values in CSS pixels. */
export interface FitInput {
	clientWidth: number;
	clientHeight: number;
	paddingLeft?: number;
	paddingRight?: number;
	paddingTop?: number;
	paddingBottom?: number;
	cellWidthPx: number;
	cellHeightPx: number;
}

/** Width ghostty-web's own FitAddon reserves for the scrollbar. */
export const SCROLLBAR_RESERVE_PX = 15;
export const MIN_COLS = 2;
export const MIN_ROWS = 1;

/**
 * The formula ghostty-web 0.4.0's FitAddon uses (see notes/obsidian-api.md), kept
 * here so it is testable and so `fit()` can return the cell metrics too.
 * Returns `undefined` when the container or the metrics are not measurable yet —
 * i.e. while the leaf is hidden — exactly like `proposeDimensions()`.
 */
export function computeFit(input: FitInput): FitResult | undefined {
	const { clientWidth, clientHeight, cellWidthPx, cellHeightPx } = input;
	if (
		!isPositive(clientWidth) ||
		!isPositive(clientHeight) ||
		!isPositive(cellWidthPx) ||
		!isPositive(cellHeightPx)
	) {
		return undefined;
	}
	const usableWidth =
		clientWidth -
		(input.paddingLeft ?? 0) -
		(input.paddingRight ?? 0) -
		SCROLLBAR_RESERVE_PX;
	const usableHeight =
		clientHeight - (input.paddingTop ?? 0) - (input.paddingBottom ?? 0);
	return {
		cols: Math.max(MIN_COLS, Math.floor(usableWidth / cellWidthPx)),
		rows: Math.max(MIN_ROWS, Math.floor(usableHeight / cellHeightPx)),
		cellWidthPx,
		cellHeightPx,
	};
}

/** `getPropertyValue` returns `''` for unknown variables; treat that as absent. */
export function cssVar(value: string | undefined | null): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** Parses a CSS length like `14px` / `14.5` into px. Undefined if not a number. */
export function parsePx(value: string | undefined | null): number | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const match = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(trimmed);
	if (!match?.[1]) return undefined;
	const n = Number.parseFloat(match[1]);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function firstNonEmpty(...values: (string | undefined)[]): string {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return FALLBACK_FONT_FAMILY;
}

function firstPositive(...values: (number | undefined)[]): number {
	for (const value of values) {
		if (isPositive(value)) return value;
	}
	return FALLBACK_FONT_SIZE;
}

function isPositive(value: number | undefined): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
