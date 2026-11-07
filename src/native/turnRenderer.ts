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

import { Component, setTooltip } from 'obsidian';
import { FoldMemory } from './foldMemory';
import { nameTurnItems } from './itemKeys';
import type {
	CompactionEntry,
	ImageBytes,
	ImageEntry,
	NoticeEntry,
	ResumeEntry,
	ShellEntry,
	TextEntry,
	ThinkingEntry,
	ToolEntry,
	Turn,
} from './conversation';
import { turnHeadings } from './conversation';
import {
	changedPath,
	changeLine,
	changeStateClass,
	sourceText,
	subagentActivity,
	subagentLabel,
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
import { copyButton, defaultCopier, renderReplyActions, replyMarkdown, type Copier } from './copyActions';
import type { ToolTable } from '../agents/format';
import { workSpan, type WorkSpan } from './turnTime';

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
 * What {@link renderPrompt} draws a prompt from: its text and where each of
 * its `obsidian://` URIs resolves now. A URI is resolved against the vault at
 * draw time, so a link to a note created since is a different drawing of the
 * same text.
 */
export function promptSignature(prompt: string, resolveUri: (uri: string) => string | null): string {
	const resolved = promptSegments(prompt).flatMap((segment) =>
		segment.kind === 'uri' ? [resolveUri(segment.uri)] : [],
	);
	return JSON.stringify([prompt, resolved]);
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
	/**
	 * The call that left the session's newest to-do list, the one update drawn
	 * open (#143); read on every draw. Left out, a turn's own last update is
	 * taken, as for a turn drawn with no session around it.
	 */
	latestTodoId?: () => string | null;
	/**
	 * Where the copy buttons put text and say they could not (#140): the
	 * clipboard and a notice when left out.
	 */
	copier?: Copier;
	/** A turn element was created: it is the one Claude is writing. */
	onTurnCreated?: (turnEl: HTMLElement) => void;
	/**
	 * An image's bytes, read from the transcript when its thumbnail comes into
	 * view (#144). Left out, an image is its label alone.
	 */
	readImage?: (image: ImageEntry) => Promise<ImageBytes | null>;
	/** Shows an image full size, on a click on its thumbnail (#144). */
	openImage?: (image: ShownImage) => void;
	/**
	 * The tool table of the session's format, which says what each call is
	 * shown as (ADR-0010); read on every draw. Left out, every format's.
	 */
	toolTable?: () => ToolTable;
	/**
	 * The time now, in ms, for labelling a prompt's time by calendar day
	 * (#139): `Date.now` when left out.
	 */
	now?: () => number;
	/**
	 * Opens the transcript of the subagent working under a call (#147). Left
	 * out, a subagent at work is its line alone.
	 */
	openSubagent?: (call: ToolEntry) => void;
}

/** An image as the view shows it: a source an `img` takes, and what it is. */
export interface ShownImage {
	src: string;
	label: string;
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
	/** Whether this item is the session's newest to-do update (#143). */
	latestTodo: boolean;
	/** Where an `obsidian://` URI resolves in the vault now (#114). */
	resolveUri: (uri: string) => string | null;
	/** The session's format's tool table, as `TurnRendererOptions.toolTable` gives it. */
	toolTable: ToolTable;
	/** The time now, in ms, as `TurnRendererOptions.now` gives it (#139). */
	now: number;
	/**
	 * Whether this item is resumed work the agent is still doing (#139): the
	 * turn's last resume while the turn is active, whose duration is not known yet.
	 */
	liveResume: boolean;
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
	/** How many headings the parser counts in that prose (`turnHeadings`). */
	headingCount?: number;
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
		signature: (item, facts) => promptSignature(item.entry.text, facts.resolveUri),
		// A steer is shown where it entered the running turn (CONTEXT.md).
		render: (item, context) => {
			const el = context.parent.createDiv({ cls: 'herdr-native-steer' });
			renderPrompt(el, item.entry.text, context.options.resolveUri);
			copyPromptButton(el, context.component, item.entry.text, context.options);
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
		signature: (item, facts) => subagentReport(item.entry, facts.toolTable),
		render: (item, context) => renderSubagentReport(item.entry, context),
	},
	subagent: {
		signature: (item, facts) => JSON.stringify(subagentLine(item.entry, facts.vaultPath)),
		render: (item, context) => renderSubagent(item.entry, context),
	},
	todo: {
		signature: (item, facts) => JSON.stringify([facts.latestTodo, todoList(item.entry, facts.toolTable)]),
		render: (item, context) => renderTodo(item.entry, context.facts.latestTodo, context),
	},
	image: {
		signature: (item) => JSON.stringify([item.entry.mediaType, item.entry.record, item.entry.index]),
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
	resume: {
		signature: (item, facts) =>
			JSON.stringify([item.entry.cause, item.entry.text, resumeSpan(item.entry, facts)]),
		render: (item, context) => renderResume(item.entry, context),
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
	/** How many headings the parser counts in its prose (#118); 0 when it is not prose. */
	headingCount: number;
	/**
	 * The heading elements its prose rendered, in document order, once that
	 * render has landed; null until then.
	 */
	headings: HTMLElement[] | null;
}

/** One turn as it stands on screen. */
interface DrawnTurn {
	el: HTMLElement;
	/**
	 * The prompt's signature as last drawn (`promptSignature`, '' for none),
	 * and its element; null for a turn without one.
	 */
	prompt: string;
	promptEl: HTMLElement | null;
	/**
	 * The prompt's time and the turn's duration as last drawn (#139), and
	 * their element; '' and null for a turn whose time is not known.
	 */
	meta: string;
	metaEl: HTMLElement | null;
	/** The prompt's copy button's listener and timer (#140); null without a prompt. */
	promptComponent: Component | null;
	/** The reply as Markdown, read by its copy buttons at the click (#140). */
	reply: string;
	/** The reply's copy buttons under the turn, once it has one (#140). */
	replyActions: { el: HTMLElement; component: Component } | null;
	/** Its items by name, in the order they are drawn. */
	items: Map<string, DrawnItem>;
	/**
	 * Which marking of the headings is current. A render that lands after the
	 * turn was drawn again must mark nothing: its elements may be gone.
	 */
	headingToken: symbol;
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
	 * position, one prose block at a time, and only while the block has as many
	 * of one as of the other: a heading the regex saw inside an indented code
	 * block, or one it missed, makes every index after it in that block a lie.
	 * A block whose render has not landed has no anchors yet, which leaves the
	 * blocks before it — the kept prose of a turn Claude is still writing —
	 * reachable.
	 */
	headingEl(turnId: string, index: number, headingCount: number | undefined): HTMLElement | undefined {
		const drawn = this.turns.get(turnId);
		if (!drawn) return undefined;
		const prose = [...drawn.items.values()].filter((item) => item.prose !== null);
		const total = prose.reduce((count, item) => count + item.headingCount, 0);
		if (total !== headingCount) return undefined;
		let offset = 0;
		for (const item of prose) {
			if (index < offset + item.headingCount) {
				const els = item.headings;
				return els && els.length === item.headingCount ? els[index - offset] : undefined;
			}
			offset += item.headingCount;
		}
		return undefined;
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
		drawn.promptComponent?.unload();
		drawn.replyActions?.component.unload();
		drawn.el.remove();
		this.turns.delete(turnId);
	}

	/** Drops every turn element and the components that went with them. */
	clear(): void {
		for (const drawn of this.turns.values()) {
			for (const item of drawn.items.values()) item.component.unload();
			drawn.promptComponent?.unload();
			drawn.replyActions?.component.unload();
			drawn.el.remove();
		}
		this.turns.clear();
	}

	/** The id of the earliest turn drawn, or null when none is (#152). */
	firstTurnId(): string | null {
		for (const id of this.turns.keys()) return id;
		return null;
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
				meta: '',
				metaEl: null,
				promptComponent: null,
				reply: '',
				replyActions: null,
				items: new Map(),
				headingToken: Symbol('draw'),
			};
			this.turns.set(turn.id, drawn);
			// The turn Claude is writing is the one that grows under the view.
			this.options.onTurnCreated?.(el);
		}
		const turnEl = drawn.el;
		let changed = false;

		const prompt = turn.prompt ? promptSignature(turn.prompt, this.options.resolveUri) : '';
		if (prompt !== drawn.prompt || (turn.prompt && !drawn.promptEl)) {
			drawn.promptEl?.remove();
			drawn.promptEl = null;
			drawn.promptComponent?.unload();
			drawn.promptComponent = null;
			if (turn.prompt) {
				drawn.promptEl = turnEl.createDiv({ cls: 'herdr-native-prompt' });
				renderPrompt(drawn.promptEl, turn.prompt, this.options.resolveUri);
				drawn.promptComponent = new Component();
				drawn.promptComponent.load();
				copyPromptButton(drawn.promptEl, drawn.promptComponent, turn.prompt, this.options);
			}
			drawn.prompt = prompt;
		}

		// What to draw, and in which order, is `turnItems` (#95): the tool calls
		// folded into groups with the vault changes and sources left outside.
		const toolTable = this.options.toolTable?.();
		const items = turnItems(turn.entries, this.options.presentation(), toolTable);
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
		const latestTodo = this.options.latestTodoId
			? this.options.latestTodoId()
			: lastTodoId(items);
		const now = (this.options.now ?? Date.now)();
		const lastResume = items.map((item) => item.kind).lastIndexOf('resume');
		const facts: ItemFacts[] = items.map((item, index) => ({
			vaultPath,
			activity,
			openRun: index === openRun,
			latestTodo: item.kind === 'todo' && item.entry.id === latestTodo,
			resolveUri: this.options.resolveUri,
			toolTable,
			now,
			liveResume: index === lastResume && activity !== null,
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
		this.drawReplyActions(drawn, replyMarkdown(turn));
		this.drawMeta(drawn, turn, activity, now);

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
				// under a reader who is selecting or following a row in it. A click
				// on the summary is a toggle, which the listener above takes.
				component.registerDomEvent(details, 'click', (event) => {
					const target = event.target as HTMLElement | null;
					if (!details.open || open.has(key) || target?.closest('summary')) return;
					open.set(key, true);
				});
			},
		});
		const drawnItem: DrawnItem = {
			kind: item.kind,
			signature,
			el: draw.el,
			component,
			prose: draw.prose ?? null,
			headingCount: draw.headingCount ?? 0,
			headings: null,
		};
		// Its anchors once its prose has rendered (#118), however the render ended.
		const found = (): void => {
			drawnItem.headings = draw.el ? Array.from(draw.el.querySelectorAll<HTMLElement>(HEADING_TAGS)) : [];
		};
		if (draw.prose) void draw.prose.then(found, found);
		return drawnItem;
	}

	/**
	 * The reply's copy buttons (#140): there while the turn has prose, gone
	 * when it has none. They read the reply at the click, so a reply that grows
	 * leaves them standing.
	 */
	private drawReplyActions(drawn: DrawnTurn, reply: string): void {
		drawn.reply = reply;
		if (reply && !drawn.replyActions) {
			const component = new Component();
			component.load();
			const el = renderReplyActions(
				drawn.el,
				component,
				() => drawn.reply,
				this.options.copier ?? defaultCopier,
			);
			drawn.replyActions = { el, component };
		} else if (!reply && drawn.replyActions) {
			drawn.replyActions.component.unload();
			drawn.replyActions.el.remove();
			drawn.replyActions = null;
		}
	}

	/**
	 * The prompt's time and how long the agent worked on it (#139), in one
	 * short line over the prompt. The duration is the prompt's own answer: it
	 * shows once that is over, which is when the turn is, or when the agent
	 * has since taken up other work on its own.
	 */
	private drawMeta(drawn: DrawnTurn, turn: Turn, activity: TurnActivity | null, now: number): void {
		const settled = activity === null || turn.entries.some((entry) => entry.kind === 'resume');
		const span = workSpan(turn.ts, turn.endTs, settled, now);
		const meta = span ? JSON.stringify(span) : '';
		if (meta === drawn.meta && (!span || drawn.metaEl)) return;
		drawn.metaEl?.remove();
		drawn.metaEl = null;
		drawn.meta = meta;
		if (!span) return;
		drawn.metaEl = drawn.el.createDiv({ cls: 'herdr-native-turn-meta' });
		renderSpan(drawn.metaEl, span);
	}

	/**
	 * Puts the turn's elements in their order: the prompt, then the items, then
	 * the reply's copy buttons. An element already in its place is not
	 * touched, so appending to a turn moves nothing that was there: a new item
	 * is inserted where it belongs, in front of the copy buttons at the end.
	 */
	private order(drawn: DrawnTurn): void {
		const els: HTMLElement[] = [];
		if (drawn.metaEl) els.push(drawn.metaEl);
		if (drawn.promptEl) els.push(drawn.promptEl);
		for (const item of drawn.items.values()) if (item.el) els.push(item.el);
		if (drawn.replyActions) els.push(drawn.replyActions.el);
		els.forEach((el, index) => {
			const at = drawn.el.children[index] ?? null;
			if (at !== el) drawn.el.insertBefore(el, at);
		});
	}

	/**
	 * Writes the anchors a heading click aims at (#118): the turn's id and the
	 * heading's place in the turn, on every `h1`-`h6` of its prose, block by
	 * block, each block's first heading numbered after the headings the parser
	 * counts in the blocks before it.
	 *
	 * Obsidian's rendered output carries nothing of this plugin's, and the
	 * render is async: a block kept from the last draw is marked now, and the
	 * rest once the renders this draw started have landed. A block still
	 * rendering takes nothing from the blocks before it. A turn drawn again
	 * since takes the mark over, which is what the token guards.
	 */
	private markHeadings(turnId: string, drawn: DrawnTurn): void {
		const token = Symbol('draw');
		drawn.headingToken = token;
		const prose = [...drawn.items.values()].filter((item) => item.prose !== null);
		const mark = (): void => {
			if (drawn.headingToken !== token) return;
			let offset = 0;
			for (const item of prose) {
				item.headings?.forEach((headingEl, index) => {
					headingEl.setAttr('data-herdr-turn', turnId);
					headingEl.setAttr('data-herdr-heading', String(offset + index));
				});
				offset += item.headingCount;
			}
		};
		mark();
		const rendering = prose.flatMap((item) => (item.headings === null && item.prose ? [item.prose] : []));
		if (rendering.length) void Promise.allSettled(rendering).then(mark);
	}
}

/** The call of a turn's last to-do update, or null when it made none. */
function lastTodoId(items: readonly TurnItem[]): string | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind === 'todo') return item.entry.id;
	}
	return null;
}

