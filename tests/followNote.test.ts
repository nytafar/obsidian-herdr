/**
 * Follow active note (issue #78): what a focused note asks for. The matching
 * itself is `chooseFollowPane`, covered in `terminalPlacement.test.ts`; what
 * is held here is the follower around it — the guards from the issue (off by
 * default, non-markdown, no owner, same owner again, terminal already on
 * screen) and that it does what a row click does, in either setting.
 */

import { describe, expect, it } from 'vitest';
import type HerdrPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/settings';
import {
	NoteFollower,
	registerNoteFollow,
	type FollowPane,
	type NoteFollowerOptions,
	type TerminalPresence,
} from '../src/followNote';
import type { RowClickAction } from '../src/views/rowModel';

const VAULT = '/Users/lasse/Vaults/hvelv';
const NOTE_LEAF = { name: 'note leaf' };

interface World {
	follower: NoteFollower<typeof NOTE_LEAF>;
	calls: string[];
	set(change: Partial<State>): void;
}

interface State {
	enabled: boolean;
	rowClick: RowClickAction;
	panes: FollowPane[] | null;
	presence: TerminalPresence;
	pinned: string[];
	endpointId: string;
}

function world(initial: Partial<State> = {}): World {
	const state: State = {
		enabled: true,
		rowClick: 'terminal',
		panes: [
			{ paneId: 'cacao', cwd: `${VAULT}/inputs/corpora/silva-cacao`, focused: false },
			{ paneId: 'efforts', cwd: `${VAULT}/efforts`, focused: false },
		],
		presence: 'none',
		pinned: [],
		endpointId: 'local',
		...initial,
	};
	const calls: string[] = [];
	const options: NoteFollowerOptions<typeof NOTE_LEAF> = {
		enabled: () => state.enabled,
		minDepth: () => 2,
		rowClick: () => state.rowClick,
		vaultPath: () => VAULT,
		endpointId: () => state.endpointId,
		panes: () => state.panes,
		pinned: (paneId) => state.pinned.includes(paneId),
		focusRank: () => 0,
		terminalPresence: () => state.presence,
		openTerminalQuietly: async (paneId, leaf) => {
			calls.push(`open:${paneId}:${leaf.name}`);
			await Promise.resolve();
		},
		focusPane: (paneId) => calls.push(`focus:${paneId}`),
	};
	return {
		follower: new NoteFollower(options),
		calls,
		set: (change) => Object.assign(state, change),
	};
}

const CACAO_NOTE = 'inputs/corpora/silva-cacao/harvest.md';
const CACAO_OTHER = 'inputs/corpora/silva-cacao/sub/roast.md';

