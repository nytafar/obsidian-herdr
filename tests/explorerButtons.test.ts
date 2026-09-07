/**
 * The folder hover button (issue #30). The injection itself needs a real file
 * explorer — an undocumented DOM this repo does not fake — so most of what is
 * tested here is every decision the class makes before it touches an element:
 * which menu a folder gets, which pane "Attach" opens, what a row's `data-path`
 * becomes on herdr's side of a remote profile, and the popout-safe element
 * check that guards the click handler.
 *
 * The last suite is the exception. Issue #74 moved the pointer listeners off
 * the explorer container and onto that container's own window, and the whole
 * point of that move — target, phase, which listener answers a click when two
 * explorers share a window, and how hard the event is stopped — is invisible to
 * a pure function. So the explorer, its window and the clicked element are
 * faked down to the handful of members the class actually calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	asElement,
	attachablePane,
	BUTTON_CLASS,
	CLAIM_ATTR,
	ExplorerFolderButtons,
	FOLDER_ROW_SELECTOR,
	folderAbsPath,
	FOLDER_BUTTON_KEYS,
	menuItemsFor,
	vaultRelativeLabel,
} from '../src/explorerButtons';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { PaneState } from '../src/herdr/scope';

// The `obsidian` stub's `Menu` is a bare class, and the wiring suite needs to
// know that a menu was opened and what it offered. One title list per menu
// shown; anything else about the menu is `menuItemsFor`'s business, above.
const shown = vi.hoisted(() => [] as string[][]);
vi.mock('obsidian', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	class FakeMenu {
		private readonly titles: string[] = [];
		addItem(build: (entry: unknown) => void): this {
			const entry = {
				setTitle: (title: string) => {
					this.titles.push(title);
					return entry;
				},
				setIcon: () => entry,
				onClick: () => entry,
			};
			build(entry);
			return this;
		}
		showAtMouseEvent(): this {
			shown.push([...this.titles]);
			return this;
		}
		showAtPosition(): this {
			shown.push([...this.titles]);
			return this;
		}
	}
	return { ...actual, Menu: FakeMenu };
});

function pane(paneId: string, cwd: string): PaneState {
	return {
		paneId,
		workspaceId: 'w1',
		tabId: 't1',
		agent: 'claude',
		name: paneId,
		agentStatus: 'idle',
		title: '',
		label: '',
		cwd,
		focused: false,
		tokens: {},
		statusChangedSeq: 0,
	};
}

const VAULT = '/Users/lasse/Vaults/hvelv';

describe('attachablePane', () => {
	it('finds an agent whose cwd is the folder itself', () => {
		const panes = [pane('p1', `${VAULT}/notes`)];
		expect(attachablePane(`${VAULT}/notes`, panes)?.paneId).toBe('p1');
	});

	it('finds an agent running below the folder', () => {
		const panes = [pane('p1', `${VAULT}/project/src`)];
		expect(attachablePane(`${VAULT}/project`, panes)?.paneId).toBe('p1');
	});

	it('prefers the agent in the folder itself over one further down', () => {
		const panes = [pane('deep', `${VAULT}/project/src`), pane('here', `${VAULT}/project`)];
		expect(attachablePane(`${VAULT}/project`, panes)?.paneId).toBe('here');
	});

	it('takes the first match among several below the folder', () => {
		const panes = [pane('first', `${VAULT}/p/a`), pane('second', `${VAULT}/p/b`)];
		expect(attachablePane(`${VAULT}/p`, panes)?.paneId).toBe('first');
	});

	it('ignores a sibling folder that merely shares a prefix', () => {
		const panes = [pane('p1', `${VAULT}/notes-archive`)];
		expect(attachablePane(`${VAULT}/notes`, panes)).toBeNull();
	});

	it('ignores an agent above the folder', () => {
		const panes = [pane('p1', VAULT)];
		expect(attachablePane(`${VAULT}/notes`, panes)).toBeNull();
	});

	it('compares trailing slashes away', () => {
		const panes = [pane('p1', `${VAULT}/notes/`)];
		expect(attachablePane(`${VAULT}/notes`, panes)?.paneId).toBe('p1');
	});

	it('answers null for no panes and for an empty folder path', () => {
		expect(attachablePane(`${VAULT}/notes`, [])).toBeNull();
		expect(attachablePane('', [pane('p1', VAULT)])).toBeNull();
	});
});

describe('menuItemsFor', () => {
	it('offers start and copy, in that order, when no agent runs there', () => {
		const items = menuItemsFor(`${VAULT}/notes`, []);
		expect(items.map((item) => item.title)).toEqual([
			'Start agent here',
			'Copy path from vault root',
		]);
		expect(items.map((item) => item.action.kind)).toEqual(['start', 'copy']);
	});

	it('puts attach first when an agent is live in the folder', () => {
		const items = menuItemsFor(`${VAULT}/notes`, [pane('p7', `${VAULT}/notes`)]);
		expect(items.map((item) => item.title)).toEqual([
			'Attach',
			'Start agent here',
			'Copy path from vault root',
		]);
		expect(items[0]?.action).toEqual({ kind: 'attach', paneId: 'p7' });
	});

	it('gives every entry an icon', () => {
		for (const item of menuItemsFor(`${VAULT}/notes`, [pane('p1', `${VAULT}/notes`)])) {
			expect(item.icon).not.toBe('');
		}
	});
});

describe('vaultRelativeLabel', () => {
	it('passes a folder path through', () => {
		expect(vaultRelativeLabel('notes/daily')).toBe('notes/daily');
	});

	it('answers / for the vault root row', () => {
		expect(vaultRelativeLabel('/')).toBe('/');
		expect(vaultRelativeLabel('')).toBe('/');
		expect(vaultRelativeLabel('.')).toBe('/');
	});

	it('drops a trailing slash and a leading ./', () => {
		expect(vaultRelativeLabel('notes/')).toBe('notes');
		expect(vaultRelativeLabel('./notes')).toBe('notes');
	});
});

describe('folderAbsPath', () => {
	it('resolves a row against the vault path herdr sees', () => {
		expect(folderAbsPath('notes/daily', VAULT)).toBe(`${VAULT}/notes/daily`);
	});

	it('resolves the root row to the vault itself, not to the filesystem root', () => {
		expect(folderAbsPath('/', VAULT)).toBe(VAULT);
	});

	it('uses the remote vault path when that is what the caller passes in', () => {
		expect(folderAbsPath('notes', '/home/lasse/hvelv')).toBe('/home/lasse/hvelv/notes');
	});
});

describe('asElement', () => {
	it('accepts anything that can answer closest, across window boundaries', () => {
		const target = { closest: () => null } as unknown as EventTarget;
		expect(asElement(target)).toBe(target);
	});

	it('rejects a null target and a non-element one', () => {
		expect(asElement(null)).toBeNull();
		expect(asElement({} as EventTarget)).toBeNull();
	});
});

describe('the DOM contract', () => {
	it('claims rows with the marker attribute the stylesheet keys off', () => {
		expect(CLAIM_ATTR).toBe('data-herdr-folder-button');
		expect(BUTTON_CLASS).toBe('herdr-folder-button');
		expect(FOLDER_ROW_SELECTOR).toBe('.nav-folder-title[data-path]');
	});

	it('opens the menu on the same keys a button activates on', () => {
		// The capture listener answers Enter and Space, which is what a `button`
		// fires a click for; the stylesheet's `:focus-visible` reveal is only
		// worth anything if the keyboard can reach the menu.
		expect(FOLDER_BUTTON_KEYS).toEqual(['Enter', ' ']);
	});
});

describe('the setting', () => {
	it('ships on', () => {
		expect(DEFAULT_SETTINGS.folderHoverButton).toBe(true);
	});
});

interface FakeListener {
	readonly type: string;
	readonly handler: (event: Event) => void;
	readonly capture: boolean;
}

interface FakeEvent {
	readonly target: object;
	defaultPrevented: boolean;
	stopped: boolean;
	immediateStopped: boolean;
	preventDefault(): void;
	stopPropagation(): void;
	stopImmediatePropagation(): void;
}

interface ListenerHost {
	readonly listeners: FakeListener[];
	addEventListener(type: string, handler: (event: Event) => void, capture?: boolean): void;
	removeEventListener(type: string, handler: (event: Event) => void, capture?: boolean): void;
	dispatch(type: string, event: FakeEvent): void;
}

/** An event target that records what was bound to it and can dispatch to it. */
function listenerHost(): ListenerHost {
	const listeners: FakeListener[] = [];
	return {
		listeners,
		addEventListener(type, handler, capture): void {
			listeners.push({ type, handler, capture: capture === true });
		},
		removeEventListener(type, handler, capture): void {
			const at = listeners.findIndex(
				(entry) =>
					entry.type === type &&
					entry.handler === handler &&
					entry.capture === (capture === true),
			);
			if (at >= 0) listeners.splice(at, 1);
		},
		// Listeners sharing a target run in registration order, and
		// `stopImmediatePropagation` is exactly what cuts the rest of them off.
		// The two-explorers case turns on that, so the fake honours it.
		dispatch(type, event): void {
			for (const entry of [...listeners]) {
				if (entry.type !== type) continue;
				entry.handler(event as unknown as Event);
				if (event.immediateStopped) return;
			}
		},
	};
}

