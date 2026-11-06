/**
 * Find in the conversation (#145): the reader types, the matches come back as
 * snippets, and picking one brings its turn into view with the match
 * highlighted.
 *
 * Two halves. {@link findInTurns} searches the reduced transcript, which is
 * what the session model holds for every turn whether it is on screen or not,
 * and is pure. {@link locateMatch} finds the same match in what was drawn, so
 * the view can scroll to it and mark it; rendered Markdown is not its source
 * (`**bold**` reads "bold"), so a match the drawing does not hold falls back to
 * the last one it does, and then to the turn.
 *
 * What is searched is what the reader reads as the conversation: the prompt,
 * the steers and the agent's prose, in that turn order. A thought, a tool call
 * and its output are folded away in the view and are not searched.
 */

import { SuggestModal, type App } from 'obsidian';
import type { Turn } from './conversation';
import { earlierLine } from './earlierTurns';

/** How many matches the picker lists at most. */
export const FIND_LIMIT = 50;
/** Characters of context shown each side of a match. */
const CONTEXT = 40;

/** Where in a turn a match is. */
export type FindPart = 'prompt' | 'steer' | 'reply';

/** One match of the query, for the picker and for the jump. */
export interface FindHit {
	turnId: string;
	/** The turn's place in the session, from 0. */
	turnIndex: number;
	part: FindPart;
	/** Which match of the query this is inside its turn, counted from 0. */
	occurrence: number;
	/** The match as written, and the text either side of it, on one line. */
	before: string;
	match: string;
	after: string;
}

/** The searchable text of one turn, in the order the view draws it. */
function partsOf(turn: Turn): { part: FindPart; text: string }[] {
	const parts: { part: FindPart; text: string }[] = [{ part: 'prompt', text: turn.prompt }];
	for (const entry of turn.entries) {
		if (entry.kind === 'text') parts.push({ part: 'reply', text: entry.text });
		else if (entry.kind === 'steer') parts.push({ part: 'steer', text: entry.text });
	}
	return parts;
}

/** Whitespace folded to single spaces, so a snippet stays on one line. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ');
}

/**
 * Every match of `query` in the turns, case-insensitive, in session order and
 * at most `limit`. An empty or blank query finds nothing.
 */
export function findInTurns(turns: readonly Turn[], query: string, limit = FIND_LIMIT): FindHit[] {
	const needle = query.trim().toLowerCase();
	if (needle === '') return [];
	const hits: FindHit[] = [];
	turns.forEach((turn, turnIndex) => {
		let occurrence = 0;
		for (const { part, text } of partsOf(turn)) {
			const haystack = text.toLowerCase();
			let at = haystack.indexOf(needle);
			while (at !== -1) {
				if (hits.length >= limit) return;
				const end = at + needle.length;
				const start = Math.max(0, at - CONTEXT);
				const stop = Math.min(text.length, end + CONTEXT);
				hits.push({
					turnId: turn.id,
					turnIndex,
					part,
					occurrence,
					before: (start > 0 ? '…' : '') + oneLine(text.slice(start, at)).trimStart(),
					match: text.slice(at, end),
					after: oneLine(text.slice(end, stop)).trimEnd() + (stop < text.length ? '…' : ''),
				});
				occurrence++;
				at = haystack.indexOf(needle, end);
			}
		}
	});
	return hits;
}

/**
 * What the picker says when nothing matched: that nothing did, and, when the
 * session model holds only its newest turns (#152), that the earlier ones
 * were not searched.
 */
export function findEmptyText(earlier: number): string {
	if (earlier === 0) return 'No matches.';
	return `No matches. ${earlierLine(earlier)} Load them to search them.`;
}

/** The classes of the drawn parts that {@link findInTurns} searches. */
const SEARCHED_CLASSES = ['herdr-native-prompt', 'herdr-native-steer', 'herdr-native-block'];

/** A match in what was drawn: the text node, and where in it. */
export interface DrawnMatch {
	node: Text;
	start: number;
	end: number;
}

/** The text nodes under `el`, in document order. */
function textNodes(el: Node, into: Text[]): void {
	for (const child of Array.from(el.childNodes)) {
		if (child.nodeType === 3) into.push(child as Text);
		else if (child.nodeType === 1) textNodes(child, into);
	}
}

