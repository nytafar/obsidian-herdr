/**
 * How many terminal cells a line of Claude's screen takes, counted high, for
 * the waiting card's one width question (#166): did a question option's label
 * end where its line ends, or wrap onto the line its description starts on
 * (`./screenCard.ts`, `optionFromRow`)? Counting too high only makes a label
 * read as unsure, and the card then sends the user to the terminal; counting
 * too low can split a wrapped label into label and description, so every
 * rule here errs high.
 *
 * The table is xterm.js's Unicode 11 one, East_Asian_Width plus
 * Emoji_Presentation, the one the xterm.js engine selects
 * (`../views/renderer/unicodeWidth.ts`, which records how it agreed with
 * herdr's VT): `☕` U+2615, `⚡`, `✅`, `❌` and `⭐` are two cells, `✔` one.
 * Over it, the wide ranges any later Unicode filled count as two, since
 * Unicode 11 calls an emoji it does not know (`🫠` U+1FAE0, Unicode 14) one
 * cell. And a sequence whose width depends on the terminal (a presentation
 * selector, a joiner, a flag's regional indicators, a skin tone, a keycap, a
 * tag) has no certain width at all.
 */

import { Unicode11Addon } from '@xterm/addon-unicode11';

interface WidthProvider {
	wcwidth(codepoint: number): number;
}

let provider: WidthProvider | null = null;

/**
 * The addon's width table. Its only public surface is registering itself on a
 * terminal, so it registers on a stand-in that keeps what it is handed.
 */
function table(): WidthProvider {
	if (provider) return provider;
	let registered: WidthProvider | null = null;
	const stand = {
		unicode: {
			register: (given: WidthProvider) => {
				registered = given;
			},
		},
	};
	new Unicode11Addon().activate(stand as unknown as Parameters<Unicode11Addon['activate']>[0]);
	provider = registered ?? { wcwidth: () => 2 };
	return provider;
}

/** Code points two cells wide in Unicode 15 that Unicode 11's table may not know: counted two whatever it says. */
function wideSince11(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		code >= 0x1f000
	);
}

/** Code points that make the width of what they join depend on the terminal. */
function unsure(code: number): boolean {
	return (
		code === 0x200d || // zero width joiner
		code === 0xfe0e || // text presentation
		code === 0xfe0f || // emoji presentation
		code === 0x20e3 || // combining keycap
		(code >= 0x1f1e6 && code <= 0x1f1ff) || // regional indicators (flags)
		(code >= 0x1f3fb && code <= 0x1f3ff) || // skin tones
		(code >= 0xe0020 && code <= 0xe007f) // tags
	);
}

/**
 * The cells `text` takes on a terminal, at most, or null when that depends on
 * the terminal. Every code point counts at least one cell, a combining mark
 * included (too high, which is safe).
 */
export function cellsAtMost(text: string): number | null {
	const widths = table();
	let cells = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (unsure(code)) return null;
		cells += Math.max(widths.wcwidth(code), wideSince11(code) ? 2 : 1);
	}
	return cells;
}
