import { describe, expect, it } from 'vitest';
import {
	DEFAULT_TERMINAL_THEME,
	TERMINAL_THEMES,
	TERMINAL_THEME_LABELS,
	THEME_COLOR_KEYS,
	followsObsidian,
	isTerminalThemeName,
	normalizeThemeName,
	luminance,
	obsidianTheme,
	parseColor,
	resolveTheme,
	type CssVarReader,
	type TerminalTheme,
} from '../src/views/renderer/themes';

/**
 * A stand-in for `getComputedStyle(body)`: the same contract the renderers give
 * `obsidianTheme`, i.e. trimmed values with the empty string as `undefined`.
 */
function reader(vars: Record<string, string>): CssVarReader {
	return (name) => vars[name];
}

/** Obsidian 1.13's own dark defaults, trimmed to what the mapping reads. */
const DARK_VARS: Record<string, string> = {
	'--background-primary': '#1e1e1e',
	'--text-normal': '#dadada',
	'--text-accent': '#a882ff',
	'--text-selection': 'rgba(0, 122, 255, 0.25)',
	'--color-base-00': '#1e1e1e',
	'--color-base-25': '#262626',
	'--color-base-30': '#363636',
	'--color-base-35': '#3f3f3f',
	'--color-base-40': '#555555',
	'--color-base-50': '#666666',
	'--color-base-60': '#999999',
	'--color-base-70': '#dadada',
	'--color-base-100': '#ffffff',
	'--color-red-rgb': '251, 70, 76',
	'--color-orange-rgb': '233, 151, 63',
	'--color-yellow-rgb': '224, 222, 113',
	'--color-green-rgb': '68, 207, 110',
	'--color-cyan-rgb': '83, 223, 221',
	'--color-blue-rgb': '2, 122, 255',
	'--color-purple-rgb': '168, 130, 255',
	'--color-pink-rgb': '250, 153, 205',
};

/** The light counterpart: the base scale inverts, the hues barely move. */
const LIGHT_VARS: Record<string, string> = {
	...DARK_VARS,
	'--background-primary': '#ffffff',
	'--text-normal': '#222222',
	'--color-base-00': '#ffffff',
	'--color-base-25': '#f2f3f5',
	'--color-base-30': '#ededed',
	'--color-base-35': '#e3e3e3',
	'--color-base-40': '#dadada',
	'--color-base-50': '#bababa',
	'--color-base-60': '#707070',
	'--color-base-70': '#5c5c5c',
	'--color-base-100': '#222222',
};

/** Every ANSI slot that has a normal/bright pair. */
const ANSI_PAIRS = [
	'black',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white',
] as const;

/** Stand-in for what the renderer reads out of Obsidian's CSS variables. */
const FROM_OBSIDIAN: TerminalTheme = {
	foreground: '#dadada',
	background: '#1e1e1e',
	red: 'rgb(224, 108, 117)',
};

const PALETTE_THEMES = TERMINAL_THEMES.filter((name) => name !== 'obsidian');

describe('theme names', () => {
	it('defaults to following Obsidian', () => {
		expect(DEFAULT_TERMINAL_THEME).toBe('obsidian');
		expect(TERMINAL_THEMES[0]).toBe('obsidian');
	});

	it('recognises exactly the shipped names', () => {
		for (const name of TERMINAL_THEMES) expect(isTerminalThemeName(name)).toBe(true);
		for (const value of ['Obsidian', 'gruvbox', '', null, undefined, 7, {}]) {
			expect(isTerminalThemeName(value)).toBe(false);
		}
	});

	it('normalises anything unknown to the default', () => {
		expect(normalizeThemeName('nord')).toBe('nord');
		expect(normalizeThemeName('catppuccin')).toBe('obsidian');
		expect(normalizeThemeName(undefined)).toBe('obsidian');
		expect(normalizeThemeName(null)).toBe('obsidian');
		expect(normalizeThemeName(42)).toBe('obsidian');
	});

	it('gives every name a distinct label', () => {
		const labels = TERMINAL_THEMES.map((name) => TERMINAL_THEME_LABELS[name]);
		for (const label of labels) {
			expect(label).toBeTruthy();
			// Sentence case (Obsidian guidelines): "Solarized dark", not
			// "Solarized Dark". Proper nouns — Obsidian, Ghostty — are exempt.
			expect(label).not.toMatch(/\b(Dark|Light)\b/);
		}
		expect(new Set(labels).size).toBe(labels.length);
	});

	it('knows which name follows Obsidian', () => {
		expect(followsObsidian('obsidian')).toBe(true);
		expect(followsObsidian('nonsense')).toBe(true);
		for (const name of PALETTE_THEMES) expect(followsObsidian(name)).toBe(false);
	});
});

