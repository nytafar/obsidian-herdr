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

/**
 * A text node. Text is a node of its own, rather than a bare string, for the
 * one piece of code that edits rendered text in place: the native view's
 * `obsidian://` links (#114), which replace a text node with the text and the
 * links it holds.
 */
export class FakeText {
	readonly nodeType = 3;
	parent: FakeElement | null = null;

	constructor(public data: string) {}

	get textContent(): string {
		return this.data;
	}

	get parentElement(): FakeElement | null {
		return this.parent;
	}

	replaceWith(...nodes: (string | Node)[]): void {
		this.parent?.replaceChild(this, nodes);
	}
}

type Node = FakeText | FakeElement;

/** One element: a tag, classes, attributes, and children mixed with text. */
export class FakeElement {
	readonly nodeType = 1;
	readonly classList = new Set<string>();
	readonly attrs: Record<string, string> = {};
	readonly nodes: Node[] = [];
	readonly listeners: { type: string; handler: (event: unknown) => void }[] = [];
	parent: FakeElement | null = null;
	/**
	 * Scroll geometry, as a scroll container reports it (#106). A test sets the
	 * two a layout would have produced; `scrollTop` clamps the way a real
	 * container does, so "the bottom" is a number a test can work out by hand
	 * rather than the one the code under test wrote.
	 */
	scrollHeight = 0;
	clientHeight = 0;
	/** Every `scrollIntoView` call, with the options it was given (#100). */
	readonly scrolledIntoView: unknown[] = [];
	private scrollTopValue = 0;
	/** `<textarea>`'s own property; the prompt box reads and clears it (#97). */
	value = '';
	/** `<button>`'s and `<textarea>`'s own property, not an attribute (#97). */
	disabled = false;
	focused = false;

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

	/** Obsidian's SVG twin of `createEl`: the same shape here, a tag and attributes (#173). */
	createSvg(tag: string, info?: FakeElementInfo | string): FakeElement {
		return this.createEl(tag, info);
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
		this.empty();
		if (text !== '') this.appendText(text);
	}

	appendText(text: string): void {
		const node = new FakeText(text);
		node.parent = this;
		this.nodes.push(node);
	}

	setAttr(name: string, value: string): void {
		this.attrs[name] = value;
	}

	/** The DOM's own name for {@link setAttr}; the list's toolbar uses it. */
	setAttribute(name: string, value: string): void {
		this.setAttr(name, value);
	}

	/**
	 * Drops an attribute. The prompt box uses it on `style` to give an emptied
	 * box its auto-grown height back, the height a drag on the resizer wrote
	 * being the browser's own inline style (#103).
	 */
	removeAttribute(name: string): void {
		delete this.attrs[name];
	}

