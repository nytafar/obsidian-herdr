/**
 * What a click on a link in the native view means (issue #114,
 * `src/native/links.ts`): a wikilink, an `obsidian://` url for this vault, or
 * something the view leaves to the browser or the OS.
 */

import { describe, expect, it } from 'vitest';
import { linkAction, linkSourcePath, obsidianUrlTarget } from '../src/native/links';

const VAULT = { name: 'hvelv', path: '/home/lasse/hvelv' };

describe('obsidianUrlTarget', () => {
	it('reads open with this vault and a file', () => {
		expect(obsidianUrlTarget('obsidian://open?vault=hvelv&file=repos%2FPlan', VAULT)).toBe(
			'repos/Plan',
		);
		expect(obsidianUrlTarget('obsidian://open?file=Plan.md&vault=hvelv', VAULT)).toBe('Plan.md');
	});

	it('takes an open with no vault as this one', () => {
		expect(obsidianUrlTarget('obsidian://open?file=Plan', VAULT)).toBe('Plan');
	});

	it('leaves another vault to the OS handler', () => {
		expect(obsidianUrlTarget('obsidian://open?vault=work&file=Plan', VAULT)).toBeNull();
		expect(obsidianUrlTarget('obsidian://vault/work/Plan', VAULT)).toBeNull();
	});

	it('decodes percent escapes and keeps a plus a plus', () => {
		expect(obsidianUrlTarget('obsidian://open?vault=hvelv&file=C%2B%2B+notes%20one', VAULT)).toBe(
			'C+++notes one',
		);
	});

	it('reads an absolute path inside the vault, and only inside it', () => {
		expect(
			obsidianUrlTarget('obsidian://open?path=%2Fhome%2Flasse%2Fhvelv%2Fa%2Fb.md', VAULT),
		).toBe('a/b.md');
		expect(obsidianUrlTarget('obsidian://open?path=%2Fetc%2Fhosts', VAULT)).toBeNull();
		expect(obsidianUrlTarget('obsidian:///home/lasse/hvelv/a%20b.md', VAULT)).toBe('a b.md');
		expect(obsidianUrlTarget('obsidian:///home/lasse/other/a.md', VAULT)).toBeNull();
	});

	it('reads the vault shorthand', () => {
		expect(obsidianUrlTarget('obsidian://vault/hvelv/repos/My%20note', VAULT)).toBe(
			'repos/My note',
		);
	});

	it('leaves every other action, a missing file and a bad escape alone', () => {
		expect(obsidianUrlTarget('obsidian://search?vault=hvelv&query=x', VAULT)).toBeNull();
		expect(obsidianUrlTarget('obsidian://herdr?pane=w1:p1', VAULT)).toBeNull();
		expect(obsidianUrlTarget('obsidian://open?vault=hvelv', VAULT)).toBeNull();
		expect(obsidianUrlTarget('obsidian://open?vault=hvelv&file=%E0%A4%A', VAULT)).toBeNull();
		expect(obsidianUrlTarget('https://example.com', VAULT)).toBeNull();
	});
});

describe('linkAction', () => {
	it('opens an internal link by its data-href, falling back to href', () => {
		expect(linkAction({ internal: true, dataHref: 'Plan#Goals', href: 'x' }, VAULT)).toEqual({
			kind: 'note',
			linktext: 'Plan#Goals',
		});
		expect(linkAction({ internal: true, dataHref: null, href: 'Plan' }, VAULT)).toEqual({
			kind: 'note',
			linktext: 'Plan',
		});
		expect(linkAction({ internal: true, dataHref: ' ', href: null }, VAULT)).toEqual({
			kind: 'pass',
		});
	});

	it('passes a web page to the browser and any other scheme to the OS', () => {
		for (const href of ['https://example.com/a', 'http://x', 'mailto:a@b.c', 'file:///etc/hosts']) {
			expect(linkAction({ internal: false, dataHref: null, href }, VAULT)).toEqual({ kind: 'pass' });
		}
	});

	it('opens an obsidian url for this vault, and passes one for another', () => {
		expect(
			linkAction(
				{ internal: false, dataHref: null, href: 'obsidian://open?vault=hvelv&file=Plan' },
				VAULT,
			),
		).toEqual({ kind: 'note', linktext: 'Plan' });
		expect(
			linkAction(
				{ internal: false, dataHref: null, href: 'obsidian://open?vault=work&file=Plan' },
				VAULT,
			),
		).toEqual({ kind: 'pass' });
	});
});

describe('linkSourcePath', () => {
	it('resolves from the pane’s folder inside the vault', () => {
		expect(linkSourcePath('/home/lasse/hvelv/repos/obsidian-herdr/', VAULT.path)).toBe(
			'repos/obsidian-herdr/.herdr-session',
		);
	});

	it('resolves from the vault root otherwise', () => {
		expect(linkSourcePath('/home/lasse/hvelv', VAULT.path)).toBe('');
		expect(linkSourcePath('/home/lasse/hvelvet/x', VAULT.path)).toBe('');
		expect(linkSourcePath('/tmp', VAULT.path)).toBe('');
		expect(linkSourcePath('', VAULT.path)).toBe('');
		expect(linkSourcePath('/home/lasse/hvelv/a', '')).toBe('');
	});
});
