/**
 * Row dispatch (issue #82): what an event on an agent row does.
 *
 * The dispatcher is driven here with a fake host and fake elements — no
 * `ItemView`, no document — which is the point of the split: the list view is
 * left binding three listeners and drawing rows, and every decision behind a
 * click, a right-click or a key is checked without Obsidian.
 *
 * The case that gave the issue its name is the last one: rename and close wait
 * on a modal, and the herdr underneath can change while it is open. An answer
 * that arrives after an endpoint switch or a reconnect is dropped, because
 * pane ids repeat across herdrs and the same id on the other endpoint is
 * somebody else's agent.
 */

import { describe, expect, it } from 'vitest';
import {
	RowDispatcher,
	STALE_TARGET_NOTICE,
	type PaneRef,
	type RowDispatchHost,
	type RowPane,
	type RowTarget,
} from '../src/views/rowDispatch';
import type { RowMenuItem } from '../src/views/rowMenu';
import type { RowClickAction } from '../src/views/rowModel';

const LOCAL = 'local';
const REMOTE = 'ssh:lasse@xl:/home/lasse/.config/herdr/herdr.sock';

/* ------------------------------------------------------------------ fakes */

/** A stand-in for an element: only `closest` and `dataset` are ever read. */
interface FakeElement {
	dataset: Record<string, string | undefined>;
	parent: FakeElement | null;
	closest(selector: string): FakeElement | null;
}

const ATTRIBUTE: Record<string, string> = {
	'[data-pane-id]': 'paneId',
	'[data-herdr-action]': 'herdrAction',
};

function element(
	dataset: Record<string, string | undefined> = {},
	parent: FakeElement | null = null,
): FakeElement {
	const el: FakeElement = {
		dataset,
		parent,
		closest(selector) {
			const key = ATTRIBUTE[selector];
			for (let node: FakeElement | null = el; node; node = node.parent) {
				if (key && node.dataset[key] !== undefined) return node;
			}
			return null;
		},
	};
	return el;
}

/** A row as the view draws it: the row div, its text and its action button. */
function row(paneId: string, buttonAction: RowClickAction = 'focus') {
	const rowEl = element({ paneId });
	return {
		row: rowEl,
		/** The row body, where a plain click lands. */
		text: element({}, rowEl),
		/** The icon button, which records the action it was drawn with. */
		button: element({ herdrAction: buttonAction }, rowEl),
		/** The Lucide glyph inside the button; a real click target (issue #21). */
		glyph: element({}, element({ herdrAction: buttonAction }, rowEl)),
	};
}

interface FakeEvent {
	target: unknown;
	/** Empty for a pointer event; the dispatcher only reads it on keydown. */
	key: string;
	prevented: number;
	preventDefault(): void;
}

function event(target: unknown, key?: string): FakeEvent {
	return {
		target,
		key: key ?? '',
		prevented: 0,
		preventDefault() {
			this.prevented++;
		},
	};
}

function pane(overrides: Partial<RowPane> = {}): RowPane {
	return { paneId: 'w4:p3', name: 'notes', title: 'nvim notes.md', ...overrides };
}

interface Fake {
	host: RowDispatchHost<FakeEvent>;
	dispatch: RowDispatcher<FakeEvent>;
	/** Every effect that reached the host, in order, with the ref it carried. */
	calls: { effect: string; ref?: PaneRef; extra?: unknown }[];
	notices: string[];
	menus: { items: RowMenuItem[]; choose: (item: RowMenuItem) => void }[];
	target: RowTarget;
	pins: Set<string>;
	/** Answers the two modals give; a promise so the test can move the world. */
	renameAnswer: () => Promise<string | null>;
	closeAnswer: () => Promise<boolean>;
	setRename(answer: () => Promise<string | null>): void;
	setClose(answer: () => Promise<boolean>): void;
	/** Resolved pane per id; missing means the connection does not know it. */
	panes: Map<string, RowPane>;
	closeResult: boolean;
	rowClick: RowClickAction;
}

