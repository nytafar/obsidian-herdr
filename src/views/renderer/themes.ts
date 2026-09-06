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

/* -------------------------------------------------------------------------- */
/* The `obsidian` theme: Obsidian's CSS variables mapped onto the ANSI slots.   */
/* -------------------------------------------------------------------------- */

/**
 * How the renderer hands CSS variables in. `getComputedStyle(body)
 * .getPropertyValue(name)` trimmed, with the empty string turned into
 * `undefined`, so this file never sees a DOM and tests can feed a plain record.
 */
export type CssVarReader = (name: string) => string | undefined;

/** What the mapping needs beyond the variables themselves. */
export interface ObsidianThemeContext {
	/**
	 * Whether the vault is in dark mode. The renderer reads
	 * `body.classList.contains('theme-dark')`; when it is left undefined the
	 * mapping falls back to the luminance of `--background-primary`.
	 */
	dark?: boolean;
}

interface Rgb {
	r: number;
	g: number;
	b: number;
	/** 0-1; 1 for every notation that carries no alpha. */
	a: number;
}

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;
/** `rgb(1 2 3)`, `rgb(1,2,3)`, `rgba(1,2,3,.5)` and the bare `1, 2, 3` triplet. */
const RGB_FUNC = /^rgba?\s*\(([^)]*)\)$/i;
const BARE_TRIPLET = /^\d+\s*[, ]\s*\d+\s*[, ]\s*\d+$/;

