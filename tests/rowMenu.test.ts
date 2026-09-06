/**
 * The agent row's context menu (issue #35). The `Menu` and the two modals are
 * Obsidian's; what is worth testing is the content: the three entries in
 * order, the pin entry flipping with the row, the destructive one marked and
 * separated, and what the confirm and prompt say for a given row.
 */

import { describe, expect, it } from 'vitest';
import {
	closeConfirmation,
	renamePrompt,
	rowMenuItems,
	type RowMenuRow,
} from '../src/views/rowMenu';

function row(overrides: Partial<RowMenuRow> = {}): RowMenuRow {
	return { paneId: 'w4:p3', displayName: 'notes', pinned: false, name: 'notes', ...overrides };
}

describe('rowMenuItems', () => {
	it('offers pin, rename and close, in that order', () => {
		const items = rowMenuItems(row());
		expect(items.map((item) => item.action)).toEqual(['pin', 'rename', 'close']);
		expect(items.map((item) => item.label)).toEqual([
			'Pin to top of group',
			'Rename agent',
			'Close pane',
		]);
	});

	it('flips the pin entry for a pinned row', () => {
		const [pin] = rowMenuItems(row({ pinned: true }));
		expect(pin?.action).toBe('unpin');
		expect(pin?.label).toBe('Unpin from top of group');
		expect(pin?.icon).toBe('pin-off');
	});

	it('marks only close as a warning, behind a separator', () => {
		const items = rowMenuItems(row());
		expect(items.map((item) => item.warning)).toEqual([false, false, true]);
		expect(items.map((item) => item.separatorBefore)).toEqual([false, false, true]);
	});

	it('gives every entry an icon', () => {
		for (const item of rowMenuItems(row())) expect(item.icon).not.toBe('');
	});
});

describe('closeConfirmation', () => {
	it('names the agent in the title and says what is lost', () => {
		const text = closeConfirmation(row({ displayName: 'notes-2' }));
		expect(text.title).toBe('Close "notes-2"?');
		expect(text.body).toContain('ends the agent');
		expect(text.confirm).toBe('Close pane');
	});
});

describe('renamePrompt', () => {
	it('starts from the agent’s own name', () => {
		expect(renamePrompt(row({ name: 'notes' })).initial).toBe('notes');
	});

	it('starts blank for an agent herdr never named, not from the title or pane id', () => {
		expect(renamePrompt(row({ name: undefined, displayName: 'w4:p3' })).initial).toBe('');
		expect(renamePrompt(row({ name: '', displayName: 'zsh' })).initial).toBe('');
	});

	it('explains herdr’s naming rule', () => {
		const text = renamePrompt(row());
		expect(text.title).toBe('Rename agent');
		expect(text.label).toMatch(/lowercase/i);
		expect(text.confirm).toBe('Rename');
	});
});
