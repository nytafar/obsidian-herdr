/**
 * Obsidian's readable line length, for a view that is not a note (issue #117).
 *
 * The reading view builds
 * `previewEl.createDiv("markdown-preview-view markdown-rendered")` and inside
 * it `createDiv("markdown-preview-sizer markdown-preview-section")`, then
 * toggles {@link READABLE_WIDTH_CLASS} on the preview element from the
 * `readableLineLength` setting (Obsidian 1.10's own bundle,
 * `updateReadableLineLength`). The one rule that width comes from is
 * `app.css`:
 *
 * ```css
 * .markdown-preview-view.is-readable-line-width .markdown-preview-sizer {
 *   max-width: var(--file-line-width);
 *   margin-left: auto;
 *   margin-right: auto;
 * }
 * ```
 *
 * So the native view needs no width of its own: the same classes in the same
 * nesting, and the theme's `--file-line-width` decides. What is not in
 * `obsidian.d.ts` is how to *read* the setting — `vault.getConfig` and the
 * vault's `config-changed` event are both internal — so both reads live here,
 * behind optional calls, and a build of Obsidian that has neither simply gets
 * Obsidian's own default, which is on.
 */

import type { App, EventRef } from 'obsidian';

/** The class Obsidian's own views toggle for the setting. */
export const READABLE_WIDTH_CLASS = 'is-readable-line-width';

/** The setting this reads; the same string the core views pass to `getConfig`. */
const READABLE_LINE_LENGTH = 'readableLineLength';

/** The internal slice of the vault used here, none of it in `obsidian.d.ts`. */
interface ConfigVault {
	getConfig?(key: string): unknown;
	on?(name: string, callback: (key?: string) => void): EventRef;
	offref?(ref: EventRef): void;
}

function configVault(app: App | undefined): ConfigVault | undefined {
	return (app as { vault?: ConfigVault } | undefined)?.vault;
}

/**
 * Whether the vault wants a readable line width. Obsidian's default is on, and
 * that is also what a build with no `getConfig` gets: a view that is too narrow
 * reads like a note, a view that is too wide reads like nothing at all.
 */
export function readableLineWidth(app: App): boolean {
	const value = configVault(app)?.getConfig?.(READABLE_LINE_LENGTH);
	return value === undefined ? true : value !== false;
}

/**
 * Calls `run` whenever the setting may have moved, and gives back the way to
 * stop. The event carries the key that changed; a build that fires it without
 * one is taken at its word and asks again.
 *
 * Returns a no-op unsubscribe when the vault has no such event, which is the
 * same build that has no `getConfig`: nothing was registered, so nothing has to
 * be given back.
 */
export function watchReadableLineWidth(app: App, run: () => void): () => void {
	const vault = configVault(app);
	const ref = vault?.on?.('config-changed', (key) => {
		if (key === undefined || key === READABLE_LINE_LENGTH) run();
	});
	if (!ref) return () => {};
	return () => vault?.offref?.(ref);
}