function clamp255(n: number): number {
	return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * A CSS colour as numbers, or undefined when the notation is one this file does
 * not read (`hsl()`, `color()`, named colours). Undefined always means "leave the
 * slot to its fallback", never "black".
 */
export function parseColor(value: string | undefined): Rgb | undefined {
	if (!value) return undefined;
	const text = value.trim();
	if (!text) return undefined;

	const hex6 = HEX6.exec(text);
	if (hex6) {
		const byte = (h: string | undefined): number => parseInt(h ?? '00', 16);
		return {
			r: byte(hex6[1]),
			g: byte(hex6[2]),
			b: byte(hex6[3]),
			a: hex6[4] === undefined ? 1 : byte(hex6[4]) / 255,
		};
	}
	const hex3 = HEX3.exec(text);
	if (hex3) {
		const dup = (h: string | undefined): number => parseInt((h ?? '0').repeat(2), 16);
		return {
			r: dup(hex3[1]),
			g: dup(hex3[2]),
			b: dup(hex3[3]),
			a: hex3[4] === undefined ? 1 : dup(hex3[4]) / 255,
		};
	}

	const func = RGB_FUNC.exec(text);
	const body = func ? (func[1] ?? '') : BARE_TRIPLET.test(text) ? text : undefined;
	if (body === undefined) return undefined;
	const parts = body
		.replace(/\//g, ' ')
		.split(/[\s,]+/)
		.filter((p) => p.length > 0);
	if (parts.length < 3) return undefined;
	const [r, g, b] = parts.map((p) => Number.parseFloat(p));
	if (r === undefined || g === undefined || b === undefined) return undefined;
	if (![r, g, b].every((n) => Number.isFinite(n))) return undefined;
	let a = 1;
	const raw = parts[3];
	if (raw !== undefined) {
		const n = Number.parseFloat(raw);
		if (!Number.isFinite(n)) return undefined;
		a = raw.endsWith('%') ? n / 100 : n;
	}
	return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: Math.max(0, Math.min(1, a)) };
}

function toHex(color: Rgb): string {
	const hex = (n: number): string => clamp255(n).toString(16).padStart(2, '0');
	return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}

/** Relative luminance, the sRGB approximation. 0 is black, 1 is white. */
export function luminance(color: Rgb): number {
	return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
}

/**
 * The lightening step for the bright ANSI variants: mix 30 % of the target
 * extreme into the base colour. "Bright" means *further from the background*, so
 * on a dark vault the target is white and on a light vault it is black; a bright
 * red on paper that is 30 % nearer white would be less legible than the normal
 * one, which is exactly the collapse this replaces.
 *
 * The step is fixed rather than perceptual on purpose: it is reproducible, it is
 * enough to be visible at 30 %, and it cannot silently produce the input.
 */
export const BRIGHT_MIX = 0.3;

function mix(color: Rgb, target: number, amount: number): Rgb {
	return {
		r: color.r + (target - color.r) * amount,
		g: color.g + (target - color.g) * amount,
		b: color.b + (target - color.b) * amount,
		a: color.a,
	};
}

/**
 * The bright counterpart of `color`. Mixes {@link BRIGHT_MIX} toward white on a
 * dark background and toward black on a light one, and if the base is already at
 * that extreme (pure white in dark mode) it steps the other way, so the returned
 * colour is never equal to the input.
 */
export function brighten(color: Rgb, dark: boolean): Rgb {
	const target = dark ? 255 : 0;
	const stepped = mix(color, target, BRIGHT_MIX);
	if (toHex(stepped) !== toHex(color)) return stepped;
	return mix(color, dark ? 0 : 255, BRIGHT_MIX);
}

/** The hues Obsidian publishes, each with a `--color-<hue>-rgb` companion. */
type Hue = 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'purple' | 'pink';

/** ANSI slot → hue. Magenta is Obsidian's purple; ANSI has no orange slot. */
const HUE_FOR_SLOT: Record<
	'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan',
	Hue
> = {
	red: 'red',
	green: 'green',
	yellow: 'yellow',
	blue: 'blue',
	magenta: 'purple',
	cyan: 'cyan',
};

/**
 * A hue as numbers. `--color-<hue>-rgb` is the authoritative triplet — themes
 * define it next to the hex so that `rgba(var(--color-red-rgb), .2)` works — and
 * `--color-<hue>` is the fallback for a theme that only sets the hex.
 */
function readHue(read: CssVarReader, hue: Hue): Rgb | undefined {
	return parseColor(read(`--color-${hue}-rgb`)) ?? parseColor(read(`--color-${hue}`));
}

/** First variable in `names` that parses as a colour. */
function readColor(read: CssVarReader, ...names: string[]): Rgb | undefined {
	for (const name of names) {
		const parsed = parseColor(read(name));
		if (parsed) return parsed;
	}
	return undefined;
}

/**
 * The grey ramp, per appearance. Obsidian's twelve base steps run light-to-dark
 * in a light vault and dark-to-light in a dark one, so one fixed choice cannot
 * serve both: `--color-base-30` is a near-white in a light theme and a dark grey
 * in a dark one. These pick the same *perceptual* positions in either — black
 * just off the background, bright white at the far end — using the finer steps
 * (25, 35, 40, 60, 70) rather than only the coarse ones.
 *
 * Each entry is a fallback chain, because a theme that predates the finer steps
 * may define only 00/10/20/…; the last name in each is one of those.
 */
interface BaseScale {
	black: string[];
	brightBlack: string[];
	white: string[];
	brightWhite: string[];
}

const DARK_BASE_SCALE: BaseScale = {
	black: ['--color-base-25', '--color-base-20', '--color-base-30'],
	brightBlack: ['--color-base-40', '--color-base-35', '--color-base-50'],
	white: ['--color-base-70', '--color-base-60'],
	brightWhite: ['--color-base-100'],
};

const LIGHT_BASE_SCALE: BaseScale = {
	black: ['--color-base-100'],
	brightBlack: ['--color-base-60', '--color-base-70'],
	white: ['--color-base-35', '--color-base-40', '--color-base-30'],
	brightWhite: ['--color-base-00', '--color-base-05', '--color-base-10'],
};

/** Whether the vault is dark: the explicit flag, else the background's luminance. */
function isDarkTheme(read: CssVarReader, context: ObsidianThemeContext): boolean {
	if (context.dark !== undefined) return context.dark;
	const background = readColor(read, '--background-primary');
	// No parsable background at all: dark is Obsidian's own default appearance.
	return background === undefined ? true : luminance(background) < 0.5;
}

/**
 * Obsidian's CSS variables as terminal colours — the `obsidian` theme, the
 * default and the only one computed rather than tabulated.
 *
 * Pure by construction: `read` is the only way in, so the renderers keep the DOM
 * and this file stays unit-testable. A slot whose variables are all missing or
 * unparsable is left unset, exactly as the pre-#50 table did, and the renderer
 * library falls back to its own default for it.
 */
export function obsidianTheme(
	read: CssVarReader,
	context: ObsidianThemeContext = {},
): TerminalTheme {
	const dark = isDarkTheme(read, context);
	const theme: TerminalTheme = {};
	const set = (key: ThemeColorKey, color: Rgb | undefined): void => {
		if (color) theme[key] = toHex(color);
	};

	set('foreground', readColor(read, '--text-normal'));
	set('background', readColor(read, '--background-primary'));
	set('cursor', readColor(read, '--text-accent'));
	set('cursorAccent', readColor(read, '--background-primary'));
	set('selectionBackground', readColor(read, '--text-selection'));
	set('selectionForeground', readColor(read, '--text-normal'));

	const scale = dark ? DARK_BASE_SCALE : LIGHT_BASE_SCALE;
	set('black', readColor(read, ...scale.black));
	set('brightBlack', readColor(read, ...scale.brightBlack));
	set('white', readColor(read, ...scale.white));
	set('brightWhite', readColor(read, ...scale.brightWhite));

	for (const [slot, hue] of Object.entries(HUE_FOR_SLOT)) {
		const base = readHue(read, hue);
		if (!base) continue;
		set(slot as ThemeColorKey, base);
		// Obsidian publishes no bright variants, so four of the eight pairs used
		// to read the same variable and collapse (#50); derive them instead.
		const bright = `bright${slot.charAt(0).toUpperCase()}${slot.slice(1)}`;
		set(bright as ThemeColorKey, brighten(base, dark));
	}

	return theme;
}
