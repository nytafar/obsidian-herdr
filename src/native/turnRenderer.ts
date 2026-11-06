/**
 * The turn renderer (issues #93, #95, #96, #118): one reduced turn as DOM.
 *
 * What renders how (native-view-design.md): assistant prose through
 * `MarkdownRenderer`, one element per block, so the vault's own wikilinks,
 * callouts and embeds come out as they do anywhere else; human prompts as plain
 * pre-wrapped text with their wikilinks linkified; a turn's consecutive tool
 * calls as one collapsed tool group with the vault changes and the sources it
 * made kept outside it (#95); thinking as a collapsed "Thought"; a steer where
 * it entered the turn.
 *
 * It holds one element per turn and one `Component` per item in it, and the
 * heading anchors a TOC click aims at. A turn is reconciled, not rebuilt
 * (#127): an item that did not change keeps its element and its Markdown, and
 * a disclosure the reader opened stays open (`./foldMemory.ts`). Everything
 * around the turns — the scroll, the lines under them, the waiting card — is
 * the surface's (`./surface.ts`), which hands this the Markdown renderer it
 * tracks for the scroll.
 */

import { Component } from 'obsidian';
import { FoldMemory } from './foldMemory';
import { nameTurnItems } from './itemKeys';
import type {
	CompactionEntry,
	ImageEntry,
	NoticeEntry,
	ShellEntry,
	TextEntry,
	ThinkingEntry,
	ToolEntry,
	Turn,
} from './reducer';
import {
	changedPath,
	changeLine,
	changeStateClass,
	sourceText,
	subagentReport,
	openRunIndex,
	toolDetail,
	toolGroupHeader,
	toolGroupStartsOpen,
	toolGroupState,
	todoList,
	turnItems,
	vaultNoteLink,
	type ToolGroupPresentation,
	type TurnActivity,
	type TurnItem,
} from './toolCalls';
import { fillUriLink } from './noteLinks';
import { progressText, renderChecklist } from './todoList';
import { findObsidianUris } from './obsidianUri';

/**
 * One piece of a human prompt: literal text, a wikilink to a note, or an
 * `obsidian://` URI (#114), which is resolved when it is drawn.
 */
export type PromptSegment =
	| { kind: 'text'; text: string }
	| { kind: 'link'; target: string; label: string }
	| { kind: 'uri'; uri: string };

/**
 * A human prompt split into text, wikilinks and `obsidian://` URIs.
 *
 * Human prompts are shown as the human typed them — plain, pre-wrapped text,
 * not Markdown — with the one exception that a link is a link, because a
 * prompt in this vault is usually half references (native-view-design.md).
 */
export function promptSegments(prompt: string): PromptSegment[] {
	const segments: PromptSegment[] = [];
	const pattern = /\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g;
	let at = 0;
	for (let match = pattern.exec(prompt); match; match = pattern.exec(prompt)) {
		if (match.index > at) segments.push(...textSegments(prompt.slice(at, match.index)));
		const target = (match[1] ?? '').trim();
		const alias = match[2]?.trim();
		segments.push({ kind: 'link', target, label: alias || target });
		at = match.index + match[0].length;
	}
	if (at < prompt.length) segments.push(...textSegments(prompt.slice(at)));
	return segments;
}

/** A run of prompt text between wikilinks, with its `obsidian://` URIs split out. */
function textSegments(text: string): PromptSegment[] {
	const segments: PromptSegment[] = [];
	let at = 0;
	for (const match of findObsidianUris(text)) {
		if (match.start > at) segments.push({ kind: 'text', text: text.slice(at, match.start) });
		segments.push({ kind: 'uri', uri: match.uri });
		at = match.end;
	}
	if (at < text.length) segments.push({ kind: 'text', text: text.slice(at) });
	return segments;
}

/**
 * A human prompt: text as typed, wikilinks and `obsidian://` URIs as links.
 * A click on one is the view's delegated handler's (`./viewLinks.ts`).
 */
export function renderPrompt(
	el: HTMLElement,
	prompt: string,
	resolveUri: (uri: string) => string | null,
): void {
	for (const segment of promptSegments(prompt)) {
		if (segment.kind === 'text') {
			el.appendText(segment.text);
			continue;
		}
		if (segment.kind === 'uri') {
			fillUriLink(el.createEl('a'), segment.uri, resolveUri(segment.uri));
			continue;
		}
		el.createEl('a', {
			cls: 'internal-link',
			text: segment.label,
			href: segment.target,
			attr: { 'data-href': segment.target },
		});
	}
}

