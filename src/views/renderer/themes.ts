/**
 * Terminal colour themes (issue #26, PRD S18).
 *
 * Pure data plus one resolver. Nothing here may import `obsidian`, ghostty-web or
 * touch the DOM: the renderer reads Obsidian's CSS variables and hands the result
 * in as `fromObsidian`, so this file stays unit-testable without a window.
 *
 * The default is `obsidian`, which is exactly the pre-#26 behaviour — the
 * variables the renderer read, passed straight through. Every other name is a
 * built-in palette written out below as its sixteen ANSI colours plus
 * foreground, background, cursor and selection.
 *
 * The palettes are transcribed from the published schemes and are approximations
 * where a scheme leaves a slot undefined (bright variants, selection colours). If
 * a colour looks wrong, fix the table; nothing else depends on the exact values.
 *
 * Stretch goal from #26, deliberately not in this cut: reading the user's real
 * Ghostty config (`~/.config/ghostty/config`, `theme = …` plus `palette = N=#rrggbb`
 * overrides) and offering it as another name. That would plug in as one more
 * branch in {@link resolveTheme} — a `ghostty-config` name whose colours are read
 * elsewhere and passed in like `fromObsidian` is, so this file stays pure.
 */

/** The keys ghostty-web's `ITheme` accepts. Kept structural, not imported. */
export const THEME_COLOR_KEYS = [
	'foreground',
	'background',
	'cursor',
	'cursorAccent',
	'selectionBackground',
	'selectionForeground',
	'black',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white',
	'brightBlack',
	'brightRed',
	'brightGreen',
	'brightYellow',
	'brightBlue',
	'brightMagenta',
	'brightCyan',
	'brightWhite',
] as const;

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

/**
 * A theme as the renderer wants it: every key optional, because the Obsidian
 * default only sets the variables the current CSS theme actually defines.
 * Structurally assignable to ghostty-web's `ITheme`.
 */
export type TerminalTheme = Partial<Record<ThemeColorKey, string>>;

/** Theme names the setting offers. `obsidian` follows the vault's CSS. */
export const TERMINAL_THEMES = [
	'obsidian',
	'ghostty-dark',
	'ghostty-light',
	'solarized-dark',
	'solarized-light',
	'gruvbox-dark',
	'dracula',
	'nord',
	'one-dark',
] as const;

export type TerminalThemeName = (typeof TERMINAL_THEMES)[number];

export const DEFAULT_TERMINAL_THEME: TerminalThemeName = 'obsidian';

/** Dropdown labels, sentence case per the Obsidian guidelines. */
export const TERMINAL_THEME_LABELS: Record<TerminalThemeName, string> = {
	obsidian: 'Follow Obsidian',
	'ghostty-dark': 'Ghostty dark',
	'ghostty-light': 'Ghostty light',
	'solarized-dark': 'Solarized dark',
	'solarized-light': 'Solarized light',
	'gruvbox-dark': 'Gruvbox dark',
	dracula: 'Dracula',
	nord: 'Nord',
	'one-dark': 'One dark',
};

/** ANSI 0-15: black, red, green, yellow, blue, magenta, cyan, white, then bright. */
type Ansi16 = readonly [
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
];

interface PaletteSpec {
	ansi: Ansi16;
	foreground: string;
	background: string;
	cursor: string;
	/** Selection background. The text colour defaults to `foreground`. */
	selection: string;
	selectionForeground?: string;
}

