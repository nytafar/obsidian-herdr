/**
 * Unicode cell widths for the xterm.js engine (issue #48).
 *
 * `@xterm/xterm` 5.5.0 ships one width table, Unicode 6, in which U+1F7E2 and
 * U+2705 measure one cell. herdr's VT measures them as two. We do not run the
 * VT: herdr composes the frame, positions every cell and hands it to us already
 * placed, so a width disagreement is not self-correcting the way it is inside a
 * normal terminal — every cell to the right of the offending glyph shifts by a
 * column and box borders break. Claude Code prints both of those glyphs
 * constantly, which is how the bug shows up.
 *
 * The fix is `@xterm/addon-unicode11` 0.8.0 (MIT, peer `@xterm/xterm` ^5.0.0,
 * 12 KB minified), which registers xterm's own Unicode 11 table as version
 * `'11'`. It is chosen over a hand-written table because a hand-written table is
 * exactly what the prior art got wrong twice: an early fix there widened all of
 * U+2600–U+27BF, which broke Ink-style spinners, and had to be narrowed back to
 * Emoji_Presentation. The addon's table is derived from East_Asian_Width plus
 * Emoji_Presentation, so it is narrow by construction: measured headlessly
 * against libghostty-vt over 21 glyphs — the five rows of the issue's table,
 * the braille spinner range U+2807/U+280B/U+28FF, box drawing U+2500/U+2502/
 * U+256D, and a spread of dingbats and emoji — the two engines agree on every
 * one. `tests/unicodeWidth.test.ts` pins that agreement.
 *
 * `@xterm/addon-unicode-graphemes` is deliberately not used: it is known to
 * block plugin load.
 *
 * **The gate.** `terminal.unicode` is proposed API. Without
 * `allowProposedApi: true` the property access throws, so a width provider added
 * without it does nothing while looking correct. {@link UNICODE_TERMINAL_OPTIONS}
 * exists so the flag and the addon cannot be separated.
 */
import type { ITerminalAddon } from '@xterm/xterm';

/** The Unicode version the addon registers, and the one we select. */
export const UNICODE_VERSION = '11';

/**
 * Terminal options that {@link applyUnicodeWidths} needs. Spread into the
 * `Terminal` constructor; `unicode` is proposed API and throws without it.
 */
export const UNICODE_TERMINAL_OPTIONS = { allowProposedApi: true } as const;

/**
 * The slice of `Terminal` this module touches. Structural on purpose, so the
 * test can drive `@xterm/headless`, which has the same parser, buffer and
 * unicode service as the browser build with the renderer removed.
 */
export interface UnicodeCapableTerminal {
	readonly unicode: { activeVersion: string };
	loadAddon(addon: ITerminalAddon): void;
}

type Unicode11Module = typeof import('@xterm/addon-unicode11');

let addonModule: Promise<Unicode11Module> | undefined;

/**
 * Loads the addon once per window, in step with the lazy loads in `xtermJs.ts`:
 * a vault that never opens an xterm.js terminal never evaluates it.
 */
async function loadAddon(): Promise<Unicode11Module> {
	addonModule ??= import('@xterm/addon-unicode11');
	return addonModule;
}

/**
 * Registers the Unicode 11 width table on `terminal` and selects it. Returns
 * whether the table is active.
 *
 * Failure is not fatal: a terminal built without
 * {@link UNICODE_TERMINAL_OPTIONS}, or a future xterm that drops the proposed
 * API, keeps rendering with the built-in table. That is today's behaviour, so a
 * warning is the right response rather than an unmounted terminal.
 */
export async function applyUnicodeWidths(
	terminal: UnicodeCapableTerminal,
): Promise<boolean> {
	try {
		const { Unicode11Addon } = await loadAddon();
		terminal.loadAddon(new Unicode11Addon());
		terminal.unicode.activeVersion = UNICODE_VERSION;
		return terminal.unicode.activeVersion === UNICODE_VERSION;
	} catch (error) {
		console.warn(
			'herdr: xterm.js Unicode 11 widths unavailable; wide glyphs may shift the frame',
			error,
		);
		return false;
	}
}
