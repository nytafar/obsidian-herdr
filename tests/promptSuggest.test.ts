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
import type { AgentFormat } from '../src/agents/format';
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

describe('PromptSuggest: the `/` list is the pane’s agent’s (ADR-0010)', () => {
	const entry = (name: string): CatalogEntry => ({
		name,
		scope: 'builtin',
		kind: 'command',
		description: '',
		argumentHint: '',
		path: null,
	});
	/** A format with a fixed list, standing in for an agent that is not Claude. */
	const other = {
		agent: 'other',
		commands: { builtin: () => [entry('presets')], local: () => ({ catalog: () => [entry('presets')] }) },
	} as unknown as AgentFormat;

	function namesFor(
		format: (() => AgentFormat | null | undefined) | undefined,
		catalog: (agent: string) => CommandCatalogSource | null,
	): { names: string[]; asked: string[] } {
		const area = { value: '/', selectionStart: 1 } as unknown as HTMLTextAreaElement;
		const app = { vault: { getFiles: () => [] } } as unknown as App;
		const asked: string[] = [];
		const suggest = new PromptSuggest(area, {
			app,
			cwd: () => '/repo',
			vaultPath: () => '',
			...(format ? { format } : {}),
			catalog: (agent) => {
				asked.push(agent);
				return catalog(agent);
			},
		});
		const access = suggest as unknown as { getSuggestions(): PromptSuggestion[] };
		return { names: access.getSuggestions().map((s) => (s.kind === 'command' ? s.entry.name : '')), asked };
	}

	/** The runtime's reader: Claude's catalogue for Claude, none for anyone else. */
	const claudeOnly = (agent: string): CommandCatalogSource | null =>
		agent === 'claude' ? { catalog: () => [entry('review')] } : null;

	it('asks the runtime for the pane’s agent’s catalogue, and gets the format’s list for an agent it reads none of', () => {
		expect(namesFor(() => other, claudeOnly)).toEqual({ names: ['presets'], asked: ['other'] });
	});

	it('reads a pane whose runtime names no agent as the default agent’s', () => {
		expect(namesFor(() => undefined, claudeOnly)).toEqual({ names: ['review'], asked: ['claude'] });
		expect(namesFor(undefined, claudeOnly)).toEqual({ names: ['review'], asked: ['claude'] });
	});

	it('offers nothing for an agent with no format, and asks no runtime for it', () => {
		expect(namesFor(() => null, claudeOnly)).toEqual({ names: [], asked: [] });
	});
});

describe('PromptSuggest: commands ranked by use (#149)', () => {
	const entry = (name: string): CatalogEntry => ({
		name,
		scope: 'user',
		kind: 'command',
		description: '',
		argumentHint: '',
		path: null,
	});

	function suggestOver(text: string, usage: Record<string, number>, used: string[]) {
		const area = {
			value: text,
			selectionStart: text.length,
			setSelectionRange: () => {},
			focus: () => {},
		} as unknown as HTMLTextAreaElement;
		const app = { vault: { getFiles: () => [] } } as unknown as App;
		const suggest = new PromptSuggest(area, {
			app,
			cwd: () => '/repo',
			vaultPath: () => '',
			catalog: () => ({ catalog: () => [entry('review'), entry('release'), entry('rewind')] }),
			usage: () => usage,
			onCommandUsed: (name) => used.push(name),
		});
		const access = suggest as unknown as { getSuggestions(): PromptSuggestion[] };
		const names = (): string[] =>
			access.getSuggestions().map((s) => (s.kind === 'command' ? s.entry.name : ''));
		return { suggest, names };
	}

	it('offers the most used command first', () => {
		const { names } = suggestOver('/re', { rewind: 3, release: 1 }, []);
		expect(names()).toEqual(['rewind', 'release', 'review']);
	});

	it('reports a picked command, and never a picked file', () => {
		const used: string[] = [];
		const { suggest, names } = suggestOver('/re', {}, used);
		names();

		suggest.selectSuggestion({ kind: 'command', entry: entry('review') });
		suggest.selectSuggestion({ kind: 'file', file: { path: 'a.md' } as never });

		expect(used).toEqual(['review']);
	});
});
