/**
 * The list view's own behaviour needs a DOM and a live herdr, so what is left to
 * test here is the one thing `main.ts` and the view's registration agree on (the
 * view type id) and the toolbar's quick settings menu (issue #44), which is pure
 * and lives one module over. Everything a row *says* lives in
 * `src/views/rowModel.ts` and is covered by `tests/rowModel.test.ts`; the view
 * re-exported those helpers for a while after issue #16 split them out, and that
 * shim is gone — callers import the pure module directly.
 */

import { describe, expect, it } from 'vitest';
import * as view from '../src/views/agentListView';
import { quickSettingsItems, type QuickSettings } from '../src/views/quickSettings';

describe('agentListView module surface', () => {
	it('exports the view type id', () => {
		expect(view.AGENT_LIST_VIEW_TYPE).toBe('herdr-agents');
	});
});

describe('quickSettingsItems (issue #44)', () => {
	const SETTINGS: QuickSettings = {
		agentListRowClick: 'terminal',
		terminalPlacement: 'split-right',
		terminalTab: 'per-agent',
		splitIntoFolderTab: true,
		folderHoverButton: true,
	};

	it('offers the five quick settings under their own headings', () => {
		const items = quickSettingsItems({ ...SETTINGS });
		expect([...new Set(items.map((item) => item.section))]).toEqual([
			'Clicking an agent row',
			'Terminal opens in',
			'Terminal tabs',
			'Also',
		]);
		expect(items).toHaveLength(9);
	});

	it('ticks exactly the values in effect', () => {
		const items = quickSettingsItems({
			...SETTINGS,
			agentListRowClick: 'focus',
			terminalPlacement: 'tab',
			terminalTab: 'reuse',
			splitIntoFolderTab: false,
		});
		expect(items.filter((item) => item.checked).map((item) => item.label)).toEqual([
			'Focuses it in herdr',
			'New tab',
			'Reuse one tab',
			'Folder hover button',
		]);
	});

	it('writes the value it names and nothing else', () => {
		const settings = { ...SETTINGS };
		const pick = (label: string): void => {
			const item = quickSettingsItems(settings).find((entry) => entry.label === label);
			expect(item).toBeDefined();
			item?.apply(settings);
		};
		pick('Focuses it in herdr');
		pick('Split left');
		pick('Reuse one tab');
		expect(settings).toEqual({
			...SETTINGS,
			agentListRowClick: 'focus',
			terminalPlacement: 'split-left',
			terminalTab: 'reuse',
		});
	});

	it('toggles the two booleans rather than setting them', () => {
		const settings = { ...SETTINGS };
		const toggle = (label: string): void => {
			quickSettingsItems(settings)
				.find((entry) => entry.label === label)
				?.apply(settings);
		};
		toggle('Share a herdr tab per folder');
		toggle('Folder hover button');
		expect(settings.splitIntoFolderTab).toBe(false);
		expect(settings.folderHoverButton).toBe(false);
		toggle('Folder hover button');
		expect(settings.folderHoverButton).toBe(true);
	});

	it('marks the folder button as the one entry with a side effect', () => {
		const withEffect = quickSettingsItems({ ...SETTINGS }).filter((item) => item.effect);
		expect(withEffect.map((item) => [item.label, item.effect])).toEqual([
			['Folder hover button', 'folder-button'],
		]);
	});
});
