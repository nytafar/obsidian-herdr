/**
 * Render mode: how a pane's tab is shown (issue #92, ADR-0002).
 *
 * The vocabulary, and nothing else. A render mode is a property of the *tab*,
 * stored in its view state and switchable in place; the global setting is only
 * the default a new tab starts from. Two of the three modes draw a terminal —
 * libghostty (`ghostty-web`) and xterm (`xterm.js`) — and the third, `native`,
 * shows the pane's agent session as Obsidian Markdown.
 *
 * The two terminal values are the {@link TerminalEngine} names on purpose: the
 * global default has been stored under `terminalEngine` since issue #27, and a
 * vault upgrading into this build must keep the engine it had. So the render
 * mode is "the engine names, plus native", not a new set of strings with a
 * migration attached.
 */

import {
	DEFAULT_TERMINAL_ENGINE,
	TERMINAL_ENGINES,
	TERMINAL_ENGINE_LABELS,
	isTerminalEngine,
	type TerminalEngine,
} from '../views/renderer/TerminalRenderer';

/** The native render mode's stored value; the one mode that draws no terminal. */
export const NATIVE_RENDER_MODE = 'native';

/** Every render mode this build knows, in the order the dropdown shows them. */
export const RENDER_MODES = [...TERMINAL_ENGINES, NATIVE_RENDER_MODE] as const;

export type RenderMode = (typeof RENDER_MODES)[number];

/** What a tab renders when nothing has chosen: the v1 terminal (issue #27). */
export const DEFAULT_RENDER_MODE: RenderMode = DEFAULT_TERMINAL_ENGINE;

/** Settings dropdown labels, sentence case per the Obsidian guidelines. */
export const RENDER_MODE_LABELS: Record<RenderMode, string> = {
	...TERMINAL_ENGINE_LABELS,
	[NATIVE_RENDER_MODE]: 'Native view (Markdown, no terminal)',
};

/** Short names, for the tab menu and the command, where the row is narrow. */
export const RENDER_MODE_NAMES: Record<RenderMode, string> = {
	'ghostty-web': 'Ghostty web',
	'xterm.js': 'xterm.js',
	[NATIVE_RENDER_MODE]: 'Native view',
};

/** Whether `value` is a render mode this build knows. */
export function isRenderMode(value: unknown): value is RenderMode {
	return value === NATIVE_RENDER_MODE || isTerminalEngine(value);
}

/**
 * A stored setting (hand-edited `data.json`, or a name a newer build wrote)
 * turned into a render mode this build supports. Same contract as
 * `normalizeEngineName`: anything unknown is the default, never an error.
 */
export function normalizeRenderMode(value: unknown): RenderMode {
	return isRenderMode(value) ? value : DEFAULT_RENDER_MODE;
}

/**
 * The engine a terminal surface mounts for this render mode. `native` draws no
 * terminal at all, so it answers with the default engine: the only caller that
 * reaches here with it is a surface that fell back to a terminal.
 */
export function engineForRenderMode(mode: RenderMode): TerminalEngine {
	return isTerminalEngine(mode) ? mode : DEFAULT_TERMINAL_ENGINE;
}
