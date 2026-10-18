/**
 * Follow active note (issue #78): what a focused note asks for. The matching
 * itself is `chooseFollowPane`, covered in `terminalPlacement.test.ts`; what
 * is held here is the follower around it — the guards from the issue (off by
 * default, non-markdown, no owner, same owner again, terminal already on
 * screen) and that it does what a row click does, in either setting.
 */

import { describe, expect, it } from 'vitest';
import {
	NoteFollower,
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