function fake(options: { rowClick?: RowClickAction; panes?: RowPane[]; pins?: string[] } = {}): Fake {
	const state: Fake = {
		host: null as unknown as RowDispatchHost<FakeEvent>,
		dispatch: null as unknown as RowDispatcher<FakeEvent>,
		calls: [],
		notices: [],
		menus: [],
		target: { endpointId: LOCAL, connection: { generation: 1 } },
		pins: new Set(options.pins ?? []),
		renameAnswer: () => Promise.resolve(null),
		closeAnswer: () => Promise.resolve(false),
		setRename(answer) {
			state.renameAnswer = answer;
		},
		setClose(answer) {
			state.closeAnswer = answer;
		},
		panes: new Map((options.panes ?? [pane()]).map((entry) => [entry.paneId, entry])),
		closeResult: true,
		rowClick: options.rowClick ?? 'terminal',
	};
	const key = (ref: PaneRef): string => `${ref.endpointId}|${ref.paneId}`;
	state.host = {
		target: () => state.target,
		pane: (paneId) => state.panes.get(paneId) ?? null,
		rowClick: () => state.rowClick,
		pinned: (ref) => state.pins.has(key(ref)),
		setPinned: async (ref, pinned) => {
			state.calls.push({ effect: 'setPinned', ref, extra: pinned });
			if (pinned) state.pins.add(key(ref));
			else state.pins.delete(key(ref));
			await Promise.resolve();
		},
		openTerminal: (ref) => state.calls.push({ effect: 'openTerminal', ref }),
		focusPane: (ref) => state.calls.push({ effect: 'focusPane', ref }),
		renameAgent: async (ref, name) => {
			state.calls.push({ effect: 'renameAgent', ref, extra: name });
			await Promise.resolve();
		},
		closePane: async (ref) => {
			state.calls.push({ effect: 'closePane', ref });
			await Promise.resolve();
			return state.closeResult;
		},
		showRowMenu: (menuEvent, items, choose) => {
			state.calls.push({ effect: 'showRowMenu', extra: menuEvent });
			state.menus.push({ items, choose });
		},
		promptRename: (text) => {
			state.calls.push({ effect: 'promptRename', extra: text });
			return state.renameAnswer();
		},
		confirmClose: (text) => {
			state.calls.push({ effect: 'confirmClose', extra: text });
			return state.closeAnswer();
		},
		refreshList: () => state.calls.push({ effect: 'refreshList' }),
		notice: (message) => {
			state.notices.push(message);
			state.calls.push({ effect: 'notice', extra: message });
		},
	};
	state.dispatch = new RowDispatcher<FakeEvent>(state.host);
	return state;
}

/** Effects only, for asserting that nothing else happened. */
const effects = (world: Fake): string[] => world.calls.map((call) => call.effect);

