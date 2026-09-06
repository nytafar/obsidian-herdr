/**
 * Cross-window-safe DOM guards. Obsidian pop-out windows (`WorkspaceWindow`)
 * are a separate realm with their own `Element`/`HTMLElement` constructors, so
 * `target instanceof Element` (or `instanceof HTMLElement`) is false for
 * anything created in a detached window even though it is a perfectly good
 * element. See https://docs.obsidian.md/plugins/guides/pop-out-windows.
 */

/**
 * An event target as an `Element`, without `instanceof`: a popout window has
 * its own `Element` constructor, so `target instanceof Element` is false for
 * anything clicked in a detached view.
 */
export function asElement(target: EventTarget | null): Element | null {
	if (target === null || typeof target !== 'object') return null;
	const candidate = target as Element;
	return typeof candidate.closest === 'function' ? candidate : null;
}

/**
 * Whether `node` is an `HTMLElement`, checked against its own document's
 * realm rather than the module's `HTMLElement` constructor, so elements from
 * a pop-out window are recognised too.
 */
export function isHTMLElement(node: unknown): node is HTMLElement {
	if (node === null || typeof node !== 'object') return false;
	const candidate = node as HTMLElement;
	const ownerDocument = candidate.ownerDocument;
	const view = ownerDocument?.defaultView;
	if (!view) return false;
	return candidate instanceof view.HTMLElement;
}
