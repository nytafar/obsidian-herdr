/**
 * Links in the native view open beside it (issue #114).
 *
 * A wikilink or an `obsidian://` URI in a transcript names a note the reader
 * wants to look at *next to* the agent, not instead of it. Three pieces:
 *
 * - {@link chooseLinkLeaf}, pure: which leaf a plain click opens the note in.
 * - {@link openLinkBeside}: that decision against the real workspace.
 * - {@link linkVaultUris}: the rendered prose's `obsidian://` URIs turned into
 *   links to the note, shown as its path from the vault root.
 *
 * What Obsidian itself does with the prose, read from its 1.13.7 `app.js`:
 * `MarkdownRenderer.render` parses, appends and runs the post-processors, and
 * wires no click handler at all — only a reading view or an embed does that —
 * so a link in this view does nothing unless the view handles it. Its parser
 * autolinks bare `www.`, `http://` and `https://` text and nothing else, so a
 * bare `obsidian://` URI arrives as plain text; `<obsidian://…>` and
 * `[label](obsidian://…)` arrive as `a.external-link` with the URI as `href`,
 * which a click would hand to the operating system.
 */

import type { App, PaneType, WorkspaceLeaf } from 'obsidian';
import { parseLinktext } from 'obsidian';
import { findObsidianUris, soleObsidianUri } from './obsidianUri';
import { trimTrailingSlashes } from '../paths';

/**
 * The plugin's page preview source, registered in `main.ts`. What the Page
 * preview settings list this view under, and what a `hover-link` from it says.
 */
export const HOVER_LINK_SOURCE = 'herdr';

/** Class on a link this view made out of an `obsidian://` URI. */
export const VAULT_URI_CLASS = 'herdr-vault-uri';

/** A leaf the note could open in, as {@link chooseLinkLeaf} sees it. */
export interface LinkLeafCandidate<T, G> {
	leaf: T;
	/** The tab group it sits in, compared by identity. */
	group: G | null;
	/** `state.file` of the leaf's persisted view state, or null. */
	file: string | null;
	/** Another herdr view, which holds a session and is never navigated away. */
	panel: boolean;
	/** A pinned leaf, which a click must not navigate. */
	pinned: boolean;
}

/** Where a plain click opens the note. */
export type LinkLeafDecision<T> =
	| { kind: 'reuse'; leaf: T }
	| { kind: 'split'; from: T }
	| { kind: 'tab' };

/**
 * The leaf a plain click on a link opens the note in: beside the native view,
 * never the view's own leaf.
 *
 * Only a leaf in *another* tab group counts as beside it: one in the view's own
 * group is a tab behind it, and showing it would hide the transcript. In order:
 *
 * 1. A leaf beside the view that already shows the note, pinned or not.
 * 2. The leaf beside it showing the note the reader came from
 *    (`getActiveFile()`, which skips the terminal view, so it still names that
 *    note after a click in the transcript), unless it is pinned. This is the
 *    split a terminal is placed in by default, and navigating it is what a
 *    link in a sidebar does to the main area.
 * 3. A new split beside the view, which the next click then finds as 2.
 * 4. A new tab, when the view sits in a sidebar, where a split would put a
 *    note in the sidebar.
 */
export function chooseLinkLeaf<T, G>(input: {
	/** The native view's own leaf, or null when it has none. */
	own: T | null;
	ownGroup: G | null;
	ownInSidebar: boolean;
	/** Vault-relative path of the note the link resolves to, or null. */
	targetPath: string | null;
	/** Vault-relative path of the active note, or null. */
	activeFilePath: string | null;
	/** Every leaf outside the sidebars, in layout order. */
	leaves: readonly LinkLeafCandidate<T, G>[];
}): LinkLeafDecision<T> {
	const beside = input.leaves.filter(
		(candidate) =>
			candidate.leaf !== input.own &&
			!candidate.panel &&
			(input.ownGroup === null || candidate.group !== input.ownGroup),
	);
	const target = input.targetPath;
	const showing = target ? beside.find((candidate) => candidate.file === target) : undefined;
	if (showing) return { kind: 'reuse', leaf: showing.leaf };
	const active = input.activeFilePath;
	const neighbour = active
		? beside.find((candidate) => !candidate.pinned && candidate.file === active)
		: undefined;
	if (neighbour) return { kind: 'reuse', leaf: neighbour.leaf };
	if (input.own !== null && !input.ownInSidebar) return { kind: 'split', from: input.own };
	return { kind: 'tab' };
}

