import { describe, expect, it, vi } from 'vitest';
import {
	cellFromPoint,
	computeFit,
	cssVar,
	DEFAULT_CURSOR_STYLE,
	DEFAULT_TERMINAL_ENGINE,
	normalizeCursorStyle,
	TERMINAL_CURSOR_STYLES,
	TERMINAL_CURSOR_STYLE_LABELS,
	FALLBACK_FONT_FAMILY,
	FALLBACK_FONT_SIZE,
	isTerminalEngine,
	MIN_COLS,
	MIN_ROWS,
	normalizeEngineName,
	parsePx,
	resolveFont,
	SCROLLBAR_RESERVE_PX,
	TERMINAL_ENGINES,
	TERMINAL_ENGINE_LABELS,
	type CellHitInput,
	type FitInput,
	type RendererOptions,
} from '../src/views/renderer/TerminalRenderer';
import {
	LINES_PER_SCROLLBACK_MB,
	MAX_SCROLLBACK_LINES,
	MIN_SCROLLBACK_LINES,
	scrollbackLines,
} from '../src/views/renderer/xtermJs';
import { createRenderer } from '../src/views/renderer/create';

// Both engines are mocked: `createRenderer` is being tested for which class it
// picks, and the real ones need a browser (ghostty-web's WASM loader, xterm's
// UMD preamble both want `self`). Importing `xtermJs` itself is safe because it
// only imports xterm.js lazily, inside `mount()`.
vi.mock('../src/views/renderer/ghosttyWeb', () => ({
	GhosttyWebRenderer: class FakeGhostty {
		constructor(public readonly options: RendererOptions) {}
	},
}));
vi.mock('../src/views/renderer/xtermJs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/views/renderer/xtermJs')>();
	return {
		...actual,
		XtermJsRenderer: class FakeXterm {
			constructor(public readonly options: RendererOptions) {}
		},
	};
});

// Only the DOM-free helpers are unit tested; the ghostty-web renderer itself
// needs a canvas plus the WASM. See tests/README.md for the in-Obsidian smoke.

const BOX: FitInput = {
	clientWidth: 815, // 800 usable after the 15 px scrollbar reserve
	clientHeight: 400,
	cellWidthPx: 8,
	cellHeightPx: 16,
};

describe('resolveFont', () => {
	it('prefers explicit options', () => {
		expect(
			resolveFont(
				{ fontFamily: 'Iosevka', fontSize: 13 },
				{ fontFamily: 'Menlo', fontSize: 16 },
			),
		).toEqual({ fontFamily: 'Iosevka', fontSize: 13 });
	});

	it('falls back to Obsidian when the option is undefined, 0 or blank', () => {
		const obsidian = { fontFamily: 'Menlo', fontSize: 16 };
		expect(resolveFont(undefined, obsidian)).toEqual(obsidian);
		expect(resolveFont({}, obsidian)).toEqual(obsidian);
		expect(resolveFont({ fontSize: 0, fontFamily: '' }, obsidian)).toEqual(
			obsidian,
		);
		expect(resolveFont({ fontFamily: '   ' }, obsidian)).toEqual(obsidian);
	});

	it('falls back to neutral defaults when Obsidian gives nothing', () => {
		expect(resolveFont({}, {})).toEqual({
			fontFamily: FALLBACK_FONT_FAMILY,
			fontSize: FALLBACK_FONT_SIZE,
		});
		expect(resolveFont({ fontSize: -3 }, { fontSize: 0 }).fontSize).toBe(
			FALLBACK_FONT_SIZE,
		);
	});

	it('trims the family and clamps the size', () => {
		expect(resolveFont({ fontFamily: '  Iosevka  ' }, {}).fontFamily).toBe(
			'Iosevka',
		);
		expect(resolveFont({ fontSize: 900 }, {}).fontSize).toBe(72);
		expect(resolveFont({ fontSize: 1 }, {}).fontSize).toBe(6);
	});
});

describe('computeFit', () => {
	it('divides the padded box by the cell, reserving the scrollbar', () => {
		expect(computeFit(BOX)).toEqual({
			cols: 100,
			rows: 25,
			cellWidthPx: 8,
			cellHeightPx: 16,
		});
	});

	it('subtracts padding on both axes', () => {
		const fit = computeFit({
			...BOX,
			paddingLeft: 8,
			paddingRight: 8,
			paddingTop: 16,
			paddingBottom: 16,
		});
		expect(fit).toMatchObject({ cols: 98, rows: 23 });
	});

	it('floors partial cells rather than overflowing', () => {
		expect(
			computeFit({ ...BOX, clientWidth: BOX.clientWidth + 7 }),
		).toMatchObject({ cols: 100 });
		expect(
			computeFit({ ...BOX, clientWidth: BOX.clientWidth + 8 }),
		).toMatchObject({ cols: 101 });
	});

	it('keeps the FitAddon minimums for a tiny container', () => {
		expect(
			computeFit({ ...BOX, clientWidth: SCROLLBAR_RESERVE_PX + 1, clientHeight: 1 }),
		).toMatchObject({ cols: MIN_COLS, rows: MIN_ROWS });
	});

	it('returns undefined while the container or the metrics are unmeasurable', () => {
		expect(computeFit({ ...BOX, clientWidth: 0 })).toBeUndefined();
		expect(computeFit({ ...BOX, clientHeight: 0 })).toBeUndefined();
		expect(computeFit({ ...BOX, cellWidthPx: 0 })).toBeUndefined();
		expect(computeFit({ ...BOX, cellHeightPx: 0 })).toBeUndefined();
		expect(computeFit({ ...BOX, clientWidth: Number.NaN })).toBeUndefined();
	});
});