/** A prompt's copy button (#140): the prompt as typed, links and all. */
function copyPromptButton(
	el: HTMLElement,
	component: Component,
	prompt: string,
	options: TurnRendererOptions,
): void {
	copyButton(
		el,
		component,
		{ cls: 'herdr-native-copy-prompt', icon: 'copy', label: 'Copy prompt', text: () => prompt },
		options.copier ?? defaultCopier,
	);
}

/**
 * Assistant prose, through Obsidian's own renderer. The block is the turn's
 * prose, because the headings inside it are the ones the table of contents
 * lists (#118) and nothing else in a turn counts.
 */
function renderText(entry: TextEntry, context: ItemContext): ItemDraw {
	const el = context.parent.createDiv({ cls: 'herdr-native-block' });
	return {
		el,
		prose: context.options.renderMarkdown(entry.text, el, context.component),
		headingCount: turnHeadings([entry]).length,
	};
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
	// the parser's headings (#118).
	void context.options.renderMarkdown(entry.text, bodyEl, context.component);
	return { el: details };
}

/** The tool group: one summary line that expands to a row per call. */
function renderToolGroup(tools: readonly ToolEntry[], context: ItemContext): ItemDraw {
	const { activity, openRun, vaultPath } = context.facts;
	const state = toolGroupState(tools, activity, openRun);
	const header = toolGroupHeader(tools, state, context.facts.toolTable);
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
		if (entry.status === 'error' || entry.status === 'declined') rowEl.addClass('is-error');
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
	const report = subagentReport(entry, context.facts.toolTable);
	if (!report) return { el: null };
	const el = context.parent.createDiv({ cls: 'herdr-native-report' });
	// Not prose either, as far as the headings go (#118).
	void context.options.renderMarkdown(report, el, context.component);
	return { el };
}

