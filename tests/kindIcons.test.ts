/**
 * Agent kind marks (issue #19). The SVG strings go through Obsidian's `addIcon`,
 * which drops them into an `<svg viewBox="0 0 100 100">` as markup, so what is
 * worth asserting here is the shape of that contract — content only, no wrapper,
 * nothing executable — plus the fallback that keeps a row from rendering blank.
 */

import { describe, expect, it } from 'vitest';
import {
	FALLBACK_KIND_ICON,
	KIND_ICON_PREFIX,
	KIND_ICON_SVGS,
	iconForKind,
	isKindIcon,
	kindLabel,
	registerKindIcons,
} from '../src/views/kindIcons';
import { AGENT_KINDS } from '../src/settings';

describe('iconForKind', () => {
	it('gives every kind herdr can start a mark of its own', () => {
		for (const kind of AGENT_KINDS) {
			expect(iconForKind(kind)).toBe(`${KIND_ICON_PREFIX}${kind}`);
		}
	});

	it('falls back to a Lucide icon for an unknown or empty kind, never blank', () => {
		expect(iconForKind('')).toBe(FALLBACK_KIND_ICON);
		expect(iconForKind('   ')).toBe(FALLBACK_KIND_ICON);
		expect(iconForKind('some-future-harness')).toBe(FALLBACK_KIND_ICON);
	});

	it('normalises case and surrounding space', () => {
		expect(iconForKind(' Claude ')).toBe(`${KIND_ICON_PREFIX}claude`);
	});

	it('is not fooled by inherited object properties', () => {
		expect(iconForKind('constructor')).toBe(FALLBACK_KIND_ICON);
		expect(iconForKind('toString')).toBe(FALLBACK_KIND_ICON);
	});
});

describe('isKindIcon', () => {
	it('separates our fill-based marks from the stroked Lucide fallback', () => {
		expect(isKindIcon(iconForKind('claude'))).toBe(true);
		expect(isKindIcon(iconForKind('nothing-like-this'))).toBe(false);
		expect(isKindIcon(FALLBACK_KIND_ICON)).toBe(false);
	});
});

describe('kindLabel', () => {
	it('names the kind in sentence case', () => {
		expect(kindLabel('claude')).toBe('Claude');
		expect(kindLabel('opencode')).toBe('Opencode');
	});

	it('says something for a kind herdr did not report', () => {
		expect(kindLabel('')).toBe('Unknown agent');
		expect(kindLabel('  ')).toBe('Unknown agent');
	});
});

describe('the SVG strings', () => {
	it('are contents of an icon, not whole documents', () => {
		for (const [kind, svg] of Object.entries(KIND_ICON_SVGS)) {
			expect(svg, kind).not.toContain('<svg');
			expect(svg, kind).not.toContain('viewBox');
			expect(svg, kind).not.toContain('<script');
			expect(svg, kind).not.toContain('xlink');
			// Rendered inside markup, so an unbalanced element would break the row.
			expect(svg.split('<').length, kind).toBe(svg.split('>').length);
		}
	});

	it('stay small enough to bundle in main.js', () => {
		for (const [kind, svg] of Object.entries(KIND_ICON_SVGS)) {
			expect(svg.length, kind).toBeLessThan(1024);
		}
	});

	it('carry no colour of their own, so both themes inherit the row colour', () => {
		for (const [kind, svg] of Object.entries(KIND_ICON_SVGS)) {
			expect(svg, kind).not.toMatch(/fill="(?!currentColor)#?\w/);
			expect(svg, kind).not.toContain('stroke=');
		}
	});
});

describe('registerKindIcons', () => {
	it('registers one prefixed id per mark and nothing else', () => {
		const registered = new Map<string, string>();
		registerKindIcons((id, svg) => registered.set(id, svg));

		expect(registered.size).toBe(Object.keys(KIND_ICON_SVGS).length);
		for (const kind of AGENT_KINDS) {
			expect(registered.get(`${KIND_ICON_PREFIX}${kind}`)).toBe(KIND_ICON_SVGS[kind]);
		}
		for (const id of registered.keys()) expect(id.startsWith(KIND_ICON_PREFIX)).toBe(true);
	});
});
