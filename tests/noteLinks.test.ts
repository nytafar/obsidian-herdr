/**
 * Where a link in the native view opens, and what its `obsidian://` URIs turn
 * into (issue #114). The leaf decision is pure; the DOM pass runs on the
 * harness in `tests/fixtures/dom.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
	chooseLinkLeaf,
	linkSourcePath,
	linkVaultUris,
	VAULT_URI_CLASS,
	type LinkLeafCandidate,
} from '../src/native/noteLinks';
import { hostEl, type FakeElement } from './fixtures/dom';

type Candidate = LinkLeafCandidate<string, string>;

function leaf(
	name: string,
	group: string,
	file: string | null,
	extra: Partial<Candidate> = {},
): Candidate {
	return { leaf: name, group, file, panel: false, pinned: false, ...extra };
}

/** The layout a terminal placed beside its note leaves: note left, view right. */
const OWN = 'native';
const VIEW = leaf(OWN, 'right', null, { panel: true });

function choose(
	leaves: Candidate[],
	options: {
		targetPath?: string | null;
		activeFilePath?: string | null;
		ownInSidebar?: boolean;
		own?: string | null;
	} = {},
) {
	return chooseLinkLeaf({
		own: options.own === undefined ? OWN : options.own,
		ownGroup: options.own === null ? null : 'right',
		ownInSidebar: options.ownInSidebar ?? false,
		targetPath: options.targetPath ?? null,
		activeFilePath: options.activeFilePath ?? null,
		leaves,
	});
}

describe('chooseLinkLeaf', () => {
	it('opens in the split beside the view, the one showing the note the reader came from', () => {
		const leaves = [leaf('note', 'left', 'today.md'), VIEW];
		expect(choose(leaves, { targetPath: 'b.md', activeFilePath: 'today.md' })).toEqual({
			kind: 'reuse',
			leaf: 'note',
		});
	});

	it('reuses a leaf beside the view that already shows the note, even a pinned one', () => {
		const leaves = [
			leaf('note', 'left', 'today.md'),
			leaf('b', 'left', 'b.md', { pinned: true }),
			VIEW,
		];
		expect(choose(leaves, { targetPath: 'b.md', activeFilePath: 'today.md' })).toEqual({
			kind: 'reuse',
			leaf: 'b',
		});
	});

	it('never navigates the view itself, another herdr view, or a tab behind the view', () => {
		const leaves = [
			// A tab in the view's own group: showing it would hide the transcript.
			leaf('behind', 'right', 'b.md'),
			leaf('other-agent', 'left', 'b.md', { panel: true }),
			{ ...VIEW, file: 'b.md' },
		];
		expect(choose(leaves, { targetPath: 'b.md', activeFilePath: 'b.md' })).toEqual({
			kind: 'split',
			from: OWN,
		});
	});

	it('splits off the view when the note beside it is pinned', () => {
		const leaves = [leaf('note', 'left', 'today.md', { pinned: true }), VIEW];
		expect(choose(leaves, { targetPath: 'b.md', activeFilePath: 'today.md' })).toEqual({
			kind: 'split',
			from: OWN,
		});
	});

	it('splits off the view when nothing sits beside it', () => {
		expect(choose([VIEW], { targetPath: 'b.md', activeFilePath: null })).toEqual({
			kind: 'split',
			from: OWN,
		});
	});

	it('opens a tab rather than a split in a sidebar, or with no leaf of its own', () => {
		expect(choose([leaf('graph', 'main', null)], { ownInSidebar: true })).toEqual({ kind: 'tab' });
		expect(choose([leaf('graph', 'main', null)], { own: null })).toEqual({ kind: 'tab' });
	});

	it('reuses the main area beside a view in the sidebar', () => {
		const leaves = [leaf('note', 'main', 'today.md')];
		expect(choose(leaves, { ownInSidebar: true, activeFilePath: 'today.md' })).toEqual({
			kind: 'reuse',
			leaf: 'note',
		});
	});
});

describe('linkSourcePath', () => {
	it('is a path in the cwd when the cwd is inside the vault', () => {
		expect(linkSourcePath('/home/lasse/hvelv/repos/x/', '/home/lasse/hvelv')).toBe('repos/x/');
	});

	it('is the vault root for the vault itself, a folder outside it, or no vault', () => {
		expect(linkSourcePath('/home/lasse/hvelv', '/home/lasse/hvelv')).toBe('');
		expect(linkSourcePath('/home/lasse/hvelvet', '/home/lasse/hvelv')).toBe('');
		expect(linkSourcePath('/tmp', '/home/lasse/hvelv')).toBe('');
		expect(linkSourcePath('/home/lasse/hvelv/a', '')).toBe('');
	});
});

