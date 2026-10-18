/**
 * The shared path helpers. Their callers — `folderName`, `relativeCwd`,
 * `attachablePane`, `resolveWorkspace` — are covered by their own suites; what
 * is pinned here is the contract those callers rely on, in particular what the
 * root and an empty path answer.
 */

import { describe, expect, it } from 'vitest';
import {
	lastPathSegment,
	trimTrailingSlashes,
	vaultFolderDepth,
	vaultPathIsInside,
	vaultRelativeFolder,
} from '../src/paths';

describe('trimTrailingSlashes', () => {
	it('makes two spellings of a directory compare equal', () => {
		expect(trimTrailingSlashes('/Users/lasse/hvelv/')).toBe('/Users/lasse/hvelv');
		expect(trimTrailingSlashes('/Users/lasse/hvelv///')).toBe('/Users/lasse/hvelv');
		expect(trimTrailingSlashes('/Users/lasse/hvelv')).toBe('/Users/lasse/hvelv');
	});

	it('empties the root, which is what a `${root}/${rest}` join wants', () => {
		expect(trimTrailingSlashes('/')).toBe('');
		expect(trimTrailingSlashes('')).toBe('');
	});
});

describe('lastPathSegment', () => {
	it('answers the last segment, trailing slashes ignored', () => {
		expect(lastPathSegment('/Users/lasse/hvelv')).toBe('hvelv');
		expect(lastPathSegment('/Users/lasse/hvelv/')).toBe('hvelv');
		expect(lastPathSegment('hvelv')).toBe('hvelv');
	});

	it('has nothing to answer for the root or an empty path', () => {
		// `folderName` turns this one into '/'; a group label falls back to the cwd.
		expect(lastPathSegment('/')).toBe('');
		expect(lastPathSegment('')).toBe('');
	});
});

describe('vaultRelativeFolder', () => {
	const VAULT = '/Users/lasse/Vaults/hvelv';
	const REMOTE_VAULT = '/home/lasse/hvelv';

	it.each([
		['inside the vault', `${VAULT}/inputs/corpora`, VAULT, 'inputs/corpora'],
		['one folder down', `${VAULT}/efforts`, VAULT, 'efforts'],
		['at the root', VAULT, VAULT, ''],
		['at the root, cwd with a trailing slash', `${VAULT}/`, VAULT, ''],
		['at the root, vault with a trailing slash', VAULT, `${VAULT}/`, ''],
		['inside, both with trailing slashes', `${VAULT}/efforts//`, `${VAULT}///`, 'efforts'],
		['doubled slashes inside the cwd', `${VAULT}//inputs///corpora`, VAULT, 'inputs/corpora'],
		['dot segments resolved', `${VAULT}/inputs/./x/../corpora`, VAULT, 'inputs/corpora'],
		['surrounding whitespace ignored', `  ${VAULT}/efforts \n`, ` ${VAULT} `, 'efforts'],
		['a remote vault path', `${REMOTE_VAULT}/inputs/corpora`, REMOTE_VAULT, 'inputs/corpora'],
		['the remote root', REMOTE_VAULT, `${REMOTE_VAULT}/`, ''],
	])('maps a cwd %s', (_case, cwd, vault, expected) => {
		expect(vaultRelativeFolder(cwd, vault)).toBe(expected);
	});

	it.each([
		['outside the vault', '/Users/lasse/code/herdr', VAULT],
		['above the vault', '/Users/lasse/Vaults', VAULT],
		['the filesystem root', '/', VAULT],
		['a sibling sharing the vault as a prefix', `${VAULT}-old/notes`, VAULT],
		['a sibling equal to the vault plus a suffix', `${VAULT}-old`, VAULT],
		['leaving the vault through ..', `${VAULT}/../hvelv-old`, VAULT],
		['a local cwd against the remote vault', `${VAULT}/inputs`, REMOTE_VAULT],
		['a remote cwd against the local vault', `${REMOTE_VAULT}/inputs`, VAULT],
		['an unknown cwd', '', VAULT],
		['an unknown vault path', `${VAULT}/inputs`, ''],
		['a relative cwd', 'inputs/corpora', VAULT],
		['a relative vault path', `${VAULT}/inputs`, 'hvelv'],
		['a vault at the filesystem root', '/inputs', '/'],
	])('answers null for a cwd %s', (_case, cwd, vault) => {
		expect(vaultRelativeFolder(cwd, vault)).toBeNull();
	});
});

describe('vaultFolderDepth', () => {
	it.each([
		['', 0],
		['/', 0],
		['efforts', 1],
		['efforts/', 1],
		['inputs/corpora', 2],
		['inputs/corpora/silva-cacao', 3],
		['inputs//corpora/silva-cacao/', 3],
	])('counts %j as %i deep', (path, depth) => {
		expect(vaultFolderDepth(path)).toBe(depth);
	});
});

describe('vaultPathIsInside', () => {
	it.each([
		['a note in the folder', 'efforts/a.md', 'efforts', true],
		['a note deeper down', 'efforts/x/y/a.md', 'efforts', true],
		['the folder itself', 'efforts', 'efforts', true],
		['anything, in the root', 'efforts/a.md', '', true],
		['a note in a sibling with the folder as prefix', 'efforts-old/a.md', 'efforts', false],
		['a note above the folder', 'a.md', 'efforts', false],
		['a note in another folder', 'inputs/a.md', 'efforts', false],
		['with trailing slashes on the folder', 'efforts/a.md', 'efforts/', true],
	])('%s', (_case, path, folder, expected) => {
		expect(vaultPathIsInside(path, folder)).toBe(expected);
	});
});