/**
 * The heading elements a rendered block can hold, as one selector (#118).
 * Obsidian's renderer builds ordinary `h1`-`h6` elements, so this is the whole
 * of what "a heading in the prose" means here.
 */
const HEADING_TAGS = 'h1, h2, h3, h4, h5, h6';

/** What {@link TurnRenderer} needs from the surface around it. */
export interface TurnRendererOptions {
	/**
	 * How much of a turn's tool calls to fold away (#95). Read on every draw, so
	 * a change to the setting reaches an open view on the next full draw.
	 */
	presentation: () => ToolGroupPresentation;
	/** The vault's absolute path, for stripping it off the files the agent changed. */
	vaultPath: () => string;
	/**
	 * Markdown through Obsidian's renderer, as the surface runs it: with its
	 * links resolved and its promise tracked for the scroll (#106).
	 */
	renderMarkdown: (markdown: string, el: HTMLElement, component: Component) => Promise<void>;
	/** The vault path an `obsidian://` URI opens in this vault, or null (#114). */
	resolveUri: (uri: string) => string | null;
	/**
	 * What the reader opened and closed (#127). The surface's, so it outlives
	 * this renderer; a renderer of its own when left out.
	 */
	folds?: FoldMemory;
	/** A turn element was created: it is the one Claude is writing. */
	onTurnCreated?: (turnEl: HTMLElement) => void;
}

/**
 * What an item's signature may depend on beyond the item itself: everything a
 * render function reads that is not in the item. An item is drawn again when
 * its signature changes and left standing otherwise, so a fact a render reads
 * and its signature leaves out would go stale on screen.
 */
export interface ItemFacts {
	/** The vault's absolute path, as `TurnRendererOptions.vaultPath` gives it. */
	vaultPath: string;
	/** What the agent is doing in this turn (#128); null for a finished turn. */
	activity: TurnActivity | null;
	/** Whether this item is the turn's open run (`openRunIndex`, #128). */
	openRun: boolean;
}

/** What a render function is handed for one item. */
export interface ItemContext {
	/** The turn's element. Append to it; the renderer puts the item in its place. */
	parent: HTMLElement;
	/** The item's own component: its listeners and its rendered Markdown. */
	component: Component;
	options: TurnRendererOptions;
	facts: ItemFacts;
	/**
	 * Opens a disclosure as the reader left it, or as `defaultOpen` says when
	 * they never touched it, and remembers what they do with it from now on.
	 */
	disclose: (details: HTMLDetailsElement, defaultOpen: boolean) => void;
}

/** What one item drew. */
export interface ItemDraw {
	/** Its element, or null when it draws nothing. */
	el: HTMLElement | null;
	/**
	 * The render of assistant prose, whose headings the table of contents
	 * counts (#118). Nothing else in a turn is prose for that purpose.
	 */
	prose?: Promise<void>;
}

/**
 * How one kind of item is drawn: its signature, which says when it must be
 * drawn again, and the function that draws it. A kind added to `TurnItem` is
 * one entry in {@link ITEM_KINDS}; its name comes from `./itemKeys.ts`.
 */
export interface ItemKind<I extends TurnItem> {
	signature: (item: I, facts: ItemFacts) => string;
	render: (item: I, context: ItemContext) => ItemDraw;
}

type ItemKinds = { [K in TurnItem['kind']]: ItemKind<Extract<TurnItem, { kind: K }>> };

/**
 * Every kind of item, keyed by `TurnItem['kind']`, so a kind without an entry
 * does not compile.
 */
