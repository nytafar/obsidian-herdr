/**
 * The row's action pair (issue #21). `AgentListView` needs a DOM, so what is
 * testable is the decision it renders from: which action sits on the row body,
 * which on the icon button, and what the button then says — the tooltip has to
 * follow the setting, because the pair is configurable.
 *
 * In its own file so it does not collide with the sort and grouping work landing
 * in `tests/rowModel.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { isRowClickAction, rowActions } from '../src/views/rowModel';
import { DEFAULT_SETTINGS } from '../src/settings';

describe('rowActions', () => {
	it('puts the terminal on the row body by default', () => {
		const actions = rowActions('terminal');
		expect(actions.body).toBe('terminal');
		expect(actions.button).toBe('focus');
		expect(actions.buttonIcon).toBe('arrow-up-right');
		expect(actions.buttonLabel).toBe('Focus in herdr');
	});

	it('swaps both halves, and the button label with them, when flipped', () => {
		const actions = rowActions('focus');
		expect(actions.body).toBe('focus');
		expect(actions.button).toBe('terminal');
		expect(actions.buttonIcon).toBe('square-terminal');
		expect(actions.buttonLabel).toBe('Open terminal');
	});

	it('always gives the button the other half of the pair', () => {
		for (const setting of ['terminal', 'focus'] as const) {
			const actions = rowActions(setting);
			expect(actions.button).not.toBe(actions.body);
		}
	});

	it('falls back to the default rather than throwing on a junk stored value', () => {
		const actions = rowActions('nonsense' as never);
		expect(actions.body).toBe('terminal');
		expect(actions.button).toBe('focus');
	});

	it('is what the shipped default asks for: a click opens the terminal', () => {
		expect(DEFAULT_SETTINGS.agentListRowClick).toBe('terminal');
		expect(rowActions(DEFAULT_SETTINGS.agentListRowClick).body).toBe('terminal');
	});
});

describe('isRowClickAction', () => {
	it('accepts the two actions and nothing else', () => {
		expect(isRowClickAction('terminal')).toBe(true);
		expect(isRowClickAction('focus')).toBe(true);
		expect(isRowClickAction(undefined)).toBe(false);
		expect(isRowClickAction('')).toBe(false);
		expect(isRowClickAction('Terminal')).toBe(false);
		expect(isRowClickAction(1)).toBe(false);
	});
});
