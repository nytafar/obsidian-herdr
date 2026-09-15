/**
 * The table of contents in Obsidian's outline place (issue #119, #91 user
 * story 21).
 *
 * **The spike first.** Obsidian's core outline (view type `outline`) has no
 * seam for a view that is not a file. In Obsidian 1.10's bundle the view is
 * file-bound — `isLeafBoundToFile`, `this.file`, `getDisplayText` off the file
 * — and its headings come from one method with no injection point at all:
 *
 * ```js
 * getHeadings = function () {
 *   var e = this.file;
 *   if (!e || "md" !== e.extension) return [];
 *   var t = this.app.metadataCache.getFileCache(e);
 *   ...
 *   return t.headings ?? [];
 * }
 * ```
 *
 * Nothing is registered, overridable or announced: the only extension points
 * around the plugin are `registerHoverLinkSource("outline")` and its drag
 * source. So the integration is at the **leaf** level, which is what this file
 * is: when the reader moves to a native herdr tab and an outline leaf is up in
 * a sidebar, the plugin's own table of contents is revealed in that outline's
 * tab group, and when the reader moves back to anything else, the outline is
 * revealed again.
 *
 * Two rules it is built on. **Nothing is ever detached** (CLAUDE.md, PRD N1):
 * a swap is two `revealLeaf` calls on leaves that both stay where the user put
 * them. And **no view is held**: the swap remembers the one outline leaf it
 * covered, as a leaf, and checks it is still a leaf the workspace hands back
 * before revealing it again.
 *
 * Everything the swap does to the workspace comes in as a callback, so the
 * whole decision and the whole sequence are tested against a fake workspace
 * (`tests/nativeToc.test.ts`).
 */

import type { Workspace, WorkspaceLeaf } from 'obsidian';
import type HerdrPlugin from '../main';
import { leafFacts, TOC_VIEW_TYPE, type ActiveLeafFacts } from './tocView';

/** Obsidian's core outline view, the place this borrows. */
export const OUTLINE_VIEW_TYPE = 'outline';

/** What a leaf becoming active does to the sidebar. */
export type OutlineSwapAction =
	| { kind: 'none' }
	| { kind: 'toc'; outlineLeaf: WorkspaceLeaf }
	| { kind: 'outline'; outlineLeaf: WorkspaceLeaf };

/**
 * Which way the sidebar swaps, as one pure function.
 *
 * A native view in the main area with an outline up is the one case that
 * covers the outline. Any *other* main-area leaf puts it back — a note, a
 * terminal tab, the agent list — but only ever the leaf this swap covered
 * itself, so a sidebar the user arranged is never rearranged for them.
 *
 * Every leaf outside the main area is ignored, the sidebars included, exactly
 * as the list itself ignores them (`tocTarget`): revealing a leaf activates it,
 * and a swap that answered that would immediately undo itself.
 */
export function outlineSwapAction(input: {
	/** What is true of the leaf that became active. */
	facts: ActiveLeafFacts | null;
	/** An outline leaf showing in an expanded sidebar, or null when there is none. */
	outlineLeaf: WorkspaceLeaf | null;
	/** The outline leaf this swap has covered, while it has covered one. */
	hidden: WorkspaceLeaf | null;
}): OutlineSwapAction {
	const { facts, outlineLeaf, hidden } = input;
	if (!facts || !facts.inMainArea) return { kind: 'none' };
	if (facts.nativePaneId) {
		if (hidden || !outlineLeaf) return { kind: 'none' };
		return { kind: 'toc', outlineLeaf };
	}
	if (!hidden) return { kind: 'none' };
	return { kind: 'outline', outlineLeaf: hidden };
}

/** Everything the swap needs of a workspace, and nothing else. */
export interface OutlineSwapOptions {
	/** What is true of a leaf; the same facts the table of contents reads. */
	facts(leaf: WorkspaceLeaf | null): ActiveLeafFacts | null;
	/** Outline leaves showing in an expanded sidebar, in the workspace's order. */
	outlineLeaves(): WorkspaceLeaf[];
	/** Every leaf showing the plugin's table of contents, wherever it is. */
	tocLeaves(): WorkspaceLeaf[];
	/** Puts a table of contents in the outline's own tab group; null if it cannot. */
	createTocLeaf(beside: WorkspaceLeaf): Promise<WorkspaceLeaf | null>;
	/** Brings a leaf to the front of its tab group. Never detaches anything. */
	reveal(leaf: WorkspaceLeaf): Promise<void>;
}

/**
 * The swap itself: the decision above, plus the one piece of state it needs —
 * which outline leaf is currently covered — and the workspace calls that carry
 * it out.
 */