describe('NoteFollower', () => {
	it('opens the owning agent’s terminal beside the note, quietly', async () => {
		const w = world();
		await w.follower.noteFocused(CACAO_NOTE, NOTE_LEAF);
		expect(w.calls).toEqual(['open:cacao:note leaf']);
	});

	it('focuses the pane in herdr when that is what a row click does', async () => {
		const w = world({ rowClick: 'focus' });
		await w.follower.noteFocused(CACAO_NOTE, NOTE_LEAF);
		expect(w.calls).toEqual(['focus:cacao']);
	});

	it('does not focus a pane herdr already has focused', async () => {
		const w = world({
			rowClick: 'focus',
			panes: [{ paneId: 'cacao', cwd: `${VAULT}/inputs/corpora/silva-cacao`, focused: true }],
		});
		await w.follower.noteFocused(CACAO_NOTE, NOTE_LEAF);
		expect(w.calls).toEqual([]);
	});

	it('does nothing while the setting is off, which is the default', async () => {
		const w = world({ enabled: false });
		await w.follower.noteFocused(CACAO_NOTE, NOTE_LEAF);
		expect(w.calls).toEqual([]);
	});

	it('does nothing for non-markdown files, notes nobody owns, shallow owners or no connection', async () => {
		const w = world();
		await w.follower.noteFocused('inputs/corpora/silva-cacao/map.canvas', NOTE_LEAF);
		await w.follower.noteFocused('inbox/today.md', NOTE_LEAF);
		// `efforts/` is one folder deep, below the default minimum of two.
		await w.follower.noteFocused('efforts/plan.md', NOTE_LEAF);
		w.set({ panes: null });
		await w.follower.noteFocused(CACAO_NOTE, NOTE_LEAF);
		expect(w.calls).toEqual([]);
	});

	it('does not trigger again for another note of the same agent', async () => {
		const w = world();
		await w.follower.noteFocused(CACAO_NOTE, NOTE_LEAF);
		await w.follower.noteFocused(CACAO_OTHER, NOTE_LEAF);
		await w.follower.noteFocused(CACAO_NOTE, NOTE_LEAF);
		expect(w.calls).toEqual(['open:cacao:note leaf']);
	});

	it('follows again after a note nobody owns, or a switch to another agent', async () => {
		const w = world({
			panes: [
				{ paneId: 'cacao', cwd: `${VAULT}/inputs/corpora/silva-cacao`, focused: false },
				{ paneId: 'beans', cwd: `${VAULT}/inputs/corpora/beans`, focused: false },
			],
		});
		await w.follower.noteFocused(CACAO_NOTE, NOTE_LEAF);
		await w.follower.noteFocused('inbox/today.md', NOTE_LEAF);
		await w.follower.noteFocused(CACAO_NOTE, NOTE_LEAF);
		await w.follower.noteFocused('inputs/corpora/beans/a.md', NOTE_LEAF);
		expect(w.calls).toEqual(['open:cacao:note leaf', 'open:cacao:note leaf', 'open:beans:note leaf']);
	});

	it('leaves the layout alone when the terminal is already on screen', async () => {
		const w = world({ presence: 'shown' });
		await w.follower.noteFocused(CACAO_NOTE, NOTE_LEAF);
		expect(w.calls).toEqual([]);
	});

	it('reveals a terminal that is open but hidden', async () => {
		const w = world({ presence: 'hidden' });
		await w.follower.noteFocused(CACAO_NOTE, NOTE_LEAF);
		expect(w.calls).toEqual(['open:cacao:note leaf']);
	});

	it('treats the same pane id on another herdr as another agent', async () => {
		const w = world();
		await w.follower.noteFocused(CACAO_NOTE, NOTE_LEAF);
		w.set({ endpointId: 'ssh:lasse@xl:/home/lasse/.config/herdr/herdr.sock' });
		await w.follower.noteFocused(CACAO_OTHER, NOTE_LEAF);
		expect(w.calls).toEqual(['open:cacao:note leaf', 'open:cacao:note leaf']);
	});

	it('breaks a tie of depth with the pin', async () => {
		const folder = `${VAULT}/inputs/corpora/silva-cacao`;
		const w = world({
			panes: [
				{ paneId: 'first', cwd: folder, focused: false },
				{ paneId: 'pinned', cwd: folder, focused: false },
			],
			pinned: ['pinned'],
		});
		await w.follower.noteFocused(CACAO_NOTE, NOTE_LEAF);
		expect(w.calls).toEqual(['open:pinned:note leaf']);
	});
});

