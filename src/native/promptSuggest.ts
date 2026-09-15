/**
 * The prompt box's autocomplete (issue #98).
 *
 * Obsidian's **input suggest**, not its editor suggest: the prompt box is a
 * plain text area, not a Markdown editor, and `AbstractInputSuggest` is the
 * popover the app already draws for text fields. Two triggers:
 *
 * - **`/` at the very start of the prompt** offers the command catalog
 *   (`./commandCatalog.ts`), because that is where Claude Code reads a command
 *   from: a leading `/command` is executed, a slash anywhere else is text
 *   (`docs/architecture.md`, "Agent prompts and session identity").
 * - **`@` at a word boundary** offers vault files, and what goes into the
 *   prompt is the path the agent can open (`./promptMentions.ts`).
 *
 * The base class is written for an `<input>` or a contenteditable `<div>`, and
 * reads their value in its own way; a text area's value lives on `.value`, so
 * {@link PromptSuggest} overrides `getValue` and `setValue` and keeps its own
 * typed reference to the element. Everything else — the popover, the keyboard
 * handling, the lifetime — is Obsidian's.
 *
 * Nothing here is unit tested: what it decides is the trigger and the text it
 * writes back, and both are pure functions below that the catalog and mention
 * tests cover through their own modules. The popover itself is a manual check
 * (`tests/README.md`).
 */

import { AbstractInputSuggest, type App, type TFile } from 'obsidian';
import {
	loadCommandCatalog,
	matchCommands,
	scopeLabel,
	type CatalogEntry,
} from './commandCatalog';
import { mentionFor, vaultFileAbsolutePath } from './promptMentions';

/** How long a loaded catalog is reused before the tree is read again. */
const CATALOG_TTL_MS = 5000;

/** How many files a `@` offers at once. */
const FILE_LIMIT = 50;

/** What is being completed, and the text it replaces. */
export interface PromptTrigger {
	kind: 'command' | 'file';
	/** What has been typed after the `/` or the `@`. */
	query: string;
	/** Index of the `/` or `@` in the prompt. */
	start: number;
}

/** One row of the popover. */
export type PromptSuggestion =
	| { kind: 'command'; entry: CatalogEntry }
	| { kind: 'file'; file: TFile };

/**
 * What the cursor is completing, or null for ordinary typing.
 *
 * A command trigger is the first character of the prompt and nothing else: a
 * `/` further in is a path, not a command. A file trigger is an `@` at the
 * start or after whitespace. Neither survives a space, so a finished mention
 * stops offering.
 */
export function activeTrigger(text: string, cursor: number): PromptTrigger | null {
	const before = text.slice(0, cursor);
	if (before.startsWith('/') && !/\s/.test(before)) {
		return { kind: 'command', query: before.slice(1), start: 0 };
	}
	const at = before.lastIndexOf('@');
	if (at === -1) return null;
	const previous = at === 0 ? '' : (before[at - 1] ?? '');
	if (previous !== '' && !/\s/.test(previous)) return null;
	const query = before.slice(at + 1);
	if (/\s/.test(query)) return null;
	return { kind: 'file', query, start: at };
}

/** The prompt with the trigger replaced, and where the cursor lands after it. */
export function withSuggestion(
	text: string,
	trigger: PromptTrigger,
	replacement: string,
	cursor: number,
): { text: string; cursor: number } {
	const head = `${text.slice(0, trigger.start)}${replacement} `;
	return { text: `${head}${text.slice(cursor)}`, cursor: head.length };
}

export interface PromptSuggestOptions {
	app: App;
	/** The pane's working directory: the project scope and the mention form. */
	cwd: () => string;
	/** The vault's base path on this machine, or '' when it has none. */
	vaultPath: () => string;
}

/** The popover the prompt box shows while a `/` or an `@` is being typed. */
export class PromptSuggest extends AbstractInputSuggest<PromptSuggestion> {
	private readonly textEl: HTMLTextAreaElement;
	private readonly options: PromptSuggestOptions;
	/** The catalog as last read, with the cwd and the moment it was read for. */
	private cached: { cwd: string; at: number; entries: CatalogEntry[] } | null = null;
	/** The trigger the offered suggestions were built for. */
	private trigger: PromptTrigger | null = null;