const ITEM_KINDS: ItemKinds = {
	text: {
		signature: (item) => item.entry.text,
		render: (item, context) => renderText(item.entry, context),
	},
	thinking: {
		signature: (item) => item.entry.text,
		render: (item, context) => renderThinking(item.entry, context),
	},
	steer: {
		signature: (item) => item.entry.text,
		// A steer is shown where it entered the running turn (CONTEXT.md).
		render: (item, context) => {
			const el = context.parent.createDiv({ cls: 'herdr-native-steer' });
			renderPrompt(el, item.entry.text, context.options.resolveUri);
			return { el };
		},
	},
	group: {
		signature: (item, facts) =>
			JSON.stringify([
				facts.vaultPath,
				toolGroupState(item.tools, facts.activity, facts.openRun),
				item.tools.map((entry) => [entry.id, entry.name, entry.status, toolDetail(entry, facts.vaultPath)]),
			]),
		render: (item, context) => renderToolGroup(item.tools, context),
	},
	change: {
		signature: (item, facts) =>
			JSON.stringify([facts.vaultPath, changedPath(item.entry), item.entry.status]),
		render: (item, context) => renderVaultChange(item.entry, context),
	},
	source: {
		signature: (item) => JSON.stringify(sourceText(item.entry)),
		render: (item, context) => renderSource(item.entry, context),
	},
	report: {
		signature: (item) => subagentReport(item.entry),
		render: (item, context) => renderSubagentReport(item.entry, context),
	},
	todo: {
		signature: (item) => JSON.stringify([item.latest, todoList(item.entry)]),
		render: (item, context) => renderTodo(item.entry, item.latest, context),
	},
	image: {
		signature: (item) => item.entry.mediaType,
		render: (item, context) => renderImage(item.entry, context),
	},
	compaction: {
		signature: (item) => item.entry.summary,
		render: (item, context) => renderCompaction(item.entry, context),
	},
	notice: {
		signature: (item) => item.entry.text,
		render: (item, context) => renderNotice(item.entry, context),
	},
	shell: {
		signature: (item) => JSON.stringify([item.entry.command, item.entry.stdout, item.entry.stderr]),
		render: (item, context) => renderShell(item.entry, context),
	},
};

/** The signature of an item, through its kind's entry. */
function itemSignature(item: TurnItem, facts: ItemFacts): string {
	const kind = ITEM_KINDS[item.kind] as ItemKind<TurnItem>;
	return kind.signature(item, facts);
}

/** An item drawn, through its kind's entry. */
function drawItem(item: TurnItem, context: ItemContext): ItemDraw {
	const kind = ITEM_KINDS[item.kind] as ItemKind<TurnItem>;
	return kind.render(item, context);
}

/** One item as it stands on screen. */
interface DrawnItem {
	kind: TurnItem['kind'];
	signature: string;
	el: HTMLElement | null;
	/** Its listeners and its Markdown; unloaded when it is drawn again or goes. */
	component: Component;
	/** Its prose render (#118), or null when it is not prose. */
	prose: Promise<void> | null;
}

/** One turn as it stands on screen. */
interface DrawnTurn {
	el: HTMLElement;
	/** The prompt as last drawn, and its element; null for a turn without one. */
	prompt: string;
	promptEl: HTMLElement | null;
	/** Its items by name, in the order they are drawn. */
	items: Map<string, DrawnItem>;
	/**
	 * Which marking of the headings is current. A render that lands after the
	 * turn was drawn again must mark nothing: its elements may be gone.
	 */
	headingToken: symbol;
	/**
	 * The heading elements of the turn's prose, in the order the reducer counts
	 * them, once that prose has rendered (#118). Empty until it has.
	 */
	headingEls: HTMLElement[];
}

/**
 * The turns of one attached view, drawn into the reading view's sizer.
 *
 * A turn is reconciled rather than rebuilt (#127): its items are named
 * (`./itemKeys.ts`), and an item whose name and signature are what they were
 * keeps its element, its component and its rendered Markdown. Only an item
 * that changed or is new is drawn, which while Claude writes is usually the
 * last one. Every DOM listener and every rendered Markdown child hangs off a
 * `Component` per item, unloaded when that item is drawn again or goes, and
 * for all of them when the turns are cleared.
 */
export class TurnRenderer {
	/** One drawn turn per turn id, in the order the turns arrived. */
	private readonly turns = new Map<string, DrawnTurn>();
	private readonly folds: FoldMemory;

	constructor(
		private readonly sizerEl: HTMLElement,
		private readonly options: TurnRendererOptions,
	) {
		this.folds = options.folds ?? new FoldMemory();
	}

	/** How many turns are drawn. */
	get size(): number {
		return this.turns.size;
	}

	/** The element a turn was drawn into, or undefined for a turn not drawn. */
	turnEl(turnId: string): HTMLElement | undefined {
		return this.turns.get(turnId)?.el;
	}

