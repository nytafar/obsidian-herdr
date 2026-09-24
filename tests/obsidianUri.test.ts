/**
 * `obsidian://` URIs in a transcript (issue #114): what one names, whether it
 * is a note in this vault, and where one starts and ends in a run of text.
 * The shapes are the ones agents in this vault actually print.
 */

import { describe, expect, it } from 'vitest';
import {
	findObsidianUris,
	parseObsidianUri,
	resolveObsidianUri,
	soleObsidianUri,
	type VaultLookup,
} from '../src/native/obsidianUri';

const BASE = '/home/lasse/hvelv';

/** A vault named `hvelv` holding exactly these files. */
function vault(files: string[], name = 'hvelv'): VaultLookup {
	const set = new Set(files);
	return {
		name,
		basePath: BASE,
		exact: (path) => (set.has(path) ? path : null),
		// Obsidian's shortest-path resolution, as far as these cases need it.
		link: (linkpath) =>
			files.find((file) => file === `${linkpath}.md` || file.endsWith(`/${linkpath}.md`)) ??
			null,
	};
}

const NOTES = vault([
	'registry/clients/my/Prøver.md',
	'registry/herbs/reishi/reishi.md',
	'Daily notes.md',
	'attachments/plot.png',
	'a+b.md',
]);

describe('parseObsidianUri', () => {
	it('reads open with a vault and a percent-encoded file', () => {
		expect(
			parseObsidianUri('obsidian://open?vault=hvelv&file=registry%2Fclients%2Fmy%2FPr%C3%B8ver'),
		).toEqual({ kind: 'file', vault: 'hvelv', file: 'registry/clients/my/Prøver' });
	});

	it('reads open with an absolute path, which overrides vault and file', () => {
		expect(
			parseObsidianUri('obsidian://open?vault=x&file=y&path=%2Fhome%2Flasse%2Fhvelv%2Fa.md'),
		).toEqual({ kind: 'path', path: '/home/lasse/hvelv/a.md' });
	});

	it('reads the vault shorthand, one decoded segment at a time', () => {
		expect(parseObsidianUri('obsidian://vault/hvelv/registry/clients/my/Pr%C3%B8ver')).toEqual({
			kind: 'file',
			vault: 'hvelv',
			file: 'registry/clients/my/Prøver',
		});
	});

	it('keeps a plus a plus, as Obsidian does', () => {
		expect(parseObsidianUri('obsidian://open?vault=hvelv&file=a+b')).toEqual({
			kind: 'file',
			vault: 'hvelv',
			file: 'a+b',
		});
	});

	it('drops what follows a hash and a trailing slash on the action', () => {
		expect(parseObsidianUri('obsidian://open/?vault=hvelv&file=a#Heading')).toEqual({
			kind: 'file',
			vault: 'hvelv',
			file: 'a',
		});
	});

	it('opens nothing for another action, an open with no note, or garbage', () => {
		expect(parseObsidianUri('obsidian://new?vault=hvelv&file=a')).toBeNull();
		expect(parseObsidianUri('obsidian://search?vault=hvelv&query=a')).toBeNull();
		expect(parseObsidianUri('obsidian://open?vault=hvelv')).toBeNull();
		expect(parseObsidianUri('obsidian://open')).toBeNull();
		expect(parseObsidianUri('obsidian://vault/hvelv')).toBeNull();
		expect(parseObsidianUri('obsidian://open?vault=hvelv&file=%E0%A4%A')).toBeNull();
		expect(parseObsidianUri('https://example.com/?file=a')).toBeNull();
		expect(parseObsidianUri('')).toBeNull();
	});
});

