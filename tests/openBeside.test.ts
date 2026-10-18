/**
 * Opening a link beside a herdr panel (issue #114, `src/openBeside.ts`).
 *
 * The choice itself, `chooseLeafBeside`, is pure and asserted on plain slots;
 * `leafBeside` and `openLinkBeside` run against the fake workspace in
 * `tests/fixtures/workspace.ts`, which is where the split neighbour, a pinned
 * tab, another panel and a pop-out are laid out by hand.
 */

import { describe, expect, it } from 'vitest';
import type { App, Workspace, WorkspaceLeaf } from 'obsidian';
import { chooseLeafBeside, leafBeside, openLinkBeside, type BesideSlot } from '../src/openBeside';
import {
	FakeWorkspace,
	fakeMetadataCache,
	note,
	panelState,
	type FakeLeaf,
} from './fixtures/workspace';

function slot(
	leaf: string,
	group: string,
	extra: Partial<BesideSlot<string>> = {},
): BesideSlot<string> {
	return { leaf, group, file: null, usable: true, front: true, ...extra };
}

describe('chooseLeafBeside', () => {
	it('takes the front tab of the group next to the panel', () => {
		const choice = chooseLeafBeside({
			panel: 'panel',
			file: 'b.md',
			slots: [slot('panel', 'A', { usable: false }), slot('note', 'B', { file: 'a.md' })],
		});
		expect(choice).toEqual({ kind: 'neighbour', leaf: 'note' });
	});

	it('reuses a leaf already showing the file, even a pinned background tab', () => {
		const choice = chooseLeafBeside({
			panel: 'panel',
			file: 'b.md',
			slots: [
				slot('panel', 'A', { usable: false }),
				slot('front', 'B', { file: 'a.md' }),
				slot('behind', 'B', { file: 'b.md', front: false, usable: false }),
			],
		});
		expect(choice).toEqual({ kind: 'existing', leaf: 'behind' });
	});

	it('never chooses anything in the panel’s own group, the file included', () => {
		const choice = chooseLeafBeside({
			panel: 'panel',
			file: 'b.md',
			slots: [slot('panel', 'A', { usable: false }), slot('tab', 'A', { file: 'b.md', front: false })],
		});
		expect(choice).toEqual({ kind: 'split' });
	});

	it('tries the nearest group first, after the panel before before it', () => {
		const choice = chooseLeafBeside({
			panel: 'panel',
			file: null,
			slots: [
				slot('far', 'A'),
				slot('before', 'B'),
				slot('panel', 'C', { usable: false }),
				slot('after', 'D'),
			],
		});
		expect(choice).toEqual({ kind: 'neighbour', leaf: 'after' });
	});

	it('passes over a group whose front tab is another panel or pinned', () => {
		const choice = chooseLeafBeside({
			panel: 'panel',
			file: null,
			slots: [
				slot('panel', 'A', { usable: false }),
				slot('other panel', 'B', { usable: false }),
				slot('usable but behind', 'B', { front: false }),
				slot('note', 'C'),
			],
		});
		expect(choice).toEqual({ kind: 'neighbour', leaf: 'note' });
	});

	it('splits when the panel is alone', () => {
		expect(
			chooseLeafBeside({ panel: 'panel', file: 'a.md', slots: [slot('panel', 'A')] }),
		).toEqual({ kind: 'split' });
	});
});

/** A panel split to the left of a note, the layout `terminalPlacement` makes. */
function besideANote(): { workspace: FakeWorkspace; panel: FakeLeaf; noteLeaf: FakeLeaf } {
	const workspace = new FakeWorkspace();
	const panel = workspace.add('panel', {}, panelState());
	const noteLeaf = workspace.add('note', {}, note('Daily.md'));
	return { workspace, panel, noteLeaf };
}

function asWorkspace(workspace: FakeWorkspace): Workspace {
	return workspace as unknown as Workspace;
}

function asLeaf(leaf: FakeLeaf): WorkspaceLeaf {
	return leaf as unknown as WorkspaceLeaf;
}