describe('resolveTheme', () => {
	it('passes the Obsidian colours straight through, unset keys and all', () => {
		const resolved = resolveTheme('obsidian', FROM_OBSIDIAN);
		expect(resolved).toEqual(FROM_OBSIDIAN);
		expect(resolved.blue).toBeUndefined();
	});

	it('falls back to Obsidian for an unknown name', () => {
		expect(resolveTheme('catppuccin-mocha', FROM_OBSIDIAN)).toEqual(FROM_OBSIDIAN);
		expect(resolveTheme(undefined, FROM_OBSIDIAN)).toEqual(FROM_OBSIDIAN);
		expect(resolveTheme(null, FROM_OBSIDIAN)).toEqual(FROM_OBSIDIAN);
	});

	it('returns an empty theme when Obsidian gives nothing', () => {
		expect(resolveTheme('obsidian')).toEqual({});
	});

	it('gives every built-in palette all the theme keys', () => {
		for (const name of PALETTE_THEMES) {
			const theme = resolveTheme(name, FROM_OBSIDIAN) as Record<string, unknown>;
			expect(Object.keys(theme).sort()).toEqual([...THEME_COLOR_KEYS].sort());
			for (const key of THEME_COLOR_KEYS) {
				expect(theme[key], `${name}.${key}`).toMatch(/^#[0-9a-f]{6}$/);
			}
		}
	});

	it('ignores the Obsidian colours when a palette is chosen', () => {
		const nord = resolveTheme('nord', FROM_OBSIDIAN);
		expect(nord.background).toBe('#2e3440');
		expect(nord.red).not.toBe(FROM_OBSIDIAN.red);
	});

	it('keeps the palettes distinct', () => {
		const backgrounds = PALETTE_THEMES.map(
			(name) => resolveTheme(name).background,
		);
		expect(new Set(backgrounds).size).toBeGreaterThan(1);
		// Light schemes must actually be light, dark ones dark: a swapped row in
		// the table is the easy mistake, and this catches it.
		expect(resolveTheme('solarized-light').background).toBe('#fdf6e3');
		expect(resolveTheme('solarized-dark').background).toBe('#002b36');
		expect(resolveTheme('ghostty-light').background).toBe('#ffffff');
	});
});

describe('parseColor', () => {
	it('reads the notations Obsidian actually publishes', () => {
		expect(parseColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
		expect(parseColor('#1e1e1e')).toEqual({ r: 30, g: 30, b: 30, a: 1 });
		expect(parseColor('  251, 70, 76 ')).toEqual({ r: 251, g: 70, b: 76, a: 1 });
		expect(parseColor('rgb(2 122 255)')).toEqual({ r: 2, g: 122, b: 255, a: 1 });
		expect(parseColor('rgba(0, 122, 255, 0.25)')?.a).toBeCloseTo(0.25);
		expect(parseColor('#00ff0080')?.a).toBeCloseTo(0.5, 2);
	});

	it('returns undefined rather than guessing', () => {
		for (const value of ['', '   ', undefined, 'red', 'hsl(200, 50%, 50%)', 'rgb(1,2)']) {
			expect(parseColor(value)).toBeUndefined();
		}
	});
});

describe('obsidianTheme: ANSI pairs', () => {
	it('never collapses a normal and bright pair, dark or light', () => {
		for (const vars of [DARK_VARS, LIGHT_VARS]) {
			const theme = obsidianTheme(reader(vars)) as Record<string, string>;
			for (const slot of ANSI_PAIRS) {
				const bright = `bright${slot[0].toUpperCase()}${slot.slice(1)}`;
				expect(theme[slot], slot).toMatch(/^#[0-9a-f]{6}$/);
				expect(theme[bright], bright).toMatch(/^#[0-9a-f]{6}$/);
				expect(theme[bright], `${slot} pair`).not.toBe(theme[slot]);
			}
		}
	});

	it('brightens away from the background: lighter on dark, darker on light', () => {
		const dark = obsidianTheme(reader(DARK_VARS), { dark: true });
		const light = obsidianTheme(reader(LIGHT_VARS), { dark: false });
		expect(luminance(parseColor(dark.brightRed)!)).toBeGreaterThan(
			luminance(parseColor(dark.red)!),
		);
		expect(luminance(parseColor(light.brightRed)!)).toBeLessThan(
			luminance(parseColor(light.red)!),
		);
	});

	it('infers dark from the background when the flag is absent', () => {
		const inferred = obsidianTheme(reader(DARK_VARS));
		const told = obsidianTheme(reader(DARK_VARS), { dark: true });
		expect(inferred).toEqual(told);
		const lightInferred = obsidianTheme(reader(LIGHT_VARS));
		expect(lightInferred).toEqual(obsidianTheme(reader(LIGHT_VARS), { dark: false }));
	});

	it('prefers the -rgb triplet but accepts a hex-only theme', () => {
		const hexOnly = obsidianTheme(reader({ ...LIGHT_VARS, '--color-red-rgb': '', '--color-red': '#c00000' }));
		expect(hexOnly.red).toBe('#c00000');
	});

	it('leaves a slot unset when its variables are missing or unparsable', () => {
		const theme = obsidianTheme(reader({ '--background-primary': '#1e1e1e' }));
		expect(theme.background).toBe('#1e1e1e');
		expect(theme.red).toBeUndefined();
		expect(theme.foreground).toBeUndefined();
		expect(obsidianTheme(reader({ '--color-green-rgb': 'not a colour' })).green).toBeUndefined();
	});
});