/** What a subagent at work's line says (#147): everything its render reads. */
function subagentLine(entry: ToolEntry, vaultPath: string): { label: string; activity: string; calls: number } {
	const progress = entry.subagent;
	return {
		label: subagentLabel(entry),
		activity: progress ? subagentActivity(progress, vaultPath) : 'Starting',
		calls: progress?.calls ?? 0,
	};
}

/**
 * A subagent at work (#147): what it is, what it did last and how many calls
 * it made, with its whole transcript a click away where the view can open it.
 */
function renderSubagent(entry: ToolEntry, context: ItemContext): ItemDraw {
	const line = subagentLine(entry, context.facts.vaultPath);
	const el = context.parent.createDiv({ cls: 'herdr-native-subagent' });
	const head = el.createDiv({ cls: 'herdr-native-subagent-head' });
	head.createSpan({ cls: 'herdr-native-subagent-title', text: `Subagent working: ${line.label}` });
	if (line.calls > 0) {
		head.createSpan({
			cls: 'herdr-native-subagent-count',
			text: line.calls === 1 ? '1 call' : `${line.calls} calls`,
		});
	}
	el.createDiv({ cls: 'herdr-native-subagent-activity', text: line.activity });
	const open = context.options.openSubagent;
	if (open) {
		const button = el.createEl('button', {
			cls: 'herdr-native-subagent-open',
			text: 'Show transcript',
			attr: { type: 'button' },
		});
		context.component.registerDomEvent(button, 'click', () => open(entry));
	}
	return { el };
}