describe('css helpers', () => {
	it('treats blank CSS variables as absent', () => {
		expect(cssVar('  #fff ')).toBe('#fff');
		expect(cssVar('')).toBeUndefined();
		expect(cssVar('   ')).toBeUndefined();
		expect(cssVar(undefined)).toBeUndefined();
		expect(cssVar(null)).toBeUndefined();
	});

	it('parses positive px lengths only', () => {
		expect(parsePx('14px')).toBe(14);
		expect(parsePx(' 14.5px ')).toBe(14.5);
		expect(parsePx('14')).toBe(14);
		expect(parsePx('0px')).toBeUndefined();
		expect(parsePx('-2px')).toBeUndefined();
		expect(parsePx('1.2em')).toBeUndefined();
		expect(parsePx('inherit')).toBeUndefined();
		expect(parsePx(undefined)).toBeUndefined();
	});
});

describe('cellFromPoint', () => {
	/** A 100x40 grid of 8x16 cells, drawn at (200, 100) on the page. */
	const grid: CellHitInput = {
		clientX: 0,
		clientY: 0,
		left: 200,
		top: 100,
		cellWidthPx: 8,
		cellHeightPx: 16,
		cols: 100,
		rows: 40,
	};

	it('maps a point to the cell that contains it', () => {
		expect(cellFromPoint({ ...grid, clientX: 200, clientY: 100 })).toEqual({
			column: 0,
			row: 0,
		});
		// 3.5 cells across, 2.9 down: the fractional part belongs to the cell.
		expect(cellFromPoint({ ...grid, clientX: 200 + 28, clientY: 100 + 46 })).toEqual({
			column: 3,
			row: 2,
		});
	});

	it('subtracts the container padding when it is measuring the container', () => {
		const padded = { ...grid, paddingLeft: 12, paddingTop: 6 };
		expect(cellFromPoint({ ...padded, clientX: 200 + 12, clientY: 100 + 6 })).toEqual({
			column: 0,
			row: 0,
		});
		expect(cellFromPoint({ ...padded, clientX: 200 + 12 + 24, clientY: 100 + 6 + 32 })).toEqual({
			column: 3,
			row: 2,
		});
		// Without the padding the same point would be one cell further along.
		expect(cellFromPoint({ ...grid, clientX: 200 + 12 + 24, clientY: 100 + 6 + 32 })).toEqual({
			column: 4,
			row: 2,
		});
	});

	it('is unaffected by the device pixel ratio: every input is CSS pixels', () => {
		// ghostty-web sizes its canvas `cols * metrics.width` in style pixels and
		// only multiplies the backing store by the ratio, and a bounding rect is
		// CSS pixels too. Scaling either by dpr would halve the column on retina.
		const point = { ...grid, clientX: 200 + 80, clientY: 100 + 80 };
		const retinaMistake = cellFromPoint({
			...point,
			cellWidthPx: grid.cellWidthPx * 2,
			cellHeightPx: grid.cellHeightPx * 2,
		});
		expect(cellFromPoint(point)).toEqual({ column: 10, row: 5 });
		expect(retinaMistake).toEqual({ column: 5, row: 2 });
	});

	it('clamps a point outside the grid to the nearest cell', () => {
		expect(cellFromPoint({ ...grid, clientX: 0, clientY: 0 })).toEqual({ column: 0, row: 0 });
		expect(cellFromPoint({ ...grid, clientX: 999_999, clientY: 999_999 })).toEqual({
			column: 99,
			row: 39,
		});
	});

	it('is undefined while nothing can be measured', () => {
		expect(cellFromPoint({ ...grid, cellWidthPx: 0 })).toBeUndefined();
		expect(cellFromPoint({ ...grid, cellHeightPx: Number.NaN })).toBeUndefined();
		expect(cellFromPoint({ ...grid, cols: 0, rows: 0 })).toBeUndefined();
		expect(cellFromPoint({ ...grid, clientX: Number.NaN })).toBeUndefined();
	});
});

