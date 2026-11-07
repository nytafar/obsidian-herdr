/**
 * What the native view's stylesheet promises and no unit test can draw (#146):
 * a narrow layout keyed on the view's own width, and a reader who asked for
 * reduced motion getting none. Layout itself is a hand check in Obsidian
 * (no horizontal scroll at 280px); this keeps the rules from going missing.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

/** The body of every at-rule whose prelude matches, braces balanced. */
function blocks(prelude: RegExp): string[] {
	const found: string[] = [];
	for (const match of css.matchAll(new RegExp(prelude.source, 'g'))) {
		const open = css.indexOf('{', match.index);
		let depth = 0;
		for (let at = open; at < css.length; at++) {
			if (css[at] === '{') depth++;
			if (css[at] === '}' && --depth === 0) {
				found.push(css.slice(open + 1, at));
				break;
			}
		}
	}
	return found;
}

describe('styles.css: the native view', () => {
	it('names the view as the container its narrow layout measures', () => {
		expect(css).toMatch(/\.herdr-native-view \{[^}]*container: herdr-native \/ size;/);
	});

	it('lays out a narrow view by the view’s width, not the window’s', () => {
		const narrow = blocks(/@container herdr-native \(max-width: \d+px\)/).join('\n');
		expect(narrow).toContain('.herdr-native-prompt-toolbar');
		expect(narrow).toContain('.herdr-native-turn table');
		// The session bar collapses to short values (#161).
		expect(narrow).toContain('.herdr-native-session-short');
	});

	it('never lets the text area’s own minimum widen the view', () => {
		expect(css).toMatch(/\.herdr-native-prompt-input \{[^}]*min-width: 0;/);
	});

	it('turns motion off for a reader who asked for less', () => {
		const reduced = blocks(/@media \(prefers-reduced-motion: reduce\)/).join('\n');
		expect(reduced).toContain('.herdr-native-view');
		expect(reduced).toMatch(/transition: none/);
		expect(reduced).toMatch(/scroll-behavior: auto/);
	});
});