	constructor(inputEl: HTMLTextAreaElement, options: PromptSuggestOptions) {
		// The base class types its element as an input or a contenteditable div;
		// its listeners work on a text area just as well, and the two methods
		// that read the element's value are overridden below.
		super(options.app, inputEl as unknown as HTMLInputElement);
		this.textEl = inputEl;
		this.options = options;
	}

	/** A text area keeps its text in `value`, which the base class cannot know. */
	getValue(): string {
		return this.textEl.value;
	}

	setValue(value: string): void {
		this.textEl.value = value;
	}

	protected getSuggestions(): PromptSuggestion[] {
		const cursor = this.textEl.selectionStart ?? this.textEl.value.length;
		const trigger = activeTrigger(this.textEl.value, cursor);
		this.trigger = trigger;
		if (!trigger) return [];
		if (trigger.kind === 'command') {
			return matchCommands(this.catalog(), trigger.query).map((entry) => ({
				kind: 'command' as const,
				entry,
			}));
		}
		return this.files(trigger.query).map((file) => ({ kind: 'file' as const, file }));
	}

	renderSuggestion(suggestion: PromptSuggestion, el: HTMLElement): void {
		const row = el.createDiv({ cls: 'herdr-prompt-suggestion' });
		if (suggestion.kind === 'file') {
			row.createDiv({ cls: 'herdr-prompt-suggestion-name', text: suggestion.file.basename });
			row.createDiv({ cls: 'herdr-prompt-suggestion-note', text: suggestion.file.path });
			return;
		}
		const { entry } = suggestion;
		const hint = entry.argumentHint ? ` ${entry.argumentHint}` : '';
		row.createDiv({ cls: 'herdr-prompt-suggestion-name', text: `/${entry.name}${hint}` });
		const kind = entry.kind === 'skill' ? 'skill' : 'command';
		const note = entry.description
			? `${scopeLabel(entry.scope)} ${kind} — ${entry.description}`
			: `${scopeLabel(entry.scope)} ${kind}`;
		row.createDiv({ cls: 'herdr-prompt-suggestion-note', text: note });
	}

	selectSuggestion(suggestion: PromptSuggestion): void {
		const trigger = this.trigger;
		if (!trigger) return;
		const cursor = this.textEl.selectionStart ?? this.textEl.value.length;
		const replacement =
			suggestion.kind === 'command' ? `/${suggestion.entry.name}` : this.mention(suggestion.file);
		const next = withSuggestion(this.textEl.value, trigger, replacement, cursor);
		this.setValue(next.text);
		this.textEl.setSelectionRange(next.cursor, next.cursor);
		this.textEl.focus();
		this.close();
	}

	/** The mention text for a vault file, in the form the pane's agent can open. */
	private mention(file: TFile): string {
		const path = vaultFileAbsolutePath({
			vaultPath: this.options.vaultPath(),
			filePath: file.path,
		});
		// A vault that is not on this filesystem has no path to give the agent;
		// the vault-relative one is the best that can be said.
		if (path === null) return `@${file.path}`;
		return mentionFor({ path, cwd: this.options.cwd() });
	}

	/** The catalog for this pane's cwd, re-read when it is stale or the cwd moved. */
	private catalog(): CatalogEntry[] {
		const cwd = this.options.cwd();
		const now = Date.now();
		const cached = this.cached;
		if (cached && cached.cwd === cwd && now - cached.at < CATALOG_TTL_MS) return cached.entries;
		const entries = loadCommandCatalog({ cwd });
		this.cached = { cwd, at: now, entries };
		return entries;
	}

	/** Vault files whose path contains the query, shortest path first. */
	private files(query: string): TFile[] {
		const needle = query.toLowerCase();
		const hits = this.options.app.vault
			.getFiles()
			.filter((file) => file.path.toLowerCase().includes(needle));
		hits.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
		return hits.slice(0, FILE_LIMIT);
	}
}