describe('resolveObsidianUri', () => {
	it('finds an encoded, non-ASCII note printed without .md', () => {
		expect(
			resolveObsidianUri(
				'obsidian://open?vault=hvelv&file=registry%2Fclients%2Fmy%2FPr%C3%B8ver',
				NOTES,
			),
		).toBe('registry/clients/my/Prøver.md');
	});

	it('finds a file named exactly, extension and all', () => {
		expect(
			resolveObsidianUri('obsidian://open?vault=hvelv&file=attachments%2Fplot.png', NOTES),
		).toBe('attachments/plot.png');
		expect(resolveObsidianUri('obsidian://open?vault=hvelv&file=Daily%20notes.md', NOTES)).toBe(
			'Daily notes.md',
		);
	});

	it('falls back to link resolution for a bare note name', () => {
		expect(resolveObsidianUri('obsidian://open?vault=hvelv&file=reishi', NOTES)).toBe(
			'registry/herbs/reishi/reishi.md',
		);
	});

	it('strips the vault path off an absolute path', () => {
		expect(
			resolveObsidianUri(
				'obsidian://open?path=%2Fhome%2Flasse%2Fhvelv%2Fregistry%2Fherbs%2Freishi%2Freishi.md',
				NOTES,
			),
		).toBe('registry/herbs/reishi/reishi.md');
		expect(
			resolveObsidianUri('obsidian://open?path=%2Fhome%2Flasse%2Fhvelv%2FDaily%20notes', NOTES),
		).toBe('Daily notes.md');
	});

	it('resolves the vault shorthand', () => {
		expect(resolveObsidianUri('obsidian://vault/hvelv/registry/herbs/reishi/reishi', NOTES)).toBe(
			'registry/herbs/reishi/reishi.md',
		);
	});

	it('leaves another vault, a path outside this one, and a missing note alone', () => {
		expect(resolveObsidianUri('obsidian://open?vault=work&file=Daily%20notes', NOTES)).toBeNull();
		expect(resolveObsidianUri('obsidian://vault/work/Daily%20notes', NOTES)).toBeNull();
		// A `file=` with no vault is not this vault's to claim.
		expect(resolveObsidianUri('obsidian://open?file=Daily%20notes', NOTES)).toBeNull();
		expect(resolveObsidianUri('obsidian://open?path=%2Fhome%2Flasse%2Fhvelvet%2Fa', NOTES)).toBeNull();
		expect(resolveObsidianUri('obsidian://open?path=%2Fetc%2Fhosts', NOTES)).toBeNull();
		expect(resolveObsidianUri('obsidian://open?vault=hvelv&file=nowhere', NOTES)).toBeNull();
		expect(resolveObsidianUri('obsidian://new?vault=hvelv&file=Daily%20notes', NOTES)).toBeNull();
	});

	it('claims no absolute path when the vault has none', () => {
		expect(
			resolveObsidianUri('obsidian://open?path=%2Fhome%2Flasse%2Fhvelv%2FDaily%20notes', {
				...NOTES,
				basePath: '',
			}),
		).toBeNull();
	});
});

describe('findObsidianUris', () => {
	it('finds each URI in a sentence, with its position', () => {
		const text = 'Wrote obsidian://open?vault=hvelv&file=a and obsidian://vault/hvelv/b today';
		expect(findObsidianUris(text)).toEqual([
			{ uri: 'obsidian://open?vault=hvelv&file=a', start: 6, end: 40 },
			{ uri: 'obsidian://vault/hvelv/b', start: 45, end: 69 },
		]);
	});

	it('leaves the sentence its punctuation and its brackets', () => {
		expect(findObsidianUris('See obsidian://open?vault=v&file=a.').map((m) => m.uri)).toEqual([
			'obsidian://open?vault=v&file=a',
		]);
		expect(findObsidianUris('(obsidian://open?vault=v&file=a), next').map((m) => m.uri)).toEqual([
			'obsidian://open?vault=v&file=a',
		]);
		expect(findObsidianUris('**obsidian://open?vault=v&file=a**').map((m) => m.uri)).toEqual([
			'obsidian://open?vault=v&file=a',
		]);
	});

	it('keeps a bracket the URI opened itself', () => {
		expect(findObsidianUris('obsidian://open?vault=v&file=a(1)').map((m) => m.uri)).toEqual([
			'obsidian://open?vault=v&file=a(1)',
		]);
	});

	it('ends a URI at a quote, a backtick or an angle bracket', () => {
		expect(findObsidianUris('"obsidian://vault/v/a" `x` <obsidian://vault/v/b>').map((m) => m.uri))
			.toEqual(['obsidian://vault/v/a', 'obsidian://vault/v/b']);
	});

	it('finds nothing in text with no URI, or only the scheme', () => {
		expect(findObsidianUris('no links here')).toEqual([]);
		expect(findObsidianUris('obsidian:// alone')).toEqual([]);
	});
});

describe('soleObsidianUri', () => {
	it('is the URI when the text is exactly one, whitespace aside', () => {
		expect(soleObsidianUri(' obsidian://vault/v/a ')).toBe('obsidian://vault/v/a');
	});

	it('is null for anything more or less', () => {
		expect(soleObsidianUri('open obsidian://vault/v/a')).toBeNull();
		expect(soleObsidianUri('obsidian://vault/v/a.')).toBeNull();
		expect(soleObsidianUri('obsidian://vault/v/a obsidian://vault/v/b')).toBeNull();
		expect(soleObsidianUri('npm test')).toBeNull();
	});
});