const URI = 'obsidian://open?vault=hvelv&file=registry%2Fclients%2Fmy%2FPr%C3%B8ver';
const PATH = 'registry/clients/my/Prøver.md';
const OTHER = 'obsidian://open?vault=work&file=a';

function resolve(uri: string): string | null {
	return uri === URI ? PATH : null;
}

/** A paragraph as Obsidian renders it, built by hand. */
function paragraph(): { root: FakeElement; p: FakeElement } {
	const { el } = hostEl();
	return { root: el, p: el.createEl('p') };
}

describe('linkVaultUris', () => {
	it('links a bare URI in text, shown as the note path', () => {
		const { root, p } = paragraph();
		p.appendText(`Saved to ${URI}, see there.`);

		linkVaultUris(root as unknown as HTMLElement, resolve);

		expect(p.textContent).toBe(`Saved to ${PATH}, see there.`);
		const link = p.find('internal-link');
		expect(link.tag).toBe('a');
		expect(link.hasClass(VAULT_URI_CLASS)).toBe(true);
		expect(link.attrs['data-href']).toBe(PATH);
		expect(link.attrs.href).toBe(PATH);
	});

	it('makes a URI for another vault an external link, as written', () => {
		const { root, p } = paragraph();
		p.appendText(`Elsewhere: ${OTHER}`);

		linkVaultUris(root as unknown as HTMLElement, resolve);

		expect(p.textContent).toBe(`Elsewhere: ${OTHER}`);
		const link = p.find('external-link');
		expect(link.attrs.href).toBe(OTHER);
		expect(p.findAll('internal-link')).toEqual([]);
	});

	it('links inline code that is exactly one URI, and leaves other code alone', () => {
		const { root, p } = paragraph();
		p.createEl('code', { text: URI });
		p.createEl('code', { text: `open ${URI}` });
		p.createEl('code', { text: OTHER });
		const pre = root.createEl('pre');
		pre.createEl('code', { text: URI });

		linkVaultUris(root as unknown as HTMLElement, resolve);

		expect(p.children.map((child) => child.tag)).toEqual(['a', 'code', 'code']);
		expect(p.children[0]?.textContent).toBe(PATH);
		expect(pre.textContent).toBe(URI);
		expect(pre.findAll('internal-link')).toEqual([]);
	});

	it('shows the path on a link whose text is its own URI', () => {
		const { root, p } = paragraph();
		p.createEl('a', { cls: 'external-link', text: URI, href: URI, attr: { target: '_blank' } });

		linkVaultUris(root as unknown as HTMLElement, resolve);

		const link = p.find('internal-link');
		expect(link.textContent).toBe(PATH);
		expect(link.hasClass('external-link')).toBe(false);
		expect(link.attrs.target).toBeUndefined();
		expect(link.attrs['aria-label']).toBeUndefined();
	});

	it('keeps a labelled link its label and puts the path in its tooltip', () => {
		const { root, p } = paragraph();
		p.createEl('a', {
			cls: 'external-link',
			text: 'The samples',
			href: URI,
			attr: { 'aria-label': URI },
		});

		linkVaultUris(root as unknown as HTMLElement, resolve);

		const link = p.find('internal-link');
		expect(link.textContent).toBe('The samples');
		expect(link.attrs['aria-label']).toBe(PATH);
		expect(link.attrs['data-href']).toBe(PATH);
	});

	it('leaves a link to another vault, and every other link, as it was', () => {
		const { root, p } = paragraph();
		p.createEl('a', { cls: 'external-link', text: OTHER, href: OTHER });
		p.createEl('a', { cls: 'external-link', text: 'Web', href: 'https://example.com' });

		linkVaultUris(root as unknown as HTMLElement, resolve);

		expect(p.findAll('external-link').map((link) => link.textContent)).toEqual([OTHER, 'Web']);
		expect(p.findAll('internal-link')).toEqual([]);
	});

	it('reaches text nested in lists and emphasis', () => {
		const { root } = paragraph();
		const item = root.createEl('ul').createEl('li');
		item.createEl('strong').appendText(URI);

		linkVaultUris(root as unknown as HTMLElement, resolve);

		expect(item.find('internal-link').textContent).toBe(PATH);
	});
});