/** Runs the menu entry with that action, as choosing it in the `Menu` does. */
async function choose(world: Fake, action: RowMenuItem['action']): Promise<void> {
	const menu = world.menus[world.menus.length - 1];
	expect(menu).toBeDefined();
	const item = menu?.items.find((entry) => entry.action === action);
	expect(item).toBeDefined();
	if (menu && item) menu.choose(item);
	// The dispatcher's menu callback is fire and forget, exactly as the `Menu`
	// calls it, so the effects land over the next few microtasks. Draining them
	// beats a timer: nothing here waits on anything real.
	for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

/* ------------------------------------------------------------- activation */

describe('click on a row', () => {
	it('opens the terminal for the pane on the connected endpoint', () => {
		const world = fake();
		const target = row('w4:p3');
		const click = event(target.text);
		world.dispatch.click(click);
		expect(click.prevented).toBe(1);
		expect(world.calls).toEqual([
			{ effect: 'openTerminal', ref: { endpointId: LOCAL, paneId: 'w4:p3' } },
		]);
	});

	it('focuses the pane instead when the setting swaps the pair', () => {
		const world = fake({ rowClick: 'focus' });
		world.dispatch.click(event(row('w4:p3').text));
		expect(world.calls).toEqual([
			{ effect: 'focusPane', ref: { endpointId: LOCAL, paneId: 'w4:p3' } },
		]);
	});

	it('runs the action the button was drawn with, not the current setting', () => {
		const world = fake();
		const target = row('w4:p3', 'focus');
		// The setting flips after the repaint that drew the button.
		world.rowClick = 'focus';
		world.dispatch.click(event(target.button));
		expect(world.calls).toEqual([
			{ effect: 'focusPane', ref: { endpointId: LOCAL, paneId: 'w4:p3' } },
		]);
	});

	it('resolves a click on the button’s SVG glyph to the row and the button', () => {
		const world = fake();
		world.dispatch.click(event(row('w4:p3', 'focus').glyph));
		expect(world.calls).toEqual([
			{ effect: 'focusPane', ref: { endpointId: LOCAL, paneId: 'w4:p3' } },
		]);
	});

	it('keys the effect by the endpoint the list is showing', () => {
		const world = fake();
		world.target = { endpointId: REMOTE, connection: { generation: 7 } };
		world.dispatch.click(event(row('w4:p3').text));
		expect(world.calls).toEqual([
			{ effect: 'openTerminal', ref: { endpointId: REMOTE, paneId: 'w4:p3' } },
		]);
	});

	it('ignores a click that missed every row, leaving the browser alone', () => {
		const world = fake();
		const click = event(element({}));
		world.dispatch.click(click);
		expect(click.prevented).toBe(0);
		expect(world.calls).toEqual([]);
	});

	it('ignores a target that is not an element at all', () => {
		const world = fake();
		world.dispatch.click(event(null));
		world.dispatch.click(event({}));
		expect(world.calls).toEqual([]);
	});

	it('still acts on a stale row, letting herdr report a pane that is gone', () => {
		// The row was drawn by an earlier repaint and its pane has since left the
		// scope. The click is what the user asked for, so it is sent and the
		// failure is reported where every other failure is; the scope is not
		// consulted at all on this path.
		const world = fake({ panes: [] });
		world.dispatch.click(event(row('w4:gone').text));
		expect(world.calls).toEqual([
			{ effect: 'openTerminal', ref: { endpointId: LOCAL, paneId: 'w4:gone' } },
		]);
	});
});

describe('keyboard activation', () => {
	it('fires exactly once for Enter on a row', () => {
		const world = fake();
		const key = event(row('w4:p3').text, 'Enter');
		world.dispatch.keyDown(key);
		expect(world.calls).toHaveLength(1);
		// Also what stops the browser turning Enter into a second click.
		expect(key.prevented).toBe(1);
	});

	it('fires exactly once for Enter on the icon button, with the button’s action', () => {
		const world = fake();
		const key = event(row('w4:p3', 'focus').button, 'Enter');
		world.dispatch.keyDown(key);
		expect(world.calls).toEqual([
			{ effect: 'focusPane', ref: { endpointId: LOCAL, paneId: 'w4:p3' } },
		]);
		expect(key.prevented).toBe(1);
	});

	it('treats Space like Enter and every other key like nothing', () => {
		const world = fake();
		world.dispatch.keyDown(event(row('w4:p3').text, ' '));
		expect(world.calls).toHaveLength(1);
		for (const key of ['a', 'Tab', 'Escape', 'ArrowDown']) {
			const pressed = event(row('w4:p3').text, key);
			world.dispatch.keyDown(pressed);
			expect(pressed.prevented).toBe(0);
		}
		expect(world.calls).toHaveLength(1);
	});
});

/* ------------------------------------------------------------- row menu */

describe('the row menu', () => {
	it('offers pin, rename and terminate for an unpinned row', () => {
		const world = fake();
		const contextMenu = event(row('w4:p3').text);
		world.dispatch.contextMenu(contextMenu);
		expect(contextMenu.prevented).toBe(1);
		const menu = world.menus[0];
		expect(menu?.items.map((item) => item.action)).toEqual(['pin', 'rename', 'close']);
		expect(menu?.items.map((item) => item.warning)).toEqual([false, false, true]);
		expect(world.calls.map((call) => call.effect)).toEqual(['showRowMenu']);
	});

	it('offers unpin for a row pinned on this endpoint', () => {
		const world = fake({ pins: [`${LOCAL}|w4:p3`] });
		world.dispatch.contextMenu(event(row('w4:p3').text));
		expect(world.menus[0]?.items[0]?.action).toBe('unpin');
	});

	it('reads the pin from the endpoint the row is on, not from the pane id alone', () => {
		const world = fake({ pins: [`${REMOTE}|w4:p3`] });
		world.dispatch.contextMenu(event(row('w4:p3').text));
		expect(world.menus[0]?.items[0]?.action).toBe('pin');
	});

	it('leaves the browser menu alone outside a row', () => {
		const world = fake();
		const contextMenu = event(element({}));
		world.dispatch.contextMenu(contextMenu);
		expect(contextMenu.prevented).toBe(0);
		expect(world.menus).toEqual([]);
	});

	it('draws no menu for a row the connection no longer knows', () => {
		const world = fake({ panes: [] });
		const contextMenu = event(row('w4:gone').text);
		world.dispatch.contextMenu(contextMenu);
		expect(contextMenu.prevented).toBe(0);
		expect(world.menus).toEqual([]);
	});

	it('names the agent in both modals the way the row names it', async () => {
		const world = fake({ panes: [pane({ name: '', title: 'nvim notes.md' })] });
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'close');
		const confirm = world.calls.find((call) => call.effect === 'confirmClose')?.extra as {
			title: string;
		};
		// Falls back to the stripped title, as `agentDisplayName` does.
		expect(confirm.title).toBe('Terminate "nvim notes.md"?');
	});

	it('starts the rename prompt from the agent’s own name', async () => {
		const world = fake({ panes: [pane({ name: 'notes' })] });
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'rename');
		const prompt = world.calls.find((call) => call.effect === 'promptRename')?.extra as {
			initial: string;
		};
		expect(prompt.initial).toBe('notes');
	});
});

