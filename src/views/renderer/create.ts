/**
 * The single place that names a renderer implementation (PRD M14). Everything
 * else — the terminal view, the bridge — depends on `TerminalRenderer` only, so
 * swapping ghostty-web for xterm.js is this function plus one new file.
 */

import { GhosttyWebRenderer } from './ghosttyWeb';
import type { RendererOptions, TerminalRenderer } from './TerminalRenderer';

export function createRenderer(options: RendererOptions = {}): TerminalRenderer {
	return new GhosttyWebRenderer(options);
}