/** Built-in palettes. `obsidian` is absent on purpose: it has no fixed colours. */
const PALETTES: Record<Exclude<TerminalThemeName, 'obsidian'>, PaletteSpec> = {
	// Ghostty's shipped default palette (Tomorrow Night) on its default background.
	'ghostty-dark': {
		ansi: [
			'#1d1f21', '#cc6666', '#b5bd68', '#f0c674',
			'#81a2be', '#b294bb', '#8abeb7', '#c5c8c6',
			'#666666', '#d54e53', '#b9ca4a', '#e7c547',
			'#7aa6da', '#c397d8', '#70c0b1', '#eaeaea',
		],
		foreground: '#ffffff',
		background: '#282c34',
		cursor: '#ffffff',
		selection: '#3e4451',
	},
	// The light counterpart: the Tomorrow palette on paper white.
	'ghostty-light': {
		ansi: [
			'#4d4d4c', '#c82829', '#718c00', '#eab700',
			'#4271ae', '#8959a8', '#3e999f', '#d6d6d6',
			'#8e908c', '#e14c4c', '#8ca61a', '#f5c93b',
			'#5b8bc7', '#a06fc0', '#4bb1b7', '#ffffff',
		],
		foreground: '#4d4d4c',
		background: '#ffffff',
		cursor: '#4d4d4c',
		selection: '#d6d6d6',
	},
	// Solarized, Ethan Schoonover. Both variants share the accent colours; only
	// the base tones swap, which is the whole point of the scheme.
	'solarized-dark': {
		ansi: [
			'#073642', '#dc322f', '#859900', '#b58900',
			'#268bd2', '#d33682', '#2aa198', '#eee8d5',
			'#002b36', '#cb4b16', '#586e75', '#657b83',
			'#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
		],
		foreground: '#839496',
		background: '#002b36',
		cursor: '#93a1a1',
		selection: '#073642',
		selectionForeground: '#93a1a1',
	},
	'solarized-light': {
		ansi: [
			'#073642', '#dc322f', '#859900', '#b58900',
			'#268bd2', '#d33682', '#2aa198', '#eee8d5',
			'#002b36', '#cb4b16', '#586e75', '#657b83',
			'#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
		],
		foreground: '#657b83',
		background: '#fdf6e3',
		cursor: '#586e75',
		selection: '#eee8d5',
		selectionForeground: '#586e75',
	},
	'gruvbox-dark': {
		ansi: [
			'#282828', '#cc241d', '#98971a', '#d79921',
			'#458588', '#b16286', '#689d6a', '#a89984',
			'#928374', '#fb4934', '#b8bb26', '#fabd2f',
			'#83a598', '#d3869b', '#8ec07c', '#ebdbb2',
		],
		foreground: '#ebdbb2',
		background: '#282828',
		cursor: '#ebdbb2',
		selection: '#504945',
	},
	dracula: {
		ansi: [
			'#21222c', '#ff5555', '#50fa7b', '#f1fa8c',
			'#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
			'#6272a4', '#ff6e6e', '#69ff94', '#ffffa5',
			'#d6acff', '#ff92df', '#a4ffff', '#ffffff',
		],
		foreground: '#f8f8f2',
		background: '#282a36',
		cursor: '#f8f8f2',
		selection: '#44475a',
	},
	nord: {
		ansi: [
			'#3b4252', '#bf616a', '#a3be8c', '#ebcb8b',
			'#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
			'#4c566a', '#bf616a', '#a3be8c', '#ebcb8b',
			'#81a1c1', '#b48ead', '#8fbcbb', '#eceff4',
		],
		foreground: '#d8dee9',
		background: '#2e3440',
		cursor: '#d8dee9',
		selection: '#434c5e',
	},
	'one-dark': {
		ansi: [
			'#282c34', '#e06c75', '#98c379', '#e5c07b',
			'#61afef', '#c678dd', '#56b6c2', '#abb2bf',
			'#5c6370', '#e06c75', '#98c379', '#e5c07b',
			'#61afef', '#c678dd', '#56b6c2', '#ffffff',
		],
		foreground: '#abb2bf',
		background: '#282c34',
		cursor: '#528bff',
		selection: '#3e4451',
	},
};

/** A palette spec expanded to the full set of `ITheme` keys. */
function paletteTheme(spec: PaletteSpec): Record<ThemeColorKey, string> {
	const [
		black, red, green, yellow, blue, magenta, cyan, white,
		brightBlack, brightRed, brightGreen, brightYellow,
		brightBlue, brightMagenta, brightCyan, brightWhite,
	] = spec.ansi;
	return {
		foreground: spec.foreground,
		background: spec.background,
		cursor: spec.cursor,
		// The cell under the block cursor: the background reads as an inversion.
		cursorAccent: spec.background,
		selectionBackground: spec.selection,
		selectionForeground: spec.selectionForeground ?? spec.foreground,
		black,
		red,
		green,
		yellow,
		blue,
		magenta,
		cyan,
		white,
		brightBlack,
		brightRed,
		brightGreen,
		brightYellow,
		brightBlue,
		brightMagenta,
		brightCyan,
		brightWhite,
	};
}

/** Whether `value` is one of the names this build knows. */
export function isTerminalThemeName(value: unknown): value is TerminalThemeName {
	return (
		typeof value === 'string' &&
		(TERMINAL_THEMES as readonly string[]).includes(value)
	);
}

/**
 * A stored setting (hand-edited `data.json`, or a name a newer build wrote) turned
 * into a name this build supports. Anything unknown falls back to the default.
 */
export function normalizeThemeName(value: unknown): TerminalThemeName {
	return isTerminalThemeName(value) ? value : DEFAULT_TERMINAL_THEME;
}

/** True when the theme takes its colours from Obsidian's CSS variables. */
export function followsObsidian(name: unknown): boolean {
	return normalizeThemeName(name) === 'obsidian';
}

/**
 * The colours the renderer should hand ghostty-web.
 *
 * `obsidian` (and any unknown name) returns `fromObsidian` unchanged, which is
 * byte for byte what the renderer did before #26 — including leaving keys unset
 * when the CSS theme does not define the variable. A built-in palette ignores
 * `fromObsidian` entirely and always returns all keys.
 */
export function resolveTheme(
	name: unknown,
	fromObsidian: TerminalTheme = {},
): TerminalTheme {
	const resolved = normalizeThemeName(name);
	if (resolved === 'obsidian') return fromObsidian;
	return paletteTheme(PALETTES[resolved]);
}
