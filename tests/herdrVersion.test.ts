import { describe, expect, it } from 'vitest';
import { compareHerdrVersions, herdrVersionAtLeast, parseHerdrVersion } from '../src/herdr/version';

describe('parseHerdrVersion', () => {
	it('reads the forms herdr and its tooling print', () => {
		expect(parseHerdrVersion('0.9.5')).toEqual([0, 9, 5]);
		expect(parseHerdrVersion('v0.9.5')).toEqual([0, 9, 5]);
		expect(parseHerdrVersion('herdr 0.9.5')).toEqual([0, 9, 5]);
		expect(parseHerdrVersion('0.9.4-preview')).toEqual([0, 9, 4]);
		expect(parseHerdrVersion('1.2')).toEqual([1, 2, 0]);
	});

	it('is null when there is no version to read', () => {
		expect(parseHerdrVersion('unknown')).toBeNull();
		expect(parseHerdrVersion('')).toBeNull();
		expect(parseHerdrVersion(null)).toBeNull();
		expect(parseHerdrVersion(undefined)).toBeNull();
	});
});

describe('compareHerdrVersions', () => {
	it('orders numerically, not lexically', () => {
		expect(compareHerdrVersions([0, 10, 0], [0, 9, 5])).toBeGreaterThan(0);
		expect(compareHerdrVersions([0, 9, 2], [0, 9, 10])).toBeLessThan(0);
		expect(compareHerdrVersions([1, 0, 0], [0, 99, 99])).toBeGreaterThan(0);
		expect(compareHerdrVersions([0, 9, 5], [0, 9, 5])).toBe(0);
	});
});

describe('herdrVersionAtLeast', () => {
	it('gates on the minimum release', () => {
		expect(herdrVersionAtLeast('0.9.5', '0.9.2')).toBe(true);
		expect(herdrVersionAtLeast('0.9.2', '0.9.2')).toBe(true);
		expect(herdrVersionAtLeast('0.9.0', '0.9.2')).toBe(false);
		expect(herdrVersionAtLeast('0.8.2', '0.9.0')).toBe(false);
	});

	it('counts a preview as the release it names', () => {
		expect(herdrVersionAtLeast('0.9.4-preview', '0.9.4')).toBe(true);
	});

	it('keeps a gated feature off while the version is unknown', () => {
		expect(herdrVersionAtLeast(null, '0.9.0')).toBe(false);
		expect(herdrVersionAtLeast('unknown', '0.9.0')).toBe(false);
	});
});
