/**
 * The shared path helpers. Their callers — `folderName`, `relativeCwd`,
 * `attachablePane`, `resolveWorkspace` — are covered by their own suites; what
 * is pinned here is the contract those callers rely on, in particular what the
 * root and an empty path answer.
 */

import { describe, expect, it } from 'vitest';
import { lastPathSegment, trimTrailingSlashes } from '../src/paths';

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