	/**
	 * The rendered element of a turn's heading, or undefined when the click
	 * should fall back to the turn (#118).
	 *
	 * Reducer headings (`headingCount` of them) and rendered headings pair by
	 * position only while there are as many of one as of the other: a heading
	 * the regex saw inside an indented code block, or one it missed, makes
	 * every index after it a lie.
	 */
	headingEl(turnId: string, index: number, headingCount: number | undefined): HTMLElement | undefined {
		const els = this.turns.get(turnId)?.headingEls ?? [];
		return els.length === headingCount ? els[index] : undefined;
	}

	/**
	 * Drops one turn — its element, its items' components and what the reader
	 * opened in it — because a rewind left it behind (#131). A turn not drawn
	 * is nothing to drop.
	 */
	remove(turnId: string): void {
		const drawn = this.turns.get(turnId);
		this.folds.forget(turnId);
		if (!drawn) return;
		for (const item of drawn.items.values()) item.component.unload();
		drawn.el.remove();
		this.turns.delete(turnId);
	}

	/** Drops every turn element and the components that went with them. */
	clear(): void {
		for (const drawn of this.turns.values()) {
			for (const item of drawn.items.values()) item.component.unload();
		}
		this.turns.clear();
		this.sizerEl.empty();
	}

	/**
	 * Draws one turn into its own element, which is created on first sight and
	 * reused afterwards: a turn that grows while Claude writes keeps its place
	 * in the view, and the turns around it are not touched. Inside it, only the
	 * items that changed are drawn again.
	 *
	 * `activity` is what the agent is doing in this turn (#128), null for every
	 * turn but the session's latest while it works or waits: the surface draws
	 * the latest turn again when the status moves, and only its tool groups'
	 * headers change.
	 */
	render(turn: Turn, activity: TurnActivity | null = null): void {
		let drawn = this.turns.get(turn.id);
		if (!drawn) {
			const el = this.sizerEl.createDiv({ cls: 'herdr-native-turn' });
			drawn = {
				el,
				prompt: '',
				promptEl: null,
				items: new Map(),
				headingToken: Symbol('draw'),
				headingEls: [],
			};
			this.turns.set(turn.id, drawn);
			// The turn Claude is writing is the one that grows under the view.
			this.options.onTurnCreated?.(el);
		}
		const turnEl = drawn.el;
		let changed = false;

		if (turn.prompt !== drawn.prompt || (turn.prompt && !drawn.promptEl)) {
			drawn.promptEl?.remove();
			drawn.promptEl = null;
			if (turn.prompt) {
				drawn.promptEl = turnEl.createDiv({ cls: 'herdr-native-prompt' });
				renderPrompt(drawn.promptEl, turn.prompt, this.options.resolveUri);
			}
			drawn.prompt = turn.prompt;
		}

		// What to draw, and in which order, is `turnItems` (#95): the tool calls
		// folded into groups with the vault changes and sources left outside.
		const items = turnItems(turn.entries, this.options.presentation());
		const folds = this.folds.turn(turn.id);
		const names = nameTurnItems(items, folds.names);
		folds.names.clear();
		for (const [id, name] of names.members) folds.names.set(id, name);
		// A group split off from one the reader opened, or merged with one, opens
		// as they left it; opened wins over closed, so nothing they were reading
		// folds away under them.
		for (const [key, from] of names.related) {
			const choices = from.map((name) => folds.open.get(name));
			if (choices.includes(true)) folds.open.set(key, true);
			else if (!folds.open.has(key) && choices.includes(false)) folds.open.set(key, false);
		}

		const vaultPath = this.options.vaultPath();
		const openRun = openRunIndex(items);
		const facts: ItemFacts[] = items.map((_, index) => ({
			vaultPath,
			activity,
			openRun: index === openRun,
		}));
		const signatures = items.map((item, index) => itemSignature(item, facts[index] as ItemFacts));
		const kept = new Set<string>();
		items.forEach((item, index) => {
			const key = names.keys[index] ?? '';
			const old = drawn.items.get(key);
			if (old && old.kind === item.kind && old.signature === signatures[index]) kept.add(key);
		});

		// What changed or went first, so a new element never sits beside the
		// one it replaces.
		for (const [key, item] of drawn.items) {
			if (kept.has(key)) continue;
			item.component.unload();
			item.el?.remove();
			changed = true;
		}

		const next = new Map<string, DrawnItem>();
		items.forEach((item, index) => {
			const key = names.keys[index] ?? '';
			const old = drawn.items.get(key);
			if (old && kept.has(key)) {
				next.set(key, old);
				return;
			}
			next.set(
				key,
				this.drawItem(turnEl, turn.id, key, item, signatures[index] ?? '', facts[index] as ItemFacts),
			);
			changed = true;
		});
		drawn.items = next;

		this.order(drawn);
		if (changed) this.markHeadings(turn.id, drawn);
	}