describe('leafBeside', () => {
	it('returns the split neighbour, not the panel', () => {
		const { workspace, panel, noteLeaf } = besideANote();
		expect(leafBeside(asWorkspace(workspace), asLeaf(panel), 'Other.md')).toBe(noteLeaf);
	});

	it('splits the panel to the right when nothing sits beside it', () => {
		const workspace = new FakeWorkspace();
		const group = {};
		const panel = workspace.add('panel', group, panelState(), { front: true });
		workspace.add('hidden note', group, note('Daily.md'));

		const leaf = leafBeside(asWorkspace(workspace), asLeaf(panel), 'Daily.md');

		expect(workspace.createLeafBySplit).toHaveBeenCalledWith(panel, 'vertical', false);
		expect(leaf).toBe(workspace.splits[0]);
	});

	it('does not navigate another panel, a pinned note or a view that is not navigable', () => {
		const workspace = new FakeWorkspace();
		const panel = workspace.add('panel', {}, panelState());
		workspace.add('other panel', {}, panelState());
		workspace.add('pinned', {}, note('Pinned.md', { pinned: true }));
		workspace.add('graph', {}, { type: 'graph' }, { navigation: false });

		leafBeside(asWorkspace(workspace), asLeaf(panel), 'Daily.md');

		expect(workspace.createLeafBySplit).toHaveBeenCalledOnce();
	});

	it('stays inside the panel’s own window', () => {
		const workspace = new FakeWorkspace();
		const popout = { name: 'popout' };
		workspace.add('main note', {}, note('Daily.md'));
		const panel = workspace.add('panel', {}, panelState(), { root: popout });

		leafBeside(asWorkspace(workspace), asLeaf(panel), 'Daily.md');

		expect(workspace.createLeafBySplit).toHaveBeenCalledWith(panel, 'vertical', false);
	});

	it('sends a sidebar panel’s link to the main area, reusing the file’s leaf when open', () => {
		const workspace = new FakeWorkspace();
		const panel = workspace.add('panel', {}, panelState(), { root: workspace.rightSplit });
		const open = workspace.add('open', {}, note('Daily.md'));

		expect(leafBeside(asWorkspace(workspace), asLeaf(panel), 'Daily.md')).toBe(open);
		leafBeside(asWorkspace(workspace), asLeaf(panel), 'Other.md');
		expect(workspace.getLeaf).toHaveBeenCalledWith(false);
		expect(workspace.createLeafBySplit).not.toHaveBeenCalled();
	});
});

function appWith(workspace: FakeWorkspace, files: string[]): App {
	return { workspace, metadataCache: fakeMetadataCache(files) } as unknown as App;
}

describe('openLinkBeside', () => {
	it('opens the resolved file beside the panel, with the heading as its state', async () => {
		const { workspace, panel, noteLeaf } = besideANote();

		await openLinkBeside(
			appWith(workspace, ['notes/Plan.md']),
			asLeaf(panel),
			'Plan#Next steps',
			'',
			false,
		);

		expect(panel.opened).toEqual([]);
		expect(noteLeaf.opened).toEqual([
			{ file: { path: 'notes/Plan.md' }, state: { active: true, eState: { subpath: '#Next steps' } } },
		]);
		expect(workspace.revealLeaf).toHaveBeenCalledWith(noteLeaf);
		expect(workspace.openLinkText).not.toHaveBeenCalled();
	});

	it('leaves a mod-click to Obsidian, as a link in a note does', async () => {
		const { workspace, panel, noteLeaf } = besideANote();

		await openLinkBeside(appWith(workspace, ['Plan.md']), asLeaf(panel), 'Plan', 'src.md', 'tab');

		expect(workspace.openLinkText).toHaveBeenCalledWith('Plan', 'src.md', 'tab');
		expect(noteLeaf.opened).toEqual([]);
	});

	it('hands an unresolved link to Obsidian in the leaf beside, made active first', async () => {
		const { workspace, panel, noteLeaf } = besideANote();

		await openLinkBeside(appWith(workspace, []), asLeaf(panel), 'New idea', '', false);

		expect(workspace.setActiveLeaf).toHaveBeenCalledWith(noteLeaf, { focus: true });
		expect(workspace.openLinkText).toHaveBeenCalledWith('New idea', '', false);
	});

	it('opens wherever Obsidian puts it when there is no panel to stay beside', async () => {
		const { workspace } = besideANote();

		await openLinkBeside(appWith(workspace, ['Plan.md']), null, 'Plan', '', false);

		expect(workspace.openLinkText).toHaveBeenCalledWith('Plan', '', false);
	});
});
