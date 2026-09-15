/**
 * What a click on an agent row does to the workspace (issues #28, #38).
 *
 * `openTerminal` is the one place the pure decisions in `terminalPlacement.ts`
 * become `createLeafBySplit` or `getLeaf('tab')`, and the bug this file pins was
 * in neither of them: it was in which leaf the split is taken beside.
 *
 * The workspace here is a stand-in with Obsidian's own answers, read off the
 * app's implementation rather than guessed:
 *
 * - `getMostRecentLeaf()` is the most recently *activated visible* leaf of the
 *   main area, whatever view it holds — a terminal counts.
 * - `getActiveFile()` skips views that are not navigable, and a herdr terminal
 *   is one (`View.navigation` is false unless a view sets it), so it keeps
 *   naming the note the reader came from.
 * - `getLeaf('tab')` opens the tab in the most recent leaf's own tab group.
 *
 * The plugin is built with `Object.create` rather than `new`: `openTerminal`
 * needs the workspace, the settings and the scope, and nothing else, while a
 * real construction would start a connection coordinator.
 */

import { describe, expect, it } from 'vitest';
import HerdrPlugin from '../src/main';
import { HerdrActions, type ActionHost } from '../src/actions';
import { DEFAULT_SETTINGS, type HerdrSettings } from '../src/settings';
import { FileSystemAdapter } from './fixtures/obsidian';

const VAULT = '/home/lasse/hvelv';
const NOTE = 'projects/herdr/notes.md';
const CWD = `${VAULT}/projects/herdr`;
/** The tab and pane "Start agent here" creates for that same folder. */
const TAB = 't9';
const NEW_PANE = 'w2:pB';

/** A leaf as this test needs it: a name, the state it persists, a recorder. */
interface FakeLeaf {
	name: string;
	state: Record<string, unknown>;
	getViewState(): { state: Record<string, unknown> };
	setViewState(state: unknown): Promise<void>;
}

function leaf(name: string, state: Record<string, unknown>): FakeLeaf {
	return {
		name,
		state,
		getViewState: () => ({ state }),
		setViewState: async (next: unknown) => {
			Object.assign(state, next as Record<string, unknown>);
		},
	};
}

interface Harness {
	plugin: HerdrPlugin;
	/** Every leaf the plugin asked the workspace for, in order. */
	calls: string[];
	noteLeaf: FakeLeaf;
	terminalLeaf: FakeLeaf;
	/** Every JSON API method the plugin's action host sent, in order. */
	requests: string[];
}

function harness(options: {
	/** Which leaf was activated last; a terminal once one has been attached. */
	mostRecent: 'note' | 'terminal';
	settings?: Partial<HerdrSettings>;
	/**
	 * What the scope answers for the pane being opened. `null` is a pane the
	 * scope has not admitted yet, which is every pane an agent was just started
	 * in: membership comes from `pane.agent_detected` plus a `pane.list` round
	 * trip, and `agent.start` returns before either.
	 */
	scopeCwd?: string | null;
}): Harness {
	const calls: string[] = [];
	const noteLeaf = leaf('note', { file: NOTE, mode: 'source' });
	const terminalLeaf = leaf('terminal', {
		paneId: 'w2:pA',
		mode: 'control',
		endpointId: 'local',
	});
	const placed = leaf('placed', {});
	const workspace = {
		getActiveViewOfType: () => null,
		getLeavesOfType: (type: string) => (type === 'herdr-terminal' ? [terminalLeaf] : []),
		getActiveFile: () => ({ path: NOTE }),
		getMostRecentLeaf: () => (options.mostRecent === 'note' ? noteLeaf : terminalLeaf),
		iterateRootLeaves: (callback: (value: FakeLeaf) => void) => {
			for (const each of [noteLeaf, terminalLeaf]) callback(each);
		},
		createLeafBySplit: (source: FakeLeaf, direction: string, before: boolean) => {
			calls.push(`split ${direction} of ${source.name} before=${before}`);
			return placed;
		},
		getLeaf: (kind: string) => {
			calls.push(`tab (${kind})`);
			return placed;
		},
		revealLeaf: async (target: FakeLeaf) => {
			calls.push(`reveal ${target.name}`);
		},
	};
	const adapter = Object.create(FileSystemAdapter.prototype) as { getBasePath(): string };
	adapter.getBasePath = () => VAULT;
	const requests: string[] = [];
	const cwd = options.scopeCwd === undefined ? CWD : options.scopeCwd;
	const plugin = Object.create(HerdrPlugin.prototype) as Record<string, unknown>;
	plugin.app = { workspace, vault: { adapter, getName: () => 'hvelv' } };
	plugin.settings = { ...DEFAULT_SETTINGS, ...options.settings };
	plugin.connection = {
		current: {
			endpoint: { id: 'local' },
			client: {
				request: async (method: string) => {
					requests.push(method);
					switch (method) {
						case 'tab.create':
							return { tab: { tab_id: TAB }, root_pane: { pane_id: NEW_PANE } };
						case 'pane.list':
							return { panes: [{ pane_id: NEW_PANE, tab_id: TAB }] };
						default:
							return {};
					}
				},
			},
			scope: {
				get: (paneId: string) => (cwd === null ? undefined : { paneId, cwd }),
				list: () => [],
				agentNames: () => new Set<string>(),
				workspaceId: 'w2',
			},
		},
	};
	return { plugin: plugin as unknown as HerdrPlugin, calls, noteLeaf, terminalLeaf, requests };
}

