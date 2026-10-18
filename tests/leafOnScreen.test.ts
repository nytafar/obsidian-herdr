/**
 * "Is this leaf on screen", the one answer the explorer reveal (#116), follow
 * active note (#78), the open-beside choice (#114) and the quiet terminal open
 * share. `isShown` covers a background tab; a collapsed sidebar is checked by
 * its own flag, because `isShown` is not documented to say no for it.
 */

import { describe, expect, it } from 'vitest';
import type { Workspace, WorkspaceLeaf } from 'obsidian';
import { leafOnScreen } from '../src/leafOnScreen';

function setup(options: {
	root?: 'main' | 'left' | 'right';
	/** What `isShown` answers; null for an element without it. */
	shown?: boolean | null;
	deferred?: boolean;
	collapsed?: boolean;
}) {
	const leftSplit = { collapsed: options.collapsed ?? false };
	const rightSplit = { collapsed: options.collapsed ?? false };
	const main = {};
	const root = options.root === 'left' ? leftSplit : options.root === 'right' ? rightSplit : main;
	const containerEl = options.shown === null ? {} : { isShown: () => options.shown ?? true };
	const leaf = { isDeferred: options.deferred ?? false, getRoot: () => root, view: { containerEl } };
	return {
		workspace: { leftSplit, rightSplit } as unknown as Workspace,
		leaf: leaf as unknown as WorkspaceLeaf,
	};
}

describe('leafOnScreen', () => {
	it('is true for the front tab of the main area or an open sidebar', () => {
		for (const root of ['main', 'left', 'right'] as const) {
			const { workspace, leaf } = setup({ root });
			expect(leafOnScreen(workspace, leaf)).toBe(true);
		}
	});

	it('is false in a collapsed sidebar, even where isShown says yes', () => {
		for (const root of ['left', 'right'] as const) {
			const { workspace, leaf } = setup({ root, collapsed: true, shown: true });
			expect(leafOnScreen(workspace, leaf)).toBe(false);
		}
	});

	it('ignores the sidebars being collapsed for a main-area leaf', () => {
		const { workspace, leaf } = setup({ root: 'main', collapsed: true });
		expect(leafOnScreen(workspace, leaf)).toBe(true);
	});

	it('is false for a background tab and for a deferred leaf', () => {
		const background = setup({ shown: false });
		expect(leafOnScreen(background.workspace, background.leaf)).toBe(false);
		const deferred = setup({ deferred: true });
		expect(leafOnScreen(deferred.workspace, deferred.leaf)).toBe(false);
	});

	it('lets the other checks decide where isShown is missing', () => {
		const { workspace, leaf } = setup({ shown: null });
		expect(leafOnScreen(workspace, leaf)).toBe(true);
	});
});
