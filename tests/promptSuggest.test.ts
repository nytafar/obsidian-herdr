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
import { PromptSuggest } from '../src/native/promptSuggest';
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
