/**
 * The prompt box's autocomplete (issue #98).
 *
 * Obsidian's **input suggest**, not its editor suggest: the prompt box is a
 * plain text area, not a Markdown editor, and `AbstractInputSuggest` is the
 * popover the app already draws for text fields. Two triggers:
 *
 * - **`/` at the very start of the prompt** offers the command catalog
 *   (`./commandCatalog.ts`) of the pane's own machine, read here for a local
 *   runtime and over the connection for a remote herdr-core one
 *   (`../hc/commandCatalog.ts`), because that is where the agent reads a command
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
 * The popover owns the enter key while it is open — that is how a suggestion is
 * picked — so the prompt box has to know when it is, or Enter-to-send (#103)
 * would send a half-typed `/comm` instead of completing it. Obsidian opens and
 * closes the popover through {@link PopoverSuggest.open} and `close`, so
 * {@link PromptSuggest.isShowing} follows those two calls and nothing else.
 *
 * Only that is unit tested (`tests/promptSuggest.test.ts`): what the rest
 * decides is the trigger and the text it writes back, and both are pure
 * functions below that the catalog and mention tests cover through their own
 * modules. The popover itself is a manual check (`tests/README.md`).
 */

import { AbstractInputSuggest, type App, type TFile } from 'obsidian';
import {
	matchCommands,
	scopeLabel,
	type CatalogEntry,
	type CommandCatalogSource,
	type CommandUsage,
} from './commandCatalog';
import { mentionFor, vaultFileAbsolutePath } from './promptMentions';
import type { AgentFormat } from '../agents/format';
import { defaultAgentFormat } from '../agents/catalog';

/** How many files a `@` offers at once. */
const FILE_LIMIT = 50;

/** What a pane whose agent has no format offers after a `/`: nothing. */
const NO_COMMANDS: CommandCatalogSource = { catalog: () => [] };

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
	/**
	 * The pane's working directory, on the pane's machine: the mention form,
	 * and where the `/` catalog's project scope starts.
	 */
	cwd: () => string;
	/**
	 * Where the `/` catalog of the pane's agent is read, asked on every `/`
	 * with that agent's id: the pane's machine, which for a herdr-core runtime
	 * over SSH is another one and answers asynchronously. A runtime reads
	 * catalogues per agent (`NativeSessionAdapter.commandCatalog`). Not given,
	 * or null, is this machine's catalogue of the pane's agent ({@link format}),
	 * walked by this suggest and kept for the TTL.
	 */
	catalog?: (agent: string) => CommandCatalogSource | null;
	/**
	 * The format of the agent the pane runs, whose catalogue is offered
	 * (ADR-0010). Two cases, kept apart: undefined (or not given) is a runtime
	 * that names no agent, read as the catalog's default agent's, as before
	 * agents had formats; null is an agent this build has no format for, which
	 * offers no commands at all.
	 */
	format?: () => AgentFormat | null | undefined;
	/** The pane this box prompts, for a catalog that reads per pane (#132). */
	paneId?: () => string;
	/**
	 * The vault's base path on the pane's machine (an SSH runtime's remote
	 * vault path), or '' when it has none: where a mentioned file is opened.
	 */
	vaultPath: () => string;
	/**
	 * How often each command has been picked (#149), read on every `/`, so the
	 * commands a user reaches for are offered first. Left out, nothing is ranked
	 * by use.
	 */
	usage?: () => CommandUsage;
	/** A command was picked from the popover; the caller counts and keeps it. */
	onCommandUsed?: (name: string) => void;
}

/** The popover the prompt box shows while a `/` or an `@` is being typed. */
export class PromptSuggest extends AbstractInputSuggest<PromptSuggestion> {
	private readonly textEl: HTMLTextAreaElement;
	private readonly options: PromptSuggestOptions;
	/** This machine's catalog, for a suggest that was given no source. */
	private localCatalog: { format: AgentFormat; source: CommandCatalogSource } | null = null;
	/** The trigger the offered suggestions were built for. */
	private trigger: PromptTrigger | null = null;
	/** Whether the popover is showing; see {@link PromptSuggest.isShowing}. */
	private showing = false;

	constructor(inputEl: HTMLTextAreaElement, options: PromptSuggestOptions) {
		// The base class types its element as an input or a contenteditable div;
		// its listeners work on a text area just as well, and the two methods
		// that read the element's value are overridden below.
		super(options.app, inputEl as unknown as HTMLInputElement);
		this.textEl = inputEl;
		this.options = options;
	}

	/**
	 * Whether the popover is showing, which is the one thing the prompt box asks
	 * of the suggest: the enter picks a suggestion while it is, and sends the
	 * prompt only when it is not (#103).
	 *
	 * Not `isOpen`: Obsidian's suggest sets a plain `isOpen` field on every
	 * instance as it is created, which hides a method of that name, and the
	 * prompt box's Enter handler then threw "isOpen is not a function".
	 */
	isShowing(): boolean {
		return this.showing;
	}

	open(): void {
		this.showing = true;
		super.open();
	}

	close(): void {
		this.showing = false;
		super.close();
	}

	/** A text area keeps its text in `value`, which the base class cannot know. */
	getValue(): string {
		return this.textEl.value;
	}

	setValue(value: string): void {
		this.textEl.value = value;
	}

	/**
	 * Synchronous for vault files and a catalog already known; a promise while
	 * a remote catalog is read, which Obsidian's input suggest takes as well
	 * (`getSuggestions(query): T[] | Promise<T[]>`, since 1.5.7).
	 */
	protected getSuggestions(): PromptSuggestion[] | Promise<PromptSuggestion[]> {
		const cursor = this.textEl.selectionStart ?? this.textEl.value.length;
		const trigger = activeTrigger(this.textEl.value, cursor);
		this.trigger = trigger;
		if (!trigger) return [];
		if (trigger.kind === 'command') {
			const offer = (entries: CatalogEntry[]): PromptSuggestion[] =>
				matchCommands(entries, trigger.query, this.options.usage?.()).map((entry) => ({ kind: 'command' as const, entry }));
			const entries = this.catalogSource().catalog(this.options.cwd(), this.options.paneId?.());
			return Array.isArray(entries) ? offer(entries) : entries.then(offer);
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
		// Closed first, and whatever happens: once a suggestion has been taken
		// the popover is gone, and the next enter is the prompt box's (#103).
		this.close();
		if (!trigger) return;
		if (suggestion.kind === 'command') this.options.onCommandUsed?.(suggestion.entry.name);
		const cursor = this.textEl.selectionStart ?? this.textEl.value.length;
		const replacement =
			suggestion.kind === 'command' ? `/${suggestion.entry.name}` : this.mention(suggestion.file);
		const next = withSuggestion(this.textEl.value, trigger, replacement, cursor);
		this.setValue(next.text);
		this.textEl.setSelectionRange(next.cursor, next.cursor);
		this.textEl.focus();
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

	/**
	 * The pane's agent's catalogue: the runtime's reader for that agent, or
	 * this machine's when the runtime gives none. An agent with no format has
	 * none to offer.
	 */
	private catalogSource(): CommandCatalogSource {
		const named = this.options.format?.();
		const format = named === undefined ? defaultAgentFormat() : named;
		if (!format) return NO_COMMANDS;
		const given = this.options.catalog?.(format.agent);
		if (given) return given;
		if (this.localCatalog?.format !== format) this.localCatalog = { format, source: format.commands.local() };
		return this.localCatalog.source;
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