	empty(): void {
		for (const node of this.nodes) node.parent = null;
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

	focus(): void {
		this.focused = true;
	}

	get scrollTop(): number {
		return this.scrollTopValue;
	}

	set scrollTop(value: number) {
		const furthest = Math.max(0, this.scrollHeight - this.clientHeight);
		this.scrollTopValue = Math.max(0, Math.min(value, furthest));
	}

	scrollIntoView(options?: unknown): void {
		this.scrolledIntoView.push(options ?? null);
	}

	/**
	 * Where a layout put the element's top, in viewport pixels; a test sets it
	 * for the turn commands (#145), which measure turns against the view.
	 */
	top = 0;

	getBoundingClientRect(): { top: number } {
		return { top: this.top };
	}

	addEventListener(type: string, handler: (event: unknown) => void): void {
		this.listeners.push({ type, handler });
	}

	removeEventListener(type: string, handler: (event: unknown) => void): void {
		const at = this.listeners.findIndex((l) => l.type === type && l.handler === handler);
		if (at !== -1) this.listeners.splice(at, 1);
	}

	// -- The standard DOM the `obsidian://` links use (#114) -----------------

	/** Upper case, as an HTML document reports it. */
	get tagName(): string {
		return this.tag.toUpperCase();
	}

	/** A snapshot, which is all the code under test iterates. */
	get childNodes(): Node[] {
		return [...this.nodes];
	}

	get parentElement(): FakeElement | null {
		return this.parent;
	}

	getAttribute(name: string): string | null {
		return this.attrs[name] ?? null;
	}

	replaceWith(...nodes: (string | Node)[]): void {
		this.parent?.replaceChild(this, nodes);
	}

	/**
	 * `node` moved in front of `ref`, or to the end when `ref` is null, as the
	 * DOM does it: out of wherever it was first. The turn renderer puts a new
	 * item where it belongs this way (#127).
	 */
	insertBefore(node: FakeElement, ref: FakeElement | null): FakeElement {
		if (node.parent) {
			const from = node.parent.nodes.indexOf(node);
			if (from !== -1) node.parent.nodes.splice(from, 1);
		}
		const at = ref ? this.nodes.indexOf(ref) : -1;
		if (at === -1) this.nodes.push(node);
		else this.nodes.splice(at, 0, node);
		node.parent = this;
		this.inserted++;
		return node;
	}

	/** How many `insertBefore` calls moved a node here, for the "touches nothing" cases. */
	inserted = 0;

	/**
	 * `<details>`'s own property, reflected as the `open` attribute the way the
	 * DOM reflects it. A test that plays the reader sets it and dispatches
	 * `toggle`, which is what the browser does on a click on the summary.
	 */
	get open(): boolean {
		return 'open' in this.attrs;
	}

	set open(value: boolean) {
		if (value) this.attrs.open = '';
		else delete this.attrs.open;
	}

	/** `old` swapped for `nodes` in place, each moved out of wherever it was. */
	replaceChild(old: Node, nodes: (string | Node)[]): void {
		const at = this.nodes.indexOf(old);
		if (at === -1) return;
		const added = nodes.map((node) => {
			if (typeof node === 'string') return new FakeText(node);
			if (node.parent) {
				const from = node.parent.nodes.indexOf(node);
				if (from !== -1) node.parent.nodes.splice(from, 1);
			}
			return node;
		});
		// Moving a node out of this very element may have shifted `old`.
		this.nodes.splice(this.nodes.indexOf(old), 1, ...added);
		old.parent = null;
		for (const node of added) node.parent = this;
	}

	/**
	 * The nearest ancestor or self matching `tag`, `.class` or `tag.class`: the
	 * shapes the plugin passes (`a.internal-link`). Anything else throws.
	 */
	closest(selector: string): FakeElement | null {
		const match = /^([a-z][a-z0-9]*)?(?:\.([\w-]+))?$/.exec(selector);
		if (!match || (!match[1] && !match[2])) throw new Error(`unsupported selector: ${selector}`);
		const [, tag, cls] = match;
		return (
			this.ancestry().find((el) => (!tag || el.tag === tag) && (!cls || el.hasClass(cls))) ?? null
		);
	}

	/** This element and every ancestor, innermost first. */
	ancestry(): FakeElement[] {
		return [this, ...(this.parent?.ancestry() ?? [])];
	}

	// -- What a test asks --------------------------------------------------

	/** Everything this element and its children say, in order. */
	get textContent(): string {
		return this.nodes.map((node) => node.textContent).join('');
	}

	/** Child elements, text nodes left out. */
	get children(): FakeElement[] {
		return this.nodes.filter((node): node is FakeElement => node instanceof FakeElement);
	}

	/** Every element at or below this one carrying `cls`, in document order. */
	findAll(cls: string): FakeElement[] {
		const found: FakeElement[] = [];
		if (this.hasClass(cls)) found.push(this);
		for (const child of this.children) found.push(...child.findAll(cls));
		return found;
	}

	/**
	 * Descendants matching a list of bare tag names, in document order: the one
	 * selector shape the plugin passes, `h1, h2, … h6` for the heading
	 * anchors (#118). Anything else throws, so a query this harness cannot
	 * answer fails here instead of quietly matching nothing.
	 */
	querySelectorAll(selector: string): FakeElement[] {
		const tags = selector.split(',').map((part) => part.trim().toLowerCase());
		for (const tag of tags) {
			if (!/^[a-z][a-z0-9]*$/.test(tag)) throw new Error(`unsupported selector: ${selector}`);
		}
		const found: FakeElement[] = [];
		for (const child of this.children) {
			if (tags.includes(child.tag.toLowerCase())) found.push(child);
			found.push(...child.querySelectorAll(selector));
		}
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

	/**
	 * Fires every listener registered for `type`, here and then on every
	 * ancestor, as a bubbling DOM event does: the native view's links are
	 * handled by one listener on its root (#114). `target` is this element
	 * and `preventDefault` marks the event, unless the test passes its own.
	 */
	dispatch(type: string, event: Record<string, unknown> = {}): Record<string, unknown> {
		const detail: Record<string, unknown> = {
			target: this,
			defaultPrevented: false,
			preventDefault: () => {
				detail.defaultPrevented = true;
			},
			...event,
		};
		for (const el of this.ancestry()) {
			for (const listener of [...el.listeners]) {
				if (listener.type === type) listener.handler(detail);
			}
		}
		return detail;
	}
}

/** A container to mount a view on, typed as the `HTMLElement` a view expects. */
export function hostEl(): { el: FakeElement; host: HTMLElement } {
	const el = new FakeElement('div');
	return { el, host: el as unknown as HTMLElement };
}
