/**
 * Every link in the native view, prose and prompts alike, through one
 * delegated handler on the view's root (#114): Obsidian's renderer wires no
 * clicks of its own here.
 */

import { Keymap, type App, type Component, type HoverParent, type WorkspaceLeaf } from 'obsidian';
import { HOVER_LINK_SOURCE, openLinkBeside } from './noteLinks';

/** The link an event inside the view landed on, if it landed on one (#114). */
function linkAt(target: EventTarget | null): HTMLElement | null {
	const el = target as HTMLElement | null;
	if (typeof el?.closest !== 'function') return null;
	return el.closest<HTMLElement>('a.internal-link');
}

/** What the link handlers need from the view around them. */
export interface ViewLinksOptions {
	app: App;
	/** What the view's links resolve against. */
	sourcePath: () => string;
	/** The view's own leaf, which a link never opens in. */
	leaf?: () => WorkspaceLeaf | null;
	/** Whether a note split off beside the view goes before it. */
	noteSplitBefore?: () => boolean;
	/** The view, as the page preview's parent. */
	hoverParent: HoverParent;
	/** How a failure reaches the user. */
	notify: (message: string) => void;
}

/** Wires click, middle click and hover on `root`, torn down with `component`. */
export function registerViewLinks(component: Component, root: HTMLElement, options: ViewLinksOptions): void {
	component.registerDomEvent(root, 'click', (event) => onLinkClick(options, event, 0));
	component.registerDomEvent(root, 'auxclick', (event) => onLinkClick(options, event, 1));
	component.registerDomEvent(root, 'mouseover', (event) => onLinkHover(options, event));
}

/**
 * A click on a link: beside the view on a plain click, where Obsidian would
 * on a mod-click, a new tab on a middle click (#114). Never the operating
 * system's protocol handler, and never this view's own leaf.
 *
 * A click something inside the link already handled — an embed's own
 * reading view wires its links — is left to it.
 */
function onLinkClick(options: ViewLinksOptions, event: MouseEvent, button: number): void {
	if (event.defaultPrevented || (event.button ?? 0) !== button) return;
	const linkEl = linkAt(event.target);
	const linktext = linkEl?.getAttribute('data-href') ?? linkEl?.getAttribute('href');
	if (!linktext) return;
	event.preventDefault();
	openLinkBeside(options.app, {
		linktext,
		sourcePath: options.sourcePath(),
		ownLeaf: options.leaf?.() ?? null,
		newLeaf: button === 1 ? 'tab' : Keymap.isModEvent(event),
		splitBefore: options.noteSplitBefore?.() ?? false,
	}).catch((error: unknown) => {
		const reason = error instanceof Error ? error.message : String(error);
		options.notify(`Herdr: could not open ${linktext} (${reason})`);
	});
}

/** A hover over a link: Obsidian's page preview, as in a note (#114). */
function onLinkHover(options: ViewLinksOptions, event: MouseEvent): void {
	const linkEl = linkAt(event.target);
	const linktext = linkEl?.getAttribute('data-href');
	if (!linkEl || !linktext) return;
	options.app.workspace.trigger('hover-link', {
		event,
		source: HOVER_LINK_SOURCE,
		hoverParent: options.hoverParent,
		targetEl: linkEl,
		linktext,
		sourcePath: options.sourcePath(),
	});
}
