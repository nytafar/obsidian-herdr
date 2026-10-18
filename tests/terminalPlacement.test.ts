/**
 * Where a new terminal view goes (issue #28). The decision is DOM-free on
 * purpose: `openTerminal` only turns it into `createLeafBySplit` or
 * `getLeaf('tab')`, so every branch is checked here instead of in Obsidian.
 */

import { describe, expect, it } from 'vitest';
import {
	chooseFollowPane,
	chooseNoteLeaf,
	decideOpenTarget,
	decidePlacement,
	FocusHold,
	FocusRecency,
	type FollowCandidate,
	type OpenTargetInput,
	type PlacementInput,
} from '../src/terminalPlacement';

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

function target(overrides: Partial<OpenTargetInput> = {}): OpenTargetInput {
	return { mode: 'per-agent', hasPaneLeaf: false, hasAnyLeaf: false, ...overrides };
}

describe('decideOpenTarget (issue #38)', () => {
	it('reveals this pane’s own terminal in either mode', () => {
		expect(decideOpenTarget(target({ hasPaneLeaf: true, hasAnyLeaf: true }))).toBe('existing');
		expect(
			decideOpenTarget(target({ mode: 'reuse', hasPaneLeaf: true, hasAnyLeaf: true })),
		).toBe('existing');
	});

	it('places a new leaf per agent when the setting says so', () => {
		expect(decideOpenTarget(target({ hasAnyLeaf: true }))).toBe('new');
		expect(decideOpenTarget(target())).toBe('new');
	});

	it('switches an open terminal to this pane under reuse', () => {
		expect(decideOpenTarget(target({ mode: 'reuse', hasAnyLeaf: true }))).toBe('switch');
	});

	it('still places the first terminal under reuse', () => {
		// Nothing to take over: reuse only ever holds one tab, it does not refuse
		// to open one.
		expect(decideOpenTarget(target({ mode: 'reuse' }))).toBe('new');
	});
});

/**
 * Which leaf the split is taken beside (issue #28).
 *
 * The leaves are strings: the choice only ever compares the file each leaf says
 * it shows against the active one, and never touches a leaf otherwise.
 */
describe('chooseNoteLeaf: the leaf the split is taken beside', () => {
	const NOTE = 'projects/herdr/notes.md';
	const note = { leaf: 'note', file: NOTE };
	const terminal = { leaf: 'terminal', file: null };

	it('takes the most recent leaf when that is the note', () => {
		expect(
			chooseNoteLeaf({ activeFilePath: NOTE, mostRecent: note, rootLeaves: [note, terminal] }),
		).toBe('note');
	});

	it('finds the note when a terminal is the most recent leaf', () => {
		// Attaching in control mode focuses the renderer, and that activates the
		// terminal's leaf, so `getMostRecentLeaf()` names the terminal from the
		// first open onwards while `getActiveFile()` still names the note.
		// Asking only the most recent leaf stopped splitting at that point.
		expect(
			chooseNoteLeaf({
				activeFilePath: NOTE,
				mostRecent: terminal,
				rootLeaves: [note, terminal],
			}),
		).toBe('note');
	});

	it('prefers the most recent leaf over another showing the same note', () => {
		// A pop-out is not among the main area's leaves, so the recent leaf has to
		// win on its own account rather than by being found in the list.
		const popout = { leaf: 'popout', file: NOTE };
		expect(chooseNoteLeaf({ activeFilePath: NOTE, mostRecent: popout, rootLeaves: [note] })).toBe(
			'popout',
		);
	});

	it('says nothing when no leaf shows the note, or there is no note', () => {
		expect(
			chooseNoteLeaf({ activeFilePath: NOTE, mostRecent: terminal, rootLeaves: [terminal] }),
		).toBeNull();
		expect(chooseNoteLeaf({ activeFilePath: null, mostRecent: note, rootLeaves: [note] })).toBeNull();
	});
});

