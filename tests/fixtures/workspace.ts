/**
 * A fake Obsidian workspace for the "open beside the panel" decision (#114).
 *
 * Just enough layout for `src/openBeside.ts`: leaves in tab groups under a
 * root, each with a persisted view state, the front tab of each group as
 * `getMostRecentLeaf(group)` reports it and as the only leaf of the group whose
 * `containerEl.isShown()` says yes, and recorders for every call that
 * places or opens something. Groups and roots are bare objects compared by
 * identity, as the real `WorkspaceTabs` and `WorkspaceSplit` are.
 *
 * Cast to `Workspace` and `WorkspaceLeaf` at the call site; the real types are
 * checked by `tsc` against `obsidian.d.ts`, which does not see this file.
 */

import { vi } from 'vitest';

/** A file as `getFirstLinkpathDest` hands it back. */
export interface FakeFile {
	path: string;
}

/** The persisted state of a leaf, the part the decision reads. */
export interface FakeViewState {
	type: string;
	state?: Record<string, unknown>;
	pinned?: boolean;
}

export class FakeLeaf {
	/** Every `openFile` call on this leaf, in order. */
	readonly opened: { file: FakeFile; state: unknown }[] = [];
	isDeferred = false;
	/** Set by `detach`. */
	detached = false;
	/**
	 * Whether the leaf is on screen, as `containerEl.isShown()` answers. The
	 * workspace sets it to "the front tab of its group"; a test may override it.
	 */
	shown: () => boolean = () => true;
	view: { navigation: boolean; containerEl: { isShown(): boolean } };

	constructor(
		readonly name: string,
		public parent: object,
		public root: object,
		public viewState: FakeViewState,
		navigation = true,
	) {
		this.view = { navigation, containerEl: { isShown: () => this.shown() } };
	}

	detach(): void {
		this.detached = true;
	}

	getRoot(): object {
		return this.root;
	}

	getViewState(): FakeViewState {
		return this.viewState;
	}

	async openFile(file: FakeFile, state?: unknown): Promise<void> {
		this.opened.push({ file, state });
		this.viewState = { type: 'markdown', state: { file: file.path } };
	}
}

/** The view type of a herdr panel, as the fake lays one out. */
export const PANEL_TYPE = 'herdr-terminal';

export class FakeWorkspace {
	readonly rootSplit = { name: 'root' };
	readonly leftSplit = { name: 'left' };
	readonly rightSplit = { name: 'right' };
	/** Every leaf, in layout order. */
	readonly leaves: FakeLeaf[] = [];
	/** The front tab of a group; the group's first leaf when unset. */
	readonly fronts = new Map<object, FakeLeaf>();
	/** Leaves `createLeafBySplit` made, in order. */
	readonly splits: FakeLeaf[] = [];

	readonly openLinkText = vi.fn(async (..._args: unknown[]) => {});
	readonly setActiveLeaf = vi.fn((..._args: unknown[]) => {});
	readonly revealLeaf = vi.fn(async (..._args: unknown[]) => {});
	readonly getLeaf = vi.fn((..._args: unknown[]) => this.add('from getLeaf', {}, { type: 'empty' }));
	readonly createLeafBySplit = vi.fn((leaf: FakeLeaf, ..._rest: unknown[]) => {
		const made = new FakeLeaf('split', {}, leaf.root, { type: 'empty' });
		made.shown = () => this.getMostRecentLeaf(made.parent) === made;
		// The new group lands right after the one it was split from.
		let at = this.leaves.length - 1;
		this.leaves.forEach((candidate, index) => {
			if (candidate.parent === leaf.parent) at = index;
		});
		this.leaves.splice(at + 1, 0, made);
		this.splits.push(made);
		return made;
	});

	/** A leaf in `group` (a fresh one when left out), in the main area unless `root` says. */
	add(
		name: string,
		group: object,
		viewState: FakeViewState,
		options: { root?: object; navigation?: boolean; front?: boolean } = {},
	): FakeLeaf {
		const leaf = new FakeLeaf(
			name,
			group,
			options.root ?? this.rootSplit,
			viewState,
			options.navigation ?? true,
		);
		leaf.shown = () => this.getMostRecentLeaf(leaf.parent) === leaf;
		this.leaves.push(leaf);
		if (options.front) this.fronts.set(group, leaf);
		return leaf;
	}

	iterateAllLeaves(callback: (leaf: FakeLeaf) => unknown): void {
		for (const leaf of [...this.leaves]) callback(leaf);
	}

	iterateRootLeaves(callback: (leaf: FakeLeaf) => unknown): void {
		for (const leaf of [...this.leaves]) if (leaf.root === this.rootSplit) callback(leaf);
	}

	getMostRecentLeaf(group?: object): FakeLeaf | null {
		if (!group) return null;
		return this.fronts.get(group) ?? this.leaves.find((leaf) => leaf.parent === group) ?? null;
	}
}

/** A note leaf's view state. */
export function note(file: string, extra: Partial<FakeViewState> = {}): FakeViewState {
	return { type: 'markdown', state: { file }, ...extra };
}

/** A herdr panel's view state. */
export function panelState(): FakeViewState {
	return { type: PANEL_TYPE, state: { paneId: 'w4:p1' } };
}

/**
 * The metadata cache, resolving link paths to the files listed: by vault
 * path, by that path without `.md`, or by base name. Records what it was asked.
 */
export function fakeMetadataCache(paths: string[]): {
	getFirstLinkpathDest: ReturnType<typeof vi.fn>;
} {
	const files = paths.map((path) => ({ path }));
	return {
		getFirstLinkpathDest: vi.fn((linkpath: string, _sourcePath: string) => {
			return (
				files.find(
					(file) =>
						file.path === linkpath ||
						file.path === `${linkpath}.md` ||
						file.path.split('/').pop() === `${linkpath}.md`,
				) ?? null
			);
		}),
	};
}
