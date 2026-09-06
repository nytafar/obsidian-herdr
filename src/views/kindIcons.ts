/**
 * Agent kind marks for the sidebar (PRD M8; issue #19).
 *
 * A row identifies its harness with an icon, not with the word "claude" on every
 * line. Obsidian's `setIcon` only knows Lucide, so a per-kind mark has to be
 * registered once with `addIcon()`; this module holds those SVG strings and the
 * pure lookup, and `main.ts` does nothing but hand it `addIcon` at load.
 *
 * No `obsidian` import on purpose: registration is injected, so everything here
 * is unit tested without a document (`tests/kindIcons.test.ts`).
 *
 * About the artwork. Nothing here is traced from a vendor's asset — every mark
 * is plain geometry written by hand, and the marks we could not draw both
 * recognisably and safely are lettered badges instead, which is the fallback the
 * ticket asks for rather than shipping something we may not ship:
 *
 * - `claude` is a symmetric eight-ray burst, `codex` the `</>` of general
 *   developer iconography, `pi` the mathematical glyph. None is a logo copy.
 * - Everything else is a letter in a rounded square, tooltip and `aria-label`
 *   carrying the real name.
 *
 * `addIcon` wants the *contents* of an SVG on a `0 0 100 100` viewBox, so these
 * strings hold path and text elements only, never an `<svg>` wrapper. They are
 * fill-based, unlike Lucide's stroked icons, which is why `styles.css` flips
 * `fill`/`stroke` back for them (Obsidian's `.svg-icon` rule sets `fill: none`,
 * and a CSS rule beats a presentation attribute).
 */

/** Prefix for every id this module registers, so nothing collides with Lucide. */
export const KIND_ICON_PREFIX = 'herdr-kind-';

/** Shown for a kind with no mark of its own, and for an empty kind. Lucide. */
export const FALLBACK_KIND_ICON = 'bot';

/**
 * Rounded square used by the lettered badges: one outer and one inner rounded
 * rectangle, filled with `evenodd` so the gap between them is the outline. A
 * stroked frame would need `stroke`, which the fill-based rule above removes.
 */
const LETTER_FRAME =
	'M30 10H70A20 20 0 0 1 90 30V70A20 20 0 0 1 70 90H30A20 20 0 0 1 10 70V30A20 20 0 0 1 30 10Z' +
	'M31 19H69A12 12 0 0 1 81 31V69A12 12 0 0 1 69 81H31A12 12 0 0 1 19 69V31A12 12 0 0 1 31 19Z';

/**
 * A letter in the rounded square. The font size and weight are attributes as
 * well as CSS so the badge still reads if a theme resets SVG text styling.
 */
function letterMark(letter: string): string {
	return (
		`<path fill-rule="evenodd" d="${LETTER_FRAME}"/>` +
		'<text x="50" y="52" text-anchor="middle" dominant-baseline="central"' +
		` font-size="44" font-weight="700">${letter}</text>`
	);
}

/** Eight tapered rays around the centre; wider at the tip than at the hub. */
const CLAUDE_MARK =
	'<path d="M53 41L57.5 5L42.5 5L47 41ZM58.5 45.8L87.1 23.5L76.5 12.9L54.2 41.5Z' +
	'M59 53L95 57.5L95 42.5L59 47ZM54.2 58.5L76.5 87.1L87.1 76.5L58.5 54.2Z' +
	'M47 59L42.5 95L57.5 95L53 59ZM41.5 54.2L12.9 76.5L23.5 87.1L45.8 58.5Z' +
	'M41 47L5 42.5L5 57.5L41 53ZM45.8 41.5L23.5 12.9L12.9 23.5L41.5 45.8Z"/>';

/** `</>`: two chevrons and a slash, each a filled polygon rather than a stroke. */
const CODEX_MARK =
	'<path d="M39.6 20L17.6 50L39.6 80L28.4 80L6.4 50L28.4 20Z' +
	'M49.6 82L59.6 18L50.4 18L40.4 82Z' +
	'M71.6 20L93.6 50L71.6 80L60.4 80L82.4 50L60.4 20Z"/>';

/** The Greek letter: one bar and two legs. */
const PI_MARK = '<path d="M18 27H82V39H18ZM31 39H43V77H31ZM57 39H69V77H57Z"/>';

/**
 * Kind (as herdr reports it in `pane.agent`) → SVG contents. Keys are lowercase;
 * {@link iconForKind} normalises before looking one up. A kind missing from here
 * is not an error, it simply falls back to {@link FALLBACK_KIND_ICON}, which is
 * what keeps a herdr that grows a new harness from rendering a blank row.
 */
export const KIND_ICON_SVGS: Readonly<Record<string, string>> = {
	claude: CLAUDE_MARK,
	codex: CODEX_MARK,
	pi: PI_MARK,
	opencode: letterMark('O'),
	gemini: letterMark('G'),
	cursor: letterMark('C'),
	amp: letterMark('A'),
	// "P" rather than a second "C": cursor already has it, and a badge that
	// repeats a letter tells a scanning eye nothing.
	copilot: letterMark('P'),
	kimi: letterMark('K'),
	droid: letterMark('D'),
	// grok is xAI's; "X" also keeps it apart from gemini's "G".
	grok: letterMark('X'),
};

/** Normalised lookup key for a `pane.agent` value. */
function normalise(kind: string): string {
	return kind.trim().toLowerCase();
}

/**
 * Icon id for a kind: the registered mark, or Lucide's `bot`. Never empty, so a
 * row always has something in the icon slot.
 */
export function iconForKind(kind: string): string {
	const key = normalise(kind);
	// `hasOwnProperty`, not `in`: a kind called "constructor" is a string herdr
	// could hand us, and `in` would answer yes for every prototype member.
	return Object.prototype.hasOwnProperty.call(KIND_ICON_SVGS, key)
		? `${KIND_ICON_PREFIX}${key}`
		: FALLBACK_KIND_ICON;
}

/**
 * Whether an id from {@link iconForKind} is one of ours. The view uses this to
 * add the class that restores `fill` — the Lucide fallback must keep its stroke.
 */
export function isKindIcon(icon: string): boolean {
	return icon.startsWith(KIND_ICON_PREFIX);
}

/** What the icon's tooltip and `aria-label` say. Sentence case, like all UI. */
export function kindLabel(kind: string): string {
	const trimmed = kind.trim();
	if (!trimmed) return 'Unknown agent';
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Registers every mark, once, at plugin load.
 *
 * @param register Obsidian's `addIcon`, injected so this module stays free of
 *   the `obsidian` import and testable under node.
 */
export function registerKindIcons(register: (iconId: string, svgContent: string) => void): void {
	for (const [kind, svg] of Object.entries(KIND_ICON_SVGS)) {
		register(`${KIND_ICON_PREFIX}${kind}`, svg);
	}
}
