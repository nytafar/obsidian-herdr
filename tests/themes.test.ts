import { describe, expect, it } from 'vitest';
import {
	DEFAULT_TERMINAL_THEME,
	TERMINAL_THEMES,
	TERMINAL_THEME_LABELS,
	THEME_COLOR_KEYS,
	followsObsidian,
	isTerminalThemeName,
	normalizeThemeName,
	resolveTheme,
	type TerminalTheme,
} from '../src/views/renderer/themes';

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