/**
 * A to-do list update, where the turn made it (#143): the list as a
 * checklist under a line that says how far it has got. The session's newest
 * update starts open and every earlier one folded, in this turn and in every
 * finished one, so the view shows where the work has got to and keeps how it
 * got there; the reader's choice wins.
 * A list that cannot be read is the line alone.
 */
function renderTodo(entry: ToolEntry, latest: boolean, context: ItemContext): ItemDraw {
	const items = todoList(entry, context.facts.toolTable);
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
 * A picture sent with the prompt (#129): what it is, as a label, which is all
 * the view shows until its bytes are read and where they cannot be.
 */
export function imageLabel(entry: ImageEntry): string {
	const subtype = entry.mediaType.split('/')[1]?.trim();
	return subtype ? `Image (${subtype.toUpperCase()})` : 'Image';
}

/**
 * Calls `load` once `el` comes near the visible part of the view, or at once
 * where nothing can say when that is. The observer goes with the component.
 */
function whenVisible(el: HTMLElement, component: Component, load: () => void): void {
	// The element's own window, so a view in a popout watches its own viewport.
	const win = el.win as (Window & { IntersectionObserver?: typeof IntersectionObserver }) | undefined;
	const Observer = win?.IntersectionObserver;
	if (!Observer) {
		load();
		return;
	}
	const observer = new Observer(
		(entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			load();
		},
		{ rootMargin: '400px 0px' },
	);
	observer.observe(el);
	component.register(() => observer.disconnect());
}

/**
 * A picture sent with the prompt (#144): a thumbnail, read from the
 * transcript only when it comes into view, so a long session's pictures are
 * not all read at open and none is held by the session model; a click shows
 * it full size. Until the bytes are there, and where they cannot be read, it
 * is the label.
 */
function renderImage(entry: ImageEntry, context: ItemContext): ItemDraw {
	const label = imageLabel(entry);
	const el = context.parent.createEl('button', {
		cls: 'herdr-native-image',
		attr: { type: 'button', 'aria-label': `Show ${label.toLowerCase()} full size` },
	});
	el.createSpan({ cls: 'herdr-native-image-label', text: label });
	const read = context.options.readImage;
	if (!read || !entry.record) {
		el.disabled = true;
		return { el };
	}
	let live = true;
	context.component.register(() => {
		live = false;
	});
	let shown: Promise<ShownImage | null> | null = null;
	const load = (): Promise<ShownImage | null> => {
		shown ??= read(entry).then(
			(bytes) => {
				if (!live) return null;
				// Not there (yet): a click asks again.
				if (!bytes) {
					shown = null;
					return null;
				}
				const image = { src: `data:${bytes.mediaType || entry.mediaType};base64,${bytes.data}`, label };
				el.empty();
				el.createEl('img', { cls: 'herdr-native-image-thumb', attr: { src: image.src, alt: label } });
				el.addClass('herdr-has-thumb');
				return image;
			},
			() => {
				shown = null;
				return null;
			},
		);
		return shown;
	};
	whenVisible(el, context.component, () => void load());
	context.component.registerDomEvent(el, 'click', () => {
		void load().then((image) => {
			if (image && live) context.options.openImage?.(image);
		});
	});
	return { el };
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
		if (rendered || !details.open) return;
		rendered = true;
		// An agent that keeps its summary unreadable (#137) still compacted.
		if (!entry.summary) bodyEl.setText('No readable summary.');
		else void context.options.renderMarkdown(entry.summary, bodyEl, context.component);
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
 * When a stretch of work started and, once it is over, how long it took
 * (#139): "14:02 · worked 7s", the full date and time on hover of each.
 */
function renderSpan(el: HTMLElement, span: WorkSpan): void {
	const time = el.createEl('time', { text: span.time.label, attr: { datetime: span.time.iso } });
	setTooltip(time, span.time.full);
	if (!span.duration) return;
	el.appendText(' \u00b7 ');
	const duration = el.createSpan({ cls: 'herdr-native-turn-duration', text: `worked ${span.duration}` });
	setTooltip(duration, `Worked for ${span.duration}, until ${span.endFull}`);
}

/** A resumed stretch's span: its start, and its duration once it is over. */
function resumeSpan(entry: ResumeEntry, facts: ItemFacts): WorkSpan | null {
	return workSpan(entry.ts, entry.endTs, !facts.liveResume, facts.now);
}

/** What set the agent working again, as the divider says it (#139). */
const RESUME_LABELS: Record<ResumeEntry['cause'], string> = {
	hook: 'Resumed by a hook',
	notification: 'Resumed by a notification',
	meta: 'Resumed by a runtime message',
	other: 'Resumed on its own',
};

/**
 * Where the agent took up work again on its own after answering (#139): a
 * divider inside the turn, saying what set it going, when, and for how long.
 * The cause's words stay on one line, in full on hover.
 */
function renderResume(entry: ResumeEntry, context: ItemContext): ItemDraw {
	const el = context.parent.createDiv({ cls: 'herdr-native-resume' });
	const head = el.createDiv({ cls: 'herdr-native-resume-head' });
	head.createSpan({ cls: 'herdr-native-resume-label', text: RESUME_LABELS[entry.cause] });
	const span = resumeSpan(entry, context.facts);
	if (span) renderSpan(head.createSpan({ cls: 'herdr-native-turn-meta' }), span);
	if (entry.text) {
		const text = el.createDiv({ cls: 'herdr-native-resume-text', text: entry.text });
		setTooltip(text, entry.text);
	}
	return { el };
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
