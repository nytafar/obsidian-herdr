/**
 * How a pane's tab is shown (issues #92, #104; ADR-0002).
 *
 * Two questions, not one. **Which view**: the native Markdown view of the
 * pane's agent session, or a terminal. **Which terminal engine**: libghostty
 * (`ghostty-web`) or xterm (`xterm.js`). Both are properties of the *tab*,
 * stored in its view state and switchable in place; the global settings
 * (`defaultView`, `terminalEngine`) are the defaults a tab that never chose
 * follows, and each falls back on its own — a tab pinned to the native view
 * still follows the engine setting for the terminal it comes back to.
 *
 * Until #104 this was one value, "the engine names plus native", stored in the
 * v1 `terminalEngine` setting and in a tab's `renderMode`. One value cannot
 * remember a tab's engine across a round trip through the native view, and
 * cannot back two dropdowns. {@link splitRenderMode} is the whole of the
 * migration off it, and the only thing in the plugin that still knows the old
 * vocabulary: `native` becomes the native view with no engine chosen, so the
 * default engine; an engine name becomes the terminal view on that engine.
 */

import {
	isTerminalEngine,
	normalizeEngineName,
	type TerminalEngine,
} from '../views/renderer/TerminalRenderer';

/** Every view a tab can show, in the order the dropdown and the menu list them. */
export const PANE_VIEWS = ['terminal', 'native'] as const;

export type PaneView = (typeof PANE_VIEWS)[number];

/** What a tab shows when nothing has chosen: the v1 terminal (issue #27). */
export const DEFAULT_PANE_VIEW: PaneView = 'terminal';

/** Settings dropdown labels, sentence case per the Obsidian guidelines. */
export const PANE_VIEW_LABELS: Record<PaneView, string> = {
	terminal: 'Terminal',
	native: 'Native view (Markdown, no terminal)',
};

/** Short names, for the tab menu and the header button, where the row is narrow. */
export const PANE_VIEW_NAMES: Record<PaneView, string> = {
	terminal: 'Terminal',
	native: 'Native view',
};

/**
 * Short engine names, for the tab menu, where the row is narrow and the
 * settings labels ("Ghostty web (WebAssembly, canvas)") do not fit.
 */
export const TERMINAL_ENGINE_NAMES: Record<TerminalEngine, string> = {
	'ghostty-web': 'Ghostty web',
	'xterm.js': 'xterm.js',
};

/** Whether `value` is a view this build knows. */
export function isPaneView(value: unknown): value is PaneView {
	return typeof value === 'string' && (PANE_VIEWS as readonly string[]).includes(value);
}

/**
 * A stored setting (hand-edited `data.json`, or a name a newer build wrote)
 * turned into a view this build supports. Same contract as
 * `normalizeEngineName`: anything unknown is the default, never an error.
 */
export function normalizePaneView(value: unknown): PaneView {
	return isPaneView(value) ? value : DEFAULT_PANE_VIEW;
}

/** The view a click on the header toggle switches to (issue #105). */
export function otherPaneView(view: PaneView): PaneView {
	return view === 'native' ? 'terminal' : 'native';
}

/**
 * The engine a tab's terminal mounts: its own once it has chosen one, else the
 * global setting, normalized. Independent of the view, so switching to the
 * native view and back keeps the engine the tab had (issue #104).
 */
export function effectiveEngine(stored: TerminalEngine | null, fallback: unknown): TerminalEngine {
	return stored ?? normalizeEngineName(fallback);
}

/** The v1 value that meant "the native view" before it had a field of its own. */
export const LEGACY_NATIVE_RENDER_MODE = 'native';

/** What a legacy render mode said, once split into the two fields (#104). */
export interface SplitRenderMode {
	view: PaneView;
	/** The engine the value named, or null when it named the native view. */
	engine: TerminalEngine | null;
}

/**
 * A stored render mode — the v1 `terminalEngine` setting, or a tab's
 * `renderMode` — split into a view and an engine, or null when the value is
 * not one this build ever wrote. Lossless in both directions it can be:
 * `native` chose no engine, so the tab or the vault falls back to the default
 * one, and an engine name chose no view beyond "a terminal".
 */
export function splitRenderMode(value: unknown): SplitRenderMode | null {
	if (value === LEGACY_NATIVE_RENDER_MODE) return { view: 'native', engine: null };
	if (isTerminalEngine(value)) return { view: 'terminal', engine: value };
	return null;
}
