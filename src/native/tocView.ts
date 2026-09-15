/**
 * The table of contents sidebar (issue #100, #91 user story 8).
 *
 * A right-sidebar view listing the turns of the **active native view**, each
 * turn's headings nested beneath it, the way Obsidian's own outline lists a
 * note. Headings are computed in the reducer (`turnHeadings`, #100), so nothing
 * here parses Markdown; a click scrolls the view through its seams,
 * `NativePaneSurface.scrollToTurn` for a prompt and `scrollToHeading` for a
 * heading (#118), both of which switch following off (#106).
 *
 * The view holds no reference to a native view: it follows the pane, through
 * the same reference-counted session model the surface subscribes to, and finds
 * a view to scroll with `getLeavesOfType` at the moment of the click (the
 * Obsidian rule in CLAUDE.md).
 *
 * "Active" is the whole trick, and {@link tocTarget} is where it lives: a click
 * in this list activates the TOC's own leaf, so a leaf outside the main editor
 * area — the sidebars, this view among them — must leave the list alone, or the
 * list could never be clicked twice.
 *
 * Everything in the panel is DOM and subscription only. What a turn says is the
 * reducer's; where a heading's indent comes from is `styles.css`, by class, as
 * no plugin code may set an inline style.
 */

import { Component, ItemView, type WorkspaceLeaf } from 'obsidian';
import type HerdrPlugin from '../main';
import { TerminalView, TERMINAL_VIEW_TYPE } from '../views/terminalView';
import type { SessionHandleOf, SessionModels, SessionModelView } from './sessionModel';
import type { Turn } from './reducer';

export const TOC_VIEW_TYPE = 'herdr-toc';

/** What the panel needs to know about the leaf that just became active. */
export interface ActiveLeafFacts {
	/** True for a leaf in the main editor area; the sidebars are not. */
	inMainArea: boolean;
	/** The pane id when that leaf is a herdr terminal in native mode, else ''. */
	nativePaneId: string;
}

/** What an active-leaf change does to the list. */
export type TocTarget =
	| { kind: 'follow'; paneId: string }
	| { kind: 'empty' }
	| { kind: 'keep' };

/**
 * Which session the list should show after a leaf became active.
 *
 * A native view in the main area is the one to follow. Another main-area leaf —
 * a note, a terminal in xterm mode — means the reader has moved on, and the
 * list empties. Anything else, the sidebars and this view's own leaf included,
 * says nothing about what the reader was looking at, so the list stays.
 */
export function tocTarget(facts: ActiveLeafFacts | null): TocTarget {
	if (!facts || !facts.inMainArea) return { kind: 'keep' };
	return facts.nativePaneId ? { kind: 'follow', paneId: facts.nativePaneId } : { kind: 'empty' };
}

export interface TocPanelOptions {
	/** The plugin's registry; the panel holds one handle at a time. */
	models: SessionModels;
	/** What is true of a leaf, which only the view around the panel can say. */
	facts(leaf: WorkspaceLeaf | null): ActiveLeafFacts | null;
	/**
	 * Brings a turn into view in the native view the list is about: that leaf
	 * when it is still open, else any leaf showing the pane. The leaf is passed
	 * rather than held, and the view around the panel resolves it at the click.
	 */
	scrollToTurn(leaf: WorkspaceLeaf | null, paneId: string, turnId: string): void;
	/**
	 * The same for one heading of a turn's prose (#118). The index is the
	 * heading's place in that turn's `headings`, which is the order the reducer
	 * computes and this list draws; the surface pairs it with the elements
	 * Obsidian rendered, and falls back to the turn when they cannot be paired.
	 */
	scrollToHeading(
		leaf: WorkspaceLeaf | null,
		paneId: string,
		turnId: string,
		index: number,
	): void;
}

/**
 * The list itself: the view minus Obsidian's `ItemView`, so a test drives it
 * with a fake workspace and a fake session model (`tests/nativeToc.test.ts`).
 */
export class TocPanel {
	private readonly options: TocPanelOptions;
	/** Listeners on the rows; replaced wholesale on every draw. */
	private component = new Component();
	private listEl: HTMLElement | null = null;
	private paneId = '';
	/**
	 * The leaf the list is about, or null while it is about none. A leaf, never
	 * a view (CLAUDE.md): it is only ever compared by identity against what
	 * `getLeavesOfType` hands back at the moment it is used.
	 */
	private followedLeaf: WorkspaceLeaf | null = null;
	private handle: SessionHandleOf<SessionModelView> | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(options: TocPanelOptions) {
		this.options = options;
	}