describe('pinning from the menu', () => {
	it('pins the row on its endpoint and repaints every list', async () => {
		const world = fake();
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'pin');
		expect(world.calls.slice(1)).toEqual([
			{ effect: 'setPinned', ref: { endpointId: LOCAL, paneId: 'w4:p3' }, extra: true },
			{ effect: 'refreshList' },
		]);
		expect(world.pins.has(`${LOCAL}|w4:p3`)).toBe(true);
	});

	it('unpins a pinned row', async () => {
		const world = fake({ pins: [`${LOCAL}|w4:p3`] });
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'unpin');
		expect(world.pins.has(`${LOCAL}|w4:p3`)).toBe(false);
	});

	it('writes to the endpoint the menu was opened on, not the one now shown', async () => {
		const world = fake();
		world.dispatch.contextMenu(event(row('w4:p3').text));
		// The toolbar toggle switched the list while the menu was open.
		world.target = { endpointId: REMOTE, connection: { generation: 2 } };
		await choose(world, 'pin');
		expect(world.pins.has(`${LOCAL}|w4:p3`)).toBe(true);
		expect(world.pins.has(`${REMOTE}|w4:p3`)).toBe(false);
	});
});

/* -------------------------------------------------- rename and terminate */

describe('rename', () => {
	it('sends the name the prompt returned', async () => {
		const world = fake();
		world.setRename(() => Promise.resolve('notes-2'));
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'rename');
		expect(world.calls.at(-1)).toEqual({
			effect: 'renameAgent',
			ref: { endpointId: LOCAL, paneId: 'w4:p3' },
			extra: 'notes-2',
		});
	});

	it('does nothing when the prompt is cancelled', async () => {
		const world = fake();
		world.setRename(() => Promise.resolve(null));
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'rename');
		expect(effects(world)).toEqual(['showRowMenu', 'promptRename']);
	});
});