interface FakeExplorer {
	/** The container's own listeners, kept apart from the window's. */
	readonly host: ListenerHost;
	readonly container: HTMLElement;
	/** Puts a node inside this container, for the `contains` guard. */
	holds(node: object): void;
}

/** One explorer container, in the window it is given. */
function fakeContainer(view: ListenerHost | null): FakeExplorer {
	const host = listenerHost();
	const inside = new Set<object>();
	const container = {
		ownerDocument: { defaultView: view },
		addEventListener: (type: string, handler: (event: Event) => void, capture?: boolean) =>
			host.addEventListener(type, handler, capture),
		removeEventListener: (type: string, handler: (event: Event) => void, capture?: boolean) =>
			host.removeEventListener(type, handler, capture),
		querySelectorAll: (): never[] => [],
		contains: (node: object | null): boolean => node !== null && inside.has(node),
	} as unknown as HTMLElement;
	return { host, container, holds: (node) => inside.add(node) };
}

function fakeEvent(target: object): FakeEvent {
	const event: FakeEvent = {
		target,
		defaultPrevented: false,
		stopped: false,
		immediateStopped: false,
		preventDefault(): void {
			event.defaultPrevented = true;
		},
		stopPropagation(): void {
			event.stopped = true;
		},
		stopImmediatePropagation(): void {
			event.stopped = true;
			event.immediateStopped = true;
		},
	};
	return event;
}

