/**
 * The single place that names a renderer implementation (PRD M14). Everything
 * else — the terminal view, the bridge — depends on `TerminalRenderer` only, so
 * the engine setting (issue #27) is this switch and nothing more.
 *
 * Both engines are bundled, so `main.js` carries ghostty-web's inlined WASM and
 * xterm.js side by side; see `scripts/bench-renderers.mjs` for what each costs.
 */

import { GhosttyWebRenderer } from './ghosttyWeb';
import { XtermJsRenderer } from './xtermJs';
import {
	normalizeEngineName,
	type RendererOptions,
	type TerminalRenderer,
} from './TerminalRenderer';

/** An unknown engine is the default engine, never an error (PRD N3's spirit). */
export function createRenderer(options: RendererOptions = {}): TerminalRenderer {
	switch (normalizeEngineName(options.engine)) {
		case 'xterm.js':
			return new XtermJsRenderer(options);
		case 'ghostty-web':
		default:
			return new GhosttyWebRenderer(options);
	}
}
