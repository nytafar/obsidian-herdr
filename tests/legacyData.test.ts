/**
 * Settings from the old plugin id `herdr`: adopted only when they are this
 * plugin's, read and never written.
 */

import { describe, expect, it } from 'vitest';
import { isOurManifest, looksLikeOurData, readLegacyData, retireLegacyPlugin, type LegacyDataReader } from '../src/legacyData';

const OLD = '.config-dir/plugins/herdr';

const OUR_MANIFEST = {
	id: 'herdr',
	name: 'Herdr',
	version: '0.5.0',
	author: 'Lasse',
	authorUrl: 'https://github.com/nytafar',
};

/** xicum/herdr-obsidian's shape: same id and name, someone else. */
const FOREIGN_MANIFEST = {
	id: 'herdr',
	name: 'Herdr',
	version: '1.0.0',
	author: 'xicum',
	authorUrl: 'https://github.com/xicum',
};

const OUR_DATA = {
	runtimes: [{ id: 'local', kind: 'herdr', target: 'local' }],
	activeRuntime: 'local',
	defaultView: 'native',
	terminalEngine: 'ghostty-web',
};

function fakeVault(files: Record<string, unknown>): LegacyDataReader {
	// Read-only by construction: the migration has no way to write.
	const reader = {
		exists: (path: string) => Promise.resolve(path in files),
		read: (path: string) => {
			const value = files[path];
			if (value === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
			return Promise.resolve(typeof value === 'string' ? value : JSON.stringify(value));
		},
	};
	return reader;
}

describe('readLegacyData', () => {
	it('adopts our data beside our manifest', async () => {
		const vault = fakeVault({ [`${OLD}/data.json`]: OUR_DATA, [`${OLD}/manifest.json`]: OUR_MANIFEST });
		expect(await readLegacyData(vault, '.config-dir')).toEqual(OUR_DATA);
	});

	it('adopts it beside the dev symlinked manifest, which already says gjetr', async () => {
		const vault = fakeVault({
			[`${OLD}/data.json`]: { panesPerTab: 2 },
			[`${OLD}/manifest.json`]: { ...OUR_MANIFEST, id: 'gjetr', name: 'Gjetr' },
		});
		expect(await readLegacyData(vault, '.config-dir')).toEqual({ panesPerTab: 2 });
	});

	it('adopts our data with no manifest only on our own keys', async () => {
		expect(await readLegacyData(fakeVault({ [`${OLD}/data.json`]: OUR_DATA }), '.config-dir')).toEqual(OUR_DATA);
		expect(
			await readLegacyData(fakeVault({ [`${OLD}/data.json`]: { socketPath: '/x', herdrBinary: 'herdr' } }), '.config-dir'),
		).toBeNull();
	});

	it('never adopts another herdr plugin’s data, even when it carries our keys', async () => {
		const vault = fakeVault({ [`${OLD}/data.json`]: OUR_DATA, [`${OLD}/manifest.json`]: FOREIGN_MANIFEST });
		expect(await readLegacyData(vault, '.config-dir')).toBeNull();
	});

	it('ignores a missing folder, broken JSON and a non-object', async () => {
		expect(await readLegacyData(fakeVault({}), '.config-dir')).toBeNull();
		expect(await readLegacyData(fakeVault({ [`${OLD}/data.json`]: '{not json' }), '.config-dir')).toBeNull();
		expect(
			await readLegacyData(fakeVault({ [`${OLD}/data.json`]: '[1]', [`${OLD}/manifest.json`]: OUR_MANIFEST }), '.config-dir'),
		).toBeNull();
		expect(
			await readLegacyData(fakeVault({ [`${OLD}/data.json`]: OUR_DATA, [`${OLD}/manifest.json`]: '{broken' }), '.config-dir'),
		).toBeNull();
	});

	it('reads under the vault’s own config dir', async () => {
		const vault = fakeVault({ '.config-x/plugins/herdr/data.json': OUR_DATA });
		expect(await readLegacyData(vault, '.config-x')).toEqual(OUR_DATA);
		expect(await readLegacyData(vault, '.config-dir')).toBeNull();
	});
});

describe('isOurManifest and looksLikeOurData', () => {
	it('tell ours from the others', () => {
		expect(isOurManifest(OUR_MANIFEST)).toBe(true);
		expect(isOurManifest(FOREIGN_MANIFEST)).toBe(false);
		expect(isOurManifest({ ...OUR_MANIFEST, id: 'something-else' })).toBe(false);
		expect(isOurManifest({ id: 'herdr', author: 'Daniel Steinberger' })).toBe(false);
		expect(looksLikeOurData(OUR_DATA)).toBe(true);
		expect(looksLikeOurData({ runtimes: [] })).toBe(false);
		expect(looksLikeOurData(null)).toBe(false);
	});
});

describe('retireLegacyPlugin', () => {
	const ours = { id: 'herdr', author: 'Lasse', authorUrl: 'https://github.com/nytafar' };
	const xicum = { id: 'herdr', author: 'xicum', authorUrl: 'https://github.com/xicum' };
	function manager(enabled: boolean, manifest: unknown) {
		const disabled: string[] = [];
		return {
			disabled,
			enabledPlugins: new Set(enabled ? ['herdr'] : []),
			manifests: { herdr: manifest },
			disablePluginAndSave: async (id: string) => {
				disabled.push(id);
			},
		};
	}

	it('turns off our old install when it is still enabled', async () => {
		const m = manager(true, ours);
		expect(await retireLegacyPlugin(m)).toBe(true);
		expect(m.disabled).toEqual(['herdr']);
	});

	it('leaves another plugin with the herdr id alone', async () => {
		const m = manager(true, xicum);
		expect(await retireLegacyPlugin(m)).toBe(false);
		expect(m.disabled).toEqual([]);
	});

	it('does nothing when the old install is not enabled, or there is no plugin manager', async () => {
		const m = manager(false, ours);
		expect(await retireLegacyPlugin(m)).toBe(false);
		expect(await retireLegacyPlugin(undefined)).toBe(false);
		expect(m.disabled).toEqual([]);
	});
});