describe('engine names', () => {
	it('offers ghostty-web and xterm.js, ghostty-web first and by default', () => {
		expect([...TERMINAL_ENGINES]).toEqual(['ghostty-web', 'xterm.js']);
		expect(DEFAULT_TERMINAL_ENGINE).toBe('ghostty-web');
	});

	it('gives every engine a distinct, non-empty dropdown label', () => {
		// Sentence case is the guideline; `xterm.js` is a brand that is written
		// lower case, so the assertion is distinctness, not capitalisation.
		const labels = TERMINAL_ENGINES.map((name) => TERMINAL_ENGINE_LABELS[name]);
		expect(labels.every((label) => label.trim().length > 0)).toBe(true);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it('normalises anything unknown to the default, never throwing', () => {
		expect(normalizeEngineName('xterm.js')).toBe('xterm.js');
		expect(normalizeEngineName('ghostty-web')).toBe('ghostty-web');
		expect(normalizeEngineName('xterm')).toBe(DEFAULT_TERMINAL_ENGINE);
		expect(normalizeEngineName(undefined)).toBe(DEFAULT_TERMINAL_ENGINE);
		expect(normalizeEngineName(7)).toBe(DEFAULT_TERMINAL_ENGINE);
		expect(normalizeEngineName(null)).toBe(DEFAULT_TERMINAL_ENGINE);
		expect(isTerminalEngine('xterm.js')).toBe(true);
		expect(isTerminalEngine('kitty')).toBe(false);
	});
});

describe('createRenderer', () => {
	it('builds the engine the options name', () => {
		expect(createRenderer({ engine: 'ghostty-web' }).constructor.name).toBe(
			'FakeGhostty',
		);
		expect(createRenderer({ engine: 'xterm.js' }).constructor.name).toBe(
			'FakeXterm',
		);
	});

	it('falls back to ghostty-web with no engine or an unknown one', () => {
		expect(createRenderer().constructor.name).toBe('FakeGhostty');
		expect(createRenderer({}).constructor.name).toBe('FakeGhostty');
		expect(
			createRenderer({ engine: 'kitty' as never }).constructor.name,
		).toBe('FakeGhostty');
	});

	it('passes the options through untouched', () => {
		const options: RendererOptions = { engine: 'xterm.js', fontSize: 13 };
		const renderer = createRenderer(options) as unknown as {
			options: RendererOptions;
		};
		expect(renderer.options).toBe(options);
	});
});

describe('scrollbackLines', () => {
	// The setting is a byte budget because ghostty-web's option is; xterm.js
	// counts lines, so one setting has to mean the same history in both.
	it('converts the byte budget at the measured 600 lines per megabyte', () => {
		expect(scrollbackLines(10_000_000)).toBe(10 * LINES_PER_SCROLLBACK_MB);
		expect(scrollbackLines(1_000_000)).toBe(LINES_PER_SCROLLBACK_MB);
	});

	it('clamps, so a hand-edited budget cannot ask for a gigabyte of lines', () => {
		expect(scrollbackLines(1)).toBe(MIN_SCROLLBACK_LINES);
		expect(scrollbackLines(10_000_000_000)).toBe(MAX_SCROLLBACK_LINES);
	});

	it('leaves xterm to its own default for a missing or unusable budget', () => {
		expect(scrollbackLines(undefined)).toBeUndefined();
		expect(scrollbackLines(0)).toBeUndefined();
		expect(scrollbackLines(-1)).toBeUndefined();
		expect(scrollbackLines(Number.NaN)).toBeUndefined();
	});
});

describe('cursor style names (issue #52)', () => {
	it('keeps every shape both engines accept', () => {
		expect([...TERMINAL_CURSOR_STYLES]).toEqual(['block', 'underline', 'bar']);
	});

	it('defaults to block, which is what both engines start with', () => {
		expect(DEFAULT_CURSOR_STYLE).toBe('block');
		expect(normalizeCursorStyle(undefined)).toBe('block');
	});

	it('turns anything a newer or hand-edited data.json holds into a shape', () => {
		expect(normalizeCursorStyle('bar')).toBe('bar');
		expect(normalizeCursorStyle('beam')).toBe(DEFAULT_CURSOR_STYLE);
		expect(normalizeCursorStyle(7)).toBe(DEFAULT_CURSOR_STYLE);
		expect(normalizeCursorStyle(null)).toBe(DEFAULT_CURSOR_STYLE);
	});

	it('labels every shape in sentence case', () => {
		for (const style of TERMINAL_CURSOR_STYLES) {
			const label = TERMINAL_CURSOR_STYLE_LABELS[style];
			expect(label).toBeTruthy();
			expect(label).toBe(label[0]?.toUpperCase() + label.slice(1).toLowerCase());
		}
	});
});