	mount(containerEl: HTMLElement): void {
		this.listEl = containerEl.createDiv({ cls: 'herdr-toc' });
		this.render();
	}

	/** A leaf became active; {@link tocTarget} says what that means here. */
	activeLeafChanged(leaf: WorkspaceLeaf | null): void {
		const target = tocTarget(this.options.facts(leaf));
		if (target.kind === 'keep') return;
		const paneId = target.kind === 'follow' ? target.paneId : '';
		// Which leaf the list is about, remembered before the early return: two
		// tabs on one pane are the same session and different leaves, and a click
		// must scroll the one the list is about (#100).
		this.followedLeaf = paneId ? leaf : null;
		if (paneId === this.paneId) return;
		this.release();
		this.paneId = paneId;
		if (paneId) {
			this.handle = this.options.models.acquire(paneId);
			this.unsubscribe = this.handle.model.on(() => this.render());
		}
		this.render();
	}

	/**
	 * A leaf swapped its surface where it stands (#105): the header toggle, the
	 * tab menu and the waiting card's "Open in terminal" all change which view a
	 * leaf shows without any leaf becoming active, so `active-leaf-change` says
	 * nothing about it.
	 *
	 * It is news when it happens in the leaf the list follows — that view is not
	 * a native view any more — and when it happens in the leaf the reader is
	 * in. A swap in some third tab is not: the reader has not moved.
	 */
	surfaceChanged(leaf: WorkspaceLeaf, active: boolean): void {
		if (!active && leaf !== this.followedLeaf) return;
		this.activeLeafChanged(leaf);
	}

	/** Gives the model and the row listeners back. */
	unmount(): void {
		this.release();
		this.paneId = '';
		this.followedLeaf = null;
		this.component.unload();
		this.listEl = null;
	}

	/** Drops the subscription and the handle; safe when there is neither. */
	private release(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.handle?.release();
		this.handle = null;
	}

	private render(): void {
		const listEl = this.listEl;
		if (!listEl) return;
		listEl.empty();
		// The rows are gone, so their listeners go with them: one component per
		// draw, unloaded before the next.
		this.component.unload();
		this.component = new Component();
		this.component.load();

		const turns = this.handle?.model.state.turns ?? [];
		if (!this.paneId) {
			listEl.createDiv({ cls: 'herdr-toc-empty', text: 'No native view is active.' });
			return;
		}
		if (turns.length === 0) {
			listEl.createDiv({ cls: 'herdr-toc-empty', text: 'Nothing in this session yet.' });
			return;
		}
		for (const turn of turns) this.renderTurn(listEl, turn);
	}

	/** One turn: its prompt, then the headings of its prose, nested under it. */
	private renderTurn(listEl: HTMLElement, turn: Turn): void {
		const turnEl = listEl.createDiv({ cls: 'herdr-toc-turn' });
		this.renderRow(turnEl, ['herdr-toc-item', 'herdr-toc-prompt'], firstLine(turn.prompt), turn.id);
		turn.headings.forEach((heading, index) => {
			this.renderRow(
				turnEl,
				['herdr-toc-item', 'herdr-toc-heading', `mod-level-${heading.level}`],
				heading.text,
				turn.id,
				// The heading's place in *this turn*, which is how the surface
				// addresses it (#118), not its place in the whole list.
				index,
			);
		});
	}

	/**
	 * One clickable line. A prompt row scrolls to its turn; a heading row
	 * scrolls to the heading itself (#118), by its place in the turn, which the
	 * surface pairs with the elements it marked after Obsidian rendered them.
	 *
	 * A button in everything but tag: `role` and `tabindex` put it in the tab
	 * order and tell a screen reader what it is, and enter and space activate
	 * it, which is what a real button would have done for free. The tag stays a
	 * `div` because the row is a truncated line of text, not a control, and a
	 * `button` would need its own rules to stop being one (Obsidian
	 * guidelines: no inline styles, keyboard and screen reader support).
	 */
	private renderRow(
		parentEl: HTMLElement,
		cls: string[],
		text: string,
		turnId: string,
		heading?: number,
	): void {
		const rowEl = parentEl.createDiv({ cls, text, attr: { role: 'button', tabindex: '0' } });
		this.component.registerDomEvent(rowEl, 'click', () => this.activate(turnId, heading));
		this.component.registerDomEvent(rowEl, 'keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			// Space would scroll the list under the reader otherwise.
			event.preventDefault();
			this.activate(turnId, heading);
		});
	}

	/** What a click or an enter on a row does: scroll the leaf the list is about. */
	private activate(turnId: string, heading?: number): void {
		if (!this.paneId) return;
		if (heading === undefined) {
			this.options.scrollToTurn(this.followedLeaf, this.paneId, turnId);
			return;
		}
		this.options.scrollToHeading(this.followedLeaf, this.paneId, turnId, heading);
	}
}