/** A click on a link in the native view. */
export interface LinkOpenRequest {
	/** The link text: a wikilink target, or the path a URI resolved to. */
	linktext: string;
	/** What the link resolves against, as for `openLinkText`. */
	sourcePath: string;
	/** The native view's own leaf, or null when it has none. */
	ownLeaf: WorkspaceLeaf | null;
	/** `Keymap.isModEvent`: a mod-click opens where Obsidian would. */
	newLeaf: PaneType | boolean;
	/** Whether a new split puts the note before (left of) the view. */
	splitBefore: boolean;
}

/**
 * Opens a link from the native view: where Obsidian would on a mod-click, and
 * beside the view ({@link chooseLinkLeaf}) on a plain one.
 *
 * A note that does not exist yet is Obsidian's to create, so it goes through
 * `openLinkText` with the chosen leaf made active first: `getLeaf(false)`
 * returns the active leaf whenever it can navigate (`getUnpinnedLeaf` in
 * Obsidian 1.13.7), and the chosen leaf always can.
 */
export async function openLinkBeside(app: App, request: LinkOpenRequest): Promise<void> {
	const workspace = app.workspace;
	const { linktext, sourcePath } = request;
	if (request.newLeaf) {
		await workspace.openLinkText(linktext, sourcePath, request.newLeaf);
		return;
	}
	const { path, subpath } = parseLinktext(linktext);
	const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
	const own = request.ownLeaf;
	const decision = chooseLinkLeaf({
		own,
		ownGroup: own?.parent ?? null,
		ownInSidebar: own !== null && inSidebar(app, own),
		targetPath: file?.path ?? null,
		activeFilePath: workspace.getActiveFile()?.path ?? null,
		leaves: linkLeafCandidates(app, own),
	});
	const leaf =
		decision.kind === 'reuse'
			? decision.leaf
			: decision.kind === 'split'
				? workspace.createLeafBySplit(decision.from, 'vertical', request.splitBefore)
				: workspace.getLeaf('tab');
	if (!file) {
		workspace.setActiveLeaf(leaf, { focus: true });
		await workspace.openLinkText(linktext, sourcePath, false);
		return;
	}
	await leaf.openFile(file, { active: true, eState: subpath ? { subpath } : undefined });
	// A leaf that already showed it may be a tab behind another in its group.
	if (decision.kind === 'reuse') await workspace.revealLeaf(leaf);
}

/** Whether a leaf lives in the left or right sidebar. */
function inSidebar(app: App, leaf: WorkspaceLeaf): boolean {
	const root = leaf.getRoot();
	return root === app.workspace.leftSplit || root === app.workspace.rightSplit;
}

/**
 * Every leaf outside the sidebars, read off its persisted view state rather
 * than `leaf.view`, so a deferred tab still says which file it shows (PRD N1).
 * A leaf of the native view's own type is another herdr tab.
 */
function linkLeafCandidates(
	app: App,
	own: WorkspaceLeaf | null,
): LinkLeafCandidate<WorkspaceLeaf, unknown>[] {
	const ownType = own?.getViewState().type ?? null;
	const leaves: LinkLeafCandidate<WorkspaceLeaf, unknown>[] = [];
	app.workspace.iterateAllLeaves((leaf) => {
		if (inSidebar(app, leaf)) return;
		const state = leaf.getViewState();
		const file = state.state?.file;
		leaves.push({
			leaf,
			group: leaf.parent ?? null,
			file: typeof file === 'string' ? file : null,
			panel: ownType !== null && state.type === ownType,
			pinned: state.pinned === true,
		});
	});
	return leaves;
}

/**
 * What the native view's Markdown resolves links against (#114): a path in the
 * pane's working directory when that is inside the vault, so `./note` and the
 * nearest of two same-named notes are the agent's, and the vault root
 * otherwise. Obsidian only ever takes the folder of it — everything before the
 * last `/` — so the trailing slash is the whole of the "file".
 */
export function linkSourcePath(cwd: string, vaultPath: string): string {
	const root = trimTrailingSlashes(vaultPath);
	const dir = trimTrailingSlashes(cwd);
	if (!root || !dir.startsWith(`${root}/`)) return '';
	return `${dir.slice(root.length + 1)}/`;
}

/** DOM node types, as numbers: tests run with no `Node` global. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Elements whose text is not prose: code blocks and what is drawn, not written. */
const OPAQUE_TAGS = new Set(['PRE', 'SVG', 'MATH', 'MJX-CONTAINER', 'SCRIPT', 'STYLE']);

