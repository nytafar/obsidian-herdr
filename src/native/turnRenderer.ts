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
 * It holds one element and one `Component` per turn, and the heading anchors a
 * TOC click aims at. Everything around the turns — the scroll, the lines under
 * them, the waiting card — is the surface's (`./surface.ts`), which hands this
 * the Markdown renderer it tracks for the scroll.
 */

import { Component } from 'obsidian';
import type {
	CompactionEntry,
	ImageEntry,
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
	toolDetail,
	toolGroupSummary,
	turnItems,
	vaultNoteLink,
	type ToolGroupPresentation,
	type TurnItem,
} from './toolCalls';
import { fillUriLink } from './noteLinks';
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

/**
 * What one turn's draw collects for the heading anchors (#118): the elements
 * its assistant prose was rendered into, in document order, and the renders
 * that have to land before those elements hold anything.
 *
 * Prose only. A thought, a subagent report and a tool detail are Markdown too,
 * but the reducer's `turnHeadings` reads `text` entries alone, and a heading
 * counted here that the reducer never saw would shift every index after it.
 */
interface TurnDraw {
	proseEls: HTMLElement[];
	renders: Promise<void>[];
}

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
	/** A turn element was created: it is the one Claude is writing. */
	onTurnCreated?: (turnEl: HTMLElement) => void;
}

/**
 * The turns of one attached view, drawn into the reading view's sizer.
 *
 * Every DOM listener and every rendered Markdown child hangs off a `Component`
 * per turn that is unloaded when its turn is redrawn or the turns are cleared.
 */
export class TurnRenderer {
	/** One element per turn id, in the order the turns arrived. */
	private readonly turnEls = new Map<string, HTMLElement>();
	/** One component per turn: its listeners and its rendered Markdown. */
	private readonly turnComponents = new Map<string, Component>();
	/**
	 * The heading elements of each turn's prose, in the order the reducer counts
	 * them, once that turn's Markdown has rendered (#118). Empty until it has.
	 */
	private readonly turnHeadingEls = new Map<string, HTMLElement[]>();
	/**
	 * Which draw owns each turn's headings. A turn is redrawn while Claude
	 * writes, so a render that lands after the draw it belonged to was replaced
	 * must mark nothing: its elements are already out of the document.
	 */
	private readonly headingDraws = new Map<string, symbol>();

	constructor(
		private readonly sizerEl: HTMLElement,
		private readonly options: TurnRendererOptions,
	) {}

	/** How many turns are drawn. */
	get size(): number {
		return this.turnEls.size;
	}

	/** The element a turn was drawn into, or undefined for a turn not drawn. */
	turnEl(turnId: string): HTMLElement | undefined {
		return this.turnEls.get(turnId);
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
		const els = this.turnHeadingEls.get(turnId) ?? [];
		return els.length === headingCount ? els[index] : undefined;
	}

	/** Drops every turn element and the components that went with them. */
	clear(): void {
		for (const component of this.turnComponents.values()) component.unload();
		this.turnComponents.clear();
		this.turnEls.clear();
		this.turnHeadingEls.clear();
		this.headingDraws.clear();
		this.sizerEl.empty();
	}

	/**
	 * Draws one turn into its own element, which is created on first sight and
	 * reused afterwards: a turn that grows while Claude writes keeps its place
	 * in the view, and the turns around it are not touched.
	 */
	render(turn: Turn): void {
		let turnEl = this.turnEls.get(turn.id);
		if (!turnEl) {
			turnEl = this.sizerEl.createDiv({ cls: 'herdr-native-turn' });
			this.turnEls.set(turn.id, turnEl);
			// The turn Claude is writing is the one that grows under the view.
			this.options.onTurnCreated?.(turnEl);
		}
		turnEl.empty();
		this.turnComponents.get(turn.id)?.unload();
		const component = new Component();
		component.load();
		this.turnComponents.set(turn.id, component);

		if (turn.prompt) {
			this.renderPrompt(turnEl.createDiv({ cls: 'herdr-native-prompt' }), turn.prompt);
		}
		// What to draw, and in which order, is `turnItems` (#95): the tool calls
		// folded into groups with the vault changes and sources left outside.
		const draw: TurnDraw = { proseEls: [], renders: [] };
		for (const item of turnItems(turn.entries, this.options.presentation())) {
			this.renderItem(turnEl, item, component, draw);
		}
		this.markHeadings(turn, draw);
	}

