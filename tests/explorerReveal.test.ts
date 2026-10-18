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
		expect(folderRevealNotice('no-explorer', 'efforts')).toBe(
			'Herdr: the file explorer is not open. Open it, or turn on the core Files plugin, to reveal folders.',
		);
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

	it('prefers the foreground cwd when it differs and lies inside the vault', () => {
		expect(cwdRevealTarget({ ...base, foregroundCwd: `${VAULT}/inputs/corpora/silva` })).toBe(
			'inputs/corpora/silva',
		);
		expect(cwdRevealTarget({ ...base, foregroundCwd: base.cwd })).toBe('inputs/corpora');
	});

	it('falls back to the cwd when the foreground cwd is outside the vault or absent', () => {
		expect(cwdRevealTarget({ ...base, foregroundCwd: '/tmp/build' })).toBe('inputs/corpora');
		expect(cwdRevealTarget({ ...base, foregroundCwd: null })).toBe('inputs/corpora');
		expect(cwdRevealTarget({ ...base, cwd: '/tmp', foregroundCwd: '/tmp/x' })).toBeNull();
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

	/** The element the explorer's tree is, for the focus checks. */
	const EXPLORER_EL = { name: 'explorer tree' };

	function setup(
		options: {
			enabled?: boolean;
			/** What `revealInFolder` does to the workspace besides revealing. */
			onReveal?: 'take-active' | 'take-focus' | 'activate-note';
			/**
			 * When `setActiveLeaf` fires `active-leaf-change`: inside the call, as
			 * Obsidian has been seen to, or on a later microtask.
			 */
			dispatch?: 'sync' | 'async';
			/** Where the keyboard is before anything happens. */
			focusInExplorer?: boolean;
		} = {},
	) {
		const log: string[] = [];
		const doc = { activeElement: (options.focusInExplorer ? EXPLORER_EL : null) as unknown };
		let handler: ((leaf: FakeLeaf | null) => void) | null = null;
		let active: FakeLeaf | null = null;
		const leafOf = (type: string, state: Record<string, unknown>): FakeLeaf => {
			const leaf: FakeLeaf = {
				state: { type, state },
				view: { containerEl: { ownerDocument: doc } },
				getViewState: () => leaf.state,
			};
			return leaf;
		};
		const fire = (leaf: FakeLeaf | null): void => {
			if (options.dispatch === 'async') queueMicrotask(() => handler?.(leaf));
			else handler?.(leaf);
		};
		const noteLeaf = leafOf('markdown', { file: 'efforts/alpha/a.md' });
		const explorerLeaf = {
			...leafOf('file-explorer', {}),
			isDeferred: false,
			getRoot: () => ({}),
		};
		Object.assign(explorerLeaf.view, {
			containerEl: {
				ownerDocument: doc,
				contains: (el: unknown) => el === EXPLORER_EL,
				isShown: () => true,
			},
			revealInFolder: (folder: FakeFolder) => {
				log.push(`reveal:${folder.path}`);
				if (options.onReveal === 'take-active') {
					active = explorerLeaf;
					doc.activeElement = EXPLORER_EL;
					fire(explorerLeaf);
				} else if (options.onReveal === 'take-focus') {
					doc.activeElement = EXPLORER_EL;
				} else if (options.onReveal === 'activate-note') {
					active = noteLeaf;
					fire(noteLeaf);
				}
			},
		});
		const terminal = (paneId: string, endpointId = 'local'): FakeLeaf =>
			leafOf('herdr-terminal', { paneId, mode: 'control', endpointId });
		const panes: Record<string, { cwd: string; foregroundCwd?: string }> = {
			'w4:p1': { cwd: `${VAULT}/efforts/alpha` },
			'w4:p2': { cwd: `${VAULT}/inputs/corpora` },
			'w4:p3': { cwd: '/Users/lasse/code/herdr' },
			'w4:p4': { cwd: `${VAULT}/efforts`, foregroundCwd: `${VAULT}/efforts/beta` },
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
			getActiveViewOfType: () =>
				active ? { leaf: active, getViewType: () => active?.getViewState().type } : null,
			setActiveLeaf: (leaf: FakeLeaf, params: { focus?: boolean }) => {
				log.push(`setActiveLeaf:${String(leaf.state.state.paneId)} focus=${String(params.focus)}`);
				active = leaf;
				if (params.focus) doc.activeElement = null;
				fire(leaf);
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
				endpointId === 'local' ? { scope: { get: (paneId: string) => panes[paneId] } } : null,
			herdrVaultPath: () => VAULT,
		};
		registerCwdReveal(plugin as unknown as HerdrPlugin);
		const settle = async (): Promise<void> => {
			for (let tick = 0; tick < 10; tick++) await Promise.resolve();
		};
		const activate = async (leaf: FakeLeaf | null): Promise<void> => {
			active = leaf;
			handler?.(leaf);
			await settle();
		};
		return { log, activate, terminal, leafOf, noteLeaf };
	}

	it('reveals the folder of each herdr tab as it comes to the front', async () => {
		const { log, activate, terminal } = setup();
		await activate(terminal('w4:p1'));
		await activate(terminal('w4:p2'));
		expect(log).toEqual(['reveal:efforts/alpha', 'reveal:inputs/corpora']);
	});

	it('reveals the foreground folder when it differs from the cwd', async () => {
		const { log, activate, terminal } = setup();
		await activate(terminal('w4:p4'));
		expect(log).toEqual(['reveal:efforts/beta']);
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

	it.each<'sync' | 'async'>(['sync', 'async'])(
		'hands the active leaf back when the explorer took it, revealing once (%s dispatch)',
		async (dispatch) => {
			const { log, activate, terminal } = setup({ onReveal: 'take-active', dispatch });
			await activate(terminal('w4:p1'));
			expect(log).toEqual(['reveal:efforts/alpha', 'setActiveLeaf:w4:p1 focus=true']);
		},
	);

	it('hands the focus back when the explorer took only that', async () => {
		const { log, activate, terminal } = setup({ onReveal: 'take-focus', dispatch: 'async' });
		await activate(terminal('w4:p1'));
		expect(log).toEqual(['reveal:efforts/alpha', 'setActiveLeaf:w4:p1 focus=true']);
	});

	it('does not reveal the same tab twice when it comes back without another leaf between', async () => {
		const { log, activate, terminal } = setup({ dispatch: 'async' });
		const tab = terminal('w4:p1');
		await activate(tab);
		await activate(tab);
		expect(log).toEqual(['reveal:efforts/alpha']);
	});

	it('reveals a tab again once another leaf has been in front', async () => {
		const { log, activate, terminal, noteLeaf } = setup();
		const tab = terminal('w4:p1');
		await activate(tab);
		await activate(noteLeaf);
		await activate(tab);
		expect(log).toEqual(['reveal:efforts/alpha', 'reveal:efforts/alpha']);
	});

	it('leaves a note that took the active leaf alone (#78)', async () => {
		const { log, activate, terminal } = setup({ onReveal: 'activate-note' });
		await activate(terminal('w4:p1'));
		expect(log).toEqual(['reveal:efforts/alpha']);
	});

	it('leaves focus the explorer already had before the reveal where it is', async () => {
		const { log, activate, terminal } = setup({ onReveal: 'take-focus', focusInExplorer: true });
		await activate(terminal('w4:p1'));
		expect(log).toEqual(['reveal:efforts/alpha']);
	});
});
