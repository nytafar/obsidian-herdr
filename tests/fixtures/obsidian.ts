/**
 * Runtime stub for the `obsidian` module (vitest only).
 *
 * `obsidian` ships types but no runtime entry point, so importing a plugin file
 * that pulls in `ItemView` or `setIcon` explodes under node. Most of this file
 * therefore only has to be loadable: it is aliased in `vitest.config.ts` and
 * never used by the bundle.
 *
 * `Setting` is the exception. The settings tab's section builders (issue #85)
 * are plain functions over a container, so a `Setting` that records what it was
 * asked to render — and hands a test the change handler of a control — is
 * enough to assert a whole section without a DOM. Everything a control records
 * is a plain field; `change()` on a control is the only thing tests drive.
 *
 * Type checking still happens against the real `obsidian.d.ts`, because `tsc`
 * does not see this alias. Tests that want the recording API import this file
 * by path instead.
 */

/**
 * Enough of `Component` for a view to register what it has to give back: the
 * native surface hangs its DOM listeners and its rendered Markdown off one and
 * unloads it on detach (issue #93).
 */
export class Component {
	/** Registered teardowns, run by `unload` and countable from a test. */
	readonly registered: (() => void)[] = [];
	loaded = false;
	load(): void {
		this.loaded = true;
	}
	unload(): void {
		this.loaded = false;
		for (const off of this.registered.splice(0)) off();
	}
	register(cb: () => void): void {
		this.registered.push(cb);
	}
	registerDomEvent(el: unknown, type: string, handler: (event: unknown) => void): void {
		const target = el as {
			addEventListener(type: string, handler: (event: unknown) => void): void;
			removeEventListener(type: string, handler: (event: unknown) => void): void;
		};
		target.addEventListener(type, handler);
		this.register(() => target.removeEventListener(type, handler));
	}
}

/** An ATX heading, the one piece of Markdown the stub below understands. */
const STUB_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;

/**
 * Recording stand-in for `MarkdownRenderer`. The real one turns Markdown into
 * Obsidian's own DOM — wikilinks, callouts, embeds and all — which no test can
 * assert without the app; what a test can assert is that the surface handed it
 * the right Markdown, in the right element, with a component to hang the result
 * on. The stub writes the source text into the element synchronously so the
 * surrounding structure is still assertable.
 *
 * One shape of output is real, because the surface reads it back: an ATX
 * heading line becomes an `h1`–`h6` element, which is what the heading
 * anchors are written onto (#118). Everything else is the source text, so a
 * block of prose with no headings still says exactly what it was given.
 */
/** What the stub renderer needs of the element it was handed. */
interface StubElement {
	createEl(tag: string, info: { text: string }): unknown;
	appendText(text: string): void;
}

export class MarkdownRenderer {
	/** Every `render` call, in order, across a test file. Cleared by `reset`. */
	static readonly calls: {
		markdown: string;
		el: unknown;
		sourcePath: string;
		component: Component;
	}[] = [];

	static reset(): void {
		MarkdownRenderer.calls.length = 0;
	}

	static async render(
		_app: unknown,
		markdown: string,
		el: unknown,
		sourcePath: string,
		component: Component,
	): Promise<void> {
		MarkdownRenderer.calls.push({ markdown, el, sourcePath, component });
		const rendered = (el as { createDiv(info: { cls: string }): StubElement }).createDiv({
			cls: 'markdown-rendered',
		});
		let first = true;
		for (const line of markdown.split('\n')) {
			const heading = STUB_HEADING.exec(line);
			if (heading) {
				rendered.createEl(`h${(heading[1] ?? '').length}`, { text: (heading[2] ?? '').trim() });
				first = false;
				continue;
			}
			rendered.appendText(first ? line : `\n${line}`);
			first = false;
		}
	}
}

/** Modifier-click detection; a plain click is never a mod event. */
export const Keymap = {
	isModEvent(event?: unknown): boolean {
		const mouse = event as { ctrlKey?: boolean; metaKey?: boolean } | undefined;
		return Boolean(mouse?.ctrlKey || mouse?.metaKey);
	},
};

export class View extends Component {}

export class ItemView extends View {
	constructor(public leaf: unknown) {
		super();
	}
}

/**
 * Stand-in for the base class of the prompt box's autocomplete (#98). Only
 * loadable, like most of this fixture: the popover is Obsidian's own and what
 * it needs — a document, a scope, a focused field — no test here has.
 */