export class OutlineSwap {
	private readonly options: OutlineSwapOptions;
	/** The outline leaf this swap covered, or null while it has covered none. */
	private hidden: WorkspaceLeaf | null = null;
	/**
	 * Which request is being served. Creating a leaf is async, and the reader
	 * can be two tabs further on by the time it comes back; a request that has
	 * been overtaken reveals nothing.
	 */
	private request = 0;

	constructor(options: OutlineSwapOptions) {
		this.options = options;
	}

	/** A leaf became active. Awaited by tests; fired and forgotten in the app. */
	async activeLeafChanged(leaf: WorkspaceLeaf | null): Promise<void> {
		const outlines = this.options.outlineLeaves();
		// An outline leaf that has been closed, or whose sidebar is collapsed, is
		// not one to reveal again: the reader put it away themselves.
		if (this.hidden && !outlines.includes(this.hidden)) this.hidden = null;
		const action = outlineSwapAction({
			facts: this.options.facts(leaf),
			outlineLeaf: outlines.at(0) ?? null,
			hidden: this.hidden,
		});
		if (action.kind === 'none') return;
		const request = ++this.request;
		if (action.kind === 'outline') {
			this.hidden = null;
			await this.options.reveal(action.outlineLeaf);
			return;
		}
		const outlineLeaf = action.outlineLeaf;
		const tocLeaf = await this.tocLeafFor(outlineLeaf);
		if (!tocLeaf || request !== this.request) return;
		// Covered only when the list really is in front of the outline. A table
		// of contents the user keeps somewhere else hides nothing, so there is
		// nothing to put back either.
		if (tocLeaf.parent === outlineLeaf.parent) this.hidden = outlineLeaf;
		await this.options.reveal(tocLeaf);
	}

	/**
	 * The table of contents to reveal: the one in the outline's tab group, else
	 * any that is already open, else a new one built in that group.
	 *
	 * A second copy of a sidebar view is worse than one in a place the user
	 * chose, which is why an existing leaf anywhere wins over creating another.
	 */
	private async tocLeafFor(outlineLeaf: WorkspaceLeaf): Promise<WorkspaceLeaf | null> {
		const open = this.options.tocLeaves();
		const inGroup = open.find((leaf) => leaf.parent === outlineLeaf.parent);
		if (inGroup) return inGroup;
		return open.at(0) ?? (await this.options.createTocLeaf(outlineLeaf));
	}
}

/**
 * Whether a leaf sits in a sidebar the reader has not collapsed, which is what
 * "the outline is up" means: a collapsed sidebar shows nothing, and revealing
 * into it would open a panel nobody asked for.
 */
function inExpandedSidebar(workspace: Workspace, leaf: WorkspaceLeaf): boolean {
	const root = leaf.getRoot();
	for (const sidebar of [workspace.leftSplit, workspace.rightSplit]) {
		if (root === sidebar) return !sidebar.collapsed;
	}
	return false;
}

/**
 * Hangs the swap on the workspace for the life of the plugin.
 *
 * Two events feed it: a leaf becoming active, and a tab swapping its surface
 * where it stands (#105), which activates no leaf and would otherwise leave the
 * sidebar showing the wrong thing for the tab the reader is in.
 */
export function registerOutlineSwap(plugin: HerdrPlugin): void {
	const workspace = plugin.app.workspace;
	const swap = new OutlineSwap({
		facts: (leaf) => leafFacts(plugin.app, leaf),
		outlineLeaves: () =>
			workspace
				.getLeavesOfType(OUTLINE_VIEW_TYPE)
				.filter((leaf) => inExpandedSidebar(workspace, leaf)),
		tocLeaves: () => workspace.getLeavesOfType(TOC_VIEW_TYPE),
		createTocLeaf: async (beside) => {
			// A leaf's parent is the `WorkspaceTabs` it is a tab of, which is what
			// `createLeafInParent` takes in practice; the published signature says
			// `WorkspaceSplit`, and the two are the same empty class to the
			// compiler. The index appends, from the child count the tab group
			// keeps but does not publish — 0 where a build has none, which puts
			// the tab first rather than nowhere.
			const parent = beside.parent;
			const at = (parent as { children?: unknown[] }).children?.length ?? 0;
			const leaf = workspace.createLeafInParent(parent, at);
			await leaf.setViewState({ type: TOC_VIEW_TYPE, active: true });
			return leaf;
		},
		reveal: (leaf) => workspace.revealLeaf(leaf),
	});
	plugin.registerEvent(
		workspace.on('active-leaf-change', (leaf) => void swap.activeLeafChanged(leaf)),
	);
	plugin.register(
		plugin.paneViews.on((leaf) => {
			if (leaf === workspace.getMostRecentLeaf()) void swap.activeLeafChanged(leaf);
		}),
	);
}
