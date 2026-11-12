/**
 * The list view's own behaviour needs a DOM and a live herdr, so what is left to
 * test here is the one thing `main.ts` and the view's registration agree on (the
 * view type id) and the toolbar's quick settings menu (issue #44), which is pure
 * and lives one module over; and, on a view mounted on the DOM fixture, that
 * the + button's toolbar and repaints start no probe (issue #125). Everything a
 * row *says* lives in `src/views/rowModel.ts` and is covered by
 * `tests/rowModel.test.ts`; the view re-exported those helpers for a while
 * after issue #16 split them out, and that shim is gone — callers import the
 * pure module directly.
 */

import { describe, expect, it } from 'vitest';
// The stub `obsidian` resolves to, imported by path for its recording types.
import { Menu } from './fixtures/obsidian';
import * as view from '../src/views/agentListView';
import { quickSettingsItems, type QuickSettings } from '../src/views/quickSettings';
import { AgentCatalogs } from '../src/agents/catalogs';
import { endpointOf, type Connection } from '../src/connection';
import { defaultLocalRuntime } from '../src/runtimes';
import { DEFAULT_SETTINGS } from '../src/settings';
import { hostEl } from './fixtures/dom';

/** Lets every microtask queued so far run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The + button (issue #125) on a mounted list: the toolbar and the repaint
 * read the catalog's cache and start no probe (render does no I/O), and the
 * keyboard's context-menu key opens the catalog menu under the button.
 */
describe('the + button on a mounted list', () => {
	function mounted() {
		let probes = 0;
		const runtime = defaultLocalRuntime();
		const connection = {
			endpoint: endpointOf(runtime),
			client: { ping: () => Promise.resolve() },
		} as unknown as Connection;
		const settings = structuredClone(DEFAULT_SETTINGS);
		const agentCatalogs = new AgentCatalogs({
			connection: () => connection,
			endpoint: () => endpointOf(runtime),
			settings: () => settings,
			probe: () => {
				probes++;
				return Promise.resolve({ found: new Set(['codex']), herdrVersion: '0.9.5' });
			},
		});
		const plugin = {
			settings,
			endpoint: endpointOf(runtime),
			agentCatalogs,
			capabilities: () => ({ startAgent: true }),
			onScopeReplaced: () => () => undefined,
			endpoints: { session: () => null, kindUnavailable: () => null, pinnedPaneIds: () => [] },
			showGetStarted: () => false,
			herdrVaultPath: () => '/vault',
			actions: { startAgentHere: () => Promise.resolve(null) },
		};
		const { el, host } = hostEl();
		const listView = new view.AgentListView({} as never, plugin as never);
		Object.assign(listView, { contentEl: host });
		return { listView, el, probes: () => probes };
	}

	it('starts no probe from building the toolbar or from any repaint', async () => {
		const { listView, probes } = mounted();
		await (listView as unknown as { onOpen(): Promise<void> }).onOpen();
		const render = (listView as unknown as { render(): void }).render.bind(listView);
		render();
		render();
		await settle();
		expect(probes()).toBe(0);
	});

	it('opens the catalog menu from the context-menu key under the button, after the probe it waited on', async () => {
		const { listView, el, probes } = mounted();
		await (listView as unknown as { onOpen(): Promise<void> }).onOpen();
		const start = el.find('herdr-start-agent-button');
		Object.assign(start, { getBoundingClientRect: () => ({ left: 40, bottom: 28 }) });
		Menu.shown = [];
		// As a browser has it: `currentTarget` is null once the dispatch is over.
		// The button's own listener, which stops the event short of the rows'.
		for (const listener of start.listeners.filter((entry) => entry.type === 'contextmenu')) {
			listener.handler({ clientX: 0, clientY: 0, currentTarget: null, preventDefault: () => undefined, stopPropagation: () => undefined });
		}
		await settle();
		expect(probes()).toBe(1);
		expect(Menu.shown).toHaveLength(1);
		expect(Menu.shown[0]?.position).toEqual({ x: 40, y: 28 });
		expect(Menu.shown[0]?.items.map((item) => item.title)).toEqual(['Codex']);
	});
});

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

