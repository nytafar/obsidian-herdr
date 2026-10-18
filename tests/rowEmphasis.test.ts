/**
 * Where a row's agent is live (issue #76): the terminal tier from the open and
 * active tabs, and how the two surfaces split over the icon and the background
 * under each row-click setting. All of it is `rowModel.ts`, which takes the tabs
 * as data, so no workspace or DOM is needed.
 *
 * In its own file so it does not collide with other work in
 * `tests/rowModel.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
	buildRows,
	rowEmphasis,
	terminalTier,
	type RowModel,
	type RowModelOptions,
	type TerminalRef,
	type TerminalTier,
} from '../src/views/rowModel';
import type { PaneState } from '../src/herdr/scope';

const VAULT = '/Users/lasse/Vaults/hvelv';
const LOCAL = 'local';
const REMOTE = 'remote:xl';

function pane(paneId: string, overrides: Partial<PaneState> = {}): PaneState {
	return {
		paneId,
		workspaceId: 'w4',
		tabId: 'w4:t1',
		agent: 'claude',
		name: '',
		agentStatus: 'idle',
		title: paneId,
		label: '',
		cwd: VAULT,
		focused: false,
		tokens: {},
		statusChangedSeq: 0,
		...overrides,
	};
}

const ref = (paneId: string, endpointId = LOCAL): TerminalRef => ({ endpointId, paneId });

function rowsById(panes: PaneState[], options: RowModelOptions): Map<string, RowModel> {
	const groups = buildRows(panes, new Map(), VAULT, { groupBy: 'none', ...options });
	return new Map(groups.flatMap((group) => group.rows).map((row) => [row.paneId, row]));
}

describe('terminalTier', () => {
	it('is closed without a tab, open with one, active when it is the active tab', () => {
		expect(terminalTier(ref('w4:p1'), [], null)).toBe('closed');
		expect(terminalTier(ref('w4:p1'), [ref('w4:p1')], null)).toBe('open');
		expect(terminalTier(ref('w4:p1'), [ref('w4:p1')], ref('w4:p1'))).toBe('active');
		// Another pane's active tab leaves this one merely open.
		expect(terminalTier(ref('w4:p1'), [ref('w4:p1'), ref('w4:p2')], ref('w4:p2'))).toBe(
			'open',
		);
	});

	it('counts the active tab as open even when the open list missed it', () => {
		expect(terminalTier(ref('w4:p1'), [], ref('w4:p1'))).toBe('active');
	});

	it('does not match a terminal on the other endpoint with the same pane id', () => {
		const remoteTab = ref('w4:p1', REMOTE);
		expect(terminalTier(ref('w4:p1'), [remoteTab], null)).toBe('closed');
		expect(terminalTier(ref('w4:p1'), [remoteTab], remoteTab)).toBe('closed');
	});
});

describe('rowEmphasis', () => {
	const TIERS: TerminalTier[] = ['closed', 'open', 'active'];

	it('by default puts herdr focus on the icon and the terminal on the background', () => {
		expect(rowEmphasis(true, 'closed', 'terminal')).toEqual({
			iconTier: 'full',
			backgroundTier: 'none',
			current: false,
		});
		expect(rowEmphasis(false, 'open', 'terminal')).toEqual({
			iconTier: 'none',
			backgroundTier: 'faint',
			current: false,
		});
		expect(rowEmphasis(false, 'active', 'terminal')).toEqual({
			iconTier: 'none',
			backgroundTier: 'full',
			current: true,
		});
		expect(rowEmphasis(true, 'active', 'terminal')).toEqual({
			iconTier: 'full',
			backgroundTier: 'full',
			current: true,
		});
		expect(rowEmphasis(false, 'closed', 'terminal')).toEqual({
			iconTier: 'none',
			backgroundTier: 'none',
			current: false,
		});
	});

	it('swapped, puts the terminal on the icon by opacity and herdr focus on the background', () => {
		expect(rowEmphasis(false, 'open', 'focus')).toEqual({
			iconTier: 'faint',
			backgroundTier: 'none',
			current: false,
		});
		expect(rowEmphasis(false, 'active', 'focus')).toEqual({
			iconTier: 'full',
			backgroundTier: 'none',
			current: true,
		});
		// Herdr focus has one strength only, on either channel.
		expect(rowEmphasis(true, 'closed', 'focus')).toEqual({
			iconTier: 'none',
			backgroundTier: 'full',
			current: false,
		});
		expect(rowEmphasis(true, 'open', 'focus')).toEqual({
			iconTier: 'faint',
			backgroundTier: 'full',
			current: false,
		});
	});

	it('swaps the channels exactly when the setting is swapped', () => {
		for (const focused of [false, true]) {
			for (const terminal of TIERS) {
				const plain = rowEmphasis(focused, terminal, 'terminal');
				const swapped = rowEmphasis(focused, terminal, 'focus');
				expect(swapped.iconTier).toBe(plain.backgroundTier);
				expect(swapped.backgroundTier).toBe(plain.iconTier);
				// aria-current follows the active tab, whatever the setting.
				expect(swapped.current).toBe(plain.current);
				expect(plain.current).toBe(terminal === 'active');
			}
		}
	});

	it('never gives herdr focus the faint tier', () => {
		for (const rowClick of ['terminal', 'focus'] as const) {
			for (const terminal of TIERS) {
				const emphasis = rowEmphasis(true, terminal, rowClick);
				const focusTier =
					rowClick === 'terminal' ? emphasis.iconTier : emphasis.backgroundTier;
				expect(focusTier).toBe('full');
			}
		}
	});

	it('falls back to the default split on a junk stored setting', () => {
		expect(rowEmphasis(true, 'open', 'nonsense' as never)).toEqual(
			rowEmphasis(true, 'open', 'terminal'),
		);
	});
});

describe('buildRows liveness (issue #76)', () => {
	const panes = [pane('w4:p1', { focused: true }), pane('w4:p2'), pane('w4:p3'), pane('w4:p4')];
	const live: RowModelOptions = {
		endpointId: LOCAL,
		openTerminals: [ref('w4:p2'), ref('w4:p3'), ref('w4:p4', REMOTE)],
		activeTerminal: ref('w4:p3'),
	};

	it('marks the tiers with the default setting', () => {
		const rows = rowsById(panes, { ...live, rowClick: 'terminal' });
		expect(rows.get('w4:p1')).toMatchObject({
			terminal: 'closed',
			iconTier: 'full',
			backgroundTier: 'none',
		});
		expect(rows.get('w4:p2')).toMatchObject({
			terminal: 'open',
			iconTier: 'none',
			backgroundTier: 'faint',
		});
		expect(rows.get('w4:p3')).toMatchObject({
			terminal: 'active',
			iconTier: 'none',
			backgroundTier: 'full',
			current: true,
		});
		const current = [...rows.values()].filter((row) => row.current);
		expect(current.map((row) => row.paneId)).toEqual(['w4:p3']);
	});

	it('marks the tiers with the setting swapped', () => {
		const rows = rowsById(panes, { ...live, rowClick: 'focus' });
		expect(rows.get('w4:p1')).toMatchObject({ iconTier: 'none', backgroundTier: 'full' });
		expect(rows.get('w4:p2')).toMatchObject({ iconTier: 'faint', backgroundTier: 'none' });
		expect(rows.get('w4:p3')).toMatchObject({
			iconTier: 'full',
			backgroundTier: 'none',
			current: true,
		});
	});

	it('leaves a row dark when only the other endpoint has a terminal for its pane id', () => {
		for (const rowClick of ['terminal', 'focus'] as const) {
			const rows = rowsById(panes, {
				...live,
				rowClick,
				activeTerminal: ref('w4:p4', REMOTE),
			});
			expect(rows.get('w4:p4')).toMatchObject({
				terminal: 'closed',
				iconTier: 'none',
				backgroundTier: 'none',
				current: false,
			});
			// The tab that used to be active is still open, just no longer current.
			expect(rows.get('w4:p3')).toMatchObject({ terminal: 'open', current: false });
		}
	});

	it('lights the other endpoint only for a list on that endpoint', () => {
		const rows = rowsById(panes, { ...live, endpointId: REMOTE, rowClick: 'terminal' });
		expect(rows.get('w4:p2')?.terminal).toBe('closed');
		expect(rows.get('w4:p3')?.terminal).toBe('closed');
		expect(rows.get('w4:p4')?.terminal).toBe('open');
	});

	it('lights no terminal without the data, and keeps herdr focus on the icon', () => {
		const rows = rowsById(panes, {});
		expect([...rows.values()].map((row) => row.terminal)).toEqual([
			'closed',
			'closed',
			'closed',
			'closed',
		]);
		expect(rows.get('w4:p1')?.iconTier).toBe('full');
	});
});