	private renderItem(
		turnEl: HTMLElement,
		item: TurnItem,
		component: Component,
		draw: TurnDraw,
	): void {
		switch (item.kind) {
			case 'text':
				this.renderText(turnEl, item.entry, component, draw);
				return;
			case 'thinking':
				this.renderThinking(turnEl, item.entry, component);
				return;
			case 'group':
				this.renderToolGroup(turnEl, item.tools);
				return;
			case 'change':
				this.renderVaultChange(turnEl, item.entry);
				return;
			case 'source':
				this.renderSource(turnEl, item.entry);
				return;
			case 'report':
				this.renderSubagentReport(turnEl, item.entry, component);
				return;
			case 'steer':
				// A steer is shown where it entered the running turn (CONTEXT.md).
				this.renderPrompt(turnEl.createDiv({ cls: 'herdr-native-steer' }), item.entry.text);
				return;
			case 'image':
				renderImage(turnEl, item.entry);
				return;
			case 'compaction':
				this.renderCompaction(turnEl, item.entry, component);
				return;
		}
	}

	/**
	 * A compaction (#130): a slim divider, "Context compacted", that opens to
	 * the summary the agent continued from. The summary is rendered on the
	 * first open only — it runs to pages, and most readers never open it — and
	 * is not prose as far as the headings go (#118).
	 */
	private renderCompaction(turnEl: HTMLElement, entry: CompactionEntry, component: Component): void {
		const details = turnEl.createEl('details', { cls: 'herdr-native-compaction' });
		details.createEl('summary', { cls: 'herdr-native-compaction-summary', text: 'Context compacted' });
		const bodyEl = details.createDiv({ cls: 'herdr-native-compaction-body' });
		let rendered = false;
		component.registerDomEvent(details, 'toggle', () => {
			if (rendered || !details.open || !entry.summary) return;
			rendered = true;
			void this.options.renderMarkdown(entry.summary, bodyEl, component);
		});
	}

	private renderPrompt(el: HTMLElement, prompt: string): void {
		renderPrompt(el, prompt, this.options.resolveUri);
	}

	/**
	 * Assistant prose, through Obsidian's own renderer. The block is the draw's,
	 * because the headings inside it are the ones the table of contents lists
	 * (#118) and nothing else in a turn counts.
	 */
	private renderText(
		turnEl: HTMLElement,
		entry: TextEntry,
		component: Component,
		draw: TurnDraw,
	): void {
		const blockEl = turnEl.createDiv({ cls: 'herdr-native-block' });
		draw.proseEls.push(blockEl);
		draw.renders.push(this.options.renderMarkdown(entry.text, blockEl, component));
	}

	/**
	 * Writes the anchors a heading click aims at (#118), once the draw's
	 * Markdown has rendered: the turn's id and the heading's place in the turn,
	 * on every `h1`-`h6` of its prose in document order.
	 *
	 * Obsidian's rendered output carries nothing of this plugin's, and the
	 * render is async, so this is the only moment the elements exist and are
	 * still the ones on screen. A turn redrawn since takes the mark over, which
	 * is what the draw token guards: `render` empties the element, so a render
	 * that lands late would otherwise mark elements nobody can see.
	 */
	private markHeadings(turn: Turn, draw: TurnDraw): void {
		const token = Symbol('draw');
		this.headingDraws.set(turn.id, token);
		this.turnHeadingEls.delete(turn.id);
		const mark = (): void => {
			if (this.headingDraws.get(turn.id) !== token) return;
			const found: HTMLElement[] = [];
			for (const proseEl of draw.proseEls) {
				found.push(...Array.from(proseEl.querySelectorAll<HTMLElement>(HEADING_TAGS)));
			}
			found.forEach((headingEl, index) => {
				headingEl.setAttr('data-herdr-turn', turn.id);
				headingEl.setAttr('data-herdr-heading', String(index));
			});
			this.turnHeadingEls.set(turn.id, found);
		};
		if (draw.renders.length === 0) {
			mark();
			return;
		}
		void Promise.allSettled(draw.renders).then(mark);
	}

