/**
 * A terminal tab closing (`HerdrPlugin.terminalTabReleased`): when no other
 * tab shows the pane, its kind is told, and a `claude` shell ends with its
 * last tab (ADR-0008). A shell whose runtime was removed while its tab was
 * open is still this plugin's process: closing that tab ends it too (the D2
 * review found it left running).
 *
 * The plugin is built with `Object.create`, as in `mainPlacement.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import HerdrPlugin from '../src/main';

afterEach(() => {
	vi.unstubAllGlobals();
});

function plugin(options: { endpoint: boolean; shown: boolean }) {
	const closed: string[] = [];
	const released: string[] = [];
	// The release check runs a moment later; here, at once.
	vi.stubGlobal('window', {
		setTimeout: (handler: () => void) => {
			handler();
			return 1;
		},
	});
	const instance = Object.create(HerdrPlugin.prototype) as HerdrPlugin;
	const loose = instance as unknown as Record<string, unknown>;
	loose.endpointFor = () => (options.endpoint ? { id: 'rt', runtime: { kind: 'claude' } } : null);
	loose.kindOf = () => ({ terminalReleased: (_endpoint: unknown, paneId: string) => released.push(paneId) });
	loose.app = {
		workspace: {
			getLeavesOfType: () =>
				options.shown ? [{ getViewState: () => ({ state: { paneId: 'sh-0000abcd', endpointId: 'rt' } }) }] : [],
		},
	};
	loose.claudeKind = {
		shells: {
			close: (id: string) => {
				closed.push(id);
				return Promise.resolve();
			},
		},
	};
	return { instance, closed, released };
}

describe('a terminal tab released', () => {
	it('tells the kind when its runtime is still there', () => {
		const { instance, closed, released } = plugin({ endpoint: true, shown: false });
		instance.terminalTabReleased('sh-0000abcd', 'rt');
		expect(released).toEqual(['sh-0000abcd']);
		expect(closed).toEqual([]);
	});

	it('ends a shell whose runtime was removed once its last tab is gone', () => {
		const { instance, closed } = plugin({ endpoint: false, shown: false });
		instance.terminalTabReleased('sh-0000abcd', 'rt');
		expect(closed).toEqual(['sh-0000abcd']);
	});

	it('keeps it while another tab still shows it, and leaves other panes of a removed runtime alone', () => {
		const shown = plugin({ endpoint: false, shown: true });
		shown.instance.terminalTabReleased('sh-0000abcd', 'rt');
		expect(shown.closed).toEqual([]);
		const pane = plugin({ endpoint: false, shown: false });
		pane.instance.terminalTabReleased('w1:p2', 'rt');
		expect(pane.closed).toEqual([]);
	});
});
