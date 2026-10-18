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
import type HerdrPlugin from '../src/main';
import {
	cwdRevealTarget,
	folderRevealNotice,
	registerCwdReveal,
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

describe('cwdRevealTarget', () => {
	const VAULT = '/Users/lasse/Vaults/hvelv';
	const base = { enabled: true, paneId: 'w4:p3', cwd: `${VAULT}/inputs/corpora`, vaultPath: VAULT };

	it('is the pane folder inside the vault, the root as the empty path', () => {
		expect(cwdRevealTarget(base)).toBe('inputs/corpora');
		expect(cwdRevealTarget({ ...base, cwd: `${VAULT}/` })).toBe('');
	});

	it('follows the vault as herdr sees it under a remote profile', () => {
		expect(
			cwdRevealTarget({ ...base, cwd: '/home/lasse/hvelv/efforts', vaultPath: '/home/lasse/hvelv' }),
		).toBe('efforts');
	});

	it.each<[string, Partial<Parameters<typeof cwdRevealTarget>[0]>]>([
		['the setting is off', { enabled: false }],
		['the leaf is no herdr tab', { paneId: null }],
		['the connection does not hold the pane', { cwd: null }],
		['the cwd is outside the vault', { cwd: '/Users/lasse/code/herdr' }],
		['the cwd is a sibling of the vault', { cwd: `${VAULT}-old` }],
		['the vault path is unknown', { vaultPath: '' }],
	])('is null when %s', (_case, change) => {
		expect(cwdRevealTarget({ ...base, ...change })).toBeNull();
	});
});

describe('registerCwdReveal', () => {
	const VAULT = '/Users/lasse/Vaults/hvelv';

	interface FakeLeaf {
		state: { type: string; state: Record<string, unknown> };
		view: { containerEl: { ownerDocument: { activeElement: unknown } } };
		getViewState(): { type: string; state: Record<string, unknown> };
	}

	function setup(options: { enabled?: boolean; stealActive?: boolean } = {}) {
		const log: string[] = [];
		const doc = { activeElement: null as unknown };
		let handler: ((leaf: FakeLeaf | null) => void) | null = null;
		let active: unknown = null;
		const explorerLeaf = {
			isDeferred: false,
			getRoot: () => ({}),
			view: {
				containerEl: { contains: () => false, isShown: () => true },
				revealInFolder: (folder: FakeFolder) => {
					log.push(`reveal:${folder.path}`);
					if (options.stealActive) active = explorerLeaf;
				},
			},
		};
		const leafOf = (type: string, state: Record<string, unknown>): FakeLeaf => {
			const leaf: FakeLeaf = {
				state: { type, state },
				view: { containerEl: { ownerDocument: doc } },
				getViewState: () => leaf.state,
			};
			return leaf;
		};
		const terminal = (paneId: string, endpointId = 'local'): FakeLeaf =>
			leafOf('herdr-terminal', { paneId, mode: 'control', endpointId });
		const cwds: Record<string, string> = {
			'w4:p1': `${VAULT}/efforts/alpha`,
			'w4:p2': `${VAULT}/inputs/corpora`,
			'w4:p3': '/Users/lasse/code/herdr',
		};
		const workspace = {
			leftSplit: { collapsed: false },
			rightSplit: { collapsed: false },
			on: (name: string, callback: (leaf: FakeLeaf | null) => void) => {
				expect(name).toBe('active-leaf-change');
				handler = callback;
				return {};
			},
			getLeavesOfType: () => [explorerLeaf],
			revealLeaf: () => Promise.resolve(),
			getActiveViewOfType: () => ({ leaf: active }),
			setActiveLeaf: (leaf: FakeLeaf) => {
				log.push(`setActiveLeaf:${String(leaf.state.state.paneId)}`);
				active = leaf;
				// Obsidian fires the event from inside setActiveLeaf.
				handler?.(leaf);
			},
		};
		const plugin = {
			app: {
				workspace,
				vault: {
					getRoot: () => ({ path: '/' }),
					getFolderByPath: (path: string) => ({ path }),
				},
			},
			settings: { revealCwdInExplorer: options.enabled ?? true },
			registerEvent: () => undefined,
			endpointSession: (endpointId: string) =>
				endpointId === 'local'
					? {
							scope: {
								get: (paneId: string) => (cwds[paneId] ? { cwd: cwds[paneId] } : undefined),
							},
						}
					: null,
			herdrVaultPath: () => VAULT,
		};
		registerCwdReveal(plugin as unknown as HerdrPlugin);
		const activate = async (leaf: FakeLeaf | null): Promise<void> => {
			active = leaf;
			handler?.(leaf);
			for (let tick = 0; tick < 5; tick++) await Promise.resolve();
		};
		return { log, activate, terminal, leafOf };
	}

	it('reveals the folder of each herdr tab as it comes to the front', async () => {
		const { log, activate, terminal } = setup();
		await activate(terminal('w4:p1'));
		await activate(terminal('w4:p2'));
		expect(log).toEqual(['reveal:efforts/alpha', 'reveal:inputs/corpora']);
	});

	it('does nothing for a note, a pane outside the vault, another herdr, or no leaf', async () => {
		const { log, activate, terminal, leafOf } = setup();
		await activate(leafOf('markdown', { file: 'efforts/alpha/a.md' }));
		await activate(terminal('w4:p3'));
		await activate(terminal('w4:p1', 'ssh:lasse@xl:/home/lasse/.config/herdr/herdr.sock'));
		await activate(null);
		expect(log).toEqual([]);
	});

	it('does nothing with the setting off', async () => {
		const { log, activate, terminal } = setup({ enabled: false });
		await activate(terminal('w4:p1'));
		expect(log).toEqual([]);
	});

	it('hands the active leaf back when the explorer took it, without revealing twice', async () => {
		const { log, activate, terminal } = setup({ stealActive: true });
		await activate(terminal('w4:p1'));
		expect(log).toEqual(['reveal:efforts/alpha', 'setActiveLeaf:w4:p1']);
	});
});
