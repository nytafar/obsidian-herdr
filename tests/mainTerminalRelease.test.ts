/**
 * A terminal tab closing (`HerdrPlugin.terminalTabReleased`): when no other
 * tab shows the pane, its kind is told; when no runtime names the pane any
 * more (its runtime was removed while the tab was open), every kind that
 * keeps its own processes is asked whether the pane is one of them (#185).
 * That a `claude` shell ends then is the claude kind's own test
 * (`claudeTerminal.test.ts`).
 *
 * The plugin is built with `Object.create`, as in `mainPlacement.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import HerdrPlugin from '../src/main';

afterEach(() => {
	vi.unstubAllGlobals();
});

function plugin(options: { endpoint: boolean; shown: boolean }) {
	const orphaned: string[] = [];
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
	loose.endpoints = {
		endpoint: () => (options.endpoint ? { id: 'rt', runtime: { kind: 'claude' } } : null),
		kindOf: () => ({ terminalReleased: (_endpoint: unknown, paneId: string) => released.push(paneId) }),
	};
	loose.app = {
		workspace: {
			getLeavesOfType: () =>
				options.shown ? [{ getViewState: () => ({ state: { paneId: 'sh-0000abcd', endpointId: 'rt' } }) }] : [],
		},
	};
	loose.kinds = {
		herdr: {},
		claude: { paneOrphaned: (paneId: string) => orphaned.push(paneId) },
	};
	return { instance, orphaned, released };
}

describe('a terminal tab released', () => {
	it('tells the kind when its runtime is still there', () => {
		const { instance, orphaned, released } = plugin({ endpoint: true, shown: false });
		instance.terminalTabReleased('sh-0000abcd', 'rt');
		expect(released).toEqual(['sh-0000abcd']);
		expect(orphaned).toEqual([]);
	});

	it('asks the kinds about a pane whose runtime was removed, once its last tab is gone', () => {
		const { instance, orphaned } = plugin({ endpoint: false, shown: false });
		instance.terminalTabReleased('sh-0000abcd', 'rt');
		expect(orphaned).toEqual(['sh-0000abcd']);
	});

	it('keeps it while another tab still shows it', () => {
		const shown = plugin({ endpoint: false, shown: true });
		shown.instance.terminalTabReleased('sh-0000abcd', 'rt');
		expect(shown.orphaned).toEqual([]);
	});
});