/** A click landing on our button, inside a folder row carrying `data-path`. */
function buttonTarget(dataPath: string): object {
	const row = {
		getAttribute: (name: string): string | null => (name === 'data-path' ? dataPath : null),
	};
	const button = {
		getBoundingClientRect: (): { left: number; bottom: number } => ({ left: 4, bottom: 8 }),
		closest: (selector: string): object | null => {
			if (selector === `.${BUTTON_CLASS}`) return button;
			return selector === FOLDER_ROW_SELECTOR ? row : null;
		},
	};
	return button;
}

/** A click on the row itself, away from the button: not ours to take. */
function rowTarget(): object {
	const row = {
		getAttribute: (): string | null => 'notes',
		closest: (selector: string): object | null =>
			selector === FOLDER_ROW_SELECTOR ? row : null,
	};
	return row;
}

type ExplorerPlugin = ConstructorParameters<typeof ExplorerFolderButtons>[0];

let leaves: { view: { containerEl: HTMLElement } }[] = [];

/** Just enough plugin: the leaves to watch, the vault path and an empty scope. */
function fakePlugin(): ExplorerPlugin {
	return {
		app: {
			workspace: {
				on: (): object => ({}),
				offref: (): void => {},
				getLeavesOfType: (): { view: { containerEl: HTMLElement } }[] => leaves,
			},
		},
		herdrVaultPath: (): string => VAULT,
		scope: { list: (): PaneState[] => [] },
	} as unknown as ExplorerPlugin;
}

const MENU = ['Start agent here', 'Copy path from vault root'];

