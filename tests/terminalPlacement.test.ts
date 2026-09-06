/**
 * Where a new terminal view goes (issue #28). The decision is DOM-free on
 * purpose: `openTerminal` only turns it into `createLeafBySplit` or
 * `getLeaf('tab')`, so every branch is checked here instead of in Obsidian.
 */

import { describe, expect, it } from 'vitest';
import { decidePlacement, type PlacementInput } from '../src/terminalPlacement';

const VAULT = '/Users/lasse/Vaults/hvelv';

function input(overrides: Partial<PlacementInput> = {}): PlacementInput {
	return {
		placement: 'split-right',
		paneCwd: `${VAULT}/projects/herdr`,
		activeFilePath: 'projects/herdr/notes.md',
		vaultPath: VAULT,
		...overrides,
	};
}

describe('decidePlacement (issue #28)', () => {
	it('splits to the right of a note inside the agent’s cwd', () => {
		expect(decidePlacement(input())).toEqual({ kind: 'split', before: false });
	});

	it('splits to the left when the setting says so', () => {
		expect(decidePlacement(input({ placement: 'split-left' }))).toEqual({
			kind: 'split',
			before: true,
		});
	});

	it('always takes a tab when the setting says so', () => {
		expect(decidePlacement(input({ placement: 'tab' }))).toEqual({ kind: 'tab' });
		expect(decidePlacement(input({ placement: 'tab', activeFilePath: null }))).toEqual({
			kind: 'tab',
		});
	});

	it('takes a tab when no note is open', () => {
		expect(decidePlacement(input({ activeFilePath: null }))).toEqual({ kind: 'tab' });
		expect(decidePlacement(input({ activeFilePath: '   ' }))).toEqual({ kind: 'tab' });
	});

	it('takes a tab for a note outside the agent’s cwd', () => {
		expect(decidePlacement(input({ activeFilePath: 'journal/2026-09-06.md' }))).toEqual({
			kind: 'tab',
		});
	});

	it('splits for the vault root as cwd, which contains every note', () => {
		expect(decidePlacement(input({ paneCwd: VAULT }))).toEqual({ kind: 'split', before: false });
		expect(decidePlacement(input({ paneCwd: `${VAULT}/` }))).toEqual({
			kind: 'split',
			before: false,
		});
	});

	it('takes a tab for a cwd outside the vault', () => {
		expect(decidePlacement(input({ paneCwd: '/Users/lasse/code/herdr' }))).toEqual({
			kind: 'tab',
		});
	});

	it('is not fooled by a cwd that is only a string prefix of the note’s folder', () => {
		expect(decidePlacement(input({ paneCwd: `${VAULT}/projects/herd` }))).toEqual({
			kind: 'tab',
		});
	});

	it('takes a tab when the pane has no cwd or the vault path is unknown', () => {
		expect(decidePlacement(input({ paneCwd: '' }))).toEqual({ kind: 'tab' });
		expect(decidePlacement(input({ vaultPath: '' }))).toEqual({ kind: 'tab' });
	});

	it('compares against the remote vault path under a remote profile', () => {
		// `vaultPath` is whatever `herdrVaultPath()` returns, so a remote pane cwd
		// only ever meets a remote root here.
		const remote = input({
			vaultPath: '/home/lasse/hvelv',
			paneCwd: '/home/lasse/hvelv/projects/herdr',
		});
		expect(decidePlacement(remote)).toEqual({ kind: 'split', before: false });
		expect(decidePlacement({ ...remote, paneCwd: `${VAULT}/projects/herdr` })).toEqual({
			kind: 'tab',
		});
	});

	it('joins vault and note path without doubling separators', () => {
		expect(decidePlacement(input({ vaultPath: `${VAULT}/` }))).toEqual({
			kind: 'split',
			before: false,
		});
	});
});
