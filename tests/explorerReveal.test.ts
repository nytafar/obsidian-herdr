/**
 * Revealing a vault folder in the file explorer (issues #79, #116). The
 * explorer is undocumented, so what is held here is the contract around it:
 * which folder is looked up (the root by `getRoot`), that the explicit reveal
 * opens the explorer's sidebar first and the ambient one never does, and that
 * a missing folder, a missing explorer or an explorer without
 * `revealInFolder` each end in an outcome rather than an exception.
 */

import { describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import {
	folderRevealNotice,
	revealingExplorer,
	revealVaultFolder,
	type FolderRevealOutcome,
} from '../src/explorerReveal';

interface FakeFolder {
	path: string;
}

interface World {
	app: App;
	log: string[];
	sidebar: { collapsed: boolean };
}

function world(
	options: {
		folders?: string[];
		explorer?: 'present' | 'absent' | 'no-method' | 'deferred';
		collapsed?: boolean;
		shown?: boolean;
	} = {},
): World {
	const log: string[] = [];
	const folders = new Map<string, FakeFolder>(
		(options.folders ?? []).map((path) => [path, { path }]),
	);
	const root: FakeFolder = { path: '/' };
	const sidebar = { collapsed: options.collapsed ?? false };
	const explorer = options.explorer ?? 'present';
	const view: Record<string, unknown> = {
		containerEl: { isShown: () => options.shown ?? true },
	};
	if (explorer !== 'no-method') {
		view.revealInFolder = (folder: FakeFolder) => log.push(`revealInFolder:${folder.path}`);
	}
	const leaf = {
		view,
		isDeferred: explorer === 'deferred',
		getRoot: () => sidebar,
	};
	const app = {
		vault: {
			getRoot: () => root,
			getFolderByPath: (path: string) => folders.get(path) ?? null,
		},
		workspace: {
			leftSplit: sidebar,
			rightSplit: { collapsed: false },
			getLeavesOfType: (type: string) => {
				log.push(`getLeavesOfType:${type}`);
				return explorer === 'absent' ? [] : [leaf];
			},
			revealLeaf: async () => {
				log.push('revealLeaf');
				sidebar.collapsed = false;
				leaf.isDeferred = false;
				await Promise.resolve();
			},
		},
	};
	return { app: app as unknown as App, log, sidebar };
}

describe('revealVaultFolder, the explicit reveal', () => {
	it('opens the explorer, then reveals the folder', async () => {
		const w = world({ folders: ['inputs/corpora'], collapsed: true });
		const outcome = await revealVaultFolder(w.app, 'inputs/corpora', { showExplorer: true });
		expect(outcome).toBe('revealed');
		expect(w.log).toEqual([
			'getLeavesOfType:file-explorer',
			'revealLeaf',
			'revealInFolder:inputs/corpora',
		]);
		expect(w.sidebar.collapsed).toBe(false);
	});

	it('reveals the vault root through getRoot', async () => {
		const w = world();
		expect(await revealVaultFolder(w.app, '', { showExplorer: true })).toBe('revealed');
		expect(w.log.at(-1)).toBe('revealInFolder:/');
	});

	it('loads a deferred explorer before asking it', async () => {
		const w = world({ folders: ['efforts'], explorer: 'deferred' });
		expect(await revealVaultFolder(w.app, 'efforts', { showExplorer: true })).toBe('revealed');
	});

	it.each<[string, Parameters<typeof world>[0], FolderRevealOutcome]>([
		['a folder the vault does not have', { folders: [] }, 'no-folder'],
		['no explorer leaf', { folders: ['efforts'], explorer: 'absent' }, 'no-explorer'],
		['an explorer without revealInFolder', { folders: ['efforts'], explorer: 'no-method' }, 'unsupported'],
	])('ends in an outcome for %s', async (_case, options, expected) => {
		const w = world(options);
		expect(await revealVaultFolder(w.app, 'efforts', { showExplorer: true })).toBe(expected);
		expect(w.log.some((line) => line.startsWith('revealInFolder'))).toBe(false);
	});
});

describe('revealVaultFolder, the ambient reveal', () => {
	it('reveals into an explorer already on screen, without revealing its leaf', async () => {
		const w = world({ folders: ['efforts'] });
		expect(await revealVaultFolder(w.app, 'efforts', { showExplorer: false })).toBe('revealed');
		expect(w.log).not.toContain('revealLeaf');
	});

	it.each<[string, Parameters<typeof world>[0]]>([
		['in a collapsed sidebar', { folders: ['efforts'], collapsed: true }],
		['in a background tab', { folders: ['efforts'], shown: false }],
		['not loaded yet', { folders: ['efforts'], explorer: 'deferred' }],
	])('leaves an explorer %s alone', async (_case, options) => {
		const w = world(options);
		expect(await revealVaultFolder(w.app, 'efforts', { showExplorer: false })).toBe(
			'explorer-hidden',
		);
		expect(w.log).toEqual(['getLeavesOfType:file-explorer']);
	});
});

describe('revealingExplorer', () => {
	it('accepts a view with the method and nothing else', () => {
		const view = { revealInFolder: () => undefined };
		expect(revealingExplorer(view)).toBe(view);
		expect(revealingExplorer({ revealInFolder: 'no' })).toBeNull();
		expect(revealingExplorer({})).toBeNull();
		expect(revealingExplorer(null)).toBeNull();
		expect(revealingExplorer(undefined)).toBeNull();
	});
});

describe('folderRevealNotice', () => {
	it('says nothing when the folder was revealed, and why not otherwise', () => {
		expect(folderRevealNotice('revealed', 'efforts')).toBeNull();
		expect(folderRevealNotice('explorer-hidden', 'efforts')).toBeNull();
		expect(folderRevealNotice('no-folder', 'inputs/corpora')).toBe(
			'Herdr: the folder "inputs/corpora" is not in this vault.',
		);
		expect(folderRevealNotice('no-explorer', 'efforts')).toMatch(/file explorer is not open/);
		expect(folderRevealNotice('unsupported', 'efforts')).toMatch(/cannot reveal folders/);
	});
});