/** A prompt's first line, which is all a one-line row can say. */
function firstLine(text: string): string {
	return (text.split('\n', 1)[0] ?? '').trim();
}

/** The sidebar view around {@link TocPanel}. */
export class TocView extends ItemView {
	private readonly plugin: HerdrPlugin;
	private readonly panel: TocPanel;

	constructor(leaf: WorkspaceLeaf, plugin: HerdrPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.panel = new TocPanel({
			models: this.plugin.sessionModels,
			facts: (candidate) => this.leafFacts(candidate),
			scrollToTurn: (leaf, paneId, turnId) =>
				this.scrollNative(leaf, paneId, (view) => view.scrollNativeToTurn(turnId)),
			scrollToHeading: (leaf, paneId, turnId, index) =>
				this.scrollNative(leaf, paneId, (view) => view.scrollNativeToHeading(turnId, index)),
		});
	}

	getViewType(): string {
		return TOC_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Herdr table of contents';
	}

	getIcon(): string {
		return 'list';
	}

	async onOpen(): Promise<void> {
		this.panel.mount(this.contentEl);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => this.panel.activeLeafChanged(leaf)),
		);
		// A tab that swapped its surface where it stands (#105): no leaf became
		// active, so the leaf change above is silent about it.
		this.register(
			this.plugin.paneViews.on((leaf) =>
				this.panel.surfaceChanged(leaf, leaf === this.app.workspace.getMostRecentLeaf()),
			),
		);
		// Opening the TOC from a native view must show that view, and the leaf
		// change that revealed this one has already been and gone.
		this.panel.activeLeafChanged(this.app.workspace.getMostRecentLeaf());
	}

	async onClose(): Promise<void> {
		this.panel.unmount();
	}

	/** What is true of a leaf, which is the one thing the panel cannot know. */
	private leafFacts(leaf: WorkspaceLeaf | null): ActiveLeafFacts | null {
		if (!leaf) return null;
		const view = leaf.view;
		return {
			inMainArea: leaf.getRoot() === this.app.workspace.rootSplit,
			nativePaneId: view instanceof TerminalView ? view.nativePaneId() : '',
		};
	}

	/**
	 * Scrolls the native view the list is about, however the click asked for it
	 * (a turn, or one heading inside it).
	 *
	 * **The leaf the list follows**, not the first leaf showing that pane: two
	 * tabs can be on one pane (ADR-0003), and scrolling the other one moves
	 * nothing the reader can see. The leaf comes in from the panel and is only
	 * ever matched by identity against what `getLeavesOfType` hands back now, so
	 * no view is held anywhere (CLAUDE.md) and a leaf that has been closed since
	 * the list was drawn simply does not match. It falls back to any leaf on the
	 * pane, which is what a tab closed and reopened since then looks like.
	 */
	private scrollNative(
		followed: WorkspaceLeaf | null,
		paneId: string,
		move: (view: TerminalView) => void,
	): void {
		const showing = this.app.workspace
			.getLeavesOfType(TERMINAL_VIEW_TYPE)
			.filter((leaf) => leaf.view instanceof TerminalView && leaf.view.nativePaneId() === paneId);
		const leaf = showing.find((candidate) => candidate === followed) ?? showing.at(0);
		const view = leaf?.view;
		if (view instanceof TerminalView) move(view);
	}
}

/**
 * Reveals the table of contents, creating it in the right sidebar the first
 * time. `getRightLeaf(false)` can return null, and the view is never held in a
 * field — `getLeavesOfType` is the lookup, as for the agent list.
 */
export async function revealTocView(plugin: HerdrPlugin): Promise<void> {
	const workspace = plugin.app.workspace;
	let leaf = workspace.getLeavesOfType(TOC_VIEW_TYPE).at(0) ?? null;
	if (!leaf) {
		leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: TOC_VIEW_TYPE, active: true });
	}
	await workspace.revealLeaf(leaf);
}