export class PopoverSuggest<T> {
	constructor(
		public app: unknown,
		public scope?: unknown,
	) {}
	open(): void {}
	close(): void {}
	selectSuggestion(_value: T): void {}
}

export class AbstractInputSuggest<T> extends PopoverSuggest<T> {
	limit = 100;
	constructor(
		app: unknown,
		public textInputEl: unknown,
	) {
		super(app);
	}
	getValue(): string {
		return '';
	}
	setValue(_value: string): void {}
	onSelect(_callback: (value: T, evt: unknown) => unknown): this {
		return this;
	}
}

export class Modal {
	constructor(public app: unknown) {}
}

export class Notice {
	constructor(public message: string) {}
}

export class Plugin extends Component {}

export class PluginSettingTab {}

export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class FileSystemAdapter {}
export class Menu {}

/**
 * Stand-in for the `inputEl`/`selectEl`/`sliderEl` a real component exposes.
 * Nothing here reaches a DOM; it exists so code that adds a listener or selects
 * the text of a field still runs under node.
 */
export class FakeElement {
	readonly listeners: { type: string; handler: (event: unknown) => void }[] = [];
	addEventListener(type: string, handler: (event: unknown) => void): void {
		this.listeners.push({ type, handler });
	}
	removeEventListener(): void {}
	select(): void {}
	focus(): void {}
	/** Fires every listener registered for `type`, in order. */
	dispatch(type: string, event: unknown = {}): void {
		for (const l of this.listeners) if (l.type === type) l.handler(event);
	}
}

class BaseComponent {
	disabled = false;
	tooltip = '';
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	setTooltip(tooltip: string): this {
		this.tooltip = tooltip;
		return this;
	}
}

/** A control with a value and an `onChange` handler a test can invoke. */
class ValueComponent<T> extends BaseComponent {
	value: T;
	/** The handler last passed to `onChange`, or null while there is none. */
	changeHandler: ((value: T) => unknown) | null = null;

	constructor(initial: T) {
		super();
		this.value = initial;
	}

	setValue(value: T): this {
		this.value = value;
		return this;
	}

	getValue(): T {
		return this.value;
	}

	onChange(handler: (value: T) => unknown): this {
		this.changeHandler = handler;
		return this;
	}

	/**
	 * What the user doing something to this control does: records the new value
	 * and runs the handler. Returns whatever the handler returns, so a test can
	 * await an async one.
	 */
	change(value: T): unknown {
		this.value = value;
		return this.changeHandler?.(value);
	}
}

export class ToggleComponent extends ValueComponent<boolean> {
	readonly kind = 'toggle' as const;
	readonly toggleEl = new FakeElement();
	constructor() {
		super(false);
	}
}

export class TextComponent extends ValueComponent<string> {
	readonly kind = 'text' as const;
	readonly inputEl = new FakeElement();
	placeholder = '';
	constructor() {
		super('');
	}
	setPlaceholder(placeholder: string): this {
		this.placeholder = placeholder;
		return this;
	}
}

export class TextAreaComponent extends TextComponent {}

export class DropdownComponent extends ValueComponent<string> {
	readonly kind = 'dropdown' as const;
	readonly selectEl = new FakeElement();
	/** Options in the order they were added, as `[value, label]` pairs. */
	readonly options: [string, string][] = [];
	constructor() {
		super('');
	}
	addOption(value: string, label: string): this {
		this.options.push([value, label]);
		return this;
	}
	addOptions(options: Record<string, string>): this {
		for (const [value, label] of Object.entries(options)) this.addOption(value, label);
		return this;
	}
	/** The values offered, which is what a test usually asserts. */
	optionValues(): string[] {
		return this.options.map(([value]) => value);
	}
}

export class SliderComponent extends ValueComponent<number> {
	readonly kind = 'slider' as const;
	readonly sliderEl = new FakeElement();
	limits: { min: number; max: number; step: number } | null = null;
	dynamicTooltip = false;
	constructor() {
		super(0);
	}
	setLimits(min: number, max: number, step: number): this {
		this.limits = { min, max, step };
		return this;
	}
	setDynamicTooltip(): this {
		this.dynamicTooltip = true;
		return this;
	}
}

