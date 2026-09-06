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
	obsidianFontWeights,
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
				const bright = `bright${slot.charAt(0).toUpperCase()}${slot.slice(1)}`;
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

describe('obsidianTheme: the base scale', () => {
	it('flips with the appearance, so black stays near the background', () => {
		const dark = obsidianTheme(reader(DARK_VARS), { dark: true });
		const light = obsidianTheme(reader(LIGHT_VARS), { dark: false });
		// Dark vault: black is the dark end, bright white the light end.
		expect(luminance(parseColor(dark.black)!)).toBeLessThan(
			luminance(parseColor(dark.brightWhite)!),
		);
		// Light vault: the same slots, and the scale has inverted under them.
		expect(luminance(parseColor(light.black)!)).toBeLessThan(
			luminance(parseColor(light.brightWhite)!),
		);
		expect(light.black).toBe(LIGHT_VARS['--color-base-100']);
		expect(light.brightWhite).toBe(LIGHT_VARS['--color-base-00']);
		expect(dark.black).toBe(DARK_VARS['--color-base-25']);
		expect(dark.brightWhite).toBe(DARK_VARS['--color-base-100']);
	});

	it('uses the finer steps and keeps the four greys apart', () => {
		for (const vars of [DARK_VARS, LIGHT_VARS]) {
			const theme = obsidianTheme(reader(vars));
			const greys = [theme.black, theme.brightBlack, theme.white, theme.brightWhite];
			expect(new Set(greys).size).toBe(4);
		}
		expect(obsidianTheme(reader(DARK_VARS)).brightBlack).toBe(
			DARK_VARS['--color-base-40'],
		);
		expect(obsidianTheme(reader(LIGHT_VARS)).white).toBe(
			LIGHT_VARS['--color-base-35'],
		);
	});

	it('falls back down the chain when a step is missing', () => {
		const vars = { ...DARK_VARS };
		delete vars['--color-base-25'];
		delete vars['--color-base-40'];
		const theme = obsidianTheme(reader(vars), { dark: true });
		expect(theme.black).toBe(DARK_VARS['--color-base-20'] ?? DARK_VARS['--color-base-30']);
		expect(theme.brightBlack).toBe(DARK_VARS['--color-base-35']);
	});
});

/** A theme that tuned its code palette, as most community themes do. */
const CODE_VARS: Record<string, string> = {
	...DARK_VARS,
	'--code-normal': '#dadada',
	'--code-comment': '#7f8c98',
	'--code-string': '#7ee787',
	'--code-keyword': '#ff7bd5',
	'--code-function': '#79c0ff',
	'--code-property': '#56d4dd',
	'--code-value': '#ffd866',
	'--code-important': '#ff6b6b',
};

describe('obsidianTheme: the code palette', () => {
	it('takes the code colours for the slots whose meaning matches', () => {
		const theme = obsidianTheme(reader(CODE_VARS), { dark: true });
		expect(theme.green).toBe(CODE_VARS['--code-string']);
		expect(theme.magenta).toBe(CODE_VARS['--code-keyword']);
		expect(theme.blue).toBe(CODE_VARS['--code-function']);
		expect(theme.cyan).toBe(CODE_VARS['--code-property']);
		expect(theme.yellow).toBe(CODE_VARS['--code-value']);
		expect(theme.red).toBe(CODE_VARS['--code-important']);
		expect(theme.brightBlack).toBe(CODE_VARS['--code-comment']);
	});

	it('derives the bright variants from the code colours too', () => {
		const theme = obsidianTheme(reader(CODE_VARS), { dark: true });
		expect(theme.brightGreen).not.toBe(theme.green);
		expect(luminance(parseColor(theme.brightGreen)!)).toBeGreaterThan(
			luminance(parseColor(theme.green)!),
		);
	});

	it('ignores a code palette the theme never differentiated', () => {
		const flat: Record<string, string> = { ...DARK_VARS };
		for (const name of [
			'--code-normal',
			'--code-comment',
			'--code-string',
			'--code-keyword',
			'--code-function',
			'--code-property',
			'--code-value',
			'--code-important',
		]) {
			flat[name] = '#dadada';
		}
		const theme = obsidianTheme(reader(flat), { dark: true });
		expect(theme.green).toBe(obsidianTheme(reader(DARK_VARS), { dark: true }).green);
		expect(theme.brightBlack).toBe(
			obsidianTheme(reader(DARK_VARS), { dark: true }).brightBlack,
		);
	});

	it('keeps the terminal background out of --code-background', () => {
		const theme = obsidianTheme(
			reader({ ...CODE_VARS, '--code-background': '#000000' }),
			{ dark: true },
		);
		expect(theme.background).toBe(DARK_VARS['--background-primary']);
	});
});

describe('obsidianTheme: cursor and selection', () => {
	it('takes the cursor from the interactive accent and its glyph from on-accent', () => {
		const theme = obsidianTheme(
			reader({
				...DARK_VARS,
				'--interactive-accent': '#8a5cf6',
				'--text-on-accent': '#ffffff',
			}),
		);
		expect(theme.cursor).toBe('#8a5cf6');
		expect(theme.cursorAccent).toBe('#ffffff');
	});

	it('falls back to the text accent and the background', () => {
		const theme = obsidianTheme(reader(DARK_VARS));
		expect(theme.cursor).toBe(DARK_VARS['--text-accent']);
		expect(theme.cursorAccent).toBe(DARK_VARS['--background-primary']);
	});

	it('keeps a translucent selection translucent and sets no text colour', () => {
		const theme = obsidianTheme(reader(DARK_VARS));
		expect(theme.selectionBackground).toBe('rgba(0, 122, 255, 0.25)');
		expect(theme.selectionForeground).toBeUndefined();
	});

	it('sets a selection text colour only when the selection is opaque', () => {
		const theme = obsidianTheme(
			reader({ ...DARK_VARS, '--text-selection': '#264f78' }),
		);
		expect(theme.selectionBackground).toBe('#264f78');
		expect(theme.selectionForeground).toBe(DARK_VARS['--text-normal']);
	});

	it('leaves both selection keys unset when the variable is missing', () => {
		const vars = { ...DARK_VARS };
		delete vars['--text-selection'];
		const theme = obsidianTheme(reader(vars));
		expect(theme.selectionBackground).toBeUndefined();
		expect(theme.selectionForeground).toBeUndefined();
	});
});

describe('obsidianFontWeights', () => {
	it('reads the vault weights, numbers or keywords', () => {
		expect(
			obsidianFontWeights(reader({ '--font-weight': '400', '--bold-weight': '600' })),
		).toEqual({ fontWeight: 400, fontWeightBold: 600 });
		expect(
			obsidianFontWeights(reader({ '--font-weight': 'normal', '--bold-weight': 'bold' })),
		).toEqual({ fontWeight: 400, fontWeightBold: 700 });
	});

	it('drops a bold weight that would not read as bold', () => {
		expect(
			obsidianFontWeights(reader({ '--font-weight': '600', '--bold-weight': '600' })),
		).toEqual({ fontWeight: 600 });
		expect(obsidianFontWeights(reader({ '--bold-weight': '300' }))).toEqual({});
	});

	it('sets nothing when the variables are missing or nonsense', () => {
		expect(obsidianFontWeights(reader({}))).toEqual({});
		expect(
			obsidianFontWeights(reader({ '--font-weight': 'heavy', '--bold-weight': '5000' })),
		).toEqual({});
	});
});