describe('openTerminal places a new terminal (issue #28)', () => {
	it('splits beside the note the reader is in', async () => {
		const { plugin, calls } = harness({ mostRecent: 'note' });
		await plugin.openTerminal('w2:pB');
		expect(calls).toEqual(['split vertical of note before=false', 'reveal placed']);
	});

	it('still splits beside the note once a terminal is the most recent leaf', async () => {
		// The reported regression: the first terminal focuses its renderer and so
		// becomes the most recent leaf, and every agent clicked after that landed
		// in a tab of that terminal's group instead of a split beside the note.
		const { plugin, calls } = harness({ mostRecent: 'terminal' });
		await plugin.openTerminal('w2:pB');
		expect(calls).toEqual(['split vertical of note before=false', 'reveal placed']);
	});

	it('splits on the left when the setting says so', async () => {
		const { plugin, calls } = harness({
			mostRecent: 'terminal',
			settings: { terminalPlacement: 'split-left' },
		});
		await plugin.openTerminal('w2:pB');
		expect(calls).toEqual(['split vertical of note before=true', 'reveal placed']);
	});

	it('takes a tab when the note is outside the agent’s directory', async () => {
		// Unchanged by the fix: what a split is taken *beside* is a different
		// question from whether there is one at all.
		const { plugin, calls } = harness({
			mostRecent: 'note',
			settings: { remote: { ...DEFAULT_SETTINGS.remote } },
		});
		(plugin as unknown as { connection: { current: { scope: unknown } } }).connection.current.scope =
			{
				get: (paneId: string) => ({ paneId, cwd: '/home/lasse/code/elsewhere' }),
			};
		await plugin.openTerminal('w2:pB');
		expect(calls).toEqual(['tab (tab)', 'reveal placed']);
	});

	it('reveals this pane’s own terminal instead of placing a second one', async () => {
		const { plugin, calls } = harness({ mostRecent: 'note' });
		await plugin.openTerminal('w2:pA');
		expect(calls).toEqual(['reveal terminal']);
	});
});

describe('starting an agent from a folder places its terminal the same way (#28)', () => {
	it('splits beside the note although the scope has not admitted the pane yet', async () => {
		// The reported bug: "Start agent here" from the explorer's hover button
		// filled the main area, while "Attach" on the same folder split beside the
		// note. The placement is the same call for both; only the cwd differed,
		// because `agent.start` returns before the scope has a state for the pane
		// it just created, and a pane with no cwd cannot contain the note.
		const { plugin, calls, requests } = harness({ mostRecent: 'note', scopeCwd: null });
		const host = (plugin as unknown as { actionHost(): ActionHost }).actionHost();
		await new HerdrActions(host).startAgentHere(CWD);
		expect(requests).toContain('agent.start');
		expect(calls).toEqual(['split vertical of note before=false', 'reveal placed']);
	});

	it('still takes a tab when the folder does not contain the note', async () => {
		const { plugin, calls } = harness({ mostRecent: 'note', scopeCwd: null });
		const host = (plugin as unknown as { actionHost(): ActionHost }).actionHost();
		await new HerdrActions(host).startAgentHere('/home/lasse/code/elsewhere');
		expect(calls).toEqual(['tab (tab)', 'reveal placed']);
	});
});