describe('the pointer listener (issue #74)', () => {
	beforeEach(() => {
		leaves = [];
		shown.length = 0;
		// `watch` observes its container, and node has no `MutationObserver`;
		// nothing here mutates a container, so an inert one is enough.
		vi.stubGlobal(
			'MutationObserver',
			class {
				observe(): void {}
				disconnect(): void {}
			},
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function explorer(view: ListenerHost | null): FakeExplorer {
		const made = fakeContainer(view);
		leaves.push({ view: { containerEl: made.container } });
		return made;
	}

	it('binds click and auxclick on the container window, in capture', () => {
		const view = listenerHost();
		const made = explorer(view);
		const buttons = new ExplorerFolderButtons(fakePlugin());
		buttons.enable();
		expect(view.listeners.map((entry) => entry.type)).toEqual(['click', 'auxclick']);
		expect(view.listeners.every((entry) => entry.capture)).toBe(true);
		// Nothing contends for the explorer's keys, so those stay on the container.
		expect(made.host.listeners.map((entry) => entry.type)).toEqual(['keydown']);
		expect(made.host.listeners[0]?.capture).toBe(true);
		buttons.disable();
	});

	it('opens the menu and stops the click immediately, so nothing downstream reacts', () => {
		const view = listenerHost();
		const made = explorer(view);
		const buttons = new ExplorerFolderButtons(fakePlugin());
		buttons.enable();
		const target = buttonTarget('notes');
		made.holds(target);
		const event = fakeEvent(target);
		view.dispatch('click', event);
		expect(shown).toEqual([MENU]);
		expect(event.defaultPrevented).toBe(true);
		expect(event.immediateStopped).toBe(true);
		buttons.disable();
	});

	it('answers a middle click the same way, so no folder note opens in a tab', () => {
		const view = listenerHost();
		const made = explorer(view);
		const buttons = new ExplorerFolderButtons(fakePlugin());
		buttons.enable();
		const target = buttonTarget('notes');
		made.holds(target);
		const event = fakeEvent(target);
		view.dispatch('auxclick', event);
		expect(shown).toEqual([MENU]);
		expect(event.immediateStopped).toBe(true);
		buttons.disable();
	});

	it('lets a click elsewhere in the row through untouched', () => {
		const view = listenerHost();
		const made = explorer(view);
		const buttons = new ExplorerFolderButtons(fakePlugin());
		buttons.enable();
		const target = rowTarget();
		made.holds(target);
		const event = fakeEvent(target);
		view.dispatch('click', event);
		expect(shown).toEqual([]);
		expect(event.defaultPrevented).toBe(false);
		expect(event.stopped).toBe(false);
		buttons.disable();
	});

	it('opens exactly one menu when two explorers share a window', () => {
		const view = listenerHost();
		const first = explorer(view);
		const second = explorer(view);
		const buttons = new ExplorerFolderButtons(fakePlugin());
		buttons.enable();
		expect(view.listeners).toHaveLength(4);
		// The click lands in the second explorer. The first must ignore it even
		// though the button matches its selector every bit as well.
		const target = buttonTarget('notes');
		second.holds(target);
		expect(first.container.contains(target as unknown as Node)).toBe(false);
		view.dispatch('click', fakeEvent(target));
		expect(shown).toEqual([MENU]);
		buttons.disable();
	});

	it('ignores a button in the window that is in no container it watches', () => {
		// The window hears every click in it, including one on a folder row of an
		// explorer this object does not watch — a leaf being torn down, say. The
		// containment guard is the whole of what keeps that from opening a menu,
		// and it is the same guard that stops two explorers opening two.
		const view = listenerHost();
		explorer(view);
		const buttons = new ExplorerFolderButtons(fakePlugin());
		buttons.enable();
		const event = fakeEvent(buttonTarget('notes'));
		view.dispatch('click', event);
		expect(shown).toEqual([]);
		expect(event.stopped).toBe(false);
		buttons.disable();
	});

	it('gives the window listeners back on disable', () => {
		const view = listenerHost();
		const made = explorer(view);
		const buttons = new ExplorerFolderButtons(fakePlugin());
		buttons.enable();
		buttons.disable();
		expect(view.listeners).toEqual([]);
		expect(made.host.listeners).toEqual([]);
		const target = buttonTarget('notes');
		made.holds(target);
		view.dispatch('click', fakeEvent(target));
		expect(shown).toEqual([]);
	});

	it('survives a container whose window is gone rather than throwing', () => {
		explorer(null);
		const buttons = new ExplorerFolderButtons(fakePlugin());
		expect(() => buttons.enable()).not.toThrow();
		expect(() => buttons.disable()).not.toThrow();
	});
});
