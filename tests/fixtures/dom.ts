/**
 * A DOM harness for view tests (issue #93, vitest only).
 *
 * vitest runs these tests under node, where there is no DOM at all, and the
 * plugin's views do not use one directly anyway: they use Obsidian's element
 * helpers — `createDiv`, `createEl`, `addClass`, `setText`, `empty` — which are
 * Obsidian's own additions to `HTMLElement` and would be missing from a real
 * DOM implementation too. So the harness implements exactly those, and a view
 * that reaches for anything else fails loudly here rather than silently in the
 * app.
 *
 * Elements are cast to `HTMLElement` at the call site (`hostEl()`); the real
 * types are checked by `tsc` against `obsidian.d.ts`, which does not see this
 * file.
 */

/** The subset of Obsidian's `DomElementInfo` the views actually pass. */
export interface FakeElementInfo {
	cls?: string | string[];
	text?: string;
	href?: string;
	title?: string;
	type?: string;
	attr?: Record<string, string>;
}

type Node = string | FakeElement;

/** One element: a tag, classes, attributes, and children mixed with text. */
export class FakeElement {
	readonly classList = new Set<string>();
	readonly attrs: Record<string, string> = {};
	readonly nodes: Node[] = [];
	readonly listeners: { type: string; handler: (event: unknown) => void }[] = [];
	parent: FakeElement | null = null;

	constructor(readonly tag: string) {}

	// -- Obsidian's element helpers ------------------------------------------

	createDiv(info?: FakeElementInfo | string): FakeElement {
		return this.createEl('div', info);
	}

	createSpan(info?: FakeElementInfo | string): FakeElement {
		return this.createEl('span', info);
	}

	createEl(tag: string, info?: FakeElementInfo | string): FakeElement {
		const child = new FakeElement(tag);
		const options: FakeElementInfo = typeof info === 'string' ? { cls: info } : (info ?? {});
		if (options.cls) child.addClass(...[options.cls].flat());
		if (options.text !== undefined) child.setText(options.text);
		if (options.href !== undefined) child.attrs.href = options.href;
		if (options.title !== undefined) child.attrs.title = options.title;
		if (options.type !== undefined) child.attrs.type = options.type;
		for (const [name, value] of Object.entries(options.attr ?? {})) child.attrs[name] = value;
		child.parent = this;
		this.nodes.push(child);
		return child;
	}

	addClass(...classes: string[]): void {
		for (const cls of classes) this.classList.add(cls);
	}

	removeClass(...classes: string[]): void {
		for (const cls of classes) this.classList.delete(cls);
	}

	toggleClass(classes: string | string[], value: boolean): void {
		for (const cls of [classes].flat()) {
			if (value) this.classList.add(cls);
			else this.classList.delete(cls);
		}
	}

	hasClass(cls: string): boolean {
		return this.classList.has(cls);
	}

	setText(text: string): void {
		this.nodes.length = 0;
		if (text !== '') this.nodes.push(text);
	}

	appendText(text: string): void {
		this.nodes.push(text);
	}

	setAttr(name: string, value: string): void {
		this.attrs[name] = value;
	}

	empty(): void {
		for (const node of this.nodes) if (typeof node !== 'string') node.parent = null;
		this.nodes.length = 0;
	}

	remove(): void {
		const parent = this.parent;
		if (!parent) return;
		const at = parent.nodes.indexOf(this);
		if (at !== -1) parent.nodes.splice(at, 1);
		this.parent = null;
	}

	detach(): void {
		this.remove();
	}

	addEventListener(type: string, handler: (event: unknown) => void): void {
		this.listeners.push({ type, handler });
	}

	removeEventListener(type: string, handler: (event: unknown) => void): void {
		const at = this.listeners.findIndex((l) => l.type === type && l.handler === handler);
		if (at !== -1) this.listeners.splice(at, 1);
	}

	// -- What a test asks --------------------------------------------------

	/** Everything this element and its children say, in order. */
	get textContent(): string {
		return this.nodes
			.map((node) => (typeof node === 'string' ? node : node.textContent))
			.join('');
	}

	/** Child elements, text nodes left out. */
	get children(): FakeElement[] {
		return this.nodes.filter((node): node is FakeElement => typeof node !== 'string');
	}

	/** Every element at or below this one carrying `cls`, in document order. */
	findAll(cls: string): FakeElement[] {
		const found: FakeElement[] = [];
		if (this.hasClass(cls)) found.push(this);
		for (const child of this.children) found.push(...child.findAll(cls));
		return found;
	}

	/** The one element carrying `cls`; throws unless there is exactly one. */
	find(cls: string): FakeElement {
		const hits = this.findAll(cls);
		const [first] = hits;
		if (!first || hits.length !== 1) {
			throw new Error(`expected one .${cls}, found ${hits.length}`);
		}
		return first;
	}

	/** Fires every listener registered for `type`, in order. */
	dispatch(type: string, event: Record<string, unknown> = {}): void {
		const detail = { preventDefault: () => {}, ...event };
		for (const listener of this.listeners) if (listener.type === type) listener.handler(detail);
	}
}

/** A container to mount a view on, typed as the `HTMLElement` a view expects. */
export function hostEl(): { el: FakeElement; host: HTMLElement } {
	const el = new FakeElement('div');
	return { el, host: el as unknown as HTMLElement };
}