	/** One item drawn on its own component, at the end of the turn for now. */
	private drawItem(
		turnEl: HTMLElement,
		turnId: string,
		key: string,
		item: TurnItem,
		signature: string,
		facts: ItemFacts,
	): DrawnItem {
		const component = new Component();
		component.load();
		const open = this.folds.turn(turnId).open;
		const draw = drawItem(item, {
			parent: turnEl,
			component,
			options: this.options,
			facts,
			disclose: (details, defaultOpen) => {
				// What this view last set, so its own change is not taken for the
				// reader's: the browser fires `toggle` for both.
				let applied = open.get(key) ?? defaultOpen;
				details.open = applied;
				component.registerDomEvent(details, 'toggle', () => {
					if (details.open === applied) return;
					applied = details.open;
					open.set(key, applied);
				});
				// Reading inside a disclosure the view opened is a choice to keep it
				// (#128): a running group folds once it settles, and must not fold
				// under a reader who is selecting or following a row in it. Ovis's
				// `keepOpen` (devswha/ovis, MIT). A click on the summary is a toggle,
				// which the listener above takes.
				component.registerDomEvent(details, 'click', (event) => {
					const target = event.target as HTMLElement | null;
					if (!details.open || open.has(key) || target?.closest('summary')) return;
					open.set(key, true);
				});
			},
		});
		return { kind: item.kind, signature, el: draw.el, component, prose: draw.prose ?? null };
	}

	/**
	 * Puts the turn's elements in their order: the prompt, then the items. An
	 * element already in its place is not touched, so appending to a turn moves
	 * nothing and only a new item in the middle is inserted where it belongs.
	 */
	private order(drawn: DrawnTurn): void {
		const els: HTMLElement[] = [];
		if (drawn.promptEl) els.push(drawn.promptEl);
		for (const item of drawn.items.values()) if (item.el) els.push(item.el);
		els.forEach((el, index) => {
			const at = drawn.el.children[index] ?? null;
			if (at !== el) drawn.el.insertBefore(el, at);
		});
	}

	/**
	 * Writes the anchors a heading click aims at (#118), once the turn's prose
	 * has rendered: the turn's id and the heading's place in the turn, on every
	 * `h1`-`h6` of its prose in document order.
	 *
	 * Obsidian's rendered output carries nothing of this plugin's, and the
	 * render is async, so this waits for every prose render the turn holds —
	 * those already landed, and those this draw started. A turn drawn again
	 * since takes the mark over, which is what the token guards.
	 */
	private markHeadings(turnId: string, drawn: DrawnTurn): void {
		const token = Symbol('draw');
		drawn.headingToken = token;
		drawn.headingEls = [];
		const prose = [...drawn.items.values()].filter((item) => item.prose !== null);
		const renders = prose.flatMap((item) => (item.prose ? [item.prose] : []));
		const mark = (): void => {
			if (drawn.headingToken !== token) return;
			const found: HTMLElement[] = [];
			for (const item of prose) {
				if (item.el) found.push(...Array.from(item.el.querySelectorAll<HTMLElement>(HEADING_TAGS)));
			}
			found.forEach((headingEl, index) => {
				headingEl.setAttr('data-herdr-turn', turnId);
				headingEl.setAttr('data-herdr-heading', String(index));
			});
			drawn.headingEls = found;
		};
		if (prose.length === 0) {
			mark();
			return;
		}
		void Promise.allSettled(renders).then(mark);
	}
}

/**
 * Assistant prose, through Obsidian's own renderer. The block is the turn's
 * prose, because the headings inside it are the ones the table of contents
 * lists (#118) and nothing else in a turn counts.
 */
function renderText(entry: TextEntry, context: ItemContext): ItemDraw {
	const el = context.parent.createDiv({ cls: 'herdr-native-block' });
	return { el, prose: context.options.renderMarkdown(entry.text, el, context.component) };
}