/** The drawn parts of a turn that are searched, in document order. */
function searchedParts(el: HTMLElement, into: HTMLElement[]): void {
	for (const child of Array.from(el.childNodes)) {
		if (child.nodeType !== 1) continue;
		const childEl = child as HTMLElement;
		if (SEARCHED_CLASSES.some((cls) => childEl.hasClass(cls))) into.push(childEl);
		else searchedParts(childEl, into);
	}
}

/**
 * The `occurrence`-th match of `query` in a drawn turn, or the last one there
 * is when the drawing holds fewer; null when it holds none. A match is found
 * inside one text node: one split by formatting is not found here, and the
 * jump falls back to the turn.
 */
export function locateMatch(turnEl: HTMLElement, query: string, occurrence: number): DrawnMatch | null {
	const needle = query.trim().toLowerCase();
	if (needle === '') return null;
	const parts: HTMLElement[] = [];
	searchedParts(turnEl, parts);
	let last: DrawnMatch | null = null;
	let seen = 0;
	for (const part of parts) {
		const nodes: Text[] = [];
		textNodes(part, nodes);
		for (const node of nodes) {
			const haystack = (node.textContent ?? '').toLowerCase();
			let at = haystack.indexOf(needle);
			while (at !== -1) {
				last = { node, start: at, end: at + needle.length };
				if (seen === occurrence) return last;
				seen++;
				at = haystack.indexOf(needle, at + needle.length);
			}
		}
	}
	return last;
}

/** The highlight registry's name; `styles.css` colours `::highlight()` of it. */
export const FIND_HIGHLIGHT = 'herdr-native-find';
/** The class a match's element gets where the highlight API is missing. */
export const FIND_HIT_CLASS = 'herdr-native-find-hit';

/** The CSS Custom Highlight API, as far as this uses it. */
interface HighlightWindow {
	CSS?: { highlights?: Map<string, unknown> };
	Highlight?: new (...ranges: Range[]) => unknown;
}

/**
 * Marks a match: the exact characters through the CSS Custom Highlight API,
 * which leaves the rendered Markdown untouched, or, where that is missing, the
 * element holding them through a class. Returns how to take the mark off.
 */
export function highlightMatch(match: DrawnMatch): () => void {
	const doc = match.node.ownerDocument;
	const win = doc?.defaultView as (Window & HighlightWindow) | null | undefined;
	const registry = win?.CSS?.highlights;
	if (doc && registry && win?.Highlight) {
		const range = doc.createRange();
		range.setStart(match.node, match.start);
		range.setEnd(match.node, match.end);
		registry.set(FIND_HIGHLIGHT, new win.Highlight(range));
		return () => registry.delete(FIND_HIGHLIGHT);
	}
	const el = match.node.parentElement;
	el?.addClass(FIND_HIT_CLASS);
	return () => el?.removeClass(FIND_HIT_CLASS);
}

/** The words a hit's part is listed with. */
function partLabel(part: FindPart): string {
	if (part === 'prompt') return 'prompt';
	if (part === 'steer') return 'message during the turn';
	return 'reply';
}

/**
 * The picker: Obsidian's own suggest modal, a snippet per match with the
 * match marked, and the turn it is in under it.
 */
export class ConversationFindModal extends SuggestModal<FindHit> {
	private query = '';

	/**
	 * `earlier` is how many turns before `turns` the session model does not
	 * hold (#152): they are not searched, the picker says so, and a match's
	 * turn is counted from the session's first.
	 */
	constructor(
		app: App,
		private readonly turns: () => readonly Turn[],
		private readonly onPick: (hit: FindHit, query: string) => void,
		private readonly earlier = 0,
	) {
		super(app);
		this.setPlaceholder('Find in conversation…');
		this.emptyStateText = findEmptyText(earlier);
	}

	getSuggestions(query: string): FindHit[] {
		this.query = query;
		return findInTurns(this.turns(), query);
	}

	renderSuggestion(hit: FindHit, el: HTMLElement): void {
		const line = el.createDiv({ cls: 'herdr-native-find-snippet' });
		line.appendText(hit.before);
		line.createEl('mark', { text: hit.match });
		line.appendText(hit.after);
		el.createDiv({
			cls: 'herdr-native-find-where',
			text: `Turn ${this.earlier + hit.turnIndex + 1}, ${partLabel(hit.part)}`,
		});
	}

	onChooseSuggestion(hit: FindHit): void {
		this.onPick(hit, this.query);
	}
}