export class ButtonComponent extends BaseComponent {
	readonly kind = 'button' as const;
	readonly buttonEl = new FakeElement();
	text = '';
	icon = '';
	cta = false;
	warning = false;
	clickHandler: (() => unknown) | null = null;
	setButtonText(text: string): this {
		this.text = text;
		return this;
	}
	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}
	setCta(): this {
		this.cta = true;
		return this;
	}
	setWarning(): this {
		this.warning = true;
		return this;
	}
	onClick(handler: () => unknown): this {
		this.clickHandler = handler;
		return this;
	}
	/** What a click does; returns the handler's result. */
	click(): unknown {
		return this.clickHandler?.();
	}
}

export class ExtraButtonComponent extends ButtonComponent {}

/** Every control kind a {@link Setting} can hold. */
export type SettingComponent =
	| ToggleComponent
	| TextComponent
	| DropdownComponent
	| SliderComponent
	| ButtonComponent;

/** Settings built on a container, in construction order. */
const built = new WeakMap<object, Setting[]>();

/**
 * Recording stand-in for Obsidian's `Setting`. Chaining works the way the real
 * one does — every setter and every `add*` returns the setting — but nothing is
 * rendered: the container is only an identity to file this row under.
 */
export class Setting {
	name = '';
	desc = '';
	/** True once `setHeading()` was called: this row is a section heading. */
	heading = false;
	readonly classes: string[] = [];
	readonly components: SettingComponent[] = [];

	constructor(public readonly containerEl: unknown) {
		const key = containerEl as object;
		const rows = built.get(key);
		if (rows) rows.push(this);
		else built.set(key, [this]);
	}

	setName(name: string | DocumentFragment): this {
		this.name = typeof name === 'string' ? name : (name.textContent ?? '');
		return this;
	}

	setDesc(desc: string | DocumentFragment): this {
		this.desc = typeof desc === 'string' ? desc : (desc.textContent ?? '');
		return this;
	}

	setHeading(): this {
		this.heading = true;
		return this;
	}

	setClass(cls: string): this {
		this.classes.push(cls);
		return this;
	}

	setTooltip(): this {
		return this;
	}

	setDisabled(): this {
		return this;
	}

	private add<T extends SettingComponent>(component: T, cb: (component: T) => unknown): this {
		this.components.push(component);
		cb(component);
		return this;
	}

	addToggle(cb: (component: ToggleComponent) => unknown): this {
		return this.add(new ToggleComponent(), cb);
	}

	addText(cb: (component: TextComponent) => unknown): this {
		return this.add(new TextComponent(), cb);
	}

	addTextArea(cb: (component: TextAreaComponent) => unknown): this {
		return this.add(new TextAreaComponent(), cb);
	}

	addDropdown(cb: (component: DropdownComponent) => unknown): this {
		return this.add(new DropdownComponent(), cb);
	}

	addSlider(cb: (component: SliderComponent) => unknown): this {
		return this.add(new SliderComponent(), cb);
	}

	addButton(cb: (component: ButtonComponent) => unknown): this {
		return this.add(new ButtonComponent(), cb);
	}

	addExtraButton(cb: (component: ExtraButtonComponent) => unknown): this {
		return this.add(new ExtraButtonComponent(), cb);
	}

	/** The single control this row holds; throws when it holds none or several. */
	control(): SettingComponent {
		const [first] = this.components;
		if (!first || this.components.length !== 1) {
			throw new Error(`"${this.name}" has ${this.components.length} controls, expected 1`);
		}
		return first;
	}
}

/**
 * A bare container for a section builder. Any object identity does; this one
 * just says so at the call site.
 */
export function settingsContainer(): HTMLElement {
	return {} as HTMLElement;
}

/** Every `Setting` built on `container`, in construction order. */
export function builtSettings(container: unknown): Setting[] {
	return built.get(container as object) ?? [];
}

/** The names of every `Setting` built on `container`, headings included. */
export function settingNames(container: unknown): string[] {
	return builtSettings(container).map((setting) => setting.name);
}

/** The one setting named `name`; throws when there is not exactly one. */
export function settingNamed(container: unknown, name: string): Setting {
	const hits = builtSettings(container).filter((setting) => setting.name === name);
	const [first] = hits;
	if (!first || hits.length !== 1) {
		throw new Error(`expected one setting named "${name}", found ${hits.length}`);
	}
	return first;
}

export function setIcon(): void {}
export function setTooltip(): void {}