	/**
	 * A thought, collapsed (#95). A `details` rather than a click handler: the
	 * browser owns the open state, so a turn redrawn while Claude writes does not
	 * fight the reader, and nothing has to be torn down.
	 *
	 * A block with no text is an encrypted thought this build cannot read, and
	 * renders nothing rather than an empty disclosure.
	 */
	private renderThinking(
		turnEl: HTMLElement,
		entry: ThinkingEntry,
		component: Component,
	): void {
		if (!entry.text.trim()) return;
		const details = turnEl.createEl('details', { cls: 'herdr-native-thinking' });
		details.createEl('summary', { cls: 'herdr-native-thinking-summary', text: 'Thought' });
		const bodyEl = details.createDiv({ cls: 'herdr-native-thought' });
		// The promise is the draw's business, and a thought is not in it: only
		// prose is paired with the reducer's headings (#118).
		void this.options.renderMarkdown(entry.text, bodyEl, component);
	}

	/** The tool group: one summary line that expands to a row per call. */
	private renderToolGroup(turnEl: HTMLElement, tools: readonly ToolEntry[]): void {
		const details = turnEl.createEl('details', { cls: 'herdr-native-tools' });
		details.createEl('summary', {
			cls: 'herdr-native-tools-summary',
			text: toolGroupSummary(tools),
		});
		const vaultPath = this.options.vaultPath();
		for (const entry of tools) {
			const detail = toolDetail(entry, vaultPath);
			details.createDiv({
				cls: 'herdr-native-tool',
				text: detail ? `${entry.name} ${detail}` : entry.name,
			});
		}
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
	private renderVaultChange(turnEl: HTMLElement, entry: ToolEntry): void {
		const path = changedPath(entry);
		if (!path) return;
		const el = turnEl.createDiv({ cls: 'herdr-native-change' });
		const state = changeStateClass(entry.status);
		if (state) el.addClass(state);
		const { lead, trail } = changeLine(entry.status);
		el.appendText(lead);
		const link = vaultNoteLink(path, this.options.vaultPath());
		if (link) this.renderPrompt(el, `[[${link}]]`);
		else el.appendText(path);
		if (trail) el.appendText(trail);
	}

	/**
	 * What a subagent reported, as prose (#96): the turn's own text and the text
	 * of the agent it sent out read the same way, which is the point of showing
	 * it at all. The call that launched it stays folded in the tool group.
	 */
	private renderSubagentReport(
		turnEl: HTMLElement,
		entry: ToolEntry,
		component: Component,
	): void {
		const report = subagentReport(entry);
		if (!report) return;
		const blockEl = turnEl.createDiv({ cls: 'herdr-native-report' });
		// Not prose either, as far as the headings go (#118).
		void this.options.renderMarkdown(report, blockEl, component);
	}

	/**
	 * A web search or a fetch: where the turn's facts came from.
	 *
	 * A fetch is the one page it asked for. A search is the query it ran and the
	 * pages it came back with, which live in the result rather than the input
	 * (#95, `./toolCalls.ts`); a search that returned none shows its query alone.
	 * External links are Obsidian's to open, so they get no handler of ours.
	 */
	private renderSource(turnEl: HTMLElement, entry: ToolEntry): void {
		const { label, url, links } = sourceText(entry);
		const el = turnEl.createDiv({ cls: 'herdr-native-source' });
		if (url) {
			el.createEl('a', { cls: 'external-link', text: label, href: url });
			return;
		}
		el.createDiv({ cls: 'herdr-native-source-query', text: label });
		for (const link of links) {
			el.createEl('a', {
				cls: ['herdr-native-source-link', 'external-link'],
				text: link.title,
				href: link.url,
			});
		}
	}
}

/**
 * A picture sent with the prompt, as a placeholder (#129): the bytes stay in
 * the transcript, and the line says one was there and of what type.
 */
export function imageLabel(entry: ImageEntry): string {
	const subtype = entry.mediaType.split('/')[1]?.trim();
	return subtype ? `Image (${subtype.toUpperCase()})` : 'Image';
}

function renderImage(turnEl: HTMLElement, entry: ImageEntry): void {
	turnEl.createDiv({ cls: 'herdr-native-image', text: imageLabel(entry) });
}