/**
 * A thought, collapsed (#95), in a `details` whose open state the reader's
 * choice decides once they have made one (#127).
 *
 * A block with no text is an encrypted thought this build cannot read, and
 * renders nothing rather than an empty disclosure.
 */
function renderThinking(entry: ThinkingEntry, context: ItemContext): ItemDraw {
	if (!entry.text.trim()) return { el: null };
	const details = context.parent.createEl('details', { cls: 'herdr-native-thinking' });
	details.createEl('summary', { cls: 'herdr-native-thinking-summary', text: 'Thought' });
	const bodyEl = details.createDiv({ cls: 'herdr-native-thought' });
	context.disclose(details, false);
	// Not prose as far as the headings go: only text entries are paired with
	// the reducer's headings (#118).
	void context.options.renderMarkdown(entry.text, bodyEl, context.component);
	return { el: details };
}

/** The tool group: one summary line that expands to a row per call. */
function renderToolGroup(tools: readonly ToolEntry[], context: ItemContext): ItemDraw {
	const { activity, openRun, vaultPath } = context.facts;
	const state = toolGroupState(tools, activity, openRun);
	const header = toolGroupHeader(tools, state);
	const details = context.parent.createEl('details', { cls: 'herdr-native-tools' });
	if (state !== 'settled') details.addClass(state === 'live' ? 'is-live' : 'is-waiting');
	// The header in three parts (#128): where the group stands, the counts,
	// which a narrow view may cut short, and the failures, which it never cuts.
	// The parts are flex items, which a screen reader may run together, so the
	// summary says the whole line once in words.
	const label = [header.title, header.counts, header.failed].filter(Boolean).join(', ');
	const lineEl = details
		.createEl('summary', { cls: 'herdr-native-tools-summary', attr: { 'aria-label': label } })
		.createSpan({ cls: 'herdr-native-tools-line' });
	lineEl.createSpan({ cls: 'herdr-native-tools-title', text: header.title });
	const separator = (): void => {
		lineEl.createSpan({ cls: 'herdr-native-tools-separator', text: '·', attr: { 'aria-hidden': 'true' } });
	};
	if (header.counts) {
		separator();
		lineEl.createSpan({ cls: 'herdr-native-tools-counts', text: header.counts });
	}
	if (header.failed) {
		separator();
		lineEl.createSpan({ cls: 'herdr-native-tools-failed', text: header.failed });
	}
	for (const entry of tools) {
		const detail = toolDetail(entry, vaultPath);
		const rowEl = details.createDiv({
			cls: 'herdr-native-tool',
			text: detail ? `${entry.name} ${detail}` : entry.name,
		});
		if (entry.status === 'error') rowEl.addClass('is-error');
		if (entry.status === 'lost') rowEl.addClass('is-lost');
	}
	context.disclose(details, toolGroupStartsOpen(state));
	return { el: details };
}

/**
 * A file the agent wrote or edited, at the point in the turn where it did.
 * Inside the vault it is a link to the note, so a reader can go and read it;
 * outside there is nothing to strip and nothing to open, so the path shows
 * as it was. No diff either way (native-view-design.md).
 *
 * What the line says follows the call's status (#91): a change that was
 * refused, or that nothing has answered yet, must not read as one that
 * landed.
 */
function renderVaultChange(entry: ToolEntry, context: ItemContext): ItemDraw {
	const path = changedPath(entry);
	if (!path) return { el: null };
	const el = context.parent.createDiv({ cls: 'herdr-native-change' });
	const state = changeStateClass(entry.status);
	if (state) el.addClass(state);
	const { lead, trail } = changeLine(entry.status);
	el.appendText(lead);
	const link = vaultNoteLink(path, context.facts.vaultPath);
	if (link) renderPrompt(el, `[[${link}]]`, context.options.resolveUri);
	else el.appendText(path);
	if (trail) el.appendText(trail);
	return { el };
}

/**
 * What a subagent reported, as prose (#96): the turn's own text and the text
 * of the agent it sent out read the same way, which is the point of showing
 * it at all. The call that launched it stays folded in the tool group.
 */
function renderSubagentReport(entry: ToolEntry, context: ItemContext): ItemDraw {
	const report = subagentReport(entry);
	if (!report) return { el: null };
	const el = context.parent.createDiv({ cls: 'herdr-native-report' });
	// Not prose either, as far as the headings go (#118).
	void context.options.renderMarkdown(report, el, context.component);
	return { el };
}

