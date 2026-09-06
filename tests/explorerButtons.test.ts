/**
 * The folder hover button (issue #30). The injection itself needs a real file
 * explorer — an undocumented DOM this repo does not fake — so what is tested
 * here is every decision the class makes before it touches an element: which
 * menu a folder gets, which pane "Attach" opens, what a row's `data-path`
 * becomes on herdr's side of a remote profile, and the popout-safe element
 * check that guards the click handler.
 */

import { describe, expect, it } from 'vitest';
import {
	asElement,
	attachablePane,
	BUTTON_CLASS,
	CLAIM_ATTR,
	FOLDER_ROW_SELECTOR,
	folderAbsPath,
	FOLDER_BUTTON_KEYS,
	menuItemsFor,
	vaultRelativeLabel,
} from '../src/explorerButtons';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { PaneState } from '../src/herdr/scope';

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