describe('terminate', () => {
	it('closes the pane once the confirmation is given', async () => {
		const world = fake();
		world.setClose(() => Promise.resolve(true));
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'close');
		expect(effects(world)).toEqual(['showRowMenu', 'confirmClose', 'closePane']);
	});

	it('does nothing when the confirmation is declined', async () => {
		const world = fake();
		world.setClose(() => Promise.resolve(false));
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'close');
		expect(effects(world)).toEqual(['showRowMenu', 'confirmClose']);
	});

	it('drops the pin of a pane it closed, since the id never comes back', async () => {
		const world = fake({ pins: [`${LOCAL}|w4:p3`] });
		world.setClose(() => Promise.resolve(true));
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'close');
		expect(world.calls.at(-1)).toEqual({
			effect: 'setPinned',
			ref: { endpointId: LOCAL, paneId: 'w4:p3' },
			extra: false,
		});
		expect(world.pins.size).toBe(0);
	});

	it('keeps the pin when herdr refused to close the pane', async () => {
		const world = fake({ pins: [`${LOCAL}|w4:p3`] });
		world.setClose(() => Promise.resolve(true));
		world.closeResult = false;
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'close');
		expect(effects(world)).toEqual(['showRowMenu', 'confirmClose', 'closePane']);
		expect(world.pins.has(`${LOCAL}|w4:p3`)).toBe(true);
	});
});

/* ------------------------------------------- the endpoint under a modal */

describe('an answer that arrives after the herdr underneath changed', () => {
	/** The same pane id, live on the other herdr, must come through untouched. */
	const otherEndpoint = (): RowTarget => ({ endpointId: REMOTE, connection: { generation: 2 } });
	/** A reconnect to the same herdr: same endpoint, a new connection. */
	const reconnected = (): RowTarget => ({ endpointId: LOCAL, connection: { generation: 2 } });

	it('drops a rename confirmed after the endpoint switched, with a notice', async () => {
		const world = fake();
		world.setRename(() => {
			world.target = otherEndpoint();
			return Promise.resolve('notes-2');
		});
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'rename');
		expect(effects(world)).toEqual(['showRowMenu', 'promptRename', 'notice']);
		expect(world.notices).toEqual([STALE_TARGET_NOTICE]);
	});

	it('drops a rename confirmed after the connection was replaced', async () => {
		const world = fake();
		world.setRename(() => {
			world.target = reconnected();
			return Promise.resolve('notes-2');
		});
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'rename');
		expect(effects(world)).toEqual(['showRowMenu', 'promptRename', 'notice']);
	});

	it('drops a terminate confirmed after the endpoint switched, with a notice', async () => {
		const world = fake();
		world.setClose(() => {
			world.target = otherEndpoint();
			return Promise.resolve(true);
		});
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'close');
		expect(effects(world)).toEqual(['showRowMenu', 'confirmClose', 'notice']);
		expect(world.notices).toEqual([STALE_TARGET_NOTICE]);
	});

	it('drops a terminate confirmed after the connection was replaced', async () => {
		const world = fake();
		world.setClose(() => {
			world.target = reconnected();
			return Promise.resolve(true);
		});
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'close');
		expect(effects(world)).toEqual(['showRowMenu', 'confirmClose', 'notice']);
	});

	it('drops it when the connection went away entirely', async () => {
		const world = fake();
		world.setClose(() => {
			world.target = { endpointId: LOCAL, connection: null };
			return Promise.resolve(true);
		});
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'close');
		expect(effects(world)).toEqual(['showRowMenu', 'confirmClose', 'notice']);
	});

	it('never touches the same pane id on the endpoint that took over', async () => {
		const world = fake();
		world.setClose(() => {
			world.target = otherEndpoint();
			return Promise.resolve(true);
		});
		world.setRename(() => {
			world.target = otherEndpoint();
			return Promise.resolve('notes-2');
		});
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'close');
		world.target = { endpointId: LOCAL, connection: { generation: 1 } };
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'rename');
		expect(world.calls.filter((call) => call.ref)).toEqual([]);
		expect(world.pins.size).toBe(0);
	});

	it('goes ahead when nothing moved while the modal was open', async () => {
		const world = fake();
		const unchanged = world.target;
		world.setRename(() => {
			// A new object with the same identity contract must not count as a
			// change: it is the very same connection.
			world.target = { ...unchanged };
			return Promise.resolve('notes-2');
		});
		world.dispatch.contextMenu(event(row('w4:p3').text));
		await choose(world, 'rename');
		expect(world.calls.at(-1)?.effect).toBe('renameAgent');
		expect(world.notices).toEqual([]);
	});
});