/**
 * A to-do list update, where the turn made it (#143): the list as a
 * checklist under a line that says how far it has got. The turn's latest
 * update starts open and every earlier one folded, so a long turn shows
 * where it has got to and keeps how it got there; the reader's choice wins.
 * A list that cannot be read is the line alone.
 */
function renderTodo(entry: ToolEntry, latest: boolean, context: ItemContext): ItemDraw {
	const items = todoList(entry);
	if (!items) {
		const el = context.parent.createDiv({ cls: 'herdr-native-todo', text: 'Updated the to-do list' });
		return { el };
	}
	const details = context.parent.createEl('details', { cls: 'herdr-native-todo' });
	details.createEl('summary', {
		cls: 'herdr-native-todo-summary',
		text: items.length ? `Updated the to-do list · ${progressText(items)}` : 'Cleared the to-do list',
	});
	if (items.length) renderChecklist(details, items);
	context.disclose(details, latest);
	return { el: details };
}

/**
 * A web search or a fetch: where the turn's facts came from.
 *
 * A fetch is the one page it asked for. A search is the query it ran and the
 * pages it came back with, which live in the result rather than the input
 * (#95, `./toolCalls.ts`); a search that returned none shows its query alone.
 * External links are Obsidian's to open, so they get no handler of ours.
 */
function renderSource(entry: ToolEntry, context: ItemContext): ItemDraw {
	const { label, url, links } = sourceText(entry);
	const el = context.parent.createDiv({ cls: 'herdr-native-source' });
	if (url) {
		el.createEl('a', { cls: 'external-link', text: label, href: url });
		return { el };
	}
	el.createDiv({ cls: 'herdr-native-source-query', text: label });
	for (const link of links) {
		el.createEl('a', {
			cls: ['herdr-native-source-link', 'external-link'],
			text: link.title,
			href: link.url,
		});
	}
	return { el };
}

/**
 * A picture sent with the prompt, as a placeholder (#129): the bytes stay in
 * the transcript, and the line says one was there and of what type.
 */
export function imageLabel(entry: ImageEntry): string {
	const subtype = entry.mediaType.split('/')[1]?.trim();
	return subtype ? `Image (${subtype.toUpperCase()})` : 'Image';
}

function renderImage(entry: ImageEntry, context: ItemContext): ItemDraw {
	return { el: context.parent.createDiv({ cls: 'herdr-native-image', text: imageLabel(entry) }) };
}

/**
 * A compaction (#130): a slim divider, "Context compacted", that opens to the
 * summary the agent continued from. The summary is rendered the first time it
 * is open — it runs to pages, and most readers never open it — and is not
 * prose as far as the headings go (#118).
 */
function renderCompaction(entry: CompactionEntry, context: ItemContext): ItemDraw {
	const details = context.parent.createEl('details', { cls: 'herdr-native-compaction' });
	details.createEl('summary', { cls: 'herdr-native-compaction-summary', text: 'Context compacted' });
	const bodyEl = details.createDiv({ cls: 'herdr-native-compaction-body' });
	let rendered = false;
	const renderOnce = (): void => {
		if (rendered || !details.open || !entry.summary) return;
		rendered = true;
		void context.options.renderMarkdown(entry.summary, bodyEl, context.component);
	};
	context.component.registerDomEvent(details, 'toggle', renderOnce);
	context.disclose(details, false);
	renderOnce();
	return { el: details };
}

/** The runtime's own notice (#133), a muted line where it was written. */
function renderNotice(entry: NoticeEntry, context: ItemContext): ItemDraw {
	return { el: context.parent.createDiv({ cls: 'herdr-native-notice', text: entry.text }) };
}

/**
 * A bash-mode command and what it printed (#133): the command as the human
 * typed it after the `!`, then its output as the terminal showed it, stderr
 * marked as such. Nothing yet while the command is still running.
 */
function renderShell(entry: ShellEntry, context: ItemContext): ItemDraw {
	const el = context.parent.createDiv({ cls: 'herdr-native-shell' });
	el.createDiv({ cls: 'herdr-native-shell-command', text: `! ${entry.command}` });
	if (entry.stdout) el.createEl('pre', { cls: 'herdr-native-shell-output', text: entry.stdout });
	if (entry.stderr) el.createEl('pre', { cls: ['herdr-native-shell-output', 'is-error'], text: entry.stderr });
	return { el };
}
