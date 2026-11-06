/**
 * The agent's to-do list on screen (issue #143): as a checklist where the turn
 * updated it, and as a one-line chip under the transcript that keeps the
 * current list in reach without scrolling.
 *
 * What the list says is pure and lives in `./toolCalls.ts` (`todoList`,
 * `todoProgress`, `latestTodoList`); this is the drawing. Each item's state is
 * a glyph for the eye and words for a screen reader, after Ovis's `TodoList`
 * (devswha/ovis, MIT, `src/components/ChatView.tsx`).
 *
 * Where the chip goes was decided for the narrow sidebar the view usually
 * lives in: not pinned over the top of the turns, where it would cover the
 * prose being read, but in the strip between the turns and the prompt box,
 * folded to one line — how far the list has got and what is being done now —
 * and opening to the whole list, which scrolls inside a capped height.
 */

import { todoProgress, type TodoItem, type TodoStatus } from './toolCalls';

/** What each state shows: a glyph, hidden from screen readers, and its words. */
const TODO_STATES: Readonly<Record<TodoStatus, { glyph: string; words: string; cls: string }>> = {
	completed: { glyph: '✓', words: 'done', cls: 'is-completed' },
	in_progress: { glyph: '●', words: 'in progress', cls: 'is-in-progress' },
	pending: { glyph: '○', words: 'to do', cls: 'is-pending' },
};

/** A list as a checklist: one row per item, its state as a glyph and in words. */
export function renderChecklist(parent: HTMLElement, items: readonly TodoItem[]): HTMLElement {
	const listEl = parent.createEl('ul', { cls: 'herdr-native-checklist' });
	for (const item of items) {
		const state = TODO_STATES[item.status];
		const rowEl = listEl.createEl('li', { cls: ['herdr-native-checklist-item', state.cls] });
		rowEl.createSpan({
			cls: 'herdr-native-checklist-glyph',
			text: state.glyph,
			attr: { 'aria-hidden': 'true' },
		});
		rowEl.createSpan({ cls: 'herdr-native-checklist-text', text: item.content });
		rowEl.createSpan({ cls: 'herdr-native-sr-only', text: ` (${state.words})` });
	}
	return listEl;
}

/** "3 of 7 done", the progress a summary line carries. */
export function progressText(items: readonly TodoItem[]): string {
	const { done, total } = todoProgress(items);
	return `${done} of ${total} done`;
}

/**
 * The chip under the transcript: the current to-do list, folded to one line.
 *
 * It is one element for as long as the view is attached and is filled in
 * place, so the reader's open or closed stays with it; it is drawn again only
 * when the list changed. Hidden while the agent keeps no list, and once every
 * item on it is done: a finished plan is in the turn that finished it.
 */
export class TodoChip {
	private readonly el: HTMLDetailsElement;
	private readonly summaryEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	/** The list last drawn, as JSON, so an unchanged list draws nothing. */
	private drawn: string | null = null;

	constructor(root: HTMLElement) {
		this.el = root.createEl('details', { cls: ['herdr-native-plan', 'herdr-native-sizer', 'herdr-is-hidden'] });
		this.summaryEl = this.el.createEl('summary', { cls: 'herdr-native-plan-summary' });
		this.bodyEl = this.el.createDiv({ cls: 'herdr-native-plan-body' });
	}

	/** Shows `items` as the current list, or hides the chip for none. */
	update(items: readonly TodoItem[] | null): void {
		const visible = items !== null && items.some((item) => item.status !== 'completed');
		const signature = visible ? JSON.stringify(items) : null;
		if (signature === this.drawn) return;
		this.drawn = signature;
		this.el.toggleClass('herdr-is-hidden', !visible);
		this.summaryEl.empty();
		this.bodyEl.empty();
		if (!visible || !items) return;
		const { current } = todoProgress(items);
		const now = current ? (current.activeForm ?? current.content) : null;
		const progress = progressText(items);
		// One line: the title and the progress never shrink, what is being done
		// now is cut with an ellipsis. The parts are flex items, so the line is
		// also said once in words.
		this.summaryEl.setAttr('aria-label', ['To-do', progress, now].filter(Boolean).join(', '));
		const lineEl = this.summaryEl.createSpan({ cls: 'herdr-native-plan-line' });
		lineEl.createSpan({ cls: 'herdr-native-plan-title', text: 'To-do' });
		lineEl.createSpan({ cls: 'herdr-native-plan-separator', text: '·', attr: { 'aria-hidden': 'true' } });
		lineEl.createSpan({ cls: 'herdr-native-plan-progress', text: progress });
		if (now) {
			lineEl.createSpan({ cls: 'herdr-native-plan-separator', text: '·', attr: { 'aria-hidden': 'true' } });
			lineEl.createSpan({ cls: 'herdr-native-plan-current', text: now });
		}
		renderChecklist(this.bodyEl, items);
	}
}