describe('chooseFollowPane (issue #78)', () => {
	const NOTE = 'inputs/corpora/silva-cacao/notes/harvest.md';

	function candidate(paneId: string, folder: string, overrides: Partial<FollowCandidate> = {}): FollowCandidate {
		return { paneId, cwd: folder ? `${VAULT}/${folder}` : VAULT, pinned: false, focusRank: 0, ...overrides };
	}

	function choose(panes: FollowCandidate[], notePath = NOTE, minDepth = 2, vaultPath = VAULT) {
		return chooseFollowPane({ notePath, vaultPath, minDepth, panes });
	}

	it('matches an agent whose folder holds the note', () => {
		expect(choose([candidate('a', 'inputs/corpora/silva-cacao')])).toBe('a');
		expect(choose([candidate('a', 'inputs/corpora/silva-cacao/notes')])).toBe('a');
	});

	it('skips agents shallower than the minimum depth, and the root always', () => {
		// The issue's own example, at the default depth of 2.
		expect(choose([candidate('root', '')])).toBeNull();
		expect(choose([candidate('top', 'inputs')])).toBeNull();
		expect(choose([candidate('two', 'inputs/corpora')])).toBe('two');
		expect(choose([candidate('two', 'inputs/corpora')], NOTE, 3)).toBeNull();
		expect(choose([candidate('top', 'inputs')], NOTE, 1)).toBe('top');
		// A depth of 0 would hand every note to an agent at the root; it is read as 1.
		expect(choose([candidate('root', '')], NOTE, 0)).toBeNull();
	});

	it('does nothing for a note above the agent, in another folder or in a sibling', () => {
		const pane = candidate('a', 'inputs/corpora/silva-cacao');
		expect(choose([pane], 'inputs/corpora/index.md')).toBeNull();
		expect(choose([pane], 'efforts/x/y.md')).toBeNull();
		expect(choose([pane], 'inputs/corpora/silva-cacao-old/a.md')).toBeNull();
	});

	it('ignores agents outside the vault and in a sibling of it', () => {
		const outside = { ...candidate('out', ''), cwd: '/Users/lasse/code/herdr' };
		const sibling = { ...candidate('old', ''), cwd: `${VAULT}-old/inputs/corpora/silva-cacao` };
		expect(choose([outside, sibling])).toBeNull();
	});

	it('compares against the vault as herdr sees it, the remote one included', () => {
		const remote = { ...candidate('r', ''), cwd: '/home/lasse/hvelv/inputs/corpora/silva-cacao' };
		expect(choose([remote], NOTE, 2, '/home/lasse/hvelv/')).toBe('r');
		expect(choose([remote])).toBeNull();
		expect(choose([candidate('a', 'inputs/corpora')], NOTE, 2, '')).toBeNull();
	});

	it('gives the note to the deepest matching folder', () => {
		const panes = [
			candidate('shallow', 'inputs/corpora', { pinned: true, focusRank: 9 }),
			candidate('deep', 'inputs/corpora/silva-cacao'),
			candidate('other', 'inputs/corpora/elsewhere'),
		];
		expect(choose(panes)).toBe('deep');
	});

	it('breaks a tie of depth by pin first, then by the most recent herdr focus', () => {
		const folder = 'inputs/corpora/silva-cacao';
		expect(
			choose([
				candidate('recent', folder, { focusRank: 5 }),
				candidate('pinned', folder, { pinned: true, focusRank: 1 }),
			]),
		).toBe('pinned');
		expect(
			choose([
				candidate('older', folder, { focusRank: 2 }),
				candidate('recent', folder, { focusRank: 7 }),
			]),
		).toBe('recent');
		expect(
			choose([
				candidate('pinned-old', folder, { pinned: true, focusRank: 1 }),
				candidate('pinned-new', folder, { pinned: true, focusRank: 3 }),
			]),
		).toBe('pinned-new');
	});

	it('keeps herdr’s pane order when nothing else separates two panes', () => {
		const folder = 'inputs/corpora/silva-cacao';
		expect(choose([candidate('first', folder), candidate('second', folder)])).toBe('first');
	});
});

describe('FocusRecency', () => {
	it('ranks panes by when herdr last focused them, the focused one first', () => {
		const recency = new FocusRecency();
		recency.observe({ paneId: 'a', focused: true }, false);
		recency.observe({ paneId: 'b', focused: true }, false);
		recency.observe({ paneId: 'a', focused: false }, true);
		const a = recency.rank({ paneId: 'a', focused: false });
		const b = recency.rank({ paneId: 'b', focused: false });
		expect(b).toBeGreaterThan(a);
		expect(recency.rank({ paneId: 'never', focused: false })).toBe(0);
		// Focused before the plugin connected, so never seen to become focused.
		expect(recency.rank({ paneId: 'c', focused: true })).toBeGreaterThan(b);
	});

	it('counts a pane once per focus, not per update that keeps it focused', () => {
		const recency = new FocusRecency();
		recency.observe({ paneId: 'a', focused: true }, false);
		recency.observe({ paneId: 'b', focused: true }, false);
		// Another change on `a` while it stays unfocused, and on `b` while focused.
		recency.observe({ paneId: 'a', focused: false }, false);
		recency.observe({ paneId: 'b', focused: true }, true);
		expect(recency.rank({ paneId: 'b', focused: false })).toBeGreaterThan(
			recency.rank({ paneId: 'a', focused: false }),
		);
	});

	it('forgets a removed pane and everything on reset', () => {
		const recency = new FocusRecency();
		recency.observe({ paneId: 'a', focused: true }, false);
		recency.observe({ paneId: 'b', focused: true }, false);
		recency.forget('a');
		expect(recency.rank({ paneId: 'a', focused: false })).toBe(0);
		recency.reset();
		expect(recency.rank({ paneId: 'b', focused: false })).toBe(0);
	});
});

describe('FocusHold', () => {
	it('lets an ordinary leaf focus, and a held one only once it is active', () => {
		const hold = new FocusHold<object>();
		const note = {};
		const quiet = {};
		const other = {};
		expect(hold.mayFocus(other, note)).toBe(true);
		hold.hold(quiet);
		expect(hold.mayFocus(quiet, note)).toBe(false);
		expect(hold.mayFocus(quiet, null)).toBe(false);
		// The reader came to it: from now on it is an ordinary terminal.
		expect(hold.mayFocus(quiet, quiet)).toBe(true);
		expect(hold.mayFocus(quiet, note)).toBe(true);
	});

	it('ends the hold when the leaf is opened the ordinary way', () => {
		const hold = new FocusHold<object>();
		const note = {};
		const quiet = {};
		hold.hold(quiet);
		hold.release(quiet);
		expect(hold.mayFocus(quiet, note)).toBe(true);
	});
});