/**
 * Turns the `obsidian://` URIs in rendered prose into links (#114).
 *
 * - A bare URI in text, which Obsidian leaves as text, becomes a link.
 * - Inline code that is exactly one URI becomes the link; any other inline
 *   code, and every fenced block, is left alone.
 * - A link Obsidian already made keeps its label, and its tooltip becomes the
 *   note's path; one whose label is the URI itself shows the path instead.
 *
 * A URI that resolves (`resolve` returns the note's vault-relative path)
 * becomes an internal link to that path, which the view's own click handler
 * opens beside it. One that does not — another vault, another action, a note
 * that is not there — stays the external link it is, and a bare one becomes
 * one, so it is at least as clickable as it would be in a note.
 */
export function linkVaultUris(root: HTMLElement, resolve: (uri: string) => string | null): void {
	for (const node of Array.from(root.childNodes)) visit(node, resolve);
}

function visit(node: ChildNode, resolve: (uri: string) => string | null): void {
	if (node.nodeType === TEXT_NODE) {
		linkText(node as Text, resolve);
		return;
	}
	if (node.nodeType !== ELEMENT_NODE) return;
	const el = node as HTMLElement;
	const tag = el.tagName.toUpperCase();
	if (tag === 'A') {
		relabelLink(el, resolve);
		return;
	}
	if (tag === 'CODE') {
		linkCode(el, resolve);
		return;
	}
	if (OPAQUE_TAGS.has(tag)) return;
	for (const child of Array.from(el.childNodes)) visit(child, resolve);
}

function linkText(node: Text, resolve: (uri: string) => string | null): void {
	const text = node.textContent ?? '';
	const parent = node.parentElement;
	const matches = findObsidianUris(text);
	if (!parent || matches.length === 0) return;
	const parts: (string | Node)[] = [];
	let at = 0;
	for (const match of matches) {
		if (match.start > at) parts.push(text.slice(at, match.start));
		parts.push(uriLink(parent, match.uri, resolve(match.uri)));
		at = match.end;
	}
	if (at < text.length) parts.push(text.slice(at));
	node.replaceWith(...parts);
}

function linkCode(el: HTMLElement, resolve: (uri: string) => string | null): void {
	const uri = soleObsidianUri(el.textContent ?? '');
	if (!uri) return;
	const path = resolve(uri);
	// Code that names another vault is still code.
	const parent = el.parentElement;
	if (!path || !parent) return;
	el.replaceWith(uriLink(parent, uri, path));
}

/** A link Obsidian made: pointed at the note, labelled or tooltipped with its path. */
function relabelLink(el: HTMLElement, resolve: (uri: string) => string | null): void {
	const href = el.getAttribute('href') ?? '';
	if (!href.startsWith('obsidian://')) return;
	const path = resolve(href);
	if (!path) return;
	const label = (el.textContent ?? '').trim();
	markInternal(el, path);
	// An autolink, or a Markdown link whose text is its own URI: the URI is
	// what the reader would see, and the path is what they want to.
	if (!label || label.startsWith('obsidian://')) {
		el.setText(path);
		el.removeAttribute('aria-label');
		el.removeAttribute('data-tooltip-position');
		return;
	}
	// Obsidian's renderer put the URI in the tooltip of a labelled link.
	el.setAttr('aria-label', path);
	el.setAttr('data-tooltip-position', 'top');
}

/**
 * A link for a URI, made by the element it will end up in and moved into place
 * by the `replaceWith` that follows: that element's own document, which is
 * not the main window's in a popped-out view.
 */
function uriLink(parent: HTMLElement, uri: string, path: string | null): HTMLElement {
	const el = parent.createEl('a');
	fillUriLink(el, uri, path);
	return el;
}

/**
 * Makes an empty `a` the link for a URI: an internal link showing the note's
 * path when it resolved (`path`), else the external link Obsidian would make.
 * The prompt's links are built with it too, so both read the same.
 */
export function fillUriLink(el: HTMLElement, uri: string, path: string | null): void {
	if (path) {
		markInternal(el, path);
		el.setText(path);
		return;
	}
	// What Obsidian's renderer makes of a link it does not own (`app.js`, the
	// `external-link` transform), so it looks and opens like any other.
	el.addClass('external-link');
	el.setAttr('href', uri);
	el.setAttr('target', '_blank');
	el.setAttr('rel', 'noopener nofollow');
	el.setText(uri);
}

function markInternal(el: HTMLElement, path: string): void {
	el.removeClass('external-link');
	el.addClass('internal-link', VAULT_URI_CLASS);
	el.setAttr('href', path);
	el.setAttr('data-href', path);
	el.removeAttribute('target');
}
