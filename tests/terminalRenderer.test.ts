import { describe, expect, it } from 'vitest';
import {
	computeFit,
	cssVar,
	FALLBACK_FONT_FAMILY,
	FALLBACK_FONT_SIZE,
	MIN_COLS,
	MIN_ROWS,
	parsePx,
	resolveFont,
	SCROLLBAR_RESERVE_PX,
	type FitInput,
} from '../src/views/renderer/TerminalRenderer';

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
