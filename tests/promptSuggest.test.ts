/**
 * The prompt box's autocomplete, as far as the box has to know it (#98, #103).
 *
 * Everything the popover itself does is Obsidian's, and a manual check
 * (`tests/README.md`): there is no document here, no scope and no focused
 * field. What *is* the plugin's, and what a test can hold, is the one thing the
 * prompt box asks the suggest — whether the popover is open, because the enter
 * belongs to it while it is, and sends the prompt only when it is not.
 *
 * `AbstractInputSuggest` is the loadable stub from `tests/fixtures/obsidian.ts`,
 * so `open()` and `close()` here are exactly the two calls Obsidian makes on
 * the real one.
 */

import { describe, expect, it } from 'vitest';
import { hostEl } from './fixtures/dom';
import { PromptSuggest, type PromptSuggestion } from '../src/native/promptSuggest';
import type { CatalogEntry, CommandCatalogSource } from '../src/native/commandCatalog';
import type { App } from 'obsidian';

function suggestOn(): PromptSuggest {
	const { host } = hostEl();
	const app = { vault: { getFiles: () => [] } } as unknown as App;
	return new PromptSuggest(host as unknown as HTMLTextAreaElement, {
		app,
		cwd: () => '/home/lasse/hvelv',
		vaultPath: () => '/home/lasse/hvelv',
	});
}

describe('PromptSuggest: whether the popover is open', () => {
	it('is closed until Obsidian opens it, and closed again after', () => {
		const suggest = suggestOn();
		expect(suggest.isOpen()).toBe(false);

		suggest.open();
		expect(suggest.isOpen()).toBe(true);

		suggest.close();
		expect(suggest.isOpen()).toBe(false);
	});

	it('is closed once a suggestion has been taken', () => {
		const suggest = suggestOn();
		suggest.open();

		// Nothing was triggered, so nothing is written back; what matters is
		// that the popover is gone and the next enter is the prompt box's.
		suggest.selectSuggestion({ kind: 'file', file: { path: 'a.md' } as never });

		expect(suggest.isOpen()).toBe(false);
	});
});

describe('PromptSuggest: whose commands a `/` offers', () => {
	/** A suggest over a bare text area holding `text`, the cursor at its end. */
	function typed(text: string, catalog: () => CommandCatalogSource): {
		suggestions: () => PromptSuggestion[] | Promise<PromptSuggestion[]>;
		cwds: string[];
	} {
		const area = { value: text, selectionStart: text.length } as unknown as HTMLTextAreaElement;
		const app = { vault: { getFiles: () => [] } } as unknown as App;
		const cwds: string[] = [];
		const suggest = new PromptSuggest(area, {
			app,
			cwd: () => '/remote/repo',
			vaultPath: () => '',
			catalog: () => ({
				catalog: (cwd) => {
					cwds.push(cwd);
					return catalog().catalog(cwd);
				},
			}),
		});
		const access = suggest as unknown as { getSuggestions(): PromptSuggestion[] | Promise<PromptSuggestion[]> };
		return { suggestions: () => access.getSuggestions(), cwds };
	}

	const entry = (name: string): CatalogEntry => ({
		name,
		scope: 'user',
		kind: 'command',
		description: '',
		argumentHint: '',
		path: null,
	});

	it('offers a known catalog at once, from the pane’s own cwd', () => {
		const { suggestions, cwds } = typed('/re', () => ({ catalog: () => [entry('review'), entry('other')] }));

		const result = suggestions();
		expect(Array.isArray(result)).toBe(true);
		expect((result as PromptSuggestion[]).map((s) => (s.kind === 'command' ? s.entry.name : ''))).toEqual(['review']);
		expect(cwds).toEqual(['/remote/repo']);
	});

	it('hands Obsidian a promise while a remote catalog is read', async () => {
		const { suggestions } = typed('/rem', () => ({ catalog: () => Promise.resolve([entry('remote-only')]) }));

		const result = suggestions();
		expect(result).toBeInstanceOf(Promise);
		expect((await result).map((s) => (s.kind === 'command' ? s.entry.name : ''))).toEqual(['remote-only']);
	});
});