describe('registerNoteFollow, the wiring on the workspace', () => {
	const CACAO = `${VAULT}/inputs/corpora/silva-cacao`;

	/** A leaf as the wiring reads it: persisted state, root and `isShown`. */
	interface WiredLeaf {
		name: string;
		isDeferred: boolean;
		shown: boolean;
		root: object;
		viewState: { type: string; state?: Record<string, unknown> };
		view: { containerEl: { isShown(): boolean } };
		getViewState(): { type: string; state?: Record<string, unknown> };
		getRoot(): object;
	}

	function wiredLeaf(name: string, viewState: WiredLeaf['viewState'], root: object): WiredLeaf {
		const leaf: WiredLeaf = {
			name,
			isDeferred: false,
			shown: true,
			root,
			viewState,
			view: { containerEl: { isShown: () => leaf.shown } },
			getViewState: () => leaf.viewState,
			getRoot: () => leaf.root,
		};
		return leaf;
	}

	function wired(
		options: {
			/** What the open does to the layout, as a placement would. */
			onOpen?: 'take-active' | 'cover-note';
			/** A terminal for the cacao pane already open, and where. */
			terminal?: 'none' | 'shown' | 'background' | 'collapsed-sidebar';
		} = {},
	) {
		const calls: string[] = [];
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const main = { name: 'main' };
		const leftSplit = { collapsed: false };
		const noteLeaf = wiredLeaf('note', { type: 'markdown', state: { file: CACAO_NOTE } }, main);
		const listLeaf = wiredLeaf('list', { type: 'herdr-agent-list', state: {} }, leftSplit);
		const terminalLeaf = wiredLeaf(
			'terminal',
			{ type: 'herdr-terminal', state: { paneId: 'cacao', mode: 'control', endpointId: 'local' } },
			main,
		);
		const terminals: WiredLeaf[] = [];
		const presence = options.terminal ?? 'none';
		if (presence !== 'none') terminals.push(terminalLeaf);
		if (presence === 'background') terminalLeaf.shown = false;
		if (presence === 'collapsed-sidebar') {
			// `isShown` itself still says yes: only the sidebar's flag says no.
			terminalLeaf.root = leftSplit;
			leftSplit.collapsed = true;
		}
		let active: WiredLeaf | null = noteLeaf;
		const workspace = {
			leftSplit,
			rightSplit: { collapsed: false },
			on: (name: string, callback: (...args: unknown[]) => void) => {
				handlers.set(name, callback);
				return {};
			},
			getLeavesOfType: (type: string) => (type === 'herdr-terminal' ? terminals : []),
			getActiveViewOfType: () => (active ? { leaf: active } : null),
			setActiveLeaf: (leaf: WiredLeaf, params: { focus?: boolean }) => {
				calls.push(`setActiveLeaf:${leaf.name} focus=${String(params.focus)}`);
				active = leaf;
			},
		};
		const scope = {
			on: () => () => undefined,
			list: () => [{ paneId: 'cacao', cwd: CACAO, focused: false }],
		};
		const plugin = {
			app: { workspace },
			settings: { ...DEFAULT_SETTINGS, followActiveNote: true },
			scope,
			endpoint: { id: 'local' },
			register: () => undefined,
			registerEvent: () => undefined,
			onScopeReplaced: () => () => undefined,
			herdrVaultPath: () => VAULT,
			actions: { focusPane: async (paneId: string) => calls.push(`focus:${paneId}`) },
			openTerminal: async (paneId: string, _cwd: unknown, open: { focus?: boolean }) => {
				calls.push(`open:${paneId} focus=${String(open.focus)}`);
				if (!terminals.includes(terminalLeaf)) terminals.push(terminalLeaf);
				terminalLeaf.shown = true;
				terminalLeaf.root = main;
				leftSplit.collapsed = false;
				if (options.onOpen === 'take-active') active = terminalLeaf;
				if (options.onOpen === 'cover-note') noteLeaf.shown = false;
				await Promise.resolve();
			},
		};
		registerNoteFollow(plugin as unknown as HerdrPlugin);
		const settle = async (): Promise<void> => {
			for (let tick = 0; tick < 10; tick++) await Promise.resolve();
		};
		const activate = async (leaf: WiredLeaf | null): Promise<void> => {
			active = leaf;
			handlers.get('active-leaf-change')?.(leaf);
			await settle();
		};
		const openFile = async (path: string, extension: string): Promise<void> => {
			handlers.get('file-open')?.({ path, extension });
			await settle();
		};
		return { calls, activate, openFile, noteLeaf, listLeaf, terminalLeaf, main };
	}

	it('follows a markdown note becoming the active leaf, quietly', async () => {
		const w = wired();
		await w.activate(w.noteLeaf);
		expect(w.calls).toEqual(['open:cacao focus=false']);
	});

	it('says nothing when a terminal or the agent list comes to the front', async () => {
		const w = wired({ terminal: 'background' });
		await w.activate(w.terminalLeaf);
		await w.activate(w.listLeaf);
		await w.activate(null);
		expect(w.calls).toEqual([]);
	});

	it('follows another note opened in the same leaf through file-open', async () => {
		const w = wired();
		w.noteLeaf.viewState = { type: 'markdown', state: { file: CACAO_NOTE } };
		await w.openFile(CACAO_NOTE, 'md');
		expect(w.calls).toEqual(['open:cacao focus=false']);
	});

	it('ignores a pdf or a canvas, whether it becomes active or is opened', async () => {
		const w = wired();
		const pdfPath = 'inputs/corpora/silva-cacao/paper.pdf';
		const canvasPath = 'inputs/corpora/silva-cacao/map.canvas';
		const pdf = wiredLeaf('pdf', { type: 'pdf', state: { file: pdfPath } }, w.main);
		const canvas = wiredLeaf('canvas', { type: 'canvas', state: { file: canvasPath } }, w.main);
		await w.activate(pdf);
		await w.openFile(pdfPath, 'pdf');
		await w.activate(canvas);
		await w.openFile(canvasPath, 'canvas');
		expect(w.calls).toEqual([]);
	});

	it('hands the note its leaf back when the open moved it', async () => {
		const w = wired({ onOpen: 'take-active' });
		await w.activate(w.noteLeaf);
		expect(w.calls).toEqual(['open:cacao focus=false', 'setActiveLeaf:note focus=true']);
	});

	it('makes a terminal that covers the note active, without focusing it', async () => {
		const w = wired({ onOpen: 'cover-note' });
		await w.activate(w.noteLeaf);
		expect(w.calls).toEqual(['open:cacao focus=false', 'setActiveLeaf:terminal focus=false']);
	});

	it('leaves a terminal on screen alone', async () => {
		const w = wired({ terminal: 'shown' });
		await w.activate(w.noteLeaf);
		expect(w.calls).toEqual([]);
	});

	it.each<'background' | 'collapsed-sidebar'>(['background', 'collapsed-sidebar'])(
		'reveals a terminal in a %s, which is not on screen',
		async (terminal) => {
			const w = wired({ terminal });
			await w.activate(w.noteLeaf);
			expect(w.calls).toEqual(['open:cacao focus=false']);
		},
	);
});
