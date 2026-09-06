/**
 * Cell widths, measured on both engines (issue #48).
 *
 * The point of this file is not the expected column. It is that the two engines
 * *agree*: herdr composes and positions the frame with libghostty-vt's width
 * table, and we replay it into whichever renderer the user picked. Where the
 * two disagree, every cell to the right of the glyph shifts by a column.
 *
 * Both engines run headless. xterm.js is `@xterm/headless`, the same parser,
 * buffer and unicode service as the browser build with the renderer removed.
 * ghostty-web is libghostty-vt instantiated straight from the `.wasm`, because
 * the package's own loader fetches a data URL through the browser — the method
 * `scripts/bench-renderers.mjs` uses.
 *
 * The spinner and box-drawing rows are the important half. They fail if someone
 * widens a whole block, which is the mistake the prior art made twice.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import {
	applyUnicodeWidths,
	UNICODE_TERMINAL_OPTIONS,
	UNICODE_VERSION,
} from '../src/views/renderer/unicodeWidth';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLS = 20;
const ROWS = 3;

/** The issue's table, then the glyphs that catch an over-wide rule. */
const GLYPHS: ReadonlyArray<{ name: string; glyph: string; cells: number }> = [
	{ name: 'U+1F7E2 green circle', glyph: '\u{1F7E2}', cells: 2 },
	{ name: 'U+2705 check mark button', glyph: '✅', cells: 2 },
	{ name: 'U+2733 eight-spoked asterisk', glyph: '✳', cells: 1 },
	{ name: 'U+D55C hangul', glyph: '한', cells: 2 },
	{ name: 'U+2500 box drawing', glyph: '─', cells: 1 },
	// Braille: the Ink spinner range. One cell, and it must stay one cell.
	{ name: 'U+2807 braille spinner', glyph: '⠇', cells: 1 },
	{ name: 'U+280B braille spinner', glyph: '⠋', cells: 1 },
	{ name: 'U+28FF braille full', glyph: '⣿', cells: 1 },
	// The rest of the box-drawing glyphs a Claude Code frame is built from.
	{ name: 'U+2502 box drawing', glyph: '│', cells: 1 },
	{ name: 'U+256D box drawing', glyph: '╭', cells: 1 },
	// Dingbats inside U+2600–U+27BF without Emoji_Presentation: still one cell.
	{ name: 'U+2600 black sun', glyph: '☀', cells: 1 },
	{ name: 'U+2699 gear', glyph: '⚙', cells: 1 },
	{ name: 'U+2714 heavy check mark', glyph: '✔', cells: 1 },
	{ name: 'U+2764 heavy black heart', glyph: '❤', cells: 1 },
	{ name: 'U+27A4 black rightwards arrowhead', glyph: '➤', cells: 1 },
	// Emoji_Presentation, in and out of that block: two cells.
	{ name: 'U+2728 sparkles', glyph: '✨', cells: 2 },
	{ name: 'U+274C cross mark', glyph: '❌', cells: 2 },
	{ name: 'U+26A1 high voltage', glyph: '⚡', cells: 2 },
	{ name: 'U+2B50 star', glyph: '⭐', cells: 2 },
	{ name: 'U+1F4A1 light bulb', glyph: '\u{1F4A1}', cells: 2 },
	// Plain ASCII, as the control.
	{ name: 'U+0041 latin A', glyph: 'A', cells: 1 },
];

/** Columns the cursor advances by in `@xterm/headless`, widths applied. */
async function xtermCells(glyph: string): Promise<number> {
	const terminal = new Terminal({
		cols: COLS,
		rows: ROWS,
		...UNICODE_TERMINAL_OPTIONS,
	});
	// `@xterm/headless`'s Terminal satisfies `UnicodeCapableTerminal` as it is,
	// which is the point of that interface being structural.
	const applied = await applyUnicodeWidths(terminal);
	expect(applied).toBe(true);
	expect(terminal.unicode.activeVersion).toBe(UNICODE_VERSION);
	await new Promise<void>((resolve) => terminal.write(glyph, resolve));
	const x = terminal.buffer.active.cursorX;
	terminal.dispose();
	return x;
}

/** libghostty-vt's exports, kept to what this file calls. */
interface GhosttyExports {
	memory: WebAssembly.Memory;
}
type GhosttyCtor = new (
	exports: WebAssembly.Exports,
	memory: WebAssembly.Memory,
	cols: number,
	rows: number,
	options: Record<string, never>,
) => {
	write(bytes: Uint8Array): void;
	getCursor(): { x: number };
	free(): void;
};

let GhosttyTerminal: GhosttyCtor;
let ghosttyExports: WebAssembly.Exports & GhosttyExports;

/** Columns the cursor advances by in libghostty-vt, herdr's own width table. */
function ghosttyCells(glyph: string): number {
	const terminal = new GhosttyTerminal(
		ghosttyExports,
		ghosttyExports.memory,
		COLS,
		ROWS,
		{},
	);
	terminal.write(new TextEncoder().encode(glyph));
	const { x } = terminal.getCursor();
	terminal.free();
	return x;
}

describe('cell widths agree across the two engines', () => {
	beforeAll(async () => {
		const wasm = await readFile(
			path.join(ROOT, 'node_modules/ghostty-web/dist/ghostty-vt.wasm'),
		);
		const { instance } = await WebAssembly.instantiate(wasm, {
			env: { log: () => undefined },
		});
		ghosttyExports = instance.exports as WebAssembly.Exports & GhosttyExports;
		({ GhosttyTerminal } = (await import('ghostty-web')) as unknown as {
			GhosttyTerminal: GhosttyCtor;
		});
	});

	for (const { name, glyph, cells } of GLYPHS) {
		it(`${name} is ${cells} cell${cells === 1 ? '' : 's'} on both`, async () => {
			const ghostty = ghosttyCells(glyph);
			const xterm = await xtermCells(glyph);
			expect({ ghostty, xterm }).toEqual({ ghostty: cells, xterm: cells });
		});
	}
});

describe('applyUnicodeWidths', () => {
	it('reports failure instead of throwing without allowProposedApi', async () => {
		const terminal = new Terminal({ cols: COLS, rows: ROWS });
		const applied = await applyUnicodeWidths(terminal);
		expect(applied).toBe(false);
		terminal.dispose();
	});

	it('is what makes the difference: without it, U+2705 is one cell', async () => {
		// The gate itself is on: `buffer` is proposed API too. What is missing is
		// the width table, which is the regression this whole file guards.
		const terminal = new Terminal({
			cols: COLS,
			rows: ROWS,
			...UNICODE_TERMINAL_OPTIONS,
		});
		await new Promise<void>((resolve) => terminal.write('✅', resolve));
		// Unicode 6: the very mismeasurement issue #48 is about.
		expect(terminal.buffer.active.cursorX).toBe(1);
		terminal.dispose();
	});
});
